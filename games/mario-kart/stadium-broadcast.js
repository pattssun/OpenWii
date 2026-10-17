import * as THREE from "three";
/** Low-resolution GPU-only race feed for the arena screens. */
export function stadiumBroadcast(renderer, scene, materials, {width=512,height=384} = {}) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const camera = new THREE.PerspectiveCamera(58, width / height, 0.3, 900);
  const originals = materials.map((m) => m.map);
  let nextFrame = 0,
    frames = 0,
    interval = 100;
  for (const m of materials) m.map = target.texture;
  return {
    setRate(hz) {
      interval = hz > 0 ? 1000 / hz : Infinity;
      nextFrame = 0;
      for (let i = 0; i < materials.length; i++) materials[i].map = hz > 0 ? target.texture : originals[i];
    },
    get frames() {
      return frames;
    },
    update(now, chaseCamera) {
      if (!Number.isFinite(interval) || now < nextFrame) return;
      nextFrame = now + interval;
      camera.position.copy(chaseCamera.position);
      camera.quaternion.copy(chaseCamera.quaternion);
      camera.fov = chaseCamera.fov;
      camera.updateProjectionMatrix();
      const previous = renderer.getRenderTarget();
      const updateShadows = renderer.shadowMap.autoUpdate;
      // Sampling the render target while writing it is an invalid framebuffer
      // feedback loop. The broadcast sees the original standby screen artwork.
      for (let i = 0; i < materials.length; i++)
        materials[i].map = originals[i];
      try {
        // Reuse the main view's shadow map instead of rendering it twice.
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(scene, camera);
        frames++;
      } finally {
        renderer.shadowMap.autoUpdate = updateShadows;
        renderer.setRenderTarget(previous);
        for (const m of materials) m.map = target.texture;
      }
    },
  };
}
