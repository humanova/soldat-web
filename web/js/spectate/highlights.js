// The highlights of a recorded match, found in its messages (a demo as parseDemo in replay.js
// reads it): runs of kills, very long shots, flag carriers stopped just short of scoring, and
// the captures. The page plays them as a reel; the hub lists how many a demo has
// (relay/lib/recorder.mjs), counted the same way.
//
// A highlight: { type, tick (the moment), from, to (the clip), slot, name and team (who made
// it), cams (whom the camera follows from when), label, score (how good it is, to rank them) }.

const TICKS = 60;
const MSG = { MapChange: 8, ThingSnapshot: 9, ThingTaken: 12, SpriteDeath: 13, PlayersList: 16, NewPlayer: 17,
  FlagInfo: 32, ThingMustSnapshot: 33 };
const MAX_PLAYERS = 32, NAME_LEN = 24;
const PL_NAME = 108, PL_TEAM = 1516;
const ALPHA_FLAG = 1, BRAVO_FLAG = 2;               // thing styles; a flag of team n is style n
const CAPTURE_STYLES = new Set([3, 4]);             // FlagInfo: CAPTURERED, CAPTUREBLUE
const MULTIKILL_GAP = 180;                          // Constants.pas MULTIKILLINTERVAL: the game's own count
const MULTIKILL_MIN = 3;
const LONG_SHOT = 55;                               // m (the game's 14 px): about 1 kill in 300
const LONG_SHOT_CUT = 20;                           // ticks before the kill
const SAVE_NEAR = 0.25;                             // of the way between the bases
const BEFORE = 3 * TICKS, AFTER = 1.5 * TICKS;
const CAPTURE_RUN = 12 * TICKS;                     // at most this much of the run before a capture

export const HIGHLIGHT_TYPES = ['multi', 'long', 'save', 'cap'];

const MULTIKILL_NAMES = { 3: 'Triple kill', 4: 'Multi kill', 5: 'Multi kill ×2', 6: 'Serial kill', 7: 'Insane kills' };
const WEAPONS = {
  0: 'USSOCOM', 1: 'Desert Eagles', 2: 'MP5', 3: 'Ak-74', 4: 'Steyr AUG', 5: 'Spas-12', 6: 'Ruger 77', 7: 'M79',
  8: 'Barrett', 9: 'Minimi', 10: 'Minigun', 205: 'flamer', 206: 'fists', 207: 'bow', 208: 'bow', 210: 'cluster grenade',
  211: 'knife', 212: 'chainsaw', 222: 'grenade', 224: 'LAW', 225: 'M2',
};

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function fixedString(b, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < b.length && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
}

