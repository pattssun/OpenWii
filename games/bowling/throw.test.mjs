import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StanceCalibration, ThrowTracker, readSample, pointingBeam, speedFromSwing, THROW, CALIBRATION,
} from './throw.js';
import { axesFromSample, DEG } from '../../core/orientation.js';

/** Phone held flat (top edge forward) pointing `heading` degrees clockwise from north. */
const flat = (heading = 0, pitch = 0, motion = { rx: 0, ry: 0, rz: 0 }) => ({
  alpha: (360 - heading) % 360, beta: pitch, gamma: 0, motion,
});
/** Phone held upright, back of the phone pointing at `heading`. */
const upright = (heading = 0, motion = { rx: 0, ry: 0, rz: 0 }) => ({
  alpha: (360 - heading) % 360, beta: 90, gamma: 0, motion,
});

function holdStill(cal, make, fromMs = 0, ms = 1000, stepMs = 8) {
  let done = false;
  for (let t = fromMs; t <= fromMs + ms; t += stepMs) done = cal.update(make(t), t) || done;
  return done;
}
const calibrated = (heading = 0, make = (t) => flat(heading)) => {
  const cal = new StanceCalibration();
  holdStill(cal, make);
  return cal;
};

// ── Orientation plumbing ───────────────────────────────────────────────────
test('flat and upright grips both resolve to a horizontal beam and heading', () => {
  const f = readSample(flat(90));
  assert.equal(f.grip, 'flat');
  assert.ok(Math.abs(f.heading - 90) < 1e-6);
  const u = readSample(upright(270));
  assert.equal(u.grip, 'upright');
  assert.ok(Math.abs(((u.heading + 360) % 360) - 270) < 1e-6);
  assert.ok(Math.abs(pointingBeam(axesFromSample(flat(0, 20))).beam.z - Math.sin(20 * DEG)) < 1e-9);
});

// ── Calibration ────────────────────────────────────────────────────────────
test('calibration completes once the phone is held still long enough', () => {
  const cal = new StanceCalibration();
  assert.equal(cal.ready, false);
  assert.equal(holdStill(cal, () => flat(40), 0, 400), false, 'too brief');
  assert.equal(cal.ready, false);
  assert.ok(cal.progress > 0 && cal.progress < 1);
  assert.equal(holdStill(cal, () => flat(40), 408, 600), true);
  assert.ok(cal.ready);
  assert.ok(Math.abs(cal.heading - 40) < 0.5);
  assert.equal(cal.progress, 1);
});

test('calibration restarts if the phone is waved around', () => {
  const cal = new StanceCalibration();
  holdStill(cal, () => flat(0), 0, 500);
  cal.update(flat(0, 0, { rx: 300, ry: 0, rz: 0 }), 510);
  assert.equal(cal.progress, 0);
  assert.match(cal.status, /still/i);
  assert.equal(cal.ready, false);
});

test('calibration rejects a phone held at an awkward 45° tilt', () => {
  const cal = new StanceCalibration();
  const done = holdStill(cal, () => flat(0, 45), 0, 1500);
  assert.equal(done, false);
  assert.equal(cal.ready, false);
  assert.match(cal.status, /screen/i);
});

test('a drifting heading blocks calibration until it settles', () => {
  const cal = new StanceCalibration();
  let t = 0;
  for (; t < 1500; t += 8) cal.update(flat((t / 1500) * 40), t);   // 40° sweep
  assert.equal(cal.ready, false, 'a steadily turning phone is not a stance');
  assert.equal(holdStill(cal, () => flat(40), t, 900), true);
});

test('calibration also works for an upright grip', () => {
  const cal = new StanceCalibration();
  assert.ok(holdStill(cal, () => upright(75)));
  assert.equal(cal.grip, 'upright');
  assert.ok(Math.abs(cal.heading - 75) < 0.5);
});

test('relative heading is signed: right of straight is positive', () => {
  const cal = calibrated(350);
  assert.ok(Math.abs(cal.relative(10) - 20) < 0.6, 'wraps across north');
  assert.ok(cal.relative(340) < 0);
});

// ── Throwing ───────────────────────────────────────────────────────────────

/** Grip, swing for a while, release. Returns every non-null event. */
function throwWith({ cal, swing = 450, twist = 0, grip = 600, swingMs = 260, aim = 0, drift = 0, make = flat, hold = true } = {}) {
  const tracker = new ThrowTracker(cal);
  const out = [];
  let t = 1500;
  const push = (e) => { if (e) out.push(e); };
  for (let i = 0; i < grip / 8; i += 1, t += 8) push(tracker.update(make(cal.heading + aim, 0, { rx: 0, ry: 0, rz: 0 }), t, hold && i > 3));
  for (let i = 0; i < swingMs / 8; i += 1, t += 8) {
    const k = Math.sin((i / (swingMs / 8)) * Math.PI);
    push(tracker.update(make(cal.heading + aim + drift * (i / (swingMs / 8)), 0, { rx: swing * k, ry: twist, rz: 0 }), t, hold));
  }
  push(tracker.update(make(cal.heading + aim + drift, 0, { rx: swing * 0.05, ry: twist, rz: 0 }), t, false));
  return out;
}

