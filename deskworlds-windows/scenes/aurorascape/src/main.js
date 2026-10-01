import { QUALITY_PRESETS as presets, activeQuality, frameRate, framebufferSize, renderScale } from '../../shared/render-policy.js';
import { preferredQuality, reportSceneError } from '../../shared/controls.js';
import { createFrameLoop } from '../../shared/frame-loop.js';
import { randomGenerator } from '../../shared/random.js';
import { createWorld, FIXED_STEP } from './behaviour.js';
import { createRenderer, tierName } from './render.js';

const canvas = document.querySelector('#scene'), stage = document.querySelector('#stage'), loading = document.querySelector('#loading');
const params = new URLSearchParams(location.search), isHost = document.documentElement.dataset.motion === 'host';
const capture = params.has('capture');
let quality = preferredQuality(params);
let hostRate = isHost ? 0 : 60, onBattery = false, contextLost = false, disposed = false;
let paused = capture || (!isHost && matchMedia('(prefers-reduced-motion: reduce)').matches);
let changeRate = () => {};
let changePower = () => {};
// Installed before WebGL startup so host rate 0 cannot be lost during initialization.
window.sceneRate = fps => { if (!Number.isFinite(fps)) return; const next = Math.max(0, Math.min(60, fps)); if (next === hostRate) return; hostRate = next; changeRate(); };
window.scenePause = value => { paused = Boolean(value); changeRate(); };
// The host knows the power source; a browser only sometimes does (see getBattery below).
window.scenePower = battery => { const next = Boolean(battery); if (next === onBattery) return; onBattery = next; changePower(); };

