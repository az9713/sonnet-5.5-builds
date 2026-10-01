// Comb jellies (ctenophores): eight meridional rows of beating comb plates, each plate a fused tuft of cilia.
//
// The plates of a row beat one after another, each a little later than the plate before it: a metachronal
// wave travelling along the row. Where a plate stands flat against the light it diffracts it, so the
// shimmer is a travelling band of changing colour. This module owns the phase maths (mirrored in the shader)
// and the slow swimming and tumbling of the animal.

export const ROWS = 8;
export const PLATES = 30;
export const BEAT_HZ = 2.6;        // visual beat rate (a real comb row beats 10-30 Hz; slowed so a display can resolve the wave)
export const LAG_PER_PLATE = 0.05;   // phase lag between neighbouring plates, in cycles

// Phase in [0, 1) of plate i at time t. It advances linearly along the row, so the wave travels.
export function platePhase(t, i, rowOffset = 0, hz = BEAT_HZ, lag = LAG_PER_PLATE) {
  const p = hz * t - i * lag + rowOffset;
  return p - Math.floor(p);
}

// How strongly a plate at phase ph reflects: a bright, short power stroke and a dim recovery.
export function plateGlint(ph) {
  const x = ph < 0.3 ? ph / 0.3 : (1 - ph) / 0.7;
  return Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, x)))) ** 3;
}

export const COMB_GLSL = `
const float COMB_ROWS = ${ROWS.toFixed(1)};
const float COMB_PLATES = ${PLATES.toFixed(1)};
const float COMB_HZ = ${BEAT_HZ.toFixed(4)};
const float COMB_LAG = ${LAG_PER_PLATE.toFixed(4)};
float combPhase(float t, float i, float rowOffset) { return fract(COMB_HZ * t - i * COMB_LAG + rowOffset); }
float combGlint(float ph) {
  float x = ph < 0.3 ? ph / 0.3 : (1.0 - ph) / 0.7;
  float s = sin(3.14159265 * clamp(x, 0.0, 1.0));
  return s * s * s;
}
`;

const TAU = Math.PI * 2;
const WTMP = [0, 0, 0, 0], HX = [0, 0, 0], XB = [0, 0, 0], ZB = [0, 0, 0];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; };

// One comb jelly. axis points from the oral pole toward the aboral pole.
export function createComb(spec, random) {
  const c = {
    pos: [spec.x, spec.y, spec.z], vel: [0, 0, 0], axis: [random() - 0.5, random() * 0.6 + 0.3, random() - 0.5], size: spec.size,
    spin: random() * TAU, spinRate: (random() - 0.5) * 0.4, swim: 0.07 + random() * 0.05, seed: random() * 100,
    rowOffsets: Array.from({ length: ROWS }, (_, i) => i * 0.0 + (random() - 0.5) * 0.08),
    ext: 0.6, tent: [], wob: [random() * TAU, random() * TAU, random() * TAU], zBand: spec.zBand, beat: 0.8 + random() * 0.45, tumble: [0, 0, 0],
    basis: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, time: 0,
  };
  norm(c.axis);
  return c;
}

// Slow oral-end-first swimming, gentle tumbling, retraction of the feeding tentacles. water(x,y,z,out) gives the current.
export function stepComb(c, dt, time, water, bounds) {
  c.time = time;
  const w = WTMP;
  water(c.pos[0], c.pos[1], c.pos[2], w);
  // swim toward the oral pole (-axis), slowing and speeding with the beat envelope
  const surge = 0.55 + 0.45 * Math.sin(time * 0.35 + c.seed);
  for (let k = 0; k < 3; k++) {
    const target = -c.axis[k] * c.swim * surge + w[k] * 0.9;
    c.vel[k] += (target - c.vel[k]) * Math.min(1, 1.6 * dt);
    c.pos[k] += c.vel[k] * dt;
  }
  // tumble: the axis wanders slowly, kept loosely upright, and is turned by shear in the water
  const t1 = time * 0.17 + c.seed, t2 = time * 0.11 + c.seed * 1.7;
  c.tumble[0] += (Math.sin(t1 * 2.1) * 0.35 - c.tumble[0]) * dt; c.tumble[1] += (Math.cos(t2 * 2.3) * 0.35 - c.tumble[1]) * dt; c.tumble[2] += (Math.sin(t1 * 1.3 + 1) * 0.35 - c.tumble[2]) * dt;
  c.axis[2] -= c.axis[2] * 0.8 * dt;   // lie across the view more often than along it
  c.axis[0] += (c.tumble[0] + w[2] * 0.6) * dt; c.axis[1] += (c.tumble[1] * 0.5 + 0.12 * (1 - c.axis[1])) * dt; c.axis[2] += (c.tumble[2] - w[0] * 0.6) * dt;
  norm(c.axis);
  c.spin += c.spinRate * dt;
  // retractable tentacles breathe in and out
  c.ext = 0.62 + 0.38 * Math.sin(time * 0.13 + c.seed * 3.0) * Math.sin(time * 0.071 + c.seed);
  if (bounds) bounds(c);
  // orthonormal basis, y = axis
  const y = c.axis, hx = HX; if (Math.abs(y[1]) < 0.9) { hx[0] = 0; hx[1] = 1; hx[2] = 0; } else { hx[0] = 1; hx[1] = 0; hx[2] = 0; }
  const x = XB, z = ZB;
  x[0] = hx[1] * y[2] - hx[2] * y[1]; x[1] = hx[2] * y[0] - hx[0] * y[2]; x[2] = hx[0] * y[1] - hx[1] * y[0]; norm(x);
  z[0] = y[1] * x[2] - y[2] * x[1]; z[1] = y[2] * x[0] - y[0] * x[2]; z[2] = y[0] * x[1] - y[1] * x[0];
  const cs = Math.cos(c.spin), sn = Math.sin(c.spin);
  const bx = c.basis.x, bz = c.basis.z;
  for (let k = 0; k < 3; k++) { bx[k] = x[k] * cs + z[k] * sn; bz[k] = -x[k] * sn + z[k] * cs; c.basis.y[k] = y[k]; }
}
