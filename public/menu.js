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
 * Custom channel artwork, drawn in code — bold, simple shapes in the flat
 * vector style of the real channel tiles. Each painter gets the tile context
 * with the art already clipped and the background gradient down; it draws
 * around (w/2, h*0.42) at a scale derived from h.
 */
const ART_PAINTERS = {
  'fruit-ninja': (g, w, h) => {
    const cx = w / 2;
    const cy = h * 0.44;
    const R = h * 0.30;
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.5);
    softShadow(g);
    // A watermelon half: rind, pith, flesh, seeds.
    const wedge = (r, colour) => {
      g.beginPath();
      g.arc(0, 0, r, Math.PI, 0);
      g.closePath();
      g.fillStyle = colour;
      g.fill();
    };
    wedge(R, '#2c7a33');
    g.shadowColor = 'transparent';
    wedge(R * 0.93, '#8ed06b');
    wedge(R * 0.86, '#f7f3e0');
    wedge(R * 0.8, '#ef4444');
    g.fillStyle = '#26180f';
    for (const [sx, sy, a] of [[-0.45, -0.32, 0.5], [0, -0.5, 0], [0.45, -0.32, -0.5]]) {
      g.save();
      g.translate(R * sx, R * sy * 0.55);
      g.rotate(a);
      g.beginPath();
      g.ellipse(0, 0, R * 0.045, R * 0.08, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.restore();
    // The blade swoosh that just cut it.
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineCap = 'round';
    g.lineWidth = h * 0.028;
    g.beginPath();
    g.moveTo(cx - R * 1.5, cy + R * 0.7);
    g.quadraticCurveTo(cx, cy - R * 1.15, cx + R * 1.55, cy - R * 0.55);
    g.stroke();
    g.restore();
  },

  golf: (g, w, h) => {
    const cx = w / 2;
    const base = h * 0.62;
    // Rolling green.
    softShadow(g);
    g.fillStyle = '#67b34e';
    g.beginPath();
    g.ellipse(cx, base, w * 0.34, h * 0.15, 0, 0, Math.PI * 2);
    g.fill();
    g.shadowColor = 'transparent';
    g.fillStyle = '#7cc95d';
    g.beginPath();
    g.ellipse(cx - w * 0.05, base - h * 0.02, w * 0.3, h * 0.12, 0, 0, Math.PI * 2);
    g.fill();
    // The hole, the pin, the flag.
    const hx = cx + w * 0.1;
    const hy = base - h * 0.015;
    g.fillStyle = '#1d3a24';
    g.beginPath();
    g.ellipse(hx, hy, w * 0.045, h * 0.018, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#f4f6f8';
    g.lineWidth = h * 0.016;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(hx, hy);
    g.lineTo(hx, hy - h * 0.34);
    g.stroke();
    g.fillStyle = '#e23b3b';
    g.beginPath();
    g.moveTo(hx, hy - h * 0.34);
    g.lineTo(hx - w * 0.13, hy - h * 0.285);
    g.lineTo(hx, hy - h * 0.23);
    g.closePath();
    g.fill();
    // The ball, sitting up on the green.
    softShadow(g, 0.2);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx - w * 0.14, hy - h * 0.012, h * 0.036, 0, Math.PI * 2);
    g.fill();
    g.shadowColor = 'transparent';
  },

  'island-flyover': (g, w, h) => {
    const cx = w / 2;
    const sea = h * 0.62;
    // The island: sand rim, green body, snow-capped peak.
    softShadow(g);
    g.fillStyle = '#e8d9a8';
    g.beginPath();
    g.ellipse(cx, sea, w * 0.3, h * 0.1, 0, 0, Math.PI * 2);
    g.fill();
    g.shadowColor = 'transparent';
    g.fillStyle = '#4d9e53';
    g.beginPath();
    g.ellipse(cx, sea - h * 0.02, w * 0.25, h * 0.085, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5f7c6b';
    g.beginPath();
    g.moveTo(cx - w * 0.09, sea - h * 0.03);
    g.lineTo(cx, sea - h * 0.21);
    g.lineTo(cx + w * 0.09, sea - h * 0.03);
    g.closePath();
    g.fill();
    g.fillStyle = '#f4f7f8';
    g.beginPath();
    g.moveTo(cx - w * 0.032, sea - h * 0.145);
    g.lineTo(cx, sea - h * 0.21);
    g.lineTo(cx + w * 0.032, sea - h * 0.145);
    g.closePath();
    g.fill();
    // The plane, banking overhead, with its wake.
    g.save();
    g.translate(cx + w * 0.16, h * 0.2);
    g.rotate(0.12);
    softShadow(g, 0.25);
    g.fillStyle = '#e23b3b';
    g.fillRect(-w * 0.095, -h * 0.012, w * 0.19, h * 0.024);
    g.fillStyle = '#f4f6f9';
    g.beginPath();
    g.ellipse(0, 0, w * 0.06, h * 0.021, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = h * 0.014;
    g.lineCap = 'round';
    g.setLineDash([h * 0.02, h * 0.045]);
    g.beginPath();
    g.moveTo(cx - w * 0.28, h * 0.33);
    g.quadraticCurveTo(cx - w * 0.05, h * 0.28, cx + w * 0.08, h * 0.2);
    g.stroke();
    g.setLineDash([]);
  },

  kart: (g, w, h) => {
    const base = h * 0.58;
    // Track band with the chequered start line.
    g.fillStyle = '#4a4a52';
    g.fillRect(0, base - h * 0.1, w, h * 0.26);
    const sq = h * 0.033;
    for (let r = 0; r < 2; r += 1) {
      for (let x = 0; x < w; x += sq * 2) {
        g.fillStyle = (r + x / (sq * 2)) % 2 < 1 ? '#f2f2f2' : '#1c1c22';
        g.fillRect(x + (r % 2) * sq, base - h * 0.1 + r * sq, sq, sq);
      }
    }
    // The kart: red body, dark wheels, a helmeted driver.
    const cx = w / 2;
    const cy = base + h * 0.045;
    g.save();
    g.translate(cx, cy);
    softShadow(g);
    g.fillStyle = '#d92b1f';
    roundRect(g, -w * 0.14, -h * 0.075, w * 0.28, h * 0.085, h * 0.03);
    g.fill();
    g.fillStyle = '#b81f15';
    roundRect(g, w * 0.1, -h * 0.055, w * 0.075, h * 0.05, h * 0.02);
    g.fill();
    g.shadowColor = 'transparent';
    g.fillStyle = '#f4f6f8';
    g.beginPath();
    g.arc(-w * 0.02, -h * 0.1, h * 0.045, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#22262e';
    for (const wx of [-w * 0.095, w * 0.095]) {
      g.beginPath();
      g.arc(wx, h * 0.02, h * 0.05, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#22262e';
    }
    g.restore();
    // Speed lines.
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = h * 0.016;
    g.lineCap = 'round';
    for (const [y0, x0, x1] of [[cy - h * 0.06, 0.08, 0.2], [cy - h * 0.01, 0.05, 0.16]]) {
      g.beginPath();
      g.moveTo(cx - w * (0.14 + x1), y0);
      g.lineTo(cx - w * (0.14 + x0), y0);
      g.stroke();
    }
  },

  swordplay: (g, w, h) => {
    const cx = w / 2;
    const cy = h * 0.42;
    const blade = (angle) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(angle);
      softShadow(g);
      // Blade with a bright edge and a tapered tip.
      const L = h * 0.34;
      const W = h * 0.05;
      const grad = g.createLinearGradient(-W, 0, W, 0);
      grad.addColorStop(0, '#eef2f6');
      grad.addColorStop(0.5, '#c9d3dd');
      grad.addColorStop(1, '#9fabb9');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(-W / 2, L * 0.55);
      g.lineTo(-W / 2, -L);
      g.lineTo(0, -L - W * 1.4);
      g.lineTo(W / 2, -L);
      g.lineTo(W / 2, L * 0.55);
      g.closePath();
      g.fill();
      g.shadowColor = 'transparent';
      // Guard and grip.
      g.fillStyle = '#caa53d';
      roundRect(g, -W * 1.6, L * 0.55, W * 3.2, W * 0.75, W * 0.35);
      g.fill();
      g.fillStyle = '#3a2c52';
      roundRect(g, -W * 0.55, L * 0.55 + W * 0.75, W * 1.1, L * 0.34, W * 0.5);
      g.fill();
      g.fillStyle = '#caa53d';
      g.beginPath();
      g.arc(0, L * 0.55 + W * 0.75 + L * 0.34 + W * 0.5, W * 0.62, 0, Math.PI * 2);
      g.fill();
      g.restore();
    };
    blade(-0.62);
    blade(0.62);
  },

  'table-tennis': (g, w, h) => {
    const cx = w / 2 - w * 0.04;
    const cy = h * 0.46;
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.5);
    softShadow(g);
    // Handle first, then the blade over it.
    g.fillStyle = '#d9a45c';
    roundRect(g, -h * 0.045, h * 0.16, h * 0.09, h * 0.24, h * 0.045);
    g.fill();
    g.fillStyle = '#e23b3b';
    g.beginPath();
    g.ellipse(0, 0, h * 0.21, h * 0.24, 0, 0, Math.PI * 2);
    g.fill();
    g.shadowColor = 'transparent';
    g.strokeStyle = '#b81f15';
    g.lineWidth = h * 0.02;
    g.beginPath();
    g.ellipse(0, 0, h * 0.185, h * 0.215, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();
    // The ball, mid-flight with a bounce arc.
    softShadow(g, 0.2);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx + w * 0.2, cy - h * 0.2, h * 0.05, 0, Math.PI * 2);
    g.fill();
    g.shadowColor = 'transparent';
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = h * 0.013;
    g.setLineDash([h * 0.015, h * 0.035]);
    g.beginPath();
    g.arc(cx + w * 0.06, cy + h * 0.09, h * 0.34, -1.85, -0.55);
    g.stroke();
    g.setLineDash([]);
  },
};

function softShadow(g, strength = 0.3) {
  g.shadowColor = `rgba(20, 30, 45, ${strength})`;
  g.shadowBlur = 16;
  g.shadowOffsetY = 6;
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

  const paint = ART_PAINTERS[game.slug];
  if (paint) {
    paint(g, w, h);
  } else {
    // Unknown channel: fall back to its emoji, big and centred.
    g.font = `${Math.round(h * 0.42)}px -apple-system, "Apple Color Emoji", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.25)';
    g.shadowBlur = 18;
    g.shadowOffsetY = 6;
    g.fillText(game.emoji || '🎮', w / 2, h * 0.42);
    g.shadowColor = 'transparent';
  }

  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.font = `700 ${Math.round(h * 0.115)}px -apple-system, system-ui, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 2;
  g.fillText(game.title, w / 2, h - pad - 18);
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

  // SD card slot, purely decorative, tucked by the left button.
  roundRect(g, lx + r * 1.45, cy + r * 0.1, r * 0.62, r * 0.52, 5);
  g.fillStyle = '#c2cdda';
  g.fill();
  g.strokeStyle = '#aab7c6';
  g.lineWidth = 2;
  g.stroke();

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
/**
 * The Wii pointer, matched to the original: a chunky white fist with the
 * index finger up, thick slate outline, soft drop shadow, and the player
 * number written large in blue across the palm.
 */
function handTexture(playerColour, playerNum = 1) {
  return makeTexture(1.3, 1.5, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.translate(w * 0.5, h * 0.48);
    const s = w * 0.0062;
    g.scale(s, s);
    g.rotate(-0.12);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const glove = () => {
      g.beginPath();
      // Index finger, pointing up from the left of the fist.
      g.moveTo(-28, -8);
      g.lineTo(-28, -46);
      g.quadraticCurveTo(-28, -58, -19, -58);
      g.quadraticCurveTo(-10, -58, -10, -46);
      g.lineTo(-10, -22);
      // Three folded knuckles rolling over the top of the fist.
      g.quadraticCurveTo(-4, -27, 4, -24);
      g.quadraticCurveTo(12, -30, 20, -22);
      g.quadraticCurveTo(30, -24, 33, -12);
      g.quadraticCurveTo(40, -8, 38, 4);
      // Round fist edge down to the wrist.
      g.quadraticCurveTo(38, 20, 28, 29);
      g.quadraticCurveTo(20, 37, 6, 39);
      g.lineTo(-8, 39);
      g.quadraticCurveTo(-27, 36, -31, 18);
      g.quadraticCurveTo(-34, 3, -28, -8);
      g.closePath();
    };

    // Drop shadow first, then the glove.
    g.save();
    g.translate(4, 7);
    glove();
    g.fillStyle = 'rgba(30, 48, 82, 0.25)';
    g.fill();
    g.restore();

    glove();
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = '#3c4d61';
    g.lineWidth = 10;
    g.stroke();

    // Knuckle creases along the top of the fist.
    g.strokeStyle = 'rgba(60, 77, 97, 0.5)';
    g.lineWidth = 4.5;
    g.beginPath(); g.moveTo(2, -22); g.quadraticCurveTo(6, -15, 4, -8); g.stroke();
    g.beginPath(); g.moveTo(18, -19); g.quadraticCurveTo(22, -12, 20, -5); g.stroke();

    // The player number, big and blue across the palm.
    g.fillStyle = playerColour;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 3;
    g.font = '800 40px -apple-system, "Arial Rounded MT Bold", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(playerNum), 4, 12);
  });
}

const hand = new THREE.Mesh(
  new THREE.PlaneGeometry(1.3, 1.5),
  new THREE.MeshBasicMaterial({ map: handTexture('#3c8cf0').texture, transparent: true, depthTest: false }),
);
hand.renderOrder = 999;
scene.add(hand);

// ── State ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();
const pointer = new Pointer({});
// Pointer speed is a preference, remembered across pages and restarts.
pointer.sensitivity = loadSensitivity() ?? 1;
let lastSample = null;
let lastSampleAt = 0;
let hovered = null;         // tile | arrow | 'wii' | null
let launching = null;       // { tile, t } during zoom-to-fill

// No calibration flow. Rate-based aiming is grip-agnostic and unit/sign
// auto-gaining, so the pointer is live from the first packet: pair and play.

const link = new GameLink({
  onOrientation: (sample) => {
    const now = performance.now();
    const dt = lastSampleAt ? clamp((now - lastSampleAt) / 1000, 1 / 240, 0.1) : 1 / 60;
    lastSampleAt = now;
    lastSample = sample;
    pointer.update(sample, dt, now);
  },
  onCommand: (cmd) => {
    if (cmd.type === 'button' && cmd.button === 'A') pressA();
    else if (cmd.type === 'button' && cmd.button === 'B') pressB();
    else if (cmd.type === 'calibrate' || cmd.type === 'recentre') quickRecentre();
    else if (cmd.type === 'speed') {
      pointer.sensitivity = clamp(pointer.sensitivity * (cmd.factor || 1), 0.2, 6);
      saveSensitivity(pointer.sensitivity);
      showSpeed();
    }
  },
  onPresence: ({ controller }) => {
    const on = controller > 0;
    $('dot').classList.toggle('on', on);
    $('link-t').textContent = on ? 'remote connected' : 'no remote connected';
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

function quickRecentre() {
  ensureAudio();
  pointer.recentre();
  audio.play('select');
}

// ── Interaction ────────────────────────────────────────────────────────────
function pressA() {
  ensureAudio();
  if (launching) return;

  if (hovered === 'wii' || hovered === 'qr') { audio.play('select'); return; }
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
  // The original's cursor is big — nearly half a tile tall.
  const hk = L.scale * 1.28;
  hand.scale.setScalar(hk);
  hand.position.set(p.x + 0.21 * hk, p.y - 0.48 * hk, 3);
  hand.visible = !launching;

  if (!launching) setHover(hitTest(p.x, p.y));
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
  const qrTarget = hovered === 'qr' ? 1 : 0;
  qrHover += (qrTarget - qrHover) * Math.min(1, dt * 12);
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

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  $('debug').textContent = [
    `fps         ${fps.toFixed(0)}`,
    `pointer     ${pointer.display.x.toFixed(3)}, ${pointer.display.y.toFixed(3)}`,
    `lead        ${(pointer.lead*1000).toFixed(0)}ms  vel ${Math.hypot(pointer.vel.x, pointer.vel.y).toFixed(2)}/s`,
    `gyro map    ${pointer.describeMap()}`,
    `rate        ${pointer.rateDps.yaw.toFixed(1)} / ${pointer.rateDps.pitch.toFixed(1)} deg/s`,
    `deg/screen  ${(pointer.degPerScreen / pointer.sensitivity).toFixed(0)} · gyro ${pointer.hasGyro ? 'yes' : 'NO — orientation only'}`,
    `mode        ${pointer.mode}`,
    `hover       ${hovered === 'wii' ? 'OpenWii button' : hovered === 'qr' ? 'QR button' : hovered && hovered.dir !== undefined ? 'arrow' : hovered && hovered.game ? hovered.game.title : '—'}`,
    `sensor      ${link.rate.toFixed(0)} Hz`,
    `channels    ${games.length}`,
  ].join('\n');
}, 250);

drawBar();
resize();
requestAnimationFrame(frame);

window.__openwii = {
  scene, camera, renderer, tiles, arrows, pointer, audio, link,
  hitTest, toWorld, pressA, pressB, step, layout: L,
  state: () => ({ hovered, launching: !!launching, page, games, fps }),
};
