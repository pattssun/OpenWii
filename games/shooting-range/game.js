import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import {
  Range, FIELD_W, FIELD_H, ROUND_MS, TARGET_TTL_MS, pointsFor,
} from './logic.js';

/**
 * Shooting Range — renderer. A flat carnival gallery drawn on 2D canvas:
 * ring targets pop up on sticks, the crosshair is the pointer, A fires.
 * All rules live in logic.js; this file only draws.
 */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

const range = new Range({ onEvent: handleEvent });
let started = false;

// Screen mapping: the FIELD (1.6×1) letterboxed into the window.
let view = { x: 0, y: 0, w: 1, h: 1, s: 1 };
function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = Math.min(w / FIELD_W, h / FIELD_H) * 0.94;
  view = { x: (w - FIELD_W * s) / 2, y: (h - FIELD_H * s) / 2, w, h, s };
}
window.addEventListener('resize', layout);
layout();

const fx = (x) => view.x + x * view.s;             // field → screen
const fy = (y) => view.y + y * view.s;
const toField = (px, py) => ({                     // pointer [0,1] → field
  x: (px * view.w - view.x) / view.s,
  y: (py * view.h - view.y) / view.s,
});

// Transient effects the renderer owns.
const bursts = [];      // { x, y, r, age, points }
const misses = [];      // { x, y, age }
let flashAge = 1;
let aim = { x: 0.5, y: 0.5 };

const channel = createChannel({
  onA: () => {
    if (!started || range.state === 'done') { startRound(); return; }
    fire();
  },
});

// Dev console hook: inspect targets and the field mapping from the console.
window.__debug = { range, view: () => view, aim: () => aim };

function startRound() {
  started = true;
  range.start(performance.now());
  bursts.length = 0;
  misses.length = 0;
  $('overlay').classList.add('hide');
}

function fire() {
  if (range.state !== 'running') return;
  // A mouse press may land before the frame loop has sampled the latest
  // mousemove — take the shot position from the source, not last frame.
  if (!channel.pointer.live && channel.mouse.active) {
    aim = { x: channel.mouse.x, y: channel.mouse.y };
  }
  const p = toField(aim.x, aim.y);
  flashAge = 0;
  channel.audio.play('impact');
  channel.feedback({ type: 'slice', combo: 1 });
  range.shoot(p.x, p.y, performance.now());
}

