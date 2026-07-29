import * as THREE from '/vendor/three/three.module.js';
import { FruitNinja, FIELD_H } from './logic.js';
import { Pointer } from '../../core/pointer.js';
import { saveSensitivity, loadSensitivity } from '../../core/calibration.js';
import { AudioEngine } from '../../core/audio.js';
import { GameLink } from '../../core/net.js';
import { clamp } from '../../core/orientation.js';

/**
 * Fruit Ninja — Three.js renderer.
 *
 * Gameplay runs on the fixed play field in logic.js; this file only maps that
 * field into a 3D scene and draws it. The camera sits at the distance where the
 * field's height exactly fills the frame, which keeps world↔screen a plain
 * linear map and lets the proven 2D collision math carry over untouched.
 */

const $ = (id) => document.getElementById(id);

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const FOV = 45;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
const CAM_Z = (FIELD_H / 2) / Math.tan((FOV / 2) * (Math.PI / 180));
camera.position.set(0, 0, CAM_Z);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(4, 8, 9);
scene.add(key);
const rim = new THREE.DirectionalLight(0xff5f6d, 0.7);
rim.position.set(-6, -2, 4);
scene.add(rim);

const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 50),
  new THREE.MeshStandardMaterial({ color: 0x141b2a, roughness: 1 }),
);
backdrop.position.z = -14;
scene.add(backdrop);

const game = new FruitNinja({ aspect: 16 / 9, onEvent: handleEvent });

// ── Meshes ─────────────────────────────────────────────────────────────────
const sphereGeo = new THREE.SphereGeometry(1, 24, 18);
const halfGeo = new THREE.SphereGeometry(1, 24, 18, 0, Math.PI);
const particleGeo = new THREE.SphereGeometry(1, 6, 5);
const meshes = new Map();   // logic id → Object3D

const mat = (colour, roughness = 0.45) =>
  new THREE.MeshStandardMaterial({ color: colour, roughness, metalness: 0.05 });

function fruitMesh(f) {
  if (f.bomb) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(sphereGeo, mat(0x14171f, 0.3));
    body.scale.setScalar(f.r);
    g.add(body);
    const fuse = new THREE.Mesh(
      new THREE.TorusGeometry(f.r * 0.5, f.r * 0.09, 6, 12, Math.PI),
      mat(0xff5f6d, 0.7),
    );
    fuse.position.y = f.r * 0.85;
    fuse.rotation.z = Math.PI * 0.15;
    g.add(fuse);
    const spark = new THREE.PointLight(0xffd166, 4, 5);
    spark.position.set(f.r * 0.9, f.r * 1.25, 0);
    g.add(spark);
    return g;
  }
  const m = new THREE.Mesh(sphereGeo, mat(f.kind.rind));
  m.scale.setScalar(f.r);
  return m;
}

function halfMesh(h) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(halfGeo, mat(h.kind.rind)));
  const flesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshStandardMaterial({ color: h.kind.flesh, roughness: 0.8, side: THREE.DoubleSide }),
  );
  flesh.rotation.y = Math.PI / 2;
  g.add(flesh);
  g.scale.setScalar(h.r);
  return g;
}

/**
 * Point a half's cut face along the direction it flew, then tumble it about the
 * slice line so the exposed flesh swings into view.
 *
 * The hemisphere geometry's flat face normal is −X, so the alignment rotation
 * about Z is `cut + side·90°`. Tumbling about Z instead — the obvious first
 * guess — keeps the flat face permanently edge-on to the camera, and both
 * halves just read as whole fruit.
 */
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const qAlign = new THREE.Quaternion();
const qTumble = new THREE.Quaternion();
const cutAxis = new THREE.Vector3();

function applyHalfOrientation(mesh, h) {
  qAlign.setFromAxisAngle(Z_AXIS, h.cut + h.side * (Math.PI / 2));
  cutAxis.set(Math.cos(h.cut), Math.sin(h.cut), 0);
  qTumble.setFromAxisAngle(cutAxis, h.tumble);
  mesh.quaternion.copy(qTumble).multiply(qAlign);
}

function particleMesh(p) {
  return new THREE.Mesh(
    particleGeo,
    new THREE.MeshBasicMaterial({ color: p.color, transparent: true }),
  );
}