async function start() {
  // A capture is repeatable; a visit is not.
  const seed = capture ? 1 : Math.floor(Math.random() * 2 ** 32);
  const netParam = Number(params.get('net'));
  const world = createWorld({
    random: randomGenerator(seed), visualRandom: randomGenerator(seed ^ 0x5bd1e995),
    netAt: capture && Number.isFinite(netParam) && params.has('net') ? netParam : null,
  });
  const rend = createRenderer(canvas, world, { quality: tierName(activeQuality(quality, false)) });
  const { renderer, resize: sizeTargets, dispose } = rend;
  if (capture && params.has('steps')) rend.setAuroraSteps(Math.min(64, Number(params.get('steps')) || 16));
  if (capture) for (const k of (params.get('hide') || '').split(',')) if (k) rend.hide[k] = true;
  if (capture && params.has('dbg')) rend.setDebug(Number(params.get('dbg')));
  if (capture && params.has('ss')) rend.setLandSamples(Number(params.get('ss')));
  if (capture && params.has('aur')) rend.setAuroraScale(Number(params.get('aur')));
  const camParam = (params.get('cam') || '').split(',').map(Number);
  if (capture && camParam.length >= 6 && camParam.every(Number.isFinite)) rend.setDebugCamera(camParam);
  let loop = null, accumulator = 0, frames = 0, zeroSize = false;
  let cpuEMA = 0, slowSamples = 0, autoScale = 1, ratio = 1;
  const running = () => !disposed && !paused && !document.hidden && !contextLost && !zeroSize && hostRate > 0;
  const fps = () => frameRate(quality, hostRate, onBattery);

  // --- the cursor: a point on the water, with a speed in screen widths per second ---
  const pointer = { x: 0, y: 0, t: 0, speed: 0, inside: false, lastEvent: -1 };
  function point(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
    const now = performance.now() / 1000;
    if (pointer.inside && now > pointer.t) {
      const inst = Math.hypot(fx - pointer.x, (fy - pointer.y) * rect.height / rect.width) / Math.max(now - pointer.t, 0.016);
      pointer.speed += (Math.min(inst, 8) - pointer.speed) * 0.6;
    }
    pointer.x = fx; pointer.y = fy; pointer.t = now; pointer.inside = true;
    const hit = rend.screenToWater(fx, fy);
    world.setCursor(hit.x, hit.z, pointer.speed);
    if (paused) loop?.invalidate();
  }
  const release = () => { pointer.inside = false; pointer.speed = 0; world.setCursor(null); if (paused) loop?.invalidate(); };

  function render() {
    if (contextLost || disposed || document.hidden) return;
    rend.render();
    frames++;
    if (!loading.hidden) loading.hidden = true;
  }
  function simulate() { world.step(FIXED_STEP); rend.simStep(); }
  function renderFrame(elapsed) {
    const before = performance.now();
    // a cursor that stops sending events is a cursor that has stopped moving
    if (pointer.inside && before / 1000 - pointer.t > 0.12) { pointer.speed *= Math.exp(-6 * elapsed); const hit = rend.screenToWater(pointer.x, pointer.y); world.setCursor(hit.x, hit.z, pointer.speed); }
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 6) { simulate(); accumulator -= FIXED_STEP; steps++; }
    if (steps === 6) accumulator = 0;
    render();
    if (!running()) return;
    const cost = performance.now() - before;
    cpuEMA = cpuEMA ? cpuEMA * 0.96 + cost * 0.04 : cost;
    // Conservative one-way downshift, never an oscillating up/down resolution loop.
    if (cpuEMA > 1000 / fps() * 0.85 || elapsed > 1.65 / fps()) slowSamples++; else slowSamples = Math.max(0, slowSamples - 1);
    if (slowSamples > 80 && autoScale > 0.72 && !capture) { autoScale = Math.max(0.72, autoScale - 0.1); slowSamples = 0; resize(false); }
  }
  function restart() {
    accumulator = 0;
    loop?.setRate(fps());
    loop?.setPaused(paused);
    loop?.setHidden(document.hidden || contextLost || disposed || zeroSize);
  }
  changeRate = restart;
  changePower = () => { resize(); restart(); };
  function resize(redrawNow = true) {
    const width = stage.clientWidth, height = stage.clientHeight, preset = presets[activeQuality(quality, onBattery)];
    const wasZeroSize = zeroSize;
    zeroSize = !(width > 0 && height > 0);
    if (zeroSize) { restart(); return; }
    ratio = renderScale(quality, devicePixelRatio, onBattery) * autoScale;
    const { width: w, height: h } = framebufferSize(width, height, ratio, renderer.capabilities.maxTextureSize, preset.pixels);
    ratio = w / width;
    sizeTargets(width, height, w, h);
    if (wasZeroSize) restart();
    if (redrawNow && !document.hidden) render();
  }
  const observer = new ResizeObserver(() => resize());
  observer.observe(stage);
  resize(false);

  canvas.addEventListener('pointermove', event => point(event.clientX, event.clientY), { passive: true });
  canvas.addEventListener('pointerdown', event => point(event.clientX, event.clientY), { passive: true });
  canvas.addEventListener('pointerup', event => { if (event.pointerType !== 'mouse') release(); });
  canvas.addEventListener('pointerleave', release);
  document.addEventListener('keydown', event => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Space') { event.preventDefault(); window.scenePause(!paused); }
    else if (event.key.toLowerCase() === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen?.().catch(() => {}); }
  });
  document.addEventListener('visibilitychange', () => { release(); if (!document.hidden) { resize(false); if (paused) render(); } restart(); });
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', event => { if (!isHost && event.matches) { paused = true; restart(); } });
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); contextLost = true; restart(); loading.hidden = false; });
  canvas.addEventListener('webglcontextrestored', () => { contextLost = false; resize(false); render(); restart(); });
  if (navigator.getBattery && !isHost) {
    navigator.getBattery().then(battery => { function update() { onBattery = !battery.charging; resize(); restart(); } battery.addEventListener('chargingchange', update); update(); }).catch(() => {});
  }

  // Capture mode advances the actual simulation, then renders the actual WebGL scene. Only the last
  // few seconds of water are simulated on the GPU: older ripples have long since died away.
  const WATER_WINDOW = 7;
  const advance = seconds => {
    const n = Math.round(seconds / FIXED_STEP), gpuFrom = n - Math.round(WATER_WINDOW / FIXED_STEP);
    for (let i = 0; i < n; i++) { world.step(FIXED_STEP); if (i >= gpuFrom) rend.simStep(); }
  };
  // A pointer path in canvas fractions, for stills: the cursor glides to (x, y), then rests there.
  function cursorSequence(x, y, seconds = 2.6) {
    const n = Math.round(seconds / FIXED_STEP), travel = Math.round(n * 0.55);
    for (let i = 0; i < n; i++) {
      const u = Math.min(1, i / travel), e = u * u * (3 - 2 * u);
      const hit = rend.screenToWater(x - 0.16 * (1 - e), y + 0.03 * (1 - e));
      world.setCursor(hit.x, hit.z, i < travel ? 0.28 : 0.02);
      simulate();
    }
  }
  const cursorParam = (params.get('cursor') || '').split(',').map(Number);
  const hasCursor = capture && cursorParam.length === 2 && cursorParam.every(Number.isFinite);
  if (capture) {
    const total = Math.min(120, Math.max(0, Number(params.get('time')) || 0));
    advance(hasCursor ? Math.max(0, total - 2.6) : total);
    if (hasCursor) cursorSequence(cursorParam[0], cursorParam[1]);
  }
  render();
  loop = createFrameLoop(renderFrame, { fps: fps(), paused, hidden: document.hidden || contextLost || zeroSize });
  restart();
  const gl = renderer.getContext();
  const aurora = window.aurora = {
    ready: true,
    diagnostics: () => ({
      ...world.diagnostics(), frames, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      pixels: [canvas.width, canvas.height], quality, tier: rend.tier, effectiveFPS: running() ? fps() : 0, renderScale: ratio, cpuFrameEMA: cpuEMA,
      paused, hostRate, hidden: document.hidden, contextLost, webgl: 'WebGL2', renderer: gl.getParameter(gl.RENDERER),
    }),
    // Client-independent pointer: canvas fractions (x right, y down), or nothing to lift the cursor.
    cursor(x, y) {
      if (x === undefined) { release(); render(); return; }
      const rect = canvas.getBoundingClientRect();
      point(rect.left + x * rect.width, rect.top + y * rect.height);
      render();
    },
    // Glide the cursor to (x, y) over `seconds` of simulated time (paused captures).
    glide(x, y, seconds = 2.6) { if (!paused) throw new Error('Pause before gliding.'); cursorSequence(x, y, seconds); render(); },
    pause(value = true) { paused = Boolean(value); restart(); },
    advance(seconds) {
      if (!paused) throw new Error('Pause before advancing deterministic capture time.');
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) throw new RangeError('Advance must be 0–120 seconds.');
      advance(seconds); render();
    },
    world,
  };
  window.sceneStats = aurora.diagnostics;
  if (params.get('diagnostics') === '1') {
    const { installDiagnostics } = await import('../../shared/diagnostics.js');
    installDiagnostics({ renderer, loop, renderFrame, stats: window.sceneStats });
  }
  // Release owned GPU objects and stop callbacks when a page is really discarded.
  // BFCache pages retain resources and restart from their old simulation time.
  addEventListener('pagehide', event => {
    loop.setHidden(true); if (event.persisted) return; disposed = true; loop.dispose(); observer.disconnect(); dispose();
  });
  addEventListener('pageshow', event => { if (event.persisted) { resize(false); render(); restart(); } });
}
start().catch(reportSceneError);
