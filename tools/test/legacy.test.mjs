// Demos of older Soldat versions (web/js/spectate/legacy.js).   node --test tools/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateDemo, detectVersion } from '../../web/js/spectate/legacy.js';
import { parseDemo, Replay } from '../../web/js/spectate/replay.js';
import { match, demo, downgrade, expected, concat, spriteSnapshot, playersList } from './fake-demo.mjs';

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

test('a demo of an unknown layout is refused', async () => {
  // as 1.7.0, but its sprites in a layout of no known version
  const msgs = as('1.7.0').map(([t, m]) => [t, m[0] === 3 ? m.subarray(0, 34) : m]);
  await assert.rejects(migrateDemo(demo(msgs)), /whose demos can't be converted yet/);
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
