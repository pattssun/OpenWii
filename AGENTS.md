# OpenWii

Motion-controlled games for the browser — the player's phone is the remote. A
Node/Socket.io relay streams phone IMU data over the LAN to a game running on the
PC. See **README.md** for the architecture and the hard-won gotchas.

## Layout

```
server.js         Socket.io relay + static serving. Auto-discovers games/.
public/           Launcher (index.html) + the shared phone controller.
games/<slug>/     One folder per game, each with its own index.html.
```

A game is any folder under `games/` containing an `index.html`. No registry to
edit — the server scans on boot. `game.json` (title/tagline/emoji) is optional
and only feeds the launcher card.

Fruit Ninja was reverse-engineered from a demo video; its
`SPEC.md` / `PROMPT.md` live in `games/fruit-ninja/`.
Source: https://www.instagram.com/reel/DZiAyThpC63/

## Things that will bite you

- **Sensors need HTTPS.** Browsers block motion sensors on insecure origins and
  Chrome does it silently — listeners attach, no error, no events. `npm start`
  serves HTTPS with a self-signed cert. `HTTP=1` is mouse-only.
- **Never send orientation `volatile`.** Socket.IO drops volatile packets when
  the transport isn't writable, which on long-polling is most of the time.
- **Don't reduce the mapping back to raw Euler angles.** Aim is measured in a
  calibrated frame built from the player's actual grip; the naive version breaks
  entirely for anyone holding the phone upright.

## Working agreement

Commit directly to `main` — no feature branches, no PRs. Commit only when asked.
