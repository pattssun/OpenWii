import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyAxes, bodyAxesFromQuat, DEG } from './orientation.js';
import { buildFrame } from './calibration.js';
import { Pointer } from './pointer.js';

/**
 * Regression tests for the four bugs documented in the README, plus the
 * guarantees Phase 0 rests on. Each of these was a real failure that reached a
 * user; none of them announced itself.
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
/** Device orientation is Rz(alpha)·Rx(beta)·Ry(gamma). */
const quatFromEuler = (al, be, ga) => mul(mul(axisQ(2, al), axisQ(0, be)), axisQ(1, ga));

function calibratedPointer(alpha, beta, gamma, opts = {}) {
  const p = new Pointer({ mode: 'relative', ...opts });
  p.setViewport(1280, 720);
  p.degPerScreenX = 60;
  p.degPerScreenY = 40;
  p.recenterSpring = 0;
  p.setFrame(buildFrame(bodyAxes(alpha, beta, gamma)));
  p.recentre();
  return p;
}

// ── Orientation decoding ───────────────────────────────────────────────────
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

// ── Grip detection ─────────────────────────────────────────────────────────
test('a flat grip resolves to the top edge', () => {
  assert.equal(buildFrame(bodyAxes(0, 0, 0)).axis, 'y');
});

test('an upright grip resolves to the back of the phone', () => {
  // Phone held vertical like a TV remote: the top edge points at the ceiling,
  // which is the gimbal singularity that used to freeze horizontal aiming.
  assert.equal(buildFrame(bodyAxes(0, 90, 0)).axis, 'z');
});

test('an upright grip can still aim horizontally', () => {
  const p = calibratedPointer(0, 90, 0);
  const xs = [];
  p.update({ alpha: 0, beta: 90, gamma: 0 }, 1 / 60);
  for (let i = 0; i <= 120; i += 1) {
    p.update({ alpha: -22 * Math.sin(i / 12), beta: 90, gamma: 0 }, 1 / 60);
    xs.push(p.aim.x);
  }
  const travel = Math.max(...xs) - Math.min(...xs);
  assert.ok(travel > 0.5, `swept ${(travel * 100).toFixed(0)}% of the screen`);
});

// ── Mapping fidelity ───────────────────────────────────────────────────────
test('relative mode moves the full amount, not a filtered fraction', () => {
  // Integrating deltas onto the *filtered* cursor collapses to
  // pos += alpha*delta, scaling every movement to ~14% at rest.
  const p = calibratedPointer(0, 0, 0);
  p.update({ alpha: 0, beta: 0, gamma: 0 }, 1 / 60);
  const x0 = p.aim.x;
  for (let i = 1; i <= 20; i += 1) p.update({ alpha: -i, beta: 0, gamma: 0 }, 1 / 60);
  const expected = 20 / 60;                 // 20° across a 60° screen
  const actual = p.aim.x - x0;
  assert.ok(Math.abs(actual / expected - 1) < 0.02, `ratio ${(actual / expected).toFixed(3)}`);
});

test('rolling the wrist does not move the aim', () => {
  const p = calibratedPointer(0, 0, 0);
  p.update({ alpha: 0, beta: 0, gamma: 0 }, 1 / 60);
  const before = { x: p.aim.x, y: p.aim.y };
  for (let g = 0; g <= 80; g += 4) p.update({ alpha: 0, beta: 0, gamma: g }, 1 / 60);
  const moved = Math.hypot(p.aim.x - before.x, p.aim.y - before.y);
  assert.ok(moved < 0.01, `moved ${(moved * 100).toFixed(2)}% of the screen`);
});

test('yaw freezes near the pitch singularity instead of spinning', () => {
  const p = calibratedPointer(0, 0, 0);
  let prev = p.aim.x;
  let worst = 0;
  for (let i = 0; i < 40; i += 1) {
    p.update({ alpha: (i * 37) % 360, beta: 89.7, gamma: 0 }, 1 / 60);
    worst = Math.max(worst, Math.abs(p.aim.x - prev));
    prev = p.aim.x;
  }
  assert.ok(worst < 0.02, `worst single-frame jump ${(worst * 100).toFixed(2)}% of screen`);
});

