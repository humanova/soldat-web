#!/usr/bin/env node
// Soldat Web relay: serves the browser client, proxies the lobby server list and
// bridges WebSocket <-> UDP so browsers can talk to Soldat 1.7.1 servers.
// No dependencies (Node.js 18+).
//
//   node relay/server.mjs [--port 8080] [--root ./web] [--allow 127.0.0.1:23073]
//
// Environment: PORT, ROOT, ALLOW (comma separated host:port list), ALLOW_ANY=1,
// LOBBY_URL, TRUST_PROXY=1, MAX_SESSIONS_PER_IP, ORIGINS (comma separated page
// origins allowed to use the relay besides its own; "*" for any).

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const PORT = parseInt(arg('port', process.env.PORT || '8080'), 10);
const ROOT = path.resolve(arg('root', process.env.ROOT || path.join(here, '..', 'web')));
const LOBBY_URL = process.env.LOBBY_URL || 'https://api.soldat.pl/v0/servers';
const ALLOW_ANY = process.env.ALLOW_ANY === '1' || args.includes('--allow-any');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_SESSIONS_PER_IP = parseInt(process.env.MAX_SESSIONS_PER_IP || '4', 10);
const MAX_SESSIONS = 1000;
const IDLE_TIMEOUT = 60_000;
const MAX_DATAGRAM = 8192;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// The 1.7.1 server firewalls an address that sends more than 18 RequestGame/PlayerInfo
// messages within 1000 ticks (~16.7 s). All relayed players share our address, so
// these messages are paced per target server.
const JOIN_MSG_IDS = new Set([14, 15]);
const JOIN_WINDOW_MS = 17_000;
const JOIN_MAX_PER_WINDOW = 14;

// Browsers send an Origin header with WebSocket requests. By default only pages served by
// this relay may use it (other sites cannot borrow it); ORIGINS adds allowed origins.
const allowedOrigins = new Set((process.env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  if (allowedOrigins.has('*') || allowedOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (_) {
    return false;
  }
}

const staticAllow = new Set((arg('allow', process.env.ALLOW || '') || '').split(',').map(s => s.trim()).filter(Boolean));

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// ---------------------------------------------------------------- lobby list

let lobbyCache = { time: 0, body: null, allowed: new Set() };
let lobbyPending = null;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10_000, headers: { 'User-Agent': 'soldat-web-relay' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(new Error('too large')); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function lobby() {
  if (Date.now() - lobbyCache.time < 15_000 && lobbyCache.body) return lobbyCache;
  if (!lobbyPending) {
    lobbyPending = fetchText(LOBBY_URL).then((text) => {
      const data = JSON.parse(text);
      const allowed = new Set();
      for (const s of data.Servers || []) allowed.add(`${s.IP}:${s.Port}`);
      lobbyCache = { time: Date.now(), body: JSON.stringify({ Servers: data.Servers || [] }), allowed };
      return lobbyCache;
    }).finally(() => { lobbyPending = null; });
  }
  try {
    return await lobbyPending;
  } catch (e) {
    log('lobby fetch failed:', e.message);
    if (lobbyCache.body) return lobbyCache;
    return { time: 0, body: JSON.stringify({ Servers: [] }), allowed: new Set() };
  }
}

async function resolveTarget(host, port) {
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.\-:]+$/.test(host)) throw new Error('invalid host');
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  let ip = host;
  if (net.isIP(host) === 0) {
    const r = await dns.lookup(host, { family: 4 });
    ip = r.address;
  }
  if (net.isIP(ip) !== 4) throw new Error('only IPv4 servers are supported');
  return { ip, port };
}

async function targetAllowed(host, ip, port) {
  if (ALLOW_ANY) return true;
  if (staticAllow.has(`${ip}:${port}`) || staticAllow.has(`${host}:${port}`)) return true;
  const l = await lobby();
  return l.allowed.has(`${ip}:${port}`);
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.smod': 'application/zip', '.zip': 'application/zip', '.ttf': 'font/ttf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pms': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.wasm', '.smod', '.ttf', '.bmp', '.pms', '.txt', '.svg']);
const gzCache = new Map();

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400).end(); return; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.resolve(ROOT, '.' + urlPath);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // revalidate code and data (ETag); on-demand map graphics never change
      'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext) && st.size > 1024;
    if (gzipOk) {
      const key = file + etag;
      const send = (buf) => {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = buf.length;
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : buf);
      };
      if (gzCache.has(key)) { send(gzCache.get(key)); return; }
      fs.readFile(file, (e2, data) => {
        if (e2) { res.writeHead(500).end(); return; }
        zlib.gzip(data, { level: 6 }, (e3, gz) => {
          if (e3) { res.writeHead(500).end(); return; }
          if (gz.length < 256 * 1024 * 1024) gzCache.set(key, gz);
          send(gz);
        });
      });
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- websocket

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buf.length) setImmediate(() => this.parse());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    if (this.onclose) this.onclose();
  }

  parse() {
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        if (hi !== 0) { this.close(1009); return; }
        len = b.readUInt32BE(6); off = 10;
      }
      if (!masked) { this.close(1002); return; }
      if (len > 1 << 20) { this.close(1009); return; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) {
        if (!this.frag) { this.close(1002); return; }
        this.frag.push(payload);
        if (fin) {
          const data = Buffer.concat(this.frag);
          const fop = this.fragOp;
          this.frag = null;
          this.deliver(fop, data);
        }
        continue;
      }
      if (op !== 0x1 && op !== 0x2) { this.close(1003); return; }
      if (!fin) { this.frag = [payload]; this.fragOp = op; continue; }
      this.deliver(op, payload);
    }
  }

  deliver(op, data) {
    if (this.onmessage) this.onmessage(op === 0x1 ? data.toString('utf8') : data, op === 0x2);
  }

  sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendText(obj) { this.sendFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  sendBinary(buf) { this.sendFrame(0x2, buf); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    try { this.sendFrame(0x8, p); } catch (_) {}
    this.socket.end();
    setTimeout(() => this.finish(), 1000);
  }

  get buffered() { return this.socket.writableLength; }
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConn(socket, head);
}

