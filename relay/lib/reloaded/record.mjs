// A Soldat Reloaded match recorded: what the hub hands its viewers, written as Reloaded's
// own demo (a .srdm, apps/client/demo), which its game plays back as one it recorded
// itself. One per round, from the round's Map; kept in the recordings folder with the
// 1.7.1 demos (relay/lib/recorder.mjs), listed with them, and marked `game: "reloaded"`.
//
// A demo is a header, then records: a kind byte, a little-endian u16 size, the bytes.
//
//   header  "SRDM", u16 its VERSION, u16 the wire's, u32 when it began (Unix seconds),
//           u32 its ticks, u8 the recorder's slot, its name (24 bytes), the map (64)
//   packet  a message as the server sent it
//   frame   the packets before it are all in: what they began is taken now
//   tick    a tick of the game: the tick on show, the recorder's command and cursor, and
//           its soldier if it plays (the hub's never does: a spectator)
//
// Its summary has the match's highlights and rating, found as a 1.7.1 match's are
// (plays.mjs).
//
// The hub writes a tick for each 60th of a second it has heard the stream for, showing
// a few ticks behind the newest snapshot, as a game watching it live would. The round
// begins with the server's weapons and its Map; the snapshots after a Map are whole until
// the hub acknowledges them, so every one has its base in the demo.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { VERSION, TICK_RATE, TABLES, Bits, fields } from './wire.mjs';
import { playsOf } from './plays.mjs';

// the demo's layout, as of its VERSION 2 (apps/client/demo/demo.odin)
const DEMO_VERSION = 2;
const NAME_BYTES = 24, MAP_BYTES = 64;
const HEADER_SIZE = 4 + 2 + 2 + 4 + 4 + 1 + NAME_BYTES + MAP_BYTES;
const PACKET = 1, FRAME = 2, TICK = 3;
const RECORD_MAX = 65535;
const VIEW_BEHIND = 3;          // ticks the view keeps behind the newest snapshot
const MAX_MS = 3 * 3600_000;    // longer, and the demo ends (a round is never this long)

// A tick record of nobody: its head alone, the view first (32 bits from bit 0, so its
// four bytes are the view's, little-endian)
const TICK_BODY = (() => {
  const b = Bits.writer(64);
  fields(b, TABLES.tick_head, {
    view: 0, 'command.sequence': 0, 'command.buttons': 0, 'command.aim': [0, 0], cursor: [0, 0], present: false,
  });
  if (!b.ok || TABLES.tick_head[0].name !== 'view' || TABLES.tick_head[0].bits !== 32) throw new Error('the demo tick is not as expected');
  return Buffer.from(b.bytes());
})();

function record(kind, data) {
  const b = Buffer.alloc(3 + data.length);
  b[0] = kind;
  b.writeUInt16LE(data.length, 1);
  data.copy(b, 3);
  return b;
}

const FRAME_RECORD = record(FRAME, Buffer.alloc(0));

export const RELOADED_DEMO = '.srdm';

export class ReloadedRecording {
  // store: the recordings' (recorder.mjs); info: { server, serverName, group, map, mapHash,
  // mode, delay, round, slot, name }; opening: messages at its start, before the Map
  constructor(store, info, at, opening = []) {
    this.store = store;
    this.info = info;
    this.start = at;
    this.id = store.newId(info.server, at);
    this.part = path.join(store.dir, this.id + RELOADED_DEMO + '.part');
    this.out = fs.createWriteStream(this.part);
    this.out.on('error', (e) => { store.log(`recording ${this.id}: ${e.message}`); this.failed = true; });
    this.out.write(Buffer.alloc(HEADER_SIZE));
    this.bytes = HEADER_SIZE;
    this.tick = 0;               // ticks written
    this.newest = 0;             // the newest snapshot's tick
    this.view = 0;               // the tick last shown
    this.unframed = false;
    this.players = new Map();    // slot and name -> { name, team }, everyone who played
    this.mostPlaying = 0;
    this.scores = [0, 0, 0, 0];
    this.finished = null;
    for (const m of opening) this.packet(m);
  }

  write(b) {
    if (this.finished || this.failed) return;
    this.out.write(b);
    this.bytes += b.length;
  }

  packet(data) {
    if (data.length > RECORD_MAX) return;
    this.write(record(PACKET, data));
    this.unframed = true;
  }

