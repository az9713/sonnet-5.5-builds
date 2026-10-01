// A jellyfish: pulsing bell, swimming body, trailing tentacles and oral arms, and the steering that decides where it goes.
//
// Behaviour is a small state machine (drift, travel to a slowly changing goal, avoid the cursor) layered
// with continuous separation from the others and soft walls. A jellyfish cannot steer directly: it pulses,
// every power stroke gives a forward impulse along its bell axis, drag eats the velocity, so to go sideways
// it first tilts its axis toward the goal. Each stroke also sheds a vortex ring from the margin.
import { contraction, localContraction, thrustProfile, strokeImpulse, marginPoint, apexPoint, TC } from './pulse.js';
import { createChain, resetChain, stepChain, kickChain } from './chain.js';

export const FIXED_STEP = 1 / 60;
export const TANK_Z = [-21, -3.5];
export const NODE_W = 24;
const TAU = Math.PI * 2;
const DRAG = 1.3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };

// Half extents of the swimming volume at distance d from the camera: most of the frustum, so jellyfish may brush the frame edges.
export const CAM_TAN_V = 0.315;
export function tankHalf(d, aspect = 16 / 9) { return { hx: 0.92 * CAM_TAN_V * aspect * d, hy: 0.9 * CAM_TAN_V * d }; }
export function insideTank(pos, aspect = 16 / 9, slack = 0) {
  const d = -pos[2], h = tankHalf(d, aspect);
  return d >= -TANK_Z[1] - slack && d <= -TANK_Z[0] + slack && Math.abs(pos[0]) <= h.hx + slack && Math.abs(pos[1]) <= h.hy + slack;
}

export const VARIANTS = [
  { body: [0.30, 0.26, 0.95], gonad: [1.0, 0.32, 0.80], margin: [0.55, 0.45, 1.0] },     // moon jelly: pale violet, magenta gonads
  { body: [1.0, 0.34, 0.50], gonad: [1.0, 0.60, 0.22], margin: [1.0, 0.45, 0.5] },       // rose: pink bell, amber gonads
  { body: [0.10, 0.65, 1.0], gonad: [0.62, 1.0, 0.70], margin: [0.25, 0.85, 1.0] },      // cyan
  { body: [0.50, 0.66, 1.0], gonad: [1.0, 0.82, 0.45], margin: [0.7, 0.8, 1.0] },        // glass blue-white
];

export function createJelly(spec, random, index = 0) {
  const R = spec.size;
  const nT = spec.tentacles, nA = 4;
  const j = {
    index, size: R, variant: spec.variant, spec,
    pos: [spec.x, spec.y, spec.z], vel: [0, 0, 0], axis: norm([(random() - 0.5) * 0.4, 1, (random() - 0.5) * 0.4]), axisVel: [0, 0, 0], roll: random() * TAU, rollVel: 0,
    phase: random(), rate: 0, rateTarget: 0, baseRate: (0.34 + random() * 0.22) / Math.pow(R, 0.18), amp: 0.8, vigor: 0.4, strokes: 0, strokeJ: 0, strokeStart: 0,
    mode: 'drift', modeT: 2 + random() * 6, goal: [spec.x, spec.y, spec.z], disturbed: 0, avoidT: 0, time: 0, lastImpulse: 0, speed: 0,
    seed: random() * 100, lobes: spec.lobes ?? (random() < 0.5 ? 16 : 12), oval: [random() * TAU, random() * TAU], wallBias: 1,
    basis: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, hang: [0, -1, 0],
    chains: [], rings: [], ringCursor: 0, nodes: null, rows: 0, pulseEvent: 0,
    zBand: spec.zBand || [spec.z - 2, spec.z + 2], migrate: random() * TAU,
  };
  // tentacles around the margin, then four oral arms from the manubrium
  const root = [0, 0, 0];
  for (let k = 0; k < nT; k++) {
    const phi = (k + (random() - 0.5) * 0.7) / nT * TAU, len = R * spec.tentLen * (0.65 + 0.7 * random());
    const ch = createChain(spec.nodesT || 16, len / ((spec.nodesT || 16) - 1));
    ch.drag = 5 + 3 * random(); ch.bend = 0.09 + 0.03 * random(); ch.damping = 0.955; ch.hang = 0.025;
    j.chains.push({ kind: 0, phi, chain: ch, tw: 0.8 + 0.6 * random(), seed: random() });
  }
  for (let k = 0; k < nA; k++) {
    const phi = (k + 0.5) / nA * TAU + (random() - 0.5) * 0.3, len = R * spec.armLen * (0.8 + 0.4 * random());
    const ch = createChain(spec.nodesA || 20, len / ((spec.nodesA || 20) - 1));
    ch.drag = 7; ch.bend = 0.09; ch.hang = 0.015; ch.damping = 0.96;
    j.chains.push({ kind: 1, phi, chain: ch, tw: 1.0, seed: random() });
  }
  j.rows = j.chains.length;
  j.nodes = new Float32Array(j.rows * NODE_W * 4);
  for (let r = 0; r < 4; r++) j.rings.push({ alive: false, age: 0, c: [0, 0, 0], dir: [0, -1, 0], radius: 0, speed: 0, gamma: 0, spin: 0, phi0: 0 });
  updateBasis(j);
  for (const c of j.chains) { rootOf(j, c, root); resetChain(c.chain, root[0], root[1], root[2], -j.axis[0], -j.axis[1], -j.axis[2]); }
  j.rate = j.rateTarget = j.baseRate;
  pickGoal(j, random, 0);
  return j;
}

