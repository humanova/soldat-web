#!/usr/bin/env node
// Converts the demos the game recorded (Soldat 1.2.0 to 1.7.1) to the layout of Soldat 1.7.1
// with Soldat TV's header, which Soldat TV plays (web/js/spectate/legacy.js, docs/DEMOS.md).
// The page does the same with a demo dropped on it; this is for many files at once.
//
//   node tools/migrate-demo.mjs FILE.sdm...            writes FILE-171.sdm next to each
//   node tools/migrate-demo.mjs --out DIR FILE.sdm...  writes DIR/FILE.sdm
//   node tools/migrate-demo.mjs --check FILE.sdm...    only tells the version
//
// A .sdm.gz (Soldat TV's folder) is read too. Demos that need no change are not written.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { migrateDemo } from '../web/js/spectate/legacy.js';

const args = process.argv.slice(2);
const check = args.includes('--check');
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1));
if (!files.length) {
  console.error('usage: node tools/migrate-demo.mjs [--check] [--out DIR] FILE.sdm...');
  process.exit(2);
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const file of files) {
  try {
    let data = fs.readFileSync(file);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const r = await migrateDemo(new Uint8Array(data.buffer, data.byteOffset, data.length));
    if (!r.from) throw new Error('not a Soldat demo');
    if (check || !r.changed) {
      console.log(`${file}: ${r.name}, ${r.changed ? 'to be converted' : 'nothing to change'}.`);
      continue;
    }
    const base = path.basename(file).replace(/\.gz$/i, '').replace(/\.sdm$/i, '');
    const out = outDir ? path.join(outDir, base + '.sdm') : path.join(path.dirname(file), base + '-171.sdm');
    fs.writeFileSync(out, r.data);
    console.log(`${file} -> ${out}: ${r.notes.join(' ')}`);
  } catch (e) {
    failed++;
    console.error(`${file}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