function syncMeshes(list, build, apply) {
  for (const item of list) {
    let m = meshes.get(item.id);
    if (!m) {
      m = build(item);
      meshes.set(item.id, m);
      scene.add(m);
    }
    apply(m, item);
  }
}

/** Drop meshes whose logic object is gone — otherwise the scene leaks. */
function pruneMeshes() {
  const alive = new Set();
  for (const f of game.fruits) alive.add(f.id);
  for (const h of game.halves) alive.add(h.id);
  for (const p of game.particles) alive.add(p.id);
  for (const [id, m] of meshes) {
    if (alive.has(id)) continue;
    scene.remove(m);
    if (m.material && m.material.dispose) m.material.dispose();
    meshes.delete(id);
  }
}

// ── Blade trail ────────────────────────────────────────────────────────────
/**
 * A tapered ribbon rather than a line: the blade arc is the signature visual,
 * and THREE.Line is locked to 1px on every platform regardless of linewidth.
 * Two passes — a wide additive glow under a bright core — reproduce the 2D
 * build's look in 3D.
 */
const RIBBON_MAX = 48;

function makeRibbon({ width, colour, opacity, blending }) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(RIBBON_MAX * 2 * 3);
  const colours = new Float32Array(RIBBON_MAX * 2 * 4);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 4));

  // Index buffer is static: two triangles per quad, for the maximum length.
  const idx = [];
  for (let i = 0; i < RIBBON_MAX - 1; i += 1) {
    idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  geo.setIndex(idx);

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    blending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  mesh.userData = { width, colour: new THREE.Color(colour) };
  scene.add(mesh);
  return mesh;
}

const ribbons = [
  makeRibbon({ width: 0.55, colour: 0xff5f6d, opacity: 0.5, blending: THREE.AdditiveBlending }),
  makeRibbon({ width: 0.17, colour: 0xffffff, opacity: 0.95, blending: THREE.NormalBlending }),
];

