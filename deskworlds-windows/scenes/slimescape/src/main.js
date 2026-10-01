import { QUALITY_PRESETS as presets, qualityName, activeQuality, frameRate, framebufferSize, renderScale } from '../../shared/render-policy.js';
import { installControls, reportSceneError, preferredQuality } from '../../shared/controls.js';
import { createFrameLoop } from '../../shared/frame-loop.js';
import { randomGenerator } from '../../shared/random.js';
import { createView } from './view.js';
import { createWorld, FIXED_STEP } from './world.js';
import { createRenderer, SIM_QUALITY } from './render.js';

const canvas = document.querySelector('#scene'), stage = document.querySelector('#stage'), loading = document.querySelector('#loading');
const params = new URLSearchParams(location.search), isHost = document.documentElement.dataset.motion === 'host';
const capture = params.has('capture');
if (capture) document.body.classList.add('clean', 'capture');
let quality = preferredQuality(params);
let hostRate = isHost ? 0 : 60, onBattery = false, contextLost = false, disposed = false;
let paused = capture || (!isHost && matchMedia('(prefers-reduced-motion: reduce)').matches);
let changeRate = () => {}, changePower = () => {}, feed = () => {};
// Installed before WebGL startup so host rate 0 cannot be lost during initialization.
window.sceneRate = fps => { if (!Number.isFinite(fps)) return; const next = Math.max(0, Math.min(60, fps)); if (next === hostRate) return; hostRate = next; changeRate(); };
window.sceneFeed = () => feed();
window.scenePause = value => { paused = Boolean(value); changeRate(); };
// The Mac host knows the power source; a browser only sometimes does (see getBattery below).
window.scenePower = battery => { const next = Boolean(battery); if (next === onBattery) return; onBattery = next; changePower(); };

// Capture-only tuning: ?m=sa:0.6,so:0.03 overrides model constants, ?t=ks:10 overrides look constants.
const KEYS = { sa: 'sensorAngle', so: 'sensorDist', ra: 'turnAngle', ss: 'step', wob: 'wobble', dep: 'deposit', decay: 'decay', dif: 'diffuse', fw: 'foodWeight', lw: 'lightWeight', lt: 'lostThreshold', lm: 'lostMax', fb: 'foodBoost' };
function overrides(name, map = {}) {
  const out = {};
  for (const part of (params.get(name) || '').split(',')) { const [k, v] = part.split(':'); if (k && Number.isFinite(Number(v))) out[map[k] || k] = Number(v); }
  return out;
}

