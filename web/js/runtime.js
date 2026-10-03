// Loads the game (soldat.wasm, or soldat-spectate.wasm for the spectator), provides its imports and drives the game loop.
import { VFS } from './vfs.js';
import { createWasi, WasiExit } from './wasi.js';
import { readZip } from './zip.js';
import { createPhysFS } from './physfs.js';
import { createGL } from './gl.js';
import { createSDL } from './sdl.js';
import { createAL } from './al.js';
import { createNet } from './net.js';

function makeRt() {
  const rt = {
    memory: null,
    exports: null,
    _u8: null,
    _dv: null,
    u8() {
      if (!this._u8 || this._u8.buffer !== this.memory.buffer) this._u8 = new Uint8Array(this.memory.buffer);
      return this._u8;
    },
    dv() {
      if (!this._dv || this._dv.buffer !== this.memory.buffer) this._dv = new DataView(this.memory.buffer);
      return this._dv;
    },
    cstr(ptr) {
      if (!ptr) return '';
      const u8 = this.u8();
      let end = ptr;
      while (u8[end]) end++;
      return new TextDecoder().decode(u8.subarray(ptr, end));
    },
    alloc(n) { return this.exports.soldat_malloc(n); },
    free(p) { if (p) this.exports.soldat_free(p); },
    allocCString(s) {
      const b = new TextEncoder().encode(s);
      const p = this.alloc(b.length + 1);
      this.u8().set(b, p);
      this.u8()[p + b.length] = 0;
      return p;
    },
  };
  return rt;
}

function hwid() {
  const KEY = 'soldat.hwid';
  let id = null;
  try { id = localStorage.getItem(KEY); } catch (_) {}
  if (!id || !/^[0-9A-F]{10}$/.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(5));
    id = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    try { localStorage.setItem(KEY, id); } catch (_) {}
  }
  return id;
}

