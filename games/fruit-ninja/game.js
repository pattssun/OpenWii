'use strict';

/**
 * Fruit Ninja — PC game client (OpenWii).
 *
 * Receives phone orientation over Socket.io, maps it to a screen-space blade
 * cursor, and runs the game loop on a 2D canvas.
 *
 * Layout of this file:
 *   1. Canvas + resize
 *   2. Vector helpers + orientation decoding
 *   3. Calibration                (grip detection, neutral pose, swing range)
 *   4. Sensor → cursor mapping
 *   5. Blade trail
 *   6. Entities: fruit, halves, particles
 *   7. Collision (segment ↔ circle)
 *   8. Game state machine
 *   9. Render
 *  10. Input / networking
 */

// ═══ 1. Canvas ═════════════════════════════════════════════════════════════
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;
let booted = false;   // true once the cursor/aim state below exists

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // A hidden or minimised window reports 0×0. Left as-is that collapses every
  // clamp to zero and parks the blade in the top-left corner for good once the
  // window comes back, so floor it and pull the aim state into the new bounds.
  W = Math.max(1, window.innerWidth);
  H = Math.max(1, window.innerHeight);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // `booted` rather than a typeof check: `aim` is a const declared further
  // down, and typeof on a binding in its temporal dead zone still throws.
  if (booted) {
    aim.x = clamp(aim.x, 0, W);
    aim.y = clamp(aim.y, 0, H);
    cursor.x = clamp(cursor.x, 0, W);
    cursor.y = clamp(cursor.y, 0, H);
  }
}
window.addEventListener('resize', resize);
resize();

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ═══ 2. Vectors + orientation decoding ═════════════════════════════════════
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * The phone's three body axes expressed in world coordinates.
 *
 * Rows of the W3C ZXY rotation matrix R = Rz(alpha)·Rx(beta)·Ry(gamma) give the
 * world axes; its *columns* give the device axes, which is what we want — we
 * care about where the phone is pointing, not where north is.
 *
 *   x → right edge      y → top edge      z → out of the screen
 */
function bodyAxes(alpha, beta, gamma) {
  const z = alpha * DEG;
  const x = beta * DEG;
  const y = gamma * DEG;
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const cX = Math.cos(x);
  const sX = Math.sin(x);
  const cY = Math.cos(y);
  const sY = Math.sin(y);
  return {
    x: { x: cZ * cY - sZ * sX * sY, y: sZ * cY + cZ * sX * sY, z: -cX * sY },
    y: { x: -sZ * cX, y: cZ * cX, z: sX },
    z: { x: cZ * sY + sZ * sX * cY, y: sZ * sY - cZ * sX * cY, z: cX * cY },
  };
}

/**
 * Same three body axes, straight from a quaternion.
 *
 * The Generic Sensor API (`AbsoluteOrientationSensor`) reports device→world
 * rotation as a quaternion using the same ENU convention as the Euler triple,
 * so the columns mean exactly what they do above — and we skip Euler decoding
 * entirely, which is strictly better numerically.
 */
function bodyAxesFromQuat(q) {
  const [x, y, z, w] = q;
  return {
    x: { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + z * w), z: 2 * (x * z - y * w) },
    y: { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) },
    z: { x: 2 * (x * z + y * w), y: 2 * (y * z - x * w), z: 1 - 2 * (x * x + y * y) },
  };
}

/** Accept either representation the controller might be streaming. */
function axesFromSample(sample) {
  return sample.quat
    ? bodyAxesFromQuat(sample.quat)
    : bodyAxes(sample.alpha, sample.beta, sample.gamma);
}

