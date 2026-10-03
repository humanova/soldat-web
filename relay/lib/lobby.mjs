// The Soldat lobby (api.soldat.pl): its server list, fetched at most every 15 seconds (or as
// often as the caller's maxAge asks, for a refresh someone asked for), and the names of the
// players on a server.
import https from 'node:https';

function fetchText(url, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'soldat-web-relay' } }, (res) => {
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

// Returns a function lobby(maxAge = 15 s) that resolves to { time, servers } (servers: the
// lobby's entries; the last good list, or none, when the lobby is unreachable).
export function makeLobby(url, log) {
  let cache = { time: 0, servers: [] };
  let pending = null;
  return async function lobby(maxAge = 15_000) {
    if (Date.now() - cache.time < Math.max(maxAge, 5_000) && cache.time) return cache;
    if (!pending) {
      pending = fetchText(url).then((text) => {
        const data = JSON.parse(text);
        cache = { time: Date.now(), servers: data.Servers || [] };
        return cache;
      }).finally(() => { pending = null; });
    }
    try {
      return await pending;
    } catch (e) {
      log('lobby fetch failed:', e.message);
      return cache;
    }
  };
}

// Returns a function players(ip, port) that resolves to the names of the players on that
// server (bots included), asked at most every 15 seconds per server; the last good answer,
// or null, when the lobby is unreachable. listUrl: the server list's URL (.../v0/servers).
export function makeLobbyPlayers(listUrl, log) {
  const base = /\/servers\/?$/.test(listUrl) ? listUrl.replace(/\/servers\/?$/, '') : null;
  const cache = new Map();  // "ip:port" -> { time, names, pending }
  return async function players(ip, port) {
    if (!base) return null;
    const key = `${ip}:${port}`;
    let c = cache.get(key);
    if (!c) cache.set(key, c = { time: 0, names: null, pending: null });
    if (Date.now() - c.time < 15_000) return c.names;
    if (!c.pending) {
      c.pending = fetchText(`${base}/server/${ip}/${port}/players`, 4_000).then((text) => {
        const names = JSON.parse(text).Players;
        c.names = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 32) : null;
        c.time = Date.now();
      }).catch((e) => {
        c.time = Date.now();  // don't ask again right away
        log(`lobby players of ${key} failed:`, e.message);
      }).finally(() => { c.pending = null; });
    }
    await c.pending;
    return c.names;
  };
}
