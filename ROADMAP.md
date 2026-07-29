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
| Pointer | **Rate-based gyro aiming** *(rewritten from scratch 2026-07-28 after six rounds of patching absolute/hybrid pointing; supersedes both earlier decisions — see "The pointer, rebuilt" below).* Cursor velocity = angular velocity from the raw gyroscope, the design every post-Wii console uses for gyro-without-optics (Splatoon, Zelda, Steam Input) and what the ZIG SIM demo behind this project does. No calibration flow at all: pair and play. |
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

**Acceptance — met 2026-07-28.** Run `npm test` (17 tests).

| Criterion | Result |
|---|---|
| `core/` free of game-specific identifiers | ✅ 0 matches in code |
| Fruit Ninja 3D passes the 8 mechanics tests | ✅ 8/8 |
| O2 — motion → pixels | ✅ p50 **17.6 ms**, p95 **19.2 ms** (gate 50/80) |
| O3 — target acquisition | ✅ **20/20 (100%)**, worst error 0.52 of tolerance |
| O4 — drift after 5 min @ 2°/min | ✅ **2.5%** of screen (gate 5%); uncorrected absolute drifts 16.7% |
| O6 — frame cost | ✅ **1.43 ms/frame** at 256 meshes / 190 draw calls — 11.7× headroom |
| ≥ 6 audio cues, each file-overridable | ✅ 10 cues; override probe falls back to synth correctly |
| README's four bugs stay fixed | ✅ covered by `core/core.test.mjs` |

Two measurement caveats, stated rather than buried:
- **O2 was measured over loopback on one machine**, so it reflects the software
  path, not real Wi-Fi. The round trip itself was 1.8 ms p50; the figure is
  dominated by the 16.7 ms render frame, so Wi-Fi latency would have to be
  extreme to breach the gate.
- **O6 measures per-frame cost, not sustained fps.** The preview harness
  throttles `requestAnimationFrame`, so frame *cadence* can't be observed there;
  frame *cost* can, and 1.43 ms against a 16.67 ms budget is the meaningful
  number.

The drift-correction result is the one worth keeping in mind: hybrid mode holds
2.5% where uncorrected absolute aiming reaches 16.7%. The tradeoff is inherent —
hold a deliberate off-centre aim for minutes and the correction will slowly
re-centre you. That is the cost of the mode, and it is the right trade for
pointing at a screen.

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

**Acceptance — met 2026-07-28.**

| # | Item | Result |
|---|---|---|
| 1 | ~~Health & Safety on boot~~ | ❌ **cut** — built, then removed on request. A screen you dismiss every launch is a joke that stops being funny the second time. |
| 2 | 4×3 grid of rounded channel tiles | ✅ 12 tiles |
| 3 | Idle wobble | ✅ per-tile phase, out of sync |
| 4 | Hover highlight | ✅ lifts 0.59 units, scales 1.07× |
| 5 | Hover sound | ✅ |
| 6 | Zoom-to-fill on select | ✅ 5.9× scale, then navigates |
| 7 | Bottom bar | ✅ |
| 8 | Wii button, pulsing + hoverable | ✅ |
| 9 | Live clock and date | ✅ redrawn 5×/sec |
| 10 | Seamlessly looping menu music | ✅ scheduler runs, audio clock advances |
| 11 | Back navigation with its own sound | ✅ |
| 12 | Page arrows | ✅ present, disabled on a single page |

**12/12 of the surviving items** (13/13 as originally built, before the warning
screen was cut). Also met:
- **O5 keyboard-free** — A and B on the phone drive boot dismissal, channel
  select, and return-to-menu. Calibration persists to `localStorage`, so
  launching a channel no longer re-runs the hold-still/swing flow; verified by
  loading the game directly and finding it already calibrated.
- **O6** — **0.066 ms/frame** in the menu (251× headroom), 16 draw calls.
- Every interactive element has a cue: hover, select, back, channel-open, boot,
  pointer-connect.

Two notes on how this was verified. The preview harness throttles
`requestAnimationFrame`, so the render loop was split into a `step(now, dt)`
function the test drives directly — cadence can't be observed there, behaviour
can. And an early run reported the music failing; that was a synchronous check
racing the async `AudioContext.unlock()`, not the music.

