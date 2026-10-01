// The water: a damped 2-D wave equation on a grid, h'' = c^2 laplacian(h) - damping, stepped
// at the fixed 1/60 s. The GPU runs exactly this update in a fragment shader (SIM_FRAG in
// shaders.js is generated from the constants here); this module is the CPU reference the tests
// check for stability, symmetry and reflection.
//
// State per cell: h (height, m), v (velocity, m per step), foam (0..1 agitation).
export const SIM = {
  size: 300,            // m, the simulated square
  minX: -150, minZ: -312,
  c: 6.0,               // m/s, wave speed
  step: 1 / 60,
  damp: 0.40,           // 1/s, energy loss of the open water
  visc: 0.045,          // diffusion of velocity: ripples spread and soften as they travel
  sponge: 14,           // cells over which the edge absorbs part of an arriving wave
  spongeLoss: 0.10,     // extra loss per step at the very edge
  leak: 0.20,           // 1/s, level drains back to rest so injected volume does not pile up
  foamDecay: 0.72,      // 1/s
  drive: 0.4,           // how firmly a driven disturbance pulls the surface toward its velocity, per step
  maxDisturbances: 48,
};

export function simConstants(N) {
  const dx = SIM.size / N;
  return {
    k: (SIM.c * SIM.step / dx) ** 2,
    visc: SIM.visc,
    keep: Math.exp(-SIM.damp * SIM.step),
    foamKeep: Math.exp(-SIM.foamDecay * SIM.step),
    hKeep: Math.exp(-SIM.leak * SIM.step),
    dx,
  };
}

export function createWaveSim(N = 128) {
  const { k, visc, keep, foamKeep, hKeep, dx } = simConstants(N);
  const h = new Float32Array(N * N), v = new Float32Array(N * N), foam = new Float32Array(N * N);
  const h2 = new Float32Array(N * N), v2 = new Float32Array(N * N);
  const idx = (i, j) => Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i));
  // Absorption near the edge, 0 inside: a soft shore rather than a hard wall.
  const edgeLoss = (i, j) => {
    const d = Math.min(i, j, N - 1 - i, N - 1 - j);
    const f = Math.max(0, 1 - d / SIM.sponge);
    return SIM.spongeLoss * f * f;
  };
  const sim = {
    N, dx, h, v, foam, k,
    // A gaussian disturbance at world metres (x, z). A positive radius adds an impulse of velocity;
    // a negative radius drives the surface toward a velocity (the way a moving body pushes water),
    // which is bounded however long it is applied.
    inject(x, z, radius, amount, foamAmount = 0) {
      const drive = radius < 0; radius = Math.abs(radius);
      const gx = (x - SIM.minX) / dx, gz = (z - SIM.minZ) / dx, r = radius / dx, r2 = r * r;
      const i0 = Math.max(0, Math.floor(gx - 3 * r)), i1 = Math.min(N - 1, Math.ceil(gx + 3 * r));
      const j0 = Math.max(0, Math.floor(gz - 3 * r)), j1 = Math.min(N - 1, Math.ceil(gz + 3 * r));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const g = Math.exp(-((i + 0.5 - gx) ** 2 + (j + 0.5 - gz) ** 2) / r2);
        if (drive) v[j * N + i] += (amount - v[j * N + i]) * g * SIM.drive;
        else v[j * N + i] += amount * g;
        foam[j * N + i] = Math.min(1, foam[j * N + i] + foamAmount * g);
      }
    },
    step() {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const lapH = h[idx(i - 1, j)] + h[idx(i + 1, j)] + h[idx(i, j - 1)] + h[idx(i, j + 1)] - 4 * h[c];
        const lapV = v[idx(i - 1, j)] + v[idx(i + 1, j)] + v[idx(i, j - 1)] + v[idx(i, j + 1)] - 4 * v[c];
        v2[c] = (v[c] + k * lapH + visc * lapV) * keep * (1 - edgeLoss(i, j));
      }
      for (let c = 0; c < N * N; c++) { h2[c] = (h[c] + v2[c]) * hKeep; }
      h.set(h2); v.set(v2);
      for (let c = 0; c < N * N; c++) foam[c] *= foamKeep;
    },
    // Kinetic plus potential energy (arbitrary units, comparable between calls).
    energy() {
      let e = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const gx = h[idx(i + 1, j)] - h[c], gz = h[idx(i, j + 1)] - h[c];
        e += 0.5 * v[c] * v[c] + 0.5 * k * (gx * gx + gz * gz);
      }
      return e;
    },
  };
  return sim;
}

// The GLSL update, built from the same constants so GPU and CPU agree.
export function simShader(N) {
  const c = simConstants(N);
  return /* glsl */`
uniform sampler2D uState;
uniform vec2 uTexel;
uniform int uCount;
uniform vec4 uD[${SIM.maxDisturbances}];
uniform float uF[${SIM.maxDisturbances}];
uniform float uReset;
varying vec2 vUv;
vec3 at(vec2 uv){ return texture2D(uState, clamp(uv, 0.5*uTexel, 1.0 - 0.5*uTexel)).rgb; }
void main(){
  vec3 s = at(vUv);
  vec3 l = at(vUv - vec2(uTexel.x, 0.0)), r = at(vUv + vec2(uTexel.x, 0.0)), d = at(vUv - vec2(0.0, uTexel.y)), u = at(vUv + vec2(0.0, uTexel.y));
  float lapH = l.x + r.x + d.x + u.x - 4.0*s.x;
  float lapV = l.y + r.y + d.y + u.y - 4.0*s.y;
  vec2 cell = vUv/uTexel;
  float edge = min(min(cell.x, cell.y), min(1.0/uTexel.x - cell.x, 1.0/uTexel.y - cell.y));
  float f = max(0.0, 1.0 - edge/${SIM.sponge.toFixed(1)});
  float vel = (s.y + ${c.k.toFixed(6)}*lapH + ${c.visc.toFixed(5)}*lapV)*${c.keep.toFixed(6)}*(1.0 - ${SIM.spongeLoss.toFixed(4)}*f*f);
  float foam = s.z*${c.foamKeep.toFixed(6)};
  vec2 world = vec2(${SIM.minX.toFixed(1)}, ${SIM.minZ.toFixed(1)}) + vUv*${SIM.size.toFixed(1)};
  for (int i = 0; i < ${SIM.maxDisturbances}; i++) {
    if (i >= uCount) break;
    vec2 q = world - uD[i].xy;
    float rr = abs(uD[i].z);
    float g = exp(-dot(q, q)/(rr*rr));
    if (uD[i].z < 0.0) vel += (uD[i].w - vel)*g*${SIM.drive.toFixed(2)};
    else vel += uD[i].w*g;
    foam = min(1.0, foam + uF[i]*g);
  }
  float h = (s.x + vel)*${c.hKeep.toFixed(6)};
  gl_FragColor = vec4(h, vel, foam, 1.0)*(1.0 - uReset);
}
`;
}
