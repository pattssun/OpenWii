import {
  DEG, clamp, dot, scale, sub, cross, length, axesFromSample,
} from './orientation.js';

/**
 * Calibration — measure the player's grip instead of assuming one.
 *
 * The naive approach treats the phone's top edge as the aim axis and reads yaw
 * off `alpha`. That works only for the grip you happened to assume. Hold the
 * phone upright like a TV remote and the top edge points at the ceiling: that's
 * the gimbal singularity, yaw stops meaning anything, and swinging sideways
 * moves the cursor *not at all*. It's a silent failure — data streams at 60Hz
 * and the cursor simply won't go left or right.
 *
 * So we measure:
 *   1. Wait until the phone is genuinely still, then snapshot that pose.
 *   2. Pick whichever body axis is closest to horizontal — that's what the
 *      player is actually pointing with. Flat-in-palm grips resolve to the top
 *      edge; upright remote grips resolve to the phone's back.
 *   3. Build an orthonormal frame (forward/right/up) around it, so every angle
 *      is measured relative to the player's own neutral pose. That puts the
 *      singularity a full 90° away from where they're actually holding it.
 *   4. Watch practice swings, size the mapping to their real range, and re-zero
 *      at the centre of it.
 */

/**
 * Calibration persists across pages.
 *
 * Each channel is its own document, so without this the player would be asked
 * to hold still and swing again every single time they opened a game — which
 * would make the keyboard-free menu→game→menu loop miserable. Calibrate once at
 * the menu; every channel inherits it.
 */
const STORAGE_KEY = 'openwii.calibration.v1';

/**
 * The server's boot id, fetched once per page. Calibration is scoped to it, so
 * the flow runs once per `npm start` and every page afterwards inherits it.
 */
let bootId = null;

export async function fetchBootId() {
  if (bootId) return bootId;
  try {
    const res = await fetch('/api/session');
    bootId = (await res.json()).bootId;
  } catch {
    bootId = 'unknown';
  }
  return bootId;
}

export function saveCalibration(frame, result) {
  if (!frame) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ frame, result, bootId, at: Date.now() }));
  } catch { /* private browsing, quota — not fatal */ }
}

export function loadCalibration() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved.frame || !saved.frame.f) return null;
    // Tied to the server run. A calibration from a previous run is stale by
    // definition — the player has moved, and a wrong neutral pose is more
    // confusing than being asked to calibrate.
    if (!bootId || saved.bootId !== bootId) return null;
    return saved;
  } catch {
    return null;
  }
}

export function clearCalibration() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Pointer speed is a preference, not a measurement.
 *
 * How fast a cursor should feel is genuinely personal, and no amount of
 * calibration can derive it — so it is tunable live and remembered. Unlike the
 * calibration frame this is NOT scoped to a server run: a preference that
 * resets every time you restart the server is not a preference.
 */
const SENSITIVITY_KEY = 'openwii.sensitivity.v1';

export function saveSensitivity(v) {
  try { localStorage.setItem(SENSITIVITY_KEY, String(v)); } catch { /* ignore */ }
}

export function loadSensitivity() {
  try {
    const v = Number(localStorage.getItem(SENSITIVITY_KEY));
    return Number.isFinite(v) && v > 0 ? clamp(v, 0.2, 6) : null;
  } catch {
    return null;
  }
}

// Long enough to be a real measurement of the hand's tremor plus the sensor's
// own noise, not just a couple of samples that happened to agree.
export const STEADY_MS = 1200;
const STEADY_KEEP_MS = STEADY_MS * 1.6;
const STEADY_GIVE_UP_MS = 6000;
const COS_STEADY = Math.cos(5 * DEG);

export const CAL_STEPS = ['signal', 'steady', 'range', 'done'];

/**
 * Peak angular deviation, in degrees, across a window of "held still" samples.
 *
 * This is the hand's tremor plus the sensor's noise — the floor below which no
 * movement can be trusted as intent. Everything downstream that has to
 * distinguish "the player moved" from "the player is human" is scaled off it.
 */
export function measureNoise(buf, current) {
  let worst = 0;
  for (const s of buf) {
    // The two axes bound the phone's attitude; the larger deviation wins.
    const a = Math.acos(clamp(dot(s.y, current.y), -1, 1));
    const b = Math.acos(clamp(dot(s.z, current.z), -1, 1));
    worst = Math.max(worst, a, b);
  }
  return worst / DEG;
}