const tip = new THREE.Mesh(
  new THREE.SphereGeometry(0.13, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
scene.add(tip);
const tipGlow = new THREE.PointLight(0xff5f6d, 8, 7);
scene.add(tipGlow);

function drawTrail() {
  const pts = game.trail.points;
  const n = Math.min(pts.length, RIBBON_MAX);
  const start = pts.length - n;

  for (const ribbon of ribbons) {
    const pos = ribbon.geometry.attributes.position.array;
    const col = ribbon.geometry.attributes.color.array;
    const { width, colour } = ribbon.userData;

    for (let i = 0; i < n; i += 1) {
      const p = pts[start + i];
      const prev = pts[start + Math.max(0, i - 1)];
      const next = pts[start + Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;

      // Widest at the head, pinched to nothing at the tail.
      const taper = n > 1 ? i / (n - 1) : 1;
      const hw = (width * taper * taper) / 2;
      const o = i * 6;
      pos[o] = p.x - ty * hw; pos[o + 1] = p.y + tx * hw; pos[o + 2] = 0.4;
      pos[o + 3] = p.x + ty * hw; pos[o + 4] = p.y - tx * hw; pos[o + 5] = 0.4;

      const c = i * 8;
      for (const v of [0, 4]) {
        col[c + v] = colour.r; col[c + v + 1] = colour.g; col[c + v + 2] = colour.b;
        col[c + v + 3] = taper * taper;
      }
    }

    ribbon.geometry.attributes.position.needsUpdate = true;
    ribbon.geometry.attributes.color.needsUpdate = true;
    ribbon.geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
    ribbon.visible = n > 1;
  }

  tip.position.set(game.cursor.x, game.cursor.y, 0.4);
  tipGlow.position.copy(tip.position);
  tip.visible = game.cursor.active;
  tipGlow.visible = game.cursor.active;
}

// ── Audio ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();

// ── Pointer ────────────────────────────────────────────────────────────────
// Rate-based gyro aiming, no calibration flow: the pointer is live from the
// first packet, and the learned gyro gain lives inside the Pointer itself.
const pointer = new Pointer({});
pointer.sensitivity = loadSensitivity() ?? 1;
let lastSample = null;
let lastSampleAt = 0;

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  game.setAspect(camera.aspect);
  pointer.setViewport(w, h);
}
window.addEventListener('resize', resize);

/** Normalised pointer (0..1, y down) → world units on the z=0 plane. */
function toWorld(nx, ny) {
  const halfH = FIELD_H / 2;
  const halfW = halfH * camera.aspect;
  return { x: (nx - 0.5) * 2 * halfW, y: (0.5 - ny) * 2 * halfH };
}

const link = new GameLink({
  onOrientation: (sample) => {
    const now = performance.now();
    const dt = lastSampleAt ? clamp((now - lastSampleAt) / 1000, 1 / 240, 0.1) : 1 / 60;
    lastSampleAt = now;
    lastSample = sample;
    pointer.update(sample, dt, now);
  },
  onCommand: (cmd) => {
    if (cmd.type === 'calibrate') quickRecentre();
    else if (cmd.type === 'recentre') quickRecentre();
    else if (cmd.type === 'start') beginPlay();
    else if (cmd.type === 'button' && cmd.button === 'A') beginPlay();
    // B returns to the menu, so the whole loop is reachable from the phone.
    else if (cmd.type === 'button' && cmd.button === 'B') window.location.href = '/';
  },
  onPresence: ({ controller }) => {
    const on = controller > 0;
    $('dot').classList.toggle('on', on);
    $('link-t').textContent = on ? 'remote connected' : 'no remote connected';
    if (on && game.state.phase === 'idle') {
      $('cta').innerHTML = 'Remote linked. Press <strong>Space</strong> to play.';
    }
  },
});

// ── Events from the logic layer ────────────────────────────────────────────
function handleEvent(e) {
  if (e.type === 'slice') {
    audio.play('swipe', { intensity: e.combo });
    link.feedback({ type: 'slice', combo: e.combo });
  } else if (e.type === 'bomb') {
    audio.play('explode');
    link.feedback({ type: 'bomb' });
  } else if (e.type === 'miss') {
    audio.play('fail');
    link.feedback({ type: 'miss' });
  } else if (e.type === 'gameover') {
    const best = Math.max(Number(localStorage.getItem('fn.best') || 0), e.score);
    localStorage.setItem('fn.best', String(best));
    showOverlay(`<h1>💥 <em>Sliced Out</em></h1>
      <div id="final">You scored <b>${e.score}</b> — best <b>${best}</b></div>
      <p>Swing again when you're ready.</p>
      <div class="cta"><strong>Space</strong> to play again · <strong>R</strong> to recalibrate</div>`);
  }
  syncHud();
}

// ── Overlays / HUD ─────────────────────────────────────────────────────────
let toastUntil = 0;
function flash(text) {
  toastUntil = performance.now() + 2200;
  $('toast').textContent = text.toUpperCase();
  $('toast').classList.add('on');
}

const showOverlay = (html) => { $('panel').innerHTML = html; $('overlay').classList.remove('hide'); };
const hideOverlay = () => $('overlay').classList.add('hide');

function syncHud() {
  $('score-v').textContent = game.state.score;
  $('best').textContent = `Best ${Math.max(Number(localStorage.getItem('fn.best') || 0), game.state.score)}`;
  const dots = $('lives').children;
  for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('on', i < game.state.lives);
  const combo = $('combo');
  const show = game.state.combo > 1;
  combo.classList.toggle('on', show);
  if (show) combo.textContent = `${game.state.combo}× COMBO!`;
}

function quickRecentre() {
  pointer.recentre();
  flash('re-centred');
}

function startGame() {
  hideOverlay();
  game.start(performance.now());
  syncHud();
}

function beginPlay() {
  audio.unlock();
  startGame();
}

function goToMenu() {
  window.location.href = '/';
}

/** Mirror the logic state into the scene graph. Split out so the verification
 *  harness can time a frame's work directly, without depending on rAF cadence. */
function syncScene() {
  syncMeshes(game.fruits, fruitMesh, (m, f) => {
    m.position.set(f.x, f.y, 0);
    m.rotation.set(f.rot * f.spinAxis.x, f.rot * f.spinAxis.y, f.rot * f.spinAxis.z);
  });
  syncMeshes(game.halves, halfMesh, (m, h) => {
    m.position.set(h.x, h.y, 0);
    applyHalfOrientation(m, h);
  });
  syncMeshes(game.particles, particleMesh, (m, p) => {
    m.position.set(p.x, p.y, 0.2);
    m.scale.setScalar(p.r * Math.max(0.2, p.life));
    m.material.opacity = clamp(p.life, 0, 1);
  });
  pruneMeshes();
  drawTrail();
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let frames = 0;
let fpsMark = performance.now();
let fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;

  frames += 1;
  if (now - fpsMark >= 500) {
    fps = (frames * 1000) / (now - fpsMark);
    frames = 0;
    fpsMark = now;
  }

  if (!pointer.live && mouse.active) pointer.setFromMouse(mouse.x, mouse.y);
  if (pointer.live && now - pointer.lastSeen > 500) pointer.live = false;

  // Drive the blade every frame, not every packet. The trail is sampled here
  // too, so its speed window sees display-rate motion rather than packet-rate
  // steps — which is what the slice threshold is tuned against.
  if (pointer.live || mouse.active) {
    const aim = pointer.sampleAt(now);
    const p = toWorld(aim.x, aim.y);
    game.setCursor(p.x, p.y, now);
  }

  game.update(now, dt);
  syncScene();

  if (toastUntil && now > toastUntil) { toastUntil = 0; $('toast').classList.remove('on'); }

  renderer.render(scene, camera);
}

// ── Input ──────────────────────────────────────────────────────────────────
const mouse = { x: 0.5, y: 0.5, active: false };
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX / window.innerWidth;
  mouse.y = e.clientY / window.innerHeight;
  mouse.active = true;
});
window.addEventListener('pointerdown', () => audio.unlock());

