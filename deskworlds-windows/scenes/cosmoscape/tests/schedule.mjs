import assert from 'node:assert/strict';
import { SEGMENTS, CYCLE, GROWTH, stateAt, growthAt, timeForPhase, stateForPhase, phaseNames, STRUCTURE } from '../src/schedule.js';
import { cameraParams, cameraPose, SPEED } from '../src/camera.js';
import { createSim, FIXED_STEP } from '../src/sim.js';

// ---- The cycle: web 80, morph 20, neural 40, morph 20, mycelium 40, morph 20 = 220 s, in that order.
assert.deepEqual(phaseNames(), ['web', 'toNeural', 'neural', 'toMycelium', 'mycelium', 'toWeb']);
assert.equal(CYCLE, 220);
assert.ok(SEGMENTS[0].dur >= 60 && SEGMENTS[0].dur <= 90, 'web phase is 60-90 s');
assert.ok(SEGMENTS[1].dur === 20 && SEGMENTS[2].dur >= 30 && SEGMENTS[4].dur >= 30, 'morphs ~20 s, structures ~40 s');
{
  // Which segment, where.
  assert.equal(stateAt(0).name, 'web');
  assert.equal(stateAt(79.99).name, 'web');
  assert.equal(stateAt(80).name, 'toNeural');
  assert.equal(stateAt(100).name, 'neural');
  assert.equal(stateAt(140).name, 'toMycelium');
  assert.equal(stateAt(160).name, 'mycelium');
  assert.equal(stateAt(200).name, 'toWeb');
  assert.equal(stateAt(219.99).name, 'toWeb');
  assert.equal(stateAt(220).name, 'web', 'the cycle repeats');
  assert.equal(stateAt(-1).name, 'toWeb', 'negative times wrap');
  for (const t of [0, 13.7, 85, 101, 145, 170, 205]) {
    const a = stateAt(t), b = stateAt(t + CYCLE), c = stateAt(t + 7 * CYCLE);
    assert.equal(a.name, b.name); assert.ok(Math.abs(a.m - b.m) < 1e-9 && Math.abs(a.growth - c.growth) < 1e-9, 'periodic');
  }
  // Structures blended: web -> neural -> mycelium -> web.
  const pairs = SEGMENTS.filter(s => s.from !== s.to).map(s => [s.from, s.to]);
  assert.deepEqual(pairs, [[STRUCTURE.web, STRUCTURE.neural], [STRUCTURE.neural, STRUCTURE.mycelium], [STRUCTURE.mycelium, STRUCTURE.web]]);
}

// ---- Continuity: sampled finely over three cycles, blend weights sum to 1, never jump, and the web's growth factor is
// continuous wherever the web is visible (the reset to the early value hides inside the morph, while its weight is 0).
{
  const dt = 0.01;
  let prev = null, maxWeightStep = 0, maxGrowthStep = 0, resets = 0;
  for (let t = 0; t < CYCLE * 3; t += dt) {
    const s = stateAt(t);
    assert.ok(Math.abs(s.weights[0] + s.weights[1] + s.weights[2] - 1) < 1e-9, 'weights sum to 1');
    assert.ok(s.weights.every(w => w >= -1e-12 && w <= 1 + 1e-12), 'weights in [0,1]');
    assert.ok(s.m >= 0 && s.m <= 1 && s.u >= 0 && s.u <= 1, 'progress in range');
    assert.ok(Number.isFinite(s.growth) && s.growth >= GROWTH.early - 1e-9 && s.growth <= GROWTH.late + 1e-9, 'growth within bounds');
    if (prev) {
      for (let i = 0; i < 3; i++) maxWeightStep = Math.max(maxWeightStep, Math.abs(s.weights[i] - prev.weights[i]));
      if (s.weights[0] > 0 || prev.weights[0] > 0) maxGrowthStep = Math.max(maxGrowthStep, Math.abs(s.growth - prev.growth));
      else if (Math.abs(s.growth - prev.growth) > 0.5) resets++;
    }
    prev = s;
  }
  assert.ok(maxWeightStep < 1e-3, `blend weights move smoothly (largest step ${maxWeightStep})`);
  assert.ok(maxGrowthStep < 1e-3, `web growth is continuous while the web is visible (largest step ${maxGrowthStep})`);
  assert.equal(resets, 3, 'the growth factor resets exactly once per cycle, while the web has zero weight');
  // Boundary values.
  assert.ok(Math.abs(growthAt(0) - GROWTH.early) < 1e-12, 'a new web starts at the early growth');
  assert.ok(Math.abs(growthAt(79.999) - GROWTH.late) < 1e-3, 'and ends at the late one');
  assert.ok(Math.abs(growthAt(90) - GROWTH.late) < 1e-12, 'held while it dissolves');
  assert.ok(Math.abs(growthAt(210) - GROWTH.early) < 1e-12, 'already reset by the time it re-forms');
  let last = -1;
  for (let t = 0; t < 80; t += 0.5) { const g = growthAt(t); assert.ok(g >= last, 'growth increases through the web phase'); last = g; }
}

// ---- Frozen phases for screenshots.
{
  assert.equal(timeForPhase('web', 0), 0);
  assert.equal(timeForPhase('neural', 0.5), 100 + 20);
  assert.equal(timeForPhase('MYCELIUM', 1), 200);
  assert.equal(timeForPhase('nonsense', 0.5), null);
  const s = stateForPhase('toMycelium', 0.5);
  assert.ok(s.from === 1 && s.to === 2 && Math.abs(s.m - 0.5) < 1e-9);
  assert.equal(stateForPhase('web', 1).name === 'web' || stateForPhase('web', 1).name === 'toNeural', true);
  const sim = createSim();
  sim.force('neural', 0.25);
  assert.equal(sim.cycle().name, 'neural');
  sim.force(null);
  assert.equal(sim.cycle().name, 'web');
}

