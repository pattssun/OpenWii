/** Four-view runtime and graphics probe using four simulated Socket.IO phones. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.KART_URL || 'https://localhost:9453';
const out = new URL('./evidence/four-player/experiments/', import.meta.url);
const sampleMs = Number(process.env.KART_SAMPLE_MS || 10000);
await mkdir(out, {recursive:true});
const report = {date:new Date().toISOString(), base, viewport:{width:1920,height:1080},
  deviceScaleFactor:1, preset:'medium', sampleMs,
  method:'Headless Chrome on bundled stadium; four Socket.IO clients emit live orientation and gas, with no physical phones. Presented frame intervals while the shared race advances.',
  errors:[], checks:[]};
const browser = await chromium.launch({channel:'chrome',headless:true,
  args:['--autoplay-policy=no-user-gesture-required']});
try {
  const page = await browser.newPage({ignoreHTTPSErrors:true,viewport:report.viewport,deviceScaleFactor:1});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error' && /WebGL|GL_INVALID|FRAMEBUFFER|shader/i.test(m.text()))report.errors.push(m.text());});
  await page.goto(`${base}/games/mario-kart/?evidence=1`);
  await page.waitForFunction(()=>window.__kart?.assets,null,{timeout:90000});
  assert.equal(await page.evaluate(()=>__kart.sourceCourse),true);
  await page.click('#graphics-panel summary');
  await page.selectOption('#graphics-quality','medium');
  await page.click('[data-mode="quad"]');
  await page.screenshot({path:fileURLToPath(new URL('lobby.png',out))});
  await page.evaluate(()=>{
    const quat=[.061628416716219346,.061628416716219346,-.7044160264027587,.7044160264027587];
    window.__probePhones=Array.from({length:4},(_,i)=>{
      const socket=io({transports:['websocket']});
      socket.on('connect',()=>socket.emit('register',{role:'controller',identity:`four-player-performance-${i}`}));
      return socket;
    });
    window.__probeTimer=setInterval(()=>__probePhones.forEach(socket=>socket.emit('orientation',{quat})),16);
  });
  await page.waitForFunction(()=>[0,1,2,3].every(i=>document.getElementById(`duo-state-${i}`).textContent==='Press 2 to ready'),null,{timeout:30000});
  for(let i=0;i<4;i++) {
    await page.evaluate(i=>__probePhones[i].emit('command',{type:'button',button:'2',pressed:true}),i);
    if(i<3)await page.waitForFunction(i=>document.getElementById(`duo-state-${i}`).textContent==='READY',i,{timeout:10000});
  }
  await page.waitForFunction(()=>__kart.race.state==='racing',null,{timeout:60000}).catch(async e=>{
    report.readyDiagnostic=await page.evaluate(()=>({state:__kart.race.state,
      statuses:[0,1,2,3].map(i=>document.getElementById(`duo-state-${i}`).textContent),
      connection:document.getElementById('connection').textContent}));
    throw e;
  });
  await page.evaluate(()=>{window.__gasTimer=setInterval(()=>__probePhones.forEach(socket=>socket.emit('command',{type:'buttons',buttons:{2:true}})),100);});
  await page.waitForTimeout(1500);
  const before=await page.evaluate(()=>({count:__kart.frameTimes.length,time:__kart.race.time,
    progress:__kart.race.players.slice(0,4).map(p=>p.s)}));
  const start=performance.now();
  await page.waitForTimeout(sampleMs);
  report.wallMs=performance.now()-start;
  report.benchmark=await page.evaluate(before=>{
    const frames=__kart.frameTimes.slice(before.count).filter(ms=>ms>0&&ms<1000).sort((a,b)=>a-b);
    const sum=frames.reduce((a,b)=>a+b,0);
    const canvas=document.getElementById('game'),gl=canvas.getContext('webgl2');
    const ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {frames:frames.length,fps:frames.length*1000/sum,meanMs:sum/frames.length,
      p95Ms:frames[Math.floor((frames.length-1)*.95)],p99Ms:frames[Math.floor((frames.length-1)*.99)],
      maxMs:frames.at(-1),elapsedRaceSeconds:__kart.race.time-before.time,
      progressBefore:before.progress,progressAfter:__kart.race.players.slice(0,4).map(p=>p.s),
      state:__kart.race.state,paused:__kart.paused,graphics:__kart.graphics,
      renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      drawingBuffer:[canvas.width,canvas.height],stats:__kart.stats,
      hud:[0,1,2,3].map(i=>({name:document.getElementById(`duo-name-${i}`).textContent,
        speed:document.getElementById(`duo-speed-${i}`).textContent,
        lap:document.getElementById(`duo-lap-${i}`).textContent,
        rank:document.getElementById(`duo-rank-${i}`).textContent}))};
  },before);
  assert.ok(report.benchmark.frames>60,'Presented frames');
  assert.ok(report.benchmark.elapsedRaceSeconds>1,'Race advances');
  assert.equal(report.benchmark.state,'racing');
  assert.equal(report.benchmark.paused,false);
  await page.screenshot({path:fileURLToPath(new URL('race-balanced.png',out))});
  // Capture the four lower-half road/kart regions in WebGL's bottom-left coordinate system.
  for(const quality of ['medium','low','medium']) {
    await page.selectOption('#graphics-quality',quality);
    await page.waitForTimeout(800);
    const metrics=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
      const canvas=document.getElementById('game'),gl=canvas.getContext('webgl2');
      const pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const coverage=[0,1,2,3].map(slot=>{
        const col=slot%2,row=slot<2?1:0;let bright=0,total=0;
        for(let y=Math.floor(canvas.height*(row*.5+.05));y<canvas.height*(row*.5+.20);y+=8)
          for(let x=Math.floor(canvas.width*(col*.5+.125));x<canvas.width*(col*.5+.375);x+=8){
            const k=(y*canvas.width+x)*4;
            if((pixels[k]+pixels[k+1]+pixels[k+2])/3>45)bright++;
            total++;
          }
        return bright/total;
      });
      resolve({coverage,size:[canvas.width,canvas.height],graphics:__kart.graphics,
        hud:[0,1,2,3].map(i=>{
          const el=document.getElementById(`duo-hud-${i}`),s=getComputedStyle(el);
          return {border:s.borderTopColor,borderWidth:s.borderTopWidth,
            rankSvg:!!document.querySelector(`#duo-rank-${i} > svg.race-lettering`),
            lapFont:getComputedStyle(document.getElementById(`duo-lap-${i}`)).fontFamily,
            coins:getComputedStyle(document.getElementById(`duo-coins-${i}`)).color,
            bounds:el.getBoundingClientRect().toJSON()};
        })});
    })));
    report.checks.push({quality,...metrics});
    if(quality==='low')await page.screenshot({path:fileURLToPath(new URL('race-performance.png',out))});
    assert.ok(metrics.coverage.every(c=>c>.3),`${quality}: four scenes visibly populated: ${metrics.coverage}`);
    assert.deepEqual(metrics.hud.map(h=>h.border),['rgb(255, 82, 103)','rgb(94, 170, 255)','rgb(99, 217, 120)','rgb(255, 224, 103)']);
    assert.ok(metrics.hud.every(h=>h.rankSvg&&/KartCounter/.test(h.lapFont)));
  }
  await page.setViewportSize({width:1919,height:1079});
  await page.selectOption('#graphics-quality','low');
  await page.waitForTimeout(1000);
  report.oddSize=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
    const canvas=document.getElementById('game'),gl=canvas.getContext('webgl2');
    const pixels=new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const bands=[];
    for(const axis of ['vertical','horizontal']){
      const center=Math.floor((axis==='vertical'?canvas.width:canvas.height)/2);
      for(let offset=-3;offset<=3;offset++){
        let black=0,total=0,lum=0;
        for(let t=0;t<(axis==='vertical'?canvas.height:canvas.width);t+=4){
          const x=axis==='vertical'?center+offset:t,y=axis==='vertical'?t:center+offset;
          if(x<0||y<0||x>=canvas.width||y>=canvas.height)continue;
          const i=(y*canvas.width+x)*4,v=(pixels[i]+pixels[i+1]+pixels[i+2])/3;
          if(v<5)black++;
          lum+=v;total++;
        }
        bands.push({axis,offset,blackFraction:black/total,meanLuma:lum/total});
      }
    }
    resolve({css:[innerWidth,innerHeight],buffer:[canvas.width,canvas.height],bands});
  })));
  await page.screenshot({path:fileURLToPath(new URL('odd-performance.png',out))});
  assert.deepEqual(report.errors,[]);
  report.passed=true;
  await page.evaluate(()=>{clearInterval(__probeTimer);clearInterval(__gasTimer);__probePhones.forEach(s=>s.disconnect());});
}catch(e){report.passed=false;report.failure=e.stack||String(e);throw e;}
finally{await writeFile(new URL('report.json',out),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));await browser.close();}
