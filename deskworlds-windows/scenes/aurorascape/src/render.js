import * as THREE from 'three';
import {
  POST_VERT, RAY_VERT, AURORA_MAP_FRAG, AURORA_FRAG, SKY_FRAG, WATER_FRAG, WHALE_VERT, WHALE_FRAG, PART_VERT, PART_FRAG,
  DOWN_FRAG, UP_FRAG, OUTPUT_FRAG, BLUR_FRAG, simShader, MAP,
} from './shaders.js';
import { buildWhaleGeometry } from './whale-shape.js';
import { NJ } from './rig.js';
import { SIM } from './wave-sim.js';
import { substorm, pulse, auroraAmbient } from './aurora-model.js';
import { CAMERA } from './behaviour.js';

const V3 = THREE.Vector3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// What each quality buys. The aurora march steps, the plan-map and march resolutions, the water
// simulation size, the star density and the reflection taps all scale; eco is built to be cheap.
export const TIERS = {
  eco: { steps: 16, auroraScale: 0.5, map: [320, 184], simN: 192, starCell: 0.030, bisect: 6, taps: 1, msaa: 0, levels: 5 },
  balanced: { steps: 24, auroraScale: 0.6, map: [512, 288], simN: 256, starCell: 0.022, bisect: 8, taps: 2, msaa: 4, levels: 6 },
  detail: { steps: 32, auroraScale: 0.75, map: [640, 360], simN: 384, starCell: 0.018, bisect: 10, taps: 3, msaa: 4, levels: 6 },
  native: { steps: 40, auroraScale: 1.0, map: [768, 432], simN: 512, starCell: 0.015, bisect: 12, taps: 4, msaa: 4, levels: 6 },
};
export const tierName = (q) => (Object.hasOwn(TIERS, q) ? q : 'balanced');

const EXPOSURE = 1.0;
const PITCH = 0.07;         // rad the camera looks above the horizon
const HFOV = 78 * Math.PI / 180;

