import { Trail, segmentDistance } from '../../core/trail.js';

/**
 * Fruit Ninja — pure game logic. No Three.js, no DOM.
 *
 * Kept renderer-free so the mechanics can be tested headlessly in Node instead
 * of by evaluating JavaScript inside a browser tab. `game.js` owns rendering
 * and drives an instance of this.
 *
 * Units are a virtual play field measured in world units, `FIELD_H` tall and
 * `FIELD_H * aspect` wide — not pixels. The 2D original scaled its physics off
 * the window size, which quietly changed how the game felt when you resized it.
 */

export const FIELD_H = 9;
export const GRAVITY = 18.75;          // world units/s², = the old 1500 px/s²
export const MIN_SLICE_SPEED = 3.25;   // world units/s, = the old 260 px/s
export const FRUIT_TYPES = [
  { name: 'watermelon', rind: 0x2f8f4e, flesh: 0xff4d5e, r: 0.65 },
  { name: 'orange', rind: 0xff9f1c, flesh: 0xffbe55, r: 0.53 },
  { name: 'lime', rind: 0x7ec850, flesh: 0xc9e88a, r: 0.48 },
  { name: 'plum', rind: 0x8e5cd9, flesh: 0xd9b8ff, r: 0.5 },
  { name: 'peach', rind: 0xff7a6b, flesh: 0xffd0b0, r: 0.55 },
  { name: 'blueberry', rind: 0x4d7cff, flesh: 0xa8c0ff, r: 0.43 },
];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class FruitNinja {
  constructor({ aspect = 16 / 9, onEvent = () => {} } = {}) {
    this.h = FIELD_H;
    this.w = FIELD_H * aspect;
    this.onEvent = onEvent;

    this.state = {
      phase: 'idle',        // idle | playing | over
      score: 0,
      lives: 3,
      combo: 0,
      comboUntil: 0,
      nextSpawn: 0,
      startedAt: 0,
    };

    this.fruits = [];
    this.halves = [];
    this.particles = [];
    this.trail = new Trail({ lifetimeMs: 140, minStep: 0.004, speedWindowMs: 55 });
    this.cursor = { x: 0, y: 0, active: false };
  }

  setAspect(aspect) {
    this.w = this.h * aspect;
  }

  /** Pointer position in world units. */
  setCursor(x, y, now) {
    this.cursor.x = x;
    this.cursor.y = y;
    this.cursor.active = true;
    this.trail.push(x, y, now);
  }

  start(now) {
    Object.assign(this.state, {
      phase: 'playing', score: 0, lives: 3, combo: 0, comboUntil: 0,
      startedAt: now, nextSpawn: now + 900,
    });
    this.fruits.length = 0;
    this.halves.length = 0;
    this.particles.length = 0;
    this.trail.clear();
    this.onEvent({ type: 'start' });
  }

  end(now) {
    this.state.phase = 'over';
    this.onEvent({ type: 'gameover', score: this.state.score });
  }

  spawn(isBomb, now) {
    const kind = FRUIT_TYPES[(Math.random() * FRUIT_TYPES.length) | 0];
    const x = rand(-this.w * 0.38, this.w * 0.38);
    const rise = rand(this.h * 0.55, this.h * 0.88);
    this.fruits.push({
      x,
      y: -this.h / 2 - 0.8,
      vx: (-x / 4) * rand(0.4, 1.1),
      vy: Math.sqrt(2 * GRAVITY * rise),
      r: isBomb ? 0.5 : kind.r,
      rot: rand(0, Math.PI * 2),
      spin: rand(-2.4, 2.4),
      spinAxis: { x: rand(-1, 1), y: rand(-1, 1), z: rand(-1, 1) },
      bomb: !!isBomb,
      kind,
      id: FruitNinja.nextId++,
    });
  }

  slice(f, angle, now) {
    const perp = angle + Math.PI / 2;
    for (const side of [-1, 1]) {
      this.halves.push({
        x: f.x, y: f.y,
        vx: f.vx + Math.cos(perp) * side * rand(1.2, 2.2),
        vy: f.vy + Math.sin(perp) * side * rand(1.2, 2.2) - 0.8,
        r: f.r,
        // `cut` is the fixed angle of the slice line; `tumble` accumulates
        // about it. Keeping them separate lets the renderer point the flat
        // face along the separation direction and still spin the half so the
        // exposed flesh turns toward the camera.
        cut: angle,
        tumble: 0,
        spin: side * rand(1.5, 4),
        side,
        kind: f.kind,
        id: FruitNinja.nextId++,
      });
    }
    for (let i = 0; i < 22; i += 1) {
      const a = angle + rand(-0.9, 0.9) + (Math.random() < 0.5 ? 0 : Math.PI);
      const s = rand(1, 6);
      this.particles.push({
        x: f.x, y: f.y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s + rand(0, 1.8),
        r: rand(0.03, 0.1), color: f.kind.rind, life: 1, decay: rand(0.7, 1.6),
        id: FruitNinja.nextId++,
      });
    }
  }

  explode(f) {
    for (let i = 0; i < 90; i += 1) {
      const a = rand(0, Math.PI * 2);
      const s = rand(1.5, 11);
      this.particles.push({
        x: f.x, y: f.y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        r: rand(0.025, 0.11), color: Math.random() < 0.5 ? 0xffd166 : 0xff5f6d,
        life: 1, decay: rand(0.6, 1.4), id: FruitNinja.nextId++,
      });
    }
  }

  spawnInterval(now) {
    return Math.max(320, 1000 - ((now - this.state.startedAt) / 1000) * 12);
  }

  bombChance(now) {
    return clamp(0.04 + ((now - this.state.startedAt) / 1000) * 0.0022, 0, 0.2);
  }

  update(now, dt) {
    this.stepDebris(dt);
    if (this.state.phase !== 'playing') return;

    if (now >= this.state.nextSpawn) {
      const burst = Math.random() < 0.22 ? 3 : Math.random() < 0.45 ? 2 : 1;
      for (let i = 0; i < burst; i += 1) this.spawn(Math.random() < this.bombChance(now), now);
      this.state.nextSpawn = now + this.spawnInterval(now);
    }

    const canCut = this.trail.speed() > MIN_SLICE_SPEED && this.trail.segments.length > 0;
    const floor = -this.h / 2 - 1.2;

    for (let i = this.fruits.length - 1; i >= 0; i -= 1) {
      const f = this.fruits[i];
      f.vy -= GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.spin * dt;

      if (canCut) {
        let cut = false;
        for (const s of this.trail.segments) {
          if (segmentDistance(f.x, f.y, s.x1, s.y1, s.x2, s.y2) > f.r) continue;
          cut = true;
          this.fruits.splice(i, 1);
          if (f.bomb) {
            this.explode(f);
            this.onEvent({ type: 'bomb' });
            this.end(now);
          } else {
            this.slice(f, Math.atan2(s.y2 - s.y1, s.x2 - s.x1), now);
            this.state.combo = now < this.state.comboUntil ? this.state.combo + 1 : 1;
            this.state.comboUntil = now + 260;
            const gained = 1 + (this.state.combo > 1 ? this.state.combo : 0);
            this.state.score += gained;
            this.onEvent({ type: 'slice', combo: this.state.combo, gained, x: f.x, y: f.y });
          }
          break;
        }
        if (cut) continue;
      }

      if (f.y + f.r < floor) {
        this.fruits.splice(i, 1);
        if (!f.bomb && this.state.phase === 'playing') {
          this.state.lives -= 1;
          this.onEvent({ type: 'miss', lives: this.state.lives });
          if (this.state.lives <= 0) this.end(now);
        }
      }
    }

    if (this.state.combo > 1 && now >= this.state.comboUntil) this.state.combo = 0;
  }

  stepDebris(dt) {
    const floor = -this.h / 2 - 2;
    for (let i = this.halves.length - 1; i >= 0; i -= 1) {
      const h = this.halves[i];
      h.vy -= GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.tumble += h.spin * dt;
      if (h.y < floor) this.halves.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.vy -= GRAVITY * 0.55 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }
}

FruitNinja.nextId = 1;
