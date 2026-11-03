// Soldat Reloaded on Soldat TV (relay/lib/reloaded): its wire read and written back, the
// hub's spectator reading only the snapshots it acknowledges, the hub answering a
// viewer's game as the server would (its join, its map download, a whole snapshot for
// it), and a round recorded as the game's own demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  Bits, fields, words, build, parse, TABLES, E, MSG, MAX_PLAYERS, MAX_THINGS, SIZES, VERSION, blankSoldier, buildClientState, snapshotHeader,
} from '../../relay/lib/reloaded/wire.mjs';
import { ReloadedClient } from '../../relay/lib/reloaded/client.mjs';
import { ReloadedHub } from '../../relay/lib/reloaded/hub.mjs';
import { makeReloadedFiles, sha256 } from '../../relay/lib/reloaded/files.mjs';
import { ReloadedRecording } from '../../relay/lib/reloaded/record.mjs';
import { makeRecordings } from '../../relay/lib/recorder.mjs';
import { playsOf, reloadedPlays } from '../../relay/lib/reloaded/plays.mjs';

test('a struct goes whole and as a delta, and reads back the same', () => {
  const a = blankSoldier();
  Object.assign(a, { 'body.pos': [12.5, -40], team: 2, 'vitals.health': 150, 'controls.buttons': 0b1000001,
    'pose.legs': { id: 3, frame: 7 }, 'carrying.held': 4, 'rng.state': 0x123456789n });
  const b = { ...a, 'body.pos': [13, -41.25], 'vitals.health': 120.5, 'carrying.held': null };
  for (const [o, base] of [[a, null], [b, a]]) {
    const w = Bits.writer();
    fields(w, TABLES.soldier_served, o, base);
    assert.ok(w.ok);
    const r = Bits.reader(w.bytes());
    const back = fields(r, TABLES.soldier_served, {}, base);
    assert.ok(r.done);
    for (const f of TABLES.soldier_served) assert.deepEqual(back[f.name], o[f.name], f.name);
  }
});

test('words and messages read back as written', () => {
  const list = [
    { seq: 7, tick: 100, word: { type: 'Shot', owner: 3, weapon: E.Weapon.AK74, pos: [1, 2], velocity: [3, -4], damage: 1, number: 99, harmless: false } },
    { seq: 8, tick: 101, word: { type: 'Ruling', inner: { type: 'Flag_Return', flag: 1, returner: null, pos: [5, 6] } } },
  ];
  const w = Bits.writer();
  words(w, list);
  const back = words(Bits.reader(w.bytes()));
  assert.deepEqual(back, list);
  const chat = parse(build('Chat', { slot: 4, name: 'Ann', team: false, taunt: false, kind: E.Chat_Kind.Game, text: 'hi there' }));
  assert.equal(chat.kind, 'Chat');
  assert.deepEqual(chat.body, { slot: 4, name: 'Ann', team: false, taunt: false, kind: E.Chat_Kind.Game, text: 'hi there' });
  assert.equal(parse(build('Welcome', { slot: 31, tick: 123456 })).body.tick, 123456);
});

// a table's fields at their zero
function blank(table) {
  const o = {};
  for (const f of table) o[f.name] = f.kind === 'bool' ? false : f.kind === 'maybe' ? null : 0;
  return o;
}

// a snapshot of nobody, whole or against `base` (a tick)
function snapshot(round, tick, base = 0) {
  const b = Bits.writer();
  b.kind(MSG.Snapshot);
  b.u16(round); b.u32(tick); b.u32(base); b.u32(0); b.u32(0);
  const r = blank(TABLES.round);
  fields(b, TABLES.round, r, base ? r : null);
  for (let i = 0; i < MAX_PLAYERS + MAX_THINGS; i++) b.enum(E.Snap_Word.Gone, E.Snap_Word);
  words(b, []);
  assert.ok(b.ok);
  return Buffer.from(b.bytes());
}

const kindOf = (data) => MSG[Bits.reader(data).kind()];