/** Shortest signed difference a−b, wrapped to (−180, 180]. */
function angleDelta(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

// ═══ 3. Calibration ════════════════════════════════════════════════════════
/**
 * Why calibration is not optional.
 *
 * The naive approach — treat the phone's top edge as the aim axis and read yaw
 * straight off `alpha` — breaks the moment the player's grip differs from the
 * one you assumed. Hold the phone upright like a TV remote and the top edge
 * points at the ceiling: yaw becomes numerically meaningless (it is the gimbal
 * singularity), and swinging sideways moves the blade *not at all*.
 *
 * So instead of assuming a grip, we measure one:
 *
 *   1. Watch until the phone is genuinely still, then snapshot that pose.
 *   2. Pick whichever body axis is closest to horizontal in that pose — that is
 *      the axis the player is actually pointing with. Flat-in-palm grips resolve
 *      to the top edge; upright remote grips resolve to the phone's back.
 *   3. Build an orthonormal frame (forward / right / up) around it. All angles
 *      are then measured *relative to the player's own neutral pose*, which puts
 *      the singularity 90° away from where they are actually holding it.
 *   4. Watch a few practice swings and size the screen mapping to the range they
 *      actually swing through.
 */
const frame = {
  f: null,      // forward (unit)
  r: null,      // right
  u: null,      // up
  axis: 'y',    // which body axis turned out to be "forward"
  yaw0: 0,      // neutral offset, re-zeroed at the centre of the swing range
  pitch0: 0,
};

const STEADY_MS = 700;              // how long the phone must hold still
const STEADY_KEEP_MS = STEADY_MS * 1.6;
const STEADY_GIVE_UP_MS = 6000;     // never strand the player on this screen
const COS_STEADY = Math.cos(5 * DEG);

const cal = {
  active: false,
  step: 'signal',                   // signal → steady → range → done
  stepSince: 0,
  steadyBuf: [],
  yawMin: 0,
  yawMax: 0,
  pitchMin: 0,
  pitchMax: 0,
  done: false,
};

/** Build a frame around whichever axis the player is pointing with. */
function buildFrame(axes) {
  // Smaller |z| means closer to horizontal.
  const useTopEdge = Math.abs(axes.y.z) <= Math.abs(axes.z.z);
  const f = useTopEdge ? axes.y : scale(axes.z, -1);   // -z = out the phone's back

  // Gram-Schmidt world-up against forward to get the frame's up vector.
  let u = sub({ x: 0, y: 0, z: 1 }, scale(f, f.z));
  const ulen = Math.hypot(u.x, u.y, u.z);
  if (ulen < 1e-3) return null;                        // pointing dead vertical
  u = scale(u, 1 / ulen);

  return { f, u, r: cross(f, u), axis: useTopEdge ? 'y' : 'z' };
}

function forwardOf(axes) {
  return frame.axis === 'y' ? axes.y : scale(axes.z, -1);
}

/** Yaw/pitch of the phone measured inside the calibrated frame. */
function anglesIn(fwd) {
  return {
    yaw: Math.atan2(dot(fwd, frame.r), dot(fwd, frame.f)) / DEG - frame.yaw0,
    pitch: Math.asin(clamp(dot(fwd, frame.u), -1, 1)) / DEG - frame.pitch0,
  };
}

function adoptFrame(built) {
  frame.f = built.f;
  frame.u = built.u;
  frame.r = built.r;
  frame.axis = built.axis;
  frame.yaw0 = 0;
  frame.pitch0 = 0;
}

function setCalStep(step, now) {
  cal.step = step;
  cal.stepSince = now;
  sendCalibration();
}

function startCalibration() {
  cal.active = true;
  cal.done = false;
  cal.steadyBuf.length = 0;
  frame.f = null;
  prev = null;
  state.phase = 'calibrating';
  $('overlay').classList.add('hide');
  recentre();
  setCalStep('signal', performance.now());
}

/** Snap the blade and its filters back to the middle of the screen. */
function recentre() {
  aim.x = W / 2;
  aim.y = H / 2;
  cursor.x = W / 2;
  cursor.y = H / 2;
  filterX.reset();
  filterY.reset();
  trail.length = 0;
}

function advanceCalibration(axes, now) {
  if (cal.step === 'signal') {
    // First packet through the door — we have a live sensor.
    setCalStep('steady', now);
    return;
  }

  if (cal.step === 'steady') {
    cal.steadyBuf.push({ t: now, y: axes.y, z: axes.z });
    while (cal.steadyBuf.length > 1 && now - cal.steadyBuf[0].t > STEADY_KEEP_MS) cal.steadyBuf.shift();

    // Gate on elapsed *sample time*, not sample count. Counting samples would
    // quietly impose a minimum sensor rate — a phone streaming at 4Hz, or a
    // stuttering link, could satisfy "held still" forever and never pass.
    const spans = cal.steadyBuf.length >= 2 && now - cal.steadyBuf[0].t >= STEADY_MS;
    // Every sample in the window must be within ~5° of where we are now.
    const agrees = cal.steadyBuf.every(
      (s) => dot(s.y, axes.y) > COS_STEADY && dot(s.z, axes.z) > COS_STEADY,
    );
    // Shaky hands shouldn't dead-end the flow; take the pose we have.
    const givenUp = now - cal.stepSince > STEADY_GIVE_UP_MS;

    if ((spans && agrees) || givenUp) {
      const built = buildFrame(axes);
      if (built) {
        adoptFrame(built);
        cal.yawMin = 0;
        cal.yawMax = 0;
        cal.pitchMin = 0;
        cal.pitchMax = 0;
        if (givenUp) flash('close enough — using that pose');
        setCalStep('range', now);
      } else if (givenUp) {
        // Pointing dead vertical: no usable frame exists from this pose.
        flash('hold the phone more level, then hold still');
        cal.stepSince = now;
      }
    }
    return;
  }

  if (cal.step === 'range') {
    const spanX = cal.yawMax - cal.yawMin;
    const spanY = cal.pitchMax - cal.pitchMin;
    const elapsed = now - cal.stepSince;
    // Enough of a sweep in both axes, or they have had long enough to try.
    if ((spanX > 30 && spanY > 14 && elapsed > 2600) || elapsed > 10000) finishCalibration();
  }
}

function finishCalibration() {
  const spanX = clamp(cal.yawMax - cal.yawMin, 25, 150);
  const spanY = clamp(cal.pitchMax - cal.pitchMin, 14, 110);

  // Map the range they actually swung through onto the screen, with a little
  // margin so the corners stay comfortably reachable.
  map.degPerScreenX = spanX * 0.9;
  map.degPerScreenY = spanY * 0.9;

  // The middle of their swing is the natural neutral — re-zero there rather
  // than wherever their arm happened to stop.
  frame.yaw0 += (cal.yawMin + cal.yawMax) / 2;
  frame.pitch0 += (cal.pitchMin + cal.pitchMax) / 2;

  cal.active = false;
  cal.done = true;
  cal.step = 'done';
  prev = null;
  recentre();
  sendCalibration();
  flash(`calibrated · ${Math.round(spanX)}° × ${Math.round(spanY)}° swing · ${frame.axis === 'y' ? 'flat grip' : 'upright grip'}`);
  startGame();
}

/** Mid-game re-centre: keep the sensitivity, just re-zero the neutral pose. */
function quickRecentre() {
  if (!lastAxes) {
    flash('no sensor data yet');
    return;
  }
  const built = buildFrame(lastAxes);
  if (!built) {
    flash('point the phone more level, then press C');
    return;
  }
  adoptFrame(built);
  prev = null;
  recentre();
  flash('re-centred');
}

function sendCalibration() {
  socket.emit('feedback', {
    type: 'calibration',
    step: cal.active ? cal.step : 'done',
    active: cal.active,
  });
}

// ═══ 4. Sensor → cursor mapping ════════════════════════════════════════════
/**
 *   relative — integrates the *change* in yaw/pitch, like a mouse. Grip-
 *              agnostic, drifts slowly, so a soft spring pulls toward centre.
 *   absolute — cursor position is the angle off neutral. Laser pointer; no
 *              drift. Genuinely usable now that neutral is calibrated.
 *   gyro     — integrate rotationRate directly. Ignores the magnetometer.
 */
const MAPPINGS = ['relative', 'absolute', 'gyro'];

const map = {
  mode: 'relative',
  sensitivity: 1,
  degPerScreenX: 55,
  degPerScreenY: 38,
  recenter: 0.35,
  invertX: false,
  invertY: false,
};

const cursor = { x: W / 2, y: H / 2, live: false, lastSeen: 0 };

/**
 * Unfiltered aim accumulator.
 *
 * Relative mode integrates deltas onto `aim`, and `cursor` is the *filtered*
 * view of it. Accumulating onto the filtered value instead would be a slow
 * poison: filtering gives cursor = prev + α(target − prev), so feeding it
 * target = cursor + delta collapses to cursor += α·delta — every movement
 * scaled by the smoothing coefficient, which at rest is about 0.14. Small and
 * medium swings would land at a seventh of their intended size.
 */
const aim = { x: W / 2, y: H / 2 };
booted = true;

const sensor = { yaw: 0, pitch: 0, roll: 0, hz: 0, alpha: 0, beta: 0, gamma: 0, source: '—' };

let prev = null;          // previous {yaw, pitch}, for relative mode
let lastAxes = null;      // most recent decoded body axes

/**
 * One Euro filter — adaptive low-pass. Heavy smoothing when the blade is
 * nearly still (kills IMU jitter), almost none when it's swinging (keeps
 * slashes crisp). A plain moving average would smear every fast slice.
 */
class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.05, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (TAU * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, dt) {
    if (this.x === null) {
      this.x = value;
      return value;
    }
    const dRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

const filterX = new OneEuro(1.6, 0.012);
const filterY = new OneEuro(1.6, 0.012);

function setCursor(nx, ny) {
  cursor.x = clamp(nx, 0, W);
  cursor.y = clamp(ny, 0, H);
  cursor.live = true;
  cursor.lastSeen = performance.now();
}

/** Turn one orientation sample into a cursor position. */
function applyOrientation(sample, dt) {
  const axes = axesFromSample(sample);
  lastAxes = axes;
  sensor.alpha = sample.alpha || 0;
  sensor.beta = sample.beta || 0;
  sensor.gamma = sample.gamma || 0;
  sensor.roll = sensor.gamma;
  sensor.source = sample.quat ? 'quaternion' : 'euler';
  cursor.live = true;
  cursor.lastSeen = performance.now();

  if (cal.active) advanceCalibration(axes, performance.now());
  if (!frame.f) return;                       // no usable frame yet

  const fwd = forwardOf(axes);
  const { yaw, pitch } = anglesIn(fwd);
  sensor.yaw = yaw;
  sensor.pitch = pitch;

  if (cal.active && cal.step === 'range') {
    cal.yawMin = Math.min(cal.yawMin, yaw);
    cal.yawMax = Math.max(cal.yawMax, yaw);
    cal.pitchMin = Math.min(cal.pitchMin, pitch);
    cal.pitchMax = Math.max(cal.pitchMax, pitch);
  }

  const pxPerDegX = (W / map.degPerScreenX) * map.sensitivity * (map.invertX ? -1 : 1);
  const pxPerDegY = (H / map.degPerScreenY) * map.sensitivity * (map.invertY ? -1 : 1);

  let tx;
  let ty;

  if (map.mode === 'absolute') {
    tx = W / 2 + yaw * pxPerDegX;
    ty = H / 2 - pitch * pxPerDegY;
  } else if (map.mode === 'gyro' && sample.motion) {
    const { rx, ry, rz } = sample.motion;
    const omega = { x: rx || 0, y: ry || 0, z: rz || 0 };
    // Angular velocity is reported in the body frame; project it onto the
    // calibrated frame's up (yaw) and right (pitch) axes.
    const yawRate = dot(omega, { x: dot(axes.x, frame.u), y: dot(axes.y, frame.u), z: dot(axes.z, frame.u) });
    const pitchRate = dot(omega, { x: dot(axes.x, frame.r), y: dot(axes.y, frame.r), z: dot(axes.z, frame.r) });
    tx = aim.x - yawRate * dt * pxPerDegX;
    ty = aim.y - pitchRate * dt * pxPerDegY;
  } else {
    if (!prev) prev = { yaw, pitch };
    // Near ±90° of pitch the forward vector is almost vertical and yaw stops
    // meaning anything — freeze horizontal motion rather than let it spin.
    const dYaw = Math.abs(dot(fwd, frame.u)) > 0.985 ? 0 : angleDelta(yaw, prev.yaw);
    const dPitch = angleDelta(pitch, prev.pitch);
    prev = { yaw, pitch };

    tx = aim.x + dYaw * pxPerDegX;
    ty = aim.y - dPitch * pxPerDegY;

    // Gentle spring to centre so accumulated drift never strands the blade.
    if (map.recenter) {
      tx += (W / 2 - tx) * map.recenter * dt;
      ty += (H / 2 - ty) * map.recenter * dt;
    }
  }

  aim.x = clamp(tx, 0, W);
  aim.y = clamp(ty, 0, H);
  setCursor(filterX.filter(aim.x, dt), filterY.filter(aim.y, dt));
}

// ═══ 5. Blade trail ════════════════════════════════════════════════════════
const TRAIL_MS = 140;
const trail = [];
let newSegments = [];

function updateTrail(now) {
  const last = trail[trail.length - 1];
  newSegments = [];

  if (!last || Math.hypot(cursor.x - last.x, cursor.y - last.y) > 0.7) {
    if (last) newSegments.push({ x1: last.x, y1: last.y, x2: cursor.x, y2: cursor.y });
    trail.push({ x: cursor.x, y: cursor.y, t: now });
  }
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
}

/**
 * Blade speed measured over a short window of trail history rather than from a
 * single sample. One-sample velocity divides by the packet inter-arrival time,
 * so a network hitch or a dropped frame manufactures a huge bogus speed — which
 * would let a motionless blade slice. A window is stable across those stalls.
 */
const SPEED_WINDOW_MS = 55;

function bladeSpeed() {
  if (trail.length < 2) return 0;
  const last = trail[trail.length - 1];
  let i = trail.length - 1;
  while (i > 0 && last.t - trail[i - 1].t < SPEED_WINDOW_MS) i -= 1;
  const first = trail[i];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  return Math.hypot(last.x - first.x, last.y - first.y) / dt;
}

function drawTrail(now) {
  if (trail.length < 2) return;

  for (const pass of [
    { width: 26, color: 'rgba(255,120,150,0.30)', blur: 24 },
    { width: 9, color: 'rgba(255,255,255,0.95)', blur: 0 },
  ]) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = pass.blur;
    ctx.shadowColor = '#ff5f6d';
    ctx.strokeStyle = pass.color;

    for (let i = 1; i < trail.length; i += 1) {
      const a = trail[i - 1];
      const b = trail[i];
      const taper = Math.max(0, 1 - (now - b.t) / TRAIL_MS);
      ctx.globalAlpha = taper * taper;
      ctx.lineWidth = pass.width * taper;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 18;
  ctx.shadowColor = '#ff5f6d';
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, 5, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ═══ 6. Entities ═══════════════════════════════════════════════════════════
const GRAVITY = 1500;

const FRUITS = [
  { name: 'watermelon', rind: '#2f8f4e', flesh: '#ff4d5e', juice: '#ff4d5e', r: 52 },
  { name: 'orange', rind: '#ff9f1c', flesh: '#ffbe55', juice: '#ff9f1c', r: 42 },
  { name: 'lime', rind: '#7ec850', flesh: '#c9e88a', juice: '#7ec850', r: 38 },
  { name: 'plum', rind: '#8e5cd9', flesh: '#d9b8ff', juice: '#8e5cd9', r: 40 },
  { name: 'peach', rind: '#ff7a6b', flesh: '#ffd0b0', juice: '#ff7a6b', r: 44 },
  { name: 'blueberry', rind: '#4d7cff', flesh: '#a8c0ff', juice: '#4d7cff', r: 34 },
];

const fruits = [];
const halves = [];
const particles = [];
const pops = [];

function spawnFruit(isBomb) {
  const kind = FRUITS[(Math.random() * FRUITS.length) | 0];
  const scaleF = clamp(Math.min(W, H) / 900, 0.7, 1.35);
  const x = rand(W * 0.12, W * 0.88);
  const rise = rand(H * 0.55, H * 0.88);

  fruits.push({
    x,
    y: H + 60,
    vx: ((W / 2 - x) / (H / 400)) * rand(0.4, 1.1),
    vy: -Math.sqrt(2 * GRAVITY * rise),
    r: (isBomb ? 40 : kind.r) * scaleF,
    rot: rand(0, TAU),
    spin: rand(-2.4, 2.4),
    bomb: !!isBomb,
    kind,
    born: performance.now(),
  });
}

function sliceFruit(f, angle) {
  const perp = angle + Math.PI / 2;
  for (const side of [-1, 1]) {
    halves.push({
      x: f.x,
      y: f.y,
      vx: f.vx + Math.cos(perp) * side * rand(90, 170),
      vy: f.vy + Math.sin(perp) * side * rand(90, 170) - 60,
      r: f.r,
      rot: angle,
      spin: side * rand(1.5, 4),
      side,
      kind: f.kind,
      life: 1,
    });
  }

  for (let i = 0; i < 22; i += 1) {
    const a = angle + rand(-0.9, 0.9) + (Math.random() < 0.5 ? 0 : Math.PI);
    const s = rand(80, 460);
    particles.push({
      x: f.x, y: f.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - rand(0, 140),
      r: rand(2.5, 8), color: f.kind.juice, life: 1, decay: rand(0.7, 1.6),
    });
  }
}

function explode(f) {
  for (let i = 0; i < 90; i += 1) {
    const a = rand(0, TAU);
    const s = rand(120, 900);
    particles.push({
      x: f.x, y: f.y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      r: rand(2, 9), color: Math.random() < 0.5 ? '#ffd166' : '#ff5f6d',
      life: 1, decay: rand(0.6, 1.4),
    });
  }
}

// ═══ 7. Collision ══════════════════════════════════════════════════════════
function segmentDistance(cx, cy, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(cx - x1, cy - y1);
  const t = clamp(((cx - x1) * dx + (cy - y1) * dy) / lenSq, 0, 1);
  return Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy));
}

const MIN_SLICE_SPEED = 260;

// ═══ 8. Game state ═════════════════════════════════════════════════════════
const state = {
  phase: 'idle',       // idle | calibrating | playing | over
  score: 0,
  best: Number(localStorage.getItem('fn.best') || 0),
  lives: 3,
  combo: 0,
  comboUntil: 0,
  nextSpawn: 0,
  startedAt: 0,
  debug: false,
  toast: '',
  toastUntil: 0,
};

function flash(text) {
  state.toast = text;
  state.toastUntil = performance.now() + 2200;
}

function startGame() {
  state.phase = 'playing';
  state.score = 0;
  state.lives = 3;
  state.combo = 0;
  state.startedAt = performance.now();
  state.nextSpawn = performance.now() + 900;
  fruits.length = 0;
  halves.length = 0;
  particles.length = 0;
  pops.length = 0;
  trail.length = 0;
  $('overlay').classList.add('hide');
  syncHud();
}

function endGame() {
  state.phase = 'over';
  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem('fn.best', String(state.best));
  }
  socket.emit('feedback', { type: 'bomb' });

  $('panel').innerHTML = `
    <h1>💥 <em>Sliced Out</em></h1>
    <div id="final">You scored <b>${state.score}</b> — best <b>${state.best}</b></div>
    <p>Swing again when you're ready.</p>
    <div class="cta">
      <strong>Space</strong> to play again · <strong>R</strong> to recalibrate
    </div>`;
  $('overlay').classList.remove('hide');
  syncHud();
}

function addScore(n, x, y) {
  state.score += n;
  pops.push({ x, y, text: `+${n}`, life: 1 });
  syncHud();
}

function syncHud() {
  $('score-v').textContent = state.score;
  $('best').textContent = `Best ${Math.max(state.best, state.score)}`;
  const dots = $('lives').children;
  for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('on', i < state.lives);
}

function spawnInterval() {
  return Math.max(320, 1000 - ((performance.now() - state.startedAt) / 1000) * 12);
}
function bombChance() {
  return clamp(0.04 + ((performance.now() - state.startedAt) / 1000) * 0.0022, 0, 0.2);
}

// ═══ 9. Update + render ════════════════════════════════════════════════════
let lastFrame = performance.now();

function stepDebris(dt) {
  for (let i = halves.length - 1; i >= 0; i -= 1) {
    const h = halves[i];
    h.vy += GRAVITY * dt;
    h.x += h.vx * dt;
    h.y += h.vy * dt;
    h.rot += h.spin * dt;
    if (h.y - h.r > H + 120) halves.splice(i, 1);
  }
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.vy += GRAVITY * 0.55 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i -= 1) {
    pops[i].y -= 44 * dt;
    pops[i].life -= 1.3 * dt;
    if (pops[i].life <= 0) pops.splice(i, 1);
  }
}

