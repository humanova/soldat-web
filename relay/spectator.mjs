#!/usr/bin/env node
// Soldat Web spectator hub: the public counterpart of relay/play.mjs. It serves the
// spectator page and streams matches of the game servers named in its config. For each
// watched server it holds a single spectator connection (relay/lib/hub.mjs) that all
// viewers share; viewers pick a server by its id and never send anything to it.
// No dependencies (Node.js 18+).
//
//   node relay/spectator.mjs [--config relay/spectator.json] [--port 8090]
//
// Config (JSON, see relay/spectator.example.json):
//   servers: [{ id, name, host, port, password?, delaySeconds?, group?, askPassword? }]
//                   the only servers it joins. group: the guide's tab the server is listed
//                   under (none: the main list); askPassword: viewers give the server's
//                   password (a link has it, /<id>?password=..., or the page asks), the hub
//                   keeps the last one that worked and then anyone can watch
//   playerName      name of the spectator on the servers (at most 23 characters)
//   delaySeconds    broadcast delay (anti ghosting), per server overridable
//   lingerSeconds   how long the spectator stays on a server after the last viewer left
//   maxViewersPerIp, maxViewers, origins (other page origins allowed), trustProxy,
//   lobbyUrl (the Soldat lobby's server list, for the current map and players of servers not
//             watched; their names come from .../server/<ip>/<port>/players next to it)
// Environment: PORT, ROOT, CONFIG.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { log, makeArg, originChecker, clientIpOf, requestUrl } from './lib/util.mjs';
import { serveStatic } from './lib/static.mjs';
import { acceptWebSocket } from './lib/ws.mjs';
import { proxyFiles } from './lib/files.mjs';
import { Hub } from './lib/hub.mjs';
import { makeLobby, makeLobbyPlayers } from './lib/lobby.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = makeArg(process.argv.slice(2));
const CONFIG = path.resolve(arg('config', process.env.CONFIG || path.join(here, 'spectator.json')));
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const PORT = parseInt(arg('port', process.env.PORT || config.port || '8090'), 10);
const ROOT = path.resolve(arg('root', process.env.ROOT || path.join(here, '..', 'web')));
const MAX_VIEWERS = config.maxViewers ?? 500;
const MAX_VIEWERS_PER_IP = config.maxViewersPerIp ?? 3;
const PLAYER_NAME = String(config.playerName || '[soldat.live] Soldat TV').slice(0, 23);
const LOBBY_URL = config.lobbyUrl || 'https://api.soldat.pl/v0/servers';
const lobby = makeLobby(LOBBY_URL, log);
const lobbyPlayers = makeLobbyPlayers(LOBBY_URL, log);
const originAllowed = originChecker(new Set(config.origins || []));
const clientIp = clientIpOf(!!config.trustProxy);

// the game client is not served here: the public site only spectates
const HIDDEN = new Set(['/index.html', '/soldat.wasm', '/js/main.js']);

const hubs = new Map();
for (const s of config.servers || []) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(s.id || '') || !s.host || !(s.port > 0 && s.port < 65536) ||
      (s.group != null && !/^[\w .'-]{1,24}$/.test(s.group))) {
    throw new Error('bad server entry in config: ' + JSON.stringify(s));
  }
  if (hubs.has(s.id)) throw new Error('duplicate server id ' + s.id);
  hubs.set(s.id, new Hub({ ...s, name: s.name || s.id }, {
    playerName: PLAYER_NAME, delaySeconds: config.delaySeconds ?? 0, log,
    lingerMs: (config.lingerSeconds ?? 60) * 1000,
  }));
}

// ---------------------------------------------------------------- viewers

const viewersByIp = new Map();
let viewerCount = 0;

// wrong passwords (askPassword servers), per address: a few tries, then a pause
const WRONG_MAX = 5, WRONG_WINDOW_MS = 10 * 60_000;
const wrongByIp = new Map();
function wrongTries(ip) {
  const w = wrongByIp.get(ip);
  return w && Date.now() - w.since < WRONG_WINDOW_MS ? w.count : 0;
}
function addWrong(ip) {
  const count = wrongTries(ip);
  wrongByIp.set(ip, { count: count + 1, since: count ? wrongByIp.get(ip).since : Date.now() });
}
setInterval(() => { for (const ip of wrongByIp.keys()) if (!wrongTries(ip)) wrongByIp.delete(ip); }, 60_000).unref();

