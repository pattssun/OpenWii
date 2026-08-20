import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { gripTilt, axesFromSample } from '../../core/orientation.js';
import {
  Flight, islandHeight, SEA_LEVEL, POINT_COUNT,
} from './logic.js';

/**
 * Island Flyover — renderer. Hold the phone like a paper plane: bank to turn,
 * tip to climb and dive. Fly through all the rings.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cd4f5);
scene.fog = new THREE.Fog(0x9cd4f5, 250, 900);

const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 1600);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xfff0cd, 1.6);
sun.position.set(200, 400, 100);
scene.add(sun);

// ── Island terrain ─────────────────────────────────────────────────────────
{
  const SIZE = 1100;
  const SEG = 130;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = islandHeight(x, z);
    pos.setY(i, h);
    if (h < SEA_LEVEL - 2) c.setHex(0x1e5f8e);          // sea bed
    else if (h < SEA_LEVEL + 0.6) c.setHex(0xe7d9a8);   // beach
    else if (h < 10) c.setHex(0x63b56b);                // lowland
    else if (h < 24) c.setHex(0x3f8a52);                // forest
    else if (h < 36) c.setHex(0x8a8577);                // rock
    else c.setHex(0xf2f5f7);                            // snow cap
    const shade = 1 + Math.sin(x * 0.09) * Math.cos(z * 0.07) * 0.05;
    colours[i * 3] = c.r * shade;
    colours[i * 3 + 1] = c.g * shade;
    colours[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(
    geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  );
  scene.add(ground);
}
const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(2400, 2400),
  new THREE.MeshStandardMaterial({ color: 0x2f86c9, roughness: 0.35, transparent: true, opacity: 0.92 }),
);
sea.rotation.x = -Math.PI / 2;
sea.position.y = SEA_LEVEL;
scene.add(sea);

const mat = (c, r = 0.6) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// ── The plane ──────────────────────────────────────────────────────────────
const plane = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.9, 5, 8), mat(0xf2f5f9, 0.4));
  body.rotation.x = -Math.PI / 2;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(9, 0.16, 1.7), mat(0xe23b3b, 0.5));
  wing.position.z = 0.3;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.14, 1), mat(0xe23b3b, 0.5));
  tail.position.set(0, 0.35, 2.3);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 1), mat(0xf2f5f9, 0.5));
  fin.position.set(0, 0.7, 2.3);
  plane.add(body, wing, tail, fin);
}
scene.add(plane);

// ── Rings ──────────────────────────────────────────────────────────────────
const flight = new Flight({ onEvent: handleEvent });
const ringMeshes = new Map();
const ringGeo = new THREE.TorusGeometry(7, 0.8, 10, 28);
function buildRings() {
  for (const m of ringMeshes.values()) scene.remove(m);
  ringMeshes.clear();
  for (const p of flight.points) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
      color: 0xffd25e, roughness: 0.35, emissive: 0x996b1a, emissiveIntensity: 0.6,
    }));
    m.position.set(p.x, p.y, p.z);
    scene.add(m);
    ringMeshes.set(p.id, m);
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────
let started = false;
const channel = createChannel({
  onA: () => { if (!started || flight.state === 'done') startFlight(); },
  onSample: (sample) => {
    const tilt = gripTilt(axesFromSample(sample));
    flight.setTilt(tilt.bank, tilt.pitch);
  },
});

// Keyboard fallback for desk testing: arrows steer.
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.key] = true; });
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

function startFlight() {
  started = true;
  flight.start(performance.now());
  buildRings();
  $('overlay').classList.add('hide');
  syncHud();
}

function syncHud() {
  $('count').textContent = `${flight.collected} / ${POINT_COUNT}`;
  const s = Math.floor(flight.elapsedMs / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function handleEvent(e) {
  if (e.type === 'collect') {
    const m = ringMeshes.get(e.id);
    if (m) scene.remove(m);
    channel.feedback({ type: 'slice', combo: 1 });
    channel.audio.play('select');
    syncHud();
  } else if (e.type === 'done') {
    const s = (e.ms / 1000).toFixed(1);
    $('panel').innerHTML = `<h1>🛩 <em>Full sweep!</em></h1>
      <p>All ${POINT_COUNT} i-points in ${s}s.</p>
      <div class="cta"><strong>A</strong> fly again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    channel.audio.play('swipe');
  }
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

  channel.poll(now);
  if (!channel.pointer.live) {
    // Desk fallback: arrow keys.
    const bank = (keys.ArrowRight ? 40 : 0) + (keys.ArrowLeft ? -40 : 0);
    const pitch = (keys.ArrowUp ? 25 : 0) + (keys.ArrowDown ? -25 : 0);
    if (bank || pitch || keys._touched) { flight.setTilt(bank, pitch); keys._touched = true; }
  }
  flight.update(now, dt);
  step(now, dt);
  renderer.render(scene, camera);
}

/** Scene/camera sync — split out for verification. */
function step(now, dt) {
  plane.position.set(flight.pos.x, flight.pos.y, flight.pos.z);
  plane.rotation.set(0, 0, 0);
  plane.rotateY(-flight.heading);
  plane.rotateX(-flight.pitch);
  plane.rotateZ(-flight.bankVis * 1.2);

  for (const [id, m] of ringMeshes) {
    m.rotation.y = now / 700 + id;
    m.position.y = flight.points[id].y + Math.sin(now / 500 + id) * 0.8;
  }

  // Chase camera.
  const back = 16;
  const cx = flight.pos.x - Math.sin(flight.heading) * back;
  const cz = flight.pos.z + Math.cos(flight.heading) * back;
  const cy = flight.pos.y + 5 - flight.pitch * 8;
  camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 4));
  camera.lookAt(flight.pos.x, flight.pos.y + 1, flight.pos.z);

  if (flight.state === 'flying' && frames % 15 === 0) syncHud();
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
    `pos       ${flight.pos.x.toFixed(0)}, ${flight.pos.y.toFixed(0)}, ${flight.pos.z.toFixed(0)}`,
    `tilt      bank ${flight.input.bank.toFixed(0)}° pitch ${flight.input.pitch.toFixed(0)}°`,
    `collected ${flight.collected}/${POINT_COUNT}`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
camera.position.set(0, 90, 560);
camera.lookAt(0, 20, 0);
requestAnimationFrame(frame);

window.__openwii = {
  flight, channel, pointer: channel.pointer, scene, camera, renderer, step,
  startFlight, ringMeshes, fps: () => fps,
};
