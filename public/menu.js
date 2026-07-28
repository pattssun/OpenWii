import * as THREE from '/vendor/three/three.module.js';
import { Pointer } from '/core/pointer.js';
import { Calibration, loadCalibration, fetchBootId, saveSensitivity, loadSensitivity } from '/core/calibration.js';
import { AudioEngine } from '/core/audio.js';
import { GameLink } from '/core/net.js';
import { clamp } from '/core/orientation.js';

/**
 * The Wii Menu.
 *
 * Rendered in Three.js so the channel tiles can carry real depth — the idle
 * wobble and the zoom-to-fill transition are perspective effects, and faking
 * them in CSS never quite lands. Tile faces are canvas textures: crisp text at
 * any size, and no font loading to wait on.
 *
 * Judged on fidelity rather than feel, per the roadmap.
 */

const $ = (id) => document.getElementById(id);

// ── Layout constants ───────────────────────────────────────────────────────
const COLS = 4;
const ROWS = 3;
const PER_PAGE = COLS * ROWS;
const TILE_W = 3.4;
const TILE_H = 2.5;
const GAP_X = 0.34;
const GAP_Y = 0.30;
const BAR_H = 1.5;            // bottom bar height in world units
const VIEW_H = 12.4;          // world units the camera frames vertically

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const FOV = 35;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
const CAM_Z = (VIEW_H / 2) / Math.tan((FOV / 2) * (Math.PI / 180));
camera.position.set(0, 0, CAM_Z);

scene.add(new THREE.AmbientLight(0xffffff, 0.82));
const key = new THREE.DirectionalLight(0xffffff, 0.75);
key.position.set(-2, 5, 8);
scene.add(key);

/** The Wii Menu's soft silver-white vertical wash. */
function backdropTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#f4f7fa');
  grad.addColorStop(0.55, '#e4eaf1');
  grad.addColorStop(1, '#ccd6e2');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  return new THREE.CanvasTexture(c);
}
scene.background = backdropTexture();

// ── Canvas-texture helpers ─────────────────────────────────────────────────
const TEX_SCALE = 128;   // texels per world unit

