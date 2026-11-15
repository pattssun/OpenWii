/**
 * Bowling — rules, scoring and lane physics. No renderer, no DOM.
 *
 * Coordinates are metres on a top-down lane: x is across the lane (+ right of
 * the bowler), z runs from the foul line (0) towards the pins. Real ten-pin
 * dimensions are used so a throw behaves the way people expect.
 *
 * Three layers, each testable alone:
 *   - scoring   : nextRoll() / scoreFrames() — pure functions of the roll list
 *   - physics   : LaneSim — one ball, ten pins, fixed timestep, deterministic
 *   - match     : Match — turns, re-racks and results for 1–2 players
 */

// ── Geometry ───────────────────────────────────────────────────────────────
export const LANE = {
  halfWidth: 0.5334,        // 41.5in lane
  gutterWidth: 0.235,
  headPinZ: 18.288,         // 60ft from the foul line
  pinSpacing: 0.3048,       // 12in between pin centres
  pitZ: 19.55,              // pins past here have dropped into the pit
  pinRadius: 0.0605,
  ballRadius: 0.1085,
};
export const MAX_PLAYERS = 2;
export const FIXED_DT = 1 / 480;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The ten-pin triangle, bowler's view: pin 1 at the front, 7 and 10 in the back corners. */
export function rack() {
  const row = LANE.pinSpacing * Math.cos(Math.PI / 6);
  const half = LANE.pinSpacing / 2;
  const layout = [
    [0],
    [-half, half],
    [-2 * half, 0, 2 * half],
    [-3 * half, -half, half, 3 * half],
  ];
  const pins = [];
  let id = 1;
  layout.forEach((xs, r) => {
    for (const x of xs) pins.push({ id: id++, x, z: LANE.headPinZ + r * row });
  });
  return pins;
}

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * Where the next roll falls, given the pins knocked down by each roll so far.
 * `fresh` says whether the next roll starts from a full rack.
 */
export function nextRoll(rolls) {
  let i = 0;
  for (let frame = 1; frame <= 9; frame += 1) {
    if (i >= rolls.length) return { frame, roll: 0, fresh: true, done: false };
    if (rolls[i] === 10) { i += 1; continue; }
    if (i + 1 >= rolls.length) return { frame, roll: 1, fresh: false, done: false };
    i += 2;
  }
  const r = rolls.slice(i);
  if (r.length === 0) return { frame: 10, roll: 0, fresh: true, done: false };
  if (r.length === 1) return { frame: 10, roll: 1, fresh: r[0] === 10, done: false };
  if (r.length === 2) {
    if (r[0] === 10) return { frame: 10, roll: 2, fresh: r[1] === 10, done: false };
    if (r[0] + r[1] === 10) return { frame: 10, roll: 2, fresh: true, done: false };
  }
  return { frame: 10, roll: 3, fresh: false, done: true };
}

/**
 * Ten frames of {rolls, score}. `score` is the running total, or null while a
 * strike/spare is still waiting for its bonus rolls.
 */
export function scoreFrames(rolls) {
  const frames = [];
  let i = 0;
  let total = 0;
  let blocked = false;
  for (let f = 0; f < 10; f += 1) {
    let shown = [];
    let score = null;
    if (f < 9) {
      if (rolls[i] === 10) {
        shown = [10];
        if (rolls[i + 1] !== undefined && rolls[i + 2] !== undefined) score = 10 + rolls[i + 1] + rolls[i + 2];
      } else if (rolls[i] !== undefined) {
        shown = rolls.slice(i, i + 2);
        if (shown.length === 2) {
          const sum = shown[0] + shown[1];
          if (sum < 10) score = sum;
          else if (rolls[i + 2] !== undefined) score = 10 + rolls[i + 2];
        }
      }
      i += shown.length;
    } else {
      shown = rolls.slice(i, i + 3);
      const strikeOrSpare = shown.length >= 2 && (shown[0] === 10 || shown[0] + shown[1] === 10);
      if (shown.length >= (strikeOrSpare ? 3 : 2)) score = shown.reduce((x, y) => x + y, 0);
    }
    if (score === null || blocked) {
      blocked = true;
      frames.push({ rolls: shown, score: null });
    } else {
      total += score;
      frames.push({ rolls: shown, score: total });
    }
  }
  return frames;
}

export const totalScore = (rolls) => {
  const done = scoreFrames(rolls).filter((f) => f.score !== null);
  return done.length ? done[done.length - 1].score : 0;
};

