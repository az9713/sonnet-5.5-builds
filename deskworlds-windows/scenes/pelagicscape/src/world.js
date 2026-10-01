// The whole pelagic world as pure simulation: jellyfish, comb jellies, plankton, and the one shared water.
//
// Everything that moves feels the same field: the ambient current (flow.js) plus the disturbance grid, into which the
// cursor, the bell margins, the swimming bodies and the vortex rings all stir. Tentacles bend in it, plankton flash in
// its shear, marine snow is carried by it.
import { randomGenerator } from '../../shared/random.js';
import { ambientFlow, createAmbientLattice } from './flow.js';
import { createDisturbance, createPlankton, resizePlankton } from './bio.js';
import { createJelly, stepJelly, fillNodes, tankHalf, CAM_TAN_V, FIXED_STEP, NODE_W, TANK_Z } from './jelly.js';
import { createComb, stepComb } from './comb.js';
import { createChain, resetChain, stepChain } from './chain.js';
import { TC } from './pulse.js';

export { FIXED_STEP, NODE_W };
export const COUNTS = {
  eco: { plankton: 4000, snow: 350, combs: 4 },
  balanced: { plankton: 12000, snow: 900, combs: 5 },
  detail: { plankton: 24000, snow: 1600, combs: 6 },
  native: { plankton: 24000, snow: 1600, combs: 6 },
};
// What each quality tier costs. The wallpaper's `native` tier falls back to `balanced` on battery (shared/render-policy.js).
export function tierCounts(quality) { return COUNTS[quality] || COUNTS.balanced; }
export const CURSOR_DEPTH = 7.4;
const RING_MARKERS = 40;

// Composition for a 16:9 frame: a large near jellyfish low on the left, a sharp one in the middle, smaller ones receding, dark space top right.
const SPECS = [
  { x: -1.6, y: -0.5, z: -5.0, size: 1.0, variant: 0, tentacles: 20, tentLen: 3.0, armLen: 2.0, zBand: [-5.7, -4.4], home: [-1.7, -0.7], roam: [1.3, 0.8] },
  { x: 1.5, y: 0.35, z: -8.6, size: 0.62, variant: 1, tentacles: 32, tentLen: 2.5, armLen: 1.9, zBand: [-9.8, -7.4], home: [1.8, 0.4], roam: [2.0, 1.2] },
  { x: -3.7, y: 1.5, z: -11.6, size: 0.52, variant: 2, tentacles: 40, tentLen: 1.5, armLen: 1.5, zBand: [-12.6, -10.4], home: [-3.8, 1.4], roam: [1.6, 1.3] },
  { x: 5.4, y: 1.9, z: -14.6, size: 0.42, variant: 3, tentacles: 24, tentLen: 3.0, armLen: 2.0, zBand: [-15.6, -13.6], home: [5.2, 1.7], roam: [1.8, 1.5] },
  { x: -0.2, y: -1.9, z: -18.8, size: 0.62, variant: 0, tentacles: 28, tentLen: 2.4, armLen: 1.8, zBand: [-19.8, -17.6], home: [0.2, -1.8], roam: [3.5, 1.8] },
];
const COMB_SPECS = [
  [0.4, 1.3, -7.2, 0.24], [-2.4, -0.4, -9.6, 0.2], [3.3, -1.0, -6.4, 0.26], [-0.8, -1.5, -6.0, 0.2], [2.6, 2.0, -10.2, 0.2], [-4.8, -0.9, -7.8, 0.22],
];

