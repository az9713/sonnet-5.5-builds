// 3D Hilbert curve index (Skilling 2004, "Programming the Hilbert curve"): a space-filling curve whose
// consecutive indices are face-adjacent cells, so sorting points by it keeps spatial neighbours close in rank.
// Used to match two point sets by rank, a cheap approximation of optimal transport.
// Coordinates are integers in [0, 2^order); order <= 10 keeps the index inside 30 bits.

export function hilbertIndex(x, y, z, order) {
  // Branch-free form of Skilling's inverse-undo loop (the branches are unpredictable on scattered points).
  for (let b = order - 1; b >= 1; b--) {
    const Q = 1 << b, P = Q - 1;
    x ^= P & -((x >> b) & 1);
    let m = -((y >> b) & 1);
    x ^= P & m; let t = (x ^ y) & P & ~m; x ^= t; y ^= t;
    m = -((z >> b) & 1);
    x ^= P & m; t = (x ^ z) & P & ~m; x ^= t; z ^= t;
  }
  y ^= x; z ^= y;
  let t = 0;
  for (let b = order - 1; b >= 1; b--) t ^= ((1 << b) - 1) & -((z >> b) & 1);
  x ^= t; y ^= t; z ^= t;
  return ((spread(x) << 2) | (spread(y) << 1) | spread(z)) >>> 0;
}

// Puts two zero bits between each of the low 10 bits of v.
function spread(v) {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}

// Inverse: index to [x, y, z].
export function hilbertCoords(index, order, out = [0, 0, 0]) {
  let x = 0, y = 0, z = 0;
  for (let b = 0; b < order; b++) {
    const g = (index >>> (3 * b)) & 7;
    x |= ((g >> 2) & 1) << b; y |= ((g >> 1) & 1) << b; z |= (g & 1) << b;
  }
  const N = 2 << (order - 1);
  let t = z >> 1;
  z ^= y; y ^= x; x ^= t;
  for (let Q = 2; Q !== N; Q <<= 1) {
    const P = Q - 1;
    if (z & Q) x ^= P; else { t = (x ^ z) & P; x ^= t; z ^= t; }
    if (y & Q) x ^= P; else { t = (x ^ y) & P; x ^= t; y ^= t; }
    if (x & Q) x ^= P;
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

// Morton (Z-order) index, the alternative with weaker locality.
export function mortonIndex(x, y, z) {
  return ((spread(x) << 2) | (spread(y) << 1) | spread(z)) >>> 0;
}
