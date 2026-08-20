'use strict';

/**
 * Phone controller — a Wii-remote face that reads DeviceOrientation /
 * DeviceMotion and streams it to the PC game client at ~60Hz.
 *
 * Sensor events fire at their own cadence (60Hz on iOS, sometimes faster on
 * Android). Rather than emit on every event, we latch the newest sample and
 * flush it immediately, rate-capped — that guarantees we always send the
 * *freshest* reading without flooding the wire.
 *
 * The UI is the remote itself: A/B, the −⌂+ row, 1/2, a speaker grille that
 * lights up when the remote "speaks" (slice haptics + a little swoosh from the
 * phone, the way the real one did it), and player LEDs that blink while
 * pairing and go solid on a slot.
 */

const socket = io({ transports: ['websocket', 'polling'] });

const $ = (id) => document.getElementById(id);
const els = {
  net: $('net'), dotNet: $('dot-net'), hz: $('hz'), player: $('player'),
  gate: $('gate'), enable: $('enable'),
  remote: $('remote'), stage: $('stage'),
  btnA: $('btn-a'), btnB: $('btn-b'),
  btnHome: $('btn-home'), btnMinus: $('btn-minus'), btnPlus: $('btn-plus'),
  btn1: $('btn-1'), btn2: $('btn-2'), power: $('power'),
  speaker: $('speaker'), leds: $('leds'), sheet: $('sheet'),
  rates: $('rates'), diag: $('diag'), diagBody: $('diag-body'),
  diagTitle: $('diag-title'), diagDump: $('diag-dump'),
};

let enabledAt = 0;   // when the user granted sensor permission
let gameConnected = false;

// ── Haptics + the remote's little speaker ──────────────────────────────────
const buzz = (pattern) => { if (navigator.vibrate) navigator.vibrate(pattern); };

/**
 * The real remote's party trick was sound from your hand. A tiny synth stands
 * in for it: a swoosh on a slice, a thud on a bomb, a click on A.
 */
