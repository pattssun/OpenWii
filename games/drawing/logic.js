/**
 * Drawing — sketchbook logic. No renderer, no DOM.
 *
 * Point at the canvas, hold A to paint. Strokes are polylines that share
 * endpoints segment-to-segment, so a stroke is continuous by construction:
 * however fast the hand moves between samples, the renderer draws one
 * unbroken line through every recorded point.
 *
 * Coordinates are normalised [0,1]×[0,1] over the whole screen; the toolbar
 * geometry lives here so the renderer and the tests hit-test identically.
 */

export const COLORS = [
  '#1d1f24', '#e23b3b', '#f28c28', '#f6d32d', '#3fae5a',
  '#2aa9c9', '#2f6fd6', '#8e5bd0', '#e06fae', '#8a5a3b',
];
export const SIZES = [0.004, 0.009, 0.018];   // brush radius, fraction of height
export const ERASER_SIZE = 0.024;

/**
 * Toolbar layout: one column down the LEFT edge. Colours, then sizes, then
 * eraser and clear. Every entry carries its own hit rect.
 */
export const TOOLBAR = (() => {
  const entries = [];
  const x = 0.012;
  const w = 0.031;
  const h = 0.05;
  let y = 0.03;
  for (let i = 0; i < COLORS.length; i += 1) {
    entries.push({ kind: 'color', value: COLORS[i], rect: { x, y, w, h } });
    y += 0.056;
  }
  y += 0.015;
  for (let i = 0; i < SIZES.length; i += 1) {
    entries.push({ kind: 'size', value: i, rect: { x, y, w, h } });
    y += 0.056;
  }
  y += 0.015;
  entries.push({ kind: 'eraser', value: null, rect: { x, y, w, h } });
  y += 0.056;
  entries.push({ kind: 'clear', value: null, rect: { x, y, w, h } });
  return entries;
})();

export function pickTool(x, y) {
  for (const e of TOOLBAR) {
    const r = e.rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return e;
  }
  return null;
}

/** Largest distance between consecutive points of a stroke's polyline. */
export function strokeMaxStep(stroke) {
  let max = 0;
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return max;
}

export class Sketch {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.color = COLORS[0];
    this.sizeIndex = 1;
    this.eraser = false;
    this.strokes = [];
    this.current = null;
  }

  get brushSize() {
    return this.eraser ? ERASER_SIZE : SIZES[this.sizeIndex];
  }

  /**
   * A pressed at (x, y). Over the toolbar it operates the tool and does NOT
   * start a stroke; over the paper it puts the pen down.
   */
  penDown(x, y) {
    const tool = pickTool(x, y);
    if (tool) {
      this.applyTool(tool);
      return { tool };
    }
    this.current = {
      color: this.color,
      size: this.brushSize,
      erase: this.eraser,
      points: [{ x, y }],
    };
    this.strokes.push(this.current);
    return { stroke: this.current };
  }

  penMove(x, y) {
    if (!this.current) return;
    const pts = this.current.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < 1e-5) return;   // deduplicate stalls
    pts.push({ x, y });
  }

  penUp() {
    if (this.current && this.current.points.length === 1) {
      // A tap leaves a dot: duplicate the point so a segment renders.
      this.current.points.push({ ...this.current.points[0] });
    }
    this.current = null;
  }

  applyTool(tool) {
    if (tool.kind === 'color') { this.color = tool.value; this.eraser = false; }
    else if (tool.kind === 'size') this.sizeIndex = tool.value;
    else if (tool.kind === 'eraser') this.eraser = true;
    else if (tool.kind === 'clear') this.clear();
    this.onEvent({ type: 'tool', tool });
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.onEvent({ type: 'clear' });
  }
}
