// Replays of recorded matches (demos, written by relay/lib/recorder.mjs). A replay stands in
// for the spectator hub: the client joins it as it joins the hub (net.js openSocket), gets a
// PlayersList and the join messages built from the match as it was at the chosen moment,
// then the recorded messages in time. A jump rebuilds that state (from checkpoints every few
// seconds), the client forgets its world and joins again (soldat_spectator_rewind), and the
// two seconds before the moment run at high speed so that everyone is where they were.

import { findHighlights } from './highlights.js';

const MSG = {
  HeartBeat: 2, ServerSpriteSnapshot: 3, ThingSnapshot: 9, ThingTaken: 12, RequestGame: 14,
  PlayerInfo: 15, PlayersList: 16, NewPlayer: 17, ServerDisconnect: 18, PlayerDisconnect: 19, DeltaMovement: 21,
  Ping: 30,
  FlagInfo: 32, ThingMustSnapshot: 33, HeartBeat16: 35, HeartBeat8: 36, ServerSpriteSnapshotMajor: 41,
  ClientSpriteSnapshotDead: 43, ServerVars: 52, ServerSyncMsg: 54, WeaponActive: 65, Gravity: 69, MapChange: 8,
};
// PlayersList layout (docs/PROTOCOL-1.7.1.md)
const PL = {
  mapName: 3, players: 20, name: 108, shirt: 876, pants: 1004, skin: 1132, hair: 1260, jet: 1388,
  team: 1516, predDuration: 1548, look: 1588, pos: 1620, vel: 1876, timeLimit: 2136, timeLeft: 2140,
  serverTicks: 2145,
};
const COLORS = ['shirt', 'pants', 'skin', 'hair', 'jet'];
const MAX_PLAYERS = 32, NAME_LEN = 24, TEAM_SPECTATOR = 5;
const FLAG_STYLES = new Set([1, 2, 3]);
const HEADER_SIZE = 180;
export const TICKS = 60;                  // a second
const CHECKPOINT = 5 * TICKS;
// heartbeats by the player slots they have (the team scores follow seven bytes a slot)
const HEARTBEAT_SLOTS = { [MSG.HeartBeat]: 32, [MSG.HeartBeat16]: 16, [MSG.HeartBeat8]: 8 };
const PREROLL = 2 * TICKS, PREROLL_SPEED = 30;
// the client leaves after 15 s without a ping; a demo without them gets one every 2 s
const PING_GAP = 2 * TICKS;
// a shot from afar in the reel (a highlight's shot): the camera eases out to show both
// players before it leaves, holds while it flies, and eases in after it lands
const SHOT_OUT = 40, SHOT_HOLD = 18, SHOT_IN = 42;
const ease = (x) => x * x * (3 - 2 * x);

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function fixedString(b, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < b.length && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
}

function writeFixed(b, off, len, text) {
  b.fill(0, off, off + len);
  for (let i = 0; i < Math.min(len, text.length); i++) b[off + i] = text.charCodeAt(i) & 0xFF;
}

function setHash(b) {
  let h = (b[0] + 0xB5A5) & 0xFFFF;
  for (let i = 3; i < b.length; i++) h = (h * 33 + b[i]) & 0xFFFF;
  b[1] = h & 0xFF;
  b[2] = h >> 8;
  return b;
}

// ---------------------------------------------------------------- the file

// { map, start (Unix time), ticks, msgs, at (each message's tick), cams: [{ tick, slot }] }.
// What would end the viewer's own connection (the server going down, the hub's spectator
// leaving) is left out.
export function parseDemo(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < HEADER_SIZE || fixedString(u8, 0, 6) !== 'SOLDEM') throw new Error('This is no Soldat demo.');
  const d = dv(u8);
  const msgs = [], at = [], cams = [];
  let p = HEADER_SIZE, tick = 0, own = 0;
  while (p + 2 <= u8.length) {
    const size = d.getUint16(p, true);
    p += 2;
    if (size === 1) { tick++; continue; }
    if (size === 0) { p += 2; continue; }
    if (size < 3 || p + size > u8.length) break;
    const m = u8.subarray(p, p + size);
    p += size;
    if (m[0] === MSG.ClientSpriteSnapshotDead) { cams.push({ tick, slot: m[3] }); continue; }
    if (m[0] === MSG.NewPlayer && !own) own = m[3];
    if (m[0] === MSG.ServerDisconnect || (m[0] === MSG.PlayerDisconnect && m[3] === own)) continue;
    msgs.push(m);
    at.push(tick);
  }
  return { map: fixedString(u8, 8, 161), start: d.getInt32(172, true), ticks: tick, msgs, at: Int32Array.from(at), cams };
}

