import {itemRoulette} from "./item-roulette.js";
import { QUALITY, renderScale, duoRenderScale, gpuInfo, loadQuality, performanceMeter } from './graphics.js';
import {raceEffects} from "./race-effects.js";
import {itemPortraits} from "./item-portraits.js";
import {raceLettering,racePosition,lapBoard} from "./hud-lettering.js";
import {boostScreen,createBoostFeedback} from "./boost-screen.js";
import { loadSourceWorld } from './source-world.js';
import { RoundedBoxGeometry } from "/vendor/three-examples/geometries/RoundedBoxGeometry.js";
import { makeHoverGlow, updateHoverGlow } from "./hover-effects.js";
import { updateDriverLook } from "./driver-look.js";
import { makeItemModel } from "./item-models.js";
import { updateHeldItem, heldItemOrigin } from "./held-item.js";
import { rivalVisible } from "./rival-visibility.js";
import { driverCameraAnchor } from "./driver-camera-anchor.js";
import { clearChaseView, clearanceLookTarget, smoothChaseCorrection } from "./chase-clearance.js";
import { stadiumBroadcast } from "./stadium-broadcast.js";
import { raceNumerals } from "./hud-numerals.js";
import { cameraCollision } from "./camera-collision.js";
import { GTAOPass } from "/vendor/three-examples/postprocessing/GTAOPass.js";
import * as THREE from "three";
import { updateSourceWheel } from './source-wheel.js';
import { updateGlider } from './glider-animation.js';
import { makeBoostEffect, updateBoostEffect } from './boost-effect.js';
import { updateStarModel, makeStarAura, updateStarAura } from './star-effect.js';
import { EffectComposer } from "/vendor/three-examples/postprocessing/EffectComposer.js";
import { RenderPass } from "/vendor/three-examples/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "/vendor/three-examples/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "/vendor/three-examples/postprocessing/OutputPass.js";
import { RoomEnvironment } from "/vendor/three-examples/environments/RoomEnvironment.js";
import { mergeGeometries } from "/vendor/three-examples/utils/BufferGeometryUtils.js";
import { GameLink } from "../../core/net.js";
import {
  Race,
  CHARACTERS,
  ITEMS,
  ordinal,
  formatTime,
  seeded,
} from "./logic.js";
import {
  activeSurfaceTrack,
  useSourceTrack,
  trackAt,
  surfaceAt,
  TRACK_LENGTH as L,
  TRACK_SAMPLES,
  SECTIONS,
  clamp,
  angle,
  wrap,
} from "./track.js";
import { addAtmosphere } from "./atmosphere.js";
import { roadFrame, chasePose, cameraClearance } from "./visual-frame.js";
import { WheelInput } from "./input.js";
import { DuoLobby } from './duo-lobby.js';
import { KartAudio } from "./audio.js";
import {
  proceduralKart,
  loadKartPack,
  makeGlider,
  rigWheels,
  disposeModel,
} from "./models.js";
import { buildWorld, canvasTexture } from "./world.js";
import { ITEM_ICONS, portrait, loadSourcePortraits } from "./icons.js";
const $ = (id) => document.getElementById(id),
  canvas = $("game"),
  V = THREE.Vector3;
await loadSourcePortraits();
const renderedItemIcons=itemPortraits();
const updateItemReel=itemRoulette($("item-icon"),{...ITEM_ICONS,...renderedItemIcons},ITEMS);
const updateBoostScreen=boostScreen($("speed-lines"));
let boostFeedback={strength:0,kick:0};
window.addEventListener("error", (e) => {
  $("error").hidden = false;
  $("error").textContent = "The race could not load: " + e.message;
});
const renderer = new THREE.WebGLRenderer({
  canvas,
  // Antialias once in the composer, rather than also on the output canvas.
  antialias: false,
  powerPreference: "high-performance",
});
let qualityName = loadQuality();
let quality = QUALITY[qualityName];
let mode = 'solo';
const gpu = gpuInfo(renderer.getContext());
renderer.setPixelRatio(renderScale(innerWidth, innerHeight, devicePixelRatio, quality));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const effects=raceEffects(scene,seeded(8703));
scene.background = new THREE.Color("#081325");
scene.fog = new THREE.FogExp2("#111c30", 0.0011);
const camera = new THREE.PerspectiveCamera(
  59,
  innerWidth / innerHeight,
  0.2,
  1100,
);
const camera2 = camera.clone();
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.28;
room.dispose();
pmrem.dispose();
scene.add(new THREE.HemisphereLight("#a5c8f4", "#34384a", 0.29));
const key = new THREE.DirectionalLight("#fff3dd", 1.7);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, {
  left: -32,
  right: 32,
  top: 32,
  bottom: -32,
  near: 1,
  far: 150,
});
key.shadow.bias = -0.00035;
key.shadow.normalBias = 0.025;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight("#77baff", 0.32);
fill.position.set(-80, 70, 20);
scene.add(fill);
const trackLights = [-2, -1, 0, 1, 2].map((side) => {
  const light = new THREE.SpotLight(
    side < 0 ? "#c0dbff" : "#fff0d9",
    1500,
    72,
    0.7,
    0.72,
    2,
  );
  scene.add(light, light.target);
  return light;
});
const renderTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType,
  samples: Math.min(quality.samples, renderer.capabilities.maxSamples),
});
const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));
const ambientOcclusion = new GTAOPass(scene, camera, innerWidth, innerHeight);
ambientOcclusion.updateGtaoMaterial({
  radius: 2.2,
  thickness: 1.1,
  distanceExponent: 1.5,
  samples: 8,
});
ambientOcclusion.updatePdMaterial({
  radius: 4,
  samples: 8,
  depthPhi: 3,
  normalPhi: 3,
});
ambientOcclusion.blendIntensity = 0.6;
composer.addPass(ambientOcclusion);
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.18,
  0.4,
  2.1,
);
composer.addPass(bloom);
const outputPass = new OutputPass();
// This is an opaque full-screen game. Transparent pickups and postprocessing
// must not punch alpha holes through the final image into the page background.
outputPass.material.fragmentShader = outputPass.material.fragmentShader.replace(
  "gl_FragColor = texture2D( tDiffuse, vUv );",
  "gl_FragColor = vec4(texture2D( tDiffuse, vUv ).rgb, 1.0);",
);
composer.addPass(outputPass);
const coursePreference = new URLSearchParams(location.search).get('sourceCourse');
let courseDescriptor = null;
if (coursePreference !== '0') {
  try {
    const response = await fetch('/assets/mario-kart/manifest.json');
    if (response.ok) courseDescriptor = (await response.json()).course || null;
  } catch { /* An optional local pack is not required to play. */ }
}
if (!courseDescriptor && coursePreference === '1') courseDescriptor = {model:'stadium-source.glb',route:'stadium-route.json'};
let world;
if (courseDescriptor) {
  try { world = await loadSourceWorld(scene, courseDescriptor); }
  catch (error) { console.warn('Local course pack unavailable; using built-in course:', error.message); }
}
if (!world) world = buildWorld(scene);
if (world.source) {
  useSourceTrack(world.route);
  camera.far = 2500;
  camera.updateProjectionMatrix();
  camera2.far = 2500;
  camera2.updateProjectionMatrix();
}
// The source stadium has 16:9 panels; generated scenery uses 4:3 panels.
const broadcast = stadiumBroadcast(renderer, scene, world.screenMaterials,
  world.source ? {width:768,height:432} : undefined);
function applyGraphics() {
  quality = QUALITY[qualityName];
  const scale = mode === 'duo'
    ? duoRenderScale(innerWidth, innerHeight, devicePixelRatio, quality)
    : renderScale(innerWidth, innerHeight, devicePixelRatio, quality);
  renderer.setPixelRatio(scale);
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = (mode === 'duo' ? innerWidth / 2 : innerWidth) / innerHeight;
  camera.updateProjectionMatrix();
  camera2.aspect = (innerWidth / 2) / innerHeight;
  camera2.updateProjectionMatrix();
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    const samples = mode === 'duo' ? 0 : Math.min(quality.samples, renderer.capabilities.maxSamples);
    if (target.samples !== samples) { target.samples = samples; target.dispose(); }
  }
  composer.setPixelRatio(scale);
  composer.setSize(innerWidth, innerHeight);
  ambientOcclusion.enabled = mode === 'solo' && quality.ao;
  bloom.enabled = mode === 'solo' && quality.bloom;
  const shadowsEnabled = mode !== 'duo' && quality.shadows;
  if (renderer.shadowMap.enabled !== shadowsEnabled) {
    renderer.shadowMap.enabled = shadowsEnabled;
    // Shadow support is compiled into material shaders. Refresh the cached
    // programs when switching presets/modes, before disposing the old map.
    const materials = new Set();
    scene.traverse(object => {
      for (const material of (Array.isArray(object.material) ? object.material : [object.material]))
        if (material) materials.add(material);
    });
    for (const material of materials) material.needsUpdate = true;
  }
  if (key.shadow.mapSize.x !== quality.shadowSize) {
    key.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    key.shadow.map?.dispose();
    key.shadow.map = null;
  }
  renderer.shadowMap.needsUpdate = true;
  broadcast.setRate(mode === 'duo' ? 0 : quality.broadcastHz);
  $('graphics-quality').value = qualityName;
}
applyGraphics();
$('graphics-quality').addEventListener('change', event => {
  qualityName = event.target.value;
  try { localStorage.setItem('openwii.kart.graphics.v1', qualityName); } catch { /* Optional. */ }
  applyGraphics();
});
$('graphics-gpu').textContent = gpu.renderer;
$('graphics-advice').textContent = gpu.software
  ? 'Software rendering detected. Enable graphics acceleration in your browser settings and restart the browser.'
  : gpu.nvidia
    ? 'NVIDIA hardware rendering active.'
    : 'For the RTX GPU: Windows Settings > System > Display > Graphics > your browser > Options > High performance, then restart the browser.';