/** Scorecard marks for one frame: X, /, digits and - for a miss. */
export function marks(frame, index) {
  const out = [];
  const r = frame.rolls;
  const sym = (v) => (v === 0 ? '-' : String(v));
  if (index < 9) {
    if (r[0] === 10) return ['', 'X'];
    if (r.length > 0) out.push(sym(r[0]));
    if (r.length > 1) out.push(r[0] + r[1] === 10 ? '/' : sym(r[1]));
    return out;
  }
  let standing = 10;
  r.forEach((v) => {
    if (standing === 10 && v === 10) { out.push('X'); standing = 10; return; }
    if (standing < 10 && v === standing) { out.push('/'); standing = 10; return; }
    out.push(sym(v));
    standing = standing === 10 ? 10 - v : standing - v;
  });
  return out;
}

// ── Physics ────────────────────────────────────────────────────────────────

const BALL_MASS = 6.5;
const PIN_MASS = 1.6;
const BALL_PIN_RESTITUTION = 0.5;
const PIN_PIN_RESTITUTION = 0.7;
const STAND_FRICTION = 22;       // m/s² — a nudged pin skids to a halt
const DOWN_FRICTION = 1.6;       // m/s² — a toppled pin slides much further
const FALL_DELTA_V = 0.5;        // m/s change that knocks a pin over
const SHOVE_DISTANCE = 0.09;     // m a standing pin may slide before it tips
const FALLEN_REACH = 0.09;      // m — a toppled pin sweeps a wider arc than a standing one
const HOOK_ACCEL = 0.62;         // m/s² of sideways pull at full hook
const BALL_DRAG = 0.12;          // m/s² — the ball loses a little pace on the way

/** Normalise throw parameters from any input method into physical ones. */
export function normalizeThrow(t = {}) {
  return {
    x0: clamp(Number.isFinite(t.x0) ? t.x0 : 0, -0.45, 0.45),
    angle: clamp(Number.isFinite(t.angle) ? t.angle : 0, -0.3, 0.3),   // radians, + = right
    speed: clamp(Number.isFinite(t.speed) ? t.speed : 7, 2, 10.5),     // m/s down the lane
    hook: clamp(Number.isFinite(t.hook) ? t.hook : 0, -1, 1),          // + curves right
  };
}

export class LaneSim {
  /**
   * @param pins standing pins [{id,x,z}] — positions are kept between rolls
   * @param throwParams see normalizeThrow
   */
  constructor({ pins, throw: throwParams, onEvent = () => {} }) {
    const t = normalizeThrow(throwParams);
    this.throw = t;
    this.onEvent = onEvent;
    this.time = 0;
    this.pins = pins.map((p) => ({ ...p, x0: p.x, z0: p.z, vx: 0, vz: 0, down: false, out: false, hit: false }));
    this.ball = {
      x: t.x0,
      z: 0,
      vx: Math.sin(t.angle) * t.speed,
      vz: Math.cos(t.angle) * t.speed,
      gutter: 0,           // -1 / +1 once it has dropped in a gutter
      done: false,
      hitPins: false,
    };
    this.settled = 0;
    this.done = false;
    this.accumulator = 0;
  }

  get standing() {
    return this.pins.filter((p) => !p.down && !p.out);
  }
  get knocked() {
    return this.pins.filter((p) => p.down || p.out);
  }

