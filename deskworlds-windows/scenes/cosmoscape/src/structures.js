// Procedural target structures for the morph: a neural network and a mycelial network, each a point set with
// exactly `count` points in the periodic unit box. Both are built as tapered tubes (position, radius and
// brightness at each end) plus a few dense spots (somata, boutons, colony cores), then sampled: the point
// budget is shared out in proportion to tube length times thickness, and each point sits at a random place
// along its tube with a gaussian offset across it, so thick processes are bright and dense, thin ones faint.
// Deterministic for a seed. Output per point: position (xyz, in [0,1)), heat in [0,1] (what kind of
// structure it belongs to: amber somata and cores, blue-white trunks, dim fine twigs) and pulse (distance
// along its fibre, which the shader uses for travelling pulses).
import { randomGenerator } from '../../shared/random.js';
import { swirl } from './morph.js';

const TAU = Math.PI * 2;
const wd = d => d - Math.round(d);
const wrap = x => x - Math.floor(x);

function createBuilder(rng) {
  let cap = 1 << 15, n = 0, spots = [];
  let A = new Float32Array(cap * 3), B = new Float32Array(cap * 3), F = new Float32Array(cap * 6);   // r0 r1 h0 h1 s0 s1
  // Gaussian deviates from a table of 4096 Box-Muller samples drawn once: a cheap, deterministic stand-in.
  const table = new Float32Array(4096);
  for (let i = 0; i < 4096; i += 2) { const r = Math.sqrt(-2 * Math.log(1 - rng())), a = TAU * rng(); table[i] = r * Math.cos(a); table[i + 1] = r * Math.sin(a); }
  const gauss = () => table[(rng() * 4096) | 0];
  function grow() {
    cap *= 2;
    const a = new Float32Array(cap * 3); a.set(A); A = a;
    const b = new Float32Array(cap * 3); b.set(B); B = b;
    const f = new Float32Array(cap * 6); f.set(F); F = f;
  }
  return {
    rng, gauss,
    get tubes() { return n; },
    tube(ax, ay, az, bx, by, bz, r0, r1, h0, h1, s0, s1) {
      if (n === cap) grow();
      const o = n * 3, p = n * 6;
      A[o] = ax; A[o + 1] = ay; A[o + 2] = az; B[o] = bx; B[o + 1] = by; B[o + 2] = bz;
      F[p] = r0; F[p + 1] = r1; F[p + 2] = h0; F[p + 3] = h1; F[p + 4] = s0; F[p + 5] = s1;
      n++;
    },
    spot(x, y, z, radius, weight, heat, s = 0) { spots.push({ x, y, z, radius, weight, heat, s }); },
    spots, data: () => ({ A, B, F, n }),
  };
}

