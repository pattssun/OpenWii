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

export function saveCalibration(frame, result) {
  if (!frame) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ frame, result, at: Date.now() }));
  } catch { /* private browsing, quota — not fatal */ }
}

export function loadCalibration({ maxAgeMs = 12 * 60 * 60 * 1000 } = {}) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved.frame || !saved.frame.f) return null;
    // A stale frame is worse than none: the player has almost certainly moved,
    // and a wrong neutral pose is confusing in a way "please calibrate" is not.
    if (Date.now() - (saved.at || 0) > maxAgeMs) return null;
    return saved;
  } catch {
    return null;
  }
}

export function clearCalibration() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export const STEADY_MS = 700;
const STEADY_KEEP_MS = STEADY_MS * 1.6;
const STEADY_GIVE_UP_MS = 6000;
const COS_STEADY = Math.cos(5 * DEG);

export const CAL_STEPS = ['signal', 'steady', 'range', 'done'];

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
          this.range = { yawMin: 0, yawMax: 0, pitchMin: 0, pitchMax: 0 };
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

      const spanX = r.yawMax - r.yawMin;
      const spanY = r.pitchMax - r.pitchMin;
      const elapsed = now - this.stepSince;
      if ((spanX > 30 && spanY > 14 && elapsed > 2600) || elapsed > 10000) this.finish();
    }

    return this.frame;
  }

  finish() {
    const r = this.range;
    const spanX = clamp(r.yawMax - r.yawMin, 25, 150);
    const spanY = clamp(r.pitchMax - r.pitchMin, 14, 110);

    // The middle of their swing is the natural neutral — re-zero there rather
    // than wherever their arm happened to stop.
    this.frame.yaw0 += (r.yawMin + r.yawMax) / 2;
    this.frame.pitch0 += (r.pitchMin + r.pitchMax) / 2;

    this.active = false;
    this.done = true;
    this.step = 'done';
    // 0.9 leaves a margin so the screen corners stay comfortably reachable.
    this.result = { degPerScreenX: spanX * 0.9, degPerScreenY: spanY * 0.9, grip: this.frame.axis };
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
