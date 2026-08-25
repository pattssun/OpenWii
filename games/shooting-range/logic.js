/**
 * Shooting Range — gallery logic. No renderer, no DOM.
 *
 * One continuous 60-second gallery in a meadow: targets pop up, the
 * crosshair follows the pointer, A fires. Three target types:
 *   normal — the classic bullseye; smaller ones pay more (10..30)
 *   gold   — small and drifting on a sine sway; pays GOLD_POINTS
 *   bomb   — shooting it explodes and costs BOMB_PENALTY points
 *
 * Coordinates live in an abstract 1.6 × 1.0 field so the logic, the
 * renderer and the tests all agree on geometry.
 */

export const FIELD_W = 1.6;
export const FIELD_H = 1.0;
export const ROUND_MS = 60_000;
export const NORMAL_R_MIN = 0.05;
export const NORMAL_R_MAX = 0.085;
export const GOLD_R_MIN = 0.038;
export const GOLD_R_MAX = 0.055;
export const BOMB_R = 0.08;
export const GOLD_POINTS = 60;
export const BOMB_PENALTY = 20;
export const GOLD_CHANCE = 0.18;     // of each spawn roll…
export const BOMB_CHANCE = 0.12;     // …after the gold roll
export const GOLD_SWAY_HZ = 0.55;    // sine drift of the gold target

// Targets place into an invisible grid of sky cells — one target per cell,
// jittered inside it — so they spread uniformly and can never overlap.
export const SPAWN_COLS = 4;
export const SPAWN_ROWS = 3;
export const SPAWN_X0 = 0.08;
export const SPAWN_X1 = 1.52;
export const SPAWN_Y0 = 0.13;
export const SPAWN_Y1 = 0.88;
export const TARGET_TTL_MS = 2_800;
export const GOLD_TTL_MS = 3_400;
export const MAX_ALIVE = 6;
export const SPAWN_MS_START = 950;   // spawn interval at the start…
export const SPAWN_MS_END = 500;     // …ramping down to this by the end

/** Points for a NORMAL target of radius r: 30 smallest, 10 biggest. */
export function pointsFor(r) {
  return Math.round(10 + 20 * ((NORMAL_R_MAX - r) / (NORMAL_R_MAX - NORMAL_R_MIN)));
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
    this.bombs = 0;
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
    this.bombs = 0;
    this.startMs = now;
    this.nextSpawnMs = now + 400;     // a beat of quiet, then the first pop
  }

  get accuracy() {
    return this.shots ? this.hits / this.shots : 0;
  }

  spawn(now) {
    // A free cell is any the live targets don't sit in.
    const occupied = new Set(this.targets.map((t) => t.cell));
    const free = [];
    for (let i = 0; i < SPAWN_COLS * SPAWN_ROWS; i += 1) {
      if (!occupied.has(i)) free.push(i);
    }
    if (!free.length) return null;
    const cell = free[Math.floor(this.rng() * free.length) % free.length];

    const roll = this.rng();
    const kind = roll < GOLD_CHANCE ? 'gold'
      : roll < GOLD_CHANCE + BOMB_CHANCE ? 'bomb' : 'normal';
    const r = kind === 'gold' ? GOLD_R_MIN + this.rng() * (GOLD_R_MAX - GOLD_R_MIN)
      : kind === 'bomb' ? BOMB_R
        : NORMAL_R_MIN + this.rng() * (NORMAL_R_MAX - NORMAL_R_MIN);

    const cellW = (SPAWN_X1 - SPAWN_X0) / SPAWN_COLS;
    const cellH = (SPAWN_Y1 - SPAWN_Y0) / SPAWN_ROWS;
    const cx = SPAWN_X0 + ((cell % SPAWN_COLS) + 0.5) * cellW;
    const cy = SPAWN_Y0 + (Math.floor(cell / SPAWN_COLS) + 0.5) * cellH;

    // The gold sway and the jitter both stay inside the cell, so even a
    // drifting target can never reach a neighbour.
    const swayAmp = kind === 'gold'
      ? Math.min(0.06 + this.rng() * 0.06, cellW / 2 - r - 0.03) : 0;
    const jx = Math.max(0, cellW / 2 - r - swayAmp - 0.015);
    const jy = Math.max(0, cellH / 2 - r - 0.015);

    const t = {
      id: this.nextId++,
      kind,
      cell,
      x0: cx + (this.rng() * 2 - 1) * jx,
      y: cy + (this.rng() * 2 - 1) * jy,
      x: 0,
      r,
      swayAmp,
      phase: this.rng() * Math.PI * 2,
      bornMs: now,
      expiresMs: now + (kind === 'gold' ? GOLD_TTL_MS : TARGET_TTL_MS),
    };
    t.x = this.positionOf(t, now);
    this.targets.push(t);
    this.onEvent({ type: 'spawn', target: t });
    return t;
  }

  /** Gold targets drift on a sine sway; everything else holds still. */
  positionOf(t, now) {
    if (!t.swayAmp) return t.x0;
    const age = (now - t.bornMs) / 1000;
    return t.x0 + Math.sin(t.phase + age * GOLD_SWAY_HZ * Math.PI * 2) * t.swayAmp;
  }

  /** Fire at field coordinates. Returns { hit, kind?, points?, target? }. */
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
    if (best.kind === 'bomb') {
      this.bombs += 1;
      this.score = Math.max(0, this.score - BOMB_PENALTY);
      this.onEvent({ type: 'bombHit', penalty: BOMB_PENALTY, target: best, score: this.score });
      return { hit: true, kind: 'bomb', points: -BOMB_PENALTY, target: best };
    }
    this.hits += 1;
    const points = best.kind === 'gold' ? GOLD_POINTS : pointsFor(best.r);
    this.score += points;
    this.onEvent({ type: 'hit', kind: best.kind, points, target: best, score: this.score });
    return { hit: true, kind: best.kind, points, target: best };
  }

  update(now) {
    if (this.state !== 'running') return;

    this.targets = this.targets.filter((t) => {
      if (now < t.expiresMs) {
        t.x = this.positionOf(t, now);
        return true;
      }
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
        bombs: this.bombs,
        accuracy: this.accuracy,
      });
    }
  }
}
