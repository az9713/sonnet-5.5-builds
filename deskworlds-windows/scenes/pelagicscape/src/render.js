import * as THREE from 'three';
import {
  BELL_VERT, BELL_FRAG, THREAD_VERT, THREAD_FRAG, COMB_VERT, COMB_FRAG, POINTS_VERT, POINTS_FRAG,
  POST_VERT, DOWN_FRAG, UP_FRAG, DOF_FRAG, OUTPUT_FRAG,
} from './shaders.js';
import { VARIANTS, NODE_W } from './jelly.js';
import { CURSOR_DEPTH } from './world.js';

const levelsFor = tier => (tier === 'eco' ? 5 : 6);   // mip levels of the depth-of-field and bloom chain

const V3 = THREE.Vector3;
const FOCUS = 8.6;                 // the middle jellyfish is in focus
const COC_REF = 17;                // circle of confusion in pixels at relative defocus 1, for a 720 px tall frame
const BLOOM = { weights: [0.55, 0.38, 0.22, 0.1, 0.05], gain: 0.5, halo: new V3(0.75, 0.95, 1.2) };
const NODES_T = 16, NODES_A = 20, NODES_C = 14;
const OVER = {                      // premultiplied "over": additive glow carries alpha 0
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  transparent: true, depthTest: false, depthWrite: false,
};

function lathe(nu, nv) {
  const n = (nu + 1) * (nv + 1), p = new Float32Array(n * 2), idx = [];
  let k = 0;
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { p[k++] = i / nu; p[k++] = j / nv; }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b = a + nv + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aP', new THREE.BufferAttribute(p, 2));
  g.setIndex(idx);
  return g;
}

// A strip of ribbon samples along a chain of n nodes; `instances` ribbons share it, each reading its own row of the node texture.
function ribbons(n, instances, row0, seeds, widthScale) {
  const sub = 3, S = (n - 1) * sub + 1;
  const u = new Float32Array(S * 2), side = new Float32Array(S * 2), idx = [];
  for (let k = 0; k < S; k++) {
    const x = k / sub;
    u[k * 2] = x; u[k * 2 + 1] = x; side[k * 2] = -1; side[k * 2 + 1] = 1;
    if (k < S - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S * 2 * 3), 3));
  g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  const inst = new Float32Array(instances * 4);
  for (let i = 0; i < instances; i++) { inst[i * 4] = row0 + i; inst[i * 4 + 1] = seeds[i]; inst[i * 4 + 2] = widthScale[i]; }
  g.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
  g.setIndex(idx);
  g.instanceCount = instances;
  return g;
}

