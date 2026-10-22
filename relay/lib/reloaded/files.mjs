// The files of Soldat Reloaded servers' maps, as the hub fetched them (a round's .pms and
// its own art), kept in `dir` by their SHA-256, the hash the server names them by (Map,
// Map_Art). Viewers' games ask the hub for them (Map_Fetch) as they would the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HELD = 16;          // files kept in memory, the latest asked for

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function makeReloadedFiles({ dir, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const held = new Map();   // hash -> bytes, oldest first
  const file = (hash) => path.join(dir, hash);
  const hold = (hash, bytes) => {
    held.delete(hash);
    held.set(hash, bytes);
    while (held.size > HELD) held.delete(held.keys().next().value);
    return bytes;
  };
  return {
    has(hash) {
      return held.has(hash) || fs.existsSync(file(hash));
    },
    // the file's bytes, or null
    get(hash) {
      const b = held.get(hash);
      if (b) return hold(hash, b);
      try { return hold(hash, fs.readFileSync(file(hash))); } catch (_) { return null; }
    },
    // bytes fetched for `hash`: kept if they are what it names
    put(hash, bytes) {
      if (sha256(bytes) !== hash) return false;
      const tmp = file(hash) + '.part';
      try {
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file(hash));
      } catch (e) {
        log('could not keep a map file: ' + e.message);
      }
      hold(hash, bytes);
      return true;
    },
  };
}
