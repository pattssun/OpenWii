import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Range, pointsFor, FIELD_W, FIELD_H, ROUND_MS, MAX_ALIVE,
  NORMAL_R_MIN, NORMAL_R_MAX, GOLD_R_MIN, GOLD_R_MAX, BOMB_R,
  GOLD_POINTS, BOMB_PENALTY, GOLD_SWAY_HZ, TARGET_TTL_MS,
  SPAWN_COLS, SPAWN_ROWS, SPAWN_X0, SPAWN_X1, SPAWN_Y0, SPAWN_Y1,
} from './logic.js';
import { mulberry32 } from '../alien-attack/logic.js';

/** Spawn until the rigged rng yields a target of the wanted kind. */
function spawnKind(range, kind, now = 0) {
  for (let i = 0; i < 200; i += 1) {
    const t = range.spawn(now);
    if (t.kind === kind) return t;
    range.targets.pop();              // discard the wrong kind
  }
  throw new Error(`no ${kind} in 200 spawns`);
}

// S1 — hit geometry, unchanged by the type system.
test('S1: a shot inside the radius destroys the target, outside misses', () => {
  const r = new Range({ rng: mulberry32(3) });
  r.start(0);
  const t = spawnKind(r, 'normal');
  const inside = t.r / Math.SQRT2 - 1e-4;
  assert.equal(r.shoot(t.x + inside, t.y + inside, 10).hit, true);
  assert.equal(r.targets.length, 0, 'the hit target is gone');

  const t2 = spawnKind(r, 'normal', 20);
  assert.equal(r.shoot(t2.x + t2.r + 1e-4, t2.y, 30).hit, false);
  assert.equal(r.targets.length, 1, 'a miss leaves the target standing');
  assert.equal(r.shots, 2);
  assert.equal(r.hits, 1);
});

// S2 — the three types: sizes, movement, and what they pay.
test('S2: normal targets are big and pay 10..30 by size', () => {
  assert.equal(pointsFor(NORMAL_R_MAX), 10);
  assert.equal(pointsFor(NORMAL_R_MIN), 30);
  const r = new Range({ rng: mulberry32(11) });
  r.start(0);
  for (let i = 0; i < 30; i += 1) {
    const t = spawnKind(r, 'normal');
    assert.ok(t.r >= NORMAL_R_MIN && t.r <= NORMAL_R_MAX);
    const res = r.shoot(t.x, t.y, 10);
    assert.equal(res.points, pointsFor(t.r));
  }
});

test('S2: gold targets are small, drift on a sway, and pay GOLD_POINTS', () => {
  const r = new Range({ rng: mulberry32(7) });
  r.start(0);
  const t = spawnKind(r, 'gold');
  assert.ok(t.r >= GOLD_R_MIN && t.r <= GOLD_R_MAX, 'small');
  assert.ok(t.swayAmp > 0, 'it moves');

  // The drift is the documented sine: verify against an independent
  // computation at several times, and confirm it stays inside the field.
  for (const ms of [0, 400, 900, 1600]) {
    r.update(t.bornMs + ms);
    const expected = t.x0
      + Math.sin(t.phase + (ms / 1000) * GOLD_SWAY_HZ * Math.PI * 2) * t.swayAmp;
    assert.ok(Math.abs(t.x - expected) < 1e-12, `position at +${ms}ms`);
    assert.ok(t.x - t.r >= 0 && t.x + t.r <= FIELD_W, 'stays in the field');
  }
  const res = r.shoot(t.x, t.y, 1600);
  assert.equal(res.points, GOLD_POINTS);
  assert.equal(r.score, GOLD_POINTS);
});

test('S2: shooting a bomb subtracts BOMB_PENALTY, floored at zero', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(5) });
  r.start(0);
  const b1 = spawnKind(r, 'bomb');
  assert.equal(b1.r, BOMB_R);
  const res = r.shoot(b1.x, b1.y, 10);
  assert.equal(res.kind, 'bomb');
  assert.equal(res.points, -BOMB_PENALTY);
  assert.equal(r.score, 0, 'never below zero');
  assert.equal(r.hits, 0, 'a bomb is not a scoring hit');
  assert.equal(r.bombs, 1);
  assert.ok(events.some((e) => e.type === 'bombHit'));

  // With points in the bank, the penalty comes off the top.
  const n = spawnKind(r, 'normal', 20);
  r.shoot(n.x, n.y, 30);
  const before = r.score;
  const b2 = spawnKind(r, 'bomb', 40);
  r.shoot(b2.x, b2.y, 50);
  assert.equal(r.score, Math.max(0, before - BOMB_PENALTY));
});