function handleEvent(e) {
  if (e.type === 'hit') {
    bursts.push({ x: e.target.x, y: e.target.y, r: e.target.r, age: 0, points: e.points });
    channel.audio.play(e.points >= 35 ? 'swipe' : 'select');
  } else if (e.type === 'miss') {
    misses.push({ x: e.x, y: e.y, age: 0 });
    channel.audio.play('back');
  } else if (e.type === 'done') {
    const pct = Math.round(e.accuracy * 100);
    $('panel').innerHTML = `<h1>🎯 <em>Time!</em></h1>
      <div>
        <span class="stat"><b>${e.score}</b><span>score</span></span>
        <span class="stat"><b>${e.hits}/${e.shots}</b><span>hits</span></span>
        <span class="stat"><b>${pct}%</b><span>accuracy</span></span>
      </div>
      <div class="cta"><strong>A</strong> shoot again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    channel.audio.play('select');
  }
}

// ── Drawing ────────────────────────────────────────────────────────────────
function drawBackdrop() {
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, '#2b4257');
  g.addColorStop(0.75, '#1a2a38');
  g.addColorStop(1, '#14202c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);

  // Gallery frame and wooden counter.
  ctx.fillStyle = '#0e1822';
  ctx.fillRect(fx(0) - 14, fy(0) - 14, FIELD_W * view.s + 28, FIELD_H * view.s + 28);
  const wall = ctx.createLinearGradient(0, fy(0), 0, fy(FIELD_H));
  wall.addColorStop(0, '#31485d');
  wall.addColorStop(1, '#243748');
  ctx.fillStyle = wall;
  ctx.fillRect(fx(0), fy(0), FIELD_W * view.s, FIELD_H * view.s);
  const counter = ctx.createLinearGradient(0, fy(FIELD_H) - 0.09 * view.s, 0, fy(FIELD_H));
  counter.addColorStop(0, '#8a5a3b');
  counter.addColorStop(1, '#6e4227');
  ctx.fillStyle = counter;
  ctx.fillRect(fx(0), fy(FIELD_H) - 0.07 * view.s, FIELD_W * view.s, 0.07 * view.s);
}

function drawTarget(t, now) {
  const age = now - t.bornMs;
  const left = t.expiresMs - now;
  // Pop in over 160ms, sag and shrink over the last 350ms.
  let k = Math.min(1, age / 160);
  k = 1 - (1 - k) * (1 - k);
  if (left < 350) k *= Math.max(0, left / 350);
  if (k <= 0) return;

  const x = fx(t.x);
  const y = fy(t.y);
  const r = t.r * view.s * k;

  for (const [rr, color] of [[1, '#e23b3b'], [0.66, '#f4f7fa'], [0.33, '#e23b3b']]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#c9302c';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
}

function drawEffects(dt) {
  for (let i = bursts.length - 1; i >= 0; i -= 1) {
    const b = bursts[i];
    b.age += dt;
    const k = b.age / 0.55;
    if (k >= 1) { bursts.splice(i, 1); continue; }
    const x = fx(b.x);
    const y = fy(b.y);
    ctx.strokeStyle = `rgba(255, 214, 100, ${1 - k})`;
    ctx.lineWidth = 3;
    for (let a = 0; a < 8; a += 1) {
      const ang = (a / 8) * Math.PI * 2;
      const r0 = b.r * view.s * (0.6 + k * 1.6);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * r0 * 0.6, y + Math.sin(ang) * r0 * 0.6);
      ctx.lineTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(255, 240, 200, ${1 - k})`;
    ctx.font = `800 ${Math.round(0.045 * view.s)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`+${b.points}`, x, y - b.r * view.s - (0.02 + k * 0.05) * view.s);
  }
  for (let i = misses.length - 1; i >= 0; i -= 1) {
    const m = misses[i];
    m.age += dt;
    const k = m.age / 0.4;
    if (k >= 1) { misses.splice(i, 1); continue; }
    ctx.strokeStyle = `rgba(180, 200, 220, ${0.7 * (1 - k)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx(m.x), fy(m.y), (0.012 + k * 0.03) * view.s, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCrosshair(now) {
  const x = aim.x * view.w;
  const y = aim.y * view.h;
  const r = 0.028 * view.s * (flashAge < 0.08 ? 1.35 : 1);
  ctx.strokeStyle = '#ffe9a8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * r * 0.55, y + dy * r * 0.55);
    ctx.lineTo(x + dx * r * 1.45, y + dy * r * 1.45);
  }
  ctx.stroke();
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fill();
  if (flashAge < 0.08) {
    ctx.fillStyle = `rgba(255, 240, 190, ${0.5 * (1 - flashAge / 0.08)})`;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  void now;
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;

  const p = channel.poll(now);
  if (p) aim = p;
  flashAge += dt;
  range.update(now);

  drawBackdrop();
  for (const t of range.targets) drawTarget(t, now);
  drawEffects(dt);
  drawCrosshair(now);

  if (range.state === 'running') {
    const leftS = Math.max(0, (ROUND_MS - (now - range.startMs)) / 1000);
    $('score').textContent = range.score;
    $('meta').textContent = `${leftS.toFixed(1)}s · ${range.hits}/${range.shots} hits`;
  }

  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    dbg.textContent = `state ${range.state}\ntargets ${range.targets.length}\n`
      + `ttl ${TARGET_TTL_MS}ms\npoints ${pointsFor(0.035)}–${pointsFor(0.085)}`;
  }
}
requestAnimationFrame(frame);

// Launching from the menu goes straight into the round — no instruction
// screen; the first target holds off a moment while the splash fades.
startRound();
range.nextSpawnMs = performance.now() + 1600;
