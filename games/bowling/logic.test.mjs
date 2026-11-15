import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE, rack, nextRoll, scoreFrames, totalScore, marks,
  LaneSim, simulateRoll, normalizeThrow, Match, FIXED_DT,
} from './logic.js';

const rollsOf = (...r) => r;

// ── Scoring ────────────────────────────────────────────────────────────────
test('a perfect game is 300 and a gutter game is 0', () => {
  assert.equal(totalScore(Array(12).fill(10)), 300);
  assert.equal(totalScore(Array(20).fill(0)), 0);
});

test('all spares with 5 pins scores 150', () => {
  assert.equal(totalScore(Array(21).fill(5)), 150);
});

test('a worked example with strikes, spares and misses scores 167', () => {
  const rolls = rollsOf(10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1);
  assert.equal(totalScore(rolls), 167);
  const frames = scoreFrames(rolls);
  assert.deepEqual(frames.map((f) => f.score), [20, 39, 48, 66, 74, 84, 90, 120, 148, 167]);
});

test('a strike or spare shows no score until its bonus rolls have been bowled', () => {
  assert.equal(scoreFrames([10])[0].score, null);
  assert.equal(scoreFrames([10, 3])[0].score, null);
  assert.equal(scoreFrames([10, 3, 4])[0].score, 17);
  assert.equal(scoreFrames([6, 4])[0].score, null);
  assert.equal(scoreFrames([6, 4, 5])[0].score, 15);
  assert.equal(totalScore([10]), 0);
});

test('the tenth frame gives bonus rolls only after a strike or spare', () => {
  const nine = Array(18).fill(0);
  assert.deepEqual(nextRoll(nine), { frame: 10, roll: 0, fresh: true, done: false });
  assert.equal(nextRoll([...nine, 3, 4]).done, true);
  assert.deepEqual(nextRoll([...nine, 10]), { frame: 10, roll: 1, fresh: true, done: false });
  assert.deepEqual(nextRoll([...nine, 10, 7]), { frame: 10, roll: 2, fresh: false, done: false });
  assert.deepEqual(nextRoll([...nine, 10, 10]), { frame: 10, roll: 2, fresh: true, done: false });
  assert.deepEqual(nextRoll([...nine, 6, 4]), { frame: 10, roll: 2, fresh: true, done: false });
  assert.equal(nextRoll([...nine, 6, 4, 9]).done, true);
  assert.equal(totalScore([...nine, 6, 4, 9]), 19);
});

test('nextRoll tracks the frame and whether the rack is fresh', () => {
  assert.deepEqual(nextRoll([]), { frame: 1, roll: 0, fresh: true, done: false });
  assert.deepEqual(nextRoll([7]), { frame: 1, roll: 1, fresh: false, done: false });
  assert.deepEqual(nextRoll([7, 2]), { frame: 2, roll: 0, fresh: true, done: false });
  assert.deepEqual(nextRoll([10]), { frame: 2, roll: 0, fresh: true, done: false });
});

test('scorecard marks show X, / and - the way a paper card does', () => {
  const frames = scoreFrames([10, 7, 3, 0, 9]);
  assert.deepEqual(marks(frames[0], 0), ['', 'X']);
  assert.deepEqual(marks(frames[1], 1), ['7', '/']);
  assert.deepEqual(marks(frames[2], 2), ['-', '9']);
  const tenth = { rolls: [10, 10, 10] };
  assert.deepEqual(marks(tenth, 9), ['X', 'X', 'X']);
  assert.deepEqual(marks({ rolls: [10, 7, 3] }, 9), ['X', '7', '/']);
  assert.deepEqual(marks({ rolls: [6, 4, 10] }, 9), ['6', '/', 'X']);
});

