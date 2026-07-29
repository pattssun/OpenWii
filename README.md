# 🕹 OpenWii

Motion-controlled games for your computer. **Your phone is the remote.**

Open a page on your PC, scan a QR code with your phone, and swing. No app, no
dongle, no console — the phone's IMU streams over your LAN and drives the game.

```
phone IMU ──60Hz──▶ Socket.io ──▶ Node relay ──▶ PC canvas ──▶ cursor + gameplay
```

## Run it

```bash
npm install
npm start
```

1. Open **https://localhost:8443/** on the PC — the launcher shows a QR code.
2. Scan it with your phone (same Wi-Fi). Accept the certificate warning.
3. Tap **Enable motion sensors**.
4. Pick a game and play. No calibration step — the pointer learns your
   phone's gyroscope conventions from the first second of motion.

Grip the phone however is comfortable — flat in your palm like a Wii remote, or
upright like a TV remote.

### Why HTTPS — this is the #1 thing that breaks

Browsers gate every motion sensor behind a secure context, and `http://192.168.x.x`
is **not** one. Chrome enforces this *silently*: `addEventListener('deviceorientation')`
succeeds, no error is thrown, and events simply never fire. On Android there's no
`requestPermission()` either, so nothing ever reports a denial. An insecure origin
is indistinguishable from a broken phone unless you go looking.

So the controller refuses to pretend: on a non-secure origin it disables the
Enable button, says why, and dumps the full capability report.

The server generates a self-signed cert on first boot and regenerates it when
your LAN IP changes — click through the warning once per device. `HTTP=1 npm start`
forces plain HTTP; fine for working on a game loop with a mouse, useless for
actual phone control.

## Games

| Game | | |
| --- | --- | --- |
| 🍉 **Fruit Ninja** | Swing the phone like a sword. Slice fruit, dodge bombs. Up to 4 phones, same board. | [`games/fruit-ninja`](games/fruit-ninja) |
| ⚔️ **Swordplay** | Duel a fencer foe — swing to strike, hold your blade to block. | [`games/swordplay`](games/swordplay) |
| 🏓 **Table Tennis** | Track the ball, swing at contact for pace. First to 11. | [`games/table-tennis`](games/table-tennis) |
| ⛳ **Golf** | Drive, approach, putt. Swing hard off the tee, soft on the green. | [`games/golf`](games/golf) |
| 🛩 **Island Flyover** | Hold the phone flat like a paper plane and thread 20 rings. | [`games/island-flyover`](games/island-flyover) |
| 🏎 **Kart Time Trial** | Tilt to steer. Three laps, one clock, and your own ghost. | [`games/kart`](games/kart) |

## Adding a game

Drop a folder into `games/` with an `index.html`. The server discovers it on
boot and the launcher lists it — there is no registry to edit.

```
games/your-game/
  index.html     loads /socket.io/socket.io.js, then your own game.js
  game.json      { title, tagline, emoji }   ← optional, for the launcher card
```

Your game client registers as the `game` role and listens for `orientation`:

```js
const socket = io();
socket.on('connect', () => socket.emit('register', 'game'));
socket.on('orientation', (sample) => { /* sample.alpha/beta/gamma or sample.quat */ });
socket.emit('feedback', { type: 'slice' });   // → phone haptics
```

Fruit Ninja's [`game.js`](games/fruit-ninja/game.js) carries the reference
implementation of the orientation→cursor mapping described below. It is not yet
extracted into a shared module — the second game is the right time to do that,
once there's real evidence about which parts generalise.

## Architecture

```
server.js              Express + Socket.io relay. Holds no game state.
scripts/gen-cert.js    Self-signed cert with your LAN IP in the SANs.
core/                  The motion engine. Renderer- and game-agnostic.
  orientation.js         phone attitude → world-space body axes
  calibration.js         grip detection, neutral pose, swing range
  pointer.js             mapping modes incl. hybrid drift correction
  filter.js  trail.js    One Euro filter, gesture history + speed
  audio.js               synthesized cues with file override
  net.js                 relay client, player slots, latency probe
public/index.html      Launcher: pairing QR + game list.
public/controller.*    The remote. Shared by every game.
games/<slug>/          One folder per game, auto-discovered.
  logic.js               pure game logic — testable in Node
  game.js                Three.js renderer
```

