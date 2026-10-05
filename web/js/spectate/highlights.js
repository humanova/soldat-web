// The highlights of a recorded match, found in its messages (a demo as parseDemo in replay.js
// reads it): runs of kills, two quick kills with a weapon switch, very long shots, long knife
// throws, flag carriers stopped just short of scoring, carriers who killed their way home to
// score, and the captures. The page plays them
// as a reel of clips; the hub lists how many a demo has (relay/lib/recorder.mjs), counted the
// same way.
//
// A play: { type, tick (the moment), from, to (what to show of it), slot, name and team (who
// made it), cams (whom the camera follows from when), label, caption (the label to show:
// text, and weapons by a kill's weapon number for their pictures), score (how good it is, to
// rank them) }. A shot across the screen also has shot: { killer, victim, tick, fired (the tick the
// shot left), back (more kills follow: the camera goes back to the killer, not on to the
// victim) }, for the camera to show both; a play of several kills has wide (zoom out by that
// much).
//
// A clip: plays whose times overlap are one, so the reel shows no moment twice. { from, to,
// parts (its plays in order, each with start and end: the part of the clip that is theirs),
// wide (the most of its parts), score (theirs added up), and the best part's type, tick,
// slot, name, team, label and caption }.

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
const KNIFE_THROW = 20;                             // m: about 1 knife kill in 10, a lobbed throw
const COMBO_GAP = 90;                               // two kills with a weapon switch, at most this apart: about 1 in 9 minutes
const WIDE = 0.26;                                  // a clip of several kills: 1.3 times the view
const SAVE_NEAR = 0.25;                             // of the way between the bases
const BEFORE = 3 * TICKS, AFTER = 1.5 * TICKS;
const CAPTURE_RUN = 12 * TICKS;                     // at most this much of the run before a capture
const CARRY_KILLS = 2;                              // a carrier who kills this many on the way home: about 1 capture in 12
const MERGE_GAP = TICKS / 2;                        // clips closer than this are one
const SHOWN = 0.75 * TICKS, LEAD = 1.5 * TICKS;     // in a clip: of one play after it, of the next before it
const RATED = 180;                                  // s: a shorter match (a map left early, a recording's end) is not rated

export const HIGHLIGHT_TYPES = ['multi', 'combo', 'long', 'knife', 'save', 'carry', 'cap'];

