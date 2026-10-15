/** One simulated phone through the relay; keyboard drives the other three humans. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL('./evidence/one-phone-four-player/', import.meta.url);
await mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
  const page = await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto(`${process.env.KART_URL || 'https://localhost:8443'}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:90000});
  await page.click('[data-mode="quad"]');
  assert.equal(await page.isChecked('#quad-keyboard-test'),false);
  await page.check('#quad-keyboard-test');
  await page.click('#quad-ready-all');
  assert.equal(await page.evaluate(()=>__kart.race.state),'ready','Missing P1 cannot start');
  await page.uncheck('#quad-keyboard-test');
  for(let slot=1;slot<4;slot++) assert.equal(await page.textContent(`#duo-state-${slot}`),'Connect phone');
  await page.check('#quad-keyboard-test');
  const drivers=await page.locator('.duo-choice b').allTextContents();
  await page.click('[data-keyboard-slot="2"]');
  await page.keyboard.press('ArrowRight');
  const changed=await page.locator('.duo-choice b').allTextContents();
  assert.notEqual(changed[2],drivers[2]);
  assert.deepEqual([changed[0],changed[1],changed[3]],[drivers[0],drivers[1],drivers[3]]);
  assert.equal(new Set(changed).size,4);
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('#duo-state-2'),/READY/);
  await page.keyboard.press('x');
  assert.doesNotMatch(await page.textContent('#duo-state-2'),/^READY/);
  await page.evaluate(()=>{
    const socket=window.__onePhone=io({transports:['websocket']});
    socket.on('connect',()=>socket.emit('register',{role:'controller',identity:'one-phone-quad-test-player-1'}));
    window.__phoneTimer=setInterval(()=>socket.emit('orientation',{quat:[.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587]}),16);
  });
  await page.waitForFunction(()=>document.getElementById('duo-state-0').textContent==='Press 2 to ready',null,{timeout:20000});
  await page.screenshot({path:fileURLToPath(new URL('lobby.png',out))});
  await page.click('#quad-ready-all');
  assert.equal(await page.evaluate(()=>__kart.race.state),'ready','P1 still needs own ready confirmation');
  await page.evaluate(()=>{
    __onePhone.emit('command',{type:'button',button:'2',pressed:true});
    __onePhone.emit('command',{type:'button-up',button:'2'});
  });
  await page.waitForFunction(()=>__kart.race.state==='racing',null,{timeout:30000});
  assert.equal(await page.locator('.duo-player:visible').count(),4);
  for(const slot of [1,2,3]) {
    await page.click(`[data-keyboard-slot="${slot}"]`);
    await page.keyboard.down('z');
    await page.waitForFunction(slot=>__kart.race.players[slot].lastInput.gas,slot);
    assert.deepEqual(await page.evaluate(()=>__kart.race.players.map(p=>p.lastInput.gas)),[false,slot===1,slot===2,slot===3]);
    await page.keyboard.up('z');
    await page.waitForFunction(()=>__kart.race.players.every(p=>!p.lastInput.gas));
  }
  await page.click('[data-keyboard-slot="2"]');
  await page.keyboard.down('z');
  await page.waitForFunction(()=>__kart.race.players[2].lastInput.gas);
  await page.click('[data-keyboard-slot="3"]');
  await page.waitForFunction(()=>__kart.race.players.every(p=>!p.lastInput.gas));
  await page.keyboard.up('z');
  // Scenario setup supplies held items; the real keyboard event exercises routing.
  await page.evaluate(()=>__kart.race.players.forEach(p=>{p.item='mushroom';p.roulette=0;}));
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>__kart.race.players[3].item===null);
  assert.deepEqual(await page.evaluate(()=>__kart.race.players.slice(0,3).map(p=>p.item)),['mushroom','mushroom','mushroom']);
  await page.evaluate(()=>__onePhone.emit('command',{type:'buttons',buttons:{2:true}}));
  await page.waitForFunction(()=>__kart.race.players[0].lastInput.gas);
  assert.equal(await page.evaluate(()=>__kart.race.players.slice(1).some(p=>p.lastInput.gas)),false);
  await page.screenshot({path:fileURLToPath(new URL('race.png',out))});
  await page.evaluate(()=>__onePhone.disconnect());
  await page.waitForFunction(()=>__kart.paused);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>__kart.paused),true,'Keyboard slots cannot bypass lost P1');
  await page.evaluate(()=>__onePhone.connect());
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!__kart.paused,null,{timeout:10000});
  assert.deepEqual(errors,[]);
  console.log('PASS: opt-in gates, P1 readiness, local driver/ready controls, P2/P3/P4 isolated gas, switch release, P4 item, P1 phone controls and disconnect/reconnect safety.');
  await page.evaluate(()=>{clearInterval(__phoneTimer);__onePhone.disconnect();});
} finally {await browser.close();}
