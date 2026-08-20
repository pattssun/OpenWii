import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyAxes, bodyAxesFromQuat, DEG } from './orientation.js';
import { Pointer } from './pointer.js';

/**
 * Tests for the rate-based pointer with the learned device axis map.
 *
 * Ground rules, written in blood:
 *  - Every gyro signal is computed NUMERICALLY from consecutive attitudes.
 *  - Device conventions are simulated as transforms of that numeric truth
 *    (permuted, mirrored, rescaled, garbage) — never hand-derived.
 * Hand-picked conventions caused the circle bug, the swing-up-goes-left bug,
 * and twice produced tests that confidently asserted the wrong thing.
 */

// ── Quaternion helpers (test-local, independent of the code under test) ────
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

/** Body-frame angular velocity between two attitudes, deg/s. */
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

// ── Device models: what a phone might do to the true body rates ────────────
const DEVICE = {
  spec: (w) => [w.x, w.y, w.z],
  radians: (w) => [w.x / 57.29578, w.y / 57.29578, w.z / 57.29578],
  mirrored: (w) => [-w.x, -w.y, -w.z],
  // The "swing up moved the cursor left" phone: reports each rotation on a
  // different axis label than the body axis it happened about.
  swapped: (w) => [w.z, w.x, w.y],
};

const FLAT = quatFromEuler(0, 0, 0);
const UPRIGHT = quatFromEuler(0, 80, 0);
const LANDSCAPE = quatFromEuler(0, 0, 90);

/**
 * Simulate a phone driven by yaw(t)/pitch(t) in the *user's* frame:
 * attitude = Rworld-up(yaw) · Rworld-right(pitch) · grip. Orientation samples
 * (as quaternions) are lagged by `lagMs`; the gyro is derived from the true
 * attitude and passed through the device model.
 */
function drive({
  yaw = () => 0, pitch = () => 0, grip = FLAT, device = DEVICE.spec,
  lagMs = 60, secs = 6, pointer = null,
}) {
  const p = pointer || new Pointer({});
  const attitude = (t) => mul(mul(axisQ(2, yaw(t)), axisQ(0, pitch(t))), grip);
  const FRAME = 1000 / 60;
  const h = 1e-4;
  const track = [];
  let ms = 0;
  for (let i = 0; i < secs * 60; i += 1, ms += FRAME) {
    const t = ms / 1000;
    const w = omegaBody(
      bodyAxesFromQuat(attitude(t)),
      bodyAxesFromQuat(attitude(t + h)),
      h,
    );
    const r = device ? device(w) : null;
    const sample = { quat: attitude(Math.max(0, ms - lagMs) / 1000) };
    if (r) sample.motion = { rx: r[0], ry: r[1], rz: r[2] };
    p.update(sample, FRAME / 1000, ms);
    const d = p.sampleAt(ms);
    track.push({ ms, x: d.x, y: d.y, yaw: yaw(t), pitch: pitch(t) });
  }
  return { p, track };
}

/** Two-axis wander that exercises yaw and pitch at unrelated frequencies. */
const WANDER = {
  yaw: (t) => 12 * Math.sin(2 * Math.PI * 1.0 * t),
  pitch: (t) => 8 * Math.sin(2 * Math.PI * 1.4 * t),
};

/** Demeaned tracking error of cursor x against commanded yaw, screen units. */
function yawError(track, fromMs) {
  const rows = track.filter((r) => r.ms >= fromMs);
  const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const my = rows.reduce((s, r) => s + r.yaw, 0) / rows.length;
  let sum = 0;
  for (const r of rows) sum += Math.abs((r.x - mx) - -((r.yaw - my) / 30));
  return sum / rows.length;
}

function travel(rows, key) {
  const v = rows.map((r) => r[key]);
  return Math.max(...v) - Math.min(...v);
}

// ── Foundation ──────────────────────────────────────────────────────────────
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

