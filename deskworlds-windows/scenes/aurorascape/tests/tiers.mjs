import assert from 'node:assert/strict';
import { TIERS, MAX_LEVELS, tierName, tierFor, tierChanges } from '../src/tiers.js';
import { createWorld, FIXED_STEP } from '../src/behaviour.js';
import { randomGenerator } from '../../shared/random.js';

// Tier selection follows the shared policy: native falls back to balanced on battery, the rest are unchanged.
assert.equal(tierFor('native', false), 'native');
assert.equal(tierFor('native', true), 'balanced');
for (const q of ['eco', 'balanced', 'detail']) { assert.equal(tierFor(q, false), q); assert.equal(tierFor(q, true), q); }
assert.equal(tierFor('nonsense', false), 'balanced');
assert.equal(tierName('nope'), 'balanced');

// The mapping from tier to parameters: every tier is complete, and cost rises with the tier.
const keys = ['steps', 'auroraScale', 'map', 'simN', 'starCell', 'bisect', 'ss', 'taps', 'msaa', 'levels', 'landMax'];
const order = ['eco', 'balanced', 'detail', 'native'];
for (const n of order) for (const k of keys) assert.ok(TIERS[n][k] !== undefined, `${n}.${k}`);
for (let i = 1; i < order.length; i++) {
  const a = TIERS[order[i - 1]], b = TIERS[order[i]];
  assert.ok(b.steps >= a.steps && b.simN >= a.simN && b.map[0] >= a.map[0] && b.auroraScale >= a.auroraScale && b.taps >= a.taps, `${order[i]} costs at least as much as ${order[i - 1]}`);
}
assert.equal(TIERS.native.simN, 512); assert.equal(TIERS.balanced.simN, 256);
assert.deepEqual([TIERS.native.steps, TIERS.balanced.steps], [40, 24]);
assert.deepEqual(TIERS.balanced.map, [512, 288]);
for (const n of order) assert.ok(TIERS[n].levels <= MAX_LEVELS && TIERS[n].simN % 2 === 0);

// What a switch rebuilds: nothing for the same tier; the battery fall-back touches sim, map, aurora, land and msaa.
assert.ok(Object.values(tierChanges('balanced', 'balanced')).every((v) => !v));
const nb = tierChanges('native', 'balanced');
assert.ok(nb.sim && nb.map && nb.aurora && nb.land && nb.msaa && nb.sky && !nb.bloom, JSON.stringify(nb));
const back = tierChanges('balanced', 'native');
assert.deepEqual(Object.keys(back).filter((k) => back[k]), Object.keys(nb).filter((k) => nb[k]), 'symmetric');
assert.ok(tierChanges('balanced', 'eco').bloom, 'eco has a shallower bloom pyramid');

// The world does not depend on the tier: switching tiers mid-run (as the renderer does on a power change)
// leaves whales, particles and time bit-identical to a run that never switches, and stays deterministic.
function run(switches) {
  const w = createWorld({ random: randomGenerator(7), visualRandom: randomGenerator(7 ^ 0x5bd1e995), netAt: null });
  let tier = tierFor('native', false), changes = 0;
  for (let i = 0; i < 60 * 30; i++) {
    if (switches && i % 400 === 100) { const next = tierFor('native', (i / 400 | 0) % 2 === 0); if (next !== tier) { changes++; tier = next; } }
    w.step(FIXED_STEP);
  }
  return { changes, time: w.time, whales: w.whales.map((x) => [x.x, x.y, x.z, x.yaw, x.mode, x.rig.P[3 * 12 + 1]]), particles: w.particles.fill() };
}
const a = run(true), b = run(false), c = run(true);
assert.ok(a.changes >= 3, `tier switched ${a.changes} times`);
assert.equal(a.time, b.time);
assert.deepEqual(a.whales, b.whales, 'whale state is independent of tier switches');
assert.deepEqual(a, c, 'deterministic');
console.log('ok tiers');
