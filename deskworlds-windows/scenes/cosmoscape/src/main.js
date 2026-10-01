import { QUALITY_PRESETS as presets, activeQuality, frameRate, framebufferSize, renderScale } from '../../shared/render-policy.js';
import { preferredQuality, reportSceneError } from '../../shared/controls.js';
import { createFrameLoop } from '../../shared/frame-loop.js';
import { buildWeb, buildTargets } from './particles.js';
import { createSim, FIXED_STEP } from './sim.js';
import { cameraParams, cameraPose } from './camera.js';
import { SEGMENTS, CYCLE, phaseNames } from './schedule.js';
import { createRenderer } from './render.js';

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
window.scenePower = battery => { const next = Boolean(battery); if (next === onBattery) return; onBattery = next; changePower(); };

// ?look=gain:30,size:0.4 overrides tuning constants (development aid).
function lookOverrides() {
  const out = {};
  for (const part of (params.get('look') || '').split(',')) { const [k, v] = part.split(':'); if (k && Number.isFinite(Number(v))) out[k] = Number(v); }
  return out;
}

async function start() {
  // A capture is repeatable; a visit is not.
  const seed = capture ? 1 : Math.floor(Math.random() * 2 ** 32);
  const startedAt = performance.now();
  const timings = {};
  // The lattice size is fixed by the quality chosen at load (eco: 48^3 particles, else 64^3).
  // Stage 1 is all the first frame needs. The neural network and mycelium are generated after it (see below): nothing
  // asks for them until the web has run its first 80 s.
  const data = buildWeb(quality === 'eco' ? 'eco' : 'balanced', seed, timings);
  timings.firstFrame = performance.now() - startedAt;
  // A visit starts a little way into the web's growth, where it is already structured; a capture starts at the very beginning.
  const sim = createSim({ cycleOffset: capture ? 0 : 14 });
  const camParams = cameraParams(seed);
  const pose = cameraPose(0, camParams), startPose = cameraPose(0, camParams);
  const { renderer, camera, render: draw, resize: sizeTargets, setTier, targetsChanged, dispose, info } = createRenderer(canvas, data, activeQuality(quality, onBattery), lookOverrides());
  let loop = null, accumulator = 0, frames = 0, zeroSize = false, growthOverride = null;
  let cpuEMA = 0, slowSamples = 0, autoScale = 1, ratio = 1;
  const frame = { pose, cycle: null, time: 0, lens: 0, pull: 0, cursorX: 0.5, cursorY: 0.5, frontCenter: [0, 0, 0] };
  const running = () => !disposed && !paused && !document.hidden && !contextLost && !zeroSize && hostRate > 0;
  const fps = () => frameRate(quality, hostRate, onBattery);

  // The cursor is a point mass: it bends light around it and leans nearby matter toward its ray.
  function point(x, y) {
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    sim.cursor((x - rect.left) / rect.width, (y - rect.top) / rect.height, paused);
    if (paused) loop?.invalidate();
  }
  const release = () => { sim.cursor(null, null, paused); if (paused) loop?.invalidate(); };

  function prepare() {
    const st = sim.state, cyc = sim.cycle();
    if (growthOverride !== null) cyc.growth = growthOverride;
    // Until the targets exist the web simply stays itself.
    if (!data.targetsReady && (cyc.from !== 0 || cyc.to !== 0)) { cyc.from = cyc.to = 0; cyc.m = 0; }
    frame.cycle = cyc; frame.time = st.time;
    cameraPose(st.time, camParams, pose);
    // The transition front starts a little ahead of where the camera was looking when the morph began.
    const segment = SEGMENTS[cyc.index].dur, begin = st.time - cyc.u * segment;   // the clock time when this segment began
    cameraPose(begin, camParams, startPose);
    for (let i = 0; i < 3; i++) frame.frontCenter[i] = startPose.pos[i] + startPose.fwd[i] * 0.22;
    frame.lens = st.lens; frame.pull = st.pull; frame.cursorX = st.x; frame.cursorY = st.y;
  }
  function render() {
    if (contextLost || disposed || document.hidden) return;
    prepare();
    draw(frame);
    frames++;
    if (!loading.hidden) loading.hidden = true;
  }
  function renderFrame(elapsed) {
    const before = performance.now();
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 6) { sim.step(FIXED_STEP); accumulator -= FIXED_STEP; steps++; }
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
  changePower = () => { setTier(activeQuality(quality, onBattery)); resize(); restart(); };
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
  setTier(activeQuality(quality, onBattery));
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
    navigator.getBattery().then(battery => { function update() { onBattery = !battery.charging; setTier(activeQuality(quality, onBattery)); resize(); restart(); } battery.addEventListener('chargingchange', update); update(); }).catch(() => {});
  }

  // Capture mode advances the actual simulation, then renders the actual WebGL scene. The simulation is only a clock
  // and a cursor spring, so jumping ahead is exact and cheap.
  const advance = seconds => { for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) sim.step(FIXED_STEP); };
  const setPhase = (name, u = 0) => {
    if (name === null || name === undefined || name === 'auto') { sim.force(null); return true; }
    if (!phaseNames().some(n => n.toLowerCase() === String(name).toLowerCase())) return false;
    sim.force(phaseNames().find(n => n.toLowerCase() === String(name).toLowerCase()), Math.min(1, Math.max(0, Number(u) || 0)));
    return true;
  };
  if (params.has('phase')) setPhase(params.get('phase'), Number(params.get('t')));
  if (params.has('D')) growthOverride = Number(params.get('D'));
  const cursorParam = (params.get('cursor') || '').split(',').map(Number);
  if (capture && cursorParam.length === 2 && cursorParam.every(Number.isFinite)) sim.cursor(cursorParam[0], cursorParam[1], true);
  if (capture) {
    // A capture is deterministic and complete: build the targets before the first frame.
    for (const _ of buildTargets(data, seed)) { /* run to the end */ }
    targetsChanged();
    timings.total = performance.now() - startedAt;
    advance(Math.min(120, Math.max(0, Number(params.get('time')) || 0)));
  }
  render();
  loop = createFrameLoop(renderFrame, { fps: fps(), paused, hidden: document.hidden || contextLost || zeroSize });
  restart();
  const gl = renderer.getContext();
  window.cosmicWeb = {
    ready: true,
    diagnostics: () => {
      const c = frame.cycle || sim.cycle();
      return {
        phase: c.name, phaseProgress: c.u, cycleTime: c.cycleTime, cycleLength: CYCLE, growth: c.growth, from: c.from, to: c.to, morph: c.m,
        particles: data.count, targetsReady: data.targetsReady, sigma: data.sigma, lens: sim.state.lens, pull: sim.state.pull, simTime: sim.state.time,
        startupMs: { ...timings }, frames, drawCalls: renderer.info.render.calls, points: renderer.info.render.points, maxPointSize: info.maxPoint, hdr: info.hdrType,
        pixels: [canvas.width, canvas.height], quality, effectiveFPS: running() ? fps() : 0, renderScale: ratio, cpuFrameEMA: cpuEMA,
        paused, hostRate, hidden: document.hidden, contextLost, webgl: 'WebGL2', renderer: gl.getParameter(gl.RENDERER),
      };
    },
    // Freeze a phase: web, neural, mycelium, toNeural, toMycelium, toWeb, with progress 0..1 (null/'auto' resumes the cycle).
    setPhase(name, u) { const ok = setPhase(name, u); render(); return ok; },
    // Client pixel fractions of the canvas, or nothing to lift the cursor.
    cursor(x, y) { if (x === undefined) release(); else { const rect = canvas.getBoundingClientRect(); point(rect.left + x * rect.width, rect.top + y * rect.height); } render(); },
    setGrowth(value) { growthOverride = value === null || value === undefined ? null : Number(value); render(); },
    pause(value = true) { paused = Boolean(value); restart(); },
    advance(seconds) {
      if (!paused) throw new Error('Pause before advancing deterministic capture time.');
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) throw new RangeError('Advance must be 0–120 seconds.');
      advance(seconds); render();
    },
  };
  window.sceneStats = window.cosmicWeb.diagnostics;
  if (!capture) buildInBackground();
  // Generate the targets in pieces between frames so no single hitch is longer than the biggest piece.
  async function buildInBackground() {
    const stages = buildTargets(data, seed);
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (disposed) return;
      if (stages.next().done) break;
    }
    targetsChanged();
    timings.total = performance.now() - startedAt;
    if (paused) loop?.invalidate();
  }
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
