/** HUD scenarios use the real one-phone lobby, then stage item state for captures. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out=new URL('./evidence/multiplayer-hud/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
 for(const mode of ['duo','quad']) {
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.KART_URL||'https://localhost:8443'}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:90000});
  if(mode==='quad') assert.equal(await page.inputValue('#lap-count'),'8','Lap preference persists across loads');
  await page.fill('#lap-count','7');
  await page.locator('#lap-count').blur();
  await page.click('#lap-increase');
  assert.equal(await page.inputValue('#lap-count'),'8');
  await page.click(`[data-mode="${mode}"]`);
  await page.check(mode==='quad'?'#quad-keyboard-test':'#keyboard-test');
  await page.evaluate(()=>{
   const phone=window.__phone=io({transports:['websocket']});
   phone.on('connect',()=>phone.emit('register',{role:'controller',identity:'multiplayer-hud-review-phone'}));
   window.__timer=setInterval(()=>phone.emit('orientation',{quat:[.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587]}),16);
  });
  await page.waitForFunction(()=>document.getElementById('duo-state-0').textContent==='Press 2 to ready',null,{timeout:20000});
  await page.screenshot({path:fileURLToPath(new URL(`${mode}-lobby.png`,out))});
  if(mode==='quad') await page.click('#quad-ready-all');
  else await page.keyboard.press('Enter');
  await page.evaluate(()=>{__phone.emit('command',{type:'button',button:'2',pressed:true});__phone.emit('command',{type:'button-up',button:'2'});});
  await page.waitForFunction(()=>__kart.race.state==='racing',null,{timeout:30000});
  assert.equal(await page.evaluate(()=>__kart.race.laps),8);
  const count=mode==='quad'?4:2;
  assert.equal(await page.isVisible('#minimap'),false,'The solo map stays hidden in split screen');
  assert.equal(await page.locator('.duo-player:visible .player-minimap:visible').count(),count);
  for(let slot=0;slot<count;slot++) {
   const map=await page.locator(`#player-minimap-${slot}`).boundingBox();
   const viewport=await page.locator(`#duo-hud-${slot}`).boundingBox();
   assert.ok(map.width<=170 && map.height<=150);
   assert.ok(map.x>=viewport.x && map.y>=viewport.y && map.x+map.width<=viewport.x+viewport.width && map.y+map.height<=viewport.y+viewport.height,`P${slot+1} map stays inside its own view`);
   const mapPixels=await page.locator(`#player-minimap-${slot}`).evaluate(c=>{
    const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    return Array.from(pixels).filter((v,i)=>i%4===3 && v>0).length;
   });
   assert.ok(mapPixels>500,`P${slot+1} map contains track/marker pixels`);
  }
  // Freeze only the simulation; the HUD still draws from controlled scenario times.
  await page.evaluate(()=>{__kart.freeze=true;__kart.race.time=Math.max(5,__kart.race.time);__kart.race.players.forEach(p=>{p.item=null;p.roulette=1;});});
  await page.waitForFunction(count=>Array.from({length:count},(_,i)=>document.querySelector(`#duo-item-${i} .rolling`)).every(Boolean),count);
  const before=await page.locator('#duo-item-0 .item-reel').getAttribute('style');
  await page.evaluate(()=>{__kart.race.time+=.1;});
  await page.waitForFunction(before=>document.querySelector('#duo-item-0 .item-reel').getAttribute('style')!==before,before);
  await page.screenshot({path:fileURLToPath(new URL(`${mode}-roulette.png`,out))});
  await page.evaluate(()=>{__kart.race.players.forEach((p,i)=>{p.roulette=0;p.item=['mushroom','red','banana','star'][i];});__kart.race.time+=.1;});
  await page.waitForTimeout(100);
  await page.evaluate(()=>{__kart.race.time+=.3;});
  await page.waitForFunction(count=>Array.from({length:count},(_,i)=>document.querySelector(`#duo-item-${i} .split-item-icon:not(.rolling)>img, #duo-item-${i} .split-item-icon:not(.rolling)>svg`)).every(Boolean),count);
  const overlappingHud=await page.evaluate(()=>{
   return [...document.querySelectorAll('.duo-player:not([hidden])')].flatMap(card=>{
    const map=card.querySelector('.player-minimap').getBoundingClientRect();
    return [...card.querySelectorAll('header,.duo-rank,.duo-info,.duo-item')].filter(el=>{
     const box=el.getBoundingClientRect();return map.left<box.right&&map.right>box.left&&map.top<box.bottom&&map.bottom>box.top;
    }).map(el=>el.id||el.className);
   });
  });
  assert.deepEqual(overlappingHud,[],'Each compact map clears its player HUD');
  for(let i=0;i<count;i++) {
   assert.doesNotMatch(await page.textContent(`#duo-item-${i}`),/ROULETTE|NO ITEM/);
   const frame=await page.locator(`#duo-item-${i}`).boundingBox(),header=await page.locator(`#duo-hud-${i} header`).boundingBox();
   assert.ok(frame.y>=header.y+header.height,`P${i+1} item clears its player label`);
   assert.match(await page.getAttribute(`#duo-item-${i}`,'aria-label'),new RegExp(['mushroom','red','banana','star'][i]));
  }
  await page.screenshot({path:fileURLToPath(new URL(`${mode}-items.png`,out))});
  // One player's new roulette must not replace another player's held icon.
  await page.evaluate(()=>{__kart.race.players[0].item=null;__kart.race.players[0].roulette=1;__kart.race.time+=.1;});
  await page.waitForFunction(()=>document.querySelector('#duo-item-0 .rolling'));
  assert.equal(await page.locator('#duo-item-1 .rolling').count(),0);
  await page.evaluate(()=>{__kart.race.players[0].roulette=0;__kart.race.players[0].item=null;__kart.race.time+=.1;});
  await page.waitForFunction(()=>document.getElementById('duo-item-0').classList.contains('empty'));
  assert.deepEqual(errors,[]);
  console.log(`PASS ${mode}: custom laps, compact rendered map, animated independent item reels/icons, empty state and HUD bounds`);
  await page.evaluate(()=>{clearInterval(__timer);__phone.disconnect();});
  await page.close();
 }
 await context.close();
} finally {await browser.close();}
