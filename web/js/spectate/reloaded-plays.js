// The highlights and the rating of a Soldat Reloaded match, from its demo (a .srdm,
// relay/lib/reloaded/record.mjs), as a 1.7.1 match's are found (highlights.js): this reads the
// demo into what highlights.js's play finder takes, and the finder does the rest. The kills,
// the flags taken, returned and scored are the server's words in the snapshots; who plays,
// where they are, where the flags are, the clock and the score are the snapshots' state. And
// for a demo recorded without the hub's director's picks (camera records), the picks as it
// would have made them. The relay (relay/lib/reloaded/plays.mjs) and the page both run it.
//
// Ticks are the demo's: its tick records, 60 a second, as its player and the game's bar
// count them. Something the server did on its tick T is put at the first demo tick that
// shows T (its tick record's view), as the game shows it then.
//
//   reloadedPlays(demo, { scores }) -> { clips, highlights, rating, cams? }
// demo: the .srdm's bytes (a Uint8Array, not gzipped); scores: the final [alpha, bravo] the
// match is listed with (default: the snapshots' last). A long match takes a second or two.
import { MSG, STREAM_RING, SIZES, E, Bits, snapshotHeader, snapshotBody, words, fields, TABLES } from './reloaded-wire.js';
import { findPlays, countHighlights, rateMatch } from './highlights.js';
import { PICK_MS, LEAD_MS } from './director.js';
import { ReloadedDirector } from './reloaded-director.js';

const TICKS = 60;
const HEADER_SIZE = 4 + 2 + 2 + 4 + 4 + 1 + 24 + 64;
const PACKET = 1, TICK = 3, CAMERA = 4;
const ALPHA_FLAG = E.Thing_Kind.Alpha_Flag, BRAVO_FLAG = E.Thing_Kind.Bravo_Flag;  // a flag of team n is kind n
const SPECTATOR = E.Team.Spectator;
const PLAYING = E.Round_Wire_Phase.Playing;
const W = E.Weapon;

// a kill's weapon as 1.7.1's kill numbers have it (NetworkClientSprite.pas), which the
// highlights name and picture
const KILL_WEAPON = {
  [W.USSOCOM]: 0, [W.Desert_Eagles]: 1, [W.MP5]: 2, [W.AK74]: 3, [W.Steyr_AUG]: 4, [W.Spas12]: 5, [W.Ruger77]: 6,
  [W.M79]: 7, [W.Barrett]: 8, [W.Minimi]: 9, [W.Minigun]: 10, [W.Punch]: 206, [W.Knife]: 211, [W.Thrown_Knife]: 211,
  [W.Chainsaw]: 212, [W.Frag_Grenade]: 222, [W.LAW]: 224,
};

// a Map message's round (message.odin's msg_map read whole); null for one that can't be read
function mapRound(data) {
  const b = Bits.reader(data);
  b.kind();
  const round = b.u16();
  b.string('', SIZES.Map_Name); b.string('', SIZES.Name);
  b.u16(); b.u8(); b.u32(); b.hash(); b.u8(); b.u32();
  return b.done ? round : null;
}

// The demo's records, in order: what happened at which server tick, and which server tick
// each demo tick showed. { items: [{ tick (the server's), word } or { tick, state }],
// views: [the server tick each demo tick showed], mapChange: the demo tick of the round's
// end (null: none), cameras: its camera records (the hub's director's picks) }.
// onFrame(f, words, tick): each new snapshot as read (snapshotBody's frame), the words new
// in it, at the demo tick it came.
function readDemo(d, onFrame = null) {
  if (d.length < HEADER_SIZE || String.fromCharCode(...d.subarray(0, 4)) !== 'SRDM') throw new Error('not a Soldat Reloaded demo');
  const items = [], views = [];
  const ring = new Array(STREAM_RING).fill(null);
  const heard = new Set();     // the words' seqs: each comes again until acknowledged
  let round = 0, mapChange = null, newest = 0, cameras = 0;
  for (let o = HEADER_SIZE; o + 3 <= d.length;) {
    const kind = d[o], size = d[o + 1] | (d[o + 2] << 8), data = d.subarray(o + 3, o + 3 + size);
    o += 3 + size;
    if (kind === TICK) {
      const t = fields(Bits.reader(data), TABLES.tick_head, {});
      views.push(t.view || 0);
      continue;
    }
    if (kind === CAMERA) cameras++;
    if (kind !== PACKET) continue;
    const b = Bits.reader(data);
    const k = MSG[b.kind()];
    if (k === 'Map') {
      const r = mapRound(data);
      if (r !== null) round = r;
      ring.fill(null);
      heard.clear();
      newest = 0;
      continue;
    }
    if (k === 'Map_Change') {
      if (mapChange === null) mapChange = views.length;
      continue;
    }
    if (k !== 'Snapshot') continue;
    const h = snapshotHeader(b);
    if (!b.ok || h.round !== round) continue;
    let base = null;
    if (h.base) {
      base = ring[h.base % STREAM_RING];
      if (!base || base.tick !== h.base) continue;
    }
    const f = snapshotBody(b, base);
    const said = words(b);
    if (!b.done) continue;
    f.tick = h.tick;
    ring[h.tick % STREAM_RING] = f;
    const fresh = said.filter((w) => !heard.has(w.seq));
    for (const w of fresh) {
      heard.add(w.seq);
      items.push({ tick: w.tick, word: w.word });
    }
    // the state, once for each tick (a later snapshot of a tick says nothing new): as much
    // of it as the plays need
    if (h.tick > newest) {
      newest = h.tick;
      items.push({ tick: h.tick, state: compact(f) });
      if (onFrame) onFrame(f, fresh, views.length);
    }
  }
  // by the server's tick, a tick's words before its state (the state is as the tick left it)
  items.sort((a, b) => a.tick - b.tick || (a.word ? 0 : 1) - (b.word ? 0 : 1));
  return { items, views, mapChange, cameras };
}

