# Mario Kart for OpenWii

A fan-made browser racing game with your phone as the steering wheel. Choose
one of eight drivers and race one or two human players plus CPU opponents for one or three laps, with
items, drifting, mini-turbos, anti-gravity and gliding.

From the repository root:

```sh
npm ci
npm start
```

Open the launcher, scan its QR code with a phone on the same Wi-Fi, enable motion
and select the first tile. Hold the remote sideways: **2** accelerates, **1**
brakes, **A** drifts and **crosspad right** uses an item. Choose a driver with the
crosspad and press **2**, choose the lap count, then press **2** again to race.

See the main README for [requirements and setup](../../README.md#quick-start),
[all controls](#controls) and
[troubleshooting](../../README.md#troubleshooting).

## Controls

Hold the phone sideways with the **crosspad on the left and 1 / 2 on the right**,
screen mostly facing up. Roll it like a steering wheel to turn. Small tilts give
gentle corrections; a tilt of about 28° reaches full steering. The remote keeps
its physical button arrangement when the browser changes orientation; on iPad,
the controls scale up to fit the screen.

1. Choose a driver with the crosspad and press **2** to confirm.
2. Choose **1 lap or 3 laps** with left/right, then press **2** again to start.
   The game remembers your lap choice. Press **1** here to change driver.
3. Hold the phone level and still for a moment. The countdown waits until the
   steering wheel has a stable neutral position. Hold **2** after GO to accelerate.

| Action | Phone remote | Computer keyboard |
| --- | --- | --- |
| Steer | Tilt left / right | ← / → |
| Accelerate | Hold **2** | Hold **Z** |
| Brake / reverse | Hold **1** | Hold **X** |
| Drift | Hold **A** while turning | Hold **Shift** while turning |
| Release drift boost | Release **A** | Release **Shift** |
| Use item | Crosspad **→** | **Space** |
| Confirm / resume | **2** | **Enter** |
| Recenter steering | **−**, then level the phone and resume | **R** |
| Return to launcher | **Home** | Click **Channels** |

Choose a driver and race length with the mouse or keyboard if no phone is
connected. **Esc** pauses/resumes, **F** toggles fullscreen, **C** toggles a clean
view, and the **Sound** button mutes the game. If steering feels reversed, press
**I** on the computer to invert it. Hiding the game or losing the phone connection
pauses the race; reconnect and press **2 / Enter** to resume.

Drifting builds blue, orange, then purple sparks; release it for a mini-turbo.
Item boxes award power-ups, coins raise top speed, and ramps deploy the glider
automatically. The leaderboard appears after all eight racers finish.

## Two players

Choose **2 PLAYERS** in the game lobby. Connect two phones to the same server;
the first is red P1 on the left and the second is blue P2 on the right. Each
phone chooses its own driver with the crosspad. Hold both phones sideways and
level until each shows wheel ready, then press **2** on each phone. Drivers must
be distinct. The computer's race length buttons apply to both players.

Each player has a separate camera, item, position, lap, coins, and speed display.
Two humans race with six CPU racers. If a phone disconnects or stops streaming
motion, the race pauses. Reconnect the same phone, hold it level until its wheel
is ready, then press **2** to resume. Phone identity and player slot persist for
the current server run; restart the server to clear reservations. **Race Again**
returns both players to the lobby to choose drivers and ready up again.


## Testing with one phone

Choose **2 PLAYERS**, then tick **Test with one phone: keyboard Player 2**.
Connect your phone as red P1 and calibrate normally. Use its crosspad to choose
your driver and press **2** to ready. On the computer, click the game background,
use the arrow keys to choose blue P2's driver, and press **Enter** to ready.
Both players must be ready before the shared countdown starts.

For P2, use **Z** for gas, **X** for brake, **arrows** to steer, **Shift** to drift,
and **Space** for an item. **Esc** pauses; **Enter** resumes. The option is off
by default and does not reserve a phone slot. To return to two-phone play,
untick it in the lobby. It exercises split-screen racing with one real phone;
it does not test a second phone's sensors or connection.

## Graphics and performance

Open **GRAPHICS** at the top right to see live FPS, frame time, render resolution,
and the GPU actually rendering the game. During a race, move the mouse to the top
bar to reveal it. Graphics changes apply immediately and are remembered.

| Setting | Resolution budget | Effects |
| --- | --- | --- |
| Balanced (default) | Up to 1080p | Bloom, 1024px shadows, 2-sample antialiasing, 5 FPS stadium screens |
| Performance | Up to 720p | No ambient occlusion, bloom, dynamic shadows or live stadium feed |
| High | Up to 1440p | Ambient occlusion, bloom, 2048px shadows, 4-sample antialiasing, 10 FPS stadium screens |

Resolution preserves the window's aspect ratio and does not exceed the pixel
budget, including on high-DPI displays. The HUD remains at native resolution.
Two-player mode uses a combined 720p budget on Performance and up to 1080p on
Balanced or High, with direct side-by-side views and no postprocessing, dynamic
shadows, or live stadium screens. The graphics preset is retained for the next
single-player race.

On laptops with both Intel and NVIDIA graphics, check that the GPU readout names
the NVIDIA adapter. The game requests high performance, but Windows selects the
GPU. Set your browser to **High performance** in **Windows Settings > System >
Display > Graphics**, then fully quit and reopen the browser. See
[Microsoft's per-app GPU instructions](https://support.microsoft.com/en-au/windows/hardware/display-graphics/optimizations-for-windowed-games-in-windows-11).
If the readout reports software rendering, enable graphics acceleration in the
browser's system settings and restart it.

With the server running, `node games/mario-kart/performance-review.mjs --compare`
prints the actual Chrome renderer and frame timings at three fixed course poses
for each preset at a 1920×1080 viewport. Add `--headed` for a visible test window.
This render benchmark freezes the race to compare the same views; it does not
measure race simulation cost or physical phone input.

## What comes with the repository

The repository includes the runtime pack used by the polished demo: eight
converted racers, Mario Kart Stadium and its driving surfaces, music and sound
effects, UI fonts, portraits, and stadium TV artwork. A normal clone followed by
`npm ci` and `npm start` loads this pack automatically; no separate downloads or
Blender build are needed. The pack adds approximately 102 MB to the checkout.

See the [runtime pack credits](../../assets/mario-kart/README.md) for provenance.
Downloaded source archives and development recordings are not included. The
procedural models, generated course, and synthesized audio remain as fallbacks
if runtime files are unavailable.

Six bundled item icons are official Nintendo promotional artwork; see their
[source credits](item-art/SOURCES.md). These images are not covered by the
repository's MIT software license.

- [Model/course conversion tools](pipeline/SOURCE-ASSETS.md)
- [Audio preparation and synthesized fallback](AUDIO.md)
- [Silent development-video prototype and graphics showcase](../../tests/kart-prototype/README.md)

## Checks

```sh
npm run test:unit
# With npm start running and Google Chrome installed:
npm run test:kart-public
```

The public browser check verifies the bundled models, source course, fonts, and
sample audio, then drives a complete race through the finish/results/restart flow.
`npm run test:kart-fallback` separately verifies play without the runtime pack.
`REPORT.md`, `VISUAL-REPORT.md` and iteration notes record development history;
their local evidence links and earlier test counts are not release requirements.

This is an independent fan project, not an official Nintendo game or emulator.
The repository's MIT license covers its software, not Nintendo or other
third-party artwork and recordings.
