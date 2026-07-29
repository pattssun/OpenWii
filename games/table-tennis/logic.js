import { stepBall } from '../shared/ball.js';

/**
 * Table Tennis — rally logic. No renderer, no DOM.
 *
 * Simplified rules tuned for feel: the ball must clear the net and land on the
 * far side; hitting the net or missing the return gives the point away. The
 * player's skill is POSITION — the paddle (driven by the pointer) must be on
 * the ball's line when it crosses the hit plane — and swing speed adds pace.
 * First to 11 wins. All randomness injected.
 */

export const TABLE = {
  LENGTH: 2.74, WIDTH: 1.525, HEIGHT: 0.76, NET: 0.1525,
};
export const PLAYER_Z = 1.75;
export const AI_Z = -1.75;
export const REACH = 0.42;          // paddle radius of effect
export const WIN_SCORE = 11;

export class Rally {
  constructor({ onEvent = () => {}, rng = Math.random, aiSkill = 0.8 } = {}) {
    this.onEvent = onEvent;
    this.rng = rng;
    this.aiSkill = aiSkill;

    this.state = 'ready';           // ready | rally | point | over
    this.score = { player: 0, ai: 0 };
    this.winner = null;
    this.server = 'player';
    this.hits = 0;                  // consecutive hits this rally
    this.longestRally = 0;

    this.ball = { x: 0, y: 1.1, z: 0, vx: 0, vy: 0, vz: 0 };
    this.ballLive = false;
    this.lastCrossedNet = null;

    this.paddle = { x: 0, y: TABLE.HEIGHT + 0.15 };   // player paddle position
    this.aiPaddle = { x: 0 };
    this.swingBoost = 0;            // latest swing speed, decays
    this.pauseUntil = 0;
  }

  start(now) {
    this.state = 'rally';
    this.score = { player: 0, ai: 0 };
    this.winner = null;
    this.hits = 0;
    this.longestRally = 0;
    this.serve('player', now);
    this.onEvent({ type: 'start' });
  }

  serve(who, now) {
    this.server = who;
    const dir = who === 'player' ? -1 : 1;
    this.ball = {
      x: (this.rng() - 0.5) * 0.4,
      y: TABLE.HEIGHT + 0.35,
      z: who === 'player' ? PLAYER_Z - 0.15 : AI_Z + 0.15,
      vx: (this.rng() - 0.5) * 0.6,
      vy: 2.4,
      vz: dir * 3.4,
    };
    this.ballLive = true;
    this.hits = 0;
    this.onEvent({ type: 'serve', who });
  }

  /** Pointer position (normalised 0..1) → paddle in table space. */
  setPaddle(nx, ny) {
    this.paddle.x = (nx - 0.5) * (TABLE.WIDTH + 0.7);
    this.paddle.y = TABLE.HEIGHT + 0.05 + (1 - ny) * 0.7;
  }

  /** A swing just happened; the next return gets its pace. */
  swing(peakDps) {
    this.swingBoost = Math.min(1, peakDps / 500);
  }

  scorePoint(who, why, now) {
    this.score[who] += 1;
    this.longestRally = Math.max(this.longestRally, this.hits);
    this.onEvent({ type: 'point', who, why, score: { ...this.score } });
    if (this.score[who] >= WIN_SCORE) {
      this.state = 'over';
      this.winner = who;
      this.ballLive = false;
      this.onEvent({ type: 'over', winner: who });
      return;
    }
    this.state = 'point';
    this.ballLive = false;
    this.pauseUntil = now + 1200;
    this.nextServer = who;          // point winner serves
  }

  /** Return the ball from a paddle at (px, py) toward the other side. */
  hitBall(towardAI, px, aimX, power) {
    const b = this.ball;
    this.hits += 1;
    const dir = towardAI ? -1 : 1;
    const pace = 3.6 + power * 2.6;
    b.vz = dir * pace;
    // Arc height scales down with pace so hard hits fly flatter but still
    // clear the net (validated by test, not by hope).
    b.vy = 2.35 - power * 0.55;
    b.vx = (aimX - b.x) * 0.9 + (b.x - px) * 2.2;
    this.onEvent({ type: 'hit', by: towardAI ? 'player' : 'ai' });
  }

  update(now, dt) {
    if (this.state === 'point' && now >= this.pauseUntil) {
      this.state = 'rally';
      this.serve(this.nextServer, now);
    }
    if (this.state !== 'rally' || !this.ballLive) return;

    const b = this.ball;
    const prevZ = b.z;
    stepBall(b, dt, { gravity: 9.81, drag: 0.06 });
    this.swingBoost = Math.max(0, this.swingBoost - dt * 1.5);

    // Table bounce (only over the table's footprint).
    const overTable = Math.abs(b.x) < TABLE.WIDTH / 2 && Math.abs(b.z) < TABLE.LENGTH / 2;
    if (b.y < TABLE.HEIGHT && overTable && b.vy < 0) {
      b.y = TABLE.HEIGHT;
      b.vy = -b.vy * 0.82;
      this.onEvent({ type: 'bounce', z: b.z });
    }

    // Net: crossing z=0 below net height gives the point away.
    if (prevZ !== b.z && Math.sign(prevZ) !== Math.sign(b.z)) {
      if (b.y < TABLE.HEIGHT + TABLE.NET) {
        const who = prevZ > 0 ? 'ai' : 'player';   // whoever hit it loses
        this.onEvent({ type: 'net' });
        this.scorePoint(who, 'net', now);
        return;
      }
      this.lastCrossedNet = now;
    }

    // Player return plane.
    if (b.vz > 0 && prevZ < PLAYER_Z && b.z >= PLAYER_Z) {
      const dist = Math.hypot(b.x - this.paddle.x, b.y - this.paddle.y);
      if (dist < REACH) {
        this.hitBall(true, this.paddle.x, (this.rng() - 0.5) * 0.8, this.swingBoost);
      } else {
        this.scorePoint('ai', 'missed return', now);
        return;
      }
    }

    // AI return plane.
    if (b.vz < 0 && prevZ > AI_Z && b.z <= AI_Z) {
      const err = Math.abs(b.x - this.aiPaddle.x);
      const whiff = err > REACH || this.rng() > this.aiSkill + 0.15 - this.swingBoost * 0.25;
      if (!whiff) {
        this.hitBall(false, this.aiPaddle.x, (this.rng() - 0.5) * 1.0, 0.25 + this.rng() * 0.3);
      } else {
        this.scorePoint('player', 'winner', now);
        return;
      }
    }

    // AI paddle tracks the ball with capped speed.
    const track = (b.x - this.aiPaddle.x);
    const maxStep = (0.9 + this.aiSkill * 1.6) * dt;
    this.aiPaddle.x += Math.max(-maxStep, Math.min(maxStep, track));

    // Floor: whoever failed to keep it up loses the point.
    if (b.y < 0.02) {
      const who = b.z > 0 ? 'ai' : 'player';   // fell on player side → ai point... resolved below
      this.scorePoint(b.z > 0 ? 'ai' : 'player', 'floor', now);
    }
    // Sailed long past either end without being touched.
    if (b.z > PLAYER_Z + 1.2) this.scorePoint('ai', 'long', now);
    else if (b.z < AI_Z - 1.2) this.scorePoint('player', 'long', now);
  }
}