test('placement: live targets never overlap, even with gold at full sway', () => {
  for (const seed of [3, 21, 77]) {
    const r = new Range({ rng: mulberry32(seed) });
    r.start(0);
    while (r.targets.length < MAX_ALIVE) r.spawn(0);
    // Check every pair at the worst case: each gold pushed to both sway
    // extremes; static targets at their spot.
    const spots = (t) => (t.swayAmp
      ? [t.x0 - t.swayAmp, t.x0 + t.swayAmp] : [t.x0]).map((x) => ({ x, y: t.y, r: t.r }));
    for (let i = 0; i < r.targets.length; i += 1) {
      for (let j = i + 1; j < r.targets.length; j += 1) {
        for (const a of spots(r.targets[i])) {
          for (const b of spots(r.targets[j])) {
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            assert.ok(d > a.r + b.r, `seed ${seed}: pair ${i},${j} clear (${d.toFixed(3)})`);
          }
        }
      }
    }
    // And everything stays inside the field, sway included.
    for (const t of r.targets) {
      assert.ok(t.x0 - t.swayAmp - t.r >= 0 && t.x0 + t.swayAmp + t.r <= FIELD_W);
      assert.ok(t.y - t.r >= 0 && t.y + t.r <= FIELD_H);
    }
  }
});

test('placement: every grid cell gets used over time', () => {
  const r = new Range({ rng: mulberry32(13) });
  r.start(0);
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const t = r.spawn(i);
    seen.add(t.cell);
    r.targets.length = 0;
  }
  assert.equal(seen.size, SPAWN_COLS * SPAWN_ROWS, 'all cells reachable');
  void SPAWN_X0; void SPAWN_X1; void SPAWN_Y0; void SPAWN_Y1; void SPAWN_ROWS;
});

test('S2: the spawn mix contains all three kinds in sane proportions', () => {
  const r = new Range({ rng: mulberry32(42) });
  r.start(0);
  const counts = { normal: 0, gold: 0, bomb: 0 };
  for (let i = 0; i < 400; i += 1) {
    counts[r.spawn(i).kind] += 1;
    r.targets.length = 0;
  }
  assert.ok(counts.normal > counts.gold && counts.gold > 40, `gold ${counts.gold}`);
  assert.ok(counts.bomb > 20 && counts.bomb < 90, `bomb ${counts.bomb}`);
});

// S3 — the 60-second round: totals must match an independent tally.
test('S3: the round ends at 60s with score, hits, bombs and accuracy', () => {
  const events = [];
  const r = new Range({ onEvent: (e) => events.push(e), rng: mulberry32(9) });
  r.start(0);
  let tally = 0;
  let hits = 0;
  let shots = 0;
  for (let now = 0; now <= ROUND_MS + 100; now += 50) {
    r.update(now);
    if (now % 400 === 0 && r.state === 'running' && r.targets.length) {
      const t = r.targets[0];
      const res = r.shoot(t.x, t.y, now);
      shots += 1;
      if (res.hit && res.kind !== 'bomb') { hits += 1; tally += res.points; }
      if (res.hit && res.kind === 'bomb') tally = Math.max(0, tally - BOMB_PENALTY);
    }
    if (now % 2000 === 0 && r.state === 'running') {
      const res = r.shoot(0.001, 0.001, now);
      shots += 1;
      if (res.hit && res.kind !== 'bomb') { hits += 1; tally += res.points; }
      if (res.hit && res.kind === 'bomb') tally = Math.max(0, tally - BOMB_PENALTY);
    }
  }
  assert.equal(r.state, 'done');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.score, tally, 'score equals the independent tally');
  assert.equal(done.shots, shots);
  assert.equal(done.hits, hits);
  assert.ok(Math.abs(done.accuracy - hits / shots) < 1e-12);
  assert.ok(done.hits > 15, `the marksman actually hit things (${done.hits})`);
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
  assert.equal(r.bombs, 0);
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
  const solo = new Range({ rng: mulberry32(2) });
  solo.start(0);
  const t = solo.spawn(0);
  const ttl = t.kind === 'gold' ? 3400 : TARGET_TTL_MS;
  solo.update(ttl - 1);
  assert.ok(solo.targets.includes(t), 'alive just before TTL');
  solo.update(ttl + 1);
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