function handleWatch(req, socket, head) {
  const ip = clientIp(req);
  if (!originAllowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const count = viewersByIp.get(ip) || 0;
  if (count >= MAX_VIEWERS_PER_IP || viewerCount >= MAX_VIEWERS) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return;
  }
  const ws = acceptWebSocket(req, socket, head);
  if (!ws) return;
  viewersByIp.set(ip, count + 1);
  viewerCount++;
  let cleanup = () => {};
  ws.onclose = () => {
    viewerCount--;
    const c = (viewersByIp.get(ip) || 1) - 1;
    if (c <= 0) viewersByIp.delete(ip); else viewersByIp.set(ip, c);
    cleanup();
  };
  const hello = setTimeout(() => ws.close(1008), 10_000);
  let started = false;
  ws.onmessage = (msg, binary) => {
    // one request per connection: a second one would start another stream or download
    if (binary || started) return;
    started = true;
    clearTimeout(hello);
    let m;
    try { m = JSON.parse(msg); } catch (_) { ws.close(1003); return; }
    if (!m || typeof m !== 'object') { ws.close(1003); return; }
    const hub = typeof m.server === 'string' ? hubs.get(m.server) : null;
    if (!hub) { ws.sendText({ type: 'error', message: 'Unknown server.' }); ws.close(1008); return; }
    let password;
    if (m.type === 'watch' && hub.cfg.askPassword) {
      const refuse = (message, reason) => { ws.sendText({ type: 'error', message, reason }); ws.close(1008); };
      const blocked = wrongTries(ip) >= WRONG_MAX;
      if (!blocked && typeof m.password === 'string') password = m.password.slice(0, 64);
      const ok = hub.checkPassword(password);
      if (ok === 'missing' && blocked && m.password) { refuse('Too many wrong passwords. Try again in a few minutes.'); return; }
      if (ok === 'missing') { refuse('This server needs a password.', 'password'); return; }
      if (ok === 'wait') { refuse('Someone just tried a wrong password. Try again in a few seconds.'); return; }
    }
    if (m.type === 'watch') cleanup = watch(ws, ip, hub, password);
    else if (m.type === 'files') cleanup = files(ws, ip, hub, m.files);
    else ws.close(1003);
  };
}

function watch(ws, ip, hub, password) {
  const viewer = {
    send: (buf) => ws.sendBinary(buf),
    sendText: (obj) => ws.sendText(obj),
    close: (code) => ws.close(code),
    get buffered() { return ws.buffered; },
    password,
    wrongPassword: () => addWrong(ip),
  };
  let windowStart = Date.now(), windowCount = 0;
  ws.onmessage = (msg, binary) => {
    // game messages and pings alike: at most 200 a second, of at most 2 KB
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
    if (++windowCount > 200 || msg.length > 2048) return;
    if (!binary) {
      try {
        const c = JSON.parse(msg);
        if (c && c.type === 'ping' && typeof c.t === 'number') ws.sendText({ type: 'pong', t: c.t });
      } catch (_) {}
      return;
    }
    hub.fromViewer(viewer, msg);
  };
  hub.addViewer(viewer);
  log(`viewer ${ip} -> ${hub.cfg.id} (${hub.viewers.size} watching)`);
  return () => hub.removeViewer(viewer);
}

// map downloads from the watched server's file server (game port + 10)
const filesInFlight = new Map();

function files(ws, ip, hub, list) {
  const busy = filesInFlight.get(hub.cfg.id) || 0;
  if (busy >= 4) { ws.sendText({ type: 'error', message: 'busy, try again' }); ws.close(1013); return () => {}; }
  filesInFlight.set(hub.cfg.id, busy + 1);
  let stop = () => {};
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    filesInFlight.set(hub.cfg.id, (filesInFlight.get(hub.cfg.id) || 1) - 1);
    stop();
  };
  (async () => {
    try {
      let host = hub.cfg.host;
      if (net.isIP(host) === 0) host = (await dns.lookup(host, { family: 4 })).address;
      if (ws.closed) { release(); return; }
      stop = proxyFiles(ws, host, hub.cfg.port + 10, list);
      log(`file request ${ip} -> ${hub.cfg.id}`);
    } catch (e) {
      ws.sendText({ type: 'error', message: e.message });
      ws.close(1008);
      release();
    }
  })();
  return release;
}