// ---------------------------------------------------------------- the match at a moment

// what relay/lib/hub.mjs tracks to let viewers join, in ticks of the demo
class MatchState {
  constructor() {
    this.base = null;
    this.map = '';
    this.own = 0;
    this.ownNewPlayer = null;
    this.roster = new Array(MAX_PLAYERS + 1).fill(null);
    this.vars = this.gravity = this.heartbeat = this.sync = this.mapChange = null;
    this.syncTick = this.mapChangeTick = 0;
    this.weaponActive = new Map();
    this.things = new Map();
    this.ticks = 0;
    this.ticksTick = 0;
    this.time = { left: 0, tick: 0 };
  }

  clone() {
    const c = Object.assign(new MatchState(), this);
    c.roster = this.roster.slice();
    c.weaponActive = new Map(this.weaponActive);
    c.things = new Map(this.things);
    return c;
  }

  apply(m, tick) {
    this.settleMapChange(tick);
    const num = m[3];
    switch (m[0]) {
      case MSG.PlayersList:
        if (!this.base && m.length >= 2150) this.playersList(m, tick);
        break;
      case MSG.NewPlayer: {
        if (num < 1 || num > MAX_PLAYERS || m.length < 61) break;
        const d = dv(m);
        const p = { name: fixedString(m, 7, NAME_LEN), team: m[51], look: m[52], pos: m.subarray(53, 61), vel: new Uint8Array(8) };
        COLORS.forEach((k, j) => { p[k] = d.getUint32(31 + j * 4, true); });
        this.roster[num] = p;
        // the hub's spectator: the first NewPlayer of the demo
        if (!this.own) this.own = num;
        if (num === this.own) this.ownNewPlayer = m;
        break;
      }
      case MSG.PlayerDisconnect:
        if (num >= 1 && num <= MAX_PLAYERS) this.roster[num] = null;
        break;
      case MSG.ServerSpriteSnapshot:
      case MSG.ServerSpriteSnapshotMajor:
      case MSG.DeltaMovement: {
        const p = this.roster[num];
        if (p && m.length >= 20) this.roster[num] = { ...p, pos: m.subarray(4, 12), vel: m.subarray(12, 20) };
        const tickAt = m[0] === MSG.ServerSpriteSnapshot ? 37 : m[0] === MSG.DeltaMovement ? 23 : 28;
        if (m.length >= tickAt + 4) { this.ticks = dv(m).getInt32(tickAt, true); this.ticksTick = tick; }
        break;
      }
      case MSG.ServerVars: this.vars = m; break;
      case MSG.Gravity: this.gravity = m; break;
      case MSG.WeaponActive: this.weaponActive.set(m[4], m); break;
      case MSG.HeartBeat: case MSG.HeartBeat16: case MSG.HeartBeat8: this.heartbeat = m; break;
      case MSG.ServerSyncMsg: this.sync = m; this.syncTick = tick; break;
      case MSG.ThingMustSnapshot:
      case MSG.ThingSnapshot:
        this.things.set(num, { msg: m, style: m[5], taken: false });
        break;
      case MSG.ThingTaken: {
        const t = this.things.get(num);
        if (t && !FLAG_STYLES.has(t.style)) this.things.set(num, { ...t, taken: true });
        break;
      }
      case MSG.MapChange:
        this.mapChange = m;
        this.mapChangeTick = tick;
        break;
    }
  }

