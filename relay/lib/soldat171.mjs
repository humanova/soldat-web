// Soldat 1.7.1 protocol pieces the relays need (docs/PROTOCOL-1.7.1.md): message check
// values, the session cipher, message sizes, datagram splitting and hardware ids.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MSG = {
  HeartBeat: 2, ServerSpriteSnapshot: 3, BulletSnapshot: 5, ChatMessage: 6, SkeletonSnapshot: 7,
  MapChange: 8, ThingSnapshot: 9, ThingTaken: 12, SpriteDeath: 13, RequestGame: 14, PlayerInfo: 15,
  PlayersList: 16, NewPlayer: 17, ServerDisconnect: 18, PlayerDisconnect: 19, DeltaMovement: 21,
  DeltaWeapons: 25, DeltaHelmet: 26, DeltaMouseAim: 29, Ping: 30, Pong: 31, FlagInfo: 32,
  ThingMustSnapshot: 33, HeartBeat16: 35, HeartBeat8: 36, IdleAnimation: 37, StatusRequest: 40,
  ServerSpriteSnapshotMajor: 41, ClientSpriteSnapshotDead: 43, UnAccepted: 44, VoteOn: 45,
  RequestMap: 49, ServerVars: 52, ServerSyncMsg: 54, ClientFreeCam: 55, VoteOff: 56,
  SpecialMessage: 64, WeaponActive: 65, UnicodeChat: 66, Gravity: 69, PlaySound: 70,
};

// fixed sizes of server messages (Net.pas MessageSize); others fill the rest of the datagram
const SIZES = new Map([
  [2, 303], [3, 41], [5, 24], [7, 6], [8, 22], [9, 71], [12, 7], [13, 280], [16, 2150], [17, 61],
  [18, 3], [19, 5], [21, 27], [25, 7], [26, 5], [29, 6], [30, 5], [32, 5], [33, 73], [35, 159],
  [36, 87], [37, 6], [40, 3], [41, 32], [45, 49], [52, 986], [54, 8], [56, 3], [60, 12], [61, 12],
  [62, 7], [65, 5], [69, 7], [70, 38], [127, 3],
]);

export const TEAM_SPECTATOR = 5;
export const MAX_PLAYERS = 32;
export const PLAYERS_LIST_SIZE = 2150;
export const PLAYERS_LIST_SESSION_ID = 2134;  // its UInt16 session id, the cipher's key
// PlayerInfo's [offset, size] fields in the order they are encrypted
export const PLAYER_INFO_FIELDS = [[33, 4], [37, 4], [41, 4], [45, 4], [49, 4], [32, 1], [31, 1], [27, 4], [53, 12]];

// ---------------------------------------------------------------- check value

export function packetHash(b, size = b.length) {
  let h = (b[0] + 0xB5A5) & 0xFFFF;
  for (let i = 3; i < size; i++) h = (h * 33 + b[i]) & 0xFFFF;
  return h;
}

export function setHash(b) {
  const h = packetHash(b);
  b[1] = h & 0xFF;
  b[2] = h >> 8;
  return b;
}

export function hashOk(b) {
  return b.length >= 3 && packetHash(b) === (b[1] | (b[2] << 8));
}

// Splits a datagram (zlib compressed when it starts with $FF) into its messages.
export function splitDatagram(dgram) {
  let data = dgram;
  if (data.length && data[0] === 0xFF) {
    try { data = zlib.inflateSync(data.subarray(1)); } catch (_) { return []; }
  }
  const out = [];
  let p = 0;
  while (p < data.length) {
    let len = SIZES.get(data[p]) || 0;
    if (len <= 0 || len > data.length - p) len = data.length - p;
    const m = data.subarray(p, p + len);
    if (len >= 3 && hashOk(m)) out.push(m);
    p += len;
  }
  return out;
}

// ---------------------------------------------------------------- Blowfish

// Blowfish's initial P-array and S-boxes are the hexadecimal digits of pi after the point.
let PI_WORDS = null;
function piWords() {
  if (PI_WORDS) return PI_WORDS;
  const words = 18 + 4 * 256;
  const guard = 64n;
  const bits = BigInt(words * 32) + guard;
  const one = 1n << bits;
  const atanInv = (x) => {  // atan(1/x) in fixed point
    const x2 = x * x;
    let term = one / x, sum = term, k = 1n, sign = -1n;
    while (term !== 0n) {
      term /= x2;
      k += 2n;
      sum += sign * (term / k);
      sign = -sign;
    }
    return sum;
  };
  const pi = 16n * atanInv(5n) - 4n * atanInv(239n);  // Machin
  const frac = (pi - 3n * one) >> guard;
  PI_WORDS = new Uint32Array(words);
  for (let i = 0; i < words; i++) PI_WORDS[i] = Number((frac >> BigInt((words - 1 - i) * 32)) & 0xFFFFFFFFn);
  return PI_WORDS;
}

