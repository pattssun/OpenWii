import test from 'node:test';
import assert from 'node:assert/strict';
import { FruitNinja, FIELD_H } from './logic.js';

/**
 * The eight mechanics that had to survive the 2D→3D port.
 *
 * These are the same eight behaviours the 2D build was verified against. The
 * coordinate literals differ because the units changed from window pixels to
 * world units — the assertions did not.
 */

/** A game with spawning suppressed, so tests control the board exactly. */
function game() {
  const g = new FruitNinja({ aspect: 16 / 9 });
  g.start(0);
  g.state.nextSpawn = Infinity;
  return g;
}

function put(g, x, y, bomb = false) {
  g.fruits.push({
    x, y, vx: 0, vy: 0, r: 0.65, rot: 0, spin: 0,
    spinAxis: { x: 0, y: 1, z: 0 }, bomb, kind: { rind: 0, flesh: 0 }, id: 1,
  });
  return g.fruits[g.fruits.length - 1];
}

/** Sweep the pointer across the field, stepping the real update loop. */
function sweep(g, x0, x1, y, steps, dtMs, clock) {
  for (let i = 0; i <= steps; i += 1) {
    clock.t += dtMs;
    g.setCursor(x0 + ((x1 - x0) * i) / steps, y, clock.t);
    g.state.nextSpawn = Infinity;
    g.update(clock.t, dtMs / 1000);
  }
}

test('a fast slash slices the fruit into two halves with juice', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.fruits.length, 0, 'fruit consumed');
  assert.equal(g.halves.length, 2, 'two halves');
  assert.ok(g.particles.length > 0, 'juice particles');
  assert.ok(g.state.score > 0, 'scored');
});

test('a slow drag through a fruit does not slice it', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  // 0.02 world units per 16ms = 1.25 u/s, well under MIN_SLICE_SPEED (3.25).
  sweep(g, -0.1, 0.1, 0, 10, 16, clock);
  assert.equal(g.fruits.length, 1, 'fruit survives');
  assert.equal(g.state.score, 0, 'no score');
});

test('a fast slash that misses does not slice', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  sweep(g, -3, 3, 3.5, 5, 16, clock);   // same speed, far above the fruit
  assert.equal(g.fruits.length, 1, 'fruit survives');
  assert.equal(g.state.score, 0, 'no score');
});

test('slicing two fruits in one swipe pays a combo bonus', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, -1.2, 0);
  put(g, 1.2, 0);
  sweep(g, -4, 4, 0, 6, 16, clock);
  assert.equal(g.state.combo, 2, 'combo counted');
  // 1 for the first + (1 + 2) for the second = 4, vs 2 with no bonus.
  assert.ok(g.state.score >= 3, `combo bonus applied (got ${g.state.score})`);
});

test('slicing a bomb ends the game', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0, true);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.state.phase, 'over', 'game over');
  assert.ok(g.particles.length > 50, 'explosion');
});

test('a bomb that falls off the bottom costs nothing', () => {
  const g = game();
  const f = put(g, 0, -FIELD_H / 2 - 2, true);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 3, 'lives untouched');
  assert.equal(g.state.phase, 'playing', 'still playing');
  assert.equal(g.fruits.length, 0, 'bomb removed');
});

test('a fruit that falls off the bottom costs a life', () => {
  const g = game();
  const f = put(g, 0, -FIELD_H / 2 - 2);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 2, 'one life lost');
  assert.equal(g.fruits.length, 0, 'fruit removed');
});

test('losing the last life ends the game', () => {
  const g = game();
  g.state.lives = 1;
  const f = put(g, 0, -FIELD_H / 2 - 2);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 0);
  assert.equal(g.state.phase, 'over', 'game over');
});
