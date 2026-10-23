// Soldat Reloaded's wire (github.com/soldatreloaded/soldatreloaded, core/network), as the page
// and the relay both read it: the bits as its own Buffer reads and writes them (buffer.odin),
// the structs by the field tables its tags make (fields.odin), whole or as a delta against a
// base, the server's words, and its snapshots (stream.odin). The tables, the unions' variants
// and the enums are read off its own code into relay/lib/reloaded/wire-<version>.json
// (tools/reloaded/dump-wire.sh), the newest of which is reloaded-wire-data.js. Bytes are
// Uint8Arrays (a Buffer is one); the relay's messages are relay/lib/reloaded/wire.mjs.
import wireData from './reloaded-wire-data.js';

export const WIRE = wireData;
export const VERSION = WIRE.version;
export const { MTU, MAX_PLAYERS, MAX_THINGS, TICK_RATE, WIRE_PER_PACKET, STREAM_RING, STREAM_WHOLE_AFTER } = WIRE.constants;
export const SIZES = WIRE.sizes;
export const TABLES = WIRE.tables;

// an enum as names and their numbers, both ways: E.Team.Alpha === 1, E.Team[1] === 'Alpha'
export const E = {};
for (const [name, values] of Object.entries(WIRE.enums)) {
  const e = { max: values.length - 1 };
  values.forEach((v, i) => { e[v] = i; e[i] = v; });
  E[name] = e;
}
export const MSG = E.Msg_Kind;

// the bits a value up to max needs
export function bitsFor(max) {
  let bits = 1;
  while (bits < 32 && Math.floor(max / 2 ** bits) !== 0) bits++;
  return bits;
}

const f32 = new DataView(new ArrayBuffer(4));

// ---------------------------------------------------------------- the buffer

// A reader or a writer, the bits least significant first, each byte filled from its low
// end. Reading something it cannot trust (past the end, a float that is no number, a value
// past its range, a string too long) makes it bad, and the message is dropped whole.
export class Bits {
  constructor(data, reading) {
    this.data = data;
    this.bit = 0;
    this.reading = reading;
    this.bad = false;
  }

  static reader(data) { return new Bits(data, true); }
  static writer(size = MTU) { return new Bits(new Uint8Array(size), false); }

  get ok() { return !this.bad; }
  // a reader that read everything: within the last byte's padding
  get done() { return !this.bad && this.bit <= this.data.length * 8 && this.data.length * 8 - this.bit < 8; }
  bytes() { return this.data.subarray(0, (this.bit + 7) >> 3); }

  // up to 32 bits, a byte's worth at a time
  get(bits) {
    if (this.bit + bits > this.data.length * 8) { this.bad = true; this.bit = this.data.length * 8; return 0; }
    let v = 0, done = 0, bit = this.bit;
    while (done < bits) {
      const off = bit & 7, take = Math.min(8 - off, bits - done);
      v += ((this.data[bit >> 3] >> off) & ((1 << take) - 1)) * 2 ** done;
      done += take;
      bit += take;
    }
    this.bit = bit;
    return v;
  }

  put(v, bits) {
    if (bits < 32 && Math.floor(v / 2 ** bits) !== 0) this.bad = true;
    if (this.bit + bits > this.data.length * 8) { this.bad = true; return; }
    let done = 0, bit = this.bit;
    while (done < bits) {
      const off = bit & 7, take = Math.min(8 - off, bits - done);
      this.data[bit >> 3] |= (Math.floor(v / 2 ** done) & ((1 << take) - 1)) << off;
      done += take;
      bit += take;
    }
    this.bit = bit;
  }

  // each of these reads its value, or writes v and returns it
  bits(v, bits) {
    if (this.reading) return this.get(bits);
    this.put(v >>> 0, bits);
    return v;
  }

