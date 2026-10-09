// Old demos on the maps they were played on. Many stock maps were reshaped between versions
// (1.6.0 redid Cambodia, 1.7.0 remade ctf_Ash and moved ctf_Maya up), and a demo played on
// 1.7.1's map shows its players in the ground or in the air. The asset mirror has every older
// version of a stock map whose ground differs from 1.7.1's (tools/old-maps.py; listed in
// old-maps-data.js), named <map>~<version it came with>. Of 1.7.1's map and those, a demo plays
// on the one its players are inside the ground of the least; on a tie, the one its version
// shipped. The page plays a copy of the demo with the map renamed; the converted file keeps the
// map's own name.

import { setHash } from './legacy.js';

const HEADER_SIZE = 180, HEADER_MAP = 8, HEADER_MAP_LEN = 161;
const PLAYERS_LIST = 16, MAP_CHANGE = 8;
const LIST_MAP = 3, LIST_MAP_LEN = 16;  // PlayersList: MapName, array[0..15] of Char
const CHANGE_COUNTER = 3, CHANGE_MAP = 5, CHANGE_MAP_LEN = 16;  // MapChange: Counter, MapName: string[16]
const POSITIONS = new Set([3, 21, 41]);  // sprite snapshots, movement: Pos at 4
const SAMPLE = 4000;

// the versions each format of legacy-formats.js covers (a beta: its own and the release's)
const FORMAT_VERSIONS = {
  '1.2.1': ['1.2.0', '1.2.1'], '1.3.1': ['1.3.0', '1.3.1'], '1.4.2': ['1.4.0', '1.4.2'], '1.4.1': ['1.4.1'],
  '1.5.0': ['1.5.0'], '1.5.1': ['1.5.0', '1.6.0'], '1.6.0': ['1.6.0', '1.6.1', '1.6.2', '1.6.3'],
  '1.6.4b': ['1.6.3', '1.6.4'], '1.6.4rc1': ['1.6.3', '1.6.4'], '1.6.4': ['1.6.4', '1.6.5'], '1.6.6': ['1.6.6'],
  '1.6.7b1': ['1.6.6', '1.6.7'], '1.6.7': ['1.6.7'], '1.6.8b1': ['1.6.7', '1.6.8'], '1.6.8': ['1.6.8'],
  '1.7.0': ['1.6.9', '1.7.0'], '1.7.1b1': ['1.7.0'],
};

