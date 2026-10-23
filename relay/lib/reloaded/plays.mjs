// The highlights and the rating of a Soldat Reloaded match, from its demo (a .srdm,
// record.mjs), as a 1.7.1 match's are found (web/js/spectate/highlights.js): this reads the
// demo into what highlights.js's play finder takes, and the finder does the rest. The kills,
// the flags taken, returned and scored are the server's words in the snapshots; who plays,
// where they are, where the flags are, the clock and the score are the snapshots' state.
//
// Ticks are the demo's: its tick records, 60 a second, as its player and the game's bar
// count them. Something the server did on its tick T is put at the first demo tick that
// shows T (its tick record's view), as the game shows it then.
//
//   reloadedPlays(demo, { scores }) -> { clips, highlights, rating }
// demo: the .srdm's bytes (not gzipped); scores: the final [alpha, bravo] the match is
// listed with (default: the snapshots' last). It takes a second or two for a long match:
// the relay has playsOf do it on a thread of its own (plays-worker.mjs).
//   await playsOf(file, scores): the same, of a .srdm or a recording's .srdm.gz
import { Worker } from 'node:worker_threads';
import { MSG, STREAM_RING, E, Bits, parse, snapshotHeader, snapshotBody, words, fields, TABLES } from './wire.mjs';
import { findPlays, countHighlights, rateMatch } from '../../../web/js/spectate/highlights.js';

const TICKS = 60;
const HEADER_SIZE = 4 + 2 + 2 + 4 + 4 + 1 + 24 + 64;
const PACKET = 1, TICK = 3;
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

// The demo's records, in order: what happened at which server tick, and which server tick
// each demo tick showed. { items: [{ tick (the server's), word } or { tick, state }],
// views: [the server tick each demo tick showed], mapChange: the demo tick of the round's
// end (null: none) }
function readDemo(d) {
  if (d.length < HEADER_SIZE || d.toString('latin1', 0, 4) !== 'SRDM') throw new Error('not a Soldat Reloaded demo');
  const items = [], views = [];
  const ring = new Array(STREAM_RING).fill(null);
  const heard = new Set();     // the words' seqs: each comes again until acknowledged
  let round = 0, mapChange = null, newest = 0;
  for (let o = HEADER_SIZE; o + 3 <= d.length;) {
    const kind = d[o], size = d.readUInt16LE(o + 1), data = d.subarray(o + 3, o + 3 + size);
    o += 3 + size;
    if (kind === TICK) {
      const t = fields(Bits.reader(data), TABLES.tick_head, {});
      views.push(t.view || 0);
      continue;
    }
    if (kind !== PACKET) continue;
    const b = Bits.reader(data);
    const k = MSG[b.kind()];
    if (k === 'Map') {
      const m = parse(data);
      if (m) round = m.body.round;
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
    for (const w of said) {
      if (heard.has(w.seq)) continue;
      heard.add(w.seq);
      items.push({ tick: w.tick, word: w.word });
    }
    // the state, once for each tick (a later snapshot of a tick says nothing new): as much
    // of it as the plays need
    if (h.tick > newest) {
      newest = h.tick;
      items.push({ tick: h.tick, state: compact(f) });
    }
  }
  // by the server's tick, a tick's words before its state (the state is as the tick left it)
  items.sort((a, b) => a.tick - b.tick || (a.word ? 0 : 1) - (b.word ? 0 : 1));
  return { items, views, mapChange };
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
export function readReloadedMatch(demo) {
  const { items, views, mapChange } = readDemo(demo);
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
  return { kills, carrierKills, caps, resting, score, mapChanged, end, ticks: views.length, last, names };
}

// The match's clips (findPlays's), how many plays of each kind, and its rating.
export function reloadedPlays(demo, { scores } = {}) {
  const m = readReloadedMatch(demo);
  const clips = findPlays(m);
  const seconds = m.ticks / TICKS;
  return { clips, highlights: countHighlights(clips), rating: rateMatch(clips, seconds, scores || m.score) };
}

export function playsOf(file, scores) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./plays-worker.mjs', import.meta.url), { workerData: { file, scores } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error('the plays worker stopped (' + code + ')')));
  });
}

// The plays of a recordings store's (relay/lib/recorder.mjs) Soldat Reloaded demos: a demo's
// clips, worked out when asked and kept for the next asks (the last KEPT), and the
// summaries of demos kept without highlights (before they were found, or when finding them
// failed) filled in, one after another.
const KEPT = 20;

export function makeReloadedPlays(recordings, log) {
  const kept = new Map();   // id -> its clips (a promise)
  return {
    // a published Soldat Reloaded demo's clips (findPlays's); null if it has none
    clips(id) {
      const f = recordings.file(id);
      if (!f || f.meta.game !== 'reloaded') return Promise.resolve(null);
      if (!kept.has(id)) {
        const p = playsOf(f.path, f.meta.scores).then((m) => m.clips);
        p.catch(() => kept.delete(id));
        kept.set(id, p);
        if (kept.size > KEPT) kept.delete(kept.keys().next().value);
      }
      return kept.get(id);
    },
    async backfill() {
      let n = 0;
      for (const m of recordings.list()) {
        if (m.game !== 'reloaded' || m.highlights != null) continue;
        const f = recordings.file(m.id);
        if (!f) continue;
        try {
          const { highlights, rating } = await playsOf(f.path, m.scores);
          await recordings.update(m.id, { highlights, rating });
          n++;
        } catch (e) {
          log(`recording ${m.id}: no plays found: ${e.message}`);
        }
      }
      if (n) log(`plays found for ${n} Soldat Reloaded recording${n === 1 ? '' : 's'}`);
    },
  };
}
