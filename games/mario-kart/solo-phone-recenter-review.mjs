/** Regression: recenter must reacquire the solo phone after startup expires. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
  await page.goto(`${process.env.KART_URL||'https://localhost:8443'}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:90000});
  await page.evaluate(()=>{
    window.__phone=io({transports:['websocket']});
    __phone.on('connect',()=>__phone.emit('register',{role:'controller',identity:'simulated-phone-0-stable-local-test'}));
    window.__phoneTimer=setInterval(()=>__phone.emit('orientation',{quat:[.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587]}),16);
  });
  await page.waitForFunction(()=>__kart.wheel.armed);
  await page.keyboard.press('Enter');
  await page.click('[data-laps="1"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>__kart.race.state==='racing' && __kart.race.time>7,null,{timeout:30000});
  for(const trigger of ['phone','keyboard']) {
    if(trigger==='phone') await page.evaluate(()=>__phone.emit('command',{type:'recentre'}));
    else await page.keyboard.press('KeyR');
    await page.waitForFunction(()=>__kart.paused);
    await page.waitForFunction(()=>__kart.wheel.ref && __kart.wheel.armed,null,{timeout:10000});
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>__kart.paused),false,`${trigger} recenter resumes`);
  }
  await page.evaluate(()=>{clearInterval(__phoneTimer);__phone.disconnect();});
  console.log(JSON.stringify({passed:true,checks:['phone recenter after startup','keyboard recenter after startup']}));
} finally {await browser.close();}
