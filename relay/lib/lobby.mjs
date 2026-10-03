// The Soldat lobby's server list (api.soldat.pl), fetched at most every 15 seconds.
import https from 'node:https';

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

// Returns a function that resolves to { time, servers } (servers: the lobby's entries;
// the last good list, or none, when the lobby is unreachable).
export function makeLobby(url, log) {
  let cache = { time: 0, servers: [] };
  let pending = null;
  return async function lobby() {
    if (Date.now() - cache.time < 15_000 && cache.time) return cache;
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