function update(now, dt) {
  // Mouse fallback keeps the game playable (and testable) without a phone.
  if (!cursor.live && mouse.active) setCursor(mouse.x, mouse.y);

  updateTrail(now);
  stepDebris(dt);

  if (state.phase !== 'playing') return;

  if (now >= state.nextSpawn) {
    const burst = Math.random() < 0.22 ? 3 : Math.random() < 0.45 ? 2 : 1;
    for (let i = 0; i < burst; i += 1) spawnFruit(Math.random() < bombChance());
    state.nextSpawn = now + spawnInterval();
  }

  const canCut = bladeSpeed() > MIN_SLICE_SPEED && newSegments.length > 0;

  for (let i = fruits.length - 1; i >= 0; i -= 1) {
    const f = fruits[i];
    f.vy += GRAVITY * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.rot += f.spin * dt;

    if (canCut) {
      for (const s of newSegments) {
        if (segmentDistance(f.x, f.y, s.x1, s.y1, s.x2, s.y2) > f.r) continue;

        fruits.splice(i, 1);
        if (f.bomb) {
          explode(f);
          endGame();
        } else {
          sliceFruit(f, Math.atan2(s.y2 - s.y1, s.x2 - s.x1));
          state.combo = now < state.comboUntil ? state.combo + 1 : 1;
          state.comboUntil = now + 260;
          addScore(1 + (state.combo > 1 ? state.combo : 0), f.x, f.y);
          socket.emit('feedback', { type: 'slice', combo: state.combo });
        }
        break;
      }
    }

    if (f.y - f.r > H + 80 && fruits[i] === f) {
      fruits.splice(i, 1);
      if (!f.bomb && state.phase === 'playing') {
        state.lives -= 1;
        socket.emit('feedback', { type: 'miss' });
        syncHud();
        if (state.lives <= 0) endGame();
      }
    }
  }

  const comboEl = $('combo');
  const showCombo = state.combo > 1 && now < state.comboUntil + 700;
  comboEl.classList.toggle('on', showCombo);
  if (showCombo) comboEl.textContent = `${state.combo}× COMBO!`;
  else if (state.combo > 1 && now >= state.comboUntil) state.combo = 0;
}

