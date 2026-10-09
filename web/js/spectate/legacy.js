// Demos of older Soldat versions, brought to the layout of Soldat 1.7.1 that the page plays
// (replay.js) and that Soldat 1.7.1 opens. docs/DEMOS.md has the formats: they were reverse
// engineered from the dedicated servers of each version and checked against the demos their
// games came with. A demo is the server's messages as its client got them, so the server's
// message layouts are the demo's.
//
// The demos the game recorded have no header up to 1.7.1: their records start at once (up to
// 1.6.3) or after three bytes (1.6.4 on). The 180-byte 'SOLDEM' header is Soldat TV's (and
// the 1.8 source's). A converted demo gets one. legacy-formats.js has every version's
// messages; this file reads a demo, tells its version and writes it again in 1.7.1's layout.
//
// Runs in the browser and in Node (tools/migrate-demo.mjs). Also tidies demos of 1.7.1:
// records of several messages are split (the replay reads one message a record),
// compressed ones inflated, and a player list with its fields in clear encrypted.

import { SessionCipher } from './cipher.js';
import {
  FORMATS, FORMAT, L171, VARIABLE, ORDER, OLD_WEAPON_NUM, STYLE_WEAPON, WEAPON_STYLE, DEFAULT_SPREAD, DEFAULT_PUSH,
  DEFAULT_INHERITED, MODIFIER, MOVEMENT_ACC_SCALE, DEFAULT_GRAVITY,
} from './legacy-formats.js';

export { FORMATS };

const HEADER_SIZE = 180;
const MAP_NAME = 8, START_DATE = 172, TICKS_NUM = 176;
const COMPRESSED = 0xFF;
const ID = { HeartBeat: 2, Snapshot: 3, Bullet: 5, PlayersList: 16, NewPlayer: 17, Weapons: 25, HeartBeat16: 35, HeartBeat8: 36,
  ServerVars: 52, ForceWeapon: 62, Special: 64 };
const GAMESTYLE_HTF = 6;

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// the check value of the message at b[at, at + len)
export function setHash(b, at = 0, len = b.length - at) {
  let h = (b[at] + 0xB5A5) & 0xFFFF;
  for (let i = at + 3; i < at + len; i++) h = (h * 33 + b[i]) & 0xFFFF;
  b[at + 1] = h & 0xFF;
  b[at + 2] = h >> 8;
  return b;
}

// ---------------------------------------------------------------- layouts

const WIDTH = { u8: 1, i8: 1, u16: 2, i16: 2, i32: 4, u32: 4, f32: 4 };
const GET = {
  u8: (d, o) => d.getUint8(o), i8: (d, o) => d.getInt8(o), u16: (d, o) => d.getUint16(o, true), i16: (d, o) => d.getInt16(o, true),
  i32: (d, o) => d.getInt32(o, true), u32: (d, o) => d.getUint32(o, true), f32: (d, o) => d.getFloat32(o, true),
};
const SET = {
  u8: (d, o, v) => d.setUint8(o, v), i8: (d, o, v) => d.setInt8(o, v), u16: (d, o, v) => d.setUint16(o, v, true), i16: (d, o, v) => d.setInt16(o, v, true),
  i32: (d, o, v) => d.setInt32(o, v, true), u32: (d, o, v) => d.setUint32(o, v, true), f32: (d, o, v) => d.setFloat32(o, v, true),
};

// a layout's fields with their offsets (from at): { name: { off, type, n, size } }, and its size
function fields(layout, at) {
  const out = {};
  let off = at;
  for (const [name, t] of layout) {
    let type = t, n = 1;
    const arr = /^(\w+)\[(\d+)\]$/.exec(t);
    if (arr) { type = arr[1]; n = +arr[2]; }
    const raw = /^b(\d+)$/.exec(type);
    const size = raw ? +raw[1] : WIDTH[type] * n;
    out[name] = { off, type: raw ? 'raw' : type, n, size };
    off += size;
  }
  return { fields: out, size: off };
}

