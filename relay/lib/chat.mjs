// Soldat TV chat: one room for everyone on the site (room null) and one for the viewers of
// each server (room: its id), all on one connection. No accounts: every message carries the
// nickname its sender picked. Only the last 10 minutes are kept, in memory.
//
//   page -> hub   { type: 'listen', rooms }            the rooms whose lines it gets (the
//                                                      page's channel checkboxes)
//                 { type: 'say', room, name, text }
//                 { type: 'ping' }
//   hub -> page   { type: 'history', room, lines }     a room's last 10 minutes, on listening
//                 { type: 'line', room, name, text, t }
//                 { type: 'error', message }
//                 { type: 'pong' }

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 300;          // lines a room keeps, however busy
const MAX_TEXT = 200, MAX_NAME = 16;
const SAY_EVERY_MS = 1500, SAY_BURST = 5;  // per address: one line every 1.5 s, five at once
const MAX_BUFFERED = 256 * 1024;

// one line of text: no control or invisible characters (bidi overrides, zero widths), no
// piles of combining marks, single spaces
function clean(s, max) {
  if (typeof s !== 'string') return '';
  s = s.slice(0, max * 4)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, max).join('').trim();
}

// isRoom(id): whether a server room exists (the hub's servers)
export function makeChat({ isRoom, perIp = 2, max = 2000 }) {
  const rooms = new Map();   // room -> { lines, members }
  const byIp = new Map();    // address -> { conns, tokens, at }
  let count = 0;

  function room(id) {
    let r = rooms.get(id);
    if (!r) rooms.set(id, r = { lines: [], members: new Set() });
    return r;
  }

  function prune(r) {
    const old = Date.now() - KEEP_MS;
    let n = 0;
    while (n < r.lines.length && r.lines[n].t < old) n++;
    if (r.lines.length - n > KEEP_MAX) n = r.lines.length - KEEP_MAX;
    if (n) r.lines.splice(0, n);
  }

  setInterval(() => {
    for (const [id, r] of rooms) {
      prune(r);
      if (id !== null && !r.lines.length && !r.members.size) rooms.delete(id);
    }
    // an address is forgotten once it is gone and could say five lines again (reconnecting
    // does not refill it)
    for (const [ip, a] of byIp) if (!a.conns && refill(a) >= SAY_BURST) byIp.delete(ip);
  }, 60_000).unref();

  // a line every SAY_EVERY_MS, at most SAY_BURST saved up
  function refill(a) {
    const now = Date.now();
    a.tokens = Math.min(SAY_BURST, a.tokens + (now - a.at) / SAY_EVERY_MS);
    a.at = now;
    return a.tokens;
  }
  function maySay(ip) {
    const a = byIp.get(ip);
    if (refill(a) < 1) return false;
    a.tokens--;
    return true;
  }

  function send(ws, text) {
    if (ws.buffered < MAX_BUFFERED) ws.sendText(text);
  }

  return {
    accepts(ip) {
      return count < max && (byIp.get(ip)?.conns || 0) < perIp;
    },

    attach(ws, ip) {
      count++;
      const a = byIp.get(ip) || { conns: 0, tokens: SAY_BURST, at: Date.now() };
      a.conns++;
      byIp.set(ip, a);
      const listening = new Set();
      const enter = (id) => {
        const r = room(id);
        r.members.add(ws);
        prune(r);
        ws.sendText({ type: 'history', room: id, lines: r.lines.map(({ name, text, t }) => ({ name, text, t })) });
      };
      const leave = (id) => { rooms.get(id)?.members.delete(ws); };
      const valid = (id) => id === null || (typeof id === 'string' && isRoom(id));

      let windowStart = Date.now(), windowCount = 0;
      ws.onmessage = (msg, binary) => {
        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
        if (++windowCount > 20) { ws.close(1008); return; }
        if (binary || msg.length > 2048) return;
        let m;
        try { m = JSON.parse(msg); } catch (_) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.type === 'ping') {
          ws.sendText({ type: 'pong' });
        } else if (m.type === 'listen') {
          // the global room and a server's, a few at most
          const want = new Set(Array.isArray(m.rooms) ? m.rooms.slice(0, 4).filter(valid) : []);
          for (const id of listening) if (!want.has(id)) { leave(id); listening.delete(id); }
          for (const id of want) if (!listening.has(id)) { listening.add(id); enter(id); }
        } else if (m.type === 'say') {
          const id = m.room ?? null;
          if (!valid(id)) return;
          const name = clean(m.name, MAX_NAME), text = clean(m.text, MAX_TEXT);
          if (!name || !text) return;
          if (!maySay(ip)) { ws.sendText({ type: 'error', message: 'Slow down a little.' }); return; }
          const r = room(id);
          const line = { name, text, t: now };
          r.lines.push(line);
          prune(r);
          const out = JSON.stringify({ type: 'line', room: id, ...line });
          for (const member of r.members) send(member, out);
        }
      };
      ws.onclose = () => {
        count--;
        for (const id of listening) leave(id);
        a.conns--;
      };
    },
  };
}
