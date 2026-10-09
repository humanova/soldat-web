// Made-up demos for the tests: a match in Soldat 1.7.1's layout (docs/PROTOCOL-1.7.1.md),
// and the same match as Soldat 1.7.0 and 1.6.8 sent it (docs/DEMOS.md).

import { SessionCipher } from '../../web/js/spectate/cipher.js';
import { setHash } from '../../web/js/spectate/legacy.js';

export const SESSION_ID = 2345;
const HEADER_SIZE = 180;
const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function text(b, off, len, s) {
  for (let i = 0; i < Math.min(len, s.length); i++) b[off + i] = s.charCodeAt(i);
}

const PLAYERS = [
  { slot: 1, name: 'Alpha One', team: 1, x: 100, y: -200 },
  { slot: 2, name: 'Bravo Two', team: 2, x: -300, y: -150 },
];

export function playersList({ map = 'ctf_Ash', gameStyle = 3, gravity = 0.06, clear = false } = {}) {
  const b = new Uint8Array(2150), d = dv(b);
  b[0] = 16;
  text(b, 3, 16, map);
  b[19] = gameStyle;
  b[20] = PLAYERS.length;
  d.setUint16(21, 10, true);
  text(b, 24, 24, 'Test server');
  for (let i = 1; i <= 32; i++) text(b, 108 + (i - 1) * 24, 24, '0 ');
  for (const p of PLAYERS) {
    const o = p.slot - 1;
    b.fill(0, 108 + o * 24, 108 + o * 24 + 24);
    text(b, 108 + o * 24, 24, p.name);
    d.setUint32(876 + o * 4, 0xFFD20F05, true);
    b[1516 + o] = p.team;
    d.setFloat32(1620 + o * 8, p.x, true);
    d.setFloat32(1624 + o * 8, p.y, true);
  }
  d.setUint32(1580, 0x25B400, true);
  d.setFloat32(1584, gravity, true);
  d.setUint16(2134, SESSION_ID, true);
  d.setInt32(2136, 36000, true);
  d.setInt32(2140, 30000, true);
  b[2144] = 2;
  d.setInt32(2145, 5000, true);
  if (!clear) new SessionCipher(SESSION_ID).fields(b, [[1580, 4], [19, 1], [1584, 4]]);
  return setHash(b);
}

export function newPlayer(slot, name, team) {
  const b = new Uint8Array(61), d = dv(b);
  b[0] = 17;
  b[3] = slot;
  b[6] = 0;  // JoinType: the older versions have none (a normal join)
  text(b, 7, 24, name);
  d.setUint32(31, 0xFF050FD2, true);
  b[51] = team;
  b[52] = 0x12;
  d.setFloat32(53, 10, true);
  d.setFloat32(57, -20, true);
  return setHash(b);
}

export function serverVars() {
  const b = new Uint8Array(986), d = dv(b);
  b[0] = 52;
  d.setInt32(5, 36000, true);
  for (let i = 0; i < 20; i++) {
    d.setFloat32(12 + i * 4, 1 + i / 10, true);
    b[92 + i] = 10 + i;
    d.setUint16(112 + i * 2, 60 + i, true);
    d.setFloat32(152 + i * 4, 10 + i, true);
    b[232 + i] = 1;
    d.setFloat32(732 + i * 4, 1.15, true);  // the hitbox modifiers 1.7.0 had built in
    d.setFloat32(812 + i * 4, 1, true);
    d.setFloat32(892 + i * 4, 0.9, true);
  }
  b.fill(1, 972, 986);
  return setHash(b);
}

export function heartBeat(mapId = 0x1234ABCD) {
  const b = new Uint8Array(303), d = dv(b);
  b[0] = 2;
  d.setUint32(3, mapId, true);
  b[7] = 1; b[8] = 1;
  d.setUint16(7 + 32 * 7, 2, true);  // alpha's score
  return setHash(b);
}

export function spriteSnapshot(slot, tick, health = 150, vest = 25) {
  const b = new Uint8Array(41), d = dv(b);
  b[0] = 3;
  b[3] = slot;
  d.setFloat32(4, 100 + tick, true);
  d.setFloat32(8, -200, true);
  d.setFloat32(12, 1.5, true);
  b[20] = 64; b[21] = 1;
  d.setUint16(22, 0x0102, true);
  b[24] = 0x08;
  d.setFloat32(25, vest, true);
  d.setFloat32(29, health, true);
  b[33] = 30; b[34] = 2; b[35] = 3; b[36] = 11;
  d.setInt32(37, 5000 + tick, true);
  return setHash(b);
}