test('the spectator reads only the snapshots it acknowledges, and holds back for a whole one', () => {
  const heard = [];
  const c = new ReloadedClient({ host: '127.0.0.1', port: 1, name: 'TV' }, {
    onJoined: () => {}, onMessage: (data, kind, info) => heard.push(info.tick), onGone: () => {},
  });
  c.state = 'joined';
  c.round = 3;
  const ack = () => c.held || c.read;
  c.message(snapshot(3, 10));
  assert.equal(ack(), 10);                     // a whole one is always read
  for (let t = 11; t <= 15; t++) c.message(snapshot(3, t, 10));
  assert.equal(ack(), 10);                     // too soon to read another
  c.message(snapshot(3, 16, 10));
  assert.equal(ack(), 16);
  c.message(snapshot(3, 17, 99));              // against a base it never read: passed on all the same
  c.wantWhole();
  for (let t = 18; t <= 40; t++) c.message(snapshot(3, t, 16));
  assert.equal(ack(), 16);                     // held: the server's base grows old
  assert.equal(c.stats.read, 2);
  c.message(snapshot(3, 41));
  assert.equal(ack(), 41);
  assert.equal(c.held, 0);
  c.message(snapshot(3, 41, 16));              // a tick heard before: dropped
  c.message(snapshot(2, 42));                  // another round's: dropped
  assert.deepEqual(heard, Array.from({ length: 32 }, (_, i) => 10 + i));
});

