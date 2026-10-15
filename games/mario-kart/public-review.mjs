/** Public-distribution check: bundled runtime pack, or --fallback without it. Drive a full
 * one-lap race with real keyboard events; never write player/simulation state. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const base=process.env.KART_URL||'https://localhost:8443';
const fallback=process.argv.includes('--fallback');
const out=new URL(fallback?'./evidence/public-fallback/':'./evidence/public-release/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={at:new Date().toISOString(),mode:fallback?'fallback':'bundled',method:'Actual keyboard events and a geometric path follower. Read-only race inspection. No simulation state writes. Not a physical-phone test.',checks:[],errors:[]};
try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
  if(fallback)await context.route(/\/(assets|audio)\//,route=>route.fulfill({status:404,body:'Runtime pack deliberately unavailable for fallback verification'}));
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  const games=await (await context.request.get(base+'/api/games')).json();
  assert.equal(games[0].slug,'mario-kart');
  const pairing=await (await context.request.get(base+'/api/pairing')).json();assert.ok(pairing.url.endsWith('/controller')&&pairing.qr.startsWith('data:image/png'));
  await page.goto(base+'/games/mario-kart/?evidence=1');await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:60000});
  assert.equal(await page.evaluate(()=>__kart.sourceCourse),!fallback);
  assert.equal(await page.evaluate(()=>__kart.assets.loaded),fallback?0:8);
  assert.equal(await page.evaluate(source=>__kart.karts.filter(k=>k.source===source).length,fallback?'procedural':'glb'),8);
  if(!fallback){
    const manifest=await (await context.request.get(base+'/assets/mario-kart/manifest.json')).json();
    const audio=await (await context.request.get(base+'/assets/mario-kart/audio/manifest.json')).json();
    report.assets={manifest,cues:Object.keys(audio.cues).length};
    await page.evaluate(async()=>Promise.all(['KartMessage','KartCounter'].map(font=>document.fonts.load('16px '+font))));
    assert.ok(await page.evaluate(()=>['KartMessage','KartCounter'].every(name=>[...document.fonts].some(font=>font.family===name&&font.status==='loaded'))),'Both bundled fonts loaded');
    for(const file of ['ui/driver-icons.png',manifest.course.tvBrand.image]){
      assert.ok((await context.request.get(base+'/assets/mario-kart/'+file)).ok(),file);
    }
  }
  assert.equal(await page.locator('.character').count(),8);
  await page.screenshot({path:fileURLToPath(new URL('menu.png',out))});
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#chosen').textContent(),'Luigi');
  await page.keyboard.press('Enter');await page.locator('[data-laps="1"]').click();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>__kart.race.state==='countdown');
  await page.waitForFunction(()=>__kart.race.state==='racing');
  assert.equal(await page.evaluate(()=>__kart.race.laps),1);
  await page.keyboard.down('KeyZ');await page.waitForFunction(()=>__kart.race.player.speed>10);await page.keyboard.up('KeyZ');
  const speed=await page.evaluate(()=>__kart.race.player.speed);
  await page.keyboard.down('KeyX');await page.waitForTimeout(300);await page.keyboard.up('KeyX');assert.ok(await page.evaluate(()=>__kart.race.player.speed)<speed);
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>__kart.paused),true);
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>__kart.paused),false);
  assert.equal(await page.evaluate(()=>__kart.audioState.samples.ready),!fallback);
  if(!fallback){
    const samples=await page.evaluate(()=>__kart.audioState.samples);
    assert.equal(samples.loaded,report.assets.cues,'Every referenced audio cue decoded');
    assert.deepEqual(samples.failures,[]);report.assets.decodedCues=samples.loaded;
  }
  await page.waitForFunction(()=>__kart.audioState.state==='running');
  await page.click('#mute');assert.equal(await page.evaluate(()=>__kart.audioState.enabled),false);
  await page.click('#mute');assert.equal(await page.evaluate(()=>__kart.audioState.enabled),true);
  report.checks.push('launcher order and pairing QR',fallback?'eight procedural racers and generated track':'eight source racers, original course, UI fonts and artwork','driver and lap selection','countdown, acceleration and braking','pause and resume',fallback?'synth audio and mute without sample pack':'complete sample pack decoded, audio and mute');
  await page.evaluate(async()=>window.geometry=await import('./track.js'));
  const firstRaceFrame=await page.evaluate(()=>__kart.frameTimes.length);
  await page.keyboard.down('KeyZ');let direction=0,seenAnti=false,seenGlider=false;const start=Date.now();
  while(Date.now()-start<180000){
    const state=await page.evaluate(()=>{const r=__kart.race.player;return {state:__kart.race.state,x:r.x,z:r.z,heading:r.heading,anti:r.anti,gliding:r.gliding,target:geometry.surfaceAt(r.s+Math.max(12,r.speed*.48),0)};});
    if(state.state==='results')break;
    seenAnti ||= !!state.anti;seenGlider ||= !!state.gliding;
    const target=Math.atan2(state.target.x-state.x,-(state.target.z-state.z)),error=Math.atan2(Math.sin(target-state.heading),Math.cos(target-state.heading));
    const next=error>.045?1:error<-.045?-1:0;
    if(next!==direction){if(direction)await page.keyboard.up(direction>0?'ArrowRight':'ArrowLeft');if(next)await page.keyboard.down(next>0?'ArrowRight':'ArrowLeft');direction=next;}
    await page.waitForTimeout(45);
  }
  await page.keyboard.up('KeyZ');if(direction)await page.keyboard.up(direction>0?'ArrowRight':'ArrowLeft');
  assert.equal(await page.evaluate(()=>__kart.race.state),'results','Complete one lap through normal input');
  report.performance=await page.evaluate(first=>{
    const frames=__kart.frameTimes.slice(first).sort((a,b)=>a-b);
    return {averageFPS:1000/(frames.reduce((a,b)=>a+b,0)/frames.length),p95ms:frames[Math.floor(frames.length*.95)],frames:frames.length,graphics:__kart.graphics};
  },firstRaceFrame);
  await page.waitForFunction(()=>!document.getElementById('results').hidden&&!document.getElementById('again').disabled,null,{timeout:20000});
  assert.ok(seenAnti&&seenGlider,'Race traverses antigravity and gliding');
  assert.equal(await page.locator('#standings').evaluate(el=>el.children.length),8);
  report.raceSeconds=(Date.now()-start)/1000;report.checks.push('full keyboard race through antigravity and gliding','finish sound transition and eight-row results');
  await page.screenshot({path:fileURLToPath(new URL('results.png',out))});
  await page.click('#again');await page.waitForFunction(()=>__kart.race.state==='countdown');report.checks.push('race again');
  assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify(report,null,2));
}finally{await writeFile(new URL('report.json',out),JSON.stringify(report,null,2)+'\n');await browser.close();}
