import * as THREE from '/vendor/three/three.module.js';
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { axesFromSample, clamp } from '../../core/orientation.js';
import { Duel, AI, swordBasis, bladeScreenAngle } from './logic.js';

/**
 * Swordplay — renderer. The duel runs in logic.js; this file draws it and
 * pipes the phone in: pointer position places the sword, full attitude orients
 * it (roll, pitch, yaw — 1:1), the swing detector turns fast gestures into
 * attacks, and a held blade is the guard.
 */

const $ = (id) => document.getElementById(id);

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd8f0);
scene.fog = new THREE.Fog(0x9fd8f0, 30, 90);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
camera.position.set(0, 1.7, 5.2);
camera.lookAt(0, 1.3, -4);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xfff4d6, 1.4);
sun.position.set(6, 12, 4);
scene.add(sun);

const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// Sea + duel platform.
const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0x2e7fc4, 0.35));
sea.rotation.x = -Math.PI / 2;
sea.position.y = -2.2;
scene.add(sea);

const platform = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.6, 1.2, 24), mat(0xdcd3bd));
platform.position.y = -0.6;
scene.add(platform);
const rim = new THREE.Mesh(new THREE.TorusGeometry(6, 0.18, 8, 32), mat(0xb44f3a));
rim.rotation.x = Math.PI / 2;
rim.position.y = 0.02;
scene.add(rim);

// ── Opponent ───────────────────────────────────────────────────────────────
function makeFencer(colour) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 4, 12), mat(colour));
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), mat(0xf3c89b));
  head.position.y = 1.95;
  g.add(body, head);

  const arm = new THREE.Group();
  arm.position.set(0.5, 1.35, 0.15);
  const swordG = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.16), mat(0xd9dee6, 0.25));
  blade.position.y = 0.95;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.2), mat(0x6b4a2b));
  guard.position.y = 0.18;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.32, 8), mat(0x2b2b33));
  swordG.add(blade, guard, grip);
  arm.add(swordG);
  g.add(arm);
  return { group: g, arm, sword: swordG, body };
}

const foe = makeFencer(0x8e4fd0);
foe.group.position.set(0, 0, -3.6);
foe.group.rotation.y = Math.PI;   // face the player
scene.add(foe.group);

// Telegraph ring: glows red while the AI winds up.
const telegraph = new THREE.Mesh(
  new THREE.RingGeometry(0.85, 1.05, 28),
  new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0 }),
);
telegraph.position.set(0, 1.4, -3.0);
scene.add(telegraph);

// ── Player sword ───────────────────────────────────────────────────────────
const sword = new THREE.Group();
{
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.7, 0.18), mat(0xe8edf4, 0.2));
  blade.position.y = 1.05;
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.7, 0.2), mat(0xffffff, 0.1));
  edge.position.y = 1.05;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.22), mat(0x6b4a2b));
  guard.position.y = 0.2;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.4, 10), mat(0x232733));
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat(0xc9a24a, 0.4));
  pommel.position.y = -0.22;
  sword.add(blade, edge, guard, grip, pommel);
}
sword.scale.setScalar(0.62);
scene.add(sword);

// Until real attitude arrives, rest the blade at a natural forward tilt.
const restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.95, 0.18, 0.12));
sword.quaternion.copy(restQ);

const swordTargetQ = new THREE.Quaternion();
const basisM = new THREE.Matrix4();

// ── Duel wiring ────────────────────────────────────────────────────────────
const swingDetector = new SwingDetector({});
let lastAxes = null;
let swinging = false;
let swingFlash = 0;

const duel = new Duel({ onEvent: handleEvent });

const channel = createChannel({
  onA: () => {
    if (duel.state === 'ready' || duel.state === 'over') startMatch();
  },
  onSample: (sample, dt, now) => {
    lastAxes = axesFromSample(sample);
    const swing = swingDetector.update(channel.pointer.rateDps, dt, now);
    swinging = swingDetector.active;
    duel.setBlade(lastAxes ? bladeScreenAngle(lastAxes) : 0, swinging);
    if (swing) {
      swingFlash = 1;
      duel.swing(swing, now);
    }
  },
});

function startMatch() {
  duel.start(performance.now());
  $('overlay').classList.add('hide');
  syncHud();
}

function banner(text, ms = 1200) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => el.classList.remove('on'), ms);
}

function syncHud() {
  const dots = (n) => '●'.repeat(n) + '○'.repeat(Math.max(0, 3 - n));
  $('p-score').textContent = dots(duel.player.points);
  $('a-score').textContent = dots(duel.ai.points);
}