const updatePerformance = performanceMeter(({fps, frameMs}) => {
  $('graphics-fps').textContent = `${fps} FPS`;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  $('graphics-stats').textContent = `${frameMs.toFixed(1)} ms/frame · ${size.x} × ${size.y} · ${renderer.info.render.calls} draw calls · ${Math.round(renderer.info.render.triangles / 1000)}k triangles`;
});
addAtmosphere(scene);
// Consolidate static scenery by material. No dynamic light/firework meshes are
// included; source object transforms are baked, preserving exact geometry.
const twoSidedBoards = [];
world.world.traverse((o) => {
  if (
    o.isMesh &&
    o.geometry.type === "PlaneGeometry" &&
    o.material.map &&
    o.material.side === THREE.DoubleSide
  )
    twoSidedBoards.push(o);
});
for (const front of twoSidedBoards) {
  front.material.side = THREE.FrontSide;
  const back = front.clone();
  back.rotateY(Math.PI);
  back.translateZ(0.025);
  front.parent.add(back);
}
world.world.updateMatrixWorld(true);
const avoidScenery = world.avoidCamera || cameraCollision(world.world);
const staticGroups = new Map(),
  remove = [];
world.world.traverse((o) => {
  // The hero sculpture receives the same finished GLB as the driver pack.
  // Keep its replaceable model outside the irreversible static scenery batch.
  for (let parent = o; parent; parent = parent.parent)
    if (parent.userData.dynamicScenery) return;
  if (
    !o.isMesh ||
    o.isInstancedMesh ||
    world.lights.includes(o) ||
    Array.isArray(o.material)
  )
    return;
  const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
  g.applyMatrix4(o.matrixWorld);
  // Generated primitives differ in uv presence; normalize the merge contract.
  if (!g.getAttribute("uv"))
    g.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(
        new Float32Array(g.getAttribute("position").count * 2),
        2,
      ),
    );
  const id = o.material.uuid;
  if (!staticGroups.has(id))
    staticGroups.set(id, { mat: o.material, geos: [], cast: false });
  staticGroups.get(id).cast ||= o.castShadow;
  staticGroups.get(id).geos.push(g);
  remove.push(o);
});
for (const o of remove) o.removeFromParent();
for (const { mat, geos, cast } of staticGroups.values()) {
  const g = mergeGeometries(geos);
  if (!g) continue;
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  m.castShadow = cast;
  scene.add(m);
  geos.forEach((x) => x.dispose());
}
const lobby = new DuoLobby();
let selected = "mario",
  selectedLaps = localStorage.getItem("openwii.kart.laps") === "1" ? 1 : 3,
  paused = false,
  race,
  noticeUntil = 0,
  hitUntil = 0,
  renderCount = 0,
  lastFrame = performance.now(),
  resultsShown = false, resultsPresentation = null;
const audio = new KartAudio(),
  wheel = new WheelInput({
    invert: localStorage.getItem("openwii.chargeInvert2") === "1",
  }),
  keys = new Set();
const wheels = [wheel, new WheelInput()];
const captureUntils = [performance.now() + 3000, performance.now() + 3000];
const duoItemPulses = [false, false], lastDuoItems = [false, false];
let duoSignalGraceUntil = 0;
let presenceSlots = [];
let keyboardPlayer2 = false;
function duoSlots() {
  if (!keyboardPlayer2) return presenceSlots;
  return [presenceSlots[0], { slot: 1, occupied: true, identity: 'local-keyboard-player-2' }];
}
function duoRemote(slot, now) {
  if (keyboardPlayer2 && slot === 1) return {
    live: true, status: 'Keyboard test controller',
    steer: Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft')),
    gas: keys.has('KeyZ'), brake: keys.has('KeyX'),
    drift: keys.has('ShiftLeft') || keys.has('ShiftRight'), item: false,
  };
  return wheels[slot].read(now);
}
function duoMotionReady(slot, now) {
  return (keyboardPlayer2 && slot === 1) || (wheels[slot].armed && wheels[slot].read(now).live);
}
let captureUntil = performance.now() + 3000,
  usingPhone = false,
  phoneHadGas = false,
  lastRemoteItem = false,
  itemPulse = false;
