// The plays of the Soldat Reloaded recordings, for the relay: web/js/spectate/reloaded-plays.js
// finds them (the page does too, for a demo file dropped on it). It takes a second or two for
// a long match, so the relay has playsOf do it on a thread of its own (plays-worker.mjs).
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

// The plays of a recordings store's (relay/lib/recorder.mjs) Soldat Reloaded demos: a demo's
// clips (and its director's picks, for one recorded without them), worked out when asked and
// kept for the next asks (the last KEPT), and the
// summaries of demos kept without highlights (before they were found, or when finding them
// failed) filled in, one after another.
const KEPT = 20;

export function makeReloadedPlays(recordings, log) {
  const kept = new Map();   // id -> its clips and cams (a promise)
  return {
    // a published Soldat Reloaded demo's { clips (findPlays's), cams (reloadedPlays's) }; null
    // if it has none
    plays(id) {
      const f = recordings.file(id);
      if (!f || f.meta.game !== 'reloaded') return Promise.resolve(null);
      if (!kept.has(id)) {
        const p = playsOf(f.path, f.meta.scores).then(({ clips, cams }) => ({ clips, cams }));
        p.catch(() => kept.delete(id));
        kept.set(id, p);
        if (kept.size > KEPT) kept.delete(kept.keys().next().value);
      }
      return kept.get(id);
    },
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
