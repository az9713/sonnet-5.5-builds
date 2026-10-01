// The Zel'dovich approximation: x(q, D) = q + D psi(q), with D the linear growth factor. Pure functions mirrored
// by the vertex shader (which evaluates them per particle every frame from the stored q, psi and the three
// eigenvalues of d psi_i / d q_j). The density follows from mass conservation: rho / rho0 = 1 / |det(I + D H)|,
// H_ij = d psi_i / d q_j. In the eigenframe of H it is the product of 1 / |1 + D lambda_i|: the first eigenvalue
// to reach -1/D is the shell crossing along that axis (a sheet), two collapsed axes make a filament, three a knot.

export const wrap01 = x => x - Math.floor(x);

// Wrapped Eulerian position into out[o..o+2].
export function position(out, o, q, p, D) {
  out[o] = wrap01(q[0] + D * p[0]);
  out[o + 1] = wrap01(q[1] + D * p[1]);
  out[o + 2] = wrap01(q[2] + D * p[2]);
  return out;
}

// Determinant of the mapping's Jacobian in the eigenframe: prod (1 + D lambda_i).
export const jacobian = (l1, l2, l3, D) => (1 + D * l1) * (1 + D * l2) * (1 + D * l3);

// Growth factor at which the first axis collapses for a particle (Infinity if it never does).
export const shellCrossing = lambdaMin => lambdaMin < 0 ? -1 / lambdaMin : Infinity;

// Density with each factor softened so the caustic is a finite, bright ridge instead of a singularity.
export function density(l1, l2, l3, D, soft = 0.2) {
  const a = 1 + D * l1, b = 1 + D * l2, c = 1 + D * l3, s2 = soft * soft;
  return 1 / Math.sqrt((a * a + s2) * (b * b + s2) * (c * c + s2));
}

// Morphology by how many axes have collapsed at growth D: 0 void/underdense flow, 1 sheet, 2 filament, 3 knot.
export function collapsedAxes(l1, l2, l3, D) { return (1 + D * l1 <= 0) + (1 + D * l2 <= 0) + (1 + D * l3 <= 0); }

// Eigenvalues of a symmetric 3x3 matrix, ascending, into out[o..o+2] (Smith 1961, closed form).
export function eigenvaluesSym3(a11, a22, a33, a12, a13, a23, out, o = 0) {
  const p1 = a12 * a12 + a13 * a13 + a23 * a23;
  const q = (a11 + a22 + a33) / 3;
  if (p1 < 1e-24) {
    let x = a11, y = a22, z = a33, t;
    if (x > y) { t = x; x = y; y = t; }
    if (y > z) { t = y; y = z; z = t; }
    if (x > y) { t = x; x = y; y = t; }
    out[o] = x; out[o + 1] = y; out[o + 2] = z;
    return out;
  }
  const d1 = a11 - q, d2 = a22 - q, d3 = a33 - q;
  const p = Math.sqrt((d1 * d1 + d2 * d2 + d3 * d3 + 2 * p1) / 6);
  const ip = 1 / p;
  const b11 = d1 * ip, b22 = d2 * ip, b33 = d3 * ip, b12 = a12 * ip, b13 = a13 * ip, b23 = a23 * ip;
  const det = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const hi = q + 2 * p * Math.cos(phi), lo = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  out[o] = lo; out[o + 1] = 3 * q - hi - lo; out[o + 2] = hi;
  return out;
}