// ---------------------------------------------------------------- server list

// addresses of the configured servers, to find them in the lobby's list
const addresses = new Map();
async function resolveAll() {
  for (const h of hubs.values()) {
    try {
      const ip = net.isIP(h.cfg.host) ? h.cfg.host : (await dns.lookup(h.cfg.host, { family: 4 })).address;
      addresses.set(`${ip}:${h.cfg.port}`, h.cfg.id);
    } catch (e) {
      log(`cannot resolve ${h.cfg.host}: ${e.message}`);
    }
  }
}
resolveAll();
setInterval(resolveAll, 10 * 60_000).unref();

// The watchable servers, busiest first: what the hub knows when it watches, else what
// the lobby reports (servers outside the lobby show only their name until watched).
// fresh: someone pressed Refresh (the lobby is still asked at most every 5 seconds).
async function listServers(fresh) {
  const l = await lobby(fresh ? 5_000 : 15_000);
  const fromLobby = new Map();
  for (const e of l.servers) {
    const id = addresses.get(`${e.IP}:${e.Port}`);
    if (id) fromLobby.set(id, e);
  }
  const list = await Promise.all([...hubs.values()].map(async (h) => {
    const info = h.info();
    const e = fromLobby.get(h.cfg.id);
    const bots = e ? e.NumBots || 0 : 0;
    // who plays: the hub's own roster while it watches (with teams), else the lobby's names
    const names = info.names ?? (e && e.NumPlayers > 0
      ? (await lobbyPlayers(e.IP, e.Port))?.map((name) => ({ name })) ?? null
      : null);
    return {
      ...info,
      group: h.cfg.group || null,
      locked: h.locked(),
      names,
      title: e ? e.Name : null,
      mode: e ? e.GameStyle : null,
      map: info.state === 'live' ? info.map : (e ? e.CurrentMap : info.map) || null,
      players: info.players ?? (e ? e.NumPlayers : null),
      maxPlayers: e ? e.MaxPlayers : null,
      bots,
      country: e ? e.Country : null,
      listed: !!e,
    };
  }));
  const humans = (s) => (s.players || 0) - (s.bots || 0);
  list.sort((a, b) => humans(b) - humans(a) || (b.players || 0) - (a.players || 0) ||
    b.viewers - a.viewers || a.name.localeCompare(b.name));
  return { servers: list, updated: l.time };
}

// ---------------------------------------------------------------- http

const server = http.createServer((req, res) => {
  const url = requestUrl(req);
  if (!url) { res.writeHead(400).end(); return; }
  if (url.pathname === '/api/watch') {
    listServers(url.searchParams.has('fresh')).then(({ servers, updated }) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // updated: when the lobby was asked (0: never), in the hub's clock like now
      res.end(JSON.stringify({ servers, updated, now: Date.now() }));
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  // one address for the page (search engines would list both)
  if (url.pathname === '/spectate.html') { res.writeHead(301, { Location: './' + url.search }).end(); return; }
  // a server's own address (/<id>): the page, tuned in to it
  const id = url.pathname.slice(1);
  if (hubs.has(id)) { serveStatic(ROOT, req, res, { file: '/spectate.html' }); return; }
  serveStatic(ROOT, req, res, { index: 'spectate.html', hidden: HIDDEN });
});

server.on('upgrade', (req, socket, head) => {
  const url = requestUrl(req);
  socket.on('error', () => {});
  if (url && url.pathname === '/watch') handleWatch(req, socket, head);
  else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.listen(PORT, () => {
  log(`Soldat Web spectator on http://localhost:${PORT}/ (serving ${ROOT})`);
  log(`servers: ${[...hubs.values()].map(h => `${h.cfg.id} (${h.cfg.host}:${h.cfg.port})`).join(', ') || 'none'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const h of hubs.values()) h.disconnect('shutting down');
    setTimeout(() => process.exit(0), 200);
  });
}