export function createWorld({ seed = 1, quality = 'balanced', aspect = 16 / 9 } = {}) {
  const rng = randomGenerator(seed);
  const prng = randomGenerator((seed ^ 0x9e3779b9) >>> 0);   // plankton have their own stream, so a tier change never alters the animals
  const counts = COUNTS[quality] || COUNTS.balanced;
  const world = { time: 0, aspect, quality, steps: 0, camera: { x: 0, y: 0, z: 0, tanV: CAM_TAN_V } };
  const disturbance = createDisturbance();
  const tmp = [0, 0, 0, 0], tmp2 = [0, 0, 0];

  // --- shared water
  const lattice = createAmbientLattice();
  lattice.update(0);
  const flow = (x, y, z, out) => {       // ambient + disturbance (for filaments)
    disturbance.sample(x, y, z, tmp);
    lattice.sample(x, y, z, tmp2);
    // Filaments feel wakes more gently than the plankton do: a stirred wake sways them rather than tying them in knots.
    const m = Math.hypot(tmp[0], tmp[1], tmp[2]), k = m > 1e-6 ? 0.3 * Math.min(1, 1.6 / m) : 0;
    out[0] = tmp[0] * k + tmp2[0]; out[1] = tmp[1] * k + tmp2[1]; out[2] = tmp[2] * k + tmp2[2]; out[3] = tmp[3];
  };
  const ambient = (x, y, z, t, out) => lattice.sample(x, y, z, out);
  const exactAmbient = (x, y, z, t, out) => ambientFlow(x, y, z, t, out);

  // --- animals
  const jellies = SPECS.map((s, i) => createJelly(s, rng, i));
  for (const j of jellies) j.aspect = aspect;
  // All comb jellies exist and swim all the time (cheap); a tier only decides how many are shown, so switching tiers never makes one jump.
  const combs = COMB_SPECS.map(([x, y, z, size], i) => {
    const c = createComb({ x, y, z, size, zBand: [z - 1.5, z + 1.5] }, randomGenerator(seed * 7919 + i * 104729 + 13));
    c.index = i; c.length = size * 2.5;
    c.chains = [];
    for (let k = 0; k < 2; k++) {
      const ch = createChain(14, 0.1); ch.drag = 5; ch.bend = 0.035; ch.hang = 0.004;
      c.chains.push({ chain: ch, side: k ? 1 : -1 });
    }
    c.nodes = new Float32Array(2 * NODE_W * 4);
    c.maxLen = size * 11;
    return c;
  });
  const cursor = { on: false, cx: 0, cy: 0, depth: CURSOR_DEPTH, px: 0, py: 0, hasPrev: false, vx: 0, vy: 0, sx: 0, sy: 0 };

  // --- plankton
  const near = (p, rngf) => {
    const j = jellies[(rngf() * jellies.length) | 0];
    const r = j.size * (0.9 + 1.2 * rngf()), th = rngf() * Math.PI * 2, ph = Math.acos(2 * rngf() - 1);
    p[0] = j.pos[0] + r * Math.sin(ph) * Math.cos(th); p[1] = j.pos[1] + r * Math.cos(ph) * 1.2 - j.size * 0.5; p[2] = j.pos[2] + r * Math.sin(ph) * Math.sin(th);
  };
  const spawn = (p, kind, rngf, respawn) => {
    if (kind === 0 && rngf() < 0.25) { near(p, rngf); return p; }
    let d;
    if (kind === 0) d = rngf() < 0.8 ? CURSOR_DEPTH - 1.3 + rngf() * 2.6 : 3.8 + rngf() * 17;
    else d = 3.8 + rngf() * 17.5;
    const h = tankHalf(d, Math.max(world.aspect, 1.6));
    p[0] = (rngf() * 2 - 1) * h.hx * 1.1; p[1] = (rngf() * 2 - 1) * h.hy * 1.15; p[2] = -d;
    return p;
  };
  let plankton = createPlankton({ count: counts.plankton, snow: counts.snow, rings: jellies.length * 4 * RING_MARKERS, random: prng, spawn });
  let tier = COUNTS[quality] ? quality : 'balanced', combCount = counts.combs;
  const field = (x, y, z, out) => disturbance.sample(x, y, z, out);

  // --- cursor
  function setCursor(nx, ny) {     // normalised device coordinates, -1..1, y up
    const tanH = CAM_TAN_V * world.aspect;
    cursor.cx = world.camera.x + nx * tanH * CURSOR_DEPTH; cursor.cy = world.camera.y + ny * CAM_TAN_V * CURSOR_DEPTH;
    cursor.sx = nx; cursor.sy = ny;
    if (!cursor.on) { cursor.px = cursor.cx; cursor.py = cursor.cy; }
    cursor.on = true;
  }
  function releaseCursor() { cursor.on = false; }

  const wctx = { time: 0, aspect, ambient: exactAmbient, flow, cursor, jellies, random: rng };
  let cursorTrail = 0;

  function stirCursor(dt) {
    if (!cursor.on) { cursor.vx = cursor.vy = 0; return; }
    const dx = cursor.cx - cursor.px, dy = cursor.cy - cursor.py, dist = Math.hypot(dx, dy);
    const vx = dx / dt, vy = dy / dt, speed = Math.hypot(vx, vy);
    const k = speed > 14 ? 14 / speed : 1;
    cursor.vx = vx * k; cursor.vy = vy * k;
    if (dist > 1e-4) {
      const sigma = 0.34, n = Math.min(10, Math.ceil(dist / (sigma * 0.8)));
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        disturbance.splat(cursor.px + dx * f, cursor.py + dy * f, -CURSOR_DEPTH, cursor.vx, cursor.vy, 0, sigma, 22 / n * 1.6, dt, 1.1);
      }
    }
    cursor.px = cursor.cx; cursor.py = cursor.cy;
  }

  const sp = [0, 0, 0], sm = [0, 0, 0];
  function stirJelly(j, dt) {
    const R = j.size, strokeNow = j.phase < TC + 0.12;
    // the body drags water with it
    if (j.speed > 0.12) {
      disturbance.splat(j.pos[0], j.pos[1], j.pos[2], j.vel[0], j.vel[1], j.vel[2], 0.55 * R + 0.15, 7, dt);
    }
    if (strokeNow && (world.steps & 1) === 0) {
      // the margin sweeps in and a jet leaves downward: shear all round the rim
      const thr = Math.sin(Math.min(1, j.phase / TC) * Math.PI);
      const jet = (1.6 + 2.6 * j.vigor) * Math.sqrt(R) * thr;
      const nm = 6;
      for (let k = 0; k < nm; k++) {
        const phi = (k + (j.strokes & 1) * 0.5) / nm * Math.PI * 2;
        toWorldLocal(j, R * 0.98 * Math.cos(phi), -0.22 * R, R * 0.98 * Math.sin(phi), sp);
        const rx = Math.cos(phi) * j.basis.x[0] + Math.sin(phi) * j.basis.z[0], ry = Math.cos(phi) * j.basis.x[1] + Math.sin(phi) * j.basis.z[1], rz = Math.cos(phi) * j.basis.x[2] + Math.sin(phi) * j.basis.z[2];
        disturbance.splat(sp[0], sp[1], sp[2], -j.axis[0] * jet - rx * jet * 0.5, -j.axis[1] * jet - ry * jet * 0.5, -j.axis[2] * jet - rz * jet * 0.5, 0.2 + 0.25 * R, 26, dt * 2);
      }
    }
    for (const r of j.rings) {
      if (!r.alive || r.speed < 0.15) continue;
      const nr = 6, sigma = 0.1 + 0.3 * r.radius;
      const bx = j.basis.x, bz = j.basis.z;
      for (let k = 0; k < nr; k++) {
        const phi = r.phi0 + k / nr * Math.PI * 2, cx = Math.cos(phi), sx = Math.sin(phi);
        const px = r.c[0] + r.radius * (cx * bx[0] + sx * bz[0]), py = r.c[1] + r.radius * (cx * bx[1] + sx * bz[1]), pz = r.c[2] + r.radius * (cx * bx[2] + sx * bz[2]);
        const v = r.speed * 2.4;
        disturbance.splat(px, py, pz, r.dir[0] * v, r.dir[1] * v, r.dir[2] * v, sigma, 16, dt, sigma);
      }
    }
  }
  function toWorldLocal(j, lx, ly, lz, out) {
    const b = j.basis;
    out[0] = j.pos[0] + b.x[0] * lx + b.y[0] * ly + b.z[0] * lz; out[1] = j.pos[1] + b.x[1] * lx + b.y[1] * ly + b.z[1] * lz; out[2] = j.pos[2] + b.x[2] * lx + b.y[2] * ly + b.z[2] * lz;
  }

  const combBounds = c => {
    const h = tankHalf(-c.pos[2], world.aspect);
    for (let k = 0; k < 2; k++) { const lim = k === 0 ? h.hx : h.hy; if (c.pos[k] < -lim) { c.pos[k] = -lim; c.vel[k] = Math.abs(c.vel[k]); } if (c.pos[k] > lim) { c.pos[k] = lim; c.vel[k] = -Math.abs(c.vel[k]); } }
    const z0 = c.zBand[0], z1 = c.zBand[1];
    if (c.pos[2] < z0) { c.pos[2] = z0; c.vel[2] = Math.abs(c.vel[2]); } if (c.pos[2] > z1) { c.pos[2] = z1; c.vel[2] = -Math.abs(c.vel[2]); }
  };
  const combW = (x, y, z, o) => { flow(x, y, z, o); };

  function step(dt = FIXED_STEP) {
    world.time += dt; world.steps++;
    wctx.time = world.time; wctx.aspect = world.aspect;
    // slow camera drift
    const t = world.time;
    world.camera.x = 0.11 * Math.sin(t * 0.043) + 0.05 * Math.sin(t * 0.101 + 1); world.camera.y = 0.07 * Math.sin(t * 0.037 + 2) + 0.03 * Math.sin(t * 0.091);
    if (world.time - lattice.stamp > 0.2) lattice.update(world.time);
    disturbance.step(dt);
    stirCursor(dt);
    for (const j of jellies) stepJelly(j, dt, wctx);
    for (const j of jellies) stirJelly(j, dt);
    for (const c of combs) {
      stepComb(c, dt, t, combW, combBounds);
      const L = c.length, b = c.basis;
      for (let k = 0; k < 2; k++) {
        const ch = c.chains[k], s = ch.side;
        const o0 = c.size * 0.55 * s, o1 = L * 0.18;
        const rx = c.pos[0] + b.x[0] * o0 + b.y[0] * o1, ry = c.pos[1] + b.x[1] * o0 + b.y[1] * o1, rz = c.pos[2] + b.x[2] * o0 + b.y[2] * o1;
        if (!ch.init) { resetChain(ch.chain, rx, ry, rz, b.y[0], b.y[1], b.y[2]); ch.init = true; }
        ch.chain.rest = Math.max(0.01, c.ext * c.maxLen / 13);
        stepChain(ch.chain, dt, rx, ry, rz, b.y[0] * 0.8, b.y[1] * 0.8 - 0.2, b.y[2] * 0.8, flow);
      }
    }
    // plankton, then the vortex ring markers
    plankton.step(dt, field, ambient, t);
  }

  // Ring markers: a torus of glowing points swirling around each live ring. Cheap; refreshed once per drawn frame.
  function updateMarkers() {
    const pts = plankton.pts, base = plankton.count + plankton.snow;
    let m = 0;
    for (const j of jellies) {
      for (const r of j.rings) {
        for (let k = 0; k < RING_MARKERS; k++, m++) {
          const b = (base + m) * 4;
          if (!r.alive) { pts[b + 3] = 0; continue; }
          const phi = r.phi0 + k / RING_MARKERS * Math.PI * 2, psi = r.spin * (1.6 + 0.5 * Math.sin(k * 2.1)) + k * 1.3;
          const rho = 0.2 * r.radius * (1 + 0.4 * Math.sin(k * 1.7)), c = Math.cos(phi), s = Math.sin(phi);
          const rr = r.radius + rho * Math.cos(psi), dz = rho * Math.sin(psi);
          const bx = j.basis.x, bz = j.basis.z;
          pts[b] = r.c[0] + rr * (c * bx[0] + s * bz[0]) + r.dir[0] * dz; pts[b + 1] = r.c[1] + rr * (c * bx[1] + s * bz[1]) + r.dir[1] * dz; pts[b + 2] = r.c[2] + rr * (c * bx[2] + s * bz[2]) + r.dir[2] * dz;
          const age = r.age;
          pts[b + 3] = 0.95 * Math.exp(-age / 1.35) * Math.min(1, age / 0.12) * (0.7 + 0.3 * Math.sin(psi));
        }
      }
    }
  }

  function fillAll() {
    for (const j of jellies) fillNodes(j);
    for (const c of combs) {
      let o = 0;
      for (const ch of c.chains) {
        const n = ch.chain.n; let s = 0;
        for (let i = 0; i < NODE_W; i++, o += 4) {
          const k = Math.min(i, n - 1) * 3; if (i > 0 && i < n) s += ch.chain.rest;
          c.nodes[o] = ch.chain.pos[k]; c.nodes[o + 1] = ch.chain.pos[k + 1]; c.nodes[o + 2] = ch.chain.pos[k + 2]; c.nodes[o + 3] = s;
        }
      }
    }
    updateMarkers();
  }

  // Switches quality tier in place: jellyfish, tentacles, the water and every surviving particle keep their state.
  function setTier(name) {
    const next = COUNTS[name] ? name : 'balanced', c = COUNTS[next];
    if (next === tier) return false;
    tier = next; combCount = c.combs;
    if (c.plankton !== plankton.count || c.snow !== plankton.snow) plankton = resizePlankton(plankton, { count: c.plankton, snow: c.snow, random: prng, spawn });
    api.plankton = plankton;
    return true;
  }

  function setAspect(a) { world.aspect = a; for (const j of jellies) j.aspect = a; }

  function diagnostics() {
    return {
      time: world.time, jellyfish: jellies.length, combJellies: combCount, plankton: plankton.count, snow: plankton.snow,
      tier, tentacles: jellies.reduce((s, j) => s + j.chains.length, 0), strokes: jellies.map(j => j.strokes),
      flashes: plankton.stats.flashes, flashEnergy: plankton.stats.energy, disturbedCells: disturbance.active,
      rings: jellies.reduce((s, j) => s + j.rings.filter(r => r.alive).length, 0), modes: jellies.map(j => j.mode),
      cursor: cursor.on, jellyPositions: jellies.map(j => j.pos.map(v => Math.round(v * 100) / 100)),
    };
  }
  const api = { world, jellies, combs, plankton, disturbance, cursor, step, fillAll, setCursor, releaseCursor, setAspect, setTier, diagnostics, flow, ambient, get tier() { return tier; }, get combCount() { return combCount; } };
  return api;
}
