import { clamp, dot, angleDelta, axesFromSample } from './orientation.js';
import { OneEuro } from './filter.js';
import { anglesIn, forwardOf } from './calibration.js';

export const MODES = ['hybrid', 'absolute', 'relative', 'gyro'];

/**
 * Screen pointer driven by phone attitude.
 *
 *   hybrid   — absolute aiming with slow drift correction. Default, and the
 *              closest thing to the Wii Remote's IR pointing that a phone can
 *              manage without a sensor bar.
 *   absolute — raw angle off neutral. No drift correction, so magnetometer
 *              wander accumulates.
 *   relative — integrates the *change* in angle, like a mouse. Never gets lost;
 *              never feels like pointing at the screen.
 *   gyro     — integrates rotationRate directly. Ignores the magnetometer.
 */
export class Pointer {
  constructor(options = {}) {
    this.mode = options.mode || 'hybrid';
    this.sensitivity = options.sensitivity ?? 1;
    this.degPerScreenX = options.degPerScreenX ?? 55;
    this.degPerScreenY = options.degPerScreenY ?? 38;
    this.invertX = false;
    this.invertY = false;

    // Relative-mode spring back toward centre; hybrid uses drift correction
    // instead, which is strictly better when an absolute reference exists.
    this.recenterSpring = options.recenterSpring ?? 0.35;

    /**
     * Drift correction.
     *
     * Over a long window a player's aim centres on the screen — they are, after
     * all, pointing at it. So a persistent non-zero mean is drift, not
     * intention. We low-pass the angle with a very long time constant and
     * subtract it. `driftTau` has to stay far longer than any deliberate aim:
     * at 45s, holding a corner for five seconds moves the estimate ~10%, while
     * degrees-per-minute magnetometer wander is absorbed completely.
     */
    this.driftTau = options.driftTau ?? 45;
    this.driftLimit = options.driftLimit ?? 25;      // degrees, hard ceiling
    this.driftYaw = 0;
    this.driftPitch = 0;

    this.w = 1;
    this.h = 1;
    this.frame = null;

    /**
     * Unfiltered aim accumulator. `position` is the *filtered* view of it.
     *
     * Accumulating onto the filtered value instead is a slow poison: smoothing
     * gives pos += α(target − pos), so feeding it target = pos + delta collapses
     * to pos += α·delta — every movement scaled by the smoothing coefficient,
     * about 0.14 at rest. Small and medium movements land at a seventh of their
     * intended size.
     */
    this.aim = { x: 0.5, y: 0.5 };            // normalised 0..1
    this.position = { x: 0.5, y: 0.5 };
    this.filterX = new OneEuro(1.6, 0.012);
    this.filterY = new OneEuro(1.6, 0.012);

    this.angles = { yaw: 0, pitch: 0 };
    this.live = false;
    this.lastSeen = 0;
    this.prev = null;
    this.lastAxes = null;
    this.source = '—';
  }

  setViewport(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  setFrame(frame) {
    this.frame = frame;
    this.prev = null;
  }

  /** Apply calibration output (screen span per axis). */
  applyCalibration(result) {
    if (!result) return;
    this.degPerScreenX = result.degPerScreenX;
    this.degPerScreenY = result.degPerScreenY;
  }

  recentre() {
    this.aim.x = 0.5;
    this.aim.y = 0.5;
    this.position.x = 0.5;
    this.position.y = 0.5;
    this.driftYaw = 0;
    this.driftPitch = 0;
    this.prev = null;
    this.filterX.reset();
    this.filterY.reset();
  }

  /** Pixel position, for renderers that want screen space. */
  get pixels() {
    return { x: this.position.x * this.w, y: this.position.y * this.h };
  }

  /**
   * Feed one orientation sample. `dt` in seconds.
   * Returns the normalised position, or null if no frame is calibrated yet.
   */
  update(sample, dt, now = 0) {
    const axes = axesFromSample(sample);
    this.lastAxes = axes;
    this.source = sample.quat ? 'quaternion' : 'euler';
    this.live = true;
    this.lastSeen = now;

    if (!this.frame) return null;

    const fwd = forwardOf(this.frame, axes);
    const { yaw, pitch } = anglesIn(this.frame, fwd);
    this.angles = { yaw, pitch };

    // Fraction of a screen per degree, so games get resolution-independent aim.
    const perDegX = (1 / this.degPerScreenX) * this.sensitivity * (this.invertX ? -1 : 1);
    const perDegY = (1 / this.degPerScreenY) * this.sensitivity * (this.invertY ? -1 : 1);

    let tx;
    let ty;

    if (this.mode === 'hybrid') {
      // Exponential smoothing toward the long-run mean. Using the exact
      // exponential rather than (dt/tau) keeps the time constant honest even
      // when packet intervals wobble.
      const a = 1 - Math.exp(-dt / this.driftTau);
      this.driftYaw += a * (yaw - this.driftYaw);
      this.driftPitch += a * (pitch - this.driftPitch);
      const dy = clamp(this.driftYaw, -this.driftLimit, this.driftLimit);
      const dp = clamp(this.driftPitch, -this.driftLimit, this.driftLimit);
      tx = 0.5 + (yaw - dy) * perDegX;
      ty = 0.5 - (pitch - dp) * perDegY;
    } else if (this.mode === 'absolute') {
      tx = 0.5 + yaw * perDegX;
      ty = 0.5 - pitch * perDegY;
    } else if (this.mode === 'gyro' && sample.motion) {
      const { rx = 0, ry = 0, rz = 0 } = sample.motion;
      const omega = { x: rx, y: ry, z: rz };
      // Angular velocity arrives in the body frame; project onto the
      // calibrated frame's up (yaw) and right (pitch) axes.
      const yawRate = dot(omega, {
        x: dot(axes.x, this.frame.u), y: dot(axes.y, this.frame.u), z: dot(axes.z, this.frame.u),
      });
      const pitchRate = dot(omega, {
        x: dot(axes.x, this.frame.r), y: dot(axes.y, this.frame.r), z: dot(axes.z, this.frame.r),
      });
      tx = this.aim.x - yawRate * dt * perDegX;
      ty = this.aim.y - pitchRate * dt * perDegY;
    } else {
      if (!this.prev) this.prev = { yaw, pitch };
      // Near ±90° of pitch the forward vector is almost vertical and yaw stops
      // meaning anything — freeze horizontal motion rather than let it spin.
      const dYaw = Math.abs(dot(fwd, this.frame.u)) > 0.985 ? 0 : angleDelta(yaw, this.prev.yaw);
      const dPitch = angleDelta(pitch, this.prev.pitch);
      this.prev = { yaw, pitch };
      tx = this.aim.x + dYaw * perDegX;
      ty = this.aim.y - dPitch * perDegY;
      if (this.recenterSpring) {
        tx += (0.5 - tx) * this.recenterSpring * dt;
        ty += (0.5 - ty) * this.recenterSpring * dt;
      }
    }

    this.aim.x = clamp(tx, 0, 1);
    this.aim.y = clamp(ty, 0, 1);
    this.position.x = clamp(this.filterX.filter(this.aim.x, dt), 0, 1);
    this.position.y = clamp(this.filterY.filter(this.aim.y, dt), 0, 1);
    return this.position;
  }

  /** Drive the pointer from a mouse, for desk testing without a phone. */
  setFromMouse(nx, ny) {
    this.aim.x = clamp(nx, 0, 1);
    this.aim.y = clamp(ny, 0, 1);
    this.position.x = this.aim.x;
    this.position.y = this.aim.y;
  }
}
