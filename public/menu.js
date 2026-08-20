import * as THREE from '/vendor/three/three.module.js';
import { Pointer } from '/core/pointer.js';
import { saveSensitivity, loadSensitivity } from '/core/calibration.js';
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
const PER_PAGE = 12;          // every grid shape below multiplies to this
const TILE_W = 3.4;
const TILE_H = 2.5;
const GAP_X = 0.34;
const GAP_Y = 0.30;
const BAR_H = 2.2;            // bottom bar height in world units — the original's bar is tall
const VIEW_H = 12.4;          // world units the camera frames vertically

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, desynchronized: true, powerPreference: 'high-performance',
});
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

/** The Wii Menu's soft silver-white wash, with its trademark fine scanlines. */
function backdropTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#eef2f6');
  grad.addColorStop(0.55, '#dbe2ea');
  grad.addColorStop(1, '#bfcad6');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  g.fillStyle = 'rgba(110, 128, 150, 0.07)';
  for (let y = 0; y < 512; y += 3) g.fillRect(0, y, 4, 1);
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

/** Full-bleed art colours per channel — saturated, like real channel tiles. */
const CHANNEL_ART = {
  'fruit-ninja': ['#ffb347', '#e8542f'],
  swordplay: ['#8fb3e0', '#4a6fa8'],
  'table-tennis': ['#4cc3ab', '#238f7a'],
  golf: ['#8fd05f', '#3f9b45'],
  'island-flyover': ['#74cbf4', '#2f8fd0'],
  kart: ['#f4785f', '#c93a30'],
};

/**
 * Measure an emoji's painted extents by rendering it offscreen and scanning
 * pixel alpha. Returns the ink centre's offset from the draw origin (centre
 * aligned, middle baseline) and the ink height. Cached per emoji and size.
 */
