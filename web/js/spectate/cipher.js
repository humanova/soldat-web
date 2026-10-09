// Soldat 1.7.1's session cipher (docs/PROTOCOL-1.7.1.md) for the page: DCPcrypt's
// TDCP_blowfish with InitStr(Key, TDCP_ripemd160), CBC with DCPcrypt's partial blocks
// (CV := E(CV); data xor CV). The key is #$A7 + IntToStr(SessionID + $25B3B1), the same in
// Soldat 1.6.8 to 1.7.1. relay/lib/soldat171.mjs has it for Node.

// ---------------------------------------------------------------- RIPEMD-160

const RL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
const RR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
const KL = [0, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
const KR = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0];

const rol = (x, n) => (x << n) | (x >>> (32 - n));

function fr(j, x, y, z) {
  if (j < 16) return x ^ y ^ z;
  if (j < 32) return (x & y) | (~x & z);
  if (j < 48) return (x | ~y) ^ z;
  if (j < 64) return (x & z) | (y & ~z);
  return x ^ (y | ~z);
}

export function ripemd160(data) {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = new DataView(padded.buffer);
  bits.setUint32(padded.length - 8, len * 8, true);
  bits.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  const h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  const X = new Array(16);
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) X[i] = bits.getUint32(o + i * 4, true);
    let [al, bl, cl, dl, el] = h;
    let [ar, br, cr, dr, er] = h;
    for (let j = 0; j < 80; j++) {
      const r = j >> 4;
      let t = (rol((al + fr(j, bl, cl, dl) + X[RL[j]] + KL[r]) | 0, SL[j]) + el) | 0;
      al = el; el = dl; dl = rol(cl, 10); cl = bl; bl = t;
      t = (rol((ar + fr(79 - j, br, cr, dr) + X[RR[j]] + KR[r]) | 0, SR[j]) + er) | 0;
      ar = er; er = dr; dr = rol(cr, 10); cr = br; br = t;
    }
    const t = (h[1] + cl + dr) | 0;
    h[1] = (h[2] + dl + er) | 0;
    h[2] = (h[3] + el + ar) | 0;
    h[3] = (h[4] + al + br) | 0;
    h[4] = (h[0] + bl + cr) | 0;
    h[0] = t;
  }
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  h.forEach((w, i) => dv.setUint32(i * 4, w, true));
  return out;
}

// ---------------------------------------------------------------- Blowfish

// Blowfish's initial P-array and S-boxes are the hexadecimal digits of pi after the point
let PI_WORDS = null;
function piWords() {
  if (PI_WORDS) return PI_WORDS;
  const words = 18 + 4 * 256;
  const guard = 64n;
  const one = 1n << (BigInt(words * 32) + guard);
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
    lr[0] = (r ^ this.P[17]) >>> 0;
    lr[1] = (l ^ this.P[16]) >>> 0;
  }

  dec(lr) {
    let [l, r] = lr;
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.P[i]) >>> 0;
      r = (r ^ this.f(l)) >>> 0;
      [l, r] = [r, l];
    }
    lr[0] = (r ^ this.P[0]) >>> 0;
    lr[1] = (l ^ this.P[1]) >>> 0;
  }

  // in place on 8 bytes, big endian words like DCPcrypt
  block(b, o, decrypt) {
    const dv = new DataView(b.buffer, b.byteOffset + o, 8);
    const lr = [dv.getUint32(0), dv.getUint32(4)];
    if (decrypt) this.dec(lr); else this.enc(lr);
    dv.setUint32(0, lr[0]);
    dv.setUint32(4, lr[1]);
  }
}

// ---------------------------------------------------------------- the session cipher

// the key of a session: a prefix and the session id plus a number, 1.6.0 on's by default
// (older versions had others: legacy-formats.js)
export const sessionKey = (sessionId, prefix = '\xA7', add = 0x25B3B1) =>
  Uint8Array.from(prefix + String(sessionId + add), (c) => c.charCodeAt(0));

export class SessionCipher {
  constructor(sessionId, prefix, add) {
    this.bf = new Blowfish(ripemd160(sessionKey(sessionId, prefix, add)));
    this.iv = new Uint8Array(8);
    this.bf.block(this.iv, 0, false);
    this.cv = this.iv.slice();
  }

  reset() { this.cv.set(this.iv); }

  run(buf, off, size, decrypt) {
    const n = size >> 3;
    for (let i = 0; i < n; i++, off += 8) {
      if (decrypt) {
        const c = buf.slice(off, off + 8);
        this.bf.block(buf, off, true);
        for (let j = 0; j < 8; j++) buf[off + j] ^= this.cv[j];
        this.cv.set(c);
      } else {
        for (let j = 0; j < 8; j++) buf[off + j] ^= this.cv[j];
        this.bf.block(buf, off, false);
        this.cv.set(buf.subarray(off, off + 8));
      }
    }
    const rem = size & 7;
    if (rem) {
      this.bf.block(this.cv, 0, false);
      for (let j = 0; j < rem; j++) buf[off + j] ^= this.cv[j];
    }
  }

  // encrypts (or decrypts) the [offset, size] fields of a message in place, in order, between
  // resets: as each side of the game does with a message
  fields(buf, list, decrypt = false) {
    this.reset();
    for (const [o, n] of list) this.run(buf, o, n, decrypt);
    this.reset();
  }
}
