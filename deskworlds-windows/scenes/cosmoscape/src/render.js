import * as THREE from 'three';
import { POINT_VERT, POINT_FRAG, GALAXY_VERT, GALAXY_FRAG, POST_VERT, DOWN_FRAG, UP_FRAG, OUTPUT_FRAG } from './shaders.js';
import { dustIndices, buildGalaxies } from './particles.js';

const V3 = THREE.Vector3;
export const FOV = 46;
// Per quality tier: how far the particle pass is rendered below display resolution (and upsampled), the largest sprite in
// pixels at 900 px frame height, the share of the dust layer drawn, the depth of the bloom pyramid, and a sprite size multiplier.
export const RENDER_TIERS = Object.freeze({
  eco: { scale: 0.7, cap: 140, dust: 0, levels: 5, size: 1.25, galaxies: 2600 },
  balanced: { scale: 0.85, cap: 180, dust: 0.3, levels: 6, size: 1, galaxies: 5200 },
  detail: { scale: 1, cap: 240, dust: 0.75, levels: 6, size: 1, galaxies: 5200 },
  native: { scale: 1, cap: 280, dust: 1, levels: 6, size: 1, galaxies: 5200 },
});
const MAX_LEVELS = 6;
const BLOOM = { weights: [0.55, 0.45, 0.28, 0.14, 0.07], gain: 0.5, halo: new V3(0.85, 0.95, 1.2) };
const LOOK_DEFAULT = {
  size: 0.55,          // kernel sigma of a web particle, in local spacings
  eps: 0.14, soft: 0.08,
  structSigma: 0.0021, structGain: 0.1,   // kernel sigma of a neural / mycelial point, box units
  dustSize: 0.03,
  gain: 10, dustGain: 0.4, galaxyGain: 0.8,
  minSigma: 0.65, aperture: 0.016,   // circle of confusion at unit relative defocus, as a share of the frame height
  lensE: 0.11,         // Einstein radius as a share of the frame height at full strength
  exposure: 1.0,
  spread: 0.55, swirl: 0.07, streak: 0.07,
};

