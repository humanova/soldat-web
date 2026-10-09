// Demos of older Soldat versions (web/js/spectate/legacy.js).   node --test tools/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateDemo, detectVersion, FORMATS } from '../../web/js/spectate/legacy.js';
import { DEFAULT_SPREAD } from '../../web/js/spectate/legacy-formats.js';
import { SessionCipher } from '../../web/js/spectate/cipher.js';
import { parseDemo, Replay } from '../../web/js/spectate/replay.js';
import { match, demo, downgrade, expected, concat, spriteSnapshot, playersList, toFormat, gameDemo } from './fake-demo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const as = (to) => match().map(([t, m]) => [t, downgrade(m, to)]);
const want = () => demo(match().map(([t, m]) => [t, expected(m)]));
const same = (a, b) => assert.ok(Buffer.from(a).equals(Buffer.from(b)), 'the demos differ');

test('a 1.7.1 demo is left as it is', async () => {
  const file = demo(match());
  const r = await migrateDemo(file);
  assert.equal(r.from, '1.7.1');
  assert.equal(r.changed, false);
  assert.equal(r.data, file);
});

for (const v of ['1.7.0', '1.6.8']) {
  test(`a ${v} demo becomes the 1.7.1 demo of the same match`, async () => {
    const r = await migrateDemo(demo(as(v)));
    assert.equal(r.from, v);
    assert.equal(r.changed, true);
    same(r.data, want());
  });
}

test('a converted demo plays: the replay finds its players and its spectator', async () => {
  const { data } = await migrateDemo(demo(as('1.6.8')));
  const d = parseDemo(data);
  assert.equal(d.map, 'ctf_Ash');
  assert.equal(d.ticks, 130);
  const replay = new Replay(d, {}, {});
  assert.equal(replay.ownName, 'Demo Recorder');
  const { state } = replay.stateAt(100);
  assert.deepEqual([1, 2, 3].map((i) => state.roster[i] && state.roster[i].name), ['Alpha One', 'Bravo Two', 'Charlie Three']);
  assert.equal(state.vars.length, 986);
});

test('the version is told by the messages that changed', () => {
  const recs = (msgs) => msgs.map(([, m]) => m);
  assert.equal(detectVersion(recs(match())), '1.7.1');
  assert.equal(detectVersion(recs(as('1.7.0'))), '1.7.0');
  assert.equal(detectVersion(recs(as('1.6.8'))), '1.6.8');
  assert.equal(detectVersion(recs(match().map(([t, m]) => [t, toFormat(m, FORMATS.find((f) => f.key === '1.6.6'))]).filter(([, m]) => m))), '1.6.6');
  assert.equal(detectVersion([]), null);
});

test('records of several messages are split, compressed ones unpacked', async () => {
  const two = (t) => [spriteSnapshot(1, t), spriteSnapshot(2, t)].map((m) => downgrade(m, '1.7.0'));
  const msgs = as('1.7.0').filter(([t, m]) => !(m[0] === 3 && t >= 10 && t < 20));
  for (let t = 10; t < 15; t++) msgs.push([t, two(t)]);
  for (let t = 15; t < 20; t++) msgs.push([t, concat([Uint8Array.of(0xFF), zlib.deflateSync(concat(two(t)))])]);
  msgs.sort((a, b) => a[0] - b[0]);
  const r = await migrateDemo(demo(msgs));
  assert.equal(r.from, '1.7.0');
  assert.match(r.notes.join(' '), /5 compressed records unpacked/);
  assert.match(r.notes.join(' '), /10 records of several messages split/);
  same(r.data, want());
});

test('an old demo\'s messages get check values the game accepts', async () => {
  // the old game played its demos without checking them; 1.7.1 drops a message that fails
  const msgs = as('1.7.0').map(([t, m]) => [t, m[0] === 6 ? Uint8Array.from(m, (b, i) => (i === 1 ? b ^ 0xFF : b)) : m]);
  const r = await migrateDemo(demo(msgs));
  same(r.data, want());
});

test('a player list with its game mode in clear is encrypted', async () => {
  const msgs = match({ clearList: true });
  const r = await migrateDemo(demo(msgs));
  assert.equal(r.changed, true);
  assert.match(r.notes.join(' '), /in clear: encrypted/);
  same(r.data, demo(match()));
  assert.deepEqual(Buffer.from(playersList()), Buffer.from(parseDemo(r.data).msgs[0]));
});

// what the conversion of the match recorded with an older version gives: [tick, message]
// of the converted demo, by message ID
function converted(data) {
  const d = parseDemo(data);
  const by = new Map();
  d.msgs.forEach((m, i) => {
    if (!by.has(m[0])) by.set(m[0], []);
    by.get(m[0]).push([d.at[i], m, new DataView(m.buffer, m.byteOffset, m.byteLength)]);
  });
  return { d, by, at: (id, tick) => (by.get(id) || []).find(([t]) => t === tick) };
}

