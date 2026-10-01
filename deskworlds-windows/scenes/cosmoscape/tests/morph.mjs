import assert from 'node:assert/strict';
import { hilbertIndex, hilbertCoords, mortonIndex } from '../src/hilbert.js';
import { hilbertOrder, matchByRank, matchWithOrder, matchBalanced, morphPosition, progress, swirl, swirlGLSL, SWIRL_WAVES, wrapDelta } from '../src/morph.js';
import { randomGenerator } from '../../shared/random.js';

const random = randomGenerator(8);

// ---- Hilbert index: a bijection of the lattice onto 0..N-1, adjacent along the curve, inverse round trips.
for (const order of [1, 2, 3, 4, 5]) {
  const side = 1 << order, N = side ** 3, seen = new Uint8Array(N), at = new Array(N);
  for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++) {
    const h = hilbertIndex(x, y, z, order);
    assert.ok(h >= 0 && h < N, `index in range (order ${order})`);
    assert.equal(seen[h], 0, 'no index repeats');
    seen[h] = 1; at[h] = [x, y, z];
    const back = hilbertCoords(h, order);
    assert.deepEqual(back, [x, y, z], 'inverse round trip');
  }
  assert.equal(seen.reduce((a, b) => a + b, 0), N, 'every index used: bijective');
  // Locality: consecutive indices are face neighbours (Manhattan distance exactly 1), the defining Hilbert property.
  for (let h = 0; h + 1 < N; h++) {
    const d = Math.abs(at[h][0] - at[h + 1][0]) + Math.abs(at[h][1] - at[h + 1][1]) + Math.abs(at[h][2] - at[h + 1][2]);
    assert.equal(d, 1, `consecutive Hilbert cells are adjacent (order ${order}, index ${h})`);
  }
}
// Order 10 (the production resolution) stays in 30 bits and still round-trips on random cells.
for (let t = 0; t < 2000; t++) {
  const c = [Math.floor(random() * 1024), Math.floor(random() * 1024), Math.floor(random() * 1024)];
  const h = hilbertIndex(c[0], c[1], c[2], 10);
  assert.ok(h < 2 ** 30);
  assert.deepEqual(hilbertCoords(h, 10), c);
}
// Locality is better than Morton's: the mean spatial jump between consecutive indices of random-offset index pairs.
{
  const order = 5, side = 32, N = side ** 3;
  const stepSum = (curve) => {
    const order2 = new Array(N);
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++) order2[curve(x, y, z)] = [x, y, z];
    let sum = 0, worst = 0;
    for (let i = 0; i + 1 < N; i++) { const d = Math.hypot(order2[i][0] - order2[i + 1][0], order2[i][1] - order2[i + 1][1], order2[i][2] - order2[i + 1][2]); sum += d; worst = Math.max(worst, d); }
    return { mean: sum / (N - 1), worst };
  };
  const hil = stepSum((x, y, z) => hilbertIndex(x, y, z, order)), mor = stepSum((x, y, z) => mortonIndex(x, y, z));
  assert.equal(hil.worst, 1, 'Hilbert never jumps');
  assert.ok(mor.worst > 5 && hil.mean < mor.mean, 'Morton jumps; Hilbert does not');
  // Morton itself is a bijection.
  const seen = new Set();
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) seen.add(mortonIndex(x, y, z));
  assert.equal(seen.size, 512);
}

// ---- Sorting by Hilbert index.
{
  const count = 4000, pos = Float32Array.from({ length: count * 3 }, () => random());
  const order = hilbertOrder(pos, count, 8);
  assert.equal(new Set(order).size, count, 'order is a permutation');
  let prev = -1;
  for (const i of order) {
    const h = hilbertIndex(Math.floor(pos[3 * i] * 256), Math.floor(pos[3 * i + 1] * 256), Math.floor(pos[3 * i + 2] * 256), 8);
    assert.ok(h >= prev, 'keys nondecreasing');
    prev = h;
  }
}

// ---- Matching by rank is a permutation (every target used exactly once) and moves matter far less than a random pairing would.
{
  const count = 20000;
  // Two clustered point sets: the second is the first with every clump displaced by a modest vector and jittered.
  const centres = Array.from({ length: 24 }, () => [random(), random(), random()]);
  const moves = centres.map(() => [(random() - 0.5) * 0.3, (random() - 0.5) * 0.3, (random() - 0.5) * 0.3]);
  const make = shift => {
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const c = Math.floor(random() * centres.length);
      for (let k = 0; k < 3; k++) { const v = centres[c][k] + (shift ? moves[c][k] : 0) + (random() - 0.5) * 0.08; out[3 * i + k] = v - Math.floor(v); }
    }
    return out;
  };
  const a = make(false), b = make(true);
  const dist = p => { let s = 0; for (let i = 0; i < count; i++) { const j = p[i]; for (let k = 0; k < 3; k++) s += Math.abs(wrapDelta(b[3 * j + k] - a[3 * i + k])); } return s / count; };
  const shuffled = Uint32Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const baseline = dist(shuffled);
  const check = (perm, label) => {
    assert.equal(perm.length, count);
    const used = new Uint8Array(count);
    for (const t of perm) { assert.ok(t < count, 'target index in range'); used[t]++; }
    assert.ok(used.every(v => v === 1), `${label}: every target used exactly once`);
    return dist(perm);
  };
  const rank = check(matchByRank(a, b, count, 9), 'Hilbert rank');
  const balanced = check(matchBalanced(a, b, count, 64, 9), 'balanced');
  assert.deepEqual(matchWithOrder(hilbertOrder(a, count, 9), b, count, 9), matchByRank(a, b, count, 9), 'split form agrees');
  assert.ok(rank < baseline, `Hilbert rank pairing beats a random pairing (${rank.toFixed(3)} vs ${baseline.toFixed(3)})`);
  assert.ok(balanced < 0.6 * baseline && balanced < rank, `balanced bisection moves matter far less than a random pairing (${balanced.toFixed(3)} vs ${baseline.toFixed(3)}, Hilbert rank alone ${rank.toFixed(3)})`);
  // Deterministic.
  assert.deepEqual(matchBalanced(a, b, count, 64, 9), matchBalanced(a, b, count, 64, 9));
  // Identical sets match themselves exactly (every point goes to its twin, up to ties at identical cells).
  const same = matchBalanced(a, a, count, 64, 9);
  let moved = 0;
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) moved += Math.abs(a[3 * same[i] + k] - a[3 * i + k]);
  assert.ok(moved / count < 0.02, `a set matched against itself barely moves (${(moved / count).toExponential(2)})`);
}

