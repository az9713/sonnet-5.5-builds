// The ambient current: a slow, aperiodic, divergence-free water velocity field.
//
// u = curl A, where each component of the vector potential A is a sum of three travelling sines with
// incommensurate wave vectors and drift speeds. The curl is exact, so JS (tentacles, plankton, jellyfish)
// and GLSL (anything that wants the current on the GPU) evaluate literally the same function: the GLSL
// source below is generated from the same table, rounded to the same digits.
//
// Units are world units and seconds. Typical speed is about 0.1 units/s; wavelengths are 9-25 units.

// [component, amplitude, kx, ky, kz, omega, phase]
const RAW = [
  [0, 1.00, 0.31, 0.17, 0.43, 0.047, 0.4],
  [0, 0.70, -0.52, 0.29, 0.11, -0.061, 2.1],
  [0, 0.45, 0.14, -0.67, 0.38, 0.083, 4.7],
  [1, 1.00, 0.22, 0.41, -0.29, -0.052, 1.3],
  [1, 0.65, 0.57, -0.19, 0.33, 0.071, 5.2],
  [1, 0.40, -0.36, 0.52, 0.18, -0.093, 3.0],
  [2, 1.00, 0.44, 0.23, 0.27, 0.058, 0.9],
  [2, 0.60, -0.18, 0.61, -0.35, -0.077, 2.8],
  [2, 0.42, 0.63, 0.12, 0.49, 0.089, 5.9],
];
const round = x => Number(x.toFixed(5));
const RMS = 0.095;   // overall current speed, units per second

// Scale amplitudes so the rms speed is RMS (computed once, deterministic), then round to the digits GLSL prints.
function build() {
  const waves = RAW.map(w => ({ c: w[0], a: w[1], k: [w[2], w[3], w[4]], w: w[5], p: w[6] }));
  const raw = (x, y, z, t, out, scale) => {
    let ux = 0, uy = 0, uz = 0;
    for (const { c, a, k, w, p } of waves) {
      const g = a * scale * Math.cos(k[0] * x + k[1] * y + k[2] * z + w * t + p);
      // curl of (A_c e_c): u_i += eps_ijk d_j A_k
      if (c === 0) { uy += k[2] * g; uz -= k[1] * g; }
      else if (c === 1) { ux -= k[2] * g; uz += k[0] * g; }
      else { ux += k[1] * g; uy -= k[0] * g; }
    }
    out[0] = ux; out[1] = uy; out[2] = uz;
  };
  const tmp = [0, 0, 0];
  let sum = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    raw((i * 0.731) % 20 - 10, (i * 1.37) % 12 - 6, -((i * 0.913) % 19) - 3, i * 0.37, tmp, 1);
    sum += tmp[0] ** 2 + tmp[1] ** 2 + tmp[2] ** 2; n++;
  }
  const scale = RMS / Math.sqrt(sum / n);
  for (const w of waves) { w.a = round(w.a * scale); w.k = w.k.map(round); w.w = round(w.w); w.p = round(w.p); }
  return waves;
}
export const WAVES = build();

// The current at (x, y, z) and time t, written into out[0..2].
export function ambientFlow(x, y, z, t, out) {
  let ux = 0, uy = 0, uz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const { c, a, k, w, p } = WAVES[i];
    const g = a * Math.cos(k[0] * x + k[1] * y + k[2] * z + w * t + p);
    if (c === 0) { uy += k[2] * g; uz -= k[1] * g; }
    else if (c === 1) { ux -= k[2] * g; uz += k[0] * g; }
    else { ux += k[1] * g; uy -= k[0] * g; }
  }
  out[0] = ux; out[1] = uy; out[2] = uz;
  return out;
}

const f = x => (x < 0 ? '(' + x.toFixed(5) + ')' : x.toFixed(5));
// The same function as GLSL source: vec3 pelagicFlow(vec3 p, float t).
export const FLOW_GLSL = `vec3 pelagicFlow(vec3 p, float t) {
  vec3 u = vec3(0.0);
  float g;
${WAVES.map(({ c, a, k, w, p }) => {
  const line = `  g = ${f(a)} * cos(${f(k[0])} * p.x + ${f(k[1])} * p.y + ${f(k[2])} * p.z + ${f(w)} * t + ${f(p)});`;
  const upd = c === 0 ? `  u.y += ${f(k[2])} * g; u.z -= ${f(k[1])} * g;` : c === 1 ? `  u.x -= ${f(k[2])} * g; u.z += ${f(k[0])} * g;` : `  u.x += ${f(k[1])} * g; u.y -= ${f(k[0])} * g;`;
  return line + '\n' + upd;
}).join('\n')}
  return u;
}
`;

// A cheap stand-in for ambientFlow for many samples per step: the current is smooth over about a unit and drifts slowly,
// so it is evaluated on a coarse lattice a few times a second and read back with trilinear interpolation.
export function createAmbientLattice() {
  const cell = 1.5, x0 = -18, y0 = -9.5, z0 = -24, nx = 25, ny = 14, nz = 17;
  const data = new Float32Array(nx * ny * nz * 3);
  const tmp = [0, 0, 0];
  let stamp = -1;
  return {
    update(t) {
      let o = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, o += 3) {
        ambientFlow(x0 + i * cell, y0 + j * cell, z0 + k * cell, t, tmp);
        data[o] = tmp[0]; data[o + 1] = tmp[1]; data[o + 2] = tmp[2];
      }
      stamp = t;
    },
    get stamp() { return stamp; },
    sample(x, y, z, out) {
      let fx = (x - x0) / cell, fy = (y - y0) / cell, fz = (z - z0) / cell;
      fx = fx < 0 ? 0 : fx > nx - 1.001 ? nx - 1.001 : fx; fy = fy < 0 ? 0 : fy > ny - 1.001 ? ny - 1.001 : fy; fz = fz < 0 ? 0 : fz > nz - 1.001 ? nz - 1.001 : fz;
      const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
      const b = ((k * ny + j) * nx + i) * 3, sy = nx * 3, sz = nx * ny * 3;
      for (let c = 0; c < 3; c++) {
        const a = b + c;
        const c00 = data[a] * (1 - tx) + data[a + 3] * tx, c10 = data[a + sy] * (1 - tx) + data[a + sy + 3] * tx;
        const c01 = data[a + sz] * (1 - tx) + data[a + sz + 3] * tx, c11 = data[a + sy + sz] * (1 - tx) + data[a + sy + sz + 3] * tx;
        out[c] = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
      }
      return out;
    },
  };
}