for (const fmt of FORMATS.filter((f) => f.key !== '1.7.1')) {
  test(`the game's demo of ${fmt.name} plays as the same match`, async () => {
    const msgs = match().map(([t, m]) => [t, toFormat(m, fmt)]).filter(([, m]) => m);
    const r = await migrateDemo(gameDemo(msgs, fmt.hashed));
    assert.equal(r.from, fmt.key);
    assert.equal(r.changed, true);
    const { d, by, at } = converted(r.data);
    assert.equal(d.map, 'ctf_Ash');
    assert.equal(d.ticks, 130);
    const old = !fmt.hashed;  // up to 1.6.3: no ServerTicks
    // the player list: encrypted as 1.7.1 wants it, its game mode and names kept
    const list = by.get(16)[0][1].slice();
    new SessionCipher(list[2134] | (list[2135] << 8)).fields(list, [[1580, 4], [19, 1], [1584, 4]], true);
    assert.equal(list[19], 3);
    assert.ok(Math.abs(new DataView(list.buffer).getFloat32(1584, true) - 0.06) < 1e-6);
    const replay = new Replay(d, {}, {});
    assert.deepEqual([1, 2, 3].map((i) => replay.stateAt(100).state.roster[i]?.name), ['Alpha One', 'Bravo Two', 'Charlie Three']);
    // a snapshot: where the player was, health and vest, the weapons by 1.7.1's numbers
    const [, , s] = at(3, 50).length ? at(3, 50) : [];
    assert.equal(s.getFloat32(4, true), 150);
    assert.equal(s.getFloat32(12, true), fmt.key === '1.4.1' ? 0 : 1.5);
    assert.deepEqual([s.getFloat32(25, true), s.getFloat32(29, true), s.getUint8(35), s.getUint8(36)], [25, 150, 3, 11]);
    assert.equal(s.getInt32(37, true), old ? 50 : 5050);
    // bullets and weapons
    assert.deepEqual([at(5, 40)[1][3], at(5, 40)[1][4]], [1, 3]);
    assert.deepEqual([at(5, 42)[1][3], at(5, 42)[1][4]], [2, 11]);
    assert.deepEqual([...at(25, 41)[1].subarray(3, 7)], [2, 14, 12, 9]);
    const mv = at(21, 43)[2];
    assert.deepEqual([mv.getFloat32(4, true), mv.getUint16(20, true), mv.getUint8(22), mv.getInt32(23, true)], [343, 0x11, 90, old ? 43 : 5043]);
    assert.deepEqual([...at(37, 44)[1].subarray(3, 6)], [1, 2, 0]);
    // a death
    const death = at(13, 90)[2];
    assert.deepEqual([death.getUint8(3), death.getUint8(4), death.getFloat32(264, true)], [2, 1, -40]);
    assert.equal(death.getUint8(7), ['1.4.2', '1.4.1', '1.3.1', '1.2.1'].includes(fmt.key) ? 0 : 5);
    assert.equal(death.getFloat32(271, true), fmt.key === '1.2.1' ? 0 : 345.5);
    // the scores: two players, alpha's 2, no map id
    const hb = at(2, 60)[1];
    assert.deepEqual([...hb.subarray(3, 10)], [0, 0, 0, 0, 1, 1, 0]);
    assert.equal(hb[231] | (hb[232] << 8), 2);
    // the weapons' settings in 1.7.1's order (1.2.1 sent none)
    if (fmt.key === '1.2.1') assert.equal(by.get(52), undefined);
    else {
      const v = by.get(52)[0][2];
      assert.deepEqual(Array.from({ length: 20 }, (_, i) => Math.round(v.getFloat32(12 + i * 4, true) * 10)), Array.from({ length: 20 }, (_, i) => 10 + i));
      assert.deepEqual(Array.from({ length: 20 }, (_, i) => v.getUint8(92 + i)), Array.from({ length: 20 }, (_, i) => 10 + i));
      assert.ok(Math.abs(v.getFloat32(732, true) - 1.15) < 1e-6);
      assert.deepEqual(Array.from({ length: 20 }, (_, i) => Math.round(v.getFloat32(372 + i * 4, true) * 200)), Array.from({ length: 20 }, (_, i) => i));
      if (old) assert.ok(Math.abs(v.getFloat32(452, true) - DEFAULT_SPREAD[0]) < 1e-6);
    }
    assert.equal(String.fromCharCode(...at(6, 100)[1].subarray(4, 7)), ' gg');
    // SpecialMessage got its layer in 1.6.8; up to 1.6.3 its layout is not known: left out
    if (fmt.hashed) assert.deepEqual([...at(64, 101)[1].subarray(3, 6), String.fromCharCode(...at(64, 101)[1].subarray(25, 32))], [1, 0, 0x2C, 'Round 2']);
    else assert.equal(at(64, 101), undefined);
  });
}