// ---- Camera: smooth, bounded speed, valid orthonormal basis, never repeating.
{
  const params = cameraParams(1), a = cameraPose(0, params), b = { pos: [0, 0, 0], fwd: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0], focus: 0 };
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  let maxSpeed = 0, maxTurn = 0, prevPos = null, prevFwd = null, minFocus = 9, maxFocus = 0;
  for (let t = 0; t < 600; t += 0.05) {
    const p = cameraPose(t, params, b);
    assert.ok([...p.pos, ...p.fwd, ...p.up, ...p.right, p.focus].every(Number.isFinite));
    assert.ok(Math.abs(dot(p.fwd, p.fwd) - 1) < 1e-9 && Math.abs(dot(p.up, p.up) - 1) < 1e-9 && Math.abs(dot(p.right, p.right) - 1) < 1e-9, 'unit vectors');
    assert.ok(Math.abs(dot(p.fwd, p.up)) < 1e-9 && Math.abs(dot(p.fwd, p.right)) < 1e-9 && Math.abs(dot(p.up, p.right)) < 1e-9, 'orthogonal');
    minFocus = Math.min(minFocus, p.focus); maxFocus = Math.max(maxFocus, p.focus);
    if (prevPos) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.pos[0] - prevPos[0], p.pos[1] - prevPos[1], p.pos[2] - prevPos[2]) / 0.05);
      maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, dot(p.fwd, prevFwd))) / 0.05);
    }
    prevPos = p.pos.slice(); prevFwd = p.fwd.slice();
  }
  assert.ok(maxSpeed < 0.02 && maxSpeed > SPEED * 0.3, `slow drift (max ${maxSpeed.toFixed(4)} box/s)`);
  assert.ok(maxTurn < 0.06, `slow rotation (max ${maxTurn.toFixed(4)} rad/s)`);
  assert.ok(minFocus > 0.1 && maxFocus < 0.35 && maxFocus - minFocus > 0.05, 'focus racks within a sensible range');
  // Never repeats exactly: poses a cycle, two cycles, or any whole number of the component periods apart differ.
  const key = t => { const p = cameraPose(t, params, { pos: [0, 0, 0], fwd: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0], focus: 0 }); return [...p.pos, ...p.fwd]; };
  const k0 = key(50);
  for (const shift of [CYCLE, 2 * CYCLE, 173, 173 * 2, 131 * 3, 1000, 5 * 173 * 131]) {
    const k1 = key(50 + shift);
    const d = Math.hypot(...k0.map((v, i) => v - k1[i]));
    assert.ok(d > 0.01, `the pose at t+${shift} differs (${d.toFixed(4)})`);
  }
  // A different seed starts somewhere else.
  assert.notDeepEqual(cameraPose(0, cameraParams(2)).pos, a.pos);
  assert.deepEqual(cameraPose(10, cameraParams(1)).pos, cameraPose(10, cameraParams(1)).pos, 'deterministic');
}

// ---- The cursor: a critically damped spring with eased lens and pull.
{
  const sim = createSim(), s = sim.state;
  assert.equal(s.lens, 0);
  sim.cursor(0.3, 0.6);
  assert.deepEqual([s.x, s.y], [0.3, 0.6], 'first contact places the mass without lag');
  sim.cursor(0.8, 0.2);
  let overshoot = 0, lastX = s.x, monotone = true;
  for (let i = 0; i < 360; i++) {
    sim.step(FIXED_STEP);
    if (s.x < lastX - 1e-12) monotone = false;
    lastX = s.x; overshoot = Math.max(overshoot, s.x - 0.8);
  }
  assert.ok(Math.abs(s.x - 0.8) < 1e-3 && Math.abs(s.y - 0.2) < 1e-3, 'spring settles on the target');
  assert.ok(monotone && overshoot < 1e-3, 'critically damped: no overshoot');
  assert.ok(s.lens > 0.99 && s.pull > 0.95, `lens and pull ease in (${s.lens.toFixed(3)}, ${s.pull.toFixed(3)})`);
  sim.cursor(null);
  let t = 0;
  while (s.lens > 0.5 && t < 10) { sim.step(FIXED_STEP); t += FIXED_STEP; }
  assert.ok(t > 0.2 && t < 1.5, `the lens fades over about a second (half-way at ${t.toFixed(2)} s)`);
  for (let i = 0; i < 60 * 12; i++) sim.step(FIXED_STEP);
  assert.equal(s.lens, 0); assert.equal(s.pull, 0);
  assert.ok(Math.abs(s.time - (360 + 12 * 60) * FIXED_STEP - t) < 1e-9, 'time is the sum of fixed steps');
  // Deterministic.
  const run = () => { const q = createSim(); q.cursor(0.2, 0.9); for (let i = 0; i < 100; i++) { if (i === 30) q.cursor(0.7, 0.1); q.step(FIXED_STEP); } return [q.state.x, q.state.y, q.state.lens]; };
  assert.deepEqual(run(), run());
}
console.log('ok schedule: cycle order and timing, continuous weights and growth, growth reset hidden in the morph, camera smooth and non-repeating, cursor spring');