const MULTIKILL_NAMES = { 3: 'Triple kill', 4: 'Multi kill', 5: 'Multi kill ×2', 6: 'Serial kill', 7: 'Insane kills' };
const WEAPONS = {
  0: 'USSOCOM', 1: 'Desert Eagles', 2: 'MP5', 3: 'Ak-74', 4: 'Steyr AUG', 5: 'Spas-12', 6: 'Ruger 77', 7: 'M79',
  8: 'Barrett', 9: 'Minimi', 10: 'Minigun', 205: 'flamer', 206: 'fists', 207: 'bow', 208: 'bow', 210: 'cluster grenade',
  211: 'knife', 212: 'chainsaw', 222: 'grenade', 224: 'LAW', 225: 'M2',
};
const KNIFE = 211, LAW = 224;
// what a kill was made with, as far as switching goes: the two grenades are one, as are
// the guns (a grenade and a gun need no switch); a combo takes a knife or a LAW
const weaponKind = (w) => (w === 222 || w === 210 ? 'grenade' : w <= 10 ? 'gun' : String(w));
export const weaponName = (w) => WEAPONS[w] || 'gun';
const capital = (s) => s[0].toUpperCase() + s.slice(1);

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
        if (enemy) {
          kills.push({ tick: t, slot: killer, by: k, victim, weapon: m[5], dist: d.getFloat32(271, true),
            life: d.getFloat32(275, true) });
        }
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

  // runs of kills: the game's own multi-kill count. Two quick ones with a knife or a LAW
  // and something else are a combo; a longer run with them says what it was made with.
  const runs = new Map();
  const runOf = new Map();   // a kill's run, where it has a clip: a shot from off the screen in it is part of that
  for (const k of kills) {
    const r = runs.get(k.slot);
    if (r && k.tick - r.last <= MULTIKILL_GAP) { r.kills.push(k); r.last = k.tick; continue; }
    if (r) run(r);
    runs.set(k.slot, { slot: k.slot, by: k.by, first: k.tick, last: k.tick, kills: [k] });
  }
  for (const r of runs.values()) run(r);
  function run(r) {
    const n = r.kills.length;
    const weapons = r.kills.map((k) => k.weapon);
    const kinds = new Set(weapons.map(weaponKind));
    const switched = kinds.size > 1 && weapons.some((w) => w === KNIFE || w === LAW);
    const names = [...new Set(weapons.map(weaponName))];
    const used = [...new Map(weapons.map((w) => [weaponName(w), w])).values()];
    let h = null;
    if (n >= MULTIKILL_MIN) {
      h = clip({ type: 'multi', tick: r.last, slot: r.slot, by: r.by, kills: n, score: 2 ** (n - 2) * (switched ? 1.5 : 1),
        label: MULTIKILL_NAMES[Math.min(7, n)] + (switched ? ` · ${names.join(', ')}` : ''),
        caption: [MULTIKILL_NAMES[Math.min(7, n)], ...(switched ? used : [])], wide: WIDE },
      r.first - BEFORE, r.last + AFTER);
    } else if (n === 2 && switched && r.last - r.first <= COMBO_GAP) {
      h = clip({ type: 'combo', tick: r.last, slot: r.slot, by: r.by, kills: n, score: 1.5,
        label: capital(names.join(' + ')), caption: used.flatMap((w, i) => (i ? ['+', w] : [w])), wide: WIDE },
      r.first - BEFORE, r.last + AFTER);
    }
    if (!h) return;
    out.push(h);
    for (const k of r.kills) runOf.set(k, h);
  }

  // shots from off the screen: very long ones, and long knife throws (thrown in an arc)
  for (const k of kills) {
    const knife = k.weapon === KNIFE;
    if (k.dist < (knife ? KNIFE_THROW : LONG_SHOT)) continue;
    const m = Math.round(k.dist);
    const score = knife ? 1 + (k.dist - KNIFE_THROW) / 4 : 1 + (k.dist - LONG_SHOT) / 10;
    const shot = { killer: k.slot, victim: k.victim, tick: k.tick, fired: k.tick - Math.max(0, Math.round(k.life * TICKS)), back: false };
    const r = runOf.get(k);
    if (r) {
      // the run's clip shows it (its first such shot)
      if (r.shot) continue;
      r.shot = { ...shot, back: k.tick < r.tick };
      r.score += score;
      r.label += knife ? ` · ${m} m throw` : ` · ${m} m shot`;
      r.caption.push(knife ? `· ${m} m throw` : `· ${m} m shot`);
      continue;
    }
    out.push(clip({ type: knife ? 'knife' : 'long', tick: k.tick, slot: k.slot, by: k.by, victim: k.victim, distance: m,
      score, label: knife ? `Knife throw from ${m} m` : `${WEAPONS[k.weapon] ? WEAPONS[k.weapon] + ' kill' : 'Kill'} from ${m} m`,
      caption: WEAPONS[k.weapon] ? [k.weapon, knife ? `throw from ${m} m` : `from ${m} m`] : [`Kill from ${m} m`], shot },
      // where the camera cannot show both: it goes to the victim just before the shot lands
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
        label: `Stopped ${c.of.name} from scoring`, caption: [`Stopped ${c.of.name} from scoring`] }, c.tick - BEFORE - TICKS, c.tick + AFTER));
    }
  }

  for (const c of caps) {
    if (c.tick > end) continue;
    // the run from the grab (at least the last few seconds of it)
    let from = Math.min(c.tick - 2 * BEFORE, Math.max(c.tick - CAPTURE_RUN, c.since - TICKS));
    // a carrier who fought their way home: the run from their first kill on it
    const fought = kills.filter((k) => k.slot === c.slot && k.tick >= c.since && k.tick <= c.tick);
    if (fought.length >= CARRY_KILLS) {
      from = Math.min(from, fought[0].tick - BEFORE);
      const label = `Capture with ${fought.length} kills on the way`;
      out.push(clip({ type: 'carry', tick: c.tick, slot: c.slot, by: c.by, kills: fought.length, score: 0.5 + fought.length,
        label, caption: [label], wide: WIDE }, from, c.tick + 2 * TICKS));
      continue;
    }
    out.push(clip({ type: 'cap', tick: c.tick, slot: c.slot, by: c.by, score: 1, label: 'Capture', caption: ['Capture'] },
      from, c.tick + 2 * TICKS));
  }

  return clips(out.filter((h) => h.tick <= end));
}