let actx = null;
function phoneAudioUnlock() {
  if (actx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try { actx = new Ctx(); } catch { /* no audio, no problem */ }
}

function pSound(kind) {
  if (!actx || actx.state !== 'running') { if (actx) actx.resume(); return; }
  const t0 = actx.currentTime;
  const g = actx.createGain();
  g.connect(actx.destination);
  if (kind === 'click') {
    const o = actx.createOscillator();
    o.type = 'square'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    o.connect(g); o.start(t0); o.stop(t0 + 0.06);
  } else if (kind === 'swoosh') {
    const frames = Math.floor(actx.sampleRate * 0.12);
    const buf = actx.createBuffer(1, frames, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i += 1) d[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = actx.createBufferSource();
    src.buffer = buf;
    const f = actx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(2400, t0);
    f.frequency.exponentialRampToValueAtTime(500, t0 + 0.12);
    g.gain.value = 0.12;
    src.connect(f).connect(g); src.start(t0);
  } else if (kind === 'thud') {
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t0);
    o.frequency.exponentialRampToValueAtTime(50, t0 + 0.25);
    g.gain.setValueAtTime(0.18, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    o.connect(g); o.start(t0); o.stop(t0 + 0.3);
  }
}

let talkTimer = 0;
function speakerTalk(ms = 220) {
  els.speaker.classList.add('talk');
  clearTimeout(talkTimer);
  talkTimer = setTimeout(() => els.speaker.classList.remove('talk'), ms);
}

// ── Connection status ──────────────────────────────────────────────────────
// Text detail lives in the button-2 sheet; the remote itself carries the
// state like the real one did — player LEDs blink while pairing and go
// solid on a slot, and the power button glows blue when linked to the PC,
// red when the server is unreachable.
function setNet(text, state) {
  els.net.textContent = text;
  els.dotNet.className = `dot ${state || ''}`;
  els.power.classList.toggle('err', state === 'err');
  els.power.classList.toggle('linked', state !== 'err' && gameConnected);
}

function syncLeds() {
  const linked = gameConnected && playerSlot !== null;
  els.leds.classList.toggle('seek', !linked);
  const lights = els.leds.children;
  for (let i = 0; i < lights.length; i += 1) {
    lights[i].classList.toggle('on', linked && i === playerSlot);
  }
}

socket.on('connect', () => {
  socket.emit('register', 'controller');
  setNet('waiting for PC…', '');
  syncLeds();
});
socket.on('disconnect', () => { setNet('disconnected', 'err'); gameConnected = false; syncLeds(); });
socket.on('connect_error', () => setNet('server unreachable', 'err'));

socket.on('presence', ({ game }) => {
  gameConnected = game > 0;
  setNet(gameConnected ? 'linked to PC' : 'waiting for PC…', gameConnected ? 'on' : '');
  if (gameConnected) buzz(15);
  syncLeds();
});

// Latency probe — echo straight back. The PC times the round trip, because a
// one-way timestamp would need the two devices' clocks to agree, and they don't.
socket.on('ping-probe', ({ id }) => socket.emit('pong-probe', { id }));

let playerSlot = null;
socket.on('slot', ({ slot }) => {
  playerSlot = slot;
  els.player.textContent = `P${slot + 1}`;
  els.player.classList.remove('hide');
  syncLeds();
});
socket.on('slot-denied', ({ max }) => {
  setNet(`all ${max} player slots are full`, 'err');
});

// Game feedback lands in the hand: haptics + the speaker grille lighting up.
socket.on('feedback', (msg) => {
  if (msg.type === 'slice') {
    buzz(msg.combo > 2 ? [12, 18, 22] : 18);
    speakerTalk();
    pSound('swoosh');
  } else if (msg.type === 'bomb') {
    buzz([60, 40, 120]);
    speakerTalk(500);
    pSound('thud');
  } else if (msg.type === 'miss') {
    buzz(8);
  } else if (msg.type === 'launch') {
    speakerTalk(120);
  }
});

// ── Sensor plumbing ────────────────────────────────────────────────────────
let latest = null;      // newest orientation sample, flushed rate-capped
let motion = null;      // newest acceleration sample
let streaming = false;
let rawEvents = 0;      // orientation events fired, including empty ones
let sensorEvents = 0;   // events that carried usable angles
let usingGenericSensor = false;

let orientationSource = null;

function onOrientation(e) {
  rawEvents += 1;

  // Reject empty readings BEFORE latching onto a source. Some devices fire
  // 'deviceorientationabsolute' with all-null values when the magnetometer
  // hasn't calibrated; latching to that stream first would permanently lock
  // out the perfectly good 'deviceorientation' events behind it.
  if (e.alpha === null && e.beta === null && e.gamma === null) return;

  // Android fires BOTH 'deviceorientation' (alpha relative to an arbitrary
  // start heading) and 'deviceorientationabsolute' (alpha relative to true
  // north). Letting both write here interleaves two different yaw origins, and
  // the PC's frame-to-frame deltas become noise. Pick one stream and stay on
  // it — absolute if this device offers it, since it doesn't drift.
  if (e.type === 'deviceorientationabsolute') orientationSource = e.type;
  else if (orientationSource === null) orientationSource = e.type;
  if (e.type !== orientationSource) return;

  sensorEvents += 1;
  latest = {
    alpha: e.alpha || 0,
    beta: e.beta || 0,
    gamma: e.gamma || 0,
    // iOS exposes a true-north heading; useful as a drift-free yaw source.
    heading: typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null,
  };
  flush();
}

/**
 * Send the moment the sensor speaks.
 *
 * rAF-latching added up to a full frame of pure delay before the packet even
 * left the device — the rate cap below does the same job for free.
 */
const MIN_EMIT_MS = 6;    // ~166Hz ceiling; real sensors run well under this
let lastEmit = 0;

function flush() {
  if (!streaming || !latest) return;
  const now = performance.now();
  if (now - lastEmit < MIN_EMIT_MS) return;
  lastEmit = now;
  socket.emit('orientation', { ...latest, motion, t: now });
  sent += 1;
}

function onMotion(e) {
  const a = e.acceleration || e.accelerationIncludingGravity;
  const r = e.rotationRate;
  if (!a && !r) return;
  motion = {
    ax: a ? a.x || 0 : 0,
    ay: a ? a.y || 0 : 0,
    az: a ? a.z || 0 : 0,
    // The raw gyroscope. Unlike `deviceorientation` — which is the OS's fused
    // attitude estimate and carries that fusion's latency — this is a direct
    // readout of angular velocity, and it is what makes the cursor feel
    // immediate. The PC integrates it and corrects against orientation.
    rz: r ? r.alpha || 0 : 0,
    rx: r ? r.beta || 0 : 0,
    ry: r ? r.gamma || 0 : 0,
  };
  // Send on the motion event too. Gating the gyro behind orientation events
  // would throw away exactly the freshness we're here for.
  flush();
}

// ── Capability probe ───────────────────────────────────────────────────────
/**
 * Chrome gates every motion sensor behind a secure context, and it does so
 * *silently*: `addEventListener('deviceorientation')` succeeds, no error is
 * raised, and events simply never fire. On Android there is no
 * requestPermission() either, so nothing ever reports a denial. An insecure
 * origin is therefore indistinguishable from a broken phone unless you go
 * looking — hence this probe.
 */
function capabilities() {
  const hasDOE = typeof DeviceOrientationEvent !== 'undefined';
  return {
    origin: location.origin,
    secureContext: window.isSecureContext === true,
    deviceOrientationEvent: hasDOE,
    requestPermission: hasDOE && typeof DeviceOrientationEvent.requestPermission === 'function',
    absoluteOrientationSensor: typeof window.AbsoluteOrientationSensor === 'function',
    relativeOrientationSensor: typeof window.RelativeOrientationSensor === 'function',
  };
}

async function sensorPermissionStates() {
  if (!navigator.permissions) return { permissions: 'unsupported' };
  const out = {};
  for (const name of ['accelerometer', 'gyroscope', 'magnetometer']) {
    try {
      out[name] = (await navigator.permissions.query({ name })).state;
    } catch {
      out[name] = 'unqueryable';
    }
  }
  return out;
}

async function renderDiagnostics(headline, detail) {
  const caps = capabilities();
  const perms = await sensorPermissionStates();
  els.diag.classList.remove('hide');
  els.sheet.classList.add('open');
  els.diagTitle.textContent = headline;
  els.diagBody.textContent = detail;
  els.diagDump.textContent = JSON.stringify({ ...caps, ...perms, ua: navigator.userAgent }, null, 1);
}

// ── Generic Sensor API fallback ────────────────────────────────────────────
/**
 * When `deviceorientation` produces nothing, fall back to the Generic Sensor
 * API. Two reasons: Chrome implements it well, and unlike the legacy events it
 * reports *named* failures (SecurityError, NotAllowedError, NotReadableError)
 * instead of silence — so even when it can't work, it tells us why.
 *
 * It reports a quaternion, which the PC prefers anyway: no Euler angles, no
 * gimbal edge cases in the decode.
 */
let genericSensor = null;

const SENSOR_ERRORS = {
  SecurityError: 'Blocked by the browser. This page must be served over HTTPS — an insecure origin cannot read motion sensors.',
  NotAllowedError: 'Motion sensors are blocked for this site. Chrome → ⋮ → Settings → Site settings → Motion sensors → allow.',
  NotReadableError: 'This device reports no orientation sensor available.',
};

function startGenericSensor() {
  const Ctor = window.AbsoluteOrientationSensor || window.RelativeOrientationSensor;
  if (!Ctor) return false;

  try {
    // Ask for 120Hz; the browser clamps to what the hardware offers. Every
    // extra Hz shortens the packet interval the PC's dead reckoning covers.
    genericSensor = new Ctor({ frequency: 120, referenceFrame: 'device' });
  } catch (err) {
    renderDiagnostics('⚠️ Sensor unavailable', SENSOR_ERRORS[err.name] || err.message);
    return false;
  }

  genericSensor.addEventListener('reading', () => {
    const q = genericSensor.quaternion;
    if (!q) return;
    rawEvents += 1;
    sensorEvents += 1;
    usingGenericSensor = true;
    // [x, y, z, w], device → world (ENU), same convention as the legacy matrix.
    latest = { quat: [q[0], q[1], q[2], q[3]] };
    els.diag.classList.add('hide');
  });

  genericSensor.addEventListener('error', (ev) => {
    const name = ev.error && ev.error.name;
    renderDiagnostics('⚠️ Sensor error', SENSOR_ERRORS[name] || `${name}: ${ev.error && ev.error.message}`);
  });

  try {
    genericSensor.start();
    return true;
  } catch (err) {
    renderDiagnostics('⚠️ Sensor unavailable', SENSOR_ERRORS[err.name] || err.message);
    return false;
  }
}

/** iOS 13+ requires an explicit, user-gesture-triggered permission grant. */
async function requestSensors() {
  const caps = capabilities();

  // Refuse to pretend. Without a secure context nothing below can ever fire.
  if (!caps.secureContext) {
    await renderDiagnostics(
      '⚠️ Not a secure page',
      `This page is served from ${location.origin}, which browsers treat as insecure — motion sensors are blocked outright. Restart the server with "npm start" (HTTPS) and open the https:// address instead.`,
    );
    throw new Error('needs HTTPS for sensors');
  }

  if (!caps.deviceOrientationEvent && !caps.absoluteOrientationSensor && !caps.relativeOrientationSensor) {
    await renderDiagnostics('⚠️ No orientation API', 'This browser exposes no orientation sensor API at all.');
    throw new Error('no orientation API');
  }

  if (caps.requestPermission) {
    const state = await DeviceOrientationEvent.requestPermission();
    if (state !== 'granted') throw new Error('Motion permission denied');
  }
  if (typeof DeviceMotionEvent !== 'undefined'
      && typeof DeviceMotionEvent.requestPermission === 'function') {
    try { await DeviceMotionEvent.requestPermission(); } catch { /* optional */ }
  }

  // 'deviceorientation' is relative to an arbitrary start heading on some
  // devices; the absolute variant is world-referenced where available.
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('devicemotion', onMotion, true);

  // Watchdog: legacy events fail silently, so if nothing has fired shortly
  // after attaching, escalate to the API that actually reports its errors.
  setTimeout(() => {
    if (rawEvents > 0) return;
    if (!startGenericSensor()) {
      renderDiagnostics(
        '⚠️ No sensor data',
        'No orientation events fired and no fallback sensor is available. Check Chrome → Settings → Site settings → Motion sensors.',
      );
    }
  }, 1500);
}

els.enable.addEventListener('click', async () => {
  els.enable.disabled = true;
  phoneAudioUnlock();
  try {
    await requestSensors();
    streaming = true;
    enabledAt = performance.now();
    els.gate.classList.add('hide');
    els.remote.classList.remove('asleep');
    buzz([10, 40, 18]);
    speakerTalk(400);
    keepAwake();
    // Zero the mapping the moment the sword goes live.
    socket.emit('command', { type: 'calibrate' });
  } catch (err) {
    els.enable.disabled = false;
    setNet(err.message, 'err');
  }
});

// ── The remote's buttons ───────────────────────────────────────────────────
// Everything sends on pointerdown, not click — a click waits for the finger to
// lift, which reads as lag when you're holding a remote.
function onPress(el, fn, pattern = 10) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    buzz(pattern);
    fn();
  });
}