const karts = [];
// Emissive exhaust sheets have no solid surface for ambient occlusion.
// GTAO overrides mesh materials, so shader transparency alone cannot exclude them.
const renderOcclusion = ambientOcclusion.render.bind(ambientOcclusion);
ambientOcclusion.render = (...args) => {
  const active = karts.map(k => k.boostEffect).filter(effect => effect.visible);
  for (const effect of active) effect.visible = false;
  try { renderOcclusion(...args); }
  finally { for (const effect of active) effect.visible = true; }
};
const shadowTexture = canvasTexture(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "#0009");
  g.addColorStop(1, "#0000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});
function constructRace() {
  race = new Race({
    character: selected,
    characters: mode === 'duo' ? lobby.characters : undefined,
    humanCount: mode === 'duo' ? 2 : 1,
    laps: selectedLaps,
    seed: new URLSearchParams(location.search).has("evidence")
      ? 42
      : Math.floor(performance.now()) % 100000,
    onEvent: onEvent,
  });
  resultsShown = false;resultsPresentation=null;
  for (const rig of cameraRigs) rig.initializedCamera = false;
  $('again').disabled=false;
  for (const k of karts) {
    k.disposed = true;
    scene.remove(k.root, k.shadow);
    disposeModel(k.root);
    k.shadow.geometry.dispose();
    k.shadow.material.dispose();
  }
  karts.length = 0;
  for (const r of race.racers) {
    const root = new THREE.Group(),
      model = proceduralKart(r.character.id),
      glider = makeGlider(r.character.color,r.character.id),
      hover = makeHoverGlow(),starAura=makeStarAura(),boostEffect=makeBoostEffect();
    root.add(model, glider, hover,starAura,boostEffect);
    scene.add(root);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.8, 4.4),
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    scene.add(shadow);
    karts.push({
      id: r.character.id,
      root,
      model,
      glider,
      hover,
      starAura,
      boostEffect,
      shadow,
      wheels: rigWheels(model),
      source: "procedural",
    });
  }
  const set = karts.slice();
  loadKartPack(set).then((status) => {
    if (set[0] !== karts[0]) return;
    debug.assets = status;
    const mario = set.find((k) => k.id === "mario" && k.source === "glb");
    if (mario && !world.statue.userData.finishedModel) {
      // Own copies survive race resets and item-driven material changes.
      const sculpture = mario.model.clone(true);
      sculpture.traverse((o) => {
        if (o.geometry) o.geometry = o.geometry.clone();
        if (o.material)
          o.material = Array.isArray(o.material)
            ? o.material.map((m) => m.clone())
            : o.material.clone();
        if (/^wheel-[0-3]$/.test(o.name)) o.rotation.set(0, 0, 0);
      });
      for (const child of [...world.statue.children]) {
        world.statue.remove(child);
        disposeModel(child);
      }
      world.statue.add(sculpture);
      world.statue.userData.finishedModel = true;
    }
  });
  $("results").hidden = true;
  $("pause").hidden = true;
  paused = false;
}
const link = new GameLink({
  onOrientation: (sample, slot) => {
    if (mode === 'duo' && keyboardPlayer2 && slot === 1) return;
    if (slot < 0 || slot > (mode === 'duo' ? 1 : 0)) return;
    if (mode === 'solo') usingPhone = true;
    wheels[slot].sample(sample, performance.now(), {
      canCapture:
        race?.state === "ready" ||
        race?.state === "countdown" ||
        performance.now() < (mode === 'solo' ? captureUntil : captureUntils[slot]),
    });
    if (mode === 'duo' && race?.state === 'ready') syncDuoLobby();
  },
  onCommand: (cmd, slot) => {
    if (mode === 'duo' && keyboardPlayer2 && slot === 1) return;
    if (slot < 0 || slot > (mode === 'duo' ? 1 : 0)) return;
    const now = performance.now();
    wheels[slot].command(cmd, now);
    if (mode === 'duo') {
      if (cmd.type === 'recentre' || cmd.type === 'calibrate') {
        wheels[slot].reset();
        captureUntils[slot] = now + 10000;
        if (race?.state !== 'ready') pause(`P${slot + 1} is recentering the wheel.`);
      }
      if (cmd.type === 'button' && cmd.pressed !== false) {
        if (race.state === 'ready') {
          if (['left', 'right', 'up', 'down'].includes(cmd.button)) {
            if (lobby.choose(slot, cmd.menuDirection || cmd.button)) { audio.ui('cursor'); sendProfile(); }
          } else if (cmd.button === '1') lobby.cancel(slot);
          else if (cmd.button === '2') {
            const motion = wheels[slot].read(now);
            if (lobby.setReady(slot, presenceSlots[slot]?.identity, motion.live && wheels[slot].armed)) audio.ui('confirm');
          }
          syncDuoLobby();
          return;
        }
        if (paused && cmd.button === '2') { resume(); return; }
        if (race.state === 'racing' && cmd.button === 'right' && !paused) duoItemPulses[slot] = true;
        if (race.state === 'results' && cmd.button === '2') confirm();
      }
      return;
    }
    if (cmd.type === "home") {
      audio.ui('cancel').then(()=>setTimeout(()=>location.href="/",100));
      return;
    }
    if (cmd.type === "recentre" || cmd.type === "calibrate") {
      wheel.reset();
      captureUntil = now + 10000;
      if (race?.state === "racing")
        pause("Level the wheel for a moment, then press 2 or Enter.");
    }
    if (cmd.type === 'button' && cmd.pressed !== false) {
      if (cmd.button === '2' && (paused || ['ready','results'].includes(race.state))) confirm();
      if (race.state === 'ready') {
        if (['left','right','up','down'].includes(cmd.button)) navigateDriver(cmd.menuDirection || cmd.button);
        if (cmd.button === '1') cancelDriver();
      } else if (cmd.button === 'right' && !paused) itemPulse = true;
    }
  },
  onPresence: (p) => {
    presenceSlots = p.slots || [];
    if (mode === 'duo') {
      $('connection').textContent = `P1 ${presenceSlots[0]?.occupied ? 'CONNECTED' : 'WAITING'} · P2 ${keyboardPlayer2 ? 'KEYBOARD TEST' : presenceSlots[1]?.occupied ? 'CONNECTED' : 'WAITING'}`;
      for (let slot = 0; slot < 2; slot++) if (!presenceSlots[slot]?.occupied) wheels[slot].release();
      if (race && !['ready', 'results'].includes(race.state) && !lobby.sameParticipants(duoSlots()))
        pause('A player disconnected. The same phones must reconnect.');
      syncDuoLobby();
      sendProfile();
      return;
    }
    $("connection").textContent = p.controller
      ? "PHONE CONNECTED · P1"
      : "KEYBOARD READY";
    if (!p.controller) {
      wheel.release();
      if (usingPhone && race?.state === "racing")
        pause("Phone disconnected. Reconnect or continue with the keyboard.");
      usingPhone = false;
    }
    sendProfile();
  },
});
function sendProfile() {
  link.feedback({ type: "controller-profile", profile: "wheel", slot: 0 });
  if (mode === 'duo' && !keyboardPlayer2) {
    link.feedback({ type: 'controller-profile', profile: 'wheel', slot: 1 });
    link.feedback({ type: 'controller-player', slot: 1,
      playerLabel: `P2 · ${CHARACTERS.find(c => c.id === lobby.characters[1]).name}`, playerColor: '#5eaaff' });
  }
  link.feedback({ type: 'controller-player', slot: 0,
    playerLabel: `P1 · ${mode === 'duo' ? CHARACTERS.find(c => c.id === lobby.characters[0]).name : CHARACTERS.find(c => c.id === selected).name}`,
    playerColor: '#ff5267' });
}
const profileTimer = setInterval(sendProfile, 850);
function onEvent(e) {
  if(e.type==='box' && race.boxes[e.box]){const b=race.boxes[e.box];effects.box(surfaceAt(b.s,b.lateral),race.time);}
  if(e.type==='contact'){
    burst(race.racers[e.racer],5,'#fff1b8');
    if(e.racer < race.humanCount)link.feedback({type:'rumble',pattern:[35],slot:e.racer});
  }
  if(e.type==='hit' && race?.racers[e.racer]){
    const r=race.racers[e.racer];burst(r,28,e.cause==='blue'?'#98dbff':'#fff0a0');
    if(e.cause==='blue'){
      const ball=new THREE.Mesh(new THREE.SphereGeometry(1,32,20),new THREE.MeshBasicMaterial({color:'#b9eaff',transparent:true,opacity:.65,depthWrite:false,blending:THREE.AdditiveBlending}));
      ball.position.set(r.x,r.y+1,r.z);scene.add(ball);itemImpacts.push({mesh:ball,start:race.time});
    }
  }
  audio.event(e, race);
  if (e.type === 'hit' && e.racer < race.humanCount)
    link.feedback({ type: 'rumble', pattern: [80, 40, 80], slot: e.racer });
  if (e.racer !== 0) return;
  if(e.type==='useItem'){$('item-frame').dataset.used=String(race.time);$('item-icon').animate([{transform:'scale(1)',opacity:1},{transform:'scale(1.3)',opacity:0}],{duration:150});}
  if(e.type==='itemReady')$('item-frame').animate([{filter:'brightness(2)',transform:'scale(1.15)'},{filter:'brightness(1)',transform:'scale(1)'}],{duration:250});
  const labels = {
    rocket: "ROCKET START!",
    burnout: "TOO EARLY!",
    turbo: ["", "MINI-TURBO!", "SUPER MINI-TURBO!", "ULTRA MINI-TURBO!"][
      e.tier
    ],
    finalLap: "FINAL LAP",
    lap: "LAP 2",
    finish: "FINISH!",
    glider: "TAKE FLIGHT!",
    antigrav: "ANTI-GRAVITY",
    hit: "SPIN OUT!",
    bump: "SPIN BOOST!",
  };
  if (labels[e.type]) {
    $('notice').dataset.kind=e.type;
    $('notice').innerHTML=e.type==='finish'?raceLettering('FINISH!'):['lap','finalLap'].includes(e.type)?'<div class="lap-sign"></div>':labels[e.type];
    if(['lap','finalLap'].includes(e.type))$('notice').firstElementChild.innerHTML=lapBoard(e.type==='finalLap'?3:2);
    $('notice').getAnimations().forEach(a=>a.cancel());
    $('notice').animate(e.type==='finish'?[{opacity:0,scale:'1.45'},{opacity:1,scale:'1',offset:.22},{opacity:1,scale:'1'}]:[{opacity:0,translate:'70px 0'},{opacity:1,translate:'0 0',offset:.2},{opacity:1,translate:'0 0',offset:.8},{opacity:0,translate:'20px -25px'}],{duration:1500});
    $("notice").dataset.essential = String(
      ["lap", "finalLap", "finish"].includes(e.type),
    );
    noticeUntil = race?.time + 1.5;
  }
  if (e.type === "hit") {
    hitUntil = (race?.time || 0) + 1;
    burst(race.player, 36, "#ffd755");
  }
  if (e.type === "coin") burst(race.player, 10, "#ffdf46");
}
let starting = false, driverConfirmed = false;
function showDuoLobby() {
  $('intro').hidden = false;
  $('track-label').hidden = true;
  $('hud').hidden = true;
  $('duo-hud').hidden = true;
  $('results').hidden = true;
  $('duo-lobby').hidden = false;
  syncDuoLobby();
}
function syncDuoLobby() {
  if (mode !== 'duo' || !race) return;
  $('connection').textContent = `P1 ${presenceSlots[0]?.occupied ? 'CONNECTED' : 'WAITING'} · P2 ${keyboardPlayer2 ? 'KEYBOARD TEST' : presenceSlots[1]?.occupied ? 'CONNECTED' : 'WAITING'}`;
  const now = performance.now();
  const live = [0, 1].map(slot => duoMotionReady(slot, now));
  const slots = duoSlots();
  if (race.state === 'ready') lobby.sync(slots, live);
  for (let slot = 0; slot < 2; slot++) {
    const c = CHARACTERS.find(character => character.id === lobby.characters[slot]);
    $(`duo-portrait-${slot}`).src = portrait(c);
    $(`duo-portrait-${slot}`).alt = c.name;
    $(`duo-driver-${slot}`).textContent = c.name;
    $(`duo-state-${slot}`).textContent = slot === 1 && keyboardPlayer2
      ? (lobby.ready[slot] ? 'READY · KEYBOARD TEST' : 'Press Enter to ready') : !slots[slot]?.occupied ? 'Connect phone' :
      !live[slot] ? 'Hold level to calibrate' : lobby.ready[slot] ? 'READY' : 'Press 2 to ready';
  }
  if (race.state === 'ready' && lobby.canStart(slots, live)) beginDuo();
}
async function beginDuo() {
  if (starting || mode !== 'duo' || race.state !== 'ready') return;
  starting = true;
  await audio.ui('start');
  starting = false;
  const live = [0, 1].map(slot => duoMotionReady(slot, performance.now()));
  if (!lobby.canStart(duoSlots(), live)) return;
  constructRace();
  race.start();
  // Rebuilding the eight visual karts may block sensor callbacks briefly.
  // Wait for fresh packets before advancing the shared countdown.
  duoSignalGraceUntil = performance.now() + 1500;
  $('intro').hidden = true;
  $('track-label').hidden = true;
  $('hud').hidden = false;
  $('duo-hud').hidden = false;
  $('results').hidden = true;
  applyGraphics();
  noticeUntil = 0;
}
function setMode(next) {
  if (race.state !== 'ready' || starting) return;
  mode = next === 'duo' ? 'duo' : 'solo';
  document.body.classList.toggle('duo', mode === 'duo');
  document.querySelectorAll('[data-mode]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  $('duo-lobby').hidden = mode !== 'duo';
  $('track-label').hidden = mode === 'duo';
  $('characters').hidden = mode === 'duo';
  $('chosen').hidden = mode === 'duo';
  $('start').hidden = mode === 'duo';
  $('menu-hint').hidden = mode === 'duo';
  if (mode === 'duo') {
    lobby.reset();
    for (const w of wheels) w.reset();
    captureUntils.fill(performance.now() + 10000);
  }
  constructRace();
  applyGraphics();
  syncDuoLobby();
  if (mode === 'solo') link.feedback({ type: 'controller-profile', profile: 'default', slot: 1 });
  sendProfile();
}
for (const button of document.querySelectorAll('[data-mode]'))
  button.onclick = () => setMode(button.dataset.mode);
$('keyboard-test').addEventListener('change', event => {
  if (race.state !== 'ready' || starting) { event.target.checked = keyboardPlayer2; return; }
  keyboardPlayer2 = event.target.checked;
  $('keyboard-test-help').hidden = !keyboardPlayer2;
  $('duo-instructions').textContent = keyboardPlayer2
    ? 'Connect one phone as P1. Hold it sideways and level, choose your driver with its crosspad, then press 2. Use the computer arrows to choose P2’s driver and Enter to ready.'
    : 'Connect two phones. Hold each one sideways and level to calibrate, choose a driver with the crosspad, then press 2 on each phone.';
  lobby.cancel(1);
  keys.clear();
  wheels[1].release();
  duoItemPulses[1] = lastDuoItems[1] = false;
  canvas.focus({ preventScroll: true });
  syncDuoLobby();
  sendProfile();
});
function setDriverConfirmed(value) {
  driverConfirmed = value;
  $('intro').classList.toggle('driver-confirmed',value);
  document.querySelector('.intro-copy').textContent = value ? 'Choose race length · Turn your phone sideways' : 'Choose your driver';
  $('start').innerHTML = value ? 'Start Race <span>② OK</span>' : 'Confirm Driver <span>② OK</span>';
  $('menu-hint').textContent = value ? '← → Race length · ② Start Race · ① Change driver' : 'Crosspad to choose · ② Confirm driver';
}
function cancelDriver() {
  if(driverConfirmed){setDriverConfirmed(false);audio.ui('cancel');}
}
function chooseDriver(index) {
  if (race.state !== 'ready' || starting) return;
  const c=CHARACTERS[(index+CHARACTERS.length)%CHARACTERS.length];
  selected=c.id;setDriverConfirmed(false);
  document.querySelectorAll('.character').forEach((el,i)=>{
    el.classList.toggle('selected',CHARACTERS[i].id===selected);
    el.setAttribute('aria-pressed',String(CHARACTERS[i].id===selected));
  });
  $('chosen').textContent=c.name;
  constructRace();
  audio.ui('cursor');
}
function selectLaps(laps) {
  if (race.state !== 'ready' || starting) return;
  selectedLaps = laps === 1 ? 1 : 3;
  race.laps = selectedLaps;
  localStorage.setItem('openwii.kart.laps', String(selectedLaps));
  syncLapOptions();
  audio.ui('cursor');
}
function syncLapOptions() {
  document.querySelectorAll('[data-laps]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.laps) === selectedLaps));
  });
  document.querySelector('#track-label small').textContent = `${selectedLaps} ${selectedLaps === 1 ? 'LAP' : 'LAPS'} · 8 RACERS · MARIO KART STADIUM`;
}
for (const button of document.querySelectorAll('[data-laps]')) {
  button.onclick = () => selectLaps(Number(button.dataset.laps));
}
syncLapOptions();
function navigateDriver(direction) {
  if (driverConfirmed) {
    if (direction === 'left' || direction === 'right') selectLaps(selectedLaps === 1 ? 3 : 1);
    return;
  }
  const index=CHARACTERS.findIndex(c=>c.id===selected);
  const step={left:-1,right:1,up:-4,down:4}[direction];
  chooseDriver(index+step);
}
async function begin() {
  if (starting) return;
  starting = true;
  const button = $("start"), label = button.innerHTML;
  button.disabled = true;
  button.textContent = "LOADING…";
  await audio.ui('start');
  starting = false;
  button.disabled = false;
  button.innerHTML = label;
  wheel.reset();
  captureUntil = performance.now() + 3000;
  race.start();
  $("intro").hidden = true;
  $("track-label").hidden = true;
  $("hud").hidden = false;
  $("results").hidden = true;
  noticeUntil = 0;
}
function confirm() {
  if (paused) {
    resume();
    return;
  }
  if (mode === 'duo') {
    if (race.state === 'results' && resultsPresentation?.done) {
      lobby.ready.fill(false);
      constructRace();
      showDuoLobby();
    }
    return;
  }
  if (race.state === 'ready') {
    if (!driverConfirmed) {setDriverConfirmed(true);audio.ui('confirm');}
    else begin();
  }
  else if (race.state === "results" && resultsPresentation?.done) {
    constructRace();
    begin();
  }
}
$("start").onclick = confirm;
$("again").onclick = confirm;
$("resume").onclick = resume;
$("mute").onclick = () => {
  audio.engine.enabled = !audio.engine.enabled;
  audio.engine.master?.gain.setValueAtTime(
    audio.engine.enabled ? 0.55 : 0,
    audio.engine.ctx.currentTime,
  );
  $("mute").textContent = audio.engine.enabled ? "♪ SOUND ON" : "♪ SOUND OFF";
};
for (const c of CHARACTERS) {
  const b = document.createElement("button");
  b.className = "character" + (c.id === selected ? " selected" : "");
  b.setAttribute("aria-label", c.name);
  b.innerHTML = `<img src="${portrait(c)}" alt="${c.name}">`;
  b.setAttribute('aria-pressed',String(c.id===selected));
  b.onclick = () => chooseDriver(CHARACTERS.indexOf(c));
  $("characters").append(b);
}
function pause(reason = "Take a breath. The race will wait.") {
  if (["ready", "results"].includes(race.state)) return;
  paused = true;
  $("hud").getAnimations({subtree:true}).forEach(a=>a.pause());
  keys.clear();
  duoItemPulses.fill(false);
  lastDuoItems.fill(false);
  for (const w of (mode === 'duo' ? wheels : [wheel])) w.release();
  if (mode === 'duo') captureUntils.fill(performance.now() + 10000);
  $("pause-reason").textContent = reason;
  $("pause").hidden = false;
  audio.engine.ctx?.suspend();
}
function resume() {
  if (mode === 'duo' && !['ready', 'results'].includes(race.state)) {
    const live = [0, 1].every(slot => duoMotionReady(slot, performance.now()));
    if (!lobby.sameParticipants(duoSlots()) || !live) {
      $('pause-reason').textContent = keyboardPlayer2
        ? 'Reconnect Player 1’s phone and hold it level until the wheel is ready.'
        : 'Reconnect both original phones and hold them level until both wheels are ready.';
      return;
    }
  }
  paused = false;
  $("hud").getAnimations({subtree:true}).forEach(a=>{if(a.playState==="paused")a.play();});
  $("pause").hidden = true;
  lastFrame = performance.now();
  audio.ui('confirm');
}
document.addEventListener('click', e => {
  const button=e.target.closest('button, a');
  if(!button || button.matches('.character,[data-laps],#start,#again,#resume'))return;
  if(button.matches('a[href="/"]')&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){
    e.preventDefault();audio.ui('cancel').then(()=>setTimeout(()=>location.href='/',100));
  }else audio.ui('confirm');
});
window.addEventListener("keydown", (e) => {
  if (e.target.closest?.('#graphics-panel')) return;
  if (e.target.id === 'keyboard-test' && ['Space', 'Enter'].includes(e.code)) return;
  const handled = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "KeyZ",
    "KeyX",
    "ShiftLeft",
    "ShiftRight",
    "Space",
    "Enter",
    "Escape",
    "KeyR",
    "KeyI",
  ];
  if (handled.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (mode === 'duo' && keyboardPlayer2 && race.state === 'ready') {
    if (e.code.startsWith('Arrow')) {
      if (lobby.choose(1, e.code.slice(5).toLowerCase())) audio.ui('cursor');
      sendProfile();
    }
    if (e.code === 'Enter') lobby.setReady(1, duoSlots()[1].identity, true);
    if (e.code === 'KeyX') lobby.cancel(1);
    syncDuoLobby();
    return;
  }
  if (mode === 'solo' && race.state === 'ready' && e.code.startsWith('Arrow')) {
    navigateDriver(e.code.slice(5).toLowerCase());
    return;
  }
  if (e.code === 'Escape' && race.state === 'ready') { if (mode === 'solo') cancelDriver(); return; }
  if (e.code === "Enter") confirm();
  if (e.code === "Space") {
    if (mode === 'duo' && keyboardPlayer2 && !paused && race.state === 'racing') duoItemPulses[1] = true;
    else itemPulse = true;
  }
  if (e.code === "Escape") paused ? resume() : pause();
  if (e.code === "KeyR") {
    if (mode === 'duo') return;
    wheel.reset();
    captureUntil = performance.now() + 10000;
    if (usingPhone && race.state === "racing")
      pause("Level the wheel for a moment, then press 2 or Enter.");
  }
  if (e.code === "KeyI") {
    wheel.invert = !wheel.invert;
    localStorage.setItem("openwii.chargeInvert2", wheel.invert ? "1" : "0");
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
  if (race?.state === "racing")
    pause("Window lost focus. Press Enter to resume.");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause("The race paused while this tab was hidden.");
  else if (paused) queueMicrotask(() => audio.engine.ctx?.suspend());
});
window.addEventListener("pagehide", () => {
  clearInterval(profileTimer);
  link.feedback({ type: "controller-profile", profile: "default", slot: 0 });
  if (mode === 'duo') link.feedback({ type: 'controller-profile', profile: 'default', slot: 1 });
  audio.stop();
});
// Pickups: shared geometries, predictable pools, no allocation as racers lap.
const pickupRoot = new THREE.Group();
scene.add(pickupRoot);
const coinParts = [new THREE.CylinderGeometry(0.62, 0.62, 0.14, 40)];
for (const side of [-1, 1]) {
  const rim = new THREE.TorusGeometry(0.52, 0.035, 8, 40);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, side * 0.088, 0);
  const stamp = new THREE.CapsuleGeometry(0.07, 0.55, 4, 8);
  stamp.rotateX(Math.PI / 2);
  stamp.translate(0, side * 0.1, 0);
  coinParts.push(rim, stamp);
}
const coinGeo = mergeGeometries(coinParts),
  coinMat = new THREE.MeshStandardMaterial({
    color: "#ffd637",
    metalness: 0.68,
    roughness: 0.25,
    emissive: "#b98a12",
    emissiveIntensity: 0.22,
  });
