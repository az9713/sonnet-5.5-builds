import assert from 'node:assert/strict';
import { createAgentSim, MODEL, seedAgents, foodAt, WORLD_W } from '../src/agents-ref.js';
import { randomGenerator } from '../../shared/random.js';

const W = 96, H = 54, CPU = H;   // 54 cells per plate unit
// The tiny grid is coarse (54 cells per unit), so sensing and stepping are scaled up to stay a few cells.
const TINY = { ...MODEL, sensorDist: 0.09, step: 0.03, lostThreshold: 0.2 };
const make = (seed, extra = {}) => createAgentSim({ width: W, height: H, count: 1400, random: randomGenerator(seed), cellsPerUnit: CPU, model: TINY, ...extra });
const run = (sim, n) => { for (let i = 0; i < n; i++) sim.step(); return sim; };
const hash = sim => { let h = 0; for (const v of sim.agents) h = (Math.imul(h, 31) + Math.round(v * 1000)) | 0; for (let i = 0; i < sim.trail.length; i += 7) h = (Math.imul(h, 31) + Math.round(sim.trail[i] * 100)) | 0; return h; };

// Seeding is deterministic, finite, and inside the plate.
{
  const a = seedAgents(randomGenerator(5), 500), b = seedAgents(randomGenerator(5), 500), c = seedAgents(randomGenerator(6), 500);
  assert.deepEqual([...a], [...b]); assert.notDeepEqual([...a], [...c]);
  for (let i = 0; i < 500; i++) { assert.ok(a[i * 4] >= 0 && a[i * 4] < WORLD_W && a[i * 4 + 1] >= 0 && a[i * 4 + 1] < 1); assert.ok(Number.isFinite(a[i * 4 + 2])); }
}

// Same seed, same history: the model has no hidden state besides the generator.
{
  const a = run(make(3), 60), b = run(make(3), 60), c = run(make(4), 60);
  assert.equal(hash(a), hash(b), 'Same seed, same result');
  assert.notEqual(hash(a), hash(c), 'A different seed gives a different history');
}

// Stability: nothing becomes NaN, agents stay on the plate, the trail stays bounded and non-negative.
{
  const sim = run(make(7), 200);
  for (const v of sim.agents) assert.ok(Number.isFinite(v));
  for (let i = 0; i < sim.count; i++) { assert.ok(sim.agents[i * 4] >= 0 && sim.agents[i * 4] < W && sim.agents[i * 4 + 1] >= 0 && sim.agents[i * 4 + 1] < H); }
  let min = Infinity, max = -Infinity, total = 0;
  for (const v of sim.trail) { assert.ok(Number.isFinite(v)); min = Math.min(min, v); max = Math.max(max, v); total += v; }
  assert.ok(min >= 0, 'Trail is never negative');
  // Deposit per agent per step is at most deposit * (1 + food boost) * (1 + 3 * reinforce); with decay d the standing total stays below that / (1 - d)
  const cap = sim.count * MODEL.deposit * (1 + MODEL.foodBoost) * (1 + 3 * MODEL.reinforce) / (1 - MODEL.decay);
  assert.ok(total < cap, `Trail mass is bounded by deposit / (1 - decay) (${total.toFixed(0)} < ${cap.toFixed(0)})`);
  assert.ok(total > sim.count * 2, 'Agents do leave a trail');
}