export function spriteSnapshotMajor(slot, tick, health = 120) {
  const b = new Uint8Array(32), d = dv(b);
  b[0] = 41;
  b[3] = slot;
  d.setFloat32(4, 50 + tick, true);
  d.setFloat32(8, -100, true);
  d.setFloat32(20, health, true);
  b[24] = 200; b[25] = 2;
  d.setUint16(26, 0x0304, true);
  d.setInt32(28, 5000 + tick, true);
  return setHash(b);
}

export function spriteDeath(slot, killer, health = -40) {
  const b = new Uint8Array(280), d = dv(b);
  b[0] = 13;
  b[3] = slot; b[4] = killer; b[5] = 7; b[6] = 3; b[7] = 0x05;
  for (let i = 0; i < 16; i++) {
    d.setFloat32(8 + i * 8, 100 + i, true);
    d.setFloat32(136 + i * 8, 99 + i, true);
  }
  d.setFloat32(264, health, true);
  b[268] = 1;
  d.setInt16(269, 180, true);
  d.setFloat32(271, 345.5, true);
  d.setFloat32(275, 1.25, true);
  b[279] = 1;
  return setHash(b);
}

const chat = (slot, s) => setHash(Uint8Array.from([6, 0, 0, slot, ...[...s].map((c) => c.charCodeAt(0)), 0]));

// [tick, message] of a short match
export function match({ clearList = false } = {}) {
  const out = [
    [0, playersList({ clear: clearList })],
    [0, newPlayer(32, 'Demo Recorder', 5)],
    [0, serverVars()],
    [0, heartBeat()],
  ];
  for (let t = 1; t <= 120; t++) {
    for (const p of PLAYERS) out.push([t, spriteSnapshot(p.slot, t)]);
    if (t % 30 === 0) out.push([t, spriteSnapshotMajor(1, t)]);
    if (t % 60 === 0) out.push([t, heartBeat()]);
  }
  out.push([90, spriteDeath(2, 1)]);
  out.push([95, newPlayer(3, 'Charlie Three', 1)]);
  out.push([100, chat(1, ' gg')]);
  return out.sort((a, b) => a[0] - b[0]);
}

// a demo file of [tick, message | message[] (one record)] (ticks in order); version: the header's
export function demo(msgs, { ticks = 130, map = 'ctf_Ash', version = 0 } = {}) {
  const parts = [];
  let tick = 0;
  const head = new Uint8Array(HEADER_SIZE), hd = dv(head);
  text(head, 0, 6, 'SOLDEM');
  hd.setUint16(6, version, true);
  text(head, 8, 160, map);
  hd.setInt32(172, 1400000000, true);
  hd.setInt32(176, ticks, true);
  parts.push(head);
  const rec = (m) => {
    const r = new Uint8Array(2 + m.length);
    dv(r).setUint16(0, m.length, true);
    r.set(m, 2);
    parts.push(r);
  };
  for (const [t, m] of msgs) {
    for (; tick < t; tick++) parts.push(Uint8Array.of(1, 0));
    rec(Array.isArray(m) ? concat(m) : m);
  }
  for (; tick < ticks; tick++) parts.push(Uint8Array.of(1, 0));
  return concat(parts);
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- the older layouts

function pick(m, size, parts) {
  const o = new Uint8Array(size);
  for (const [from, to, at] of parts) o.set(m.subarray(from, to), at);
  return o;
}

// a 1.7.1 message as 1.7.0 (or 1.6.8) sent it
export function downgrade(m, to) {
  const d = dv(m);
  let o = m;
  switch (m[0]) {
    case 3:
      o = pick(m, 36, [[0, 25, 0], [33, 41, 28]]);
      o[25] = d.getFloat32(25, true);
      dv(o).setInt16(26, d.getFloat32(29, true), true);
      break;
    case 41:
      o = pick(m, 30, [[0, 20, 0], [24, 32, 22]]);
      dv(o).setInt16(20, d.getFloat32(20, true), true);
      break;
    case 13:
      o = pick(m, 278, [[0, 264, 0], [268, 280, 266]]);
      dv(o).setInt16(264, d.getFloat32(264, true), true);
      break;
    case 17:
      o = pick(m, 60, [[0, 6, 0], [7, 61, 6]]);
      break;
    case 52:
      o = pick(m, 746, [[0, 732, 0], [972, 986, 732]]);
      break;
    case 16:
      if (to === '1.6.8') o = m.slice(0, 2149);
      break;
  }
  return o === m ? m : setHash(o);
}

// what the conversion gives for a 1.7.1 message it got back from an older layout
export function expected(m) {
  if (m[0] !== 2 && m[0] !== 35 && m[0] !== 36) return m;
  const o = m.slice();
  o.fill(0, 3, 7);  // the heartbeat's map id: another checksum before 1.7.1
  return setHash(o);
}
