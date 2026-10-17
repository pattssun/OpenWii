# Mario Kart: local split screen for up to four players

## Current extension: four players

The user has authorized moving the existing two-player implementation to four
players. Preserve the requirements below as the two-player baseline and extend
them as follows; this section supersedes the former four-player exclusion.

- Retain solo and two-player options; add an explicit four-player option.
- Four players race in a 2 by 2 grid: P1 red top left, P2 blue top right,
  P3 green bottom left, P4 yellow bottom right. Each view has a matching outline,
  readable native-style HUD, independent camera and finish indication.
- Four distinct drivers, four independently calibrated/motion-ready phones and
  four ready confirmations are required for the normal four-player countdown.
- One shared eight-racer simulation has four humans and four CPUs. All input,
  item edges, feedback, recentering, finishes and connection safety apply to
  all four players. Resume requires all intended participants and live input.
- Phone labels must match player colors; retain the latest drift-button position
  and steering sensitivity. Preserve the explicit keyboard P2 test in duo mode.
- Provide an explicit, off-by-default one-phone quad test: real P1 phone plus
  local keyboard P2–P4, selectable on the computer with independent inputs and
  readiness. Do not reserve extra relay slots. Normal four-phone mode retains
  its full connection/calibration gates; losing the real P1 phone still pauses.
- Keep bounded total rendering cost, correct track rendering in Performance,
  and per-view visibility. Do not multiply simulation/animation updates by views.
- Extend automated coverage to all four slots, readiness, independent controls,
  finish/results and reconnect safety. Exercise the actual relay/browser flow
  with simulated phones and visually inspect four-view screenshots. Measure a
  bounded four-view rendering run and report hardware and simulation limitations.
- Update user documentation. Do not commit or leave test servers running.

## Objective

Play Mario Kart with a friend using two phones connected to one computer on the
same LAN. This is the first stage toward the user's eventual four-player goal.

## Required behavior

- Preserve the existing single-player mode and the current workspace changes.
- Offer explicit one-player/two-player selection before the race.
- In two-player mode use two side-by-side views: red P1 on the left, blue P2 on
  the right. Use matching readable player labels on the phone and computer.
- Both players choose distinct drivers using their own phones; provide computer
  controls for configuring/testing the lobby as appropriate.
- Require two connected, motion-ready, independently calibrated phones and both
  players' readiness before a shared countdown. Do not allow one player's menu
  actions to alter the other's selection or accidentally start the race.
- Run one shared eight-racer simulation: two human-controlled racers and six CPUs.
- Route steering, gas, brake, drift, item presses, and feedback independently.
  Retain the recently reduced phone steering sensitivity (0.6 gain).
- Each view has its own chase camera, item/lap/position/coin/speed display, and
  finish indication. Simulation/animation advance once per frame, regardless of
  view count. Camera-dependent visibility must not leak between views.
- Each human's countdown boost and finish are independent. A finishing player
  must not end the other's race. Display shared standings after both humans
  finish and the race's existing results criteria are met; provide race again.
- Pause on loss of either active phone or stale motion; safely clear held input.
  Reconnect must restore the intended player, or explicitly keep the race paused
  until the correct assignment has been established. Recenter is per player.
- Keep the existing graphics presets and GPU/FPS diagnostics. Use an inexpensive
  split-screen render path, bound total rendering resolution, and avoid repeating
  expensive postprocessing/shadows/TV rendering unnecessarily.
- Do not commit. Do not overwrite pre-existing README/package/certificate work.
- Stop any test server started by this work before completion, so port 8443 is
  free for the user to start the application.

## Validation

The user has one phone available for testing. Offer an explicit lobby option to
use the computer keyboard as Player 2, while Player 1 uses the real phone. This
test option must be visible, off by default, require Player 1's normal readiness,
and not consume or reserve another phone slot. Normal two-phone play keeps its
existing safety checks. Keyboard controls must affect only P2 in this mode.

- Unit tests for independent human inputs/items/countdown/finishes and existing
  single-player behavior.
- Browser validation with two simulated phone clients exercising the actual
  Socket.IO/controller protocol, independent driver choice, ready/calibration,
  controls, disconnect/reconnect, finish/results/restart, and both viewports.
- Test single-player public race flow after integration.
- Measure actual frame timings for split screen and report viewport/GPU/preset
  and whether simulation/input was real or simulated. Do not promise 60 FPS
  without supporting measurements.
- Visually inspect screenshots of the lobby and split-screen race. Physical
  phone sensor feel remains a user check; do not claim hardware validation.

## Out of scope

Four-player UI, online multiplayer, additional tracks, new assets, a server-side
race simulation, or changing global keyboard steering sensitivity.