const boxGeo = new RoundedBoxGeometry(1.7, 1.7, 1.7, 3, 0.055),
  boxMat = new THREE.MeshPhysicalMaterial({
    color: "#c9edb3",
    roughness: 0.08,
    metalness: 0.45,
    envMapIntensity: 1.4,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    iridescence: 1,
    iridescenceIOR: 1.3,
    clearcoat: 1,
    emissive: "#6c9e6a",
    emissiveIntensity: 0.18,
  });
const qTex = canvasTexture(128, 128, (c) => {
  c.clearRect(0, 0, 128, 128);
  const sheen = c.createLinearGradient(0, 0, 128, 128);
  sheen.addColorStop(0, "#eeff83b0");
  sheen.addColorStop(0.45, "#94edaf50");
  sheen.addColorStop(1, "#5ba8ea95");
  c.fillStyle = sheen;
  c.fillRect(3, 3, 122, 122);
  c.fillStyle = "#e7ffffbb";
  for (const [x, y, r] of [
    [18, 105, 6],
    [32, 111, 3],
    [109, 20, 5],
  ]) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  c.strokeStyle = "#e8ffbca0";
  c.lineWidth = 3;
  c.strokeRect(3, 3, 122, 122);
  c.strokeStyle = "#fffed9a0";
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(9, 44);
  c.lineTo(9, 9);
  c.lineTo(47, 9);
  c.stroke();
  // A broad, bevel-like question glyph reads as a solid object at race speed.
  const glyph = new Path2D(
    "M35 44 C35 7 103 7 103 43 C103 61 81 65 79 77 L78 84 L56 84 L56 67 C57 56 80 54 80 43 C80 30 58 30 58 43 L58 47 Z M56 93 L78 93 L78 113 L56 113 Z",
  );
  c.save();
  c.translate(2, 3);
  c.lineJoin = "round";
  c.lineWidth = 12;
  c.strokeStyle = "#145196";
  c.stroke(glyph);
  c.restore();
  c.lineJoin = "round";
  c.lineWidth = 7;
  c.strokeStyle = "#219bde";
  c.stroke(glyph);
  const enamel = c.createLinearGradient(40, 20, 80, 110);
  enamel.addColorStop(0, "#ffffed");
  enamel.addColorStop(0.65, "#eaffff");
  enamel.addColorStop(1, "#b7e9f9");
  c.fillStyle = enamel;
  c.fill(glyph);
});
const qMat = new THREE.MeshStandardMaterial({
  map: qTex,
  color: "#fff",
  transparent: true,
  alphaTest: 0.1,
  depthWrite: false,
  emissive: "#8199d1",
  emissiveMap: qTex,
  emissiveIntensity: 0.5,
  roughness: 0.2,
});
let coinMeshes = [],
  boxMeshes = [];
