// The scene's stateful part: the clock and the cursor as a point mass. The cursor position is a critically damped
// spring (the lens lags a little behind the hand), and the strengths of its two effects ease in while the cursor is
// on the canvas and ease out when it leaves (the lens fades over about a second, the pull a little longer).
// Pure; stepped at a fixed 1/60 s.
import { stateAt, stateForPhase } from './schedule.js';

export const FIXED_STEP = 1 / 60;
const OMEGA = 9;   // spring rad/s

export function createSim() {
  const s = { time: 0, present: false, tx: 0.5, ty: 0.5, x: 0.5, y: 0.5, vx: 0, vy: 0, lens: 0, pull: 0, forced: null, steps: 0 };
  function step(dt = FIXED_STEP) {
    s.time += dt; s.steps++;
    // Critically damped spring toward the target.
    const ax = OMEGA * OMEGA * (s.tx - s.x) - 2 * OMEGA * s.vx, ay = OMEGA * OMEGA * (s.ty - s.y) - 2 * OMEGA * s.vy;
    s.vx += ax * dt; s.vy += ay * dt; s.x += s.vx * dt; s.y += s.vy * dt;
    const up = s.present ? 1 : 0;
    s.lens += (up - s.lens) * (1 - Math.exp(-dt * (s.present ? 2.6 : 1.9)));
    s.pull += (up - s.pull) * (1 - Math.exp(-dt * (s.present ? 1.6 : 1.1)));
    if (!s.present && s.lens < 1e-4) s.lens = 0;
    if (!s.present && s.pull < 1e-4) s.pull = 0;
  }
  return {
    state: s, step,
    // x, y in 0..1 of the canvas (y down); null lifts the cursor. snap places it with no spring lag.
    cursor(x, y, snap = false) {
      if (x === null || x === undefined) { s.present = false; if (snap) { s.lens = 0; s.pull = 0; } return; }
      if (!s.present && !(s.lens > 0.02)) { s.x = x; s.y = y; s.vx = s.vy = 0; }
      s.present = true; s.tx = x; s.ty = y;
      if (snap) { s.x = x; s.y = y; s.vx = s.vy = 0; s.lens = 1; s.pull = 1; }
    },
    force(name, u = 0) { s.forced = name ? { name, u } : null; },
    cycle() { return s.forced ? (stateForPhase(s.forced.name, s.forced.u) || stateAt(s.time)) : stateAt(s.time); },
  };
}
