import { clamp, dot, angleDelta, axesFromSample, DEG } from './orientation.js';

/**
 * The pointer, rebuilt from scratch: rate-based gyro aiming.
 *
 * Why this design and not absolute pointing
 * ------------------------------------------
 * The phone offers two motion signals. `deviceorientation` is the OS's fused
 * attitude estimate — absolute, but inherently lagged, with yaw referenced to
 * a magnetometer that wanders. `rotationRate` is the raw gyroscope — a clean,
 * zero-lag angular *velocity* with no absolute reference at all.
 *
 * Absolute pointing needs an absolute reference. The Wii Remote had one: an IR
 * camera watching the sensor bar. A phone has nothing to look at, so every
 * absolute design ends up built on the laggy orientation estimate and then
 * buried under compensation — filters, prediction, drift correction, fusion.
 * A previous version of this file was 448 lines of exactly that, and each fix
 * surfaced a new artifact.
 *
 * Rate-based aiming is what the industry converged on for gyro-without-optics:
 * Splatoon, Zelda, Steam Input. Cursor velocity = angular velocity. The gyro's
 * cleanliness becomes precision, its zero lag becomes immediacy, and drift is
 * a non-problem because the cursor clamps at the screen edges and the player
 * self-corrects — the same way a mouse recovers from hitting the edge of a
 * desk. It is also how the ZIG SIM demo that inspired this project works.
 *
 * The mapping
 * -----------
 *   yaw rate   = ω · up      (rotation about world-up — turning left/right)
 *   pitch rate = ω · x_body  (rotation about the phone's right edge — up/down)
 *
 * `up` expressed in the body frame comes from the orientation sample. Its lag
 * is harmless here: only the *direction* of gravity is taken from it, which
 * changes slowly, never the pointer's motion. This projection makes the
 * pointer grip-agnostic — flat like a Wii Remote or upright like a TV remote,
 * rotation about world-up is yaw either way. No calibration step required.
 *
 * The one learned constant
 * ------------------------
 * Browsers disagree about `rotationRate`: most report deg/s, some rad/s (a
 * 57× difference — a cursor 57× too slow), and sign conventions have
 * historically varied. One scalar `k` absorbs all of it, learned by comparing
 * total gyro-integrated angle against total orientation heading change during
 * real motion. The magnitude ratio uses summed absolute increments, which is
 * immune to the orientation lag's phase shift; the sign comes from their
 * correlation. Until enough motion has been seen, k stays 1 (correct for the
 * common deg/s case).
 */
export class Pointer {
  constructor(options = {}) {
    this.sensitivity = options.sensitivity ?? 1;
    // Degrees of turn to cross the full screen width at sensitivity 1.
    this.degPerScreen = options.degPerScreen ?? 30;
    // Vertical uses a tighter span — screens are wide, wrists pitch less.
    this.aspect = options.aspect ?? 0.6;
    // Below this angular speed the hand is trembling, not aiming. Ignoring it
    // keeps the cursor rock-still at rest with no smoothing lag while moving.
    this.deadzoneDps = options.deadzoneDps ?? 0.3;
    this.invertX = false;
    this.invertY = false;

    this.pos = { x: 0.5, y: 0.5 };
    this.rate = { x: 0, y: 0 };            // screen fractions per second
    this.rateDps = { yaw: 0, pitch: 0 };   // for the debug overlay

    // Unit/sign auto-gain (see header). k maps reported gyro units to deg/s.
    this.k = 1;
    this.kAbsO = 0;      // Σ|orientation heading change|, degrees
    this.kAbsG = 0;      // Σ|gyro yaw increment|, reported units
    this.kDot = 0;       // Σ o·g — sign evidence
    this.kLearned = false;

    this.win = { head0: 0, g: 0, t: 0 };   // current learning window
    this.prevUsedX = null;

    this.live = false;
    this.lastSeen = 0;
    this.lastDraw = 0;
    this.hasGyro = false;
    this.mode = 'gyro-rate';
    this.source = '—';
    this.w = 1;
    this.h = 1;
  }

  get display() { return this.pos; }
  get position() { return this.pos; }
  get pixels() { return { x: this.pos.x * this.w, y: this.pos.y * this.h }; }