function noiseTexture() {
  const n = 256, data = new Uint8Array(n * n * 4);
  let s = 0x9e3779b9 | 0;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256);
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createRenderer(canvas, world, { quality = 'balanced' } = {}) {
  const tier = TIERS[tierName(quality)];
  let activeTier = tier;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear = false;
  renderer.info.autoReset = false;

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.3, 400);
  camera.rotation.order = 'YXZ';
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const noise = noiseTexture();
  const hasFloat = renderer.extensions.has('EXT_color_buffer_float');
  const hdrType = THREE.HalfFloatType;
  const rtOpts = (extra = {}) => ({ type: hdrType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...extra });

  // ---- targets
  const mapRT = new THREE.WebGLRenderTarget(tier.map[0], tier.map[1], rtOpts({ generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
  const auroraRaw = new THREE.WebGLRenderTarget(64, 64, rtOpts());
  const auroraRT = new THREE.WebGLRenderTarget(64, 64, rtOpts({ generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
  const skyRT = new THREE.WebGLRenderTarget(64, 64, rtOpts());
  const hdr = new THREE.WebGLRenderTarget(64, 64, rtOpts({ depthBuffer: true, samples: tier.msaa }));
  const N = tier.simN;
  const simRTs = [0, 1].map(() => new THREE.WebGLRenderTarget(N, N, rtOpts({ wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping })));
  const chain = () => Array.from({ length: tier.levels }, () => new THREE.WebGLRenderTarget(64, 64, rtOpts()));
  const downs = chain(), ups = chain();
  let simCur = 0;

  // ---- uniforms shared by every material (one object each, so one assignment updates all)
  const au = { g: new V3(), m: new V3() };
  const shared = {
    uNoise: { value: noise }, uTime: { value: 0 }, uFrame: { value: 0 },
    uCam: { value: new V3(CAMERA.x, CAMERA.y, CAMERA.z) }, uInvVP: { value: new THREE.Matrix4() },
    uView: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
    uRes: { value: new THREE.Vector2(1, 1) },
    uAmb: { value: new V3(0.03, 0.09, 0.05) }, uAurG: { value: au.g }, uAurM: { value: au.m },
    uStarCell: { value: tier.starCell }, uPixAng: { value: 0.001 },
    uSim: { value: simRTs[0].texture }, uSimN: { value: N },
    uAurora: { value: auroraRT.texture }, uSky: { value: skyRT.texture }, uMap: { value: mapRT.texture },
  };

  function pass(vertexShader, fragmentShader, uniforms, extra = {}) {
    const material = new THREE.ShaderMaterial({ uniforms: { ...shared, ...uniforms }, vertexShader, fragmentShader, depthTest: false, depthWrite: false, ...extra });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, u: material.uniforms, material };
  }
  const mapPass = pass(POST_VERT, AURORA_MAP_FRAG, { uAct: { value: 0.3 }, uExpand: { value: 0 } });
  const aurPass = pass(RAY_VERT, AURORA_FRAG, { uTexKm: { value: (MAP.x1 - MAP.x0) / tier.map[0] }, uSteps: { value: tier.steps }, uGain: { value: 1 }, uAct: { value: 0.3 } });
  const blurPass = pass(POST_VERT, BLUR_FRAG, { uSrc: { value: auroraRaw.texture }, uTexel: { value: new THREE.Vector2() } });
  const skyPass = pass(RAY_VERT, SKY_FRAG, { uBisect: { value: tier.bisect } });
  const waterPass = pass(RAY_VERT, WATER_FRAG, { uTaps: { value: tier.taps } });
  const simPass = pass(POST_VERT, simShader(N), {
    uState: { value: simRTs[0].texture }, uTexel: { value: new THREE.Vector2(1 / N, 1 / N) }, uCount: { value: 0 },
    uD: { value: world.disturbances.data }, uF: { value: world.disturbances.foam }, uReset: { value: 1 },
  });
  const down = pass(POST_VERT, DOWN_FRAG, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
  const up = pass(POST_VERT, UP_FRAG, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
  const output = pass(POST_VERT, OUTPUT_FRAG, {
    uBeauty: { value: hdr.texture }, uBloom: { value: ups[1].texture }, uExposure: { value: EXPOSURE }, uBloomGain: { value: 0.45 },
    uCA: { value: 0.0025 }, uVignette: { value: 0.5 },
  });

  // ---- whales: one shared mesh, drawn twice (the mirror image, then the whale)
  const geo = buildWhaleGeometry();
  const whaleGeometry = new THREE.BufferGeometry();
  whaleGeometry.setAttribute('position', new THREE.BufferAttribute(geo.position, 3));
  whaleGeometry.setAttribute('aNrm', new THREE.BufferAttribute(geo.normal, 3));
  whaleGeometry.setAttribute('aMisc', new THREE.BufferAttribute(geo.misc, 4));
  whaleGeometry.setIndex(new THREE.BufferAttribute(geo.index, 1));
  const mirrorScene = new THREE.Scene(), whaleScene = new THREE.Scene(), partScene = new THREE.Scene();
  const blend = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, transparent: true };
  const whaleMaterials = [];
  world.whales.forEach((w, i) => {
    const own = {
      uSP: { value: w.rig.P }, uST: { value: w.rig.T }, uSU: { value: w.rig.U }, uWet: { value: w.rig.wet }, uLag: { value: w.rig.lag },
      uJD: { value: w.rig.JD }, uScale: { value: w.scale }, uGape: { value: 0 }, uPleat: { value: 0 }, uSeed: { value: (i * 0.37 + 0.11) % 1 },
    };
    for (const mirror of [1, 0]) {
      const m = new THREE.ShaderMaterial({
        uniforms: { ...shared, ...own, uMirror: { value: mirror } }, vertexShader: WHALE_VERT, fragmentShader: WHALE_FRAG,
        side: THREE.DoubleSide, depthTest: true, depthWrite: true, ...blend,
      });
      const mesh = new THREE.Mesh(whaleGeometry, m);
      mesh.frustumCulled = false;
      (mirror ? mirrorScene : whaleScene).add(mesh);
      whaleMaterials.push(m);
    }
  });
  // particles: instanced soft quads
  const P = world.particles;
  const partGeometry = new THREE.InstancedBufferGeometry();
  partGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  partGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  const posAttr = new THREE.InstancedBufferAttribute(P.posSize, 4); posAttr.setUsage(THREE.DynamicDrawUsage);
  const parAttr = new THREE.InstancedBufferAttribute(P.params, 4); parAttr.setUsage(THREE.DynamicDrawUsage);
  partGeometry.setAttribute('aPosSize', posAttr); partGeometry.setAttribute('aParam', parAttr);
  partGeometry.instanceCount = 0;
  const partMaterial = new THREE.ShaderMaterial({
    uniforms: { ...shared }, vertexShader: PART_VERT, fragmentShader: PART_FRAG, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const partMesh = new THREE.Mesh(partGeometry, partMaterial);
  partMesh.frustumCulled = false;
  partScene.add(partMesh);

  // ---- camera
  const size = new THREE.Vector2(1, 1);
  const dir = new V3(), tmp = new V3();
  let camYaw = 0, vfov = 52;
  function frameCamera(aspect, heightPx) {
    vfov = clamp(2 * Math.atan(Math.tan(HFOV / 2) / aspect) * 180 / Math.PI, 38, 74);
    camera.fov = vfov; camera.aspect = aspect;
    camera.updateProjectionMatrix();
    shared.uPixAng.value = 2 * Math.tan(vfov * Math.PI / 360) / Math.max(heightPx, 1);
  }
  // A slow drift of the viewpoint, as if a small boat rode the swell.
  let debugCam = null;
  const hide = {};
  function poseCamera(time) {
    if (debugCam) {
      camera.position.set(debugCam[0], debugCam[1], debugCam[2]);
      camera.lookAt(debugCam[3], debugCam[4], debugCam[5]);
      if (debugCam[6]) { camera.fov = debugCam[6]; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld(true);
      shared.uCam.value.copy(camera.position);
      shared.uView.value.copy(camera.matrixWorldInverse);
      shared.uProj.value.copy(camera.projectionMatrix);
      shared.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
      return;
    }
    const yaw = 0.022 * Math.sin(time * 0.071) + 0.012 * Math.sin(time * 0.173 + 1.0) + camYaw;
    const bob = 0.05 * Math.sin(time * 0.5) + 0.03 * Math.sin(time * 0.83 + 2.0);
    camera.position.set(CAMERA.x + 0.4 * Math.sin(time * 0.045), CAMERA.y + bob, CAMERA.z);
    camera.rotation.set(PITCH + 0.006 * Math.sin(time * 0.37), yaw, 0.004 * Math.sin(time * 0.29));
    camera.updateMatrixWorld(true);
    shared.uCam.value.copy(camera.position);
    shared.uView.value.copy(camera.matrixWorldInverse);
    shared.uProj.value.copy(camera.projectionMatrix);
    shared.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
  }

  // The water point under a pointer given in 0..1 canvas fractions (y down). Above the horizon the
  // pointer is carried to the far edge of the pool along the same bearing.
  const hit = { x: 0, z: -100, onWater: false };
  function screenToWater(fx, fy) {
    tmp.set(fx * 2 - 1, -(fy * 2 - 1), 0.5).unproject(camera).sub(camera.position).normalize();
    if (tmp.y < -0.004) {
      const t = camera.position.y / -tmp.y;
      hit.x = camera.position.x + tmp.x * t; hit.z = camera.position.z + tmp.z * t; hit.onWater = true;
    } else {
      const h = Math.hypot(tmp.x, tmp.z) || 1;
      hit.x = camera.position.x + tmp.x / h * 210; hit.z = camera.position.z + tmp.z / h * 210; hit.onWater = false;
    }
    // keep inside the simulated pool
    hit.x = clamp(hit.x, SIM.minX + 6, SIM.minX + SIM.size - 6); hit.z = clamp(hit.z, SIM.minZ + 6, -14);
    return hit;
  }

  // ---- the water simulation: one fixed step per call, fed with the world's disturbances
  function simStep(d = world.disturbances) {
    simPass.u.uState.value = simRTs[simCur].texture;
    simPass.u.uCount.value = d.count;
    simPass.u.uD.value = d.data; simPass.u.uF.value = d.foam;
    const next = 1 - simCur;
    renderer.setRenderTarget(simRTs[next]);
    renderer.render(simPass.scene, screenCamera);
    simPass.u.uReset.value = 0;
    simCur = next;
    shared.uSim.value = simRTs[simCur].texture;
  }
  simStep({ count: 0, data: world.disturbances.data, foam: world.disturbances.foam });
  simStep({ count: 0, data: world.disturbances.data, foam: world.disturbances.foam });

  const ambient = [0, 0, 0];
  let frame = 0;
  function syncAurora(time) {
    const s = substorm(time), p = pulse(time);
    auroraAmbient(time, ambient);
    shared.uAmb.value.set(ambient[0], ambient[1], ambient[2]);
    const lvl = s.level * p;
    au.g.set(0.09, 1.0, 0.30).multiplyScalar(lvl * 0.55);
    au.m.set(1.0, 0.16, 0.55).multiplyScalar((0.12 + 0.9 * s.act) * lvl * 0.5);
    mapPass.u.uAct.value = s.act; mapPass.u.uExpand.value = s.expand;
    aurPass.u.uAct.value = s.act;
    aurPass.u.uGain.value = lvl * 1.0;
  }

  function render() {
    renderer.info.reset();
    const time = world.time;
    shared.uTime.value = time;
    shared.uFrame.value = frame;
    syncAurora(time);
    poseCamera(time);
    world.whales.forEach((w, i) => {
      for (const m of [whaleMaterials[i * 2], whaleMaterials[i * 2 + 1]]) { m.uniforms.uGape.value = w.gape; m.uniforms.uPleat.value = 0.5 + 0.5 * Math.sin(time * 0.6 + i); }
    });
    const count = P.fill();
    partGeometry.instanceCount = count;
    posAttr.needsUpdate = true; parAttr.needsUpdate = true;

    // 1. the plan map of the curtains, then the view-ray march (the sky seen from the ground)
    renderer.setRenderTarget(mapRT); renderer.render(mapPass.scene, screenCamera);
    renderer.setRenderTarget(auroraRaw); renderer.render(aurPass.scene, screenCamera);
    renderer.setRenderTarget(auroraRT); renderer.render(blurPass.scene, screenCamera);
    // 2. stars, Milky Way, land, haze
    renderer.setRenderTarget(skyRT); renderer.render(skyPass.scene, screenCamera);
    // 3. water over it, the whales and their reflections, the mist
    renderer.setRenderTarget(hdr); renderer.clear();
    renderer.render(waterPass.scene, screenCamera);
    renderer.clearDepth();
    if (!hide.mirror) renderer.render(mirrorScene, camera);
    renderer.clearDepth();
    if (!hide.whales) renderer.render(whaleScene, camera);
    if (!hide.particles) renderer.render(partScene, camera);
    // 4. bloom pyramid and the grade
    let src = hdr.texture, w = size.x, h = size.y;
    for (let k = 1; k < tier.levels; k++) {
      down.u.uSrc.value = src; down.u.uTexel.value.set(1 / w, 1 / h); down.u.uFirst.value = k === 1 ? 1 : 0;
      renderer.setRenderTarget(downs[k]); renderer.render(down.scene, screenCamera);
      src = downs[k].texture; w = downs[k].width; h = downs[k].height;
    }
    const weights = [0.7, 0.55, 0.38, 0.25, 0.18];
    for (let k = tier.levels - 2; k >= 1; k--) {
      const coarse = k === tier.levels - 2 ? downs[k + 1] : ups[k + 1];
      up.u.uSrc.value = coarse.texture; up.u.uBase.value = downs[k].texture;
      up.u.uTexel.value.set(1 / coarse.width, 1 / coarse.height); up.u.uWeight.value = weights[k - 1];
      renderer.setRenderTarget(ups[k]); renderer.render(up.scene, screenCamera);
    }
    output.u.uFrame.value = frame++ % 4096;
    renderer.setRenderTarget(null);
    renderer.render(output.scene, screenCamera);
  }

  function resize(cssWidth, cssHeight, w, h) {
    renderer.setSize(w, h, false);
    size.set(w, h);
    shared.uRes.value.set(w, h);
    hdr.setSize(w, h); skyRT.setSize(w, h);
    const aw = Math.max(64, Math.round(w * activeTier.auroraScale)), ah = Math.max(64, Math.round(h * activeTier.auroraScale));
    auroraRT.setSize(aw, ah); auroraRaw.setSize(aw, ah);
    blurPass.u.uTexel.value.set(1 / aw, 1 / ah);
    for (let k = 1; k < tier.levels; k++) {
      const lw = Math.max(2, Math.ceil(w / 2 ** k)), lh = Math.max(2, Math.ceil(h / 2 ** k));
      downs[k].setSize(lw, lh); ups[k].setSize(lw, lh);
    }
    frameCamera(cssWidth / cssHeight, h);
    output.u.uRes.value.set(w, h);
    poseCamera(world.time);
  }

  function dispose() {
    const geometries = new Set(), materials = new Set();
    for (const root of [mapPass.scene, aurPass.scene, blurPass.scene, skyPass.scene, waterPass.scene, simPass.scene, down.scene, up.scene, output.scene, mirrorScene, whaleScene, partScene]) {
      root.traverse((o) => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
    }
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    for (const rt of [mapRT, auroraRaw, auroraRT, skyRT, hdr, ...simRTs, ...downs, ...ups]) rt.dispose();
    noise.dispose();
    renderer.dispose();
  }

  return {
    renderer, camera, render, resize, dispose, simStep, screenToWater, tier, hasFloat,
    setCameraYaw(v) { camYaw = v; },
    hide,
    setAuroraSteps(n) { aurPass.u.uSteps.value = n; },
    // Development stills only: a free camera, [px, py, pz, tx, ty, tz, fov?].
    setDebugCamera(v) { debugCam = v; },
    get vfov() { return vfov; },
  };
}