// ── Device conventions are learned, never assumed ──────────────────────────
test('a spec-convention phone earns trust and tracks tightly', () => {
  const { p, track } = drive({ ...WANDER });
  assert.ok(p.gyroTrusted, 'axis map trusted');
  const err = yawError(track, 2500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}% of screen`);
});

test('THE BUG: a phone reporting gyro on swapped axes still aims straight', () => {
  // Reported as: rx carries the true z rotation, ry the true x, rz the true y.
  // Under the old assumed-convention code, a vertical swing on this phone
  // moved the cursor horizontally. The learned map must absorb it.
  const warm = drive({ ...WANDER, device: DEVICE.swapped, secs: 5 });
  assert.ok(warm.p.gyroTrusted, 'swapped map learned and trusted');
  warm.p.recentre();   // isolate cross-talk from the wander's leftover offset

  // Now a PURE vertical swing on the same pointer.
  const { track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    device: DEVICE.swapped,
    pointer: warm.p,
    secs: 4,
  });
  const rows = track.filter((r) => r.ms > 1000);
  const xT = travel(rows, 'x');
  const yT = travel(rows, 'y');
  assert.ok(xT < 0.03, `horizontal drift ${(xT * 100).toFixed(1)}% during vertical swing`);
  assert.ok(yT > 0.3, `vertical actually moves (${(yT * 100).toFixed(0)}%)`);
});

test('a rad/s phone is learned: per-axis scale ≈ 57.3', () => {
  const { p, track } = drive({ ...WANDER, device: DEVICE.radians, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted');
  for (const m of p.map) {
    if (!m) continue;
    assert.ok(Math.abs(m.scale - 57.29578) / 57.29578 < 0.15,
      `scale ≈ 57.3 (got ${m.scale.toFixed(1)})`);
  }
  const err = yawError(track, 3500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

test('a mirrored-convention phone is learned and tracks the right way', () => {
  const { p, track } = drive({ ...WANDER, device: DEVICE.mirrored, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted');
  const err = yawError(track, 3500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

test('an unlearnable gyro is never trusted, and directions stay correct', () => {
  // Garbage readings must fail the residual gate; the pointer then runs on
  // convention-free ground truth: softer, but never pointing the wrong way.
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const garbage = () => [rnd() * 40, rnd() * 40, rnd() * 40];
  const { p, track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    device: garbage,
    secs: 6,
  });
  assert.equal(p.gyroTrusted, false, 'garbage never earns trust');
  const rows = track.filter((r) => r.ms > 2000);
  assert.ok(travel(rows, 'x') < 0.04, 'no horizontal drift from garbage');
  assert.ok(travel(rows, 'y') > 0.25, 'vertical swing still works via fallback');
});

test('no gyro at all still points the right way', () => {
  const { p, track } = drive({ ...WANDER, device: null, secs: 6 });
  assert.equal(p.hasGyro, false);
  const rows = track.filter((r) => r.ms > 2000);
  // Fallback is lagged, so assert direction (covariance) and amplitude.
  const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const my = rows.reduce((s, r) => s + r.yaw, 0) / rows.length;
  const cov = rows.reduce((s, r) => s + (r.x - mx) * -(r.yaw - my), 0);
  assert.ok(cov > 0, 'cursor moves the same way as the hand');
  const expected = (2 * 12) / 30;
  assert.ok(Math.abs(travel(rows, 'x') - expected) / expected < 0.3,
    `travel within 30% of expected (${(travel(rows, 'x') * 100).toFixed(0)}%)`);
});

// ── Grip-agnostic geometry ──────────────────────────────────────────────────
test('a vertical swing is vertical in flat, upright and landscape grips', () => {
  for (const [name, grip] of [['flat', FLAT], ['upright', UPRIGHT], ['landscape', LANDSCAPE]]) {
    const { track } = drive({
      pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
      grip,
      secs: 5,
    });
    const rows = track.filter((r) => r.ms > 1500);
    assert.ok(travel(rows, 'x') < 0.03,
      `${name}: horizontal drift ${(travel(rows, 'x') * 100).toFixed(1)}%`);
    assert.ok(travel(rows, 'y') > 0.3, `${name}: vertical moves`);
  }
});

test('upright grip yaw tracks like flat grip yaw', () => {
  const { p, track } = drive({ ...WANDER, grip: UPRIGHT, secs: 6 });
  assert.ok(p.gyroTrusted, 'trusted in upright grip');
  const err = yawError(track, 2500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

// ── Latency ─────────────────────────────────────────────────────────────────
test('realistic orientation lag does not slow the cursor', () => {
  // 100ms of OS fusion lag — worse than typical. The live path reads the raw
  // gyro through the learned map, so the lag only touches the learning side,
  // where the delay-aligned comparison absorbs it.
  const { p, track } = drive({ ...WANDER, lagMs: 100, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted despite lag');
  const err = yawError(track, 3500);
  assert.ok(err < 0.08, `tracking error at 100ms lag ${(err * 100).toFixed(1)}%`);
});

test('absurd orientation lag degrades to correct-but-soft, never wrong', () => {
  const { track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    lagMs: 300,
    secs: 6,
  });
  const rows = track.filter((r) => r.ms > 2000);
  assert.ok(travel(rows, 'x') < 0.04, 'still no cross-axis motion at 300ms lag');
  assert.ok(travel(rows, 'y') > 0.2, 'vertical still works');
});

// ── Stillness and lifecycle ─────────────────────────────────────────────────
test('the cursor is rock-still at rest', () => {
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
  const t = Math.max(...xs) - Math.min(...xs);
  assert.ok(t < 0.005, `rest wobble ${(t * 100).toFixed(2)}% of screen`);
});

test('stillness never corrupts the learned map', () => {
  const { p } = drive({ ...WANDER, secs: 5 });
  assert.ok(p.gyroTrusted);
  const before = p.map.map((m) => (m ? { ...m } : null));
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let ms = 100000;
  for (let i = 0; i < 60 * 30; i += 1, ms += 1000 / 60) {
    p.update({
      alpha: rnd() * 0.3, beta: 0, gamma: 0,
      motion: { rx: rnd() * 0.1, ry: rnd() * 0.1, rz: rnd() * 0.1 },
    }, 1 / 60, ms);
  }
  // Columns and signs must be untouched; scale may drift a couple of percent
  // from the handful of packets where the motion-EMA decays across the
  // wander-to-stillness boundary. That is a bounded transition tail, not
  // learning-from-noise.
  const after = p.map;
  before.forEach((b, i) => {
    if (!b) { assert.equal(after[i], null); return; }
    assert.equal(after[i].col, b.col, `axis ${i} column unchanged`);
    assert.equal(after[i].sign, b.sign, `axis ${i} sign unchanged`);
    assert.ok(Math.abs(after[i].scale - b.scale) / b.scale < 0.05,
      `axis ${i} scale within 5% (${b.scale.toFixed(3)} → ${after[i].scale.toFixed(3)})`);
  });
  assert.ok(p.gyroTrusted, 'trust retained');
});

test('recentre snaps to the middle and stays', () => {
  const { p } = drive({ ...WANDER, secs: 2 });
  p.recentre();
  assert.equal(p.pos.x, 0.5);
  assert.equal(p.pos.y, 0.5);
  assert.equal(p.sampleAt(999999).x, 0.5, 'no coasting after recentre');
});

test('when packets stop, the cursor freezes instead of coasting', () => {
  const { p, track } = drive({ yaw: (t) => 20 * t, secs: 2 });
  const last = track[track.length - 1];
  const later = p.sampleAt(last.ms + 1000);
  assert.ok(Math.abs(later.x - last.x) < 0.02,
    `coasted ${(Math.abs(later.x - last.x) * 100).toFixed(1)}% after packets stopped`);
});

// ── Pose anchoring: the cursor's centre must stay the phone's centre ────────
// The complaint that drove this: constant slashing (fruit ninja) un-centred
// the cursor until the player recentred by hand every minute. Two mechanisms
// fix it — overshoot headroom at the edges, and stillness re-anchoring to the
// beam's absolute pose. Trajectories here are in the user's frame; everything
// the pointer sees is derived numerically, per the rules at the top.

test('an over-swing past the edge comes back to centre', () => {
  const p = new Pointer({});
  drive({ ...WANDER, secs: 4, pointer: p });          // earn gyro trust first
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // 25° right and back — 10° past the half-screen edge (15° at sensitivity 1).
  // The old screen-space clamp lost those 10°: the cursor came back 33% off.
  const out = (t) => (t < 1 ? 0
    : t < 1.5 ? -25 * ((t - 1) / 0.5)
      : t < 2 ? -25
        : t < 2.5 ? -25 * (1 - ((t - 2) / 0.5)) : 0);
  const { track } = drive({ yaw: out, pitch: () => 0, secs: 3.2, pointer: p });
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.x - 0.5) < 0.06, `returned to x=${done.x.toFixed(3)}`);
});

test('drift from a huge clamped swing heals while the hand is still', () => {
  const p = new Pointer({});
  drive({ ...WANDER, secs: 4, pointer: p });
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // 60° out and back blows even the overshoot margin — the clamp genuinely
  // eats aim. The stillness that follows must re-anchor to the true pose.
  const out = (t) => (t < 0.5 ? 0
    : t < 1 ? -60 * ((t - 0.5) / 0.5)
      : t < 1.5 ? -60
        : t < 2 ? -60 * (1 - ((t - 1.5) / 0.5)) : 0);
  const { track } = drive({ yaw: out, pitch: () => 0, secs: 6.5, pointer: p });
  const justBack = track.find((r) => r.ms >= 2200);
  const done = track[track.length - 1];
  assert.ok(Math.abs(justBack.x - 0.5) > 0.2,
    `sanity: the clamp cost real aim first (x=${justBack.x.toFixed(3)})`);
  assert.ok(Math.abs(done.x - 0.5) < 0.06, `healed to x=${done.x.toFixed(3)}`);
});

test('a held aim is never dragged — healing targets the pose, not the centre', () => {
  const p = new Pointer({});
  drive({ ...WANDER, secs: 4, pointer: p });
  p.recentre();
  // Raise the aim 4° and hold it there, dead still, for seven seconds.
  const hold = (t) => (t < 0.5 ? 0 : t < 1 ? 4 * ((t - 0.5) / 0.5) : 4);
  const { track } = drive({ yaw: () => 0, pitch: hold, secs: 8, pointer: p });
  // By 4s the deadzone loss from the ramp has healed; from there on the aim
  // must sit at the pose-true position (0.5 − 4/18 = 0.278) and not creep.
  const settled = track.find((r) => r.ms >= 4000);
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.y - 0.5) > 0.1, `sanity: aim is off-centre (y=${done.y.toFixed(3)})`);
  assert.ok(Math.abs(done.y - (0.5 - 4 / 18)) < 0.02,
    `holds the pose-true position (y=${done.y.toFixed(3)})`);
  assert.ok(Math.abs(done.y - settled.y) < 0.01,
    `held aim crept: ${settled.y.toFixed(3)} → ${done.y.toFixed(3)}`);
});

test('clamp loss is repaid mid-play — gentle aiming, no stillness required', () => {
  // The real complaint: fruit ninja never contains 800ms of true stillness,
  // so drift piled up until the player pressed re-centre by hand. A clamped
  // swing's loss must now heal during ordinary between-slash aiming motion.
  const p = new Pointer({});
  drive({ ...WANDER, secs: 4, pointer: p });
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // A huge 60° slash out and back — far past the overshoot cap, aim is lost —
  // followed by continuous gentle pitch wobble (~9°/s peak: above the still
  // gate, well under the calm gate), never a moment of stillness.
  const yaw = (t) => (t < 0.5 ? 0
    : t < 1 ? -60 * ((t - 0.5) / 0.5)
      : t < 1.5 ? -60
        : t < 2 ? -60 * (1 - ((t - 1.5) / 0.5)) : 0);
  const pitch = (t) => (t < 2 ? 0 : 3 * Math.sin(2 * Math.PI * 0.5 * (t - 2)));
  const { track } = drive({ yaw, pitch, secs: 7, pointer: p });
  const justBack = track.find((r) => r.ms >= 2100);
  assert.ok(Math.abs(justBack.x - 0.5) > 0.2,
    `sanity: the clamp cost real aim (x=${justBack.x.toFixed(3)})`);
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.x - 0.5) < 0.08,
    `repaid during gentle aiming, no stillness (x=${done.x.toFixed(3)})`);
});
