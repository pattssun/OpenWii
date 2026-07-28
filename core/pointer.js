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

    /**
     * Smoothing.
     *
     * One Euro adapts as `cutoff = minCutoff + beta·|speed|`, so **beta is
     * unit-dependent**. These filters used to run in pixels, where a fast swing
     * gave speeds in the thousands and beta=0.012 opened the cutoff up to ~37Hz.
     * Working in normalised 0..1 units shrank speed by a factor of the screen
     * width, which silently collapsed the adaptive term to nothing — leaving a
     * fixed 1.6Hz low-pass with ~250ms of settling lag at every speed. That
     * reads exactly as "slow and imprecise": the cursor trails your hand, and
     * the lag makes you overshoot every target.
     *
     * beta is now scaled for normalised units, and minCutoff raised so the
     * resting case settles in ~80ms rather than ~250ms.
     */
    this.filterX = new OneEuro(options.minCutoff ?? 10, options.beta ?? 25);
    this.filterY = new OneEuro(options.minCutoff ?? 10, options.beta ?? 25);

    this.angles = { yaw: 0, pitch: 0 };
    this.live = false;
    this.lastSeen = 0;
    this.prev = null;
    this.lastAxes = null;
    this.source = '—';

    /**
     * Per-frame extrapolation.
     *
     * Packets arrive at whatever rate the phone's sensor runs; the display
     * refreshes at its own. Reading the last packet's position straight into
     * the render loop means the cursor is frozen on some frames and jumps two
     * steps on others — the two rates beat against each other, and the result
     * reads as a low refresh rate rather than as latency. So we track velocity
     * and advance the cursor every frame instead of every packet.
     *
     * The same mechanism buys back latency: extrapolating slightly *past* now
     * cancels the pipeline delay (phone → wire → render). `lead` is that
     * compensation. Too much and reversals overshoot, which feels imprecise —
     * hence the cap on total predicted displacement.
     */
    // Tuned against a simulated 60Hz sensor, 20ms pipeline delay and a 60Hz
    // display. lead=30ms and a 4% cap give a mean tracking error of 2.6% of
    // screen width at a one-sweep-per-second wave, with 3.5% overshoot at a
    // hard stop that settles in ~130ms. Raising lead past this buys almost
    // nothing and makes reversals rubber-band.
    this.lead = options.lead ?? 0.03;            // seconds of latency to cancel
    this.maxAhead = options.maxAhead ?? 0.09;    // never extrapolate further than this
    this.maxLeap = options.maxLeap ?? 0.04;      // max predicted travel, screen fraction
    this.velTau = options.velTau ?? 0.045;       // velocity smoothing
    this.vel = { x: 0, y: 0 };                   // screen fractions per second
    this.display = { x: 0.5, y: 0.5 };           // what the renderer should draw
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
    this.display.x = 0.5;
    this.display.y = 0.5;
    this.vel.x = 0;
    this.vel.y = 0;
    this.driftYaw = 0;
    this.driftPitch = 0;
    this.prev = null;
    this.filterX.reset();
    this.filterY.reset();
  }

  /** Pixel position, for renderers that want screen space. */
  get pixels() {
    return { x: this.display.x * this.w, y: this.display.y * this.h };
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

    const px = this.position.x;
    const py = this.position.y;
    this.position.x = clamp(this.filterX.filter(this.aim.x, dt), 0, 1);
    this.position.y = clamp(this.filterY.filter(this.aim.y, dt), 0, 1);

    // Velocity for the per-frame extrapolation, lightly smoothed so a single
    // noisy packet can't fling the prediction.
    const k = clamp(dt / this.velTau, 0, 1);
    this.vel.x += ((this.position.x - px) / dt - this.vel.x) * k;
    this.vel.y += ((this.position.y - py) / dt - this.vel.y) * k;

    this.display.x = this.position.x;
    this.display.y = this.position.y;
    return this.position;
  }

  /**
   * Where to draw the cursor *this frame*. Call once per render frame, not per
   * packet — that's the whole point.
   */
  sampleAt(now) {
    if (!this.live) {
      this.display.x = this.position.x;
      this.display.y = this.position.y;
      return this.display;
    }
    const since = Math.max(0, (now - this.lastSeen) / 1000);
    const ahead = Math.min(since + this.lead, this.maxAhead);
    const dx = clamp(this.vel.x * ahead, -this.maxLeap, this.maxLeap);
    const dy = clamp(this.vel.y * ahead, -this.maxLeap, this.maxLeap);
    this.display.x = clamp(this.position.x + dx, 0, 1);
    this.display.y = clamp(this.position.y + dy, 0, 1);
    return this.display;
  }

  /** Drive the pointer from a mouse, for desk testing without a phone. */
  setFromMouse(nx, ny) {
    this.aim.x = clamp(nx, 0, 1);
    this.aim.y = clamp(ny, 0, 1);
    this.position.x = this.aim.x;
    this.position.y = this.aim.y;
    // A mouse is already at zero latency; nothing to predict.
    this.display.x = this.aim.x;
    this.display.y = this.aim.y;
    this.vel.x = 0;
    this.vel.y = 0;
  }
}
