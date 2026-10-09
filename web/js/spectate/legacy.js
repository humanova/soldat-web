// Demos of older Soldat versions, brought to the 1.7.1 layout that the page plays
// (replay.js) and that Soldat 1.7.1 opens. docs/DEMOS.md has the formats: they were
// reverse engineered from the dedicated servers of each version (soldatserver 2.7.8 for
// Soldat 1.6.8, 2.8.0 for 1.7.0, 2.8.1 for 1.7.1). A demo is the server's messages as its
// client got them, so the server's message layouts are the demo's.
//
// 1.6.8 to 1.7.1 share the demo file, the 3-byte message header and its check value, and the
// session cipher. 1.7.1 changed six messages: health and vest went from integers to Singles
// (ServerSpriteSnapshot, ServerSpriteSnapshot_Major, SpriteDeath), NewPlayer got a JoinType,
// ServerVars the weapons' hitbox modifiers. 1.6.9/1.7.0 added a byte to PlayersList.
//
// Run in the browser and in Node (tools/migrate-demo.mjs). Also tidies 1.7.1 demos:
// records of several messages are split (the replay reads one message a record),
// compressed ones inflated, and a player list with its fields in clear encrypted.

import { SessionCipher } from './cipher.js';

const HEADER_SIZE = 180;
const ID = {
  HeartBeat: 2, ServerSpriteSnapshot: 3, SpriteDeath: 13, PlayersList: 16, NewPlayer: 17,
  HeartBeat16: 35, HeartBeat8: 36, ServerSpriteSnapshotMajor: 41, ServerVars: 52,
};
const COMPRESSED = 0xFF;
const JOIN_NORMAL = 0;
// the hitbox modifiers 1.6.8 and 1.7.0 had built in (1.7.1 sends each weapon's)
const MODIFIER = { head: 1.15, chest: 1, legs: 0.9 };
const WEAPONS = 20;

// fixed sizes of the server's messages; the others fill the rest of their record
const SIZES_171 = new Map([
  [2, 303], [3, 41], [5, 24], [7, 6], [8, 22], [9, 71], [12, 7], [13, 280], [16, 2150], [17, 61],
  [18, 3], [19, 5], [21, 27], [25, 7], [26, 5], [29, 6], [30, 5], [32, 5], [33, 73], [35, 159],
  [36, 87], [37, 6], [40, 3], [41, 32], [43, 4], [45, 49], [52, 986], [54, 8], [56, 3], [60, 12],
  [61, 12], [62, 7], [65, 5], [69, 7], [70, 38], [127, 3],
]);
const SIZES_170 = new Map([...SIZES_171, [3, 36], [13, 278], [17, 60], [41, 30], [52, 746]]);
const SIZES_168 = new Map([...SIZES_170, [16, 2149]]);

export const FORMATS = {
  '1.6.8': { name: 'Soldat 1.6.8', sizes: SIZES_168 },
  '1.7.0': { name: 'Soldat 1.7.0', sizes: SIZES_170 },
  '1.7.1': { name: 'Soldat 1.7.1', sizes: SIZES_171 },
};

// the messages whose size tells the versions apart: [1.7.1's, the older one's]
const TELLS = new Map([[3, [41, 36]], [13, [280, 278]], [17, [61, 60]], [41, [32, 30]], [52, [986, 746]]]);

// PlayersList's encrypted fields, in their order: MapID, GameStyle, Gravity
const PL_FIELDS = [[1580, 4], [19, 1], [1584, 4]];
const PL_SESSION_ID = 2134;
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

// ---------------------------------------------------------------- the version

// Which version recorded a demo, from the sizes of the messages that changed: a record of
// several messages of one kind is a multiple of its size. Votes are counted with tell().
const votes = () => ({ older: 0, newer: 0, list: 0 });

function tell(v, id, len) {
  if (id === ID.PlayersList && (len === 2149 || len === 2150)) v.list = len;
  const t = TELLS.get(id);
  if (!t) return;
  const isNew = len % t[0] === 0, isOld = len % t[1] === 0;
  if (isNew && !isOld) v.newer++;
  else if (isOld && !isNew) v.older++;
}

function decide(v) {
  if (!v.older && !v.newer) return v.list === 2149 ? '1.6.8' : null;
  if (v.newer >= v.older) return '1.7.1';
  return v.list === 2149 ? '1.6.8' : '1.7.0';
}

// the version of a demo's message records (Uint8Arrays); null: none of them tells
export function detectVersion(records) {
  const v = votes();
  for (const m of records) if (m.length > 2) tell(v, m[0], m.length);
  return decide(v);
}

// ---------------------------------------------------------------- the messages

const i16 = (m, o) => ((m[o] | (m[o + 1] << 8)) << 16) >> 16;

