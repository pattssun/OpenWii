'use strict';

/**
 * fruit-ninja — LAN relay server.
 *
 * Serves two clients and pipes messages between them:
 *   /            → PC game client (canvas)
 *   /controller  → phone controller (IMU sender)
 *
 * The server holds no game state. It is a dumb, low-latency switchboard so the
 * phone's orientation stream reaches the PC with as few hops as possible.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { ensureCert, localAddresses } = require('./scripts/gen-cert');

const PORT = Number(process.env.PORT) || 8443;
const FORCE_HTTP = process.env.HTTP === '1';

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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

function broadcastPresence() {
  io.emit('presence', { game: countOf('game'), controller: countOf('controller') });
}

io.on('connection', (socket) => {
  socket.on('register', (role) => {
    if (role !== 'game' && role !== 'controller') return;
    roles.set(socket.id, role);
    socket.join(role);
    console.log(`[io] ${role} connected (${socket.id})`);
    broadcastPresence();
  });

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
    socket.to('game').emit('orientation', data);
  });

  socket.on('motion', (data) => {
    socket.to('game').emit('motion', data);
  });

  // Phone → PC control actions: calibrate, start, pause, sensitivity nudges.
  socket.on('command', (data) => {
    socket.to('game').emit('command', data);
  });

  // PC → phone feedback: slice hits (haptics), score, game state.
  socket.on('feedback', (data) => {
    socket.to('controller').emit('feedback', data);
  });

  socket.on('disconnect', () => {
    const role = roles.get(socket.id);
    roles.delete(socket.id);
    if (role) console.log(`[io] ${role} disconnected (${socket.id})`);
    broadcastPresence();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  🍉  fruit-ninja — motion controlled');
  console.log(line);
  console.log(`  PC game     ${scheme}://localhost:${PORT}/`);
  console.log(`  Phone sword ${controllerUrl}`);
  if (!tls) {
    console.log('\n  ⚠  Running plain HTTP. Phone sensors will NOT work off');
    console.log('     localhost — browsers gate the IMU behind a secure context.');
  } else {
    console.log('\n  ⚠  Self-signed cert: the phone will show a warning once.');
    console.log('     Tap Advanced → Proceed. Sensors need HTTPS to unlock.');
  }
  console.log(`${line}\n`);
});
