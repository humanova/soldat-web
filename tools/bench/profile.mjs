// Summarizes a V8 .cpuprofile (from bench.mjs --profile): self and inclusive time
// per function. Wasm functions carry their Free Pascal names.
// Usage: node tools/bench/profile.mjs file.cpuprofile [top]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function summarizeProfile(p, top = 30) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = (n) => {
    const { functionName, url } = n.callFrame;
    const where = url.startsWith('wasm') ? ' [wasm]' : url ? ` [${url.replace(/^.*\//, '')}]` : '';
    return (functionName || '(anonymous)') + where;
  };
  const self = new Map(), incl = new Map();
  let total = 0, idle = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const dt = p.timeDeltas[i] || 0;
    const node = byId.get(p.samples[i]);
    total += dt;
    if (node.callFrame.functionName === '(idle)') { idle += dt; continue; }
    self.set(name(node), (self.get(name(node)) || 0) + dt);
    const seen = new Set();
    for (let id = p.samples[i]; id !== undefined; id = parent.get(id)) {
      const k = name(byId.get(id));
      if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); }
    }
  }
  const busy = total - idle;
  const lines = [`CPU busy ${(busy / 1000).toFixed(0)} ms of ${(total / 1000).toFixed(0)} ms (${(100 * busy / total).toFixed(1)}%)`];
  const table = (title, m) => {
    lines.push(title);
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) {
      lines.push(`${(v / 1000).toFixed(1).padStart(8)} ms ${(100 * v / busy).toFixed(1).padStart(5)}%  ${k}`);
    }
  };
  table('self time (% of busy):', self);
  table('inclusive time (% of busy):', incl);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(summarizeProfile(JSON.parse(readFileSync(process.argv[2], 'utf8')), Number(process.argv[3] || 30)));
}
