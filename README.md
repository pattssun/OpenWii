# 🍉 fruit-ninja — motion controlled

Your phone is the sword. Swing it in the air; the blade on your PC screen follows
and slices fruit. Built to the breakdown in [SPEC.md](SPEC.md).

```
phone IMU ──60Hz──▶ Socket.io ──▶ Node relay ──▶ PC canvas ──▶ cursor + slice
```

## Run it

```bash
npm install
npm start
```

Then:

1. Open **https://localhost:8443/** on the PC — the start screen shows a QR code.
2. Scan it with your phone (same Wi-Fi). Accept the certificate warning.
3. Tap **Enable motion sensors**. Calibration starts automatically:
   - **Hold still** — grip the phone however you like and point it at the screen.
   - **Swing it around** — big sweeps, side to side then up and down.
4. The game starts as soon as calibration lands. Swing to slice.

Grip it however is comfortable — flat in your palm like a Wii remote, or upright
like a TV remote. Calibration works out which way you're pointing (see below).

### Why HTTPS — this is the #1 thing that breaks

Browsers gate every motion sensor behind a secure context, and `http://192.168.x.x`
is **not** one. Chrome enforces this *silently*: `addEventListener('deviceorientation')`
succeeds, no error is thrown, and events simply never fire. On Android there's no
`requestPermission()` either, so nothing ever reports a denial. An insecure origin
is indistinguishable from a broken phone unless you go looking.

So the controller refuses to pretend: on a non-secure origin it disables the
Enable button, says why, and dumps the full capability report.

The server generates a self-signed cert on first boot (SANs cover localhost and
your LAN IP) — click through the warning once per device. `HTTP=1 npm start`
forces plain HTTP; fine for working on the game loop with a mouse, useless for
actual phone control.

## Controls (PC)

| Key | Action |
| --- | --- |
| `Space` | Start / restart (skips a calibration step you're stuck on) |
| `R` | Full recalibration |
| `C` | Quick re-centre — re-zero the neutral pose, keep the sensitivity |
| `M` | Cycle mapping: relative → absolute → gyro |
| `←` `→` | Sensitivity |
| `X` / `Y` | Invert axis |
| `D` | Debug overlay (detected grip, live yaw/pitch, blade speed, sensor Hz) |

The phone has **Re-center**, **Start**, and **Recalibrate from scratch** buttons,
and mirrors the calibration prompts — you're holding it, not looking at the
monitor.

Moving the mouse drives the blade whenever no phone is streaming, so the game is
playable and debuggable on its own.

## Why calibration is not optional

The naive approach — treat the phone's top edge as the aim axis and read yaw off
`alpha` — works only for the grip you happened to assume. Hold the phone upright
like a TV remote and the top edge points at the **ceiling**: that's the gimbal
singularity, yaw stops meaning anything, and swinging sideways moves the blade
*not at all*. This is a silent failure — the connection is fine, data is
streaming at 60Hz, and the blade just won't go left or right.

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
[`public/game.js`](public/game.js) builds the W3C rotation matrix and reads its
*columns* — the phone's three body axes in world coordinates — then measures
yaw/pitch inside the calibrated frame above.

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

Positions run through a **One Euro filter**: heavy smoothing when the blade is
near-still (kills IMU jitter), almost none when swinging (keeps slashes crisp). A
plain moving average would smear every fast slice.

Slicing tests each fruit circle against the trail segments added that frame
(point-to-segment distance ≤ radius), gated on blade speed measured over a 55ms
window. The window matters: single-sample velocity divides by packet
inter-arrival time, so one network hitch fabricates a huge speed and a motionless
blade starts cutting.

## Layout

```
server.js              Express + Socket.io relay. Holds no game state.
scripts/gen-cert.js    Self-signed cert with your LAN IP in the SANs.
public/controller.*    Phone: permission gate, 60Hz sensor stream, haptics.
public/index.html      PC: canvas, HUD, pairing screen.
public/game.js         PC: mapping, trail, physics, collision, render.
```

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
unaffected — so the phone pairs, buttons work, calibration starts, and the blade
never moves. The rAF rate cap on the sender is the real backpressure control.

## If it isn't working

The controller page shows `sensor N Hz · sent N Hz · <transport>`. That line
separates the two failure modes:

| Reading | Meaning |
| --- | --- |
| Enable button says **Sensors need HTTPS** | You're on an insecure origin. Nothing can work; use the https:// address. |
| `sensor 0 Hz` | The phone isn't producing data. The warning card names the cause and shows a capability dump. |
| `sensor 60 Hz`, `sent 60 Hz`, PC still waiting | Data leaves the phone but doesn't arrive — transport or routing, not sensors. |
| yaw/pitch/roll frozen | Events fire but carry no values. Move the phone in a figure-8 to settle the compass. |

The last field of the rates line names the active source —
`deviceorientation` or `OrientationSensor`.

**Sensor fallback.** If no `deviceorientation` event fires within 1.5s of being
enabled, the controller escalates to the Generic Sensor API
(`AbsoluteOrientationSensor`). Two reasons: Chrome implements it well, and unlike
the legacy events it reports *named* failures — `SecurityError`,
`NotAllowedError`, `NotReadableError` — each mapped to a specific instruction, so
even when it can't work it says why. It streams a quaternion, which the PC
prefers anyway: no Euler decode, no gimbal edge cases. Both representations
decode to identical body axes (verified to 4.4e-16).

On the PC, `D` toggles a debug overlay with the detected grip, live yaw/pitch,
blade speed, packet rate, and whether samples arrived as Euler or quaternion.

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

Secure context — loaded over `http://192.168.4.233:8080`, the controller reports
`isSecureContext: false`, disables Enable, and explains why ✅

Quaternion fallback — decodes to the same body axes as the Euler path across 10
poses including gimbal-adjacent ones, worst component error 4.44e-16 ✅ · drives
the cursor to a bit-identical position ✅ · upright grip covers 73% of the screen
on the quaternion path ✅

## Where to take it next

Per SPEC.md's modification point: swap the mapping (a Kalman filter fusing
`gyro` rate with `absolute` orientation would beat all three current modes —
gyro for responsiveness, orientation to cancel drift), or replace the canvas
renderer with Three.js and let fruit arc through actual 3D space.