  playersList(b, tick) {
    const d = dv(b);
    this.base = b;
    this.map = fixedString(b, PL.mapName, 16);
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const name = fixedString(b, PL.name + (i - 1) * NAME_LEN, NAME_LEN);
      if (!name || name === '0 ') { this.roster[i] = null; continue; }
      const p = { name, team: b[PL.team + i - 1], look: b[PL.look + i - 1] };
      for (const k of COLORS) p[k] = d.getUint32(PL[k] + (i - 1) * 4, true);
      p.pos = b.subarray(PL.pos + (i - 1) * 8, PL.pos + i * 8);
      p.vel = b.subarray(PL.vel + (i - 1) * 8, PL.vel + i * 8);
      this.roster[i] = p;
    }
    this.ticks = d.getInt32(PL.serverTicks, true);
    this.ticksTick = tick;
    this.time = { left: d.getInt32(PL.timeLeft, true), tick };
  }

  settleMapChange(tick) {
    if (!this.mapChange) return;
    if (tick - this.mapChangeTick < dv(this.mapChange).getInt16(3, true)) return;
    this.map = fixedString(this.mapChange, 6, Math.min(16, this.mapChange[5]));
    this.mapChange = null;
    this.things.clear();
    this.sync = null;
    this.time = { left: dv(this.base).getInt32(PL.timeLimit, true), tick };
  }

  timeLeft(tick) {
    if (this.sync) {
      const left = dv(this.sync).getInt32(3, true);
      return this.sync[7] ? left : Math.max(0, left - (tick - this.syncTick));
    }
    return Math.max(0, this.time.left - (tick - this.time.tick));
  }

  // what the hub answers to RequestGame and PlayerInfo
  buildPlayersList(tick) {
    this.settleMapChange(tick);
    const b = this.base.slice();
    const d = dv(b);
    writeFixed(b, PL.mapName, 16, this.map);
    let count = 0;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const p = i === this.own ? null : this.roster[i];
      const o = i - 1;
      if (!p) {
        writeFixed(b, PL.name + o * NAME_LEN, NAME_LEN, '0 ');
        b[PL.team + o] = 0;
        b[PL.look + o] = 0;
        for (const k of COLORS) d.setUint32(PL[k] + o * 4, 0, true);
        b.fill(0, PL.pos + o * 8, PL.pos + o * 8 + 8);
        b.fill(0, PL.vel + o * 8, PL.vel + o * 8 + 8);
        continue;
      }
      count++;
      writeFixed(b, PL.name + o * NAME_LEN, NAME_LEN, p.name);
      b[PL.team + o] = p.team;
      b[PL.look + o] = p.look;
      for (const k of COLORS) d.setUint32(PL[k] + o * 4, p[k], true);
      b.set(p.pos, PL.pos + o * 8);
      b.set(p.vel, PL.vel + o * 8);
    }
    b[PL.players] = count;
    b.fill(0, PL.predDuration, PL.predDuration + MAX_PLAYERS);
    d.setInt32(PL.timeLeft, this.timeLeft(tick), true);
    d.setInt32(PL.serverTicks, this.ticks + (tick - this.ticksTick), true);
    return setHash(b);
  }

  joinBundle(tick) {
    const out = [];
    if (this.ownNewPlayer) out.push(this.ownNewPlayer);
    if (this.vars) out.push(this.vars);
    if (this.gravity) out.push(this.gravity);
    for (const m of this.weaponActive.values()) out.push(m);
    for (const t of this.things.values()) if (!t.taken) out.push(t.msg);
    if (this.heartbeat) out.push(this.heartbeat);
    if (this.sync) {
      const b = this.sync.slice();
      dv(b).setInt32(3, this.timeLeft(tick), true);
      out.push(setHash(b));
    }
    if (this.mapChange) {
      const b = this.mapChange.slice();
      dv(b).setInt16(3, Math.max(1, dv(b).getInt16(3, true) - (tick - this.mapChangeTick)), true);
      out.push(setHash(b));
    }
    return out;
  }
}

// ---------------------------------------------------------------- the player

export class Replay {
  // demo: parseDemo's; meta: the hub's listing of it; hooks: call(export, ...args) into the
  // game, onFollow(slot) (the director's pick), onHold(held) (paused or not), onTime()
  // (moved), onEnd(), onClip(clip) (the reel goes on to it; null: the reel stopped),
  // onPart(play) (the clip goes on to its next play), onShot(shot) (shotAt, each frame
  // while it has one, then once null)
  constructor(demo, meta, hooks) {
    this.demo = demo;
    this.meta = meta;
    this.hooks = hooks;
    this.speed = 1;
    this.playing = true;
    this.sock = null;
    this.checkpoints = [];
    this.markers = [];
    this.scan();
    this.highlights = findHighlights(demo, this.end);
    this.reel = null;        // highlights only: { i (the clip), part (the play in it), done, shotOff (no shot camera in it) }
    this.shooting = false;   // onShot had a shot last
    this.following = 0;      // the reel's camera
    this.jump(0);
  }