// plays whose times overlap (or nearly) as one clip each
function clips(plays) {
  plays.sort((a, b) => a.from - b.from || a.tick - b.tick);
  const groups = [];
  for (const p of plays) {
    const g = groups[groups.length - 1];
    if (g && p.from < g.to + MERGE_GAP) { g.parts.push(p); g.to = Math.max(g.to, p.to); }
    else groups.push({ from: p.from, to: p.to, parts: [p] });
  }
  return groups.map(({ from, to, parts }) => {
    parts.sort((a, b) => a.tick - b.tick);
    // each part has the clip until the next one's: from where that one's own clip begins,
    // but after a moment of this one's outcome and with a lead into that one's
    let start = from;
    parts = parts.map((p, i) => {
      const next = parts[i + 1];
      let end = to;
      if (next) {
        const lo = p.tick + SHOWN, hi = next.tick - LEAD;
        end = lo <= hi ? Math.min(hi, Math.max(lo, next.from)) : Math.round((p.tick + next.tick) / 2);
        end = Math.max(end, start + 1);
      }
      const part = { ...p, start, end };
      start = end;
      return part;
    });
    const best = parts.reduce((a, b) => (b.score > a.score ? b : a));
    return { type: best.type, tick: best.tick, slot: best.slot, name: best.name, team: best.team, label: best.label, caption: best.caption,
      from, to, parts, wide: Math.max(0, ...parts.map((p) => p.wide || 0)), score: parts.reduce((a, p) => a + p.score, 0) };
  });
}

// How good a match is to watch, 0 to 100: { rating, action, contest, and what they are of },
// or null for a match under 3 minutes or without a play.
//   action (up to 60): the plays' scores (but the captures') in 10 minutes, times 1.5;
//   contest (up to 40): how close it was: the final margin (16 for 0 or 1, 10 for 2, 5 for
//   3), 6 a change of the lead (up to 12), 6 for a win from 2 or more behind, and 0.5 a
//   capture (up to 6).
// clips: findHighlights's; seconds: how long the match is; scores: the final [Alpha, Bravo]
// (by default the captures it has).
export function rateMatch(clips, seconds, scores) {
  const plays = clips.flatMap((c) => c.parts).sort((a, b) => a.tick - b.tick);
  // too short to say, or nothing happened (nobody playing)
  if (seconds < RATED || !plays.length) return null;
  // a fought capture's kills are action; its capture counts in the contest
  const points = plays.reduce((n, p) => n + (p.type === 'cap' ? 0 : p.type === 'carry' ? p.score - 1 : p.score), 0);
  // a short match is not rated up for a play or two
  const perTen = (points * 600) / Math.max(seconds, 300);
  const action = Math.min(60, perTen * 1.5);
  // the score as it went
  const caps = plays.filter((p) => p.type === 'cap' || p.type === 'carry');
  const now = [0, 0, 0];
  const behind = [0, 0, 0];
  let leader = 0, leadChanges = 0;
  for (const c of caps) {
    if (c.team !== 1 && c.team !== 2) continue;
    now[c.team]++;
    const l = now[1] > now[2] ? 1 : now[2] > now[1] ? 2 : 0;
    if (l && leader && l !== leader) leadChanges++;
    if (l) leader = l;
    behind[1] = Math.max(behind[1], now[2] - now[1]);
    behind[2] = Math.max(behind[2], now[1] - now[2]);
  }
  const [a, b] = scores && scores.length >= 2 ? scores : [now[1], now[2]];
  const margin = Math.abs(a - b);
  const winner = a > b ? 1 : b > a ? 2 : 0;
  const comeback = winner ? behind[winner] : 0;
  const close = margin <= 1 ? 16 : margin === 2 ? 10 : margin === 3 ? 5 : 0;
  // a match without captures (or no team game) has no contest to rate
  const contest = caps.length ? close + Math.min(12, 6 * leadChanges) + (comeback >= 2 ? 6 : 0) + Math.min(6, caps.length / 2) : 0;
  const round = (x) => Math.round(x * 10) / 10;
  return { rating: Math.round(action + contest), action: Math.round(action), contest: Math.round(contest),
    points: round(points), perTen: round(perTen), margin, leadChanges, comeback, caps: caps.length };
}

// what a rating is of, in lines: "Action 40 of 60: 26.9 play points in 10 minutes", ...
export function ratingText(r) {
  const s = (n, one, more) => `${n} ${n === 1 ? one : more}`;
  const contest = [r.margin ? `won by ${r.margin}` : 'a draw'];
  if (r.leadChanges) contest.push(s(r.leadChanges, 'change of the lead', 'changes of the lead'));
  if (r.comeback >= 2) contest.push(`a win from ${r.comeback} behind`);
  contest.push(s(r.caps, 'capture', 'captures'));
  return [`Rating ${r.rating} of 100`, `Action ${r.action} of 60: ${r.perTen} play points in 10 minutes`,
    r.caps ? `Contest ${r.contest} of 40: ${contest.join(', ')}` : 'Contest: no captures'];
}

// { multi, combo, long, knife, save, carry, cap }: how many plays of each, in a list of clips
export function countHighlights(list) {
  const n = Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, 0]));
  for (const c of list) for (const p of c.parts) n[p.type]++;
  return n;
}