// How to write a message of one version in 1.7.1's layout: copies of the bytes that stay as
// they are, conversions of the numbers whose type changed. Fields 1.7.1 has and the version
// has not stay 0, for the fixes below to fill.
function compile(fmt, id) {
  const entry = fmt.msgs.get(id);
  if (!entry || entry.drop !== undefined) return null;
  const head = fmt.hashed ? 3 : 1;
  const to = entry.to;
  if (VARIABLE.has(to)) return { to, variable: true, head, special: entry.special };
  const target = fields(L171[to], 3);
  const source = fields(entry.layout || L171[to], head);
  const ops = [], missing = [];
  for (const [name, t] of Object.entries(target.fields)) {
    const s = source.fields[name];
    if (!s) { missing.push(name); continue; }
    if (s.type === t.type && s.size === t.size) {
      const last = ops[ops.length - 1];
      if (last && last.copy && last.src + last.len === s.off && last.dst + last.len === t.off) last.len += s.size;
      else ops.push({ copy: true, src: s.off, dst: t.off, len: s.size });
    } else {
      ops.push({ src: s.off, get: GET[s.type], sw: WIDTH[s.type], dst: t.off, set: SET[t.type], tw: WIDTH[t.type], n: Math.min(s.n, t.n) });
    }
  }
  return { to, head, size: source.size, out: target.size, ops, missing: new Set(missing), at: target.fields, old: source.fields };
}

// the message at m[o, ...) (md: m's DataView) to out at q
function run(plan, m, md, o, out, od, q) {
  for (const op of plan.ops) {
    if (op.copy) {
      const src = o + op.src, dst = q + op.dst;
      if (op.len <= 16) for (let i = 0; i < op.len; i++) out[dst + i] = m[src + i];
      else out.set(m.subarray(src, src + op.len), dst);
      continue;
    }
    for (let i = 0; i < op.n; i++) op.set(od, q + op.dst + i * op.tw, op.get(md, o + op.src + i * op.sw));
  }
}

// ---------------------------------------------------------------- the player list

const plausible = (style, gravity) => style <= GAMESTYLE_HTF && (gravity === null || (Number.isFinite(gravity) && gravity > 0 && gravity < 10));

// The game decrypts a player list's map id, game mode and gravity with its session id: 'ok' if
// they make sense so, 'clear' if they do as they are (the game wrote them to its demos in
// clear), else 'unreadable'. m: a player list of the format's layout; with clear set, the
// fields are decrypted in m.
function listState(m, plan, fmt, clear = false) {
  const f = plan.old;
  const list = fmt.encrypted.map((n) => [f[n].off, f[n].size]);
  const read = (b) => {
    const d = dv(b);
    return plausible(b[f.GameStyle.off], f.Gravity ? d.getFloat32(f.Gravity.off, true) : null);
  };
  if (fmt.cipher) {
    const copy = m.slice();
    new SessionCipher(dv(m).getUint16(f.SessionID.off, true), ...fmt.cipher).fields(copy, list, true);
    if (read(copy)) {
      if (clear) m.set(copy);
      return 'ok';
    }
  }
  return read(m) ? 'clear' : 'unreadable';
}

// for the tests: the state of a player list of 1.7.1
export const playersListState = (m) => (m[0] === ID.PlayersList && m.length >= 2150 ? listState(m, PL_PLAN, FORMAT['1.7.1']) : 'unreadable');
const PL_PLAN = compile(FORMAT['1.7.1'], ID.PlayersList);
const PL171 = PL_PLAN.at;
const encryptList = (b, q) => new SessionCipher(dv(b).getUint16(q + PL171.SessionID.off, true))
  .fields(b, ['MapID', 'GameStyle', 'Gravity'].map((n) => [q + PL171[n].off, PL171[n].size]));

// ---------------------------------------------------------------- the version

// how well a version's message sizes fit a demo's records: +1 a message of a size it knows,
// -4 one that is too short for its size, -1 an unknown one
function fit(fmt, records) {
  const sizes = sizesOf(fmt);
  let score = 0;
  for (const m of records) {
    let p = 0;
    while (p < m.length) {
      const len = sizes.get(m[p]);
      if (len === undefined) { score--; break; }
      if (len === 0) { score++; break; }
      if (len > m.length - p) { score -= 4; break; }
      score++;
      p += len;
    }
  }
  return score;
}

