import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyAxes, bodyAxesFromQuat, DEG } from './orientation.js';
import { Pointer } from './pointer.js';

/**
 * Tests for the rate-based pointer.
 *
 * Every gyro signal here is computed NUMERICALLY from two consecutive
 * attitudes — never hand-derived. Hand-picked sign conventions are how the
 * old design's circle bug happened, and a test that asserts a wrong
 * convention confidently is worse than no test.
 */

// ── Helpers ────────────────────────────────────────────────────────────────
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQ = (ax, deg) => {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return [ax === 0 ? s : 0, ax === 1 ? s : 0, ax === 2 ? s : 0, Math.cos(h)];
};
const quatFromEuler = (al, be, ga) => mul(mul(axisQ(2, al), axisQ(0, be)), axisQ(1, ga));

/** Body-frame angular velocity between two attitudes, in deg/s. */
function omegaBody(a1, a2, h) {
  const col = (a, k) => [a[k].x, a[k].y, a[k].z];
  const R1 = [col(a1, 'x'), col(a1, 'y'), col(a1, 'z')];
  const R2 = [col(a2, 'x'), col(a2, 'y'), col(a2, 'z')];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map(
    (j) => R1[i][0] * R2[j][0] + R1[i][1] * R2[j][1] + R1[i][2] * R2[j][2],
  ));
  return {
    x: (M[2][1] - M[1][2]) / (2 * h) / DEG,
    y: (M[0][2] - M[2][0]) / (2 * h) / DEG,
    z: (M[1][0] - M[0][1]) / (2 * h) / DEG,
  };
}

/**
 * Simulate a phone: orientation samples lagged by `lagMs` (the OS fusion
 * estimate is never fresh), gyro computed from the TRUE motion (the gyro is),
 * scaled by `unitScale` to model deg/s vs rad/s vs mirrored conventions.
 */
function drive(eulerAt, { unitScale = 1, lagMs = 60, secs = 6, pointer = null } = {}) {
  const p = pointer || new Pointer({});
  const FRAME = 1000 / 60;
  const h = 1e-4;
  const track = [];
  let ms = 0;
  for (let i = 0; i < secs * 60; i += 1, ms += FRAME) {
    const [al, be, ga] = eulerAt(Math.max(0, ms - lagMs) / 1000);
    const [tAl, tBe, tGa] = eulerAt(ms / 1000);
    const om = omegaBody(
      bodyAxes(tAl, tBe, tGa),
      bodyAxes(...eulerAt((ms + h * 1000) / 1000)),
      h,
    );
    p.update({
      alpha: al, beta: be, gamma: ga,
      motion: { rx: om.x * unitScale, ry: om.y * unitScale, rz: om.z * unitScale },
    }, FRAME / 1000, ms);
    const d = p.sampleAt(ms);
    track.push({ ms, x: d.x, y: d.y, al: tAl, be: tBe });
  }
  return { p, track };
}

/** Demeaned tracking error of cursor x against true yaw, % of screen. */
function yawTrackingError(track, degPerScreen, fromMs) {
  const rows = track.filter((r) => r.ms >= fromMs);
  const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const ma = rows.reduce((s, r) => s + r.al, 0) / rows.length;
  let sum = 0;
  for (const r of rows) {
    // Turning left = alpha increasing = cursor moves left (x decreases).
    // Demeaning removes the arbitrary offset a rate-based cursor accumulates
    // while its gain is still being learned.
    const ideal = -(r.al - ma) / degPerScreen;
    sum += Math.abs((r.x - mx) - ideal);
  }
  return sum / rows.length;
}

// ── Orientation decoding (unchanged foundation) ────────────────────────────
test('quaternion decoding matches Euler decoding exactly', () => {
  const cases = [
    [0, 0, 0], [37, 0, 0], [0, 52, 0], [0, 0, -41], [120, -33, 67],
    [-95, 88, 15], [200, -140, -70], [359, 179, 89], [45, 90, 0], [270, -90, 45],
  ];
  let worst = 0;
  for (const [al, be, ga] of cases) {
    const a = bodyAxes(al, be, ga);
    const b = bodyAxesFromQuat(quatFromEuler(al, be, ga));
    for (const k of ['x', 'y', 'z']) {
      for (const c of ['x', 'y', 'z']) worst = Math.max(worst, Math.abs(a[k][c] - b[k][c]));
    }
  }
  assert.ok(worst < 1e-9, `worst component error ${worst.toExponential(2)}`);
});

// ── The core behaviour: the cursor is the gyro ─────────────────────────────
test('a deg/s phone tracks a horizontal sweep, correct direction and scale', () => {
  const { track } = drive((t) => [10 * Math.sin(2 * Math.PI * t), 0, 0]);
  const err = yawTrackingError(track, 30, 2000);
  assert.ok(err < 0.05, `demeaned tracking error ${(err * 100).toFixed(1)}% of screen`);
});

test('a rad/s phone (57× smaller readings) is learned and then tracks', () => {
  // Firefox has reported rotationRate in rad/s. Untreated, the cursor moves
  // 57× too slowly — which reads as "the cursor is really slow".
  const { p, track } = drive(
    (t) => [12 * Math.sin(2 * Math.PI * t), 0, 0],
    { unitScale: 1 / 57.29578, secs: 8 },
  );
  assert.ok(Math.abs(p.k - 57.29578) / 57.29578 < 0.1, `k learned ≈57.3 (got ${p.k.toFixed(1)})`);
  const err = yawTrackingError(track, 30, 4000);
  assert.ok(err < 0.06, `tracking error after learning ${(err * 100).toFixed(1)}%`);
});