function drawFruitBody(r, kind, isBomb) {
  if (isBomb) {
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.15, 0, 0, r);
    g.addColorStop(0, '#4a5164');
    g.addColorStop(1, '#12151d');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = '#ff5f6d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.5, -r * 1.5, r * 0.75, -r * 1.15);
    ctx.stroke();

    ctx.fillStyle = '#ffd166';
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#ffd166';
    ctx.beginPath();
    ctx.arc(r * 0.78, -r * 1.15, rand(3, 5.5), 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    return;
  }

  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, kind.flesh);
  g.addColorStop(0.55, kind.rind);
  g.addColorStop(1, '#00000055');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(-r * 0.34, -r * 0.4, r * 0.2, r * 0.13, -0.6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ── Calibration screen ─────────────────────────────────────────────────────
const CAL_COPY = {
  signal: {
    title: 'Waiting for the phone',
    body: 'Open the controller page and tap Enable motion sensors.',
  },
  steady: {
    title: 'Hold still',
    body: 'Grip the phone however feels natural and point it at this screen.',
  },
  range: {
    title: 'Swing it around',
    body: 'Big sweeps — left and right, then up and down. As far as you would in play.',
  },
};

/** Greedy word wrap against the current ctx font. */
function wrapText(text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCalibration(now) {
  const copy = CAL_COPY[cal.step];
  if (!copy) return;

  ctx.save();
  ctx.fillStyle = 'rgba(11,14,20,0.55)';
  ctx.fillRect(0, 0, W, H);

  // Scale with the viewport — this screen has to survive narrow windows.
  const titleSize = clamp(W / 18, 22, 46);
  const bodySize = clamp(W / 52, 13, 18);
  const maxWidth = W * 0.82;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8ecf4';
  ctx.font = `800 ${titleSize}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(copy.title, W / 2, H * 0.24);

  ctx.fillStyle = '#8b95ad';
  ctx.font = `500 ${bodySize}px -apple-system, system-ui, sans-serif`;
  wrapText(copy.body, maxWidth).forEach((line, i) => {
    ctx.fillText(line, W / 2, H * 0.24 + titleSize * 0.8 + i * (bodySize * 1.45));
  });

  const cx = W / 2;
  const cy = H * 0.55;

  if (cal.step === 'signal') {
    ctx.fillStyle = '#59637a';
    ctx.font = '600 14px ui-monospace, Menlo, monospace';
    ctx.fillText(`${sensor.hz.toFixed(0)} Hz from phone`, cx, cy);
  }

  if (cal.step === 'steady') {
    // Ring fills while the phone stays put; it empties the moment they move.
    const held = clamp((now - cal.stepSince) / STEADY_MS, 0, 1);
    const steadyNow = cal.steadyBuf.length > 4 ? held : 0;
    ctx.strokeStyle = '#232a3b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, 58, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = '#35d07f';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, 58, -Math.PI / 2, -Math.PI / 2 + TAU * steadyNow);
    ctx.stroke();

    ctx.fillStyle = '#8b95ad';
    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.fillText(`${sensor.hz.toFixed(0)} Hz`, cx, cy + 5);
  }

  if (cal.step === 'range') {
    // Show the swept box growing against the screen's aspect.
    const bw = W * 0.34;
    const bh = bw * (H / W);
    const spanX = clamp((cal.yawMax - cal.yawMin) / 60, 0, 1);
    const spanY = clamp((cal.pitchMax - cal.pitchMin) / 30, 0, 1);

    ctx.strokeStyle = '#232a3b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(53,208,127,0.18)';
    ctx.strokeStyle = '#35d07f';
    ctx.beginPath();
    ctx.roundRect(cx - (bw * spanX) / 2, cy - (bh * spanY) / 2, bw * spanX, bh * spanY, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#8b95ad';
    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.fillText(
      `${(cal.yawMax - cal.yawMin).toFixed(0)}° × ${(cal.pitchMax - cal.pitchMin).toFixed(0)}°`,
      cx, cy + bh / 2 + 26,
    );
  }

  ctx.fillStyle = '#59637a';
  ctx.font = `500 ${bodySize * 0.8}px -apple-system, system-ui, sans-serif`;
  ctx.fillText('Space to skip · R to start over', W / 2, H - 60);
  ctx.restore();
}

function render(now) {
  const bg = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#1a2233');
  bg.addColorStop(1, '#0b0e14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * clamp(p.life, 0.2, 1), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const h of halves) {
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.rot);
    ctx.beginPath();
    ctx.rect(-h.r * 1.1, h.side < 0 ? -h.r * 1.1 : 0, h.r * 2.2, h.r * 1.1);
    ctx.clip();
    drawFruitBody(h.r, h.kind, false);
    ctx.fillStyle = h.kind.flesh;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.ellipse(0, 0, h.r * 0.94, h.r * 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  for (const f of fruits) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    drawFruitBody(f.r, f.kind, f.bomb);
    ctx.restore();
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '800 30px -apple-system, system-ui, sans-serif';
  for (const p of pops) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.restore();

  if (state.phase === 'calibrating') drawCalibration(now);

  drawTrail(now);

  if (state.toast && now < state.toastUntil) {
    ctx.save();
    ctx.globalAlpha = clamp((state.toastUntil - now) / 500, 0, 1);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b95ad';
    ctx.font = '600 14px -apple-system, system-ui, sans-serif';
    ctx.fillText(state.toast.toUpperCase(), W / 2, H - 78);
    ctx.restore();
  }

  if (state.debug) drawDebug();
}

function drawDebug() {
  const lines = [
    `mode        ${map.mode}`,
    `grip        ${frame.f ? (frame.axis === 'y' ? 'flat (top edge)' : 'upright (back)') : '—'}`,
    `sensitivity ${map.sensitivity.toFixed(2)}`,
    `screen span ${map.degPerScreenX.toFixed(0)}° × ${map.degPerScreenY.toFixed(0)}°`,
    `yaw/pitch   ${sensor.yaw.toFixed(1)}° / ${sensor.pitch.toFixed(1)}°`,
    `raw abg     ${sensor.alpha.toFixed(0)} ${sensor.beta.toFixed(0)} ${sensor.gamma.toFixed(0)} (${sensor.source})`,
    `aim         ${aim.x.toFixed(0)}, ${aim.y.toFixed(0)}`,
    `cursor      ${cursor.x.toFixed(0)}, ${cursor.y.toFixed(0)}`,
    `blade speed ${bladeSpeed().toFixed(0)} px/s`,
    `sensor rate ${sensor.hz.toFixed(0)} Hz`,
    `entities    ${fruits.length}f ${halves.length}h ${particles.length}p`,
  ];
  ctx.save();
  ctx.fillStyle = '#0b0e14dd';
  ctx.strokeStyle = '#232a3b';
  ctx.beginPath();
  ctx.roundRect(W - 320, 24, 296, lines.length * 20 + 22, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#8b95ad';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  lines.forEach((l, i) => ctx.fillText(l, W - 304, 48 + i * 20));
  ctx.restore();
}

function frame_(now) {
  requestAnimationFrame(frame_);
  const dt = Math.min((now - lastFrame) / 1000, 1 / 20);
  lastFrame = now;
  if (dt <= 0) return;

  if (cursor.live && now - cursor.lastSeen > 500) cursor.live = false;

  update(now, dt);
  render(now);
}
requestAnimationFrame(frame_);

// ═══ 10. Input + networking ════════════════════════════════════════════════
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => socket.emit('register', 'game'));

socket.on('presence', ({ controller }) => {
  const on = controller > 0;
  $('dot').classList.toggle('on', on);
  $('link-t').textContent = on ? 'sword connected' : 'no sword connected';
  if (on && state.phase === 'idle') {
    $('cta').innerHTML = 'Sword linked. Press <strong>Space</strong> to calibrate and play.';
  }
});

let sensorSamples = 0;
let sensorMark = performance.now();
let lastSensorT = 0;

socket.on('orientation', (data) => {
  const now = performance.now();
  const dt = lastSensorT ? clamp((now - lastSensorT) / 1000, 1 / 240, 0.1) : 1 / 60;
  lastSensorT = now;
  applyOrientation(data, dt);

  sensorSamples += 1;
  if (now - sensorMark >= 1000) {
    sensor.hz = (sensorSamples * 1000) / (now - sensorMark);
    sensorSamples = 0;
    sensorMark = now;
  }
});

socket.on('command', (cmd) => {
  if (cmd.type === 'calibrate') startCalibration();
  else if (cmd.type === 'recentre') quickRecentre();
  else if (cmd.type === 'start') beginPlay();
});

/** Space / phone Start: calibrate first if we never have, otherwise just play. */
function beginPlay() {
  if (state.phase === 'calibrating') {
    // Skip straight past calibration using whatever we have so far.
    if (!frame.f && lastAxes) {
      const built = buildFrame(lastAxes);
      if (built) adoptFrame(built);
    }
    cal.active = false;
    cal.step = 'done';
    sendCalibration();
    startGame();
    return;
  }
  if (cursor.live && !cal.done) startCalibration();
  else startGame();
}

const mouse = { x: W / 2, y: H / 2, active: false };
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.active = true;
});

window.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      if (state.phase !== 'playing') beginPlay();
      break;
    case 'r':
      startCalibration();
      break;
    case 'c':
      quickRecentre();
      break;
    case 'm':
      map.mode = MAPPINGS[(MAPPINGS.indexOf(map.mode) + 1) % MAPPINGS.length];
      prev = null;
      flash(`mapping: ${map.mode}`);
      break;
    case 'arrowright':
      map.sensitivity = clamp(map.sensitivity * 1.12, 0.2, 6);
      flash(`sensitivity ${map.sensitivity.toFixed(2)}`);
      break;
    case 'arrowleft':
      map.sensitivity = clamp(map.sensitivity / 1.12, 0.2, 6);
      flash(`sensitivity ${map.sensitivity.toFixed(2)}`);
      break;
    case 'x':
      map.invertX = !map.invertX;
      flash(`invert X: ${map.invertX}`);
      break;
    case 'y':
      map.invertY = !map.invertY;
      flash(`invert Y: ${map.invertY}`);
      break;
    case 'd':
      state.debug = !state.debug;
      break;
    default:
      break;
  }
});

fetch('/api/pairing')
  .then((r) => r.json())
  .then(({ url, qr }) => {
    $('pair-qr').src = qr;
    $('pair-url').textContent = url;
  })
  .catch(() => {
    $('pair-url').textContent = 'open /controller on your phone';
  });

syncHud();