// the size of a message of an older version in 1.7.1's layout
function upgradedSize(id, len, from) {
  switch (id) {
    case ID.ServerSpriteSnapshot: return len === 36 ? 41 : len;
    case ID.ServerSpriteSnapshotMajor: return len === 30 ? 32 : len;
    case ID.SpriteDeath: return len === 278 ? 280 : len;
    case ID.NewPlayer: return len === 60 ? 61 : len;
    case ID.ServerVars: return len === 746 ? 986 : len;
    case ID.PlayersList: return len === 2149 && from === '1.6.8' ? 2150 : len;
  }
  return len;
}

// writes a message of 1.6.8 or 1.7.0 at out[q] in the layout of 1.7.1 (od: out's DataView)
function writeUpgraded(out, od, q, m, from) {
  const part = (a, b, at) => out.set(m.subarray(a, b), q + at);
  switch (upgradedSize(m[0], m.length, from) === m.length ? -1 : m[0]) {
    case ID.ServerSpriteSnapshot:
      // 25 Vest: Byte, 26 Health: SmallInt -> 25 Vest, 29 Health: Single
      part(0, 25, 0);
      od.setFloat32(q + 25, m[25], true);
      od.setFloat32(q + 29, i16(m, 26), true);
      part(28, 36, 33);
      return;
    case ID.ServerSpriteSnapshotMajor:
      // 20 Health: SmallInt -> Single
      part(0, 20, 0);
      od.setFloat32(q + 20, i16(m, 20), true);
      part(22, 30, 24);
      return;
    case ID.SpriteDeath:
      // 264 Health: SmallInt -> Single
      part(0, 264, 0);
      od.setFloat32(q + 264, i16(m, 264), true);
      part(266, 278, 268);
      return;
    case ID.NewPlayer:
      // 6 JoinType, before the name
      part(0, 6, 0);
      out[q + 6] = JOIN_NORMAL;
      part(6, 60, 7);
      return;
    case ID.ServerVars:
      // 732 ModifierHead, ModifierChest, ModifierLegs: array[1..20] of Single, then WeaponActive
      part(0, 732, 0);
      for (let i = 0; i < WEAPONS; i++) {
        od.setFloat32(q + 732 + i * 4, MODIFIER.head, true);
        od.setFloat32(q + 812 + i * 4, MODIFIER.chest, true);
        od.setFloat32(q + 892 + i * 4, MODIFIER.legs, true);
      }
      part(732, 746, 972);
      return;
    case ID.PlayersList:
      // 2149 SurvivalClearWeapons (1.6.9)
      part(0, 2149, 0);
      out[q + 2149] = 0;
      return;
  }
  out.set(m, q);
  // the map's id: another checksum before 1.7.1; 0 is no id (the client checks none)
  if ((m[0] === ID.HeartBeat || m[0] === ID.HeartBeat16 || m[0] === ID.HeartBeat8) && m.length >= 7) out.fill(0, q + 3, q + 7);
}

const plausible = (style, gravity) => style <= GAMESTYLE_HTF && Number.isFinite(gravity) && gravity > 0 && gravity < 10;

// The game decrypts a player list's game mode and gravity with its session id: 'ok' if they
// make sense so, 'clear' if they do as they are (a client may have written them in clear),
// else 'unreadable'.
export function playersListState(m) {
  if (m[0] !== ID.PlayersList || m.length < 2150) return 'unreadable';
  const clear = m.slice();
  new SessionCipher(dv(m).getUint16(PL_SESSION_ID, true)).fields(clear, PL_FIELDS, true);
  if (plausible(clear[19], dv(clear).getFloat32(1584, true))) return 'ok';
  return plausible(m[19], dv(m).getFloat32(1584, true)) ? 'clear' : 'unreadable';
}

const encryptPlayersList = (m) => new SessionCipher(dv(m).getUint16(PL_SESSION_ID, true)).fields(m, PL_FIELDS);

// ---------------------------------------------------------------- the demo

