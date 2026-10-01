// Builds every per-particle array the GPU needs, once, at start-up. Pure (typed arrays out).
//
//   position   q, the particle's Lagrangian lattice position (jittered inside its cell so there is no visible grid)
//   aPsi       Zel'dovich displacement at q
//   aHd, aHo   the symmetric matrix H_ij = d psi_i / d q_j: diagonal, and off-diagonal (xy, xz, yz). The vertex shader
//              builds F = I + D H from it: the cell's footprint, the density 1/det F and its colour
//   aNeural    xyz (matched point of the neural network) and heat
//   aMyc       xyz and heat of the matched mycelium point
//   aRand      four uniform randoms (front jitter, size, tint, twinkle)
//   aPulse     distance along the fibre, in the neural network and the mycelium
//
// The web is evaluated on the GPU as x = q + D psi, so growth is free every frame; the other two are fixed targets.
// Each particle is assigned one point of each target by balanced k-d bisection with Hilbert ranking in the cells
// (morph.js) against the web at a reference growth, so the same 262k (or 110k) particles move between all three structures.
import { generateDisplacement } from './field.js';
import { generateNeural, generateMycelium } from './structures.js';
import { matchBalanced } from './morph.js';
import { GROWTH } from './schedule.js';
import { randomGenerator } from '../../shared/random.js';

// lattice: particle lattice side (count = side^3); field: side of the FFT lattice the displacement is made on.
export const TIERS = Object.freeze({
  eco: { lattice: 48, field: 32 },
  balanced: { lattice: 64, field: 64 },
  detail: { lattice: 64, field: 64 },
  native: { lattice: 64, field: 64 },
});
// Jitter of q inside its cell, as a fraction of the spacing: enough to break the lattice, small enough to stay smooth.
const JITTER = 0.4;
export const REFERENCE_GROWTH = 0.62 * GROWTH.late;   // growth at which web and targets are matched

// Periodic trilinear sample of an n^3 lattice at fractional lattice coordinates.
function trilinear(a, n, x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z), tx = x - fx, ty = y - fy, tz = z - fz;
  const x0 = ((fx % n) + n) % n, y0 = ((fy % n) + n) % n, z0 = ((fz % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n, z1 = (z0 + 1) % n;
  const i00 = n * (y0 + n * z0), i10 = n * (y1 + n * z0), i01 = n * (y0 + n * z1), i11 = n * (y1 + n * z1);
  const c00 = a[x0 + i00] * (1 - tx) + a[x1 + i00] * tx, c10 = a[x0 + i10] * (1 - tx) + a[x1 + i10] * tx;
  const c01 = a[x0 + i01] * (1 - tx) + a[x1 + i01] * tx, c11 = a[x0 + i11] * (1 - tx) + a[x1 + i11] * tx;
  return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
}

// Stage 1: everything the web needs (the field, the lattice, the matching reference). Enough to draw the first frame.
export function buildWeb(tier = 'balanced', seed = 1, timings = {}) {
  const { lattice: L, field: F } = TIERS[tier] || TIERS.balanced;
  const count = L * L * L;
  const rng = randomGenerator((seed ^ 0x7f4a7c15) >>> 0);
  let t0 = performance.now();
  const lap = name => { const t = performance.now(); timings[name] = t - t0; t0 = t; };
  const field = generateDisplacement(F, seed);
  lap('field');
  const q = new Float32Array(count * 3), psi = new Float32Array(count * 3), hd = new Float32Array(count * 3), ho = new Float32Array(count * 3);
  const aRand = new Float32Array(count * 4);
  const same = F === L;
  let p = 0;
  for (let k = 0; k < L; k++) for (let j = 0; j < L; j++) for (let i = 0; i < L; i++, p++) {
    const jx = (rng() - 0.5) * JITTER, jy = (rng() - 0.5) * JITTER, jz = (rng() - 0.5) * JITTER;
    q[3 * p] = (((i + jx) / L) % 1 + 1) % 1; q[3 * p + 1] = (((j + jy) / L) % 1 + 1) % 1; q[3 * p + 2] = (((k + jz) / L) % 1 + 1) % 1;
    let h0, h1, h2, h3, h4, h5;
    if (same) {
      const n = i + L * (j + L * k);
      psi[3 * p] = field.psi[0][n]; psi[3 * p + 1] = field.psi[1][n]; psi[3 * p + 2] = field.psi[2][n];
      h0 = field.hess[0][n]; h1 = field.hess[1][n]; h2 = field.hess[2][n]; h3 = field.hess[3][n]; h4 = field.hess[4][n]; h5 = field.hess[5][n];
    } else {
      const x = q[3 * p] * F, y = q[3 * p + 1] * F, z = q[3 * p + 2] * F;
      psi[3 * p] = trilinear(field.psi[0], F, x, y, z); psi[3 * p + 1] = trilinear(field.psi[1], F, x, y, z); psi[3 * p + 2] = trilinear(field.psi[2], F, x, y, z);
      h0 = trilinear(field.hess[0], F, x, y, z); h1 = trilinear(field.hess[1], F, x, y, z); h2 = trilinear(field.hess[2], F, x, y, z);
      h3 = trilinear(field.hess[3], F, x, y, z); h4 = trilinear(field.hess[4], F, x, y, z); h5 = trilinear(field.hess[5], F, x, y, z);
    }
    hd[3 * p] = h0; hd[3 * p + 1] = h1; hd[3 * p + 2] = h2; ho[3 * p] = h3; ho[3 * p + 1] = h4; ho[3 * p + 2] = h5;
    const o = 4 * p;
    aRand[o] = rng(); aRand[o + 1] = rng(); aRand[o + 2] = rng(); aRand[o + 3] = rng();
  }
  lap('lattice');
  return {
    count, lattice: L, q, psi, hd, ho, aRand, sigma: field.sigma, timings, seed, targetsReady: false,
    aNeural: new Float32Array(count * 4), aMyc: new Float32Array(count * 4), aPulse: new Float32Array(count * 2),
  };
}

// Stage 2, a generator so the caller can yield to the browser between the pieces: the neural network and the mycelium
// (no one needs them for the first 80 s), each followed by its matching against the web at the reference growth.
export function* buildTargets(web, seed = web.seed, report = () => {}) {
  const { count, q, psi, timings } = web;
  let t0 = performance.now();
  const lap = name => { const t = performance.now(); timings[name] = t - t0; t0 = t; report(name); };
  const neural = generateNeural(count, seed);
  lap('neural'); yield 'neural'; t0 = performance.now();
  const mycelium = generateMycelium(count, seed);
  lap('mycelium'); yield 'mycelium'; t0 = performance.now();
  const ref = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) { const v = q[i] + REFERENCE_GROWTH * psi[i]; ref[i] = v - Math.floor(v); }
  const pn = matchBalanced(ref, neural.pos, count, 128, 9);
  lap('matchNeural'); yield 'matchNeural'; t0 = performance.now();
  const pm = matchBalanced(ref, mycelium.pos, count, 128, 9);
  lap('matchMycelium'); yield 'matchMycelium'; t0 = performance.now();
  const { aNeural, aMyc, aPulse } = web;
  for (let i = 0; i < count; i++) {
    const a = pn[i], b = pm[i];
    aNeural[4 * i] = neural.pos[3 * a]; aNeural[4 * i + 1] = neural.pos[3 * a + 1]; aNeural[4 * i + 2] = neural.pos[3 * a + 2]; aNeural[4 * i + 3] = neural.heat[a];
    aMyc[4 * i] = mycelium.pos[3 * b]; aMyc[4 * i + 1] = mycelium.pos[3 * b + 1]; aMyc[4 * i + 2] = mycelium.pos[3 * b + 2]; aMyc[4 * i + 3] = mycelium.heat[b];
    aPulse[2 * i] = neural.pulse[a]; aPulse[2 * i + 1] = mycelium.pulse[b];
  }
  web.neural = neural; web.mycelium = mycelium; web.targetsReady = true;
  lap('fill');
}

