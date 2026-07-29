import * as THREE from '/vendor/three/three.module.js';
import { createChannel } from '../../core/channel.js';
import { gripTilt, axesFromSample } from '../../core/orientation.js';
import {
  Race, trackCenter, trackTangent, fmtMs,
  RACE_LAPS, TRACK_HALF_WIDTH, SAMPLES,
} from './logic.js';

/**
 * Kart time trial — renderer. Tilt the phone like a wheel to steer; throttle
 * is automatic. Three laps against the clock, your best lap runs as a ghost.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa5d8f3);
scene.fog = new THREE.Fog(0xa5d8f3, 260, 760);

const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1400);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
sun.position.set(150, 300, 120);
scene.add(sun);

const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// ── Ground and circuit ─────────────────────────────────────────────────────
const grass = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), mat(0x5cb463, 0.95));
grass.rotation.x = -Math.PI / 2;
grass.position.y = -0.05;
scene.add(grass);

// Track ribbon: triangle strip between the left and right edges of the
// centreline, with white edge lines and a chequered start line.
{
  const verts = [];
  const makeEdge = (t, side) => {
    const p = trackCenter(t);
    const tan = trackTangent(t);
    return { x: p.x - tan.z * side, z: p.z + tan.x * side };
  };
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = (i % SAMPLES) / SAMPLES;
    const l = makeEdge(t, -TRACK_HALF_WIDTH);
    const r = makeEdge(t, TRACK_HALF_WIDTH);
    verts.push(l.x, 0, l.z, r.x, 0, r.z);
  }
  const idx = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, mat(0x4a4a52, 0.9)));

  const lineFor = (side) => {
    const pts = [];
    for (let i = 0; i <= SAMPLES; i += 1) {
      const e = makeEdge((i % SAMPLES) / SAMPLES, side);
      pts.push(new THREE.Vector3(e.x, 0.06, e.z));
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xf2f2f2 }),
    );
  };
  scene.add(lineFor(-TRACK_HALF_WIDTH + 0.4), lineFor(TRACK_HALF_WIDTH - 0.4));

  // Start line + arch at t = 0.
  const p0 = trackCenter(0);
  const tan0 = trackTangent(0);
  const across = Math.atan2(tan0.x, -tan0.z);
  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2, 3),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
  );
  stripe.rotation.x = -Math.PI / 2;
  stripe.rotation.z = -across;
  stripe.position.set(p0.x, 0.07, p0.z);
  scene.add(stripe);

  const arch = new THREE.Group();
  const post = () => new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 10), mat(0xe23b3b, 0.5));
  const l = post(); l.position.x = -TRACK_HALF_WIDTH; l.position.y = 5;
  const r = post(); r.position.x = TRACK_HALF_WIDTH; r.position.y = 5;
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(TRACK_HALF_WIDTH * 2 + 1.4, 1.6, 1.2), mat(0xf2f5f9, 0.5),
  );
  bar.position.y = 10;
  arch.add(l, r, bar);
  arch.position.set(p0.x, 0, p0.z);
  arch.rotation.y = -across;
  scene.add(arch);
}

// A few trees around the infield and outfield for a sense of speed.
{
  const tree = (x, z, s) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 3, 7), mat(0x7a5233, 0.9));
    trunk.position.y = 1.5;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(2.6, 5.5, 8), mat(0x2f7a3f, 0.9));
    crown.position.y = 5.4;
    g.add(trunk, crown);
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    return g;
  };
  for (let i = 0; i < 42; i += 1) {
    const a = (i / 42) * Math.PI * 2;
    const wobble = Math.sin(i * 3.7) * 26;
    const r = (i % 2 ? 232 : 78) + wobble;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.8;
    if (Math.hypot(trackCenter(0).x - x, trackCenter(0).z - z) < 20) continue;
    scene.add(tree(x, z, 0.8 + ((i * 7) % 10) / 12));
  }
}

// ── Karts ──────────────────────────────────────────────────────────────────
function buildKart(bodyColor, opacity = 1) {
  const g = new THREE.Group();
  const opts = opacity < 1 ? { transparent: true, opacity } : {};
  const m = (c, r = 0.5) => new THREE.MeshStandardMaterial({ color: c, roughness: r, ...opts });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.9), m(bodyColor, 0.4));
  body.position.y = 0.55;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 0.8), m(bodyColor, 0.4));
  nose.position.set(0, 0.5, -1.7);
  const driver = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), m(0xf5d7b0, 0.7));
  driver.position.set(0, 1.25, 0.3);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.46, 10, 8), m(0xf2f5f9, 0.4));
  helmet.position.set(0, 1.32, 0.3);
  helmet.scale.y = 0.8;
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.4, 12);
  for (const [wx, wz] of [[-0.95, -1], [0.95, -1], [-0.95, 1], [0.95, 1]]) {
    const w = new THREE.Mesh(wheelGeo, m(0x232327, 0.9));
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.42, wz);
    g.add(w);
  }
  g.add(body, nose, driver, helmet);
  return g;
}
const kart = buildKart(0xe23b3b);
scene.add(kart);
const ghostKart = buildKart(0x9ecbff, 0.35);
ghostKart.visible = false;
scene.add(ghostKart);

// ── Wiring ─────────────────────────────────────────────────────────────────
const race = new Race({ onEvent: handleEvent });
let started = false;

const channel = createChannel({
  onA: () => { if (!started || race.state === 'done') startRace(); },
  onSample: (sample) => {
    const tilt = gripTilt(axesFromSample(sample));
    race.setSteer(tilt.bank);
  },
});

const keys = {};
window.addEventListener('keydown', (e) => { keys[e.key] = true; });
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

function startRace() {
  started = true;
  race.start(performance.now());
  ghostKart.visible = false;
  $('overlay').classList.add('hide');
  syncHud();
}

function syncHud() {
  $('lap').textContent = `${Math.min(race.lap, RACE_LAPS)} / ${RACE_LAPS}`;
  $('time').textContent = fmtMs(race.state === 'racing' ? race.lapMs : race.lastLapMs);
  $('best').textContent = fmtMs(race.bestLapMs);
}

function handleEvent(e) {
  if (e.type === 'lap') {
    channel.feedback({ type: 'slice', combo: e.best ? 2 : 1 });
    channel.audio.play(e.best ? 'swipe' : 'select');
    syncHud();
  } else if (e.type === 'done') {
    const rows = race.lapTimes.map((ms, i) =>
      `<div>Lap ${i + 1} &nbsp; <strong>${fmtMs(ms)}</strong>${ms === race.bestLapMs ? ' ★' : ''}</div>`).join('');
    $('panel').innerHTML = `<h1>🏁 <em>Finish!</em></h1>
      <p>Total ${fmtMs(e.totalMs)} — best lap ${fmtMs(e.bestMs)}.</p>
      <div class="laps">${rows}</div>
      <div class="cta"><strong>A</strong> race the ghost · <strong>B</strong> menu</div>`;
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
    const bank = (keys.ArrowRight ? 42 : 0) + (keys.ArrowLeft ? -42 : 0);
    if (bank || keys._touched) { race.setSteer(bank); keys._touched = true; }
  }
  race.update(now, dt);
  step(now, dt);
  renderer.render(scene, camera);
}

/** Scene/camera sync — split out for verification. */
function step(now, dt) {
  kart.position.set(race.pos.x, 0, race.pos.z);
  kart.rotation.set(0, 0, 0);
  kart.rotateY(-race.heading + Math.PI);
  kart.rotateZ(-race.steer * Math.PI / 180 * 0.25);   // lean into the tilt

  if (race.state === 'racing' && race.ghost) {
    const g = race.ghostAt(race.lapMs);
    if (g) {
      ghostKart.visible = true;
      ghostKart.position.set(g.x, 0, g.z);
      ghostKart.rotation.set(0, 0, 0);
      ghostKart.rotateY(-g.heading + Math.PI);
    }
  } else {
    ghostKart.visible = false;
  }

  const back = 11;
  const cx = race.pos.x - Math.sin(race.heading) * back;
  const cz = race.pos.z + Math.cos(race.heading) * back;
  camera.position.lerp(new THREE.Vector3(cx, 5.2, cz), Math.min(1, dt * 5));
  camera.lookAt(race.pos.x, 1.6, race.pos.z);

  if (race.state === 'racing' && frames % 6 === 0) syncHud();
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
    `fps      ${fps.toFixed(0)}`,
    `pos      ${race.pos.x.toFixed(0)}, ${race.pos.z.toFixed(0)}`,
    `speed    ${race.speed.toFixed(1)} m/s ${race.onTrack ? 'track' : 'GRASS'}`,
    `steer    ${race.steer.toFixed(0)}°`,
    `lap      ${race.lap}/${RACE_LAPS} cp ${race.nextCp}`,
    `gyro map ${channel.pointer.describeMap()}`,
    `sensor   ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
const s0 = trackCenter(0);
camera.position.set(s0.x, 30, s0.z + 60);
camera.lookAt(s0.x, 0, s0.z);
requestAnimationFrame(frame);

window.__openwii = {
  race, channel, pointer: channel.pointer, scene, camera, renderer, step,
  startRace, kart, ghostKart, fps: () => fps,
};
