# 🕹 OpenWii

Play the Wii with your phone.

A browser tab on your computer shows a Wii menu. Scan the QR code on screen and
your phone becomes the remote — swing it and a hand cursor sweeps across the
screen. Point at a channel, press A, and you're slicing fruit. No app to
install, no console, no hardware at all: the phone's motion sensors stream over
your Wi-Fi and drive the game.

<!-- demo video: drag openwii_demo.mp4 into this line on github.com and it embeds -->

Up to **four phones** can join the same screen.

> [!TIP]
> I encourage you to drop this repo into Claude Code or any AI coding agent and
> ask it questions — how the pointer learns your grip, why the relay never
> interprets a packet, how a game folder becomes a channel. It's a small
> codebase and it explains itself well.

## Run it

```bash
npm install
npm start
```

1. On macOS the server auto-opens Chrome at **https://localhost:8443/** in a
   dedicated profile (so game audio can autoplay). Elsewhere, open that URL
   yourself. Set `NO_OPEN=1` to skip the auto-open.
2. Scan the QR code with your phone — same Wi-Fi network. Accept the
   certificate warning once.
3. Tap **Enable motion sensors** and swing. There is no calibration step: the
   pointer learns your phone's gyroscope conventions from the first second of
   motion, whatever way you hold it.

On the remote: **A** is the action button, **B** or **⌂** goes back to the
menu, **− / +** adjusts pointer speed, **1** re-centres the cursor. Moving the
mouse drives the cursor whenever no phone is connected, so every game stays
playable and debuggable on its own (`HTTP=1 npm start` for a quick
mouse-only server).

> [!WARNING]
> **HTTPS is not optional, and this is the #1 thing that breaks.** Browsers
> gate motion sensors behind a secure context, and Chrome enforces it
> *silently* — listeners attach, no error is thrown, and events simply never
> fire. That's why `npm start` generates a self-signed certificate and serves
> HTTPS by default. If the cursor won't move, check the phone is on the
> `https://` address before checking anything else.

## The games

| | | |
| --- | --- | --- |
| 🍉 **Fruit Ninja** | Swing the phone like a sword. Slice fruit, dodge bombs. Up to 4 blades on one board. | [`games/fruit-ninja`](games/fruit-ninja) |
| ⚔️ **Swordplay** | Duel a fencer — swing to strike, hold your blade to block. | [`games/swordplay`](games/swordplay) |
| 🏓 **Table Tennis** | Track the ball, swing at contact for pace. First to 11. | [`games/table-tennis`](games/table-tennis) |
| ⛳ **Golf** | Drive, approach, putt. Swing hard off the tee, soft on the green. | [`games/golf`](games/golf) |
| 🛩 **Island Flyover** | Hold the phone flat like a paper plane and thread the rings. | [`games/island-flyover`](games/island-flyover) |
| 🏎 **Kart Time Trial** | Tilt to steer. Three laps, one clock, and your own ghost. | [`games/kart`](games/kart) |

Fruit Ninja is the most developed of the six — multiplayer, criticals, combos,
and a spec reverse-engineered from a demo video
([`SPEC.md`](games/fruit-ninja/SPEC.md)).

## How it maps to a real Wii

Every part of the original console has a counterpart here:

| the Wii · 2006 | OpenWii · 2026 |
| --- | --- |
| Wii Remote — gyro, buttons, Bluetooth radio | Your phone — one web page, no app |
| **Sensor bar** — IR lights the remote aims at | **Pure software** — `core/pointer.js` learns where you point from the motion itself |
| Bluetooth | Wi-Fi, through a tiny Node relay · 60 packets/s |
| Console — system menu, runs the games | A browser tab — menu and games are web pages |
| TV | Still the TV. The one part that stays. |

The sensor bar row is the interesting one. The real Wii needs external hardware
to know where the remote points; here nothing feeds the pointer from outside.
The engine builds a pointing frame from the player's actual grip, learns each
phone's gyro axis conventions **from its own data at runtime** (they genuinely
differ between devices — hand-derived sign conventions were wrong three
separate times), heals drift back toward the true pose between swings, and
dead-reckons the cursor slightly ahead of the packet stream so it doesn't feel
laggy. That file is where most of this project's effort went.

## Architecture

```
server.js              Express + Socket.io relay. Forwards packets, never
                       interprets them. Assigns each phone a player slot (max 4).
scripts/gen-cert.js    Self-signed cert with your LAN IP in the SANs.
public/index.html      The Wii menu: channel grid, pairing QR, hand cursors.
public/controller.*    The remote — a drawn Wii Remote, shared by every game.
core/                  The motion engine. Renderer- and game-agnostic.
  pointer.js             learned axis map, drift healing, display lead
  gesture.js             swing detection
  channel.js             per-game wiring (pointer + link + home button)
  audio.js               synthesized cues, file overrides
games/<slug>/          One folder per game, auto-discovered on boot.
  logic.js               pure rules — no DOM, no Three.js, testable in Node
  game.js                Three.js renderer
```

The relay holds zero game state: `orientation` and `command` flow phone → PC,
`feedback` (haptic buzzes) flows PC → phone, addressed to one player slot.

## Adding a game

Drop a folder into `games/` with an `index.html`. The server discovers it on
boot and the menu grows a channel — there is no registry to edit.

```
games/your-game/
  index.html     loads socket.io + your game.js
  game.json      { title, tagline, emoji }   ← optional, for the channel card
  logic.js       your rules, kept free of rendering so they test headlessly
  game.js        your renderer
```

`core/channel.js` gives you a calibrated pointer, the player link, and the home
button in a few lines — see any of the six games for the pattern.

## Sounds

Game cues are synthesized in the browser, so the repo ships no media at all.
Drop an audio file into `audio/` named after a cue (`fn-slice.wav`,
`menu-music.mp3`, …) and it overrides the synth at runtime. The menu's own
cues are deliberately file-only — the menu stays silent until you supply them.

> [!IMPORTANT]
> `audio/` is gitignored on purpose. If you sample sounds from real hardware
> you own, they stay on your machine — **never commit copyrighted audio.**

## Tests

```bash
npm test
```

79 tests, all headless — game logic never touches Three.js or the DOM
precisely so it can be exercised in Node. The pointer suite drives the real
engine with synthetic phones (including deliberately noisy, wrongly-labeled
ones) and derives every expected value independently of the code under test.

## What building this taught me

The pointer went through seven rounds of individually-correct fixes that still
left it broken, then a from-scratch redesign fixed it in two. What survived:

- **Treat devices as untrusted input.** Axis labels, signs, and units differ
  between real phones and the spec. Learn conventions from the data at runtime;
  every hardcoded assumption I made was eventually wrong on someone's device.
- **Measure what the player perceives, not a proxy.** "Packet latency 17 ms"
  passed its gate while the cursor sat 250 ms behind the hand (filter lag).
  Instrument the end-to-end quantity or the metric will lie to you.
- **N correct fixes that don't cure the symptom means the architecture is
  wrong.** Each fix being individually verifiable is exactly what makes that
  trap sticky. 448 lines of compensation became ~190 lines that worked.
- **Never let tests share an assumption with the code under test.** Every
  simulation that assumed the same device conventions as the code passed while
  the real device failed.

## Name

Not affiliated with, endorsed by, or connected to Nintendo. "Wii" is Nintendo's
trademark; this project is an independent, open-source take on playing
motion-controlled games in a browser.

## License

[MIT](LICENSE)