  signed(v, bits) {
    if (this.reading) {
      const raw = this.get(bits);
      return raw >= 2 ** (bits - 1) ? raw - 2 ** bits : raw;
    }
    if (v < -(2 ** (bits - 1)) || v >= 2 ** (bits - 1)) this.bad = true;
    this.put(v < 0 ? v + 2 ** bits : v, bits);
    return v;
  }

  bool(v) { return this.bits(v ? 1 : 0, 1) === 1; }
  u8(v) { return this.bits(v, 8); }
  u16(v) { return this.bits(v, 16); }
  u32(v) { return this.bits(v, 32); }

  u64(v) {
    if (this.reading) {
      const lo = this.get(32), hi = this.get(32);
      return (BigInt(hi) << 32n) | BigInt(lo);
    }
    this.put(Number(v & 0xFFFFFFFFn), 32);
    this.put(Number(v >> 32n), 32);
    return v;
  }

  // 0 to max, in as few bits as max needs
  range(v, max) {
    if (!this.reading && v > max) this.bad = true;
    v = this.bits(v, bitsFor(max));
    if (this.reading && v > max) this.bad = true;
    return v;
  }

  enum(v, e) { return this.range(v, e.max); }

  kind(v) {
    v = this.enum(v, MSG);
    if (this.reading && v === MSG.Invalid) this.bad = true;
    return v;
  }

  f32(v) {
    if (this.reading) {
      f32.setUint32(0, this.get(32), true);
      const x = f32.getFloat32(0, true);
      if (!Number.isFinite(x)) this.bad = true;
      return x;
    }
    f32.setFloat32(0, v, true);
    this.put(f32.getUint32(0, true), 32);
    return v;
  }

  vec2(v) { return [this.f32(v ? v[0] : 0), this.f32(v ? v[1] : 0)]; }
  rgba(v) { return [0, 1, 2, 3].map((i) => this.u8(v ? v[i] : 0)); }
  hash(v) { return Uint8Array.from({ length: SIZES.MAP_HASH_SIZE }, (_, i) => this.u8(v ? v[i] : 0)); }

  // up to n characters, the length first
  // (latin1: a character a byte, its code's low byte as written)
  string(v, n) {
    const s = this.reading ? null : String(v ?? '').slice(0, n);
    const len = this.bits(s ? s.length : 0, 8);
    if (len > n) { this.bad = true; return ''; }
    if (!this.reading) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xFF); return v; }
    let out = '';
    for (let i = 0; i < len; i++) out += String.fromCharCode(this.get(8));
    return out;
  }
}

// ---------------------------------------------------------------- the field tables

const ANIMATION_MAX = E.Animation_Id.max;

// one field's value, read or written; the values: numbers, booleans, [x, y] for a vec2,
// [r, g, b, a] for a colour, { id, frame } for an animation, null or a number for a Maybe,
// a BigInt for 64 bits
function field(b, f, v) {
  switch (f.kind) {
    case 'unsigned':
      if (f.bits > 32) return b.u64(v ?? 0n);
      v = b.bits(v ?? 0, f.bits);
      if (f.max && v > f.max) b.bad = true;
      return v;
    case 'signed': return b.signed(v ?? 0, f.bits);
    case 'bool': return b.bool(v);
    case 'f32': return b.f32(v ?? 0);
    case 'vec2': return b.vec2(v);
    case 'rgba': return b.rgba(v);
    case 'maybe': {
      const x = b.range(v == null ? 0 : v + 1, f.max);
      return x === 0 ? null : x - 1;
    }
    case 'animation': {
      const id = b.range(v ? v.id : 0, ANIMATION_MAX);
      const frame = b.signed(v ? v.frame : 0, 8);
      return { id, frame };
    }
  }
  throw new Error('a field of kind ' + f.kind);
}

const same = (a, b) => {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  if (a && typeof a === 'object') return !!b && a.id === b.id && a.frame === b.frame;
  return a === b;
};

