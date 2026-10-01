import assert from 'node:assert/strict';
import { createWorld, tierCounts, COUNTS, FIXED_STEP } from '../src/world.js';
import { activeQuality, QUALITY_PRESETS } from '../../shared/render-policy.js';

// Tier mapping: counts per tier as specified; native on battery is the balanced tier.
assert.deepEqual([COUNTS.eco.plankton, COUNTS.balanced.plankton, COUNTS.detail.plankton, COUNTS.native.plankton], [4000, 12000, 24000, 24000]);
assert.equal(activeQuality('native', true), 'balanced'); assert.equal(activeQuality('native', false), 'native');
assert.equal(tierCounts(activeQuality('native', true)).plankton, 12000);
assert.equal(tierCounts('bogus').plankton, 12000);
assert.ok(QUALITY_PRESETS.native.battery === 'balanced');

const snapshot = w => JSON.stringify([w.jellies.map(j => [j.pos, j.vel, j.axis, j.phase, j.strokes]), w.jellies.map(j => Array.from(j.nodes.slice(0, 48)))]);
const run = (switches, seconds = 14) => {
  const w = createWorld({ seed: 4, quality: 'native' });
  const events = [];
  for (let s = 0; s < seconds * 60; s++) {
    const t = s / 60;
    for (const [at, tier] of switches) if (Math.abs(t - at) < 1e-9 || (s === Math.round(at * 60))) {
      const before = Array.from(w.plankton.pts.slice(0, 4 * 50)), n0 = w.plankton.count, s0 = w.plankton.snow;
      const changed = w.setTier(tier);
      events.push({ tier, changed, n0, s0, n1: w.plankton.count, s1: w.plankton.snow, combs: w.combCount, keptFirst50: Array.from(w.plankton.pts.slice(0, 200)).every((v, i) => v === before[i]) });
    }
    w.step(FIXED_STEP);
  }
  w.fillAll();
  return { w, events };
};

const steady = run([]);
const cycled = run([[3, 'balanced'], [8, 'native'], [11, 'balanced']]);
// Counts follow the tier and surviving particles keep their state.
assert.deepEqual(cycled.events.map(e => [e.n1, e.s1, e.combs]), [[12000, 900, 5], [24000, 1600, 6], [12000, 900, 5]]);
assert.ok(cycled.events.every(e => e.changed && e.keptFirst50), 'state carried across tier changes');
assert.equal(cycled.w.plankton.total, 12000 + 900 + 5 * 0 + cycled.w.jellies.length * 4 * 40);
assert.equal(cycled.w.tier, 'balanced'); assert.equal(steady.w.tier, 'native');
// Same tier again does nothing.
assert.equal(cycled.w.setTier('balanced'), false);
// Jellyfish and their chains are untouched by switching down and up, and the whole thing is deterministic.
assert.equal(snapshot(cycled.w), snapshot(steady.w), 'jellyfish state identical to an uninterrupted run');
assert.equal(snapshot(run([[3, 'balanced'], [8, 'native'], [11, 'balanced']]).w), snapshot(cycled.w));
assert.deepEqual(Array.from(run([[3, 'eco']], 6).w.plankton.pts.slice(0, 400)), Array.from(run([[3, 'eco']], 6).w.plankton.pts.slice(0, 400)));
// Everything finite after the switches, and eco drops to its counts.
assert.ok(cycled.w.plankton.pts.every(Number.isFinite) && cycled.w.plankton.vel.every(Number.isFinite));
const eco = run([[1, 'eco']], 4).w; assert.deepEqual([eco.plankton.count, eco.plankton.snow, eco.combCount], [4000, 350, 4]);
console.log('ok tier');
