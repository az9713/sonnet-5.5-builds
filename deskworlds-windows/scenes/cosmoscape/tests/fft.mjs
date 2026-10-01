import assert from 'node:assert/strict';
import { fft1d, createFFT3D, createPlan } from '../src/fft.js';
import { randomGenerator } from '../../shared/random.js';

const random = randomGenerator(11);
const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// Round trip in one dimension within 1e-9, for several sizes.
for (const n of [2, 4, 8, 64, 256]) {
  const re = Float64Array.from({ length: n }, () => random() - 0.5), im = Float64Array.from({ length: n }, () => random() - 0.5);
  const r0 = re.slice(), i0 = im.slice();
  fft1d(re, im, false);
  fft1d(re, im, true);
  assert.ok(maxAbs(re, r0) < 1e-9 && maxAbs(im, i0) < 1e-9, `1D round trip, n=${n}`);
}

// Parseval: sum |x|^2 = (1/n) sum |X|^2.
{
  const n = 128, re = Float64Array.from({ length: n }, () => random() - 0.5), im = Float64Array.from({ length: n }, () => random() - 0.5);
  let e0 = 0; for (let i = 0; i < n; i++) e0 += re[i] * re[i] + im[i] * im[i];
  fft1d(re, im, false);
  let e1 = 0; for (let i = 0; i < n; i++) e1 += re[i] * re[i] + im[i] * im[i];
  assert.ok(Math.abs(e0 - e1 / n) < 1e-9 * e0, 'Parseval in 1D');
}

// Known inputs: a delta transforms to a constant, a shifted delta to a pure phase ramp, a cosine to two spikes.
{
  const n = 32, re = new Float64Array(n), im = new Float64Array(n);
  re[0] = 1;
  fft1d(re, im, false);
  assert.ok(re.every(v => Math.abs(v - 1) < 1e-12) && im.every(v => Math.abs(v) < 1e-12), 'delta -> constant');
  const a = new Float64Array(n), b = new Float64Array(n);
  a[3] = 1;
  fft1d(a, b, false);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(a[k] - Math.cos(-2 * Math.PI * 3 * k / n)) < 1e-12 && Math.abs(b[k] - Math.sin(-2 * Math.PI * 3 * k / n)) < 1e-12, 'shifted delta -> phase ramp');
  }
  const c = Float64Array.from({ length: n }, (_, j) => Math.cos(2 * Math.PI * 5 * j / n)), d = new Float64Array(n);
  fft1d(c, d, false);
  for (let k = 0; k < n; k++) {
    const want = k === 5 || k === n - 5 ? n / 2 : 0;
    assert.ok(Math.abs(c[k] - want) < 1e-9 && Math.abs(d[k]) < 1e-9, `cosine spike at k=${k}`);
  }
  // A sine puts imaginary spikes of opposite sign at +m and -m.
  const s = Float64Array.from({ length: n }, (_, j) => Math.sin(2 * Math.PI * 2 * j / n)), t = new Float64Array(n);
  fft1d(s, t, false);
  assert.ok(Math.abs(t[2] + n / 2) < 1e-9 && Math.abs(t[n - 2] - n / 2) < 1e-9, 'sine spikes');
}

// Linearity.
{
  const n = 64, x = Float64Array.from({ length: n }, () => random()), y = Float64Array.from({ length: n }, () => random());
  const z = x.map((v, i) => 2 * v - 3 * y[i]);
  const xi = new Float64Array(n), yi = new Float64Array(n), zi = new Float64Array(n);
  const X = x.slice(), Y = y.slice(), Z = z.slice();
  fft1d(X, xi); fft1d(Y, yi); fft1d(Z, zi);
  for (let k = 0; k < n; k++) assert.ok(Math.abs(Z[k] - (2 * X[k] - 3 * Y[k])) < 1e-9 && Math.abs(zi[k] - (2 * xi[k] - 3 * yi[k])) < 1e-9, 'linear');
}

// 3D: round trip, Parseval, and a plane wave lands on exactly one (and its conjugate) mode.
for (const n of [4, 8, 16]) {
  const N = n ** 3, fft = createFFT3D(n);
  const re = Float64Array.from({ length: N }, () => random() - 0.5), im = new Float64Array(N);
  const r0 = re.slice();
  let e0 = 0; for (let i = 0; i < N; i++) e0 += re[i] * re[i];
  fft.forward(re, im);
  let e1 = 0; for (let i = 0; i < N; i++) e1 += re[i] * re[i] + im[i] * im[i];
  assert.ok(Math.abs(e0 - e1 / N) < 1e-9 * e0, `Parseval in 3D, n=${n}`);
  fft.inverse(re, im);
  assert.ok(maxAbs(re, r0) < 1e-9 && Math.max(...im.map(Math.abs)) < 1e-9, `3D round trip, n=${n}`);
}
{
  const n = 16, N = n ** 3, fft = createFFT3D(n), kx = 2, ky = -3, kz = 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) re[x + n * (y + n * z)] = Math.cos(2 * Math.PI * (kx * x + ky * y + kz * z) / n);
  fft.forward(re, im);
  const idx = (a, b, c) => ((a + n) % n) + n * (((b + n) % n) + n * ((c + n) % n));
  const hot = new Set([idx(kx, ky, kz), idx(-kx, -ky, -kz)]);
  for (let i = 0; i < N; i++) {
    const want = hot.has(i) ? N / 2 : 0;
    assert.ok(Math.abs(re[i] - want) < 1e-8 && Math.abs(im[i]) < 1e-8, 'plane wave -> two spikes');
  }
}

// Sizes that are not powers of two are refused.
assert.throws(() => createPlan(48), RangeError);
assert.throws(() => createPlan(1), RangeError);
console.log('ok fft: 1D/3D round trip < 1e-9, Parseval, delta / phase ramp / cosine / sine / plane-wave inputs, linearity');