  get length() { return this.end; }
  // where the replay is (during a jump: where it is going)
  get time() { return this.target ?? this.pos; }

  // one pass: checkpoints of the match, and the captures for the timeline
  scan() {
    const { msgs, at } = this.demo;
    const s = new MatchState();
    let change = 0;
    let scores = null;
    let zeroed = 0;  // past the map change: where the server zeroes the scores
    for (let i = 0; i < msgs.length; i++) {
      while (this.checkpoints.length * CHECKPOINT < at[i]) {
        this.checkpoints.push({ tick: this.checkpoints.length * CHECKPOINT, index: i, state: s.clone() });
      }
      const m = msgs[i];
      s.apply(m, at[i]);
      if (m[0] === MSG.MapChange && m.length >= 5) { change = at[i] + dv(m).getInt16(3, true); zeroed = 0; }
      const n = HEARTBEAT_SLOTS[m[0]];
      if (n && m.length >= 15 + 7 * n) {
        const now = [0, 1, 2, 3].map((k) => dv(m).getUint16(7 + 7 * n + 2 * k, true));
        if (change && !zeroed && scores && now.some((v, k) => v < scores[k])) zeroed = at[i];
        scores = now;
      }
      if (m[0] === MSG.FlagInfo && (m[3] === 3 || m[3] === 4)) {
        const p = s.roster[m[4]];
        this.markers.push({ tick: at[i], team: m[3] - 2, name: p ? p.name : '' });
      }
    }
    // the client joins on a PlayersList: a demo starts with one
    if (!s.base) throw new Error('This demo has no player list to start from: it was not recorded by Soldat TV or a Soldat 1.7.1 client.');
    if (!this.checkpoints.length) this.checkpoints.push({ tick: 0, index: 0, state: new MatchState() });
    this.ownName = s.ownNewPlayer ? fixedString(s.ownNewPlayer, 7, NAME_LEN) : '';
    // a demo ends where the next map begins: the replay stops on the scoreboard just before,
    // and before the server zeroes the scores on it
    const t = this.demo.ticks;
    const last = Math.min(t, change - TICKS / 2, zeroed ? zeroed - 1 : Infinity);
    this.end = change && change >= t - TICKS && change <= t + TICKS ? Math.max(0, last) : t;
  }

  // the match at `tick` (messages up to and with it), and the index of the next message
  stateAt(tick) {
    const { msgs, at } = this.demo;
    const cp = this.checkpoints[Math.min(this.checkpoints.length - 1, Math.floor(tick / CHECKPOINT))];
    const s = cp.state.clone();
    let i = cp.index;
    for (; i < msgs.length && at[i] <= tick; i++) s.apply(msgs[i], at[i]);
    return { state: s, next: i };
  }

  // the clip of the reel
  get clip() { return this.reel ? this.highlights[this.reel.i] : null; }

  // the play of the reel's clip at `tick`
  partAt(tick) {
    const parts = this.clip.parts;
    let i = 0;
    while (i + 1 < parts.length && parts[i + 1].start <= tick) i++;
    return i;
  }

  camAt(tick) {
    const clip = this.clip;
    if (clip) {
      const p = clip.parts[this.partAt(tick)];
      // the shot camera is on the killer until it is on the victim (or back on the killer)
      const s = this.reel.shotOff ? null : p.shot;
      if (s && tick >= s.fired - SHOT_OUT) return tick < s.tick + SHOT_HOLD + SHOT_IN || s.back ? s.killer : s.victim;
      let slot = p.slot;
      for (const c of p.cams) if (c.tick <= tick) slot = c.slot;
      return slot;
    }
    let slot = 0;
    for (const c of this.demo.cams) { if (c.tick > tick) break; slot = c.slot; }
    return slot;
  }