// demo: { msgs, at, ticks }; end: where the match ends (the replay's length, default its ticks)
export function findHighlights(demo, end = demo.ticks) {
  const { msgs, at } = demo;
  const players = new Array(MAX_PLAYERS + 1).fill(null);   // { name, team }
  const holder = { [ALPHA_FLAG]: 0, [BRAVO_FLAG]: 0 };
  const grabbed = { [ALPHA_FLAG]: 0, [BRAVO_FLAG]: 0 };     // when the carrier took it
  const flagPos = { [ALPHA_FLAG]: null, [BRAVO_FLAG]: null };
  const resting = { [ALPHA_FLAG]: new Map(), [BRAVO_FLAG]: new Map() };  // where a flag lies: its base, mostly
  const kills = [], carrierKills = [], caps = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i], t = at[i];
    if (t > end) break;
    switch (m[0]) {
      case MSG.PlayersList:
        if (m.length < PL_TEAM + MAX_PLAYERS) break;
        for (let s = 1; s <= MAX_PLAYERS; s++) {
          const name = fixedString(m, PL_NAME + (s - 1) * NAME_LEN, NAME_LEN);
          players[s] = name && name !== '0 ' ? { name, team: m[PL_TEAM + s - 1] } : null;
        }
        break;
      case MSG.NewPlayer:
        if (m[3] >= 1 && m[3] <= MAX_PLAYERS && m.length >= 61) players[m[3]] = { name: fixedString(m, 7, NAME_LEN), team: m[51] };
        break;
      case MSG.ThingSnapshot:
      case MSG.ThingMustSnapshot: {
        const flag = m[5];
        if ((flag !== ALPHA_FLAG && flag !== BRAVO_FLAG) || m.length < 15) break;
        const d = dv(m);
        flagPos[flag] = { x: d.getFloat32(7, true), y: d.getFloat32(11, true) };
        if (m[6] !== holder[flag]) { holder[flag] = m[6]; grabbed[flag] = t; }
        if (!m[6]) {
          const k = `${Math.round(flagPos[flag].x / 20)},${Math.round(flagPos[flag].y / 20)}`;
          resting[flag].set(k, (resting[flag].get(k) || 0) + 1);
        }
        break;
      }
      case MSG.ThingTaken: {
        const flag = m[5];
        if (flag !== ALPHA_FLAG && flag !== BRAVO_FLAG) break;
        // a team takes the other's flag and returns its own
        const p = players[m[4]];
        const by = p && p.team !== flag ? m[4] : 0;
        if (by !== holder[flag]) { holder[flag] = by; grabbed[flag] = t; }
        break;
      }
      case MSG.FlagInfo:
        if (CAPTURE_STYLES.has(m[3]) && m[4] >= 1 && m[4] <= MAX_PLAYERS) {
          const flag = m[3] === 3 ? BRAVO_FLAG : ALPHA_FLAG;   // Alpha scores with Bravo's flag
          caps.push({ tick: t, slot: m[4], by: players[m[4]], since: grabbed[flag] });
          holder[flag] = 0;
        }
        break;
      case MSG.SpriteDeath: {
        if (m.length < 280) break;
        const victim = m[3], killer = m[4], d = dv(m);
        const v = players[victim], k = players[killer];
        const enemy = killer !== victim && v && k && v.team !== k.team;
        for (const flag of [ALPHA_FLAG, BRAVO_FLAG]) {
          if (holder[flag] !== victim) continue;
          // stopped on the way home: the carrier's own flag was there to score with
          const own = flag === ALPHA_FLAG ? BRAVO_FLAG : ALPHA_FLAG;
          if (enemy && !holder[own]) {
            carrierKills.push({ tick: t, slot: killer, by: k, victim, of: v, own, home: flagPos[own],
              x: d.getFloat32(8, true), y: d.getFloat32(12, true) });
          }
          holder[flag] = 0;
          grabbed[flag] = t;
        }
        if (enemy) kills.push({ tick: t, slot: killer, by: k, victim, weapon: m[5], dist: d.getFloat32(271, true) });
        break;
      }
      case MSG.MapChange:
        // the scoreboard: what happens on it does not count
        end = Math.min(end, t);
        break;
    }
  }

  // by: the player as they were then; cams: whom the camera follows from when (the player,
  // unless the clip says otherwise)
  const clip = ({ by, ...h }, from, to, cams = [{ tick: from, slot: h.slot }]) =>
    ({ ...h, name: by ? by.name : '', team: by ? by.team : 0, from: Math.max(0, from), to: Math.min(end, to), cams });
  const out = [];

  // runs of kills: the game's own multi-kill count
  const runs = new Map();
  for (const k of kills) {
    const r = runs.get(k.slot);
    if (r && k.tick - r.last <= MULTIKILL_GAP) { r.n++; r.last = k.tick; continue; }
    if (r && r.n >= MULTIKILL_MIN) out.push(multi(r));
    runs.set(k.slot, { slot: k.slot, by: k.by, first: k.tick, last: k.tick, n: 1 });
  }
  for (const r of runs.values()) if (r.n >= MULTIKILL_MIN) out.push(multi(r));
  function multi(r) {
    return clip({ type: 'multi', tick: r.last, slot: r.slot, by: r.by, kills: r.n, score: 2 ** (r.n - 2),
      label: MULTIKILL_NAMES[Math.min(7, r.n)] }, r.first - BEFORE, r.last + AFTER);
  }

  for (const k of kills) {
    if (k.dist < LONG_SHOT) continue;
    out.push(clip({ type: 'long', tick: k.tick, slot: k.slot, by: k.by, victim: k.victim, distance: Math.round(k.dist),
      score: 1 + (k.dist - LONG_SHOT) / 10, label: `${WEAPONS[k.weapon] ? WEAPONS[k.weapon] + ' kill' : 'Kill'} from ${Math.round(k.dist)} m` },
      // the victim is off the screen: the camera goes to them just before the shot lands
      k.tick - BEFORE, k.tick + AFTER, [{ tick: k.tick - BEFORE, slot: k.slot }, { tick: k.tick - LONG_SHOT_CUT, slot: k.victim }]));
  }

  // where each flag lies most: its base
  const base = {};
  for (const flag of [ALPHA_FLAG, BRAVO_FLAG]) {
    let best = null, n = 0;
    for (const [k, c] of resting[flag]) if (c > n) { best = k; n = c; }
    if (best) { const [x, y] = best.split(',').map(Number); base[flag] = { x: x * 20, y: y * 20 }; }
  }
  if (base[ALPHA_FLAG] && base[BRAVO_FLAG]) {
    const span = Math.hypot(base[ALPHA_FLAG].x - base[BRAVO_FLAG].x, base[ALPHA_FLAG].y - base[BRAVO_FLAG].y);
    for (const c of carrierKills) {
      const b = base[c.own];
      // the carrier's own flag at home, the carrier close to it
      if (!span || !c.home || Math.hypot(c.home.x - b.x, c.home.y - b.y) > 60) continue;
      const near = Math.hypot(c.x - b.x, c.y - b.y) / span;
      if (near > SAVE_NEAR) continue;
      out.push(clip({ type: 'save', tick: c.tick, slot: c.slot, by: c.by, victim: c.victim, score: 1 + 2 * (1 - near / SAVE_NEAR),
        label: `Stopped ${c.of.name} from scoring` }, c.tick - BEFORE - TICKS, c.tick + AFTER));
    }
  }

  for (const c of caps) {
    if (c.tick > end) continue;
    // the run from the grab (at least the last few seconds of it)
    const from = Math.min(c.tick - 2 * BEFORE, Math.max(c.tick - CAPTURE_RUN, c.since - TICKS));
    out.push(clip({ type: 'cap', tick: c.tick, slot: c.slot, by: c.by, score: 1, label: 'Capture' }, from, c.tick + 2 * TICKS));
  }

  return out.filter((h) => h.tick <= end).sort((a, b) => a.from - b.from || a.tick - b.tick);
}

// { multi, long, save, cap }: how many of each
export function countHighlights(list) {
  const n = Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, 0]));
  for (const h of list) n[h.type]++;
  return n;
}
