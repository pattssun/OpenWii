import { axesFromSample, angleDelta, clamp, DEG } from '../../core/orientation.js';

/**
 * Bowling input — from phone motion to a thrown ball. No DOM, no renderer.
 *
 * Two pieces, one per player:
 *   StanceCalibration  — "hold the remote out in front and keep it still".
 *                        Captures which way is down the lane for this phone,
 *                        exactly as Mario Kart waits for a level, steady wheel
 *                        before it trusts the sensors.
 *   ThrowTracker       — hold A to grip the ball, swing, let go of A to release.
 *                        Release gives the throw: speed from how hard the arm
 *                        swung, aim from where the phone points, hook from how
 *                        far the wrist twisted.
 *
 * Aim = where the phone points when you grip the ball, plus every degree your
 * hand sweeps sideways while you swing (integrated from the gyro, which is
 * reliable at any arm pitch). It is damped (`aimGain`): a real lane is about 3°
 * wide as seen from the foul line, so one-to-one mapping would turn ordinary
 * hand wobble into gutter balls. Position on the foul line does the coarse aiming.
 *
 * Samples are the relay's `orientation` packets: attitude (alpha/beta/gamma or
 * a quaternion) plus `motion` with the gyro rates rx/ry/rz in deg/s.
 */

/** Most-horizontal beam of the phone: the top edge held flat, or out of the back held upright. */
export function pointingBeam(axes) {
  const top = axes.y;
  const back = { x: -axes.z.x, y: -axes.z.y, z: -axes.z.z };
  const useTop = Math.abs(top.z) <= Math.abs(back.z);
  return {
    beam: useTop ? top : back,
    // The beam expressed in the phone's own axes, to project gyro rates onto it.
    local: useTop ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: -1 },
    grip: useTop ? 'flat' : 'upright',
  };
}

/** Compass-style heading in degrees: 0 north, increasing clockwise (a right turn). */
export const headingOf = (beam) => Math.atan2(beam.x, beam.y) / DEG;

const rates = (sample) => {
  const m = sample.motion;
  return m && Number.isFinite(m.rx) && Number.isFinite(m.ry) && Number.isFinite(m.rz)
    ? { x: m.rx, y: m.ry, z: m.rz }
    : null;
};

/** Describe one sample: where it points, how it is turning, how hard it swings. */
export function readSample(sample, invertTwist = false) {
  const axes = axesFromSample(sample);
  const { beam, local, grip } = pointingBeam(axes);
  const w = rates(sample);
  let total = 0;
  let twist = 0;
  if (w) {
    total = Math.hypot(w.x, w.y, w.z);
    // Roll about the pointing beam: + is clockwise seen from behind the phone.
    twist = (w.x * local.x + w.y * local.y + w.z * local.z) * (invertTwist ? -1 : 1);
  }
  // Turn rate about the world's vertical axis, + = turning right. Unlike the
  // beam's heading this stays meaningful when the arm swings through vertical.
  const yawRight = w ? -(w.x * axes.x.z + w.y * axes.y.z + w.z * axes.z.z) : 0;
  return {
    beam,
    grip,
    yawRight,
    heading: headingOf(beam),
    pitch: Math.asin(clamp(beam.z, -1, 1)) / DEG,
    total,
    twist,
    swing: Math.sqrt(Math.max(0, total * total - twist * twist)),
    hasGyro: w !== null,
  };
}

// ── Calibration ────────────────────────────────────────────────────────────

export const CALIBRATION = {
  holdMs: 650,            // steady for this long before the stance is accepted
  minSamples: 10,
  maxHeadingRange: 4,     // degrees of wobble tolerated while holding still
  maxPitchRange: 3.5,     // degrees
  maxRate: 28,            // deg/s of gyro motion tolerated
  maxPitch: 38,           // beyond this the grip is neither flat nor upright
};

export class StanceCalibration {
  constructor() {
    this.reset();
  }

  reset() {
    this.ready = false;
    this.heading = 0;
    this.grip = 'flat';
    this.window = [];
    this.progress = 0;
    this.status = 'Hold the remote out in front of you';
  }

  /** Feed one packet. Returns true on the packet that completes calibration. */
  update(sample, now) {
    if (this.ready) return false;
    const s = readSample(sample);
    if (Math.abs(s.pitch) > CALIBRATION.maxPitch) {
      this.window = [];
      this.progress = 0;
      this.status = 'Point the remote at the screen, not up or down';
      return false;
    }
    if (s.hasGyro && s.total > CALIBRATION.maxRate) {
      this.window = [];
      this.progress = 0;
      this.status = 'Hold still for a moment';
      return false;
    }
    this.window.push({ at: now, heading: s.heading, pitch: s.pitch, grip: s.grip });
    this.window = this.window.filter((w) => now - w.at <= CALIBRATION.holdMs + 120);

    const first = this.window[0];
    const headings = this.window.map((w) => angleDelta(w.heading, first.heading));
    const pitches = this.window.map((w) => w.pitch);
    const steady = Math.max(...headings) - Math.min(...headings) <= CALIBRATION.maxHeadingRange
      && Math.max(...pitches) - Math.min(...pitches) <= CALIBRATION.maxPitchRange;
    if (!steady) {
      // Keep only the newest samples so a single jolt does not stall calibration.
      this.window = this.window.slice(-3);
      this.progress = 0;
      this.status = 'Hold still for a moment';
      return false;
    }
    const span = now - first.at;
    this.progress = clamp(span / CALIBRATION.holdMs, 0, 1);
    this.status = 'Hold still…';
    if (this.window.length >= CALIBRATION.minSamples && span >= CALIBRATION.holdMs) {
      const mean = headings.reduce((a, b) => a + b, 0) / headings.length;
      this.heading = (first.heading + mean + 360) % 360;
      this.grip = s.grip;
      this.ready = true;
      this.progress = 1;
      this.status = 'Ready';
      return true;
    }
    return false;
  }

