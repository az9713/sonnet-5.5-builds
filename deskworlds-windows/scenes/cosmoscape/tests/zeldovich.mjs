import assert from 'node:assert/strict';
import { position, wrap01, jacobian, shellCrossing, density, collapsedAxes, eigenvaluesSym3 } from '../src/zeldovich.js';
import { SPECTRUM, generateDisplacement } from '../src/field.js';
import { randomGenerator } from '../../shared/random.js';
import { deflection, imageRadius, distortion, betaSlope } from '../src/lens.js';

const random = randomGenerator(3);

// ---- Eigenvalues of symmetric 3x3 matrices: invariants, ordering, degenerate cases.
{
  const e = [0, 0, 0];
  for (let trial = 0; trial < 500; trial++) {
    const a = Array.from({ length: 6 }, () => (random() - 0.5) * 4);
    const [a11, a22, a33, a12, a13, a23] = a;
    eigenvaluesSym3(a11, a22, a33, a12, a13, a23, e);
    assert.ok(e[0] <= e[1] + 1e-12 && e[1] <= e[2] + 1e-12, 'ascending');
    assert.ok(Math.abs(e[0] + e[1] + e[2] - (a11 + a22 + a33)) < 1e-9, 'sum = trace');
    const sq = e[0] ** 2 + e[1] ** 2 + e[2] ** 2, frob = a11 ** 2 + a22 ** 2 + a33 ** 2 + 2 * (a12 ** 2 + a13 ** 2 + a23 ** 2);
    assert.ok(Math.abs(sq - frob) < 1e-8 * Math.max(1, frob), 'sum of squares = Frobenius norm');
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
    assert.ok(Math.abs(e[0] * e[1] * e[2] - det) < 1e-8 * Math.max(1, Math.abs(det)), 'product = determinant');
  }
  eigenvaluesSym3(3, 1, 2, 0, 0, 0, e);
  assert.deepEqual([...e], [1, 2, 3], 'diagonal matrix, sorted');
  eigenvaluesSym3(2, 2, 2, 0, 0, 0, e);
  assert.deepEqual([...e], [2, 2, 2], 'multiple of the identity');
  eigenvaluesSym3(0, 0, 0, 1, 0, 0, e);   // [[0,1,0],[1,0,0],[0,0,0]] -> -1, 0, 1
  assert.ok(Math.abs(e[0] + 1) < 1e-12 && Math.abs(e[1]) < 1e-12 && Math.abs(e[2] - 1) < 1e-12);
}

// ---- Periodic wrap of the Zel'dovich mapping.
{
  const out = [0, 0, 0];
  for (let trial = 0; trial < 500; trial++) {
    const q = [random(), random(), random()], p = [(random() - 0.5) * 3, (random() - 0.5) * 3, (random() - 0.5) * 3], D = random() * 3;
    position(out, 0, q, p, D);
    assert.ok(out.every(v => v >= 0 && v < 1), 'wrapped into [0,1)');
    const shifted = position([0, 0, 0], 0, [q[0] + 3, q[1] - 2, q[2] + 1], p, D);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(shifted[i] - out[i]) < 1e-9 || Math.abs(Math.abs(shifted[i] - out[i]) - 1) < 1e-9, 'periodic in q');
  }
  assert.equal(wrap01(-0.25), 0.75);
  assert.equal(wrap01(1.25), 0.25);
  assert.equal(wrap01(0), 0);
  // D = 0: particles sit on their lattice positions.
  assert.deepEqual(position([0, 0, 0], 0, [0.25, 0.5, 0.75], [9, 9, 9], 0), [0.25, 0.5, 0.75]);
}

