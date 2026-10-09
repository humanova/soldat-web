// Old demos on the maps they were played on (web/js/spectate/old-maps.js).   node --test tools/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { migrateDemo } from '../../web/js/spectate/legacy.js';
import { pickMaps, renameMaps, shownMap } from '../../web/js/spectate/old-maps.js';
import { OLD_MAPS } from '../../web/js/spectate/old-maps-data.js';
import { parseDemo, Replay } from '../../web/js/spectate/replay.js';
import { readZip } from '../../web/js/zip.js';
import { match, demo, setHashOk } from './fake-demo.mjs';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const smod = await readZip(new Uint8Array(fs.readFileSync(path.join(web, 'soldat.smod'))));
const maps = {
  own: (m) => smod.get('maps/' + m.toLowerCase() + '.pms')?.data || null,
  fetchMap: async (n) => new Uint8Array(fs.readFileSync(path.join(web, 'assets/maps', n + '.pms'))),
};
const intro = async (v) => migrateDemo(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(web, 'intros', `intro-${v}.sdm.gz`)))));

test('the old maps the page picks from are in the asset mirror', () => {
  const index = new Set(JSON.parse(fs.readFileSync(path.join(web, 'assets/index.json'), 'utf8')));
  const listed = JSON.parse(fs.readFileSync(path.join(web, 'assets/old-maps.json'), 'utf8'));
  for (const [name, variants] of Object.entries(OLD_MAPS)) {
    for (const [file, versions] of variants) {
      assert.equal(file.toLowerCase().replace(/~\w+$/, ''), name);
      assert.ok(file.length <= 16, file);
      assert.match(versions, /^1\.\d\.\d( 1\.\d\.\d)*$/);
      assert.ok(index.has(`maps/${file}.pms`) && listed.includes(`maps/${file}.pms`), file);
      assert.ok(fs.existsSync(path.join(web, 'assets/maps', file + '.pms')), file);
    }
  }
  for (const rel of listed) assert.ok(index.has(rel) && fs.existsSync(path.join(web, 'assets', rel)), rel);
});

test('an old demo plays on the map its players stood on', async () => {
  // 1.6.0 redid Cambodia: the 1.5.0 intro's players are in 1.7.1's ground; 1.6.4 has 1.7.1's
  for (const [v, want] of [['1.5.0', 'Cambodia~20'], ['1.6.0', 'Cambodia~60'], ['1.6.4', null], ['1.2.0', null]]) {
    const r = await intro(v);
    const names = await pickMaps(r.from, r.data, maps);
    assert.equal(names.get(parseDemo(r.data).map) || null, want, v);
  }
  // a map 1.7.1 lacks: its own file, under its name
  const r = await intro('1.3.0');
  assert.deepEqual([...await pickMaps(r.from, r.data, maps)], [['htf_Mare', 'htf_Mare']]);
  // Soldat TV's own demos: as they are
  assert.equal((await pickMaps('1.7.1', demo(match()), maps)).size, 0);
});

test('a demo\'s maps are renamed in its player list, map changes and header', async () => {
  const r = await intro('1.5.0');
  const played = renameMaps(r.data, new Map([['Cambodia', 'Cambodia~20']]));
  assert.notEqual(played, r.data);
  const d = parseDemo(played);
  assert.equal(d.map, 'Cambodia~20');
  assert.equal(shownMap(d.map), 'Cambodia');
  const list = d.msgs.find((m) => m[0] === 16);
  assert.equal(String.fromCharCode(...list.subarray(3, 14)), 'Cambodia~20');
  assert.ok(setHashOk(list));
  assert.equal(new Replay(d, {}, {}).stateAt(100).state.map, 'Cambodia~20');
  // the rest is untouched
  assert.equal(played.length, r.data.length);
  assert.equal(renameMaps(r.data, new Map()), r.data);
  // a map change: its name too
  const msgs = match();
  const change = new Uint8Array(22);
  change[0] = 8;
  new DataView(change.buffer).setInt16(3, 10, true);
  change[5] = 8;
  for (let i = 0; i < 8; i++) change[6 + i] = 'Cambodia'.charCodeAt(i);
  msgs.push([110, change]);
  msgs.sort((a, b) => a[0] - b[0]);
  const out = parseDemo(renameMaps(demo(msgs), new Map([['Cambodia', 'Cambodia~60']])));
  const m = out.msgs.find((x) => x[0] === 8);
  assert.equal(String.fromCharCode(...m.subarray(6, 6 + m[5])), 'Cambodia~60');
  assert.ok(setHashOk(m));
});
