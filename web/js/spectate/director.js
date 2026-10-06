// The auto camera's director: whom Auto follows. It scores the players on what the stream
// says about them (the flags, fights, kills, shots, who got hurt, who runs) and moves on only
// for someone clearly better: not before a few seconds, not off a fight that is still on,
// and a moment after the followed player dies, preferably to their killer. A flag taken is
// followed at once. The page's camera (Spectator.pas, Auto) frames whoever it picks with the
// enemies around them, and cuts to a pick far away.
//
// relay/lib/hub.mjs runs it on the live stream: the server sends frequent updates only around
// the hub spectator's camera target, so its pick is everybody's. Its picks are in the demos it
// records; a replay of one recorded before (DIRECTOR_VERSION in its meta) has them worked out
// again (directDemo). Messages are the server's 1.7.1 messages in clear (docs/PROTOCOL-1.7.1.md).

// recordings with the picks of this director say so in their meta (director)
export const DIRECTOR_VERSION = 2;
export const PICK_MS = 500;   // how often the hub asks
export const LEAD_MS = 800;   // with a broadcast delay the camera goes this much early

const MSG = {
  ServerSpriteSnapshot: 3, BulletSnapshot: 5, ThingSnapshot: 9, SpriteDeath: 13, PlayersList: 16,
  NewPlayer: 17, PlayerDisconnect: 19, DeltaMovement: 21, ThingMustSnapshot: 33, ServerSpriteSnapshotMajor: 41,
};
const TEAM_SPECTATOR = 5;
const PL_NAME = 108, PL_TEAM = 1516, NAME_LEN = 24;
const FLAG_STYLES = new Set([1, 2, 3]);  // alpha, bravo, pointmatch
const KEY_FIRE = 1 << 4;

const MIN_HOLD_MS = 3000;     // on one player at least this long, but for a taken flag
const FLAG_HOLD_MS = 1000;
const DEATH_HOLD_MS = 1500;   // the followed player died: a moment on the spot
const KILLER_MS = 3000;       // then their killer is worth more for this long
const BORED_MS = 25_000;      // long on someone with nothing going on: someone else
const SWITCH_RATIO = 1.25;    // someone else is followed when better by this much...
const SWITCH_MARGIN = 6;      // ...and this
const FIGHT_MARGIN = 10;      // ...and this more while the followed player fights
const FIRED_MS = 1500;
const HURT_MS = 2000;
const KILLS_MS = 8000;
const ENGAGE_X = 600, ENGAGE_Y = 350;  // enemies this close fight each other
const NEAR = 700;             // players this close are a crowd

export class Director {
  constructor() {
    this.players = new Map();  // slot -> what the stream said about them
    this.flags = new Map();    // style -> { holder, x, y }
    this.target = 0;
    this.since = 0;
    this.why = '';             // why the last switch (for a look at what it does)
    this.lastKill = { killer: 0, victim: 0, at: 0 };
  }

  player(slot) {
    let p = this.players.get(slot);
    if (!p) {
      p = { x: 0, y: 0, vx: 0, vy: 0, seen: false, health: 0, dead: false, deadAt: 0,
        firedAt: 0, hurtAt: 0, kills: [] };
      this.players.set(slot, p);
    }
    return p;
  }

  // a message of the stream (a Uint8Array); now in ms
  see(m, now) {
    const id = m[0], num = m[3];
    if (m.length < 4) return;
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    switch (id) {
      case MSG.ServerSpriteSnapshot:
        if (m.length >= 33) this.moved(num, dv, 4, dv.getUint16(22, true), dv.getFloat32(29, true), now);
        break;
      case MSG.ServerSpriteSnapshotMajor:
        if (m.length >= 28) this.moved(num, dv, 4, dv.getUint16(26, true), dv.getFloat32(20, true), now);
        break;
      case MSG.DeltaMovement:
        if (m.length >= 22) this.moved(num, dv, 4, dv.getUint16(20, true), null, now);
        break;
      case MSG.BulletSnapshot:
        if (num >= 1 && num <= 32) this.player(num).firedAt = now;
        break;
      case MSG.SpriteDeath: {
        if (num < 1 || num > 32 || m.length < 5) break;
        const p = this.player(num);
        p.dead = true;
        p.deadAt = now;
        const killer = m[4];
        if (killer >= 1 && killer <= 32 && killer !== num) {
          const k = this.player(killer);
          k.kills.push(now);
          if (k.kills.length > 8) k.kills.shift();
          this.lastKill = { killer, victim: num, at: now };
        }
        break;
      }
      case MSG.ThingSnapshot:
      case MSG.ThingMustSnapshot:
        if (FLAG_STYLES.has(m[5]) && m.length >= 15) {
          this.flags.set(m[5], { holder: m[6], x: dv.getFloat32(7, true), y: dv.getFloat32(11, true) });
        }
        break;
      case MSG.PlayerDisconnect:
        this.players.delete(num);
        break;
    }
  }

  moved(num, dv, at, keys, health, now) {
    if (num < 1 || num > 32) return;
    const p = this.player(num);
    p.x = dv.getFloat32(at, true);
    p.y = dv.getFloat32(at + 4, true);
    p.vx = dv.getFloat32(at + 8, true);
    p.vy = dv.getFloat32(at + 12, true);
    p.seen = true;
    if (keys & KEY_FIRE) p.firedAt = now;
    if (health != null && Number.isFinite(health)) {
      if (health < p.health - 0.5 && !p.dead) p.hurtAt = now;
      // back from the dead: up from nothing a while after dying
      if (p.dead && health > 0 && now - p.deadAt > 1000) p.dead = false;
      p.health = health;
    }
  }

