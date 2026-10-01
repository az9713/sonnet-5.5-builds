import * as THREE from 'three';
import {
  POST_VERT, AGENT_FRAG, SPLAT_VERT, SPLAT_FRAG, DIFFUSE_FRAG, SOFT_FRAG, PROBE_FRAG, SCENE_FRAG, SLUG_VERT, slugFrag,
  TRAIL_VERT, TRAIL_FRAG, SPRING_VERT, SPRING_FRAG, SPECK_VERT, SPECK_FRAG, DOF_FRAG, DOWN_FRAG, UP_FRAG, OUTPUT_FRAG,
} from './shaders.js';
import { MODEL, WORLD_W, seedAgents } from './agents-ref.js';
import { FLAKE } from './food.js';
import { SLUG } from './slugs.js';
import { PROBE } from './world.js';

// Everything that scales with quality: the size of the trail map, the number of agents (a square texture),
// how long the colony is pre-grown before the first frame, and the cost of the lens.
export const SIM_QUALITY = Object.freeze({
  eco: { map: [640, 360], agents: 256, warmup: 600, dofTaps: 8, bloom: 4, specks: 36, dof: 0.0085 },
  balanced: { map: [1024, 576], agents: 400, warmup: 900, dofTaps: 14, bloom: 5, specks: 60, dof: 0.0095 },
  detail: { map: [1280, 720], agents: 512, warmup: 1100, dofTaps: 20, bloom: 5, specks: 80, dof: 0.0100 },
  native: { map: [1536, 864], agents: 512, warmup: 1200, dofTaps: 24, bloom: 6, specks: 90, dof: 0.0105 },
});
const REF_DENSITY = 160000 / WORLD_W, REF_PPU = 1024 / WORLD_W;     // the balanced profile is what the constants were tuned at
export const TUNE = { ks: 60, bump: 5.0, grain: 0.8, wave: 1.0, flow: 0.02, glow: 0.55, shadow: 0.5, exposure: 1.05, bloom: 0.34, fringe: 0.0013, vignette: 0.62, photoRadius: 0.16, cursorRadius: 0.26 };

const V4 = THREE.Vector4;
const half = h => { const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff; return (s ? -1 : 1) * (e === 0 ? 6.103515625e-5 * (f / 1024) : e === 31 ? Infinity : 2 ** (e - 15) * (1 + f / 1024)); };