const BH = [0, 0, 0], BX = [0, 0, 0], BZ = [0, 0, 0];
function updateBasis(j) {
  const y = j.axis, h = BH, x = BX, z = BZ;
  if (Math.abs(y[1]) < 0.9) { h[0] = 0; h[1] = 1; h[2] = 0; } else { h[0] = 1; h[1] = 0; h[2] = 0; }
  x[0] = h[1] * y[2] - h[2] * y[1]; x[1] = h[2] * y[0] - h[0] * y[2]; x[2] = h[0] * y[1] - h[1] * y[0]; norm(x);
  z[0] = y[1] * x[2] - y[2] * x[1]; z[1] = y[2] * x[0] - y[0] * x[2]; z[2] = y[0] * x[1] - y[1] * x[0];
  const cs = Math.cos(j.roll), sn = Math.sin(j.roll), b = j.basis;
  for (let k = 0; k < 3; k++) { b.x[k] = x[k] * cs + z[k] * sn; b.z[k] = -x[k] * sn + z[k] * cs; b.y[k] = y[k]; }
}
// local (bell) -> world
export function toWorld(j, lx, ly, lz, out) {
  const b = j.basis;
  out[0] = j.pos[0] + b.x[0] * lx + b.y[0] * ly + b.z[0] * lz;
  out[1] = j.pos[1] + b.x[1] * lx + b.y[1] * ly + b.z[1] * lz;
  out[2] = j.pos[2] + b.x[2] * lx + b.y[2] * ly + b.z[2] * lz;
  return out;
}
const loc = [0, 0, 0];
function rootOf(j, c, out) {
  if (c.kind === 0) marginPoint(j.size, j.phase, j.amp, c.phi, loc);
  else { apexPoint(j.size, j.phase, j.amp, loc); loc[0] = 0.07 * j.size * Math.cos(c.phi); loc[2] = 0.07 * j.size * Math.sin(c.phi); loc[1] -= 0.17 * j.size; }
  return toWorld(j, loc[0], loc[1], loc[2], out);
}

function pickGoal(j, random, time) {
  const z = j.zBand[0] + (j.zBand[1] - j.zBand[0]) * random();
  const h = tankHalf(-z, j.aspect || 16 / 9);
  const m = 0.25 + j.size * 0.4;
  // Each animal ranges around its own patch of water; its preferred depth also drifts slowly up and down (vertical migration).
  const home = j.spec.home || [0, 0], roam = j.spec.roam || [h.hx * 0.7, h.hy * 0.6];
  const yPref = Math.sin(time * 0.045 + j.migrate) * roam[1] * 0.5;
  j.goal[0] = clamp(home[0] + (random() * 2 - 1) * roam[0], -h.hx * 0.88 + m, h.hx * 0.88 - m);
  j.goal[1] = clamp(home[1] + yPref + (random() * 2 - 1) * roam[1] * 0.6, -h.hy * 0.85, h.hy * 0.85);
  j.goal[2] = z;
}

