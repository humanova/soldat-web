#!/usr/bin/env node
// Recounts the scores, highlights and ratings the recorded matches are listed with
// (relay/lib/recorder.mjs: Score, demoPlays) from their demo files, for demos saved before
// they were counted as they are now.
// The spectator hub reads the list when it starts: restart it afterwards.
//
//   node relay/fix-scores.mjs [--config relay/spectator.json] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { makeArg } from './lib/util.mjs';
import { demoScore, demoPlays, DEMO_ID } from './lib/recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = makeArg(args);
const CONFIG = path.resolve(arg('config', process.env.CONFIG || path.join(here, 'spectator.json')));
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const dir = path.resolve(path.dirname(CONFIG), config.recordings?.dir || 'data/recordings');
const dryRun = args.includes('--dry-run');

const demos = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (DEMO_ID.test(meta.id) && fs.existsSync(path.join(dir, meta.id + '.sdm.gz'))) demos.push(meta);
  } catch (_) {}
}

let changed = 0;
for (const meta of demos) {
  // a demo starts a map when the server's previous one ended as it began
  const newMap = demos.some((m) => m.server === meta.server && m !== meta && Math.abs(m.end - meta.start) < 2000);
  const demo = zlib.gunzipSync(fs.readFileSync(path.join(dir, meta.id + '.sdm.gz')));
  const scores = demoScore(demo, newMap);
  const { highlights, rating } = demoPlays(demo, meta.seconds, scores);
  const sameScores = scores.join() === (meta.scores || []).join();
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (sameScores && same(highlights, meta.highlights) && same(rating, meta.rating)) continue;
  changed++;
  console.log(`${meta.id} (${meta.map}):` +
    (sameScores ? '' : ` ${(meta.scores || []).slice(0, 2).join(':')} -> ${scores.slice(0, 2).join(':')}`) +
    (highlights ? ` highlights ${Object.entries(highlights).map(([k, n]) => `${k} ${n}`).join(', ')}` : '') +
    (rating ? `; rated ${rating.rating} (action ${rating.action}, contest ${rating.contest})` : ''));
  if (dryRun) continue;
  const p = path.join(dir, meta.id + '.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify({ ...meta, scores, highlights, rating }));
  fs.renameSync(p + '.tmp', p);
}
console.log(`${changed} of ${demos.length} demos ${dryRun ? 'would change' : 'changed'}` +
  (changed && !dryRun ? '; restart the spectator hub to list them' : ''));
