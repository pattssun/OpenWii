'use strict';

/**
 * Phone controller — reads DeviceOrientation/DeviceMotion and streams it to the
 * PC game client at ~60Hz.
 *
 * Sensor events fire at their own cadence (60Hz on iOS, sometimes faster on
 * Android). Rather than emit on every event, we latch the newest sample and
 * flush it on requestAnimationFrame — that hard-caps the wire rate at the
 * display refresh and guarantees we always send the *freshest* reading.
 */

const socket = io({ transports: ['websocket', 'polling'] });

const $ = (id) => document.getElementById(id);
const els = {
  net: $('net'), dotNet: $('dot-net'), hz: $('hz'),
  gate: $('gate'), live: $('live'), enable: $('enable'),
  calibrate: $("calibrate"), recentre: $("recentre"),
  btnA: $("btn-a"), btnB: $("btn-b"),
  yaw: $('v-yaw'), pitch: $('v-pitch'), roll: $('v-roll'),
  canvas: $('c'), cal: $('cal'), calTitle: $('cal-title'), calBody: $('cal-body'),
  rates: $('rates'), diag: $('diag'), diagBody: $('diag-body'),
  player: $("player"),
  diagTitle: $('diag-title'), diagDump: $('diag-dump'),
};

let enabledAt = 0;   // when the user granted sensor permission

let gameConnected = false;

// ── Connection status ──────────────────────────────────────────────────────
function setNet(text, state) {
  els.net.textContent = text;
  els.dotNet.className = `dot ${state || ''}`;
}

socket.on('connect', () => {
  socket.emit('register', 'controller');
  setNet('waiting for PC…', '');
});
socket.on('disconnect', () => setNet('disconnected', 'err'));
socket.on('connect_error', () => setNet('server unreachable', 'err'));

socket.on('presence', ({ game }) => {
  gameConnected = game > 0;
  setNet(gameConnected ? 'linked to PC' : 'waiting for PC…', gameConnected ? 'on' : '');
});

// Latency probe — echo straight back. The PC times the round trip, because a
// one-way timestamp would need the two devices' clocks to agree, and they don't.
socket.on('ping-probe', ({ id }) => socket.emit('pong-probe', { id }));

let playerSlot = 0;
socket.on('slot', ({ slot }) => {
  playerSlot = slot;
  els.player.textContent = `Player ${slot + 1}`;
  els.player.classList.remove('hide');
});
socket.on('slot-denied', ({ max }) => {
  setNet(`all ${max} player slots are full`, 'err');
});

// Calibration prompts mirrored from the PC — you're holding the phone, not
// looking at the monitor, so the instructions have to be here too.
const CAL_COPY = {
  signal: ['📡 Connecting', 'Waiting for sensor data…'],
  steady: ['🧍 Hold still', 'Point it at the screen and keep it steady — measuring your hand.'],
  range: ['🌀 Swing it around', 'Left and right, then up AND down. It ends when you stop.'],
  done: ['🎮 Ready', 'Point and swing.'],
};

function showCalibration(step) {
  const copy = CAL_COPY[step] || CAL_COPY.done;
  els.calTitle.textContent = copy[0];
  els.calBody.textContent = copy[1];
  els.cal.classList.toggle('active', step !== 'done');
}

socket.on('feedback', (msg) => {
  if (msg.type === 'calibration') {
    showCalibration(msg.step);
    if (navigator.vibrate && msg.step === 'range') navigator.vibrate(30);
    return;
  }
  // Haptics on a slice — the whole point of holding a real object.
  if (!navigator.vibrate) return;
  if (msg.type === 'slice') navigator.vibrate(msg.combo > 2 ? [12, 18, 22] : 18);
  else if (msg.type === 'bomb') navigator.vibrate([60, 40, 120]);
  else if (msg.type === 'miss') navigator.vibrate(8);
});

// ── Sensor plumbing ────────────────────────────────────────────────────────
let latest = null;      // newest orientation sample, flushed on rAF
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
 * This used to latch the newest sample and flush it on the phone's own
 * requestAnimationFrame, to cap the wire rate. But rAF is tied to the phone's
 * display refresh, so it added up to a full frame of pure delay before the
 * packet even left the device — and the rate cap below does the same job
 * without costing anything.
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
    genericSensor = new Ctor({ frequency: 60, referenceFrame: 'device' });
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
  try {
    await requestSensors();
    streaming = true;
    enabledAt = performance.now();
    els.gate.classList.add('hide');
    els.live.classList.remove('hide');
    resizeViz();
    keepAwake();
    // Zero the mapping the moment the sword goes live.
    socket.emit('command', { type: 'calibrate' });
  } catch (err) {
    els.enable.disabled = false;
    setNet(err.message, 'err');
  }
});

els.calibrate.addEventListener('click', () => socket.emit('command', { type: 'calibrate' }));
els.recentre.addEventListener('click', () => socket.emit('command', { type: 'recentre' }));

// A and B. Sent on pointerdown rather than click so the press lands as soon as
// the finger does — a click waits for release, which reads as lag on a remote.
for (const [el, button] of [[els.btnA, 'A'], [els.btnB, 'B']]) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    socket.emit('command', { type: 'button', button });
    if (navigator.vibrate) navigator.vibrate(10);
  });
}

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

// ── 60Hz flush loop ────────────────────────────────────────────────────────
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

function tick(now) {
  requestAnimationFrame(tick);

  // Sending happens in flush(), on the sensor event. This loop is only for the
  // on-screen readouts, which have no reason to be on the latency path.
  if (streaming && latest) {
    const a = displayAngles(latest);
    els.yaw.textContent = Math.round(a.yaw);
    els.pitch.textContent = Math.round(a.pitch);
    els.roll.textContent = Math.round(a.roll);
    drawViz(a);
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

/**
 * Angles purely for the on-screen readout — the PC does its own decoding from
 * whichever representation arrives. Quaternion samples are reduced to the
 * heading/elevation of the phone's top edge, which is the intuitive thing to
 * watch while you wave it about.
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

// ── Tilt visualiser ────────────────────────────────────────────────────────
const ctx = els.canvas.getContext('2d');
let vw = 0;
let vh = 0;

function resizeViz() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = els.canvas.getBoundingClientRect();
  vw = r.width;
  vh = r.height;
  els.canvas.width = Math.round(vw * dpr);
  els.canvas.height = Math.round(vh * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeViz);

function drawViz(angles) {
  if (!vw || !latest) return;
  ctx.clearRect(0, 0, vw, vh);

  const cx = vw / 2;
  const cy = vh / 2;
  const len = Math.min(vw, vh) * 0.36;

  // Blade angle mirrors roll; length shortens as the phone pitches away.
  const roll = (angles.roll * Math.PI) / 180;
  const lean = Math.cos((angles.pitch * Math.PI) / 180);

  ctx.strokeStyle = '#232a3b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, len, 0, Math.PI * 2);
  ctx.stroke();

  const dx = Math.sin(roll) * len * lean;
  const dy = -Math.cos(roll) * len * Math.abs(lean);

  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  grad.addColorStop(0, '#2b3448');
  grad.addColorStop(1, '#ff5f6d');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - dx, cy - dy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();
}

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
