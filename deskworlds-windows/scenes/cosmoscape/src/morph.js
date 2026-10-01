// Matching and interpolating between point sets: the same particles flow from one structure to the next.
//
// matchByRank: sort both point sets along the Hilbert curve and pair equal ranks. Each source particle is
// assigned exactly one target (a permutation), and since nearby points share nearby ranks, the pairing is a
// cheap approximation of the optimal-transport map: matter moves along short, mostly parallel paths instead
// of scrambling. The interpolation is a smoothstep in time with a per-particle delay (so the transition front
// sweeps through space) plus a divergence-free swirl that peaks mid-transition (so the streams curve).
import { hilbertIndex } from './hilbert.js';

// Indices of count points (positions in [0,1)^3, packed xyz) sorted by Hilbert index (stable LSD radix sort
// on the 3*order-bit key, 10 bits per pass).
export function hilbertOrder(pos, count, order = 10) {
  const side = 1 << order, max = side - 1;
  let keys = new Uint32Array(count), idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const x = Math.min(max, Math.floor(pos[3 * i] * side)), y = Math.min(max, Math.floor(pos[3 * i + 1] * side)), z = Math.min(max, Math.floor(pos[3 * i + 2] * side));
    keys[i] = hilbertIndex(x, y, z, order); idx[i] = i;
  }
  let keys2 = new Uint32Array(count), idx2 = new Uint32Array(count);
  const counts = new Uint32Array(1024);
  for (let shift = 0; shift < 3 * order; shift += 10) {
    counts.fill(0);
    for (let i = 0; i < count; i++) counts[(keys[i] >>> shift) & 1023]++;
    let sum = 0;
    for (let c = 0; c < 1024; c++) { const n = counts[c]; counts[c] = sum; sum += n; }
    for (let i = 0; i < count; i++) { const d = counts[(keys[i] >>> shift) & 1023]++; keys2[d] = keys[i]; idx2[d] = idx[i]; }
    let t = keys; keys = keys2; keys2 = t; t = idx; idx = idx2; idx2 = t;
  }
  return idx;
}

// perm[i] = index of the target assigned to source particle i. A permutation of 0..count-1.
export function matchByRank(src, dst, count, order = 10) {
  return matchWithOrder(hilbertOrder(src, count, order), dst, count, order);
}
// The same with the source's Hilbert order already computed (one web order serves every target).
export function matchWithOrder(srcOrder, dst, count, order = 9) {
  const b = hilbertOrder(dst, count, order), perm = new Uint32Array(count);
  for (let r = 0; r < count; r++) perm[srcOrder[r]] = b[r];
  return perm;
}

// Balanced k-d bisection with Hilbert ranking inside the cells: the better approximation of optimal transport.
// A pure Hilbert-rank pairing is optimal along the curve only, and a short stretch of curve is a compact blob in space,
// so two unrelated distributions get paired almost at random. Here both sets are first cut recursively at their median,
// along the longest side of the node, into cells with equal counts (the two halves of a node are paired left with
// left, right with right: an iterated 1D transport, the Knothe-Rosenblatt map), and only inside a small cell, where
// the curve is local, are the points paired by Hilbert rank.
export function matchBalanced(src, dst, count, leaf = 512, order = 9) {
  const S = new Uint32Array(count), T = new Uint32Array(count);
  for (let i = 0; i < count; i++) { S[i] = i; T[i] = i; }
  const side = 1 << order, max = side - 1;
  const keys = pos => {
    const k = new Uint32Array(count);
    for (let i = 0; i < count; i++) k[i] = hilbertIndex(Math.min(max, Math.floor(pos[3 * i] * side)), Math.min(max, Math.floor(pos[3 * i + 1] * side)), Math.min(max, Math.floor(pos[3 * i + 2] * side)), order);
    return k;
  };
  // Floyd-Rivest-free quickselect: afterwards idx[lo..k) <= idx[k] <= idx(k..hi) by pos along `axis`.
  const select = (idx, pos, axis, lo, hi, k) => {
    hi--;
    while (hi > lo) {
      const mid = (lo + hi) >> 1;
      const a = pos[3 * idx[lo] + axis], b = pos[3 * idx[mid] + axis], c = pos[3 * idx[hi] + axis];
      const pivot = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));
      let i = lo, j = hi;
      while (i <= j) {
        while (pos[3 * idx[i] + axis] < pivot) i++;
        while (pos[3 * idx[j] + axis] > pivot) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  };
  const perm = new Uint32Array(count);
  const sk = keys(src), dk = keys(dst);
  // Node = index range plus its box (tracked from the split planes, so no pass over the points is needed to find the long side).
  const stack = [0, count, 0, 0, 0, 1, 1, 1], tmp = new Float64Array(leaf * 2 + 2), tmp2 = new Float64Array(leaf * 2 + 2);
  while (stack.length) {
    const z1 = stack.pop(), y1 = stack.pop(), x1 = stack.pop(), z0 = stack.pop(), y0 = stack.pop(), x0 = stack.pop(), hi = stack.pop(), lo = stack.pop(), n = hi - lo;
    if (n <= leaf) {
      // Pair by Hilbert rank inside the cell.
      const sa = tmp.subarray(0, n), ta = tmp2.subarray(0, n);
      for (let i = 0; i < n; i++) { sa[i] = sk[S[lo + i]] * count + S[lo + i]; ta[i] = dk[T[lo + i]] * count + T[lo + i]; }
      sa.sort(); ta.sort();
      for (let i = 0; i < n; i++) perm[sa[i] % count] = ta[i] % count;
      continue;
    }
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0, axis = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2), mid = lo + (n >> 1);
    select(S, src, axis, lo, hi, mid);
    select(T, dst, axis, lo, hi, mid);
    const cut = 0.5 * (src[3 * S[mid] + axis] + dst[3 * T[mid] + axis]);
    // Children: [lo, mid) below the plane, [mid, hi) above it.
    if (axis === 0) stack.push(lo, mid, x0, y0, z0, cut, y1, z1, mid, hi, cut, y0, z0, x1, y1, z1);
    else if (axis === 1) stack.push(lo, mid, x0, y0, z0, x1, cut, z1, mid, hi, x0, cut, z0, x1, y1, z1);
    else stack.push(lo, mid, x0, y0, z0, x1, y1, cut, mid, hi, x0, y0, cut, x1, y1, z1);
  }
  return perm;
}