test('both sample representations drive the pointer identically', () => {
  const results = [];
  for (const useQuat of [false, true]) {
    const p = calibratedPointer(0, 0, 0);
    const send = (al, be, ga) => p.update(
      useQuat ? { quat: quatFromEuler(al, be, ga) } : { alpha: al, beta: be, gamma: ga },
      1 / 60,
    );
    send(0, 0, 0);
    for (let i = 0; i <= 120; i += 1) send(-20 * Math.sin(i / 12), 10 * Math.sin(i / 9), 0);
    results.push({ x: p.aim.x, y: p.aim.y });
  }
  assert.ok(Math.abs(results[0].x - results[1].x) < 1e-6, 'x matches');
  assert.ok(Math.abs(results[0].y - results[1].y) < 1e-6, 'y matches');
});

// ── Responsiveness ─────────────────────────────────────────────────────────
test('the cursor keeps up with a moving hand', () => {
  // The symptom of over-smoothing is tracking error: how far behind the true
  // aim the cursor sits mid-sweep. With the old constants this reached 25% of
  // the screen — a quarter of the display behind your hand, which reads as
  // both "slow" and "imprecise", since the lag makes you overshoot.
  //
  // A step-response test would NOT catch this: One Euro initialises to its
  // first sample, so a fresh filter appears to settle instantly.
  const p = calibratedPointer(0, 0, 0, { mode: 'absolute' });
  p.mode = 'absolute';
  p.recentre();
  let worst = 0;
  for (let f = 0; f < 60; f += 1) {
    const yaw = -25 * Math.sin((f / 60) * Math.PI * 2);   // one sweep per second
    p.update({ alpha: yaw, beta: 0, gamma: 0 }, 1 / 60);
    worst = Math.max(worst, Math.abs(p.position.x - (0.5 + -yaw / 60)));
  }
  assert.ok(worst < 0.08, `worst tracking error ${(worst * 100).toFixed(1)}% of screen`);
});

test('the smoothing filter actually opens up with speed', () => {
  // `cutoff = minCutoff + beta*|speed|` makes beta unit-dependent. When the
  // pointer moved from pixels to normalised units, beta kept its pixel-era
  // value and the adaptive term collapsed to nothing — leaving a fixed low-pass
  // that lagged at every speed. This pins the adaptation to real units.
  const p = new Pointer({});
  const slow = p.filterX.minCutoff + p.filterX.beta * 0.1;   // 0.1 screens/sec
  const fast = p.filterX.minCutoff + p.filterX.beta * 3;     // 3 screens/sec
  assert.ok(fast > slow * 3, `cutoff opens ${slow.toFixed(1)}Hz → ${fast.toFixed(1)}Hz`);
});

// ── Drift correction ───────────────────────────────────────────────────────
test('hybrid mode absorbs slow sensor drift; absolute mode does not', () => {
  const run = (mode) => {
    const p = calibratedPointer(0, 0, 0, { mode });
    p.mode = mode;
    p.recentre();
    const steps = 5 * 60 * 60;                 // 5 minutes at 60Hz
    for (let i = 0; i < steps; i += 1) {
      const bias = (i / (60 * 60)) * 2;         // 2°/min of sensor wander
      p.update({ alpha: -bias, beta: 0, gamma: 0 }, 1 / 60);
    }
    return Math.abs(p.position.x - 0.5);
  };
  const hybrid = run('hybrid');
  const absolute = run('absolute');
  assert.ok(hybrid < 0.05, `hybrid error ${(hybrid * 100).toFixed(2)}% of screen`);
  assert.ok(absolute > hybrid * 3, `absolute (${(absolute * 100).toFixed(1)}%) drifts far more`);
});