// Shares `count` points between tubes and spots and generates them.
function sample(builder, count, spotShare) {
  const { A, B, F, n } = builder.data(), { rng, gauss, spots } = builder;
  const pos = new Float32Array(count * 3), heat = new Float32Array(count), pulse = new Float32Array(count);
  const tubeWeight = new Float64Array(n);
  let tw = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3, len = Math.hypot(B[o] - A[o], B[o + 1] - A[o + 1], B[o + 2] - A[o + 2]);
    tw += tubeWeight[i] = len * (0.5 * (F[i * 6] + F[i * 6 + 1]) + 0.0005);
  }
  let sw = 0;
  for (const s of spots) sw += s.weight;
  const spotBudget = spots.length ? Math.round(count * spotShare) : 0;
  let k = 0;
  // Spots first: gaussian blobs.
  let swAcc = 0, done = 0;
  for (const s of spots) {
    swAcc += s.weight;
    const upto = Math.round((swAcc / sw) * spotBudget);
    for (; done < upto && k < count; done++, k++) {
      const x = gauss(), y = gauss(), z = gauss();
      pos[k * 3] = wrap(s.x + x * s.radius * 0.55); pos[k * 3 + 1] = wrap(s.y + y * s.radius * 0.55); pos[k * 3 + 2] = wrap(s.z + z * s.radius * 0.55);
      heat[k] = Math.min(1, s.heat * (0.9 + 0.1 * rng())); pulse[k] = s.s;
    }
  }
  const tubeBudget = count - k;
  let acc = 0, issued = 0;
  for (let i = 0; i < n; i++) {
    acc += tubeWeight[i];
    const upto = Math.round((acc / tw) * tubeBudget);
    const o = i * 3, p = i * 6;
    const dx = B[o] - A[o], dy = B[o + 1] - A[o + 1], dz = B[o + 2] - A[o + 2];
    const len = Math.hypot(dx, dy, dz) || 1e-9;
    // Perpendicular frame.
    let ux = dy * 0 - dz * 1, uy = dz * 0 - dx * 0, uz = dx * 1 - dy * 0;   // d x (0,0,1)... replaced below if degenerate
    ux = -dy; uy = dx; uz = 0;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6 * len) { ux = 0; uy = -dz; uz = dy; ul = Math.hypot(uy, uz) || 1; }
    ux /= ul; uy /= ul; uz /= ul;
    const vx = (dy * uz - dz * uy) / len, vy = (dz * ux - dx * uz) / len, vz = (dx * uy - dy * ux) / len;
    for (; issued < upto && k < count; issued++, k++) {
      const t = rng(), r = F[p] + (F[p + 1] - F[p]) * t;
      const cx = gauss() * r * 0.5, cy = gauss() * r * 0.5;
      pos[k * 3] = wrap(A[o] + dx * t + ux * cx + vx * cy);
      pos[k * 3 + 1] = wrap(A[o + 1] + dy * t + uy * cx + vy * cy);
      pos[k * 3 + 2] = wrap(A[o + 2] + dz * t + uz * cx + vz * cy);
      heat[k] = F[p + 2] + (F[p + 3] - F[p + 2]) * t; pulse[k] = F[p + 4] + (F[p + 5] - F[p + 4]) * t;
    }
  }
  // Rounding leftovers: repeat the last tube's points (stay on structure).
  for (; k < count; k++) { const s = k - 1 >= 0 ? k - 1 : 0; pos[k * 3] = pos[s * 3]; pos[k * 3 + 1] = pos[s * 3 + 1]; pos[k * 3 + 2] = pos[s * 3 + 2]; heat[k] = heat[s]; pulse[k] = pulse[s]; }
  return { pos, heat, pulse, tubes: n, spots: spots.length };
}

