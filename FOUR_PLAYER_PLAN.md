# Four-player implementation plan

Approved from the planner audit against PROJECT_SPEC.md.

1. Retain solo/duo and add quad mode; centralize active count 1/2/4. Relay already
   has four stable identity slots and targeted feedback; preserve that protocol.
2. Generalize lobby arrays to 2/4 players while retaining DuoLobby compatibility.
   Bound driver search, including vertical moves, and guarantee distinct drivers.
3. Allow Race humanCount 1/2/4 with eight total racers and four CPUs in quad.
   Preserve array-driven independent controls, item edges, countdown and finishes.
4. Allocate four wheels, capture deadlines, item edges and camera rigs. Route
   active slots independently; keyboard P2 remains duo-only. Require every active
   phone calibrated/live/ready. Pause and clear controls on loss/stale motion;
   resume requires intended identities and all live wheels. Recenter per player.
5. Add four lobby/HUD cards, red/blue/green/yellow labels on phone/computer, and
   2x2 views in P1 top-left/P2 top-right/P3 bottom-left/P4 bottom-right order.
   Preserve solo/duo layout and native HUD fonts/artwork. Shared results show all
   humans and wait for the existing all-human/all-racer finish criteria.
6. Render viewport/scissor quarters accounting for bottom-left WebGL origin and
   odd dimensions. Update simulation/shared visuals once per frame; set visibility
   per camera. Preserve combined pixel cap, inexpensive split path and Performance
   shader/material fix. Measure actual quad timings before claiming performance.
7. Update metadata/docs. Preserve phone drift position and steering sensitivity.

## Acceptance and validation

- Unit coverage: four unique drivers and bounded selection, readiness/identity,
  independent inputs/items/countdown/finishes, solo/duo compatibility.
- Actual browser and Socket.IO with four simulated phones: all readiness gates,
  isolated control/feedback/recenter, disconnect/reconnect/stale pause, race flow.
- Inspect lobby/race screenshots and bounds/colors/fonts/track coverage in both
  Performance and Balanced; run existing solo/duo regressions.
- Bounded quad benchmark reports viewport/preset/GPU/frame timings and simulated
  phone limitation. Put evidence in evidence/four-player, preserving prior reports.
- Independent tester/experimenter then reviewer; resolve actionable findings.
- No commits. Stop every test server started by this work before completion.
