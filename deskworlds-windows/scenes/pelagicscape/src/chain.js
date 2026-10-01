// A trailing filament: a chain of nodes pulled along by its root.
//
// Each tentacle or oral arm is a position-based Verlet chain. Per step a node
//  - keeps its own velocity (inertia, lightly damped),
//  - is dragged toward the local water velocity (the shared flow field, so currents and wakes bend it),
//  - is nudged toward continuing straight on from its parent (bending stiffness), and toward hanging along a
//    preferred direction (trailing behind the swimmer), and
//  - is held to its rest length by distance constraints, a few Gauss-Seidel sweeps from the root, then one
//    exact follow-the-leader pass so lengths never drift.
// The root is moved by the caller (the bell margin), so the tip responds a beat later: a travelling wave
// whose amplitude grows toward the free end.

export function createChain(n, restLength) {
  return {
    n, rest: restLength, pos: new Float32Array(n * 3), prev: new Float32Array(n * 3), mass: new Float32Array(n),
    drag: 6, damping: 0.99, bend: 0.03, hang: 0.006, buoyancy: 0, sweeps: 3,
  };
}

// Straight line from root along dir.
export function resetChain(ch, rx, ry, rz, dx, dy, dz) {
  const { n, rest, pos, prev, mass } = ch;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= l; dy /= l; dz /= l;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    pos[k] = prev[k] = rx + dx * rest * i; pos[k + 1] = prev[k + 1] = ry + dy * rest * i; pos[k + 2] = prev[k + 2] = rz + dz * rest * i;
    mass[i] = 1 + 2.2 * (1 - i / (n - 1)) ** 2;   // heavier near the root so the root end follows the bell, the tip whips
  }
  mass[0] = 0;
}

const u = new Float32Array(4), su = new Float32Array(3 * 64);
const STRIDE = 3;   // the water is sampled every third node and interpolated: it varies slowly along a filament
// Advances the chain by dt. root: [x, y, z]; hang: preferred direction of the free part (unit, trailing);
// sample(x, y, z, out): water velocity.
export function stepChain(ch, dt, rx, ry, rz, hx, hy, hz, sample) {
  const { n, rest, pos, prev, mass, drag, damping, bend, hang, buoyancy, sweeps } = ch;
  pos[0] = rx; pos[1] = ry; pos[2] = rz;
  const inv = 1 / dt, d2 = dt * dt;
  for (let i = 1; ; i += STRIDE) {
    if (i > n - 1) i = n - 1;
    sample(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], u);
    su[i * 3] = u[0]; su[i * 3 + 1] = u[1]; su[i * 3 + 2] = u[2];
    if (i === n - 1) break;
  }
  for (let i = 1; i < n; i++) {
    const k = i * 3;
    const vx = (pos[k] - prev[k]) * inv, vy = (pos[k + 1] - prev[k + 1]) * inv, vz = (pos[k + 2] - prev[k + 2]) * inv;
    const i0 = 1 + Math.floor((i - 1) / STRIDE) * STRIDE, i1 = Math.min(i0 + STRIDE, n - 1), fw = i1 > i0 ? (i - i0) / (i1 - i0) : 0;
    const wx = su[i0 * 3] + (su[i1 * 3] - su[i0 * 3]) * fw, wy = su[i0 * 3 + 1] + (su[i1 * 3 + 1] - su[i0 * 3 + 1]) * fw, wz = su[i0 * 3 + 2] + (su[i1 * 3 + 2] - su[i0 * 3 + 2]) * fw;
    // Drag grows toward the tip: thin, light free ends are more easily pushed around by the water.
    const w = drag * (0.6 + 0.8 * i / (n - 1));
    const ax = (wx - vx) * w, ay = (wy - vy) * w + buoyancy, az = (wz - vz) * w;
    // Bending stiffness and hanging preference act as positional pulls toward where a stiff, trailing filament would be.
    const p = (i - 1) * 3;
    let tx, ty, tz;
    if (i >= 2) {
      const q = (i - 2) * 3;
      const sx = pos[p] - pos[q], sy = pos[p + 1] - pos[q + 1], sz = pos[p + 2] - pos[q + 2];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      tx = pos[p] + sx / sl * rest; ty = pos[p + 1] + sy / sl * rest; tz = pos[p + 2] + sz / sl * rest;
    } else { tx = pos[p] + hx * rest; ty = pos[p + 1] + hy * rest; tz = pos[p + 2] + hz * rest; }
    const hxp = pos[p] + hx * rest, hyp = pos[p + 1] + hy * rest, hzp = pos[p + 2] + hz * rest;
    const damp = Math.pow(damping, dt * 60);
    let nx = pos[k] + (pos[k] - prev[k]) * damp + ax * d2;
    let ny = pos[k + 1] + (pos[k + 1] - prev[k + 1]) * damp + ay * d2;
    let nz = pos[k + 2] + (pos[k + 2] - prev[k + 2]) * damp + az * d2;
    nx += (tx - nx) * bend + (hxp - nx) * hang; ny += (ty - ny) * bend + (hyp - ny) * hang; nz += (tz - nz) * bend + (hzp - nz) * hang;
    prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
    pos[k] = nx; pos[k + 1] = ny; pos[k + 2] = nz;
  }
  // Distance constraints: mass-weighted sweeps, then an exact follow-the-leader pass.
  for (let it = 0; it < sweeps; it++) {
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * 3, b = i * 3;
      const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, e = (l - rest) / l;
      const wa = mass[i - 1] === 0 ? 0 : 1 / mass[i - 1], wb = 1 / mass[i], ws = wa + wb;
      const ka = wa / ws, kb = wb / ws;
      pos[a] += dx * e * ka; pos[a + 1] += dy * e * ka; pos[a + 2] += dz * e * ka;
      pos[b] -= dx * e * kb; pos[b + 1] -= dy * e * kb; pos[b + 2] -= dz * e * kb;
    }
    pos[0] = rx; pos[1] = ry; pos[2] = rz;
  }
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, e = rest / l;
    pos[b] = pos[a] + dx * e; pos[b + 1] = pos[a + 1] + dy * e; pos[b + 2] = pos[a + 2] + dz * e;
  }
}

// Retractable chains: change the rest length (all segments); positions are re-projected by the next step.
export function setRest(ch, rest) { ch.rest = rest; }

// A sudden push on the whole filament (a power stroke): the root end is carried with the bell, the free end is flicked,
// and the drag then takes the speed away again. v is the velocity given to the tip; it is shared out toward the tip.
export function kickChain(ch, dt, vx, vy, vz) {
  const { n, prev } = ch;
  for (let i = 1; i < n; i++) {
    const w = i / (n - 1), k = i * 3;
    prev[k] -= vx * w * dt; prev[k + 1] -= vy * w * dt; prev[k + 2] -= vz * w * dt;
  }
}
