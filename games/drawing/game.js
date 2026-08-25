import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { Sketch, TOOLBAR, SIZES } from './logic.js';

/**
 * Sketch — renderer. A sheet of paper and a toolbar; point, hold A, paint.
 * The stroke model and toolbar geometry live in logic.js; this file draws
 * them and wires press/release. Everything is in normalised [0,1] screen
 * coordinates, scaled by the window height so brush sizes stay physical.
 */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

const PAPER = '#fbfaf4';
const sketch = new Sketch({ onEvent: handleEvent });

let vw = 1;
let vh = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  vw = window.innerWidth;
  vh = window.innerHeight;
  canvas.width = vw * dpr;
  canvas.height = vh * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', layout);
layout();

const px = (x) => x * vw;
const py = (y) => y * vh;
const brushPx = (size) => size * vh * 2;   // logic sizes are radii in height units

let aim = { x: 0.5, y: 0.5 };
let penIsDown = false;
let toolFlashUntil = 0;

const channel = createChannel({
  // A is a toggle: one press puts the pen on the paper, the next lifts it —
  // no holding a button through a whole stroke.
  onA: () => {
    // A mouse press may land before the frame loop has sampled the latest
    // mousemove — take the press position from the source, not last frame.
    if (!channel.pointer.live && channel.mouse.active) {
      aim = { x: channel.mouse.x, y: channel.mouse.y };
    }
    if (penIsDown) { liftPen(); return; }
    const res = sketch.penDown(aim.x, aim.y);
    if (res.tool) {
      toolFlashUntil = performance.now() + 250;
      channel.audio.play('select');
      channel.feedback({ type: 'slice', combo: 1 });
    } else {
      penIsDown = true;
      channel.audio.play('hover');
    }
  },
});

// Dev console hook: inspect the stroke model from the console.
window.__debug = { sketch, aim: () => aim };

function liftPen() {
  if (!penIsDown) return;
  penIsDown = false;
  sketch.penUp();
  channel.audio.play('hover');
}

function handleEvent(e) {
  if (e.type === 'clear') channel.audio.play('back');
}

// ── Drawing ────────────────────────────────────────────────────────────────
function drawStrokes() {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const s of sketch.strokes) {
    ctx.strokeStyle = s.erase ? PAPER : s.color;
    ctx.lineWidth = Math.max(1.5, brushPx(s.size));
    ctx.beginPath();
    const pts = s.points;
    ctx.moveTo(px(pts[0].x), py(pts[0].y));
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(px(pts[i].x), py(pts[i].y));
    ctx.stroke();
  }
}

function drawToolbar(now) {
  // A shelf down the left edge behind the tools.
  ctx.fillStyle = '#efe9da';
  ctx.fillRect(0, 0, px(0.055), vh);
  ctx.fillStyle = '#ddd5c2';
  ctx.fillRect(px(0.055), 0, 2, vh);

  for (const e of TOOLBAR) {
    const r = e.rect;
    const x = px(r.x);
    const y = py(r.y);
    const w = px(r.w);
    const h = py(r.h);
    const cx = x + w / 2;
    const cy = y + h / 2;

    const selected = (e.kind === 'color' && !sketch.eraser && sketch.color === e.value)
      || (e.kind === 'size' && sketch.sizeIndex === e.value)
      || (e.kind === 'eraser' && sketch.eraser);

    ctx.fillStyle = selected ? '#ffffff' : '#f7f2e7';
    ctx.strokeStyle = selected ? '#2b2b30' : '#cfc7b2';
    ctx.lineWidth = selected ? 2.5 : 1.5;
    roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();

    if (e.kind === 'color') {
      ctx.fillStyle = e.value;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(w, h) * 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === 'size') {
      ctx.fillStyle = '#2b2b30';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, brushPx(SIZES[e.value]) / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.font = `${Math.round(h * 0.5)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.kind === 'eraser' ? '🧽' : '🗑', cx, cy + 1);
    }
  }
  void now;
}

function drawCursor(now) {
  const x = px(aim.x);
  const y = py(aim.y);
  const r = Math.max(3, brushPx(sketch.brushSize) / 2);
  const flash = now < toolFlashUntil;
  ctx.strokeStyle = sketch.eraser ? '#8a8478' : sketch.color;
  ctx.lineWidth = flash ? 3.5 : 2;
  ctx.beginPath();
  ctx.arc(x, y, r + (flash ? 3 : 0), 0, Math.PI * 2);
  ctx.stroke();
  if (penIsDown) {
    ctx.fillStyle = sketch.eraser ? PAPER : sketch.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// ── Loop ───────────────────────────────────────────────────────────────────
function frame(now) {
  requestAnimationFrame(frame);

  const p = channel.poll(now);
  if (p) aim = p;
  if (penIsDown) sketch.penMove(aim.x, aim.y);

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, vw, vh);
  drawStrokes();
  drawToolbar(now);
  drawCursor(now);

  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    dbg.textContent = `strokes ${sketch.strokes.length}\npen ${penIsDown ? 'down' : 'up'}\n`
      + `color ${sketch.color}\nsize ${sketch.sizeIndex}${sketch.eraser ? ' (eraser)' : ''}`;
  }
}
requestAnimationFrame(frame);
