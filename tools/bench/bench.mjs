// Frame-time benchmark: opens the client in a separate headless Chrome, joins a
// server, and reports frame pacing, CPU time per frame (the game's whole frame:
// network, input, simulation, rendering), GPU time per frame and import calls.
//
//   node tools/bench/bench.mjs --server HOST:PORT [--url http://localhost:8080/]
//     [--seconds 10] [--screen 1512x982x2] [--uncapped] [--headful]
//     [--profile out.cpuprofile] [--json out.json]
//
// --uncapped disables vsync to show how fast frames could be produced. A server
// with bots makes the numbers meaningful; the relay must allow it (ALLOW=...).
import { writeFileSync, readFileSync } from 'node:fs';
import { launchChrome, connect, sleep } from './cdp.mjs';
import { summarizeProfile } from './profile.mjs';

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const server = opt('server');
if (!server) { console.error('usage: bench.mjs --server HOST:PORT [--url URL] ...'); process.exit(2); }
const url = opt('url', 'http://localhost:8080/');
const seconds = Number(opt('seconds', 10));
const [sw, sh, dpr] = opt('screen', '1512x982x2').split('x').map(Number);

const chrome = await launchChrome({ headless: !flag('headful'),
  extra: flag('uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [] });
const c = await connect(chrome.wsUrl);
try {
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: sw, height: sh - 87, deviceScaleFactor: dpr, mobile: false, screenWidth: sw, screenHeight: sh });
  await c.send('Page.addScriptToEvaluateOnNewDocument',
    { source: readFileSync(new URL('inject.js', import.meta.url), 'utf8') });
  await c.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(250);
    ready = await c.evaluate(`!!document.getElementById('app') && !document.getElementById('app').hidden`).catch(() => false);
  }
  if (!ready) throw new Error('page did not load');
  const gpuName = await c.evaluate(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g && g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()`);
  await c.evaluate(`window.__bench.joinAt = performance.now(); document.getElementById('address').value = ${JSON.stringify(server)}; document.getElementById('join').click(); true`);
  let playing = false;
  for (let i = 0; i < 120 && !playing; i++) {
    await sleep(500);
    playing = await c.evaluate(`!!(window.soldat && window.soldat.running && window.__bench.mapAt)`);
  }
  if (!playing) throw new Error('the game did not start (is the server allowed by the relay?)');
  // pick a team if the server shows the team menu
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit1', key: '1', text: '1', windowsVirtualKeyCode: 49 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit1', key: '1', windowsVirtualKeyCode: 49 });
  await sleep(8000); // let V8 optimize the hot wasm functions
  await c.evaluate(`Object.assign(window.__bench, { frames: [], gpu: [], calls: Object.create(null), rec: true }); true`);
  if (opt('profile')) {
    await c.send('Profiler.enable');
    await c.send('Profiler.setSamplingInterval', { interval: 100 });
    await c.send('Profiler.start');
  }
  await sleep(seconds * 1000);
  const profile = opt('profile') ? (await c.send('Profiler.stop')).profile : null;
  const d = await c.evaluate(`(() => { const B = window.__bench; B.rec = false; const cv = document.getElementById('canvas');
    return { frames: B.frames, gpu: B.gpu, gpuExt: B.gpuExt, calls: B.calls, canvas: [cv.width, cv.height],
      joinMs: Math.round(B.mapAt - B.joinAt) }; })()`);
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify(d));
  if (profile) writeFileSync(opt('profile'), JSON.stringify(profile));
  report(d, gpuName);
  if (profile) console.log('\n' + summarizeProfile(profile, 20));
} finally {
  c.close();
  chrome.close();
}

function report(d, gpuName) {
  const f = d.frames;
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const stat = (a) => {
    const s = sorted(a), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return `mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)}  p50 ${q(0.5).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`;
  };
  const span = (f[f.length - 1][0] - f[0][0]) / 1000;
  const rendered = f.filter((x) => x[2] > 0);
  const gaps = rendered.slice(1).map((x, i) => x[0] - rendered[i][0]);
  console.log(`render ${d.canvas.join('x')} on ${gpuName}; map shown ${d.joinMs} ms after joining`);
  console.log(`display frames ${f.length} in ${span.toFixed(1)} s (${(f.length / span).toFixed(1)}/s), rendered ${rendered.length} (${(100 * rendered.length / f.length).toFixed(1)}%)`);
  console.log(`ms between rendered frames: ${stat(gaps)}`);
  console.log(`CPU ms per frame:           ${stat(f.map((x) => x[1]))}`);
  if (d.gpu.length) console.log(`GPU ms per frame:           ${stat(d.gpu)}`);
  else console.log('GPU ms per frame:           n/a (no EXT_disjoint_timer_query_webgl2)');
  const n = rendered.length || 1;
  console.log(`per rendered frame: ${(rendered.reduce((s, x) => s + x[2], 0) / n).toFixed(1)} draw calls, ${(rendered.reduce((s, x) => s + x[3], 0) / n).toFixed(1)} GL calls`);
  console.log('import calls per frame:', Object.entries(d.calls).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k} ${(v / f.length).toFixed(1)}`).join(', '));
}
