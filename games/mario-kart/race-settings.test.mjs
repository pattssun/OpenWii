import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLaps } from './race-settings.js';
import { Race } from './logic.js';
import { lapBoard } from './hud-lettering.js';

test('lap counts accept every integer from 1 to 20 and sanitize stored/input values', () => {
  for(let laps=1;laps<=20;laps++) assert.equal(new Race({laps}).laps,laps);
  for(const value of [null,undefined,'',NaN,Infinity,'invalid']) assert.equal(normalizeLaps(value),3);
  assert.equal(normalizeLaps('12'),12);
  assert.equal(normalizeLaps(0),1);
  assert.equal(normalizeLaps(21),20);
  assert.equal(normalizeLaps(5.9),5);
});

test('custom two and five lap races finish only after the configured gates', () => {
  for(const laps of [2,5]) {
    const events=[],race=new Race({seed:90,laps,onEvent:e=>events.push(e)});
    race.start();
    for(let i=0;i<60000 && race.player.finishTime===null;i++) race.update(1/120,race.cpuInput(race.player));
    assert.notEqual(race.player.finishTime,null);
    assert.equal(race.player.checkpoints,laps*8);
    assert.equal(race.player.lap,laps);
    assert.equal(events.filter(e=>e.type==='finalLap' && e.racer===0).length,1);
    assert.equal(events.filter(e=>e.type==='finish' && e.racer===0).length,1);
  }
});

test('lap sign artwork handles arbitrary configured lap counters including two digits', () => {
  for(const [lap,total] of [[2,2],[4,5],[10,20],[20,20]]) {
    const svg=lapBoard(lap,total);
    assert.ok(svg.includes(`aria-label="Lap ${lap} of ${total}"`));
    assert.doesNotMatch(svg,/undefined|NaN/);
  }
});
