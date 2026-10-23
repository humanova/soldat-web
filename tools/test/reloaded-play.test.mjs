// A Soldat Reloaded game in the browser played through the play relay
// (relay/lib/reloaded/play.mjs): each message on its kind's channel, a signed-in player's
// hardware id in their Hello whatever the page put there, and nothing that isn't a message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, parse, buildClientState, blankSoldier, E, VERSION } from '../../relay/lib/reloaded/wire.mjs';
import { outgoing } from '../../relay/lib/reloaded/play.mjs';

const LOOK = {
  gostek: 0, shirt: [1, 2, 3, 255], pants: [4, 5, 6, 255], skin: [7, 8, 9, 255], hair: [0, 0, 0, 255],
  jet: [255, 255, 0, 255], hair_style: 0, hair_custom: 0, head_style: 0, chain_style: 0, eyewear: 0,
};
const hello = (hwid) => build('Hello', {
  version: VERSION, name: 'Major', password: '', look: LOOK, primary: E.Weapon.AK74, secondary: E.Weapon.USSOCOM, hwid,
});

test('a Hello carries the signed-in account\'s hardware id, and goes reliably', () => {
  const out = outgoing(hello('PAGE-CHOSEN'), 'ABCDEF12345');
  assert.equal(out.reliable, true);
  assert.equal(out.channel, 1);
  const body = parse(out.data).body;
  assert.equal(body.hwid, 'ABCDEF12345');
  assert.equal(body.name, 'Major');
  // without sign-in it goes as the page sent it
  const plain = outgoing(hello('PAGE-CHOSEN'));
  assert.equal(parse(plain.data).body.hwid, 'PAGE-CHOSEN');
});

test('the client\'s state goes unreliably, chat reliably, and junk not at all', () => {
  const state = buildClientState({ round: 1, seq: 1, ack: 0, eventAck: 0, life: 0 }, blankSoldier());
  assert.deepEqual([outgoing(state).channel, outgoing(state).reliable], [0, false]);
  const chat = build('Chat', { slot: 3, name: 'Major', team: false, taunt: false, kind: 0, text: '/team 1' });
  assert.deepEqual([outgoing(chat).channel, outgoing(chat).reliable], [1, true]);
  assert.equal(outgoing(Buffer.from([0])), null);
  assert.equal(outgoing(hello('X').subarray(0, 3), 'ABCDEF12345'), null);
});
