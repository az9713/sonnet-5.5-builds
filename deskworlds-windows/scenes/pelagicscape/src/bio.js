// Bioluminescent plankton, lit by shear.
//
// Dinoflagellates flash when the water around them is sheared hard enough to deform the cell: a mechanical
// trigger with a threshold. The flash rises in about 100 ms, fades over a second or so, and the cell then
// needs a refractory period to recharge before it can flash again. Calm water therefore stays dark; a hand,
// a swimming bell or a shed vortex ring lights the water it shears.
//
// Two pieces:
//  - Disturbance: a sparse velocity grid. Anything that moves through the water (the cursor, bell margins,
//    vortex rings) drags the fluid it passes toward its own velocity; the disturbance then decays over about
//    half a second. The grid's shear |grad u| is what the plankton feel, and its velocity advects them.
//  - Plankton: typed-array state per particle, updated at the fixed step. Marine snow shares the buffers.

export const THRESHOLD = 2.2;     // shear (1/s) that triggers a flash
export const RISE = 0.09;         // seconds to reach peak
export const REFRACTORY = [1.4, 3.2];

export const CELL = 0.6;
const GX0 = -11.4, GY0 = -7.2, GZ0 = -22.2;
const NX = 38, NY = 24, NZ = 33;

export function createDisturbance() {
  const n = NX * NY * NZ;
  const u = new Float32Array(n * 3), shear = new Float32Array(n);
  const active = new Uint8Array(n), list = new Int32Array(n);
  let count = 0;
  const idx = (i, j, k) => (k * NY + j) * NX + i;
  function mark(c) { if (!active[c]) { active[c] = 1; list[count++] = c; } }

  // The fluid near (x, y, z) is dragged toward velocity (vx, vy, vz): a gaussian of width sigma (sigmaZ along depth), coupling rate `rate` per second.
  const wx = new Float32Array(32), wy = new Float32Array(32), wz = new Float32Array(32);
  function splat(x, y, z, vx, vy, vz, sigma, rate, dt, sigmaZ = sigma) {
    const reachXY = Math.min(15, Math.ceil(2.4 * sigma / CELL) + 1), reachZ = Math.min(15, Math.ceil(2.4 * sigmaZ / CELL) + 1);
    const ci = Math.round((x - GX0) / CELL), cj = Math.round((y - GY0) / CELL), ck = Math.round((z - GZ0) / CELL);
    const i0 = Math.max(0, ci - reachXY), i1 = Math.min(NX - 1, ci + reachXY), j0 = Math.max(0, cj - reachXY), j1 = Math.min(NY - 1, cj + reachXY), k0 = Math.max(0, ck - reachZ), k1 = Math.min(NZ - 1, ck + reachZ);
    const inv = 1 / (2 * sigma * sigma), invZ = 1 / (2 * sigmaZ * sigmaZ);
    for (let i = i0; i <= i1; i++) { const d = GX0 + i * CELL - x; wx[i - i0] = Math.exp(-d * d * inv); }
    for (let j = j0; j <= j1; j++) { const d = GY0 + j * CELL - y; wy[j - j0] = Math.exp(-d * d * inv); }
    for (let k = k0; k <= k1; k++) { const d = GZ0 + k * CELL - z; wz[k - k0] = Math.exp(-d * d * invZ); }
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const wyz = wy[j - j0] * wz[k - k0];
      for (let i = i0; i <= i1; i++) {
        const c = idx(i, j, k);
        mark(c);
        const w = wx[i - i0] * wyz;
        if (w < 0.01) continue;
        const a = Math.min(1, w * rate * dt), b = c * 3;
        u[b] += (vx - u[b]) * a; u[b + 1] += (vy - u[b + 1]) * a; u[b + 2] += (vz - u[b + 2]) * a;
      }
    }
  }

  // Decays the disturbance and recomputes shear on the active cells.
  function step(dt, tau = 0.55) {
    const keep = Math.exp(-dt / tau);
    for (let a = 0; a < count; a++) { const b = list[a] * 3; u[b] *= keep; u[b + 1] *= keep; u[b + 2] *= keep; }
    const sx = NX * 3, sy = NY * NX * 3 - 0;
    for (let a = 0; a < count; a++) {
      const c = list[a], i = c % NX, j = ((c / NX) | 0) % NY, k = (c / (NX * NY)) | 0;
      const b = c * 3;
      const xm = i > 0 ? b - 3 : b, xp = i < NX - 1 ? b + 3 : b;
      const ym = j > 0 ? b - sx : b, yp = j < NY - 1 ? b + sx : b;
      const zm = k > 0 ? b - NX * NY * 3 : b, zp = k < NZ - 1 ? b + NX * NY * 3 : b;
      const h = 0.5 / CELL;
      let s = 0;
      for (let q = 0; q < 3; q++) {
        const gx = (u[xp + q] - u[xm + q]) * h, gy = (u[yp + q] - u[ym + q]) * h, gz = (u[zp + q] - u[zm + q]) * h;
        s += gx * gx + gy * gy + gz * gz;
      }
      shear[c] = Math.sqrt(s);
    }
    for (let a = count - 1; a >= 0; a--) {
      const c = list[a], b = c * 3;
      if (u[b] * u[b] + u[b + 1] * u[b + 1] + u[b + 2] * u[b + 2] < 2.5e-5 && shear[c] < 0.02) {
        u[b] = u[b + 1] = u[b + 2] = 0; shear[c] = 0; active[c] = 0; list[a] = list[--count];
      }
    }
  }

  // Trilinear velocity and shear at a point: out[0..2] velocity, out[3] shear.
  function sample(x, y, z, out) {
    const fx = (x - GX0) / CELL, fy = (y - GY0) / CELL, fz = (z - GZ0) / CELL;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= NX - 1 || fy >= NY - 1 || fz >= NZ - 1) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
    const c000 = idx(i, j, k);
    if (!(active[c000] | active[c000 + 1] | active[c000 + NX] | active[c000 + NX + 1] | active[c000 + NX * NY] | active[c000 + NX * NY + 1] | active[c000 + NX * NY + NX] | active[c000 + NX * NY + NX + 1])) {
      out[0] = out[1] = out[2] = out[3] = 0; return out;
    }
    let ox = 0, oy = 0, oz = 0, os = 0;
    for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
      const c = c000 + di + dj * NX + dk * NX * NY, b = c * 3;
      ox += u[b] * w; oy += u[b + 1] * w; oz += u[b + 2] * w; os += shear[c] * w;
    }
    out[0] = ox; out[1] = oy; out[2] = oz; out[3] = os;
    return out;
  }
  function clear() { for (let a = 0; a < count; a++) { const c = list[a]; u[c * 3] = u[c * 3 + 1] = u[c * 3 + 2] = 0; shear[c] = 0; active[c] = 0; } count = 0; }
  return { splat, step, sample, clear, get active() { return count; }, size: [NX, NY, NZ] };
}

