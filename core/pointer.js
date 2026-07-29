import { clamp, dot, cross, scale, length, axesFromSample, DEG } from './orientation.js';

/**
 * The pointer: rate-based gyro aiming with a learned, per-device axis map.
 *
 * Why rate-based (unchanged from the rebuild)
 * -------------------------------------------
 * Absolute pointing needs an absolute reference; the Wii Remote had an IR
 * camera watching the sensor bar, a phone has nothing to look at. Rate-based
 * aiming — cursor velocity = angular velocity — is what every post-Wii
 * console does for gyro-without-optics, and what the ZIG SIM demo behind this
 * project does. Drift is a non-issue: the cursor clamps at the screen edges
 * and the player self-corrects, like a mouse at the edge of a desk.
 *
 * Why NOTHING here assumes a gyro axis convention
 * -----------------------------------------------
 * Browsers genuinely disagree about `rotationRate`: which reported component
 * corresponds to which body axis, which sign, and even the unit (deg/s vs
 * rad/s — a 57× difference). Assuming the spec's labels produced a bug where
 * swinging up moved the cursor sideways: a 90° axis confusion, invisible in
 * any simulation that assumes the same convention as the code. This project
 * has now been burned three separate times by hand-derived conventions.
 *
 * So the device's convention is *learned*, not assumed:
 *
 *   1. Ground truth: body angular velocity computed from consecutive
 *      orientation attitudes. Convention-free by construction — it comes from
 *      the attitude matrix itself. Lagged and noisy, but always pointing the
 *      right way. Until the gyro is trusted, smoothed ground truth drives the
 *      cursor directly, so the axes are correct on every device from the
 *      first second (merely a little softer).
 *
 *   2. Learning: each reported gyro component is correlated against each true
 *      body axis over windows of real motion. That yields a per-axis mapping
 *      (which column, which sign, what scale) — permutation, mirroring and
 *      units all absorbed at once. Reported samples are compared against
 *      slightly-delayed truth so the orientation estimate's lag cannot bias
 *      the correlation.
 *
 *   3. Trust gate: the mapping is only used once its predictions actually
 *      match the ground truth (small residual). A device that reports
 *      something unlearnable simply stays on ground-truth rates — degraded
 *      latency, never wrong directions.
 *
 * The screen mapping is geometric, computed fresh from the live attitude:
 *   yaw   = ω · up            (turning about world-up: left/right)
 *   pitch = ω · right          right = forward × up, forward = whichever beam
 *                              axis (top edge or back) is most horizontal
 * which makes it grip-agnostic — flat, upright, or landscape — with no
 * calibration step.
 */

const norm = (v) => {
  const L = length(v) || 1;
  return { x: v.x / L, y: v.y / L, z: v.z / L };
};

/** Body-frame angular velocity between two attitudes, deg/s. Convention-free. */
function omegaFromAttitudes(a1, a2, dt) {
  const col = (a, k) => [a[k].x, a[k].y, a[k].z];
  const R1 = [col(a1, 'x'), col(a1, 'y'), col(a1, 'z')];
  const R2 = [col(a2, 'x'), col(a2, 'y'), col(a2, 'z')];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map(
    (j) => R1[i][0] * R2[j][0] + R1[i][1] * R2[j][1] + R1[i][2] * R2[j][2],
  ));
  return {
    x: (M[2][1] - M[1][2]) / (2 * dt) / DEG,
    y: (M[0][2] - M[2][0]) / (2 * dt) / DEG,
    z: (M[1][0] - M[0][1]) / (2 * dt) / DEG,
  };
}

const AXES = ['x', 'y', 'z'];

export class Pointer {
  constructor(options = {}) {
    this.sensitivity = options.sensitivity ?? 1;
    // Degrees of turn to cross the full screen width at sensitivity 1.
    this.degPerScreen = options.degPerScreen ?? 30;
    this.aspect = options.aspect ?? 0.6;
    this.invertX = false;
    this.invertY = false;

    // Below this the hand is trembling, not aiming. The learned-gyro path is
    // clean enough for a tight threshold; the ground-truth fallback carries
    // differentiated orientation noise and needs a wider one, which is part
    // of why it is only the fallback.
    this.deadzoneDps = options.deadzoneDps ?? 0.3;
    this.fallbackDeadzoneDps = options.fallbackDeadzoneDps ?? 4;

    this.pos = { x: 0.5, y: 0.5 };
    this.rate = { x: 0, y: 0 };            // screen fractions per second
    this.rateDps = { yaw: 0, pitch: 0 };   // for the debug overlay

    // ── Ground truth ──
    this.prevAxes = null;
    this.emaO = { x: 0, y: 0, z: 0 };      // smoothed true body rates
    this.emaTau = 0.08;

    // ── Axis-map learning ──
    this.ring = [];                        // recent reported r, for lag alignment
    this.C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];   // Σ trueᵢ · reportedⱼ
    this.absO = [0, 0, 0];                 // Σ|trueᵢ| during motion, degrees
    this.absR = [0, 0, 0];                 // Σ|reportedⱼ| during motion
    this.map = [null, null, null];         // per true axis: { col, sign, scale }
    // Residual gate state. emaM smooths the mapped gyro with the SAME filter
    // as the ground truth — comparing raw against smoothed would bake a ~50%
    // phantom residual into even a perfect device (gain 0.89, phase 27° at
    // 1Hz), which is exactly the kind of self-inflicted mismatch this file
    // keeps having to learn about.
    this.emaM = { x: 0, y: 0, z: 0 };
    this.resBad = 0;
    this.resAll = 0;
    this.gyroTrusted = false;

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