// The director's picks for a demo recorded without them (before camera records were written),
// as the hub's would have been (directDemo in web/js/spectate/director.js has a 1.7.1 demo's):
// asked every PICK_MS of the demo's time, each pick LEAD_MS early, as on a server with a
// delay. own: the recorder's soldier (the header's slot). see(f, words, tick) as readDemo's
// onFrame; cams: [{ tick, slot }]
function directing(own) {
  const d = new ReloadedDirector();
  const cams = [];
  const ms = (tick) => (tick * 1000) / TICKS;
  const lead = Math.round((LEAD_MS * TICKS) / 1000);
  let next = 0;
  const pick = (tick) => {
    const was = d.target;
    const slot = d.pickNow(ms(tick));
    if (!slot || slot === was) return;
    const last = cams.length ? cams[cams.length - 1].tick : -1;
    cams.push({ tick: Math.max(last + 1, tick - lead, 0), slot });
  };
  return {
    cams,
    see(f, said, tick) {
      while (ms(tick) >= next) { pick(Math.round((next * TICKS) / 1000)); next += PICK_MS; }
      d.seeFrame(f, said, own, ms(tick));
    },
  };
}

// a snapshot's players (null: gone; a name where it came whole), flags and round
function compact(f) {
  const soldiers = [];
  for (let i = 0; i < 32; i++) {
    const s = f.soldiers[i];
    soldiers[i] = f.word[i] === E.Snap_Word.State && s && s.active
      ? { team: s.team, pos: s['body.pos'], kills: s['tally.kills'], name: f.names[i] || '' } : null;
  }
  const things = [];
  for (let i = 0; i < f.things.length; i++) {
    const t = f.things[i];
    things[i] = f.thingWord[i] === E.Snap_Word.State && t ? { kind: t.kind, holder: t.holder, pos: t['points[0]'] } : null;
  }
  const r = f.round;
  return { soldiers, things, round: r && { phase: r.phase, timeLeft: r.time_left, alpha: r['captures[1]'] || 0, bravo: r['captures[2]'] || 0 } };
}