  /** Degrees to the right of the calibrated "straight down the lane". */
  relative(heading) {
    return angleDelta(heading, this.heading);
  }
}

// ── Throwing ───────────────────────────────────────────────────────────────

export const THROW = {
  minSwing: 45,           // deg/s of swing needed for a release to count as a throw
  windowMs: 170,          // the last stretch of motion that decides the release
  gripDebounceMs: 120,    // ignore a release this soon after the grip
  aimGain: 0.4,           // ball degrees per degree of hand sweep (lane is ~3° wide)
  maxBallDeg: 5,          // the ball can never leave the foul line more steeply than this
  twistDeadzone: 40,      // deg/s of wrist roll ignored
  twistFull: 380,         // deg/s of wrist roll that is a full hook
};

/** Swing rate (deg/s) → ball speed (m/s). Soft toss ≈ 3, brisk ≈ 7, full swing ≈ 10. */
export const speedFromSwing = (rate) => clamp(2.2 + Math.max(0, rate - 40) * 0.0125, 2.2, 10.2);

export class ThrowTracker {
  constructor(calibration, { invertTwist = false } = {}) {
    this.calibration = calibration;
    this.invertTwist = invertTwist;
    this.reset();
  }

  reset() {
    this.held = false;
    this.gripAt = 0;
    this.gripAim = 0;
    this.swept = 0;       // degrees the hand has swept sideways since the grip, + = right
    this.lastAt = 0;
    this.buffer = [];
  }

  /** The player's current aim, degrees right of straight, for the aiming arrow. */
  aim(sample) {
    if (!this.calibration.ready || !sample) return 0;
    const s = readSample(sample, this.invertTwist);
    return this.damp(this.calibration.relative(s.heading));
  }

  damp(phoneDeg) {
    return clamp(phoneDeg * THROW.aimGain, -THROW.maxBallDeg, THROW.maxBallDeg);
  }

  /** Ball angle (degrees, + right) if released now: the live arrow while swinging. */
  liveAim(sample) {
    return this.held ? this.damp(this.gripAim + this.swept) : this.aim(sample);
  }

  /** Hook (-1..1) if released now, from the last stretch of wrist twist. */
  liveHook(now) {
    const recent = this.buffer.filter((b) => now - b.at <= THROW.windowMs && b.hasGyro);
    if (!recent.length) return 0;
    return this.hookFrom(recent.reduce((a, b) => a + b.twist, 0) / recent.length);
  }

  hookFrom(twist) {
    const dead = Math.sign(twist) * Math.max(0, Math.abs(twist) - THROW.twistDeadzone);
    return clamp(dead / (THROW.twistFull - THROW.twistDeadzone), -1, 1);
  }

  /**
   * Feed one packet and whether A is held. Returns one of
   *   {type:'grip'}                  A pressed while calibrated
   *   {type:'throw', speed, angle, hook, power}   A released after a swing
   *   {type:'cancel'}                A released without swinging
   * or null.
   */
  update(sample, now, held) {
    if (!this.calibration.ready) {
      this.held = false;
      return null;
    }
    const s = readSample(sample, this.invertTwist);
    const rel = this.calibration.relative(s.heading);
    this.buffer.push({ at: now, rel, swing: s.swing, twist: s.twist, total: s.total, hasGyro: s.hasGyro });
    const dt = this.lastAt ? clamp((now - this.lastAt) / 1000, 0, 0.05) : 0;
    this.lastAt = now;
    if (this.held && s.hasGyro) this.swept += s.yawRight * dt;
    this.buffer = this.buffer.filter((b) => now - b.at <= 400);

    if (held && !this.held) {
      this.held = true;
      this.swept = 0;
      this.gripAt = now;
      const settled = this.buffer.filter((b) => now - b.at <= 150);
      this.gripAim = settled.reduce((a, b) => a + b.rel, 0) / settled.length;
      return { type: 'grip' };
    }
    if (!held && this.held) {
      this.held = false;
      if (now - this.gripAt < THROW.gripDebounceMs) return { type: 'cancel', reason: 'released-too-soon', info: { heldMs: Math.round(now - this.gripAt) } };
      return this.release(rel, now);
    }
    return null;
  }

  release(_relNow, now) {
    const recent = this.buffer.filter((b) => now - b.at <= THROW.windowMs);
    const gyro = recent.filter((b) => b.hasGyro);
    const peak = gyro.length ? Math.max(...gyro.map((b) => b.swing)) : 0;
    const twistMean = gyro.length ? gyro.reduce((a, b) => a + b.twist, 0) / gyro.length : 0;
    // What the decision was based on — surfaced so a debug log can explain a throw.
    const info = {
      heldMs: Math.round(now - this.gripAt),
      windowSamples: recent.length,
      gyroSamples: gyro.length,
      peakSwingDegPerS: Math.round(peak),
      twistMeanDegPerS: Math.round(twistMean),
      gripAimDeg: +this.gripAim.toFixed(2),
      sweptDeg: +this.swept.toFixed(2),
    };
    if (peak < THROW.minSwing) return { type: 'cancel', reason: gyro.length ? 'no-swing' : 'no-gyro-data', info };
    const hook = this.hookFrom(gyro.reduce((a, b) => a + b.twist, 0) / gyro.length);
    const aimDeg = this.damp(this.gripAim + this.swept);
    const speed = speedFromSwing(peak);
    return {
      type: 'throw',
      speed,
      angle: aimDeg * DEG,
      hook,
      power: clamp((speed - 2.2) / 8, 0, 1),
      info,
    };
  }
}
