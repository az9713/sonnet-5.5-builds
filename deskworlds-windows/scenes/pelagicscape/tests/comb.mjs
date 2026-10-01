import assert from 'node:assert/strict';
import { platePhase, plateGlint, createComb, stepComb, ROWS, PLATES, LAG_PER_PLATE, BEAT_HZ } from '../src/comb.js';
import { ambientFlow } from '../src/flow.js';
import { randomGenerator } from '../../shared/random.js';

// Phase advances linearly along the row (metachronal wave): constant lag between neighbours, modulo one cycle.
const wrapDiff = (a, b) => { let d = a - b; d -= Math.round(d); return d; };
for (const t of [0, 0.37, 5.9, 123.4]) {
  for (let i = 1; i < PLATES; i++) {
    const d = wrapDiff(platePhase(t, i - 1), platePhase(t, i));
    assert.ok(Math.abs(d - LAG_PER_PLATE) < 1e-9, 'constant lag between plates');
  }
}
// Linear in the plate index (unwrapped) and in time.
const unwrapped = (t, i) => BEAT_HZ * t - i * LAG_PER_PLATE;
for (let i = 0; i < PLATES; i++) assert.ok(Math.abs(wrapDiff(platePhase(2.5, i), unwrapped(2.5, i))) < 1e-9);
// The wave travels toward higher plate indices: plate i+1 repeats plate i's phase one lag later.
{
  const dtLag = LAG_PER_PLATE / BEAT_HZ;
  for (let i = 0; i + 1 < PLATES; i++) assert.ok(Math.abs(wrapDiff(platePhase(3.1, i), platePhase(3.1 + dtLag, i + 1))) < 1e-9);
  const speed = BEAT_HZ / LAG_PER_PLATE;             // plates per second
  assert.ok(speed > 10 && speed < 100, 'wave speed in plates/s ' + speed);
}
// Glint: bounded, bright short power stroke, never negative.
let peak = 0, sum = 0;
for (let i = 0; i < 1000; i++) { const g = plateGlint(i / 1000); assert.ok(g >= 0 && g <= 1 + 1e-9); peak = Math.max(peak, g); sum += g; }
assert.ok(peak > 0.99 && sum / 1000 < 0.5, 'brief glint');
assert.equal(ROWS, 8);

// Swimming: finite, deterministic, bounded by the callback, axis stays unit, and the animal does move.
const run = seed => {
  const rng = randomGenerator(seed), c = createComb({ x: 0, y: 0, z: -7, size: 0.15 }, rng);
  const water = (x, y, z, o) => { ambientFlow(x, y, z, 0, o); o[3] = 0; };
  let travelled = 0, lastp = c.pos.slice();
  const bounds = a => { for (let k = 0; k < 3; k++) { const lo = [-6, -3, -9][k], hi = [6, 3, -5][k]; if (a.pos[k] < lo) { a.pos[k] = lo; a.vel[k] = Math.abs(a.vel[k]); } if (a.pos[k] > hi) { a.pos[k] = hi; a.vel[k] = -Math.abs(a.vel[k]); } } };
  for (let s = 0; s < 60 * 180; s++) {
    stepComb(c, 1 / 60, s / 60, water, bounds);
    assert.ok(c.pos.every(Number.isFinite) && c.axis.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...c.axis) - 1) < 1e-6);
    assert.ok(c.pos[0] >= -6 && c.pos[0] <= 6 && c.pos[2] >= -9 && c.pos[2] <= -5);
    assert.ok(c.ext > 0.05 && c.ext < 1.05, 'tentacle extension in range ' + c.ext);
    travelled += Math.hypot(c.pos[0] - lastp[0], c.pos[1] - lastp[1], c.pos[2] - lastp[2]); lastp = c.pos.slice();
  }
  assert.ok(travelled > 3, 'it swims: ' + travelled);
  return c.pos.slice();
};
assert.deepEqual(run(2), run(2)); assert.notDeepEqual(run(2), run(3));
console.log('ok comb');
