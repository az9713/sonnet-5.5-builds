// A Gaussian random density field on a periodic lattice and its Zel'dovich displacement.
//
// Power spectrum (documented choice). Wavenumbers are measured in cycles per box, m = |k| / 2 pi, so the
// fundamental mode of the box is m = 1. The density contrast has
//     P(m) = m^ns * T(m / gamma)^2 * exp(-(m / cutoff)^2)
// with T the BBKS (Bardeen, Bond, Kaiser, Szalay 1986) cold-dark-matter transfer function. With the shape
// parameter gamma = 4 modes the effective index d ln P / d ln m runs from about -1 at m ~ 2 to about -2.2 by
// m ~ 10, the range where the web's filaments are seen. The Gaussian factor is the high-k cutoff that keeps
// the field smooth on the lattice, as in the truncated Zel'dovich approximation, which is what keeps
// shell-crossing sheets and filaments thin instead of smeared.
//
// Field synthesis: white Gaussian noise in real space (so the spectrum is Hermitian and the result real by
// construction), forward FFT, multiply by sqrt(P) and by the transfer of the wanted quantity, inverse FFT.
// Normalisation: Var(delta) = sum over k != 0 of P(k) in expectation (the discrete integral of the spectrum);
// the optional exactSigma rescales the realisation so its sample rms is sigma exactly, which keeps the look
// of different seeds comparable.
//
// Zel'dovich: potential phi with laplacian(phi) = delta, displacement psi = -grad phi, i.e. psi(k) = i k delta(k) / k^2,
// so div psi = -delta. The Hessian of the displacement, H_ij = d psi_i / d q_j = -k_i k_j / k^2 delta(k),
// has trace -delta; it is computed spectrally, so it is exact for the lattice field.
import { createFFT3D } from './fft.js';
import { randomGenerator } from '../../shared/random.js';

export const SPECTRUM = Object.freeze({ ns: 1, gamma: 4, cutoff: 13 });

export function bbks(q) {
  if (q < 1e-8) return 1;
  const a = 2.34 * q;
  return (Math.log(1 + a) / a) * Math.pow(1 + 3.89 * q + Math.pow(16.1 * q, 2) + Math.pow(5.46 * q, 3) + Math.pow(6.71 * q, 4), -0.25);
}
export function powerSpectrum(m, s = SPECTRUM) {
  if (!(m > 0)) return 0;
  const t = bbks(m / s.gamma);
  return Math.pow(m, s.ns) * t * t * Math.exp(-(m * m) / (s.cutoff * s.cutoff));
}
// Frequency index of lattice coordinate j: 0..n/2-1, then -n/2..-1.
export const freq = (j, n) => (j < n >> 1 ? j : j - n);

// Sum of P over all non-zero lattice modes: the expected variance of the unnormalised field.
// P depends only on |f|^2, an integer, so the spectrum is tabulated once per transform size.
export function spectrumTable(n, s = SPECTRUM) {
  const table = new Float64Array(3 * (n >> 1) * (n >> 1) + 1);
  for (let f2 = 1; f2 < table.length; f2++) table[f2] = powerSpectrum(Math.sqrt(f2), s);
  return table;
}
export function totalPower(n, s = SPECTRUM, table = spectrumTable(n, s)) {
  const fr = new Int32Array(n);
  for (let j = 0; j < n; j++) fr[j] = freq(j, n);
  let sum = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const f2 = fr[x] * fr[x] + fr[y] * fr[y] + fr[z] * fr[z];
    if (f2) sum += table[f2];
  }
  return sum;
}

// delta(k) of one realisation: Hermitian by construction, mean zero. Returns { re, im, total, scale }.
export function densitySpectrum(n, seed, { spectrum = SPECTRUM, sigma = null } = {}) {
  const N = n * n * n, random = randomGenerator(seed);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - random())), a = 2 * Math.PI * random();
    re[i] = r * Math.cos(a);
    if (i + 1 < N) re[i + 1] = r * Math.sin(a);
  }
  createFFT3D(n).forward(re, im);
  const table = spectrumTable(n, spectrum), total = totalPower(n, spectrum, table);
  // W = FFT of unit white noise has E|W|^2 = N; the inverse transform divides by N, so delta(k) = sqrt(N P) W / sqrt(N) ... i.e.
  // delta(k) = sqrt(P) W sqrt(N) gives Var(delta) = (1/N^2) sum N P N = sum P. sigma rescales that to a chosen rms.
  const scale = (sigma === null ? 1 : sigma / Math.sqrt(total)) * Math.sqrt(N);
  const root = Float64Array.from(table, Math.sqrt);
  const fr = new Int32Array(n);
  for (let j = 0; j < n; j++) fr[j] = freq(j, n);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
    const f2 = fr[x] * fr[x] + fr[y] * fr[y] + fr[z] * fr[z];
    const a = f2 ? root[f2] * scale : 0;
    re[i] *= a; im[i] *= a;
  }
  return { re, im, total, scale };
}