test('the file store keeps what the hash names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-files-'));
  try {
    const files = makeReloadedFiles({ dir });
    const data = Buffer.from('a map');
    const hash = sha256(data);
    assert.equal(files.put(hash, Buffer.from('another')), false);
    assert.equal(files.has(hash), false);
    assert.equal(files.put(hash, data), true);
    assert.deepEqual(makeReloadedFiles({ dir }).get(hash), data);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a viewer\'s game is answered as the server answers a joining player', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-hub-'));
  const pms = Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 7) & 0xFF));
  const art = Buffer.from('an image');
  const hub = new ReloadedHub({ id: 't', name: 'Test', host: '127.0.0.1', port: 1, game: 'reloaded' }, {
    playerName: 'TV', log: () => {}, reloadedFiles: makeReloadedFiles({ dir }),
  });
  let wholes = 0;
  const client = {
    round: 3, mapName: '', stats: {},
    fetch: async (file) => (file === 0 ? pms : art),
    wantWhole: () => { wholes++; },
    roster: () => [],
  };
  try {
    hub.state = 'live';
    hub.ready = true;
    hub.slot = 6;
    hub.client = client;
    hub.lastHeard = Date.now();
    const hear = (kind, m) => {
      const data = build(kind, m);
      hub.heard(client, data, kind, parse(data).body);
    };
    hear('Weapons', { weapons: blank(TABLES.weapons) });
    hear('Map', { round: 3, map: 'ctf_Test', hostname: 'Host', limit: 10, grenades: 2, gunsOff: 0,
      hash: Buffer.from(sha256(pms), 'hex'), art: 1, timeLeft: 3600 });
    hear('Map_Art', { round: 3, index: 0, path: 'textures/x.png', size: art.length, hash: Buffer.from(sha256(art), 'hex') });
    hear('Text', { place: E.Text_Place.Screen, layer: 2, text: 'Welcome', pos: [10, 20], color: [1, 2, 3, 4], scale: 1, seconds: 0, clock: false });
    hear('Vote', { kind: E.Vote_Kind.Map, target: 'ctf_Next', starter: 'Ann', reason: '', seconds: 30 });
    hub.heard(client, snapshot(3, 500), 'Snapshot', { round: 3, tick: 500, base: 0 });
    await new Promise((r) => setImmediate(r));  // the hub's fetches

    const sent = [], said = [];
    const v = { send: (b) => sent.push(Buffer.from(b)), sendText: (o) => said.push(o), cork() {}, uncork() {}, close() {}, buffered: 0 };
    hub.addViewer(v);
    assert.equal(said[0].type, 'ready');
    hub.fromViewer(v, snapshot(3, 1));            // before its Hello: nothing
    assert.equal(sent.length, 0);
    hub.fromViewer(v, build('Hello', { version: 16, name: 'x', password: '', look: blank(TABLES.look), primary: 0, secondary: 0, hwid: '' }));
    assert.deepEqual(sent.map(kindOf), ['Welcome', 'Weapons', 'Map', 'Map_Art', 'Text', 'Vote']);
    assert.equal(parse(sent[0]).body.slot, 6);    // the viewer plays the hub's spectator
    const map = parse(sent[2]).body;
    assert.equal(map.map, 'ctf_Test');
    assert.ok(map.timeLeft <= 3600 && map.timeLeft > 3500);

    // the stream from now on, and a whole snapshot wanted until its game has heard it
    hub.heard(client, snapshot(3, 501, 500), 'Snapshot', { round: 3, tick: 501, base: 500 });
    assert.equal(kindOf(sent.at(-1)), 'Snapshot');
    hub.keysTick();
    assert.equal(wholes, 1);
    hub.keyAt = 0;
    hub.fromViewer(v, buildClientState({ round: 3, seq: 1, ack: 501, eventAck: 0, life: 0 }, blankSoldier()));
    hub.keysTick();
    assert.equal(wholes, 1);

    // its map download, from the hub's copy, in parts
    sent.length = 0;
    hub.fromViewer(v, build('Map_Fetch', { round: 3, file: 0, part: 0, count: 64 }));
    hub.fromViewer(v, build('Map_Fetch', { round: 2, file: 0, part: 0, count: 64 }));  // another round's: nothing
    await new Promise((r) => setImmediate(r));
    const parts = sent.map((b) => parse(b).body);
    assert.equal(parts.length, Math.ceil(pms.length / SIZES.MAP_PART));
    assert.deepEqual(Buffer.concat(parts.map((p) => p.data)), pms);
    sent.length = 0;
    hub.fromViewer(v, build('Map_Fetch', { round: 3, file: 1, part: 0, count: 64 }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(parse(sent[0]).body.data, art);
  } finally {
    hub.clearTimers();
    hub.state = 'idle';
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a round is recorded as the game\'s own demo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rec-'));
  try {
    const store = makeRecordings({ dir, minSeconds: 1, minPlayers: 2, log: () => {} });
    const t0 = Date.UTC(2026, 9, 22, 12);
    const weapons = build('Weapons', { weapons: blank(TABLES.weapons) });
    const map = { round: 3, map: 'ctf_Test', hostname: 'Host', limit: 10, grenades: 2, gunsOff: 0,
      hash: Buffer.alloc(32, 0xab), art: 0, timeLeft: 3600 };
    const rec = store.start({ server: 'sr', serverName: 'SR', group: 'Gather', map: 'ctf_Test', mapHash: 'ab'.repeat(32),
      mode: 'CTF', delay: 0, round: 3, slot: 6, name: 'TV' }, t0, [weapons], ReloadedRecording);
    rec.add(build('Map', map), 'Map', map, t0);
    // two seconds of the stream, a snapshot a tick, each against the one before
    for (let t = 1; t <= 120; t++) rec.add(snapshot(3, t, t - 1), 'Snapshot', { round: 3, tick: t, base: t - 1 }, t0 + (t * 1000) / 60);
    rec.roster([{ slot: 0, name: 'Ann', team: 1 }, { slot: 1, name: 'Bob', team: 2 }], [2, 1, 0, 0]);
    rec.roster([{ slot: 0, name: 'Ann', team: 1 }], [0, 0, 0, 0]);   // the round's end: the score kept
    await rec.finish(t0 + 2000);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, rec.id + '.json'), 'utf8'));
    assert.equal(meta.game, 'reloaded');
    assert.equal(meta.mapHash, 'ab'.repeat(32));
    assert.deepEqual(meta.players, [{ name: 'Ann', team: 1 }, { name: 'Bob', team: 2 }]);
    assert.deepEqual(meta.scores, [2, 1, 0, 0]);
    assert.equal(meta.seconds, 2);
    assert.ok(store.file(rec.id).path.endsWith('.srdm.gz'));

    // the header, as apps/client/demo/demo.odin reads it
    const d = zlib.gunzipSync(fs.readFileSync(path.join(dir, rec.id + '.srdm.gz')));
    assert.equal(d.toString('latin1', 0, 4), 'SRDM');
    assert.equal(d.readUInt16LE(4), 2);
    assert.equal(d.readUInt16LE(6), VERSION);
    assert.equal(d.readUInt32LE(8), t0 / 1000);
    assert.equal(d.readUInt32LE(12), 120);
    assert.equal(d[16], 6);
    assert.equal(d.toString('utf8', 17, 41).replace(/\0+$/, ''), 'TV');
    assert.equal(d.toString('utf8', 41, 105).replace(/\0+$/, ''), 'ctf_Test');

    // the records: the weapons and the Map first, a frame before each tick that follows
    // packets, a tick each 60th of a second showing a few ticks behind the newest snapshot
    const kinds = [], views = [];
    let o = 105, snapshots = 0, newest = 0;
    while (o < d.length) {
      const kind = d[o], size = d.readUInt16LE(o + 1), body = d.subarray(o + 3, o + 3 + size);
      o += 3 + size;
      kinds.push(kind);
      if (kind === 1 && kindOf(body) === 'Snapshot') {
        const b = Bits.reader(body);
        b.kind();
        snapshots++;
        newest = snapshotHeader(b).tick;
      }
      if (kind === 3) {
        const r = Bits.reader(body);
        const t = fields(r, TABLES.tick_head, {});
        assert.ok(r.done && !t.present);
        assert.ok(t.view <= Math.max(0, newest - 2), `view ${t.view} of ${newest}`);
        views.push(t.view);
        assert.notEqual(kinds.at(-2), 1, 'a tick after packets, with no frame between');
      }
    }
    assert.equal(o, d.length);
    const packets = [];
    for (let i = 0, at = 105; i < 2; i++) {
      const size = d.readUInt16LE(at + 1);
      packets.push(kindOf(d.subarray(at + 3, at + 3 + size)));
      at += 3 + size;
    }
    assert.deepEqual(packets, ['Weapons', 'Map']);
    assert.equal(snapshots, 120);
    assert.equal(views.length, 120);
    assert.equal(views.at(-1), 117);
    for (let i = 1; i < views.length; i++) if (views[i - 1]) assert.ok(views[i] - views[i - 1] <= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// a whole snapshot: the soldiers ({ slot: { team, pos, name } }), the things ({ id: thing })
// and the words
function wholeSnapshot(round, tick, soldiers, things, said, roundFields = {}) {
  const b = Bits.writer(8192);
  b.kind(MSG.Snapshot);
  b.u16(round); b.u32(tick); b.u32(0); b.u32(0); b.u32(0);
  fields(b, TABLES.round, { ...blank(TABLES.round), ...roundFields });
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const s = soldiers[i];
    b.enum(s ? E.Snap_Word.State : E.Snap_Word.Gone, E.Snap_Word);
    if (!s) continue;
    const o = Object.assign(blankSoldier(), { active: true, team: s.team, 'body.pos': s.pos, 'vitals.health': 150 });
    fields(b, TABLES.soldier_served, o);
    fields(b, TABLES.soldier_owned, o);
    b.string(s.name, SIZES.Name);
  }
  for (let i = 0; i < MAX_THINGS; i++) {
    const t = things[i];
    b.enum(t ? E.Snap_Word.State : E.Snap_Word.Gone, E.Snap_Word);
    if (t) fields(b, TABLES.thing, { ...blank(TABLES.thing), 'points[0]': [0, 0], ...t });
  }
  words(b, said);
  assert.ok(b.ok);
  return Buffer.from(b.bytes());
}