onPress(els.btnA, () => { socket.emit('command', { type: 'button', button: 'A' }); pSound('click'); }, 12);
onPress(els.btnB, () => socket.emit('command', { type: 'button', button: 'B' }), 10);
// HOME does what it did on the console: back to the menu.
onPress(els.btnHome, () => socket.emit('command', { type: 'button', button: 'B' }), 10);
onPress(els.btnMinus, () => socket.emit('command', { type: 'speed', factor: 1 / 1.12 }), 6);
onPress(els.btnPlus, () => socket.emit('command', { type: 'speed', factor: 1.12 }), 6);
onPress(els.btn1, () => socket.emit('command', { type: 'recentre' }), 8);
onPress(els.btn2, () => els.sheet.classList.toggle('open'), 8);
onPress(els.power, () => speakerTalk(250), [5, 30, 10]);
for (const dp of document.querySelectorAll('.dp')) {
  if (dp.tagName === 'BUTTON') onPress(dp, () => {}, 6);
}

// Tap outside the sheet to close it.
document.addEventListener('pointerdown', (e) => {
  if (els.sheet.classList.contains('open')
      && !els.sheet.contains(e.target) && e.target !== els.btn2) {
    els.sheet.classList.remove('open');
  }
});

/** Stop the screen sleeping mid-game; the phone gets no touch input while swinging. */
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      let lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try { lock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
        }
      });
    }
  } catch { /* not fatal */ }
}

