/** Four simulated phone sockets through the real relay and game browser. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const browser = await chromium.launch({channel:'chrome',headless:true});
const base = process.env.KART_URL || 'https://localhost:8443';
const out = new URL('./evidence/four-player/', import.meta.url);
await mkdir(out,{recursive:true});
try {
  const page = await browser.newPage({ignoreHTTPSErrors:true,viewport:{
    width:Number(process.env.KART_WIDTH)||1280,height:Number(process.env.KART_HEIGHT)||720,
  }});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(() => window.__kart?.assets,null,{timeout:90000});
  await page.click('[data-mode="duo"]');
  await page.check('#keyboard-test');
  await page.click('[data-mode="quad"]');
  assert.equal(await page.getAttribute('[data-mode="quad"]','aria-pressed'),'true');
  assert.equal(await page.isChecked('#keyboard-test'),true,'The quad mode must ignore a remembered duo keyboard test');
  assert.equal(await page.textContent('#duo-state-1'),'Connect phone','Quad P2 needs a real phone before calibration');
  await page.waitForFunction(() => document.getElementById('wheel-status').textContent.includes('P2: Connect phone'));
  assert.equal((await page.textContent('#wheel-status')).includes('keyboard available'),false);
  await page.evaluate(() => {
    const quat = [.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587];
    window.__phones = Array.from({length:4}, (_, i) => {
      const socket = io({transports:['websocket']});
      socket.on('connect', () => socket.emit('register',{role:'controller',identity:`four-player-review-${i}`}));
      socket.on('feedback', msg => {
        if (msg.type === 'controller-player') (window.__labels ||= {})[i] = msg;
      });
      return socket;
    });
    window.__phoneTimer = setInterval(() => {
      for (const socket of window.__phones) socket.emit('orientation',{quat});
    },16);
  });
  await page.waitForFunction(() =>
    [...Array(4)].every((_, i) => document.getElementById(`duo-state-${i}`).textContent === 'Press 2 to ready') &&
    Object.keys(window.__labels || {}).length === 4,null,{timeout:30000});
  const labels = await page.evaluate(() => Array.from({length:4}, (_,i) => __labels[i]));
  assert.deepEqual(labels.map(label => label.playerColor),['#ff5267','#5eaaff','#63d978','#ffe067']);
  const previousDrivers = await page.locator('.duo-choice b').allTextContents();
  await page.evaluate(() => __phones[2].emit('command',{type:'button',button:'right',menuDirection:'right',pressed:true}));
  await page.waitForFunction(previous => document.getElementById('duo-driver-2').textContent !== previous,previousDrivers[2]);
  assert.equal(await page.textContent('#duo-driver-0'),previousDrivers[0]);
  assert.equal(new Set(await page.locator('.duo-choice b').allTextContents()).size,4);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) __phones[i].emit('command',{type:'button',button:'2',pressed:true});
  });
  await page.waitForFunction(() => ['READY','Press 2 to ready'].includes(document.getElementById('duo-state-3').textContent) &&
    [...Array(3)].every((_, i) => document.getElementById(`duo-state-${i}`).textContent === 'READY'));
  assert.equal(await page.evaluate(() => __kart.race.state),'ready');
  await page.screenshot({path:fileURLToPath(new URL('lobby.png',out))});
  await page.evaluate(() => __phones[3].emit('command',{type:'button',button:'2',pressed:true}));
  await page.waitForFunction(() => __kart.race.state === 'countdown',null,{timeout:30000});
  await page.waitForFunction(() => __kart.race.state === 'racing',null,{timeout:30000});
  assert.equal(await page.locator('.duo-player:visible').count(),4);
  await page.screenshot({path:fileURLToPath(new URL('race.png',out))});
  await page.evaluate(() => __phones[3].emit('command',{type:'button',button:'2',pressed:true}));
  await page.waitForFunction(() => __kart.race.players[3].lastInput.gas);
  assert.equal(await page.evaluate(() => __kart.race.players.slice(0,3).some(player => player.lastInput.gas)),false);
  await page.evaluate(() => {
    __phones[3].emit('command',{type:'button',button:'2',pressed:false});
    __phones[1].emit('command',{type:'button',button:'2',pressed:true});
  });
  await page.waitForFunction(() => __kart.race.players[1].lastInput.gas);
  assert.equal(await page.evaluate(() => __kart.race.players[0].lastInput.gas || __kart.race.players[2].lastInput.gas),false);
  await page.evaluate(() => __phones[1].emit('command',{type:'button',button:'2',pressed:false}));
  await page.evaluate(() => __phones[3].disconnect());
  await page.waitForFunction(() => __kart.paused,null,{timeout:10000});
  await page.evaluate(() => {
    const socket = io({transports:['websocket']});
    socket.on('connect', () => socket.emit('register',{role:'controller',identity:'four-player-review-3'}));
    __phones[3] = socket;
  });
  await page.waitForFunction(() => __phones[3].connected &&
    document.getElementById('connection').textContent.includes('P4 CONNECTED'),null,{timeout:10000});
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !__kart.paused,null,{timeout:10000});
  await page.evaluate(() => __phones[2].emit('command',{type:'recentre'}));
  await page.waitForFunction(() => __kart.paused,null,{timeout:10000});
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !__kart.paused,null,{timeout:10000});
  await page.evaluate(() => {
    const race = __kart.race;
    for (const racer of race.racers) racer.finishTime = race.raceTime + racer.id * .01;
  });
  await page.waitForFunction(() => __kart.race.state === 'results',null,{timeout:10000});
  await page.waitForFunction(() => !document.getElementById('results').hidden,null,{timeout:10000});
  assert.equal((await page.textContent('#result-summary')).match(/P[1-4] /g)?.length,4);
  await page.screenshot({path:fileURLToPath(new URL('results.png',out))});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,labels:labels.map(label => label.playerLabel),
    graphics:await page.evaluate(() => __kart.graphics),checks:['duo keyboard option cannot bypass quad P2','four ready gates','distinct driver choice','four view HUD','isolated P2/P4 gas','disconnect pause','same identity reconnect','per-player recenter pause','four human results']},null,2));
  await page.evaluate(() => {clearInterval(__phoneTimer);for (const socket of __phones) socket.disconnect();});
} finally { await browser.close(); }
