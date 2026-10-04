// Spectator hub for one game server: joins it once as a spectator and streams the match
// to any number of viewers (the spectator client, web/soldat-spectate.wasm).
//
// Viewers never reach the game server. Their client still runs its normal join (RequestGame,
// PlayerInfo, RequestMap), and the hub answers those itself from the state it tracks:
// a fresh PlayersList with the current players, then the hub's own NewPlayer (viewers
// play the part of the hub's spectator; the page sets the player name to match) and the
// latest settings, items and scores. From then on viewers get the server's datagrams
// unchanged, optionally delayed.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import {
  MSG, TEAM_SPECTATOR, MAX_PLAYERS, PLAYERS_LIST_SIZE, SessionCipher, splitDatagram, setHash,
  fixedString, writeFixed, makeHwid,
} from './soldat171.mjs';

const JOIN_RETRY_MS = 3000;
const JOIN_TIMEOUT_MS = 20_000;
const SILENCE_MS = 15_000;          // no datagram for this long: the connection is gone
const CAMERA_MS = 500;              // spectators report their camera twice a second
const RECONNECT_MS = [5_000, 15_000, 30_000, 60_000];
const DIRECTOR_HOLD_MS = 8_000;     // keep a camera target at least this long
const PASSWORD_HOLD_MS = 10_000;    // after a wrong password, no new one for this long
const TICKS_PER_SECOND = 60;

// PlayersList layout (docs/PROTOCOL-1.7.1.md)
const PL = {
  mapName: 3, players: 20, name: 108, shirt: 876, pants: 1004, skin: 1132, hair: 1260, jet: 1388,
  team: 1516, predDuration: 1548, look: 1588, pos: 1620, vel: 1876, sessionId: 2134, timeLimit: 2136, timeLeft: 2140,
  serverTicks: 2145, flags: 23,
};
const NAME_LEN = 24;
const FLAG_STYLES = new Set([1, 2, 3]);  // alpha, bravo and pointmatch flag

export class Hub {
  constructor(cfg, opts) {
    this.cfg = cfg;               // { id, name, host, port, password, askPassword }
    this.password = cfg.password || '';  // the one the hub joins with
    this.knownPassword = this.password;  // the last one that let it in
    this.passwordHold = 0;
    this.playerName = opts.playerName;
    this.hwid = makeHwid(opts.playerName + '@' + cfg.id);
    this.delayMs = Math.max(0, (cfg.delaySeconds ?? opts.delaySeconds ?? 0) * 1000);
    this.lingerMs = opts.lingerMs ?? 60_000;
    this.log = (...a) => opts.log(`[${cfg.id}]`, ...a);
    this.viewers = new Set();
    this.state = 'idle';          // idle, joining, live, waiting (to reconnect)
    this.ready = false;           // live and the delayed stream has caught up: viewers may join
    this.error = '';
    this.failures = 0;
    this.timers = new Set();
    this.queue = [];              // delayed items: { at, dgram } or { at, json }
    this.resetMatch();
  }

  // ------------------------------------------------------------ public

  info() {
    const live = this.state === 'live';
    const playing = live
      ? this.match.roster.filter((p, i) => p && i !== this.match.own && p.team !== TEAM_SPECTATOR) : null;
    return {
      id: this.cfg.id, name: this.cfg.name, state: this.state, error: this.error,
      map: this.match.map,
      players: live ? playing.length : null,
      names: live ? playing.map((p) => ({ name: p.name, team: p.team })) : null,
      viewers: this.viewers.size, delay: this.delayMs / 1000,
    };
  }

  addViewer(v) {
    // v: { send(buf), sendText(obj), close(code), buffered }
    this.viewers.add(v);
    v.joined = false;
    v.greeted = false;
    v.lastRequest = 0;
    this.clearTimer('linger');
    if (this.state === 'idle') this.connect();
    if (this.state === 'waiting') v.sendText({ type: 'status', message: `Reconnecting to the server (${this.error})...` });
    else if (this.ready) this.greet(v);
    else v.sendText({ type: 'status', message: 'Joining the server as a spectator...' });
  }

