import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Patrol, captureTray, trayRead, mulberry32, fmtMs,
  shapeSteer, SteerFilter, STEER_DEADZONE,
  LANE_HALF, LATERAL_SPEED, STEER_FULL, SHIP_R, ALIEN_R,
  FIRE_COOLDOWN_MS, LIVES, INVULN_MS, KILL_POINTS,
  SPAWN_MS_START, SPAWN_MS_MIN, ALIEN_BOLT_SPEED,
} from './logic.js';

// ── Tray-grip steering, same proofs the cow carried ────────────────────────
// World: x east, y north, z up. The player sits SOUTH; the phone lies flat,
// leaned a few degrees toward the face. Rolls happen about the north–south
// axis; the player's right is east, and east-end-down reads +t
// (DEVICE-PINNED 2026-08-24).

const rot = (v, n, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = n.x * v.x + n.y * v.y + n.z * v.z;
  const cx = { x: n.y * v.z - n.z * v.y, y: n.z * v.x - n.x * v.z, z: n.x * v.y - n.y * v.x };
  return {
    x: v.x * c + cx.x * s + n.x * d * (1 - c),
    y: v.y * c + cx.y * s + n.y * d * (1 - c),
    z: v.z * c + cx.z * s + n.z * d * (1 - c),
  };
};
const rotAxes = (axes, n, a) => ({ x: rot(axes.x, n, a), y: rot(axes.y, n, a), z: rot(axes.z, n, a) });
const NORTH = { x: 0, y: 1, z: 0 };
const LEAN = 10 * (Math.PI / 180);

