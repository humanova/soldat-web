// Match recordings: the hub of a server with `record` writes what it streams to viewers into
// a demo, one per map, while it watches. Finished demos are kept gzipped in a folder
// (`recordings.dir`), listed by /api/demos and downloaded from /demos/<id>.sdm; the page
// replays them (web/js/spectate/replay.js).
//
// A demo has Soldat's demo layout (Demo.pas): a 180-byte header ('SOLDEM', version 0, the
// map, the start as a Unix time, the number of ticks), then records: a Word size and as many
// bytes; size 1 is the next tick (60 a second). The records are the server's messages as the
// hub got them (1.7.1 messages, in clear but for the PlayersList's three encrypted fields),
// and at tick 0 what a viewer gets on joining: a PlayersList, the hub spectator's own
// NewPlayer (always the first NewPlayer), then settings, items, scores and the clock.
// ClientSpriteSnapshot_Dead records (43) name the player the director follows from then on.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { MSG, setHash } from './soldat171.mjs';

const HEADER_SIZE = 180;
const TICKS_PER_SECOND = 60;
const MAX_MS = 3 * 3600_000;            // a longer stretch on one map goes on in the next demo
// only for the hub's own connection (pings stay: the client counts them as signs of life)
const SKIPPED = new Set([MSG.StatusRequest, 127]);
const HEARTBEATS = new Map([[MSG.HeartBeat, 32], [MSG.HeartBeat16, 16], [MSG.HeartBeat8, 8]]);
export const DEMO_ID = /^[a-z0-9_-]{1,32}-\d{8}-\d{6}(-\d)?$/i;

const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export function makeRecordings({ dir, keepDays = 14, maxBytes = 5 * 1024 ** 3, minSeconds = 60, minPlayers = 2, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const demos = new Map();     // id -> meta, the finished ones
  const pending = new Set();   // demos being finished
  const taken = new Set();     // ids in use

  // what is on disk; unfinished parts of an earlier run go
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith('.part') || f.endsWith('.tmp')) { fs.rmSync(p, { force: true }); continue; }
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (DEMO_ID.test(meta.id) && fs.existsSync(path.join(dir, meta.id + '.sdm.gz'))) {
        demos.set(meta.id, meta);
        taken.add(meta.id);
      } else {
        fs.rmSync(p, { force: true });
      }
    } catch (_) {}
  }

  // the oldest go first: past keepDays, or while all of them take more than maxBytes
  async function prune() {
    const list = [...demos.values()].sort((a, b) => a.start - b.start);
    let total = list.reduce((n, m) => n + m.bytes, 0);
    const old = Date.now() - keepDays * 86400_000;
    for (const m of list) {
      if (m.start >= old && total <= maxBytes) break;
      demos.delete(m.id);
      taken.delete(m.id);
      total -= m.bytes;
      await fsp.rm(path.join(dir, m.id + '.sdm.gz'), { force: true });
      await fsp.rm(path.join(dir, m.id + '.json'), { force: true });
      log(`recording ${m.id} removed`);
    }
  }
  prune();
  setInterval(prune, 3600_000).unref();

  function newId(server, at) {
    let id = `${server}-${stamp(at)}`;
    for (let n = 2; taken.has(id); n++) id = `${server}-${stamp(at)}-${n}`;
    taken.add(id);
    return id;
  }

  // published: once the server's broadcast delay has passed since the demo's end
  const published = (m) => Date.now() >= m.end + (m.delay || 0) * 1000;

  return {
    // info: { server, serverName, group, map, mode, delay }; opening: the messages of tick 0
    start(info, at, opening) {
      return new Recording({ dir, log, minSeconds, minPlayers, newId, pending, taken,
        done: (meta) => { demos.set(meta.id, meta); return prune(); } }, info, at, opening);
    },
    list(filter = {}) {
      return [...demos.values()]
        .filter((m) => published(m) && (!filter.id || m.id === filter.id) && (!filter.server || m.server === filter.server) &&
          (filter.group === undefined || (m.group || null) === filter.group))
        .sort((a, b) => b.start - a.start);
    },
    // the gzipped file of a published demo
    file(id) {
      const m = demos.get(id);
      return m && published(m) ? { path: path.join(dir, id + '.sdm.gz'), meta: m } : null;
    },
    // resolves when the demos being finished are on disk
    settle() {
      return Promise.allSettled([...pending]);
    },
  };
}