const SIZES = new Map();
// a version's message sizes: ID -> size with the header, 0 for messages of any length
function sizesOf(fmt) {
  if (!SIZES.has(fmt)) {
    const s = new Map();
    for (const [id, entry] of fmt.msgs) {
      const p = plan(fmt, id);
      if (p) s.set(id, p.variable ? 0 : p.size);
      else if (entry) s.set(id, entry.drop);
      else s.set(id, oldSize(fmt, id));
    }
    SIZES.set(fmt, s);
  }
  return SIZES.get(fmt);
}

// the size of a message a version sent that 1.7.1 has no use for (it is skipped): with the
// check value, without
const DROPPED = { 44: [0, 0], 45: [49, 20], 60: [11, 9], 63: [0, 0], 67: [7, 7], 71: [12, 12] };
function oldSize(fmt, id) {
  const s = DROPPED[id];
  return s ? s[fmt.hashed ? 0 : 1] : 0;
}

const PLANS = new Map();
function plan(fmt, id) {
  let p = PLANS.get(fmt);
  if (!p) PLANS.set(fmt, (p = new Map()));
  if (!p.has(id)) p.set(id, compile(fmt, id));
  return p.get(id);
}

// the records that tell versions apart (their sizes changed), at most a few thousand
const TELLING = new Set([2, 3, 5, 13, 16, 17, 35, 36, 37, 41, 52, 60, 61, 62, 63, 64, 65, 67, 68, 69, 70, 71]);
function sample(at, record) {
  const out = [];
  const step = Math.max(1, Math.floor(at.length / 20000));
  for (let i = 0; i < at.length; i++) {
    const m = record(at[i]);
    // all of the few player lists, new players and server settings, which tell most
    if (m[0] === ID.PlayersList || m[0] === ID.NewPlayer || m[0] === ID.ServerVars || (i % step === 0 && TELLING.has(m[0]))) out.push(m);
  }
  return out;
}

// The version of a demo: of those its framing allows, the one whose message sizes fit its
// records best; ties go to the newest. A ServerVars of 746 bytes (1.6.6 to 1.7.0, 1.7.1 beta
// 1) also tells the weapons' order, which 1.6.7 and 1.6.8 differ by.
function choose(records, hashed) {
  const vars = records.find((m) => m[0] === ID.ServerVars && m.length === 746);
  const order = vars && weaponOrder(vars, 3);
  let best = null, score = -Infinity;
  for (const fmt of FORMATS) {
    if (fmt.hashed !== hashed) continue;
    if (order && sizesOf(fmt).get(ID.ServerVars) === 746 && fmt.weapons !== order) continue;
    const s = fit(fmt, records);
    if (s > score) { best = fmt; score = s; }
  }
  return best;
}

// which order the weapons of a ServerVars of 1.6.6 to 1.7.0 are in: the flamer (bullet style
// 5) is the 17th weapon in 1.7.1's, the 18th before
function weaponOrder(m, head) {
  const style = plan(FORMAT['1.6.8'], ID.ServerVars).old.BulletStyle.off - 3 + head;
  return m[style + 16] === 5 ? 'new' : m[style + 17] === 5 ? 'old16' : 'new';
}

// the version of a demo's message records (Uint8Arrays) of 1.6.8 to 1.7.1 with their check
// values; null: none of them tells
export function detectVersion(records) {
  const telling = records.filter((m) => [3, 13, 16, 17, 41, 52].includes(m[0]));
  if (!telling.length) return null;
  return choose(telling, true).key;
}

// ---------------------------------------------------------------- the demo file

