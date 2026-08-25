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
 * Alien Attack — renderer. The phone lies flat like a tray: roll it to fly,
 * A fires. The pose held at launch is captured as neutral. All rules live
 * in logic.js; this file only draws.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060915);
scene.fog = new THREE.Fog(0x060915, 140, 320);

const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 900);

scene.add(new THREE.AmbientLight(0x8899cc, 0.55));
const key = new THREE.DirectionalLight(0xcfe0ff, 1.2);
key.position.set(60, 140, 80);
scene.add(key);

const mat = (c, r = 0.6) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
const glow = (c) => new THREE.MeshBasicMaterial({ color: c });

// Logic z runs forward; the world runs it down −z.
const wz = (z) => -z;

// ── Starfield: two drifting layers of points ───────────────────────────────
const starLayers = [];
for (const [count, spread, size, depth] of [[420, 260, 1.1, 500], [220, 160, 1.8, 320]]) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pos[i * 3] = (Math.random() - 0.5) * spread;
    pos[i * 3 + 1] = (Math.random() - 0.5) * spread * 0.6;
    pos[i * 3 + 2] = -Math.random() * depth;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xcfe0ff, size, sizeAttenuation: false, transparent: true, opacity: 0.85,
  }));
  scene.add(pts);
  starLayers.push({ pts, depth });
}

// A faint lane so the strafe width reads.
for (const side of [-1, 1]) {
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.14, 4000),
    new THREE.MeshBasicMaterial({ color: 0x24406e, transparent: true, opacity: 0.55 }),
  );
  rail.position.set(side * (LANE_HALF + 1.8), -1.6, 0);
  scene.add(rail);
}

// ── The ship ───────────────────────────────────────────────────────────────
const ship = new THREE.Group();
{
  const hull = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.6, 6), mat(0xdfe7f5, 0.35));
  hull.rotation.x = -Math.PI / 2;
  ship.add(hull);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 1.0), mat(0x9fb6e2, 0.4));
    wing.position.set(side * 1.05, -0.1, 0.55);
    wing.rotation.z = side * 0.14;
    ship.add(wing);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.7), mat(0xe2536a, 0.4));
    tip.position.set(side * 2.0, -0.06, 0.6);
    ship.add(tip);
  }
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), mat(0x69d2ff, 0.15));
  cockpit.scale.set(1, 0.7, 1.4);
  cockpit.position.set(0, 0.28, 0.1);
  ship.add(cockpit);
  const engine = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.9, 10), glow(0x7fd0ff));
  engine.rotation.x = Math.PI / 2;
  engine.position.set(0, 0, 1.6);
  ship.add(engine);
  ship.userData.engine = engine;
}
scene.add(ship);

// ── Pools for saucers and bolts ────────────────────────────────────────────
function makeSaucer() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.SphereGeometry(1.25, 18, 10), mat(0x8b93a6, 0.5));
  disc.scale.y = 0.34;
  g.add(disc);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), new THREE.MeshStandardMaterial({
    color: 0x7fe0a1, roughness: 0.2, emissive: 0x1d6b3a, emissiveIntensity: 0.8,
  }));
  dome.scale.y = 0.75;
  dome.position.y = 0.3;
  g.add(dome);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 8, 24), glow(0x9ef2b8));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return g;
}
const saucers = new Map();          // alien id → mesh

const boltGeo = new THREE.CapsuleGeometry(0.09, 1.5, 4, 8);
const playerBoltMat = glow(0x8affb0);
const alienBoltMat = glow(0xff7a6a);
const boltMeshes = [];              // { mesh, kind } recycled per frame
function boltMesh(i, kind) {
  if (!boltMeshes[i]) {
    const mesh = new THREE.Mesh(boltGeo, playerBoltMat);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    boltMeshes[i] = mesh;
  }
  const m = boltMeshes[i];
  m.material = kind === 'p' ? playerBoltMat : alienBoltMat;
  m.visible = true;
  return m;
}

// Explosions: expanding fading shells.
const bursts = [];
function explode(x, z, color = 0x9ef2b8) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  m.position.set(x, 0, wz(z));
  scene.add(m);
  bursts.push({ m, age: 0 });
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
    if (game.shoot(performance.now())) channel.audio.play('hover');
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
function syncHud() {
  $('score').textContent = game.score;
  $('meta').textContent = `${game.kills} kill${game.kills === 1 ? '' : 's'} · ${Math.floor(game.z)}m`;
  $('lives').textContent = '💚'.repeat(Math.max(0, game.lives)) + '🖤'.repeat(LIVES - Math.max(0, game.lives));
}

function handleEvent(e) {
  if (e.type === 'kill') {
    explode(e.alien.x, e.alien.z);
    channel.feedback({ type: 'slice', combo: 1 });
    channel.audio.play('impact');
  } else if (e.type === 'hit') {
    explode(game.x, game.z + 1, 0xff8a6a);
    channel.feedback({ type: 'bomb' });
    channel.audio.play('back');
    popup(e.lives > 0 ? `${e.lives} ${e.lives === 1 ? 'life' : 'lives'} left` : '');
    vignetteUntil = performance.now() + 450;
    $('vignette').classList.add('on');
  } else if (e.type === 'alienFire') {
    channel.audio.play('select');
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
    channel.audio.play('select');
  }
}

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

  // The ship: position from logic, bank into the strafe, engine shimmer.
  const blink = now < game.invulnUntil && Math.floor(now / 90) % 2 === 0;
  ship.visible = !blink;
  ship.position.set(game.x, 0, wz(game.z));
  ship.rotation.z = -THREE.MathUtils.clamp(game.steer / 18, -1, 1) * 0.5;
  ship.userData.engine.scale.y = 0.8 + Math.random() * 0.5;

  // Saucers: create/update/remove to mirror the logic.
  const liveIds = new Set();
  for (const a of game.aliens) {
    liveIds.add(a.id);
    let m = saucers.get(a.id);
    if (!m) { m = makeSaucer(); scene.add(m); saucers.set(a.id, m); }
    m.position.set(a.x, Math.sin(now / 300 + a.phase) * 0.4, wz(a.z));
    m.rotation.y = now / 500 + a.phase;
  }
  for (const [id, m] of saucers) {
    if (!liveIds.has(id)) { scene.remove(m); saucers.delete(id); }
  }

  // Bolts, both sides, from one recycled pool.
  let bi = 0;
  for (const b of game.bolts) {
    const m = boltMesh(bi++, 'p');
    m.position.set(b.x, 0, wz(b.z));
  }
  for (const b of game.alienBolts) {
    const m = boltMesh(bi++, 'a');
    m.position.set(b.x, 0, wz(b.z));
  }
  for (let i = bi; i < boltMeshes.length; i += 1) boltMeshes[i].visible = false;

  for (let i = bursts.length - 1; i >= 0; i -= 1) {
    const b = bursts[i];
    b.age += dt;
    const k = b.age / 0.45;
    if (k >= 1) { scene.remove(b.m); bursts.splice(i, 1); continue; }
    b.m.scale.setScalar(0.6 + k * 3.2);
    b.m.material.opacity = 0.9 * (1 - k);
  }

  // Starfield scrolls with the ship so space feels like it's rushing past.
  for (const layer of starLayers) {
    layer.pts.position.z = wz(game.z % layer.depth);
  }

  // Chase camera.
  camera.position.set(game.x * 0.7, 3.4, wz(game.z) + 11);
  camera.lookAt(game.x, 0.4, wz(game.z) - 12);

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
