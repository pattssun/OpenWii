import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Sketch, TOOLBAR, pickTool, strokeMaxStep, COLORS, SIZES, ERASER_SIZE,
} from './logic.js';

// D1 — a fast swing yields one unbroken polyline: every input point is kept,
// consecutive segments share endpoints, and total path length is preserved.
test('D1: a fast swing paints a continuous stroke with no gaps', () => {
  const s = new Sketch({});
  // Three samples crossing most of the screen in two frames: a violent swing.
  const path = [
    { x: 0.10, y: 0.85 }, { x: 0.48, y: 0.50 }, { x: 0.90, y: 0.80 },
  ];
  s.penDown(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i += 1) s.penMove(path[i].x, path[i].y);
  s.penUp();

  assert.equal(s.strokes.length, 1);
  const stroke = s.strokes[0];
  assert.deepEqual(stroke.points, path, 'no sample is dropped');

  // Independent path length from the raw input:
  let want = 0;
  for (let i = 1; i < path.length; i += 1) {
    want += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  let got = 0;
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    got += Math.hypot(b.x - a.x, b.y - a.y);
  }
  assert.ok(Math.abs(got - want) < 1e-12, 'full path length is drawn');
  // The polyline is gapless by construction: segment i ends where i+1 begins.
  // strokeMaxStep only measures sampling stride, never a rendering gap.
  assert.ok(strokeMaxStep(stroke) > 0.4, 'this really was a fast swing');
});

test('D1: a tap still leaves a visible dot', () => {
  const s = new Sketch({});
  s.penDown(0.5, 0.5);
  s.penUp();
  assert.equal(s.strokes[0].points.length, 2, 'degenerate segment renders a dot');
});

// D2 — the toolbar: geometry, and every tool takes effect.
test('D2: the toolbar offers 10 colors, 3 sizes, eraser and clear', () => {
  assert.equal(COLORS.length, 10);
  assert.equal(SIZES.length, 3);
  assert.equal(TOOLBAR.filter((e) => e.kind === 'color').length, 10);
  assert.equal(TOOLBAR.filter((e) => e.kind === 'size').length, 3);
  assert.equal(TOOLBAR.filter((e) => e.kind === 'eraser').length, 1);
  assert.equal(TOOLBAR.filter((e) => e.kind === 'clear').length, 1);
  // No two buttons overlap, and all sit in the left strip.
  for (const e of TOOLBAR) {
    assert.ok(e.rect.x + e.rect.w < 0.08, 'toolbar stays out of the paper');
    assert.ok(e.rect.y >= 0 && e.rect.y + e.rect.h <= 1, 'buttons stay on screen');
    for (const o of TOOLBAR) {
      if (o === e) continue;
      const apart = e.rect.y + e.rect.h <= o.rect.y || o.rect.y + o.rect.h <= e.rect.y;
      assert.ok(apart, 'buttons do not overlap');
    }
  }
});

test('D2: pointing at each button picks exactly that tool', () => {
  for (const e of TOOLBAR) {
    const cx = e.rect.x + e.rect.w / 2;
    const cy = e.rect.y + e.rect.h / 2;
    assert.equal(pickTool(cx, cy), e);
  }
  assert.equal(pickTool(0.5, 0.5), null, 'the paper is not a tool');
  const first = TOOLBAR[0];
  assert.equal(pickTool(first.rect.x - 1e-4, first.rect.y + 0.01), null, 'edges are exact');
});

test('D2: color, size, eraser and clear all take effect', () => {
  const s = new Sketch({});
  s.penDown(0.5, 0.5); s.penMove(0.6, 0.5); s.penUp();

  const red = TOOLBAR.find((e) => e.kind === 'color' && e.value === COLORS[1]);
  s.applyTool(red);
  assert.equal(s.color, COLORS[1]);

  const big = TOOLBAR.find((e) => e.kind === 'size' && e.value === 2);
  s.applyTool(big);
  assert.equal(s.brushSize, SIZES[2]);

  s.applyTool(TOOLBAR.find((e) => e.kind === 'eraser'));
  assert.equal(s.eraser, true);
  assert.equal(s.brushSize, ERASER_SIZE);
  s.penDown(0.3, 0.6); s.penMove(0.4, 0.6); s.penUp();
  assert.equal(s.strokes[1].erase, true, 'eraser strokes are marked');

  // Picking any colour puts the pen back down.
  s.applyTool(red);
  assert.equal(s.eraser, false);

  s.applyTool(TOOLBAR.find((e) => e.kind === 'clear'));
  assert.equal(s.strokes.length, 0);
});

test('D2: pressing A over the toolbar operates it and never paints', () => {
  const s = new Sketch({});
  const button = TOOLBAR.find((e) => e.kind === 'color' && e.value === COLORS[3]);
  const res = s.penDown(button.rect.x + 0.01, button.rect.y + 0.01);
  assert.ok(res.tool);
  assert.equal(s.strokes.length, 0, 'no stroke started on the toolbar');
  assert.equal(s.color, COLORS[3]);
});

// D3 — releasing A lifts the brush; strokes persist until clear.
test('D3: release lifts the pen, the next press starts a fresh stroke', () => {
  const s = new Sketch({});
  s.penDown(0.2, 0.5); s.penMove(0.3, 0.5); s.penUp();
  s.penMove(0.8, 0.9);                     // moving with the pen up draws nothing
  s.penDown(0.6, 0.4); s.penMove(0.7, 0.4); s.penUp();

  assert.equal(s.strokes.length, 2, 'two presses, two strokes');
  assert.deepEqual(s.strokes[0].points, [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }],
    'the pen-up move never joined the first stroke');
  assert.ok(s.strokes.every((st) => st.points.length >= 2), 'both persist');
  s.clear();
  assert.equal(s.strokes.length, 0);
});
