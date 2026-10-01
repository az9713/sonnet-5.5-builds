import assert from 'node:assert/strict';
import { createParticles, MIST, BUBBLE, DROP, FOAM } from '../src/particles.js';
import { randomGenerator } from '../../shared/random.js';

const DT = 1 / 60;
const make = (seed = 3, capacity = 600) => createParticles({ capacity, random: randomGenerator(seed) });
const kinds = (p) => { const c = [0, 0, 0, 0]; for (let i = 0; i < p.count; i++) c[p.read(i).kind]++; return c; };

// A blow: the mist climbs three to six metres, widens, drifts downwind, and is gone within seconds.
{
  const p = make();
  p.spout(0, 0, -50, 1, 1);
  let maxY = 0, maxSize = 0, last = 0;
  for (let s = 0; s < 60 * 8; s++) {
    p.step(DT);
    const n = p.fill();
    for (let i = 0; i < n; i++) {
      const [x, y, z, size] = p.posSize.subarray(i * 4, i * 4 + 4), [a, k] = p.params.subarray(i * 4, i * 4 + 2);
      assert.ok([x, y, z, size, a].every(Number.isFinite), 'finite particle state');
      assert.ok(a >= 0 && a <= 1.0001, `alpha ${a}`);
      if (k === MIST) { maxY = Math.max(maxY, y); maxSize = Math.max(maxSize, size); }
    }
    last = n;
  }
  assert.ok(maxY > 3 && maxY < 9, `the spout rises ${maxY.toFixed(1)} m`);
  assert.ok(maxSize > 0.45, 'puffs billow');
  assert.equal(last, 0, 'the mist is gone after 8 s');
}

// Mist is carried downwind.
{
  const p = make(); p.spout(0, 0, 0, 1, 1);
  for (let s = 0; s < 60 * 3; s++) p.step(DT);
  let mx = 0, mz = 0, n = 0;
  for (let i = 0; i < p.count; i++) { const q = p.read(i); if (q.kind === MIST) { mx += q.x; mz += q.z; n++; } }
  assert.ok(n > 10 && mx / n > 0.3 && mz / n < -0.05, `drifts with the breeze (${(mx / n).toFixed(2)}, ${(mz / n).toFixed(2)})`);
}

// Bubbles rise to the surface, turn into foam and report a ripple; drops land and report a ring; spray falls.
{
  const p = make();
  for (let i = 0; i < 40; i++) p.bubble(i * 0.1, -4, 0, 0.2);
  let events = 0, sawFoam = false;
  for (let s = 0; s < 60 * 20; s++) {
    p.step(DT); events += p.eventCount;
    for (let e = 0; e < p.eventCount; e++) { assert.ok(Number.isFinite(p.events[e * 3]) && Number.isFinite(p.events[e * 3 + 1])); }
    p.clearEvents();
    if (kinds(p)[FOAM] > 0) sawFoam = true;
    for (let i = 0; i < p.count; i++) { const q = p.read(i); if (q.kind === BUBBLE) assert.ok(q.y < 0.05, 'a bubble stays under the water'); if (q.kind === FOAM) assert.ok(Math.abs(q.y - 0.04) < 1e-5); }
  }
  assert.ok(sawFoam && events >= 40, `bubbles surfaced (${events} events)`);
  const q = make(); q.splash(0, 0, 1);
  let landed = 0;
  for (let s = 0; s < 60 * 4; s++) { q.step(DT); landed += q.eventCount; q.clearEvents(); }
  assert.ok(landed > 3, `drops land (${landed})`);
  for (let i = 0; i < q.count; i++) assert.ok(q.read(i).kind !== DROP || q.read(i).y > 0);
}

// Capacity is a hard bound and a flood never throws; the same seed gives the same cloud.
{
  const p = make(5, 120);
  for (let k = 0; k < 20; k++) { p.spout(0, 0, 0, 1, 1); p.splash(0, 0, 1); for (let s = 0; s < 5; s++) p.step(DT); }
  assert.ok(p.count <= 120);
  const a = make(8), b = make(8), c = make(9);
  for (const w of [a, b, c]) { w.spout(1, 0, 2, 1, 1); for (let s = 0; s < 90; s++) w.step(DT); w.fill(); }
  assert.deepEqual(Array.from(a.posSize.subarray(0, a.count * 4)), Array.from(b.posSize.subarray(0, b.count * 4)));
  assert.notDeepEqual(Array.from(a.posSize.subarray(0, a.count * 4)), Array.from(c.posSize.subarray(0, c.count * 4)));
}
console.log('ok particles');