test('an encrypted player list of 1.5 is read with 1.5\'s key', async () => {
  // 1.5 (soldatserver 2.6.5): '\xA7' + IntToStr(SessionID + $B37B1); MapID 1462, GameStyle 17,
  // Gravity 1466 and a word at 1470 encrypted, SessionID at 1506
  const fmt = FORMATS.find((f) => f.key === '1.5.0');
  const msgs = match().map(([t, m]) => [t, toFormat(m, fmt)]).filter(([, m]) => m);
  const list = msgs.find(([, m]) => m[0] === 16)[1];
  const sid = list[1506] | (list[1507] << 8);
  new SessionCipher(sid, '\xA7', 0xB37B1).fields(list, [[1462, 4], [17, 1], [1466, 4], [1470, 2]]);
  assert.notEqual(list[17], 3);
  const r = await migrateDemo(gameDemo(msgs, false));
  assert.ok(!r.notes.some((n) => /clear|could not/.test(n)), r.notes.join(' '));
  const out = converted(r.data).by.get(16)[0][1].slice();
  new SessionCipher(out[2134] | (out[2135] << 8)).fields(out, [[1580, 4], [19, 1], [1584, 4]], true);
  assert.equal(out[19], 3);
});

test('weapons 11 to 16 had other numbers before 1.6.8', async () => {
  // knife, chainsaw, LAW were 14, 15, 16; flamer, bow, flamed arrows 11, 12, 13
  const { OLD_WEAPON_NUM } = await import('../../web/js/spectate/legacy-formats.js');
  assert.deepEqual([0, 1, 10, 11, 12, 13, 14, 15, 16, 30, 50, 255].map(OLD_WEAPON_NUM), [0, 1, 10, 14, 15, 16, 11, 12, 13, 30, 50, 255]);
});

test('the game\'s demo of 1.7.1 gets a header and stays the same', async () => {
  const r = await migrateDemo(gameDemo(match(), true));
  assert.equal(r.from, '1.7.1');
  assert.equal(r.changed, true);
  const want = demo(match());
  new DataView(want.buffer).setInt32(172, 0, true);  // no date
  same(r.data, want);
});

// The demos the games came with (intro.sdm): set SOLDAT_DEMOS to a folder of them, named
// intro-<version>.sdm (as 1.2.1 to 1.6.9 shipped them: 121 131 141 142 15 160 164 166 167 169).
const INTROS = { 121: '1.2.1', 131: '1.3.1', 141: '1.4.1', 142: '1.4.2', 15: '1.5.0', 160: '1.6.0', 164: '1.6.4', 166: '1.6.6', 167: '1.6.8', 169: '1.7.0' };
const STYLES = [1, 1, 1, 1, 3, 1, 4, 1, 1, 1, 1, 11, 11, 12, 8, 7, 5, 14, 6, 2];
test('the games\' own demos convert', { skip: !process.env.SOLDAT_DEMOS && 'set SOLDAT_DEMOS to a folder of intro demos' }, async () => {
  for (const [v, key] of Object.entries(INTROS)) {
    const file = path.join(process.env.SOLDAT_DEMOS, `intro-${v}.sdm`);
    if (!fs.existsSync(file)) continue;
    const r = await migrateDemo(new Uint8Array(fs.readFileSync(file)));
    assert.equal(r.from, key, file);
    assert.ok(!r.notes.some((n) => /left out/.test(n)), r.notes.join(' '));
    const { d, by } = converted(r.data);
    assert.ok(d.ticks > 1000 && d.msgs.length > 10000);
    if (key !== '1.2.1') assert.deepEqual([...by.get(52)[0][1].subarray(232, 252)], STYLES, file);
    const replay = new Replay(d, {}, {});
    assert.ok(replay.stateAt(600).state.roster.filter(Boolean).length > 5, file);
    // these matches were fought with chainsaws a lot: chainsaw (12) bullets, no bow (15) ones
    if (['1.4.2', '1.6.4', '1.6.6'].includes(key)) {
      const bullets = by.get(5).map(([, m]) => m[4]);
      assert.ok(bullets.filter((w) => w === 12).length > 100 && !bullets.includes(15), file);
    }
  }
});

test('a demo of an unknown layout is refused', async () => {
  // as 1.7.0, but its sprites in a layout of no known version
  const msgs = as('1.7.0').map(([t, m]) => [t, m[0] === 3 ? m.subarray(0, 34) : m]);
  await assert.rejects(migrateDemo(demo(msgs)), /whose demos can't be converted/);
});

test('no Soldat demo: nothing to do', async () => {
  const r = await migrateDemo(new Uint8Array(500));
  assert.equal(r.from, null);
  assert.equal(r.changed, false);
});

test('the command line tool converts files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demos-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.sdm'), demo(as('1.6.8')));
    fs.writeFileSync(path.join(dir, 'new.sdm.gz'), zlib.gzipSync(demo(match())));
    const out = execFileSync(process.execPath, [path.join(here, '..', 'migrate-demo.mjs'),
      path.join(dir, 'old.sdm'), path.join(dir, 'new.sdm.gz')], { encoding: 'utf8' });
    assert.match(out, /old-171\.sdm: Recorded with Soldat 1\.6\.8: \d+ messages in Soldat 1\.7\.1's layout/);
    assert.match(out, /new\.sdm\.gz: Soldat 1\.7\.1, nothing to change/);
    same(fs.readFileSync(path.join(dir, 'old-171.sdm')), want());
    assert.ok(!fs.existsSync(path.join(dir, 'new-171.sdm')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
