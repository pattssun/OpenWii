/** Local browser smoke using two simulated phones over the real Socket.IO relay.
 * Run against an already started server: node games/mario-kart/two-player-review.mjs */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.KART_URL || 'https://localhost:8443';
const output = new URL('./evidence/two-player/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/games/mario-kart/?evidence=1&sourceCourse=0`);
  await page.waitForFunction(() => window.__kart?.assets, null, { timeout: 60000 });
  await page.click('[data-mode="duo"]');
  await page.evaluate(() => {
    const quat = [0.061628416716219346, 0.061628416716219346,
      -0.7044160264027587, 0.7044160264027587];
    window.__simPhones = [0, 1].map(i => {
      const identity = `simulated-phone-${i}-stable-local-test`;
      const socket = io({ transports: ['websocket'] });
      socket.on('connect', () => socket.emit('register', { role: 'controller', identity }));
      const timer = setInterval(() => socket.emit('orientation', { quat }), 16);
      return { socket, identity, timer };
    });
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.duo-choice small')]
    .every(el => el.textContent.includes('Press 2')), null, { timeout: 15000 });
  await page.evaluate(() => __simPhones[0].socket.emit('command',
    { type: 'button', button: 'right', menuDirection: 'right', pressed: true }));
  await page.waitForFunction(() => document.getElementById('duo-driver-0').textContent === 'Peach');
  assert.equal(await page.locator('#duo-driver-1').textContent(), 'Luigi');
  await page.screenshot({ path: fileURLToPath(new URL('lobby.png', output)) });
  await page.evaluate(() => __simPhones.forEach(phone => {
    phone.socket.emit('command', { type: 'button', button: '2', pressed: true });
    phone.socket.emit('command', { type: 'button-up', button: '2' });
  }));
  await page.waitForFunction(() => __kart.race.state === 'countdown', null, { timeout: 15000 });
  try { await page.waitForFunction(() => __kart.race.state === 'racing', null, { timeout: 15000 }); }
  catch (error) {
    console.log('Race start diagnostic', await page.evaluate(() => ({
      state: __kart.race.state, time: __kart.race.time, paused: __kart.paused,
      pauseReason: document.getElementById('pause-reason').textContent,
      slots: __simPhones.map(phone => phone.socket.connected),
      lobby: [...document.querySelectorAll('.duo-choice small')].map(el => el.textContent),
      wheelStatus: document.getElementById('wheel-status').textContent,
      errors: document.getElementById('error').textContent,
    })));
    throw error;
  }
  assert.deepEqual(await page.evaluate(() => __kart.race.players.map(p => p.character.id)),
    ['peach', 'luigi']);
  assert.equal(await page.locator('#duo-hud').isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL('race.png', output)) });
  await page.evaluate(() => { window.__gasTimer = setInterval(() =>
    __simPhones[0].socket.emit('command', { type: 'buttons', buttons: { 2: true } }), 100); });
  await page.waitForFunction(() => __kart.race.players[0].speed > 4, null, { timeout: 10000 });
  const speeds = await page.evaluate(() => __kart.race.players.map(p => ({
    speed: p.speed, gas: p.lastInput.gas, boost: p.boost, spin: p.spin })));
  console.log('Independent gas diagnostic', speeds);
  await page.waitForFunction(() => __kart.race.players[0].speed >
    __kart.race.players[1].speed + 3, null, { timeout: 10000 });
  await page.evaluate(() => { clearInterval(__gasTimer); __simPhones[0].socket.emit('command',
    { type: 'buttons', buttons: {} }); __simPhones[1].socket.disconnect(); });
  await page.waitForFunction(() => __kart.paused, null, { timeout: 10000 });
  await page.evaluate(() => {
    const phone = __simPhones[1];
    clearInterval(phone.timer);
    phone.socket = io({ transports: ['websocket'] });
    phone.socket.on('connect', () => phone.socket.emit('register',
      { role: 'controller', identity: phone.identity }));
    const quat = [0.061628416716219346, 0.061628416716219346,
      -0.7044160264027587, 0.7044160264027587];
    phone.timer = setInterval(() => phone.socket.emit('orientation', { quat }), 16);
  });
  await page.waitForFunction(() => __simPhones[1].socket.connected, null, { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => __simPhones[1].socket.emit('command',
    { type: 'button', button: '2', pressed: true }));
  await page.waitForFunction(() => !__kart.paused, null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['two phones ready with distinct drivers',
    'split race and independent gas', 'disconnect pause and identity resume'],
    graphics: await page.evaluate(() => __kart.graphics) }, null, 2));
  await page.evaluate(() => __simPhones.forEach(phone => {
    clearInterval(phone.timer); phone.socket.disconnect();
  }));
} finally { await browser.close(); }
