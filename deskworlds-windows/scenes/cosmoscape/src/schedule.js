// The cycle: the cosmic web forms and drifts, flows into a neural network, then a mycelial network, then back to
// the web (its growth factor reset to an early value while the web is invisible, inside the morph). Pure.
export const STRUCTURE = Object.freeze({ web: 0, neural: 1, mycelium: 2 });
export const SEGMENTS = Object.freeze([
  { name: 'web', dur: 80, from: 0, to: 0 },
  { name: 'toNeural', dur: 20, from: 0, to: 1 },
  { name: 'neural', dur: 40, from: 1, to: 1 },
  { name: 'toMycelium', dur: 20, from: 1, to: 2 },
  { name: 'mycelium', dur: 40, from: 2, to: 2 },
  { name: 'toWeb', dur: 20, from: 2, to: 0 },
]);
export const CYCLE = SEGMENTS.reduce((t, s) => t + s.dur, 0);
// Linear growth factor D in units where sigma_delta = 1 at D = 1. Early: the web is already faintly structured;
// late: the first filaments have shell-crossed and sharpened.
export const GROWTH = Object.freeze({ early: 0.55, late: 2.0 });
const easeOut = u => 1 - Math.pow(1 - u, 1.6);

export function growthAt(time) {
  const t = ((time % CYCLE) + CYCLE) % CYCLE;
  if (t < SEGMENTS[0].dur) return GROWTH.early + (GROWTH.late - GROWTH.early) * easeOut(t / SEGMENTS[0].dur);
  // The web is held at its late state while it dissolves; by the time the web is next visible D has been reset.
  if (t < SEGMENTS[0].dur + SEGMENTS[1].dur + SEGMENTS[2].dur * 0.5) return GROWTH.late;
  return GROWTH.early;
}

// State at (cycle) time: segment, progress u within it, the structure pair being blended and the raw blend m
// (0 = from, 1 = to; the shader adds per-particle delays and a smoothstep). weights[i] = share of structure i.
export function stateAt(time) {
  const t = ((time % CYCLE) + CYCLE) % CYCLE;
  let acc = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const s = SEGMENTS[i];
    if (t < acc + s.dur || i === SEGMENTS.length - 1) return describe(i, Math.min(1, (t - acc) / s.dur), t);
    acc += s.dur;
  }
}
function describe(index, u, t) {
  const s = SEGMENTS[index], morphing = s.from !== s.to, m = morphing ? u : 0;
  const weights = [0, 0, 0];
  if (morphing) { weights[s.from] = 1 - m; weights[s.to] = m; } else weights[s.from] = 1;
  return { name: s.name, index, u, from: s.from, to: s.to, m, morphing, weights, growth: growthAt(t), cycleTime: t, morphIndex: morphing ? index : -1 };
}
export const phaseNames = () => SEGMENTS.map(s => s.name);
export function timeForPhase(name, u = 0) {
  let acc = 0;
  for (const s of SEGMENTS) {
    if (s.name === name || s.name.toLowerCase() === String(name).toLowerCase()) return acc + Math.min(1, Math.max(0, u)) * s.dur;
    acc += s.dur;
  }
  return null;
}
// The state for a frozen phase (screenshots): ?phase=web|neural|mycelium|toNeural|toMycelium|toWeb&t=0..1
export function stateForPhase(name, u = 0) {
  const time = timeForPhase(name, u);
  return time === null ? null : stateAt(Math.min(time, CYCLE - 1e-6));
}