// A map's shown name: without the version a played copy's has
export const shownMap = (name) => name.replace(/~[\w.]+$/, '');

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const text = (b, off, len) => {
  let s = '';
  for (let i = off; i < off + len && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
};

// The demo's maps (data: a converted demo, 1.7.1's layout) and where its players were on each:
// Map(name -> [x, y, x, y, ...]). A map change takes effect when its counter runs out.
function positions(data) {
  const d = dv(data);
  const out = new Map();
  let map = '', next = null, tick = 0;
  for (let p = HEADER_SIZE; p + 2 <= data.length;) {
    const size = d.getUint16(p, true);
    if (size === 1) { tick++; p += 2; continue; }
    if (size === 0) { p += 4; continue; }
    const at = p + 2;
    p = at + size;
    if (p > data.length) break;
    if (next && tick >= next.tick) { map = next.map; next = null; }
    const id = data[at];
    if (id === PLAYERS_LIST && size >= LIST_MAP + LIST_MAP_LEN) map = text(data, at + LIST_MAP, LIST_MAP_LEN);
    else if (id === MAP_CHANGE && size >= CHANGE_MAP + 1) {
      next = { map: text(data, at + CHANGE_MAP + 1, Math.min(CHANGE_MAP_LEN, data[at + CHANGE_MAP])), tick: tick + d.getInt16(at + CHANGE_COUNTER, true) };
      if (!out.has(next.map)) out.set(next.map, []);
    } else if (POSITIONS.has(id) && map && size >= 12) {
      if (!out.has(map)) out.set(map, []);
      out.get(map).push(d.getFloat32(at + 4, true), d.getFloat32(at + 8, true));
    }
  }
  return out;
}

// a map file's triangles a player cannot be inside: [ax, ay, bx, by, cx, cy] each (PMS, MapFile.pas)
const PASSABLE = new Set([1, 3, 10, 12, 14, 16, 23, 24, 25]);  // bullets only, none, team bullets, flags, background
function solids(pms) {
  const d = dv(pms);
  const n = d.getInt32(88, true);
  const out = [];
  for (let i = 0, p = 92; i < n && p + 121 <= pms.length; i++, p += 121) {
    if (PASSABLE.has(pms[p + 120])) continue;
    for (let v = 0; v < 3; v++) out.push(d.getFloat32(p + v * 28, true), d.getFloat32(p + v * 28 + 4, true));
  }
  return Float32Array.from(out);
}

// the share of the positions inside the triangles (well inside: not on an edge)
function inside(tris, pts) {
  const step = Math.max(1, Math.floor(pts.length / 2 / SAMPLE));
  let hit = 0, total = 0;
  for (let i = 0; i + 1 < pts.length; i += 2 * step) {
    const x = pts[i], y = pts[i + 1];
    total++;
    for (let t = 0; t < tris.length; t += 6) {
      const ax = tris[t], ay = tris[t + 1], bx = tris[t + 2], by = tris[t + 3], cx = tris[t + 4], cy = tris[t + 5];
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (!det) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      if (l1 > 0.02 && l2 > 0.02 && l1 + l2 < 0.98) { hit++; break; }
    }
  }
  return total ? hit / total : 0;
}

// Which maps a converted demo of format `from` should play on: Map(its map's name -> the name
// of the version to play). own(name): 1.7.1's map file (or null); fetchMap(name): an older one's.
export async function pickMaps(from, data, { own, fetchMap }) {
  const versions = FORMAT_VERSIONS[from];
  const picked = new Map();
  if (!versions) return picked;
  const { OLD_MAPS } = await import('./old-maps-data.js');
  for (const [map, pts] of positions(data)) {
    const variants = OLD_MAPS[map.toLowerCase()];
    if (!variants) continue;
    // [name, file, shipped with the demo's version]
    const cands = variants.map(([name, vs]) => [name, null, vs.split(' ').some((v) => versions.includes(v))]);
    const mine = own(map);
    if (mine) cands.push([null, mine, false]);
    let best = null;
    for (const c of cands) {
      try {
        const file = c[1] || (await fetchMap(c[0]));
        const score = inside(solids(file), pts);
        // fewer players in the ground; on a tie, the version's own map, then 1.7.1's
        const rank = [score, c[2] ? 0 : c[0] ? 2 : 1];
        if (!best || rank[0] < best.rank[0] - 0.002 || (Math.abs(rank[0] - best.rank[0]) <= 0.002 && rank[1] < best.rank[1])) best = { name: c[0], rank };
      } catch (_) {
        // a map that cannot be had is no choice
      }
    }
    if (best && best.name) picked.set(map, best.name);
  }
  return picked;
}

// a copy of a converted demo with its maps renamed (names: Map(old -> new)), or data itself
export function renameMaps(data, names) {
  if (!names.size) return data;
  const out = data.slice();
  const d = dv(out);
  const put = (off, len, s) => { out.fill(0, off, off + len); for (let i = 0; i < Math.min(len, s.length); i++) out[off + i] = s.charCodeAt(i) & 0xFF; };
  const header = text(out, HEADER_MAP, HEADER_MAP_LEN);
  if (names.has(header)) put(HEADER_MAP, HEADER_MAP_LEN, names.get(header));
  for (let p = HEADER_SIZE; p + 2 <= out.length;) {
    const size = d.getUint16(p, true);
    if (size === 1) { p += 2; continue; }
    if (size === 0) { p += 4; continue; }
    const at = p + 2;
    p = at + size;
    if (p > out.length) break;
    if (out[at] === PLAYERS_LIST && size >= LIST_MAP + LIST_MAP_LEN) {
      const to = names.get(text(out, at + LIST_MAP, LIST_MAP_LEN));
      if (to) { put(at + LIST_MAP, LIST_MAP_LEN, to); setHash(out, at, size); }
    } else if (out[at] === MAP_CHANGE && size >= CHANGE_MAP + 1 + CHANGE_MAP_LEN) {
      const to = names.get(text(out, at + CHANGE_MAP + 1, Math.min(CHANGE_MAP_LEN, out[at + CHANGE_MAP])));
      if (to) { out[at + CHANGE_MAP] = to.length; put(at + CHANGE_MAP + 1, CHANGE_MAP_LEN, to); setHash(out, at, size); }
    }
  }
  return out;
}
