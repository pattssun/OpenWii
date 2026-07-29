import * as THREE from '/vendor/three/three.module.js';
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import {
  Hole, HOLE, GREEN_RADIUS, terrainHeight, PAR, pickClub,
} from './logic.js';

/**
 * Golf — renderer. One par-4 hole from logic.js. Aim with the pointer,
 * swing the phone to strike; the club is chosen for you by distance.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8d8ef);
scene.fog = new THREE.Fog(0xa8d8ef, 120, 420);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
sun.position.set(40, 90, 30);
scene.add(sun);

// ── Terrain mesh from the logic's height function ──────────────────────────
const W = 170;
const L = 330;                     // z from +40 (behind tee) to −290
const SEG_X = 60;
const SEG_Z = 120;
const geo = new THREE.PlaneGeometry(W, L, SEG_X, SEG_Z);
geo.rotateX(-Math.PI / 2);
{
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i) - 125;   // shift plane so it spans +40..−290
    pos.setZ(i, z);
    pos.setY(i, terrainHeight(x, z));

    const dHole = Math.hypot(x - HOLE.x, z - HOLE.z);
    // Fairway corridor from tee to green; rough outside; bright green pad.
    const t = Math.min(1, Math.max(0, -z / -HOLE.z));
    const corridorX = HOLE.x * t;
    const offFairway = Math.abs(x - corridorX);
    if (dHole < GREEN_RADIUS) c.setHex(0x7ed957);
    else if (offFairway < 14 && z < 5 && z > HOLE.z - 6) c.setHex(0x58b368);
    else c.setHex(0x3d7a4a);
    // A little height-based shading so the roll reads.
    const h = terrainHeight(x, z);
    c.offsetHSL(0, 0, h * 0.012);
    colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
}
const ground = new THREE.Mesh(
  geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
);
scene.add(ground);

const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// Cup + flag.
const cup = new THREE.Mesh(new THREE.CircleGeometry(0.6, 20),
  new THREE.MeshBasicMaterial({ color: 0x14261a }));
cup.rotation.x = -Math.PI / 2;
cup.position.set(HOLE.x, terrainHeight(HOLE.x, HOLE.z) + 0.02, HOLE.z);
scene.add(cup);
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 8), mat(0xf2f5f9, 0.4));
pole.position.set(HOLE.x, terrainHeight(HOLE.x, HOLE.z) + 1.7, HOLE.z);
scene.add(pole);
const flag = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.0, 4),
  new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.6, side: THREE.DoubleSide }));
flag.rotation.z = -Math.PI / 2;
flag.position.set(HOLE.x + 0.55, terrainHeight(HOLE.x, HOLE.z) + 3.0, HOLE.z);
scene.add(flag);

const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), mat(0xffffff, 0.3));
scene.add(ball);

// Aim arrow: a thin chevron on the ground pointing along the shot line.
const aimArrow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 3.2, 4),
  new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.9 }));
scene.add(aimArrow);

// ── Wiring ─────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 130, minTravel: 22 });
const hole = new Hole({ onEvent: handleEvent });
let started = false;

const channel = createChannel({
  onA: () => {
    if (!started || hole.state === 'holed') startRound();
  },
  onSample: (sample, dt, now) => {
    const s = swing.update(channel.pointer.rateDps, dt, now);
    if (s && started && hole.state === 'aim') {
      const power = Math.min(1, s.peak / 480);
      hole.strike(power);
      channel.feedback({ type: 'slice', combo: 1 });
      channel.audio.play('impact');
      flashPower(power);
    }
  },
});

function startRound() {
  started = true;
  hole.state = 'aim';
  hole.strokes = 0;
  hole.ball = { x: 0, y: terrainHeight(0, 0), z: 0, vx: 0, vy: 0, vz: 0 };
  $('overlay').classList.add('hide');
  syncHud();
}

function flashPower(p) {
  const el = $('power');
  el.style.width = `${Math.round(p * 100)}%`;
  el.parentElement.classList.add('on');
  clearTimeout(flashPower.t);
  flashPower.t = setTimeout(() => el.parentElement.classList.remove('on'), 1200);
}

const SCORE_NAMES = { '-2': 'EAGLE', '-1': 'BIRDIE', 0: 'PAR', 1: 'BOGEY', 2: 'DOUBLE BOGEY' };

function handleEvent(e) {
  if (e.type === 'strike') syncHud();
  else if (e.type === 'settled') {
    syncHud();
    $('banner').textContent = e.onGreen ? 'ON THE GREEN' : `${e.distance.toFixed(0)}m to the pin`;
    $('banner').classList.add('on');
    clearTimeout(handleEvent.t);
    handleEvent.t = setTimeout(() => $('banner').classList.remove('on'), 1400);
  } else if (e.type === 'holed') {
    const diff = e.strokes - PAR;
    const name = SCORE_NAMES[diff] ?? (diff > 0 ? `+${diff}` : `${diff}`);
    $('panel').innerHTML = `<h1>⛳ <em>${name}!</em></h1>
      <p>Holed in ${e.strokes} (par ${PAR}).</p>
      <div class="cta"><strong>A</strong> play again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    channel.audio.play('swipe');
  }
}

function syncHud() {
  $('strokes').textContent = `stroke ${hole.strokes + (hole.state === 'aim' ? 1 : 0)} · par ${PAR}`;
  $('club').textContent = pickClub(hole.ball);
  $('dist').textContent = `${hole.distanceToHole().toFixed(0)}m`;
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let fps = 0; let frames = 0; let fpsMark = last;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;
  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }

  const aim = channel.poll(now);
  if (hole.state === 'aim') hole.aimOffset = (aim.x - 0.5) * 0.7;
  hole.update(now, dt);
  step(now, dt);
  renderer.render(scene, camera);
}

/** Scene/camera sync — split out for verification. */
function step(now, dt) {
  const b = hole.ball;
  ball.position.set(b.x, b.y + 0.16, b.z);

  const heading = hole.headingToHole() + hole.aimOffset;
  aimArrow.visible = started && hole.state === 'aim';
  if (aimArrow.visible) {
    const ax = b.x + Math.sin(heading) * 5;
    const az = b.z - Math.cos(heading) * 5;
    aimArrow.position.set(ax, terrainHeight(ax, az) + 0.4, az);
    aimArrow.rotation.set(-Math.PI / 2, 0, 0);
    aimArrow.rotation.y = -heading + Math.PI;
    aimArrow.rotateX(-Math.PI / 2);
  }

  // Chase camera: behind the ball along the shot line; closer for putts.
  const putter = pickClub(b) === 'putter';
  const back = putter ? 6 : 14;
  const height = putter ? 3 : 7;
  const cx = b.x - Math.sin(heading) * back;
  const cz = b.z + Math.cos(heading) * back;
  const cy = Math.max(terrainHeight(cx, cz) + 1.5, b.y + height);
  camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 3));
  camera.lookAt(b.x, b.y + 1, b.z);

  flag.rotation.y = now / 900;
}

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  channel.pointer.setViewport(w, h);
}
window.addEventListener('resize', resize);

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  $('debug').textContent = [
    `fps       ${fps.toFixed(0)}`,
    `state     ${hole.state} · strokes ${hole.strokes}`,
    `ball      ${hole.ball.x.toFixed(1)}, ${hole.ball.z.toFixed(1)} (${hole.distanceToHole().toFixed(1)}m out)`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
camera.position.set(0, terrainHeight(0, 14) + 8, 14);
camera.lookAt(0, 0, -40);
requestAnimationFrame(frame);

window.__openwii = {
  hole, channel, pointer: channel.pointer, scene, camera, renderer, step, startRound,
  fps: () => fps,
};