  // the clip's shot from afar at `tick`: { a (the killer), b (the victim), mix (how far from a
  // to b the camera aims), out (how far zoomed out to show both, 0 to 1) }, or null
  shotAt(tick) {
    const clip = this.clip, s = clip && !this.reel.shotOff ? clip.parts[this.partAt(tick)].shot : null;
    if (!s) return null;
    const t0 = s.fired - SHOT_OUT, t1 = s.fired, t2 = s.tick + SHOT_HOLD, t3 = t2 + SHOT_IN;
    if (tick < t0 || tick >= t3) return null;
    const shot = { a: s.killer, b: s.victim, mix: 0.5, out: 1 };
    if (tick < t1) {
      shot.out = ease((tick - t0) / (t1 - t0));
      shot.mix = shot.out / 2;
    } else if (tick >= t2) {
      const e = ease((tick - t2) / (t3 - t2));
      shot.out = 1 - e;
      shot.mix = 0.5 + ((s.back ? 0 : 1) - 0.5) * e;
    }
    return shot;
  }

  // the clip goes on without its shot camera (the viewer zoomed, or the players are too far
  // apart to show both)
  dropShot() {
    if (!this.reel || this.reel.shotOff || !this.clip.parts.some((p) => p.shot)) return;
    this.reel.shotOff = true;
    this.following = -1;
    if (this.shooting) { this.shooting = false; this.hooks.onShot(null); }
  }

  // sets up the stream to continue from a little before `tick`
  jump(tick) {
    tick = Math.max(0, Math.min(this.length, Math.round(tick)));
    const from = Math.max(0, tick - PREROLL);
    const { state, next } = this.stateAt(from);
    this.state = state;
    this.next = next;
    this.pos = from;
    this.target = tick > from ? tick : null;
    this.cam = this.demo.cams.findIndex(c => c.tick > from);
    if (this.cam < 0) this.cam = this.demo.cams.length;
    this.joining = true;
    this.lastRequest = 0;
    this.pinged = from;
  }

  seek(tick) {
    this.jump(tick);
    if (this.time >= this.length) this.playing = false;
    if (this.sock) {
      this.hooks.call('soldat_spectator_rewind');
      this.sock.deliver(this.state.buildPlayersList(this.pos));
    }
    this.hooks.onTime();
  }

  // the next match of a reel of several: this one takes over the game's connection from the
  // one before (the jump of playReel or seek then brings the client to this match's map, as
  // a jump does)
  takeOver(prev) {
    const sock = prev.sock;
    prev.sock = null;
    prev.reel = null;
    if (!sock) return;
    sock.replay = this;
    this.sock = sock;
  }

  // highlights only: the clips one after another, the camera on whoever made each
  playReel(i = 0) {
    if (!this.highlights.length) return;
    this.reel = { i: Math.max(0, Math.min(this.highlights.length - 1, i)), part: 0, done: false, shotOff: false };
    this.shooting = false;
    this.following = -1;
    this.playing = true;
    this.seek(this.clip.from);
    this.applySpeed();
    this.hooks.onClip(this.clip);
  }

  // back to the whole match, the director's camera where it is
  stopReel() {
    if (!this.reel) return;
    this.reel = null;
    this.shooting = false;
    this.cam = this.demo.cams.findIndex(c => c.tick > this.pos);
    if (this.cam < 0) this.cam = this.demo.cams.length;
    if (this.sock && !this.joining) this.followDue = this.camAt(this.pos);
    this.hooks.onClip(null);
    this.hooks.onTime();
  }

  play() {
    if (this.reel && this.reel.done) { this.playReel(0); return; }
    if (this.time >= this.length) this.seek(0);
    this.playing = true;
    this.applySpeed();
    this.hooks.onTime();
  }

  pause() {
    this.playing = false;
    this.applySpeed();
    this.hooks.onTime();
  }

  setSpeed(x) {
    this.speed = x;
    this.applySpeed();
    this.hooks.onTime();
  }

  rate() {
    if (this.joining) return 0;
    if (this.target != null) return PREROLL_SPEED;
    return this.playing ? this.speed : 0;
  }

  applySpeed() {
    if (!this.sock || this.joining) return;
    const rate = this.rate();
    this.hooks.call('soldat_spectator_speed', rate);
    this.hooks.onHold(!rate);
  }