function makeTexture(worldW, worldH, draw) {
  const c = document.createElement('canvas');
  c.width = Math.round(worldW * TEX_SCALE);
  c.height = Math.round(worldH * TEX_SCALE);
  const g = c.getContext('2d');
  draw(g, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return { texture: tex, canvas: c, ctx: g };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ── Channel tiles ──────────────────────────────────────────────────────────
const tileGeo = new THREE.PlaneGeometry(TILE_W, TILE_H);
const tiles = [];
let games = [];
let page = 0;

function drawTileFace(g, w, h, game) {
  const pad = 10;
  g.clearRect(0, 0, w, h);

  if (!game) {
    // Empty slot: the Wii shows these as recessed grey squares, and with one
    // channel installed they're most of the grid — so they have to look right.
    roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
    const empty = g.createLinearGradient(0, 0, 0, h);
    empty.addColorStop(0, '#cdd7e3');
    empty.addColorStop(1, '#dae2ec');
    g.fillStyle = empty;
    g.fill();
    g.strokeStyle = '#bcc8d7';
    g.lineWidth = 3;
    g.stroke();
    // A faint top highlight sells the recessed look.
    g.beginPath();
    g.moveTo(pad + 26, pad + 4);
    g.lineTo(w - pad - 26, pad + 4);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 4;
    g.stroke();
    return;
  }

  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
  g.fillStyle = '#ffffff';
  g.fill();
  g.strokeStyle = '#b9c5d4';
  g.lineWidth = 3;
  g.stroke();

  // Channel art: the emoji, big and centred, on a soft tint.
  g.save();
  roundRect(g, pad + 8, pad + 8, w - (pad + 8) * 2, h - (pad + 8) * 2 - 46, 20);
  g.clip();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#eaf2fb');
  grad.addColorStop(1, '#d8e6f6');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.font = `${Math.round(h * 0.34)}px -apple-system, "Apple Color Emoji", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(game.emoji || '🎮', w / 2, h * 0.42);
  g.restore();

  g.fillStyle = '#33404f';
  g.font = `600 ${Math.round(h * 0.11)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(game.title, w / 2, h - pad - 20);
}

/**
 * Layout, recomputed on resize.
 *
 * The grid has fixed proportions but the window does not, so everything is
 * scaled to fit the narrower of the two axes. Without this the outer columns
 * simply fall off the screen on a portrait or split-screen window.
 */
const L = { scale: 1, x0: 0, y0: 0, stepX: 0, stepY: 0, arrowX: 0, arrowY: 0 };

function computeLayout() {
  const gridW = COLS * TILE_W + (COLS - 1) * GAP_X;
  const gridH = ROWS * TILE_H + (ROWS - 1) * GAP_Y;
  const halfH = VIEW_H / 2;
  const halfW = halfH * camera.aspect;

  const top = halfH;
  const barTop = -halfH + BAR_H + 0.36;
  const availH = top - barTop;
  const availW = halfW * 2;

  // Leave room for a page arrow on each side plus a margin.
  const needW = gridW + 2 * 1.7 + 0.6;
  L.scale = Math.min(1, availW / needW, availH / (gridH + 0.9));

  L.stepX = (TILE_W + GAP_X) * L.scale;
  L.stepY = (TILE_H + GAP_Y) * L.scale;
  L.x0 = -(gridW * L.scale) / 2 + (TILE_W * L.scale) / 2;
  // Centre in the space above the bar, not the whole viewport — otherwise the
  // bar's height reads as a lopsided bottom margin.
  L.y0 = (top + barTop) / 2 + (gridH * L.scale) / 2 - (TILE_H * L.scale) / 2;
  L.arrowX = (gridW * L.scale) / 2 + 0.85 * L.scale;
  L.arrowY = (top + barTop) / 2;
}

function applyLayout() {
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    t.home.set(L.x0 + col * L.stepX, L.y0 - row * L.stepY, 0);
    t.mesh.position.copy(t.home);
    t.mesh.scale.setScalar(L.scale);
  }
  arrows[0].mesh.position.set(-L.arrowX, L.arrowY, 0);
  arrows[1].mesh.position.set(L.arrowX, L.arrowY, 0);
  arrows[0].mesh.scale.setScalar(L.scale);
  arrows[1].mesh.scale.setScalar(L.scale);
}

function buildTiles() {
  for (const t of tiles) scene.remove(t.mesh);
  tiles.length = 0;

  for (let i = 0; i < PER_PAGE; i += 1) {
    const game = games[page * PER_PAGE + i] || null;
    const { texture } = makeTexture(TILE_W, TILE_H, (g, w, h) => drawTileFace(g, w, h, game));
    const mesh = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({
      map: texture, transparent: true,
    }));
    scene.add(mesh);
    tiles.push({
      mesh,
      game,
      home: new THREE.Vector3(),
      // Per-tile phase so the grid breathes out of sync rather than pulsing
      // as one block, which reads as a glitch rather than as life.
      phase: (i * 2.399) % (Math.PI * 2),
      hover: 0,
    });
  }
  applyLayout();
}

// ── Bottom bar ─────────────────────────────────────────────────────────────
const barW = 26;
const bar = makeTexture(barW, BAR_H, () => {});
const barMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(barW, BAR_H),
  new THREE.MeshBasicMaterial({ map: bar.texture, transparent: true }),
);
scene.add(barMesh);

let wiiButtonPulse = 0;
let wiiButtonHover = 0;

