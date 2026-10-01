// The camera path in box units: a slow travelling-through drift, a gentle orbit around the line of travel, slowly
// swaying yaw, pitch and roll, and a focus distance that racks in and out. Sums of sines at incommensurate periods,
// so smooth everywhere and never repeating exactly. Pure; seed-dependent phases (a visit starts somewhere new).
import { randomGenerator } from '../../shared/random.js';

const TAU = Math.PI * 2;
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const SPEED = 0.0031;   // box units per second along the line of travel

export function cameraParams(seed = 1) {
  const r = randomGenerator((seed ^ 0xa5a5a5) >>> 0);
  const dir = norm([r() - 0.5, (r() - 0.5) * 0.4, r() - 0.5]);
  const e1 = norm(cross(dir, [0, 1, 0])), e2 = cross(dir, e1);
  const phases = Array.from({ length: 16 }, () => r() * TAU);
  return { origin: [r(), r(), r()], dir, e1, e2, phases };
}

// Writes { pos[3], fwd[3], up[3], right[3], focus } into out.
export function cameraPose(time, params, out = { pos: [0, 0, 0], fwd: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0], focus: 0 }) {
  const { origin, dir, e1, e2, phases: ph } = params, t = time;
  const orbitAngle = TAU * t / 131 + ph[0], R = 0.05 + 0.012 * Math.sin(TAU * t / 89 + ph[1]);
  const c = Math.cos(orbitAngle) * R, s = Math.sin(orbitAngle) * R;
  const wander = [0.011 * Math.sin(TAU * t / 47 + ph[2]), 0.011 * Math.sin(TAU * t / 61 + ph[3]), 0.011 * Math.sin(TAU * t / 53 + ph[4])];
  for (let i = 0; i < 3; i++) out.pos[i] = origin[i] + dir[i] * SPEED * t + e1[i] * c + e2[i] * s + wander[i];
  const yaw = 0.5 * Math.sin(TAU * t / 173 + ph[5]) + 0.22 * Math.sin(TAU * t / 67 + ph[6]) + 0.08 * Math.sin(TAU * t / 29 + ph[7]);
  const pitch = 0.17 * Math.sin(TAU * t / 121 + ph[8]) + 0.06 * Math.sin(TAU * t / 41 + ph[9]);
  const roll = 0.05 * Math.sin(TAU * t / 89 + ph[10]) + 0.02 * Math.sin(TAU * t / 37 + ph[11]);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const fwd = norm([0, 1, 2].map(i => dir[i] * cy * cp + e1[i] * sy * cp + e2[i] * sp));
  let right = norm(cross(fwd, [0, 1, 0]));
  let up = cross(right, fwd);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const r2 = [0, 1, 2].map(i => right[i] * cr + up[i] * sr), u2 = [0, 1, 2].map(i => up[i] * cr - right[i] * sr);
  for (let i = 0; i < 3; i++) { out.fwd[i] = fwd[i]; out.right[i] = r2[i]; out.up[i] = u2[i]; }
  out.focus = 0.2 + 0.07 * Math.sin(TAU * t / 53 + ph[12]) + 0.03 * Math.sin(TAU * t / 19 + ph[13]);
  return out;
}
