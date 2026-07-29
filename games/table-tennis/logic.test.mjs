import test from 'node:test';
import assert from 'node:assert/strict';
import { Rally, TABLE, PLAYER_Z, AI_Z, WIN_SCORE } from './logic.js';

const seq = (vals) => { let i = 0; return () => vals[(i += 1) % vals.length]; };

function make(rngVals = [0.5], aiSkill = 1) {
  const events = [];
  const r = new Rally({ onEvent: (e) => events.push(e), rng: seq(rngVals), aiSkill });
  return { r, events };
}

/** Step the sim; optionally keep the player paddle glued to the ball. */
function run(r, ms, { track = true } = {}) {
  let now = r._t || 0;
  const end = now + ms;
  while (now < end) {
    now += 8;
    if (track && r.ballLive) {
      r.paddle.x = r.ball.x;
      r.paddle.y = Math.max(TABLE.HEIGHT + 0.05, r.ball.y);
    }
    r.update(now, 0.008);
  }
  r._t = now;
  return now;
}

test('a serve clears the net and lands on the far side', () => {
  const { r, events } = make();
  r.start(0);                      // player serves toward the AI
  run(r, 900, { track: false });
  const crossedLow = events.some((e) => e.type === 'net');
  const bounceFar = events.some((e) => e.type === 'bounce' && e.z < 0);
  assert.equal(crossedLow, false, 'did not clip the net');
  assert.ok(bounceFar, 'bounced on the AI side');
});

test('a tracked return clears the net back to the AI half', () => {
  const { r, events } = make();
  r.start(0);
  r.serve('ai', 0);                // incoming ball
  run(r, 2500);
  assert.ok(events.some((e) => e.type === 'hit' && e.by === 'player'), 'player returned it');
  assert.equal(events.some((e) => e.type === 'net'), false, 'return cleared the net');
  assert.ok(events.some((e) => e.type === 'bounce' && e.z < -0.1), 'landed on the AI half');
});

test('a rally is sustainable — the phase-3 headline bar', () => {
  const { r } = make([0.5], 1);
  r.start(0);
  run(r, 20000);
  assert.ok(r.longestRally >= 8 || r.hits >= 8,
    `rally reached ${Math.max(r.longestRally, r.hits)} consecutive hits`);
  assert.equal(r.state === 'over', false, 'nobody collapsed to 11 in 20s of clean play');
});

test('a paddle nowhere near the ball loses the point', () => {
  const { r, events } = make();
  r.start(0);
  r.serve('ai', 0);
  r.paddle.x = 5;                  // far off the table
  r.paddle.y = 3;
  run(r, 3000, { track: false });
  const point = events.find((e) => e.type === 'point');
  assert.ok(point, 'a point was decided');
  assert.equal(point.who, 'ai');
});

test('the game ends at 11 with a winner', () => {
  const { r } = make();
  r.start(0);
  // Rack up points through the real scoring path.
  for (let i = 0; i < WIN_SCORE; i += 1) {
    if (r.state === 'over') break;
    r.state = 'rally';
    r.ballLive = true;
    r.scorePoint('player', 'test', (r._t || 0) + i);
  }
  assert.equal(r.state, 'over');
  assert.equal(r.winner, 'player');
  assert.equal(r.score.player, WIN_SCORE);
});

test('geometry sanity: hit planes bracket the table', () => {
  assert.ok(PLAYER_Z > TABLE.LENGTH / 2 && AI_Z < -TABLE.LENGTH / 2);
});
