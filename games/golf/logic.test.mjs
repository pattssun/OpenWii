import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Hole, HOLE, GREEN_RADIUS, terrainHeight, pickClub, PAR,
} from './logic.js';

function settle(h, maxMs = 30000) {
  let now = 0;
  while (h.state === 'flight' && now < maxMs) {
    now += 8;
    h.update(now, 0.008);
  }
  return now;
}

test('the terrain is deterministic and gentle', () => {
  assert.equal(terrainHeight(12.3, -87.6), terrainHeight(12.3, -87.6));
  for (let z = 0; z > -240; z -= 10) {
    const h = terrainHeight(0, z);
    assert.ok(Math.abs(h) < 6, `height ${h.toFixed(1)} at z=${z} stays walkable`);
  }
});

test('club selection follows remaining distance', () => {
  assert.equal(pickClub({ x: 0, z: 0 }), 'driver');
  assert.equal(pickClub({ x: HOLE.x, z: HOLE.z + 80 }), 'iron');
  assert.equal(pickClub({ x: HOLE.x + 3, z: HOLE.z + 3 }), 'putter');
});

test('a full-power drive flies a plausible distance down the hole line', () => {
  const h = new Hole({});
  h.strike(1);
  settle(h);
  const travelled = Math.hypot(h.ball.x, h.ball.z);
  assert.ok(travelled > 120 && travelled < 260, `drove ${travelled.toFixed(0)}m`);
  assert.ok(h.distanceToHole() < 230, 'closer to the hole than the tee was');
});

test('the green is landable — the phase-3 headline bar', () => {
  // From ~100m out, some iron power lands and settles on the green. Scan a
  // few powers rather than hand-picking one: "landable" means a power exists.
  let best = Infinity;
  for (let p = 0.5; p <= 1.0; p += 0.1) {
    const h = new Hole({});
    h.ball.x = HOLE.x;
    h.ball.z = HOLE.z + 100;
    h.ball.y = terrainHeight(h.ball.x, h.ball.z);
    h.strike(p);
    settle(h);
    best = Math.min(best, h.distanceToHole());
    if (h.onGreen()) break;
  }
  assert.ok(best < GREEN_RADIUS, `best iron finished ${best.toFixed(1)}m from the pin`);
});

test('a putt rolls out and the cup captures a slow ball', () => {
  const h = new Hole({});
  h.ball.x = HOLE.x;
  h.ball.z = HOLE.z + 6;
  h.ball.y = terrainHeight(h.ball.x, h.ball.z);
  assert.equal(pickClub(h.ball), 'putter');
  // Scan putt strengths — the cup only takes a SLOW ball, so power 1 should
  // blow past while something moderate drops.
  let holed = false;
  for (let p = 0.25; p <= 0.9 && !holed; p += 0.08) {
    const t = new Hole({});
    t.ball.x = HOLE.x; t.ball.z = HOLE.z + 6;
    t.ball.y = terrainHeight(t.ball.x, t.ball.z);
    t.strike(p);
    settle(t);
    holed = t.state === 'holed';
  }
  assert.ok(holed, 'a makeable putt exists from 6m');
});

test('a whole hole is completable, strokes counted', () => {
  const h = new Hole({});
  const events = [];
  h.onEvent = (e) => events.push(e);
  let guard = 0;
  while (h.state !== 'holed' && guard < 12) {
    guard += 1;
    // A sensible player: mostly full swings, feathered on/near the green.
    const d = h.distanceToHole();
    const power = d > 120 ? 1 : d > GREEN_RADIUS + 2 ? Math.min(1, d / 100) : Math.min(0.85, 0.3 + d / 14);
    h.strike(power);
    settle(h);
  }
  assert.equal(h.state, 'holed', `holed in ${h.strokes} strokes`);
  assert.ok(h.strokes <= 9, `${h.strokes} strokes is a playable hole (par ${PAR})`);
  assert.ok(events.some((e) => e.type === 'holed'));
});
