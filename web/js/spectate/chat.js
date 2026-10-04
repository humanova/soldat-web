// Soldat TV chat (relay/lib/chat.mjs), on one connection: everyone on the site (room null)
// and the viewers of a server (room: its id). The page says which rooms it listens to; the
// hub sends their last 10 minutes, then their new lines. A nickname, no account.

export const MAX_TEXT = 200, MAX_NAME = 16;

export class TvChat {
  // url(): the hub's chat address; onChange(room, line): a line came in (line null: the
  // room's lines were replaced, or the connection came or went)
  constructor(url, onChange) {
    this.url = url;
    this.onChange = onChange;
    this.rooms = [];
    this.lines = new Map();  // room -> its lines, of the rooms listened to
    this.online = false;
    this.retry = 1000;
    this.connect();
    // idle connections are cut by proxies (Cloudflare: after 100 s)
    setInterval(() => this.send({ type: 'ping' }), 45_000);
  }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url()); } catch (_) { this.reconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.online = true;
      this.retry = 1000;
      this.send({ type: 'listen', rooms: this.rooms });
      this.onChange(null, null);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === 'history') {
        if (!this.rooms.includes(m.room)) return;
        this.lines.set(m.room, m.lines.map(l => ({ ...l, room: m.room })));
        this.onChange(m.room, null);
      } else if (m.type === 'line') {
        const list = this.lines.get(m.room);
        if (!list) return;
        list.push(m);
        if (list.length > 300) list.shift();
        this.onChange(m.room, m);
      } else if (m.type === 'error') {
        this.onChange(undefined, { error: m.message });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.online;
      this.online = false;
      if (was) this.onChange(null, null);
      this.reconnect();
    };
  }

  reconnect() {
    setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  send(m) {
    if (this.ws && this.online) this.ws.send(JSON.stringify(m));
  }

  // the rooms to get lines from (null: the global one)
  listen(rooms) {
    if (rooms.length === this.rooms.length && rooms.every(r => this.rooms.includes(r))) return;
    this.rooms = rooms;
    for (const r of this.lines.keys()) if (!rooms.includes(r)) this.lines.delete(r);
    this.send({ type: 'listen', rooms });
  }

  // the lines of these rooms, oldest first
  merged(rooms) {
    return rooms.flatMap(r => this.lines.get(r) || []).sort((a, b) => a.t - b.t);
  }

  say(room, name, text) {
    this.send({ type: 'say', room, name, text });
  }
}