Run `npm test` for the suite: 9 core regressions covering the documented bugs,
plus 8 game mechanics tests. Game logic is kept free of Three.js and the DOM
precisely so it can be tested headlessly rather than by evaluating JavaScript in
a browser tab.

The server is a dumb switchboard — `orientation` and `motion` go phone→PC,
`command` (calibrate/start) goes phone→PC, `feedback` (slice/bomb/miss) goes
PC→phone for haptics.

**Nothing is sent `volatile`.** Volatile looks perfect for a 60Hz sensor stream —
drop a stale sample rather than queue it — but Socket.IO discards volatile
packets whenever `transport.writable` is false, and on the **long-polling**
transport that is true most of the time. Measured on a polling connection:
**6 of 100 volatile packets delivered, versus all 100 plain ones.** A connection
that falls back to polling (easy to trigger with a self-signed cert) therefore
loses essentially the whole orientation stream while ordinary emits are
unaffected — so the phone pairs, buttons work, calibration starts, and nothing
moves. The rAF rate cap on the sender is the real backpressure control.

## Why calibration is not optional

The naive approach — treat the phone's top edge as the aim axis and read yaw off
`alpha` — works only for the grip you happened to assume. Hold the phone upright
like a TV remote and the top edge points at the **ceiling**: that's the gimbal
singularity, yaw stops meaning anything, and swinging sideways moves the cursor
*not at all*. This is a silent failure — the connection is fine, data is
streaming at 60Hz, and it just won't go left or right.

So rather than assume a grip, we measure one:

1. Watch until the phone is genuinely still, then snapshot that pose.
2. Pick whichever body axis is closest to horizontal — that's what the player is
   actually pointing with. Flat-in-palm grips resolve to the **top edge**;
   upright remote grips resolve to the phone's **back**.
3. Build an orthonormal frame (forward / right / up) around it. Every angle is
   then measured relative to the player's own neutral pose, which puts the
   singularity a full 90° away from where they're actually holding it.
4. Watch a few practice swings and size the screen mapping to the range they
   actually swing through, then re-zero at the centre of that range.

Press `R` to redo it, `C` to just re-zero the neutral pose mid-game.

## How the sensor mapping works

The phone reports `alpha`/`beta`/`gamma` (a ZXY Euler triple). Feeding those to
the screen directly is a trap: `gamma` gimbal-locks and `alpha` jumps 360→0.
The client builds the W3C rotation matrix and reads its *columns* — the phone's
three body axes in world coordinates — then measures yaw/pitch inside the
calibrated frame above.

Three interchangeable mappings (`M` to cycle):

- **`relative`** *(default)* — integrates the *change* in yaw/pitch into cursor
  deltas, like a mouse. Needs no aiming at the monitor; a gentle spring toward
  screen centre absorbs slow drift. Beyond ±80° of pitch yaw is meaningless, so
  horizontal motion freezes rather than spinning.
- **`absolute`** — laser pointer. Cursor position is the angle off neutral. No
  drift, and genuinely usable now that neutral is a calibrated pose.
- **`gyro`** — projects raw `rotationRate` onto the calibrated frame's up and
  right axes and integrates. Ignores the magnetometer entirely; drifts fastest.

Deltas accumulate onto an **unfiltered** aim accumulator, and the cursor is the
filtered view of it. Integrating onto the filtered value instead is a slow
poison: smoothing gives `cursor += α·(target − cursor)`, so feeding it
`target = cursor + delta` collapses to `cursor += α·delta` — every movement
scaled by the smoothing coefficient, about 0.14 at rest. Small and medium swings
land at a seventh of their intended size.

Positions run through a **One Euro filter**: heavy smoothing when the cursor is
near-still (kills IMU jitter), almost none when swinging (keeps fast motion
crisp). A plain moving average would smear every quick gesture.

Fruit Ninja's slicing tests each fruit circle against the trail segments added
that frame (point-to-segment distance ≤ radius), gated on blade speed measured
over a 55ms window. The window matters: single-sample velocity divides by packet
inter-arrival time, so one network hitch fabricates a huge speed and a motionless
blade starts cutting.

