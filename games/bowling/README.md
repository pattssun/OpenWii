# Bowling for OpenWii

Ten frames, real lane dimensions and pin physics, one or two players taking turns
with their phones. Each phone buzzes: a tick when you grip the ball, a pulse when
you release, a hit when the ball reaches the pins, a long rumble for a gutter
ball and a flourish for strikes and spares.

## How to play

1. Open the game and the controller on each phone (same Wi-Fi, HTTPS).
2. **Calibrate:** hold the phone out in front of you, pointing at the screen, and
   keep it still until your bar fills. Both players must calibrate before the
   game starts (like the wheel in Mario Kart). `−` on the remote, or `R` on the
   keyboard, recalibrates.
3. **Bowl:** on your turn
   - D-pad **◀ ▶** moves your spot on the foul line,
   - point the phone to aim, **hold A** to grip the ball,
   - swing your arm like a real delivery and **let go of A** to release,
   - a harder swing is a faster ball, and twisting your wrist as you let go puts
     a hook on it.

| Action | Phone | Keyboard |
| --- | --- | --- |
| Move on the foul line | D-pad ◀ ▶ | Z / X |
| Aim | Point the phone | ← / → |
| Hook | Twist your wrist | Q / E |
| Grip and release | Hold / release **A** | Hold / release **Space** (the meter sets the power) |
| Start / bowl again | **A** | Enter / Space |
| Recalibrate | **−** | R |

Haptics use the browser's vibration API, which Android Chrome supports. iPhones
have no web vibration API, so on iOS the game plays normally without the buzz.

## Layout

- `logic.js` — scoring (strikes, spares, the tenth frame), lane geometry, a
  deterministic ball and pin simulation, and the `Match` turn manager.
- `throw.js` — `StanceCalibration` (steady-hold calibration) and `ThrowTracker`
  (grip, swing and release → speed, aim and hook).
- `game.js` / `index.html` — the Three.js scene, scoreboard, lobby and haptics.
- `*.test.mjs` — `npm run test:unit` covers scoring, physics and the swing maths.

The sensor-to-throw mapping (swing speed, twist direction, aim damping) is tuned
from synthetic motion. If twist feels reversed on your phone, flip `invertTwist`
in `new ThrowTracker(...)`.