export function createRenderer(canvas, sim, { quality = 'balanced' } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.info.autoReset = false;
  const gl = renderer.getContext();
  const maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];

  const tanV = sim.world.camera.tanV;
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(tanV)), 1, 0.1, 80);
  const scene = new THREE.Scene();
  const MAX_LEVELS = 6;
  let LEVELS = levelsFor(quality);

  const shared = {
    uTime: { value: 0 }, uFocus: { value: FOCUS }, uCoc: { value: COC_REF }, uCocMax: { value: 16 }, uPxScale: { value: 500 },
    uExposure: { value: 1 },
  };
  const eachMat = [];
  const mat = (params) => { const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, side: THREE.DoubleSide, ...OVER, ...params }); eachMat.push(m); return m; };
  const add = (geometry, material) => { const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; scene.add(mesh); return mesh; };

  // ---- jellyfish
  const bellGeometry = lathe(60, 64);
  const items = [];
  const jellies = sim.jellies.map((j, idx) => {
    const v = VARIANTS[j.variant];
    const u = {
      ...shared,
      uCenter: { value: new V3() }, uX: { value: new V3() }, uY: { value: new V3() }, uZ: { value: new V3() },
      uR: { value: j.size }, uPhase: { value: 0 }, uAmp: { value: 1 }, uSeed: { value: j.seed }, uLobes: { value: j.lobes }, uOval: { value: new THREE.Vector2(j.oval[0], j.oval[1]) },
      uBody: { value: new V3(...v.body) }, uGonad: { value: new V3(...v.gonad) }, uMargin: { value: new V3(...v.margin) },
    };
    const back = add(bellGeometry, mat({ uniforms: { ...u, uPass: { value: 0 } }, vertexShader: BELL_VERT, fragmentShader: BELL_FRAG }));
    const front = add(bellGeometry, mat({ uniforms: { ...u, uPass: { value: 1 } }, vertexShader: BELL_VERT, fragmentShader: BELL_FRAG }));
    const tex = new THREE.DataTexture(j.nodes, NODE_W, j.rows, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
    const nT = j.chains.filter(c => c.kind === 0).length, nA = j.chains.length - nT;
    const tg = ribbons(NODES_T, nT, 0, j.chains.slice(0, nT).map(c => c.seed), j.chains.slice(0, nT).map(c => 0.8 + 0.4 * c.tw));
    const ag = ribbons(NODES_A, nA, nT, j.chains.slice(nT).map(c => c.seed), j.chains.slice(nT).map(() => 1));
    const tu = { ...shared, uNodes: { value: tex }, uN: { value: NODES_T }, uWidth: { value: 0.010 * j.size + 0.0012 }, uKind: { value: 0 }, uColor: { value: new V3(...v.body).lerp(new V3(1, 1, 1), 0.25) }, uBead: { value: 0.05 * j.size + 0.012 }, uGain: { value: 1.0 } };
    const au = { ...tu, uN: { value: NODES_A }, uWidth: { value: 0.17 * j.size }, uKind: { value: 1 }, uColor: { value: new V3(...v.gonad) }, uBead: { value: 0.08 * j.size }, uGain: { value: 0.8 } };
    const tent = add(tg, mat({ uniforms: tu, vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG }));
    const arms = add(ag, mat({ uniforms: au, vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG }));
    const item = { kind: 'jelly', j, meshes: [back, tent, arms, front], u, tex, center: u.uCenter.value };
    items.push(item);
    return item;
  });

  // ---- comb jellies
  const combGeometry = lathe(40, 56);
  const combs = sim.combs.map((c, idx) => {
    const u = {
      ...shared, uCenter: { value: new V3() }, uX: { value: new V3() }, uY: { value: new V3() }, uZ: { value: new V3() }, uSize: { value: c.size },
      uSeed: { value: c.seed }, uExt: { value: 1 }, uGain: { value: 1 },
    };
    const body = add(combGeometry, mat({ uniforms: u, vertexShader: COMB_VERT, fragmentShader: COMB_FRAG }));
    const tex = new THREE.DataTexture(c.nodes, NODE_W, 2, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
    const g = ribbons(NODES_C, 2, 0, [c.seed * 0.01, c.seed * 0.013 + 0.3], [1, 1]);
    const tu = { ...shared, uNodes: { value: tex }, uN: { value: NODES_C }, uWidth: { value: 0.0016 + 0.01 * c.size }, uKind: { value: 2 }, uColor: { value: new V3(0.45, 0.7, 1.0) }, uBead: { value: 0.03 + 0.1 * c.size }, uGain: { value: 1.2 } };
    const tent = add(g, mat({ uniforms: tu, vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG }));
    const item = { kind: 'comb', c, idx, meshes: [body, tent], u, tu, tentGain: 1.2, fade: idx < sim.combCount ? 1 : 0, tex, center: u.uCenter.value };
    items.push(item);
    return item;
  });

  // ---- plankton, snow, ring markers: one buffer, drawn in depth slices between the jellyfish
  let pointGeometry = null, interleaved = null;
  function buildPoints() {
    const pl = sim.plankton;
    const g = new THREE.BufferGeometry();
    interleaved = new THREE.InterleavedBuffer(pl.pts, 4);
    interleaved.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
    g.setAttribute('aE', new THREE.InterleavedBufferAttribute(interleaved, 1, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(pl.kind, 2));
    g.setDrawRange(0, pl.total);
    return g;
  }
  pointGeometry = buildPoints();
  const gainFor = n => 4.2 * Math.min(1, 1.15 * Math.sqrt(12000 / n));
  const pointShared = { ...shared, uMaxSize: { value: Math.min(maxPoint, 40) }, uPlanktonGain: { value: gainFor(sim.plankton.count) }, uScale: { value: 1 } };
  const slices = [];
  for (let i = 0; i <= sim.jellies.length; i++) {
    const m = mat({ uniforms: { ...pointShared, uSlice: { value: new THREE.Vector2(0, 1e9) } }, vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG });
    const p = new THREE.Points(pointGeometry, m);
    p.frustumCulled = false; scene.add(p);
    slices.push(p);
  }

  // ---- render targets
  const rt = (opts = {}) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false, ...opts });
  const hdr = rt({ count: 2 });
  const dof = rt();
  const chain = (n) => Array.from({ length: n }, () => rt());
  const downs = chain(MAX_LEVELS), ups = chain(MAX_LEVELS), cdowns = chain(4);

  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const passes = [];
  function postPass(fragmentShader, uniforms) {
    const geo = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    const passScene = new THREE.Scene();
    passScene.add(mesh);
    passes.push({ geo, material, passScene });
    return { scene: passScene, u: material.uniforms };
  }
  const down = postPass(DOWN_FRAG, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = postPass(UP_FRAG, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
  const dofPass = postPass(DOF_FRAG, {
    uL0: { value: hdr.textures[0] }, uL1: { value: downs[1].texture }, uL2: { value: downs[2].texture }, uL3: { value: downs[3].texture }, uL4: { value: downs[4].texture },
    uC0: { value: hdr.textures[1] }, uC2: { value: cdowns[2].texture }, uC3: { value: cdowns[3].texture }, uTexel: { value: new THREE.Vector2() },
  });
  const output = postPass(OUTPUT_FRAG, {
    uBeauty: { value: dof.texture }, uBloom: { value: ups[1].texture }, uHalo: { value: BLOOM.halo }, uExposure: { value: 1.35 }, uBloomGain: { value: BLOOM.gain },
    uFrame: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 }, uCA: { value: 0.004 }, uShaft: { value: 1 },
  });
  const size = new THREE.Vector2(1, 1);
  let frame = 0;

  function drawPass(p, target) { renderer.setRenderTarget(target); renderer.render(p.scene, screenCamera); }

  function updateItems() {
    const cam = sim.world.camera;
    camera.position.set(cam.x, cam.y, 0);
    camera.updateMatrixWorld();
    const t = sim.world.time;
    shared.uTime.value = t;
    for (const it of items) {
      const b = it.kind === 'jelly' ? it.j.basis : it.c.basis, pos = it.kind === 'jelly' ? it.j.pos : it.c.pos;
      it.center.set(pos[0], pos[1], pos[2]);
      it.u.uX.value.set(b.x[0], b.x[1], b.x[2]); it.u.uY.value.set(b.y[0], b.y[1], b.y[2]); it.u.uZ.value.set(b.z[0], b.z[1], b.z[2]);
      if (it.kind === 'jelly') { it.u.uPhase.value = it.j.phase; it.u.uAmp.value = it.j.amp; }
      it.tex.needsUpdate = true;
      it.depth = -(pos[2] - 0);
      if (it.kind === 'comb') {
        // comb jellies that a lower tier drops fade out over a second instead of vanishing
        const want = it.idx < sim.combCount ? 1 : 0;
        it.fade += Math.max(-0.02, Math.min(0.02, want - it.fade));
        it.u.uGain.value = it.fade; it.tu.uGain.value = it.tentGain * it.fade;
        for (const m of it.meshes) m.visible = it.fade > 0.001;
      }
    }
  }

  const sorted = items.slice(), jellyDepth = new Float64Array(items.length + 1);
  function order() {
    // far to near: slices of plankton are interleaved between the jellyfish so a flash in front of a bell is drawn over it
    for (let i = 1; i < sorted.length; i++) { const it = sorted[i]; let k = i - 1; while (k >= 0 && sorted[k].depth < it.depth) { sorted[k + 1] = sorted[k]; k--; } sorted[k + 1] = it; }
    let nj = 0;
    for (const it of sorted) if (it.kind === 'jelly') jellyDepth[nj++] = it.depth;
    jellyDepth[nj] = 0;
    let o = 0, s = 0;
    const setSlice = (lo, hi) => { const p = slices[s++]; p.renderOrder = o++; p.material.uniforms.uSlice.value.set(lo, hi); };
    let hi = 1e9, k = 0;
    setSlice(jellyDepth[0], hi);
    for (const it of sorted) {
      for (const m of it.meshes) m.renderOrder = o++;
      if (it.kind === 'jelly') { hi = it.depth; k++; setSlice(jellyDepth[k], hi); }
    }
  }

  function render() {
    renderer.info.reset();
    sim.fillAll();
    interleaved.needsUpdate = true;
    updateItems();
    order();
    output.u.uTime.value = sim.world.time;
    // scene into the two-output HDR target
    renderer.setRenderTarget(hdr);
    renderer.clear();
    renderer.render(scene, camera);
    // mip chain of colour (bloom and depth of field) and of the circle-of-confusion channel
    let src = hdr.textures[0], w = size.x, h = size.y;
    for (let k = 1; k < LEVELS; k++) {
      down.u.uSrc.value = src; down.u.uTexel.value.set(1 / w, 1 / h);
      drawPass(down, downs[k]);
      src = downs[k].texture; w = downs[k].width; h = downs[k].height;
    }
    src = hdr.textures[1]; w = size.x; h = size.y;
    for (let k = 1; k <= 3; k++) {
      down.u.uSrc.value = src; down.u.uTexel.value.set(1 / w, 1 / h);
      drawPass(down, cdowns[k]);
      src = cdowns[k].texture; w = cdowns[k].width; h = cdowns[k].height;
    }
    dofPass.u.uTexel.value.set(1 / size.x, 1 / size.y);
    drawPass(dofPass, dof);
    for (let k = LEVELS - 2; k >= 1; k--) {
      const coarse = k === LEVELS - 2 ? downs[k + 1] : ups[k + 1];
      up.u.uSrc.value = coarse.texture; up.u.uBase.value = downs[k].texture;
      up.u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      up.u.uWeight.value = BLOOM.weights[Math.min(k - 1, BLOOM.weights.length - 1)];
      drawPass(up, ups[k]);
    }
    output.u.uFrame.value = frame++ % 4096;
    renderer.setRenderTarget(null);
    renderer.render(output.scene, screenCamera);
  }

  function resize(cssWidth, cssHeight, w, h) {
    renderer.setSize(w, h, false);
    size.set(w, h);
    hdr.setSize(w, h); dof.setSize(w, h);
    for (let k = 1; k < MAX_LEVELS; k++) { const lw = Math.max(1, Math.ceil(w / 2 ** k)), lh = Math.max(1, Math.ceil(h / 2 ** k)); downs[k].setSize(lw, lh); ups[k].setSize(lw, lh); }
    for (let k = 1; k <= 3; k++) cdowns[k].setSize(Math.max(1, Math.ceil(w / 2 ** k)), Math.max(1, Math.ceil(h / 2 ** k)));
    const scale = Math.min(1.5, h / 720);
    shared.uCoc.value = COC_REF * scale; shared.uCocMax.value = 15 * scale; shared.uPxScale.value = h / (2 * tanV);
    pointShared.uMaxSize.value = Math.min(maxPoint, 2 * 15 * scale + 6); pointShared.uScale.value = Math.max(0.8, scale);
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
    output.u.uAspect.value = cssWidth / cssHeight;
    sim.setAspect(cssWidth / cssHeight);
  }

  // A quality tier change: new particle buffers for the new counts (the simulation carried the old state over), deeper or shallower mip chain.
  function setTier(name) {
    const old = pointGeometry;
    pointGeometry = buildPoints();
    for (const p of slices) p.geometry = pointGeometry;
    old.dispose();
    pointShared.uPlanktonGain.value = gainFor(sim.plankton.count);
    LEVELS = levelsFor(name);
  }

  function dispose() {
    const geometries = new Set([pointGeometry, bellGeometry, combGeometry]);
    for (const it of items) for (const m of it.meshes) geometries.add(m.geometry);
    geometries.forEach(g => g.dispose());
    eachMat.forEach(m => m.dispose());
    for (const it of items) it.tex?.dispose();
    for (const p of passes) { p.geo.dispose(); p.material.dispose(); }
    for (const r of [hdr, dof, ...downs.slice(1), ...ups.slice(1), ...cdowns.slice(1)]) r.dispose();
    renderer.dispose();
  }
  return { renderer, camera, render, resize, setTier, dispose, uniforms: { shared, output: output.u, pointShared, bloom: BLOOM }, focus: FOCUS, cursorDepth: CURSOR_DEPTH };
}