// world: { time, aspect, ambient(x,y,z,out), flow(x,y,z,out), cursor:{on,x,y,z,sx,sy,depth}, jellies, random, splat(...), cameraPos }
const a_z = j => j.axis[2];
export function stepJelly(j, dt, w) {
  j.time = w.time; j.aspect = w.aspect;
  const t = w.time, random = w.random;
  const p = j.pos, v = j.vel;
  w.ambient(p[0], p[1], p[2], t, tmpFlow);
  const uw0 = tmpFlow[0], uw1 = tmpFlow[1], uw2 = tmpFlow[2];

  // --- cursor: the nearer the pointer passes (in the frame, at this animal's depth), the more it is disturbed
  let away0 = 0, away1 = 0, influence = 0;
  const cur = w.cursor;
  if (cur.on) {
    const d = -p[2], k = d / cur.depth;                       // ray point at this depth
    const cx = cur.cx * k, cy = cur.cy * k;
    const dx = p[0] - cx, dy = p[1] - cy, dist = Math.hypot(dx, dy);
    const reach = 0.9 + j.size * 1.8;
    const depthW = clamp(1 - Math.abs(d - cur.depth) / 6.5, 0, 1);
    influence = depthW * clamp((reach - dist) / reach, 0, 1);
    if (influence > 0) { away0 = dx / (dist + 0.05); away1 = dy / (dist + 0.05); }
  }
  j.disturbed = Math.max(j.disturbed * Math.exp(-dt / 1.8), influence);
  // --- state machine
  j.modeT -= dt;
  const gx = j.goal[0] - p[0], gy = j.goal[1] - p[1], gz = j.goal[2] - p[2], gd = Math.hypot(gx, gy, gz);
  if (j.disturbed > 0.25) { j.mode = 'avoid'; j.modeT = 1.2; }
  else if (j.mode === 'avoid' && j.modeT <= 0) { j.mode = 'drift'; j.modeT = 1 + random() * 3; }
  else if (j.mode === 'drift' && j.modeT <= 0) { pickGoal(j, random, t); j.mode = 'travel'; j.modeT = 10 + random() * 14; }
  else if (j.mode === 'travel' && (gd < 0.6 + j.size || j.modeT <= 0)) { j.mode = 'drift'; j.modeT = 5 + random() * 12; }

  // desired heading and stroke vigor from the state
  let target0 = 0, target1 = 1, target2 = 0, vigor = 0.38 + 0.08 * Math.sin(t * 0.21 + j.seed);
  if (j.mode === 'travel') {
    const il = 1 / (gd + 1e-6);
    // never swim apex-down: the bell can lean sideways to head for the goal, and falls toward a lower one
    target0 = gx * il * 0.95; target2 = gz * il * 0.2; target1 = Math.max(0.35, 0.55 + gy * il * 0.6);
    vigor = gy < -0.5 ? 0.3 : 0.75 + 0.3 * Math.min(1, gd / 4);
  } else if (j.mode === 'avoid') {
    target0 = away0 * 0.9; target1 = 0.7 + Math.max(0, away1) * 0.5; target2 = 0;
    vigor = 1.1 + 0.4 * j.disturbed;
  }
  target0 += 0.18 * Math.sin(t * 0.23 + j.seed) + uw0 * 1.5; target2 += 0.06 * Math.cos(t * 0.19 + j.seed * 1.3) + uw2 * 0.6;
  target2 -= a_z(j) * 0.8;
  const tl = Math.hypot(target0, target1, target2);
  target0 /= tl; target1 /= tl; target2 /= tl;

  // --- axis: spring-damped toward the heading (a bit of overshoot, so the bell rocks)
  const a = j.axis, av = j.axisVel;
  av[0] += ((target0 - a[0]) * 7 - av[0] * 3.6) * dt; av[1] += ((target1 - a[1]) * 7 - av[1] * 3.6) * dt; av[2] += ((target2 - a[2]) * 7 - av[2] * 3.6) * dt;
  a[0] += av[0] * dt; a[1] += av[1] * dt; a[2] += av[2] * dt; norm(a);
  j.rollVel += ((uw0 - uw2) * 0.8 + 0.05 * Math.sin(t * 0.15 + j.seed) - j.rollVel) * Math.min(1, dt);
  j.roll += j.rollVel * dt;

  // --- pulse: rate follows vigor and disturbance smoothly; a stroke starts each time the phase wraps
  j.vigor += (vigor - j.vigor) * Math.min(1, 1.2 * dt);
  j.rateTarget = j.baseRate * (0.78 + 0.5 * j.vigor + 0.55 * j.disturbed);
  j.rate += (j.rateTarget - j.rate) * Math.min(1, 1.5 * dt);
  const before = j.phase;
  j.phase += j.rate * dt;
  j.pulseEvent = 0;
  if (j.phase >= 1) {
    j.phase -= 1; j.strokes++;
    j.amp = clamp(0.62 + 0.4 * j.vigor + 0.15 * (random() - 0.5), 0.45, 1.15);
    j.strokeJ = strokeImpulse(j.size, j.vigor) * (0.9 + 0.2 * random());
    // the stroke kicks the bell axis a little sideways: real jellyfish rock as they pulse
    av[0] += (random() - 0.5) * 0.5; av[2] += (random() - 0.5) * 0.5;
    j.pulseEvent = 1;
    // the stroke whips the filaments up with the bell; they trail behind again as it relaxes
    for (let r = 0; r < j.chains.length; r++) { const k = (j.chains[r].kind === 0 ? 0.9 : 0.5) * j.strokeJ * (0.8 + 0.4 * random()); kickChain(j.chains[r].chain, dt, a[0] * k, a[1] * k, a[2] * k); }
  }
  // thrust: the impulse is delivered over the power stroke, along the bell axis (apex first)
  const th = thrustProfile(j.phase) * j.rate * dt * j.strokeJ;
  v[0] += a[0] * th; v[1] += a[1] * th; v[2] += a[2] * th;
  j.lastImpulse = th / dt;
  // vortex ring shed as the stroke completes
  if (before < TC && j.phase >= TC) spawnRing(j);

  // --- translation: drag toward the water velocity, buoyancy, separation, soft walls
  const sink = -0.07;
  v[0] += (-(v[0] - 0.75 * uw0) * DRAG) * dt; v[1] += (-(v[1] - 0.75 * uw1) * DRAG + sink) * dt; v[2] += (-(v[2] - 0.75 * uw2) * DRAG) * dt;
  if (influence > 0) { v[0] += away0 * influence * 1.8 * dt; v[1] += away1 * influence * 1.8 * dt; }
  for (const o of w.jellies) {
    if (o === j) continue;
    const dx = p[0] - o.pos[0], dy = p[1] - o.pos[1], dz = p[2] - o.pos[2], d = Math.hypot(dx, dy, dz) + 1e-6;
    const want = (j.size + o.size) * 1.9 + 0.7;
    if (d < want) { const f = (want - d) / want * 1.4 * dt / d; v[0] += dx * f; v[1] += dy * f; v[2] += dz * f * 0.6; }
  }
  const h = tankHalf(-p[2], j.aspect), mx = 0.3 + j.size * 0.2, my = 0.2;
  const wall = (x, lo, hi, k) => (x < lo ? (lo - x) * k : x > hi ? (hi - x) * k : 0);
  v[0] += wall(p[0], -h.hx + mx, h.hx - mx, 1.2) * dt; v[1] += wall(p[1], -h.hy + my, h.hy - my, 1.2) * dt;
  v[2] += wall(p[2], j.zBand[0], j.zBand[1], 1.0) * dt;
  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
  // hard guarantees: stay inside the tank volume and keep clear of each other
  clampInside(j);
  for (const o of w.jellies) {
    if (o === j) continue;
    const dx = p[0] - o.pos[0], dy = p[1] - o.pos[1], dz = p[2] - o.pos[2], d = Math.hypot(dx, dy, dz) + 1e-9;
    const min = (j.size + o.size) * 1.15;
    if (d < min) { const s = (min - d) * 0.5 / d; p[0] += dx * s; p[1] += dy * s; p[2] += dz * s; o.pos[0] -= dx * s; o.pos[1] -= dy * s; o.pos[2] -= dz * s; }
  }
  j.speed = Math.hypot(v[0], v[1], v[2]);

  updateBasis(j);
  // --- filaments follow their roots
  const root = tmpRoot;
  j.hang[0] = -j.basis.y[0]; j.hang[1] = -j.basis.y[1] - 0.15; j.hang[2] = -j.basis.y[2];
  norm(j.hang);
  for (let r = 0; r < j.chains.length; r++) {
    const c = j.chains[r];
    rootOf(j, c, root);
    stepChain(c.chain, dt, root[0], root[1], root[2], j.hang[0], j.hang[1], j.hang[2], w.flow);
  }
  // --- vortex rings travel behind the bell and fade
  for (const r of j.rings) {
    if (!r.alive) continue;
    r.age += dt;
    r.speed *= Math.exp(-dt / 1.1); r.radius *= 1 + 0.09 * dt;
    r.c[0] += (r.dir[0] * r.speed + j.vel[0] * 0.15) * dt; r.c[1] += (r.dir[1] * r.speed + j.vel[1] * 0.15) * dt; r.c[2] += (r.dir[2] * r.speed + j.vel[2] * 0.15) * dt;
    r.spin += dt * 5;
    if (r.age > 4) r.alive = false;
  }
}
const tmpFlow = [0, 0, 0, 0], tmpRoot = [0, 0, 0];

