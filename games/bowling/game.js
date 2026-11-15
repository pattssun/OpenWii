import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash, goHome } from '../../core/splash.js';
import { AudioEngine } from '../../core/audio.js';
import { GameLink } from '../../core/net.js';
import {
  LANE, Match, rack, scoreFrames, marks, totalScore, nextRoll,
} from './logic.js';
import { StanceCalibration, ThrowTracker } from './throw.js';

consumeLaunchSplash();

/**
 * Bowling — renderer, input wiring and game flow. The rules live in logic.js
 * and the swing maths in throw.js; this file turns phone packets into throws
 * and turns match events into pictures, sound and haptics.
 */

const $ = (id) => document.getElementById(id);
const COLORS = ['#ff6a3d', '#3d9bff'];
const NAMES = ['Player 1', 'Player 2'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

// ── Audio ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();
const sfx = (fn) => { try { if (audio.ctx && audio.ctx.state === 'running') fn(); } catch { /* sound is optional */ } };
const sound = {
  tick: () => sfx(() => audio.tone({ freq: 880, dur: 0.07, gain: 0.12, type: 'triangle' })),
  ready: () => sfx(() => { audio.tone({ freq: 660, dur: 0.12, gain: 0.16 }); audio.tone({ freq: 990, dur: 0.2, gain: 0.16, delay: 0.1 }); }),
  grip: () => sfx(() => audio.noise({ dur: 0.08, gain: 0.12, freq: 900, type: 'lowpass' })),
  release: (p) => sfx(() => audio.noise({ dur: 0.35, gain: 0.1 + p * 0.15, type: 'bandpass', freq: 500, sweepTo: 150 })),
  rolling: (v, gutter) => sfx(() => audio.noise({ dur: 0.14, gain: gutter ? 0.1 : 0.07 + v * 0.008, type: 'lowpass', freq: gutter ? 260 : 340 + v * 40 })),
  crash: (s) => sfx(() => {
    audio.noise({ dur: 0.7, gain: 0.35 + s * 0.3, type: 'highpass', freq: 1500, sweepTo: 600 });
    audio.noise({ dur: 0.5, gain: 0.25, type: 'bandpass', freq: 2400, q: 2 });
    audio.tone({ freq: 130, dur: 0.25, gain: 0.3, type: 'square', slideTo: 60 });
  }),
  pin: () => sfx(() => audio.tone({ freq: 700 + Math.random() * 900, dur: 0.06, gain: 0.07, type: 'square' })),
  gutter: () => sfx(() => audio.tone({ freq: 110, dur: 0.5, gain: 0.3, type: 'sawtooth', slideTo: 55 })),
  strike: () => sfx(() => [523, 659, 784, 1047, 1319].forEach((f, i) => audio.tone({ freq: f, dur: 0.28, gain: 0.2, delay: i * 0.09, type: 'triangle' }))),
  spare: () => sfx(() => [523, 784, 1047].forEach((f, i) => audio.tone({ freq: f, dur: 0.24, gain: 0.18, delay: i * 0.1, type: 'triangle' }))),
  turn: () => sfx(() => audio.tone({ freq: 740, dur: 0.14, gain: 0.12 })),
};

// ── Phones ─────────────────────────────────────────────────────────────────
const pads = [0, 1].map((slot) => {
  const calib = new StanceCalibration();
  return {
    slot, calib, tracker: new ThrowTracker(calib),
    connected: false, held: false, buttons: {}, sample: null, lastAt: 0,
  };
});
const link = new GameLink({
  onOrientation: (sample, slot) => {
    const pad = pads[slot];
    if (!pad) return;
    pad.sample = sample;
    pad.lastAt = performance.now();
    if (sample.buttons) { pad.buttons = sample.buttons; pad.held = !!sample.buttons.A; }
    onSample(pad, sample);
  },
  onCommand: (cmd, slot) => {
    const pad = pads[slot];
    if (!pad) return;
    onCommand(pad, cmd);
  },
  onPresence: (p) => {
    for (const pad of pads) {
      const was = pad.connected;
      pad.connected = !!p.slots?.[pad.slot]?.occupied;
      if (was && !pad.connected) { pad.calib.reset(); pad.tracker.reset(); pad.held = false; pad.buttons = {}; }
    }
    sendProfiles();
  },
});
/** Ask each phone to stream held buttons — the same "wheel" profile Mario Kart uses. */
function sendProfiles(profile = 'wheel') {
  for (const pad of pads) if (pad.connected || profile === 'default') link.feedback({ type: 'controller-profile', profile, slot: pad.slot });
}
setInterval(sendProfiles, 850);
window.addEventListener('pagehide', () => { for (const pad of pads) link.feedback({ type: 'controller-profile', profile: 'default', slot: pad.slot }); });

/** Haptics: the phone vibrates (Android Chrome; iOS Safari has no vibration API). */
function haptic(slot, pattern) {
  if (slot == null) return;
  link.feedback({ type: 'rumble', pattern, slot });
}

// ── Game state ─────────────────────────────────────────────────────────────
const ui = {
  phase: 'lobby',            // lobby | play | over
  players: 1,
  slots: [0],                // player index → phone slot
  match: null,
  x0: [0, 0],                // each bowler's chosen spot on the foul line (m)
  lockUntil: 0,              // brief pause while a result is shown
  autostartAt: 0,
  kb: { held: false, since: 0, aim: 0, hook: 0, speedBoost: 0 },
  gripped: false,
  banner: 0,
  lastRoll: null,
  holdUntil: 0,
};
const padOf = (player) => pads[ui.slots[player]];
const now = () => performance.now();

function onCommand(pad, cmd) {
  audio.unlock?.();
  if (cmd.type === 'home') { goHome(audio); return; }
  if (cmd.type === 'recentre' || cmd.type === 'calibrate') {
    pad.calib.reset();
    pad.tracker.reset();
    haptic(pad.slot, [15]);
    return;
  }
  if (cmd.type === 'buttons') { pad.buttons = cmd.buttons || {}; pad.held = !!pad.buttons.A; return; }
  if (cmd.type === 'button-up') { pad.buttons[cmd.button] = false; if (cmd.button === 'A') pad.held = false; return; }
  if (cmd.type === 'button' && cmd.pressed !== false) {
    pad.buttons[cmd.button] = true;
    if (cmd.button === 'A') { pad.held = true; confirm(pad); }
    if (cmd.button === 'B' && ui.phase === 'over') goHome(audio);
  }
}

/** A / Enter: start from the lobby, or bowl again from the results. */
function confirm(pad) {
  if (ui.phase === 'lobby') {
    const connected = pads.filter((p) => p.connected);
    const ready = connected.every((p) => p.calib.ready);
    if (ready && (connected.length === 0 || pad == null || pad.calib.ready)) startMatch();
  } else if (ui.phase === 'over' && now() > ui.lockUntil) {
    startMatch();
  }
}

function onSample(pad, sample) {
  const t = now();
  if (!pad.calib.ready) {
    if (pad.calib.update(sample, t)) { haptic(pad.slot, [20, 60, 20]); sound.ready(); }
    return;
  }
  if (ui.phase !== 'play') return;
  const match = ui.match;
  if (!match || match.state !== 'aim' || t < ui.lockUntil) return;
  if (padOf(match.current) !== pad) return;
  const ev = pad.tracker.update(sample, t, pad.held);
  if (!ev) return;
  if (ev.type === 'grip') { ui.gripped = true; haptic(pad.slot, [12]); sound.grip(); }
  else if (ev.type === 'cancel') { ui.gripped = false; showHint('Swing your arm, then let go of A'); }
  else if (ev.type === 'throw') {
    ui.gripped = false;
    haptic(pad.slot, [20 + Math.round(ev.power * 50)]);
    sound.release(ev.power);
    match.throwBall({ x0: ui.x0[match.current], angle: ev.angle, speed: ev.speed, hook: ev.hook });
  }
}

function startMatch() {
  const connected = pads.filter((p) => p.connected);
  ui.slots = connected.length ? connected.map((p) => p.slot) : [0];
  ui.players = ui.slots.length;
  ui.x0 = [0, 0];
  ui.phase = 'play';
  $('lobby').hidden = true;
  $('over').hidden = true;
  $('board').hidden = false;
  $('turn').hidden = false;
  ui.match = new Match({ players: ui.players, onEvent: onMatchEvent });
  ball.material = ballMats[0];
  arrow.userData.mat.color.set(COLORS[0]);
  resetPins(rack(), true);
  renderBoard();
  updateTurnPanel();
  ui.lockUntil = now() + 400;
}

// ── Keyboard (current bowler; also the way to test without a phone) ───────
const keys = new Set();
window.addEventListener('keydown', (e) => {
  audio.unlock?.();
  if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
  keys.add(e.code);
  if (e.code === 'Enter') confirm(null);
  if (e.code === 'Escape' || e.code === 'KeyB') goHome(audio);
  if (e.code === 'Space') {
    e.preventDefault();
    if (ui.phase === 'lobby') { confirm(null); return; }
    if (ui.phase === 'over') { confirm(null); return; }
    if (canAct()) { ui.kb.held = true; ui.kb.since = now(); ui.gripped = true; sound.grip(); }
  }
  if (e.code === 'KeyR') for (const p of pads) if (p.connected) { p.calib.reset(); p.tracker.reset(); }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space' && ui.kb.held) {
    ui.kb.held = false;
    ui.gripped = false;
    if (!canAct()) return;
    const power = kbPower(now());
    const m = ui.match;
    sound.release(power);
    haptic(padOf(m.current)?.slot, [20 + Math.round(power * 50)]);
    m.throwBall({ x0: ui.x0[m.current], angle: ui.kb.aim, speed: 3 + power * 7.2, hook: ui.kb.hook });
  }
});
const canAct = () => ui.phase === 'play' && ui.match?.state === 'aim' && now() >= ui.lockUntil;
const kbPower = (t) => 0.5 - 0.5 * Math.cos(((t - ui.kb.since) / 1000) * Math.PI * 1.3);

