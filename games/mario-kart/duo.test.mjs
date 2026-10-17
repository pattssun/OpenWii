import test from 'node:test';
import assert from 'node:assert/strict';
import { Race } from './logic.js';
import { DuoLobby } from './duo-lobby.js';

const tick = (race, seconds, input = [{}, {}]) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) race.update(1 / 120, input);
};

test('two human racers retain distinct drivers, control, item edges and countdown timing', () => {
  const events = [];
  const race = new Race({ characters: ['luigi', 'mario'], humanCount: 2,
    onEvent: e => events.push(e) });
  assert.deepEqual(race.players.map(p => p.character.id), ['luigi', 'mario']);
  assert.equal(race.player, race.players[0]);
  race.start();
  tick(race, 1.0);
  tick(race, 0.8, [{}, { gas: true }]);
  tick(race, 1.21, [{ gas: true }, { gas: true }]);
  assert.equal(race.state, 'racing');
  assert.ok(events.some(e => e.type === 'rocket' && e.racer === 0));
  assert.ok(events.some(e => e.type === 'burnout' && e.racer === 1));
  tick(race, 1.2);
  race.players[0].item = 'mushroom';
  race.players[1].item = 'mushroom';
  tick(race, 1 / 120, [{ steer: -1, item: true }, { steer: 1 }]);
  assert.equal(race.players[0].item, null);
  assert.equal(race.players[1].item, 'mushroom');
  assert.ok(race.players[0].steer < 0 && race.players[1].steer > 0);
  tick(race, 1 / 120, [{}, { item: true }]);
  assert.equal(race.players[1].item, null);
  assert.deepEqual(events.filter(e => e.type === 'useItem').map(e => e.racer), [0, 1]);
});

test('first human finish keeps race active and results await all eight', () => {
  const finishes = [];
  const race = new Race({ characters: ['mario', 'luigi'], onEvent: e => {
    if (e.type === 'finish') finishes.push(e.racer);
  } });
  race.start();
  tick(race, 3.1);
  race.players[0].finishTime = race.raceTime;
  tick(race, 1 / 120);
  assert.equal(race.state, 'racing');
  assert.deepEqual(finishes, [0]);
  race.players[1].finishTime = race.raceTime;
  tick(race, 1 / 120);
  assert.equal(race.state, 'finishing');
  assert.deepEqual(finishes, [0, 1]);
  for (const cpu of race.racers.slice(2)) cpu.finishTime = race.raceTime + cpu.id;
  tick(race, 1 / 120);
  assert.equal(race.state, 'results');
});

test('lobby keeps choices distinct and gates start on both original ready phones', () => {
  const lobby = new DuoLobby();
  assert.deepEqual(lobby.characters, ['mario', 'luigi']);
  lobby.choose(0, 'right');
  assert.notEqual(lobby.characters[0], lobby.characters[1]);
  const slots = [{ occupied: true, identity: 'one' }, { occupied: true, identity: 'two' }];
  assert.equal(lobby.setReady(0, 'one', false), false);
  assert.equal(lobby.setReady(0, 'one', true), true);
  assert.equal(lobby.setReady(1, 'two', true), true);
  assert.equal(lobby.canStart(slots, [true, true]), true);
  const old = lobby.characters[1];
  assert.equal(lobby.choose(1, 'right'), false);
  assert.equal(lobby.characters[1], old);
  lobby.sync([{ occupied: false, identity: 'one' }, slots[1]], [false, true]);
  assert.equal(lobby.canStart(slots, [true, true]), false);
  assert.equal(lobby.sameParticipants([{ occupied: true, identity: 'other' }, slots[1]]), false);
});
