import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY, renderScale, loadQuality, performanceMeter } from './graphics.js';

test('render resolution stays within each preset budget at fullscreen and high DPI', () => {
  for (const quality of Object.values(QUALITY)) {
    for (const [width, height, dpr] of [[3840,2160,2], [1920,1080,1.5], [1280,720,1]]) {
      const scale = renderScale(width,height,dpr,quality);
      assert.ok(width * height * scale ** 2 <= quality.pixels + 1);
      assert.ok(scale <= dpr && scale <= quality.pixelRatio);
    }
  }
});
test('untrusted or unavailable graphics preferences fall back to Balanced', () => {
  assert.equal(loadQuality({getItem:()=> 'high'}), 'high');
  for (const value of ['toString','__proto__','invalid',null])
    assert.equal(loadQuality({getItem:()=> value}), 'medium');
  assert.equal(loadQuality({getItem:()=> {throw new Error('blocked')}}), 'medium');
});
test('FPS uses elapsed frame time and discards background tab gaps', () => {
  const readings=[], update=performanceMeter(value=>readings.push(value));
  for(let i=0;i<=60;i++) update(100+i*1000/60);
  assert.ok(readings.length >= 1);
  assert.equal(readings[0].fps,60);
  update(10000);
  const count=readings.length;
  update(10016);
  assert.equal(readings.length,count);
});
