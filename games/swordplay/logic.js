import { lineDiff, angleDiff } from '../../core/gesture.js';

/**
 * Swordplay — duel logic. No renderer, no DOM.
 *
 * The loop of a duel:
 *   - The AI guards at a drifting angle. A player swing scores only if it
 *     comes in around that guard (or lands during the AI's windup/recover
 *     openings) — so swinging is aiming, not mashing.
 *   - The AI telegraphs its own strikes (windup pose along a strike angle),
 *     then strikes. The player blocks by HOLDING THE BLADE PERPENDICULAR to
 *     the incoming strike when it lands. Blocking is about blade geometry,
 *     not reaction-time button presses — that is the roadmap's acceptance
 *     criterion, and it is what makes the phone-as-sword feel earned.
 *
 * First to WIN_POINTS points wins the match. All randomness is injected so
 * tests are deterministic.
 */

export const WIN_POINTS = 3;
export const BLOCK_TOLERANCE = Math.PI / 5;    // 36° either side of perpendicular
export const GUARD_TOLERANCE = Math.PI / 3.4;  // AI guard covers ~53° either side

export const AI = {
  NEUTRAL: 'neutral',
  WINDUP: 'windup',
  STRIKE: 'strike',
  RECOVER: 'recover',
};

export class Duel {
  constructor({ onEvent = () => {}, rng = Math.random, difficulty = 0.5 } = {}) {
    this.onEvent = onEvent;
    this.rng = rng;
    this.difficulty = difficulty;

    this.state = 'ready';          // ready | fighting | point | over
    this.player = { points: 0 };
    this.ai = { points: 0 };
    this.winner = null;

    // Player blade, fed continuously from the phone attitude.
    this.bladeAngle = 0;           // screen-plane angle of the blade line
    this.blocking = true;          // guard is simply "not mid-swing"

    // AI fencer.
    this.aiState = AI.NEUTRAL;
    this.aiUntil = 0;
    this.aiGuard = 0;              // angle its blade currently covers
    this.aiGuardTarget = 0;
    this.aiStrikeAngle = 0;
    this.pauseUntil = 0;
  }

  start(now) {
    this.state = 'fighting';
    this.player.points = 0;
    this.ai.points = 0;
    this.winner = null;
    this.aiState = AI.NEUTRAL;
    this.aiUntil = now + 900;
    this.onEvent({ type: 'start' });
  }

  /** Continuous blade update from the phone (angle in radians, screen plane). */
  setBlade(angle, swinging) {
    this.bladeAngle = angle;
    this.blocking = !swinging;
  }

  /** A completed player swing from the SwingDetector. */
  swing(sw, now) {
    if (this.state !== 'fighting') return;
    this.onEvent({ type: 'player-swing', angle: sw.angle });

    // Openings: the AI cannot parry while winding up or recovering.
    const open = this.aiState === AI.WINDUP || this.aiState === AI.RECOVER;
    // Otherwise its guard covers a cone; a swing into that cone is parried.
    const parried = !open && lineDiff(sw.angle, this.aiGuard) < GUARD_TOLERANCE;

    if (parried) {
      this.onEvent({ type: 'parried', angle: sw.angle });
      return;
    }
    this.scorePoint('player', now);
  }

  scorePoint(who, now) {
    this[who].points += 1;
    this.onEvent({ type: 'point', who, player: this.player.points, ai: this.ai.points });
    if (this[who].points >= WIN_POINTS) {
      this.state = 'over';
      this.winner = who;
      this.onEvent({ type: 'over', winner: who });
      return;
    }
    this.state = 'point';
    this.pauseUntil = now + 1400;
    this.aiState = AI.NEUTRAL;
  }

  update(now, dt) {
    if (this.state === 'point' && now >= this.pauseUntil) {
      this.state = 'fighting';
      this.aiState = AI.NEUTRAL;
      this.aiUntil = now + 700;
      this.onEvent({ type: 'resume' });
    }
    if (this.state !== 'fighting') return;

    // Guard drifts toward a target it re-picks now and then, so the opening
    // the player must swing through keeps moving.
    const k = Math.min(1, dt * 3);
    this.aiGuard += angleDiff(this.aiGuardTarget, this.aiGuard) * k;

    if (now < this.aiUntil) return;

    switch (this.aiState) {
      case AI.NEUTRAL: {
        if (this.rng() < 0.45 + this.difficulty * 0.2) {
          // Telegraph a strike along a fresh angle.
          this.aiStrikeAngle = this.rng() * Math.PI * 2;
          this.aiState = AI.WINDUP;
          this.aiUntil = now + 900 - this.difficulty * 350;
          this.onEvent({ type: 'ai-windup', angle: this.aiStrikeAngle, untilMs: this.aiUntil });
        } else {
          this.aiGuardTarget = this.rng() * Math.PI * 2;
          this.aiUntil = now + 500 + this.rng() * 600;
        }
        break;
      }
      case AI.WINDUP: {
        this.aiState = AI.STRIKE;
        this.aiUntil = now + 160;
        // The strike lands NOW: blocked purely by blade geometry.
        const perpendicular = this.aiStrikeAngle + Math.PI / 2;
        const blocked = this.blocking
          && lineDiff(this.bladeAngle, perpendicular) < BLOCK_TOLERANCE;
        if (blocked) {
          this.onEvent({ type: 'blocked', angle: this.aiStrikeAngle });
        } else {
          this.onEvent({ type: 'ai-hit', angle: this.aiStrikeAngle });
          this.scorePoint('ai', now);
          return;
        }
        break;
      }
      case AI.STRIKE: {
        this.aiState = AI.RECOVER;
        this.aiUntil = now + 650 - this.difficulty * 250;
        break;
      }
      case AI.RECOVER:
      default: {
        this.aiState = AI.NEUTRAL;
        this.aiUntil = now + 300;
        break;
      }
    }
  }
}

/**
 * Device attitude → a 3×3 basis for rendering the sword, and the blade's
 * screen-plane angle for block geometry.
 *
 * World (z-up, beam along +y) → view (y-up, beam into −z):
 *   view.x = world.x,  view.y = world.z,  view.z = −world.y
 * The sword blade runs along the device's long axis (+y); its edge plane is
 * the device screen plane. Pure math, so the 1:1 tracking claim is testable
 * in Node rather than by eyeballing a render.
 */
export function swordBasis(axes) {
  const toView = (v) => [v.x, v.z, -v.y];
  return {
    right: toView(axes.x),     // guard crossbar
    blade: toView(axes.y),     // blade direction
    face: toView(axes.z),      // flat of the blade
  };
}

/** Screen-plane angle of the blade line (radians, +x right, +y down). */
export function bladeScreenAngle(axes) {
  const b = swordBasis(axes);
  // View x is screen x; view y is screen UP, so negate for screen-down y.
  return Math.atan2(-b.blade[1], b.blade[0]);
}
