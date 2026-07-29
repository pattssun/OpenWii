/**
 * Island Flyover — flight and island logic. No renderer, no DOM.
 *
 * Free-roam flight over a procedural island, collecting i-points. Gentle by
 * design, like the mode it honours: no crashing — terrain and world edges
 * push you back instead of killing you.
 *
 * The terrain is a deterministic height function, so tests, the renderer and
 * the i-point placer all see exactly the same island.
 */

export const WORLD_RADIUS = 520;
export const SEA_LEVEL = 0;
export const CRUISE = 30;            // m/s
export const POINT_RADIUS = 9;       // collect distance
export const POINT_COUNT = 20;

/** Deterministic island: ridged noise from sines, radial falloff into sea. */
export function islandHeight(x, z) {
  const r = Math.hypot(x, z);
  const falloff = Math.max(0, 1 - (r / 420) ** 2);
  if (falloff <= 0) return -8;
  let h = Math.sin(x * 0.011) * 14 + Math.cos(z * 0.013) * 12
    + Math.sin((x + z) * 0.021) * 7
    + Math.sin(x * 0.05) * Math.cos(z * 0.043) * 3.5;
  // A proper central peak so the island has a landmark.
  h += Math.max(0, 42 - r * 0.16);
  return (h + 6) * falloff - 6;
}

/** Deterministic i-point ring positions: a tour around and over the island. */
export function makePoints() {
  const pts = [];
  for (let i = 0; i < POINT_COUNT; i += 1) {
    const t = i / POINT_COUNT;
    const a = t * Math.PI * 2 * 1.5;               // 1.5 laps spiralling in
    const r = 340 - t * 260;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const ground = Math.max(SEA_LEVEL, islandHeight(x, z));
    pts.push({ id: i, x, z, y: ground + 18 + (i % 3) * 9, taken: false });
  }
  return pts;
}

export class Flight {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.state = 'ready';            // ready | flying | done
    this.pos = { x: 0, y: 60, z: 430 };
    this.heading = 0;                // heading 0 faces -z: we spawn south of the island, facing it
    this.pitch = 0;                  // rad, + up
    this.bankVis = 0;                // smoothed bank for the renderer
    this.speed = CRUISE;
    this.points = makePoints();
    this.collected = 0;
    this.startedAt = 0;
    this.elapsedMs = 0;
    this.input = { bank: 0, pitch: 0 };   // degrees from gripTilt
  }

  start(now) {
    this.state = 'flying';
    this.pos = { x: 0, y: 60, z: 430 };
    this.heading = 0;
    this.pitch = 0;
    this.points = makePoints();
    this.collected = 0;
    this.startedAt = now;
    this.elapsedMs = 0;
    this.onEvent({ type: 'start' });
  }

  setTilt(bankDeg, pitchDeg) {
    this.input.bank = Math.max(-60, Math.min(60, bankDeg));
    this.input.pitch = Math.max(-45, Math.min(45, pitchDeg));
  }

  update(now, dt) {
    if (this.state !== 'flying') return;
    this.elapsedMs = now - this.startedAt;

    // Bank turns, pitch climbs — the flight model is deliberately forgiving.
    const bankRad = this.input.bank * Math.PI / 180;
    this.heading += bankRad * 1.15 * dt;
    this.bankVis += (bankRad - this.bankVis) * Math.min(1, dt * 5);

    const targetPitch = this.input.pitch * Math.PI / 180 * 0.8;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 3);

    // Diving trades a little speed, climbing costs a little.
    this.speed += (-this.pitch * 6) * dt;
    this.speed = Math.max(CRUISE * 0.7, Math.min(CRUISE * 1.5, this.speed + (CRUISE - this.speed) * 0.3 * dt));

    const horiz = this.speed * Math.cos(this.pitch);
    this.pos.x += Math.sin(this.heading) * horiz * dt;
    this.pos.z -= Math.cos(this.heading) * horiz * dt;
    this.pos.y += this.speed * Math.sin(this.pitch) * dt;

    // Gentle floors and ceilings — never a crash.
    const floor = Math.max(SEA_LEVEL + 5, islandHeight(this.pos.x, this.pos.z) + 6);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.pitch < 0) this.pitch = 0.04;
    }
    if (this.pos.y > 220) this.pos.y = 220;

    // Soft world edge: beyond the rim, steer back toward the island.
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD_RADIUS) {
      const toCentre = Math.atan2(-this.pos.x, this.pos.z);
      const diff = wrapAngle(toCentre - this.heading);
      this.heading += Math.sign(diff) * Math.min(Math.abs(diff), 1.4 * dt);
      this.onEvent({ type: 'edge' });
    }

    // Collect rings.
    for (const p of this.points) {
      if (p.taken) continue;
      const d = Math.hypot(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z);
      if (d < POINT_RADIUS) {
        p.taken = true;
        this.collected += 1;
        this.onEvent({ type: 'collect', id: p.id, collected: this.collected, total: POINT_COUNT });
        if (this.collected === POINT_COUNT) {
          this.state = 'done';
          this.onEvent({ type: 'done', ms: this.elapsedMs });
        }
      }
    }
  }
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