export const wrapDelta = d => d - Math.round(d);
export const smooth01 = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// Per-particle progress of a transition with global progress m in [0,1]: front delay offset in [0,1],
// spread S of the front. progress 0 at m = 0 and 1 at m = 1 for every offset.
export function progress(m, offset, spread) { return smooth01(Math.min(1, Math.max(0, m * (1 + spread) - spread * offset))); }

// Divergence-free swirl: a sum of waves whose polarisation is perpendicular to the (integer, hence periodic)
// wave vector, so the field is the curl of a vector potential. Table shared with the shader source.
const WAVES = [
  { k: [1, 0, 1], phase: 0.3, speed: 0.31, amp: 1.0 }, { k: [0, 1, -1], phase: 2.1, speed: -0.23, amp: 1.0 },
  { k: [1, 1, 0], phase: 4.0, speed: 0.17, amp: 0.8 }, { k: [2, -1, 0], phase: 5.2, speed: -0.29, amp: 0.7 },
  { k: [0, 2, 1], phase: 1.2, speed: 0.37, amp: 0.55 }, { k: [-1, 0, 2], phase: 3.3, speed: -0.19, amp: 0.55 },
  { k: [2, 2, -1], phase: 0.9, speed: 0.41, amp: 0.35 }, { k: [-2, 1, 2], phase: 5.9, speed: -0.33, amp: 0.35 },
];
function polarisation(k) {
  const ref = Math.abs(k[1]) < Math.abs(k[0]) + Math.abs(k[2]) ? [0, 1, 0] : [1, 0, 0];
  const e = [k[1] * ref[2] - k[2] * ref[1], k[2] * ref[0] - k[0] * ref[2], k[0] * ref[1] - k[1] * ref[0]];
  const l = Math.hypot(...e);
  return e.map(v => v / l);
}
for (const w of WAVES) { w.e = polarisation(w.k); w.amp /= Math.sqrt(Math.hypot(...w.k)); }
export const SWIRL_WAVES = WAVES;

export function swirl(out, x, y, z, t) {
  out[0] = out[1] = out[2] = 0;
  for (const w of WAVES) {
    const c = w.amp * Math.cos(2 * Math.PI * (w.k[0] * x + w.k[1] * y + w.k[2] * z) + w.phase + w.speed * t);
    out[0] += w.e[0] * c; out[1] += w.e[1] * c; out[2] += w.e[2] * c;
  }
  return out;
}
// GLSL for the same field, generated from the table so JS and shader cannot drift apart.
export function swirlGLSL() {
  const f = v => Number(v).toFixed(6);
  const lines = WAVES.map(w => `  v += vec3(${f(w.e[0])}, ${f(w.e[1])}, ${f(w.e[2])}) * (${f(w.amp)} * cos(6.2831853 * dot(vec3(${f(w.k[0])}, ${f(w.k[1])}, ${f(w.k[2])}), p) + ${f(w.phase)} + ${f(w.speed)} * t));`);
  return `vec3 swirl(vec3 p, float t) {\n  vec3 v = vec3(0.0);\n${lines.join('\n')}\n  return v;\n}`;
}

// Position of a particle moving from a to b (packed xyz triples in box units, a possibly outside [0,1) since the
// Zel'dovich position is unwrapped), at global progress m. a and b are matched modulo the box: the shorter way.
export function morphPosition(out, a, b, m, offset, spread, swirlAmp, t, scratch = [0, 0, 0]) {
  const s = progress(m, offset, spread);
  const bump = 4 * s * (1 - s);
  const mid = [a[0] + s * wrapDelta(b[0] - a[0]), a[1] + s * wrapDelta(b[1] - a[1]), a[2] + s * wrapDelta(b[2] - a[2])];
  swirl(scratch, mid[0], mid[1], mid[2], t);
  out[0] = mid[0] + swirlAmp * bump * scratch[0];
  out[1] = mid[1] + swirlAmp * bump * scratch[1];
  out[2] = mid[2] + swirlAmp * bump * scratch[2];
  return out;
}