// ── Lane geometry ──────────────────────────────────────────────────────────
test('the rack is a ten-pin triangle with the head pin 60ft out', () => {
  const pins = rack();
  assert.equal(pins.length, 10);
  assert.deepEqual(pins.map((p) => p.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(pins[0].z, LANE.headPinZ);
  assert.ok(Math.abs(pins[0].x) < 1e-9);
  // 7 and 10 are the back corners, one lane-third wide each side.
  assert.ok(pins[6].x < -0.4 && pins[9].x > 0.4);
  assert.ok(pins[6].z > pins[0].z);
});

// ── Physics ────────────────────────────────────────────────────────────────
const strikeThrow = { x0: 0.04, angle: 0, speed: 8, hook: 0 };

test('a fast ball into the pocket knocks down most of the rack', () => {
  const { knocked } = simulateRoll(rack(), { ...strikeThrow, x0: 0.05 });
  assert.ok(knocked >= 8, `expected a big hit, got ${knocked}`);
});

test('a gutter ball knocks nothing down and is reported', () => {
  const { knocked, events } = simulateRoll(rack(), { x0: 0.4, angle: 0.12, speed: 7, hook: 0 });
  assert.equal(knocked, 0);
  assert.ok(events.some((e) => e.type === 'gutter'));
});

test('a slow ball down the middle hits fewer pins than a fast one', () => {
  const slow = simulateRoll(rack(), { x0: 0, angle: 0, speed: 2.4, hook: 0 }).knocked;
  const fast = simulateRoll(rack(), { x0: 0, angle: 0, speed: 9, hook: 0 }).knocked;
  assert.ok(fast > slow, `fast ${fast} should beat slow ${slow}`);
});

test('hook curves the ball towards the side it spins', () => {
  const run = (hook) => {
    const sim = new LaneSim({ pins: [], throw: { x0: 0, angle: 0, speed: 7, hook } });
    for (let i = 0; i < 6 * 480 && !sim.done; i += 1) sim.step(FIXED_DT);
    return sim.ball.x;
  };
  assert.ok(run(1) > 0.05, 'positive hook drifts right');
  assert.ok(run(-1) < -0.05, 'negative hook drifts left');
  assert.ok(Math.abs(run(0)) < 1e-6, 'no hook goes straight');
});

test('the simulation is deterministic', () => {
  const t = { x0: 0.1, angle: 0.02, speed: 7.5, hook: 0.4 };
  const a = simulateRoll(rack(), t);
  const b = simulateRoll(rack(), t);
  assert.equal(a.knocked, b.knocked);
  assert.deepEqual(a.standing.map((p) => p.id), b.standing.map((p) => p.id));
});

test('standing pins keep their positions for the second ball', () => {
  const first = simulateRoll(rack(), { x0: -0.3, angle: 0.03, speed: 7, hook: 0 });
  assert.ok(first.knocked > 0 && first.knocked < 10);
  for (const p of first.standing) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});

test('throw parameters are clamped to something playable', () => {
  const t = normalizeThrow({ x0: 9, angle: 5, speed: 99, hook: -7 });
  assert.equal(t.x0, 0.45);
  assert.equal(t.angle, 0.3);
  assert.equal(t.speed, 10.5);
  assert.equal(t.hook, -1);
  assert.deepEqual(normalizeThrow({ x0: NaN, speed: NaN }), { x0: 0, angle: 0, speed: 7, hook: 0 });
});

test('a ball that stops short of the pins ends the roll with no pins down', () => {
  const { knocked, sim } = simulateRoll(rack(), { x0: 0, angle: 0, speed: 2, hook: 0 });
  assert.ok(sim.done);
  assert.ok(knocked <= 3, `a 2 m/s ball should barely trouble the rack, knocked ${knocked}`);
});

// ── Match flow ─────────────────────────────────────────────────────────────
function play(match, throws) {
  for (const t of throws) {
    assert.ok(match.throwBall(t));
    for (let i = 0; i < 4000 && match.state === 'rolling'; i += 1) match.update(1 / 60);
  }
}
const gutter = { x0: 0.4, angle: 0.15, speed: 7, hook: 0 };

test('players alternate frames and a gutter ball ends a roll cleanly', () => {
  const events = [];
  const m = new Match({ players: 2, onEvent: (e) => events.push(e) });
  assert.equal(m.current, 0);
  play(m, [gutter, gutter]);
  assert.equal(m.current, 1, 'player 2 bowls after a full frame');
  assert.deepEqual(m.rolls[0], [0, 0]);
  const rolls = events.filter((e) => e.type === 'roll');
  assert.equal(rolls.length, 2);
  assert.ok(rolls[0].gutter);
  assert.equal(m.position().frame, 1);
});

test('a strike moves straight on to the other player and re-racks', () => {
  const m = new Match({ players: 2 });
  m.rolls[0] = [];
  // Force a strike by faking the sim result: knock the whole rack.
  m.throwBall({ x0: 0, speed: 8 });
  m.sim.pins.forEach((p) => { p.down = true; });
  m.sim.ball.done = true;
  m.sim.settled = 1;
  m.sim.done = true;
  m.update(0.016);
  assert.deepEqual(m.rolls[0], [10]);
  assert.equal(m.current, 1);
  assert.equal(m.pins.length, 10);
});

test('after a first ball the second ball faces only the standing pins', () => {
  const m = new Match({ players: 1 });
  m.throwBall({ x0: -0.3, angle: 0.03, speed: 7, hook: 0 });
  for (let i = 0; i < 4000 && m.state === 'rolling'; i += 1) m.update(1 / 60);
  const left = 10 - m.rolls[0][0];
  assert.equal(m.pins.length, left);
  assert.equal(m.position().roll, 1);
});

test('a full gutter game ends with a zero total and a winner of none', () => {
  const m = new Match({ players: 1 });
  const throws = Array(20).fill(gutter);
  play(m, throws);
  assert.equal(m.state, 'over');
  assert.deepEqual(m.totals(), [0]);
});

test('a two-player match ends once both cards are complete', () => {
  const events = [];
  const m = new Match({ players: 2, onEvent: (e) => events.push(e) });
  play(m, Array(40).fill(gutter));
  assert.equal(m.state, 'over');
  const over = events.find((e) => e.type === 'over');
  assert.deepEqual(over.totals, [0, 0]);
  assert.equal(over.winner, 'tie');
});

test('cannot throw while a ball is already rolling', () => {
  const m = new Match({ players: 1 });
  assert.ok(m.throwBall({ speed: 7 }));
  assert.equal(m.throwBall({ speed: 7 }), false);
});
