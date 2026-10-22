// Soldat Reloaded on Soldat TV (relay/lib/reloaded): its wire read and written back, the
// hub's spectator reading only the snapshots it acknowledges, and the hub answering a
// viewer's game as the server would: its join, its map download, a whole snapshot for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bits, fields, words, build, parse, TABLES, E, MSG, MAX_PLAYERS, MAX_THINGS, SIZES, blankSoldier, buildClientState,
} from '../../relay/lib/reloaded/wire.mjs';
import { ReloadedClient } from '../../relay/lib/reloaded/client.mjs';
import { ReloadedHub } from '../../relay/lib/reloaded/hub.mjs';
import { makeReloadedFiles, sha256 } from '../../relay/lib/reloaded/files.mjs';

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
