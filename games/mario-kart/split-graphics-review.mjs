/** Fractional-resolution split-screen visual regression on the bundled track. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out=new URL('./evidence/split-graphics/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={checks:[],errors:[]};
async function sceneCoverage(page, views) {
  return page.evaluate(views=>new Promise(resolve=>requestAnimationFrame(()=>{
    const canvas=document.getElementById('game'), gl=canvas.getContext('webgl2');
    const pixels=new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    resolve(Array.from({length:views},(_,view)=>{
      let bright=0,total=0;
      // Road/kart region below the horizon, independent of DOM HUD overlays.
      for(let y=Math.floor(canvas.height*.1);y<canvas.height*.4;y+=8)
        for(let x=Math.floor(canvas.width*(view+.25)/views);x<canvas.width*(view+.75)/views;x+=8){
          const i=(y*canvas.width+x)*4;
          if((pixels[i]+pixels[i+1]+pixels[i+2])/3>45)bright++;
          total++;
        }
      return bright/total;
    }));
  })),views);
}
try {
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1920,height:1080},deviceScaleFactor:1.5});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error' && /WebGL|GL_INVALID|FRAMEBUFFER|shader/i.test(m.text()))report.errors.push(m.text());});
  await page.goto(`${process.env.KART_URL||'https://localhost:8443'}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:90000});
  assert.equal(await page.evaluate(()=>__kart.sourceCourse),true);
  await page.locator('#graphics-panel summary').click();
  for(const quality of ['medium','low','medium']) {
    await page.selectOption('#graphics-quality',quality);
    await page.waitForTimeout(1000);
    const coverage=await sceneCoverage(page,1);
    assert.ok(coverage[0]>.3,`Solo ${quality}: track/kart region must remain visible (${coverage})`);
    report.checks.push({mode:'solo',quality,coverage});
    if(quality==='low')await page.screenshot({path:fileURLToPath(new URL('solo-performance.png',out)),scale:'css'});
  }
  await page.click('[data-mode="duo"]');
  await page.check('#keyboard-test');
  await page.evaluate(()=>{
    const socket=window.__phone=io({transports:['websocket']});
    socket.on('connect',()=>socket.emit('register',{role:'controller',identity:'split-graphics-phone-stable-identity'}));
    window.__timer=setInterval(()=>socket.emit('orientation',{quat:[.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587]}),16);
  });
  await page.waitForFunction(()=>document.getElementById('duo-state-0').textContent==='Press 2 to ready',null,{timeout:20000});
  await page.keyboard.press('Enter');
  await page.evaluate(()=>{__phone.emit('command',{type:'button',button:'2',pressed:true});__phone.emit('command',{type:'button-up',button:'2'});});
  await page.waitForFunction(()=>__kart.race.state==='racing',null,{timeout:30000});
  await page.evaluate(()=>{__kart.freeze=true;});
  for(const quality of ['medium','low','high','low','medium']) {
    await page.selectOption('#graphics-quality',quality);
    await page.waitForTimeout(800);
    await page.screenshot({path:fileURLToPath(new URL(`duo-${quality}.png`,out)),scale:'css'});
    const coverage=await sceneCoverage(page,2);
    assert.ok(coverage.every(value=>value>.3),`Both ${quality} viewports must show track/karts (${coverage})`);
    for(const [i,color] of ['rgb(255, 82, 103)','rgb(94, 170, 255)'].entries()) {
      assert.equal(await page.locator(`#duo-hud-${i}`).evaluate(el=>getComputedStyle(el).borderTopColor),color);
      assert.equal(await page.locator(`#duo-rank-${i} > svg.race-lettering`).count(),1);
      assert.match(await page.locator(`#duo-lap-${i}`).evaluate(el=>getComputedStyle(el).fontFamily),/KartCounter/);
      assert.equal(await page.locator(`#duo-coins-${i}`).evaluate(el=>getComputedStyle(el).color),'rgb(255, 207, 36)');
    }
    report.checks.push(await page.evaluate(quality=>({quality,graphics:__kart.graphics,stats:__kart.stats,
      size:[document.getElementById('game').width,document.getElementById('game').height],
      borders:[0,1].map(i=>{const s=getComputedStyle(document.getElementById(`duo-hud-${i}`));return {color:s.borderTopColor,width:s.borderTopWidth};}),
    }),quality));
    report.checks.at(-1).coverage=coverage;
  }
  await page.evaluate(()=>{clearInterval(__timer);__phone.disconnect();});
  assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report,null,2));
} finally {await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));await browser.close();}