  // the page's frame clock, before each frame of the game
  pump(now) {
    const dt = Math.min(250, Math.max(0, now - (this.last || now)));
    this.last = now;
    if (!this.sock || this.joining) return;
    if (this.speedDue) { this.speedDue = false; this.applySpeed(); }
    if (this.followDue != null) { this.hooks.onFollow(this.followDue); this.followDue = null; }
    if (this.partDue) { this.partDue = false; if (this.reel) this.hooks.onPart(this.clip.parts[this.reel.part]); }
    const rate = this.rate();
    if (!rate) return;
    let pos = this.pos + (dt * TICKS * rate) / 1000;
    if (this.target != null && pos >= this.target) {
      pos = this.target;
      this.target = null;
      this.speedDue = true;
    }
    const clip = this.clip;
    if (clip && this.target == null && pos >= clip.to && !this.reel.done) {
      if (this.reel.i + 1 < this.highlights.length) {
        this.reel.i++;
        this.reel.part = 0;
        this.reel.shotOff = false;
        this.shooting = false;
        this.following = -1;
        this.seek(this.clip.from);
        this.hooks.onClip(this.clip);
        return;
      }
      // the last one: the reel stops on it
      pos = clip.to;
      this.reel.done = true;
      this.playing = false;
      this.speedDue = true;
      this.hooks.onEnd();
    }
    if (pos >= this.length) {
      pos = this.length;
      if (this.playing) { this.playing = false; this.speedDue = true; this.hooks.onEnd(); }
    }
    const { msgs, at, cams } = this.demo;
    while (this.next < msgs.length && at[this.next] <= pos) {
      const m = msgs[this.next++];
      if (m[0] === MSG.Ping) this.pinged = pos;
      this.sock.deliver(m);
    }
    if (!(pos - this.pinged < PING_GAP)) {
      this.pinged = pos;
      this.sock.deliver(setHash(Uint8Array.of(MSG.Ping, 0, 0, 0, 0)));
    }
    if (this.reel) {
      const part = this.partAt(pos);
      if (part !== this.reel.part) { this.reel.part = part; this.hooks.onPart(this.clip.parts[part]); }
      const slot = this.camAt(pos);
      if (slot !== this.following) { this.following = slot; this.hooks.onFollow(slot); }
      const shot = this.shotAt(pos);
      if (shot || this.shooting) { this.shooting = !!shot; this.hooks.onShot(shot); }
    } else {
      while (this.cam < cams.length && cams[this.cam].tick <= pos) this.hooks.onFollow(cams[this.cam++].slot);
    }
    this.pos = pos;
  }

  // ------------------------------------------------------------ the client's side

  socket() {
    this.sock = new ReplaySocket(this);
    return this.sock;
  }

  fromClient(b) {
    if (b.length < 3) return;
    const now = performance.now();
    if (b[0] === MSG.RequestGame && this.joining) {
      if (now - this.lastRequest < 1000) return;
      this.lastRequest = now;
      this.sock.deliver(this.state.buildPlayersList(this.pos));
    } else if (b[0] === MSG.PlayerInfo && this.joining) {
      this.joining = false;
      for (const m of this.state.joinBundle(this.pos)) this.sock.deliver(m);
      // the game takes these in its next frame; camera and speed are set before it (not from
      // inside the game's call, which this is)
      this.followDue = this.following = this.camAt(this.pos);
      this.speedDue = true;
      // the reel's clip is on screen from now: its play again (the page's caption)
      if (this.reel) this.partDue = true;
    }
  }
}

// a WebSocket to the hub, as far as net.js uses one
class ReplaySocket {
  constructor(replay) {
    this.replay = replay;
    this.readyState = 0;
    this.binaryType = 'arraybuffer';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
    });
  }

  send(data) {
    if (this.readyState !== 1) return;
    if (typeof data === 'string') {
      let m;
      try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'ping') this.text({ type: 'pong', t: m.t });
      else if (m.type === 'watch') this.text({ type: 'ready', name: this.replay.ownName, server: this.replay.meta.serverName, delay: 0 });
      return;
    }
    this.replay.fromClient(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  deliver(m) {
    if (this.readyState === 1 && this.onmessage) this.onmessage({ data: m.slice().buffer });
  }

  text(obj) {
    if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }

  close() {
    this.readyState = 3;
    if (this.replay.sock === this) this.replay.sock = null;
  }
}
