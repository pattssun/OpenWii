'use strict';

/**
 * OpenWii — LAN relay server.
 *
 * Serves the clients and pipes messages between them:
 *   /                     → game launcher
 *   /controller           → phone controller (the "remote", shared by all games)
 *   /games/<slug>/        → a game's PC client
 *
 * The server holds no game state. It is a dumb, low-latency switchboard so the
 * phone's orientation stream reaches the PC with as few hops as possible.
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { ensureCert, localAddresses } = require('./scripts/gen-cert');

const PORT = Number(process.env.PORT) || 8443;
const FORCE_HTTP = process.env.HTTP === '1';
const GAMES_DIR = path.join(__dirname, 'games');

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/games', express.static(GAMES_DIR, { extensions: ['html'] }));
// The shared motion engine, imported directly by games as ES modules.
app.use('/core', express.static(path.join(__dirname, 'core')));
// Three.js straight from node_modules — no build step, no bundler.
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
// Optional audio overrides. Gitignored: nothing copyrighted ships by default.
app.use('/audio', express.static(path.join(__dirname, 'audio'), { fallthrough: true }));

/**
 * Discover games from disk rather than a hardcoded list: a game is any folder
 * under games/ with an index.html. Dropping in a new folder is the whole
 * install step.
 */
function listGames() {
  let entries;
  try {
    entries = fs.readdirSync(GAMES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(GAMES_DIR, e.name, 'index.html')))
    .map((e) => {
      const meta = { title: e.name, tagline: '', emoji: '🎮' };
      try {
        Object.assign(meta, JSON.parse(fs.readFileSync(path.join(GAMES_DIR, e.name, 'game.json'), 'utf8')));
      } catch { /* game.json is optional */ }
      return { slug: e.name, url: `/games/${e.name}/`, ...meta };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

app.get('/api/games', (_req, res) => res.json(listGames()));

const tls = FORCE_HTTP ? null : ensureCert();
const server = tls ? https.createServer(tls, app) : http.createServer(app);
const scheme = tls ? 'https' : 'http';

const lanIp = localAddresses()[0] || 'localhost';
const controllerUrl = `${scheme}://${lanIp}:${PORT}/controller`;

// The PC client fetches this to render a scannable join code.
app.get('/api/pairing', async (_req, res) => {
  try {
    const qr = await QRCode.toDataURL(controllerUrl, {
      margin: 1,
      width: 320,
      color: { dark: '#0b0e14', light: '#ffffff' },
    });
    res.json({ url: controllerUrl, qr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const io = new Server(server, {
  // Orientation samples are tiny and constant; skip the polling handshake.
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' },
});

/** socket.id → 'game' | 'controller' */
const roles = new Map();

function countOf(role) {
  let n = 0;
  for (const r of roles.values()) if (r === role) n += 1;
  return n;
}

/**
 * Player slots. Only slot 0 is used today, but tagging every packet with its
 * slot from the start means adding a second phone later is a feature, not a
 * protocol migration.
 */
const MAX_PLAYERS = 4;
const slots = new Array(MAX_PLAYERS).fill(null);   // index → socket.id

function assignSlot(socketId) {
  const free = slots.indexOf(null);
  if (free === -1) return -1;
  slots[free] = socketId;
  return free;
}

function releaseSlot(socketId) {
  const i = slots.indexOf(socketId);
  if (i !== -1) slots[i] = null;
}

const slotOf = (socketId) => slots.indexOf(socketId);

function broadcastPresence() {
  io.emit('presence', {
    game: countOf('game'),
    controller: countOf('controller'),
    slots: slots.map((id, i) => ({ slot: i, occupied: id !== null })),
  });
}

io.on('connection', (socket) => {
  socket.on('register', (role) => {
    if (role !== 'game' && role !== 'controller') return;
    roles.set(socket.id, role);
    socket.join(role);

    if (role === 'controller') {
      const slot = assignSlot(socket.id);
      if (slot === -1) {
        socket.emit('slot-denied', { reason: 'all player slots full', max: MAX_PLAYERS });
        console.log(`[io] controller rejected — ${MAX_PLAYERS} slots full (${socket.id})`);
        return;
      }
      socket.emit('slot', { slot });
      console.log(`[io] controller connected as player ${slot + 1} (${socket.id})`);
    } else {
      console.log(`[io] game connected (${socket.id})`);
    }
    broadcastPresence();
  });

  // Latency probe. Echoed straight back so the game can measure a true round
  // trip — a one-way timestamp would need synchronised clocks across devices.
  socket.on('ping-probe', (data) => socket.to('controller').emit('ping-probe', data));
  socket.on('pong-probe', (data) => socket.to('game').emit('pong-probe', data));

  // Phone → PC.
  //
  // NOT volatile. Socket.IO discards volatile packets whenever the transport
  // reports itself unwritable, which on the long-polling transport is most of
  // the time — so a connection that falls back to polling (easy to trigger with
  // a self-signed cert) drops effectively the entire orientation stream while
  // ordinary emits still get through. That failure is invisible: the phone
  // connects, commands work, and the blade simply never moves. The payload is
  // ~100 bytes at 60Hz; the rate cap on the sender is the real backpressure.
  socket.on('orientation', (data) => {
    socket.to('game').emit('orientation', { ...data, slot: slotOf(socket.id) });
  });

  socket.on('motion', (data) => {
    socket.to('game').emit('motion', { ...data, slot: slotOf(socket.id) });
  });

  // Phone → PC control actions: calibrate, start, pause, sensitivity nudges.
  socket.on('command', (data) => {
    socket.to('game').emit('command', { ...data, slot: slotOf(socket.id) });
  });

  // PC → phone feedback: hits (haptics), score, game state.
  socket.on('feedback', (data) => {
    socket.to('controller').emit('feedback', data);
  });

  socket.on('disconnect', () => {
    const role = roles.get(socket.id);
    roles.delete(socket.id);
    releaseSlot(socket.id);
    if (role) console.log(`[io] ${role} disconnected (${socket.id})`);
    broadcastPresence();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  🕹  OpenWii — your phone is the remote');
  console.log(line);
  console.log(`  Launcher      ${scheme}://localhost:${PORT}/`);
  console.log(`  Phone remote  ${controllerUrl}`);
  const games = listGames();
  console.log(`\n  ${games.length} game${games.length === 1 ? '' : 's'}:`);
  for (const g of games) console.log(`    ${g.emoji}  ${g.title}  →  ${g.url}`);
  if (!tls) {
    console.log('\n  ⚠  Running plain HTTP. Phone sensors will NOT work off');
    console.log('     localhost — browsers gate the IMU behind a secure context.');
  } else {
    console.log('\n  ⚠  Self-signed cert: the phone will show a warning once.');
    console.log('     Tap Advanced → Proceed. Sensors need HTTPS to unlock.');
  }
  console.log(`${line}\n`);
});
