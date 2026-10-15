/** Adversarial browser review for the two-player relay and lobby.
 * Run against an isolated OpenWii server with KART_URL set. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.KART_URL || 'https://localhost:8443';
const output = new URL('./evidence/two-player-adversarial/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });
const failures = [];
const quat = [0.061628416716219346, 0.061628416716219346,
  -0.7044160264027587, 0.7044160264027587];

try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`${base}/games/mario-kart/?evidence=1&sourceCourse=0`);
  await page.waitForFunction(() => window.__kart?.assets, null, { timeout: 60000 });
  await page.click('[data-mode="duo"]');
  await page.waitForTimeout(4000);
  assert.equal(await page.evaluate(() => __kart.race.state), 'ready',
    'duo must remain in lobby without phones');
  assert.equal(await page.locator('#duo-state-0').textContent(), 'Connect phone');
  assert.equal(await page.locator('#duo-state-1').textContent(), 'Connect phone');

  await page.evaluate(() => {
    window.__testPhones = new Map();
    window.__connectPhone = (identity) => {
      const socket = io({ transports: ['websocket'] });
      socket.on('connect', () => socket.emit('register', { role: 'controller', identity }));
      const timer = setInterval(() => socket.emit('orientation', { quat: [
        0.061628416716219346, 0.061628416716219346,
        -0.7044160264027587, 0.7044160264027587,
      ] }), 16);
      const phone = { identity, socket, timer, slot: null };
      socket.on('slot', ({ slot }) => { phone.slot = slot; });
      window.__testPhones.set(identity, phone);
      return phone;
    };
    window.__testPhones.set('p1_original_stable_identity',
      window.__connectPhone('p1_original_stable_identity'));
    window.__testPhones.set('p2_original_stable_identity',
      window.__connectPhone('p2_original_stable_identity'));
  });
  await page.waitForFunction(() => [...__testPhones.values()].every(p => p.slot !== null));
  assert.deepEqual(await page.evaluate(() => [...__testPhones.values()].map(p => p.slot)), [0, 1]);
  await page.waitForFunction(() => [...document.querySelectorAll('.duo-choice small')]
    .every(el => el.textContent.includes('Press 2')), null, { timeout: 15000 });

  const originalDrivers = await page.evaluate(() => [
    document.querySelector('#duo-driver-0').textContent,
    document.querySelector('#duo-driver-1').textContent,
  ]);
  await page.evaluate(() => {
    const [p1, p2] = [...__testPhones.values()];
    p1.socket.emit('command', { type: 'button', button: 'right', menuDirection: 'right', pressed: true });
    p2.socket.emit('command', { type: 'button', button: 'left', menuDirection: 'left', pressed: true });
  });
  await page.waitForFunction(() => document.querySelector('#duo-driver-0').textContent !== 'Mario' &&
    document.querySelector('#duo-driver-1').textContent !== 'Luigi');
  const selectedDrivers = await page.evaluate(() => [
    document.querySelector('#duo-driver-0').textContent,
    document.querySelector('#duo-driver-1').textContent,
  ]);
  assert.notDeepEqual(selectedDrivers, originalDrivers, 'both independent menu inputs must take effect');
  assert.notEqual(selectedDrivers[0], selectedDrivers[1], 'driver selections must remain distinct');
  await page.screenshot({ path: fileURLToPath(new URL('lobby.png', output)) });

  await page.evaluate(() => __testPhones.get('p1_original_stable_identity').socket.emit('command',
    { type: 'button', button: '2', pressed: true }));
  await page.waitForFunction(() => document.querySelector('#duo-state-0').textContent === 'READY');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => __kart.race.state), 'ready',
    'one ready player must not start a shared countdown');
  assert.equal(await page.locator('#duo-state-1').textContent(), 'Press 2 to ready');

  await page.evaluate(() => __testPhones.get('p2_original_stable_identity').socket.emit('command',
    { type: 'button', button: '2', pressed: true }));
  await page.waitForFunction(() => __kart.race.state === 'countdown', null, { timeout: 15000 });
  await page.waitForFunction(() => __kart.race.state === 'racing', null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => __kart.race.humanCount), 2);
  assert.equal(await page.evaluate(() => __kart.race.racers.length), 8);
  assert.deepEqual(await page.evaluate(() => __kart.race.players.map(p => p.character.name)), selectedDrivers);
  assert.equal(await page.locator('#duo-hud').isVisible(), true);
  assert.equal(await page.locator('#duo-hud-0').isVisible(), true);
  assert.equal(await page.locator('#duo-hud-1').isVisible(), true);
  for (const id of ['#item-frame', '#lap-panel', '#position', '#minimap', '#speed'])
    assert.equal(await page.locator(id).isVisible(), false,
      `${id} solo HUD element must be hidden in duo mode`);
  await page.waitForFunction(() => __kart.renderCount > 30);
  await page.screenshot({ path: fileURLToPath(new URL('race.png', output)) });
  const initialRenderCount = await page.evaluate(() => __kart.renderCount);
  await page.waitForTimeout(1000);
  assert.ok(await page.evaluate(n => __kart.renderCount > n, initialRenderCount),
    'both viewport rendering must remain live');

  await page.evaluate(() => {
    const p1 = __testPhones.get('p1_original_stable_identity');
    p1.socket.emit('command', { type: 'buttons', buttons: { 2: true } });
  });
  await page.waitForFunction(() => __kart.race.players[0].speed > 1, null, { timeout: 10000 });
  await page.evaluate(() => __testPhones.get('p1_original_stable_identity').socket.emit('command',
    { type: 'buttons', buttons: {} }));
  await page.waitForFunction(() => __kart.race.players[0].lastInput.gas === false);
  const p2SpeedBefore = await page.evaluate(() => __kart.race.players[1].speed);
  await page.waitForTimeout(900);
  const p2SpeedAfter = await page.evaluate(() => __kart.race.players[1].speed);
  assert.ok(Math.abs(p2SpeedAfter - p2SpeedBefore) < 8,
    'P1 gas must not directly accelerate P2');

  await page.evaluate(() => {
    const p = __testPhones.get('p1_original_stable_identity');
    clearInterval(p.timer); p.socket.disconnect();
  });
  await page.waitForFunction(() => __kart.paused, null, { timeout: 5000 });
  await page.waitForTimeout(250);
  const frozenTime = await page.evaluate(() => __kart.race.time);
  await page.evaluate(() => {
    const impostor = __connectPhone('intruder_unique_identity_0001');
    window.__intruder = impostor;
    impostor.socket.emit('command', { type: 'button', button: 'right', pressed: true });
  });
  await page.waitForFunction(() => __intruder.slot !== null, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => __intruder.slot), 2,
    'new identity must not reclaim disconnected P1 slot');
  const itemBefore = await page.evaluate(() => __kart.race.players[0].item);
  await page.evaluate(() => __intruder.socket.emit('command',
    { type: 'button', button: 'right', pressed: true, slot: 0 }));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => __kart.race.players[0].item), itemBefore,
    'spoofed slot field from an unassigned identity must not control P1');
  assert.equal(await page.evaluate(t => __kart.race.time, frozenTime), frozenTime,
    'disconnect pause must freeze simulation time');
  await page.evaluate(() => { clearInterval(__intruder.timer); __intruder.socket.disconnect(); });

  await page.evaluate(() => {
    const p = __connectPhone('p1_original_stable_identity');
    window.__reconnectedP1 = p;
  });
  await page.waitForFunction(() => __reconnectedP1.slot !== null);
  assert.equal(await page.evaluate(() => __reconnectedP1.slot), 0,
    'the original phone identity must reclaim P1');
  await page.waitForTimeout(650);
  await page.evaluate(() => __reconnectedP1.socket.emit('command',
    { type: 'button', button: '2', pressed: true }));
  await page.waitForFunction(() => !__kart.paused, null, { timeout: 5000 });

  // A connected phone whose orientation stream stops must trigger the same safe pause.
  await page.evaluate(() => {
    const p = __testPhones.get('p2_original_stable_identity');
    clearInterval(p.timer);
  });
  await page.waitForFunction(() => __kart.paused, null, { timeout: 5000 });
  const stalePauseTime = await page.evaluate(() => __kart.race.time);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => __kart.race.time), stalePauseTime,
    'stale motion pause must freeze the shared simulation');
  await page.evaluate(() => {
    const p = __testPhones.get('p2_original_stable_identity');
    p.timer = setInterval(() => p.socket.emit('orientation', { quat: [
      0.061628416716219346, 0.061628416716219346,
      -0.7044160264027587, 0.7044160264027587,
    ] }), 16);
  });
  await page.waitForTimeout(650);
  await page.evaluate(() => __testPhones.get('p2_original_stable_identity').socket.emit('command',
    { type: 'button', button: '2', pressed: true }));
  await page.waitForFunction(() => !__kart.paused, null, { timeout: 5000 });

  // Exercise the results UI transition without pretending to simulate an entire race.
  await page.evaluate(() => {
    const race = __kart.race;
    race.racers.forEach((r, i) => { r.finishTime = i + 1; r.finishAnnounced = i >= 2; });
    race.state = 'racing';
    race.update(1 / 120, [{}, {}]);
  });
  await page.waitForFunction(() => __kart.race.state === 'results' && !document.querySelector('#results').hidden,
    null, { timeout: 10000 });
  assert.match(await page.locator('#result-summary').textContent(), /P1 .* P2/);
  await page.waitForFunction(() => !document.querySelector('#again').disabled, null, { timeout: 5000 });
  await page.click('#again');
  await page.waitForFunction(() => __kart.race.state === 'ready' &&
    !document.querySelector('#duo-lobby').hidden, null, { timeout: 10000 });
  assert.equal(await page.locator('#duo-state-0').textContent(), 'Press 2 to ready');
  assert.equal(await page.locator('#duo-state-1').textContent(), 'Press 2 to ready');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, checks: [
    'no-phone lobby start gate', 'independent distinct driver selection',
    'both-player ready gate', 'eight-racer split HUD and active viewports',
    'player control isolation', 'identity reservation and spoofed-slot rejection',
    'disconnect and stale-motion safe pause/resume', 'results UI and duo restart',
  ], note: 'Results UI transition was forced through the real Race object; full race completion was not simulated.',
  graphics: await page.evaluate(() => __kart.graphics) }, null, 2));
  await page.evaluate(() => {
    for (const p of __testPhones.values()) { clearInterval(p.timer); p.socket.disconnect(); }
    if (window.__intruder) { clearInterval(__intruder.timer); __intruder.socket.disconnect(); }
  });
} finally { await browser.close(); }