function clampInside(j) {
  const p = j.pos, v = j.vel, h = tankHalf(-p[2], j.aspect || 16 / 9);
  const z0 = Math.max(TANK_Z[0] + 0.4, j.zBand[0] - 0.5), z1 = Math.min(TANK_Z[1] - 0.2, j.zBand[1] + 0.5);
  if (p[2] < z0) { p[2] = z0; if (v[2] < 0) v[2] = 0; } if (p[2] > z1) { p[2] = z1; if (v[2] > 0) v[2] = 0; }
  const hx = tankHalf(-p[2], j.aspect || 16 / 9).hx, hy = tankHalf(-p[2], j.aspect || 16 / 9).hy;
  if (p[0] < -hx) { p[0] = -hx; if (v[0] < 0) v[0] = 0; } if (p[0] > hx) { p[0] = hx; if (v[0] > 0) v[0] = 0; }
  if (p[1] < -hy) { p[1] = -hy; if (v[1] < 0) v[1] = 0; } if (p[1] > hy) { p[1] = hy; if (v[1] > 0) v[1] = 0; }
}

function spawnRing(j) {
  const r = j.rings[j.ringCursor++ % j.rings.length];
  const m = marginPoint(j.size, TC, j.amp, 0, loc), mr = Math.hypot(m[0], m[2]);
  toWorld(j, 0, m[1] - 0.04 * j.size, 0, r.c);
  r.alive = true; r.age = 0; r.radius = Math.max(0.12, mr * 0.95);
  r.dir[0] = -j.axis[0]; r.dir[1] = -j.axis[1]; r.dir[2] = -j.axis[2];
  r.speed = (0.55 + 0.9 * j.vigor) * Math.sqrt(j.size) * 1.5; r.gamma = 1; r.spin = 0; r.phi0 = j.seed;
}

// Writes node positions and cumulative arc length into the texture data (rows x NODE_W x 4).
export function fillNodes(j) {
  let o = 0;
  for (let r = 0; r < j.chains.length; r++) {
    const ch = j.chains[r].chain, n = ch.n;
    let s = 0;
    for (let i = 0; i < NODE_W; i++, o += 4) {
      const k = Math.min(i, n - 1) * 3;
      if (i > 0 && i < n) s += ch.rest;
      j.nodes[o] = ch.pos[k]; j.nodes[o + 1] = ch.pos[k + 1]; j.nodes[o + 2] = ch.pos[k + 2]; j.nodes[o + 3] = s;
    }
  }
}
