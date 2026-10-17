# Approved implementation plan

Derived from the planner's repository audit and PROJECT_SPEC.md. All existing
single-player and graphics/steering behavior is the baseline.

1. Extend `Race` with `characters`, `humanCount`, and `players`, retaining the
   legacy `character`, `player`, and single input API. Accept an input per human;
   queue item edges independently through fixed steps. Handle each human's
   countdown input, boost/burnout, and finish separately. CPU control applies to
   nonhumans or finishers; rubber band against the leading human. Enter finishing
   only after all humans finish, and results after all eight racers finish.
2. Maintain lobby/input state per player: wheel, chosen driver, ready, presence,
   capture timing, input/item edges, and participant identity. Offer explicit
   solo/duo selection. P1 red left/P2 blue right; own arrows choose distinct
   drivers, 2 confirms readiness, 1 cancels own readiness. A host-controlled lap
   setting remains shared. Require two live, armed/calibrated, ready phones.
3. Add persistent random phone identity and backward-compatible registration to
   the relay. Reserve identity's slot for the server run, reclaim it on reconnect,
   include identity in presence, reject unassigned relay packets. Keep existing
   string registration working. New phones cannot silently steal active players.
   Server restart can clear reservations. Target feedback/profile/color by slot.
4. Update simulation and world animations once per frame. Extract per-view camera
   rig state and rendering from shared visual updates. Each camera has its own
   chase/clearance/smoothing/flight/finish state. Preserve solo composer path.
   Duo uses direct renderer viewport/scissor halves, no GTAO/bloom/dynamic shadows
   or live TV feed; retain blob shadows and total resolution budget. Restore
   graphics preset when returning to solo. Reset viewport/scissor after rendering.
   Recompute visibility per view, including rivals/gliders/pickups, without leaks.
5. Per-player HUDs show items, lap, rank, coins, speed, calibration/finish status;
   share countdown but show readiness per player. Keep legacy solo IDs/layout
   compatible with tests. Shared standings mark both humans. Race again returns
   duo to lobby for readiness checks. One music stream; do not end the second
   player's race/audio on the first player's finish.
6. On either active phone's disconnect or stale motion release held input and
   pause before advancing the race. Resume requires the same participant IDs,
   fresh motion and calibrated wheels. Recenter only its requesting wheel. Keep
   solo keyboard controls; no hidden keyboard takeover for an active duo racer.
7. Update Mario Kart metadata/docs. Expected files include game/logic/input UI,
   server, shared link, phone controller, audio integration as needed; add small
   modules when they clarify player/view state rather than duplicating the game.

## Acceptance and verification

- Unit tests for independent control/item/countdown/finish behavior, readiness,
  stable identity, stale-input safety, and compatibility with solo.
- Real browser + two simulated phones using actual Socket.IO registration,
  orientation, and command protocol. Exercise independent character choice,
  calibration, readiness, views/HUD, inputs/feedback, disconnect/reconnect,
  finish/results/restart. Test no cross-control and one simulation update/frame.
- Run existing single-player public race regression and relevant unit suite.
- Inspect lobby and race screenshots, including view-dependent visibility.
- Benchmark bounded actual split render/race timings; report GPU, viewport,
  preset, average FPS/p95, and simulated-phone limitation. Normal-user Chrome is
  configured for RTX; sandbox Chrome may use Intel, so label results accurately.
- Independent tester/experimenter then reviewer; address actionable failures.
- No commits. Stop only our own test server before finishing, freeing port 8443.
