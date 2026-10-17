import test from 'node:test';
import assert from 'node:assert/strict';
import { Race } from './logic.js';
import { DuoLobby } from './duo-lobby.js';

const tick = (race, seconds, input = [{}, {}]) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) race.update(1 / 120, input);
};

test('P2 may finish first without ending P1 race or admitting a replacement input', () => {
  const events = [];
  const race = new Race({ characters: ['mario', 'peach'], humanCount: 2,
    onEvent: event => events.push(event) });
  race.start();
  tick(race, 3.05);
  const p2 = race.players[1];
  p2.finishTime = race.raceTime;
  tick(race, 1 / 120, [{ gas: true, steer: -0.4 }, { gas: true, steer: 0.9 }]);
  assert.equal(race.state, 'racing');
  assert.deepEqual(events.filter(event => event.type === 'finish').map(event => event.racer), [1]);
  assert.equal(p2.lastInput.gas, true);
  assert.notEqual(p2.steer, race.players[0].steer,
    'P2 input remains distinct even when P2 has entered its finish animation');
  race.players[0].finishTime = race.raceTime;
  tick(race, 1 / 120);
  assert.equal(race.state, 'finishing');
  assert.deepEqual(events.filter(event => event.type === 'finish').map(event => event.racer), [1, 0]);
  for (const cpu of race.racers.slice(2)) cpu.finishTime = race.raceTime + cpu.id;
  tick(race, 1 / 120);
  assert.equal(race.state, 'results');
});

test('two human racers complete one shared race through real finish gates', () => {
  const events = [];
  const race = new Race({ seed: 411, laps: 1, characters: ['mario', 'peach'], humanCount: 2,
    onEvent: event => events.push(event) });
  race.start();
  for (let frame = 0; frame < 36000 && race.state !== 'results'; frame++) {
    const inputs = race.players.map(player => race.cpuInput(player));
    race.update(1 / 120, inputs);
  }
  assert.equal(race.state, 'results', 'both humans and all six CPUs should finish');
  assert.ok(race.players.every(player => player.finishTime !== null));
  assert.equal(events.filter(event => event.type === 'finish' && event.racer < 2).length, 2,
    'each human finish should be announced once');
  assert.equal(events.filter(event => event.type === 'results').length, 1);
});

test('lobby rejects invalid slots, unarmed readiness, and a replacement participant', () => {
  const lobby = new DuoLobby();
  const slots = [
    { occupied: true, identity: 'phone-one' },
    { occupied: true, identity: 'phone-two' },
  ];
  assert.equal(lobby.choose(2, 'right'), false);
  assert.equal(lobby.choose(-1, 'left'), false);
  assert.equal(lobby.setReady(0, 'phone-one', false), false);
  assert.equal(lobby.setReady(0, 'phone-one', true), true);
  assert.equal(lobby.setReady(1, 'phone-two', true), true);
  assert.equal(lobby.canStart(slots, [true, true]), true);
  const replacement = [{ occupied: true, identity: 'replacement-phone' }, slots[1]];
  lobby.sync(replacement, [true, true]);
  assert.equal(lobby.ready[0], false);
  assert.equal(lobby.sameParticipants(replacement), false);
  assert.equal(lobby.canStart(replacement, [true, true]), false);
});
