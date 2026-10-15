import test from 'node:test';
import assert from 'node:assert/strict';
import { Race } from './logic.js';
import { DuoLobby } from './duo-lobby.js';
import { splitViewport } from './split-viewport.js';

const slots = ['red', 'blue', 'green', 'yellow'].map(identity => ({ occupied: true, identity }));
const tick = (race, seconds, inputs = [{}, {}, {}, {}]) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) race.update(1 / 120, inputs);
};

test('four-driver lobby makes bounded distinct choices and requires the four original live phones', () => {
  const lobby = new DuoLobby(4);
  assert.deepEqual(lobby.characters, ['mario', 'luigi', 'peach', 'yoshi']);
  assert.equal(lobby.choose(0, 'down'), true);
  assert.equal(new Set(lobby.characters).size, 4);
  // Put a rival on the sole vertical alternative. The search must terminate
  // and pick another free character instead of cycling through two entries.
  lobby.characters = ['mario', 'toad', 'peach', 'yoshi'];
  assert.equal(lobby.choose(0, 'down'), true);
  assert.notEqual(lobby.characters[0], 'mario');
  assert.equal(new Set(lobby.characters).size, 4);
  for (let i = 0; i < 4; i++) assert.equal(lobby.setReady(i, slots[i].identity, true), true);
  assert.equal(lobby.canStart(slots, [true, true, true, true]), true);
  assert.equal(lobby.canStart(slots, [true, true, false, true]), false);
  assert.equal(lobby.sameParticipants([slots[0], slots[1], {...slots[2], identity: 'replacement'}, slots[3]]), false);
  lobby.sync([slots[0], slots[1], {...slots[2], occupied: false}, slots[3]], [true, true, false, true]);
  assert.equal(lobby.ready[2], false);
  assert.equal(lobby.canStart(slots, [true, true, true, true]), false);
});

test('four human inputs, item edges, countdown boosts and finish state are independent', () => {
  const events = [];
  const race = new Race({ characters: ['mario', 'luigi', 'peach', 'yoshi'], humanCount: 4,
    onEvent: event => events.push(event) });
  assert.equal(race.humanCount, 4);
  assert.equal(race.racers.length, 8);
  assert.equal(new Set(race.players.map(p => p.character.id)).size, 4);
  race.start();
  tick(race, 1.0);
  tick(race, 0.8, [{}, {gas:true}, {}, {}]);
  tick(race, 1.21, [{gas:true}, {gas:true}, {gas:true}, {}]);
  assert.equal(race.state, 'racing');
  assert.deepEqual(events.filter(e => e.type === 'rocket').map(e => e.racer), [0, 2]);
  assert.deepEqual(events.filter(e => e.type === 'burnout').map(e => e.racer), [1]);
  tick(race, 1.2);
  for (const player of race.players) player.item = 'mushroom';
  tick(race, 1 / 120, [{steer:-1}, {steer:1,item:true}, {steer:-1}, {steer:1,item:true}]);
  assert.deepEqual(race.players.map(p => p.item), ['mushroom', null, 'mushroom', null]);
  assert.ok(race.players[0].steer < 0 && race.players[1].steer > 0);
  assert.deepEqual(events.filter(e => e.type === 'useItem').map(e => e.racer), [1, 3]);
  for (let i = 0; i < 3; i++) {
    race.players[i].finishTime = race.raceTime;
    tick(race, 1 / 120);
    assert.equal(race.state, 'racing');
  }
  race.players[3].finishTime = race.raceTime;
  tick(race, 1 / 120);
  assert.equal(race.state, 'finishing');
  for (const cpu of race.racers.slice(4)) cpu.finishTime = race.raceTime + cpu.id;
  tick(race, 1 / 120);
  assert.equal(race.state, 'results');
  assert.deepEqual(events.filter(e => e.type === 'finish').map(e => e.racer), [0, 1, 2, 3]);
});

test('four WebGL viewports tile odd dimensions in HUD order', () => {
  const views = Array.from({length:4}, (_, i) => splitViewport(1919, 1079, 'quad', i));
  assert.deepEqual(views, [
    {x:0,y:539,width:959,height:540},
    {x:959,y:539,width:960,height:540},
    {x:0,y:0,width:959,height:539},
    {x:959,y:0,width:960,height:539},
  ]);
  assert.equal(views.reduce((sum, view) => sum + view.width * view.height, 0), 1919 * 1079);
  assert.deepEqual(splitViewport(1919, 1079, 'duo', 1), {x:959,y:0,width:960,height:1079});
});