The calibration prompts are DOM rather than canvas textures — a wall of text
where crisp type matters more than living in the same renderer.

### Post-review fixes

Three issues came back from playtesting, and one was a real bug the gates missed.

**The cursor lagged a quarter of the screen behind the hand.** One Euro adapts as
`cutoff = minCutoff + beta·|speed|`, which makes **beta unit-dependent**. The
filters were tuned in pixels, where a fast swing produced speeds in the
thousands. Moving the pointer to normalised 0..1 units during the Phase 0
extraction shrank speed by the screen width and silently collapsed the adaptive
term to nothing — leaving a fixed 1.6 Hz low-pass at *every* speed. Measured
tracking error during a one-per-second sweep: **21% of screen width before,
3% after.**

O2 never saw this. It measures packet latency, which was a healthy 17.6 ms; the
250 ms sat downstream in the filter. **Latency to the renderer is not latency to
the eye** — a gap in the gate, not just in the code. `core.test.mjs` now pins
tracking error directly. Note that a step-response test would *not* have caught
it: One Euro initialises to its first sample, so a fresh filter appears to settle
instantly regardless of its constants.

**Calibration is now scoped to a server run.** The server issues a boot id at
startup; clients tie their saved calibration to it. Calibrate once when you
`npm start`, and every channel inherits it. Games no longer contain the flow at
all — Fruit Ninja starts playing on load, and `R` sends you back to the menu.

**Swing range is capped before it becomes sensitivity.** A player told to make
"big sweeps" easily produces 120°+, and mapping all of it meant crossing the
screen took a whole-arm movement. Now clamped so pointing stays wrist-scale, and
speed is adjustable live with ←/→ and remembered across restarts — it is a
preference, not something calibration can derive.

### The pointer, rebuilt from scratch

Six rounds of feedback ("slow", "imprecise", "jittery", "circles") were each
met with a measured fix — filter constants, per-frame prediction, noise gating,
gyro fusion, drift-correction surgery — and each fix surfaced the next problem.
That pattern is the diagnosis: the architecture was wrong, not the tuning.

The root constraint: absolute pointing needs an absolute reference. The Wii
Remote had one — an IR camera watching the sensor bar. A phone has nothing to
look at, so absolute designs are necessarily built on `deviceorientation`,
which is the OS's fused estimate: inherently lagged, yaw referenced to a
wandering magnetometer. The 448-line pointer was compensation for that choice.

The rewrite (~190 lines) is rate-based gyro aiming: cursor velocity = angular
velocity, straight from the raw gyroscope. Yaw is the gyro projected onto
world-up, pitch is rotation about the phone's right edge — grip-agnostic by
construction, so **the calibration flow is deleted entirely**. Drift is a
non-issue: the cursor clamps at the screen edges and the player self-corrects,
exactly as a mouse recovers from the edge of a desk. Re-centre (C, or the
phone button) snaps to the middle.

One learned scalar absorbs the platform mess: browsers disagree on
`rotationRate` units (deg/s vs rad/s — a 57× difference that alone reads as
"the cursor is really slow") and have historically disagreed on sign. The gain
is learned by comparing gyro-integrated angle against orientation heading
change over ~150ms windows — windowed because differencing noisy orientation
per-sample amplifies noise 60× and once fooled the gate.

**Addendum (same day): device gyro conventions are now learned, not assumed.**
A real phone reported its gyro on different axis labels than the W3C spec
implies — swinging up moved the cursor sideways, a bug invisible to any
simulation sharing the code's assumption. The pointer now derives ground-truth
body rates from consecutive orientation attitudes (convention-free by
construction), learns which reported column carries which body axis (with sign
and scale — permutation, mirroring, deg-vs-rad all absorbed), and only trusts
the learned map once its predictions match reality. Until then, and on devices
that never earn trust, smoothed ground truth drives the cursor: softer, never
wrong. Pitch is also now taken about the geometrically computed user-right
axis, so landscape grips work too.

Verified (attitudes quaternion-composed, all gyro signals numeric): spec,
swapped-axes, mirrored and rad/s phones all learn, earn trust and track within
6%; garbage gyro is never trusted and directions stay correct via fallback;
vertical swings stay vertical in flat, upright and landscape grips; 100ms of
orientation lag doesn't slow the cursor; 300ms degrades to correct-but-soft.

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
