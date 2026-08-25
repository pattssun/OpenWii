import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { axesFromSample } from '../../core/orientation.js';
import {
  Patrol, captureTray, trayRead, SteerFilter, fmtMs, LANE_HALF, LIVES,
} from './logic.js';

/**
 * Alien Attack — renderer. Toy-box space: glossy plastic ships, candy
 * saucers, a ringed planet on the horizon, warp streaks and tumbling rocks.
 * The phone lies flat like a tray: roll it to fly, A fires. All rules live
 * in logic.js; this file only draws.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17204a);
scene.fog = new THREE.Fog(0x17204a, 170, 380);

const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 1200);

scene.add(new THREE.AmbientLight(0xb9c4ef, 0.75));
const key = new THREE.DirectionalLight(0xfff3dc, 1.6);
key.position.set(60, 140, 80);
scene.add(key);
const rim = new THREE.DirectionalLight(0x86b8ff, 0.6);
rim.position.set(-80, 40, -120);
scene.add(rim);

const mat = (c, rough = 0.3) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
const glow = (c, opacity = 1) => new THREE.MeshBasicMaterial({
  color: c, transparent: opacity < 1, opacity,
});
const additive = (c, opacity = 1) => new THREE.MeshBasicMaterial({
  color: c, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
});

// Logic z runs forward; the world runs it down −z.
const wz = (z) => -z;

// ── The sky: nebulas and a ringed planet, parented to the ship's z ─────────
// The whole group follows the ship so the horizon never arrives; slow local
// drift keeps it alive.
const sky = new THREE.Group();
scene.add(sky);

function nebulaSprite(hex, size) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, `${hex}cc`);
  grad.addColorStop(0.45, `${hex}55`);
  grad.addColorStop(1, `${hex}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false,
  }));
  s.scale.setScalar(size);
  return s;
}
for (const [hex, size, x, y, z] of [
  ['#ff8fd0', 220, -120, 60, -320],
  ['#59e6d6', 260, 150, 30, -360],
  ['#9d7bff', 180, 20, 100, -340],
  ['#ff8fd0', 150, 90, -40, -300],
]) {
  const n = nebulaSprite(hex, size);
  n.position.set(x, y, z);
  n.userData.drift = { x: (Math.random() - 0.5) * 0.4, y: (Math.random() - 0.5) * 0.2 };
  sky.add(n);
}

// The planet: candy-striped ball with a chunky tilted ring.
const planet = new THREE.Group();
{
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const bands = ['#ffd9a0', '#ffb066', '#ffcf8e', '#ff8f5e', '#ffd9a0', '#ffb984', '#ff9f6e'];
  for (let i = 0; i < bands.length; i += 1) {
    g.fillStyle = bands[i];
    g.fillRect(0, Math.floor((i / bands.length) * 64), 64, Math.ceil(64 / bands.length) + 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(34, 32, 24),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, fog: false }));
  planet.add(ball);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(52, 4.5, 10, 48),
    new THREE.MeshStandardMaterial({ color: 0xffe9c9, roughness: 0.6, fog: false }));
  ring.scale.z = 0.18;
  ring.rotation.x = Math.PI / 2.4;
  planet.add(ring);
  planet.position.set(95, 46, -330);
  planet.rotation.z = -0.15;
  sky.add(planet);
}

// ── Warp streaks: the speed read ───────────────────────────────────────────
const streaks = [];
{
  const geo = new THREE.BoxGeometry(0.07, 0.07, 1);
  const m = additive(0xcfe4ff, 0.7);
  for (let i = 0; i < 90; i += 1) {
    const mesh = new THREE.Mesh(geo, m);
    scene.add(mesh);
    streaks.push({ mesh, z: Math.random() * 220, x: 0, y: 0, fresh: true });
  }
}
function respawnStreak(s, aheadOf) {
  s.z = aheadOf + 60 + Math.random() * 180;
  s.x = (Math.random() - 0.5) * 70;
  s.y = -6 + Math.random() * 18;
}

// ── Drifting debris: rocks and a bit of wreckage ───────────────────────────
const debris = [];
{
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 10; i += 1) {
    const wreck = i > 7;
    const mesh = wreck
      ? new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 1.1), mat(0x9aa5c9, 0.5))
      : new THREE.Mesh(rockGeo, mat(i % 2 ? 0x8d86a8 : 0x6e6788, 0.9));
    mesh.scale.setScalar(0.8 + Math.random() * 1.6);
    scene.add(mesh);
    debris.push({
      mesh,
      z: Math.random() * 260,
      x: 0,
      y: 0,
      rot: new THREE.Vector3(Math.random(), Math.random(), Math.random())
        .multiplyScalar(0.6),
    });
  }
}
function respawnDebris(d, aheadOf) {
  d.z = aheadOf + 80 + Math.random() * 200;
  const side = Math.random() < 0.5 ? -1 : 1;
  d.x = side * (LANE_HALF + 4 + Math.random() * 22);
  d.y = -5 + Math.random() * 14;
}

// ── The ship: a glossy toy fighter ─────────────────────────────────────────
const ship = new THREE.Group();
{
  const white = mat(0xf4f7fb, 0.25);
  const red = mat(0xe64a4a, 0.3);
  const blue = mat(0x2f7fd6, 0.3);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.7, 6, 12), white);
  body.rotation.x = Math.PI / 2;
  ship.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), red);
  nose.position.set(0, 0.02, -1.55);
  ship.add(nose);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 2.2), blue);
  stripe.position.set(0, 0.5, -0.1);
  ship.add(stripe);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12),
    new THREE.MeshStandardMaterial({
      color: 0x7fdcff, roughness: 0.05, metalness: 0.2,
      emissive: 0x1a5f8a, emissiveIntensity: 0.5,
    }));
  canopy.scale.set(1, 0.75, 1.5);
  canopy.position.set(0, 0.42, -0.45);
  ship.add(canopy);

  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.15), white);
    wing.position.set(side * 1.15, -0.12, 0.45);
    wing.rotation.z = side * 0.1;
    wing.rotation.y = -side * 0.22;
    ship.add(wing);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.9), red);
    tip.position.set(side * 2.05, -0.06, 0.62);
    ship.add(tip);
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 6, 10), blue);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * 0.62, -0.18, 0.95);
    ship.add(pod);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.25, 12),
      glow(0xffb14d));
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(side * 0.62, -0.18, 1.42);
    ship.add(nozzle);
  }

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.8), red);
  fin.position.set(0, 0.55, 0.85);
  ship.add(fin);
}
scene.add(ship);

// Muzzle flash at the nose, shown for a blink after each shot.
const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), additive(0xbfffd9, 0.9));
muzzle.visible = false;
ship.add(muzzle);
muzzle.position.set(0, 0.02, -2.0);

// Engine exhaust pool.
const exhaust = [];
{
  const geo = new THREE.SphereGeometry(0.16, 8, 6);
  for (let i = 0; i < 44; i += 1) {
    const mesh = new THREE.Mesh(geo, additive(0x8fe0ff, 0.8));
    mesh.visible = false;
    scene.add(mesh);
    exhaust.push({ mesh, life: 0, vel: new THREE.Vector3() });
  }
}
let exhaustIdx = 0;
function puff(x, y, z, speed) {
  const p = exhaust[exhaustIdx];
  exhaustIdx = (exhaustIdx + 1) % exhaust.length;
  p.life = 0.28;
  p.mesh.visible = true;
  p.mesh.position.set(x, y, z);
  p.mesh.scale.setScalar(0.5 + Math.random() * 0.35);
  p.vel.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, speed * 0.12 + 1.5);
}

// ── Saucers: three candy variants ──────────────────────────────────────────
function makeSaucer(variant) {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  g.add(spin);
  g.userData.spin = spin;

  const palettes = [
    { hull: 0xff5d5d, dome: 0xb8ffd9, domeGlow: 0x2fae6b, ring: 0xffe9e9 },
    { hull: 0xa06ce8, dome: 0xffd166, domeGlow: 0xa87716, ring: 0xe9dcff },
    { hull: 0xffc23e, dome: 0x7fe8ff, domeGlow: 0x1a7fa8, ring: 0xfff3d4 },
  ];
  const p = palettes[variant % 3];

  const disc = new THREE.Mesh(new THREE.SphereGeometry(1.3, 22, 12), mat(p.hull, 0.25));
  disc.scale.y = 0.32;
  spin.add(disc);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 10), mat(0xf2f5f9, 0.3));
  belly.scale.y = 0.5;
  belly.position.y = -0.18;
  spin.add(belly);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.58, 16, 12),
    new THREE.MeshStandardMaterial({
      color: p.dome, roughness: 0.08, emissive: p.domeGlow, emissiveIntensity: 0.7,
    }));
  dome.scale.y = 0.8;
  dome.position.y = 0.32;
  g.add(dome);

  // Running lights around the rim — the part that visibly spins.
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), glow(p.ring));
    bulb.position.set(Math.cos(a) * 1.18, 0.02, Math.sin(a) * 1.18);
    spin.add(bulb);
  }

  if (variant % 3 === 1) {
    for (const side of [-1, 1]) {
      const podArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 6, 8), mat(p.hull, 0.3));
      podArm.rotation.z = Math.PI / 2;
      podArm.position.set(side * 1.5, -0.05, 0);
      g.add(podArm);
    }
  } else if (variant % 3 === 2) {
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * Math.PI * 2;
      const finM = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.6), mat(0xf2f5f9, 0.3));
      finM.position.set(Math.cos(a) * 1.1, -0.15, Math.sin(a) * 1.1);
      finM.rotation.y = -a;
      g.add(finM);
    }
  }
  return g;
}
const saucers = new Map();          // alien id → group

// ── Bolts ──────────────────────────────────────────────────────────────────
const boltGeo = new THREE.CapsuleGeometry(0.1, 1.6, 4, 8);
const haloGeo = new THREE.SphereGeometry(0.34, 8, 6);
const boltMeshes = [];              // recycled { core, halo }
function boltMesh(i, kind) {
  if (!boltMeshes[i]) {
    const core = new THREE.Mesh(boltGeo, glow(0xffffff));
    core.rotation.x = Math.PI / 2;
    const halo = new THREE.Mesh(haloGeo, additive(0xffffff, 0.45));
    halo.scale.set(1, 1, 2.6);
    core.add(halo);
    scene.add(core);
    boltMeshes[i] = core;
  }
  const m = boltMeshes[i];
  m.material.color.set(kind === 'p' ? 0x8affb0 : 0xff9066);
  m.children[0].material.color.set(kind === 'p' ? 0x4dff8a : 0xff5e3a);
  m.visible = true;
  return m;
}

// ── Explosions: flash + shockwave + chunks ─────────────────────────────────
const bursts = [];
const chunkGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
function explode(x, z, color = 0xffd166, big = true) {
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), additive(0xffffff, 0.95));
  flash.position.set(x, 0, wz(z));
  scene.add(flash);
  const ringM = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.05, 32), additive(color, 0.85));
  ringM.position.set(x, 0, wz(z));
  scene.add(ringM);
  const chunks = [];
  const n = big ? 10 : 5;
  for (let i = 0; i < n; i += 1) {
    const m = new THREE.Mesh(chunkGeo, glow(Math.random() < 0.5 ? color : 0xf2f5f9, 1));
    m.material.transparent = true;
    m.position.set(x, 0, wz(z));
    m.scale.setScalar(0.5 + Math.random());
    scene.add(m);
    chunks.push({
      m,
      vel: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 14),
      rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, 0),
    });
  }
  bursts.push({ flash, ring: ringM, chunks, age: 0 });
}

// ── Wiring ─────────────────────────────────────────────────────────────────
const game = new Patrol({ onEvent: handleEvent, seed: (performance.now() * 997) | 0 });
let started = false;

// Failsafe for the one thing only a real hand can prove: if steering ever
// feels backwards on a device, press I once and it sticks.
let invertSteer = localStorage.getItem('openwii.chargeInvert2') === '1';
let trayRef = null;                  // captured neutral; null = capture next sample
let steerFilter = new SteerFilter();
let captureNotBefore = 0;            // boot grace: time to lay the phone flat

const channel = createChannel({
  onA: () => {
    if (!started || game.state === 'done') { startRun(); return; }
    if (game.shoot(performance.now())) {
      channel.audio.play('aa-laser');
      muzzleUntil = performance.now() + 70;
    }
  },
  onCommand: (cmd) => {
    if (cmd.type === 'calibrate' || cmd.type === 'recentre') {
      trayRef = null;
      steerFilter = new SteerFilter();
    }
  },
  onSample: (sample, dt, now) => {
    const axes = axesFromSample(sample);
    if (!trayRef && now >= captureNotBefore) trayRef = captureTray(axes);
    if (!trayRef) return;
    const raw = trayRead(axes, trayRef).bank;
    const shaped = steerFilter.update(raw, dt);
    game.setSteer(invertSteer ? -shaped : shaped);
  },
});

// Dev console hook: step the sim by hand while the renderer draws it.
window.__debug = { game, channel: () => channel };

// ── Sound design ───────────────────────────────────────────────────────────
// Proper arcade SFX instead of recycled UI blips. Every cue can be replaced
// by dropping a file at audio/<name>.{mp3,wav,ogg}.
const { audio } = channel;

// Player laser: a bright pew — fast square-wave dive with a spark of noise.
audio.register('aa-laser', (a) => {
  const jitter = 1 + (Math.random() - 0.5) * 0.12;
  a.tone({ freq: 1500 * jitter, slideTo: 240, dur: 0.11, type: 'square', gain: 0.16 });
  a.tone({ freq: 2200 * jitter, slideTo: 500, dur: 0.06, type: 'sawtooth', gain: 0.06 });
  a.noise({ dur: 0.04, gain: 0.08, type: 'highpass', freq: 3800 });
});

// Alien shot: slower, darker, meaner — you learn to hear it coming.
audio.register('aa-alien-laser', (a) => {
  a.tone({ freq: 460, slideTo: 130, dur: 0.22, type: 'sawtooth', gain: 0.1 });
  a.tone({ freq: 230, slideTo: 80, dur: 0.22, type: 'square', gain: 0.07 });
});

// A saucer bursting: noise bloom swept down, a sub thump, then crackle.
audio.register('aa-explosion', (a) => {
  a.noise({ dur: 0.45, gain: 0.5, freq: 2600, sweepTo: 120 });
  a.tone({ freq: 110, slideTo: 38, dur: 0.4, type: 'sine', gain: 0.5, attack: 0.002 });
  a.noise({ dur: 0.16, gain: 0.2, type: 'bandpass', freq: 1800, q: 2, delay: 0.04 });
});

// Taking a hit: a heavier blast plus a two-note damage klaxon.
audio.register('aa-hit', (a) => {
  a.noise({ dur: 0.7, gain: 0.55, freq: 3000, sweepTo: 80 });
  a.tone({ freq: 90, slideTo: 30, dur: 0.6, type: 'sine', gain: 0.55, attack: 0.002 });
  a.tone({ freq: 660, slideTo: 520, dur: 0.14, type: 'triangle', gain: 0.16, delay: 0.12 });
  a.tone({ freq: 520, slideTo: 400, dur: 0.16, type: 'triangle', gain: 0.14, delay: 0.3 });
});

// Shot down: the ship powers down — long fall, then a final low thud.
audio.register('aa-down', (a) => {
  a.tone({ freq: 520, slideTo: 55, dur: 0.9, type: 'sawtooth', gain: 0.22 });
  a.noise({ dur: 0.9, gain: 0.18, freq: 1400, sweepTo: 60 });
  a.tone({ freq: 70, slideTo: 34, dur: 0.35, type: 'sine', gain: 0.5, delay: 0.75, attack: 0.002 });
});

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (e.key.toLowerCase() === 'i') {
    invertSteer = !invertSteer;
    localStorage.setItem('openwii.chargeInvert2', invertSteer ? '1' : '0');
    popup(invertSteer ? 'steering inverted' : 'steering normal');
  }
});
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

function startRun() {
  started = true;
  trayRef = null;                    // your pose right now becomes "straight"
  steerFilter = new SteerFilter();
  captureNotBefore = 0;
  for (const m of saucers.values()) scene.remove(m);
  saucers.clear();
  game.start(performance.now());
  for (const s of streaks) respawnStreak(s, game.z - 30);
  for (const d of debris) respawnDebris(d, game.z);
  $('overlay').classList.add('hide');
  syncHud();
}

let popupUntil = 0;
function popup(text) {
  $('popup').textContent = text;
  $('popup').classList.add('on');
  popupUntil = performance.now() + 700;
}

let vignetteUntil = 0;
let muzzleUntil = 0;
let shake = 0;
function syncHud() {
  $('score').textContent = game.score;
  $('meta').textContent = `${game.kills} kill${game.kills === 1 ? '' : 's'} · ${Math.floor(game.z)}m`;
  $('lives').textContent = '💚'.repeat(Math.max(0, game.lives)) + '🖤'.repeat(LIVES - Math.max(0, game.lives));
}

function handleEvent(e) {
  if (e.type === 'kill') {
    explode(e.alien.x, e.alien.z, [0xff5d5d, 0xa06ce8, 0xffc23e][e.alien.id % 3]);
    shake = Math.min(0.5, shake + 0.22);
    channel.feedback({ type: 'slice', combo: 1 });
    channel.audio.play('aa-explosion');
  } else if (e.type === 'hit') {
    explode(game.x, game.z + 1, 0xff8a6a, true);
    shake = 1;
    channel.feedback({ type: 'bomb' });
    channel.audio.play('aa-hit');
    popup(e.lives > 0 ? `${e.lives} ${e.lives === 1 ? 'life' : 'lives'} left` : '');
    vignetteUntil = performance.now() + 450;
    $('vignette').classList.add('on');
  } else if (e.type === 'alienFire') {
    channel.audio.play('aa-alien-laser');
  } else if (e.type === 'done') {
    $('panel').innerHTML = `<h1>💥 <em>Shot down!</em></h1>
      <div>
        <span class="stat"><b>${e.score}</b><span>score</span></span>
        <span class="stat"><b>${e.kills}</b><span>kills</span></span>
        <span class="stat"><b>${e.distanceM}m</b><span>flown</span></span>
        <span class="stat"><b>${fmtMs(e.timeMs)}</b><span>survived</span></span>
      </div>
      <div class="cta"><strong>A</strong> fly again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.audio.play('aa-down');
  }
}

const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * ((k - 1) ** 3) + c1 * ((k - 1) ** 2);
};

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;

  channel.poll(now);
  if (!channel.pointer.live) {
    const bank = (keys.ArrowRight ? 15 : 0) + (keys.ArrowLeft ? -15 : 0);
    if (bank || keys._touched) { game.setSteer(bank); keys._touched = true; }
  }
  game.update(now, dt);
  if (game.state === 'running') syncHud();
  if (popupUntil && now > popupUntil) { $('popup').classList.remove('on'); popupUntil = 0; }
  if (vignetteUntil && now > vignetteUntil) { $('vignette').classList.remove('on'); vignetteUntil = 0; }

  // The ship: position from logic, banking + a touch of yaw into the strafe.
  const blink = now < game.invulnUntil && Math.floor(now / 90) % 2 === 0;
  const lock = THREE.MathUtils.clamp(game.steer / 18, -1, 1);
  ship.visible = !blink;
  ship.position.set(game.x, 0, wz(game.z));
  ship.rotation.z = -lock * 0.55;
  ship.rotation.y = -lock * 0.14;
  ship.rotation.x = 0.02 * Math.sin(now / 900);
  muzzle.visible = now < muzzleUntil;

  // Exhaust: two puffs per frame while flying, kicked wider on hard banks.
  if (game.state === 'running' && !blink) {
    for (const side of [-1, 1]) {
      if (Math.random() < 0.85) {
        puff(game.x + side * 0.62 * Math.cos(ship.rotation.z),
          -0.18 - side * 0.62 * Math.sin(ship.rotation.z),
          wz(game.z) + 1.6, game.speed);
      }
    }
  }
  for (const p of exhaust) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.scale.multiplyScalar(1 - dt * 2.4);
    p.mesh.material.opacity = p.life * 2;
  }

  // Saucers: create/update/remove to mirror the logic; pop in on arrival.
  const liveIds = new Set();
  for (const a of game.aliens) {
    liveIds.add(a.id);
    let m = saucers.get(a.id);
    if (!m) { m = makeSaucer(a.id % 3); scene.add(m); saucers.set(a.id, m); }
    const pop = easeOutBack(Math.min(1, (now - a.bornMs) / 300));
    m.scale.setScalar(pop);
    m.position.set(a.x, Math.sin(now / 300 + a.phase) * 0.45, wz(a.z));
    m.rotation.z = Math.sin(now / 480 + a.phase) * 0.12;
    m.userData.spin.rotation.y = now / 320 + a.phase;
  }
  for (const [id, m] of saucers) {
    if (!liveIds.has(id)) { scene.remove(m); saucers.delete(id); }
  }

  // Bolts, both sides, from one recycled pool.
  let bi = 0;
  for (const b of game.bolts) {
    boltMesh(bi++, 'p').position.set(b.x, 0, wz(b.z));
  }
  for (const b of game.alienBolts) {
    boltMesh(bi++, 'a').position.set(b.x, 0, wz(b.z));
  }
  for (let i = bi; i < boltMeshes.length; i += 1) boltMeshes[i].visible = false;

  // Explosions: flash pops, ring expands, chunks tumble away.
  for (let i = bursts.length - 1; i >= 0; i -= 1) {
    const b = bursts[i];
    b.age += dt;
    const k = b.age / 0.6;
    if (k >= 1) {
      scene.remove(b.flash, b.ring);
      for (const ch of b.chunks) scene.remove(ch.m);
      bursts.splice(i, 1);
      continue;
    }
    b.flash.scale.setScalar(1 + k * 5);
    b.flash.material.opacity = Math.max(0, 0.95 - k * 2.4);
    b.ring.scale.setScalar(1 + k * 9);
    b.ring.material.opacity = 0.85 * (1 - k);
    b.ring.lookAt(camera.position);
    for (const ch of b.chunks) {
      ch.m.position.addScaledVector(ch.vel, dt);
      ch.m.rotation.x += ch.rot.x * dt;
      ch.m.rotation.y += ch.rot.y * dt;
      ch.m.material.opacity = 1 - k;
    }
  }

  // Warp streaks stretch with speed; recycle behind the ship.
  const streakLen = 2 + game.speed * 0.14;
  for (const s of streaks) {
    if (s.z < game.z - 12 || s.fresh) { respawnStreak(s, game.z); s.fresh = false; }
    s.mesh.position.set(s.x, s.y, wz(s.z));
    s.mesh.scale.z = streakLen;
  }

  // Debris tumbles past at the flanks.
  for (const d of debris) {
    if (d.z < game.z - 15) respawnDebris(d, game.z);
    d.mesh.position.set(d.x, d.y, wz(d.z));
    d.mesh.rotation.x += d.rot.x * dt;
    d.mesh.rotation.y += d.rot.y * dt;
    d.mesh.rotation.z += d.rot.z * dt;
  }

  // The sky rides along; nebulas drift on their own clocks.
  sky.position.z = wz(game.z);
  for (const n of sky.children) {
    if (n.userData.drift) {
      n.position.x += n.userData.drift.x * dt;
      n.position.y += n.userData.drift.y * dt;
    }
  }
  planet.rotation.y += dt * 0.03;

  // Chase camera with decaying shake.
  shake = Math.max(0, shake - dt * 2.2);
  const jx = shake * (Math.random() - 0.5) * 0.9;
  const jy = shake * (Math.random() - 0.5) * 0.9;
  camera.position.set(game.x * 0.7 + jx, 3.4 + jy, wz(game.z) + 11);
  camera.lookAt(game.x + jx * 0.5, 0.4 + jy * 0.5, wz(game.z) - 12);

  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio())
      || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    dbg.textContent = `state ${game.state}\nz ${game.z.toFixed(1)} x ${game.x.toFixed(2)}\n`
      + `speed ${game.speed.toFixed(1)} steer ${game.steer.toFixed(1)}°\n`
      + `aliens ${game.aliens.length} bolts ${game.bolts.length}/${game.alienBolts.length}\n`
      + `lives ${game.lives} invert ${invertSteer}`;
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Launching from the menu goes straight into flight — no instruction screen.
// The neutral capture waits out the boot grace (the hand is still coming
// down from pointing at the tile), and the first wave holds off a moment.
startRun();
captureNotBefore = performance.now() + 1800;
game.nextSpawnMs = performance.now() + 2400;
