import { BODY_LEN, topAt } from './whale-shape.js';

// The whale's skeleton: NJ joints along the spine from the nose to the end of the peduncle,
// recomputed from curvature every step. Nothing is posed from a clip. Three things bend it:
//   * a slow turn bend that follows the yaw rate, delayed more toward the tail (the body
//     swings round after the head, like a long boat turning),
//   * the arch of a surfacing roll or a terminal dive, set by the behaviour,
//   * a travelling DORSOVENTRAL wave: cetaceans beat their flukes up and down, so the
//     curvature wave lives in the vertical plane, grows toward the tail and lags in phase.
// The fluke and flippers then trail on underdamped springs, each point of a fin answering a
// little later than the one nearer the root.
export const NJ = 24;
export const IP = 7;                  // joint the whale pivots about (about a third back from the nose)
export const FIXED_STEP = 1 / 60;
export const LAG_DELAYS = [0, 0.12, 0.27, 0.46];   // s by which the lag reaches points from root to tip
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (x, target, rate, dt) => x + (target - x) * (1 - Math.exp(-rate * dt));
const HN = 64;                        // history length (s * 60) for the delayed fin lag

export function createRig({ scale = 1, phase = 0 } = {}) {
  const JD = BODY_LEN * scale / (NJ - 1);
  const P = new Float32Array(NJ * 3), T = new Float32Array(NJ * 3), U = new Float32Array(NJ * 3);
  const lx = new Float64Array(NJ), ly = new Float64Array(NJ), lz = new Float64Array(NJ);   // joint positions in the body frame
  const alpha = new Float64Array(NJ), beta = new Float64Array(NJ);
  const kTurn = new Float64Array(NJ), kPitch = new Float64Array(NJ);
  const wet = new Float32Array(NJ).fill(1);
  // Fin lag: 3 fins (fluke, left flipper, right flipper) x 4 delays x (forward, up, right).
  const lag = new Float32Array(36);
  const spring = [0, 1, 2].map(() => ({ x: [0, 0, 0], v: [0, 0, 0] }));
  const hist = [0, 1, 2].map(() => new Float32Array(HN * 3));
  let hi = 0, hn = 0;
  const rig = {
    scale, JD, P, T, U, kTurn, kPitch, wet, lag,
    tailPhase: phase, tailFreq: 0.3, tailAmp: 0.012, arch: 0,
    // pose set by the behaviour each step
    pos: [0, -1, 0], yaw: Math.PI / 2, pitch: 0, roll: 0,
    F: [0, 0, -1], Up: [0, 1, 0], S: [1, 0, 0],
    vel: [0, 0, 0], acc: [0, 0, 0], tailVelUp: 0,
    _prevPos: null, _prevVel: [0, 0, 0], _prevTail: null, _prevY: new Float32Array(NJ),
    jointVY: new Float32Array(NJ),
    time: 0, started: false, nsteps: 0,
  };

  function basis() {
    const cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw), cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
    const F = [cp * cy, sp, -cp * sy];
    const U0 = [-sp * cy, cp, sp * sy];
    const S0 = [F[1] * U0[2] - F[2] * U0[1], F[2] * U0[0] - F[0] * U0[2], F[0] * U0[1] - F[1] * U0[0]];
    const cr = Math.cos(rig.roll), sr = Math.sin(rig.roll);
    const Uv = [U0[0] * cr + S0[0] * sr, U0[1] * cr + S0[1] * sr, U0[2] * cr + S0[2] * sr];
    const Sv = [F[1] * Uv[2] - F[2] * Uv[1], F[2] * Uv[0] - F[0] * Uv[2], F[0] * Uv[1] - F[1] * Uv[0]];
    rig.F = F; rig.Up = Uv; rig.S = Sv;
  }

  // `c` carries what the behaviour wants this step.
  rig.step = function step(dt, c) {
    rig.time += dt;
    const { speed = 0, yawRate = 0, pitchRate = 0, beat = 0.3, arch = 0 } = c;
    rig.pos[0] = c.x; rig.pos[1] = c.y; rig.pos[2] = c.z;
    rig.yaw = c.yaw; rig.pitch = c.pitch; rig.roll = c.roll;
    basis();
    const { F, Up, S } = rig;

    // velocity and acceleration of the pivot, for the fin lag
    if (rig._prevPos) {
      for (let k = 0; k < 3; k++) {
        rig.vel[k] = (rig.pos[k] - rig._prevPos[k]) / dt;
        rig.acc[k] = rig.nsteps >= 2 ? (rig.vel[k] - rig._prevVel[k]) / dt : 0;
        rig._prevVel[k] = rig.vel[k];
      }
    } else rig._prevPos = [0, 0, 0];
    rig.nsteps++;
    for (let k = 0; k < 3; k++) rig._prevPos[k] = rig.pos[k];

    // tail beat: slow and long, a fraction of a hertz; amplitude and rate rise with effort
    rig.arch = approach(rig.arch, arch, 1.3, dt);
    const f = 0.22 + 0.36 * beat;
    rig.tailFreq = approach(rig.tailFreq, f, 0.8, dt);
    rig.tailAmp = approach(rig.tailAmp, 0.025 + 0.15 * beat, 1.2, dt);
    rig.tailPhase += TAU * rig.tailFreq * dt;

    const L = BODY_LEN * scale, kw = TAU / (1.05 * L);
    const turnTarget = clamp(-yawRate / Math.max(speed, 1.2), -0.2, 0.2) * 1.0;
    const pitchTarget = clamp(pitchRate / Math.max(speed, 1.2), -0.2, 0.2) * 0.8;
    for (let i = 0; i < NJ; i++) {
      const sd = i * JD, u = sd / L;
      const tau = 0.25 + 1.8 * Math.pow(u, 1.4);
      const wTurn = sstep(0.12, 0.40, u);
      kTurn[i] = approach(kTurn[i], turnTarget * wTurn, 1 / tau, dt);
      kPitch[i] = approach(kPitch[i], pitchTarget * wTurn, 1 / tau, dt);
    }
    const kappaP = (i) => {
      const sd = i * JD, u = sd / L;
      const und = rig.tailAmp * Math.pow(sstep(0.22, 1.0, u), 1.15) * Math.cos(rig.tailPhase - kw * sd) / scale;
      const archK = rig.arch * 0.145 * Math.sin(Math.PI * clamp(u * 1.02, 0, 1)) ** 0.9 / scale;
      return kPitch[i] + und + archK;
    };
    alpha[IP] = 0; beta[IP] = 0; lx[IP] = 0; ly[IP] = 0; lz[IP] = 0;
    for (let i = IP + 1; i < NJ; i++) { alpha[i] = alpha[i - 1] + kTurn[i] * JD; beta[i] = beta[i - 1] + kappaP(i) * JD; }
    for (let i = IP - 1; i >= 0; i--) { alpha[i] = alpha[i + 1] - kTurn[i] * JD; beta[i] = beta[i + 1] - kappaP(i) * JD; }
    // tangent(a, b) = (cos a cos b, sin b, -sin a cos b) in (forward, up, right); the tail lies behind (subtract)
    for (let i = IP + 1; i < NJ; i++) {
      const a = (alpha[i] + alpha[i - 1]) / 2, b = (beta[i] + beta[i - 1]) / 2, cb = Math.cos(b);
      lx[i] = lx[i - 1] - JD * Math.cos(a) * cb; ly[i] = ly[i - 1] - JD * Math.sin(b); lz[i] = lz[i - 1] + JD * Math.sin(a) * cb;
    }
    for (let i = IP - 1; i >= 0; i--) {
      const a = (alpha[i] + alpha[i + 1]) / 2, b = (beta[i] + beta[i + 1]) / 2, cb = Math.cos(b);
      lx[i] = lx[i + 1] + JD * Math.cos(a) * cb; ly[i] = ly[i + 1] + JD * Math.sin(b); lz[i] = lz[i + 1] - JD * Math.sin(a) * cb;
    }
    for (let i = 0; i < NJ; i++) {
      for (let k = 0; k < 3; k++) P[i * 3 + k] = rig.pos[k] + F[k] * lx[i] + Up[k] * ly[i] + S[k] * lz[i];
    }
    for (let i = 0; i < NJ; i++) {
      const a = Math.max(i - 1, 0), b = Math.min(i + 1, NJ - 1);
      let tx = P[a * 3] - P[b * 3], ty = P[a * 3 + 1] - P[b * 3 + 1], tz = P[a * 3 + 2] - P[b * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const d = Up[0] * tx + Up[1] * ty + Up[2] * tz;
      let ux = Up[0] - tx * d, uy = Up[1] - ty * d, uz = Up[2] - tz * d;
      const ul = Math.hypot(ux, uy, uz) || 1;
      T[i * 3] = tx; T[i * 3 + 1] = ty; T[i * 3 + 2] = tz;
      U[i * 3] = ux / ul; U[i * 3 + 1] = uy / ul; U[i * 3 + 2] = uz / ul;
      rig.jointVY[i] = rig.started ? (P[i * 3 + 1] - rig._prevY[i]) / dt : 0;
      rig._prevY[i] = P[i * 3 + 1];
    }

    // tail velocity relative to the body, along the tail's own up, drives the fluke's flex
    const tl = (NJ - 1) * 3;
    if (rig._prevTail && rig.nsteps > 2) {
      let vx = (P[tl] - rig._prevTail[0]) / dt - rig.vel[0], vy = (P[tl + 1] - rig._prevTail[1]) / dt - rig.vel[1], vz = (P[tl + 2] - rig._prevTail[2]) / dt - rig.vel[2];
      rig.tailVelUp = vx * U[tl] + vy * U[tl + 1] + vz * U[tl + 2];
    } else rig._prevTail = [0, 0, 0];
    rig.started = true;
    rig._prevTail[0] = P[tl]; rig._prevTail[1] = P[tl + 1]; rig._prevTail[2] = P[tl + 2];

    // Fin lag targets in the body frame (forward, up, right): fins are displaced against
    // acceleration and against the sweep of the rear body, and follow through an underdamped
    // spring so they stream behind, overshoot a little and settle.
    const accF = rig.acc[0] * F[0] + rig.acc[1] * F[1] + rig.acc[2] * F[2];
    const accU = rig.acc[0] * Up[0] + rig.acc[1] * Up[1] + rig.acc[2] * Up[2];
    const accS = rig.acc[0] * S[0] + rig.acc[1] * S[1] + rig.acc[2] * S[2];
    const tg = [
      [-accF * 0.3, -clamp(rig.tailVelUp, -3, 3) * 0.30 - accU * 0.2, -yawRate * 0.9 - accS * 0.3],
      [-accF * 0.22, -accU * 0.16 + pitchRate * 0.4, -yawRate * 0.45 - accS * 0.22],
      [-accF * 0.22, -accU * 0.16 + pitchRate * 0.4, -yawRate * 0.45 - accS * 0.22],
    ];
    const W = [5.2, 4.3, 4.3], Z = [0.38, 0.42, 0.42], MAXL = [1.1, 0.55, 0.55];
    for (let f = 0; f < 3; f++) {
      const sp = spring[f], tv = tg[f];
      let n = Math.hypot(tv[0], tv[1], tv[2]);
      const sc = n > MAXL[f] ? MAXL[f] / n : 1;
      for (let k = 0; k < 3; k++) {
        const target = tv[k] * sc;
        sp.v[k] += (W[f] * W[f] * (target - sp.x[k]) - 2 * Z[f] * W[f] * sp.v[k]) * dt;
        sp.x[k] += sp.v[k] * dt;
        hist[f][hi * 3 + k] = sp.x[k];
      }
    }
    hi = (hi + 1) % HN; hn = Math.min(hn + 1, HN);
    for (let f = 0; f < 3; f++) for (let d = 0; d < 4; d++) {
      const back = Math.min(Math.round(LAG_DELAYS[d] / dt), hn - 1);
      const at = ((hi - 1 - back) % HN + HN) % HN;
      for (let k = 0; k < 3; k++) lag[(f * 4 + d) * 3 + k] = hist[f][at * 3 + k];
    }

    // Skin film: a joint that is out of the water is covered by a bright film of water that
    // drains over a few seconds; a joint below the surface is wet again.
    for (let i = 0; i < NJ; i++) {
      const y = P[i * 3 + 1], top = 0.9 * scale * (0.3 + 0.7 * Math.sin(Math.PI * clamp(i / (NJ - 1) * 1.05, 0, 1)));
      if (y + top * 0.55 < 0.05) wet[i] = 1;
      else wet[i] = Math.max(0, wet[i] - dt / 5.5);
    }
  };

  // Position of the blowhole (on the top of the head), for the spout and the surfaced test.
  rig.blowhole = function blowhole(out) {
    const s = 2.4 * scale, f = s / JD, i = Math.min(NJ - 2, Math.floor(f)), a = f - i;
    const top = topAt(2.4 / BODY_LEN) * scale;
    for (let k = 0; k < 3; k++) {
      const p = P[i * 3 + k] * (1 - a) + P[(i + 1) * 3 + k] * a, u = U[i * 3 + k] * (1 - a) + U[(i + 1) * 3 + k] * a;
      out[k] = p + u * top;
    }
    return out;
  };
  // A point at distance s (m) along the spine, interpolated, for injecting disturbances.
  rig.at = function at(s, out) {
    const f = clamp(s / JD, 0, NJ - 1.001), i = Math.floor(f), a = f - i;
    for (let k = 0; k < 3; k++) out[k] = P[i * 3 + k] * (1 - a) + P[(i + 1) * 3 + k] * a;
    return out;
  };
  rig.step(FIXED_STEP, { x: 0, y: -1, z: 0, yaw: Math.PI / 2, pitch: 0, roll: 0 });
  return rig;
}
