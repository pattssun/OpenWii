/**
 * Shared ball physics for the "swing at a ball" games (table tennis, golf).
 *
 * A ball is {x, y, z, vx, vy, vz} in metres / m·s⁻¹, y up. The surface it
 * lives on is a height function so a flat table and rolling golf terrain are
 * the same code path. This folder has no index.html, so the server's game
 * discovery ignores it.
 */

/** One integration step: gravity, optional linear drag, position. */
export function stepBall(b, dt, { gravity = 9.81, drag = 0 } = {}) {
  b.vy -= gravity * dt;
  if (drag) {
    const f = Math.max(0, 1 - drag * dt);
    b.vx *= f; b.vy *= f; b.vz *= f;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
}

/**
 * Collide with the surface under the ball. Returns true on the frame the
 * ball bounced. Slope pull uses the numerical gradient so balls roll downhill
 * on curved ground and sit still on flat.
 */
export function groundBall(b, dt, {
  heightAt = () => 0,
  restitution = 0.55,
  friction = 2.2,          // 1/s velocity decay while rolling
  rollThreshold = 0.9,     // vertical speed below which bouncing becomes rolling
  stopSpeed = 0.3,         // static friction: below this on walkable slopes, stop
  gravity = 9.81,
} = {}) {
  const gy = heightAt(b.x, b.z);
  if (b.y > gy) return false;

  b.y = gy;
  let bounced = false;
  if (b.vy < -rollThreshold) {
    b.vy = -b.vy * restitution;
    bounced = true;
  } else {
    b.vy = 0;
    // Rolling: slope acceleration + kinetic friction — but only while the ball
    // is genuinely rolling. Without static friction, slope pull against decay
    // settles at a terminal creep (~0.25 m/s on gentle grades) and a ball
    // never stops on any slope; real grass grips a slow ball.
    const sp0 = Math.hypot(b.vx, b.vz);
    if (sp0 > stopSpeed) {
      const e = 0.6;
      const gx = (heightAt(b.x + e, b.z) - heightAt(b.x - e, b.z)) / (2 * e);
      const gz = (heightAt(b.x, b.z + e) - heightAt(b.x, b.z - e)) / (2 * e);
      b.vx += -gx * gravity * dt;
      b.vz += -gz * gravity * dt;
    }
    const f = Math.max(0, 1 - friction * dt);
    b.vx *= f;
    b.vz *= f;
    if (Math.hypot(b.vx, b.vz) < stopSpeed) { b.vx = 0; b.vz = 0; }
  }
  return bounced;
}

export const speedOf = (b) => Math.hypot(b.vx, b.vy, b.vz);