// ── Readouts + the remote tilting in your hand ─────────────────────────────
let sent = 0;
let hzMark = performance.now();
let lastSensorCount = 0;

/**
 * Surface the two failure modes that otherwise look identical from the phone:
 * sensors not firing at all, vs. sensors fine but packets not reaching the PC.
 */
function updateDiagnostics(now, elapsed) {
  const sensorHz = Math.round(((sensorEvents - lastSensorCount) * 1000) / elapsed);
  const sentHz = Math.round((sent * 1000) / elapsed);
  lastSensorCount = sensorEvents;

  const source = usingGenericSensor ? 'OrientationSensor' : 'deviceorientation';
  els.hz.textContent = `${sentHz} Hz`;
  els.rates.textContent = `sensor ${sensorHz} Hz · sent ${sentHz} Hz · ${transportName()} · ${source}`;

  if (!streaming) return;
  if (sensorEvents === 0 && now - enabledAt > 3500) {
    // The generic-sensor path reports its own, more specific errors; don't
    // stomp on them with a generic message.
    if (!els.diag.classList.contains('hide')) return;
    renderDiagnostics(
      '⚠️ No sensor data',
      rawEvents > 0
        ? 'Orientation events are firing but arriving empty. Move the phone in a figure-8 to settle its compass.'
        : 'No orientation events are firing. On iOS: Settings → Apps → Safari → Motion & Orientation Access. On Chrome: ⋮ → Settings → Site settings → Motion sensors.',
    );
  } else if (sensorEvents > 0) {
    els.diag.classList.add('hide');
  }
}

