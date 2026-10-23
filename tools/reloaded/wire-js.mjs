// The newest wire-<version>.json (relay/lib/reloaded/, dump-wire.sh's) as a module the page can
// import too: web/js/spectate/reloaded-wire-data.js, which web/js/spectate/reloaded-wire.js
// reads. The JSON stays what the wire is read off; this only copies it.
//   node tools/reloaded/wire-js.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'relay/lib/reloaded');
const newest = fs.readdirSync(dir).map((f) => /^wire-(\d+)\.json$/.exec(f)).filter(Boolean).sort((a, b) => b[1] - a[1])[0];
if (!newest) throw new Error('no wire-<version>.json in ' + dir);
const wire = JSON.parse(fs.readFileSync(path.join(dir, newest[0]), 'utf8'));
const out = path.join(root, 'web/js/spectate/reloaded-wire-data.js');
fs.writeFileSync(out, `// Soldat Reloaded's wire, protocol ${wire.version}: relay/lib/reloaded/${newest[0]} as a module (made by
// tools/reloaded/wire-js.mjs; don't edit it here)
export default ${JSON.stringify(wire)};
`);
console.log(path.relative(root, out));