// a record as the client got it: a compressed datagram inflated (null if it can't be)
async function inflate(data) {
  try {
    const stream = new Blob([data.subarray(1)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) {
    return null;
  }
}

// The records of a demo from p on: [offset of each message record], the end of what is read
// and the ticks. Size 1 is the next tick; size 0 has two bytes after it, which the game
// skips. With hashed messages a record of two bytes is nothing the game reads: the walk
// stops there. Returns null if the records do not end with the file (a byte too many is
// allowed), but for a cut one (cut: true) if loose.
function walk(u8, p, hashed, loose = false) {
  const d = dv(u8);
  const at = [];
  let ticks = 0;
  while (p + 2 <= u8.length) {
    const size = d.getUint16(p, true);
    const next = p + 2 + (size === 1 ? 0 : size || 2);
    if ((hashed && size === 2) || next > u8.length) break;
    if (size === 1) ticks++;
    else if (size > 1) at.push(p);
    p = next;
  }
  const cut = u8.length - p > 1;
  return !cut || loose ? { at, end: p, ticks, cut } : null;
}

// How a demo is framed: Soldat TV's header, the three bytes of the game's demos from 1.6.4 on,
// or nothing (up to 1.6.3). The first record must be a PlayersList (compressed or not) and the
// records reach the end of the file, or the last be cut short after many (the recording
// stopped; 1.6.4 RC3's intro).
function framing(u8) {
  if (u8.length >= HEADER_SIZE && String.fromCharCode(...u8.subarray(0, 6)) === 'SOLDEM') {
    return { kind: 'soldem', start: HEADER_SIZE, hashed: true, ...walk(u8, HEADER_SIZE, true, true) };
  }
  const starts = (p) => p + 3 <= u8.length && (u8[p + 2] === ID.PlayersList || u8[p + 2] === COMPRESSED);
  for (const [start, hashed] of [[3, true], [0, false]]) {
    if (!starts(start)) continue;
    const w = walk(u8, start, hashed, true);
    if (w.at.length && (!w.cut || w.at.length >= 100)) return { kind: start ? 'prefix' : 'bare', start, hashed, ...w };
  }
  return null;
}

// ---------------------------------------------------------------- converting

class Output {
  constructor(size) { this.b = new Uint8Array(size); this.d = dv(this.b); this.q = 0; }
  room(n) {
    if (this.q + n <= this.b.length) return;
    const b = new Uint8Array(Math.max(this.b.length * 2, this.q + n));
    b.set(this.b.subarray(0, this.q));
    this.b = b;
    this.d = dv(b);
  }
  bytes(src) { this.room(src.length); this.b.set(src, this.q); this.q += src.length; }
  done() { return this.b.subarray(0, this.q); }
}

// Writes the message at m[o, o + len) (of format fmt; md: m's DataView) as 1.7.1's to out,
// as a record; returns false if 1.7.1 has no use for it. ctx: the demo's tick and what is
// known of its players. (out's bytes past what is written are 0.)
function convert(fmt, m, md, o, len, out, ctx) {
  const p = plan(fmt, m[o]);
  if (!p) return false;
  if (p.variable) return convertVariable(p, m.subarray(o, o + len), out);
  if (len !== p.size) return false;
  out.room(2 + p.out);
  const q = out.q + 2;
  out.d.setUint16(out.q, p.out, true);
  if (p.to === ID.PlayersList) {
    m = clearList(fmt, p, m.subarray(o, o + len), ctx);
    md = dv(m);
    o = 0;
  }
  run(p, m, md, o, out.b, out.d, q);
  out.b[q] = p.to;
  fix(fmt, p, m, o, out.b, out.d, q, ctx);
  setHash(out.b, q, p.out);
  out.q = q + p.out;
  return true;
}

// chat, UnAccepted and SpecialMessage: their text runs to the end
function convertVariable(p, m, out) {
  const body = m.subarray(p.head);
  const layer = p.special === 'noLayer';
  const size = 3 + body.length + (layer ? 1 : 0);
  if (body.length < (p.to === ID.Special ? 23 : 1)) return false;
  out.room(2 + size);
  const q = out.q + 2;
  out.d.setUint16(out.q, size, true);
  out.b[q] = p.to;
  if (layer) {
    // SpecialMessage got a LayerId after its MsgType in 1.6.8: layer 0
    out.b[q + 3] = body[0];
    out.b[q + 4] = 0;
    out.b.set(body.subarray(1), q + 5);
  } else {
    out.b.set(body, q + 3);
  }
  setHash(out.b, q, size);
  out.q = q + size;
  return true;
}

// a copy of a player list with its encrypted fields in clear (if they were encrypted)
function clearList(fmt, p, m, ctx) {
  const copy = m.slice();
  ctx.list = listState(copy, p, fmt, true);
  ctx.lists[ctx.list]++;
  return copy;
}

// What the layouts alone do not say: 1.7.1's values for what older versions sent otherwise
// or not at all. q: the converted message in b.
function fix(fmt, p, m, o, b, d, q, ctx) {
  const at = (name) => q + p.at[name].off;
  const missing = p.missing;
  if (missing.has('ServerTicks')) d.setInt32(at('ServerTicks'), ctx.tick, true);
  switch (p.to) {
    case ID.Snapshot:
    case ID.Weapons:
    case ID.ForceWeapon: {
      if (fmt.weapons !== 'new') {
        b[at('Weapon')] = OLD_WEAPON_NUM(b[at('Weapon')]);
        b[at('Secondary')] = OLD_WEAPON_NUM(b[at('Secondary')]);
      }
      if (p.to !== ID.ForceWeapon) ctx.weapons.set(b[at('Num')], [b[at('Weapon')], b[at('Secondary')]]);
      break;
    }
    case ID.Bullet:
      if (fmt.bulletStyle) b[at('Weapon')] = bulletWeapon(m[o + p.old.Style.off], ctx.weapons.get(m[o + p.old.Owner.off]));
      else if (fmt.weapons !== 'new') b[at('Weapon')] = OLD_WEAPON_NUM(b[at('Weapon')]);
      break;
    case ID.HeartBeat:
    case ID.HeartBeat16:
    case ID.HeartBeat8: {
      // the map's id: another checksum before 1.7.1; 0 is no id (the client checks none)
      if (fmt.key !== '1.7.1') d.setUint32(at('MapID'), 0, true);
      if (missing.has('Active')) {
        // the entries of the players there are, in order: unused ones have team 255
        const n = p.at.Active.n;
        for (let i = 0; i < n; i++) {
          const team = b[at('Team') + i];
          b[at('Active') + i] = team === 0xFF ? 0 : 1;
          if (team === 0xFF) b[at('Team') + i] = 0;
          b[at('Flags') + i] = b[at('Caps') + i];
        }
      }
      break;
    }
    case ID.PlayersList: {
      if (missing.has('Gravity')) d.setFloat32(at('Gravity'), DEFAULT_GRAVITY, true);
      if (ctx.list === 'unreadable' && !fmt.hashed) {
        // a list that would not decrypt (1.2 to 1.4 had other ciphers, legacy-formats.js):
        // the game mode from the map and the match, the default gravity, no map id
        b[at('GameStyle')] = guessGameStyle(fixedString(b, at('MapName'), 16), b.subarray(at('Team'), at('Team') + 32), ctx.pointmatch);
        d.setFloat32(at('Gravity'), DEFAULT_GRAVITY, true);
        d.setUint32(at('MapID'), 0, true);
        ctx.list = 'guessed';
        ctx.lists.unreadable--;
        ctx.lists.guessed++;
      }
      // a list that would not decrypt stays as it was
      if (ctx.list !== 'unreadable') encryptList(b, q);
      break;
    }
    case ID.ServerVars:
      fixServerVars(fmt, p, b, d, q);
      break;
  }
}

// a game mode by a map's name, the players' teams and whether the match had the yellow flag:
// ctf_, inf_ and htf_ maps are played in their mode, others as pointmatch with the yellow
// flag, as a team match if anyone has a team, else as deathmatch
const GAME_STYLE = { DM: 0, PM: 1, TM: 2, CTF: 3, INF: 5, HTF: 6 };
function guessGameStyle(map, teams, yellowFlag) {
  const prefix = map.slice(0, 4).toLowerCase();
  if (prefix === 'ctf_') return GAME_STYLE.CTF;
  if (prefix === 'inf_') return GAME_STYLE.INF;
  if (prefix === 'htf_') return GAME_STYLE.HTF;
  if (yellowFlag) return GAME_STYLE.PM;
  return teams.some((t) => t >= 1 && t <= 4) ? GAME_STYLE.TM : GAME_STYLE.DM;
}

// whether a demo's things (ServerThingSnapshot, ...MustSnapshot) have the yellow flag (style 3)
const THINGS = new Set([9, 33]);
const YELLOW_FLAG = 3;
function hasYellowFlag(at, record, head) {
  for (const p of at) {
    const m = record(p);
    if (THINGS.has(m[0]) && m[head + 2] === YELLOW_FLAG) return true;
  }
  return false;
}

// a bullet's weapon from its style (up to 1.6.3): the owner's weapon of that style if there
// is one, else the style's usual weapon
function bulletWeapon(style, owner) {
  if (owner) for (const w of owner) if (WEAPON_STYLE[w] === style) return w;
  return STYLE_WEAPON[style] ?? 255;
}

// ServerVars: weapons in 1.7.1's order, MovementAcc divided by 200 where it was not, and the
// settings older versions had built in
function fixServerVars(fmt, p, b, d, q) {
  const order = ORDER[fmt.weapons];
  if (fmt.weapons !== 'new') {
    for (const f of Object.values(p.at)) {
      if (f.n !== 20) continue;
      const w = f.size / 20;
      const was = b.slice(q + f.off, q + f.off + f.size);
      for (let i = 0; i < 20; i++) b.set(was.subarray(i * w, i * w + w), q + f.off + (order[i] - 1) * w);
    }
  }
  const arr = (name) => q + p.at[name].off;
  if (p.old.MovementAcc.type !== 'f32') {
    for (let i = 0; i < 20; i++) d.setFloat32(arr('MovementAcc') + i * 4, d.getFloat32(arr('MovementAcc') + i * 4, true) / MOVEMENT_ACC_SCALE, true);
  }
  const fill = (name, values) => {
    if (p.missing.has(name)) for (let i = 0; i < 20; i++) d.setFloat32(arr(name) + i * 4, values[i], true);
  };
  fill('BulletSpread', DEFAULT_SPREAD);
  fill('Push', DEFAULT_PUSH);
  fill('InheritedVelocity', DEFAULT_INHERITED);
  fill('ModifierHead', new Array(20).fill(MODIFIER.head));
  fill('ModifierChest', new Array(20).fill(MODIFIER.chest));
  fill('ModifierLegs', new Array(20).fill(MODIFIER.legs));
}

// u8: a demo file. Returns { data (the demo in the 1.7.1 layout: u8 itself if it already
// was), from (the version it was recorded with: a key of legacy-formats.js FORMATS), name
// (its name for people), changed (data is new), notes (what was done, for people) }.
// Throws if the demo's messages are of no known version.
export async function migrateDemo(u8) {
  const frame = framing(u8);
  if (!frame) return { data: u8, from: null, name: '', changed: false, notes: [] };
  const d = dv(u8);
  const { at, end } = frame;
  const unpacked = new Map();  // compressed records: offset -> inflated
  const packed = at.filter((p) => u8[p + 2] === COMPRESSED);
  for (let k = 0; k < packed.length; k += 256) {
    const batch = packed.slice(k, k + 256);
    const data = await Promise.all(batch.map((p) => inflate(u8.subarray(p + 2, p + 2 + d.getUint16(p, true)))));
    batch.forEach((p, j) => data[j] && unpacked.set(p, data[j]));
  }
  const record = (p) => unpacked.get(p) || u8.subarray(p + 2, p + 2 + d.getUint16(p, true));
  const fmt = choose(sample(at, record), frame.hashed) || FORMAT['1.7.1'];
  const sizes = sizesOf(fmt);
  const latest = fmt.key === '1.7.1';

  // a demo of 1.7.1 with Soldat TV's header, one message a record and its list encrypted
  // stays as it is
  if (latest && frame.kind === 'soldem' && !unpacked.size && !frame.cut) {
    let same = true;
    for (const p of at) {
      const m = record(p);
      // a record of several messages, or of one cut short
      if (sizes.get(m[0]) && sizes.get(m[0]) !== m.length) { same = false; break; }
      if (m[0] === ID.PlayersList && listState(m, PL_PLAN, fmt) === 'clear') { same = false; break; }
    }
    if (same) return { data: u8, from: fmt.key, name: fmt.name, changed: false, notes: [], framed: frame.kind };
  }

  const out = new Output(Math.ceil(u8.length * (frame.hashed ? 1.1 : 1.5)) + HEADER_SIZE);
  const header = new Uint8Array(HEADER_SIZE);
  if (frame.kind === 'soldem') header.set(u8.subarray(0, HEADER_SIZE));
  else header.set([0x53, 0x4F, 0x4C, 0x44, 0x45, 0x4D]);  // 'SOLDEM'
  dv(header).setUint16(6, 0, true);  // 1.7.1's demo version
  out.bytes(header);

  const ctx = { tick: 0, weapons: new Map(), lists: { ok: 0, clear: 0, unreadable: 0, guessed: 0 } };
  // for a game mode to guess (a player list that would not decrypt)
  if (!fmt.hashed) ctx.pointmatch = hasYellowFlag(at, record, 1);
  let total = 0, kept = 0, odd = 0, splits = 0, map = '';
  const dropped = new Map();
  const tick = Uint8Array.of(1, 0);
  for (let p = frame.start, i = 0; p < end;) {
    const size = d.getUint16(p, true);
    if (size === 1) { ctx.tick++; out.bytes(tick); p += 2; continue; }
    if (size === 0) { out.bytes(u8.subarray(p, p + 4)); p += 4; continue; }
    // a message record: its messages, by the version's sizes
    const inflated = unpacked.get(at[i++]);
    const m = inflated || u8, md = inflated ? dv(inflated) : d;
    const first = inflated ? 0 : p + 2, last = inflated ? inflated.length : p + 2 + size;
    let n = 0;
    for (let o = first; o < last;) {
      let len = sizes.get(m[o]) || 0;
      if (len <= 0 || len > last - o) {
        if (len > 0) odd++;
        len = last - o;
      }
      n++;
      total++;
      if (convert(fmt, m, md, o, len, out, ctx)) {
        kept++;
        if (m[o] === ID.PlayersList && !map) map = fixedString(out.b, out.q - plan(fmt, ID.PlayersList).out + 3, 16);
      } else {
        dropped.set(m[o], (dropped.get(m[o]) || 0) + 1);
      }
      o += len;
    }
    if (n > 1) splits++;
    p += 2 + size;
  }

  // more than a few messages that do not fit: another version's layout
  if (odd > Math.max(5, total / 100)) {
    throw new Error(`This demo was recorded with a version of Soldat whose demos can't be converted: ${odd} of its ${total} messages don't fit ${fmt.name}.`);
  }
  const data = out.done();
  const od = dv(data);
  if (frame.kind !== 'soldem') {
    writeFixed(data, MAP_NAME, 161, map);
    od.setInt32(START_DATE, 0, true);
    od.setInt32(TICKS_NUM, frame.ticks, true);
  }
  const notes = [];
  if (!latest) notes.push(`Recorded with ${fmt.name}: ${kept} messages in Soldat 1.7.1's layout.`);
  if (frame.kind !== 'soldem') notes.push('The game\'s demo: given a Soldat TV header.');
  if (frame.cut) notes.push('Its last record was cut short: left out.');
  const skipped = [...dropped.values()].reduce((a, b) => a + b, 0);
  if (skipped) notes.push(`${skipped} messages Soldat 1.7.1 has no use for left out.`);
  if (unpacked.size) notes.push(`${unpacked.size} compressed records unpacked.`);
  if (splits) notes.push(`${splits} records of several messages split.`);
  if (ctx.lists.clear) notes.push('The player list had its game mode in clear: encrypted.');
  if (ctx.lists.guessed) notes.push('The player list\'s game mode could not be read: taken from the map and the teams.');
  if (ctx.lists.unreadable) notes.push('The player list\'s game mode and gravity could not be read.');
  return { data, from: fmt.key, name: fmt.name, changed: true, notes, framed: frame.kind };
}

function fixedString(b, off, len) {
  let s = '';
  for (let i = off; i < off + len && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
}

function writeFixed(b, off, len, text) {
  b.fill(0, off, off + len);
  for (let i = 0; i < Math.min(len - 1, text.length); i++) b[off + i] = text.charCodeAt(i) & 0xFF;
}