/** Build a frame around whichever axis the player is pointing with. */
export function buildFrame(axes) {
  // Smaller |z| means closer to horizontal.
  const useTopEdge = Math.abs(axes.y.z) <= Math.abs(axes.z.z);
  const f = useTopEdge ? axes.y : scale(axes.z, -1);   // -z = out the phone's back

  // Gram-Schmidt world-up against forward to get the frame's up vector.
  let u = sub({ x: 0, y: 0, z: 1 }, scale(f, f.z));
  const ulen = length(u);
  if (ulen < 1e-3) return null;                        // pointing dead vertical
  u = scale(u, 1 / ulen);

  return { f, u, r: cross(f, u), axis: useTopEdge ? 'y' : 'z', yaw0: 0, pitch0: 0 };
}

export function forwardOf(frame, axes) {
  return frame.axis === 'y' ? axes.y : scale(axes.z, -1);
}

/** Yaw/pitch of the phone measured inside a calibrated frame. */
export function anglesIn(frame, fwd) {
  return {
    yaw: Math.atan2(dot(fwd, frame.r), dot(fwd, frame.f)) / DEG - frame.yaw0,
    pitch: Math.asin(clamp(dot(fwd, frame.u), -1, 1)) / DEG - frame.pitch0,
  };
}

/**
 * Calibration state machine. Driven by orientation samples; emits step changes
 * through `onStep` so a UI (PC screen and phone alike) can follow along.
 */
export class Calibration {
  constructor({ onStep = () => {}, onDone = () => {} } = {}) {
    this.onStep = onStep;
    this.onDone = onDone;
    this.active = false;
    this.done = false;
    this.step = 'signal';
    this.stepSince = 0;
    this.steadyBuf = [];
    this.frame = null;
    this.range = { yawMin: 0, yawMax: 0, pitchMin: 0, pitchMax: 0 };
    this.noiseDeg = 0;
    this.lastSpan = 0;
    this.spanStillSince = 0;
    this.result = null;
  }

  start(now) {
    this.active = true;
    this.done = false;
    this.frame = null;
    this.steadyBuf.length = 0;
    this.setStep('signal', now);
  }

  setStep(step, now) {
    this.step = step;
    this.stepSince = now;
    this.onStep(step);
  }

  /** Feed one sample. Returns the frame once one exists, else null. */
  advance(sample, now) {
    const axes = axesFromSample(sample);
    if (!this.active) return this.frame;

    if (this.step === 'signal') {
      this.setStep('steady', now);       // first packet through the door
      return this.frame;
    }

    if (this.step === 'steady') {
      this.steadyBuf.push({ t: now, y: axes.y, z: axes.z });
      while (this.steadyBuf.length > 1 && now - this.steadyBuf[0].t > STEADY_KEEP_MS) {
        this.steadyBuf.shift();
      }

      // Gate on elapsed *sample time*, not sample count. Counting samples
      // quietly imposes a minimum sensor rate — a phone streaming at 4Hz, or a
      // stuttering link, could hold perfectly still forever and never pass.
      const spans = this.steadyBuf.length >= 2 && now - this.steadyBuf[0].t >= STEADY_MS;
      const agrees = this.steadyBuf.every(
        (s) => dot(s.y, axes.y) > COS_STEADY && dot(s.z, axes.z) > COS_STEADY,
      );
      // Shaky hands shouldn't dead-end the flow.
      const givenUp = now - this.stepSince > STEADY_GIVE_UP_MS;

      if ((spans && agrees) || givenUp) {
        const built = buildFrame(axes);
        if (built) {
          this.frame = built;
          // The hold is also a measurement: how much does this hand, holding
          // this phone, wobble when it is trying not to?
          this.noiseDeg = measureNoise(this.steadyBuf, axes);
          this.range = { yawMin: 0, yawMax: 0, pitchMin: 0, pitchMax: 0 };
          this.lastSpan = 0;
          this.spanStillSince = now;
          this.setStep('range', now);
        } else if (givenUp) {
          this.stepSince = now;          // dead vertical: no usable frame
        }
      }
      return this.frame;
    }

    if (this.step === 'range' && this.frame) {
      const { yaw, pitch } = anglesIn(this.frame, forwardOf(this.frame, axes));
      const r = this.range;
      r.yawMin = Math.min(r.yawMin, yaw);
      r.yawMax = Math.max(r.yawMax, yaw);
      r.pitchMin = Math.min(r.pitchMin, pitch);
      r.pitchMax = Math.max(r.pitchMax, pitch);

      /**
       * End when the player has finished, not the instant a threshold is met.
       *
       * The old rule tested total span, so sweeping left-right and then merely
       * *upward* satisfied it — calibration closed before you could come back
       * down, and the whole downward half of your range went unmeasured. Now
       * each direction has to be seen on its own, and the swept range has to
       * have stopped growing for a moment, so it ends when you stop rather than
       * mid-swing.
       */
      const bothYaw = r.yawMin < -12 && r.yawMax > 12;
      const bothPitch = r.pitchMin < -7 && r.pitchMax > 7;
      const span = (r.yawMax - r.yawMin) + (r.pitchMax - r.pitchMin);
      if (span > this.lastSpan + 0.5) {
        this.lastSpan = span;
        this.spanStillSince = now;             // still exploring
      }
      const settled = now - (this.spanStillSince || now) > 900;
      const elapsed = now - this.stepSince;
      if ((bothYaw && bothPitch && settled && elapsed > 3000) || elapsed > 14000) this.finish();
    }

    return this.frame;
  }