// a record as the client got it: a compressed datagram inflated (null if it can't be)
async function inflate(data) {
  try {
    const stream = new Blob([data.subarray(1)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) {
    return null;
  }
}

// calls fn(start, length) for each message of a record, buf[p, end), by the sizes of a
// version (a record may hold several); returns how many were shorter than their version
// makes them
function pieces(buf, p, end, sizes, fn) {
  let odd = 0;
  while (p < end) {
    let len = sizes.get(buf[p]) || 0;
    if (len <= 0 || len > end - p) {
      if (len > 0) odd++;
      len = end - p;
    }
    if (len >= 3) fn(p, len);
    p += len;
  }
  return odd;
}

// u8: a demo file. Returns { data (the demo in the 1.7.1 layout: u8 itself if it already
// was), from (the version it was recorded with: '1.6.8', '1.7.0' or '1.7.1'), name (its
// name for people), changed (data is new), notes (what was done, for people) }. Throws if
// the demo's messages are of no known version.
export async function migrateDemo(u8) {
  if (u8.length < HEADER_SIZE || String.fromCharCode(...u8.subarray(0, 6)) !== 'SOLDEM') {
    return { data: u8, from: null, name: '', changed: false, notes: [] };
  }
  // the message records: where their sizes are (size 1 is the next tick; size 0 has two
  // bytes after it, which the game skips), until where the game reads
  const d = dv(u8);
  const at = [];
  let end = HEADER_SIZE;
  for (let p = HEADER_SIZE; p + 2 <= u8.length;) {
    const size = d.getUint16(p, true);
    const next = p + 2 + (size === 1 ? 0 : size || 2);
    if (size === 2 || next > u8.length) break;  // nothing the game reads, or cut off
    if (size > 2) at.push(p);
    p = end = next;
  }
  const unpacked = new Map();  // compressed records: offset -> inflated
  for (const p of at) {
    if (u8[p + 2] !== COMPRESSED) continue;
    const data = await inflate(u8.subarray(p + 2, p + 2 + d.getUint16(p, true)));
    if (data) unpacked.set(p, data);
  }
  // a record's messages: calls fn(buf, start, length) for each
  const each = (p, sizes, fn) => {
    const m = unpacked.get(p);
    if (m) return pieces(m, 0, m.length, sizes, (o, len) => fn(m, o, len));
    return pieces(u8, p + 2, p + 2 + d.getUint16(p, true), sizes, (o, len) => fn(u8, o, len));
  };

  const v = votes();
  for (const p of at) {
    const m = unpacked.get(p);
    if (m) tell(v, m[0], m.length);
    else tell(v, u8[p + 2], d.getUint16(p, true));
  }
  const from = decide(v) || '1.7.1';
  const old = from !== '1.7.1';
  const sizes = FORMATS[from].sizes;

  // what is to be written: the size of the demo, and whether anything changes
  let size = end, splits = 0, odd = 0, total = 0, upgraded = 0, change = old || unpacked.size > 0;
  const lists = { ok: 0, clear: 0, unreadable: 0 };
  for (const p of at) {
    let n = 0;
    odd += each(p, sizes, (buf, o, len) => {
      n++;
      const grown = old ? upgradedSize(buf[o], len, from) : len;
      if (grown !== len) upgraded++;
      if (buf[o] === ID.PlayersList && grown >= 2150) {
        const list = new Uint8Array(grown);
        list.set(buf.subarray(o, o + len));
        const state = playersListState(list);
        lists[state]++;
        if (state === 'clear') change = true;
      }
      size += 2 + grown;
    });
    total += n;
    if (n !== 1) { splits++; change = true; }
    size -= 2 + d.getUint16(p, true);
  }
  // more than a few messages that do not fit: another version's layout
  if (old && odd > Math.max(5, total / 100)) {
    throw new Error(`This demo was recorded with a version of Soldat whose demos can't be converted yet: ${odd} of its ${total} messages don't fit ${FORMATS[from].name}.`);
  }
  const notes = [];
  if (old) notes.push(`Recorded with ${FORMATS[from].name}: ${upgraded} messages in Soldat 1.7.1's layout.`);
  if (unpacked.size) notes.push(`${unpacked.size} compressed records unpacked.`);
  if (splits) notes.push(`${splits} records of several messages split.`);
  if (lists.clear) notes.push('The player list had its game mode in clear: encrypted.');
  if (lists.unreadable) notes.push('The player list\'s game mode and gravity could not be read.');
  const result = { data: u8, from, name: FORMATS[from].name, changed: change, notes };
  if (!change) return result;

  // the demo: ticks and empty records as they were, one record a message, the header's
  // version 0 (1.7.1)
  const out = new Uint8Array(size);
  const od = dv(out);
  out.set(u8.subarray(0, HEADER_SIZE));
  od.setUint16(6, 0, true);
  let q = HEADER_SIZE, src = HEADER_SIZE;
  for (const p of at) {
    out.set(u8.subarray(src, p), q);
    q += p - src;
    src = p + 2 + d.getUint16(p, true);
    each(p, sizes, (buf, o, len) => {
      const msg = buf.subarray(o, o + len);
      const grown = old ? upgradedSize(msg[0], len, from) : len;
      od.setUint16(q, grown, true);
      if (old) writeUpgraded(out, od, q + 2, msg, from);
      else out.set(msg, q + 2);
      let fixList = false;
      if (msg[0] === ID.PlayersList && grown >= 2150) {
        const list = out.subarray(q + 2, q + 2 + grown);
        fixList = playersListState(list) === 'clear';
        if (fixList) encryptPlayersList(list);
      }
      // the check value is 1.7.1's in every version: renewed for what was changed, and for
      // all of an old demo (the game drops a message whose value is wrong); a compressed
      // record that would not inflate stays as it was
      if ((old && msg[0] !== COMPRESSED) || fixList) setHash(out, q + 2, grown);
      q += 2 + grown;
    });
  }
  out.set(u8.subarray(src, end), q);
  result.data = out;
  return result;
}