  // A server with askPassword gets its password from viewers (a link has it, or the page
  // asks). Once one has let the hub in, anyone watches, and the hub keeps it for the next
  // time. Returns 'ok', 'missing' or 'wait' (a wrong one was just tried).
  checkPassword(pw) {
    if (!this.cfg.askPassword || this.state === 'live' || this.state === 'joining') return 'ok';
    pw = typeof pw === 'string' ? pw.slice(0, 64) : '';
    // a new one: the server's password may have changed
    if (pw && pw !== this.knownPassword && Date.now() >= this.passwordHold) { this.password = pw; return 'ok'; }
    if (this.knownPassword) { this.password = this.knownPassword; return 'ok'; }
    return pw ? 'wait' : 'missing';
  }

  // the list shows a lock: watching needs a password first
  locked() {
    return !!this.cfg.askPassword && !this.knownPassword && this.state !== 'live' && this.state !== 'joining';
  }

  removeViewer(v) {
    this.viewers.delete(v);
    if (!this.viewers.size && (this.state === 'live' || this.state === 'joining')) {
      this.setTimer('linger', this.lingerMs, () => { if (!this.viewers.size) this.disconnect('no viewers'); });
    }
  }

  // a datagram from a viewer's client: only the join messages are answered, nothing is
  // ever passed on to the game server
  fromViewer(v, buf) {
    if (!this.ready || !v.greeted || buf.length < 3) return;
    const now = Date.now();
    switch (buf[0]) {
      case MSG.RequestGame:
        if (now - v.lastRequest < 1000) return;
        v.lastRequest = now;
        v.joined = false;
        v.send(this.buildPlayersList());
        break;
      case MSG.PlayerInfo:
        if (v.joined) return;
        v.joined = true;
        for (const m of this.joinBundle()) v.send(m);
        break;
      case MSG.RequestMap:
        if (now - v.lastRequest < 1000) return;
        v.lastRequest = now;
        v.send(this.buildMapReply());
        break;
    }
  }

  // ------------------------------------------------------------ connection