// what highlights.js's findPlays takes (readMatch there has it for 1.7.1), from a demo
// (and `cameras`, its camera records; with onFrame, readDemo's)
export function readReloadedMatch(demo, onFrame = null) {
  const { items, views, mapChange, cameras } = readDemo(demo, onFrame);
  // the first demo tick showing each server tick: views only grow but where the stream jumps
  const shown = [];
  let top = 0;
  for (let i = 0; i < views.length; i++) { top = Math.max(top, views[i]); shown.push(top); }
  const demoTick = (serverTick) => {
    let lo = 0, hi = shown.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shown[mid] >= serverTick) hi = mid; else lo = mid + 1;
    }
    return lo;
  };

  const players = new Array(33).fill(null);   // slot -> { name, team }
  const names = new Array(32).fill('');
  const thingKind = [];                       // thing id -> kind
  const holder = { [ALPHA_FLAG]: 0, [BRAVO_FLAG]: 0 };
  const grabbed = { [ALPHA_FLAG]: 0, [BRAVO_FLAG]: 0 };
  const flagPos = { [ALPHA_FLAG]: null, [BRAVO_FLAG]: null };
  const resting = { [ALPHA_FLAG]: new Map(), [BRAVO_FLAG]: new Map() };
  const kills = [], carrierKills = [], caps = [];
  const score = [0, 0];
  let clock = null, last = null;
  let end = mapChange ?? views.length;
  const mapChanged = mapChange !== null;

  for (const it of items) {
    const t = demoTick(it.tick);
    if (t > end) break;
    if (it.state) {
      const f = last = it.state;
      for (let i = 0; i < 32; i++) {
        const s = f.soldiers[i];
        if (s && s.name) names[i] = s.name;
        players[i + 1] = s && s.team !== SPECTATOR ? { name: names[i], team: s.team } : null;
      }
      for (let i = 0; i < f.things.length; i++) {
        const th = f.things[i];
        if (!th) { thingKind[i] = 0; continue; }
        thingKind[i] = th.kind;
        if (th.kind !== ALPHA_FLAG && th.kind !== BRAVO_FLAG) continue;
        const flag = th.kind;
        flagPos[flag] = { x: th.pos[0], y: th.pos[1] };
        const by = th.holder == null ? 0 : th.holder + 1;
        if (by !== holder[flag]) { holder[flag] = by; grabbed[flag] = t; }
        if (!by) {
          const k = `${Math.round(flagPos[flag].x / 20)},${Math.round(flagPos[flag].y / 20)}`;
          resting[flag].set(k, (resting[flag].get(k) || 0) + 1);
        }
      }
      const r = f.round;
      if (r) {
        score[0] = r.alpha;
        score[1] = r.bravo;
        clock = r.phase === PLAYING && r.timeLeft > 0 ? { left: r.timeLeft, at: t } : null;
        if (r.phase === E.Round_Wire_Phase.Ended && !mapChanged) end = Math.min(end, t);
      }
      continue;
    }
    const w = it.word;
    if (w.type !== 'Ruling' || !w.inner) continue;
    const r = w.inner;
    if (r.type === 'Kill') {
      const victim = r.target + 1, killer = r.killer + 1;
      const v = players[victim], k = players[killer];
      const enemy = killer !== victim && v && k && v.team !== k.team;
      for (const flag of [ALPHA_FLAG, BRAVO_FLAG]) {
        if (holder[flag] !== victim) continue;
        // stopped on the way home: the carrier's own flag was there to score with
        const own = flag === ALPHA_FLAG ? BRAVO_FLAG : ALPHA_FLAG;
        if (enemy && !holder[own]) {
          carrierKills.push({ tick: t, slot: killer, by: k, victim, of: v, own, home: flagPos[own], x: r.pos[0], y: r.pos[1] });
        }
        holder[flag] = 0;
        grabbed[flag] = t;
      }
      if (enemy) {
        kills.push({ tick: t, slot: killer, by: k, victim, weapon: KILL_WEAPON[r.weapon] ?? 0, dist: r.distance,
          fired: t - Math.max(0, r.airtime) });
      }
    } else if (r.type === 'Flag_Grab') {
      const flag = thingKind[r.flag];
      if (flag === ALPHA_FLAG || flag === BRAVO_FLAG) {
        if (holder[flag] !== r.soldier + 1) { holder[flag] = r.soldier + 1; grabbed[flag] = t; }
      }
    } else if (r.type === 'Flag_Capture') {
      const slot = r.soldier + 1, by = players[slot];
      const team = by ? by.team : 0;
      if (team !== 1 && team !== 2) continue;
      const flag = team === 1 ? BRAVO_FLAG : ALPHA_FLAG;   // alpha scores with bravo's flag
      const lead = score[team - 1] - score[2 - team];
      score[team - 1]++;
      const left = clock && clock.left > 0 ? Math.max(0, clock.left - (t - clock.at)) : null;
      caps.push({ tick: t, slot, by, since: grabbed[flag], team, lead, left });
      holder[flag] = 0;
    }
  }
  // last: the last snapshot read (compact's), its players' tallies for a check
  return { kills, carrierKills, caps, resting, score, mapChanged, end, ticks: views.length, last, names, cameras };
}

// The match's clips (findPlays's), how many plays of each kind, and its rating; and for a
// demo without camera records, cams: the director's picks worked out (directing).
export function reloadedPlays(demo, { scores } = {}) {
  const director = directing(demo.length > 16 ? demo[16] : -1);
  const m = readReloadedMatch(demo, director.see);
  const clips = findPlays(m);
  const seconds = m.ticks / TICKS;
  return { clips, highlights: countHighlights(clips), rating: rateMatch(clips, seconds, scores || m.score),
    ...(m.cameras ? {} : { cams: director.cams }) };
}

// A Soldat Reloaded demo's plays, for the page (a demo file dropped on it, read where it is):
// reloadedPlays's, with the snapshots' final score.
export function findReloadedPlays(demo) {
  return reloadedPlays(demo);
}
