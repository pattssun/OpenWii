/**
 * Shooting Range — gallery logic. No renderer, no DOM.
 *
 * One continuous 60-second gallery: targets pop up across the field, the
 * crosshair follows the pointer, A fires. A shot inside a target's radius
 * destroys it; smaller targets are worth more. The round ends with score and
 * accuracy.
 *
 * Coordinates live in an abstract 1.6 × 1.0 field (16:10-ish) so the logic,
 * the renderer and the tests all agree on geometry.
 */

export const FIELD_W = 1.6;
export const FIELD_H = 1.0;
export const ROUND_MS = 60_000;
export const R_MIN = 0.035;
export const R_MAX = 0.085;
export const TARGET_TTL_MS = 2_800;
export const MAX_ALIVE = 6;
export const SPAWN_MS_START = 950;    // spawn interval at the start…
export const SPAWN_MS_END = 500;      // …ramping down to this by the end

/** Points for a target of radius r: 50 for the smallest, 10 for the biggest. */
export function pointsFor(r) {
  return Math.round(10 + 40 * ((R_MAX - r) / (R_MAX - R_MIN)));
}

export class Range {
  constructor({ onEvent = () => {}, rng = Math.random } = {}) {
    this.onEvent = onEvent;
    this.rng = rng;
    this.state = 'ready';             // ready | running | done
    this.targets = [];
    this.score = 0;
    this.shots = 0;
    this.hits = 0;
    this.startMs = 0;
    this.nextSpawnMs = 0;
    this.nextId = 1;
  }

  start(now) {
    this.state = 'running';
    this.targets = [];
    this.score = 0;
    this.shots = 0;
    this.hits = 0;
    this.startMs = now;
    this.nextSpawnMs = now + 400;     // a beat of quiet, then the first pop
  }

  get accuracy() {
    return this.shots ? this.hits / this.shots : 0;
  }

  spawn(now) {
    const r = R_MIN + this.rng() * (R_MAX - R_MIN);
    const t = {
      id: this.nextId++,
      x: r + 0.05 + this.rng() * (FIELD_W - 2 * (r + 0.05)),
      y: r + 0.12 + this.rng() * (FIELD_H - 2 * (r + 0.12)),
      r,
      bornMs: now,
      expiresMs: now + TARGET_TTL_MS,
    };
    this.targets.push(t);
    this.onEvent({ type: 'spawn', target: t });
    return t;
  }

  /** Fire at field coordinates. Returns { hit, points?, target? }. */
  shoot(x, y, now) {
    if (this.state !== 'running') return { hit: false };
    this.shots += 1;
    let best = null;
    let bestD = Infinity;
    for (const t of this.targets) {
      const d = Math.hypot(x - t.x, y - t.y);
      if (d <= t.r && d < bestD) { best = t; bestD = d; }
    }
    if (!best) {
      this.onEvent({ type: 'miss', x, y });
      return { hit: false };
    }
    this.targets = this.targets.filter((t) => t !== best);
    this.hits += 1;
    const points = pointsFor(best.r);
    this.score += points;
    this.onEvent({ type: 'hit', points, target: best, score: this.score });
    return { hit: true, points, target: best };
  }

  update(now) {
    if (this.state !== 'running') return;

    this.targets = this.targets.filter((t) => {
      if (now < t.expiresMs) return true;
      this.onEvent({ type: 'expire', target: t });
      return false;
    });

    const elapsed = now - this.startMs;
    const ramp = Math.min(1, elapsed / ROUND_MS);
    const interval = SPAWN_MS_START + (SPAWN_MS_END - SPAWN_MS_START) * ramp;
    if (now >= this.nextSpawnMs && this.targets.length < MAX_ALIVE
        && elapsed < ROUND_MS - 800) {
      this.spawn(now);
      this.nextSpawnMs = now + interval;
    }

    if (elapsed >= ROUND_MS) {
      this.state = 'done';
      this.onEvent({
        type: 'done',
        score: this.score,
        shots: this.shots,
        hits: this.hits,
        accuracy: this.accuracy,
      });
    }
  }
}
