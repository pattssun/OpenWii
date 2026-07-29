import * as THREE from '/vendor/three/three.module.js';
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { Rally, TABLE, PLAYER_Z, AI_Z } from './logic.js';

/**
 * Table Tennis — renderer. The rally runs in logic.js; the pointer IS the
 * paddle, and a swing at contact time adds pace to the return.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2b45);
scene.fog = new THREE.Fog(0x1b2b45, 12, 30);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
camera.position.set(0, 2.05, PLAYER_Z + 1.9);
camera.lookAt(0, 0.75, -1.2);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(3, 8, 4);
scene.add(key);

const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// Hall floor + table.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat(0x24314f, 0.9));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE.WIDTH, 0.06, TABLE.LENGTH), mat(0x1f6e46, 0.6),
);
tableTop.position.y = TABLE.HEIGHT - 0.03;
scene.add(tableTop);
for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, TABLE.HEIGHT, 0.07), mat(0x27313f));
  leg.position.set(dx * (TABLE.WIDTH / 2 - 0.12), TABLE.HEIGHT / 2 - 0.03, dz * (TABLE.LENGTH / 2 - 0.15));
  scene.add(leg);
}
// White lines: border + centre.
const lineMat = mat(0xf2f5f9, 0.4);
const mkLine = (w, d, x, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.005, d), lineMat);
  m.position.set(x, TABLE.HEIGHT + 0.003, z);
  scene.add(m);
};
mkLine(TABLE.WIDTH, 0.03, 0, TABLE.LENGTH / 2 - 0.015);
mkLine(TABLE.WIDTH, 0.03, 0, -TABLE.LENGTH / 2 + 0.015);
mkLine(0.03, TABLE.LENGTH, TABLE.WIDTH / 2 - 0.015, 0);
mkLine(0.03, TABLE.LENGTH, -TABLE.WIDTH / 2 + 0.015, 0);
mkLine(0.02, TABLE.LENGTH, 0, 0);

const net = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE.WIDTH + 0.3, TABLE.NET, 0.02),
  new THREE.MeshStandardMaterial({ color: 0xcdd6e2, roughness: 0.9, transparent: true, opacity: 0.85 }),
);
net.position.set(0, TABLE.HEIGHT + TABLE.NET / 2, 0);
scene.add(net);

// Paddles.
function makePaddle(colour) {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.025, 24), mat(colour, 0.5));
  face.rotation.x = Math.PI / 2;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.16, 10), mat(0xc9a06a));
  grip.position.y = -0.19;
  g.add(face, grip);
  return g;
}
const paddle = makePaddle(0xd23c3c);
scene.add(paddle);
const aiPaddle = makePaddle(0x2f6fe4);
aiPaddle.position.set(0, TABLE.HEIGHT + 0.18, AI_Z);
scene.add(aiPaddle);

const ball = new THREE.Mesh(new THREE.SphereGeometry(0.033, 14, 12), mat(0xfff8ea, 0.25));
scene.add(ball);
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.05, 16),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
);
shadow.rotation.x = -Math.PI / 2;
scene.add(shadow);

// ── Wiring ─────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 120, minTravel: 18 });
const rally = new Rally({ onEvent: handleEvent });

const channel = createChannel({
  onA: () => { if (rally.state === 'ready' || rally.state === 'over') startGame(); },
  onSample: (sample, dt, now) => {
    const s = swing.update(channel.pointer.rateDps, dt, now);
    if (s) rally.swing(s.peak);
  },
});

function startGame() {
  rally.start(performance.now());
  $('overlay').classList.add('hide');
  syncHud();
}

function banner(text, ms = 1000) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => el.classList.remove('on'), ms);
}

function syncHud() {
  $('p-score').textContent = rally.score.player;
  $('a-score').textContent = rally.score.ai;
}

function handleEvent(e) {
  switch (e.type) {
    case 'hit':
      if (e.by === 'player') { channel.feedback({ type: 'slice', combo: 1 }); channel.audio.play('impact'); }
      else channel.audio.play('impact');
      break;
    case 'point':
      syncHud();
      banner(e.who === 'player' ? 'YOUR POINT' : 'RIVAL POINT');
      channel.feedback({ type: e.who === 'player' ? 'slice' : 'miss' });
      channel.audio.play(e.who === 'player' ? 'swipe' : 'fail');
      break;
    case 'serve':
      banner(e.who === 'player' ? 'your serve' : 'rival serves', 700);
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? '🏆 <em>Game!</em>' : '🏓 <em>Game lost</em>'}</h1>
        <p>${won ? `Longest rally: ${rally.longestRally} hits.` : 'Meet the ball with the paddle — position first, pace second.'}</p>
        <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
      $('overlay').classList.remove('hide');
      channel.feedback({ type: won ? 'slice' : 'bomb' });
      break;
    }
    default: break;
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

  const aim = channel.poll(now);
  rally.setPaddle(aim.x, aim.y);
  rally.update(now, dt);
  step(now, dt);
  renderer.render(scene, camera);
}

/** Scene sync — split out for verification. */
function step(now, dt) {
  paddle.position.set(rally.paddle.x, rally.paddle.y, PLAYER_Z);
  paddle.rotation.z = -rally.paddle.x * 0.4;
  aiPaddle.position.x = rally.aiPaddle.x;

  ball.visible = rally.ballLive;
  shadow.visible = rally.ballLive;
  if (rally.ballLive) {
    ball.position.set(rally.ball.x, rally.ball.y, rally.ball.z);
    const overTable = Math.abs(rally.ball.x) < TABLE.WIDTH / 2
      && Math.abs(rally.ball.z) < TABLE.LENGTH / 2;
    shadow.position.set(rally.ball.x, (overTable ? TABLE.HEIGHT : 0) + 0.004, rally.ball.z);
  }
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
    `state     ${rally.state} · hits ${rally.hits} (best ${rally.longestRally})`,
    `ball      ${rally.ball.x.toFixed(2)}, ${rally.ball.y.toFixed(2)}, ${rally.ball.z.toFixed(2)}`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
requestAnimationFrame(frame);

window.__openwii = {
  rally, channel, pointer: channel.pointer, scene, camera, renderer, step, startGame,
  fps: () => fps,
};