test('a recorded round\'s highlights and rating are found as a 1.7.1 match\'s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-plays-'));
  try {
    const store = makeRecordings({ dir, minSeconds: 1, minPlayers: 2, log: () => {} });
    const t0 = Date.UTC(2026, 9, 23, 12);
    const map = { round: 4, map: 'ctf_Test', hostname: 'Host', limit: 10, grenades: 2, gunsOff: 0,
      hash: Buffer.alloc(32, 0xcd), art: 0, timeLeft: 36000 };
    const rec = store.start({ server: 'sr', serverName: 'SR', group: null, map: 'ctf_Test', mapHash: 'cd'.repeat(32),
      mode: 'CTF', delay: 0, round: 4, slot: 9, name: 'TV' }, t0, [], ReloadedRecording);
    rec.add(build('Map', map), 'Map', map, t0);
    // Ann (alpha) kills Bob, Cid and Dan of bravo, a second apart, then takes their flag and
    // scores with it 20 s later
    const soldiers = { 0: { team: 1, pos: [0, 0], name: 'Ann' }, 1: { team: 2, pos: [100, 0], name: 'Bob' },
      2: { team: 2, pos: [200, 0], name: 'Cid' }, 3: { team: 2, pos: [300, 0], name: 'Dan' } };
    const flags = { 0: { kind: E.Thing_Kind.Alpha_Flag, 'points[0]': [0, 500], in_base: true },
      1: { kind: E.Thing_Kind.Bravo_Flag, 'points[0]': [3000, 500], in_base: true } };
    const kill = (seq, tick, target) => ({ seq, tick, word: { type: 'Ruling', inner: { type: 'Kill', killer: 0, target,
      weapon: E.Weapon.AK74, pos: [100 * target, 0], part: 1, impact: [0, 0], fire: 0, distance: 10, airtime: 5,
      ricochets: 0, respawn: 120, kills: target } } });
    const said = { 600: [kill(1, 600, 1)], 660: [kill(2, 660, 2)], 720: [kill(3, 720, 3)],
      900: [{ seq: 4, tick: 900, word: { type: 'Ruling', inner: { type: 'Flag_Grab', soldier: 0, flag: 1, pos: [3000, 500] } } }],
      2100: [{ seq: 5, tick: 2100, word: { type: 'Ruling', inner: { type: 'Flag_Capture', soldier: 0, flag: 1, pos: [0, 500] } } }] };
    let alpha = 0;
    for (let t = 1; t <= 2400; t++) {
      if (t === 2100) alpha = 1;
      const held = t >= 900 && t < 2100;
      const things = { ...flags, 1: { ...flags[1], holder: held ? 0 : null, in_base: !held } };
      const data = wholeSnapshot(4, t, soldiers, things, said[t] || [], { phase: E.Round_Wire_Phase.Playing,
        time_left: 36000 - t, 'captures[1]': alpha });
      rec.add(data, 'Snapshot', { round: 4, tick: t, base: 0 }, t0 + (t * 1000) / 60);
    }
    rec.roster([{ slot: 0, name: 'Ann', team: 1 }, { slot: 1, name: 'Bob', team: 2 }], [1, 0, 0, 0]);
    await rec.finish(t0 + 40_000);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, rec.id + '.json'), 'utf8'));
    assert.equal(meta.highlights.multi, 1);
    assert.equal(meta.highlights.cap, 1);
    assert.equal(Object.values(meta.highlights).reduce((a, b) => a + b, 0), 2);
    assert.equal(meta.rating, null);   // under 3 minutes

    const { clips } = await playsOf(store.file(rec.id).path, meta.scores);
    assert.equal(clips.length, 2);
    const [multi, cap] = clips;
    assert.equal(multi.type, 'multi');
    assert.equal(multi.label, 'Triple kill');
    assert.equal(multi.slot, 1);
    assert.equal(multi.name, 'Ann');
    // shown as the game shows it: a few ticks after the server's, the view behind the stream
    assert.ok(multi.tick >= 720 && multi.tick <= 726, `the triple kill at ${multi.tick}`);
    assert.equal(cap.type, 'cap');
    assert.equal(cap.team, 1);
    assert.ok(cap.tick >= 2100 && cap.tick <= 2106);
    assert.equal(cap.from, cap.tick - 12 * 60);   // the run from the grab (at 900), its last 12 s
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// a round on its own: Ann and Bob stand far apart, Cid takes Bravo's flag at tick 600; with
// `picked`, the hub's director's pick recorded as it began. The demo's bytes.
async function flagRound(picked) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cams-'));
  try {
    const store = makeRecordings({ dir, minSeconds: 1, minPlayers: 2, log: () => {} });
    const t0 = Date.UTC(2026, 9, 23, 13);
    const map = { round: 5, map: 'ctf_Test', hostname: 'Host', limit: 10, grenades: 2, gunsOff: 0,
      hash: Buffer.alloc(32, 0xee), art: 0, timeLeft: 36000 };
    const rec = store.start({ server: 'sr', serverName: 'SR', group: null, map: 'ctf_Test', mapHash: 'ee'.repeat(32),
      mode: 'CTF', delay: 0, round: 5, slot: 9, name: 'TV' }, t0, [], ReloadedRecording);
    rec.add(build('Map', map), 'Map', map, t0);
    if (picked) rec.camera(1, t0);
    const soldiers = { 0: { team: 1, pos: [0, 0], name: 'Ann' }, 1: { team: 2, pos: [5000, 0], name: 'Bob' },
      2: { team: 1, pos: [3000, 2000], name: 'Cid' }, 9: { team: E.Team.Spectator, pos: [0, 0], name: 'TV' } };
    for (let t = 1; t <= 1500; t++) {
      const held = t >= 600;
      const things = { 0: { kind: E.Thing_Kind.Alpha_Flag, 'points[0]': [0, 500], in_base: true },
        1: { kind: E.Thing_Kind.Bravo_Flag, 'points[0]': [3000, 2000], in_base: !held, holder: held ? 2 : null } };
      rec.add(wholeSnapshot(5, t, soldiers, things, [], { phase: E.Round_Wire_Phase.Playing, time_left: 36000 - t }),
        'Snapshot', { round: 5, tick: t, base: 0 }, t0 + (t * 1000) / 60);
    }
    rec.roster([{ slot: 0, name: 'Ann', team: 1 }, { slot: 1, name: 'Bob', team: 2 }], [0, 0, 0, 0]);
    await rec.finish(t0 + 25_000);
    return zlib.gunzipSync(fs.readFileSync(store.file(rec.id).path));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a demo recorded without the director\'s picks has them worked out, a carrier followed', async () => {
  const { cams } = reloadedPlays(await flagRound(false));
  assert.ok(cams.length >= 2);
  assert.notEqual(cams[0].slot, 10, 'never the recorder, a spectator');
  // Cid (slot 3) once the flag is theirs: within the hold of a second, LEAD_MS early
  const carrier = cams.find((c) => c.slot === 3 && c.tick >= 500);
  assert.ok(carrier, JSON.stringify(cams));
  assert.ok(carrier.tick <= 600 + 90, `the carrier followed at ${carrier.tick}`);
  assert.ok(cams.every((c, i) => !i || c.tick > cams[i - 1].tick));
  // with picks of its own, none are made up
  assert.equal(reloadedPlays(await flagRound(true)).cams, undefined);
});

test('the page\'s wire module is the newest wire-<version>.json', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../relay/lib/reloaded');
  const newest = fs.readdirSync(dir).map((f) => /^wire-(\d+)\.json$/.exec(f)).filter(Boolean).sort((a, b) => b[1] - a[1])[0];
  const { default: data } = await import('../../web/js/spectate/reloaded-wire-data.js');
  assert.deepEqual(data, JSON.parse(fs.readFileSync(path.join(dir, newest[0]), 'utf8')), 'run node tools/reloaded/wire-js.mjs');
});
