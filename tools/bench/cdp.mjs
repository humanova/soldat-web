// Starts a separate Chrome (own temporary profile) and talks the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform];

export async function launchChrome({ port = 9333, headless = true, extra = [] } = {}) {
  const userDir = mkdtempSync(join(tmpdir(), 'soldat-bench-'));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist', '--disable-extensions',
    ...(headless ? ['--headless=new'] : []), ...extra, 'about:blank',
  ];
  const proc = spawn(process.env.CHROME || DEFAULT_CHROME, args, { stdio: 'ignore' });
  const cleanup = () => { proc.kill(); setTimeout(() => rmSync(userDir, { recursive: true, force: true }), 500); };
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { wsUrl: page.webSocketDebuggerUrl, close: cleanup };
    } catch (_) {}
    await sleep(100);
  }
  cleanup();
  throw new Error('Chrome did not start (set CHROME=/path/to/chrome)');
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    pending.set(++id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