const inkCache = new Map();
function emojiInk(em, px) {
  const key = `${em}:${px}`;
  let ink = inkCache.get(key);
  if (ink) return ink;
  const s = Math.ceil(px * 1.6);
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = `${px}px -apple-system, "Apple Color Emoji", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(em, s / 2, s / 2);
  const d = g.getImageData(0, 0, s, s).data;
  let x0 = s; let x1 = -1; let y0 = s; let y1 = -1;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      if (d[(y * s + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  ink = x1 < 0
    ? { dx: 0, dy: 0, h: px }        // glyph missing: neutral fallback
    : { dx: (x0 + x1) / 2 - s / 2, dy: (y0 + y1) / 2 - s / 2, h: y1 - y0 + 1 };
  inkCache.set(key, ink);
  return ink;
}

function drawTileFace(g, w, h, game) {
  const pad = 10;
  g.clearRect(0, 0, w, h);

  if (!game) {
    // Empty slot: a recessed grey well, clearly darker than the backdrop —
    // on the real menu you can tell at a glance which slots hold a channel.
    roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
    const empty = g.createLinearGradient(0, 0, 0, h);
    empty.addColorStop(0, '#b6c1ce');
    empty.addColorStop(0.14, '#c5cfda');
    empty.addColorStop(1, '#d3dbe5');
    g.fillStyle = empty;
    g.fill();
    g.strokeStyle = '#a9b6c5';
    g.lineWidth = 3;
    g.stroke();
    return;
  }

  // Full-bleed channel art: saturated gradient, big art, the title set right
  // on the art in white — the way every real channel reads.
  const [c0, c1] = CHANNEL_ART[game.slug] || ['#9db8d9', '#6f8fbc'];
  g.save();
  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
  g.clip();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, c0);
  grad.addColorStop(1, c1);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Centre the emoji + title as ONE group, using the emoji's PIXEL ink.
  // Font metrics lie about colour emoji (some browsers report the em box or
  // nothing), and emoji art routinely sits off-centre inside its own glyph —
  // so the icon is rendered once offscreen, its painted pixels measured, and
  // the icon+gap+title block is centred in the tile from those real extents.
  const em = game.emoji || '🎮';
  const px = Math.round(h * 0.42);
  const ink = emojiInk(em, px);
  const titleH = Math.round(h * 0.115);
  const gapH = Math.round(h * 0.055);
  const groupTop = pad + (h - pad * 2 - (ink.h + gapH + titleH)) / 2;

  g.font = `${px}px -apple-system, "Apple Color Emoji", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 18;
  g.shadowOffsetY = 6;
  g.fillText(em, w / 2 - ink.dx, groupTop + ink.h / 2 - ink.dy);
  g.shadowColor = 'transparent';

  g.fillStyle = '#ffffff';
  g.font = `700 ${titleH}px -apple-system, system-ui, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 2;
  g.fillText(game.title, w / 2, groupTop + ink.h + gapH + titleH * 0.8);
  g.shadowColor = 'transparent';

  // Screen gloss: the diagonal sheen every real channel tile carries.
  const gloss = g.createLinearGradient(0, pad, 0, h * 0.52);
  gloss.addColorStop(0, 'rgba(255,255,255,0.42)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gloss;
  g.fillRect(0, 0, w, h * 0.52);
  g.restore();

  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.stroke();
  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, 26);
  g.strokeStyle = '#a9b6c5';
  g.lineWidth = 2;
  g.stroke();
}

/**
 * Layout, recomputed on resize.
 *
 * The window can be any shape, so two things adapt: the grid reflows (4×3 in
 * landscape, 3×4 around square, 2×6 in portrait — always 12 slots), and the
 * whole layout scales to fill whichever axis binds. Without the reflow a
 * portrait window shows a tiny 4-wide strip lost in empty backdrop; without
 * the fill, big windows waste most of their space.
 */
const L = { scale: 1, cols: 4, rows: 3, x0: 0, y0: 0, stepX: 0, stepY: 0, arrowX: 0, arrowY: 0 };

function pickGrid(aspect) {
  if (aspect >= 1.15) return [4, 3];
  if (aspect >= 0.72) return [3, 4];
  return [2, 6];
}

function computeLayout() {
  [L.cols, L.rows] = pickGrid(camera.aspect);
  const gridW = L.cols * TILE_W + (L.cols - 1) * GAP_X;
  const gridH = L.rows * TILE_H + (L.rows - 1) * GAP_Y;
  const halfH = VIEW_H / 2;
  const halfW = halfH * camera.aspect;

  // Reserve headroom for the link pill, which lives in CSS pixels — convert
  // its footprint into world units at the current size.
  const topPad = (66 * VIEW_H) / Math.max(420, window.innerHeight);
  const top = halfH - topPad;
  const barTop = -halfH + BAR_H + 0.36;
  const availH = top - barTop;
  const availW = halfW * 2;

  // Leave room for a page arrow on each side plus a margin. The 1.3 cap stops
  // tiles going comically large on big near-square windows.
  const needW = gridW + 2 * 1.7 + 0.6;
  L.scale = Math.min(1.3, availW / needW, availH / (gridH + 0.9));

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
    const col = i % L.cols;
    const row = Math.floor(i / L.cols);
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
// The bar spans the window at any width. Its texture is regenerated at the
// real aspect on resize — scaling a fixed-width texture down squashes the Wii
// button and clock into an unreadable smear on narrow windows.
let barW = 26;
let bar = makeTexture(barW, BAR_H, () => {});
const barMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(barW, BAR_H),
  new THREE.MeshBasicMaterial({ map: bar.texture, transparent: true }),
);
scene.add(barMesh);

function rebuildBar() {
  const halfW = (VIEW_H / 2) * camera.aspect;
  const want = Math.max(6, Math.min(26, halfW * 2 - 0.5));
  if (Math.abs(want - barW) < 0.05) return;
  barW = want;
  bar.texture.dispose();
  bar = makeTexture(barW, BAR_H, () => {});
  barMesh.geometry.dispose();
  barMesh.geometry = new THREE.PlaneGeometry(barW, BAR_H);
  barMesh.material.map = bar.texture;
  barMesh.material.needsUpdate = true;
  drawBar();
}

let wiiButtonPulse = 0;
let wiiButtonHover = 0;
let qrHover = 0;
let qrImg = null;            // pairing QR, drawn inside the right-hand button

/**
 * The original bar: a silver band whose top edge sweeps up around a round
 * button at each end, an aqua line tracing the edge, the clock dead centre in
 * quiet LCD grey. Left button says OpenWii; the right one — the console's
 * envelope — is our pairing QR instead.
 */
function drawBar() {
  const { ctx: g, canvas: c } = bar;
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);

  const cy = h * 0.56;               // circle centres sit slightly low
  const r = h * 0.4;                 // round-button radius
  const lx = h * 0.62;               // left circle centre x
  const rx = w - h * 0.62;           // right circle centre x
  const dip = h * 0.24;              // how far the middle edge sits below the swells

  // Band with a wavy top edge: swells over each button, dips across the middle.
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(0, cy - r * 0.55);
  g.quadraticCurveTo(lx - r * 1.1, cy - r * 1.28, lx, cy - r * 1.28);
  g.quadraticCurveTo(lx + r * 1.35, cy - r * 1.28, lx + r * 2.1, dip);
  g.lineTo(rx - r * 2.1, dip);
  g.quadraticCurveTo(rx - r * 1.35, cy - r * 1.28, rx, cy - r * 1.28);
  g.quadraticCurveTo(rx + r * 1.1, cy - r * 1.28, w, cy - r * 0.55);
  g.lineTo(w, h);
  g.closePath();
  const grad = g.createLinearGradient(0, dip, 0, h);
  grad.addColorStop(0, '#f6f9fc');
  grad.addColorStop(0.5, '#e6ecf3');
  grad.addColorStop(1, '#ccd6e2');
  g.fillStyle = grad;
  g.fill();
  // The aqua edge line.
  g.strokeStyle = '#9fd8ef';
  g.lineWidth = 4;
  g.stroke();
  // Cover the stroke on the three off-screen sides.
  g.fillStyle = grad;
  g.fillRect(-4, h - 3, w + 8, 6);

  /** One round bar button: white face, grey ring, soft drop. */
  const button = (x, hover, glow) => {
    g.beginPath();
    g.arc(x, cy, r + 3, 0, Math.PI * 2);
    g.fillStyle = 'rgba(90, 110, 135, 0.18)';
    g.fill();
    g.beginPath();
    g.arc(x, cy, r, 0, Math.PI * 2);
    const face = g.createLinearGradient(0, cy - r, 0, cy + r);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(1, '#dde5ee');
    g.fillStyle = face;
    g.fill();
    g.strokeStyle = glow ? `rgba(80, 170, 240, ${clamp(glow, 0, 1)})` : '#b7c3d2';
    g.lineWidth = glow ? 6 : 4;
    g.stroke();
    if (hover > 0.02) {
      g.beginPath();
      g.arc(x, cy, r + 6, 0, Math.PI * 2);
      g.strokeStyle = `rgba(80, 170, 240, ${hover * 0.65})`;
      g.lineWidth = 5;
      g.stroke();
    }
  };

  const pulse = 0.35 + 0.25 * Math.sin(wiiButtonPulse) + wiiButtonHover * 0.4;
  button(lx, wiiButtonHover, pulse);
  g.fillStyle = '#7d90a6';
  g.font = `700 ${Math.round(r * 0.42)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('OpenWii', lx, cy + 2);

  button(rx, qrHover, 0);
  if (qrImg && qrImg.complete) {
    g.save();
    g.beginPath();
    g.arc(rx, cy, r * 0.78, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#fff';
    g.fillRect(rx - r, cy - r, r * 2, r * 2);
    const q = r * 1.16;
    g.drawImage(qrImg, rx - q / 2, cy - q / 2, q, q);
    g.restore();
  } else {
    g.fillStyle = '#7d90a6';
    g.font = `700 ${Math.round(r * 0.5)}px -apple-system, system-ui, sans-serif`;
    g.fillText('✉', rx, cy + 2);
  }

  // The clock, centre stage: big, chunky, quiet LCD grey — a landmark, like
  // the original. Shrinks on narrow bars so it never collides with the buttons.
  const now = new Date();
  const hh = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, '0');
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const fit = clamp((w / h - 1.9) / 2.4, 0.5, 1);
  g.fillStyle = '#aeb9c6';
  g.textAlign = 'center';
  g.font = `500 ${Math.round(h * 0.34 * fit)}px "Helvetica Neue", -apple-system, system-ui, sans-serif`;
  const timeStr = `${h12}:${mm}`;
  const tw = g.measureText(timeStr).width;
  g.fillText(timeStr, w / 2, dip + (h - dip) * 0.44);
  g.font = `700 ${Math.round(h * 0.11 * fit)}px -apple-system, system-ui, sans-serif`;
  g.fillText(ampm, w / 2 + tw / 2 + h * 0.1 * fit, dip + (h - dip) * 0.47);
  if (fit > 0.62) {
    g.font = `500 ${Math.round(h * 0.14 * fit)}px -apple-system, system-ui, sans-serif`;
    g.fillStyle = '#98a7b6';
    g.fillText(
      now.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' }),
      w / 2, dip + (h - dip) * 0.76,
    );
  }

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
  if (!a.enabled) { a.texture.needsUpdate = true; return; }   // no page, no arrow
  const alpha = 0.85 + a.hover * 0.15;
  roundRect(g, 6, 6, w - 12, h - 12, 26);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fill();
  g.strokeStyle = `rgba(169,182,197,${alpha})`;
  g.lineWidth = 3;
  g.stroke();
  // The solid blue triangle — the original's unmistakable page affordance.
  g.beginPath();
  const cx = w / 2;
  const cy = h / 2;
  const s = w * 0.27;
  if (a.dir < 0) { g.moveTo(cx + s * 0.6, cy - s); g.lineTo(cx - s * 0.6, cy); g.lineTo(cx + s * 0.6, cy + s); }
  else { g.moveTo(cx - s * 0.6, cy - s); g.lineTo(cx + s * 0.6, cy); g.lineTo(cx - s * 0.6, cy + s); }
  g.closePath();
  g.fillStyle = `rgba(62, 155, 226, ${alpha})`;
  g.fill();
  a.texture.needsUpdate = true;
}

// ── Hand cursor ────────────────────────────────────────────────────────────
// The Wii pointer, from art: a transparent PNG of the original-style glove
// with the player number baked in (public/assets/hand-p1.png).
const handTex = new THREE.TextureLoader().load('/assets/hand-p1.png');
handTex.colorSpace = THREE.SRGBColorSpace;
handTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const HAND_SIZE = 1.6;                 // square sprite, world units at scale 1
// Where the fingertip sits inside the image (fractions from the top-left).
const HAND_TIP = { x: 0.32, y: 0.09 };

// One hand per connected phone (max 4 — the server's MAX_PLAYERS). All hands
// share the P1 artwork; players 2–4 get a coloured number badge drawn over
// the baked-in "1" so each cursor is unmistakably somebody's.
const PLAYER_COLOURS = ['#3c8cf0', '#ff5f6d', '#7ed957', '#ffd166'];

function badgeTexture(slot) {
  return makeTexture(0.5, 0.5, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = PLAYER_COLOURS[slot % PLAYER_COLOURS.length];
    g.strokeStyle = '#243b63';
    g.lineWidth = w * 0.07;
    g.beginPath();
    g.arc(w / 2, h / 2, w * 0.42, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#fff';
    g.font = `800 ${Math.round(h * 0.52)}px -apple-system, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(slot + 1), w / 2, h * 0.54);
  }).texture;
}

function makeHand(slot) {
  const group = new THREE.Group();
  const sprite = new THREE.Mesh(
    new THREE.PlaneGeometry(HAND_SIZE, HAND_SIZE),
    new THREE.MeshBasicMaterial({ map: handTex, transparent: true, depthTest: false }),
  );
  sprite.renderOrder = 999;
  group.add(sprite);
  if (slot > 0) {
    // Cover the artwork's baked "1" (sits around 53%, 55% of the image).
    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(HAND_SIZE * 0.34, HAND_SIZE * 0.34),
      new THREE.MeshBasicMaterial({ map: badgeTexture(slot), transparent: true, depthTest: false }),
    );
    badge.renderOrder = 1000;
    badge.position.set((0.53 - 0.5) * HAND_SIZE, (0.5 - 0.55) * HAND_SIZE, 0.01);
    group.add(badge);
  }
  group.visible = false;
  scene.add(group);
  return group;
}

// ── State ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();

/**
 * Per-phone input state, keyed by the server-assigned slot. Each phone gets
 * its own Pointer (gyro conventions are learned per device) and its own hand.
 * Slot 0 doubles as the mouse/keyboard desk-testing fallback, exactly as the
 * old single-pointer menu behaved.
 */
const inputs = new Map();   // slot → { pointer, lastSampleAt, hand, hover, lastHover }

function inputFor(slot) {
  let inp = inputs.get(slot);
  if (!inp) {
    const p = new Pointer({});
    // Pointer speed is a preference, remembered across pages and restarts —
    // but there's one saved value, and slot 0 is the phone that's always
    // there. Extra players tune for the session.
    p.sensitivity = (slot === 0 ? loadSensitivity() : null) ?? 1;
    p.setViewport(window.innerWidth, window.innerHeight);
    inp = { pointer: p, lastSampleAt: 0, hand: makeHand(slot), hover: null, lastHover: null };
    inputs.set(slot, inp);
  }
  return inp;
}
inputFor(0);

let launching = null;       // { tile, t } during zoom-to-fill

// No calibration flow. Rate-based aiming is grip-agnostic and unit/sign
// auto-gaining, so each pointer is live from its phone's first packet.

const link = new GameLink({
  onOrientation: (sample, slot) => {
    const now = performance.now();
    const inp = inputFor(slot);
    const dt = inp.lastSampleAt ? clamp((now - inp.lastSampleAt) / 1000, 1 / 240, 0.1) : 1 / 60;
    inp.lastSampleAt = now;
    inp.pointer.update(sample, dt, now);
  },
  onCommand: (cmd, slot) => {
    if (cmd.type === 'button' && cmd.button === 'A') pressA(slot);
    else if (cmd.type === 'button' && cmd.button === 'B') pressB();
    else if (cmd.type === 'calibrate' || cmd.type === 'recentre') quickRecentre(slot);
    else if (cmd.type === 'speed') {
      const p = inputFor(slot).pointer;
      p.sensitivity = clamp(p.sensitivity * (cmd.factor || 1), 0.2, 6);
      if (slot === 0) saveSensitivity(p.sensitivity);
      showSpeed(slot);
    }
  },
  onPresence: (pr) => {
    const on = pr.controller > 0;
    $('dot').classList.toggle('on', on);
    $('link-t').textContent = on
      ? (pr.controller > 1 ? `${pr.controller} remotes connected` : 'remote connected')
      : 'no remote connected';
    // Hide the hand of any phone that left, immediately — not after its
    // pointer times out.
    for (const s of pr.slots || []) {
      if (s.occupied) continue;
      const inp = inputs.get(s.slot);
      if (inp) { inp.pointer.live = false; inp.hand.visible = false; inp.hover = null; }
    }
  },
});

/**
 * Start audio the moment the browser lets us. Chrome permits autoplay
 * outright once the site has earned it (or when the navigation here was
 * user-initiated); otherwise the first gesture unlocks it. So: try at boot,
 * keep retrying quietly, and also try on every interaction — the music and
 * all cues come alive at the earliest instant the policy allows, instead of
 * "sometimes silent until you happen to click".
 */
function ensureAudio() {
  audio.unlock().then((ok) => {
    if (!ok) return;
    // Pre-warm the menu's sampled cues: without this, each cue's FIRST play
    // of the session uses the synth fallback while the file is still being
    // fetched — the one play the user most notices.
    for (const cue of ['menu-hover', 'menu-select', 'menu-back']) audio.loadOverride(cue);
    if (!audio.music) audio.startMusic();
  });
}
ensureAudio();
audio.startMusic();   // the element route may be allowed with no gesture at all
let soundHintOn = false;
const audioRetry = setInterval(() => {
  audio.startMusic();               // retries a policy-blocked element too
  ensureAudio();                    // unlocks the cue engine when allowed
  const musicOn = audio.music && (!audio.music.el || !audio.music.el.paused);
  const ctxOn = audio.ctx && audio.ctx.state === 'running';
  if (musicOn && ctxOn) {
    if (soundHintOn) { soundHintOn = false; speedUntil = 1; }   // hide next frame
    clearInterval(audioRetry);
  }
}, 500);

// A truly fresh browser session may refuse all autoplay until one local
// click — say so quietly instead of seeming broken. (npm run tv launches
// Chrome with autoplay enabled and never needs this.)
setTimeout(() => {
  const musicOn = audio.music && (!audio.music.el || !audio.music.el.paused);
  if (musicOn) return;
  soundHintOn = true;
  speedUntil = performance.now() + 1e9;
  $('speed').textContent = '🔊 Click anywhere once for sound';
  $('speed').classList.add('on');
}, 1500);

/** Transient readout so speed changes are visible while adjusting. */
let speedUntil = 0;
function showSpeed(slot = 0) {
  speedUntil = performance.now() + 1600;
  const p = inputFor(slot).pointer;
  const who = link.controllers > 1 ? `P${slot + 1} pointer` : 'Pointer';
  $('speed').textContent = `${who} speed ${(p.sensitivity * 100).toFixed(0)}%`;
  $('speed').classList.add('on');
}

function quickRecentre(slot = 0) {
  ensureAudio();
  inputFor(slot).pointer.recentre();
  audio.play('menu-select');
}

// ── Interaction ────────────────────────────────────────────────────────────
/** A press acts on whatever THAT player's hand is over. */
function pressA(slot = 0) {
  ensureAudio();
  if (launching) return;

  const hovered = inputFor(slot).hover;
  if (hovered === 'wii' || hovered === 'qr') { audio.play('menu-select'); return; }
  if (hovered && hovered.dir !== undefined) { turnPage(hovered.dir); return; }
  if (hovered && hovered.game) launch(hovered);
}

function pressB() {
  ensureAudio();
  audio.play('menu-back');
}

function turnPage(dir) {
  const pages = Math.max(1, Math.ceil(games.length / PER_PAGE));
  const next = page + dir;
  if (next < 0 || next >= pages) return;
  page = next;
  buildTiles();
  audio.play('menu-select');
  refreshArrows();
}

function refreshArrows() {
  const pages = Math.max(1, Math.ceil(games.length / PER_PAGE));
  arrows[0].enabled = page > 0;
  arrows[1].enabled = page < pages - 1;
  arrows.forEach(drawArrow);
}

/** A tile's current on-screen rect in CSS pixels. */
function tileScreenRect(tile) {
  const halfH = VIEW_H / 2;
  const halfW = halfH * camera.aspect;
  const w = ((TILE_W * L.scale) / (2 * halfW)) * window.innerWidth;
  const h = ((TILE_H * L.scale) / (2 * halfH)) * window.innerHeight;
  const cx = (tile.home.x / (2 * halfW) + 0.5) * window.innerWidth;
  const cy = (0.5 - tile.home.y / (2 * halfH)) * window.innerHeight;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

function launch(tile) {
  launching = { tile, t: 0 };
  audio.play('channel-launch');
  audio.stopMusic();
  link.feedback({ type: 'launch', game: tile.game.slug });

  // The launch banner: a DOM overlay that grows from the tile's exact rect
  // to full screen. DOM, not the tile texture — the old zoom scaled a small
  // canvas texture up 8× and arrived blurry; text and emoji stay crisp at
  // any size here.
  const [c0, c1] = CHANNEL_ART[tile.game.slug] || ['#9db8d9', '#6f8fbc'];
  const r = tileScreenRect(tile);
  const el = document.createElement('div');
  el.id = 'launch';
  el.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px;`
    + `background:linear-gradient(180deg, ${c0}, ${c1});`;
  el.innerHTML = `<div class="l-emoji">${tile.game.emoji || '🎮'}</div>`
    + `<div class="l-title">${tile.game.title}</div>`;
  document.body.appendChild(el);
  void el.offsetWidth;               // commit the start rect before animating
  el.classList.add('full');

  // The receiving game page opens on this same banner and fades it out — one
  // continuous motion across the navigation, no flash.
  try {
    sessionStorage.setItem('openwii.launch', JSON.stringify({
      slug: tile.game.slug, title: tile.game.title, emoji: tile.game.emoji || '🎮',
      c0, c1, t: Date.now(),
    }));
  } catch { /* storage may be unavailable; the splash just won't carry over */ }
}

// ── Layout ─────────────────────────────────────────────────────────────────
function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const inp of inputs.values()) inp.pointer.setViewport(w, h);

  const halfH = VIEW_H / 2;
  barMesh.position.set(0, -halfH + BAR_H / 2 + 0.18, 0.05);
  rebuildBar();

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
  if (wy < barMesh.position.y + BAR_H / 2 + 0.2 && wy > barMesh.position.y - BAR_H / 2) {
    // The two round bar buttons: OpenWii on the left, the pairing QR right.
    const cy = barMesh.position.y + BAR_H / 2 - BAR_H * 0.56;
    const cx = barW / 2 - BAR_H * 0.62;
    const r = BAR_H * 0.48;
    if (Math.hypot(wx + cx, wy - cy) < r) return 'wii';
    if (Math.hypot(wx - cx, wy - cy) < r) return 'qr';
    return null;
  }
  for (const t of tiles) {
    if (!t.game) continue;
    if (Math.abs(wx - t.home.x) < (TILE_W * L.scale) / 2
      && Math.abs(wy - t.home.y) < (TILE_H * L.scale) / 2) return t;
  }
  return null;
}

/** True while any player's hand is over the given target. */
function anyHover(target) {
  for (const inp of inputs.values()) if (inp.hover === target) return true;
  return false;
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

  // Every connected phone drives its own hand. Slot 0 also accepts the
  // mouse when no phone owns it — the desk-testing fallback, unchanged.
  for (const [slot, inp] of inputs) {
    const ptr = inp.pointer;
    if (!ptr.live && slot === 0 && mouse.active) ptr.setFromMouse(mouse.x, mouse.y);
    if (ptr.live && now - ptr.lastSeen > 500) ptr.live = false;

    const active = ptr.live || (slot === 0 && mouse.active);
    // Per-frame prediction, not the last packet — see Pointer.sampleAt.
    const aim = ptr.sampleAt(now);
    const p = toWorld(aim.x, aim.y);
    // Hang the sprite so the PNG's fingertip sits exactly on the aim point.
    // Both sprite and offset scale with the layout, or the cursor looks
    // enormous on a small window.
    const hk = L.scale;
    inp.hand.scale.setScalar(hk);
    inp.hand.position.set(
      p.x + (0.5 - HAND_TIP.x) * HAND_SIZE * hk,
      p.y - (0.5 - HAND_TIP.y) * HAND_SIZE * hk,
      3 + slot * 0.01,          // stable stacking when hands overlap
    );
    inp.hand.visible = active && !launching;

    inp.hover = (active && !launching) ? hitTest(p.x, p.y) : null;
    if (inp.hover && inp.hover !== inp.lastHover) audio.play('menu-hover');
    inp.lastHover = inp.hover;
  }

  // Idle wobble + hover response — a tile lights up if ANY hand is on it.
  for (const t of tiles) {
    const target = anyHover(t) ? 1 : 0;
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
    const target = anyHover(a) ? 1 : 0;
    const before = a.hover;
    a.hover += (target - a.hover) * Math.min(1, dt * 12);
    if (Math.abs(a.hover - before) > 0.01) drawArrow(a);
    a.mesh.scale.setScalar(L.scale * (1 + a.hover * 0.08));
  }

  wiiButtonPulse += dt * 1.6;
  const wiiTarget = anyHover('wii') ? 1 : 0;
  wiiButtonHover += (wiiTarget - wiiButtonHover) * Math.min(1, dt * 12);
  const qrTarget = anyHover('qr') ? 1 : 0;
  qrHover += (qrTarget - qrHover) * Math.min(1, dt * 12);
  // The transient pill (pointer speed / sound hint) hides itself on time.
  if (speedUntil && now > speedUntil) {
    speedUntil = 0;
    $('speed').classList.remove('on');
  }

  barClock += dt;
  if (barClock > 0.2) { barClock = 0; drawBar(); }

  // Launching: the DOM banner (see launch()) grows over the scene; the menu
  // itself just fades away underneath, then we navigate.
  if (launching) {
    launching.t += dt;
    const k = Math.min(1, launching.t / 0.75);
    const ease = k * k * (3 - 2 * k);
    for (const other of tiles) {
      other.mesh.material.opacity = 1 - ease;
      other.mesh.material.transparent = true;
    }
    barMesh.material.opacity = 1 - ease;
    barMesh.material.transparent = true;
    for (const a of arrows) { a.mesh.material.opacity = 1 - ease; a.mesh.material.transparent = true; }
    if (k >= 1) {
      window.location.href = launching.tile.game.url;
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
    const p0 = inputFor(0).pointer;
    p0.sensitivity = clamp(p0.sensitivity * step, 0.2, 6);
    saveSensitivity(p0.sensitivity);
    showSpeed();
  } else if (e.key.toLowerCase() === 'r') quickRecentre();
  else if (e.key.toLowerCase() === 'c') quickRecentre();
  else if (e.key.toLowerCase() === 'd') $('debug').classList.toggle('on');
});

// ── Boot sequence ──────────────────────────────────────────────────────────
fetch('/api/games').then((r) => r.json()).then((list) => {
  games = list;
  buildTiles();
  refreshArrows();
}).catch(() => { games = []; buildTiles(); refreshArrows(); });

// ── Pairing QR — lives in the bar's right-hand button, and only there ──────
fetch('/api/pairing').then((r) => r.json()).then(({ qr }) => {
  qrImg = new Image();
  qrImg.onload = drawBar;
  qrImg.src = qr;
}).catch(() => {});

const hoverName = (h) => (h === 'wii' ? 'OpenWii button'
  : h === 'qr' ? 'QR button'
    : h && h.dir !== undefined ? 'arrow'
      : h && h.game ? h.game.title : '—');

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  const p0 = inputFor(0).pointer;
  const perPlayer = [...inputs.entries()].map(([slot, inp]) =>
    `P${slot + 1} ${inp.pointer.live ? '⚡' : '·'} ${hoverName(inp.hover)}`).join('  ');
  $('debug').textContent = [
    `fps         ${fps.toFixed(0)}`,
    `pointer     ${p0.display.x.toFixed(3)}, ${p0.display.y.toFixed(3)}`,
    `gyro map    ${p0.describeMap()}`,
    `rate        ${p0.rateDps.yaw.toFixed(1)} / ${p0.rateDps.pitch.toFixed(1)} deg/s`,
    `deg/screen  ${(p0.degPerScreen / p0.sensitivity).toFixed(0)} · gyro ${p0.hasGyro ? 'yes' : 'NO — orientation only'}`,
    `mode        ${p0.mode}`,
    `players     ${perPlayer}`,
    `sensor      ${link.rate.toFixed(0)} Hz`,
    `channels    ${games.length}`,
  ].join('\n');
}, 250);