function drawBar() {
  const { ctx: g, canvas: c } = bar;
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);

  roundRect(g, 6, 10, w - 12, h - 20, h * 0.42);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#f2f5f9');
  grad.addColorStop(1, '#d5dde8');
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = '#b7c3d2';
  g.lineWidth = 3;
  g.stroke();

  // The Wii button: a wide oval on the left, breathing a soft blue.
  const bx = 44;
  const bw = h * 2.1;
  const bh = h * 0.62;
  const by = (h - bh) / 2;
  roundRect(g, bx, by, bw, bh, bh / 2);
  const glow = 0.45 + 0.3 * Math.sin(wiiButtonPulse) + wiiButtonHover * 0.5;
  g.fillStyle = '#eef4fb';
  g.fill();
  g.strokeStyle = `rgba(60, 150, 240, ${clamp(glow, 0, 1)})`;
  g.lineWidth = 7;
  g.stroke();
  g.fillStyle = '#48617d';
  g.font = `700 ${Math.round(bh * 0.5)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Wii', bx + bw / 2, by + bh / 2 + 2);

  // SD card slot, purely decorative.
  const sx = bx + bw + 34;
  roundRect(g, sx, by + bh * 0.18, bh * 0.72, bh * 0.64, 6);
  g.fillStyle = '#c6d0dd';
  g.fill();

  // Clock and date on the right.
  const now = new Date();
  const hh = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, '0');
  const h12 = ((hh + 11) % 12) + 1;
  g.fillStyle = '#3d4d60';
  g.textAlign = 'right';
  g.font = `700 ${Math.round(h * 0.34)}px -apple-system, system-ui, sans-serif`;
  g.fillText(`${h12}:${mm}`, w - 60, h / 2 - h * 0.02);
  g.font = `600 ${Math.round(h * 0.15)}px -apple-system, system-ui, sans-serif`;
  g.fillStyle = '#7286a0';
  g.fillText(
    now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    w - 60, h / 2 + h * 0.26,
  );

  bar.texture.needsUpdate = true;
}

// ── Page arrows ────────────────────────────────────────────────────────────
function makeArrow(dir) {
  const { texture, ctx: g, canvas: c } = makeTexture(1.0, 1.6, (gg, w, h) => {
    gg.clearRect(0, 0, w, h);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 1.6),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
  scene.add(mesh);
  return { mesh, texture, g, c, dir, hover: 0, enabled: false };
}

const arrows = [makeArrow(-1), makeArrow(1)];

function drawArrow(a) {
  const { g, c } = a;
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);
  const alpha = a.enabled ? 0.85 + a.hover * 0.15 : 0.28;
  roundRect(g, 6, 6, w - 12, h - 12, 26);
  g.fillStyle = `rgba(255,255,255,${a.enabled ? 0.9 : 0.5})`;
  g.fill();
  g.strokeStyle = `rgba(185,197,212,${alpha})`;
  g.lineWidth = 3;
  g.stroke();
  g.beginPath();
  const cx = w / 2;
  const cy = h / 2;
  const s = w * 0.2;
  if (a.dir < 0) { g.moveTo(cx + s * 0.6, cy - s); g.lineTo(cx - s * 0.6, cy); g.lineTo(cx + s * 0.6, cy + s); }
  else { g.moveTo(cx - s * 0.6, cy - s); g.lineTo(cx + s * 0.6, cy); g.lineTo(cx - s * 0.6, cy + s); }
  g.closePath();
  g.fillStyle = a.enabled ? `rgba(70,95,125,${alpha})` : 'rgba(150,165,182,0.55)';
  g.fill();
  a.texture.needsUpdate = true;
}

// ── Hand cursor ────────────────────────────────────────────────────────────
/** The Wii pointer: a white hand with a dark outline, drawn in code. */
function handTexture(playerColour) {
  return makeTexture(1.1, 1.4, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.translate(w * 0.5, h * 0.5);
    const s = w * 0.0075;
    g.scale(s, s);
    g.lineJoin = 'round';
    g.lineWidth = 9;
    g.strokeStyle = '#2a3340';
    g.fillStyle = '#ffffff';

    // Palm plus a pointing index finger.
    g.beginPath();
    g.moveTo(-6, 46);
    g.quadraticCurveTo(-34, 34, -34, 4);
    g.lineTo(-34, -14);
    g.quadraticCurveTo(-34, -26, -22, -26);
    g.quadraticCurveTo(-12, -26, -12, -14);
    g.lineTo(-12, -34);
    g.quadraticCurveTo(-12, -62, 0, -62);
    g.quadraticCurveTo(12, -62, 12, -34);
    g.lineTo(12, -8);
    g.quadraticCurveTo(20, -20, 30, -12);
    g.quadraticCurveTo(38, -4, 30, 16);
    g.quadraticCurveTo(22, 42, 10, 48);
    g.closePath();
    g.fill();
    g.stroke();

    g.fillStyle = playerColour;
    g.beginPath();
    g.arc(0, 24, 11, 0, Math.PI * 2);
    g.fill();
  });
}

const hand = new THREE.Mesh(
  new THREE.PlaneGeometry(1.1, 1.4),
  new THREE.MeshBasicMaterial({ map: handTexture('#3c8cf0').texture, transparent: true, depthTest: false }),
);
hand.renderOrder = 999;
scene.add(hand);

// ── State ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();
const pointer = new Pointer({ mode: 'absolute' });
// Pointer speed is a remembered preference, not something calibration derives.
pointer.sensitivity = loadSensitivity() ?? 1;
let lastSample = null;
let lastSampleAt = 0;
let hovered = null;         // tile | arrow | 'wii' | null
let launching = null;       // { tile, t } during zoom-to-fill

const calibration = new Calibration({
  onStep: (step) => {
    link.feedback({ type: 'calibration', step, active: calibration.active });
    $('cal').classList.toggle('hide', !calibration.active);
    if (calibration.active) {
      const copy = {
        signal: ['Waiting for the remote', 'Open the controller page on your phone and tap Enable motion sensors.'],
        steady: ['Hold still', 'Grip the phone however feels natural, point it at this screen, and keep it as steady as you can — this is measuring how much your hand shakes.'],
        range: ['Swing it around', 'Sweep fully left and right, then all the way up and down. Take your time — it ends when you stop.'],
      }[step];
      if (copy) { $('cal-title').textContent = copy[0]; $('cal-body').textContent = copy[1]; }
    }
  },
  onDone: (result) => {
    pointer.applyCalibration(result);
    pointer.setFrame(calibration.frame);
    pointer.recentre();
    $('cal').classList.add('hide');
    audio.play('pointer-connect');
  },
});

// Inherit this server run's calibration if one exists. Only the menu ever runs
// the flow; games inherit it, so calibration happens once per `npm start`.
let calibrationReady = false;
fetchBootId().then(() => {
  const saved = loadCalibration();
  if (saved) {
    const result = calibration.restore(saved);
    pointer.setFrame(calibration.frame);
    if (result) pointer.applyCalibration(result);
  }
  calibrationReady = true;
});

const link = new GameLink({
  onOrientation: (sample) => {
    const now = performance.now();
    const dt = lastSampleAt ? clamp((now - lastSampleAt) / 1000, 1 / 240, 0.1) : 1 / 60;
    lastSampleAt = now;
    lastSample = sample;
    // Start calibration on the first real sample, not on presence. A phone can
    // sit connected with sensors disabled indefinitely, and gating on presence
    // parks the menu behind a "hold still" prompt that can never be satisfied.
    // `calibrationReady` waits for the boot-id lookup so we don't kick off a
    // redundant calibration a beat before discovering a saved one.
    if (calibrationReady && !calibration.done && !calibration.active) calibration.start(now);
    const frame = calibration.advance(sample, now);
    if (frame && !pointer.frame) pointer.setFrame(frame);
    pointer.update(sample, dt, now);
  },
  onCommand: (cmd) => {
    if (cmd.type === 'button' && cmd.button === 'A') pressA();
    else if (cmd.type === 'button' && cmd.button === 'B') pressB();
    else if (cmd.type === 'calibrate') startCalibration();
    else if (cmd.type === 'recentre') quickRecentre();
  },
  onPresence: ({ controller }) => {
    const on = controller > 0;
    $('dot').classList.toggle('on', on);
    $('link-t').textContent = on ? 'remote connected' : 'no remote connected';
    // The pairing card is scaffolding: useful until a phone is attached, pure
    // clutter over the channel grid afterwards.
    $('pair').classList.toggle('gone', on);
  },
});

/**
 * Browsers refuse to start audio without a user gesture, so the music can only
 * begin on the first interaction. The removed warning screen used to be that
 * gesture; now any button press or click serves.
 */
let audioStarted = false;
function ensureAudio() {
  if (audioStarted) return;
  audioStarted = true;
  audio.unlock().then((ok) => {
    if (!ok) { audioStarted = false; return; }
    audio.startMusic();
  });
}

/** Transient readout so speed changes are visible while adjusting. */
let speedUntil = 0;
function showSpeed() {
  speedUntil = performance.now() + 1600;
  $('speed').textContent = `Pointer speed ${(pointer.sensitivity * 100).toFixed(0)}%`;
  $('speed').classList.add('on');
}

function startCalibration() {
  ensureAudio();
  calibration.start(performance.now());
}

function quickRecentre() {
  ensureAudio();
  if (lastSample && calibration.recentre(lastSample)) {
    pointer.setFrame(calibration.frame);
    pointer.recentre();
    audio.play('select');
  }
}

// ── Interaction ────────────────────────────────────────────────────────────
function pressA() {
  ensureAudio();
  if (calibration.active) return;
  if (launching) return;

  if (hovered === 'wii') { audio.play('select'); return; }
  if (hovered && hovered.dir !== undefined) { turnPage(hovered.dir); return; }
  if (hovered && hovered.game) launch(hovered);
}

function pressB() {
  ensureAudio();
  audio.play('back');
}

function turnPage(dir) {
  const pages = Math.max(1, Math.ceil(games.length / PER_PAGE));
  const next = page + dir;
  if (next < 0 || next >= pages) return;
  page = next;
  buildTiles();
  audio.play('select');
  refreshArrows();
}

function refreshArrows() {
  const pages = Math.max(1, Math.ceil(games.length / PER_PAGE));
  arrows[0].enabled = page > 0;
  arrows[1].enabled = page < pages - 1;
  arrows.forEach(drawArrow);
}

function launch(tile) {
  launching = { tile, t: 0 };
  audio.play('channel-open');
  audio.stopMusic();
  link.feedback({ type: 'launch', game: tile.game.slug });
}

// ── Layout ─────────────────────────────────────────────────────────────────
function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointer.setViewport(w, h);

  const halfH = VIEW_H / 2;
  const halfW = halfH * camera.aspect;
  barMesh.position.set(0, -halfH + BAR_H / 2 + 0.18, 0.05);
  barMesh.scale.x = Math.min(1, (halfW * 2 - 0.5) / barW);

  computeLayout();
  if (tiles.length) applyLayout();
}
window.addEventListener('resize', resize);

/** Normalised pointer (0..1, y down) → world units on the z=0 plane. */
function toWorld(nx, ny) {
  const halfH = VIEW_H / 2;
  const halfW = halfH * camera.aspect;
  return { x: (nx - 0.5) * 2 * halfW, y: (0.5 - ny) * 2 * halfH };
}

// ── Hit testing ────────────────────────────────────────────────────────────
function hitTest(wx, wy) {
  for (const a of arrows) {
    if (a.enabled
      && Math.abs(wx - a.mesh.position.x) < 0.55 * L.scale
      && Math.abs(wy - a.mesh.position.y) < 0.85 * L.scale) return a;
  }
  if (wy < barMesh.position.y + BAR_H / 2 && wy > barMesh.position.y - BAR_H / 2) {
    const bx = -barW * barMesh.scale.x / 2 + 1.4;
    if (wx > bx - 1.2 && wx < bx + 2.2) return 'wii';
    return null;
  }
  for (const t of tiles) {
    if (!t.game) continue;
    if (Math.abs(wx - t.home.x) < (TILE_W * L.scale) / 2
      && Math.abs(wy - t.home.y) < (TILE_H * L.scale) / 2) return t;
  }
  return null;
}

function setHover(next) {
  if (next === hovered) return;
  hovered = next;
  if (next) audio.play('hover');
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let barClock = 0;
let frames = 0;
let fpsMark = performance.now();
let fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;

  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }
  step(now, dt);
}

/** One frame's work, split out so it can be driven deterministically. */
function step(now, dt) {

  if (!pointer.live && mouse.active) pointer.setFromMouse(mouse.x, mouse.y);
  if (pointer.live && now - pointer.lastSeen > 500) pointer.live = false;

  // Per-frame prediction, not the last packet — see Pointer.sampleAt.
  const aim = pointer.sampleAt(now);
  const p = toWorld(aim.x, aim.y);
  // The hotspot is the fingertip, so the sprite hangs down-right of the aim
  // point. Both sprite and offset scale with the layout, or the cursor looks
  // enormous on a small window.
  hand.scale.setScalar(L.scale);
  hand.position.set(p.x + 0.3 * L.scale, p.y - 0.44 * L.scale, 3);
  hand.visible = !launching;

  if (!calibration.active && !launching) setHover(hitTest(p.x, p.y));
  else if (launching) setHover(null);

  // Idle wobble + hover response.
  for (const t of tiles) {
    const target = t === hovered ? 1 : 0;
    t.hover += (target - t.hover) * Math.min(1, dt * 12);
    const w = Math.sin(now / 1000 * 0.9 + t.phase);
    const w2 = Math.cos(now / 1000 * 0.7 + t.phase * 1.3);
    t.mesh.rotation.y = w * 0.035 + t.hover * 0.04;
    t.mesh.rotation.x = w2 * 0.028;
    t.mesh.position.z = t.home.z + w * 0.05 + t.hover * 0.55;
    const s = L.scale * (1 + t.hover * 0.07);
    t.mesh.scale.set(s, s, 1);
  }

  for (const a of arrows) {
    const target = a === hovered ? 1 : 0;
    const before = a.hover;
    a.hover += (target - a.hover) * Math.min(1, dt * 12);
    if (Math.abs(a.hover - before) > 0.01) drawArrow(a);
    a.mesh.scale.setScalar(L.scale * (1 + a.hover * 0.08));
  }

  wiiButtonPulse += dt * 1.6;
  const wiiTarget = hovered === 'wii' ? 1 : 0;
  wiiButtonHover += (wiiTarget - wiiButtonHover) * Math.min(1, dt * 12);
  barClock += dt;
  if (barClock > 0.2) { barClock = 0; drawBar(); }

  // Zoom-to-fill: the selected channel grows to cover the screen, everything
  // else fades, then we navigate.
  if (launching) {
    launching.t += dt;
    const k = Math.min(1, launching.t / 0.75);
    const ease = k * k * (3 - 2 * k);
    const tile = launching.tile;
    tile.mesh.position.set(
      tile.home.x * (1 - ease), tile.home.y * (1 - ease), tile.home.z + ease * 7.5,
    );
    const s = L.scale * (1 + ease * 7);
    tile.mesh.scale.set(s, s, 1);
    for (const other of tiles) {
      if (other === tile) continue;
      other.mesh.material.opacity = 1 - ease;
      other.mesh.material.transparent = true;
    }
    barMesh.material.opacity = 1 - ease;
    barMesh.material.transparent = true;
    for (const a of arrows) { a.mesh.material.opacity = 1 - ease; a.mesh.material.transparent = true; }
    if (k >= 1) {
      window.location.href = tile.game.url;
      launching.t = -1e9;   // stop re-triggering while the browser navigates
    }
  }

  renderer.render(scene, camera);
}

// ── Input fallbacks (desk testing without a phone) ─────────────────────────
const mouse = { x: 0.5, y: 0.5, active: false };
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX / window.innerWidth;
  mouse.y = e.clientY / window.innerHeight;
  mouse.active = true;
});
window.addEventListener('pointerdown', () => { ensureAudio(); pressA(); });
window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pressA(); }
  else if (e.key === 'Escape' || e.key.toLowerCase() === 'b') pressB();
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1.12 : 1 / 1.12;
    pointer.sensitivity = clamp(pointer.sensitivity * step, 0.2, 6);
    saveSensitivity(pointer.sensitivity);
    showSpeed();
  } else if (e.key.toLowerCase() === 'r') startCalibration();
  else if (e.key.toLowerCase() === 'c') quickRecentre();
  else if (e.key.toLowerCase() === 'd') $('debug').classList.toggle('on');
});

// ── Boot sequence ──────────────────────────────────────────────────────────
fetch('/api/games').then((r) => r.json()).then((list) => {
  games = list;
  buildTiles();
  refreshArrows();
}).catch(() => { games = []; buildTiles(); refreshArrows(); });

fetch('/api/pairing').then((r) => r.json()).then(({ url, qr }) => {
  $('pair-qr').src = qr;
  $('pair-url').textContent = url;
}).catch(() => {});

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  $('debug').textContent = [
    `fps         ${fps.toFixed(0)}`,
    `pointer     ${pointer.display.x.toFixed(3)}, ${pointer.display.y.toFixed(3)}`,
    `lead        ${(pointer.lead*1000).toFixed(0)}ms  vel ${Math.hypot(pointer.vel.x, pointer.vel.y).toFixed(2)}/s`,
    `hand noise  ${pointer.noiseDeg.toFixed(2)}deg  gate ${pointer.gateLo.toFixed(2)}`,
    `gyro fusion ${pointer.gyroSign.yaw ? 'on (sign ' + pointer.gyroSign.yaw + ')' : 'learning…'}`,
    `drift corr  ${pointer.mode === 'hybrid' ? pointer.driftYaw.toFixed(2) + 'deg' : 'off (absolute)'}`,
    `deg/screen  ${pointer.degPerScreenX.toFixed(0)} x ${pointer.degPerScreenY.toFixed(0)}  cutoff ${pointer.filterX.minCutoff.toFixed(1)}Hz`,
    `mode        ${pointer.mode}`,
    `grip        ${pointer.frame ? (pointer.frame.axis === 'y' ? 'flat' : 'upright') : '—'}`,
    `hover       ${hovered === 'wii' ? 'Wii button' : hovered && hovered.dir !== undefined ? 'arrow' : hovered && hovered.game ? hovered.game.title : '—'}`,
    `sensor      ${link.rate.toFixed(0)} Hz`,
    `channels    ${games.length}`,
  ].join('\n');
}, 250);

drawBar();
resize();
requestAnimationFrame(frame);

window.__openwii = {
  scene, camera, renderer, tiles, arrows, pointer, calibration, audio, link,
  hitTest, toWorld, pressA, pressB, step, layout: L,
  state: () => ({ hovered, launching: !!launching, page, games, fps }),
};
