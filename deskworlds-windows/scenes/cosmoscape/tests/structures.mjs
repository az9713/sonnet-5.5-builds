import assert from 'node:assert/strict';
import { generateNeural, generateMycelium, NEURAL } from '../src/structures.js';
import { buildWeb, buildTargets, buildParticles, buildGalaxies, dustIndices, TIERS, REFERENCE_GROWTH } from '../src/particles.js';

const COUNT = 30000;
const occupancy = (pos, count, g = 32) => {
  const occ = new Uint8Array(g ** 3);
  for (let i = 0; i < count; i++) occ[Math.floor(pos[3 * i] * g) + g * (Math.floor(pos[3 * i + 1] * g) + g * Math.floor(pos[3 * i + 2] * g))] = 1;
  return occ.reduce((a, b) => a + b, 0) / g ** 3;
};

for (const [name, make] of [['neural', generateNeural], ['mycelium', generateMycelium]]) {
  const a = make(COUNT, 1), b = make(COUNT, 1), c = make(COUNT, 2);
  assert.equal(a.pos.length, COUNT * 3); assert.equal(a.heat.length, COUNT); assert.equal(a.pulse.length, COUNT);
  assert.ok(a.pos.every(v => Number.isFinite(v) && v >= 0 && v < 1), `${name}: positions finite and inside [0,1)`);
  assert.ok(a.heat.every(v => Number.isFinite(v) && v >= 0 && v <= 1), `${name}: heat in [0,1]`);
  assert.ok(a.pulse.every(v => Number.isFinite(v) && v >= 0), `${name}: pulse coordinate finite and non-negative`);
  assert.deepEqual(a.pos, b.pos, `${name}: deterministic by seed`);
  assert.deepEqual(a.heat, b.heat);
  assert.notDeepEqual(a.pos, c.pos, `${name}: a different seed is a different network`);
  // Not a blob and not noise: far fewer cells occupied than for uniform scatter (which fills ~all of 32^3 with 30k points: 1 - exp(-30000/32768) = 60%).
  const occ = occupancy(a.pos, COUNT);
  assert.ok(occ < 0.45, `${name}: points lie on thin structures (occupancy ${occ.toFixed(3)} of 32^3 cells)`);
  assert.ok(a.tubes > 5000, `${name}: many tubes (${a.tubes})`);
  // Spread through the whole periodic box, not confined to one corner.
  for (let axis = 0; axis < 3; axis++) {
    const hist = new Array(4).fill(0);
    for (let i = 0; i < COUNT; i++) hist[Math.floor(a.pos[3 * i + axis] * 4)]++;
    assert.ok(hist.every(h => h > COUNT * 0.08), `${name}: every quarter of axis ${axis} is populated (${hist.join(',')})`);
  }
}

// ---- Neural specifics: somata are hot and dense, thickness (heat) falls off along dendrites, many neurons.
{
  const n = generateNeural(60000, 3);
  assert.equal(n.somas, NEURAL.neurons, 'all neurons placed');
  const hot = n.heat.filter(h => h > 0.9).length / n.heat.length;
  assert.ok(hot > 0.04 && hot < 0.3, `somata are a distinct hot population (${(hot * 100).toFixed(1)}%)`);
  // Along a dendrite, brightness (thickness) falls with distance from the soma: among thin-process points, heat decreases with path length.
  const bins = new Array(6).fill(0), cnt = new Array(6).fill(0);
  for (let i = 0; i < n.heat.length; i++) {
    const h = n.heat[i];
    if (h > 0.9 || (h > 0.55 && h < 0.62)) continue;       // somata, axon trunks
    const b = Math.min(5, Math.floor(n.pulse[i] / 0.04));
    bins[b] += h; cnt[b]++;
  }
  const mean = bins.map((s, i) => s / Math.max(1, cnt[i]));
  assert.ok(cnt.every(c => c > 50), 'every distance bin has dendrite points');
  assert.ok(mean[0] > mean[2] && mean[2] > mean[4], `dendrites taper: mean heat ${mean.map(v => v.toFixed(2)).join(' > ')}`);
}

