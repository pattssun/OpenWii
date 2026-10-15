/** Graphics budgets are independent of race simulation and controller sampling. */
export const QUALITY = {
  low: { label: 'Performance', pixels: 1280 * 720, pixelRatio: 1, samples: 0, ao: false, bloom: false, shadows: false, shadowSize: 512, broadcastHz: 0 },
  medium: { label: 'Balanced', pixels: 1920 * 1080, pixelRatio: 1, samples: 2, ao: false, bloom: true, shadows: true, shadowSize: 1024, broadcastHz: 5 },
  high: { label: 'High', pixels: 2560 * 1440, pixelRatio: 1.6, samples: 4, ao: true, bloom: true, shadows: true, shadowSize: 2048, broadcastHz: 10 },
};

export function renderScale(width, height, dpr, quality) {
  return Math.min(dpr, quality.pixelRatio, Math.sqrt(quality.pixels / Math.max(1, width * height)));
}

export function gpuInfo(gl) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  return { renderer, software, nvidia: /nvidia/i.test(renderer) && !software };
}

export function loadQuality(storage) {
  try {
    storage ??= globalThis.localStorage;
    const saved = storage.getItem('openwii.kart.graphics.v1');
    if (Object.hasOwn(QUALITY, saved)) return saved;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return 'medium';
}

/** Use actual presented-frame intervals; refresh the UI at most twice a second. */
export function performanceMeter(onUpdate) {
  let previous = null, elapsed = 0, frames = 0;
  return now => {
    if (previous === null) { previous = now; return; }
    const delta = now - previous;
    previous = now;
    if (delta <= 0 || delta > 1000) { elapsed = 0; frames = 0; return; }
    elapsed += delta;
    frames++;
    if (elapsed >= 500) {
      onUpdate({ fps: Math.round(frames * 1000 / elapsed), frameMs: elapsed / frames });
      elapsed = 0;
      frames = 0;
    }
  };
}