class Blowfish {
  constructor(key) {
    const init = piWords();
    this.P = init.slice(0, 18);
    this.S = [0, 1, 2, 3].map(i => init.slice(18 + i * 256, 18 + (i + 1) * 256));
    for (let i = 0, k = 0; i < 18; i++) {
      let w = 0;
      for (let j = 0; j < 4; j++, k++) w = ((w << 8) | key[k % key.length]) >>> 0;
      this.P[i] = (this.P[i] ^ w) >>> 0;
    }
    const lr = [0, 0];
    for (let i = 0; i < 18; i += 2) { this.enc(lr); this.P[i] = lr[0]; this.P[i + 1] = lr[1]; }
    for (const s of this.S) {
      for (let i = 0; i < 256; i += 2) { this.enc(lr); s[i] = lr[0]; s[i + 1] = lr[1]; }
    }
  }

  f(x) {
    const S = this.S;
    return ((((S[0][x >>> 24] + S[1][(x >>> 16) & 0xFF]) >>> 0) ^ S[2][(x >>> 8) & 0xFF]) + S[3][x & 0xFF]) >>> 0;
  }

  enc(lr) {
    let [l, r] = lr;
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.P[i]) >>> 0;
      r = (r ^ this.f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    lr[0] = (l ^ this.P[17]) >>> 0;
    lr[1] = (r ^ this.P[16]) >>> 0;
  }

  dec(lr) {
    let [l, r] = lr;
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.P[i]) >>> 0;
      r = (r ^ this.f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    lr[0] = (l ^ this.P[0]) >>> 0;
    lr[1] = (r ^ this.P[1]) >>> 0;
  }

  // in place on 8 bytes, big endian words like DCPcrypt
  block(b, o, decrypt) {
    const lr = [b.readUInt32BE(o), b.readUInt32BE(o + 4)];
    if (decrypt) this.dec(lr); else this.enc(lr);
    b.writeUInt32BE(lr[0], o);
    b.writeUInt32BE(lr[1], o + 4);
  }
}

// DCPcrypt TDCP_blowfish with InitStr(Key, TDCP_ripemd160), CBC with DCPcrypt's partial
// blocks (CV := E(CV); data xor CV). Callers reset before and after each message.
export class SessionCipher {
  constructor(sessionId) {
    const key = Buffer.from('\xA7' + String(sessionId + 0x25B3B1), 'latin1');
    this.bf = new Blowfish(crypto.createHash('ripemd160').update(key).digest());
    this.iv = Buffer.alloc(8);
    this.bf.block(this.iv, 0, false);
    this.cv = Buffer.from(this.iv);
  }

  reset() { this.iv.copy(this.cv); }

  // encrypts/decrypts buf[off, off+size) in place
  encrypt(buf, off, size) { this.run(buf, off, size, false); }
  decrypt(buf, off, size) { this.run(buf, off, size, true); }

  run(buf, off, size, decrypt) {
    const n = size >> 3;
    for (let i = 0; i < n; i++, off += 8) {
      if (decrypt) {
        const c = Buffer.from(buf.subarray(off, off + 8));
        this.bf.block(buf, off, true);
        for (let j = 0; j < 8; j++) buf[off + j] ^= this.cv[j];
        c.copy(this.cv);
      } else {
        for (let j = 0; j < 8; j++) buf[off + j] ^= this.cv[j];
        this.bf.block(buf, off, false);
        buf.copy(this.cv, 0, off, off + 8);
      }
    }
    const rem = size & 7;
    if (rem) {
      this.bf.block(this.cv, 0, false);
      for (let j = 0; j < rem; j++) buf[off + j] ^= this.cv[j];
    }
  }

  // encrypts the given [offset, size] fields of a message in order, between resets
  fields(buf, list, decrypt = false) {
    this.reset();
    for (const [o, n] of list) this.run(buf, o, n, decrypt);
    this.reset();
  }
}

// ---------------------------------------------------------------- strings

export function fixedString(buf, off, len) {
  const s = buf.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? len : z).toString('latin1');
}

export function writeFixed(buf, off, len, text) {
  buf.fill(0, off, off + len);
  buf.write(text.slice(0, len), off, 'latin1');
}

// Hardware id the server accepts: 10 hex digits plus a check digit.
export function makeHwid(seed) {
  const HEX = '0123456789ABCDEF';
  const digest = crypto.createHash('sha256').update(String(seed)).digest('hex').toUpperCase().slice(0, 10);
  let h = 5381;
  for (const c of digest) h = (Math.imul(h, 33) + HEX.indexOf(c)) >>> 0;
  return digest + HEX[h & 0xF];
}

// Puts a hardware id into a player's RequestGame (plain) or PlayerInfo (encrypted with the
// session's cipher) and renews the check value. False when the message is too short.
export function setRequestGameHwid(b, hwid) {
  if (b.length < 46) return false;
  b[33] = 11;
  b.write(hwid, 34, 'latin1');
  setHash(b);
  return true;
}

export function setPlayerInfoHwid(b, hwid, cipher) {
  if (b.length < 65) return false;
  cipher.fields(b, PLAYER_INFO_FIELDS, true);
  b[53] = 11;
  b.write(hwid, 54, 'latin1');
  cipher.fields(b, PLAYER_INFO_FIELDS);
  setHash(b);
  return true;
}