  finish() {
    const r = this.range;
    // Cap how much of the swing maps to the screen. A player told to make "big
    // sweeps" can easily produce 120°+, and mapping all of it means crossing
    // the screen takes a whole-arm movement — precise, but exhausting and slow.
    // Pointing wants wrist-scale motion.
    //
    // The lower bound is where jitter lives: on-screen wobble is noise divided
    // by degrees-per-screen, so a tight mapping magnifies a shaky hand. Hold
    // the floor far enough above the measured noise that tremor stays under
    // roughly 1% of screen width.
    // The 90x factor here was set when jitter was the complaint, and it forced
    // any hand noisier than ~0.7° into a 45°+ mapping — meaning you had to
    // rotate the phone 45° to cross the screen, which is exhausting and reads
    // as "slow". Gyro fusion and the motion gate have since removed most of the
    // jitter this was defending against, so the floor can come down a long way.
    const noiseFloor = clamp(this.noiseDeg * 55, 20, 50);
    const hiX = Math.max(noiseFloor, 60);
    const hiY = Math.max(noiseFloor * 0.62, 40);
    const spanX = clamp(r.yawMax - r.yawMin, noiseFloor, hiX);
    const spanY = clamp(r.pitchMax - r.pitchMin, noiseFloor * 0.62, hiY);

    // The middle of their swing is the natural neutral — re-zero there rather
    // than wherever their arm happened to stop.
    this.frame.yaw0 += (r.yawMin + r.yawMax) / 2;
    this.frame.pitch0 += (r.pitchMin + r.pitchMax) / 2;

    this.active = false;
    this.done = true;
    this.step = 'done';
    // 0.6 leaves margin so the corners stay reachable without stretching.
    this.result = {
      degPerScreenX: spanX * 0.6,
      degPerScreenY: spanY * 0.6,
      grip: this.frame.axis,
      noiseDeg: this.noiseDeg,
    };
    saveCalibration(this.frame, this.result);
    this.onStep('done');
    this.onDone(this.result);
  }

  /** Re-zero the neutral pose from the current sample, keeping sensitivity. */
  recentre(sample) {
    const built = buildFrame(axesFromSample(sample));
    if (!built) return false;
    this.frame = built;
    saveCalibration(this.frame, this.result);
    return true;
  }

  /** Adopt a frame saved by an earlier page. Returns the stored result. */
  restore(saved) {
    if (!saved || !saved.frame) return null;
    this.frame = saved.frame;
    this.done = true;
    this.active = false;
    this.step = 'done';
    this.result = saved.result || null;
    return this.result;
  }

  /** Adopt whatever we have and stop, for a player who skips the flow. */
  skip(sample) {
    if (!this.frame && sample) this.recentre(sample);
    this.active = false;
    this.done = true;
    this.step = 'done';
    this.onStep('done');
    return this.frame;
  }
}