function transportName() {
  try {
    return socket.io.engine.transport.name;
  } catch {
    return 'offline';
  }
}

/**
 * Angles purely for the on-screen tilt — the PC does its own decoding from
 * whichever representation arrives.
 */
function displayAngles(sample) {
  if (!sample.quat) {
    return { yaw: sample.alpha, pitch: sample.beta, roll: sample.gamma };
  }
  const [x, y, z, w] = sample.quat;
  // Column 2 of the rotation matrix: the device's +Y axis in world coords.
  const c2 = { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) };
  return {
    yaw: (Math.atan2(c2.x, c2.y) * 180) / Math.PI,
    pitch: (Math.asin(Math.max(-1, Math.min(1, c2.z))) * 180) / Math.PI,
    roll: 0,
  };
}

// The remote leans with the real one — a small parallax that makes the page
// feel like an object rather than a form. Smoothed so it drifts, not jitters.
const lean = { x: 0, y: 0 };
const clampN = (v, m) => Math.max(-m, Math.min(m, v));

function tick(now) {
  requestAnimationFrame(tick);

  if (streaming && latest) {
    const a = displayAngles(latest);
    // beta ≈ 45° is a natural hold; lean relative to that, gently.
    const tx = clampN((a.pitch - 40) * 0.14, 7);
    const ty = clampN((a.roll || 0) * 0.18, 9);
    lean.x += (tx - lean.x) * 0.12;
    lean.y += (ty - lean.y) * 0.12;
    els.remote.style.transform = `rotateX(${(-lean.x).toFixed(2)}deg) rotateY(${lean.y.toFixed(2)}deg)`;
  }

  // Outside the guard above: the "no sensor data" warning has to run precisely
  // when there is no sensor data, which is exactly when `latest` stays null.
  if (now - hzMark >= 1000) {
    updateDiagnostics(now, now - hzMark);
    sent = 0;
    hzMark = now;
  }
}
requestAnimationFrame(tick);

// Kill pull-to-refresh / rubber-banding so swinging never scrolls the page.
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// Preflight: an insecure origin can never read sensors, so say so up front
// rather than letting the player tap Enable and watch nothing happen.
if (!window.isSecureContext) {
  els.enable.textContent = '⚠️ Sensors need HTTPS';
  els.enable.disabled = true;
  renderDiagnostics(
    '⚠️ Not a secure page',
    `Served from ${location.origin}. Browsers block motion sensors on insecure origins — and they do it silently. Restart with "npm start" (HTTPS) and open the https:// address.`,
  );
}