  carrierOf(slot) {
    for (const [style, f] of this.flags) if (f.holder === slot) return style;
    return 0;
  }

  // how much there is to see around `slot`; null: nothing (dead, or nowhere yet)
  score(slot, team, players, now) {
    const p = this.players.get(slot);
    if (!p || !p.seen || p.dead) return null;
    let s = 1, fight = 0;
    const enemy = (q) => team === 0 || q.team !== team;
    const flag = this.carrierOf(slot);
    if (flag) {
      s += 50;
      // close to scoring: their own flag where it stands (alpha's carrier scores at bravo's)
      const home = this.flags.get(team);
      if (home && !home.holder) s += 40 * Math.max(0, 1 - Math.hypot(home.x - p.x, home.y - p.y) / 2000);
    }
    for (const q of players) {
      if (q.slot === slot) continue;
      const o = this.players.get(q.slot);
      if (!o || !o.seen || o.dead) continue;
      const dx = Math.abs(o.x - p.x), dy = Math.abs(o.y - p.y);
      if (dx < NEAR && dy < NEAR) s += 1;
      if (!enemy(q)) {
        // escorting a carrier
        if (this.carrierOf(q.slot) && dx < 500 && dy < 400) s += 8;
        continue;
      }
      if (dx < ENGAGE_X && dy < ENGAGE_Y) {
        const shooting = now - p.firedAt < FIRED_MS || now - o.firedAt < FIRED_MS;
        fight += shooting ? 10 : 6;
        // chasing a carrier, or the carrier's chaser
        if (this.carrierOf(q.slot)) s += 20;
      }
    }
    s += Math.min(fight, 30);
    for (const t of p.kills) if (now - t < KILLS_MS) s += 12 * (1 - (now - t) / KILLS_MS);
    if (now - p.hurtAt < HURT_MS) s += 4;
    if (now - p.firedAt < FIRED_MS) s += 3;
    s += Math.min(3, Math.hypot(p.vx, p.vy) / 3);
    return { s, fight: fight > 0 && (now - p.firedAt < FIRED_MS), flag };
  }

  // whom to follow now; players: [{ slot, team }] who may be followed. Returns the slot (0: no one).
  pick(now, players) {
    const scores = new Map();
    let best = 0, bestScore = -1;
    for (const q of players) {
      const r = this.score(q.slot, q.team, players, now);
      if (!r) continue;
      // the followed player's killer, right after
      if (this.lastKill.victim === this.target && this.lastKill.killer === q.slot &&
        now - this.lastKill.at < KILLER_MS) r.s += 15;
      scores.set(q.slot, r);
      if (r.s > bestScore) { best = q.slot; bestScore = r.s; }
    }
    const cur = this.target;
    const still = players.some((q) => q.slot === cur);
    const mine = scores.get(cur);
    const held = now - this.since;
    let next = cur, why = '';
    if (!still || !cur) {
      next = best || (players[0] ? players[0].slot : 0);
      why = 'gone';
    } else if (!mine) {
      // dead (or not seen yet): a moment on the spot, then the best
      const p = this.players.get(cur);
      const diedAgo = p && p.dead ? now - p.deadAt : Infinity;
      if (diedAgo >= DEATH_HOLD_MS && best) { next = best; why = 'dead'; }
    } else if (best && best !== cur) {
      const theirs = scores.get(best);
      const need = mine.s * SWITCH_RATIO + SWITCH_MARGIN + (mine.fight ? FIGHT_MARGIN : 0);
      if (theirs.flag && !mine.flag && held > FLAG_HOLD_MS) { next = best; why = 'flag'; }
      else if (held > MIN_HOLD_MS && theirs.s > need) { next = best; why = 'better'; }
      else if (held > BORED_MS && mine.s < 5 && theirs.s > mine.s + 3) { next = best; why = 'bored'; }
    }
    if (next !== this.target) {
      this.why = why;
      this.target = next;
      this.since = now;
    }
    return this.target;
  }
}

// The picks for a demo (parseDemo in replay.js) as the hub would make them, each LEAD_MS early
// as on a server with a delay: [{ tick, slot }]
export function directDemo(demo, ticksPerSecond = 60) {
  const d = new Director();
  const teams = new Map();
  const cams = [];
  const ms = (tick) => (tick * 1000) / ticksPerSecond;
  const lead = Math.round((LEAD_MS * ticksPerSecond) / 1000);
  let next = 0;
  const pick = (tick) => {
    const players = [...teams].map(([slot, team]) => ({ slot, team }));
    const was = d.target;
    const slot = d.pick(ms(tick), players);
    if (!slot || slot === was) return;
    const last = cams.length ? cams[cams.length - 1].tick : -1;
    cams.push({ tick: Math.max(last + 1, tick - lead, 0), slot, why: d.why });
  };
  for (let i = 0; i < demo.msgs.length; i++) {
    const m = demo.msgs[i], tick = demo.at[i];
    while (ms(tick) >= next) { pick(Math.round((next * ticksPerSecond) / 1000)); next += PICK_MS; }
    if (m[0] === MSG.PlayersList && m.length > PL_TEAM + 32) {
      teams.clear();
      for (let s = 1; s <= 32; s++) {
        const named = m[PL_NAME + (s - 1) * NAME_LEN] > 0;
        const team = m[PL_TEAM + s - 1];
        if (named && team !== TEAM_SPECTATOR) teams.set(s, team);
      }
    } else if (m[0] === MSG.NewPlayer && m.length > 51) {
      if (m[51] === TEAM_SPECTATOR) teams.delete(m[3]); else teams.set(m[3], m[51]);
    } else if (m[0] === MSG.PlayerDisconnect) {
      teams.delete(m[3]);
    }
    d.see(m, ms(tick));
  }
  return cams;
}
