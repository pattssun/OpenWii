import test from 'node:test';
import assert from 'node:assert/strict';
import slotsModule from '../phone-slots.js';

const { PhoneSlots } = slotsModule;
test('phone identity reclaims its slot and another phone cannot take it', () => {
  const slots = new PhoneSlots(2);
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert.equal(slots.assign('socket-a', a), 0);
  assert.equal(slots.assign('socket-b', b), 1);
  assert.equal(slots.assign('duplicate', a), -1);
  slots.release('socket-a');
  assert.equal(slots.assign('intruder', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), -1);
  assert.equal(slots.assign('reconnected-a', a), 0);
  assert.equal(slots.socketAt(0), 'reconnected-a');
  assert.equal(slots.presence()[0].occupied, true);
  assert.notEqual(slots.presence()[0].identity, a);
});

test('legacy registration uses free slots without permanent reservation', () => {
  const slots = new PhoneSlots(1);
  assert.equal(slots.assign('legacy'), 0);
  slots.release('legacy');
  assert.equal(slots.assign('new-legacy'), 0);
});
