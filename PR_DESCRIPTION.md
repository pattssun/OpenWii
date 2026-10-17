# Add 2/4-player Mario Kart, graphics presets and controller improvements

## Summary

Extend Mario Kart from a single human racer to local split-screen racing for
one, two or four humans using phones as controllers. Add graphics controls,
GPU diagnostics, gentler steering, one-phone multiplayer test options,
per-player minimaps and animated item roulettes, and configurable race lengths.

The existing eight-racer race remains shared across all views:

| Mode | Human racers | CPU racers | Layout |
| --- | --- | --- | --- |
| Solo | 1 | 7 | Full screen |
| Two players | 2 | 6 | P1 left, P2 right |
| Four players | 4 | 4 | P1 top left, P2 top right, P3 bottom left, P4 bottom right |

## Changes

### Local multiplayer

- Add explicit 1 PLAYER, 2 PLAYERS and 4 PLAYERS lobby options.
- Give every human an independent driver choice, readiness state, steering
  calibration, inputs, chase camera, boost feedback and HUD.
- Require distinct drivers and all active phones to be connected,
  motion-ready, calibrated and ready before the shared countdown.
- Bound driver-selection searches so occupied drivers cannot cause vertical
  crosspad navigation to loop indefinitely.
- Route gas, brake, steering, drift, item edges, recenter commands and targeted
  feedback independently by player slot.
- Handle countdown boosts, burnouts and finish states independently. An early
  human finisher does not end the other humans' race.
- Show shared standings with human player labels, including all four humans in
  four-player results. Race Again returns multiplayer to the readiness lobby.
- Play the shared finish audio only after all humans finish, once per race,
  including when multiple humans finish in the same simulation step. Apply this
  to both sampled audio and the synthesized fallback.

### Stable phone assignments and recovery

- Add persistent phone identities and reserve their player slots for the server
  process, allowing the original phone to reclaim its slot after reconnecting.
- Include identity and slot information in presence and controller routing;
  reject unassigned/excess controller connections rather than silently replacing
  active players. Retain compatibility with existing string registration.
- Pause multiplayer races on a missing participant or stale motion. Clear held
  controls and require the intended participants and live calibrated wheels
  before resuming.
- Keep recentering specific to the requesting player and preserve solo recovery.
- Label phones and viewports consistently: P1 red, P2 blue, P3 green, P4 yellow.

### Rendering and performance

- Request a high-performance WebGL adapter and display the actual GPU renderer,
  software-rendering status, FPS, frame time and rendering resolution.
- Add remembered Performance, Balanced and High graphics presets with bounded
  pixel budgets and device pixel ratio.
- Control antialiasing, ambient occlusion, bloom, shadows and stadium screen
  refresh according to the selected preset.
- Use one shared simulation and shared world-animation update per frame, then
  render each human's camera with its own viewport and scissor rectangle.
- Recompute camera-dependent visibility for each view and avoid leaking one
  camera's visibility or boost state into another view.
- Cap the combined split-screen canvas at 720p on Performance and 1080p on
  Balanced/High. Split modes use direct rendering without repeated
  postprocessing, dynamic shadows or live stadium-screen rendering.
- Handle the WebGL viewport origin and odd window dimensions when tiling views.
- Fix disappearing track/scenery after graphics changes by invalidating cached
  material shaders when shadow support changes.

### Split-screen presentation

- Outline each player's half/quarter with their assigned color.
- Reuse native-style rank artwork, lap/speed/coin numerals, fonts and finish
  lettering. Preserve the gold coin counters and rank colors.
- Keep rank suffixes fully inside their viewports, including at 720p.
- Display a compact minimap inside **every** active player's viewport in both
  two- and four-player modes. Human markers match player colors, and a white ring
  identifies the player whose view contains the map.
- Render the map content once and copy it into the small player canvases.
- Replace the split-screen item text with independent animated item reels and
  the solo game's item artwork. Preserve rolling, settling, held-item and empty
  states, with accessible item labels.

### Phone controls

- Reduce Mario Kart phone steering gain to 0.6 for gentler small corrections;
  deliberate larger tilts still reach full steering.
- Move the wheel-profile A/DRIFT button and its touch area 16px toward the D-pad.
- Preserve sideways phone layout and the existing motion/calibration model.

### Test multiplayer with one phone

- Two-player lobby: an explicit, off-by-default option uses the real P1 phone
  and the keyboard for P2.
- Four-player lobby: a separate explicit option uses the real P1 phone and
  keyboard-controlled P2–P4. Select a keyboard player, choose their driver and
  ready individually, or click Ready P2–P4.