window.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); if (game.state.phase !== 'playing') beginPlay(); break;
    case 'r':
    case 'c': quickRecentre(); break;
    case 'arrowright':
      pointer.sensitivity = clamp(pointer.sensitivity * 1.12, 0.2, 6);
      saveSensitivity(pointer.sensitivity);
      flash(`pointer speed ${(pointer.sensitivity * 100).toFixed(0)}%`);
      break;
    case 'arrowleft':
      pointer.sensitivity = clamp(pointer.sensitivity / 1.12, 0.2, 6);
      saveSensitivity(pointer.sensitivity);
      flash(`pointer speed ${(pointer.sensitivity * 100).toFixed(0)}%`);
      break;
    case 'd': $('debug').classList.toggle('on'); break;
    default: break;
  }
});

fetch('/api/pairing').then((r) => r.json()).then(({ url, qr }) => {
  $('pair-qr').src = qr;
  $('pair-url').textContent = url;
}).catch(() => { $('pair-url').textContent = 'open /controller on your phone'; });

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  $('debug').textContent = [
    `mode        ${pointer.mode}`,
    `gyro gain k ${pointer.k.toFixed(2)} ${pointer.kLearned ? '(learned)' : '(default)'}`,
    `rate        ${pointer.rateDps.yaw.toFixed(1)} / ${pointer.rateDps.pitch.toFixed(1)} deg/s`,
    `pointer     ${pointer.display.x.toFixed(3)}, ${pointer.display.y.toFixed(3)}`,
    `gesture     ${game.trail.speed().toFixed(2)} u/s`,
    `sensor rate ${link.rate.toFixed(0)} Hz`,
    `source      ${pointer.source}`,
    `fps         ${fps.toFixed(0)}`,
    `entities    ${game.fruits.length}f ${game.halves.length}h ${game.particles.length}p`,
    `meshes      ${meshes.size}`,
  ].join('\n');
}, 250);

resize();
syncHud();
// Straight into play — no calibration gate. Called here at the bottom of the
// module: startGame touches const helpers that are in the temporal dead zone
// until the whole module has evaluated.
startGame();
requestAnimationFrame(frame);

// Exposed for the verification harness.
window.__openwii = {
  game, pointer, audio, link, toWorld,
  scene, camera, renderer, meshes,
  syncScene, drawTrail, pruneMeshes,
  fps: () => fps,
};
