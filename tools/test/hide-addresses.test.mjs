// What viewers see of a hub's reason (relay/lib/util.mjs's hideAddresses): no server address,
// whitelisted or not; the relay's log keeps the reason as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hideAddresses } from '../../relay/lib/util.mjs';

test('a reason has no server address in it', () => {
  assert.equal(hideAddresses('udp: send EHOSTUNREACH 10.0.0.5:23073', ['10.0.0.5']), 'udp: send EHOSTUNREACH the server');
  assert.equal(hideAddresses('cannot resolve gather.example.org: getaddrinfo ENOTFOUND gather.example.org', ['gather.example.org']),
    'cannot resolve the server: getaddrinfo ENOTFOUND the server');
  // another server's address, not the hub's own
  assert.equal(hideAddresses('connect ECONNREFUSED 192.168.1.20:24073'), 'connect ECONNREFUSED the server');
  assert.equal(hideAddresses('the server does not answer', ['127.0.0.1', undefined]), 'the server does not answer');
  assert.equal(hideAddresses('server refused the spectator: 1.7.1 version mismatch'), 'server refused the spectator: 1.7.1 version mismatch');
});
