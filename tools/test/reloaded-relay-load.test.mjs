// The Reloaded hub's work kept small (relay/lib/reloaded): its spectator's state goes out as
// the server's datagrams bring something to acknowledge, not on a timer of its own; a hub with
// a delay sends the delayed stream on as the server's messages come in; and a recording
// gathers its records in memory, its demo the same as written a record at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Bits, fields, words, build, TABLES, E, MSG, MAX_PLAYERS, MAX_THINGS } from '../../relay/lib/reloaded/wire.mjs';
import { ReloadedClient } from '../../relay/lib/reloaded/client.mjs';
import { ReloadedHub } from '../../relay/lib/reloaded/hub.mjs';
import { ReloadedRecording } from '../../relay/lib/reloaded/record.mjs';
import { makeRecordings } from '../../relay/lib/recorder.mjs';

// a table's fields at their zero
function blank(table) {
  const o = {};
  for (const f of table) o[f.name] = f.kind === 'bool' ? false : f.kind === 'maybe' ? null : 0;
  return o;
}

// a snapshot of nobody, whole or against `base` (a tick), with `pad` bytes after it
function snapshot(round, tick, base = 0, pad = 0) {
  const b = Bits.writer(4096);
  b.kind(MSG.Snapshot);
  b.u16(round); b.u32(tick); b.u32(base); b.u32(0); b.u32(0);
  const r = blank(TABLES.round);
  fields(b, TABLES.round, r, base ? r : null);
  for (let i = 0; i < MAX_PLAYERS + MAX_THINGS; i++) b.enum(E.Snap_Word.Gone, E.Snap_Word);
  words(b, []);
  for (let i = 0; i < pad; i++) b.u8(i & 0xFF);
  assert.ok(b.ok);
  return Buffer.from(b.bytes());
}

test('the spectator\'s state goes out when there is something new to acknowledge', () => {
  const c = new ReloadedClient({ host: '127.0.0.1', port: 1, name: 'TV' }, {
    onJoined: () => {}, onMessage: () => {}, onGone: () => {},
  });
  const acks = [];
  c.peer = {
    send: (channel, bytes) => {
      const b = Bits.reader(bytes);
      assert.equal(MSG[b.kind()], 'Client_State');
      b.u16(); b.u32(); b.u32();
      acks.push(b.u32());
    },
    flush: () => {},
  };
  c.state = 'joined';
  c.round = 3;
  c.message(snapshot(3, 10));
  c.pump(1000);
  assert.deepEqual(acks, [10]);                 // a whole one read: acknowledged at once
  c.message(snapshot(3, 11, 10));
  c.pump(1017);
  assert.deepEqual(acks, [10]);                 // nothing new
  for (let t = 12; t <= 16; t++) c.message(snapshot(3, t, 10));
  c.pump(1030);
  assert.deepEqual(acks, [10]);                 // new, but too soon after the last
  c.pump(1050);
  assert.deepEqual(acks, [10, 16]);
  c.pump(1199);
  assert.deepEqual(acks, [10, 16]);
  c.pump(1200);
  assert.deepEqual(acks, [10, 16, 16]);         // again, in case the last was lost
});

test('a hub with a delay sends the delayed stream on as the server\'s messages come in', async () => {
  const hub = new ReloadedHub({ id: 't', name: 'Test', host: '127.0.0.1', port: 1, game: 'reloaded', delaySeconds: 0.05 }, {
    playerName: 'TV', log: () => {},
  });
  const client = { round: 3, mapName: 'ctf_Test', stats: {}, wantWhole: () => {}, roster: () => [], scores: () => null };
  try {
    hub.client = client;
    hub.lastHeard = Date.now();
    hub.goLive();
    const timers = [...hub.timers].map((t) => t.hubName);
    assert.ok(timers.includes('flush'));        // only for a quiet server...
    hub.ready = true;
    const sent = [];
    const v = { send: (b) => sent.push(Buffer.from(b)), sendText: () => {}, cork() {}, uncork() {}, close() {}, buffered: 0, welcomed: true };
    hub.viewers.add(v);
    hub.heard(client, snapshot(3, 1), 'Snapshot', { round: 3, tick: 1, base: 0 });
    assert.equal(sent.length, 0);               // held back for the delay
    await new Promise((r) => setTimeout(r, 70));
    hub.clearTimer('flush');                    // ...which this one is not
    hub.heard(client, snapshot(3, 2, 1), 'Snapshot', { round: 3, tick: 2, base: 1 });
    assert.equal(sent.length, 1);               // the first, as the second comes in
    assert.equal(hub.seen.tick, 1);
  } finally {
    hub.clearTimers();
    hub.state = 'idle';
  }
});

test('a hub without a delay has no timer for the delayed stream', () => {
  const hub = new ReloadedHub({ id: 't', name: 'Test', host: '127.0.0.1', port: 1, game: 'reloaded' }, {
    playerName: 'TV', log: () => {},
  });
  try {
    hub.client = { mapName: 'ctf_Test' };
    hub.goLive();
    assert.ok(![...hub.timers].some((t) => t.hubName === 'flush'));
  } finally {
    hub.clearTimers();
    hub.state = 'idle';
  }
});

test('a long recording\'s demo holds every record, in order, across the chunks it is written in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-chunks-'));
  try {
    const store = makeRecordings({ dir, minSeconds: 1, minPlayers: 2, log: () => {} });
    const t0 = Date.UTC(2026, 9, 24, 12);
    const map = { round: 3, map: 'ctf_Test', hostname: 'Host', limit: 10, grenades: 2, gunsOff: 0,
      hash: Buffer.alloc(32, 0xab), art: 0, timeLeft: 3600 };
    const rec = store.start({ server: 'sr', serverName: 'SR', map: 'ctf_Test', mode: 'CTF', delay: 0, round: 3, slot: 6, name: 'TV' },
      t0, [], ReloadedRecording);
    const mapBytes = build('Map', map);
    rec.add(mapBytes, 'Map', map, t0);
    // 40 seconds of snapshots of different sizes: half a megabyte, a few chunks' worth
    const sent = [mapBytes];
    const TICKS = 60 * 40;
    for (let t = 1; t <= TICKS; t++) {
      const data = snapshot(3, t, t - 1, (t * 37) % 300);
      sent.push(data);
      rec.add(data, 'Snapshot', { round: 3, tick: t, base: t - 1 }, t0 + (t * 1000) / 60);
      if (t % 600 === 0) rec.camera(t / 600, t0 + (t * 1000) / 60);
    }
    rec.roster([{ slot: 0, name: 'Ann', team: 1 }, { slot: 1, name: 'Bob', team: 2 }], [0, 0, 0, 0]);
    await rec.finish(t0 + 40_000);

    const d = zlib.gunzipSync(fs.readFileSync(path.join(dir, rec.id + '.srdm.gz')));
    assert.ok(d.length > 3 * (1 << 17));
    const packets = [], cameras = [];
    let o = 105, ticks = 0;
    while (o < d.length) {
      const kind = d[o], size = d.readUInt16LE(o + 1), body = d.subarray(o + 3, o + 3 + size);
      o += 3 + size;
      if (kind === 1) packets.push(body);
      else if (kind === 3) ticks++;
      else if (kind === 4) cameras.push(body[0]);
    }
    assert.equal(o, d.length);
    assert.equal(packets.length, sent.length);
    packets.forEach((p, i) => assert.ok(p.equals(sent[i]), `packet ${i}`));
    assert.equal(ticks, TICKS);
    assert.equal(d.readUInt32LE(12), TICKS);
    assert.deepEqual(cameras, [1, 2, 3, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
