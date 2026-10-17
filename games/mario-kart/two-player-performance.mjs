/** Bounded solo/duo Chrome benchmark on the bundled stadium and live simulation.
 * Start the server first. Run: node games/mario-kart/two-player-performance.mjs
 * KART_URL overrides https://localhost:8443. No game state is written by this probe.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.KART_URL || 'https://localhost:8443';
// Keep the original 720p-versus-intercept report intact as historical evidence.
const out = new URL('./evidence/two-player-performance-current/', import.meta.url);
const sampleMs = Number(process.env.KART_SAMPLE_MS || 10000);
await mkdir(out, { recursive: true });
const report = {
  date: new Date().toISOString(),
  base,
  viewport: { width: 1920, height: 1080 },
  preset: 'medium',
  sampleMs,
  method: 'Chrome presented-frame intervals during live, advancing races. Solo uses keyboard gas; duo uses two simulated Socket.IO phone clients sending orientation and P1 gas. The clients do not use physical sensors. Both runs use the bundled stadium and production graphics code.',
  runs: [],
};
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });

async function makePage() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true,
    viewport: report.viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(() => window.__kart?.assets, null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => __kart.sourceCourse), true, 'bundled stadium');
  await page.locator('#graphics-panel summary').click();
  await page.selectOption('#graphics-quality', 'medium');
  return { context, page, errors };
}

async function sample(page, mode, errors) {
  await page.waitForTimeout(2000);
  const before = await page.evaluate(() => ({
    count: __kart.frameTimes.length,
    time: __kart.race.time,
    progress: __kart.race.players.map(p => p.s),
  }));
  const wallStart = performance.now();
  await page.waitForTimeout(sampleMs);
  const actualMs = performance.now() - wallStart;
  const metrics = await page.evaluate(({ count, time, progress, mode }) => {
    const frames = __kart.frameTimes.slice(count).filter(ms => ms > 0 && ms < 1000).sort((a, b) => a - b);
    const sum = frames.reduce((a, b) => a + b, 0);
    const canvas = document.getElementById('game');
    const gl = canvas.getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      frames: frames.length,
      fps: frames.length * 1000 / sum,
      meanMs: sum / frames.length,
      p95Ms: frames[Math.floor((frames.length - 1) * .95)],
      p99Ms: frames[Math.floor((frames.length - 1) * .99)],
      maxMs: frames.at(-1),
      elapsedRaceSeconds: __kart.race.time - time,
      progressBefore: progress,
      progressAfter: __kart.race.players.map(p => p.s),
      state: __kart.race.state,
      paused: __kart.paused,
      quality: __kart.graphics,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      drawingBuffer: { width: canvas.width, height: canvas.height },
      viewBuffer: { width: mode === 'duo' ? canvas.width / 2 : canvas.width,
        height: canvas.height },
      draws: __kart.stats,
      hud: mode === 'duo' ? [0, 1].map(i => ({
        name: document.getElementById(`duo-name-${i}`).textContent,
        speed: document.getElementById(`duo-speed-${i}`).textContent,
        lap: document.getElementById(`duo-lap-${i}`).textContent,
        rank: document.getElementById(`duo-rank-${i}`).textContent,
      })) : null,
    };
  }, { ...before, mode });
  metrics.wallMs = actualMs;
  metrics.errors = errors;
  assert.ok(metrics.frames > 100, `${mode}: sufficient presented frames`);
  assert.ok(metrics.elapsedRaceSeconds > 1, `${mode}: race simulation advanced`);
  assert.equal(metrics.paused, false, `${mode}: not paused`);
  assert.equal(metrics.state, 'racing', `${mode}: still racing`);
  assert.deepEqual(errors, [], `${mode}: no page errors`);
  assert.deepEqual(metrics.drawingBuffer, report.viewport,
    `${mode}: Balanced renders the full 1920x1080 canvas at DPR 1`);
  await page.screenshot({ path: fileURLToPath(new URL(`${mode}.png`, out)) });
  return { mode, ...metrics };
}

try {
  {
    const { context, page, errors } = await makePage();
    try {
      await page.locator('#start').click();
      await page.locator('[data-laps="1"]').click();
      await page.locator('#start').click();
      await page.waitForFunction(() => __kart.race.state === 'racing', null, { timeout: 20000 });
      await page.keyboard.down('KeyZ');
      report.runs.push(await sample(page, 'solo', errors));
      await page.keyboard.up('KeyZ');
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await makePage();
    try {
      await page.click('[data-mode="duo"]');
      await page.evaluate(() => {
        const quat = [0.061628416716219346, 0.061628416716219346,
          -0.7044160264027587, 0.7044160264027587];
        window.__benchPhones = [0, 1].map(i => {
          const identity = `simulated-phone-${i}-stable-local-test`;
          const socket = io({ transports: ['websocket'] });
          socket.on('connect', () => socket.emit('register', { role: 'controller', identity }));
          const timer = setInterval(() => socket.emit('orientation', { quat }), 16);
          return { socket, timer };
        });
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.duo-choice small')]
        .every(el => el.textContent.includes('Press 2')), null, { timeout: 15000 });
      await page.evaluate(() => __benchPhones.forEach(phone => {
        phone.socket.emit('command', { type: 'button', button: '2', pressed: true });
        phone.socket.emit('command', { type: 'button-up', button: '2' });
      }));
      await page.waitForFunction(() => __kart.race.state === 'racing', null, { timeout: 20000 });
      await page.evaluate(() => { window.__benchGas = setInterval(() =>
        __benchPhones[0].socket.emit('command', { type: 'buttons', buttons: { 2: true } }), 100); });
      report.runs.push(await sample(page, 'duo', errors));
      await page.evaluate(() => {
        clearInterval(__benchGas);
        __benchPhones.forEach(phone => { clearInterval(phone.timer); phone.socket.disconnect(); });
      });
    } finally { await context.close(); }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack || String(error);
  throw error;
} finally {
  await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
