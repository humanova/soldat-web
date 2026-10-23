// A player's game in the browser (reloaded/'s web build) on a Soldat Reloaded server, through
// the play relay (relay/play.mjs): the page's line is a WebSocket, the server's is ENet over
// UDP, and this joins them, a peer of its own to the server for each player. The messages go
// through as they are, one a WebSocket frame either way, each on the channel its kind calls
// for (the game's RELIABLE: all but the client's state and the snapshots). A signed-in
// player's Hello carries their account's hardware id, whatever the page put in it, so a
// server can ban the account and not the relay's address that all its players share.
//
//   const close = startReloadedPlay(ws, { ip, port, hwid, log, label })
//
// The page greets with { type: 'reloaded', host, port } (web/js/net.js's greeting); once the
// server has taken the peer it hears { type: 'ready' }, and its game is connected.
import dgram from 'node:dgram';
import { EnetPeer } from './enet.mjs';
import { MSG, Bits, parse, build } from './wire.mjs';

const CHANNEL_UNRELIABLE = 0, CHANNEL_RELIABLE = 1;
const UNRELIABLE = new Set(['Client_State', 'Snapshot']);
const FLUSH_MS = 10;                 // acknowledgements and resends go out this often
const IDLE_MS = 60_000;              // nothing from the page this long: the game is gone
const MAX_MESSAGE = 1200;            // the wire's MTU
// what a player may send in a second: a game sends 60 states and a few more
const MAX_PER_SECOND = 150, MAX_BYTES_PER_SECOND = 48 * 1024;

// A message of the page's game as it goes to the server: { data, channel, reliable }, or
// null for one that isn't a message; a Hello with `hwid` (a signed-in player's) put in it.
export function outgoing(msg, hwid = null) {
  const b = Bits.reader(msg);
  const kind = MSG[b.kind()];
  if (!b.ok || !kind) return null;
  let data = msg;
  if (kind === 'Hello' && hwid) {
    const p = parse(msg);
    if (!p) return null;
    data = build('Hello', { ...p.body, hwid });
    if (!data) return null;
  }
  const reliable = !UNRELIABLE.has(kind);
  return { data, channel: reliable ? CHANNEL_RELIABLE : CHANNEL_UNRELIABLE, reliable };
}

export function startReloadedPlay(ws, { ip, port, hwid = null, log = () => {}, label = '' }) {
  const sock = dgram.createSocket('udp4');
  let closed = false, last = Date.now();
  let windowAt = Date.now(), count = 0, bytes = 0;
  const peer = new EnetPeer((buf) => { try { sock.send(buf); } catch (_) {} });

  const close = (why) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (peer.state !== 'gone') peer.disconnect();
    peer.flush();
    // the goodbye goes out before the socket closes
    setTimeout(() => { try { sock.close(); } catch (_) {} }, 50);
    if (why) log(`reloaded play ${label}: ${why}`);
    ws.close(1000);
  };

  peer.onConnect = () => ws.sendText({ type: 'ready' });
  peer.onMessage = (channel, data) => {
    if (ws.buffered > 1 << 20) return;   // too slow a page: dropped, as UDP would
    ws.sendBinary(data);
  };
  peer.onDisconnect = (why) => {
    if (closed) return;
    ws.sendText({ type: 'error', message: 'The server closed the connection.' });
    close('server closed: ' + why);
  };
  sock.on('message', (data, rinfo) => {
    if (rinfo.address !== ip || rinfo.port !== port) return;
    peer.receive(data);
    peer.flush();
  });
  sock.on('error', (e) => close('udp: ' + e.message));
  sock.connect(port, ip, () => {
    if (closed) return;
    peer.connect();
    peer.flush();
  });
  const timer = setInterval(() => {
    peer.flush();
    if (Date.now() - last > IDLE_MS) close('idle');
  }, FLUSH_MS);

  ws.onmessage = (msg, binary) => {
    if (!binary || closed) return;
    if (msg.length === 0 || msg.length > MAX_MESSAGE) return;
    const now = Date.now();
    if (now - windowAt > 1000) { windowAt = now; count = 0; bytes = 0; }
    if (++count > MAX_PER_SECOND || (bytes += msg.length) > MAX_BYTES_PER_SECOND) return;
    last = now;
    const out = outgoing(msg, hwid);
    if (!out) return;
    peer.send(out.channel, out.data, out.reliable);
    peer.flush();
  };

  return () => close(null);
}
