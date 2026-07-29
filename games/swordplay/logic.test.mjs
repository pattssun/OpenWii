import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Duel, AI, WIN_POINTS, swordBasis, bladeScreenAngle,
} from './logic.js';
import { bodyAxes, DEG } from '../../core/orientation.js';

/** Deterministic rng from a fixed sequence (cycles). */
const seq = (vals) => {
  let i = 0;
  return () => vals[(i += 1) % vals.length];
};

function fightingDuel(rngVals = [0.9]) {
  const events = [];
  const d = new Duel({ onEvent: (e) => events.push(e), rng: seq(rngVals) });
  d.start(0);
  return { d, events };
}

/** Run update() forward in 16ms steps until a predicate or timeout. */
function runUntil(d, from, cond, maxMs = 20000) {
  let now = from;
  while (now < from + maxMs) {
    now += 16;
    d.update(now, 0.016);
    if (cond(now)) return now;
  }
  return now;
}

// ── Player offence: swings are aimed, not mashed ───────────────────────────
test('a swing around the AI guard scores; into the guard is parried', () => {
  const { d, events } = fightingDuel();
  d.aiState = AI.NEUTRAL;
  d.aiUntil = 1e12;               // freeze the AI brain for this test
  d.aiGuard = 0;                  // guarding the horizontal line

  d.swing({ angle: Math.PI / 2, peak: 300, travel: 40 }, 1000);   // vertical slash
  assert.equal(d.player.points, 1, 'vertical slash beats a horizontal guard');

  // Scoring pauses the bout; advance past the pause before the next swing.
  runUntil(d, 1000, () => d.state === 'fighting', 3000);
  d.aiState = AI.NEUTRAL;
  d.aiUntil = 1e12;
  d.aiGuard = 0;
  d.swing({ angle: 0.1, peak: 300, travel: 40 }, 4000);           // into the guard
  assert.equal(d.player.points, 1, 'parried');
  assert.ok(events.some((e) => e.type === 'parried'));
});

test('the AI is open during windup and recover', () => {
  const { d } = fightingDuel();
  d.aiGuard = Math.PI / 2;
  d.aiState = AI.WINDUP;
  d.aiUntil = 1e12;
  d.swing({ angle: Math.PI / 2, peak: 300, travel: 40 }, 1000);
  assert.equal(d.player.points, 1, 'a swing into the guard angle still lands mid-windup');
});

// ── Blocking is blade geometry, not timing ─────────────────────────────────
test('a perpendicular blade blocks; a parallel blade takes the hit', () => {
  for (const [blade, shouldBlock] of [
    [Math.PI / 2, true],    // strike comes horizontally; vertical blade blocks
    [0, false],             // parallel blade does not
    [Math.PI / 2 + 0.4, true],   // within tolerance
    [Math.PI / 4, false],        // 45° off is outside tolerance
  ]) {
    const { d, events } = fightingDuel();
    d.aiState = AI.WINDUP;
    d.aiStrikeAngle = 0;         // horizontal strike
    d.aiUntil = 500;             // strike lands at the next update past this
    d.setBlade(blade, false);
    d.update(600, 0.016);
    if (shouldBlock) {
      assert.equal(d.ai.points, 0, `blade at ${blade.toFixed(2)} blocks`);
      assert.ok(events.some((e) => e.type === 'blocked'));
    } else {
      assert.equal(d.ai.points, 1, `blade at ${blade.toFixed(2)} fails to block`);
    }
  }
});

test('a perpendicular blade mid-swing does not block', () => {
  const { d } = fightingDuel();
  d.aiState = AI.WINDUP;
  d.aiStrikeAngle = 0;
  d.aiUntil = 500;
  d.setBlade(Math.PI / 2, true);   // right angle, but swinging
  d.update(600, 0.016);
  assert.equal(d.ai.points, 1, 'guard requires a held blade');
});

// ── Full match, both outcomes ──────────────────────────────────────────────
test('a match is completable to a player win', () => {
  const { d } = fightingDuel();
  d.aiUntil = 1e12;
  let now = 0;
  for (let i = 0; i < WIN_POINTS; i += 1) {
    d.aiGuard = 0;
    d.swing({ angle: Math.PI / 2, peak: 300, travel: 40 }, now);
    now = runUntil(d, now, () => d.state !== 'point', 3000);
    d.aiUntil = 1e12;
  }
  assert.equal(d.state, 'over');
  assert.equal(d.winner, 'player');
});

test('a match is completable to a loss, driven only by the AI clock', () => {
  // Never swing, hold the blade where it cannot block: rng 0.125 → strike at
  // 45°, whose perpendicular (135°) is 45° from a blade at 0 — outside the
  // 36° tolerance. (First draft used a strike the idle blade legitimately
  // blocked forever; the AI wasn't stuck, it was being parried.)
  const { d } = fightingDuel([0.125]);
  d.setBlade(0, false);
  const end = runUntil(d, 0, () => d.state === 'over', 60000);
  assert.equal(d.state, 'over', `match ended by ${end}ms`);
  assert.equal(d.winner, 'ai');
});

// ── 1:1 sword orientation ──────────────────────────────────────────────────
test('the sword basis is orthonormal and tracks attitude 1:1', () => {
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm3 = (a) => Math.sqrt(dot3(a, a));

  const b0 = swordBasis(bodyAxes(0, 0, 0));
  for (const k of ['right', 'blade', 'face']) {
    assert.ok(Math.abs(norm3(b0[k]) - 1) < 1e-9, `${k} unit length`);
  }
  assert.ok(Math.abs(dot3(b0.right, b0.blade)) < 1e-9, 'orthogonal');

  // Rotating the phone by θ rotates the blade by exactly θ.
  for (const theta of [10, 35, 80]) {
    const b1 = swordBasis(bodyAxes(0, theta, 0));
    const cos = dot3(b0.blade, b1.blade);
    const measured = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
    assert.ok(Math.abs(measured - theta) < 0.01,
      `pitch ${theta}° → blade rotated ${measured.toFixed(2)}°`);
  }
  const roll = swordBasis(bodyAxes(0, 0, 40));
  const cosR = dot3(b0.face, roll.face);
  const measuredR = Math.acos(Math.max(-1, Math.min(1, cosR))) / DEG;
  assert.ok(Math.abs(measuredR - 40) < 0.01, `roll 40° → face rotated ${measuredR.toFixed(2)}°`);
});

test('bladeScreenAngle reads the blade line in screen space', () => {
  // Flat phone: blade points into the screen → degenerate on screen; roll the
  // phone 90° upright: blade points up → angle ≈ ±π/2.
  const upright = bladeScreenAngle(bodyAxes(0, 90, 0));
  assert.ok(Math.abs(Math.abs(upright) - Math.PI / 2) < 0.02,
    `upright blade reads vertical (${upright.toFixed(2)})`);
});
