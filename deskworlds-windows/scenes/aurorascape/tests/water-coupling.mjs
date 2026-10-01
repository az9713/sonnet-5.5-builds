import assert from 'node:assert/strict';
import { createWorld, FIXED_STEP, BOUNDS } from '../src/behaviour.js';
import { createWaveSim, SIM } from '../src/wave-sim.js';
import { randomGenerator } from '../../shared/random.js';

// The whales, the cursor and the bubble net drive the water through the same disturbance list the GPU
// receives; replayed on the CPU reference, the surface must stay small, finite and settle when quiet.
for (const seed of [1, 2]) {
  const world = createWorld({ random: randomGenerator(seed), visualRandom: randomGenerator(seed + 7), netAt: 20 });
  const sim = createWaveSim(128);
  let maxH = 0, injected = 0;
  for (let s = 0; s < 60 * 120; s++) {
    // a cursor wanders over the water for part of the run
    if (s > 60 * 30 && s < 60 * 60) world.setCursor(Math.sin(s * 0.004) * 40, -50 - 20 * Math.sin(s * 0.002), 0.1 + 0.2 * Math.abs(Math.sin(s * 0.01)));
    else world.setCursor(null);
    world.step(FIXED_STEP);
    const d = world.disturbances;
    assert.ok(d.count <= SIM.maxDisturbances);
    for (let i = 0; i < d.count; i++) { sim.inject(d.data[i * 4], d.data[i * 4 + 1], d.data[i * 4 + 2], d.data[i * 4 + 3], d.foam[i]); injected++; }
    sim.step();
    if (s % 30 === 0) for (const v of sim.h) { assert.ok(Number.isFinite(v)); maxH = Math.max(maxH, Math.abs(v)); }
  }
  assert.ok(injected > 2000, 'the world stirs the water');
  assert.ok(maxH < 0.6, `the surface stays gentle (max ${maxH.toFixed(3)} m)`);
  assert.ok(maxH > 0.01, 'and it does move');
  // quiet again: it settles
  for (let s = 0; s < 60 * 40; s++) sim.step();
  let rest = 0; for (const v of sim.h) rest = Math.max(rest, Math.abs(v));
  assert.ok(rest < 0.02, `settles when left alone (${rest.toExponential(1)})`);
}
// every disturbance lies in the pool
{
  const world = createWorld({ random: randomGenerator(4), visualRandom: randomGenerator(5), netAt: 10 });
  for (let s = 0; s < 60 * 90; s++) {
    world.step(FIXED_STEP);
    const d = world.disturbances;
    for (let i = 0; i < d.count; i++) {
      const x = d.data[i * 4], z = d.data[i * 4 + 1];
      assert.ok(x > SIM.minX - 30 && x < SIM.minX + SIM.size + 30 && z > SIM.minZ - 30 && z < SIM.minZ + SIM.size + 30, `disturbance at ${x.toFixed(0)}, ${z.toFixed(0)}`);
      assert.ok(Math.abs(d.data[i * 4 + 3]) <= 0.1 && d.foam[i] >= 0 && d.foam[i] <= 1.0001);
    }
  }
  assert.ok(BOUNDS.minX >= SIM.minX && BOUNDS.maxX <= SIM.minX + SIM.size);
}
console.log('ok water-coupling');