// ---------------------------------------------------------------- sessions

const sessionsByIp = new Map();
let sessionCount = 0;
const joinPacing = new Map(); // "ip:port" -> { times: [], queue: [], timer }
let sessionCounter = 0;

function paceJoin(target, send, key) {
  let p = joinPacing.get(target);
  if (!p) { p = { times: [], queue: [], timer: 0 }; joinPacing.set(target, p); }
  // one pending message per session and type: a newer retry replaces the queued one
  const pending = p.queue.find(item => item.key === key);
  if (pending) { pending.send = send; pending.at = Date.now(); return; }
  const pump = () => {
    p.timer = 0;
    const now = Date.now();
    p.times = p.times.filter(t => now - t < JOIN_WINDOW_MS);
    while (p.queue.length && p.times.length < JOIN_MAX_PER_WINDOW) {
      const item = p.queue.shift();
      if (now - item.at > 20_000) continue; // stale, the client retries anyway
      p.times.push(now);
      item.send();
    }
    if (p.queue.length) p.timer = setTimeout(pump, Math.max(50, JOIN_WINDOW_MS - (now - p.times[0])));
    else if (!p.times.length) joinPacing.delete(target);
  };
  if (p.queue.length > 64) return; // drop, far too many joins in flight
  p.queue.push({ at: Date.now(), send, key });
  if (!p.timer) pump();
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

function handleRelay(req, socket, head) {
  const ip = clientIp(req);
  if (!originAllowed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const count = sessionsByIp.get(ip) || 0;
  if (count >= MAX_SESSIONS_PER_IP || sessionCount >= MAX_SESSIONS) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return;
  }
  const ws = acceptWebSocket(req, socket, head);
  if (!ws) return;
  sessionsByIp.set(ip, count + 1);
  sessionCount++;
  let started = false;
  let cleanup = () => {};
  ws.onclose = () => {
    sessionCount--;
    const c = (sessionsByIp.get(ip) || 1) - 1;
    if (c <= 0) sessionsByIp.delete(ip); else sessionsByIp.set(ip, c);
    cleanup();
  };
  const hello = setTimeout(() => { if (!started) ws.close(1008); }, 10_000);
  ws.onmessage = async (msg, binary) => {
    if (started || binary) return;
    let m;
    try { m = JSON.parse(msg); } catch (_) { ws.close(1003); return; }
    started = true;
    clearTimeout(hello);
    try {
      if (m.type === 'udp') cleanup = await startUdp(ws, ip, m);
      else if (m.type === 'files') cleanup = await startFiles(ws, ip, m);
      else throw new Error('unknown request');
    } catch (e) {
      ws.sendText({ type: 'error', message: e.message });
      ws.close(1008);
    }
  };
}

async function startUdp(ws, clientAddr, m) {
  const { ip, port } = await resolveTarget(m.host, m.port);
  if (!(await targetAllowed(m.host, ip, port))) {
    throw new Error('This relay only connects to servers listed in the Soldat lobby.');
  }
  const target = `${ip}:${port}`;
  const sessionId = ++sessionCounter;
  const sock = dgram.createSocket('udp4');
  let last = Date.now();
  let windowStart = Date.now(), windowCount = 0, windowBytes = 0;
  sock.on('message', (data, rinfo) => {
    if (rinfo.address !== ip || rinfo.port !== port) return;
    last = Date.now();
    if (ws.buffered > 1 << 20) return; // client too slow; drop like UDP would
    ws.sendBinary(data);
  });
  sock.on('error', (e) => { log('udp error', target, e.message); ws.close(1011); });
  await new Promise((resolve) => sock.bind(0, resolve));
  const send = (buf) => { try { sock.send(buf, port, ip); } catch (_) {} };
  ws.onmessage = (msg, binary) => {
    if (!binary) {
      try {
        const c = JSON.parse(msg);
        if (c.type === 'ping') ws.sendText({ type: 'pong', t: c.t });
      } catch (_) {}
      return;
    }
    if (msg.length === 0 || msg.length > MAX_DATAGRAM) return;
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; windowBytes = 0; }
    if (++windowCount > 300 || (windowBytes += msg.length) > 256 * 1024) return;
    last = now;
    if (JOIN_MSG_IDS.has(msg[0])) paceJoin(target, () => send(msg), sessionId + ':' + msg[0]);
    else send(msg);
  };
  const idle = setInterval(() => { if (Date.now() - last > IDLE_TIMEOUT) ws.close(1000); }, 5000);
  ws.sendText({ type: 'ready' });
  log(`udp session ${clientAddr} -> ${target}`);
  return () => { clearInterval(idle); try { sock.close(); } catch (_) {} };
}

