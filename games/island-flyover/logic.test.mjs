import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Flight, islandHeight, makePoints, wrapAngle,
  POINT_COUNT, WORLD_RADIUS, SEA_LEVEL,
} from './logic.js';

test('the island is deterministic, has a peak, and falls into the sea', () => {
  assert.equal(islandHeight(31.7, -84.2), islandHeight(31.7, -84.2));
  assert.ok(islandHeight(0, 0) > 25, `central peak (${islandHeight(0, 0).toFixed(1)}m)`);
  assert.ok(islandHeight(500, 0) < SEA_LEVEL, 'open sea beyond the falloff');
  // Somewhere on the shore the land actually meets the water.
  let coast = false;
  for (let r = 200; r < 420; r += 5) {
    if (Math.abs(islandHeight(r, 0)) < 2) { coast = true; break; }
  }
  assert.ok(coast, 'a coastline exists');
});

test('i-points sit above ground, inside the world, none duplicated', () => {
  const pts = makePoints();
  assert.equal(pts.length, POINT_COUNT);
  for (const p of pts) {
    assert.ok(p.y > Math.max(SEA_LEVEL, islandHeight(p.x, p.z)) + 5, `ring ${p.id} is airborne`);
    assert.ok(Math.hypot(p.x, p.z) < WORLD_RADIUS, `ring ${p.id} inside the world`);
  }
});

test('banking turns; level tilt flies straight and holds altitude', () => {
  const f = new Flight({});
  f.start(0);
  const h0 = f.heading;
  const y0 = f.pos.y;
  let now = 0;
  f.setTilt(0, 0);
  for (let i = 0; i < 120; i += 1) { now += 16; f.update(now, 0.016); }
  assert.ok(Math.abs(wrapAngle(f.heading - h0)) < 0.02, 'no phantom turn when level');
  assert.ok(Math.abs(f.pos.y - y0) < 3, `altitude held (${(f.pos.y - y0).toFixed(1)}m drift)`);

  f.setTilt(30, 0);                        // bank right
  const before = f.heading;
  for (let i = 0; i < 120; i += 1) { now += 16; f.update(now, 0.016); }
  assert.ok(wrapAngle(f.heading - before) > 0.5, 'banking right turns right');
});

test('terrain and world edges push back instead of crashing', () => {
  const f = new Flight({});
  f.start(0);
  let now = 0;
  f.setTilt(0, -45);                       // dive hard at the island
  for (let i = 0; i < 1500; i += 1) { now += 16; f.update(now, 0.016); }
  assert.ok(f.pos.y >= Math.max(SEA_LEVEL + 4, islandHeight(f.pos.x, f.pos.z) + 5.9),
    'never below the safety floor');
  assert.equal(f.state, 'flying', 'no crash state exists');

  // Fly straight out to sea; the soft edge must bring us back inside.
  const g = new Flight({});
  g.start(0);
  g.setTilt(0, 0);
  now = 0;
  let maxR = 0;
  for (let i = 0; i < 6000; i += 1) {
    now += 16; g.update(now, 0.016);
    maxR = Math.max(maxR, Math.hypot(g.pos.x, g.pos.z));
  }
  assert.ok(maxR < WORLD_RADIUS + 80, `edge held (max radius ${maxR.toFixed(0)}m)`);
});

test('all 20 i-points are collectible — the island tour is flyable', () => {
  const f = new Flight({});
  const events = [];
  f.onEvent = (e) => events.push(e);
  f.start(0);
  let now = 0;
  // A blunt autopilot: steer and climb toward the nearest un-taken ring.
  for (let i = 0; i < 60 * 60 * 8 && f.state === 'flying'; i += 1) {   // ≤8 sim-minutes
    now += 16;
    const next = f.points.find((p) => !p.taken);
    if (!next) break;
    const want = Math.atan2(next.x - f.pos.x, -(next.z - f.pos.z));
    const turn = wrapAngle(want - f.heading);
    const dist = Math.hypot(next.x - f.pos.x, next.z - f.pos.z);
    const climb = Math.atan2(next.y - f.pos.y, Math.max(dist, 1)) * 180 / Math.PI;
    f.setTilt(Math.max(-55, Math.min(55, turn * 90)), Math.max(-40, Math.min(40, climb)));
    f.update(now, 0.016);
  }
  assert.equal(f.collected, POINT_COUNT, `collected ${f.collected}/${POINT_COUNT}`);
  assert.equal(f.state, 'done');
  assert.ok(events.some((e) => e.type === 'done'));
});