export const GROUPS = 4;          // each particle re-reads the field every GROUPS steps and coasts in between

// KIND: 0 plankton, 1 marine snow, 2 vortex-ring marker.
// field.sample(x, y, z, out): out[0..2] water velocity, out[3] shear. bounds(d, out) -> frustum half extents.
export function createPlankton({ count, snow = 0, rings = 0, random, spawn }) {
  const total = count + snow + rings;
  const pts = new Float32Array(total * 4);        // x y z energy: uploaded to the GPU as is
  const vel = new Float32Array(total * 3);
  const kind = new Float32Array(total * 2);       // kind, random
  const rise = new Float32Array(count), refr = new Float32Array(count), peak = new Float32Array(count), tau = new Float32Array(count);
  const life = new Float32Array(count + snow);
  const stats = { flashes: 0, energy: 0, lastFlashes: 0 };
  let tick = 0;
  const p3 = [0, 0, 0];
  for (let i = 0; i < total; i++) {
    kind[i * 2] = i < count ? 0 : i < count + snow ? 1 : 2; kind[i * 2 + 1] = random();
    if (i < count + snow) { spawn(p3, i < count ? 0 : 1, random, false); pts[i * 4] = p3[0]; pts[i * 4 + 1] = p3[1]; pts[i * 4 + 2] = p3[2]; life[i] = 8 + random() * 60; }
    if (i < count) tau[i] = 0.4 + 0.45 * random();
    if (i >= count + snow) pts[i * 4 + 3] = 0;
  }
  const out = [0, 0, 0, 0];

  function flash(i, shear) {
    peak[i] = Math.min(1.4, 0.55 + 0.45 * shear / THRESHOLD);
    rise[i] = RISE;
    refr[i] = REFRACTORY[0] + (REFRACTORY[1] - REFRACTORY[0]) * random();
    stats.flashes++;
  }

  function step(dt, field, ambient, time) {
    const g = tick++ % GROUPS, gdt = dt * GROUPS;
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const b = i * 4;
      pts[b] += vel[i * 3] * dt; pts[b + 1] += vel[i * 3 + 1] * dt; pts[b + 2] += vel[i * 3 + 2] * dt;
      // flash dynamics, every step for every particle
      if (rise[i] > 0) { pts[b + 3] = Math.min(peak[i], pts[b + 3] + peak[i] * dt / RISE); rise[i] -= dt; }
      else if (pts[b + 3] > 1e-3) pts[b + 3] *= Math.exp(-dt / tau[i]); else pts[b + 3] = 0;
      if (refr[i] > 0) refr[i] -= dt;
      energy += pts[b + 3];
      if (i % GROUPS !== g) continue;
      field(pts[b], pts[b + 1], pts[b + 2], out);
      ambient(pts[b], pts[b + 1], pts[b + 2], time, p3);
      vel[i * 3] = p3[0] + out[0]; vel[i * 3 + 1] = p3[1] + out[1]; vel[i * 3 + 2] = p3[2] + out[2];
      if (out[3] > THRESHOLD && refr[i] <= 0 && rise[i] <= 0) flash(i, out[3]);
      life[i] -= gdt;
      if (life[i] <= 0 && pts[b + 3] < 0.01 && rise[i] <= 0) respawn(i, 0);
    }
    for (let i = count; i < count + snow; i++) {
      const b = i * 4;
      pts[b] += vel[i * 3] * dt; pts[b + 1] += vel[i * 3 + 1] * dt; pts[b + 2] += vel[i * 3 + 2] * dt;
      if (i % GROUPS !== g) continue;
      field(pts[b], pts[b + 1], pts[b + 2], out);
      ambient(pts[b], pts[b + 1], pts[b + 2], time, p3);
      vel[i * 3] = p3[0] + out[0]; vel[i * 3 + 1] = p3[1] + out[1] - 0.035 * (0.5 + kind[i * 2 + 1]); vel[i * 3 + 2] = p3[2] + out[2];   // marine snow sinks slowly
      life[i] -= gdt;
      if (life[i] <= 0) respawn(i, 1);
    }
    stats.energy = energy;
  }
  function respawn(i, k) {
    spawn(p3, k, random, true);
    const b = i * 4;
    pts[b] = p3[0]; pts[b + 1] = p3[1]; pts[b + 2] = p3[2]; pts[b + 3] = 0;
    life[i] = 15 + random() * 50;
    if (i < count) { rise[i] = 0; refr[i] = random() * 0.5; }
  }
  return { count, snow, rings, total, pts, vel, kind, rise, refr, peak, tau, step, stats, flashCount: () => stats.flashes };
}