  // the ticks up to `at`, each after a frame mark if packets came since the last
  advance(at) {
    const due = Math.floor(((at - this.start) * TICK_RATE) / 1000);
    while (this.tick < due) {
      if (this.unframed) {
        this.write(FRAME_RECORD);
        this.unframed = false;
      }
      const target = Math.max(0, this.newest - VIEW_BEHIND);
      let view = this.view ? this.view + 1 : target;
      if (target && (view > target + 1 || view < target - 2)) view = target;
      this.view = view;
      const body = Buffer.from(TICK_BODY);
      body.writeUInt32LE(view >>> 0, 0);
      this.write(record(TICK, body));
      this.tick++;
    }
  }

  // a message of the stream, heard at `at`; kind and info as the hub's client read them
  add(data, kind, info, at) {
    this.advance(at);
    this.packet(data);
    if (kind === 'Snapshot' && info.tick > this.newest) this.newest = info.tick;
  }

  // who plays now: [{ slot, name, team }] (no spectators); the teams' captures
  roster(playing, scores) {
    this.mostPlaying = Math.max(this.mostPlaying, playing.length);
    for (const p of playing) this.players.set(`${p.slot} ${p.name}`, { name: p.name, team: p.team });
    // scores that only went down are kept as they were (a reset at the round's end)
    const sum = (s) => s.reduce((a, b) => a + b, 0);
    if (scores && (sum(scores) >= sum(this.scores) || scores.some((v, i) => v > this.scores[i]))) this.scores = scores;
  }

  full(at) {
    return at - this.start >= MAX_MS;
  }

  // ends the demo at `at`; kept when long enough and played by enough people
  finish(at) {
    if (this.finished) return this.finished;
    this.advance(at);
    if (this.unframed) this.write(FRAME_RECORD);
    const store = this.store;
    this.finished = (async () => {
      await new Promise((resolve) => this.out.end(resolve));
      const seconds = this.tick / TICK_RATE;
      const name = `recording ${this.id} (${this.info.map}, ${Math.round(seconds / 60)} min)`;
      if (this.failed || seconds < store.minSeconds || this.mostPlaying < store.minPlayers) {
        await fsp.rm(this.part, { force: true });
        store.taken.delete(this.id);
        if (!this.failed) store.log(`${name} not kept: ${seconds < store.minSeconds ? 'too short' : 'too few players'}`);
        return;
      }
      const header = Buffer.alloc(HEADER_SIZE);
      header.write('SRDM', 0, 'latin1');
      header.writeUInt16LE(DEMO_VERSION, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt32LE(Math.floor(this.start / 1000), 8);
      header.writeUInt32LE(this.tick, 12);
      header[16] = this.info.slot & 0xFF;
      Buffer.from(this.info.name || '', 'utf8').subarray(0, NAME_BYTES).copy(header, 17);
      Buffer.from(this.info.map || '', 'utf8').subarray(0, MAP_BYTES).copy(header, 17 + NAME_BYTES);
      const fh = await fsp.open(this.part, 'r+');
      try { await fh.write(header, 0, HEADER_SIZE, 0); } finally { await fh.close(); }
      const gz = path.join(store.dir, this.id + RELOADED_DEMO + '.gz');
      // its highlights and rating (plays.mjs, on a thread of its own) as it is packed
      const [plays] = await Promise.all([
        playsOf(this.part, this.scores).catch((e) => {
          store.log(`recording ${this.id}: no plays found: ${e.message}`);
          return { highlights: null, rating: null };
        }),
        pipeline(fs.createReadStream(this.part), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz + '.tmp')),
      ]);
      await fsp.rename(gz + '.tmp', gz);
      await fsp.rm(this.part, { force: true });
      const meta = {
        id: this.id, game: 'reloaded', server: this.info.server, serverName: this.info.serverName,
        group: this.info.group || null, map: this.info.map, mapHash: this.info.mapHash || null,
        mode: this.info.mode ?? null, start: this.start,
        end: this.start + Math.round((this.tick * 1000) / TICK_RATE), seconds: Math.round(seconds),
        players: [...this.players.values()], scores: this.scores, highlights: plays.highlights, rating: plays.rating,
        delay: this.info.delay || 0, bytes: (await fsp.stat(gz)).size, rawBytes: this.bytes,
      };
      await fsp.writeFile(path.join(store.dir, this.id + '.json.tmp'), JSON.stringify(meta));
      await fsp.rename(path.join(store.dir, this.id + '.json.tmp'), path.join(store.dir, this.id + '.json'));
      store.log(`${name} saved: ${(meta.bytes / 1048576).toFixed(1)} MB`);
      await store.done(meta);
    })().catch((e) => {
      store.log(`recording ${this.id} failed: ${e.message}`);
      store.taken.delete(this.id);
      return fsp.rm(this.part, { force: true });
    }).finally(() => store.pending.delete(this.finished));
    store.pending.add(this.finished);
    return this.finished;
  }
}