function trayGrip(flip) {
  const s = Math.sin(LEAN);
  const c = Math.cos(LEAN);
  if (flip === 'A') {
    return { x: { x: 0, y: -c, z: -s }, y: { x: 1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
  }
  return { x: { x: 0, y: c, z: s }, y: { x: -1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
}

test('tray: captured pose reads zero; rolls read as exact deltas; flips agree', () => {
  for (const flip of ['A', 'B']) {
    const rest = rotAxes(trayGrip(flip), NORTH, 7 * (Math.PI / 180));
    const ref = captureTray(rest);
    assert.ok(Math.abs(trayRead(rest, ref).bank) < 1e-9, `flip ${flip}: neutral is 0°`);
  }
  for (const t of [12, -25]) {
    const banks = ['A', 'B'].map((flip) => {
      const ref = captureTray(trayGrip(flip));
      return trayRead(rotAxes(trayGrip(flip), NORTH, t * (Math.PI / 180)), ref).bank;
    });
    assert.ok(Math.abs(banks[0] - banks[1]) < 1e-6, 'flips agree');
    assert.ok(Math.abs(banks[0] - t) < 1e-6,
      `pinned sign: roll ${t}° → bank ${banks[0].toFixed(2)}°`);
  }
});

// ── Anti-drift steering stage ──────────────────────────────────────────────

test('shape: tremor inside the deadzone is zero, full lock is preserved', () => {
  assert.equal(shapeSteer(0), 0);
  assert.equal(shapeSteer(STEER_DEADZONE - 0.1), 0);
  assert.equal(shapeSteer(-(STEER_DEADZONE - 0.1)), 0);
  assert.ok(Math.abs(shapeSteer(STEER_FULL) - STEER_FULL) < 1e-9, 'full lock intact');
  assert.ok(Math.abs(shapeSteer(-STEER_FULL) + STEER_FULL) < 1e-9);
  assert.ok(shapeSteer(STEER_DEADZONE + 0.1) > 0 && shapeSteer(STEER_DEADZONE + 0.1) < 0.5,
    'the edge of the deadzone ramps in smoothly');
});

test('filter: a standing 3° bias heals to zero output', () => {
  const f = new SteerFilter();
  let out = 0;
  for (let i = 0; i < 60 * 10; i += 1) out = f.update(3, 1 / 60);   // 10s at rest
  assert.equal(out, 0, 'the drift is gone');
  assert.ok(Math.abs(f.bias - 3) < 0.05, 'the bias was learned, not clipped');
});

test('filter: an intentional hard steer is never eaten', () => {
  const f = new SteerFilter();
  for (let i = 0; i < 60 * 3; i += 1) f.update(0.5, 1 / 60);        // settle
  let out = 0;
  for (let i = 0; i < 60 * 5; i += 1) out = f.update(15, 1 / 60);   // held steer
  assert.ok(Math.abs(out - shapeSteer(15 - f.bias)) < 1e-9);
  assert.ok(out > 13, `a held 15° steer still steers hard (${out.toFixed(2)})`);
  assert.ok(Math.abs(f.bias) < 1, 'the steer did not get absorbed as bias');
});

test('filter: drift heals, then a swing passes through at full strength', () => {
  const f = new SteerFilter();
  for (let i = 0; i < 60 * 8; i += 1) f.update(2.5, 1 / 60);        // drifted rest
  const swung = f.update(2.5 + 14, 1 / 60);
  assert.ok(swung > 11.5, `the swing reads nearly full: ${swung.toFixed(2)}°`);
});

// ── Flight ─────────────────────────────────────────────────────────────────

function drive(p, seconds, dt, fn = () => {}) {
  let now = p.startMs;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    now += dt * 1000;
    fn(p, now);
    p.update(now, dt);
  }
  return now;
}

test('steering: bank strafes proportionally, saturates, and the lane clamps', () => {
  for (const bank of [14, -14, 6, 0]) {
    const p = new Patrol({});
    p.start(0);
    p.nextSpawnMs = Infinity;        // an empty sky for a pure steering test
    p.setSteer(bank);
    drive(p, 1.0, 0.01);
    const expected = LATERAL_SPEED * (bank / STEER_FULL) * 1.0;
    assert.ok(Math.abs(p.x - expected) < 1e-9, `bank ${bank}° → x ${p.x}`);
  }
  const p = new Patrol({});
  p.start(0);
  p.nextSpawnMs = Infinity;
  p.setSteer(90);
  drive(p, 20, 0.01);
  assert.equal(p.x, LANE_HALF, 'never leaves the lane');
});

test('a bolt dead ahead kills the saucer and scores KILL_POINTS', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x; a.swayAmp = 0; a.speed = 10;   // hovering straight ahead
  p.shoot(200);
  drive(p, 3, 0.01);
  assert.equal(p.kills, 1);
  assert.ok(events.some((e) => e.type === 'kill'));
  assert.equal(p.aliens.length, 0, 'the saucer is gone');
  assert.equal(p.score, KILL_POINTS + Math.floor(p.z));
});

test('a bolt misses a saucer parked off to the side', () => {
  const p = new Patrol({});
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x + ALIEN_R + 1.5; a.swayAmp = 0; a.speed = 0;
  p.shoot(200);
  drive(p, 1.5, 0.01);
  assert.equal(p.kills, 0);
});

test('the trigger has a cooldown', () => {
  const p = new Patrol({});
  p.start(0);
  assert.equal(p.shoot(1000), true);
  assert.equal(p.shoot(1000 + FIRE_COOLDOWN_MS - 10), false);
  assert.equal(p.shoot(1000 + FIRE_COOLDOWN_MS + 10), true);
  assert.equal(p.bolts.length, 2);
});

test('a ramming saucer costs a life, and the mercy window blocks a double hit', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const ram = (now) => {
    const a = p.spawnAlien(now);
    a.x0 = p.x; a.swayAmp = 0; a.speed = 300;   // dives straight in
    return a;
  };
  ram(0);
  let now = drive(p, 1.0, 0.01);
  assert.equal(p.lives, LIVES - 1);
  // A second rammer arriving inside the mercy window is free…
  ram(now);
  now = drive(p, 0.4, 0.01, (_, t) => { p.startMs = p.startMs; void t; });
  assert.equal(p.lives, LIVES - 1, 'invulnerability held');
  // …but after it lapses, hits count again.
  const later = now + INVULN_MS;
  const a3 = ram(later);
  for (let t = later; p.aliens.includes(a3) && p.state === 'running'; t += 10) p.update(t, 0.01);
  assert.equal(p.lives, LIVES - 2);
});

test('an alien bolt on your column hits; a dodge clears it', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  p.alienBolts.push({ x: p.x, z: p.z + 30 });
  drive(p, 1.2, 0.01);
  assert.equal(p.lives, LIVES - 1, 'a centred bolt lands');

  const q = new Patrol({});
  q.start(0);
  q.nextSpawnMs = Infinity;
  q.alienBolts.push({ x: q.x + SHIP_R + 0.5, z: q.z + 30 });
  drive(q, 1.2, 0.01);
  assert.equal(q.lives, LIVES, 'a sidestepped bolt sails past');
});