export function createRenderer(canvas, { random, world, quality = 'balanced', overrides = {} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear = false;
  renderer.info.autoReset = false;
  const floatOK = renderer.extensions.has('EXT_color_buffer_float');
  const FLOAT = floatOK ? THREE.FloatType : THREE.HalfFloatType;
  const model = { ...MODEL, ...(overrides.model || {}) };
  const tune = { ...TUNE, ...(overrides.tune || {}) };

  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.PlaneGeometry(2, 2);
  const owned = { geometries: [quad], materials: [], targets: [], textures: [] };
  const material = (params) => { const m = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...params }); owned.materials.push(m); return m; };
  const target = (w, h, type, extra = {}) => {
    const t = new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, ...extra });
    owned.targets.push(t); return t;
  };
  const pass = (mat) => { const mesh = new THREE.Mesh(quad, mat); mesh.frustumCulled = false; const scene = new THREE.Scene(); scene.add(mesh); return scene; };
  const run = (scene, rt) => { renderer.setRenderTarget(rt); renderer.render(scene, screenCamera); };

  // ---------------------------------------------------------------- simulation resources (rebuilt per quality)
  let cfg = SIM_QUALITY[quality] || SIM_QUALITY.balanced, qualityName = quality;
  let sim = null;
  const cursorSim = new V4(0, 0, tune.photoRadius, 0), cursorView = new V4(0, 0, 0, tune.cursorRadius);
  const SOURCES = FLAKE.max + 2;
  const foodA = new Float32Array(FLAKE.max * 4), foodB = new Float32Array(FLAKE.max * 4), foodU = new Float32Array(SOURCES * 4);
  let foodCount = 0;
  let frame = 0, simSteps = 0;

  function buildSim(name) {
    disposeSim();
    qualityName = SIM_QUALITY[name] ? name : 'balanced'; cfg = SIM_QUALITY[qualityName];
    const [mw, mh] = cfg.map, N = cfg.agents, count = N * N;
    const ppu = mw / WORLD_W, density = count / WORLD_W;
    const depositScale = (REF_DENSITY / density) * (ppu / REF_PPU) ** 2;
    const diffuse = Math.min(0.95, model.diffuse * (ppu / REF_PPU) ** 2);
    const s = { N, count, mw, mh, depositScale, diffuse, ping: 0, apping: 0, owned: [] };
    const own = (kind, o) => { owned[kind].push(o); s.owned.push([kind, o]); return o; };
    s.agents = [0, 1].map(() => own('targets', target(N, N, FLOAT, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })));
    s.trail = [0, 1].map(() => own('targets', target(mw, mh, THREE.HalfFloatType, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping })));
    s.soft = own('targets', target(Math.ceil(mw / 8), Math.ceil(mh / 8), THREE.HalfFloatType, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping }));
    s.probe = own('targets', target(PROBE.w, PROBE.h, THREE.UnsignedByteType));
    const world2 = new THREE.Vector2(WORLD_W, 1);
    s.agentMat = own('materials', material({
      vertexShader: POST_VERT, fragmentShader: AGENT_FRAG,
      uniforms: {
        uAgents: { value: null }, uTrail: { value: null }, uWorld: { value: world2 }, uFrame: { value: 0 },
        uSense: { value: new V4(model.sensorAngle, model.sensorDist, model.turnAngle, model.step) },
        uWeights: { value: new V4(model.foodWeight, model.lightWeight, model.lostThreshold, model.lostMax) },
        uCursor: { value: cursorSim }, uMore: { value: new THREE.Vector3(model.wobble, N, model.foodImmune) }, uMore2: { value: new THREE.Vector2(model.foodStay, model.cloneJitter) }, uForager: { value: model.foragers },
      },
    }));
    s.diffuseMat = own('materials', material({
      vertexShader: POST_VERT, fragmentShader: DIFFUSE_FRAG,
      uniforms: {
        uTrail: { value: null }, uTexel: { value: new THREE.Vector2(1 / mw, 1 / mh) }, uWorld: { value: world2 },
        uDiffuse: { value: new V4(diffuse, model.decay, 0.12, 0.02) }, uCursor: { value: cursorSim },
        uFoods: { value: foodU }, uFoodCount: { value: 0 },
      },
    }));
    s.splatMat = own('materials', material({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { uAgents: { value: null }, uTrail: { value: null }, uWorld: { value: world2 }, uDeposit: { value: new THREE.Vector3(model.deposit * depositScale, model.foodBoost, model.reinforce) }, uReinforce: { value: new THREE.Vector2(model.reinforceScale, model.reinforceCap) } },
    }));
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { pos[i * 3] = ((i % N) + 0.5) / N; pos[i * 3 + 1] = (Math.floor(i / N) + 0.5) / N; }
    const pg = own('geometries', new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(pg, s.splatMat); points.frustumCulled = false;
    s.splatScene = new THREE.Scene(); s.splatScene.add(points);
    s.agentScene = pass(s.agentMat); s.diffuseScene = pass(s.diffuseMat);
    s.softMat = own('materials', material({ vertexShader: POST_VERT, fragmentShader: SOFT_FRAG, uniforms: { uTrail: { value: null }, uTexel: { value: new THREE.Vector2(1 / mw, 1 / mh) } } }));
    s.softScene = pass(s.softMat);
    s.probeMat = own('materials', material({ vertexShader: POST_VERT, fragmentShader: PROBE_FRAG, uniforms: { uSoft: { value: s.soft.texture }, uScale: { value: tune.ks } } }));
    s.probeScene = pass(s.probeMat);
    s.copyMat = own('materials', material({
      vertexShader: POST_VERT, uniforms: { uSrc: { value: null } },
      fragmentShader: 'precision highp float; uniform sampler2D uSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(uSrc, vUv); }',
    }));
    s.copyScene = pass(s.copyMat);
    s.seedTex = own('textures', new THREE.DataTexture(new Float32Array(count * 4), N, N, THREE.RGBAFormat, THREE.FloatType));
    s.seedTex.minFilter = s.seedTex.magFilter = THREE.NearestFilter;
    sim = s;
    seed();
    return s;
  }
  function seed() {
    const s = sim;
    seedAgents(random, s.count, WORLD_W, 1, s.seedTex.image.data);
    s.seedTex.needsUpdate = true;
    s.copyMat.uniforms.uSrc.value = s.seedTex;
    run(s.copyScene, s.agents[0]);
    renderer.setRenderTarget(s.agents[1]); renderer.clear();
    for (const t of s.trail) { renderer.setRenderTarget(t); renderer.clear(); }
    s.ping = 0; s.apping = 0; frame = 0; simSteps = 0;
  }
  function disposeSim() {
    if (!sim) return;
    for (const [kind, o] of sim.owned) { o.dispose(); const list = owned[kind]; const k = list.indexOf(o); if (k >= 0) list.splice(k, 1); }
    sim = null;
  }

  // ---------------------------------------------------------------- one simulation step (1/60 s)
  function step(w) {
    const s = sim;
    const c = w.cursor;
    cursorSim.set(c.x, c.y, tune.photoRadius, c.presence > 0.02 ? c.presence : 0);
    s.diffuseMat.uniforms.uFoodCount.value = w.food.packSources(foodU);
    const cur = s.trail[s.ping], nxt = s.trail[1 - s.ping], ac = s.agents[s.apping], an = s.agents[1 - s.apping];
    // 1. agents sense the map, turn, move
    s.agentMat.uniforms.uAgents.value = ac.texture; s.agentMat.uniforms.uTrail.value = cur.texture; s.agentMat.uniforms.uFrame.value = frame++ & 0xffffff;
    run(s.agentScene, an);
    // 2. the map diffuses and decays into the other buffer; food and light are applied here
    s.diffuseMat.uniforms.uTrail.value = cur.texture;
    run(s.diffuseScene, nxt);
    // 3. every agent deposits (additive points) into the new map
    s.splatMat.uniforms.uAgents.value = an.texture; s.splatMat.uniforms.uTrail.value = cur.texture;
    run(s.splatScene, nxt);
    s.ping = 1 - s.ping; s.apping = 1 - s.apping;
    simSteps++;
  }

  // The coarse map the CPU reads so slugs can steer around the network.
  const probeBuf = new Uint8Array(PROBE.w * PROBE.h * 4);
  let probing = false;
  function fillProbe(w) {
    for (let i = 0; i < PROBE.w * PROBE.h; i++) w.probe.data[i] = probeBuf[i * 4] / 255;
    w.probe.valid = true;
  }
  function renderProbe() {
    const s = sim;
    s.softMat.uniforms.uTrail.value = s.trail[s.ping].texture;
    run(s.softScene, s.soft);
    run(s.probeScene, s.probe);
  }
  function probe(w, sync = false) {
    if (probing) return;
    renderProbe();
    if (sync) { renderer.readRenderTargetPixels(sim.probe, 0, 0, PROBE.w, PROBE.h, probeBuf); fillProbe(w); return; }
    probing = true;
    renderer.readRenderTargetPixelsAsync(sim.probe, 0, 0, PROBE.w, PROBE.h, probeBuf).then(() => { fillProbe(w); }).catch(() => {}).finally(() => { probing = false; });
  }

  function warmup(w, steps = cfg.warmup) {
    for (let i = 0; i < steps; i++) step(w);
    probe(w, true);
  }

  // ---------------------------------------------------------------- the picture
  const plateU = {
    uTrail: { value: null }, uSoft: { value: null }, uView: { value: new V4(WORLD_W / 2, 0.5, WORLD_W / 2, 0.5) }, uWorld: { value: new THREE.Vector2(WORLD_W, 1) },
    uMapSize: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uCursor: { value: cursorView }, uLamp: { value: new V4(0.8, 0.55, 1, 0) },
    uFlakeA: { value: foodA }, uFlakeB: { value: foodB }, uFlakeCount: { value: 0 },
    uTune: { value: new V4(tune.ks, tune.bump, tune.grain, tune.wave) }, uTune2: { value: new V4(tune.flow, tune.glow, tune.shadow, 1) }, uSoftTexel: { value: new THREE.Vector2(1, 1) },
  };
  const plate = pass(material({ vertexShader: POST_VERT, fragmentShader: SCENE_FRAG, uniforms: plateU }));
  const overlay = new THREE.Scene(), topOverlay = new THREE.Scene();
  const shared = { uView: plateU.uView, uCursor: { value: cursorView }, uLamp: plateU.uLamp, uTime: plateU.uTime };
  const premult = { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
  const additive = { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor };
  const addMesh = (geometry, mat, order, scene = overlay) => { owned.geometries.push(geometry); const m = new THREE.Mesh(geometry, mat); m.frustumCulled = false; m.renderOrder = order; scene.add(m); return m; };
  const cornerGeometry = (instanced) => {
    const g = instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };

  // slime trails of the slugs: a strip per slug
  const slugCount = world.slugs.slugs.length, M = SLUG.trailPoints;
  const trailGeo = new THREE.BufferGeometry();
  const trailPos = new Float32Array(slugCount * M * 2 * 3), trailFade = new Float32Array(slugCount * M * 2), trailSide = new Float32Array(slugCount * M * 2);
  const trailIdx = [];
  for (let k = 0; k < slugCount; k++) for (let i = 0; i < M - 1; i++) { const a = (k * M + i) * 2; trailIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  for (let i = 0; i < trailSide.length; i++) trailSide[i] = i % 2 ? 1 : -1;
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('aFade', new THREE.BufferAttribute(trailFade, 1).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('aSide', new THREE.BufferAttribute(trailSide, 1));
  trailGeo.setIndex(trailIdx);
  addMesh(trailGeo, material({ vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, uniforms: shared, ...additive }), 0);
  const trailTmp = new Float32Array(M * 3);

  // slugs: one bounding quad each; the body is evaluated per fragment from a small float texture
  const segs = SLUG.segments;
  const slugData = new Float32Array(segs * slugCount * 4);
  const slugTex = new THREE.DataTexture(slugData, segs, slugCount, THREE.RGBAFormat, THREE.FloatType);
  slugTex.minFilter = slugTex.magFilter = THREE.NearestFilter; slugTex.needsUpdate = true; owned.textures.push(slugTex);
  const slugGeo = cornerGeometry(true);
  const slugBox = new THREE.InstancedBufferAttribute(new Float32Array(slugCount * 4), 4).setUsage(THREE.DynamicDrawUsage);
  slugGeo.setAttribute('aBox', slugBox);
  slugGeo.setAttribute('aId', new THREE.InstancedBufferAttribute(Float32Array.from({ length: slugCount }, (_, i) => i), 1));
  slugGeo.instanceCount = slugCount;
  addMesh(slugGeo, material({ vertexShader: SLUG_VERT, fragmentShader: slugFrag(segs), uniforms: { ...shared, uSlugs: { value: slugTex } }, ...premult }), 1);

  // springtails
  const stCount = world.springtails.springtails.length;
  const stA = new Float32Array(stCount * 4), stB = new Float32Array(stCount * 4);
  const stGeo = cornerGeometry(true);
  const stAttrA = new THREE.InstancedBufferAttribute(stA, 4).setUsage(THREE.DynamicDrawUsage), stAttrB = new THREE.InstancedBufferAttribute(stB, 4).setUsage(THREE.DynamicDrawUsage);
  stGeo.setAttribute('aA', stAttrA); stGeo.setAttribute('aB', stAttrB); stGeo.instanceCount = stCount;
  addMesh(stGeo, material({ vertexShader: SPRING_VERT, fragmentShader: SPRING_FRAG, uniforms: shared, ...premult }), 2);

  // specks
  let speckMesh = null;
  function buildSpecks() {
    if (speckMesh) { topOverlay.remove(speckMesh); speckMesh.geometry.dispose(); }
    const n = cfg.specks, g = cornerGeometry(true), seeds = new Float32Array(n * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4)); g.instanceCount = n;
    speckMesh = addMesh(g, speckMaterial, 3, topOverlay);
  }
  const speckMaterial = material({ vertexShader: SPECK_VERT, fragmentShader: SPECK_FRAG, uniforms: { ...shared, uAspect: { value: 1.78 } }, ...additive });

  // targets that follow the framebuffer
  const size = new THREE.Vector2(1, 1);
  const sceneRT = target(1, 1, THREE.HalfFloatType), dofRT = target(1, 1, THREE.HalfFloatType);
  const LEVELS = 6;
  const downs = Array.from({ length: LEVELS }, () => target(1, 1, THREE.HalfFloatType)), ups = Array.from({ length: LEVELS }, () => target(1, 1, THREE.HalfFloatType));
  const dofMat = material({ vertexShader: POST_VERT, fragmentShader: DOF_FRAG, uniforms: { uSrc: { value: sceneRT.texture }, uTexel: { value: new THREE.Vector2() }, uDof: { value: new V4(0.4, 7, 1.78, 12) }, uFrame: { value: 0 } } });
  const dofScene = pass(dofMat);
  const downMat = material({ vertexShader: POST_VERT, fragmentShader: DOWN_FRAG, uniforms: { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKnee: { value: 0 } } });
  const upMat = material({ vertexShader: POST_VERT, fragmentShader: UP_FRAG, uniforms: { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } } });
  const downScene = pass(downMat), upScene = pass(upMat);
  const outMat = material({
    vertexShader: POST_VERT, fragmentShader: OUTPUT_FRAG,
    uniforms: { uBeauty: { value: dofRT.texture }, uBloom: { value: ups[1].texture }, uOut: { value: new V4(tune.exposure, tune.bloom, tune.fringe, tune.vignette) }, uTint: { value: new THREE.Vector3(1.0, 0.82, 0.5) }, uAspect: { value: 1.78 }, uFrame: { value: 0 } },
  });
  const outScene = pass(outMat);
  const WEIGHTS = [0.6, 0.45, 0.3, 0.16, 0.08];

  function resize(cssW, cssH, w, h) {
    renderer.setSize(w, h, false);
    size.set(w, h);
    sceneRT.setSize(w, h); dofRT.setSize(w, h);
    for (let k = 1; k < LEVELS; k++) {
      const lw = Math.max(1, Math.ceil(w / 2 ** k)), lh = Math.max(1, Math.ceil(h / 2 ** k));
      downs[k].setSize(lw, lh); ups[k].setSize(lw, lh);
    }
    dofMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    dofMat.uniforms.uDof.value.z = w / h; outMat.uniforms.uAspect.value = w / h; speckMaterial.uniforms.uAspect.value = w / h;
    dofMat.uniforms.uDof.value.y = Math.max(2, cfg.dof * h);
  }
  const bloomLevels = () => Math.min(cfg.bloom, LEVELS);

  function configure(name) {
    buildSim(name);
    plateU.uMapSize.value.set(cfg.map[0], cfg.map[1]);
    dofMat.uniforms.uDof.value.w = cfg.dofTaps;
    dofMat.uniforms.uDof.value.y = Math.max(2, cfg.dof * size.y);
    outMat.uniforms.uBloom.value = ups[1].texture;
    buildSpecks();
  }

  // ---------------------------------------------------------------- per frame
  function draw(w, view) {
    const s = sim, t = w.time;
    renderer.info.reset();
    const c = w.cursor;
    cursorView.set(c.x, c.y, c.presence, tune.cursorRadius);
    plateU.uView.value.set(view.cx, view.cy, view.halfW, view.halfH);
    plateU.uTime.value = t;
    plateU.uLamp.value.set(WORLD_W * 0.47 + 0.14 * Math.sin(t * 0.021 + 0.5) + 0.05 * Math.sin(t * 0.063), 0.58 + 0.07 * Math.sin(t * 0.017 + 1.0), 1.0 + 0.035 * Math.sin(t * 0.37) + 0.02 * Math.sin(t * 1.1 + 2), 0);
    plateU.uFlakeCount.value = foodCount = w.food.pack(foodA, foodB);
    plateU.uTune2.value.w = qualityName === 'eco' ? 0 : 1;
    const cur = s.trail[s.ping];
    plateU.uTrail.value = cur.texture;
    s.softMat.uniforms.uTrail.value = cur.texture;
    run(s.softScene, s.soft);
    plateU.uSoft.value = s.soft.texture;
    plateU.uSoftTexel.value.set(1 / s.soft.width, 1 / s.soft.height);
    // CPU-driven things
    w.slugs.pack(slugData); slugTex.needsUpdate = true;
    for (let k = 0; k < slugCount; k++) {
      const sl = w.slugs.slugs[k];
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, rmax = 0;
      for (let i = 0; i < sl.n; i++) { x0 = Math.min(x0, sl.x[i]); x1 = Math.max(x1, sl.x[i]); y0 = Math.min(y0, sl.y[i]); y1 = Math.max(y1, sl.y[i]); rmax = Math.max(rmax, sl.r[i]); }
      const pad = rmax * 2.3 + 0.012;
      slugBox.setXYZW(k, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + pad, (y1 - y0) / 2 + pad);
      // ribbon of slime behind the slug
      const n = w.slugs.trail(sl, trailTmp);
      for (let i = 0; i < M; i++) {
        const j = Math.max(0, i - (M - n)), p = Math.min(n - 1, j);
        const v = (k * M + i) * 2;
        if (n < 2) { for (let q = 0; q < 2; q++) { trailPos[(v + q) * 3] = 0; trailPos[(v + q) * 3 + 1] = 0; trailFade[v + q] = 0; } continue; }
        const x = trailTmp[p * 3], y = trailTmp[p * 3 + 1];
        const pa = Math.max(0, p - 1), pb = Math.min(n - 1, p + 1);
        let dx = trailTmp[pb * 3] - trailTmp[pa * 3], dy = trailTmp[pb * 3 + 1] - trailTmp[pa * 3 + 1];
        const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        const fade = i < M - n ? 0 : trailTmp[p * 3 + 2];
        const wd = 0.0105 * (0.55 + 0.45 * fade);
        trailPos[v * 3] = x - dy * wd; trailPos[v * 3 + 1] = y + dx * wd; trailFade[v] = fade;
        trailPos[(v + 1) * 3] = x + dy * wd; trailPos[(v + 1) * 3 + 1] = y - dx * wd; trailFade[v + 1] = fade;
      }
    }
    slugBox.needsUpdate = true;
    trailGeo.attributes.position.needsUpdate = true; trailGeo.attributes.aFade.needsUpdate = true;
    w.springtails.pack(stA, stB); stAttrA.needsUpdate = true; stAttrB.needsUpdate = true;
    // scene -> HDR target
    run(plate, sceneRT);
    renderer.setRenderTarget(sceneRT); renderer.render(overlay, screenCamera);
    // lens: depth of field with a focus ring that slowly drifts
    dofMat.uniforms.uDof.value.x = 0.36 + 0.09 * Math.sin(t * 0.047 + 0.8) + 0.04 * Math.sin(t * 0.131);
    dofMat.uniforms.uFrame.value = frame & 255;
    run(dofScene, dofRT);
    renderer.setRenderTarget(dofRT); renderer.render(topOverlay, screenCamera);
    // bloom pyramid
    const L = bloomLevels();
    let src = dofRT.texture, bw = size.x, bh = size.y;
    for (let k = 1; k < L; k++) {
      downMat.uniforms.uSrc.value = src; downMat.uniforms.uTexel.value.set(1 / bw, 1 / bh); downMat.uniforms.uKnee.value = k === 1 ? 0.55 : 0;
      run(downScene, downs[k]);
      src = downs[k].texture; bw = downs[k].width; bh = downs[k].height;
    }
    for (let k = L - 2; k >= 1; k--) {
      const coarse = k === L - 2 ? downs[k + 1] : ups[k + 1];
      upMat.uniforms.uSrc.value = coarse.texture; upMat.uniforms.uBase.value = downs[k].texture;
      upMat.uniforms.uTexel.value.set(1 / coarse.width, 1 / coarse.height); upMat.uniforms.uWeight.value = WEIGHTS[k - 1];
      run(upScene, ups[k]);
    }
    outMat.uniforms.uBloom.value = L > 2 ? ups[1].texture : downs[1].texture;
    outMat.uniforms.uFrame.value = frame & 4095;
    run(outScene, null);
  }

  // ---------------------------------------------------------------- housekeeping
  configure(quality);
  function stats() {
    // Debug only (capture): trail statistics read back from the coarse map.
    const s = sim, n = s.soft.width * s.soft.height * 4;
    const buf = new Uint16Array(n);
    renderer.readRenderTargetPixels(s.soft, 0, 0, s.soft.width, s.soft.height, buf);
    let sum = 0, max = 0, food = 0, covered = 0, bad = 0;
    for (let i = 0; i < n; i += 4) { const r = half(buf[i]); if (!Number.isFinite(r)) { bad++; continue; } sum += r; max = Math.max(max, r); food = Math.max(food, half(buf[i + 1])); if (r > tune.ks * 0.25) covered++; }
    return { meanTrail: sum / (n / 4), maxTrail: max, maxFood: food, covered: covered / (n / 4), nonFinite: bad };
  }
  function dispose() {
    disposeSim();
    for (const g of owned.geometries) g.dispose();
    for (const m of owned.materials) m.dispose();
    for (const t of owned.targets) t.dispose();
    for (const t of owned.textures) t.dispose();
    renderer.dispose();
  }
  return {
    renderer, draw, step, warmup, probe, resize, configure, seed, dispose, stats, tune,
    get quality() { return qualityName; }, get config() { return cfg; }, get simSteps() { return simSteps; },
    get info() { return { agents: sim.count, map: [sim.mw, sim.mh], depositScale: sim.depositScale, diffuse: sim.diffuse, float: floatOK, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }; },
  };
}
