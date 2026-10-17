/** Checks the real responsive phone-controller pages receive the correct duo profile. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.KART_URL || 'https://localhost:8443';
const output = new URL('./evidence/two-player-adversarial/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const game = await browser.newPage({ ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 } });
  const p1Context = await browser.newContext({ ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p2Context = await browser.newContext({ ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p1Context.addInitScript(() => localStorage.setItem('openwii.phone.identity.v1',
    'phone-profile-player-one-stable'));
  await p2Context.addInitScript(() => localStorage.setItem('openwii.phone.identity.v1',
    'phone-profile-player-two-stable'));
  const p1 = await p1Context.newPage(), p2 = await p2Context.newPage();
  await game.goto(`${base}/games/mario-kart/?evidence=1&sourceCourse=0`);
  await game.waitForFunction(() => window.__kart?.assets, null, { timeout: 60000 });
  await game.click('[data-mode="duo"]');

  // Connect in order so slot ownership is deterministic in the test run.
  await p1.goto(`${base}/controller`);
  await game.waitForFunction(() => document.querySelector('#duo-state-0')?.textContent === 'Hold level to calibrate', null,
    { timeout: 15000 });
  await p1.waitForFunction(() => document.querySelector('#player')?.textContent.startsWith('P1'));
  await p2.goto(`${base}/controller`);
  await game.waitForFunction(() => document.querySelector('#duo-state-0')?.textContent === 'Hold level to calibrate' &&
    document.querySelector('#duo-state-1')?.textContent === 'Hold level to calibrate', null,
  { timeout: 15000 });
  await p2.waitForFunction(() => document.querySelector('#player')?.textContent.startsWith('P2'));
  // The controller intentionally gates physical controls behind a user gesture.
  await Promise.all([p1.locator('#enable').click(), p2.locator('#enable').click()]);
  await Promise.all([p1.waitForFunction(() => document.querySelector('#gate').classList.contains('hide')),
    p2.waitForFunction(() => document.querySelector('#gate').classList.contains('hide'))]);
  await Promise.all([p1.waitForFunction(() => document.body.classList.contains('wheel-mode')),
    p2.waitForFunction(() => document.body.classList.contains('wheel-mode'))]);

  const profile = await Promise.all([p1, p2].map(page => page.evaluate(() => ({
    label: document.querySelector('#wheel-guide').textContent,
    color: getComputedStyle(document.querySelector('#wheel-guide')).color,
    slotLed: [...document.querySelectorAll('#leds i')].map(led => led.classList.contains('on')),
  }))));
  assert.ok(profile[0].label.startsWith('P1') && profile[0].label.includes('Mario'));
  assert.ok(profile[1].label.startsWith('P2') && profile[1].label.includes('Luigi'));
  assert.equal(profile[0].color, 'rgb(255, 82, 103)');
  assert.equal(profile[1].color, 'rgb(94, 170, 255)');
  assert.deepEqual(profile[0].slotLed, [true, false, false, false]);
  assert.deepEqual(profile[1].slotLed, [false, true, false, false]);

  const before = await Promise.all([game.locator('#duo-driver-0').textContent(),
    game.locator('#duo-driver-1').textContent()]);
  await p1.locator('.dp.r').click();
  await p2.locator('.dp.l').click();
  await game.waitForFunction(() => document.querySelector('#duo-driver-0').textContent !== 'Mario' &&
    document.querySelector('#duo-driver-1').textContent !== 'Luigi');
  const chosen = await Promise.all([game.locator('#duo-driver-0').textContent(),
    game.locator('#duo-driver-1').textContent()]);
  assert.notDeepEqual(chosen, before);
  assert.notEqual(chosen[0], chosen[1]);
  await Promise.all([p1.waitForFunction(name => document.querySelector('#wheel-guide').textContent.includes(name), chosen[0]),
    p2.waitForFunction(name => document.querySelector('#wheel-guide').textContent.includes(name), chosen[1])]);
  await Promise.all([p1.screenshot({ path: fileURLToPath(new URL('phone-p1.png', output)) }),
    p2.screenshot({ path: fileURLToPath(new URL('phone-p2.png', output)) })]);
  console.log(JSON.stringify({ passed: true, profiles: profile, chosenDrivers: chosen,
    note: 'Controller pages registered and sent real touch commands; sensor events were not supplied.' }, null, 2));
  await Promise.all([p1Context.close(), p2Context.close()]);
} finally { await browser.close(); }