  /** One-line summary of the learned device map, for the debug overlay. */
  describeMap() {
    if (!this.hasGyro) return 'no gyro — orientation only';
    if (!this.gyroTrusted) return 'learning (orientation fallback)';
    return this.map.map((m, i) => (m
      ? `${AXES[i]}←${AXES[m.col]}${m.sign > 0 ? '+' : '−'}${m.scale.toFixed(m.scale > 5 ? 0 : 2)}`
      : `${AXES[i]}∅`)).join(' ');
  }

  /** Feed one packet from the phone. `dt` = seconds since the previous one. */
  update(sample, dt, now = 0) {
    const axes = axesFromSample(sample);
    this.source = sample.quat ? 'quaternion' : 'euler';
    this.live = true;
    this.lastSeen = now;

    // ── Ground-truth body rates from the attitude itself ──
    let omegaTrue = { x: 0, y: 0, z: 0 };
    if (this.prevAxes && dt > 0 && dt < 0.1) {
      omegaTrue = omegaFromAttitudes(this.prevAxes, axes, dt);
      const k = clamp(dt / this.emaTau, 0, 1);
      this.emaO.x += (omegaTrue.x - this.emaO.x) * k;
      this.emaO.y += (omegaTrue.y - this.emaO.y) * k;
      this.emaO.z += (omegaTrue.z - this.emaO.z) * k;
    }
    this.prevAxes = axes;

    const m = sample.motion;
    const r = m ? [m.rx || 0, m.ry || 0, m.rz || 0] : null;
    if (r && (r[0] || r[1] || r[2])) this.hasGyro = true;

    // ── Learn the device's axis map ──
    if (r && this.hasGyro && dt > 0 && dt < 0.1) {
      // Compare against reported samples from ~50ms ago so the orientation
      // estimate's lag lines up with the gyro instead of biasing the fit.
      this.ring.push(r);
      const delaySlots = Math.max(1, Math.round(0.05 / Math.max(dt, 1 / 240)));
      while (this.ring.length > delaySlots + 1) this.ring.shift();
      const rDel = this.ring[0];

      const moving = length(this.emaO) > 10;   // deg/s of smoothed real motion
      if (moving && rDel) {
        const decay = Math.exp(-dt / 30);
        const t = [this.emaO.x, this.emaO.y, this.emaO.z];
        for (let i = 0; i < 3; i += 1) {
          this.absO[i] = this.absO[i] * decay + Math.abs(t[i]) * dt;
          this.absR[i] = this.absR[i] * decay + Math.abs(rDel[i]) * dt;
          for (let j = 0; j < 3; j += 1) {
            this.C[i][j] = this.C[i][j] * decay + t[i] * rDel[j] * dt;
          }
        }

        // Claim a reported column for each true axis. Rules learned from
        // watching this flap in practice:
        //  - relative floor: an axis with under 15% of the dominant axis's
        //    motion is cross-talk and tremor, not signal. Claiming it adds
        //    nothing to the projections and destabilises the map. (Observed:
        //    the roll axis crept over an absolute threshold after 5s and its
        //    arrival reset the trust trial.)
        //  - sticky: an existing claim is kept unless a decisively different
        //    column wins, so evidence noise can't flap the map.
        //  - unique: greedy by motion, no two axes may claim one column.
        const maxAbsO = Math.max(...this.absO, 1e-9);
        const order = [0, 1, 2].sort((a, b) => this.absO[b] - this.absO[a]);
        const taken = new Set();
        const newMap = [null, null, null];
        for (const i of order) {
          const prev = this.map[i];
          const avail = this.C[i].map((v, j) => (taken.has(j) ? 0 : Math.abs(v)));
          const best = avail.indexOf(Math.max(...avail));
          const second = Math.max(...[0, 1, 2].filter((j) => j !== best)
            .map((j) => Math.abs(this.C[i][j])));
          const decisive = avail[best] > 2 * second && this.absR[best] > 1e-9;
          const eligible = this.absO[i] >= 15 && this.absO[i] >= 0.15 * maxAbsO;

          if (prev && !taken.has(prev.col) && !(decisive && best !== prev.col && eligible)) {
            const sign = Math.sign(this.C[i][prev.col]) || prev.sign;
            newMap[i] = {
              col: prev.col,
              sign,
              scale: this.absO[i] / Math.max(this.absR[prev.col], 1e-9),
            };
            taken.add(prev.col);
          } else if (eligible && decisive) {
            newMap[i] = {
              col: best,
              sign: Math.sign(this.C[i][best]),
              scale: this.absO[i] / Math.max(this.absR[best], 1e-9),
            };
            taken.add(best);
          }
        }
        this.map = newMap;
        const shape = this.map.map((mm) => (mm ? `${mm.col}${mm.sign > 0 ? '+' : '-'}` : '-'));

        // A different assignment means the old residual history judged a
        // different map. Start its trial fresh.
        const shapeKey = shape.join('');
        if (shapeKey !== this.mapShape) {
          this.mapShape = shapeKey;
          this.resBad = 0;
          this.resAll = 0;
        }

        // Trust the map only when its predictions match reality — compared
        // through the same smoothing filter on both sides.
        const mapped = this.applyMap(rDel);
        const km = clamp(dt / this.emaTau, 0, 1);
        this.emaM.x += (mapped.x - this.emaM.x) * km;
        this.emaM.y += (mapped.y - this.emaM.y) * km;
        this.emaM.z += (mapped.z - this.emaM.z) * km;
        const err = Math.hypot(this.emaM.x - this.emaO.x, this.emaM.y - this.emaO.y, this.emaM.z - this.emaO.z);
        this.resBad = this.resBad * decay + err * dt;
        this.resAll = this.resAll * decay + length(this.emaO) * dt;

        // 0.6 sits between the two populations with wide margin: a correct
        // map on a device with 30-100ms of orientation lag scores 0.05-0.45
        // (residual phase the 50ms ring can't fully align), while a wrong
        // column scores >=1.0 (uncorrelated) and a wrong sign ~2.0.
        const pitchClaimed = this.map[0] !== null;
        const yawClaimed = this.map[1] !== null || this.map[2] !== null;
        this.gyroTrusted = pitchClaimed && yawClaimed
          && this.resAll > 1 && this.resBad / this.resAll < 0.6;
      }
    }

    // ── Live body rates: learned gyro if trusted, ground truth otherwise ──
    let omega;
    let deadzone;
    if (this.gyroTrusted && r) {
      omega = this.applyMap(r);
      deadzone = this.deadzoneDps;
    } else {
      omega = this.emaO;
      deadzone = this.fallbackDeadzoneDps;
    }

    // ── Geometry: grip-agnostic screen axes from the live attitude ──
    // up = world-up in the body frame (world-z component of each body axis).
    const up = { x: axes.x.z, y: axes.y.z, z: axes.z.z };
    // forward = whichever beam axis (top edge, or out the back) is most
    // horizontal right now; right = forward × up. Computed per-packet, so
    // portrait, upright and landscape grips all pitch about the user's right.
    const beamY = axes.y;
    const beamZ = scale(axes.z, -1);
    const fwd = Math.abs(beamY.z) <= Math.abs(beamZ.z) ? beamY : beamZ;
    const right = norm(cross(fwd, up));

    let yawDps = dot(omega, up);
    let pitchDps = dot(omega, right);
    if (Math.abs(yawDps) < deadzone) yawDps = 0;
    if (Math.abs(pitchDps) < deadzone) pitchDps = 0;
    this.rateDps = { yaw: yawDps, pitch: pitchDps };

    // Positive yaw = counterclockwise from above = pointing left → cursor
    // left; positive pitch about user-right = pointing up → cursor up.
    // (Both verified numerically in core.test.mjs across grips and device
    // conventions — never trusted from derivation.)
    const sx = this.sensitivity * (this.invertX ? -1 : 1);
    const sy = this.sensitivity * (this.invertY ? -1 : 1);
    this.rate.x = (-yawDps / this.degPerScreen) * sx;
    this.rate.y = (-pitchDps / (this.degPerScreen * this.aspect)) * sy;
  }

  /** Reported gyro → true body rates through the learned map. */
  applyMap(r) {
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i += 1) {
      const mm = this.map[i];
      out[AXES[i]] = mm ? mm.sign * mm.scale * r[mm.col] : 0;
    }
    return out;
  }

  /**
   * Where to draw the cursor this frame. Integrates the current angular rate
   * at display rate, so motion is continuous regardless of packet rate.
   */
  sampleAt(now) {
    if (!this.lastDraw) this.lastDraw = now;
    let dt = (now - this.lastDraw) / 1000;
    this.lastDraw = now;
    if (!(dt > 0) || dt > 0.25) dt = 0;

    if (this.live && now - this.lastSeen < 250) {
      this.pos.x = clamp(this.pos.x + this.rate.x * dt, 0, 1);
      this.pos.y = clamp(this.pos.y + this.rate.y * dt, 0, 1);
    }
    return this.pos;
  }
}

export const MODES = ['gyro-rate'];
