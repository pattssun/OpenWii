/** WebGL's viewport origin is bottom-left; the HUD's order is top-left first. */
export function splitViewport(width, height, mode, slot) {
  if (mode === 'duo') {
    const left = Math.floor(width / 2);
    return { x: slot === 0 ? 0 : left, y: 0,
      width: slot === 0 ? left : width - left, height };
  }
  if (mode === 'quad') {
    const left = Math.floor(width / 2);
    const bottom = Math.floor(height / 2);
    const rightColumn = slot % 2 === 1;
    const topRow = slot < 2;
    return { x: rightColumn ? left : 0, y: topRow ? bottom : 0,
      width: rightColumn ? width - left : left,
      height: topRow ? height - bottom : bottom };
  }
  return { x: 0, y: 0, width, height };
}
