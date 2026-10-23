// reloadedPlays (plays.mjs) off the relay's thread: reading a match's snapshots takes a
// second or two, which the live streams can't wait for. workerData: { file (a .srdm, or a
// recording's .srdm.gz), scores }; it posts { clips, highlights, rating } or { error }.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import { reloadedPlays } from './plays.mjs';

try {
  let demo = fs.readFileSync(workerData.file);
  if (workerData.file.endsWith('.gz')) demo = zlib.gunzipSync(demo);
  parentPort.postMessage(reloadedPlays(demo, { scores: workerData.scores }));
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
