/**
 * Kart time trial — track and kart logic. No renderer, no DOM.
 *
 * One closed circuit, three laps against the clock. Steering is the phone's
 * bank (gripTilt), throttle is automatic — the skill is the racing line.
 * Your best lap is recorded and replayed as a ghost.
 *
 * The track is a deterministic parametric centreline, so tests, the renderer
 * and the checkpoint logic all see exactly the same circuit.
 */

export const RACE_LAPS = 3;
export const TRACK_HALF_WIDTH = 11;
export const TOP_SPEED = 30;         // m/s on the racing surface
export const GRASS_SPEED = 11;       // crawling through the grass
export const CHECKPOINT_COUNT = 6;   // includes the start line (checkpoint 0)
export const SAMPLES = 512;          // centreline resolution for nearest-point queries

/** Closed-loop centreline, t in [0,1). Wavy enough to demand real steering. */
export function trackCenter(t) {
  const a = t * Math.PI * 2;
  const r = 150 + Math.sin(a * 2) * 34 + Math.cos(a * 3) * 16;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r * 0.8 };
}

/** Unit tangent of the centreline at t (finite difference). */
export function trackTangent(t) {
  const e = 1 / 2048;
  const p0 = trackCenter((t - e + 1) % 1);
  const p1 = trackCenter((t + e) % 1);
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

const SAMPLE_PTS = [];
for (let i = 0; i < SAMPLES; i += 1) SAMPLE_PTS.push(trackCenter(i / SAMPLES));

/** Nearest centreline parameter and distance for a world position. */
export function nearestOnTrack(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < SAMPLES; i += 1) {
    const p = SAMPLE_PTS[i];
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { t: best / SAMPLES, dist: Math.sqrt(bestD) };
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Signed shortest distance between two track parameters, in (-0.5, 0.5]. */
export function tDiff(a, b) {
  let d = a - b;
  while (d > 0.5) d -= 1;
  while (d <= -0.5) d += 1;
  return d;
}

export class Race {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.state = 'ready';            // ready | racing | done
    const start = trackCenter(0);
    const tan = trackTangent(0);
    this.pos = { x: start.x, z: start.z };
    this.heading = Math.atan2(tan.x, -tan.z);   // heading 0 faces -z, like the flyover
    this.speed = 0;
    this.steer = 0;                  // degrees of bank, +right
    this.lap = 1;
    this.nextCp = 1;                 // checkpoint 0 is the start line
    this.lapStartMs = 0;
    this.elapsedMs = 0;
    this.lapMs = 0;
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.lapTimes = [];
    this.onTrack = true;
    this.trackT = 0;
    // Ghost: the best lap, recorded as sparse keyframes and replayed translucent.
    this.recording = [];
    this.ghost = null;               // keyframes of the best lap
    this.lastKeyMs = -Infinity;
  }

  start(now) {
    const start = trackCenter(0);
    const tan = trackTangent(0);
    this.state = 'racing';
    this.pos = { x: start.x, z: start.z };
    this.heading = Math.atan2(tan.x, -tan.z);
    this.speed = 0;
    this.lap = 1;
    this.nextCp = 1;
    this.lapStartMs = now;
    this.elapsedMs = 0;
    this.lapMs = 0;
    this.lastLapMs = null;
    this.lapTimes = [];
    this.recording = [];
    this.lastKeyMs = -Infinity;
    this.startedAt = now;
    this.onEvent({ type: 'start' });
  }

  setSteer(bankDeg) {
    this.steer = Math.max(-60, Math.min(60, bankDeg));
  }

  update(now, dt) {
    if (this.state !== 'racing') return;
    this.elapsedMs = now - this.startedAt;
    this.lapMs = now - this.lapStartMs;

    const near = nearestOnTrack(this.pos.x, this.pos.z);
    this.trackT = near.t;
    this.onTrack = near.dist <= TRACK_HALF_WIDTH;

    // Auto-throttle toward the surface's speed; grass is punishing but not sticky.
    const target = this.onTrack ? TOP_SPEED : GRASS_SPEED;
    const accel = this.speed < target ? 14 : 26;
    this.speed += Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), accel * dt);

    // Bank steers; authority grows with speed so a standing kart can't pivot.
    const authority = Math.min(1, this.speed / 12);
    this.heading += (this.steer * Math.PI / 180) * 1.5 * authority * dt;

    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z -= Math.cos(this.heading) * this.speed * dt;

    // Ghost keyframes at 10 Hz — enough to interpolate smoothly.
    if (this.lapMs - this.lastKeyMs >= 100) {
      this.recording.push({ ms: this.lapMs, x: this.pos.x, z: this.pos.z, heading: this.heading });
      this.lastKeyMs = this.lapMs;
    }

    // Ordered checkpoints, then the start line closes the lap. A checkpoint
    // counts when the kart's track parameter sweeps past it near the track.
    const cpT = (this.nextCp % CHECKPOINT_COUNT) / CHECKPOINT_COUNT;
    if (Math.abs(tDiff(near.t, cpT)) < 0.04 && near.dist < TRACK_HALF_WIDTH * 2.5) {
      if (this.nextCp < CHECKPOINT_COUNT) {
        this.nextCp += 1;
        this.onEvent({ type: 'checkpoint', index: this.nextCp - 1 });
      } else {
        this.finishLap(now);
      }
    }
  }

  finishLap(now) {
    const ms = now - this.lapStartMs;
    this.lastLapMs = ms;
    this.lapTimes.push(ms);
    this.recording.push({ ms, x: this.pos.x, z: this.pos.z, heading: this.heading });
    const isBest = this.bestLapMs === null || ms < this.bestLapMs;
    if (isBest) {
      this.bestLapMs = ms;
      this.ghost = this.recording;
    }
    this.onEvent({ type: 'lap', lap: this.lap, ms, best: isBest });
    if (this.lap >= RACE_LAPS) {
      this.state = 'done';
      this.onEvent({
        type: 'done',
        totalMs: this.lapTimes.reduce((a, b) => a + b, 0),
        bestMs: this.bestLapMs,
      });
      return;
    }
    this.lap += 1;
    this.nextCp = 1;
    this.lapStartMs = now;
    this.recording = [];
    this.lastKeyMs = -Infinity;
  }

  /** Ghost pose at a lap-relative time, interpolated between keyframes. */
  ghostAt(lapMs) {
    const g = this.ghost;
    if (!g || g.length === 0) return null;
    if (lapMs <= g[0].ms) return g[0];
    if (lapMs >= g[g.length - 1].ms) return g[g.length - 1];
    let lo = 0;
    while (lo + 1 < g.length && g[lo + 1].ms <= lapMs) lo += 1;
    const a = g[lo];
    const b = g[lo + 1];
    const f = (lapMs - a.ms) / Math.max(1, b.ms - a.ms);
    return {
      ms: lapMs,
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      heading: a.heading + wrapAngle(b.heading - a.heading) * f,
    };
  }
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const h = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
}