// Real-space delta of one realisation (used by tests and for statistics).
export function densityField(n, seed, options) {
  const { re, im, total } = densitySpectrum(n, seed, options);
  createFFT3D(n).inverse(re, im);
  return { delta: re, imag: im, total };
}

// Fields are made by multiplying delta(k) by a real or imaginary multiplier and inverting. Because every
// spectrum involved is Hermitian, one complex inverse transform of A + iB returns two real fields at once:
// a in the real part, b in the imaginary part. Kinds: 'psi' multiplies by i f_axis / (2 pi |f|^2) (odd, so the
// Nyquist plane of its axis is zeroed to keep the result real); 'hess' by -f_a f_b / |f|^2 (even, real).
// Specialised loops, not closures: this is the start-up hot path.
function packedInverse(fft, spec, work, n, kindA, ax, kindB, bx) {
  const { re, im } = spec, wr = work.re, wi = work.im, half = n >> 1, two = 2 * Math.PI;
  const fr = new Float64Array(n);
  for (let j = 0; j < n; j++) fr[j] = freq(j, n);
  const F = [0, 0, 0], X = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
    const fx = fr[x], fy = fr[y], fz = fr[z], f2 = fx * fx + fy * fy + fz * fz;
    if (f2 === 0) { wr[i] = wi[i] = 0; continue; }
    F[0] = fx; F[1] = fy; F[2] = fz; X[0] = x; X[1] = y; X[2] = z;
    const inv = 1 / f2;
    let ar = 0, ai = 0, br = 0, bi = 0;
    if (kindA === 0) {   // psi: multiplier i c, c real
      const c = X[ax] === half ? 0 : F[ax] * inv / two;
      ar = -c * im[i]; ai = c * re[i];
    } else {             // hess: real multiplier
      const c = -F[ax] * F[kindA - 1] * inv;
      ar = c * re[i]; ai = c * im[i];
    }
    if (kindB === 0) {
      const c = X[bx] === half ? 0 : F[bx] * inv / two;
      br = -c * im[i]; bi = c * re[i];
    } else if (kindB > 0) {
      const c = -F[bx] * F[kindB - 1] * inv;
      br = c * re[i]; bi = c * im[i];
    }
    wr[i] = ar - bi; wi[i] = ai + br;   // A + iB
  }
  fft.inverse(wr, wi);
  return [new Float32Array(wr), kindB === -1 ? null : new Float32Array(wi)];
}

// The displacement field and its Hessian, as Float32 lattices, plus delta.
// Returns { n, delta, psi: [x,y,z], hess: [xx,yy,zz,xy,xz,yz], sigma }.
// kindA/kindB: 0 = psi along axis ax; k+1 = hess(ax, k); -1 = none.
export function generateDisplacement(n, seed, { spectrum = SPECTRUM, sigma = 1, exactSigma = true } = {}) {
  const spec = densitySpectrum(n, seed, { spectrum, sigma });
  const fft = createFFT3D(n), N = n * n * n;
  const work = { re: new Float64Array(N), im: new Float64Array(N) };
  const [px, py] = packedInverse(fft, spec, work, n, 0, 0, 0, 1);
  const [pz] = packedInverse(fft, spec, work, n, 0, 2, -1, 0);
  const [hxx, hyy] = packedInverse(fft, spec, work, n, 1, 0, 2, 1);    // hess(0,0), hess(1,1)
  const [hzz, hxy] = packedInverse(fft, spec, work, n, 3, 2, 2, 0);    // hess(2,2), hess(0,1)
  const [hxz, hyz] = packedInverse(fft, spec, work, n, 3, 0, 3, 1);    // hess(0,2), hess(1,2)
  const delta = new Float32Array(N);
  let sum2 = 0;
  for (let i = 0; i < N; i++) { delta[i] = -(hxx[i] + hyy[i] + hzz[i]); sum2 += delta[i] * delta[i]; }
  const rms = Math.sqrt(sum2 / N);
  let gain = 1;
  if (exactSigma && rms > 0) {
    gain = sigma / rms;
    for (const a of [px, py, pz, hxx, hyy, hzz, hxy, hxz, hyz, delta]) for (let i = 0; i < N; i++) a[i] *= gain;
  }
  return { n, delta, psi: [px, py, pz], hess: [hxx, hyy, hzz, hxy, hxz, hyz], sigma: rms * gain, gain };
}
