# OpenWii — Roadmap

> Replicate the Wii experience in a browser: boot to Health & Safety, land on a
> faithful Wii Menu, and play six channels — with the player's phone as the
> Wii Remote.

Decisions below were settled by interview on 2026-07-28. Where a choice is
recorded here, treat it as decided rather than re-litigating it mid-build.

---

## Objective

**A person with a laptop and a phone can, in under 60 seconds and without ever
touching a keyboard, be playing a Wii game that feels like a Wii game.**

Success is measured on five axes. These are the project-level gates; each phase
has its own acceptance criteria below.

| # | Metric | Target | How it's measured |
|---|---|---|---|
| O1 | Channels playable end-to-end from the menu | 6 / 6 | Manual run-through per channel |
| O2 | Pointer latency, phone motion → pixels | p50 < 50 ms, p95 < 80 ms | Socket round-trip echo ÷ 2 + render frame time, 500-sample run |
| O3 | Target acquisition without re-centring | ≥ 95 % | 20 scripted targets at edges and corners, 64 px, timed |
| O4 | Aim drift over a session | < 5 % screen width after 5 min | Hold a fixed pose, sample cursor error over time |
| O5 | Keyboard presses required for the full flow | 0 | Boot → menu → game → back → menu, keyboard physically unused |
| O6 | Sustained frame rate | 60 fps, never below 30 | `requestAnimationFrame` delta histogram per scene |

**Priority rule when fidelity and fun conflict:** the menu is judged on
fidelity, the games are judged on feel. The Wii is a spec for the shell and a
reference for the games.

---

## Settled decisions

| Area | Decision |
|---|---|
| Renderer | Three.js for everything, including a rewritten Fruit Ninja |
| Art | Low-poly originals built procedurally in code. No binary model assets. |
| Audio | Synthesized sound-alikes via Web Audio. Every cue overridable by dropping a file, so real audio can be swapped in later without code changes. |
| Players | Single player. Room/slot protocol designed for multi from the start so adding phones later is not a rewrite. |
| Pointer | Hybrid — absolute aiming off the calibrated neutral, with slow drift correction. |
| Sequencing | Depth-first. Foundation, then the menu, then Swordplay as the reference game. |

### Channel lineup

| Channel | Scope |
|---|---|
| Swordplay | Duel vs AI. The reference implementation for motion feel. |
| Island Flyover | Free-roam flight, collectible i-Points. (Not Skydiving or Dogfight.) |
| Table Tennis | Rally vs AI. |
| Golf | Swing, terrain, putting. |
| Mario Kart | **Time trial only** — no AI racers, no items. Kart feel and tilt-steering. |
| Fruit Ninja | Rewritten in Three.js. Bonus channel, not a Wii game. |

---

## Phase 0 — Foundation

Six games will share one motion engine. It currently lives inside Fruit Ninja's
`game.js` and knows about fruit. Extracting it is now unavoidable, and the
second game is the point at which it stops being speculative.

**The Fruit Ninja rewrite is deliberately scheduled here, not last.** It is the
only game with a verified test suite, which makes it the ideal proof that the
extracted core and the Three.js integration are sound: if the 3D rewrite passes
the same eight mechanics tests as the 2D original, the foundation is good. Doing
it last would mean building five games on an unvalidated core.

Work:
- Extract `core/` — orientation decode, calibration, grip detection, mapping
  modes, One Euro filtering, pointer. Renderer-agnostic, game-agnostic.
- Three.js integration and a per-game renderer contract.
- Hybrid pointer: absolute aiming plus slow drift correction, with the drift
  constant tuned against O4.
- Audio engine: cue registry, synthesized defaults, file-override lookup.
- Room/slot protocol supporting N controllers; one slot used.

**Acceptance**
- `core/` contains zero game-specific identifiers (grep-verifiable).
- Fruit Ninja 3D passes all 8 existing mechanics tests unmodified.
- O2 latency, O3 acquisition, O4 drift all measured and met.
- ≥ 6 audio cues synthesized; each replaceable by `audio/<cue>.mp3` with no
  code change.
- Existing HTTPS, calibration and transport behaviour unchanged — the four bugs
  documented in the README stay fixed. Regression-tested, not assumed.

---

## Phase 1 — The Wii Menu

Judged on fidelity. A 12-point checklist, all of which must be present:

1. Health & Safety screen on boot, dismissed by pointing and pressing A
2. 4×3 grid of rounded channel tiles
3. Idle wobble animation on tiles
4. Hover highlight
5. Hover sound
6. Channel zoom-to-fill transition on select
7. Bottom bar present
8. Wii button with its pulse
9. Live clock and date, updating
10. Seamlessly looping menu music
11. Back navigation, with its own sound
12. Page arrows

**Acceptance**
- 12 / 12 checklist items present.
- O5 — the whole flow is keyboard-free.
- O6 — 60 fps sustained in the menu.
- Every interactive element has an audio cue. No silent interactions.

---

## Phase 2 — Swordplay (reference game)

The game that sets the bar for every one after it. Judged on feel.

**Acceptance**
- Blade orientation tracks the phone 1:1 — roll, pitch and yaw all read.
- Blocking works: a block succeeds or fails based on blade angle, not timing
  alone.
- Hit detection distinguishes a swing from a wave, using the same speed-window
  approach proven in Fruit Ninja.
- A full match against AI is completable, with a win and a loss state.
- O2 latency holds during combat, not just in the menu.

---

## Phases 3–5

Criteria firm up when each is reached; these are the headline bars.

| Phase | Game | Headline bar |
|---|---|---|
| 3 | Table Tennis + Golf | Built together — both are "swing at a ball", so they share a physics and swing-detection module. A rally is sustainable; a golf ball is landable on a green. |
| 4 | Island Flyover | An island worth flying over. Highest art risk of the project: procedural geometry has to carry an entire explorable world. |
| 5 | Mario Kart (time trial) | Tilt-steering that feels good enough to want a second lap. One circuit, a working lap timer, a ghost. |

---

## Risks

**The core bar is subjective and cannot be automated.** Every metric above can
pass while the result still feels wrong. This is the main argument for showing
you a build early rather than at the end of a phase.

**Island Flyover is the biggest unknown.** Procedural low-poly geometry is
well-suited to a sword or a kart, and much less obviously suited to an entire
island that rewards exploration. If any phase slips, it is this one.

**Golf is harder than it looks** — swing arc, lie, terrain and putting are four
distinct problems, and putting is not the same game as driving.

**Mario Kart, even as a time trial, is not small.** Kart physics with credible
drift is a genuine engineering problem independent of tracks, AI and items.

**Original characters only.** Low-poly originals mean the racers cannot be
Mario. The kart game will be Mario Kart in structure and feel, with original
low-poly racers — I can't produce or ship Nintendo's models, and unlike the
trademark question on the name, shipping their assets would be direct
infringement rather than an arguable one.

**Audio stays synthesized until you say otherwise.** The override hook means
real files can be added later, but nothing copyrighted enters the repo by
default and `audio/` is gitignored.

---

## Working agreement for this roadmap

- Long autonomous runs; check in at phase boundaries.
- Commit directly to `main`, only when asked.
- Each phase ends with measured numbers against its criteria, not an assertion
  that it works.
