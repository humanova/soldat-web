// A Soldat Reloaded demo's clips and the director's picks (reloaded-plays.js), found off the
// page's thread: reading a long match takes seconds, and the game in the frame shares the
// page's. It takes the demo's bytes and posts { clips, cams } or { error }.
import { findReloadedPlays } from './reloaded-plays.js';

self.onmessage = (e) => {
  try {
    const { clips, cams } = findReloadedPlays(e.data);
    self.postMessage({ clips, cams });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
