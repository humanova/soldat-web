// the recordings kept on disk (relay/lib/recorder.mjs): with archive, none is deleted by the
// relay, however old, and one tools/archive-hf.py removed is no longer served
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRecordings } from '../../relay/lib/recorder.mjs';

test('with archive, old recordings stay until their files are gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-archive-'));
  try {
    const id = 'gather-eu-ctf-1-20200101-120000';
    const start = Date.UTC(2020, 0, 1, 12);
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, server: 'gather-eu-ctf-1', start, end: start + 600e3, bytes: 10 }));
    fs.writeFileSync(path.join(dir, id + '.sdm.gz'), 'x');
    const store = makeRecordings({ dir, keepDays: 1, maxBytes: 0, archive: true, log: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(dir, id + '.sdm.gz')));
    assert.ok(store.file(id));
    fs.rmSync(path.join(dir, id + '.sdm.gz'));
    assert.equal(store.file(id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