test('nothing happens before the stance is calibrated', () => {
  const cal = new StanceCalibration();
  const out = throwWith({ cal });
  assert.deepEqual(out, []);
});

test('hold A then release after a swing gives a throw; the grip is announced', () => {
  const cal = calibrated(0);
  const out = throwWith({ cal });
  assert.equal(out[0].type, 'grip');
  const t = out.at(-1);
  assert.equal(t.type, 'throw');
  assert.ok(t.speed > 5 && t.speed <= 10.2, `speed ${t.speed}`);
  assert.ok(Math.abs(t.angle) < 0.01);
  assert.ok(Math.abs(t.hook) < 0.01);
  assert.ok(t.power > 0.3 && t.power <= 1);
});

test('a harder swing throws faster than a gentle one', () => {
  const cal = calibrated(0);
  const hard = throwWith({ cal, swing: 700 }).at(-1);
  const soft = throwWith({ cal, swing: 140 }).at(-1);
  assert.equal(soft.type, 'throw');
  assert.ok(hard.speed > soft.speed + 3, `${hard.speed} vs ${soft.speed}`);
  assert.equal(speedFromSwing(0), 2.2);
  assert.ok(speedFromSwing(5000) <= 10.2);
});

test('aim follows where the phone points when the ball is gripped', () => {
  const cal = calibrated(30);
  const right = throwWith({ cal, aim: 8 }).at(-1);
  const left = throwWith({ cal, aim: -8 }).at(-1);
  const expected = 8 * THROW.aimGain * DEG;
  assert.ok(Math.abs(right.angle - expected) < 0.01, `right ${right.angle} vs ${expected}`);
  assert.ok(Math.abs(left.angle + expected) < 0.01, `left ${left.angle}`);
  assert.ok(Math.abs(right.angle + left.angle) < 0.005, 'symmetric');
});

test('aim is clamped so a wild swing cannot throw sideways', () => {
  const cal = calibrated(0);
  const t = throwWith({ cal, aim: 80 }).at(-1);
  assert.ok(t.angle <= 17.01 * THROW.aimGain * DEG);
});

test('wrist twist sets the hook, and its sign carries through', () => {
  const cal = calibrated(0);
  const right = throwWith({ cal, twist: 300 }).at(-1);
  const left = throwWith({ cal, twist: -300 }).at(-1);
  const none = throwWith({ cal, twist: 20 }).at(-1);
  assert.ok(right.hook > 0.5, `${right.hook}`);
  assert.ok(left.hook < -0.5);
  assert.equal(none.hook, 0, 'small tremor inside the deadzone is ignored');
});

test('twist can be inverted for devices that report the opposite sign', () => {
  const cal = calibrated(0);
  const tracker = new ThrowTracker(cal, { invertTwist: true });
  const events = [];
  for (let i = 0; i < 41; i += 1) {
    const e = tracker.update(flat(0, 0, { rx: 400, ry: 300, rz: 0 }), 1500 + i * 8, i < 40);
    if (e) events.push(e);
  }
  const out = events.find((e) => e.type === 'throw');
  assert.ok(out, 'a throw was produced');
  assert.ok(out.hook < -0.5, `hook ${out.hook}`);
});

test('letting go without swinging cancels instead of throwing', () => {
  const cal = calibrated(0);
  const out = throwWith({ cal, swing: 10 });
  assert.equal(out.at(-1).type, 'cancel');
});

test('a bounce of the button right after gripping is not a throw', () => {
  const cal = calibrated(0);
  const tracker = new ThrowTracker(cal);
  assert.equal(tracker.update(flat(0), 2000, true).type, 'grip');
  assert.equal(tracker.update(flat(0, 0, { rx: 900, ry: 0, rz: 0 }), 2040, false).type, 'cancel');
});

test('the aim reading follows the phone for the on-screen arrow', () => {
  const cal = calibrated(100);
  const tracker = new ThrowTracker(cal);
  assert.ok(Math.abs(tracker.aim(flat(112)) - 12 * THROW.aimGain) < 0.2);
  assert.ok(tracker.aim(flat(160)) <= THROW.maxAimDeg * THROW.aimGain + 1e-9);
  assert.equal(new ThrowTracker(new StanceCalibration()).aim(flat(10)), 0);
});

test('calibration constants are sane', () => {
  assert.ok(CALIBRATION.holdMs >= 400 && CALIBRATION.holdMs <= 1000);
});