class Recording {
  constructor(store, info, at, opening) {
    this.store = store;
    this.info = info;
    this.start = at;
    this.id = store.newId(info.server, at);
    this.part = path.join(store.dir, this.id + '.sdm.part');
    this.out = fs.createWriteStream(this.part);
    this.out.on('error', (e) => { store.log(`recording ${this.id}: ${e.message}`); this.failed = true; });
    this.out.write(Buffer.alloc(HEADER_SIZE));
    this.tick = 0;
    this.bytes = HEADER_SIZE;
    this.players = new Map();  // slot and name -> { name, team }, everyone who played
    this.mostPlaying = 0;
    this.scores = [0, 0, 0, 0];
    this.finished = null;
    for (const m of opening) this.add(m, at);
  }

  // moves the clock to `at`: one size-1 record per tick
  advance(at) {
    const tick = Math.round(((at - this.start) * TICKS_PER_SECOND) / 1000);
    if (tick <= this.tick) return;
    const b = Buffer.alloc((tick - this.tick) * 2);
    for (let o = 0; o < b.length; o += 2) b[o] = 1;
    this.write(b);
    this.tick = tick;
  }

  write(b) {
    if (this.finished || this.failed) return;
    this.out.write(b);
    this.bytes += b.length;
  }

  record(m) {
    const b = Buffer.alloc(2 + m.length);
    b.writeUInt16LE(m.length, 0);
    m.copy(b, 2);
    this.write(b);
  }

  // a message of the server, received at `at`
  add(m, at) {
    if (m.length < 3 || SKIPPED.has(m[0])) return;
    this.advance(at);
    this.record(m);
    const n = HEARTBEATS.get(m[0]);
    if (n && m.length >= 15 + 7 * n) {
      for (let i = 0; i < 4; i++) this.scores[i] = m.readUInt16LE(7 + 7 * n + 2 * i);
    }
  }

  // who plays now: [{ slot, name, team }] (no spectators)
  roster(playing) {
    this.mostPlaying = Math.max(this.mostPlaying, playing.length);
    for (const p of playing) this.players.set(`${p.slot} ${p.name}`, { name: p.name, team: p.team });
  }

  // the director follows `slot` from `at` on
  camera(slot, at) {
    this.advance(at);
    this.record(setHash(Buffer.from([MSG.ClientSpriteSnapshotDead, 0, 0, slot & 0xFF])));
  }

  full(at) {
    return at - this.start >= MAX_MS;
  }

  // ends the demo at `at`; kept when long enough and played by enough people
  finish(at) {
    if (this.finished) return this.finished;
    this.advance(at);
    const store = this.store;
    this.finished = (async () => {
      await new Promise((resolve) => this.out.end(resolve));
      const seconds = this.tick / TICKS_PER_SECOND;
      const name = `recording ${this.id} (${this.info.map}, ${Math.round(seconds / 60)} min)`;
      if (this.failed || seconds < store.minSeconds || this.mostPlaying < store.minPlayers) {
        await fsp.rm(this.part, { force: true });
        store.taken.delete(this.id);
        if (!this.failed) store.log(`${name} not kept: ${seconds < store.minSeconds ? 'too short' : 'too few players'}`);
        return;
      }
      const header = Buffer.alloc(HEADER_SIZE);
      header.write('SOLDEM', 0, 'latin1');
      header.writeUInt16LE(0, 6);
      header.write(this.info.map.slice(0, 160), 8, 'latin1');
      header.writeInt32LE(Math.floor(this.start / 1000), 172);
      header.writeInt32LE(this.tick, 176);
      const fh = await fsp.open(this.part, 'r+');
      try { await fh.write(header, 0, HEADER_SIZE, 0); } finally { await fh.close(); }
      const gz = path.join(store.dir, this.id + '.sdm.gz');
      await pipeline(fs.createReadStream(this.part), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz + '.tmp'));
      await fsp.rename(gz + '.tmp', gz);
      await fsp.rm(this.part, { force: true });
      const meta = {
        id: this.id, server: this.info.server, serverName: this.info.serverName, group: this.info.group || null,
        map: this.info.map, mode: this.info.mode ?? null, start: this.start,
        end: this.start + Math.round((this.tick * 1000) / TICKS_PER_SECOND), seconds: Math.round(seconds),
        players: [...this.players.values()],
        scores: this.scores, delay: this.info.delay || 0, bytes: (await fsp.stat(gz)).size, rawBytes: this.bytes,
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