- Keep the keyboard-player selector accessible during racing. Only the selected
  keyboard player receives input; unselected keyboard players remain idle.
- Clear held keyboard controls when switching the selected player.
- Keep P1's normal phone readiness and disconnect safety. Local test controllers
  do not consume relay phone slots.
- Keep the duo keyboard option from implicitly enabling the quad test option.

### Race length

- Allow any integer from 1 to 20 laps, retaining quick 1- and 3-lap buttons.
- Add a numeric field and minus/plus buttons, remember the chosen count, and
  apply it to the shared race in solo and multiplayer.
- Let solo phone left/right adjust the count after driver confirmation.
- Validate lap counts in the simulation as well as the menu.
- Update lap counters and lap-sign artwork for arbitrary supported counts,
  including two-digit values; use the configured count for final-lap behavior.

### Setup, documentation and supporting tests

- Generate and validate local HTTPS certificates using Node's built-in crypto
  APIs instead of requiring an external OpenSSL executable. Validate the key,
  validity period and local addresses when reusing a certificate.
- Include script tests in the unit-test command.
- Update the main README, Mario Kart setup/control/performance documentation,
  player-count metadata, and implementation specification/plans.
- Add focused unit tests and browser/benchmark harnesses for multiplayer,
  phone identity, readiness, inputs, finishes/audio, graphics budgets, lap counts,
  HUD behavior, reconnects and one-phone testing.

## Validation completed during development

- Full unit suite: **247 tests passed** at the last full-suite run in this work.
- Browser checks exercised the actual Socket.IO relay with simulated phone
  orientation and commands, plus real browser keyboard input.
- Checked solo/duo regressions, quad readiness, distinct drivers, isolated inputs
  and items, disconnect/reconnect, stale-input pause, recenter recovery,
  independent finishes, results and Race Again.
- Tested both one-phone multiplayer options, including P2/P3/P4 keyboard
  selection and held-input release.
- Checked independent item-reel animation/settling, lap-choice persistence and
  custom race lengths. Simulated two- and five-lap races finished at the correct
  checkpoint counts.
- Verified every player's minimap is visible, contains rendered track/markers,
  stays within its own viewport and clears other HUD elements in duo and quad.
- Inspected lobby/race/results screenshots, native HUD artwork, colored borders
  and rank bounds at 720p/1080p and odd viewport dimensions.
- Checked Performance/Balanced switching and track visibility in all four views.
- Syntax and Git whitespace checks passed. Test servers were stopped afterward.

Historical performance measurements used specific earlier revisions: a
1920×1080 Balanced duo run measured about 59.5 FPS on an RTX 3080 Ti Laptop GPU;
quad runs measured about 29–32 FPS on Intel Iris Xe, with possible concurrent
browser-test load. These are different GPUs and are not a comparison of mode
cost or a performance guarantee for the final HUD revision.

## Limitations and scope

- Only one physical phone was available. Multiple-phone protocol checks used
  simulated clients; physical four-phone sensor feel and final quad performance
  on the RTX GPU still need hardware validation.
- Multiplayer is local to one computer/server on the same network; this does
  not add online races or a server-authoritative race simulation.
- Reserved phone slots reset when the server restarts.
- Browser GPU choice remains an OS/browser setting. A WebGL performance hint
  cannot force Windows to select a particular adapter.
- Screenshots and generated reports live in the ignored
  `games/mario-kart/evidence/` directory and are not automatically included in Git.

## Suggested reviewer smoke test

1. Run `npm ci`, then `npm start`; connect a phone over HTTPS and enable motion.
2. Check solo steering, the drift-button position and a custom lap count.
3. Choose 2 PLAYERS and enable its one-phone keyboard test. Ready P1 on the phone
   and P2 using Enter. Check both maps, independent item roulettes and controls.
4. Choose 4 PLAYERS and enable its one-phone keyboard test. Ready P2–P4 on the
   computer, then P1 on the phone. Switch keyboard players and check all four
   maps, HUDs and input isolation.
5. Disconnect P1 and verify pause/resume safety. Check Performance/Balanced
   switching and use the GRAPHICS readout to identify the actual adapter.
6. Test normal two-/four-phone play when additional devices are available.

## Local troubleshooting performed, outside the code patch

During development, the laptop's browser GPU preference was adjusted locally
and leftover test-server processes causing a port 8443 conflict were stopped.
These are local setup actions, not a committed Windows configuration change or
an automatic server port-conflict fix.
