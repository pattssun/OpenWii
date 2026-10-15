import {sourceJumpLaunch} from "./source-jump.js";
import { normalizeLaps } from './race-settings.js';
import { stepSourceGlide } from './glide.js';
import { contactResponse } from "./contact-response.js";
import { roadFrame } from "./visual-frame.js";
import { kartContact } from "./kart-contact.js";
import { kartWallLimits } from './kart-wall.js';
/** Mario Kart rules. No browser or renderer dependencies. Fixed-step, seeded. */
import {
  activeSurfaceTrack,
  TRACK_LENGTH as L,
  ROAD_HALF,
  WALL_HALF,
  trackAt,
  surfaceAt,
  project,
  wrap,
  clamp,
  angle,
  BOOST_PADS,
  ITEM_ROWS,
  COIN_SPOTS,
  SECTIONS,
} from "./track.js";
export { TRACK_LENGTH } from "./track.js";
export const CHARACTERS = [
  { id: "mario", name: "Mario", color: "#ed303b", skill: 0.96 },
  { id: "luigi", name: "Luigi", color: "#31bf5a", skill: 0.94 },
  { id: "peach", name: "Peach", color: "#ff8abe", skill: 0.93 },
  { id: "yoshi", name: "Yoshi", color: "#83dc38", skill: 0.99 },
  { id: "toad", name: "Toad", color: "#428cfa", skill: 0.92 },
  { id: "bowser", name: "Bowser", color: "#ffae26", skill: 1.01 },
  { id: "donkey-kong", name: "Donkey Kong", color: "#a86335", skill: 0.97 },
  { id: "koopa", name: "Koopa", color: "#f0d449", skill: 0.91 },
];
export const ITEMS = ["banana", "green", "red", "mushroom", "star", "blue"];
export const FIXED_DT = 1 / 120;
export const EVENT_TYPES = [
  "countdown",
  "go",
  "rocket",
  "burnout",
  "hop",
  "drift",
  "turbo",
  "boost",
  "coin",
  "box",
  "itemReady",
  "useItem",
  "hit",
  "wall",
  "antigrav",
  "glider",
  "land",
  "lap",
  "finalLap",
  "finish",
  "results",
  "bump",
  "contact",
];
export function seeded(seed = 381) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function topSpeed(coins = 0) {
  return 36 + clamp(coins, 0, 10) * 0.55;
}
export function turboTier(charge) {
  return charge >= 3.4 ? 3 : charge >= 2 ? 2 : charge >= 0.8 ? 1 : 0;
}
export function rollItem(position, rng = Math.random) {
  const rear = clamp((position - 1) / 7, 0, 1);
  const weights = [
    0.42 * (1 - rear) + 0.04,
    0.36 * (1 - rear) + 0.07,
    0.16,
    0.04 + 0.29 * rear,
    0.01 + 0.26 * rear,
    0.01 + 0.16 * rear,
  ];
  let n = clamp(rng(), 0, 0.999999) * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    n -= weights[i];
    if (n < 0) return ITEMS[i];
  }
  return "mushroom";
}
function makeRacer(character, i) {
  const grid = i === 0 ? 7 : i - 1,
    progress = -8 - Math.floor(grid / 2) * 6 - (grid % 2) * 0.5,
    p = surfaceAt(progress, grid % 2 ? 3 : -3);
  return {
    id: i,
    character,
    skill: character.skill,
    progress,
    s: wrap(progress, L),
    x: p.x,
    z: p.z,
    y: p.y,
    heading: p.heading,
    lateral: grid % 2 ? 3 : -3,
    speed: 0,
    sideVelocity: 0,
    contactCooldown: 0,
    contactAnimation: 0,
    steer: 0,
    coins: 0,
    lap: 1,
    nextCheckpoint: L / 8,
    checkpoints: 0,
    finishTime: null,
    drift: 0,
    charge: 0,
    tier: 0,
    hop: 0,
    boost: 0,
    star: 0,
    spin: 0,
    invulnerable: 0,
    gliding: false,
    flight: 0,
    flightY: 0,
    flightV: 0,
    anti: false,
    item: null,
    roulette: 0,
    gasDownAt: null,
    lastInput: {},
    itemDelay: 3 + i * 0.37,
    wallCooldown: 0,
    bumpCooldown: 0,
  };
}
export class Race {
  constructor({ seed = 381, character = "mario", characters, humanCount, laps = 3, onEvent = () => {} } = {}) {
    this.laps = normalizeLaps(laps);
    this.finishedAt = null;
    this.seed = seed;
    this.rng = seeded(seed);
    this.onEvent = onEvent;
    this.state = "ready";
    this.time = 0;
    this.raceTime = 0;
    this.accumulator = 0;
    const requested = Array.isArray(characters) ? characters : [character];
    this.humanCount = humanCount === 4 || requested.length === 4 ? 4 :
      humanCount === 2 || requested.length === 2 ? 2 : 1;
    const selected = [];
    for (const id of requested.slice(0, this.humanCount)) {
      const choice = CHARACTERS.find((c) => c.id === id);
      if (choice && !selected.includes(choice)) selected.push(choice);
    }
    for (const choice of CHARACTERS) {
      if (selected.length >= this.humanCount) break;
      if (!selected.includes(choice)) selected.push(choice);
    }
    const order = [...selected, ...CHARACTERS.filter((c) => !selected.includes(c))];
    this.racers = order.slice(0, 8).map(makeRacer);
    this.players = this.racers.slice(0, this.humanCount);
    this.player = this.racers[0];
    this.objects = [];
    this.nextId = 1;
    this.finishOrder = [];
    this.boxes = ITEM_ROWS.map((p, id) => ({ ...p, id, respawn: 0 }));
    this.coins = COIN_SPOTS.map((p, id) => ({ ...p, id, respawn: 0 }));
    this.count = 3;
    this.pendingItems = this.players.map(() => false);
  }
  emit(type, racer = this.player, extra = {}) {
    this.onEvent({ type, racer: racer.id, time: this.time, ...extra });
  }
  start() {
    if (this.state !== "ready") return;
    this.state = "countdown";
    this.time = 0;
    this.emit("countdown", this.player, { count: 3 });
  }
  get standings() {
    return [...this.racers].sort((a, b) =>
      a.finishTime !== null
        ? b.finishTime !== null
          ? a.finishTime - b.finishTime
          : -1
        : b.finishTime !== null
          ? 1
          : b.progress - a.progress,
    );
  }
  position(r) {
    return this.standings.indexOf(r) + 1;
  }
  update(dt, input = {}) {
    if (
      !Number.isFinite(dt) ||
      dt <= 0 ||
      this.state === "ready"
    )
      return;
    // A long background stall pauses instead of running a race without the driver.
    this.accumulator += Math.min(dt, 0.25);
    const inputs = this.humanCount === 1 ? [Array.isArray(input) ? input[0] || {} : input] :
      this.players.map((_, i) => Array.isArray(input) ? input[i] || {} : i === 0 ? input : {});
    for (let i = 0; i < this.humanCount; i++)
      if (inputs[i].item) this.pendingItems[i] = true;
    while (this.accumulator + 1e-10 >= FIXED_DT) {
      this.step(FIXED_DT, inputs.map((value, i) => ({ ...value, item: this.pendingItems[i] })));
      this.pendingItems.fill(false);
      this.accumulator -= FIXED_DT;
    }
  }
  step(dt, inputs) {
    this.time += dt;
    if (this.state === "countdown") {
      for (const [i, player] of this.players.entries()) {
        const input = inputs[i];
        if (input.gas && !player.lastInput.gas) player.gasDownAt = this.time;
        if (!input.gas) player.gasDownAt = null;
        player.lastInput = { ...input };
      }
      const n = Math.max(0, 3 - Math.floor(this.time));
      if (n !== this.count) {
        this.count = n;
        if (n) this.emit("countdown", this.player, { count: n });
      }
      if (this.time + 1e-9 < 3) return;
      this.state = "racing";
      this.count = 0;
      this.emit("go");
      for (const player of this.players) {
        const held = player.gasDownAt === null ? 0 : 3 - player.gasDownAt;
        if (held >= 0.7 && held <= 1.5) {
          player.boost = 1.8;
          player.speed = 24;
          this.emit("rocket", player);
        } else if (held > 1.8) {
          player.spin = 1.05;
          this.emit("burnout", player);
        }
      }
    }
    this.raceTime += dt;
    for (const p of [...this.boxes, ...this.coins])
      p.respawn = Math.max(0, p.respawn - dt);
    const oldProgress = new Map(this.racers.map((r) => [r.id, r.progress]));
    for (const r of this.racers) {
      const auto = r.id >= this.humanCount || r.finishTime !== null;
      this.move(r, auto ? this.cpuInput(r) : inputs[r.id], dt, auto);
    }
    this.collisions(dt, oldProgress);
    this.updateObjects(dt, oldProgress);
    // Resolve same-step finishes by interpolated line crossing time, not array order.
    this.finishOrder = this.racers
      .filter((r) => r.finishTime !== null)
      .sort((a, b) => a.finishTime - b.finishTime)
      .map((r) => r.id);
    for (const player of this.players)
      if (player.finishTime !== null && !player.finishAnnounced) {
        player.finishAnnounced = true;
        player.finishedAt = this.time;
        if (this.players.every((human) => human.finishTime !== null) && this.state === 'racing') {
          this.state = 'finishing';
          this.finishedAt = this.time;
        }
        this.emit("finish", player);
      }
    if (
      this.state === "finishing" &&
      this.finishOrder.length === 8
    ) {
      this.showResults();
    }
  }
  showResults() {
    if (this.state !== "finishing") return;
    this.state = "results";
    this.emit("results");
  }
  cpuInput(r) {
    // Pure pursuit: steering derived from a point ahead in world coordinates.
    const lead = clamp(9 + Math.abs(r.speed) * 0.32, 9, 23),
      lane = Math.sin(this.raceTime * 0.19 + r.id * 2.1) * 3.5;
    const p = surfaceAt(r.s + lead, lane),
      desired = Math.atan2(p.x - r.x, -(p.z - r.z));
    const error = activeSurfaceTrack ? activeSurfaceTrack.steeringError(r, p) : angle(desired - r.heading),
      steer = clamp(error * 2.8, -1, 1);
    r.itemDelay -= FIXED_DT;
    return {
      gas: true,
      steer,
      drift: Math.abs(steer) > 0.22 && r.speed > 22 && !r.gliding,
      item: !!r.item && r.itemDelay < 0,
    };
  }
  move(r, raw, dt, auto = false) {
    const input = {
      gas: !!raw.gas,
      brake: !!raw.brake,
      drift: !!raw.drift,
      item: !!raw.item,
      steer: Number.isFinite(raw.steer) ? clamp(raw.steer, -1, 1) : 0,
    };
    for (const k of [
      "landing",
      "jumpCooldown",
      "hop",
      "boost",
      "star",
      "spin",
      "invulnerable",
      "wallCooldown",
      "bumpCooldown",
      "contactCooldown",
      "contactAnimation",
    ])
      r[k] = Math.max(0, (r[k] || 0) - dt);
    r.sideVelocity=(r.sideVelocity||0)*Math.exp(-dt*2.5);
    if(r.itemUse) r.itemUse.age += dt;
    if (r.roulette > 0) {
      r.roulette -= dt;
      if (r.roulette <= 0) {
        r.item = rollItem(this.position(r), this.rng);
        this.emit("itemReady", r, { item: r.item });
      }
    }
    if (input.item && !r.lastInput.item) this.useItem(r);
    const spinning = r.spin > 0;
    const steer = spinning ? 0 : input.steer;
    r.steer += (steer - r.steer) * (1 - Math.exp(-dt * 20));
    if (
      input.drift &&
      !r.lastInput.drift &&
      r.speed > 8 &&
      !r.gliding &&
      !spinning
    ) {
      r.hop = 0.36;
      this.emit("hop", r);
    }
    if (
      input.drift &&
      !r.drift &&
      Math.abs(steer) > 0.14 &&
      r.speed > 12 &&
      !r.gliding &&
      !spinning
    ) {
      r.drift = Math.sign(steer);
      r.charge = 0;
    }
    if (r.drift && (!input.drift || r.speed < 8 || spinning || r.gliding)) {
      const tier = turboTier(r.charge);
      if (tier && !spinning) {
        r.boost = Math.max(r.boost, [0, 0.65, 1.35, 2.15][tier]);
        this.emit("turbo", r, { tier });
      }
      r.drift = 0;
      r.charge = 0;
      r.tier = 0;
    }
    if (r.drift) {
      r.charge += dt * (0.7 + 0.7 * Math.abs(steer));
      const tier = turboTier(r.charge);
      if (tier > r.tier) {
        r.tier = tier;
        this.emit("drift", r, { tier });
      }
    }
    const offroad = !r.gliding && !r.jump && (activeSurfaceTrack ? !activeSurfaceTrack.onRoad(r.s,r.lateral,r) : Math.abs(r.lateral)>ROAD_HALF+.2);
    let max = topSpeed(r.coins);
    if (auto) {
      const gap = Math.max(...this.players.map((player) => player.progress)) - r.progress;
      max *= r.skill * clamp(1 + gap / 1400, 0.93, 1.09);
    }
    if (r.boost > 0) max = 55;
    if (r.star > 0) max = 53;
    // A boost expiring over the lip must not cut airborne momentum.
    if (r.jump) max = Math.max(max, r.jump.speed);
    if (offroad && r.boost <= 0 && r.star <= 0) max *= 0.43;
    if (spinning) r.speed *= Math.exp(-5 * dt);
    else if (input.brake) {
      r.speed = Math.max(-10, r.speed - 28 * dt);
    } else if (input.gas) {
      r.speed += (r.boost > 0 || r.star > 0 ? 35 : 15) * dt;
      r.speed = Math.min(r.speed, max);
    } else {
      r.speed = Math.sign(r.speed) * Math.max(0, Math.abs(r.speed) - 5.5 * dt);
    }
    if (r.speed > max) r.speed = Math.max(max, r.speed - 36 * dt);
    // No sensor angular integration, yaw momentum or centrifugal term: zero wheel
    // means exactly straight in world space. Turn rate is bounded at every speed.
    const turn = (r.drift ? r.drift * 0.12 + r.steer * 0.92 : r.steer) * 1.48;
    const turnAngle = turn * clamp(r.speed / 20, -0.5, 1) * dt * (r.gliding ? 0.52 : 1);
    const previousS = r.s,
      previousProgress = r.progress;
    if(activeSurfaceTrack?.hasRoadMesh){const launch=sourceJumpLaunch(r,dt);if(launch){r.jump=launch;r.drift=0;r.charge=0;this.emit('rampJump',r);}}
    let near;
    if (activeSurfaceTrack && !r.gliding && !r.jump) {
      near = activeSurfaceTrack.advance(r, turnAngle, r.speed * dt, r.sideVelocity * dt);
      r.x = near.x; r.y = near.y; r.z = near.z;
      r.heading = near.heading;
      r.surfaceForward = near.surfaceForward;
      r.surfaceNormal = near.surfaceNormal;
      r.verticalSpeedRatio = near.verticalSpeedRatio;
    } else {
      r.heading = angle(r.heading + turnAngle);
      r.x += (Math.sin(r.heading) * r.speed + (!r.gliding&&!r.jump?Math.cos(r.heading)*r.sideVelocity:0)) * dt;
      r.z += (-Math.cos(r.heading) * r.speed + (!r.gliding&&!r.jump?Math.sin(r.heading)*r.sideVelocity:0)) * dt;
      near = project(r.x, r.z, r.s);
    }
    r.s = near.s;
    r.lateral = near.lateral;
    const walls=activeSurfaceTrack?.hasRoadMesh&&!r.gliding
      ?kartWallLimits(activeSurfaceTrack,r,this.time)
      :activeSurfaceTrack?activeSurfaceTrack.wallBounds(r.s,r.lateral):{min:-WALL_HALF,max:WALL_HALF};
    if (!r.jump && (r.lateral<walls.min||r.lateral>walls.max)) {
      const side=r.lateral<walls.min?-1:1,edge=clamp(r.lateral,walls.min,walls.max),p = activeSurfaceTrack&&!r.gliding?activeSurfaceTrack.constrainLateral(r,edge):surfaceAt(r.s,edge);
      r.x = p.x;
      r.z = p.z;
      if(activeSurfaceTrack&&!r.gliding){r.y=p.y;r.surfaceNormal=p.normal;}
      r.lateral = edge;
      // Wall glancing is a slide, never a forced 180-degree bounce.
      const path = trackAt(r.s), tangent = path.heading,
        error = activeSurfaceTrack && !r.gliding
          ? -activeSurfaceTrack.steeringError(r, {x:r.x+path.forward.x,y:r.y+path.forward.y,z:r.z+path.forward.z})
          : angle(r.heading - tangent);
      if (Math.sign(error) === side && Math.abs(error)>.01) {
        if(activeSurfaceTrack&&!r.gliding)Object.assign(r,activeSurfaceTrack.turn(r,-error*.4));
        else r.heading=angle(tangent+error*.6);
        r.speed *= 0.86;
      }
      if (r.wallCooldown <= 0) {
        this.emit("wall", r);
        r.wallCooldown = 0.5;
      }
    }
    let advance = wrap(r.s - previousS + L / 2, L) - L / 2;
    advance = clamp(
      advance,
      -Math.abs(r.speed) * dt * 2 - 1,
      Math.abs(r.speed) * dt * 2 + 1,
    );
    r.progress += advance;
    // Sequential eighth-lap gates prevent line oscillation, reversal or a crossing
    // between overlaid roads from awarding a lap. No teleport API in normal play.
    while (
      r.finishTime === null &&
      r.progress >= r.nextCheckpoint &&
      previousProgress < r.nextCheckpoint
    ) {
      r.checkpoints++;
      r.nextCheckpoint += L / 8;
      if (r.checkpoints % 8 === 0) {
        if (r.checkpoints === this.laps * 8 && r.finishTime === null) {
          const f = clamp(
            (this.laps * L - previousProgress) /
              Math.max(1e-9, r.progress - previousProgress),
            0,
            1,
          );
          r.finishTime = this.raceTime - dt + f * dt;
        } else if (r.checkpoints < this.laps * 8) {
          r.lap = r.checkpoints / 8 + 1;
          this.emit(r.lap === this.laps ? "finalLap" : "lap", r);
        }
      }
    }
    const p = trackAt(r.s),
      wasAnti = r.anti;
    r.anti = p.anti && !r.gliding;
    if (r.anti && !wasAnti) this.emit("antigrav", r);
    if (
      !r.gliding &&
      previousS < SECTIONS.glideStart &&
      r.s >= SECTIONS.glideStart &&
      advance > 0 &&
      r.speed > 0
    ) {
      r.speed = Math.max(r.speed, 26);
      r.boost = Math.max(r.boost, 0.5);
      r.gliding = true;
      r.surfaceForward = null;
      r.surfaceNormal = null;
      r.flight = 0;
      r.flightY = surfaceAt(SECTIONS.glideStart, r.lateral).y + 1;
      r.flightV = activeSurfaceTrack ? Math.min(6, (r.verticalSpeedRatio || 0) * r.speed + 6) : 6;
      r.anti = false;
      this.emit("glider", r);
    }
    if (r.gliding) {
      r.flight += dt;
      if (activeSurfaceTrack) {
        const flight = stepSourceGlide(r.flightY, r.flightV, r.speed, dt);
        r.flightY = flight.height;
        r.flightV = flight.velocity;
      } else {
        r.flightV -= 9 * dt;
        r.flightY += r.flightV * dt;
      }
      r.y = r.flightY;
      const beyond = r.s >= SECTIONS.glideEnd || r.s < SECTIONS.antiStart, ground=activeSurfaceTrack?surfaceAt(r.s,r.lateral):p;
      if ((beyond && r.flightY <= ground.y + 1) || r.flight > (activeSurfaceTrack ? 10 : 6)) {
        r.gliding = false;
        r.surfaceForward = null;
        r.y = ground.y;
        if(activeSurfaceTrack){const support=activeSurfaceTrack.support(r,ground.normal)||ground;r.x=support.x;r.y=support.y;r.z=support.z;r.surfaceNormal=support.normal;}
        r.boost = Math.max(r.boost, 0.3);
        this.emit("land", r);
      }
    } else if(!activeSurfaceTrack) r.y = surfaceAt(r.s, r.lateral).y;
    if(r.jump){
      const j=r.jump;j.age+=dt;j.velocity-=18*dt;r.y+=j.velocity*dt;
      const ground=activeSurfaceTrack.support(r,{x:0,y:1,z:0})||surfaceAt(r.s,r.lateral);
      if(j.velocity<0 && r.y<=ground.y){
        r.y=ground.y;r.surfaceNormal=ground.normal;r.surfaceForward=null;r.jump=null;r.jumpCooldown=.35;
        r.landing=.24;r.boost=Math.max(r.boost,.55);this.emit('land',r);
      }
    }
    if(activeSurfaceTrack&&!r.gliding&&!r.jump&&activeSurfaceTrack.onBoost(r.s,r.lateral,r)){
      if(r.boost<.2)this.emit('boost',r);
      r.boost=Math.max(r.boost,.65);
    }
    for (const pad of BOOST_PADS)
      if (
        Math.abs(wrap(r.s - pad.s + L / 2, L) - L / 2) < pad.length / 2 &&
        Math.abs(r.lateral - pad.lateral) < pad.width / 2 &&
        !r.gliding && !r.jump
      ) {
        if (r.boost < 0.2) this.emit("boost", r);
        r.boost = Math.max(r.boost, 0.65);
      }
    if (r.finishTime === null && !spinning) {
      for (const c of this.coins)
        if (!c.respawn && this.touches(r, c, 2.1)) {
          r.coins = Math.min(10, r.coins + 1);
          c.respawn = 5;
          this.emit("coin", r);
        }
      for (const b of this.boxes)
        if (
          !b.respawn &&
          !r.item &&
          r.roulette <= 0 &&
          this.touches(r, b, 2.5)
        ) {
          b.respawn = 1;
          r.roulette = 1.65;
          this.emit("box", r, {box: this.boxes.indexOf(b)});
        }
    }
    r.lastInput = input;
  }
  touches(r, p, radius) {
    return (
      Math.abs(wrap(r.s - p.s + L / 2, L) - L / 2) < radius &&
      Math.abs(r.lateral - p.lateral) < radius
    );
  }
  useItem(r = this.player) {
    if (!r.item || r.roulette > 0 || r.finishTime !== null || r.spin > 0)
      return false;
    const type = r.item;
    r.item = null;
    r.itemUse = {type,age:0};
    r.itemDelay = 2 + this.rng() * 3;
    this.emit("useItem", r, { item: type, projectile: ["green","red","blue"].includes(type) ? this.nextId : null });
    if (type === "mushroom") r.boost = Math.max(r.boost, 2.3);
    else if (type === "star") {
      r.star = 7;
      r.spin = 0;
    } else {
      const ordered = this.standings.filter(
        (k) => k.id !== r.id && k.finishTime === null,
      );
      const target =
        type === "blue"
          ? ordered[0]
          : ordered.filter((k) => k.progress > r.progress).at(-1);
      const direction = type === "banana" ? -1 : 1;
      this.objects.push({
        id: this.nextId++,
        type,
        owner: r.id,
        s: wrap(r.s + direction * 3.5, L),
        lateral: r.lateral,
        speed:
          type === "banana"
            ? 0
            : type === "blue"
              ? 77
              : type === "red"
                ? 62
                : 58,
        age: 0,
        life: type === "banana" ? 40 : 12,
        target: target?.id,
        lateralVelocity:
          type === "green"
            ? Math.sin(angle(r.heading - trackAt(r.s).heading)) * 30
            : 0,
      });
    }
    return true;
  }
  hit(r, cause = "shell", attacker = null) {
    if (r.star > 0 || r.invulnerable > 0 || r.finishTime !== null) return false;
    r.spin = cause === "blue" ? 1.65 : 1.1;
    r.invulnerable = 2.3;
    r.speed *= 0.35;
    r.coins = Math.max(0, r.coins - 3);
    r.drift = 0;
    r.charge = 0;
    r.tier = 0;
    r.boost = 0;
    this.emit("hit", r, { cause, attacker });
    return true;
  }
  collisions(dt) {
    const touched = new Set();
    // Several passes resolve a pack together: a later pair must not leave an
    // earlier pair interpenetrating. Steering angles and throttle stay intact.
    for (let pass = 0; pass < 6; pass++) {
      let contacts = 0;
      for (let i = 0; i < this.racers.length; i++)
        for (let j = i + 1; j < this.racers.length; j++) {
          const a = this.racers[i],
            b = this.racers[j];
          if (a.finishTime !== null || b.finishTime !== null) continue;
          const contact = kartContact(a, b, this.time);
          if (!contact) continue;
          contacts++;
          for (const [r, sign] of [
            [a, -1],
            [b, 1],
          ]) {
            r.x += sign * contact.x * 0.5;
            r.z += sign * contact.z * 0.5;
            if (activeSurfaceTrack && !r.gliding) r.y += sign * (contact.y || 0) * .5;
            const near = activeSurfaceTrack && !r.gliding ? activeSurfaceTrack.project(r, r.s) : project(r.x, r.z, r.s);
            const walls=activeSurfaceTrack?.hasRoadMesh&&!r.gliding
              ?kartWallLimits(activeSurfaceTrack,{...r,s:near.s,lateral:near.lateral},this.time)
              :activeSurfaceTrack?activeSurfaceTrack.wallBounds(near.s,near.lateral):{min:-WALL_HALF,max:WALL_HALF};
            const lateral = clamp(near.lateral,walls.min,walls.max);
            let p = surfaceAt(near.s, lateral);
            if(activeSurfaceTrack&&!r.gliding)p=activeSurfaceTrack.constrainLateral({...r,s:near.s,lateral:near.lateral},lateral);
            if (activeSurfaceTrack || lateral !== near.lateral) {
              r.x = p.x;
              r.z = p.z;
            }
            r.lateral = lateral;
            if (!r.gliding){r.y=p.y;if(activeSurfaceTrack)r.surfaceNormal=p.normal;}
            // Keep s/progress together: the next movement projection accounts
            // for this physical displacement when advancing checkpoint gates.
          }
          const pair = i * this.racers.length + j;
          if (touched.has(pair)) continue;
          touched.add(pair);
          if(!a.gliding&&!b.gliding){
            const frame=r=>roadFrame(r.s,r.lateral,r.heading,r.surfaceForward,r.surfaceNormal);
            const impact=contactResponse(a,b,frame(a),frame(b),contact);
            if(impact>1.5)for(const r of [a,b])if(r.contactCooldown<=0){
              r.contactAnimation=.42;r.contactCooldown=.3;
              this.emit("contact",r,{impact,other:r===a?b.id:a.id});
            }
          }
          if (a.star > 0) this.hit(b, "star", a.id);
          if (b.star > 0) this.hit(a, "star", b.id);
          if (a.anti && b.anti && a.bumpCooldown <= 0 && b.bumpCooldown <= 0) {
            a.boost = Math.max(a.boost, 0.65);
            b.boost = Math.max(b.boost, 0.65);
            a.bumpCooldown = b.bumpCooldown = 1;
            this.emit("bump", a);
            this.emit("bump", b);
          }
        }
      if (!contacts) break;
    }
  }
  updateObjects(dt, oldProgress) {
    for (const o of this.objects) {
      o.age += dt;
      o.life -= dt;
      const oldS = o.s;
      const target = this.racers.find(
        (r) => r.id === o.target && r.finishTime === null,
      );
      if(o.type==='blue' && o.attack!=null){
        if(!target){o.life=0;continue;}
        o.attack+=dt;o.s=target.s;o.lateral=target.lateral;
        if(o.attack>=.85){
          for(const k of this.racers)if(Math.abs(wrap(k.s-target.s+L/2,L)-L/2)<7)this.hit(k,'blue',o.owner);
          o.life=0;
        }
        continue;
      }
      if (target && ["red", "blue"].includes(o.type)) {
        o.lateral += (target.lateral - o.lateral) * (1 - Math.exp(-dt * 7));
      }
      o.s = wrap(o.s + o.speed * dt, L);
      o.lateral += o.lateralVelocity * dt;
      const walls=activeSurfaceTrack?activeSurfaceTrack.wallBounds(o.s,o.lateral):{min:-WALL_HALF,max:WALL_HALF};
      if (o.lateral<walls.min+1||o.lateral>walls.max-1) {
        o.lateral = clamp(o.lateral,walls.min+1,walls.max-1);
        o.lateralVelocity *= -1;
      }
      for (const r of this.racers) {
        if ((r.id === o.owner && o.age < 0.75) || r.finishTime !== null)
          continue;
        if (o.type === "blue" && r.id !== o.target) continue;
        // Swept relative segment, independently tested with coarse/high-speed hits.
        const a =
          wrap(oldS - wrap(oldProgress.get(r.id), L) + L / 2, L) - L / 2;
        const b = a + o.speed * dt - (r.progress - oldProgress.get(r.id));
        const along = Math.min(Math.abs(a), Math.abs(b)) < 2 || a * b <= 0;
        if (
          along &&
          Math.abs(o.lateral - r.lateral) < 2.3 &&
          ((!r.gliding && !r.jump) || o.type === "blue")
        ) {
          if (o.type === "blue") {o.attack=0;o.s=r.s;o.lateral=r.lateral;}
          else {this.hit(r,o.type,o.owner);o.life=0;}
          break;
        }
      }
    }
    this.objects = this.objects.filter((o) => o.life > 0);
  }
}
export function ordinal(n) {
  return `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
}
export function formatTime(s) {
  return Number.isFinite(s)
    ? `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`
    : "—";
}
