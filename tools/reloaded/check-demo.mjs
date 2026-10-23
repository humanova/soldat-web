// Reads a Soldat Reloaded demo (.srdm, or a recording's .srdm.gz) back as the game would:
// its header, its records, and every snapshot against its base (relay/lib/reloaded/record.mjs).
//   node tools/reloaded/check-demo.mjs <file>
import fs from 'node:fs';
import zlib from 'node:zlib';
import { MSG, STREAM_RING, Bits, parse, snapshotHeader, snapshotBody, words, TABLES, fields } from '../../relay/lib/reloaded/wire.mjs';

const file = process.argv[2];
if (!file) {
  console.error('node tools/reloaded/check-demo.mjs <file.srdm[.gz]>');
  process.exit(2);
}
let d = fs.readFileSync(file);
if (file.endsWith('.gz')) d = zlib.gunzipSync(d);
const HEADER = 4 + 2 + 2 + 4 + 4 + 1 + 24 + 64;
const text = (from, to) => d.toString('utf8', from, to).replace(/\0.*$/s, '');
console.log({
  magic: d.toString('latin1', 0, 4), version: d.readUInt16LE(4), wire: d.readUInt16LE(6),
  date: new Date(d.readUInt32LE(8) * 1000).toISOString(), ticks: d.readUInt32LE(12),
  slot: d[16], name: text(17, 41), map: text(41, 105),
});

let o = HEADER, packets = 0, frames = 0, cameras = 0, ticks = 0, round = 0, read = 0, noBase = 0, bad = 0, badTicks = 0;
let firstView = null, lastView = 0, viewJumps = 0;
const kinds = {};
const ring = new Array(STREAM_RING).fill(null);
while (o + 3 <= d.length) {
  const kind = d[o], size = d.readUInt16LE(o + 1), data = d.subarray(o + 3, o + 3 + size);
  o += 3 + size;
  if (kind === 2) { frames++; continue; }
  if (kind === 4) { cameras++; continue; }
  if (kind === 3) {
    ticks++;
    const r = Bits.reader(data);
    const t = fields(r, TABLES.tick_head, {});
    if (!r.done && !t.present) badTicks++;
    if (firstView === null && t.view) firstView = t.view;
    if (lastView && t.view && t.view !== lastView + 1) viewJumps++;
    if (t.view) lastView = t.view;
    continue;
  }
  if (kind !== 1) { console.log('a record of no kind known,', kind, 'at', o - 3 - size); break; }
  packets++;
  const b = Bits.reader(data);
  const k = MSG[b.kind()];
  kinds[k] = (kinds[k] || 0) + 1;
  if (k === 'Map') { round = parse(data).body.round; ring.fill(null); }
  if (k !== 'Snapshot') continue;
  const h = snapshotHeader(b);
  if (h.round !== round) continue;
  let base = null;
  if (h.base) {
    base = ring[h.base % STREAM_RING];
    if (!base || base.tick !== h.base) { noBase++; continue; }
  }
  const f = snapshotBody(b, base);
  words(b);
  if (!b.done) { bad++; continue; }
  f.tick = h.tick;
  ring[h.tick % STREAM_RING] = f;
  read++;
}
console.log({ bytesLeft: d.length - o, packets, frames, cameras, ticks, kinds, snapshotsRead: read, noBase, bad, badTicks, firstView, lastView, viewJumps });