function attachPickup(object, p, height) {
  const n = p.normal || {x:0,y:1,z:0};
  if (activeSurfaceTrack) {
    const holder = new THREE.Group();
    holder.position.set(p.x+n.x*height,p.y+n.y*height,p.z+n.z*height);
    holder.quaternion.setFromUnitVectors(new V(0,1,0),new V(n.x,n.y,n.z));
    object.position.set(0,0,0);holder.add(object);pickupRoot.add(holder);
  } else {
    object.position.set(p.x,p.y+height,p.z);pickupRoot.add(object);
  }
}
function syncPickupPools() {
  pickupRoot.clear();
  coinMeshes = race.coins.map((c) => {
    const m = new THREE.Mesh(coinGeo, coinMat),
      p = surfaceAt(c.s, c.lateral);
    m.rotation.x = Math.PI / 2;
    attachPickup(m,p,1.35);
    return m;
  });
  boxMeshes = race.boxes.map((b) => {
    const g = new THREE.Group(),
      p = surfaceAt(b.s, b.lateral);

    const m = new THREE.Mesh(boxGeo, boxMat);
    g.add(m);
    for (const [position, rotation] of [
      [
        [0, 0, 0.857],
        [0, 0, 0],
      ],
      [
        [0, 0, -0.857],
        [0, Math.PI, 0],
      ],
      [
        [0.857, 0, 0],
        [0, Math.PI / 2, 0],
      ],
      [
        [-0.857, 0, 0],
        [0, -Math.PI / 2, 0],
      ],
      [
        [0, 0.857, 0],
        [-Math.PI / 2, 0, 0],
      ],
      [
        [0, -0.857, 0],
        [Math.PI / 2, 0, 0],
      ],
    ]) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), qMat);
      q.position.set(...position);
      q.rotation.set(...rotation);
      g.add(q);
    }
    attachPickup(g,p,1.8);
    return g;
  });
}
// Sparks and impact stars are recycled. Particles are cosmetic; every hit and
// charge comes from logic.js, which never references these pools.
const maxParticles = 450,
  particleGeo = new THREE.BufferGeometry(),
  particlePos = new Float32Array(maxParticles * 3),
  particleColor = new Float32Array(maxParticles * 3);
particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
particleGeo.setAttribute("color", new THREE.BufferAttribute(particleColor, 3));
const particleTex = canvasTexture(32, 32, (c) => {
  const g = c.createRadialGradient(16, 16, 1, 16, 16, 16);
  g.addColorStop(0, "white");
  g.addColorStop(0.3, "#fff9");
  g.addColorStop(1, "#fff0");
  c.fillStyle = g;
  c.fillRect(0, 0, 32, 32);
});
const points = new THREE.Points(
  particleGeo,
  new THREE.PointsMaterial({
    map: particleTex,
    size: 0.24,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
points.frustumCulled = false;
scene.add(points);
const particles = Array.from({ length: maxParticles }, () => ({
  life: 0,
  x: 0,
  y: -500,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
}));
let pi = 0;
const visualRng = seeded(76);
function particle(x, y, z, vx, vy, vz, color, life = 0.45) {
  const i = pi++ % maxParticles,
    p = particles[i];
  Object.assign(p, { x, y, z, vx, vy, vz, life });
  new THREE.Color(color).toArray(particleColor, i * 3);
}
function burst(r, n, color) {
  for (let i = 0; i < n; i++)
    particle(
      r.x,
      r.y + 1.4,
      r.z,
      (visualRng() - 0.5) * 12,
      visualRng() * 8,
      (visualRng() - 0.5) * 12,
      color,
      0.7,
    );
}
const objectMeshes = new Map();
const itemImpacts=[];
function makeCameraRig(viewCamera) {
  return { camera: viewCamera, camTarget: new V(), unconstrainedEye: new V(),
    sceneryOffset: new V(), cameraAimTarget: new V(), cameraAim: new V(),
    cameraUp: new V(0, 1, 0), initializedCamera: false,
    lastFlightCamera: null, landingCamera: null, updateBoost: createBoostFeedback() };
}
const cameraRigs = [makeCameraRig(camera), makeCameraRig(camera2)];
const basis = new THREE.Matrix4(),
  basisX = new V(),
  basisY = new V(),
  basisZ = new V();
const frameTimes = [];
let previousDrawTime = 0;
function draw(dt, now) {
  const p = race.player,
    time = race.time;
  world.update(
    now / 1000,
    race.state === "countdown" ? race.count : race.state === "ready" ? 3 : 0,
  );
  for (const [i, r] of race.racers.entries()) {
    const k = karts[i],
      path = activeSurfaceTrack ? surfaceAt(r.s,r.lateral) : trackAt(r.s);
    const cast = i < race.humanCount || race.players.some(human => Math.hypot(r.x - human.x, r.z - human.z) < 18);
    if (k.cast !== cast) {
      k.model.traverse((o) => {
        if (o.isMesh) o.castShadow = cast;
      });
      k.cast = cast;
    }
    const hop = r.hop > 0 ? Math.sin((r.hop / 0.36) * Math.PI) * 0.7 : 0;
    k.root.position.set(r.x, r.y + hop + 0.1, r.z);
    if (activeSurfaceTrack && !r.gliding) {
      const n = r.surfaceNormal||path.normal;
      k.root.position.set(r.x+n.x*(hop+.1),r.y+n.y*(hop+.1),r.z+n.z*(hop+.1));
    }
    if (!r.gliding) {
      const frame = roadFrame(r.s, r.lateral, r.heading, r.surfaceForward, r.surfaceNormal);
      basisX.set(frame.right.x, frame.right.y, frame.right.z);
      basisY.set(frame.up.x, frame.up.y, frame.up.z);
      basisZ.set(-frame.forward.x, -frame.forward.y, -frame.forward.z);
      basis.makeBasis(basisX, basisY, basisZ);
      k.root.quaternion.setFromRotationMatrix(basis);
    } else {
      // Preserve the last actual ground pose through the wing opening. The
      // source ramp descends steeply; instantly applying flat flight rotates
      // the kart by roughly 57 degrees in a single frame.
      if (activeSurfaceTrack && k.wasGliding === false)
        k.launchOrientation = k.root.quaternion.clone();
      k.root.rotation.set(-0.08, -r.heading, 0, "YXZ");
      if (activeSurfaceTrack && k.launchOrientation && r.flight < .32) {
        k.flightOrientation ||= new THREE.Quaternion();
        k.flightOrientation.copy(k.root.quaternion);
        k.root.quaternion.slerpQuaternions(k.launchOrientation, k.flightOrientation,
          THREE.MathUtils.smoothstep(r.flight || 0, 0, .32));
      }
    }
    if(r.jump){
      if(!k.wasJumping)k.jumpOrientation=k.root.quaternion.clone();
      const flat=new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.atan2(r.jump.velocity,Math.max(20,r.speed)),-r.heading,0,'YXZ'));
      k.root.quaternion.slerpQuaternions(k.jumpOrientation,flat,THREE.MathUtils.smoothstep(r.jump.age,0,.16));
    }
    k.wasJumping=!!r.jump;
    if(r.landing>0)k.root.position.y-=Math.sin((1-r.landing/.24)*Math.PI)*.16;
    k.wasGliding = r.gliding;
    if (!r.gliding) k.launchOrientation = null;
    k.model.rotation.y = r.spin > 0 ? time * 15 : r.drift ? -r.drift * 0.25 : 0;
    k.model.rotation.z = (r.gliding ? -r.steer * 0.15 : -r.steer * 0.07) + Math.sin((r.contactAnimation||0)/.42*Math.PI*2)*(r.contactAnimation||0)*.55*(r.contactSide||.4);
    updateDriverLook(k, r, race.racers, paused ? 0 : dt, race.state === "racing");
    updateHeldItem(k.model, r, paused ? 0 : dt);
    updateBoostEffect(k.boostEffect,k.model,r.boost,time+i*.17);
    updateStarModel(k.model,r.star>0,(time*.65+i*.1)%1);
    updateStarAura(k.starAura,r.star>0,time+i*.17,innerHeight);
    if(!paused) k.wheelHover = (k.wheelHover||0) + ((r.anti?1:0)-(k.wheelHover||0))*(1-Math.exp(-dt*18));
    for (const [wi, w] of k.wheels.entries()) {
      if (!w) continue;
      if (w.userData.glow) w.userData.glow.visible = r.anti;
      if (w.userData.rolling && !paused)
        w.userData.rolling.rotation.x -= (r.speed * dt) / 0.39;
      const hover = w.userData.sourceTireMeshes ? (k.wheelHover||0) : r.anti?1:0;
      updateSourceWheel(w,hover);
      w.rotation.z = hover * ((wi % 2 ? 1 : -1) * Math.PI) / 2;
      w.rotation.y = wi < 2 ? -r.steer * 0.32 : 0;
    }
    updateHoverGlow(k, r, hop);
    updateGlider(k.glider,r,time);
    k.glider.userData.baseVisible = k.glider.visible;
    // The airborne spline is the flight corridor, not a physical surface.
    // Its lower landing road is at ground level; the shadow belongs there.
    k.shadow.position.set(r.x, r.gliding ? 0.09 : r.y + 0.04, r.z);
    if (activeSurfaceTrack && r.gliding && !path.glide) k.shadow.position.y = path.y + .09;
    if (activeSurfaceTrack && !r.gliding) {
      const n=r.surfaceNormal||path.normal;k.shadow.position.set(r.x+n.x*.04,r.y+n.y*.04,r.z+n.z*.04);
    }
    if(r.jump){const g=activeSurfaceTrack.support(r,{x:0,y:1,z:0})||path;k.shadow.position.set(r.x,g.y+.04,r.z);}
    k.shadow.material.opacity = r.gliding||r.jump ? 0.2 : 0.7;
    if (!r.gliding) {
      k.shadow.quaternion.copy(k.root.quaternion);
      k.shadow.rotateX(-Math.PI / 2);
    } else k.shadow.rotation.set(-Math.PI / 2, 0, r.heading);
    effects.tire(r,roadFrame(r.s,r.lateral,r.heading,r.surfaceForward,r.surfaceNormal),paused?0:dt);
  }
  effects.update(paused?0:dt,innerHeight);
  for (const [i, m] of coinMeshes.entries()) {
    m.visible = race.coins[i].respawn === 0;
    m.rotation.z = now * 0.003;
  }
  for (const [i, g] of boxMeshes.entries()) {
    g.visible = race.boxes[i].respawn === 0;
    g.rotation.y = now * 0.001;
    g.rotation.z = Math.sin(now * 0.001 + i) * 0.2;
  }
  const alive = new Set();
  for (const o of race.objects) {
    alive.add(o.id);
    if (!objectMeshes.has(o.id)) {
      const m = makeItemModel(o.type);
      m.userData.release = heldItemOrigin(karts[o.owner].model) || new V(race.racers[o.owner].x, race.racers[o.owner].y+2, race.racers[o.owner].z);
      objectMeshes.set(o.id, m);
      scene.add(m);
    }
    const m = objectMeshes.get(o.id),
      p = surfaceAt(o.s, o.lateral);
    const n=p.normal||{x:0,y:1,z:0}, height=o.type === "blue" ? 4 : .12;
    m.position.set(p.x+n.x*height,p.y+n.y*height,p.z+n.z*height);
    if(o.type==='blue' && o.attack!=null){
      const target=race.racers.find(r=>r.id===o.target),t=o.attack;
      if(target){const orbit=t<.55?2*(1-t/.75):0, a=t*14;
        m.position.set(target.x+Math.cos(a)*orbit,target.y+4.5*(1-THREE.MathUtils.smoothstep(t,.55,.85)),target.z+Math.sin(a)*orbit);}
    }
    const releaseTime=o.type==='banana'?.42:.22, t=Math.min(1,o.age/releaseTime);
    if(t<1){m.position.lerpVectors(m.userData.release,m.position,t);m.position.addScaledVector(new V(n.x,n.y,n.z),Math.sin(t*Math.PI)*(o.type==='banana'?.6:1.4));}
    if (activeSurfaceTrack) {
      m.quaternion.setFromUnitVectors(new V(0,1,0),new V(n.x,n.y,n.z));
      m.rotateY(o.type==='banana'?0:o.age*12);
    } else m.rotation.y = o.type==='banana'?0:o.age*12;
  }
  for (const [id, m] of objectMeshes)
    if (!alive.has(id)) {
      scene.remove(m);
      m.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) o.material.dispose();
      });
      objectMeshes.delete(id);
    }
  for(let i=itemImpacts.length-1;i>=0;i--){const impact=itemImpacts[i],age=race.time-impact.start;
    impact.mesh.scale.setScalar(.5+Math.min(1,age/.24)*6);impact.mesh.material.opacity=Math.max(0,.7*(1-age/.5));
    if(age>.5||age<0){scene.remove(impact.mesh);impact.mesh.geometry.dispose();impact.mesh.material.dispose();itemImpacts.splice(i,1);}
  }
  particles.forEach((p, i) => {
    p.life -= paused ? 0 : dt;
    if (p.life > 0) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= 8 * dt;
      particlePos.set([p.x, p.y, p.z], i * 3);
    } else particlePos[i * 3 + 1] = -500;
  });
  particleGeo.attributes.position.needsUpdate = true;
  particleGeo.attributes.color.needsUpdate = true;
  boostFeedback=updateBoostScreen(race.time,p.boost);
  renderer.info.reset();
  renderer.info.autoReset = false;
  if (mode === 'duo') {
    renderer.setScissorTest(true);
    for (let view = 0; view < 2; view++) renderView(dt, now, view);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissor(0, 0, innerWidth, innerHeight);
  } else renderView(dt, now, 0);
  if (!document.hidden) updatePerformance(now);
  renderCount++;
  if (previousDrawTime && !document.hidden) {
    frameTimes.push(now - previousDrawTime);
    if (frameTimes.length > 18000) frameTimes.shift();
  }
  previousDrawTime = now;
  updateHUD();
}
function renderView(dt, now, view) {
  const p = race.players[view], time = race.time;
  const rig = cameraRigs[view];
  const { camera, camTarget, unconstrainedEye, sceneryOffset, cameraAimTarget,
    cameraAim, cameraUp } = rig;
  let { initializedCamera, lastFlightCamera, landingCamera } = rig;
  const viewBoost = mode === 'duo' ? rig.updateBoost(time, p.boost) : boostFeedback;
  const desired = chasePose(p.jump?{...p,surfaceForward:null,surfaceNormal:{x:0,y:1,z:0}}:p);
  // Blend camera offsets after contact so the steep flight camera does not
  // drop instantly to ground chase height. Keep following the moving kart;
  // geometry clearance still runs below after smoothing.
  if (activeSurfaceTrack && race.state === "racing" && !debug.snapCamera) {
    if (p.gliding) {
      lastFlightCamera = {eye: {}, aim: {}, up: {...desired.up}};
      for (const axis of ["x", "y", "z"]) {
        lastFlightCamera.eye[axis] = desired.eye[axis] - p[axis];
        lastFlightCamera.aim[axis] = desired.aim[axis] - p[axis];
      }
      landingCamera = null;
    } else {
      if (lastFlightCamera) {
        landingCamera = {...lastFlightCamera, started: race.time};
        lastFlightCamera = null;
      }
      if (landingCamera) {
        const blend = THREE.MathUtils.smoothstep(race.time - landingCamera.started, 0, .45);
        for (const axis of ["x", "y", "z"]) {
          desired.eye[axis] = THREE.MathUtils.lerp(p[axis] + landingCamera.eye[axis], desired.eye[axis], blend);
          desired.aim[axis] = THREE.MathUtils.lerp(p[axis] + landingCamera.aim[axis], desired.aim[axis], blend);
          desired.up[axis] = THREE.MathUtils.lerp(landingCamera.up[axis], desired.up[axis], blend);
        }
        if (blend === 1) landingCamera = null;
      }
    }
  } else {
    lastFlightCamera = landingCamera = null;
  }
  const finishBlend = p.finishTime === null ? 0 : THREE.MathUtils.smoothstep(race.time - (p.finishedAt ?? race.finishedAt ?? race.time), 0, .9);
  if (p.finishTime !== null) {
    const basis = roadFrame(p.s, p.lateral, p.heading, p.surfaceForward, p.surfaceNormal);
    const angle = Math.PI * (1 - finishBlend), radius = THREE.MathUtils.lerp(9.6, 8, finishBlend);
    for (const axis of ['x', 'y', 'z']) {
      desired.eye[axis] = p[axis] + radius * (basis.forward[axis] * Math.cos(angle) + basis.right[axis] * Math.sin(angle)) + basis.up[axis] * THREE.MathUtils.lerp(3.65, 2.8, finishBlend);
      desired.aim[axis] = THREE.MathUtils.lerp(desired.aim[axis], p[axis] + basis.up[axis] * 1.4, finishBlend);
    }
  }
  if (race.state === "ready") {
    const t = -p.heading - Math.PI*.31 + Math.sin(now*.00008)*.045;
    camTarget.set(p.x + Math.cos(t) * 7.6, p.y + 3.7, p.z + Math.sin(t) * 7.6);
    cameraAimTarget.set(p.x-Math.sin(t)*2.65, p.y + 1.3, p.z+Math.cos(t)*2.65);
    cameraUp.set(0, 1, 0);
  } else {
    camTarget.set(desired.eye.x, desired.eye.y, desired.eye.z);
    cameraAimTarget.set(desired.aim.x, desired.aim.y, desired.aim.z);
    const up = new V(desired.up.x, desired.up.y, desired.up.z);
    cameraUp.lerp(up, 1 - Math.exp(-dt * 7)).normalize();
  }
  if (!initializedCamera || debug.snapCamera) {
    unconstrainedEye.copy(camTarget);
    sceneryOffset.set(0,0,0);
    cameraAim.copy(cameraAimTarget);
    cameraUp.set(desired.up.x, desired.up.y, desired.up.z);
    if (race.state === "ready") cameraUp.set(0, 1, 0);
    initializedCamera = true;
    debug.snapCamera = false;
  } else {
    unconstrainedEye.lerp(camTarget, 1 - Math.exp(-dt * 13));
    cameraAim.lerp(cameraAimTarget, 1 - Math.exp(-dt * 13));
  }
  // Smooth the intended rig independently. Feeding corrected eyes back into
  // smoothing makes the camera repeatedly drift into and jump off the rail.
  const safe = cameraClearance(unconstrainedEye, p.s);
  camera.position.copy(safe);
  const cameraNormal = activeSurfaceTrack && !p.gliding ? (p.surfaceNormal||surfaceAt(p.s,p.lateral).normal) : {x:0,y:1,z:0};
  const cameraFocus = new V(p.x+cameraNormal.x*1.3,p.y+cameraNormal.y*1.3,p.z+cameraNormal.z*1.3);
  const headFocus = driverCameraAnchor(karts[view].model,cameraFocus);
  const upperHeadFocus = driverCameraAnchor(karts[view].model,cameraFocus,true);
  const beforeClearance = camera.position.clone();
  const resolvedEye = clearChaseView(cameraFocus,headFocus,camera.position,
    new V(cameraNormal.x,cameraNormal.y,cameraNormal.z),avoidScenery,upperHeadFocus);
  camera.position.copy(smoothChaseCorrection(beforeClearance,resolvedEye,cameraFocus,
    upperHeadFocus,avoidScenery,sceneryOffset,dt));
  camera.position.copy(cameraClearance(camera.position, p.s));
  camera.up.copy(cameraUp);
  camera.lookAt(clearanceLookTarget(beforeClearance,camera.position,headFocus,cameraAim));
  camera.fov +=
    (57 + viewBoost.strength*5 + viewBoost.kick*2 + (p.gliding ? 3 : 0) - camera.fov) *
    (1 - Math.exp(-dt * 6));
  // Leave the racer visible to the left of the results table.
  if (finishBlend > 0 && mode === 'solo') camera.setViewOffset(innerWidth, innerHeight, innerWidth * .22 * finishBlend, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  key.position.set(p.x - 30, p.y + 60, p.z + 25);
  for (let i = 0; i < trackLights.length; i++) {
    const stationIndex = Math.floor(p.s / 38) + i - 2,
      station = stationIndex * 38,
      side = stationIndex % 2 ? 1 : -1;
    const wrappedStation = ((station % L) + L) % L;
    const pit = wrappedStation < 82 || wrappedStation > L - 42;
    const underpass = wrappedStation >= 95 && wrappedStation <= 135;
    // Place the crossing light beneath its ceiling. The previous elevated
    // spotlight illuminated the road through a solid roof without a shadow map.
    const at = surfaceAt(station, side * (underpass ? 7 : pit ? 10 : 14));
    const light = trackLights[i];
    const lift=underpass ? 6.2 : pit ? 12.7 : 15, n=at.normal||{x:0,y:1,z:0};
    light.position.set(at.x+n.x*lift, at.y+n.y*lift, at.z+n.z*lift);
    const target = surfaceAt(station + (underpass ? 1 : 6), -side * 3);
    light.target.position.set(target.x, target.y, target.z);
    light.color.set(
      underpass
        ? "#ffe0a6"
        : pit
          ? "#ffdfa8"
          : side < 0
            ? "#c0dbff"
            : "#fff0d9",
    );
    light.intensity = underpass ? 85 : pit ? 950 : 1500;
    light.distance = underpass ? 28 : 72;
    light.angle = underpass ? 0.85 : 0.7;
  }
  // Only hide a rival if the camera actually enters its body.
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    k.root.visible = i === view || rivalVisible(k.model, camera);
    // Canopies are wider than the body and need their own clearance.
    k.glider.visible = k.glider.userData.baseVisible;
    if (k.glider.visible) {
      const canopy = k.root.localToWorld(new V(0, 3.3, 0));
      k.glider.visible = camera.position.distanceTo(canopy) > 5.3;
    }
  }
  for (const [i, mesh] of coinMeshes.entries())
    mesh.visible = race.coins[i].respawn === 0 && mesh.getWorldPosition(basisX).distanceTo(camera.position) > 1.6;
  for (const [i, mesh] of boxMeshes.entries())
    mesh.visible = race.boxes[i].respawn === 0 && mesh.getWorldPosition(basisX).distanceTo(camera.position) > 1.2;
  key.target.position.set(p.x, p.y, p.z);
  key.target.updateMatrixWorld();
  if (mode === 'duo') {
    const half = innerWidth / 2;
    camera.aspect = half / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setViewport(view * half, 0, half, innerHeight);
    renderer.setScissor(view * half, 0, half, innerHeight);
    renderer.render(scene, camera);
  } else {
    composer.render();
    broadcast.update(now, camera);
  }
  Object.assign(rig, { initializedCamera, lastFlightCamera, landingCamera });
}
function updateHUD() {
  document.body.classList.toggle("racing", race.state !== "ready");
  if (mode === 'duo') updateDuoHUD();
  const p = race.player,
    position = race.position(p);
  raceNumerals($("coins"), String(p.coins).padStart(2, "0"));
  raceNumerals($("lap"), `${p.lap}/${race.laps}`);
  if(racePosition($('position'),position)){
    $('position').animate([{scale:'1.2'},{scale:'1'}],{duration:240});
  }
  $("speed-number").textContent = Math.round(Math.abs(p.speed) * 3.6);
  $("speed-bar").style.width =
    Math.min(100, (Math.abs(p.speed) / 55) * 100) + "%";
  const recentlyUsed=!p.item && p.itemUse?.age<.16;
  $("item-frame").classList.toggle("empty", !p.item && p.roulette <= 0 && !recentlyUsed);
  updateItemReel(race.time,p.roulette,p.item || (recentlyUsed?p.itemUse.type:null));
  $("item-caption").textContent =
    p.roulette > 0
      ? "ROULETTE"
      : p.item
        ? { green: "GREEN SHELL", red: "RED SHELL", blue: "BLUE SHELL" }[
            p.item
          ] || p.item.toUpperCase()
        : "ITEM";
  $("drift-meter").style.opacity = p.drift ? 1 : 0;
  $("drift-fill").style.width = Math.min(100, (p.charge / 3.4) * 100) + "%";
  $("drift-fill").style.background = [
    "#eef6ff",
    "#43d5ff",
    "#ffaa31",
    "#d986ff",
  ][p.tier];
  $("drift-label").textContent = [
    "HOLD THE DRIFT",
    "MINI-TURBO",
    "SUPER MINI-TURBO",
    "ULTRA MINI-TURBO",
  ][p.tier];

  $("hit-flash").style.opacity = race.time < hitUntil ? 0.6 : 0;
  $("notice").hidden = race.time > noticeUntil || race.state === "countdown";
  $("countdown").hidden = !(
    race.state === "countdown" ||
    (race.state === "racing" && race.time < 3.65)
  );
  const waiting=usingPhone && race.state==='countdown' && !wheel.armed;
  const count=waiting?'':race.count?String(race.count):'GO!';
  $('wheel-ready').hidden=!waiting;
  $('lamps').style.opacity=waiting?'.35':'1';
  if($('count-number').dataset.value!==count){
    $('count-number').dataset.value=count;
    $('count-number').innerHTML=count?raceLettering(count):'';
    $('count-number').getAnimations().forEach(a=>a.cancel());
    if(count && count!=='GO!')$('count-number').animate([{opacity:0,scale:'1.5'},{opacity:1,scale:'1',offset:.18},{opacity:1,scale:'1',offset:.7},{opacity:0,scale:'.9'}],{duration:950});
    if(count==='GO!')$('count-number').animate([{opacity:0,scale:'1.4'},{opacity:1,scale:'1',offset:.2},{opacity:1,scale:'1',offset:.7},{opacity:0,scale:'1.12'}],{duration:650});
  }
  $("lamps").classList.toggle("go", race.count === 0);
  $("lamps")
    .querySelectorAll("i")
    .forEach((el, i) => el.classList.toggle("on", i < 4 - race.count));
  drawMap();
  if (race.state === 'results' && !resultsShown && audio.resultsReady) {
    resultsShown = true;
    $("results").hidden = false;
    $("hud").hidden = true;
    $('duo-hud').hidden = true;
    $("result-summary").textContent = mode === 'duo'
      ? race.players.map((player, i) => `P${i + 1} ${player.character.name} · ${ordinal(race.position(player))} place · ${formatTime(player.finishTime)}`).join('    |    ')
      : `${p.character.name} · ${ordinal(position)} place · ${formatTime(p.finishTime)}`;
    const standings=race.standings.slice();
    resultsPresentation={started:performance.now(),duration:1.2,done:false,times:standings.map(r=>r.finishTime)};
    $('again').disabled=true;
    audio.presentResults(race,resultsPresentation.duration);
    $("standings").innerHTML = standings
      .map(
        (r, i) =>
          `<div class="standing ${r.id < race.humanCount ? "me" : ""}" style="--row:${i}"><b>${i + 1}</b><img src="${portrait(r.character)}" alt=""><span>${r.id < race.humanCount ? `P${r.id + 1} · ` : ''}${r.character.name}</span><span class="time">${r.finishTime === null ? "—" : formatTime(0)}</span></div>`,
      )
      .join("");
  }
  if(resultsShown&&resultsPresentation&&!resultsPresentation.done){
    const elapsed=(performance.now()-resultsPresentation.started)/1000;
    const progress=Math.max(0,Math.min(1,(elapsed-.12)/(resultsPresentation.duration-.12)));
    document.querySelectorAll('#standings .time').forEach((el,i)=>el.textContent=resultsPresentation.times[i] === null ? '—' : formatTime(resultsPresentation.times[i]*progress));
    if(progress===1){resultsPresentation.done=true;$('again').disabled=false;}
  }
}
function updateDuoHUD() {
  if (race.state === 'ready') return;
  for (const [i, p] of race.players.entries()) {
    $(`duo-name-${i}`).textContent = p.character.name;
    racePosition($(`duo-rank-${i}`),race.position(p));
    raceNumerals($(`duo-lap-${i}`),`${Math.min(race.laps, p.lap)}/${race.laps}`);
    raceNumerals($(`duo-coins-${i}`),String(p.coins).padStart(2,'0'));
    raceNumerals($(`duo-speed-${i}`),String(Math.round(Math.abs(p.speed) * 3.6)));
    $(`duo-item-${i}`).textContent = p.roulette > 0 ? 'ITEM ROULETTE' :
      p.item ? p.item.toUpperCase() : 'NO ITEM';
    $(`duo-finish-${i}`).hidden = p.finishTime === null;
    if (!$(`duo-finish-${i}`).dataset.artwork) {
      $(`duo-finish-${i}`).innerHTML = raceLettering('FINISH!');
      $(`duo-finish-${i}`).dataset.artwork = 'true';
    }
  }
}
const mapCtx = $("minimap").getContext("2d");
const mapPortraits = new Map(
  CHARACTERS.map((c) => {
    const im = new Image();
    im.src = portrait(c);
    return [c.id, im];
  }),
);
function drawMap() {
  const c = mapCtx,
    w = 250,
    h = 220,
    to = (x, z) => [
      22 + ((x + 220) / 450) * (w - 44),
      14 + ((z + 240) / 470) * (h - 28),
    ];
  c.clearRect(0, 0, w, h);
  c.lineJoin = "round";
  for (const [width, color] of [
    [10, "#19335050"],
    [7, "#f1f7ffb8"],
  ]) {
    c.beginPath();
    TRACK_SAMPLES.forEach((p, i) => {
      const q = to(p.x, p.z);
      i ? c.lineTo(...q) : c.moveTo(...q);
    });
    c.closePath();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
  }
  const start = trackAt(0),
    q = to(start.x, start.z);
  c.fillStyle = "#ffe879";
  c.fillRect(q[0] - 3, q[1] - 4, 6, 8);
  for (const r of [...race.racers].reverse()) {
    const q = to(r.x, r.z);
    c.beginPath();
    c.arc(...q, r.id ? 4 : 6, 0, Math.PI * 2);
    c.fillStyle = r.character.color;
    c.fill();
    c.strokeStyle = r.id ? "#eef5ff" : "#fff8a1";
    c.lineWidth = r.id ? 1.3 : 3;
    c.stroke();
    const icon = mapPortraits.get(r.character.id);
    if (icon?.complete) {
      const size = r.id ? 15 : 21;
      c.drawImage(icon, q[0] - size / 2, q[1] - size / 2, size, size);
    }
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.1));
  lastFrame = now;
  if (mode === 'duo' && race?.state === 'ready') syncDuoLobby();
  if (!debug.freeze && !paused) {
    if (mode === 'duo') {
      const remotes = [0, 1].map(slot => duoRemote(slot, now));
      const safe = lobby.sameParticipants(duoSlots()) &&
        remotes.every((remote, i) => remote.live && duoMotionReady(i, now));
      if (!safe && !['ready', 'results'].includes(race.state) && now > duoSignalGraceUntil) {
        pause('A wheel signal was lost. Reconnect and level both original phones.');
      } else if (safe) {
        const inputs = remotes.map((remote, i) => {
          const item = duoItemPulses[i] || (remote.item && !lastDuoItems[i]);
          lastDuoItems[i] = remote.item;
          duoItemPulses[i] = false;
          return { gas: remote.gas, brake: remote.brake, drift: remote.drift,
            steer: remote.steer, item };
        });
        race.update(dt, inputs);
      }
      audio.update(race);
      $('wheel-status').textContent = remotes.map((remote, i) => `P${i + 1}: ${remote.status}`).join(' · ');
    } else {
    const remote = wheel.read(now),
      keyboard =
        keys.has("KeyZ") ||
        keys.has("KeyX") ||
        keys.has("ArrowLeft") ||
        keys.has("ArrowRight");
    if (
      usingPhone &&
      !remote.live &&
      phoneHadGas &&
      race.state === "racing" &&
      !keyboard
    ) {
      pause("Wheel signal lost. Hold the phone flat, then press 2 or Enter.");
      phoneHadGas = false;
    }
    phoneHadGas = remote.live && remote.gas;
    const input = {
      gas: keys.has("KeyZ") || remote.gas,
      brake: keys.has("KeyX") || remote.brake,
      drift: keys.has("ShiftLeft") || keys.has("ShiftRight") || remote.drift,
      steer: keyboard
        ? (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0)
        : remote.steer,
      item: itemPulse || (remote.item && !lastRemoteItem),
    };
    lastRemoteItem = remote.item;
    itemPulse = false;
    if (!(usingPhone && race.state === "countdown" && !wheel.armed))
      race.update(dt, input);
    audio.update(race);
    $("wheel-status").textContent = usingPhone
      ? remote.status + (wheel.invert ? " · inverted" : "")
      : "Z gas · X brake · Shift drift · Space item";
    }
  }
  draw(dt || 1 / 60, now);
}
// Explicit developer harness, enabled only by ?evidence=1. Scenario captures
// stage states and are labeled as such in the evidence report; normal keyboard
// and full-race checks are separate. No hidden gameplay shortcuts are shipped.
const debug = {
  get race() {
    return race;
  },
  wheel,
  karts,
  assets: null,
  sourceCourse: !!world.source,
  freeze: false,
  snapCamera: false,
  get audioState() {
    return {
      gain: audio.engine.master?.gain.value,
      frequency: audio.motor?.osc.frequency.value,
      state: audio.engine.ctx?.state,
      enabled: audio.engine.enabled,
      samples: audio.original.state,
      overrides: [...audio.engine.overrides]
        .filter(([, buffer]) => buffer)
        .map(([name]) => name),
    };
  },
  get paused() {
    return paused;
  },
  get renderCount() {
    return renderCount;
  },
  rayAt(x, y) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2((x / innerWidth) * 2 - 1, 1 - (y / innerHeight) * 2),
      camera,
    );
    return ray
      .intersectObjects(scene.children, true)
      .slice(0, 5)
      .map((h) => ({
        name: h.object.name,
        material: h.object.material?.name,
        racer: (() => {
          for (let node = h.object; node; node = node.parent) {
            const kart = karts.find((k) => k.root === node);
            if (kart) return kart.id;
          }
          return null;
        })(),
        color: h.object.material?.color?.getHexString(),
        type: h.object.geometry?.type,
        distance: h.distance,
        point: h.point.toArray(),
        face: h.faceIndex,
      }));
  },
  get broadcastFrames() {
    return broadcast.frames;
  },
  get statue() {
    return world.statue;
  },
  get cameraState() {
    const safe = cameraClearance(camera.position, race.player.s);
    return {
      eye: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      up: camera.up.toArray(),
      fov: camera.fov,
      clearance: Math.hypot(safe.x-camera.position.x,safe.y-camera.position.y,safe.z-camera.position.z),
    };
  },
  get frameTimes() {
    return frameTimes.slice();
  },
  get stats() {
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  },
  get graphics() {
    return { mode, quality: qualityName, gpu, pixelRatio: renderer.getPixelRatio(), ao: ambientOcclusion.enabled, bloom: bloom.enabled, shadows: renderer.shadowMap.enabled, samples: composer.renderTarget1.samples };
  },
};
if (new URLSearchParams(location.search).get("evidence") === "1") {
  window.__kart = debug;
  debug.audioStream = () => audio.original.capture?.stream;
  debug.audioUpdate = () => audio.update(race);
  debug.place = (s, { lateral = 0, speed = 30, lap = 1 } = {}) => {
    const p = surfaceAt(s, lateral),
      r = race.player;
    Object.assign(r, {
      s: wrap(s, L),
      progress: s + (lap - 1) * L,
      x: p.x,
      y: p.y,
      z: p.z,
      lateral,
      heading: p.heading,
      surfaceForward: null,
      surfaceNormal: null,
      speed,
      lap,
      nextCheckpoint: (Math.floor((s + (lap - 1) * L) / (L / 8)) + 1) * (L / 8),
      checkpoints: Math.floor((s + (lap - 1) * L) / (L / 8)),
      anti: p.anti,
    });
    debug.snapCamera = true;
  };
  debug.stage = (name) => {
    constructRace();
    syncPickupPools();
    race.start();
    race.state = "racing";
    race.time = 10;
    $("intro").hidden = true;
    $("track-label").hidden = true;
    $("hud").hidden = false;
    debug.freeze = true;
    const r = race.player;
    if (name === "start") {
      race.state = "countdown";
      race.count = 3;
      race.time = 0.5;
      r.speed = 0;
    }
    if (name === "drift") {
      debug.place(controlDistancesFor("drift"));
      r.drift = 1;
      r.charge = 3.5;
      r.tier = 3;
      r.steer = 0.6;
      noticeUntil = 0;
    }
    if (name === "antigrav") {
      debug.place(SECTIONS.antiStart + 330);
      r.anti = true;
    }
    if (name === "glider") {
      debug.place(SECTIONS.glideStart + 35);
      r.gliding = true;
      r.y = 30;
      r.flightY = 30;
      r.flight = 1;
      r.anti = false;
    }
    if (name === "hit") {
      debug.place(170);
      race.hit(r, "red");
    }
    if (name === "results") {
      // Run the real CPU planner and finish-line logic for all eight racers.
      race = new Race({ character: selected, seed: 42, onEvent: () => {} });
      race.start();
      for (let i = 0; i < 30000 && race.state !== "results"; i++)
        race.update(1 / 120, race.cpuInput(race.player));
      debug.snapCamera = true;
    }
    debug.snapCamera = true;
    draw(1 / 60, performance.now());
  };
  debug.step = (seconds, input) => {
    for (let i = 0; i < seconds * 120; i++)
      race.update(
        1 / 120,
        typeof input === "string" && input === "cpu"
          ? race.cpuInput(race.player)
          : input,
      );
    draw(1 / 60, performance.now());
  };
  debug.resume = resume;
}
function controlDistancesFor() {
  return 310;
}
constructRace();
syncPickupPools();
audio.prepare();
requestAnimationFrame(frame);
window.addEventListener("resize", () => {
  applyGraphics();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
$("fullscreen").addEventListener("click", toggleFullscreen);
window.addEventListener("keydown", (e) => {
  if (e.target.closest?.('#graphics-panel')) return;
  if (e.repeat) return;
  if (e.code === "KeyF") toggleFullscreen();
  if (e.code === "KeyC") document.body.classList.toggle("capture");
});