// Synchronous convenience (tests, capture mode): the web and both targets.
export function buildParticles(tier = 'balanced', seed = 1, timings = {}) {
  const web = buildWeb(tier, seed, timings);
  for (const _ of buildTargets(web, seed)) { /* run to the end */ }
  return web;
}

// A random subset of the particles (a shuffled prefix is a uniform sample of any size) for the dust layer.
export function dustIndices(count, seed = 1) {
  const rng = randomGenerator((seed ^ 0x3b9a73c9) >>> 0), n = count >> 1;
  const all = new Uint32Array(count);
  for (let i = 0; i < count; i++) all[i] = i;
  for (let i = 0; i < n; i++) { const j = i + Math.floor(rng() * (count - i)), t = all[i]; all[i] = all[j]; all[j] = t; }
  return all.slice(0, n);
}

// A faint distant field of galaxies: unit directions with an elliptical shape each.
// shape = (major angular sigma in radians, axis ratio, orientation, brightness); tint rgb.
export function buildGalaxies(count = 5200, seed = 1) {
  const rng = randomGenerator((seed ^ 0x6a09e667) >>> 0);
  const dir = new Float32Array(count * 3), shape = new Float32Array(count * 4), tint = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 2 * rng() - 1, a = 2 * Math.PI * rng(), r = Math.sqrt(1 - z * z);
    dir[3 * i] = r * Math.cos(a); dir[3 * i + 1] = z; dir[3 * i + 2] = r * Math.sin(a);
    const big = Math.pow(rng(), 5.0);
    shape[4 * i] = 0.0014 + 0.008 * big; shape[4 * i + 1] = 0.2 + 0.75 * rng(); shape[4 * i + 2] = Math.PI * rng();
    shape[4 * i + 3] = (0.25 + 0.75 * rng()) * (1 - 0.4 * big);
    const warm = rng();   // blue-white young galaxies to amber old ones
    tint[3 * i] = 0.55 + 0.45 * warm; tint[3 * i + 1] = 0.62 + 0.18 * warm + 0.12 * (1 - warm); tint[3 * i + 2] = 1.0 - 0.55 * warm;
  }
  return { count, dir, shape, tint };
}