function handleEvent(e) {
  switch (e.type) {
    case 'point':
      syncHud();
      banner(e.who === 'player' ? 'POINT!' : 'HIT TAKEN');
      channel.feedback({ type: e.who === 'player' ? 'slice' : 'miss' });
      channel.audio.play(e.who === 'player' ? 'swipe' : 'fail');
      break;
    case 'blocked':
      banner('BLOCKED!', 700);
      channel.feedback({ type: 'slice', combo: 1 });
      channel.audio.play('impact');
      clang = 1;
      break;
    case 'parried':
      banner('PARRIED', 600);
      channel.audio.play('impact');
      clang = 1;
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? '🏆 <em>You win!</em>' : '💀 <em>Defeated</em>'}</h1>
        <p>${won ? 'Clean swordwork.' : 'Watch the red ring — turn your blade across the strike.'}</p>
        <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
      $('overlay').classList.remove('hide');
      channel.feedback({ type: won ? 'slice' : 'bomb' });
      channel.audio.play(won ? 'swipe' : 'explode');
      break;
    }
    default: break;
  }
}

let clang = 0;

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let fps = 0;
let frames = 0;
let fpsMark = last;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;
  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }

  const aim = channel.poll(now);
  duel.update(now, dt);
  step(now, dt, aim);
  renderer.render(scene, camera);
}

/** One frame of scene work — split out so verification can drive it. */
function step(now, dt, aim) {
  // Sword position: pointer maps to a window in front of the camera.
  const px = (aim.x - 0.5) * 2.6;
  const py = (0.5 - aim.y) * 1.8 + 1.0;
  sword.position.set(px, py, 3.1);

  // Sword orientation: the phone's attitude, 1:1.
  if (!lastAxes) {
    sword.quaternion.slerp(restQ, Math.min(1, dt * 6));
  }
  if (lastAxes) {
    const b = swordBasis(lastAxes);
    basisM.makeBasis(
      new THREE.Vector3(...b.right),
      new THREE.Vector3(...b.blade),
      new THREE.Vector3(...b.face),
    );
    swordTargetQ.setFromRotationMatrix(basisM);
    sword.quaternion.slerp(swordTargetQ, Math.min(1, dt * 30));
  }

  swingFlash = Math.max(0, swingFlash - dt * 4);
  clang = Math.max(0, clang - dt * 3);

  // Opponent poses per AI state.
  const t = now / 1000;
  foe.body.position.y = 1.0 + Math.sin(t * 2.1) * 0.03;
  let armTargetZ = -duel.aiGuard;                 // guard shows its angle
  let armTargetX = 0.3;
  if (duel.aiState === AI.WINDUP) {
    armTargetZ = -duel.aiStrikeAngle + Math.PI;
    armTargetX = -0.5;                            // raised high, readable
    telegraph.material.opacity = 0.55 + 0.35 * Math.sin(t * 18);
    telegraph.rotation.z = duel.aiStrikeAngle;
  } else {
    telegraph.material.opacity = Math.max(0, telegraph.material.opacity - dt * 4);
  }
  if (duel.aiState === AI.STRIKE) armTargetX = 1.1;      // lunged through
  if (duel.aiState === AI.RECOVER) armTargetX = 0.7;
  foe.arm.rotation.z += (armTargetZ - foe.arm.rotation.z) * Math.min(1, dt * 8);
  foe.arm.rotation.x += (armTargetX - foe.arm.rotation.x) * Math.min(1, dt * 10);
  foe.group.position.z = -3.6 + (duel.aiState === AI.STRIKE ? 0.7 : 0) * 1;

  // Clang shake on blocks/parries.
  camera.position.x = (Math.random() - 0.5) * 0.05 * clang;

  sea.position.x = Math.sin(t * 0.3) * 0.5;
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
    `fps         ${fps.toFixed(0)}`,
    `duel        ${duel.state} · ai ${duel.aiState}`,
    `blade       ${(duel.bladeAngle * 57.3).toFixed(0)}° ${swinging ? '(swinging)' : '(guard)'}`,
    `rate        ${channel.pointer.rateDps.yaw.toFixed(0)}/${channel.pointer.rateDps.pitch.toFixed(0)} dps`,
    `gyro map    ${channel.pointer.describeMap()}`,
    `sensor      ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
requestAnimationFrame(frame);

window.__openwii = {
  duel, channel, pointer: channel.pointer, swingDetector,
  scene, camera, renderer, step, sword, startMatch,
  fps: () => fps,
};