## Controls (PC)

| Key | Action |
| --- | --- |
| `Space` | Start / restart (skips a calibration step you're stuck on) |
| `R` | Full recalibration |
| `C` | Quick re-centre — re-zero the neutral pose, keep the sensitivity |
| `M` | Cycle mapping: relative → absolute → gyro |
| `←` `→` | Sensitivity |
| `X` / `Y` | Invert axis |
| `D` | Debug overlay (detected grip, live yaw/pitch, speed, sensor Hz) |

The phone has **Re-center**, **Start**, and **Recalibrate from scratch** buttons,
and mirrors the calibration prompts — you're holding it, not looking at the
monitor.

Moving the mouse drives the cursor whenever no phone is streaming, so games stay
playable and debuggable on their own.

## If it isn't working

The controller page shows `sensor N Hz · sent N Hz · <transport> · <source>`.
That line separates the failure modes:

| Reading | Meaning |
| --- | --- |
| Enable button says **Sensors need HTTPS** | You're on an insecure origin. Nothing can work; use the https:// address. |
| `sensor 0 Hz` | The phone isn't producing data. The warning card names the cause and shows a capability dump. |
| `sensor 60 Hz`, `sent 60 Hz`, PC still waiting | Data leaves the phone but doesn't arrive — transport or routing, not sensors. |
| yaw/pitch/roll frozen | Events fire but carry no values. Move the phone in a figure-8 to settle the compass. |

**Sensor fallback.** If no `deviceorientation` event fires within 1.5s of being
enabled, the controller escalates to the Generic Sensor API
(`AbsoluteOrientationSensor`). Two reasons: Chrome implements it well, and unlike
the legacy events it reports *named* failures — `SecurityError`,
`NotAllowedError`, `NotReadableError` — each mapped to a specific instruction, so
even when it can't work it says why. It streams a quaternion, which the PC
prefers anyway: no Euler decode, no gimbal edge cases. Both representations
decode to identical body axes (verified to 4.4e-16).

## Verified

Mechanics were exercised by stepping the real `update()` loop with controlled
time and cursor paths; mapping was exercised by feeding synthetic orientation
through the real `applyOrientation()`.

Game loop — fast slash slices (2 halves + particles) ✅ · slow drag does not ✅ ·
near miss does not slice ✅ · combo bonus stacks ✅ · bomb slice ends the game ✅ ·
dropped bomb is free ✅ · dropped fruit costs a life ✅ · last life ends ✅

Mapping — relative delta fidelity is exactly 1.000× ✅ · upright grip resolves to
the phone's back and a horizontal swing covers 73% of the screen ✅ · flat grip
still resolves to the top edge ✅ · vertical swing covers 75% ✅ · wrist roll
moves the aim 0px ✅ · calibration runs signal → steady → range → playing ✅

Controller — with both orientation streams firing, sampled alpha deltas stay a
clean +1 per step instead of alternating ±100 ✅ · an all-null `absolute` stream
no longer locks out the working `deviceorientation` one ✅

Transport — on a polling connection, volatile delivered 6/100 packets while
plain delivered 100/100 ✅ · end-to-end with the real pages, calibration advanced
signal → steady → range on live relayed data ✅

Secure context — loaded over an `http://` LAN address, the controller reports
`isSecureContext: false`, disables Enable, and explains why ✅

Quaternion fallback — decodes to the same body axes as the Euler path across 10
poses including gimbal-adjacent ones, worst component error 4.44e-16 ✅ · drives
the cursor to a bit-identical position ✅ · upright grip covers 73% of the screen
on the quaternion path ✅

## Where to take it next

More games — bowling, tennis, sword fighting, anything that wants a swing. The
mapping engine is the reusable part; extracting it into a shared module is the
natural first refactor once a second game exists.

On the mapping itself: a Kalman filter fusing `gyro` rate with `absolute`
orientation would beat all three current modes — gyro for responsiveness,
orientation to cancel drift.

## Name

Not affiliated with, endorsed by, or connected to Nintendo. "Wii" is Nintendo's
trademark; this project is an independent, open-source take on playing
motion-controlled games in a browser.