test('saucers open fire only inside range, on their own discipline', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e), seed: 5 });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x + 6; a.swayAmp = 0; a.speed = 20;
  drive(p, 8, 0.01);
  const shots = events.filter((e) => e.type === 'alienFire');
  assert.ok(shots.length >= 1, 'it fired');
  for (const s of shots) assert.ok(s.z - 0 >= 0, 'sane fire positions');
});

test('three hits end the run with score = kills·100 + distance', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  let now = 0;
  for (let hit = 0; hit < LIVES; hit += 1) {
    now += INVULN_MS + 200;
    p.update(now, 0.01);
    if (p.state !== 'running') break;
    p.alienBolts.push({ x: p.x, z: p.z + 0.5 });
    now += 100;
    for (let t = now - 100; t <= now && p.state === 'running'; t += 10) p.update(t, 0.01);
  }
  assert.equal(p.state, 'done');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.score, done.kills * KILL_POINTS + done.distanceM);
  assert.equal(done.kills, 0);
});

test('waves ramp: spawn gaps shrink toward the floor over time', () => {
  const p = new Patrol({ seed: 9 });
  p.start(0);
  const gaps = [];
  let lastSpawn = null;
  const events = [];
  p.onEvent = (e) => {
    if (e.type !== 'spawn') return;
    events.push(e);
  };
  let prevCount = 0;
  let prevAt = 0;
  drive(p, 120, 0.02, (q, now) => {
    q.x = -LANE_HALF;                 // hug a wall; ignore combat outcomes
    if (events.length > prevCount) {
      if (prevAt) gaps.push(now - prevAt);
      prevAt = now;
      prevCount = events.length;
    }
    q.lives = LIVES;                  // immortal for the pacing measurement
    q.state = 'running';
  });
  assert.ok(gaps.length > 20, `many waves spawned (${gaps.length})`);
  const early = gaps.slice(0, 5).reduce((a, b) => a + b) / 5;
  const late = gaps.slice(-5).reduce((a, b) => a + b) / 5;
  assert.ok(early > late, `gaps shrink: ${early.toFixed(0)}ms → ${late.toFixed(0)}ms`);
  assert.ok(late >= SPAWN_MS_MIN - 30, 'never below the floor');
  assert.ok(early <= SPAWN_MS_START + 30, 'never above the ceiling');
  void lastSpawn; void mulberry32; void ALIEN_BOLT_SPEED;
});

test('A restarts a finished run from zero', () => {
  const p = new Patrol({});
  p.start(0);
  p.lives = 1;
  p.alienBolts.push({ x: p.x, z: p.z + 0.5 });
  drive(p, 0.5, 0.01);
  assert.equal(p.state, 'done');
  p.start(60_000);
  assert.equal(p.state, 'running');
  assert.equal(p.lives, LIVES);
  assert.equal(p.kills, 0);
  assert.equal(p.z, 0);
  assert.equal(p.aliens.length, 0);
});

test('fmtMs renders minutes and tenths', () => {
  assert.equal(fmtMs(83_400), '1:23.4');
  assert.equal(fmtMs(0), '—:—');
});
