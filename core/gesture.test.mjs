import test from 'node:test';
import assert from 'node:assert/strict';
import { SwingDetector, lineDiff } from './gesture.js';
import { gripTilt } from './orientation.js';
import { bodyAxes } from './orientation.js';

/** Feed a rate profile (deg/s) at 60Hz; collect emitted swings. */
function feed(profile) {
  const d = new SwingDetector({});
  const swings = [];
  let ms = 0;
  for (const [yaw, pitch] of profile) {
    const s = d.update({ yaw, pitch }, 1 / 60, ms);
    if (s) swings.push(s);
    ms += 1000 / 60;
  }
  return swings;
}

test('a fast horizontal slash is one swing with the right direction', () => {
  const profile = [];
  for (let i = 0; i < 20; i += 1) profile.push([300, 0]);   // hard yaw-left
  for (let i = 0; i < 10; i += 1) profile.push([0, 0]);
  const swings = feed(profile);
  assert.equal(swings.length, 1);
  // yaw+ = left → cursor-space −x → angle ≈ π (or −π).
  assert.ok(Math.abs(Math.abs(swings[0].angle) - Math.PI) < 0.15,
    `angle ${swings[0].angle.toFixed(2)}`);
  assert.ok(swings[0].travel > 25);
});

test('a slow wide wave is not a swing', () => {
  const profile = [];
  for (let i = 0; i < 120; i += 1) profile.push([80, 0]);   // 80 deg/s for 2s
  assert.equal(feed(profile).length, 0, 'below the arm threshold, never fires');
});

test('a fast but tiny jerk is not a swing', () => {
  const profile = [[400, 0], [400, 0], [0, 0], [0, 0]];      // ~13° of travel
  assert.equal(feed(profile).length, 0, 'insufficient travel');
});

test('a held fast rotation times out as a gesture, not a swing', () => {
  const profile = [];
  for (let i = 0; i < 60; i += 1) profile.push([250, 0]);    // a full second
  assert.equal(feed(profile).length, 0, 'exceeds maxMs');
});

test('two separated slashes are two swings', () => {
  const profile = [];
  for (let i = 0; i < 15; i += 1) profile.push([0, 320]);    // downward
  for (let i = 0; i < 20; i += 1) profile.push([0, 0]);
  for (let i = 0; i < 15; i += 1) profile.push([0, -320]);   // upward
  for (let i = 0; i < 20; i += 1) profile.push([0, 0]);
  const swings = feed(profile);
  assert.equal(swings.length, 2);
  // pitch+ = up → cursor −y; pitch− → +y (screen-down).
  assert.ok(swings[0].angle < 0 && swings[1].angle > 0, 'opposite directions');
});

test('lineDiff treats a blade and its flip as the same line', () => {
  assert.ok(lineDiff(0.2, 0.2 + Math.PI) < 1e-9);
  assert.ok(Math.abs(lineDiff(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
});

// ── Tilt (steering-wheel / flight-stick input) ─────────────────────────────
test('gripTilt matches the physical tilt, numerically pinned', () => {
  // Flat grip: bank equals the roll angle, pitch equals the beam elevation.
  assert.ok(Math.abs(gripTilt(bodyAxes(0, 0, 20)).bank - 20) < 0.01, 'roll right 20° → bank 20');
  assert.ok(Math.abs(gripTilt(bodyAxes(0, 0, -35)).bank + 35) < 0.01, 'roll left 35° → bank −35');
  assert.ok(Math.abs(gripTilt(bodyAxes(0, 25, 0)).pitch - 25) < 0.01, 'tip up 25° → pitch 25');
  assert.ok(Math.abs(gripTilt(bodyAxes(0, 0, 0)).bank) < 1e-9, 'level → 0');
});

test('gripTilt pitch works in the upright grip via beam selection', () => {
  // Upright at beta 80°, then tip further: the beam is the phone's back.
  const level = gripTilt(bodyAxes(0, 90, 0));
  assert.ok(Math.abs(level.pitch) < 0.01, 'upright pointing level');
  // Numerically: at β=110° the phone's back (−z) gains +world-z → beam rises;
  // at β=70° it dips. (First draft had this backwards — the numbers decide.)
  const up = gripTilt(bodyAxes(0, 110, 0));
  const down = gripTilt(bodyAxes(0, 70, 0));
  assert.ok(up.pitch > 15, `tipped back → beam up (${up.pitch.toFixed(1)}°)`);
  assert.ok(down.pitch < -15, `tipped forward → beam down (${down.pitch.toFixed(1)}°)`);
});