function pollMovement(dt) {
  if (!canAct()) return;
  const m = ui.match;
  const pad = padOf(m.current);
  let dx = 0;
  if (keys.has('KeyZ')) dx -= 1;
  if (keys.has('KeyX')) dx += 1;
  if (pad?.buttons.left) dx -= 1;
  if (pad?.buttons.right) dx += 1;
  if (dx) ui.x0[m.current] = clamp(ui.x0[m.current] + dx * 0.4 * dt, -0.45, 0.45);
  let da = 0;
  if (keys.has('ArrowLeft')) da -= 1;
  if (keys.has('ArrowRight')) da += 1;
  ui.kb.aim = clamp(ui.kb.aim + da * 0.05 * dt, -0.07, 0.07);
  let dh = 0;
  if (keys.has('KeyQ')) dh -= 1;
  if (keys.has('KeyE')) dh += 1;
  ui.kb.hook = clamp(ui.kb.hook + dh * 1.4 * dt, -1, 1);
}

// ── Three.js scene ─────────────────────────────────────────────────────────
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b16);
scene.fog = new THREE.Fog(0x070b16, 14, 34);
const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 80);
// The rules use +x for the bowler's right. A camera looking down +z sees +x on its
// left, so everything lives in a group mirrored in x.
const world = new THREE.Group();
world.scale.x = -1;
scene.add(world);

scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x1a1020, 0.55));
const spot = new THREE.SpotLight(0xfff1d6, 90, 30, 0.55, 0.5, 1.6);
spot.position.set(0, 5.2, 15.5);
spot.target.position.set(0, 0, 18.3);
spot.castShadow = true;
spot.shadow.mapSize.set(1024, 1024);
spot.shadow.bias = -0.0004;
world.add(spot, spot.target);
for (const z of [2, 7, 12]) {
  const l = new THREE.PointLight(0xffe8c4, 7, 14, 1.6);
  l.position.set(0, 3.2, z);
  world.add(l);
}

function woodTexture({ approach = false } = {}) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 1024;
  const g = c.getContext('2d');
  const boards = 39;
  for (let i = 0; i < boards; i += 1) {
    const x = (i / boards) * c.width;
    const hue = 28 + ((i * 7) % 6);
    const light = (approach ? 58 : 66) + ((i * 13) % 9) - 4;
    g.fillStyle = `hsl(${hue} 62% ${light}%)`;
    g.fillRect(x, 0, c.width / boards + 1, c.height);
    g.fillStyle = 'rgba(70,35,10,.28)';
    g.fillRect(x, 0, 1.2, c.height);
  }
  for (let i = 0; i < 1400; i += 1) {
    g.fillStyle = `rgba(80,40,10,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1.4, 10 + Math.random() * 40);
  }
  if (!approach) {
    // Arrows and dots, the way a real lane is marked (canvas y runs foul line → pins).
    g.fillStyle = 'rgba(40,20,6,.7)';
    for (let i = -3; i <= 3; i += 1) {
      const x = c.width / 2 + i * (c.width / 13);
      const y = 1024 * (4.57 / 19.5) + Math.abs(i) * 12 * -1 + 36;
      g.beginPath(); g.moveTo(x, y - 24); g.lineTo(x - 7, y + 4); g.lineTo(x + 7, y + 4); g.fill();
    }
    for (const dy of [2.1, 3.4]) for (let i = -3; i <= 3; i += 1) {
      g.beginPath(); g.arc(c.width / 2 + i * (c.width / 13), 1024 * (dy / 19.5), 2.4, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#1b1008';
    g.fillRect(0, 0, c.width, 5);                 // foul line
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Lane, approach, gutters, pit and the room around them.
const laneLen = LANE.pitZ;
const lane = new THREE.Mesh(
  new THREE.PlaneGeometry(LANE.halfWidth * 2, laneLen),
  new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.28, metalness: 0.05 }),
);
lane.rotation.x = -Math.PI / 2;
lane.position.set(0, 0, laneLen / 2);
lane.receiveShadow = true;
world.add(lane);
const approach = new THREE.Mesh(
  new THREE.PlaneGeometry(LANE.halfWidth * 2 + 0.9, 4.5),
  new THREE.MeshStandardMaterial({ map: woodTexture({ approach: true }), roughness: 0.4 }),
);
approach.rotation.x = -Math.PI / 2;
approach.position.set(0, 0.001, -2.25);
approach.receiveShadow = true;
world.add(approach);
const darkMat = new THREE.MeshStandardMaterial({ color: 0x0c0f18, roughness: 0.8 });
for (const side of [-1, 1]) {
  const gutter = new THREE.Mesh(new THREE.PlaneGeometry(LANE.gutterWidth, laneLen), new THREE.MeshStandardMaterial({ color: 0x151a26, roughness: 0.5 }));
  gutter.rotation.x = -Math.PI / 2;
  gutter.position.set(side * (LANE.halfWidth + LANE.gutterWidth / 2), -0.045, laneLen / 2);
  gutter.receiveShadow = true;
  world.add(gutter);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, laneLen + 4.5), darkMat);
  wall.position.set(side * (LANE.halfWidth + LANE.gutterWidth + 0.04), 0.3, (laneLen - 4.5) / 2);
  world.add(wall);
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.03, laneLen),
    new THREE.MeshBasicMaterial({ color: side < 0 ? 0xff6a3d : 0x3d9bff }),
  );
  strip.position.set(side * (LANE.halfWidth + LANE.gutterWidth + 0.09), 0.66, laneLen / 2);
  world.add(strip);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), new THREE.MeshStandardMaterial({ color: 0x0a0e1a, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -0.12, 10);
world.add(floor);
const pit = new THREE.Mesh(new THREE.BoxGeometry(LANE.halfWidth * 2 + 1, 1.2, 1.6), new THREE.MeshStandardMaterial({ color: 0x05070d, roughness: 1 }));
pit.position.set(0, 0.45, laneLen + 0.8);
world.add(pit);
const curtain = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.8), new THREE.MeshBasicMaterial({ color: 0x1a0f2e }));
curtain.position.set(0, 1.6, laneLen + 1.65);
world.add(curtain);
for (let i = 0; i < 6; i += 1) {
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 0.1), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffd9a0 : 0xa0d4ff }));
  bar.position.set(0, 3.7, 1.5 + i * 3.6);
  world.add(bar);
}

// Pins: lathe profile with two red neck stripes.
function pinGeometry() {
  const profile = [
    [0, 0], [0.0185, 0], [0.032, 0.006], [0.046, 0.05], [0.0605, 0.115], [0.0535, 0.17],
    [0.0345, 0.226], [0.0262, 0.262], [0.0258, 0.292], [0.0315, 0.334], [0.0258, 0.37], [0, 0.381],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(profile, 20);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const stripe = (y > 0.236 && y < 0.252) || (y > 0.262 && y < 0.278);
    col.set(stripe ? [0.85, 0.08, 0.1] : [0.97, 0.97, 0.94], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
const pinGeo = pinGeometry();
const pinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.02 });
const pinViews = new Map();
for (const p of rack()) {
  const mesh = new THREE.Mesh(pinGeo, pinMat);
  mesh.castShadow = true;
  mesh.visible = false;
  world.add(mesh);
  pinViews.set(p.id, { mesh, fall: 0, down: false, dir: { x: 0, z: 1 }, scale: 1, pop: 0, sweep: 0 });
}

function ballTexture(color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(255,255,255,.22)';
  for (let i = 0; i < 6; i += 1) { g.beginPath(); g.ellipse(32 + i * 44, 64, 10, 52, 0.4, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.beginPath(); g.arc(205, 50, 7, 0, Math.PI * 2); g.arc(222, 58, 7, 0, Math.PI * 2); g.arc(212, 74, 7, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ballMats = COLORS.map((c) => new THREE.MeshStandardMaterial({ map: ballTexture(c), roughness: 0.12, metalness: 0.25 }));
const ball = new THREE.Mesh(new THREE.SphereGeometry(LANE.ballRadius, 40, 28), ballMats[0]);
ball.castShadow = true;
world.add(ball);
const ballQuat = new THREE.Quaternion();

// Aim arrow on the lane.
const arrow = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 3.4), mat);
  shaft.rotation.x = -Math.PI / 2;
  shaft.position.set(0, 0, 1.9);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 3), mat);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, 0, 3.75);
  arrow.add(shaft, head);
  arrow.userData.mat = mat;
}
world.add(arrow);

// ── Pin state, shared by "between rolls" and "during a roll" ───────────────
function resetPins(list, pop = false) {
  const ids = new Set(list.map((p) => p.id));
  for (const [id, v] of pinViews) {
    v.fall = 0; v.down = false; v.scale = 1; v.sweep = 0; v.pop = pop ? 0.001 : 0;
    v.mesh.visible = ids.has(id);
    v.mesh.quaternion.identity();
    const p = list.find((q) => q.id === id);
    if (p) v.mesh.position.set(p.x, 0, p.z);
    v.mesh.scale.setScalar(pop ? 0.001 : 1);
  }
}

function drawPins(dt, simPins) {
  for (const [id, v] of pinViews) {
    if (!v.mesh.visible) continue;
    const sp = simPins?.find((p) => p.id === id);
    if (sp) {
      if (sp.out && !v.out) { v.out = true; v.sweep = 0.001; }
      if (sp.down && !v.down) {
        v.down = true;
        const s = Math.hypot(sp.vx, sp.vz);
        v.dir = s > 0.1 ? { x: sp.vx / s, z: sp.vz / s } : { x: 0, z: 1 };
      }
      v.pos = { x: sp.x, z: sp.z };
    }
    if (v.down && v.fall < 1) v.fall = Math.min(1, v.fall + dt * 5);
    if (v.sweep > 0) { v.sweep += dt * 2.5; v.mesh.scale.setScalar(Math.max(0.001, 1 - v.sweep)); if (v.sweep >= 1) v.mesh.visible = false; }
    if (v.pop > 0 && v.pop < 1) { v.pop = Math.min(1, v.pop + dt * 5); v.mesh.scale.setScalar(v.pop); }
    const base = v.pos || { x: v.mesh.position.x, z: v.mesh.position.z };
    const f = v.fall;
    if (f > 0) {
      const axis = new THREE.Vector3(v.dir.z, 0, -v.dir.x);
      v.mesh.quaternion.setFromAxisAngle(axis, f * Math.PI / 2);
      v.mesh.position.set(base.x - v.dir.x * 0.19 * f, 0.062 * f, base.z - v.dir.z * 0.19 * f);
    } else {
      v.mesh.quaternion.identity();
      v.mesh.position.set(base.x, 0, base.z);
    }
  }
}

/** After a roll: let the result sit on screen, then sweep the fallen pins away. */
function clearFallen(standing) {
  const ids = new Set(standing.map((p) => p.id));
  for (const [id, v] of pinViews) {
    if (!v.mesh.visible) continue;
    if (!ids.has(id)) { if (v.sweep === 0) v.sweep = 0.001; } else { v.fall = 0; v.down = false; v.out = false; v.mesh.quaternion.identity(); v.pos = null; }
  }
  for (const p of standing) { const v = pinViews.get(p.id); v.mesh.position.set(p.x, 0, p.z); v.pos = { x: p.x, z: p.z }; }
}

// ── HUD ────────────────────────────────────────────────────────────────────
function renderBoard() {
  const m = ui.match;
  if (!m) return;
  const board = $('board');
  board.innerHTML = '';
  for (let p = 0; p < m.playerCount; p += 1) {
    const frames = scoreFrames(m.rolls[p]);
    const nr = nextRoll(m.rolls[p]);
    const row = document.createElement('div');
    row.className = `row${p === m.current && m.state !== 'over' ? ' active' : ''}`;
    row.style.setProperty('--c', COLORS[p]);
    row.innerHTML = `<div class="who"><i></i>P${p + 1}</div>`
      + frames.map((f, i) => {
        const mk = marks(f, i).map((x) => `<span class="${x === 'X' ? 'x' : ''}">${x}</span>`).join('');
        const now = p === m.current && !nr.done && nr.frame === i + 1 ? ' now' : '';
        return `<div class="frame${now}"><div class="marks">${mk}</div><div class="total">${f.score ?? ''}</div></div>`;
      }).join('')
      + `<div class="sum">${totalScore(m.rolls[p])}</div>`;
    board.append(row);
  }
}

let hintTimer = 0;
function showHint(text, ms = 2600) {
  const h = $('hint');
  h.textContent = text;
  h.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { if (ui.phase === 'play') updateTurnPanel(); else h.hidden = true; }, ms);
}
function showBanner(text, color) {
  const b = $('banner');
  b.textContent = text;
  b.style.setProperty('--c', color);
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
}

function updateTurnPanel() {
  const m = ui.match;
  if (!m || m.state === 'over') return;
  const pos = nextRoll(m.rolls[m.current]);
  const t = $('turn');
  t.style.setProperty('--c', COLORS[m.current]);
  $('turn-name').textContent = ui.players > 1 ? NAMES[m.current] : 'Your turn';
  $('turn-detail').textContent = `Frame ${pos.frame} · ${['first ball', 'second ball', 'bonus ball'][Math.min(pos.roll, 2)]}`;
  const pad = padOf(m.current);
  $('hint').hidden = false;
  ui.persistHint = true;
  $('hint').textContent = pad?.connected
    ? 'Hold A · swing your arm · let go of A to bowl · D-pad ◀ ▶ moves your spot'
    : 'Hold Space and release to bowl · ←/→ aim · Q/E hook · Z/X move';
}

function updateLinks() {
  const box = $('links');
  const rows = [0, 1].map((slot) => {
    const pad = pads[slot];
    const state = !pad.connected ? 'no phone' : pad.calib.ready ? 'calibrated' : 'calibrating…';
    return `<div class="link"><span class="dot ${pad.connected ? 'on' : ''}"></span>P${slot + 1} <span class="cal">${state}</span></div>`;
  }).join('');
  if (box.dataset.sig !== rows) { box.dataset.sig = rows; box.innerHTML = rows; }
}

function updateLobby() {
  const cards = $('cards');
  const rows = pads.map((pad) => {
    const c = COLORS[pad.slot];
    let state;
    let tick = '';
    if (!pad.connected) state = 'Open the controller on your phone to join.';
    else if (pad.calib.ready) { state = 'Stance saved.'; tick = '✓ Ready'; }
    else state = pad.calib.status;
    const pct = !pad.connected ? 0 : pad.calib.ready ? 100 : Math.round(pad.calib.progress * 100);
    return `<div class="card ${pad.calib.ready && pad.connected ? 'ready' : ''}" style="--c:${c}"><h2>Player ${pad.slot + 1}<span>${pad.connected ? 'phone connected' : 'waiting'}</span></h2>`
      + `<div class="state">${state}</div><div class="bar"><i style="width:${pct}%"></i></div><div class="tick">${tick || '&nbsp;'}</div></div>`;
  }).join('');
  if (cards.dataset.sig !== rows) { cards.dataset.sig = rows; cards.innerHTML = rows; }

  const connected = pads.filter((p) => p.connected);
  const allReady = connected.length > 0 && connected.every((p) => p.calib.ready);
  const cta = $('lobby-cta');
  if (connected.length === 0) cta.innerHTML = 'No phone yet — press <b>Space</b> or <b>Enter</b> to play with the keyboard.';
  else if (!allReady) cta.innerHTML = 'Everyone with a phone has to calibrate before the game starts. <b>R</b> recalibrates.';
  else if (connected.length === 2) cta.innerHTML = 'Both players ready — starting…';
  else cta.innerHTML = 'Press <b>A</b> to start solo, or let Player 2 connect and calibrate.';

  if (connected.length === 2 && allReady) {
    if (!ui.autostartAt) ui.autostartAt = now() + 1400;
    if (now() > ui.autostartAt) { ui.autostartAt = 0; startMatch(); }
  } else ui.autostartAt = 0;
}

// ── Match events → picture, sound, touch ───────────────────────────────────
let rollTimer = 0;
function onMatchEvent(e) {
  const m = ui.match;
  const pad = e.player != null ? padOf(e.player) : null;
  switch (e.type) {
    case 'turn':
      ball.material = ballMats[e.player];
      arrow.userData.mat.color.set(COLORS[e.player]);
      updateTurnPanel();
      renderBoard();
      if (ui.players > 1) { haptic(padOf(e.player)?.slot, [25, 70, 25]); sound.turn(); }
      pads.forEach((p) => p.tracker.reset());
      break;
    case 'throw':
      cam.mode = 'follow';
      ballQuat.identity();
      rollTimer = 0;
      break;
    case 'ballHit':
      cam.shake = 0.5 + e.speed * 0.05;
      sound.crash(clamp(e.speed / 9, 0, 1));
      haptic(pad?.slot, [70, 30, 110]);
      break;
    case 'pinDown':
      sound.pin();
      break;
    case 'gutter':
      sound.gutter();
      haptic(pad?.slot, [220]);
      break;
    case 'roll': {
      cam.mode = 'pins';
      ui.holdUntil = now() + 2300;
      ui.lockUntil = now() + 2400;
      const last3 = e.rolls.slice(-3);
      let text = null;
      if (e.strike) text = last3.length === 3 && last3.every((x) => x === 10) ? 'TURKEY!' : 'STRIKE!';
      else if (e.spare) text = 'SPARE!';
      else if (e.gutter) text = 'GUTTER BALL';
      else text = e.pins === 0 ? 'MISS' : `${e.pins} PIN${e.pins === 1 ? '' : 'S'}`;
      showBanner(text, COLORS[e.player]);
      if (e.strike) { sound.strike(); haptic(pad?.slot, [60, 50, 60, 50, 60, 50, 180]); }
      else if (e.spare) { sound.spare(); haptic(pad?.slot, [60, 40, 110]); }
      else if (!e.gutter) haptic(pad?.slot, [18 + e.pins * 7]);
      renderBoard();
      setTimeout(() => {
        if (ui.match !== m) return;
        if (m.pins.length === 10) resetPins(m.pins, e.pins > 0);
        else clearFallen(m.pins);
      }, 2200);
      break;
    }
    case 'over': {
      setTimeout(() => {
        if (ui.match !== m) return;
        ui.phase = 'over';
        ui.lockUntil = now() + 900;
        $('hint').hidden = true;
        ui.persistHint = false;
        const [a, b] = e.totals;
        const res = $('result');
        if (e.winner === 'tie') res.textContent = 'It’s a tie!';
        else if (e.winner === null) res.textContent = `You scored ${a}`;
        else res.textContent = `${NAMES[e.winner]} wins!`;
        $('final').innerHTML = e.totals.map((t, i) => `<div class="${e.winner === i ? 'win' : ''}" style="--c:${COLORS[i]}"><span>${ui.players > 1 ? NAMES[i] : 'Score'}</span><span>${t}</span></div>`).join('');
        $('over').hidden = false;
        $('board').hidden = false;
      }, 2600);
      break;
    }
    default:
  }
}

// ── Camera ─────────────────────────────────────────────────────────────────
const cam = { mode: 'aim', shake: 0, pos: new THREE.Vector3(0, 1.2, -3.2), look: new THREE.Vector3(0, 0.1, 10) };

function updateCamera(dt) {
  const m = ui.match;
  const x0 = m ? ui.x0[m.current] : 0;
  let wantPos;
  let wantLook;
  if (cam.mode === 'follow' && m?.sim) {
    const b = m.sim.ball;
    const z = clamp(b.z - 3.4, -3.2, 12.6);
    wantPos = new THREE.Vector3(b.x * 0.45, lerp(1.2, 0.85, clamp(b.z / 10, 0, 1)), z);
    wantLook = new THREE.Vector3(b.x * 0.3, 0.25, clamp(b.z + 7, 6, 19));
  } else if (cam.mode === 'pins') {
    wantPos = new THREE.Vector3(0.35, 1.5, 13.4);
    wantLook = new THREE.Vector3(0, 0.15, 18.6);
  } else {
    wantPos = new THREE.Vector3(x0 * 0.55, 1.18, -3.3);
    wantLook = new THREE.Vector3(x0 * 0.2, 0.1, 10.5);
  }
  if (!m || (m.state === 'aim' && cam.mode !== 'aim' && now() > ui.holdUntil)) cam.mode = 'aim';
  const k = ease(dt, cam.mode === 'follow' ? 6 : 3.2);
  cam.pos.lerp(wantPos, k);
  cam.look.lerp(wantLook, k);
  camera.position.set(-cam.pos.x, cam.pos.y, cam.pos.z);
  if (cam.shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * cam.shake * 0.06;
    camera.position.y += (Math.random() - 0.5) * cam.shake * 0.05;
    cam.shake *= Math.exp(-dt * 7);
  }
  camera.lookAt(-cam.look.x, cam.look.y, cam.look.z);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 1.4 ? 66 : 52;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ── Frame loop ─────────────────────────────────────────────────────────────
let last = performance.now();
let rollSound = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  const m = ui.match;

  if (ui.phase === 'lobby') updateLobby();
  updateLinks();
  pollMovement(dt);
  if (ui.phase === 'play' && m?.state === 'aim') {
    const cur = padOf(m.current);
    if (cur?.connected && !cur.calib.ready) {
      $('hint').hidden = false;
      $('hint').textContent = `${NAMES[m.current]}: ${cur.calib.status}`;
      ui.hintCal = true;
    } else if (ui.hintCal) { ui.hintCal = false; updateTurnPanel(); }
  }

  if (m && m.state === 'rolling') m.update(dt);
  else if (m && m.state === 'aim') m.update(dt);

  // Ball + arrow.
  const rolling = m?.state === 'rolling' && m.sim;
  if (rolling) {
    const b = m.sim.ball;
    ball.visible = !b.done || b.z < LANE.headPinZ + 0.6;
    ball.position.set(b.x, LANE.ballRadius, b.z);
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0.05) {
      const axis = new THREE.Vector3(b.vz, 0, -b.vx).normalize();
      ballQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (sp * dt) / LANE.ballRadius));
      ball.quaternion.copy(ballQuat);
    }
    arrow.visible = false;
    rollSound += dt;
    if (rollSound > 0.11 && !b.done) { rollSound = 0; sound.rolling(sp, b.gutter !== 0); }
    drawPins(dt, m.sim.pins);
  } else {
    drawPins(dt, null);
    const aiming = m?.state === 'aim' && ui.phase === 'play' && t > ui.lockUntil;
    ball.visible = aiming;
    arrow.visible = aiming;
    if (aiming) {
      const x0 = ui.x0[m.current];
      const pad = padOf(m.current);
      let aim = ui.kb.aim;
      let live = '';
      if (pad?.connected && pad.calib.ready && pad.sample) {
        const deg = pad.tracker.liveAim(pad.sample);
        aim = (deg * Math.PI) / 180;
        const hook = pad.tracker.liveHook(t);
        const side = (v, l, r) => (Math.abs(v) < 0.5 ? 'straight' : v > 0 ? r : l);
        live = `Aim ${Math.abs(deg).toFixed(1)}° ${side(deg, 'left', 'right')}`
          + (ui.gripped ? ` · Hook ${Math.round(Math.abs(hook) * 100)}% ${side(hook * 2, 'left', 'right')}` : '');
      }
      $('turn-live').textContent = live;
      const lift = ui.gripped ? 0.18 + 0.05 * Math.sin(t / 90) : 0;
      ball.position.set(x0, LANE.ballRadius + lift, -0.3);
      arrow.position.set(x0, 0.01, 0);
      arrow.rotation.y = aim;
      arrow.userData.mat.opacity = ui.gripped ? 0.85 : 0.45;
      if (ui.kb.held) {
        $('meter').classList.add('on');
        $('meter-fill').style.width = `${kbPower(t) * 100}%`;
      }
    }
  }
  if (!ui.kb.held) $('meter').classList.remove('on');
  if (!(m?.state === 'aim' && ui.phase === 'play')) $('turn-live').textContent = '';

  updateCamera(dt);
  renderer.render(scene, camera);
}

resetPins(rack(), false);
ball.visible = false;
arrow.visible = false;
requestAnimationFrame(frame);

// Debug hooks for the end-to-end tests.
window.__bowling = { ui, pads, get match() { return ui.match; }, startMatch };
