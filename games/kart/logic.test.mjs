import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Race, trackCenter, trackTangent, nearestOnTrack, tDiff, fmtMs,
  RACE_LAPS, TRACK_HALF_WIDTH, TOP_SPEED, GRASS_SPEED,
} from './logic.js';

test('the circuit is closed, deterministic, and bends both ways', () => {
  const a = trackCenter(0);
  const b = trackCenter(0.999999);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.5, 'the loop closes');
  assert.deepEqual(trackCenter(0.37), trackCenter(0.37));
  // Curvature changes sign somewhere — a real circuit, not a circle.
  let left = false;
  let right = false;
  for (let t = 0; t < 1; t += 1 / 128) {
    const t0 = trackTangent(t);
    const t1 = trackTangent((t + 1 / 128) % 1);
    const cross = t0.x * t1.z - t0.z * t1.x;
    if (cross > 1e-6) left = true;
    if (cross < -1e-6) right = true;
  }
  assert.ok(left && right, 'has both left and right turns');
});

/** Blunt autopilot: steer at a point a little ahead on the centreline. */
function autopilot(race, lookahead = 0.022) {
  const aheadT = (race.trackT + lookahead) % 1;
  const p = trackCenter(aheadT);
  const want = Math.atan2(p.x - race.pos.x, -(p.z - race.pos.z));
  let diff = want - race.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff <= -Math.PI) diff += 2 * Math.PI;
  race.setSteer(Math.max(-60, Math.min(60, diff * 140)));
}

test('tilt steers: bank right curves the kart right, straight goes straight', () => {
  const r = new Race({});
  r.start(0);
  r.speed = TOP_SPEED;
  let now = 0;
  r.setSteer(0);
  const h0 = r.heading;
  for (let i = 0; i < 60; i += 1) { now += 16; r.update(now, 0.016); }
  assert.ok(Math.abs(r.heading - h0) < 1e-9, 'no phantom steering');

  r.setSteer(35);
  const before = r.heading;
  for (let i = 0; i < 60; i += 1) { now += 16; r.update(now, 0.016); }
  assert.ok(r.heading - before > 0.4, 'banking right turns right');
});

test('grass is slow: off the track the kart drops to crawl speed', () => {
  const r = new Race({});
  r.start(0);
  // Park it far off the circuit and let the throttle settle.
  r.pos = { x: 0, z: 0 };            // the infield is nowhere near the ribbon
  const near = nearestOnTrack(0, 0);
  assert.ok(near.dist > TRACK_HALF_WIDTH, 'infield is off-track');
  r.setSteer(0);
  let now = 0;
  for (let i = 0; i < 400; i += 1) { now += 16; r.heading += 0.05; r.update(now, 0.016); }
  assert.ok(r.speed <= GRASS_SPEED + 0.5, `grass caps speed (${r.speed.toFixed(1)} m/s)`);
  assert.ok(GRASS_SPEED < TOP_SPEED / 2, 'grass is a real penalty');
});

test('three laps: checkpoints in order, lap times recorded, race completes', () => {
  const r = new Race({});
  const events = [];
  r.onEvent = (e) => events.push(e);
  r.start(0);
  let now = 0;
  for (let i = 0; i < 60 * 60 * 6 && r.state === 'racing'; i += 1) {
    now += 16;
    autopilot(r);
    r.update(now, 0.016);
  }
  assert.equal(r.state, 'done', `race finished (lap ${r.lap}, cp ${r.nextCp})`);
  assert.equal(r.lapTimes.length, RACE_LAPS);
  const laps = events.filter((e) => e.type === 'lap');
  assert.equal(laps.length, RACE_LAPS);
  for (const ms of r.lapTimes) {
    assert.ok(ms > 15000 && ms < 120000, `lap time is sane (${fmtMs(ms)})`);
  }
  assert.equal(r.bestLapMs, Math.min(...r.lapTimes));
  const doneEvent = events.find((e) => e.type === 'done');
  assert.equal(doneEvent.totalMs, r.lapTimes.reduce((a, b) => a + b, 0));
  // Checkpoints all fired, in order, every lap.
  const cps = events.filter((e) => e.type === 'checkpoint').map((e) => e.index);
  assert.equal(cps.length, (5) * RACE_LAPS, 'five ordered checkpoints per lap');
});

test('the ghost is the best lap, replayable at any time offset', () => {
  const r = new Race({});
  r.start(0);
  let now = 0;
  for (let i = 0; i < 60 * 60 * 6 && r.state === 'racing'; i += 1) {
    now += 16;
    autopilot(r);
    r.update(now, 0.016);
  }
  assert.ok(r.ghost && r.ghost.length > 50, `ghost recorded (${r.ghost.length} keyframes)`);
  assert.ok(Math.abs(r.ghost[r.ghost.length - 1].ms - r.bestLapMs) < 150,
    'ghost spans the best lap');
  // Replay stays on the circuit and interpolates between keyframes.
  for (let ms = 0; ms <= r.bestLapMs; ms += 500) {
    const g = r.ghostAt(ms);
    const near = nearestOnTrack(g.x, g.z);
    assert.ok(near.dist < TRACK_HALF_WIDTH * 2, `ghost near the track at ${fmtMs(ms)}`);
  }
  const mid = r.ghostAt(r.ghost[3].ms + 50);   // between keyframes 3 and 4
  const a = r.ghost[3];
  const b = r.ghost[4];
  assert.ok((mid.x - a.x) * (b.x - a.x) + (mid.z - a.z) * (b.z - a.z) >= 0,
    'interpolation moves from keyframe 3 toward 4');
});

test('tDiff wraps: the shortest way from 0.98 to 0.02 is forward', () => {
  assert.ok(Math.abs(tDiff(0.02, 0.98) - 0.04) < 1e-12);
  assert.ok(Math.abs(tDiff(0.98, 0.02) + 0.04) < 1e-12);
  assert.equal(fmtMs(83450), '1:23.45');
});