// ---- Interpolation: exact endpoints, no NaN, shortest way around the box.
{
  const out = [0, 0, 0], scratch = [0, 0, 0];
  let finite = true;
  for (let t = 0; t < 3000; t++) {
    const a = [random() * 2 - 0.5, random() * 2 - 0.5, random() * 2 - 0.5], b = [random(), random(), random()];
    const offset = random(), spread = random(), amp = random() * 0.2, time = random() * 300;
    morphPosition(out, a, b, 0, offset, spread, amp, time, scratch);
    for (let i = 0; i < 3; i++) assert.equal(out[i], a[i], 'm = 0 is exactly the start');
    morphPosition(out, a, b, 1, offset, spread, amp, time, scratch);
    for (let i = 0; i < 3; i++) {
      const d = out[i] - b[i];
      assert.ok(Math.abs(d - Math.round(d)) < 1e-12, `m = 1 is the target modulo the box (${d})`);
    }
    for (const m of [0.1, 0.37, 0.5, 0.83]) {
      morphPosition(out, a, b, m, offset, spread, amp, time, scratch);
      if (!out.every(Number.isFinite)) finite = false;
      // The path never strays more than half a box plus the swirl from the start.
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - a[i]) <= 0.5 + amp * 4 + 1e-9, 'shortest way around');
    }
  }
  assert.ok(finite, 'no NaN or Infinity');
  // Progress: 0 at m = 0 and 1 at m = 1 for every offset and spread, nondecreasing in m, ordered by offset.
  for (let t = 0; t < 400; t++) {
    const offset = random(), spread = random() * 0.9;
    assert.equal(progress(0, offset, spread), 0);
    assert.equal(progress(1, offset, spread), 1);
    let last = 0;
    for (let m = 0; m <= 1; m += 0.02) { const p = progress(m, offset, spread); assert.ok(p >= last - 1e-12 && p >= 0 && p <= 1); last = p; }
    assert.ok(progress(0.4, 0.1, 0.55) >= progress(0.4, 0.9, 0.55), 'the front reaches low-offset particles first');
  }
  // The swirl vanishes at both ends of the transition (a particle's path is straight there), and peaks mid-way.
  const a = [0.2, 0.3, 0.4], b = [0.5, 0.35, 0.3];
  const mid = morphPosition([0, 0, 0], a, b, 0.5, 0, 0, 0.1, 5), straight = [a[0] + 0.5 * (b[0] - a[0]), a[1] + 0.5 * (b[1] - a[1]), a[2] + 0.5 * (b[2] - a[2])];
  assert.ok(Math.hypot(mid[0] - straight[0], mid[1] - straight[1], mid[2] - straight[2]) > 0.02, 'swirl bends the path mid-transition');
  const near0 = morphPosition([0, 0, 0], a, b, 0.001, 0, 0, 0.1, 5);
  assert.ok(Math.hypot(near0[0] - a[0], near0[1] - a[1], near0[2] - a[2]) < 1e-3, 'and not at the start');
}

// ---- The swirl field is divergence-free and periodic.
{
  const h = 1e-4, v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0];
  for (let t = 0; t < 200; t++) {
    const p = [random(), random(), random()], time = random() * 50;
    let div = 0;
    for (let a = 0; a < 3; a++) {
      const hi = p.slice(), lo = p.slice();
      hi[a] += h; lo[a] -= h;
      swirl(v1, hi[0], hi[1], hi[2], time); swirl(v2, lo[0], lo[1], lo[2], time);
      div += (v1[a] - v2[a]) / (2 * h);
    }
    swirl(v0, p[0], p[1], p[2], time);
    assert.ok(Math.abs(div) < 1e-4, `swirl is divergence-free (${div})`);
    swirl(v1, p[0] + 1, p[1] - 2, p[2] + 3, time);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(v1[i] - v0[i]) < 1e-9, 'periodic in the box');
    assert.ok(v0.every(Number.isFinite));
  }
  const glsl = swirlGLSL();
  assert.equal(glsl.split('cos(').length - 1, SWIRL_WAVES.length, 'the shader source is generated from the same wave table');
  for (const w of SWIRL_WAVES) assert.ok(Math.abs(w.e[0] * w.k[0] + w.e[1] * w.k[1] + w.e[2] * w.k[2]) < 1e-12, 'polarisation perpendicular to the wave vector');
}
console.log('ok morph: Hilbert bijective + adjacent + invertible, rank and balanced matching are permutations, interpolation endpoints exact, swirl divergence-free');