// ---- The density determinant: positive before shell crossing, zero at it, and a finite-difference check.
const n = 64;
const field = generateDisplacement(n, 4, { spectrum: { ...SPECTRUM, cutoff: 3 }, sigma: 1 });
{
  const e = [0, 0, 0];
  let tested = 0, collapsing = 0;
  for (let i = 0; i < n ** 3; i += 7) {
    eigenvaluesSym3(field.hess[0][i], field.hess[1][i], field.hess[2][i], field.hess[3][i], field.hess[4][i], field.hess[5][i], e);
    const Dc = shellCrossing(e[0]);
    if (Number.isFinite(Dc)) {
      collapsing++;
      assert.ok(jacobian(e[0], e[1], e[2], Dc * 0.99) > 0, 'positive just before the first crossing');
      assert.ok(jacobian(e[0], e[1], e[2], Dc * 1.01) < 0 || e[1] * Dc * 1.01 < -1, 'sign changes after it');
      assert.ok(Math.abs(1 + Dc * e[0]) < 1e-9, 'first axis reaches zero at the crossing');
    }
    for (const D of [0, 0.1, 0.3]) {
      const first = Math.min(...[e[0], e[1], e[2]].map(v => (v < 0 ? -1 / v : Infinity)));
      if (D < first) { assert.ok(jacobian(e[0], e[1], e[2], D) > 0, `Jacobian positive before shell crossing (D=${D})`); tested++; }
    }
    // Soft density is finite and positive for any D, including past crossing.
    for (const D of [0, 0.5, 1, 2, 5]) { const r = density(e[0], e[1], e[2], D, 0.1); assert.ok(r > 0 && Number.isFinite(r), 'density finite'); }
  }
  assert.ok(tested > 1000 && collapsing > 100, 'enough particles tested');
  // Mass conservation sanity: density is 1 where nothing moves, high where an axis collapses.
  assert.ok(Math.abs(density(0, 0, 0, 1, 0) - 1) < 1e-12, 'unperturbed density is 1');
  assert.ok(density(-1, 0, 0, 1, 0.05) > 15 && density(-1, -1, 0, 1, 0.05) > 15 * 15, 'collapsed axes multiply the density');
  assert.equal(collapsedAxes(-1, -1, 0.5, 1.5), 2);
}
{
  // Finite-difference Jacobian of x(q) = q + D psi(q) on the lattice against the analytic 1 + D tr H, and the full determinant.
  const D = 0.25, idx = (x, y, z) => ((x + n) % n) + n * (((y + n) % n) + n * ((z + n) % n));
  let err = 0, scale = 0, errDet = 0, count = 0;
  const e = [0, 0, 0];
  for (let z = 2; z < n; z += 5) for (let y = 2; y < n; y += 5) for (let x = 2; x < n; x += 5) {
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let a = 0; a < 3; a++) {
      const step = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let b = 0; b < 3; b++) {
        const hi = idx(x + step[b][0], y + step[b][1], z + step[b][2]), lo = idx(x - step[b][0], y - step[b][1], z - step[b][2]);
        J[a][b] = (a === b ? 1 : 0) + D * (field.psi[a][hi] - field.psi[a][lo]) * n / 2;   // d psi_a / d q_b, q in box units
      }
    }
    const detFD = J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) - J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) + J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);
    const i = idx(x, y, z);
    eigenvaluesSym3(field.hess[0][i], field.hess[1][i], field.hess[2][i], field.hess[3][i], field.hess[4][i], field.hess[5][i], e);
    const detAnalytic = jacobian(e[0], e[1], e[2], D);
    errDet += (detFD - detAnalytic) ** 2; scale += (detAnalytic - 1) ** 2; count++;
    err = Math.max(err, Math.abs(detFD - detAnalytic));
  }
  const rel = Math.sqrt(errDet / scale);
  console.log('  finite-difference relative rms error', rel.toFixed(4), 'over', count, 'particles');
  assert.ok(count > 1500 && rel < 0.06, `finite-difference determinant matches the analytic one (relative rms error of det - 1: ${rel.toFixed(4)})`);
}

// ---- Weak lens: the lens equation holds for the solved images, and the point-mass limits are right.
{
  for (const core of [0, 0.3, 0.8]) for (const E of [5, 20, 60]) for (const beta of [0.5, 3, 10, 30, 80, 200]) {
    const c = core * E;
    for (const which of [0, 1]) {
      if (core === 0 && beta < 1e-9) continue;
      const th = imageRadius(beta, E, c, which, which ? 12 : 8);
      const resid = th - deflection(th, E, c) - beta;
      if (which === 0) assert.ok(Math.abs(resid) < 1e-6 * Math.max(1, beta), `primary image solves the lens equation (E=${E}, c=${c}, beta=${beta}: ${resid})`);
      else if (core === 0) assert.ok(Math.abs(resid) < 1e-6 * Math.max(1, beta), `secondary image solves the lens equation (${resid})`);
    }
  }
  // Point mass closed form and magnification: mu+ - |mu-| = 1.
  for (const [E, beta] of [[10, 4], [30, 30], [30, 90], [7, 1]]) {
    const plus = imageRadius(beta, E, 0, 0, 12), minus = imageRadius(beta, E, 0, 1, 14), disc = Math.sqrt(beta * beta + 4 * E * E);
    assert.ok(Math.abs(plus - 0.5 * (beta + disc)) < 1e-6 && Math.abs(minus - 0.5 * (beta - disc)) < 1e-6, 'closed form roots');
    const mp = distortion(plus, beta, E, 0).magnification, mm = distortion(minus, beta, E, 0).magnification;
    assert.ok(Math.abs(mp - mm - 1) < 1e-4, `magnification difference is 1 (${mp - mm})`);
    assert.ok(plus > E && Math.abs(minus) < E, 'primary outside, secondary inside the Einstein ring');
  }
  // Far from the lens the image is the source; a source on the axis maps to the Einstein ring.
  assert.ok(Math.abs(imageRadius(500, 20, 0, 0) - 500) < 1.0, 'far images are undeflected');
  assert.ok(Math.abs(imageRadius(0, 20, 0, 0) - 20) < 1e-9, 'source behind the lens forms a ring of radius theta_E');
  // The tangential stretch grows toward the ring (arcs), and the primary image radius increases monotonically with beta.
  let last = -Infinity, lastStretch = Infinity;
  for (let beta = 0; beta <= 100; beta += 2) {
    const th = imageRadius(beta, 25, 7, 0), st = distortion(th, Math.max(beta, 1e-3), 25, 7).tangential;
    assert.ok(th > last, 'monotonic'); last = th;
    if (beta >= 4) { assert.ok(st <= lastStretch + 1e-9, 'tangential stretch falls with distance'); lastStretch = st; }
  }
  assert.ok(betaSlope(1000, 20, 5) > 0.999, 'slope -> 1 far away');
}
console.log('ok zeldovich: eigenvalues, periodic wrap, Jacobian positive before crossing, finite-difference determinant, softened density, lens equation / point-mass limits');
