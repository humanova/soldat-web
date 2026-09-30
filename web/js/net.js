// Networking for the 1.7.1 protocol. Browsers cannot send UDP, so datagrams travel
// over a WebSocket to the relay (relay/server.mjs), which forwards them to the game
// server. Map downloads use the server's TCP file server through the same relay, or
// the static asset mirror when it has the file.

const NET_CONNECTING = 0, NET_OPEN = 1, NET_CLOSED = 2;
const MAX_QUEUE = 256;
const ALLOWED_PREFIXES = ['maps/', 'textures/', 'scenery-gfx/'];
const ALLOWED_EXT = ['.pms', '.png', '.jpg', '.jpeg', '.bmp', '.gif'];

export function safeAssetPath(p) {
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..') || p.includes('\0')) return null;
  const lp = p.toLowerCase();
  if (!ALLOWED_PREFIXES.some(x => lp.startsWith(x))) return null;
  if (!ALLOWED_EXT.some(x => lp.endsWith(x))) return null;
  return p;
}

export function createNet(rt, vfs, opts) {
  let ws = null;
  let state = NET_CLOSED;
  let outQueue = [];
  const inQueue = [];
  let rtt = 0;
  let pingTimer = 0;
  const jobs = new Map();
  let nextJob = 1;
  let generation = 0;

  function relayUrl() {
    return opts.relayUrl();
  }

  function closeSocket() {
    generation++;
    clearInterval(pingTimer);
    pingTimer = 0;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (_) {}
    }
    ws = null;
    state = NET_CLOSED;
    outQueue = [];
    inQueue.length = 0;
  }

  function connect(host, port) {
    closeSocket();
    const gen = generation;
    state = NET_CONNECTING;
    let socket;
    try {
      socket = new WebSocket(relayUrl());
    } catch (e) {
      state = NET_CLOSED;
      opts.onError && opts.onError('Cannot reach the relay: ' + e.message);
      return;
    }
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => {
      if (gen !== generation) return;
      socket.send(JSON.stringify({ type: 'udp', host, port }));
    };
    socket.onmessage = (ev) => {
      if (gen !== generation) return;
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'ready') {
          state = NET_OPEN;
          for (const d of outQueue) socket.send(d);
          outQueue = [];
          pingTimer = setInterval(() => {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping', t: performance.now() }));
          }, 2000);
        } else if (msg.type === 'pong') {
          const sample = performance.now() - msg.t;
          rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
        } else if (msg.type === 'error') {
          opts.onError && opts.onError(msg.message || 'relay error');
          closeSocket();
        }
        return;
      }
      if (inQueue.length < 4096) inQueue.push(new Uint8Array(ev.data));
    };
    socket.onclose = () => {
      if (gen !== generation) return;
      if (state !== NET_CLOSED) opts.onError && opts.onError('Connection to the relay was lost.');
      state = NET_CLOSED;
      clearInterval(pingTimer);
    };
    socket.onerror = () => {};
  }

  // ---- file downloads ----

  function finishJob(job, ok) {
    if (job.status === 0) job.status = ok ? 1 : -1;
  }

  function storeFile(path, data) {
    vfs.writeFile('/user/downloads/' + path, data);
  }

  async function fetchStatic(job, path) {
    const actual = opts.assetIndex(path);
    if (!actual) return false;
    try {
      const res = await fetch(opts.assetBase() + actual.split('/').map(encodeURIComponent).join('/'));
      if (!res.ok) return false;
      const data = new Uint8Array(await res.arrayBuffer());
      job.progress += data.length;
      storeFile(actual, data);
      return true;
    } catch (_) {
      return false;
    }
  }

  function parseFileStream(buf, job) {
    // STARTFILES\r\n TotalSize(u32 BE) { path\r\n Size(u32 BE) bytes }* ENDFILES\r\n
    const dec = new TextDecoder('latin1');
    let p = 0;
    const readLine = () => {
      for (let i = p; i < buf.length - 1; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10) {
          const s = dec.decode(buf.subarray(p, i));
          p = i + 2;
          return s;
        }
      }
      return null;
    };
    if (readLine() !== 'STARTFILES') return 0;
    if (p + 4 > buf.length) return 0;
    p += 4;
    let count = 0;
    while (p < buf.length) {
      const line = readLine();
      if (line === null || line === 'ENDFILES') break;
      if (p + 4 > buf.length) break;
      const size = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
      p += 4;
      if (p + size > buf.length) break;
      const path = safeAssetPath(line);
      if (path) {
        storeFile(path, buf.slice(p, p + size));
        count++;
      }
      p += size;
    }
    return count;
  }

  function fetchFromServer(job, host, port, files) {
    return new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(relayUrl()); } catch (_) { resolve(0); return; }
      socket.binaryType = 'arraybuffer';
      const chunks = [];
      let total = 0;
      job.socket = socket;
      const done = () => {
        socket.onclose = socket.onmessage = null;
        const buf = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { buf.set(c, o); o += c.length; }
        resolve(parseFileStream(buf, job));
      };
      socket.onopen = () => socket.send(JSON.stringify({ type: 'files', host, port, files }));
      socket.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (msg.type === 'end') { try { socket.close(); } catch (_) {} done(); }
          if (msg.type === 'error') { job.error = msg.message; try { socket.close(); } catch (_) {} resolve(0); }
          return;
        }
        const c = new Uint8Array(ev.data);
        chunks.push(c);
        total += c.length;
        job.progress += c.length;
      };
      socket.onclose = () => done();
      socket.onerror = () => {};
    });
  }

  async function runJob(job, host, port, files) {
    const remaining = [];
    for (const f of files) {
      if (job.cancelled) return;
      if (!(await fetchStatic(job, f))) remaining.push(f);
    }
    if (job.cancelled) return;
    if (remaining.length) {
      await fetchFromServer(job, host, port, remaining);
    }
    if (job.cancelled) return;
    await vfs.sync();
    finishJob(job, true);
  }

  return {
    connect: (hostPtr, port) => { connect(rt.cstr(hostPtr), port); return 0; },
    state: () => state,
    send: (ptr, size) => {
      const d = rt.u8().slice(ptr, ptr + size);
      if (state === NET_OPEN && ws && ws.readyState === 1) { ws.send(d); return 0; }
      if (state === NET_CONNECTING) {
        if (outQueue.length < MAX_QUEUE) outQueue.push(d);
        return 0;
      }
      return -1;
    },
    recv: (buf, max) => {
      const d = inQueue.shift();
      if (!d) return 0;
      const n = Math.min(d.length, max);
      rt.u8().set(d.subarray(0, n), buf);
      return n;
    },
    close: () => closeSocket(),
    ping: () => Math.round(rtt),
    fetch_files: (hostPtr, port, filesPtr) => {
      const host = rt.cstr(hostPtr);
      const files = rt.cstr(filesPtr).split('\n').map(s => s.trim()).map(safeAssetPath).filter(Boolean);
      const id = nextJob++;
      const job = { status: 0, progress: 0, cancelled: false, socket: null };
      jobs.set(id, job);
      if (!files.length) finishJob(job, false);
      else runJob(job, host, port, files).catch((e) => { console.error(e); finishJob(job, false); });
      return id;
    },
    fetch_status: (id) => { const j = jobs.get(id); return j ? j.status : -1; },
    fetch_progress: (id) => { const j = jobs.get(id); return j ? j.progress : 0; },
    fetch_cancel: (id) => {
      const j = jobs.get(id);
      if (!j) return;
      j.cancelled = true;
      if (j.socket) try { j.socket.close(); } catch (_) {}
      jobs.delete(id);
    },
  };
}