const unit = (b) => { const x = b.gauss(), y = b.gauss(), z = b.gauss(), l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A direction at angle `ang` from d, in a random plane.
function deflect(b, d, ang) {
  const r = unit(b), p = norm(cross(d, r));
  return norm([d[0] * Math.cos(ang) + p[0] * Math.sin(ang), d[1] * Math.cos(ang) + p[1] * Math.sin(ang), d[2] * Math.cos(ang) + p[2] * Math.sin(ang)]);
}

// ---------------------------------------------------------------------------------------------------------
// Neural network
// ---------------------------------------------------------------------------------------------------------
export const NEURAL = { neurons: 44, minGap: 0.12, hubs: 6 };

export function generateNeural(count, seed = 1, options = {}) {
  const P = { ...NEURAL, ...options };
  const rng = randomGenerator((seed ^ 0x51ed270b) >>> 0);
  const b = createBuilder(rng);
  const somas = [];
  for (let attempt = 0; somas.length < P.neurons && attempt < 4000; attempt++) {
    const p = [rng(), rng(), rng()];
    if (somas.every(s => Math.hypot(wd(s.p[0] - p[0]), wd(s.p[1] - p[1]), wd(s.p[2] - p[2])) >= P.minGap * (attempt > 3000 ? 0.6 : 1))) somas.push({ p, axis: unit(b) });
  }
  const hubs = Array.from({ length: P.hubs }, () => [rng(), rng(), rng()]);
  const near = (p, list) => { let best = 0, bd = 9; list.forEach((q, i) => { const d = Math.hypot(wd(q[0] - p[0]), wd(q[1] - p[1]), wd(q[2] - p[2])); if (d < bd) { bd = d; best = i; } }); return best; };

  // A branching tree grown from `start` along `dir`; returns nothing, adds tubes.
  function tree(start, dir, r0, depth0, maxDepth, length0, heat, s0, tropism, soma) {
    const stack = [{ p: start.slice(), d: dir, r: r0, depth: depth0, s: s0, len: length0 }];
    while (stack.length) {
      const it = stack.pop(), segs = 3, seg = it.len / segs;
      let p = it.p, d = it.d, r = it.r, s = it.s;
      const end = r * (it.depth === 0 ? 0.85 : 0.8);
      for (let k = 0; k < segs; k++) {
        d = norm([d[0] + b.gauss() * 0.3 + tropism[0], d[1] + b.gauss() * 0.3 + tropism[1], d[2] + b.gauss() * 0.3 + tropism[2]]);
        // Dendrites avoid their own soma: push gently outward.
        if (soma) { const o = norm([p[0] - soma[0], p[1] - soma[1], p[2] - soma[2]]); d = norm([d[0] + 0.12 * o[0], d[1] + 0.12 * o[1], d[2] + 0.12 * o[2]]); }
        const q = [p[0] + d[0] * seg, p[1] + d[1] * seg, p[2] + d[2] * seg];
        const ra = r + (end - r) * (k / segs), rb = r + (end - r) * ((k + 1) / segs);
        b.tube(p[0], p[1], p[2], q[0], q[1], q[2], ra, rb, heat(ra), heat(rb), s, s + seg);
        p = q; s += seg;
      }
      if (it.depth < maxDepth) {
        for (const side of [1, -1]) {
          if (it.depth >= 2 && rng() < 0.22) continue;
          const nd = deflect(b, d, 0.45 + 0.4 * rng());
          stack.push({ p: p.slice(), d: nd, r: end * 0.92, depth: it.depth + 1, s, len: it.len * (0.8 + 0.1 * rng()) });
          if (side === 1 && rng() < 0.1) break;
        }
      } else b.spot(p[0], p[1], p[2], 0.0022, 0.35, 0.85, s);   // terminal bouton / spine head
    }
  }

  somas.forEach((n, index) => {
    const [x, y, z] = n.p;
    b.spot(x, y, z, 0.0085, 30, 0.96, 0);
    // Dendrites: one long apical one along the neuron's axis, four or five basal ones around the soma.
    const dh = r => 0.28 + 0.4 * Math.min(1, r / 0.0032);
    const nb = 4 + (rng() < 0.5 ? 1 : 0);
    tree(n.p, n.axis, 0.0034, 0, 4, 0.07, dh, 0, [n.axis[0] * 0.035, n.axis[1] * 0.035, n.axis[2] * 0.035], n.p);
    for (let i = 0; i < nb; i++) {
      const dir = norm(unit(b).map((v, c) => v - 0.7 * n.axis[c]));
      tree(n.p, dir, 0.0029, 0, 4, 0.05, dh, 0, [0, 0, 0], n.p);
    }
    // Axon: soma -> out the far side -> a hub (where bundles form) -> a distant neuron, with collaterals.
    const hub = hubs[near(n.p, hubs)];
    let target = (index + 1 + Math.floor(rng() * (somas.length - 1))) % somas.length;
    for (let tries = 0; tries < 8 && near(somas[target].p, hubs) === near(n.p, hubs); tries++) target = (index + 1 + Math.floor(rng() * (somas.length - 1))) % somas.length;
    const way = [n.p.slice()];
    const push = raw => { const last = way[way.length - 1]; way.push([last[0] + wd(raw[0] - last[0]), last[1] + wd(raw[1] - last[1]), last[2] + wd(raw[2] - last[2])]); };
    push([x - n.axis[0] * 0.07, y - n.axis[1] * 0.07, z - n.axis[2] * 0.07]);
    push([hub[0] + b.gauss() * 0.012, hub[1] + b.gauss() * 0.012, hub[2] + b.gauss() * 0.012]);
    const tp = somas[target].p;
    push([tp[0] + b.gauss() * 0.04, tp[1] + b.gauss() * 0.04, tp[2] + b.gauss() * 0.04]);
    const bulge = unit(b);
    const path = [];   // dense polyline of the spline
    const cr = (p0, p1, p2, p3, t) => p0.map((_, c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t));
    for (let w = 0; w < way.length - 1; w++) {
      const p0 = way[Math.max(0, w - 1)], p1 = way[w], p2 = way[w + 1], p3 = way[Math.min(way.length - 1, w + 2)];
      const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]), steps = Math.max(4, Math.ceil(span / 0.014));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, q = cr(p0, p1, p2, p3, t), wob = Math.sin(Math.PI * t) * 0.012 * Math.sin(w * 2 + t * 5);
        path.push([q[0] + bulge[0] * wob, q[1] + bulge[1] * wob, q[2] + bulge[2] * wob]);
      }
    }
    path.push(way[way.length - 1]);
    let s = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const u = i / path.length, ra = 0.0019 - 0.0008 * u, rb = 0.0019 - 0.0008 * (u + 1 / path.length);
      const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]);
      b.tube(path[i][0], path[i][1], path[i][2], path[i + 1][0], path[i + 1][1], path[i + 1][2], ra, rb, 0.58, 0.58, s, s + l);
      s += l;
      // Collaterals leave the axon sideways and end in small terminal arbors.
      if (i % 5 === 3 && rng() < 0.28) {
        const d = norm([path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]]);
        tree(path[i], deflect(b, d, 1.1 + 0.4 * rng()), 0.0011, 1, 3, 0.03, h => 0.42 + 0.3 * Math.min(1, h / 0.0014), s, [0, 0, 0], null);
      }
    }
    // Terminal arbor where the axon meets its target.
    const last = path[path.length - 1], prev = path[path.length - 2];
    tree(last, norm([last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]]), 0.0012, 1, 4, 0.034, r => 0.45 + 0.3 * Math.min(1, r / 0.0014), s, [0, 0, 0], null);
  });
  return { ...sample(b, count, 0.13), somas: somas.length };
}