  setViewport(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  recentre() {
    this.pos.x = 0.5;
    this.pos.y = 0.5;
    this.rate.x = 0;
    this.rate.y = 0;
  }

  setFromMouse(nx, ny) {
    this.pos.x = clamp(nx, 0, 1);
    this.pos.y = clamp(ny, 0, 1);
    this.rate.x = 0;
    this.rate.y = 0;
  }

  /** Feed one packet from the phone. `dt` = seconds since the previous one. */
  update(sample, dt, now = 0) {
    const axes = axesFromSample(sample);
    this.source = sample.quat ? 'quaternion' : 'euler';
    this.live = true;
    this.lastSeen = now;

    // World-up in the body frame: the world-z component of each body axis.
    const up = { x: axes.x.z, y: axes.y.z, z: axes.z.z };

    const m = sample.motion;
    let yawRaw = 0;
    let pitchRaw = 0;
    if (m && (m.rx || m.ry || m.rz)) {
      this.hasGyro = true;
      const omega = { x: m.rx || 0, y: m.ry || 0, z: m.rz || 0 };
      yawRaw = dot(omega, up);
      pitchRaw = omega.x;
    }

    // World heading of the most horizontal body axis — the k-learning
    // reference. Which axis qualifies can change mid-flight (phone rolled to
    // landscape); skip the sample where it switches rather than compare
    // headings of two different axes.
    const useX = Math.abs(axes.x.z) <= Math.abs(axes.z.z);
    const ax = useX ? axes.x : axes.z;
    const head = Math.atan2(ax.y, ax.x) / DEG;

    // Learning is evaluated over ~150ms windows, not per sample. Differencing
    // a noisy orientation at 60Hz amplifies the noise by 60 — 0.15° of jitter
    // reads as 9°/s of phantom "motion", which once fooled this gate into
    // dividing real-looking orientation motion by near-zero gyro motion and
    // slamming k to the clamp. Over a window, real rotation integrates and
    // noise cancels, so the two are finally distinguishable.
    if (this.hasGyro && this.prevUsedX === useX && dt > 0 && dt < 0.1) {
      this.win.g += yawRaw * dt;
      this.win.t += dt;
      if (this.win.t >= 0.15) {
        const o = angleDelta(head, this.win.head0);
        // ≥ ~5°/s of sustained rotation; sensor jitter stays far below this.
        if (Math.abs(o) > 0.8) {
          const decay = Math.exp(-this.win.t / 30);
          this.kAbsO = this.kAbsO * decay + Math.abs(o);
          this.kAbsG = this.kAbsG * decay + Math.abs(this.win.g);
          this.kDot = this.kDot * decay + o * this.win.g;
          // ≥10° of witnessed motion before overriding the deg/s default.
          if (this.kAbsO > 10 && this.kAbsG > 1e-9) {
            this.k = clamp(Math.sign(this.kDot || 1) * (this.kAbsO / this.kAbsG), -80, 80);
            this.kLearned = true;
          }
        }
        this.win = { head0: head, g: 0, t: 0 };
      }
    } else {
      this.win = { head0: head, g: 0, t: 0 };
    }
    this.prevUsedX = useX;

    let yawDps = this.k * yawRaw;
    let pitchDps = this.k * pitchRaw;
    if (Math.abs(yawDps) < this.deadzoneDps) yawDps = 0;
    if (Math.abs(pitchDps) < this.deadzoneDps) pitchDps = 0;
    this.rateDps = { yaw: yawDps, pitch: pitchDps };

    // Positive yaw = counterclockwise from above = pointing left → cursor
    // left. Positive pitch about the right edge = pointing up → cursor up.
    // (Verified numerically in core.test.mjs, not trusted from derivation —
    // and a device with mirrored conventions flips k, which flips both.)
    const sx = this.sensitivity * (this.invertX ? -1 : 1);
    const sy = this.sensitivity * (this.invertY ? -1 : 1);
    this.rate.x = (-yawDps / this.degPerScreen) * sx;
    this.rate.y = (-pitchDps / (this.degPerScreen * this.aspect)) * sy;
  }

  /**
   * Where to draw the cursor this frame. Integrates the current angular rate
   * at display rate, so motion is continuous regardless of packet rate —
   * exact integration of a velocity signal, not extrapolation of a position.
   */
  sampleAt(now) {
    if (!this.lastDraw) this.lastDraw = now;
    let dt = (now - this.lastDraw) / 1000;
    this.lastDraw = now;
    if (!(dt > 0) || dt > 0.25) dt = 0;

    // If packets stop, freeze rather than coast on a stale rate.
    if (this.live && now - this.lastSeen < 250) {
      this.pos.x = clamp(this.pos.x + this.rate.x * dt, 0, 1);
      this.pos.y = clamp(this.pos.y + this.rate.y * dt, 0, 1);
    }
    return this.pos;
  }
}

export const MODES = ['gyro-rate'];
