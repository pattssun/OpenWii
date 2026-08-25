import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Range, pointsFor, FIELD_W, FIELD_H, ROUND_MS, R_MIN, R_MAX, MAX_ALIVE,
  TARGET_TTL_MS,
} from './logic.js';
import { mulberry32 } from '../alien-attack/logic.js';

// S1 — hit geometry. Distances are laid out by hand around a known target.
test('S1: a shot inside the radius destroys the target, outside misses', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(3) });
  r.start(0);
  const t = r.spawn(0);
  // Just inside, on the rim diagonal: offset r/√2 − ε in each axis.
  const inside = t.r / Math.SQRT2 - 1e-4;
  assert.equal(r.shoot(t.x + inside, t.y + inside, 10).hit, true);
  assert.equal(r.targets.length, 0, 'the hit target is gone');

  const t2 = r.spawn(20);
  const outside = t2.r + 1e-4;
  assert.equal(r.shoot(t2.x + outside, t2.y, 30).hit, false);
  assert.equal(r.targets.length, 1, 'a miss leaves the target standing');
  assert.equal(r.shots, 2);
  assert.equal(r.hits, 1);
});

test('S1: overlapping targets — the shot takes the one nearest its centre', () => {
  const r = new Range({ rng: mulberry32(5) });
  r.start(0);
  const a = r.spawn(0);
  const b = r.spawn(0);
  // Force a known overlap regardless of rng: put b right next to a.
  b.x = a.x + 0.02;
  b.y = a.y;
  const res = r.shoot(b.x + 0.005, b.y, 10);
  assert.equal(res.hit, true);
  assert.equal(res.target.id, b.id, 'nearest centre wins');
});

// S2 — smaller targets score more, by the published formula.
test('S2: points scale from 10 (biggest) to 50 (smallest)', () => {
  // Derived here from the spec: linear in radius between the two endpoints.
  assert.equal(pointsFor(R_MAX), 10);
  assert.equal(pointsFor(R_MIN), 50);
  const mid = (R_MIN + R_MAX) / 2;
  assert.equal(pointsFor(mid), 30);
  assert.ok(pointsFor(R_MIN + 0.01) > pointsFor(R_MAX - 0.01));
});

test('S2: targets spawn inside the field at varied positions and sizes', () => {
  const r = new Range({ rng: mulberry32(42) });
  r.start(0);
  const seen = [];
  for (let i = 0; i < 40; i += 1) seen.push(r.spawn(i));
  for (const t of seen) {
    assert.ok(t.x - t.r >= 0 && t.x + t.r <= FIELD_W, 'inside horizontally');
    assert.ok(t.y - t.r >= 0 && t.y + t.r <= FIELD_H, 'inside vertically');
    assert.ok(t.r >= R_MIN && t.r <= R_MAX);
  }
  const rs = new Set(seen.map((t) => t.r.toFixed(3)));
  const xs = new Set(seen.map((t) => t.x.toFixed(2)));
  assert.ok(rs.size > 10, 'sizes vary');
  assert.ok(xs.size > 10, 'positions vary');
});

// S3 — the 60-second round: totals must match an independent tally.
test('S3: the round ends at 60s with score, shots, hits and accuracy', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(9) });
  r.start(0);
  let tally = 0;
  let hits = 0;
  let shots = 0;
  for (let now = 0; now <= ROUND_MS + 100; now += 50) {
    r.update(now);
    // A workmanlike marksman: every 400ms, shoot the oldest target dead-centre;
    // every 2s, deliberately fire into an empty corner.
    if (now % 400 === 0 && r.state === 'running' && r.targets.length) {
      const t = r.targets[0];
      const res = r.shoot(t.x, t.y, now);
      shots += 1;
      if (res.hit) { hits += 1; tally += pointsFor(res.target.r); }
    }
    if (now % 2000 === 0 && r.state === 'running') {
      const res = r.shoot(0.001, 0.001, now);
      shots += 1;
      if (res.hit) { hits += 1; tally += pointsFor(res.target.r); }
    }
  }
  assert.equal(r.state, 'done');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.score, tally, 'score equals the independent tally');
  assert.equal(done.shots, shots);
  assert.equal(done.hits, hits);
  assert.ok(Math.abs(done.accuracy - hits / shots) < 1e-12);
  assert.ok(done.hits > 20, `the marksman actually hit things (${done.hits})`);
});

test('S3: A restarts a finished round from zero', () => {
  const r = new Range({ rng: mulberry32(1) });
  r.start(0);
  for (let now = 0; now <= ROUND_MS + 100; now += 100) r.update(now);
  assert.equal(r.state, 'done');
  r.start(ROUND_MS + 5000);
  assert.equal(r.state, 'running');
  assert.equal(r.score, 0);
  assert.equal(r.shots, 0);
  assert.equal(r.targets.length, 0);
});

test('housekeeping: targets expire on TTL and the field never overfills', () => {
  const r = new Range({ rng: mulberry32(7) });
  r.start(0);
  let maxAlive = 0;
  for (let now = 0; now <= 30_000; now += 50) {
    r.update(now);
    maxAlive = Math.max(maxAlive, r.targets.length);
    for (const t of r.targets) assert.ok(now < t.expiresMs, 'no zombie targets');
  }
  assert.ok(maxAlive <= MAX_ALIVE);
  assert.ok(maxAlive >= 3, 'the gallery actually fills up');
  // A lone target dies exactly TTL after birth.
  const solo = new Range({ rng: mulberry32(2) });
  solo.start(0);
  const t = solo.spawn(0);
  solo.update(TARGET_TTL_MS - 1);
  assert.ok(solo.targets.includes(t), 'alive just before TTL');
  solo.update(TARGET_TTL_MS + 1);
  assert.ok(!solo.targets.includes(t));
});

test('shots after the buzzer do nothing', () => {
  const r = new Range({ rng: mulberry32(4) });
  r.start(0);
  const t = r.spawn(100);
  for (let now = 0; now <= ROUND_MS + 100; now += 100) r.update(now);
  const res = r.shoot(t.x, t.y, ROUND_MS + 200);
  assert.equal(res.hit, false);
  assert.equal(r.shots, 0, 'the trigger is dead after time');
});