// ---------------------------------------------------------------------------------------------------------
// Mycelium
// ---------------------------------------------------------------------------------------------------------
export const MYCELIUM = { colonies: 44, step: 0.013, branch: 0.1, anastomosis: 0.7, reach: 0.05 };

export function generateMycelium(count, seed = 1, options = {}) {
  const P = { ...MYCELIUM, ...options };
  const rng = randomGenerator((seed ^ 0x2c1b3c6d) >>> 0);
  const b = createBuilder(rng);
  const hyphae = [];   // { id, parent, tip:[x,y,z] }
  const mids = [];     // hyphal tube midpoints for anastomosis: x,y,z,id
  const cell = P.reach, grid = Math.ceil(1 / cell), hash = new Map();
  const key = (i, j, k) => (((i % grid) + grid) % grid) * grid * grid + (((j % grid) + grid) % grid) * grid + (((k % grid) + grid) % grid);
  const tmp = [0, 0, 0];
  const queue = [];
  const heatOf = (r, tipBoost) => Math.min(1, (0.28 + 0.42 * Math.min(1, Math.max(0, (r - 0.0004) / 0.0014))) * (tipBoost ? 1.35 : 1));
  const addHyphaTube = (id, p, q, ra, rb, s, tipBoost) => {
    b.tube(p[0], p[1], p[2], q[0], q[1], q[2], ra, rb, heatOf(ra, tipBoost), heatOf(rb, tipBoost), s, s + P.step);
    const m = [wrap((p[0] + q[0]) / 2), wrap((p[1] + q[1]) / 2), wrap((p[2] + q[2]) / 2)], idx = mids.length / 4;
    mids.push(m[0], m[1], m[2], id);
    const k = key(Math.floor(m[0] / cell), Math.floor(m[1] / cell), Math.floor(m[2] / cell));
    let list = hash.get(k);
    if (!list) hash.set(k, list = []);
    list.push(idx);
  };
  let nextId = 0;
  for (let c = 0; c < P.colonies; c++) {
    const centre = [rng(), rng(), rng()];
    b.spot(centre[0], centre[1], centre[2], 0.006, 3, 0.95, 0);
    const primaries = 9 + Math.floor(rng() * 5);
    for (let i = 0; i < primaries; i++) queue.push({ id: nextId++, parent: -1, p: centre.slice(), d: unit(b), r: 0.0014 + 0.0004 * rng(), len: 0.2 + 0.2 * rng(), s: 0, depth: 0 });
  }
  while (queue.length) {
    const h = queue.pop();
    let { p, d, r, s } = h;
    const steps = Math.max(3, Math.round(h.len / P.step));
    for (let k = 0; k < steps; k++) {
      // Persistent random walk bent by a slow swirl: hyphae curve like they follow a nutrient field.
      if (k % 3 === 0) swirl(tmp, p[0], p[1], p[2], 0);
      d = norm([d[0] + b.gauss() * 0.2 + tmp[0] * 0.16, d[1] + b.gauss() * 0.2 + tmp[1] * 0.16, d[2] + b.gauss() * 0.2 + tmp[2] * 0.16]);
      const q = [p[0] + d[0] * P.step, p[1] + d[1] * P.step, p[2] + d[2] * P.step];
      const rb = Math.max(0.00035, r * (1 - 0.35 / steps));
      addHyphaTube(h.id, p, q, r, rb, s, k >= steps - 3);
      if (h.depth < 5 && rng() < P.branch && b.tubes < 80000) {
        const side = deflect(b, d, 0.9 + 0.5 * rng());
        queue.push({ id: nextId++, parent: h.id, p: q.slice(), d: side, r: Math.max(0.0004, rb * 0.75), len: Math.max(0.05, (h.len - k * P.step) * (0.5 + 0.3 * rng())), s: s + P.step, depth: h.depth + 1 });
      }
      p = q; r = rb; s += P.step;
    }
    h.tip = p; h.dir = d; h.radius = r; h.s = s;
    hyphae.push(h);
  }
  // Anastomosis: a growing tip that meets another hypha fuses with it, closing a loop.
  const parent = new Map(hyphae.map(h => [h.id, h.parent]));
  let loops = 0;
  for (const h of hyphae) {
    if (rng() > P.anastomosis) continue;
    const [x, y, z] = h.tip, ci = Math.floor(x / cell), cj = Math.floor(y / cell), ck = Math.floor(z / cell);
    let best = -1, bd = P.reach * P.reach;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (let e = -1; e <= 1; e++) {
      const list = hash.get(key(ci + a, cj + c, ck + e));
      if (!list) continue;
      for (const m of list) {
        const id = mids[m * 4 + 3];
        if (id === h.id || id === h.parent || parent.get(id) === h.id) continue;
        const dx = wd(mids[m * 4] - x), dy = wd(mids[m * 4 + 1] - y), dz = wd(mids[m * 4 + 2] - z), d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd && d2 > 1e-6) { bd = d2; best = m; }
      }
    }
    if (best < 0) continue;
    const tx = x + wd(mids[best * 4] - x), ty = y + wd(mids[best * 4 + 1] - y), tz = z + wd(mids[best * 4 + 2] - z);
    // Quadratic arc leaving along the tip's heading, arriving at the other hypha.
    const L = Math.sqrt(bd), cx = x + h.dir[0] * L * 0.7, cy = y + h.dir[1] * L * 0.7, cz = z + h.dir[2] * L * 0.7;
    const segs = Math.max(3, Math.ceil(L / P.step));
    let p = h.tip, s = h.s;
    for (let k = 1; k <= segs; k++) {
      const t = k / segs, u = 1 - t;
      const q = [u * u * x + 2 * u * t * cx + t * t * tx, u * u * y + 2 * u * t * cy + t * t * ty, u * u * z + 2 * u * t * cz + t * t * tz];
      b.tube(p[0], p[1], p[2], q[0], q[1], q[2], h.radius, h.radius, 0.5, 0.5, s, s + P.step);
      p = q; s += P.step;
    }
    loops++;
  }
  return { ...sample(b, count, 0.04), hyphae: hyphae.length, loops };
}