async function start() {
  // A capture is repeatable; a visit is not.
  const seed = capture ? 1 : Math.floor(Math.random() * 2 ** 32);
  const random = randomGenerator(seed);
  const view = createView();
  view.setAspect((stage.clientWidth / Math.max(1, stage.clientHeight)) || 16 / 9);
  const world = createWorld({ random, bounds: view.bounds(0.09), slugCount: 4, springtailCount: 7 });
  const gpu = createRenderer(canvas, { random: randomGenerator(seed ^ 0x5bd1e995), world, quality: activeQuality(quality, onBattery), overrides: capture ? { model: overrides('m', KEYS), tune: overrides('t') } : {} });
  const { renderer } = gpu;
  let loop = null, accumulator = 0, frames = 0, zeroSize = false, simTick = 0;
  let cpuEMA = 0, slowSamples = 0, autoScale = 1, ratio = 1, simQuality = gpu.quality;
  const running = () => !disposed && !paused && !document.hidden && !contextLost && !zeroSize && hostRate > 0;
  const fps = () => frameRate(quality, hostRate, onBattery);
  const rect = { left: 0, top: 0, width: 1, height: 1 };
  const here = { x: 0, y: 0 };
  const redraw = () => { if (!running()) loop?.invalidate(); };

  function tick() {
    world.step(FIXED_STEP);
    view.update(world.time);
    gpu.step(world);
    if (++simTick % 20 === 0) { world.setBounds(view.bounds(0.09)); gpu.probe(world, capture); }
  }
  function render() {
    if (contextLost || disposed || document.hidden) return;
    gpu.draw(world, view);
    frames++;
    if (!loading.hidden) loading.hidden = true;
  }
  function renderFrame(elapsed) {
    const before = performance.now();
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 6) { tick(); accumulator -= FIXED_STEP; steps++; }
    if (steps === 6) accumulator = 0;
    render();
    if (!running()) return;
    const cost = performance.now() - before;
    cpuEMA = cpuEMA ? cpuEMA * 0.96 + cost * 0.04 : cost;
    // Conservative one-way downshift, never an oscillating up/down resolution loop.
    // CPU render time is only a pressure signal, not a claimed hardware GPU measurement.
    if (cpuEMA > 1000 / fps() * 0.85 || elapsed > 1.65 / fps()) slowSamples++; else slowSamples = Math.max(0, slowSamples - 1);
    if (slowSamples > 80 && autoScale > 0.72 && !capture) { autoScale = Math.max(0.72, autoScale - 0.1); slowSamples = 0; resize(false); }
  }
  let updateControls = () => {};
  function restart() {
    accumulator = 0;
    loop?.setRate(fps());
    loop?.setPaused(paused);
    loop?.setHidden(document.hidden || contextLost || disposed || zeroSize);
    updateControls();
  }
  changeRate = restart;
  // Changing quality rebuilds the colony at the new size and grows it for a moment first.
  function applyQuality() {
    const wanted = activeQuality(quality, onBattery);
    if (wanted === simQuality) return;
    simQuality = wanted; gpu.configure(wanted); gpu.warmup(world);
  }
  changePower = () => { applyQuality(); resize(); restart(); };
  function resize(redrawNow = true) {
    const width = stage.clientWidth, height = stage.clientHeight, active = activeQuality(quality, onBattery), preset = presets[active];
    const wasZeroSize = zeroSize;
    zeroSize = !(width > 0 && height > 0);
    if (zeroSize) { restart(); return; }
    ratio = renderScale(quality, devicePixelRatio, onBattery) * autoScale;
    const { width: w, height: h } = framebufferSize(width, height, ratio, renderer.capabilities.maxTextureSize, preset.pixels);
    ratio = w / width;
    gpu.resize(width, height, w, h);
    view.setAspect(width / height); world.setBounds(view.bounds(0.09));
    if (wasZeroSize) restart();
    if (redrawNow && !document.hidden) render();
  }
  const observer = new ResizeObserver(() => resize());
  observer.observe(stage);
  resize(false);

  // Pointer: the cursor is a lamp. Clicks (browser only) drop an oat flake under it.
  function point(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    view.project((clientX - r.left) / r.width, (clientY - r.top) / r.height, here);
    world.point(here.x, here.y);
    redraw();
  }
  const release = () => { world.release(); redraw(); };
  canvas.addEventListener('pointermove', event => point(event.clientX, event.clientY), { passive: true });
  canvas.addEventListener('pointerdown', event => {
    point(event.clientX, event.clientY);
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (running()) world.food.drop(here.x, here.y);
  }, { passive: true });
  canvas.addEventListener('pointerup', event => { if (event.pointerType !== 'mouse') release(); });
  canvas.addEventListener('pointerleave', release);
  // The Feed button: a pinch of oats on the plate, as a keeper would.
  feed = () => { if (running()) world.food.feedRandom(view.bounds(0.14)); };
  updateControls = installControls({
    stage, isPaused: () => paused, isRunning: running, pause: window.scenePause, feed, quality: () => quality,
    setQuality(value) { quality = qualityName(value); autoScale = 1; applyQuality(); resize(); restart(); },
  });
  document.addEventListener('visibilitychange', () => { release(); if (!document.hidden) { resize(false); if (paused) render(); } restart(); });
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', event => { if (!isHost && event.matches) { paused = true; restart(); } });
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); contextLost = true; restart(); loading.hidden = false; });
  canvas.addEventListener('webglcontextrestored', () => {
    // The colony lived in GPU memory: grow a new one.
    contextLost = false; gpu.configure(simQuality); gpu.warmup(world); resize(false); render(); restart();
  });
  if (navigator.getBattery && !isHost) {
    navigator.getBattery().then(battery => { function update() { onBattery = !battery.charging; changePower(); } battery.addEventListener('chargingchange', update); update(); }).catch(() => {});
  }

  // The colony starts already established, and a few slugs have already left trails.
  gpu.warmup(world, capture && params.has('warm') ? Math.max(0, Number(params.get('warm')) || 0) : undefined);
  world.slugs.relocate(view.bounds(0.09), world.env.field);
  for (let i = 0; i < 60 * 14; i++) { world.step(FIXED_STEP); if (i % 20 === 0) view.update(world.time); }
  // Capture mode advances the actual simulation, then renders the actual WebGL scene.
  const advance = seconds => { for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) tick(); };
  const fraction = name => { const v = (params.get(name) || '').split(',').map(Number); return v.length === 2 && v.every(Number.isFinite) ? v : null; };
  if (capture) {
    if (params.has('feed')) feed = () => world.food.feedRandom(view.bounds(0.14));
    if (params.has('feed')) feed();
    const c = fraction('cursor');
    if (c) { view.project(c[0], c[1], here); world.point(here.x, here.y); }
    advance(Math.min(120, Math.max(0, Number(params.get('time')) || 0)));
    if (params.has('drop')) { const d = fraction('drop'); if (d) { view.project(d[0], d[1], here); world.food.drop(here.x, here.y); advance(Math.min(60, Number(params.get('dropwait')) || 0)); } }
  }
  gpu.probe(world, true);
  render();
  loop = createFrameLoop(renderFrame, { fps: fps(), paused, hidden: document.hidden || contextLost || zeroSize });
  restart();
  const gl = renderer.getContext();
  window.slimeScape = {
    ready: true,
    diagnostics: () => ({
      ...gpu.info, quality: gpu.quality, frames, simSteps: gpu.simSteps, time: world.time, flakes: world.food.flakes.length, slugs: world.slugs.slugs.length, springtails: world.springtails.springtails.length,
      cursorPresence: world.cursor.presence, probeValid: world.probe.valid, pixels: [canvas.width, canvas.height], effectiveFPS: running() ? fps() : 0, renderScale: ratio, cpuFrameEMA: cpuEMA,
      scheduled: loop.state.pending, paused, hostRate, hidden: document.hidden, contextLost, webgl: 'WebGL2', renderer: gl.getParameter(gl.RENDERER),
    }),
    // Client pixel fractions of the canvas (0..1, y from the top); nothing lifts the lamp.
    cursor(x, y) { if (x === undefined) release(); else { const r = canvas.getBoundingClientRect(); point(r.left + x * r.width, r.top + y * r.height); } render(); },
    feed() { world.food.feedRandom(view.bounds(0.14)); render(); },
    drop(x, y) { view.project(x, y, here); world.food.drop(here.x, here.y); render(); },
    stats: () => gpu.stats(),
    pause(value = true) { paused = Boolean(value); restart(); },
    advance(seconds) {
      if (!paused) throw new Error('Pause before advancing deterministic capture time.');
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) throw new RangeError('Advance must be 0-120 seconds.');
      advance(seconds); render();
    },
  };
  window.sceneStats = window.slimeScape.diagnostics;
  if (params.get('diagnostics') === '1') {
    const { installDiagnostics } = await import('../../shared/diagnostics.js');
    installDiagnostics({ renderer, loop, renderFrame, stats: window.sceneStats });
  }
  // Release owned GPU objects and stop callbacks when a page is really discarded.
  // BFCache pages retain resources and restart from their old simulation time.
  addEventListener('pagehide', event => {
    loop.setHidden(true); if (event.persisted) return; disposed = true; loop.dispose(); observer.disconnect(); gpu.dispose();
  });
  addEventListener('pageshow', event => { if (event.persisted) { resize(false); render(); restart(); } });
}
start().catch(reportSceneError);
