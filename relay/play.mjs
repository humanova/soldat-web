#!/usr/bin/env node
// Soldat Web play relay: serves the browser client, proxies the lobby server list and
// bridges WebSocket <-> UDP so browsers can talk to Soldat 1.7.1 servers.
// (relay/spectator.mjs is the public spectator hub; it shares only relay/lib.)
// No dependencies (Node.js 18+).
//
//   node relay/play.mjs [--port 8080] [--root ./web] [--allow 127.0.0.1:23073]
//
// Environment: PORT, ROOT, ALLOW (comma separated host:port list), ALLOW_ANY=1,
// LOBBY_URL, TRUST_PROXY=1, MAX_SESSIONS_PER_IP, ORIGINS (comma separated page
// origins allowed to use the relay besides its own; "*" for any).

import http from 'node:http';
import dgram from 'node:dgram';
import net from 'node:net';
import dns from 'node:dns/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, makeArg, originChecker, clientIpOf, requestUrl } from './lib/util.mjs';
import { serveStatic } from './lib/static.mjs';
import { acceptWebSocket } from './lib/ws.mjs';
import { proxyFiles } from './lib/files.mjs';
import { makeLobby } from './lib/lobby.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = makeArg(args);

const PORT = parseInt(arg('port', process.env.PORT || '8080'), 10);
const ROOT = path.resolve(arg('root', process.env.ROOT || path.join(here, '..', 'web')));
const LOBBY_URL = process.env.LOBBY_URL || 'https://api.soldat.pl/v0/servers';
const ALLOW_ANY = process.env.ALLOW_ANY === '1' || args.includes('--allow-any');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const clientIp = clientIpOf(TRUST_PROXY);
const MAX_SESSIONS_PER_IP = parseInt(process.env.MAX_SESSIONS_PER_IP || '4', 10);
const MAX_SESSIONS = 1000;
const IDLE_TIMEOUT = 60_000;
const MAX_DATAGRAM = 8192;

// The 1.7.1 server firewalls an address that sends more than 18 RequestGame/PlayerInfo
// messages within 1000 ticks (~16.7 s). All relayed players share our address, so
// these messages are paced per target server.
const JOIN_MSG_IDS = new Set([14, 15]);
const JOIN_WINDOW_MS = 17_000;
const JOIN_MAX_PER_WINDOW = 14;

const originAllowed = originChecker(new Set((process.env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)));

const staticAllow = new Set((arg('allow', process.env.ALLOW || '') || '').split(',').map(s => s.trim()).filter(Boolean));

// ---------------------------------------------------------------- lobby list

const lobbyList = makeLobby(LOBBY_URL, log);

// the lobby's servers as the page gets them, and their addresses
async function lobby() {
  const l = await lobbyList();
  if (l.body === undefined) {
    l.body = JSON.stringify({ Servers: l.servers });
    l.allowed = new Set(l.servers.map(s => `${s.IP}:${s.Port}`));
  }
  return l;
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

async function startFiles(ws, clientAddr, m) {
  const filePort = Number(m.port);
  const { ip } = await resolveTarget(m.host, filePort - 10);
  if (!(await targetAllowed(m.host, ip, filePort - 10))) {
    throw new Error('This relay only connects to servers listed in the Soldat lobby.');
  }
  log(`file request ${clientAddr} -> ${ip}:${filePort}`);
  return proxyFiles(ws, ip, filePort, m.files);
}

// ---------------------------------------------------------------- http server

const server = http.createServer(async (req, res) => {
  const url = requestUrl(req);
  if (!url) { res.writeHead(400).end(); return; }
  if (url.pathname === '/api/servers') {
    const l = await lobby();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(l.body);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  serveStatic(ROOT, req, res);
});

server.on('upgrade', (req, socket, head) => {
  const url = requestUrl(req);
  socket.on('error', () => {});
  if (url && url.pathname === '/relay') handleRelay(req, socket, head);
  else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.listen(PORT, () => {
  log(`Soldat Web on http://localhost:${PORT}/ (serving ${ROOT})`);
  if (ALLOW_ANY) log('WARNING: relay accepts any destination (ALLOW_ANY)');
  if (staticAllow.size) log('extra allowed servers:', [...staticAllow].join(', '));
});
