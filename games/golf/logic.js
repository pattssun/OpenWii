import { stepBall, groundBall, speedOf } from '../shared/ball.js';

/**
 * Golf — one par-4 hole. No renderer, no DOM.
 *
 * The player aims with the pointer, swings with the phone; club selection is
 * automatic by remaining distance. Terrain is a deterministic height function
 * so tests and the renderer see exactly the same course. Distances in metres,
 * +z from tee toward the hole... hole sits at negative z, matching the other
 * games' "away from the player" convention.
 */

export const HOLE = { x: 6, z: -230 };
export const GREEN_RADIUS = 11;
export const CUP_RADIUS = 0.55;
export const PAR = 4;
export const TEE = { x: 0, z: 0 };

/** Gentle deterministic terrain: rolling fairway, raised green, dished cup area. */
export function terrainHeight(x, z) {
  let h = Math.sin(x * 0.045) * 1.1 + Math.cos(z * 0.021) * 1.4
    + Math.sin((x + z) * 0.013) * 1.8;
  const dHole = Math.hypot(x - HOLE.x, z - HOLE.z);
  if (dHole < GREEN_RADIUS + 8) {
    // The green is a smooth raised pad; blend the rough out.
    const t = Math.min(1, Math.max(0, (dHole - GREEN_RADIUS) / 8));
    h = h * t + 2.2 * (1 - t);
  }
  return h;
}

export const CLUBS = {
  driver: { loft: 14 * Math.PI / 180, power: 46 },
  iron: { loft: 30 * Math.PI / 180, power: 27 },
  putter: { loft: 0, power: 9 },
};

export function pickClub(ball) {
  const d = Math.hypot(ball.x - HOLE.x, ball.z - HOLE.z);
  if (d < GREEN_RADIUS + 2) return 'putter';
  if (d < 120) return 'iron';
  return 'driver';
}

export class Hole {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.state = 'aim';            // aim | flight | holed
    this.ball = { x: TEE.x, y: terrainHeight(TEE.x, TEE.z), z: TEE.z, vx: 0, vy: 0, vz: 0 };
    this.strokes = 0;
    this.aimOffset = 0;            // radians left/right of the hole line
    this.club = 'driver';
    this.settleMs = 0;
  }

  /** Direction of play: from the ball toward the hole, plus the aim offset. */
  headingToHole() {
    return Math.atan2(HOLE.x - this.ball.x, -(HOLE.z - this.ball.z));
  }

  /** Swing with power 0..1. Returns the launch for renderer/tests. */
  strike(power) {
    if (this.state !== 'aim') return null;
    this.club = pickClub(this.ball);
    const club = CLUBS[this.club];
    const p = Math.max(0.12, Math.min(1, power));
    const speed = club.power * p;
    const heading = this.headingToHole() + this.aimOffset;
    const flat = speed * Math.cos(club.loft);
    this.ball.vx = Math.sin(heading) * flat;
    this.ball.vz = -Math.cos(heading) * flat;
    this.ball.vy = speed * Math.sin(club.loft) + (this.club === 'putter' ? 0 : 0.4);
    this.strokes += 1;
    this.state = 'flight';
    this.settleMs = 0;
    this.onEvent({ type: 'strike', club: this.club, power: p, strokes: this.strokes });
    return { speed, heading };
  }

  onGreen() {
    return Math.hypot(this.ball.x - HOLE.x, this.ball.z - HOLE.z) < GREEN_RADIUS;
  }

  distanceToHole() {
    return Math.hypot(this.ball.x - HOLE.x, this.ball.z - HOLE.z);
  }

  update(now, dt) {
    if (this.state !== 'flight') return;
    const b = this.ball;
    stepBall(b, dt, { gravity: 9.81, drag: 0.02 });
    groundBall(b, dt, {
      heightAt: terrainHeight,
      restitution: this.onGreen() ? 0.32 : 0.42,
      friction: this.onGreen() ? 1.1 : 2.0,
    });

    // In the cup: close and slow.
    if (this.distanceToHole() < CUP_RADIUS && speedOf(b) < 3 && b.y < terrainHeight(b.x, b.z) + 0.3) {
      this.state = 'holed';
      this.onEvent({ type: 'holed', strokes: this.strokes, par: PAR });
      return;
    }

    // Settled → back to aiming.
    if (speedOf(b) < 0.05 && b.y <= terrainHeight(b.x, b.z) + 0.02) {
      this.settleMs += dt * 1000;
      if (this.settleMs > 350) {
        this.state = 'aim';
        this.onEvent({ type: 'settled', distance: this.distanceToHole(), onGreen: this.onGreen() });
      }
    } else {
      this.settleMs = 0;
    }
  }
}