test('a mirrored-convention phone is learned and tracks the right way', () => {
  const { p, track } = drive(
    (t) => [12 * Math.sin(2 * Math.PI * t), 0, 0],
    { unitScale: -1, secs: 8 },
  );
  assert.ok(p.k < -0.8, `k learned negative (got ${p.k.toFixed(2)})`);
  const err = yawTrackingError(track, 30, 4000);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

test('orientation lag does not slow the cursor', () => {
  // The rate path never waits on the orientation estimate, so even an absurd
  // 200ms of OS fusion lag must not degrade tracking. This is the property
  // the previous absolute-pointing design could not have.
  const { track } = drive(
    (t) => [10 * Math.sin(2 * Math.PI * t), 0, 0],
    { lagMs: 200 },
  );
  const err = yawTrackingError(track, 30, 2500);
  assert.ok(err < 0.05, `error with 200ms orientation lag ${(err * 100).toFixed(1)}%`);
});

test('a vertical swing produces no horizontal motion, at any grip roll', () => {
  // The old design once turned a straight up-down swing into a full circle.
  for (const roll of [0, 25, 40]) {
    const { track } = drive((t) => [0, 18 * Math.sin(2 * Math.PI * 0.8 * t), roll]);
    const xs = track.filter((r) => r.ms > 1500).map((r) => r.x);
    const ys = track.filter((r) => r.ms > 1500).map((r) => r.y);
    const xTravel = Math.max(...xs) - Math.min(...xs);
    const yTravel = Math.max(...ys) - Math.min(...ys);
    assert.ok(xTravel < 0.02, `roll ${roll}°: ${(xTravel * 100).toFixed(1)}% horizontal drift`);
    assert.ok(yTravel > 0.3, `roll ${roll}°: vertical actually moves (${(yTravel * 100).toFixed(0)}%)`);
  }
});

test('upright TV-remote grip aims exactly like the flat grip', () => {
  // Grip-agnostic by construction: yaw is rotation about world-up either way.
  const { track } = drive((t) => [10 * Math.sin(2 * Math.PI * t), 80, 0]);
  const err = yawTrackingError(track, 30, 2000);
  assert.ok(err < 0.05, `upright-grip tracking error ${(err * 100).toFixed(1)}%`);
});

test('the cursor is rock-still at rest', () => {
  // Tremor-level gyro noise and orientation jitter must not random-walk the
  // cursor. The deadzone handles this with zero cost to real motion.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const p = new Pointer({});
  let ms = 0;
  const xs = [];
  for (let i = 0; i < 60 * 5; i += 1, ms += 1000 / 60) {
    p.update({
      alpha: rnd() * 0.3, beta: rnd() * 0.3, gamma: 0,
      motion: { rx: rnd() * 0.2, ry: rnd() * 0.2, rz: rnd() * 0.2 },
    }, 1 / 60, ms);
    xs.push(p.sampleAt(ms).x);
  }
  const travel = Math.max(...xs) - Math.min(...xs);
  assert.ok(travel < 0.005, `rest wobble ${(travel * 100).toFixed(2)}% of screen`);
});

test('stillness never corrupts the learned gain', () => {
  const { p } = drive((t) => [12 * Math.sin(2 * Math.PI * t), 0, 0], { secs: 4 });
  const learned = p.k;
  // Now hold still for a long time with noise only.
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let ms = 100000;
  for (let i = 0; i < 60 * 30; i += 1, ms += 1000 / 60) {
    p.update({
      alpha: rnd() * 0.3, beta: 0, gamma: 0,
      motion: { rx: 0, ry: 0, rz: rnd() * 0.1 },
    }, 1 / 60, ms);
  }
  assert.ok(Math.abs(p.k - learned) < 0.05 * Math.abs(learned),
    `k held (${learned.toFixed(2)} → ${p.k.toFixed(2)})`);
});

test('recentre snaps to the middle and stays', () => {
  const { p } = drive((t) => [15 * Math.sin(2 * Math.PI * t), 0, 0], { secs: 2 });
  p.recentre();
  assert.equal(p.pos.x, 0.5);
  assert.equal(p.pos.y, 0.5);
  const after = p.sampleAt(999999);
  assert.equal(after.x, 0.5, 'no coasting after recentre');
});

test('when packets stop, the cursor freezes instead of coasting', () => {
  const p = new Pointer({});
  let ms = 0;
  // Constant leftward turn.
  for (let i = 0; i < 60; i += 1, ms += 1000 / 60) {
    p.update({ alpha: i, beta: 0, gamma: 0, motion: { rx: 0, ry: 0, rz: 60 } }, 1 / 60, ms);
    p.sampleAt(ms);
  }
  const atStop = p.sampleAt(ms);
  const frozen = { x: atStop.x, y: atStop.y };
  // One second with no packets.
  const later = p.sampleAt(ms + 1000);
  assert.ok(Math.abs(later.x - frozen.x) < 0.02,
    `coasted ${(Math.abs(later.x - frozen.x) * 100).toFixed(1)}% after packets stopped`);
});