export function createRenderer(canvas, data, tierName = 'balanced', overrides = {}) {
  const LOOK = { ...LOOK_DEFAULT, ...overrides };
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the output pass writes display values itself
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
  const hdrType = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
  let tier = RENDER_TIERS[tierName] || RENDER_TIERS.balanced;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 2);
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  const shared = {
    uRes: { value: new THREE.Vector2(1, 1) }, uCam: { value: new V3() }, uD: { value: 1 },
    uFrom: { value: 0 }, uTo: { value: 0 }, uM: { value: 0 }, uSpread: { value: LOOK.spread }, uSwirlAmp: { value: LOOK.swirl }, uStreak: { value: LOOK.streak }, uTime: { value: 0 },
    uCenter: { value: new V3() }, uRay: { value: new V3(0, 0, -1) }, uPull: { value: new V3(0, 0.16, 0.2) }, uFocus: { value: new THREE.Vector2(0.2, 20) },
    uH: { value: 1 / data.lattice }, uSize: { value: LOOK.size }, uEps: { value: LOOK.eps }, uStructSigma: { value: LOOK.structSigma }, uStructGain: { value: LOOK.structGain },
    uGain: { value: LOOK.gain * 110592 / data.count }, uCap: { value: 40 }, uMinSigma: { value: LOOK.minSigma }, uSoft: { value: LOOK.soft },
    uLens: { value: new THREE.Vector4(0, 0, 0, 1) }, uLensDepth: { value: 0.16 },
    uDustPass: { value: 0 }, uDustSize: { value: LOOK.dustSize }, uDustGain: { value: LOOK.dustGain },
    uGalaxyGain: { value: LOOK.galaxyGain },
  };

  // Particle geometry: q is the 'position' attribute.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.q, 3));
  geometry.setAttribute('aPsi', new THREE.BufferAttribute(data.psi, 3));
  geometry.setAttribute('aHd', new THREE.BufferAttribute(data.hd, 3));
  geometry.setAttribute('aHo', new THREE.BufferAttribute(data.ho, 3));
  geometry.setAttribute('aNeural', new THREE.BufferAttribute(data.aNeural, 4));
  geometry.setAttribute('aMyc', new THREE.BufferAttribute(data.aMyc, 4));
  geometry.setAttribute('aRand', new THREE.BufferAttribute(data.aRand, 4));
  geometry.setAttribute('aPulse', new THREE.BufferAttribute(data.aPulse, 2));
  geometry.setDrawRange(0, data.count);
  const dustGeometry = new THREE.BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) dustGeometry.setAttribute(name, geometry.attributes[name]);
  const dustIndex = dustIndices(data.count, 7);
  dustGeometry.setIndex(new THREE.BufferAttribute(dustIndex, 1));

  const material = (vertexShader, fragmentShader, defines, uniforms = shared) => new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, defines, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = (geo, mat, order) => {
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = order;
    scene.add(p);
    return p;
  };
  const dustMaterial = material(POINT_VERT, POINT_FRAG, {});
  // The dust pass has its own uDustPass flag, so it cannot share the main uniform object.
  dustMaterial.uniforms = { ...shared, uDustPass: { value: 1 } };

  // Galaxies: directions at infinity.
  const galaxies = buildGalaxies(5200, 3);
  const galaxyGeometry = new THREE.BufferGeometry();
  galaxyGeometry.setAttribute('position', new THREE.BufferAttribute(galaxies.dir, 3));
  galaxyGeometry.setAttribute('aShape', new THREE.BufferAttribute(galaxies.shape, 4));
  galaxyGeometry.setAttribute('aTint', new THREE.BufferAttribute(galaxies.tint, 3));
  galaxyGeometry.setDrawRange(0, galaxies.count);
  const galaxyPrimary = points(galaxyGeometry, material(GALAXY_VERT, GALAXY_FRAG, {}), -3);
  const galaxySecondary = points(galaxyGeometry, material(GALAXY_VERT, GALAXY_FRAG, { SECOND: 1 }), -3);
  const dust = points(dustGeometry, dustMaterial, -1);
  const web = points(geometry, material(POINT_VERT, POINT_FRAG, {}), 0);
  const webSecondary = points(geometry, material(POINT_VERT, POINT_FRAG, { SECOND: 1 }), 1);
  const dustSecondary = points(dustGeometry, (() => { const m = material(POINT_VERT, POINT_FRAG, { SECOND: 1 }); m.uniforms = dustMaterial.uniforms; return m; })(), 1);

  // Render targets: linear HDR beauty at (scaled) particle resolution and the bloom pyramid.
  const rtOptions = { type: hdrType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  const hdr = new THREE.WebGLRenderTarget(1, 1, rtOptions);
  const chain = () => Array.from({ length: MAX_LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, rtOptions));
  const downs = chain(), ups = chain();
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function postPass(fragmentShader, uniforms) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader, depthTest: false, depthWrite: false }));
    mesh.frustumCulled = false;
    const passScene = new THREE.Scene();
    passScene.add(mesh);
    return { scene: passScene, u: mesh.material.uniforms };
  }
  const down = postPass(DOWN_FRAG, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = postPass(UP_FRAG, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
  const output = postPass(OUTPUT_FRAG, {
    uBeauty: { value: hdr.texture }, uBloom: { value: ups[1].texture }, uHalo: { value: BLOOM.halo }, uExposure: { value: LOOK.exposure }, uBloomGain: { value: BLOOM.gain },
    uFrame: { value: 0 }, uOutRes: { value: new THREE.Vector2(1, 1) }, uLensOut: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
  });
  const size = new THREE.Vector2(1, 1), outSize = new THREE.Vector2(1, 1);
  const right = new V3(), upv = new V3(), back = new V3(), center = new V3();
  let frame = 0, levels = tier.levels;

  // frame: { pose, cycle, sim (cursor etc.), time, cursor: { x, y, lens, pull } }
  function syncUniforms(f) {
    const { pose, cycle, time, lens, pull } = f;
    right.fromArray(pose.right); upv.fromArray(pose.up); back.fromArray(pose.fwd).negate();
    camera.matrixWorld.makeBasis(right, upv, back);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    shared.uCam.value.fromArray(pose.pos);
    shared.uD.value = cycle.growth;
    shared.uFrom.value = cycle.from; shared.uTo.value = cycle.to; shared.uM.value = cycle.m; shared.uTime.value = time;
    center.fromArray(f.frontCenter);
    shared.uCenter.value.copy(center);
    shared.uFocus.value.set(pose.focus, LOOK.aperture * size.y);
    shared.uLensDepth.value = pose.focus * 0.85;
    shared.uCap.value = Math.max(12, Math.min(maxPoint, tier.cap * size.y / 900));
    shared.uStructSigma.value = LOOK.structSigma * tier.size;
    // Cursor: lens centre in target pixels, ray in view space.
    const s = lens * lens * (3 - 2 * lens);
    const E = LOOK.lensE * size.y * s;
    shared.uLens.value.set(f.cursorX * size.x, (1 - f.cursorY) * size.y, E, Math.max(0.45 * E, 1));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    shared.uRay.value.set((f.cursorX * 2 - 1) * tanHalf * camera.aspect, (1 - f.cursorY * 2) * tanHalf, -1).normalize();
    shared.uPull.value.set(pull * 0.55, 0.16, pose.focus);
    output.u.uLensOut.value.set(f.cursorX, 1 - f.cursorY, E * outSize.y / size.y, s);
    dustMaterial.uniforms.uDustPass.value = 1;
    const dustCount = Math.floor(dustIndex.length * tier.dust);
    dust.visible = dustCount > 0;
    dustGeometry.setDrawRange(0, dustCount);
    dustSecondary.visible = dust.visible && lens > 0.01;
    webSecondary.visible = lens > 0.01;
    galaxySecondary.visible = lens > 0.01;
    galaxyGeometry.setDrawRange(0, Math.min(galaxies.count, tier.galaxies));
    shared.uRes.value.copy(size);
  }

  function render(f) {
    renderer.info.reset();
    syncUniforms(f);
    renderer.setRenderTarget(hdr);
    renderer.clear();
    renderer.render(scene, camera);
    // Bloom pyramid.
    let src = hdr.texture, w = size.x, h = size.y;
    for (let k = 1; k < levels; k++) {
      down.u.uSrc.value = src;
      down.u.uTexel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(downs[k]);
      renderer.render(down.scene, screenCamera);
      src = downs[k].texture; w = downs[k].width; h = downs[k].height;
    }
    for (let k = levels - 2; k >= 1; k--) {
      const coarse = k === levels - 2 ? downs[k + 1] : ups[k + 1];
      up.u.uSrc.value = coarse.texture;
      up.u.uBase.value = downs[k].texture;
      up.u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      up.u.uWeight.value = BLOOM.weights[Math.min(k - 1, BLOOM.weights.length - 1)];
      renderer.setRenderTarget(ups[k]);
      renderer.render(up.scene, screenCamera);
    }
    output.u.uBloom.value = levels > 2 ? ups[1].texture : downs[1].texture;
    output.u.uFrame.value = frame++ % 4096;
    renderer.setRenderTarget(null);
    renderer.render(output.scene, screenCamera);
  }

  // w x h: device pixels of the canvas; the particle target is scaled down by the tier.
  function resize(cssWidth, cssHeight, w, h) {
    renderer.setSize(w, h, false);
    outSize.set(w, h);
    output.u.uOutRes.value.set(w, h);
    const pw = Math.max(2, Math.round(w * tier.scale)), ph = Math.max(2, Math.round(h * tier.scale));
    size.set(pw, ph);
    hdr.setSize(pw, ph);
    for (let k = 1; k < MAX_LEVELS; k++) {
      const lw = Math.max(1, Math.ceil(pw / 2 ** k)), lh = Math.max(1, Math.ceil(ph / 2 ** k));
      downs[k].setSize(lw, lh);
      ups[k].setSize(lw, lh);
    }
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
  }

  // The neural and mycelial targets arrive after the first frame: re-upload their attribute buffers.
  function targetsChanged() {
    for (const name of ['aNeural', 'aMyc', 'aPulse']) geometry.attributes[name].needsUpdate = true;
  }

  function setTier(name) {
    const next = RENDER_TIERS[name] || RENDER_TIERS.balanced;
    if (next === tier) return;
    tier = next; levels = tier.levels;
  }

  function dispose() {
    const geometries = new Set(), materials = new Set();
    for (const root of [scene, down.scene, up.scene, output.scene]) {
      root.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
    }
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
    for (const rt of [hdr, ...downs, ...ups]) rt.dispose();
    renderer.dispose();
  }

  return { renderer, camera, render, resize, dispose, setTier, targetsChanged, info: { maxPoint, hdrType: hdrType === THREE.HalfFloatType ? 'half-float' : 'rgba8', get tier() { return tier; } } };
}