  async connect() {
    this.clearTimers();
    this.state = 'joining';
    this.error = '';
    this.resetMatch();
    try {
      let ip = this.cfg.host;
      if (net.isIP(ip) === 0) ip = (await dns.lookup(ip, { family: 4 })).address;
      this.ip = ip;
    } catch (e) {
      if (this.state === 'joining') this.fail('cannot resolve ' + this.cfg.host + ': ' + e.message);
      return;
    }
    if (this.state !== 'joining') return;  // given up while resolving (no viewers left)
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (data, rinfo) => {
      if (sock !== this.sock || rinfo.address !== this.ip || rinfo.port !== this.cfg.port) return;
      this.onDatagram(data);
    });
    sock.on('error', (e) => { if (sock === this.sock) this.fail('udp: ' + e.message); });
    await new Promise((resolve) => sock.bind(0, resolve));
    if (sock !== this.sock) return;
    this.lastHeard = Date.now();
    this.joinStarted = Date.now();
    const retry = () => {
      if (this.state !== 'joining') return;
      if (Date.now() - this.joinStarted > JOIN_TIMEOUT_MS) { this.fail('the server does not answer'); return; }
      if (this.match.cipher) this.sendPlayerInfo(); else this.sendRequestGame();
      // the first request often goes unanswered: retry it sooner (the server bans addresses
      // that send more than 18 join messages within ~16 s)
      this.setTimer('join', Date.now() - this.joinStarted < 500 ? 1000 : JOIN_RETRY_MS, retry);
    };
    retry();
    this.log(`joining ${this.ip}:${this.cfg.port} as "${this.playerName}"`);
  }

  disconnect(reason, message = 'The match feed stopped: ' + reason) {
    if (this.sock) {
      const sock = this.sock;
      const close = () => { try { sock.close(); } catch (_) {} };
      if (this.match.own && this.match.cipher) {
        const b = Buffer.alloc(5);
        b[0] = MSG.PlayerDisconnect;
        b[3] = this.match.own;
        b[4] = 9;                 // KICK_LEFTGAME: the server ignores other reasons
        this.match.cipher.fields(b, [[3, 1]]);
        // closing the socket at once would drop the queued datagram
        try { sock.send(setHash(b), this.cfg.port, this.ip, close); } catch (_) { close(); }
      } else {
        close();
      }
      this.sock = null;
    }
    this.clearTimers();
    this.queue = [];
    if (this.state !== 'idle') this.log('left:', reason);
    this.state = 'idle';
    this.ready = false;
    // viewers' clients knew this session; they come back with a fresh join (the page retries)
    for (const v of [...this.viewers]) {
      this.viewers.delete(v);
      v.sendText({ type: 'error', message, ...(reason === 'wrong password' && { reason: 'password' }) });
      v.close(1011);
    }
  }

  fail(reason) {
    const wait = RECONNECT_MS[Math.min(this.failures, RECONNECT_MS.length - 1)];
    this.failures++;
    this.log(`${reason}; retrying in ${wait / 1000} s`);
    this.disconnect(reason);
    this.state = 'waiting';
    this.error = reason;
    this.setTimer('reconnect', wait, () => {
      this.state = 'idle';
      if (this.viewers.size) this.connect();
    });
  }

  // The password was wrong: the viewers who gave it count a wrong try. With an older one
  // that worked the hub tries that again, else everyone is told and no new one is tried for
  // a while (the server bans addresses that keep joining).
  wrongPassword() {
    const tried = this.password;
    if (tried === this.knownPassword) this.knownPassword = '';
    this.passwordHold = Date.now() + PASSWORD_HOLD_MS;
    for (const v of this.viewers) if (v.password === tried && v.wrongPassword) v.wrongPassword();
    if (this.knownPassword) {
      this.log('wrong password, trying the last one that worked');
      this.password = this.knownPassword;
      try { this.sock.close(); } catch (_) {}
      this.sock = null;
      this.connect();
      return;
    }
    this.password = '';
    this.disconnect('wrong password', 'Wrong password.');
  }

  sendRaw(buf) {
    if (this.sock) try { this.sock.send(buf, this.cfg.port, this.ip); } catch (_) {}
  }

  sendRequestGame() {
    const pw = Buffer.from(this.password, 'latin1');
    const b = Buffer.alloc(46 + pw.length);
    b[0] = MSG.RequestGame;
    b[3] = 0;
    b.write('1.7.1', 4, 'latin1');
    writeFixed(b, 9, NAME_LEN, this.playerName);
    b[33] = 11;
    b.write(this.hwid, 34, 'latin1');
    pw.copy(b, 45);
    this.sendRaw(setHash(b));
  }

  sendPlayerInfo() {
    const b = Buffer.alloc(65);
    b[0] = MSG.PlayerInfo;
    writeFixed(b, 3, NAME_LEN, this.playerName);
    b.writeUInt32LE(0x25B400, 27);
    b[31] = 0;                    // look
    b[32] = TEAM_SPECTATOR;
    for (const [o, c] of [[33, 0xFF808080], [37, 0xFF808080], [41, 0xFFE6B478], [45, 0xFF000000], [49, 0xFFFFFF00]]) {
      b.writeUInt32LE(c, o);
    }
    b[53] = 11;
    b.write(this.hwid, 54, 'latin1');
    this.match.cipher.fields(b, [[33, 4], [37, 4], [41, 4], [45, 4], [49, 4], [32, 1], [31, 1], [27, 4], [53, 12]]);
    this.sendRaw(setHash(b));
  }

  sendCamera() {
    if (!this.match.own || !this.match.cipher) return;
    const b = Buffer.alloc(4);
    b[0] = MSG.ClientSpriteSnapshotDead;
    b[3] = this.director.target || 0;
    this.match.cipher.fields(b, [[3, 1]]);
    this.sendRaw(setHash(b));
  }

  // ------------------------------------------------------------ from the server

  onDatagram(data) {
    this.lastHeard = Date.now();
    const wasLive = this.state === 'live';  // our own join is not part of the stream
    const msgs = splitDatagram(data);
    for (const m of msgs) {
      this.react(m);
      // news between our PlayersList and our NewPlayer
      if (this.state === 'joining' && this.match.base) this.track(m);
    }
    if (!wasLive || this.state !== 'live') return;
    if (this.delayMs > 0) this.queue.push({ at: Date.now() + this.delayMs, dgram: data, msgs });
    else this.deliver(data, msgs);
  }

  // immediate reactions of our own connection (not delayed)
  react(m) {
    const id = m[0];
    if (this.state === 'joining') {
      if (id === MSG.PlayersList && m.length >= PLAYERS_LIST_SIZE && !this.match.cipher) {
        this.match.cipher = new SessionCipher(m.readUInt16LE(PL.sessionId));
        this.liveList = Buffer.from(m);
        this.match.base = Buffer.from(m);
        this.trackPlayersList(m);
        this.sendPlayerInfo();
      } else if (id === MSG.UnAccepted) {
        const state = m[3];
        const text = fixedString(m, 4, m.length - 4);
        if (state === 3 && this.cfg.askPassword) { this.wrongPassword(); return; }
        const why = { 2: 'wrong version', 3: 'wrong password', 4: 'banned', 5: 'server or spectator slots full',
          7: 'invalid hardware id' }[state] || 'refused';
        this.fail(`server refused the spectator: ${why}${text ? ' (' + text + ')' : ''}`);
      } else if (id === MSG.NewPlayer && this.match.cipher && this.isOwnName(fixedString(m, 7, NAME_LEN))) {
        if (m[51] !== TEAM_SPECTATOR) {
          // never play: a server without spectator slots puts us into a team
          this.match.own = m[3];
          this.fail('the server has no free spectator slot');
          return;
        }
        this.goLive(m);
      }
      return;
    }
    if (this.state !== 'live') return;
    if (id === MSG.Ping && m.length >= 5) {
      this.sendRaw(setHash(Buffer.from([MSG.Pong, 0, 0, m[4]])));
    } else if (id === MSG.StatusRequest) {
      const b = Buffer.alloc(9);
      b[0] = 40;                                  // StatusReply
      b[3] = (this.liveList[PL.flags] >> 1) & 1;  // realistic mode
      b.writeInt32LE(0, 4);                       // jets: none, we are no sprite
      this.match.cipher.fields(b, [[3, 1], [4, 4], [8, 1]]);
      this.sendRaw(setHash(b));
    } else if (id === MSG.ServerDisconnect) {
      this.fail('the server closed the connection');
    } else if (id === MSG.PlayerDisconnect && m[3] === this.match.own) {
      this.fail('kicked from the server');
    } else if (id === MSG.NewPlayer && m[3] === this.match.own && m[51] !== TEAM_SPECTATOR) {
      this.fail('the server moved the spectator into a team');
    } else {
      this.directorSee(m);
    }
  }

  isOwnName(name) {
    if (name === this.playerName) return true;
    const p = name.lastIndexOf('(');
    return p > 0 && name.endsWith(')') && this.playerName.startsWith(name.slice(0, p));
  }

  goLive(ownNewPlayer) {
    this.state = 'live';
    this.failures = 0;
    this.error = '';
    this.knownPassword = this.password;
    this.clearTimer('join');
    this.match.own = ownNewPlayer[3];
    this.match.ownName = fixedString(ownNewPlayer, 7, NAME_LEN);
    this.match.ownNewPlayer = Buffer.from(ownNewPlayer);
    this.setTimer('camera', CAMERA_MS, () => this.cameraTick(), true);
    this.setTimer('flush', 20, () => this.flush(), true);
    this.log(`live in slot ${this.match.own} as "${this.match.ownName}" on ${this.match.map}`);
    // with a delay, viewers start once the delayed stream has caught up with the state
    // they get at their join
    this.setTimer('ready', this.delayMs, () => {
      this.ready = true;
      for (const v of this.viewers) this.greet(v);
    });
  }

  greet(v) {
    v.greeted = true;
    v.sendText({ type: 'ready', name: this.match.ownName, server: this.cfg.name, delay: this.delayMs / 1000 });
  }

  cameraTick() {
    if (Date.now() - this.lastHeard > SILENCE_MS) { this.fail('the server stopped sending'); return; }
    this.directorTick();
    this.sendCamera();
  }

  flush() {
    const now = Date.now();
    while (this.queue.length && this.queue[0].at <= now) {
      const item = this.queue.shift();
      if (item.json) this.broadcastText(item.json);
      else this.deliver(item.dgram, item.msgs);
    }
  }

  deliver(dgram, msgs) {
    for (const m of msgs) this.track(m);
    for (const v of this.viewers) {
      if (v.joined && v.buffered < 1 << 20) v.send(dgram);  // too slow: dropped like UDP
    }
  }

  broadcastText(obj) {
    for (const v of this.viewers) if (v.joined) v.sendText(obj);
  }

  // ------------------------------------------------------------ match state (as viewers see it)

  resetMatch() {
    this.match = {
      cipher: null, base: null, own: 0, ownName: '', ownNewPlayer: null, time: null,
      map: '', roster: new Array(MAX_PLAYERS + 1).fill(null),
      vars: null, gravity: null, weaponActive: new Map(), things: new Map(), heartbeat: null,
      sync: null, syncAt: 0, mapChange: null, mapChangeAt: 0, ticks: 0, ticksAt: 0,
    };
    this.director = { target: 0, since: 0, carriers: new Map(), lastKill: { killer: 0, at: 0 } };
    this.liveList = null;
  }

  trackPlayersList(b) {
    const r = this.match.roster;
    this.match.map = fixedString(b, PL.mapName, 16);
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const name = fixedString(b, PL.name + (i - 1) * NAME_LEN, NAME_LEN);
      if (!name || name === '0 ') { r[i] = null; continue; }
      const p = { name, team: b[PL.team + i - 1], look: b[PL.look + i - 1] };
      for (const k of ['shirt', 'pants', 'skin', 'hair', 'jet']) p[k] = b.readUInt32LE(PL[k] + (i - 1) * 4);
      p.pos = Buffer.from(b.subarray(PL.pos + (i - 1) * 8, PL.pos + i * 8));
      p.vel = Buffer.from(b.subarray(PL.vel + (i - 1) * 8, PL.vel + i * 8));
      r[i] = p;
    }
    this.match.ticks = b.readInt32LE(PL.serverTicks);
    this.match.ticksAt = Date.now();
    this.match.time = { left: b.readInt32LE(PL.timeLeft), at: Date.now() };
  }

  track(m) {
    const s = this.match;
    const id = m[0];
    const num = m[3];
    switch (id) {
      case MSG.NewPlayer: {
        if (num < 1 || num > MAX_PLAYERS) break;
        const p = { name: fixedString(m, 7, NAME_LEN), team: m[51], look: m[52] };
        ['shirt', 'pants', 'skin', 'hair', 'jet'].forEach((k, j) => { p[k] = m.readUInt32LE(31 + j * 4); });
        p.pos = Buffer.from(m.subarray(53, 61));
        p.vel = Buffer.alloc(8);
        s.roster[num] = p;
        if (num === s.own) s.ownNewPlayer = Buffer.from(m);
        break;
      }
      case MSG.PlayerDisconnect:
        if (num >= 1 && num <= MAX_PLAYERS) s.roster[num] = null;
        break;
      case MSG.ServerSpriteSnapshot:
      case MSG.ServerSpriteSnapshotMajor:
      case MSG.DeltaMovement: {
        const p = s.roster[num];
        if (p) { m.copy(p.pos, 0, 4, 12); m.copy(p.vel, 0, 12, 20); }
        const tickAt = id === MSG.ServerSpriteSnapshot ? 37 : id === MSG.DeltaMovement ? 23 : 28;
        if (m.length >= tickAt + 4) { s.ticks = m.readInt32LE(tickAt); s.ticksAt = Date.now(); }
        break;
      }
      case MSG.ServerVars: s.vars = Buffer.from(m); break;
      case MSG.Gravity: s.gravity = Buffer.from(m); break;
      case MSG.WeaponActive: s.weaponActive.set(m[4], Buffer.from(m)); break;
      case MSG.HeartBeat: case MSG.HeartBeat16: case MSG.HeartBeat8: s.heartbeat = Buffer.from(m); break;
      case MSG.ServerSyncMsg: s.sync = Buffer.from(m); s.syncAt = Date.now(); break;
      case MSG.ThingMustSnapshot:
      case MSG.ThingSnapshot:
        s.things.set(num, { msg: Buffer.from(m), style: m[5], taken: false });
        break;
      case MSG.ThingTaken: {
        const t = s.things.get(num);
        if (t && !FLAG_STYLES.has(t.style)) t.taken = true;
        break;
      }
      case MSG.MapChange:
        s.mapChange = Buffer.from(m);
        s.mapChangeAt = Date.now();
        break;
    }
    // a map change takes effect when its countdown ends
    if (s.mapChange) {
      const ticks = s.mapChange.readInt16LE(3);
      if (Date.now() - s.mapChangeAt >= (ticks * 1000) / TICKS_PER_SECOND) {
        s.map = fixedString(s.mapChange, 6, Math.min(16, s.mapChange[5]));
        s.mapChange = null;
        s.things.clear();
        s.sync = null;
        s.time = { left: s.base.readInt32LE(PL.timeLimit), at: Date.now() };  // the clock starts again
      }
    }
  }

  // ------------------------------------------------------------ answers to viewers

  serverTicksNow() {
    const s = this.match;
    return s.ticks + Math.round(((Date.now() - s.ticksAt) * TICKS_PER_SECOND) / 1000);
  }

  timeLeftNow() {
    const s = this.match;
    if (s.sync) {
      const left = s.sync.readInt32LE(3);
      if (s.sync[7]) return left;  // paused
      return Math.max(0, left - Math.round(((Date.now() - s.syncAt) * TICKS_PER_SECOND) / 1000));
    }
    return Math.max(0, s.time.left - Math.round(((Date.now() - s.time.at) * TICKS_PER_SECOND) / 1000));
  }

  buildPlayersList() {
    const s = this.match;
    const b = Buffer.from(s.base);
    writeFixed(b, PL.mapName, 16, s.map);
    let count = 0;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      const p = i === s.own ? null : s.roster[i];
      const o = i - 1;
      if (!p) {
        writeFixed(b, PL.name + o * NAME_LEN, NAME_LEN, '0 ');
        b[PL.team + o] = 0;
        b[PL.look + o] = 0;
        for (const k of ['shirt', 'pants', 'skin', 'hair', 'jet']) b.writeUInt32LE(0, PL[k] + o * 4);
        b.fill(0, PL.pos + o * 8, PL.pos + o * 8 + 8);
        b.fill(0, PL.vel + o * 8, PL.vel + o * 8 + 8);
        continue;
      }
      count++;
      writeFixed(b, PL.name + o * NAME_LEN, NAME_LEN, p.name);
      b[PL.team + o] = p.team;
      b[PL.look + o] = p.look;
      for (const k of ['shirt', 'pants', 'skin', 'hair', 'jet']) b.writeUInt32LE(p[k], PL[k] + o * 4);
      p.pos.copy(b, PL.pos + o * 8);
      p.vel.copy(b, PL.vel + o * 8);
    }
    b[PL.players] = count;
    // the predator seconds of the list the hub joined with are long out of date (a viewer's
    // client would draw that slot see-through); the hub does not track the bonus
    b.fill(0, PL.predDuration, PL.predDuration + MAX_PLAYERS);
    b.writeInt32LE(this.timeLeftNow(), PL.timeLeft);
    b.writeInt32LE(this.serverTicksNow(), PL.serverTicks);
    return setHash(b);
  }

  // what a joining player gets after its PlayerInfo
  joinBundle() {
    const s = this.match;
    const out = [];
    if (s.ownNewPlayer) out.push(s.ownNewPlayer);
    if (s.vars) out.push(s.vars);
    if (s.gravity) out.push(s.gravity);
    for (const m of s.weaponActive.values()) out.push(m);
    for (const t of s.things.values()) if (!t.taken) out.push(t.msg);
    if (s.heartbeat) out.push(s.heartbeat);
    if (s.sync) {
      const b = Buffer.from(s.sync);
      b.writeInt32LE(this.timeLeftNow(), 3);
      out.push(setHash(b));
    }
    if (s.mapChange) {
      const b = Buffer.from(s.mapChange);
      const left = s.mapChange.readInt16LE(3) - Math.round(((Date.now() - s.mapChangeAt) * TICKS_PER_SECOND) / 1000);
      b.writeInt16LE(Math.max(1, left), 3);
      out.push(setHash(b));
    }
    return out;
  }

  // the answer to RequestMap: MapChange with Counter 5 and both fields encrypted
  buildMapReply() {
    const b = Buffer.alloc(22);
    b[0] = MSG.MapChange;
    b.writeInt16LE(5, 3);
    const name = this.match.map.slice(0, 16);
    b[5] = name.length;
    b.write(name, 6, 'latin1');
    this.match.cipher.fields(b, [[3, 2], [5, 17]]);
    return setHash(b);
  }

  // ------------------------------------------------------------ director

  // The server sends frequent updates (and bullets) only around a spectator's camera
  // target, so the hub picks one for everybody: a flag carrier, else whoever just
  // scored a kill, else the best player; held for a few seconds.
  directorSee(m) {
    const d = this.director;
    const id = m[0];
    if ((id === MSG.ThingSnapshot || id === MSG.ThingMustSnapshot) && FLAG_STYLES.has(m[5])) {
      if (m[6]) d.carriers.set(m[3], m[6]); else d.carriers.delete(m[3]);
    } else if (id === MSG.SpriteDeath && m[4] && m[4] !== m[3]) {
      d.lastKill = { killer: m[4], at: Date.now() };
    } else if (id === MSG.PlayerDisconnect && d.target === m[3]) {
      d.target = 0;
    }
  }

  directorTick() {
    const d = this.director;
    const now = Date.now();
    const roster = this.match.roster;
    const valid = (n) => n && roster[n] && roster[n].team !== TEAM_SPECTATOR && n !== this.match.own;
    let want = 0;
    for (const holder of d.carriers.values()) if (valid(holder)) { want = holder; break; }
    if (!want && now - d.lastKill.at < 4000 && valid(d.lastKill.killer)) want = d.lastKill.killer;
    if (!valid(d.target) || (want && want !== d.target && now - d.since > DIRECTOR_HOLD_MS)) {
      if (!want) want = roster.findIndex((p, i) => valid(i));
      if (want > 0 && want !== d.target) {
        d.target = want;
        d.since = now;
        const item = { type: 'follow', slot: want };
        if (this.delayMs > 0) this.queue.push({ at: now + this.delayMs, json: item });
        else this.broadcastText(item);
      }
    }
  }

  // ------------------------------------------------------------ timers

  setTimer(name, ms, fn, repeat = false) {
    this.clearTimer(name);
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
    t.hubName = name;
    this.timers.add(t);
  }

  clearTimer(name) {
    for (const t of this.timers) {
      if (t.hubName === name) { clearTimeout(t); clearInterval(t); this.timers.delete(t); }
    }
  }

  clearTimers() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }
}
