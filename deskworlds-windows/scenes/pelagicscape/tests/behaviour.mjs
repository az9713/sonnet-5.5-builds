import assert from 'node:assert/strict';
import { createWorld, FIXED_STEP } from '../src/world.js';
import { insideTank, TANK_Z, tankHalf } from '../src/jelly.js';

const dt = FIXED_STEP;
function run(seed, seconds, { cursor = false } = {}) {
  const w = createWorld({ seed, quality: 'eco' });
  let minGap = Infinity, outside = 0, maxSpeed = 0;
  const modes = new Set();
  const strokes0 = w.jellies.map(j => j.strokes);
  for (let s = 0; s < seconds * 60; s++) {
    if (cursor) { const t = s / 60; w.setCursor(Math.sin(t * 0.7) * 0.8, Math.cos(t * 0.45) * 0.5); }
    w.step(dt);
    for (const j of w.jellies) {
      assert.ok(j.pos.every(Number.isFinite) && j.vel.every(Number.isFinite) && j.axis.every(Number.isFinite), 'finite state');
      assert.ok(Math.abs(Math.hypot(...j.axis) - 1) < 1e-6, 'unit axis');
      if (!insideTank(j.pos, 16 / 9, 1e-6)) outside++;
      maxSpeed = Math.max(maxSpeed, j.speed); modes.add(j.mode);
      for (const c of j.chains) assert.ok(c.chain.pos.every(Number.isFinite));
    }
    for (let a = 0; a < w.jellies.length; a++) for (let b = a + 1; b < w.jellies.length; b++) {
      const A = w.jellies[a], B = w.jellies[b];
      const d = Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1], A.pos[2] - B.pos[2]);
      minGap = Math.min(minGap, d / (A.size + B.size));
    }
  }
  return { w, minGap, outside, maxSpeed, modes, strokes: w.jellies.map((j, i) => j.strokes - strokes0[i]) };
}

// 1. Long run: bounded, finite, never overlapping, and actually behaving (pulsing, moving, changing state).
const a = run(11, 240);
assert.equal(a.outside, 0, 'jellyfish stay inside the tank volume');
assert.ok(a.minGap >= 1.05 - 1e-6, 'jellyfish never overlap: min centre distance / (r1 + r2) = ' + a.minGap);
assert.ok(a.strokes.every(n => n >= 40), 'every jellyfish keeps pulsing: ' + a.strokes);
assert.ok(a.maxSpeed > 0.15 && a.maxSpeed < 3, 'plausible speeds: ' + a.maxSpeed);
assert.ok(a.modes.has('drift') && a.modes.has('travel'), 'the state machine visits drift and travel: ' + [...a.modes]);

// 2. The cursor drives avoid-state and a faster pulse, and still keeps everything inside.
const calm = run(11, 60), poked = run(11, 60, { cursor: true });
assert.equal(poked.outside, 0); assert.ok(poked.minGap >= 1.05 - 1e-6);
assert.ok(poked.modes.has('avoid'), 'cursor makes them avoid');
const total = r => r.strokes.reduce((x, y) => x + y, 0);
assert.ok(total(poked) > total(calm), 'disturbed jellyfish pulse more often: ' + total(poked) + ' vs ' + total(calm));

// 3. Determinism by seed.
const snap = r => JSON.stringify(r.w.diagnostics().jellyPositions);
assert.equal(snap(run(5, 20)), snap(run(5, 20))); assert.notEqual(snap(run(5, 20)), snap(run(6, 20)));

// 4. Each stroke gives a forward impulse along the axis: velocity along the axis jumps during the power stroke, then decays.
{
  const w = createWorld({ seed: 2, quality: 'eco' }), j = w.jellies[1];
  let along = [], strokeAt = -1;
  for (let s = 0; s < 60 * 20; s++) {
    const before = j.strokes; w.step(dt);
    if (j.strokes > before && strokeAt < 0 && s > 120) strokeAt = along.length + 1;
    along.push(j.vel[0] * j.axis[0] + j.vel[1] * j.axis[1] + j.vel[2] * j.axis[2]);
  }
  assert.ok(strokeAt > 0);
  const peak = Math.max(...along.slice(strokeAt, strokeAt + 40)), pre = along[strokeAt - 1];
  assert.ok(peak > pre + 0.03, 'velocity along the bell axis rises over the power stroke: ' + pre + ' -> ' + peak);
}

// 5. The tank and chains: tentacles follow the bell (tips never absurdly far), render buffers fill with finite numbers.
{
  const { w } = run(3, 30, { cursor: true });
  w.fillAll();
  for (const j of w.jellies) { assert.ok(j.nodes.every(Number.isFinite)); }
  for (const c of w.combs) assert.ok(c.nodes.every(Number.isFinite));
  assert.ok(w.plankton.pts.every(Number.isFinite));
  for (const j of w.jellies) for (const c of j.chains) {
    const n = c.chain.n, tip = (n - 1) * 3; const root = c.chain.pos;
    assert.ok(Math.hypot(root[tip] - root[0], root[tip + 1] - root[1], root[tip + 2] - root[2]) <= c.chain.rest * (n - 1) * 1.02);
  }
  const h = tankHalf(8); assert.ok(h.hx > h.hy);
}
console.log('ok behaviour');