// The struct `o` (an object by the fields' names) by `table`: every field, or with a
// `base`, a bit per field and the fields that differ from it; reading with a base takes
// the unchanged ones from it.
export function fields(b, table, o, base = null) {
  for (const f of table) {
    if (base) {
      const changed = b.bool(!b.reading && !same(o[f.name], base[f.name]));
      if (!changed) {
        if (b.reading) o[f.name] = base[f.name];
        continue;
      }
    }
    o[f.name] = field(b, f, o[f.name]);
  }
  return o;
}

// ---------------------------------------------------------------- the words

// A union by its variant's number (from 1), then the variant's fields, a variant that is
// a union itself the same way inside: { type: 'Shot', ...fields } or { type: 'Ruling',
// ruling: { type: 'Kill', ... } }.
function union(b, variants, v) {
  const tag = b.range(v ? variants.findIndex((x) => x.name === v.type) + 1 : 0, variants.length);
  if (tag === 0) { b.bad = true; return null; }
  const variant = variants[tag - 1];
  if (variant.variants) {
    const inner = union(b, variant.variants, v && v.inner);
    return { type: variant.name, inner };
  }
  const o = fields(b, variant.fields, b.reading ? {} : { ...v });
  o.type = variant.name;
  return o;
}

// the words a packet carries: their count, then each with its seq and tick
export function words(b, list = []) {
  const count = b.range(list.length, WIRE_PER_PACKET);
  const out = [];
  for (let i = 0; i < count && b.ok; i++) {
    const w = list[i];
    const seq = b.u32(w && w.seq);
    const tick = b.u32(w && w.tick);
    const word = union(b, WIRE.words, w && w.word);
    if (b.ok) out.push({ seq, tick, word });
  }
  return out;
}


// ---------------------------------------------------------------- the two streams

// The snapshot's header: what its body is a delta against.
export function snapshotHeader(b, h = {}) {
  h.round = b.u16(h.round);
  h.tick = b.u32(h.tick);
  h.base = b.u32(h.base);
  h.clientAck = b.u32(h.clientAck);
  h.clientEventAck = b.u32(h.clientEventAck);
  return h;
}

// The snapshot's body against `base` (a frame as snapshotBody left it, or null for whole):
// { round, word[], soldiers[], names[], thingWord[], things[] }. A soldier or thing the base
// carried starts from it; one that goes whole brings its name.
export function snapshotBody(b, base) {
  const f = { round: null, word: [], soldiers: [], names: [], thingWord: [], things: [] };
  f.round = fields(b, TABLES.round, {}, base ? base.round : null);
  const State = E.Snap_Word.State;
  for (let i = 0; i < MAX_PLAYERS && b.ok; i++) {
    const word = f.word[i] = b.enum(0, E.Snap_Word);
    if (word !== State) continue;
    const against = base && base.word[i] === State ? base.soldiers[i] : null;
    const s = {};
    fields(b, TABLES.soldier_served, s, against);
    fields(b, TABLES.soldier_owned, s, against);
    f.soldiers[i] = s;
    if (!against) f.names[i] = b.string('', SIZES.Name);
  }
  for (let i = 0; i < MAX_THINGS && b.ok; i++) {
    const word = f.thingWord[i] = b.enum(0, E.Snap_Word);
    if (word !== State) continue;
    const against = base && base.thingWord[i] === State ? base.things[i] : null;
    f.things[i] = fields(b, TABLES.thing, {}, against);
  }
  return f;
}

// a soldier with every field at its zero, for the fields a state carries
export function blankSoldier() {
  const s = {};
  for (const t of [TABLES.soldier_served, TABLES.soldier_owned]) {
    for (const f of t) {
      s[f.name] = f.kind === 'vec2' ? [0, 0] : f.kind === 'rgba' ? [0, 0, 0, 0] : f.kind === 'bool' ? false
        : f.kind === 'maybe' ? null : f.kind === 'animation' ? { id: 0, frame: 1 }
        : f.kind === 'unsigned' && f.bits > 32 ? 0n : 0;
    }
  }
  return s;
}
