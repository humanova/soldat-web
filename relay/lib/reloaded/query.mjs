// A Soldat Reloaded server asked what it plays (core/network/query.odin): one UDP datagram
// each way on its game port, outside ENet, as its lobby and server browsers ask.
//
//   request  FF FF FF FF 'BSQi' nonce:u32, zeros to 128 bytes
//   reply    FF FF FF FF 'BSRi' nonce:u32 protocol:u16 players bots max_players mode flags
//            hostname:(len, bytes) map:(len, bytes)
import crypto from 'node:crypto';
import dgram from 'node:dgram';

const REQUEST_SIZE = 128;
const FLAG_PASSWORD = 1;
const MODES = { 1: 'CTF' };

// { protocol, players (people), bots, maxPlayers, mode, password, hostname, map }, or null
// when it does not answer in time
export function queryServer(ip, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const nonce = crypto.randomInt(0, 2 ** 32);
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (m, r) => {
      if (r.address !== ip || r.port !== port || m.length < 19) return;
      if (m.readUInt32LE(0) !== 0xFFFFFFFF || m.toString('latin1', 4, 8) !== 'BSRi' || m.readUInt32LE(8) !== nonce) return;
      let o = 19;
      const str = () => {
        if (o >= m.length) return '';
        const n = m[o];
        const s = m.toString('utf8', o + 1, Math.min(m.length, o + 1 + n));
        o += 1 + n;
        return s;
      };
      const hostname = str(), map = str();
      finish({
        protocol: m.readUInt16LE(12), players: m[14], bots: m[15], maxPlayers: m[16],
        mode: MODES[m[17]] || null, password: !!(m[18] & FLAG_PASSWORD), hostname, map,
      });
    });
    const b = Buffer.alloc(REQUEST_SIZE);
    b.fill(0xFF, 0, 4);
    b.write('BSQi', 4, 'latin1');
    b.writeUInt32LE(nonce, 8);
    sock.send(b, port, ip, (e) => { if (e) finish(null); });
  });
}
