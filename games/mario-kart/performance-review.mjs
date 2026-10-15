/** Local Chrome GPU and repeatable frame-time probe. Start the server first. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.KART_URL || 'https://localhost:8443'}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(() => window.__kart?.assets, null, { timeout: 90000 });
  const gpu = await page.evaluate(() => {
    const gl = document.getElementById('game').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), attributes: gl.getContextAttributes() };
  });
  console.log(JSON.stringify({ gpu }));
  await page.keyboard.press('Enter');
  await page.locator('[data-laps="1"]').click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => __kart.race.state === 'racing');
  const profiles = process.argv.includes('--smoke') ? [] : process.argv.includes('--compare') ? ['high', 'medium', 'low'] : [null];
  await page.locator('#graphics-panel summary').click();
  for (const quality of profiles) {
    if (quality) {
      await page.selectOption('#graphics-quality', quality);
      const state = await page.evaluate(() => __kart.graphics);
      assert.equal(state.quality, quality);
      assert.equal(state.ao, quality === 'high');
      assert.equal(state.shadows, quality !== 'low');
      assert.equal(state.bloom, quality !== 'low');
    }
    // Fixed on-course poses keep geometry/camera consistent between presets.
    for (const fraction of [0.05, 0.35, 0.65]) {
      await page.evaluate(async fraction => {
        const { TRACK_LENGTH } = await import('./track.js');
        __kart.freeze = true;
        __kart.place(TRACK_LENGTH * fraction);
      }, fraction);
      await page.waitForTimeout(2000);
      const before = await page.evaluate(() => __kart.frameTimes.length);
      await page.waitForTimeout(4000);
      const result = await page.evaluate(before => {
        const samples = __kart.frameTimes.slice(before).sort((a,b) => a-b);
        return { fps: 1000 / (samples.reduce((a,b) => a+b, 0) / samples.length), p95ms: samples[Math.floor(samples.length * .95)], frames: samples.length, stats: __kart.stats, graphics: __kart.graphics };
      }, before);
      console.log(JSON.stringify({ quality: quality || 'default', fraction, ...result }));
    }
  }
  // Exercise both directions: restoring effects after Performance must work too.
  for (const quality of ['low', 'high', 'medium']) {
    await page.selectOption('#graphics-quality', quality);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => __kart.graphics.quality), quality);
    assert.equal(await page.evaluate(() => __kart.race.state), 'racing');
  }
  await page.setViewportSize({width:2560,height:1440});
  assert.ok(await page.evaluate(() => {
    const canvas=document.getElementById('game');
    return canvas.width*canvas.height<=1920*1080 && Math.abs(canvas.width/canvas.height-16/9)<.01;
  }), 'Balanced keeps fullscreen rendering within its pixel budget');
  await page.setViewportSize({width:1920,height:1080});
  if (process.argv.includes('--screenshot')) await page.waitForTimeout(600);
  if (process.argv.includes('--screenshot')) {
    await mkdir(new URL('./evidence/', import.meta.url), {recursive:true});
    await page.screenshot({path: fileURLToPath(new URL('./evidence/performance-review.png', import.meta.url))});
  }
  await page.reload();
  await page.waitForFunction(() => window.__kart?.assets, null, {timeout:90000});
  assert.equal(await page.evaluate(() => __kart.graphics.quality), 'medium', 'Quality survives navigation');
  await page.locator('#graphics-panel summary').click();
  await page.locator('#graphics-quality').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => __kart.race.state), 'ready', 'Graphics keyboard controls do not start a race');
  console.log(JSON.stringify({uiChecks:'passed',errors}));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