  /** Advance by wall-clock dt; runs whole physics steps. */
  update(dt) {
    this.accumulator += Math.min(dt, 0.1);
    while (!this.done && this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }

  step(dt) {
    this.time += dt;
    this.stepBall(dt);
    this.stepPins(dt);
    this.collide();
    const moving = this.pins.some((p) => !p.out && Math.hypot(p.vx, p.vz) > 0.03);
    if (this.ball.done && !moving) this.settled += dt;
    else this.settled = 0;
    if ((this.ball.done && this.settled > 0.35) || this.time > 12) {
      this.done = true;
      this.onEvent({ type: 'settled', knocked: this.knocked.length });
    }
  }

  stepBall(dt) {
    const b = this.ball;
    if (b.done) return;
    if (!b.gutter && Math.abs(b.x) > LANE.halfWidth + LANE.ballRadius * 0.35) {
      b.gutter = Math.sign(b.x);
      b.vx = 0;
      this.onEvent({ type: 'gutter', side: b.gutter });
    }
    if (b.gutter) {
      b.x += (b.gutter * (LANE.halfWidth + 0.115) - b.x) * Math.min(1, dt * 18);
    } else {
      // Late hook: the ball skids on the oil early and grabs near the pins.
      const pull = this.throw.hook * HOOK_ACCEL * smoothstep(5, 15, b.z) * (1 - smoothstep(LANE.headPinZ - 0.8, LANE.headPinZ + 0.1, b.z));
      b.vx += pull * dt;
    }
    const speed = Math.hypot(b.vx, b.vz);
    const slow = Math.min(speed, BALL_DRAG * dt);
    if (speed > 0) { b.vx -= (b.vx / speed) * slow; b.vz -= (b.vz / speed) * slow; }
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    if (b.z > LANE.pitZ + 0.5 || Math.hypot(b.vx, b.vz) < 0.15) b.done = true;
  }

  stepPins(dt) {
    for (const p of this.pins) {
      if (p.out) continue;
      const speed = Math.hypot(p.vx, p.vz);
      if (speed > 0) {
        const drop = Math.min(speed, (p.down ? DOWN_FRICTION : STAND_FRICTION) * dt);
        p.vx -= (p.vx / speed) * drop;
        p.vz -= (p.vz / speed) * drop;
      }
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      // A pin shoved well off its spot has been tipped, not merely nudged.
      if (!p.down && Math.hypot(p.x - p.x0, p.z - p.z0) > SHOVE_DISTANCE) this.topple(p, 'shove');
      const edge = LANE.halfWidth + LANE.pinRadius * 0.4;
      if (p.z > LANE.pitZ || Math.abs(p.x) > edge + (p.down ? 0.12 : 0)) {
        if (!p.down) this.topple(p, 'edge');
        if (p.z > LANE.pitZ || Math.abs(p.x) > edge + 0.12) { p.out = true; p.vx = p.vz = 0; }
      }
    }
  }

  topple(p, cause) {
    if (p.down) return;
    p.down = true;
    this.onEvent({ type: 'pinDown', id: p.id, cause, time: this.time });
  }

  collide() {
    const b = this.ball;
    const live = this.pins.filter((p) => !p.out);
    if (!b.done && !b.gutter) {
      for (const p of live) {
        const dx = p.x - b.x;
        const dz = p.z - b.z;
        const d = Math.hypot(dx, dz);
        const min = LANE.ballRadius + LANE.pinRadius;
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const nz = dz / d;
        const rel = (p.vx - b.vx) * nx + (p.vz - b.vz) * nz;
        const overlap = min - d;
        // Resolve overlap by moving the lighter body.
        const pw = BALL_MASS / (BALL_MASS + PIN_MASS);
        p.x += nx * overlap * pw; p.z += nz * overlap * pw;
        b.x -= nx * overlap * (1 - pw); b.z -= nz * overlap * (1 - pw);
        if (rel >= 0) continue;
        const j = (-(1 + BALL_PIN_RESTITUTION) * rel) / (1 / BALL_MASS + 1 / PIN_MASS);
        p.vx += (j * nx) / PIN_MASS; p.vz += (j * nz) / PIN_MASS;
        b.vx -= (j * nx) / BALL_MASS; b.vz -= (j * nz) / BALL_MASS;
        if (!b.hitPins) {
          b.hitPins = true;
          this.onEvent({ type: 'ballHit', speed: Math.hypot(b.vx, b.vz), x: b.x });
        }
        p.hit = true;
        if (j / PIN_MASS > FALL_DELTA_V) this.topple(p, 'ball');
      }
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let k = i + 1; k < live.length; k += 1) {
        const a = live[i];
        const c = live[k];
        const dx = c.x - a.x;
        const dz = c.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = (a.down ? FALLEN_REACH : LANE.pinRadius) + (c.down ? FALLEN_REACH : LANE.pinRadius);
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const nz = dz / d;
        const overlap = (min - d) / 2;
        a.x -= nx * overlap; a.z -= nz * overlap;
        c.x += nx * overlap; c.z += nz * overlap;
        const rel = (c.vx - a.vx) * nx + (c.vz - a.vz) * nz;
        if (rel >= 0) continue;
        const j = (-(1 + PIN_PIN_RESTITUTION) * rel) / (2 / PIN_MASS);
        a.vx -= (j * nx) / PIN_MASS; a.vz -= (j * nz) / PIN_MASS;
        c.vx += (j * nx) / PIN_MASS; c.vz += (j * nz) / PIN_MASS;
        // A moving pin that is down, or one hit hard, knocks its neighbour over.
        if (j / PIN_MASS > FALL_DELTA_V) { this.topple(a, 'pin'); this.topple(c, 'pin'); }
      }
    }
  }
}

