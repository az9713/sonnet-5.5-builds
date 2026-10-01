import assert from 'node:assert/strict';
import { createFFT3D } from '../src/fft.js';
import { SPECTRUM, powerSpectrum, bbks, totalPower, densityField, generateDisplacement, freq } from '../src/field.js';

// ---- Power spectrum: positive, decreasing, an effective index of about -1.5 to -2.2 over the visible range.
{
  let last = Infinity;
  for (let m = 2; m <= 30; m++) {
    const p = powerSpectrum(m);
    assert.ok(p > 0 && Number.isFinite(p), 'P positive');
    assert.ok(p < last, `P falls with m (m=${m})`);
    last = p;
  }
  assert.equal(powerSpectrum(0), 0, 'no mean mode');
  const slope = (a, b) => Math.log(powerSpectrum(b) / powerSpectrum(a)) / Math.log(b / a);
  const s = slope(3, 8);
  assert.ok(s < -1.3 && s > -2.4, `effective spectral index between m=3 and 8 is ${s.toFixed(2)}`);
  assert.ok(slope(8, 12) < -1.9, 'steeper at the cutoff');
  assert.ok(Math.abs(bbks(0) - 1) < 1e-12 && bbks(1) < bbks(0.1), 'BBKS transfer: 1 at k=0, decreasing');
}

// ---- Gaussian field statistics at n = 16.
const n = 16, N = n ** 3;
{
  // Zero mean exactly (k = 0 is removed), real result, deterministic by seed.
  const a = densityField(n, 5, { sigma: null }), b = densityField(n, 5, { sigma: null }), c = densityField(n, 6, { sigma: null });
  let mean = 0; for (const v of a.delta) mean += v;
  assert.ok(Math.abs(mean / N) < 1e-12, 'zero mean');
  assert.ok(Math.max(...a.imag.map(Math.abs)) < 1e-10, 'the field is real: imaginary part vanishes to rounding');
  assert.deepEqual(a.delta, b.delta, 'same seed, same field');
  assert.notDeepEqual(a.delta, c.delta, 'different seed, different field');
  // Variance matches the discrete integral of P(k): averaged over seeds, within 12%.
  const total = totalPower(n);
  let variance = 0;
  const seeds = 8;
  for (let s = 1; s <= seeds; s++) {
    const f = densityField(n, 100 + s, { sigma: null }).delta;
    let v = 0; for (const x of f) v += x * x;
    variance += v / N;
  }
  variance /= seeds;
  assert.ok(Math.abs(variance / total - 1) < 0.12, `variance ${variance.toFixed(3)} vs sum P ${total.toFixed(3)}`);
  // The sigma option rescales the expected variance to sigma^2.
  let v2 = 0; const g = densityField(n, 9, { sigma: 2 }).delta; for (const x of g) v2 += x * x;
  assert.ok(Math.abs(Math.sqrt(v2 / N) / 2 - 1) < 0.25, 'sigma option sets the rms');
  // Gaussianity: skewness and excess kurtosis near 0 (loosely: few independent modes at n = 16).
  const f = densityField(n, 21, { sigma: null }).delta;
  let m2 = 0, m3 = 0, m4 = 0; for (const x of f) { m2 += x * x; m3 += x ** 3; m4 += x ** 4; }
  m2 /= N; m3 /= N; m4 /= N;
  assert.ok(Math.abs(m3 / m2 ** 1.5) < 0.6 && Math.abs(m4 / m2 ** 2 - 3) < 1.5, 'roughly Gaussian one-point statistics');
}

// ---- Displacement: curl-free (a pure gradient), div psi = -delta, Hessian = spectral derivative of psi, trace = -delta.
{
  const m = 32, M = m ** 3, fft = createFFT3D(m);
  const field = generateDisplacement(m, 3, { spectrum: { ...SPECTRUM, cutoff: 4 }, sigma: 1 });
  const spec = arr => { const re = Float64Array.from(arr), im = new Float64Array(M); fft.forward(re, im); return { re, im }; };
  const P = field.psi.map(spec), Dl = spec(field.delta), H = field.hess.map(spec);
  let scaleP = 0; for (const p of P) for (let i = 0; i < M; i++) scaleP = Math.max(scaleP, Math.abs(p.re[i]), Math.abs(p.im[i]));
  let curl = 0, div = 0, hessErr = 0, scaleD = 0;
  const half = m >> 1;
  let i = 0;
  for (let z = 0; z < m; z++) for (let y = 0; y < m; y++) for (let x = 0; x < m; x++, i++) {
    const k = [freq(x, m), freq(y, m), freq(z, m)];
    if (x === half || y === half || z === half) continue;   // the Nyquist planes carry no odd derivative
    // curl: k_a psi_b - k_b psi_a = 0 for every pair.
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      curl = Math.max(curl, Math.abs(k[a] * P[b].re[i] - k[b] * P[a].re[i]), Math.abs(k[a] * P[b].im[i] - k[b] * P[a].im[i]));
    }
    // div psi = i k . psi_k must equal -delta_k.
    const dre = -(k[0] * P[0].im[i] + k[1] * P[1].im[i] + k[2] * P[2].im[i]) * 2 * Math.PI, dim = (k[0] * P[0].re[i] + k[1] * P[1].re[i] + k[2] * P[2].re[i]) * 2 * Math.PI;
    div = Math.max(div, Math.abs(dre + Dl.re[i]), Math.abs(dim + Dl.im[i]));
    scaleD = Math.max(scaleD, Math.abs(Dl.re[i]));
    // Hessian xy = d psi_y / d x = i k_x psi_y,k.
    const hxy = H[3];
    hessErr = Math.max(hessErr, Math.abs(hxy.re[i] + 2 * Math.PI * k[0] * P[1].im[i]), Math.abs(hxy.im[i] - 2 * Math.PI * k[0] * P[1].re[i]));
  }
  assert.ok(curl < 1e-4 * scaleP * half, `psi is curl-free (max curl ${curl.toExponential(2)} against ${(scaleP * half).toExponential(2)})`);
  assert.ok(div < 1e-4 * scaleD, `div psi = -delta (error ${div.toExponential(2)}, delta scale ${scaleD.toExponential(2)})`);
  assert.ok(hessErr < 1e-4 * scaleD, `Hessian is the spectral derivative of psi (${hessErr.toExponential(2)})`);
  // Trace and exact sigma.
  let trace = 0, s2 = 0;
  for (let j = 0; j < M; j++) { trace = Math.max(trace, Math.abs(field.hess[0][j] + field.hess[1][j] + field.hess[2][j] + field.delta[j])); s2 += field.delta[j] ** 2; }
  assert.ok(trace < 1e-5, 'trace of the Hessian is -delta');
  assert.ok(Math.abs(Math.sqrt(s2 / M) - 1) < 1e-4, 'exactSigma: rms delta = sigma');
  assert.ok(field.psi.every(a => a.every(Number.isFinite)) && field.hess.every(a => a.every(Number.isFinite)), 'finite');
}

// ---- Deterministic by seed, including the displacement.
{
  const a = generateDisplacement(16, 2), b = generateDisplacement(16, 2), c = generateDisplacement(16, 3);
  assert.deepEqual(a.psi[0], b.psi[0]);
  assert.deepEqual(a.hess[5], b.hess[5]);
  assert.notDeepEqual(a.psi[0], c.psi[0]);
}
console.log('ok field: spectrum slope, zero mean, real, deterministic, variance ~ sum P, curl-free, div psi = -delta, Hessian exact');
