import assert from 'node:assert/strict';
import { createChain, resetChain, stepChain, kickChain } from '../src/chain.js';
import { ambientFlow } from '../src/flow.js';
import { randomGenerator } from '../../shared/random.js';

const dt = 1 / 60;
const N = 16, REST = 0.2;
const still = (x, y, z, out) => { out[0] = out[1] = out[2] = 0; };
const segs = ch => { const out = []; for (let i = 1; i < ch.n; i++) { const a = (i - 1) * 3, b = i * 3; out.push(Math.hypot(ch.pos[b] - ch.pos[a], ch.pos[b + 1] - ch.pos[a + 1], ch.pos[b + 2] - ch.pos[a + 2])); } return out; };
const allFinite = ch => ch.pos.every(Number.isFinite) && ch.prev.every(Number.isFinite);

// 1. Long violent run: random root motion (sudden impulses, like power strokes) in a moving current. Lengths hold, nothing blows up.
{
  const rng = randomGenerator(5);
  const ch = createChain(N, REST); resetChain(ch, 0, 0, 0, 0, -1, 0);
  const t = [0, 0, 0], root = [0, 0, 0], vel = [0, 0, 0];
  let maxErr = 0, maxDist = 0;
  const water = (x, y, z, out) => { ambientFlow(x, y, z, t[0], out); out[0] *= 4; out[1] *= 4; out[2] *= 4; };
  for (let s = 0; s < 60 * 120; s++) {
    t[0] = s * dt;
    if (s % 90 === 0) { vel[0] = (rng() - 0.5) * 3; vel[1] = rng() * 3; vel[2] = (rng() - 0.5) * 3; }   // an impulse
    for (let k = 0; k < 3; k++) { vel[k] *= Math.exp(-1.5 * dt); root[k] += vel[k] * dt; }
    stepChain(ch, dt, root[0], root[1], root[2], 0, -1, 0, water);
    assert.ok(allFinite(ch), 'finite at step ' + s);
    for (const l of segs(ch)) maxErr = Math.max(maxErr, Math.abs(l - REST) / REST);
    const tip = (N - 1) * 3;
    maxDist = Math.max(maxDist, Math.hypot(ch.pos[tip] - root[0], ch.pos[tip + 1] - root[1], ch.pos[tip + 2] - root[2]));
  }
  assert.ok(maxErr < 0.02, 'segment lengths stay near rest length, worst error ' + maxErr);
  assert.ok(maxDist <= REST * (N - 1) * 1.02, 'tip never farther than the chain is long');
}

// 2. Tips lag the root: after a sudden root impulse the tip moves later and less at first.
{
  const ch = createChain(N, REST); resetChain(ch, 0, 0, 0, 0, -1, 0);
  for (let s = 0; s < 120; s++) stepChain(ch, dt, 0, 0, 0, 0, -1, 0, still);     // settle
  const tipIdx = (N - 1) * 3, midIdx = 8 * 3;
  const tip0 = ch.pos[tipIdx], mid0 = ch.pos[midIdx];
  let rootX = 0, firstMid = -1, firstTip = -1, peakTipVel = 0, peakTipT = 0, peakMidVel = 0, peakMidT = 0;
  // the root accelerates sideways to speed 2 over 0.1 s, then stops
  for (let s = 0; s < 180; s++) {
    const t = s * dt, v = t < 0.1 ? 2 * (t / 0.1) : 0;
    rootX += v * dt;
    const before = [ch.pos[midIdx], ch.pos[tipIdx]];
    stepChain(ch, dt, rootX, 0, 0, 0, -1, 0, still);
    const vm = (ch.pos[midIdx] - before[0]) / dt, vt = (ch.pos[tipIdx] - before[1]) / dt;
    if (firstMid < 0 && Math.abs(ch.pos[midIdx] - mid0) > 0.02) firstMid = t;
    if (firstTip < 0 && Math.abs(ch.pos[tipIdx] - tip0) > 0.02) firstTip = t;
    if (vm > peakMidVel) { peakMidVel = vm; peakMidT = t; }
    if (vt > peakTipVel) { peakTipVel = vt; peakTipT = t; }
    assert.ok(allFinite(ch));
  }
  assert.ok(firstTip > firstMid, 'the tip starts moving after the middle: ' + firstMid + ' < ' + firstTip);
  assert.ok(peakTipT > peakMidT, 'tip velocity peaks later than the middle: ' + peakMidT + ' < ' + peakTipT);
  assert.ok(firstTip > 0.02, 'a visible delay before the tip responds');
}

// 3. The water moves the chain: a steady current deflects it downstream; no current leaves it hanging.
{
  const ch = createChain(N, REST); resetChain(ch, 0, 0, 0, 0, -1, 0);
  const wind = (x, y, z, out) => { out[0] = 0.5; out[1] = 0; out[2] = 0; };
  for (let s = 0; s < 600; s++) stepChain(ch, dt, 0, 0, 0, 0, -1, 0, wind);
  assert.ok(ch.pos[(N - 1) * 3] > 0.3, 'tip is swept downstream');
  const calm = createChain(N, REST); resetChain(calm, 0, 0, 0, 0, -1, 0);
  for (let s = 0; s < 600; s++) stepChain(calm, dt, 0, 0, 0, 0, -1, 0, still);
  assert.ok(Math.abs(calm.pos[(N - 1) * 3]) < 1e-3 && calm.pos[(N - 1) * 3 + 1] < -REST * (N - 1) * 0.98, 'still water: hangs straight');
}

// 4. Determinism and retraction: same inputs, same chain; changing the rest length is absorbed within a few steps.
{
  const run = () => { const ch = createChain(14, 0.1); resetChain(ch, 0, 0, 0, 0, -1, 0); for (let s = 0; s < 300; s++) stepChain(ch, dt, Math.sin(s * 0.05), 0, 0, 0, -1, 0, still); return Array.from(ch.pos); };
  assert.deepEqual(run(), run());
  const ch = createChain(14, 0.2); resetChain(ch, 0, 0, 0, 0, -1, 0);
  ch.rest = 0.05;
  for (let s = 0; s < 4; s++) stepChain(ch, dt, 0, 0, 0, 0, -1, 0, still);
  for (const l of segs(ch)) assert.ok(Math.abs(l - 0.05) < 1e-3);
}
// 5. A kick (power stroke) flicks the free end furthest, then the drag takes the speed away.
{
  const ch = createChain(N, REST); resetChain(ch, 0, 0, 0, 0, -1, 0);
  for (let s = 0; s < 120; s++) stepChain(ch, dt, 0, 0, 0, 0, -1, 0, still);
  const tipY = () => ch.pos[(N - 1) * 3], midY = () => ch.pos[8 * 3];
  const y0 = tipY(), m0 = midY();
  kickChain(ch, dt, 3, 0, 0);
  let tipMax = 0, midMax = 0, tipAt = 0;
  for (let s = 0; s < 120; s++) { stepChain(ch, dt, 0, 0, 0, 0, -1, 0, still); if (tipY() - y0 > tipMax) { tipMax = tipY() - y0; tipAt = s; } midMax = Math.max(midMax, midY() - m0); assert.ok(allFinite(ch)); }
  assert.ok(tipMax > 0.03 && tipMax > midMax, 'the free end is flicked furthest: ' + tipMax + ' vs ' + midMax);
  assert.ok(tipAt > 2, 'and it takes a few frames to get there');
  for (let s = 0; s < 600; s++) stepChain(ch, dt, 0, 0, 0, 0, -1, 0, still);
  assert.ok(Math.abs(tipY() - y0) < 0.05, 'then it settles back');
}
console.log('ok chain');