/** Run a whole roll to completion — handy for tests and for AI/preview. */
export function simulateRoll(pins, throwParams) {
  const events = [];
  const sim = new LaneSim({ pins, throw: throwParams, onEvent: (e) => events.push(e) });
  for (let i = 0; i < 13 * 480 && !sim.done; i += 1) sim.step(FIXED_DT);
  return { sim, events, knocked: sim.knocked.length, standing: sim.standing };
}

// ── Match ──────────────────────────────────────────────────────────────────

export const MATCH_EVENTS = [
  'turn', 'throw', 'ballHit', 'pinDown', 'gutter', 'roll', 'strike', 'spare', 'rerack', 'over',
];

/**
 * Turn order, re-racks and results for 1 or 2 bowlers. Players alternate
 * frames; in the tenth frame a bowler takes all their rolls in a row.
 */
export class Match {
  constructor({ players = 2, onEvent = () => {} } = {}) {
    this.playerCount = clamp(Math.round(players), 1, MAX_PLAYERS);
    this.onEvent = onEvent;
    this.rolls = Array.from({ length: this.playerCount }, () => []);
    this.current = 0;
    this.state = 'aim';              // aim | rolling | over
    this.pins = rack();
    this.sim = null;
    this.lastRoll = null;
    this.onEvent({ type: 'turn', player: 0, ...this.position() });
  }

  position(player = this.current) {
    return nextRoll(this.rolls[player]);
  }

  /** Release a ball. Returns false when it is not this match's moment to throw. */
  throwBall(params) {
    if (this.state !== 'aim') return false;
    this.state = 'rolling';
    const t = normalizeThrow(params);
    this.sim = new LaneSim({
      pins: this.pins,
      throw: t,
      onEvent: (e) => this.onEvent({ ...e, player: this.current }),
    });
    this.onEvent({ type: 'throw', player: this.current, throw: t });
    return true;
  }

  update(dt) {
    if (this.state !== 'rolling') return;
    this.sim.update(dt);
    if (this.sim.done) this.finishRoll();
  }

  finishRoll() {
    const player = this.current;
    const before = this.position(player);
    const standingBefore = this.pins.length;
    const knocked = standingBefore - this.sim.standing.length;
    this.rolls[player].push(knocked);
    const after = this.position(player);
    const rolls = this.rolls[player];
    const strike = before.fresh && knocked === 10;
    const spare = !before.fresh && knocked === standingBefore && standingBefore > 0;
    const gutter = this.sim.ball.gutter !== 0 && knocked === 0;
    this.lastRoll = { player, pins: knocked, strike, spare: spare && !strike, gutter, frame: before.frame, roll: before.roll };
    this.onEvent({ type: 'roll', player, ...this.lastRoll, rolls: rolls.slice() });
    if (strike) this.onEvent({ type: 'strike', player });
    else if (spare) this.onEvent({ type: 'spare', player });

    this.pins = after.fresh || after.done ? rack() : this.sim.standing.map(({ id, x, z }) => ({ id, x, z }));
    if (after.fresh && !after.done && knocked > 0) this.onEvent({ type: 'rerack', player });
    this.sim = null;

    const frameAdvanced = after.done || after.frame !== before.frame;
    if (this.rolls.every((r) => nextRoll(r).done)) {
      this.state = 'over';
      this.onEvent({ type: 'over', totals: this.rolls.map(totalScore), winner: this.winner() });
      return;
    }
    if (frameAdvanced && this.playerCount > 1) {
      this.current = (this.current + 1) % this.playerCount;
      if (nextRoll(this.rolls[this.current]).done) this.current = (this.current + 1) % this.playerCount;
      this.pins = rack();
    }
    this.state = 'aim';
    this.onEvent({ type: 'turn', player: this.current, ...this.position() });
  }

  totals() {
    return this.rolls.map(totalScore);
  }

  winner() {
    if (this.playerCount < 2) return null;
    const [a, b] = this.totals();
    return a === b ? 'tie' : a > b ? 0 : 1;
  }
}