// ---- Mycelium specifics: anastomosis loops exist and branching is dense.
{
  const m = generateMycelium(60000, 3);
  assert.ok(m.loops > 100, `hyphae fuse into loops (${m.loops})`);
  assert.ok(m.hyphae > 1000, `branching network (${m.hyphae} hyphae)`);
  const noLoops = generateMycelium(60000, 3, { anastomosis: 0 });
  assert.equal(noLoops.loops, 0);
  assert.ok(m.tubes > noLoops.tubes, 'loops add tubes');
}

// ---- Particles: the full pipeline at the smallest tier. Every target point is used by exactly one particle.
{
  const timings = {};
  const web = buildWeb('eco', 1, timings);
  assert.equal(web.count, TIERS.eco.lattice ** 3);
  assert.equal(web.targetsReady, false);
  for (const _ of buildTargets(web, 1)) { /* run all stages */ }
  assert.equal(web.targetsReady, true);
  const { count } = web;
  for (const name of ['q', 'psi', 'hd', 'ho', 'aRand', 'aNeural', 'aMyc', 'aPulse']) assert.ok(web[name].every(Number.isFinite), `${name} finite`);
  assert.ok(web.q.every(v => v >= 0 && v < 1), 'lattice positions in the box');
  // Permutation check: the multiset of matched neural positions equals the generated neural set.
  const keyOf = (arr, i, stride) => `${arr[stride * i].toFixed(6)},${arr[stride * i + 1].toFixed(6)},${arr[stride * i + 2].toFixed(6)}`;
  const target = web.neural.pos, sets = [['neural', web.aNeural, web.neural.pos], ['mycelium', web.aMyc, web.mycelium.pos]];
  for (const [name, assigned, original] of sets) {
    const counts = new Map();
    for (let i = 0; i < count; i++) counts.set(keyOf(original, i, 3), (counts.get(keyOf(original, i, 3)) || 0) + 1);
    for (let i = 0; i < count; i++) {
      const k = keyOf(assigned, i, 4), c = counts.get(k);
      assert.ok(c > 0, `${name}: a particle holds a point that exists in the target set`);
      counts.set(k, c - 1);
    }
    assert.ok([...counts.values()].every(v => v === 0), `${name}: every target point is used exactly once`);
  }
  // The assignment moves matter coherently: neighbouring particles go to neighbouring places. Mean displacement against a random pairing.
  let moved = 0, random = 0;
  for (let i = 0; i < count; i++) {
    const j = (i * 7919 + 13) % count;
    for (let k = 0; k < 3; k++) {
      const ref = web.q[3 * i + k] + REFERENCE_GROWTH * web.psi[3 * i + k];
      const d = (v) => { const x = v - ref; return Math.abs(x - Math.round(x)); };
      moved += d(web.aNeural[4 * i + k]); random += d(web.aNeural[4 * j + k]);
    }
  }
  assert.ok(moved < 0.6 * random, `matching is coherent (${(moved / count).toFixed(3)} vs ${(random / count).toFixed(3)} for a random pairing)`);
  // Same seed, same particles.
  const again = buildParticles('eco', 1);
  assert.deepEqual(again.aMyc, web.aMyc);
  assert.deepEqual(again.hd, web.hd);
}

// ---- Dust subset and background galaxies.
{
  const idx = dustIndices(10000, 4);
  assert.equal(idx.length, 5000);
  assert.equal(new Set(idx).size, idx.length, 'distinct');
  assert.ok(idx.every(i => i < 10000));
  const first = idx.subarray(0, 1000);
  const mean = first.reduce((a, b) => a + b, 0) / first.length;
  assert.ok(mean > 4000 && mean < 6000, 'any prefix is a uniform sample');
  const g = buildGalaxies(500, 3);
  for (let i = 0; i < 500; i++) assert.ok(Math.abs(Math.hypot(g.dir[3 * i], g.dir[3 * i + 1], g.dir[3 * i + 2]) - 1) < 1e-5, 'unit directions');
  assert.ok(g.shape.every(Number.isFinite) && g.tint.every(v => v >= 0 && v <= 1.0001));
  assert.deepEqual(buildGalaxies(500, 3).dir, g.dir);
}
console.log('ok structures: deterministic, thin structures, tapered dendrites, hot somata, anastomosis loops, every target used exactly once');
