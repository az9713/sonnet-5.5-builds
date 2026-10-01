// The humpback's anatomy as functions of the distance along the spine, and the one static mesh
// that every whale shares. Nothing here is a pose: the mesh stores only rest coordinates
// (distance along the body, height, lateral offset) and fin parameters; the vertex shader
// places every point from the live spine each frame.
export const BODY_LEN = 12.6;     // m, nose to the end of the peduncle at scale 1
export const FLUKE_HALF = 1.95;   // m, half span
export const FLIPPER_LEN = 4.2;   // m, a third of the body

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Radial size factor along the body (0 at the nose, 1 at the girth, ~0.13 at the peduncle).
export function radial(t) {
  const cap = Math.sqrt(Math.max(0, 1 - (1 - clamp(t / 0.05, 0, 1)) ** 2));
  const grow = sstep(0, 0.32, t);
  const rad = 0.52 + 0.48 * Math.pow(grow, 0.75);
  const taper = Math.pow(1 - sstep(0.38, 1.0, t), 0.9);
  return cap * rad * (0.13 + 0.87 * taper);
}
export const halfWidth = (t) => 1.30 * radial(t) * (1 + 0.10 * (1 - sstep(0.02, 0.22, t)));
export const topAt = (t) => 0.94 * radial(t) * (0.8 + 0.2 * sstep(0, 0.2, t));
export const bottomAt = (t) => -1.10 * radial(t);
// The dorsal fin hump and the knuckled ridge behind it, a function of the position along the
// body and the lateral offset z; added to the upper half only.
export function dorsal(t, z) {
  const fin = 0.46 * Math.exp(-(((t - 0.665) / 0.032) ** 2));
  const ridge = 0.10 * sstep(0.56, 0.72, t) * (1 - sstep(0.9, 1.0, t)) * (0.75 + 0.25 * Math.cos(t * 150));
  return (fin + ridge) * Math.exp(-((z / 0.34) ** 2));
}

const P = 2.6;
// Point on the body surface, rest coordinates (s, y, z), for t in [0,1] and angle a around the
// section (0 = right flank, pi/2 = back, pi = left, 3pi/2 = belly).
export function bodyPoint(t, a, out = [0, 0, 0]) {
  const c = Math.cos(a), sn = Math.sin(a);
  const w = halfWidth(t);
  const z = w * Math.sign(c) * Math.abs(c) ** (2 / P);
  const ex = Math.abs(sn) ** (2 / P);
  let y = sn >= 0 ? topAt(t) * ex : bottomAt(t) * ex;
  if (sn > 0) y += dorsal(t, z) * Math.min(1, ex * 1.2);
  out[0] = t * BODY_LEN; out[1] = y; out[2] = z;
  return out;
}

// parts: 0 body, 1 fluke, 2 left flipper, 3 right flipper
export function buildWhaleGeometry({ rings = 104, around = 40, flukeU = 46, flukeV = 10, flipU = 26, flipV = 8 } = {}) {
  const pos = [], nrm = [], misc = [], index = [];
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  // Body: rings x (around + 1), seam duplicated.
  for (let k = 0; k <= rings; k++) {
    // a little denser at the head and the tail
    const u = k / rings, t = u + 0.012 * Math.sin(u * Math.PI * 2) * -1 * 0;
    for (let m = 0; m <= around; m++) {
      const ang = (m / around) * Math.PI * 2;
      bodyPoint(t, ang, a);
      const e = 0.0016, ea = 0.012;
      const t0 = clamp(t - e, 0, 1), t1 = clamp(t + e, 0, 1);
      bodyPoint(t1, ang, b); bodyPoint(t0, ang, c);
      const dtx = b[0] - c[0], dty = b[1] - c[1], dtz = b[2] - c[2];
      bodyPoint(t, ang + ea, b); bodyPoint(t, ang - ea, c);
      const dax = b[0] - c[0], day = b[1] - c[1], daz = b[2] - c[2];
      // outward normal = d/dt x d/da (orientation fixed by the radial direction)
      let nx = dty * daz - dtz * day, ny = dtz * dax - dtx * daz, nz = dtx * day - dty * dax;
      const out = ny * Math.sin(ang) + nz * Math.cos(ang);
      if (out < 0) { nx = -nx; ny = -ny; nz = -nz; }
      let len = Math.hypot(nx, ny, nz);
      if (len < 1e-9 || t < 0.0006) { nx = -1; ny = 0; nz = 0; len = 1; }   // the very tip points forward (-s)
      pos.push(a[0], a[1], a[2]); nrm.push(nx / len, ny / len, nz / len);
      misc.push(0, ang, t, 0);
    }
  }
  const rowB = around + 1;
  for (let k = 0; k < rings; k++) for (let m = 0; m < around; m++) {
    const i0 = k * rowB + m, i1 = i0 + 1, i2 = i0 + rowB, i3 = i2 + 1;
    index.push(i0, i2, i1, i1, i2, i3);
  }
  // Fluke: u in [-1, 1] across the span, v in [0, 1] leading to trailing edge, side +1 top / -1 underside.
  const grid = (part, nu, nv, u0, u1, pushExtra) => {
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
        const u = u0 + (u1 - u0) * (i / nu), v = j / nv;
        pos.push(u, v, side); nrm.push(0, side, 0); misc.push(part, 0, 0, 0);
      }
      const rb = nv + 1;
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const i0 = base + i * rb + j, i1 = i0 + 1, i2 = i0 + rb, i3 = i2 + 1;
        if (side > 0) index.push(i0, i1, i2, i1, i3, i2); else index.push(i0, i2, i1, i1, i2, i3);
      }
    }
  };
  grid(1, flukeU, flukeV, -1, 1);
  grid(2, flipU, flipV, 0, 1);
  grid(3, flipU, flipV, 0, 1);
  return {
    position: new Float32Array(pos), normal: new Float32Array(nrm), misc: new Float32Array(misc),
    index: pos.length / 3 > 65000 ? new Uint32Array(index) : new Uint16Array(index),
    vertices: pos.length / 3, triangles: index.length / 3,
  };
}