// Every arrival at the menu — fresh load, reload, or backing out of a game —
// fades in from silver, with the audio joining at the same instant the fade
// begins: the theme starts (and, arriving from a game's HOME press, the HOME
// chime rings) right as the menu appears, not whenever a retry timer lands.
{
  let fromHome = false;
  try {
    const homeAt = Number(sessionStorage.getItem('openwii.home') || 0);
    sessionStorage.removeItem('openwii.home');
    fromHome = Date.now() - homeAt < 4000;
  } catch { /* storage unavailable */ }

  const veil = document.createElement('div');
  veil.style.cssText = 'position:fixed;inset:0;background:#e4eaf1;z-index:999;'
    + 'transition:opacity .45s ease;pointer-events:none;';
  document.body.appendChild(veil);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    veil.style.opacity = '0';
    setTimeout(() => veil.remove(), 550);
    audio.startMusic();              // element route: may start with no gesture
    audio.unlock().then((ok) => {
      if (!ok) return;               // policy still blocks: the retry loop takes over
      // The chime waits for its sampled file so the real HOME sound rings,
      // not the synth stand-in.
      if (fromHome) audio.loadOverride('menu-back').then(() => audio.play('menu-back'));
      audio.startMusic();
    });
  }));
}

drawBar();
resize();
requestAnimationFrame(frame);

window.__openwii = {
  scene, camera, renderer, tiles, arrows, pointer: inputFor(0).pointer, inputs, audio, link,
  hitTest, toWorld, pressA, pressB, step, layout: L,
  state: () => ({
    hovered: inputFor(0).hover,
    hovers: [...inputs.entries()].map(([s, i]) => [s, hoverName(i.hover)]),
    launching: !!launching, page, games, fps,
  }),
};