const FILE_RE = /^(maps\/[^/\\]+\.pms|textures\/[^\\]+\.(png|jpg|jpeg|bmp|gif)|scenery-gfx\/[^/\\]+\.(png|jpg|jpeg|bmp|gif))$/i;

async function startFiles(ws, clientAddr, m) {
  const filePort = Number(m.port);
  const { ip } = await resolveTarget(m.host, filePort - 10);
  if (!(await targetAllowed(m.host, ip, filePort - 10))) {
    throw new Error('This relay only connects to servers listed in the Soldat lobby.');
  }
  const files = Array.isArray(m.files) ? m.files.filter(f => typeof f === 'string' && FILE_RE.test(f) && !f.includes('..')) : [];
  if (!files.length || files.length > 256) throw new Error('bad file list');
  const tcp = net.connect({ host: ip, port: filePort });
  let total = 0;
  const timer = setTimeout(() => tcp.destroy(new Error('timeout')), 90_000);
  tcp.on('connect', () => {
    tcp.write('STARTFILES\r\n' + files.join('\r\n') + '\r\nENDFILES\r\n');
  });
  tcp.on('data', (d) => {
    total += d.length;
    if (total > MAX_FILE_BYTES) { tcp.destroy(); return; }
    ws.sendBinary(d);
    if (ws.buffered > 8 << 20) tcp.pause();
  });
  const resume = setInterval(() => { if (tcp.isPaused() && ws.buffered < 1 << 20) tcp.resume(); }, 50);
  const end = (err) => {
    clearTimeout(timer);
    clearInterval(resume);
    if (err) ws.sendText({ type: 'error', message: 'file server: ' + err.message });
    else ws.sendText({ type: 'end' });
    ws.close(1000);
  };
  tcp.on('end', () => end());
  tcp.on('error', (e) => end(e));
  log(`file request ${clientAddr} -> ${ip}:${filePort} (${files.length} files)`);
  return () => { clearTimeout(timer); clearInterval(resume); tcp.destroy(); };
}

// ---------------------------------------------------------------- http server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/servers') {
    const l = await lobby();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(l.body);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  socket.on('error', () => {});
  if (url.pathname === '/relay') handleRelay(req, socket, head);
  else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.listen(PORT, () => {
  log(`Soldat Web on http://localhost:${PORT}/ (serving ${ROOT})`);
  if (ALLOW_ANY) log('WARNING: relay accepts any destination (ALLOW_ANY)');
  if (staticAllow.size) log('extra allowed servers:', [...staticAllow].join(', '));
});
