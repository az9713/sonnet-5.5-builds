// Radix-2 complex FFT on typed arrays, in one dimension and three. Pure: no DOM, no three.
// Convention: forward is X[k] = sum x[j] exp(-2 pi i jk / n), unscaled; inverse uses exp(+...) and is scaled
// by 1/n (1/n^3 in three dimensions), so inverse(forward(x)) == x. Parseval: sum|x|^2 = (1/n) sum|X|^2.

export function createPlan(n) {
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) throw new RangeError('FFT size must be a power of two');
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n), cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  for (let k = 0; k < n >> 1; k++) { cos[k] = Math.cos((2 * Math.PI * k) / n); sin[k] = Math.sin((2 * Math.PI * k) / n); }
  return { n, rev, cos, sin };
}

// In-place unscaled transform of one line. sign -1: forward, +1: inverse.
function kernel(re, im, plan, sign) {
  const { n, rev, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t], wi = sign * sin[t];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// 1D transform of plain arrays or typed arrays, in place.
export function fft1d(re, im, inverse = false, plan = createPlan(re.length)) {
  kernel(re, im, plan, inverse ? 1 : -1);
  if (inverse) { const s = 1 / plan.n; for (let i = 0; i < plan.n; i++) { re[i] *= s; im[i] *= s; } }
}

// 3D transform of an n^3 lattice, index = x + n (y + n z), in place.
export function createFFT3D(n) {
  const plan = createPlan(n);
  const lr = new Float64Array(n), li = new Float64Array(n);
  const n2 = n * n;
  function line(re, im, base, stride, sign) {
    for (let i = 0, p = base; i < n; i++, p += stride) { lr[i] = re[p]; li[i] = im[p]; }
    kernel(lr, li, plan, sign);
    for (let i = 0, p = base; i < n; i++, p += stride) { re[p] = lr[i]; im[p] = li[i]; }
  }
  function transform(re, im, inverse) {
    const sign = inverse ? 1 : -1;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) line(re, im, n * (y + n * z), 1, sign);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) line(re, im, x + n2 * z, n, sign);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) line(re, im, x + n * y, n2, sign);
    if (inverse) { const s = 1 / (n2 * n); for (let i = 0; i < n2 * n; i++) { re[i] *= s; im[i] *= s; } }
  }
  return { n, forward: (re, im) => transform(re, im, false), inverse: (re, im) => transform(re, im, true) };
}