export class SoldatRuntime {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.rt = makeRt();
    this.vfs = new VFS();
    this.archives = new Map();
    this.assetIndex = new Map();
    this.running = false;
    this.started = false;
    this.rafId = 0;
    this.hiddenTimer = 0;
    this.log = [];
  }

  async fetchBytes(url, label, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async load({ base = '', wasm: wasmFile = 'soldat.wasm', onStatus = () => {} } = {}) {
    onStatus('Opening local storage...');
    await this.vfs.load();
    this.vfs.mkdirp('/user');
    this.vfs.mkdirp('/soldat');

    onStatus('Downloading game data...');
    const [wasm, pack, font, index] = await Promise.all([
      (WebAssembly.compileStreaming
        ? WebAssembly.compileStreaming(fetch(base + wasmFile))
        : Promise.reject(new Error('no streaming')))
        .catch(() => this.fetchBytes(base + wasmFile, wasmFile).then(b => WebAssembly.compile(b))),
      this.fetchBytes(base + 'soldat.smod', 'soldat.smod', (got, total) =>
        onStatus(`Downloading game data... ${Math.round(got / 1048576)}${total ? ' / ' + Math.round(total / 1048576) : ''} MB`)),
      this.fetchBytes(base + 'play-regular.ttf', 'font'),
      fetch(base + 'assets/index.json').then(r => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    this.assetBase = new URL(base + 'assets/', location.href).href;
    for (const p of index) this.assetIndex.set(p.toLowerCase(), p);

    onStatus('Unpacking game data...');
    this.vfs.writeFile('/soldat/play-regular.ttf', font);
    // the archive itself stays in JS memory; PhysFS reads entries from the parsed index
    this.vfs.writeFile('/soldat/soldat.smod', new Uint8Array(0));
    this.archives.set('soldat/soldat.smod', await readZip(pack));
    this.module = wasm;
  }

  // alternatives for image names the map refers to (.bmp in old maps, .png on disk)
  findAsset(path) {
    const lp = path.toLowerCase();
    if (this.assetIndex.has(lp)) return this.assetIndex.get(lp);
    const base = lp.replace(/\.[^./]+$/, '');
    for (const ext of ['.png', '.jpg', '.bmp', '.gif']) {
      if (this.assetIndex.has(base + ext)) return this.assetIndex.get(base + ext);
    }
    return null;
  }

  async instantiate() {
    const rt = this.rt;
    const hooks = this.hooks;
    this.sdl = createSDL(rt, this.canvas, {
      displaySize: () => hooks.displaySize(),
      onWindow: (w, h) => hooks.onWindow && hooks.onWindow(w, h),
      onPointerLock: (locked) => hooks.onPointerLock && hooks.onPointerLock(locked),
      onMessage: (title, text) => hooks.onMessage && hooks.onMessage(title, text),
    });
    this.gl = createGL(rt, () => this.sdl.getContext());
    this.al = createAL(rt);
    this.physfs = createPhysFS(rt, this.vfs, this.archives);
    this.net = createNet(rt, this.vfs, {
      relayUrl: () => hooks.relayUrl(),
      request: hooks.relayRequest,
      receiveOnly: !!hooks.receiveOnly,
      assetBase: () => this.assetBase,
      assetIndex: (p) => this.findAsset(p),
      onError: (msg) => hooks.onNetError && hooks.onNetError(msg),
    });
    const wasi = createWasi(rt, this.vfs, {
      args: ['soldat', ...(hooks.args || [])],
      onStdout: (line, err) => {
        this.log.push(line);
        if (this.log.length > 500) this.log.shift();
        (err ? console.warn : console.log)('[soldat]', line);
      },
    });
    const env = {
      get_hwid: (ptr) => {
        const b = new TextEncoder().encode(hwid());
        rt.u8().set(b, ptr);
        rt.u8()[ptr + b.length] = 0;
        return b.length;
      },
    };
    const imports = {
      wasi_snapshot_preview1: wasi,
      sdl: this.sdl, gl: this.gl, al: this.al, physfs: this.physfs, net: this.net, env,
    };
    // unused imports resolve to stubs so a newer build never fails to link
    for (const imp of WebAssembly.Module.imports(this.module)) {
      if (imp.kind !== 'function') continue;
      const mod = imports[imp.module] || (imports[imp.module] = {});
      if (!(imp.name in mod)) {
        console.warn('missing import', imp.module + '.' + imp.name);
        mod[imp.name] = () => 0;
      }
    }
    this.instance = await WebAssembly.instantiate(this.module, imports);
    rt.exports = this.instance.exports;
    rt.memory = this.instance.exports.memory;
    this.instance.exports._initialize();
  }

  call(name, ...args) {
    try {
      return this.rt.exports[name](...args);
    } catch (e) {
      if (e instanceof WasiExit) {
        this.stopLoop();
        if (this.hooks.onExit) this.hooks.onExit(e.code);
        return 1;
      }
      throw e;
    }
  }

  startGame() {
    if (this.started) return;
    this.started = true;
    this.call('soldat_start');
  }

  command(text) {
    const p = this.rt.allocCString(text);
    try { this.call('soldat_command', p); } finally { this.rt.free(p); }
  }

  join(host, port, password = '') {
    const h = this.rt.allocCString(host);
    const pw = this.rt.allocCString(password);
    let ok = 0;
    try {
      this.sdl.setActive(true);
      this.al.resume();
      ok = this.call('soldat_join', h, port, pw);
    } finally {
      this.rt.free(h);
      this.rt.free(pw);
    }
    if (ok) this.startLoop();
    else this.sdl.setActive(false);
    return !!ok;
  }

  leave() {
    if (!this.running) return;
    this.call('soldat_leave');
  }

  frame() {
    const r = this.call('soldat_frame');
    if (r !== 0) {
      this.stopLoop();
      this.sdl.setActive(false);
      this.vfs.sync();
      if (this.hooks.onLeave) this.hooks.onLeave();
    }
  }

  startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = 0;
    const run = (frameTime) => {
      this.lastFrame = performance.now();
      this.sdl.setFrameClock(frameTime || this.lastFrame);
      this.frame();
    };
    const tick = (frameTime) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      run(frameTime);
    };
    this.rafId = requestAnimationFrame(tick);
    // requestAnimationFrame is paused in background tabs and throttled in some
    // embedded views: keep simulating (and the connection alive) with a timer.
    // Timers in a worker are not throttled like main-thread timers in hidden tabs.
    const fallback = () => {
      if (this.running && performance.now() - this.lastFrame > 34) run();
    };
    try {
      const src = 'setInterval(() => postMessage(0), 15);';
      this.timerWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.timerWorker.onmessage = fallback;
    } catch (_) {
      this.hiddenTimer = setInterval(fallback, 15);
    }
  }

  stopLoop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.sdl.setFrameClock(0);
    clearInterval(this.hiddenTimer);
    if (this.timerWorker) {
      this.timerWorker.terminate();
      this.timerWorker = null;
    }
  }
}
