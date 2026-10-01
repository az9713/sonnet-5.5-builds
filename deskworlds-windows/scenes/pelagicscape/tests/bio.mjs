import assert from 'node:assert/strict';
import { createDisturbance, createPlankton, THRESHOLD, RISE, REFRACTORY, GROUPS } from '../src/bio.js';
import { ambientFlow } from '../src/flow.js';
import { randomGenerator } from '../../shared/random.js';

const dt = 1 / 60;
const box = (p, kind, rng) => { p[0] = (rng() - 0.5) * 8; p[1] = (rng() - 0.5) * 6; p[2] = -6 - rng() * 3; };
const calm = (x, y, z, o) => { o[0] = o[1] = o[2] = o[3] = 0; };
const noFlow = (x, y, z, t, o) => { o[0] = o[1] = o[2] = 0; };
const make = (seed, count = 600) => createPlankton({ count, snow: 50, rings: 10, random: randomGenerator(seed), spawn: box });

// 1. Calm water stays dark; shear below threshold never flashes, above threshold flashes.
{
  const p = make(1); let max = 0;
  for (let s = 0; s < 600; s++) { p.step(dt, (x, y, z, o) => { o[0] = o[1] = o[2] = 0; o[3] = THRESHOLD * 0.95; }, noFlow, s * dt); }
  for (let i = 0; i < p.count; i++) max = Math.max(max, p.pts[i * 4 + 3]);
  assert.equal(p.stats.flashes, 0); assert.equal(max, 0, 'no light below threshold');
  for (let s = 0; s < 30; s++) p.step(dt, (x, y, z, o) => { o[0] = o[1] = o[2] = 0; o[3] = THRESHOLD * 1.5; }, noFlow, s * dt);
  assert.ok(p.stats.flashes >= p.count * 0.9, 'everything above threshold flashes: ' + p.stats.flashes);
}

// 2. A flash rises in about 100 ms, peaks, then decays; the refractory period blocks a second flash until it has passed.
{
  const p = createPlankton({ count: 1, snow: 0, rings: 0, random: randomGenerator(3), spawn: (q) => { q[0] = 0; q[1] = 0; q[2] = -6; } });
  const strong = (x, y, z, o) => { o[0] = o[1] = o[2] = 0; o[3] = 5; };
  let t = 0, flashTimes = [], last = 0, peak = 0, peakT = 0;
  for (let s = 0; s < 60 * 20; s++) {
    t = s * dt;
    const before = p.stats.flashes;
    p.step(dt, strong, noFlow, t);
    if (p.stats.flashes > before) flashTimes.push(t);
    const e = p.pts[3];
    if (flashTimes.length === 1 && e > peak) { peak = e; peakT = t; }
    assert.ok(e >= 0 && e <= 1.41 && Number.isFinite(e));
  }
  assert.ok(flashTimes.length >= 4, 'it recharges and flashes again');
  for (let i = 1; i < flashTimes.length; i++) assert.ok(flashTimes[i] - flashTimes[i - 1] >= REFRACTORY[0] - 1e-6, 'refractory respected: ' + (flashTimes[i] - flashTimes[i - 1]));
  assert.ok(peak > 0.9, 'bright peak'); assert.ok(peakT - flashTimes[0] < RISE * 2 + dt * GROUPS, 'peak reached within ~100 ms: ' + (peakT - flashTimes[0]));
}

// 3. Energy decays to zero once the stimulus stops.
{
  const p = make(4, 300);
  for (let s = 0; s < 30; s++) p.step(dt, (x, y, z, o) => { o[0] = o[1] = o[2] = 0; o[3] = 6; }, noFlow, s * dt);
  const e0 = p.stats.energy; assert.ok(e0 > 20);
  let prev = Infinity;
  for (let s = 0; s < 60 * 8; s++) { p.step(dt, calm, noFlow, s * dt); if (s > 20 && s % 15 === 0) { assert.ok(p.stats.energy <= prev + 1e-6); prev = p.stats.energy; } }
  assert.ok(p.stats.energy < 1e-3 * e0 || p.stats.flashes > 0, 'decays');
  assert.ok(p.stats.energy < 0.05 * e0, 'energy decayed: ' + p.stats.energy + ' of ' + e0);
}

// 4. Deterministic by seed.
{
  const run = seed => { const d = createDisturbance(); const p = make(seed); const f = (x, y, z, o) => d.sample(x, y, z, o);
    for (let s = 0; s < 300; s++) { d.splat(Math.sin(s * 0.05) * 3, 0, -7, 6, 0, 0, 0.5, 12, dt); d.step(dt); p.step(dt, f, ambientFlow, s * dt); }
    return [Array.from(p.pts.slice(0, 200)), p.stats.flashes]; };
  assert.deepEqual(run(7), run(7)); assert.notDeepEqual(run(7)[0], run(8)[0]);
}

// 5. The disturbance grid: a body moving through the water makes shear around it that decays away; calm cells are zero.
{
  const d = createDisturbance(), o = [0, 0, 0, 0];
  d.sample(0, 0, -7, o); assert.deepEqual(o, [0, 0, 0, 0]);
  for (let s = 0; s < 6; s++) { d.splat(0, 0, -7, 5, 0, 0, 0.5, 12, dt); d.step(dt); }
  let found = 0; for (let x = -2; x <= 2; x += 0.1) { d.sample(x, 0.3, -7, o); found = Math.max(found, o[3]); }
  assert.ok(found > THRESHOLD, 'a fast stirrer shears the water above the threshold: ' + found);
  const slow = createDisturbance();
  for (let s = 0; s < 6; s++) { slow.splat(0, 0, -7, 0.4, 0, 0, 0.5, 12, dt); slow.step(dt); }
  let sm = 0; for (let x = -2; x <= 2; x += 0.1) { slow.sample(x, 0.3, -7, o); sm = Math.max(sm, o[3]); }
  assert.ok(sm < THRESHOLD, 'a slow drift does not: ' + sm);
  for (let s = 0; s < 60 * 4; s++) d.step(dt);
  assert.equal(d.active, 0, 'the wake dies away completely'); d.sample(0, 0.3, -7, o); assert.deepEqual(o, [0, 0, 0, 0]);
  for (const v of [-100, 100]) { d.sample(v, v, v, o); assert.ok(o.every(Number.isFinite)); }
}

// 6. End to end: a stirrer dragged through plankton lights some particles near its path, and only them.
{
  const d = createDisturbance(), p = createPlankton({ count: 3000, snow: 0, rings: 0, random: randomGenerator(9), spawn: (q, k, r) => { q[0] = (r() - 0.5) * 8; q[1] = (r() - 0.5) * 10; q[2] = -7 + (r() - 0.5) * 2; } });
  const f = (x, y, z, o) => d.sample(x, y, z, o);
  for (let s = 0; s < 120; s++) { const x = -3 + s * 0.05; d.splat(x, 0, -7, 6, 0, 0, 0.45, 12, dt); d.step(dt); p.step(dt, f, noFlow, s * dt); }
  assert.ok(p.stats.flashes > 20, 'wake flashes: ' + p.stats.flashes);
  let far = 0; for (let i = 0; i < p.count; i++) if (p.peak[i] > 0 && Math.abs(p.pts[i * 4 + 1]) > 2.5) far++;
  assert.equal(far, 0, 'no flashes far from the path');
}
console.log('ok bio');