// Agents follow a ridge of trail: start with a bright horizontal ridge and uniformly scattered agents; they
// gather on it (the sensors climb the gradient), far more than chance.
{
  const sim = make(11);
  const rand = randomGenerator(99);
  for (let i = 0; i < sim.count; i++) { sim.agents[i * 4] = rand() * W; sim.agents[i * 4 + 1] = rand() * H; sim.agents[i * 4 + 2] = rand() * 6.28; sim.agents[i * 4 + 3] = 0; }
  const ridgeY = 27;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sim.trail[y * W + x] = 12 * Math.exp(-((y - ridgeY) ** 2) / (2 * 1.5 ** 2));
  const frac = () => { let n = 0; for (let i = 0; i < sim.count; i++) if (Math.abs(sim.agents[i * 4 + 1] - (ridgeY + 0.5)) < 3.5) n++; return n / sim.count; };
  const before = frac();
  run(sim, 120);
  const after = frac();
  assert.ok(before < 0.2, `Agents start scattered (${before.toFixed(2)})`);
  assert.ok(after > 0.45, `Agents gather on the ridge: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
}

// Chemoattractant: agents drift toward food, so the network grows toward it. The control is the same colony,
// same seed, without the flake.
{
  const food = [{ x: 1.15, y: 0.5, amp: 1, radius: 0.16 }];
  const colony = foods => {
    const sim = make(21, { foods });
    const rand = randomGenerator(8);
    for (let i = 0; i < sim.count; i++) { sim.agents[i * 4] = (0.55 + rand() * 0.5) * CPU; sim.agents[i * 4 + 1] = rand() * H; sim.agents[i * 4 + 3] = 0; }
    return sim;
  };
  const meanDist = sim => { let t = 0; for (let i = 0; i < sim.count; i++) t += Math.hypot(sim.agents[i * 4] / CPU - food[0].x, sim.agents[i * 4 + 1] / CPU - food[0].y); return t / sim.count; };
  const fed = colony(food), control = colony([]);
  const start = meanDist(fed);
  run(fed, 60); run(control, 60);
  const a = meanDist(fed), c = meanDist(control);
  assert.ok(a < start * 0.85 && a < c * 0.88, `Agents move toward food: ${start.toFixed(2)} -> ${a.toFixed(2)} (without food ${c.toFixed(2)})`);
  assert.ok(foodAt(food, 1.15, 0.5) > foodAt(food, 0.3, 0.5), 'The attractant is strongest at the flake');
}

// Photophobia: a light on the colony pushes agents out of it.
{
  const light = { x: WORLD_W * 0.5, y: 0.5, radius: 0.18, strength: 1 };
  const sim = make(31, { light });
  const rand = randomGenerator(2);
  for (let i = 0; i < sim.count; i++) { sim.agents[i * 4] = (0.5 + (rand() - 0.5) * 0.4) * W; sim.agents[i * 4 + 1] = (0.5 + (rand() - 0.5) * 0.7) * H; }
  const inside = () => { let n = 0; for (let i = 0; i < sim.count; i++) if (Math.hypot(sim.agents[i * 4] / CPU - light.x, sim.agents[i * 4 + 1] / CPU - light.y) < light.radius) n++; return n; };
  const dark = make(31);
  dark.agents.set(sim.agents);
  const a = inside(); run(sim, 150); run(dark, 150);
  let darkInside = 0; for (let i = 0; i < dark.count; i++) if (Math.hypot(dark.agents[i * 4] / CPU - light.x, dark.agents[i * 4 + 1] / CPU - light.y) < light.radius) darkInside++;
  assert.ok(inside() < darkInside * 0.7, `Light empties its pool: ${inside()} lit vs ${darkInside} dark (started ${a})`);
}
// Tube reinforcement: with it, strong trails get relatively stronger (trunks), without it they do not.
{
  const spread = model => {
    const sim = createAgentSim({ width: W, height: H, count: 1400, random: randomGenerator(41), cellsPerUnit: CPU, model: { ...TINY, ...model } });
    for (let i = 0; i < 300; i++) sim.step();
    const v = Array.from(sim.trail).filter(x => x > 0.5).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.97)] / v[Math.floor(v.length * 0.5)];
  };
  const plain = spread({ reinforce: 0 }), reinforced = spread({ reinforce: 2.5, reinforceScale: 8 });
  assert.ok(reinforced > plain * 1.25, `Reinforcement thickens trunks relative to branches (${plain.toFixed(1)} -> ${reinforced.toFixed(1)})`);
}
console.log('ok agents: sense/turn/move/deposit rule is deterministic, bounded, ridge-following, food-seeking and photophobic');
