// The hub's director on a Soldat Reloaded server (relay/lib/reloaded/director.mjs): it reads
// the snapshots and the server's words as director.js reads 1.7.1's messages, and picks as
// it picks there. Slots are 1 to 32, a soldier's id plus one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, MAX_PLAYERS, blankSoldier } from '../../relay/lib/reloaded/wire.mjs';
import { ReloadedDirector } from '../../relay/lib/reloaded/director.mjs';

const { State, Same, Gone } = E.Snap_Word;

// a snapshot read: soldiers by id ({ team, pos, ... }), the rest as they were
function frame(soldiers, things = []) {
  const f = { word: new Array(MAX_PLAYERS).fill(Same), soldiers: [], thingWord: [], things: [] };
  for (const [id, s] of Object.entries(soldiers)) {
    if (s === null) { f.word[id] = Gone; continue; }
    f.word[id] = State;
    f.soldiers[id] = Object.assign(blankSoldier(), {
      active: true, team: s.team, 'body.pos': s.pos || [0, 0], 'body.velocity': s.vel || [0, 0],
      'vitals.health': s.health ?? 150, 'vitals.dead': !!s.dead, 'controls.buttons': s.fire ? 2 ** E.Button.Fire : 0,
    });
  }
  things.forEach((t, i) => {
    f.thingWord[i] = State;
    f.things[i] = { kind: t.kind, holder: t.holder ?? null, 'points[0]': t.pos || [0, 0] };
  });
  return f;
}

const kill = (killer, target) => ({ word: { type: 'Ruling', inner: { type: 'Kill', killer, target } } });

test('the director follows the flag carrier, and leaves out the hub and the spectators', () => {
  const d = new ReloadedDirector();
  const { Alpha, Bravo, Spectator } = E.Team;
  d.seeFrame(frame({
    0: { team: Alpha, pos: [0, 0] }, 1: { team: Bravo, pos: [3000, 0] }, 2: { team: Bravo, pos: [6000, 0] },
    5: { team: Spectator }, 8: { team: Spectator },
  }), [], 8, 0);
  assert.deepEqual([...d.teams.keys()].sort(), [1, 2, 3]);
  const first = d.pickNow(0);
  assert.ok([1, 2, 3].includes(first));
  // the Alpha flag taken by soldier 2 (slot 3): followed at once, past the hold
  d.seeFrame(frame({}, [{ kind: E.Thing_Kind.Alpha_Flag, holder: 2, pos: [6000, 0] }]), [], 8, 1500);
  assert.equal(d.flags.get(E.Thing_Kind.Alpha_Flag).holder, 3);
  assert.equal(d.pickNow(1500), 3);
});

test('a kill: the victim is dead, the killer is worth following', () => {
  const d = new ReloadedDirector();
  const { Alpha, Bravo } = E.Team;
  d.seeFrame(frame({ 0: { team: Alpha, pos: [0, 0] }, 1: { team: Bravo, pos: [5000, 3000] }, 3: { team: Bravo, pos: [9000, 0] } }), [], 31, 0);
  d.target = 1;
  d.since = 0;
  d.seeFrame(frame({}), [kill(1, 0)], 31, 5000);
  assert.equal(d.players.get(1).dead, true);
  assert.deepEqual(d.lastKill, { killer: 2, victim: 1, at: 5000 });
  // a moment on the spot, then on to the killer
  assert.equal(d.pickNow(5500), 1);
  assert.equal(d.pickNow(7000), 2);
  // gone from the server: no longer followed
  d.seeFrame(frame({ 1: null }), [], 31, 8000);
  assert.equal(d.teams.has(2), false);
  assert.notEqual(d.pickNow(8500), 2);
});
