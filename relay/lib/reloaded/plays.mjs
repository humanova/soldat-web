// The plays of the Soldat Reloaded recordings, for the relay: web/js/spectate/reloaded-plays.js
// finds them (the page does too, for a replay's clips). It takes seconds (some 20 on the VPS)
// for a long match, so the relay has playsOf do it on a thread of its own (plays-worker.mjs),
// once a demo, for its summary's highlights and rating.
//   await playsOf(file, scores): reloadedPlays's, of a .srdm or a recording's .srdm.gz
import { Worker } from 'node:worker_threads';

export { reloadedPlays, readReloadedMatch } from '../../../web/js/spectate/reloaded-plays.js';

export function playsOf(file, scores) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./plays-worker.mjs', import.meta.url), { workerData: { file, scores } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error('the plays worker stopped (' + code + ')')));
  });
}

// The summaries of a recordings store's (relay/lib/recorder.mjs) Soldat Reloaded demos kept
// without highlights (before they were found, or when finding them failed) filled in, one after
// another. A replay's clips the page finds in the demo, as a 1.7.1 demo's.
export function makeReloadedPlays(recordings, log) {
  return {
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
