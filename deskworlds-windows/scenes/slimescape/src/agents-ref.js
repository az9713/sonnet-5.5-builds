// The Physarum agent rule (after Jones 2010, "Characteristics of pattern formation and evolution in
// approximations of Physarum transport networks"), as plain JavaScript on a tiny grid.
//
// The GPU does exactly this with 65k to 262k agents (see shaders.js, AGENT_FRAG / SPLAT / DIFFUSE_FRAG);
// this module is the readable reference that the tests exercise, and it owns the model constants so the
// two cannot drift apart. No three.js import: this file runs under node.

// The plate is 16:9 and one unit tall. Everything in the scene (agents, slugs, flakes, springtails) lives
// in these plate coordinates: x in [0, WORLD_W), y in [0, 1), y up.
export const WORLD_W = 16 / 9;

// Model constants in plate units (the unit is the plate height; the 1024-wide map is ~576 cells per unit).
export const MODEL = Object.freeze({
  sensorAngle: 0.7,     // rad between the centre sensor and the left/right sensors
  sensorDist: 0.04,     // how far ahead the three sensors look
  turnAngle: 0.9,       // rad turned toward the stronger side per step
  step: 0.0032,         // distance moved per simulation step (1/60 s)
  wobble: 0.16,         // random heading noise per step (rad)
  deposit: 1,           // trail laid per agent per step
  decay: 0.915,         // trail kept per step
  diffuse: 0.6,         // blend toward the 3x3 blur per step
  foodWeight: 150,      // chemoattractant counts this much against trail when sensing
  lightWeight: 220,     // Physarum is photophobic: light counts as strongly negative trail
  lostThreshold: 0.8,   // agents on less trail than this count as lost
  lostMax: 60,         // after this many lost steps an agent is re-seeded on the colony
  foodBoost: 2.5,       // agents on food deposit this much more
  reinforce: 2.5,       // agents on moderate trail deposit more (tube reinforcement): trunks thicken, side branches fade
  reinforceScale: 30,   // trail value at which the reinforcement reaches 1
  reinforceCap: 3,      // and the most it can reach, in those units
});

// Scale the plate-unit constants to a grid of `cellsPerUnit` cells per plate height.
export function scaleModel(model, cellsPerUnit) {
  return { ...model, sensorDist: model.sensorDist * cellsPerUnit, step: model.step * cellsPerUnit };
}

const TAU = Math.PI * 2;

// Starting positions: a few colonies of different sizes, so the plate opens with bare agar around a
// network (the first frame is also warmed up by simulation, see render.js).
export function seedAgents(random, count, worldW = WORLD_W, worldH = 1, out = new Float32Array(count * 4)) {
  const colonies = [
    { x: 0.36, y: 0.52, s: 0.17, w: 0.5 },
    { x: 0.78, y: 0.4, s: 0.15, w: 0.3 },
    { x: 0.58, y: 0.84, s: 0.1, w: 0.12 },
    { x: 0.2, y: 0.17, s: 0.08, w: 0.08 },
  ];
  for (let i = 0; i < count; i++) {
    let r = random(), k = 0;
    while (k < colonies.length - 1 && r > colonies[k].w) { r -= colonies[k].w; k++; }
    const c = colonies[k];
    // Box-Muller from the seeded generator.
    const a = Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * c.s, b = random() * TAU;
    const x = c.x * worldW + a * Math.cos(b) * 1.3, y = c.y * worldH + a * Math.sin(b);
    out[i * 4] = ((x % worldW) + worldW) % worldW;
    out[i * 4 + 1] = ((y % worldH) + worldH) % worldH;
    out[i * 4 + 2] = random() * TAU;
    out[i * 4 + 3] = 0;
  }
  return out;
}

// food field written by flakes: a wide soft Gaussian, a narrow core and a long Lorentzian tail so that even a
// far-off colony can smell it (shaders.js DIFFUSE_FRAG does the same).
export function foodAt(foods, x, y, scale = 1) {
  let f = 0;
  for (const o of foods) {
    const dx = x - o.x, dy = y - o.y, d2 = dx * dx + dy * dy, s = o.radius;
    f += o.amp * (0.35 * Math.exp(-d2 / (2 * s * s)) + 0.4 * Math.exp(-d2 / (2 * (s * 0.3) ** 2)) + 0.25 / (1 + d2 / (0.64 * s * s)));
  }
  return f * scale;
}

// Agents on trail lay more (tube reinforcement), up to a cap, so busy tubes thicken and quiet ones fade.
export function reinforcement(m, trail) {
  return 1 + m.reinforce * Math.min(m.reinforceCap, trail / m.reinforceScale);
}

export function createAgentSim({ width, height, count, random, model = MODEL, cellsPerUnit = height, foods = [], light = null }) {
  const m = scaleModel(model, cellsPerUnit);
  const n = width * height;
  let trail = new Float32Array(n), next = new Float32Array(n);
  const food = new Float32Array(n);
  const agents = new Float32Array(count * 4);   // x, y (cells), heading, lost
  const ww = width / cellsPerUnit, wh = height / cellsPerUnit;
  seedAgents(random, count, ww, wh, agents);
  for (let i = 0; i < count; i++) { agents[i * 4] *= cellsPerUnit; agents[i * 4 + 1] *= cellsPerUnit; }
  let steps = 0;
  const state = { foods, light };
  const wrapX = x => ((x % width) + width) % width, wrapY = y => ((y % height) + height) % height;

  function fillFood() {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      food[y * width + x] = state.foods.length ? foodAt(state.foods, (x + 0.5) / cellsPerUnit, (y + 0.5) / cellsPerUnit) : 0;
    }
  }
  fillFood();

  const sample = (field, x, y) => {
    x = wrapX(x - 0.5); y = wrapY(y - 0.5);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const x1 = (x0 + 1) % width, y1 = (y0 + 1) % height;
    return (field[y0 * width + x0] * (1 - fx) + field[y0 * width + x1] * fx) * (1 - fy)
      + (field[y1 * width + x0] * (1 - fx) + field[y1 * width + x1] * fx) * fy;
  };
  const lightAt = (x, y) => {
    const l = state.light;
    if (!l || !(l.strength > 0)) return 0;
    const dx = x / cellsPerUnit - l.x, dy = y / cellsPerUnit - l.y;
    return l.strength * Math.exp(-(dx * dx + dy * dy) / (l.radius * l.radius));
  };
  const sense = (x, y) => sample(trail, x, y) + m.foodWeight * sample(food, x, y) - m.lightWeight * lightAt(x, y);

  function step() {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      let x = agents[o], y = agents[o + 1], th = agents[o + 2], lost = agents[o + 3];
      const C = sense(x + Math.cos(th) * m.sensorDist, y + Math.sin(th) * m.sensorDist);
      const L = sense(x + Math.cos(th + m.sensorAngle) * m.sensorDist, y + Math.sin(th + m.sensorAngle) * m.sensorDist);
      const R = sense(x + Math.cos(th - m.sensorAngle) * m.sensorDist, y + Math.sin(th - m.sensorAngle) * m.sensorDist);
      if (C > L && C > R) { /* straight on */ }
      else if (C < L && C < R) th += (random() < 0.5 ? -1 : 1) * m.turnAngle;
      else if (L < R) th -= m.turnAngle;
      else if (R < L) th += m.turnAngle;
      th += (random() - 0.5) * m.wobble;
      x = wrapX(x + Math.cos(th) * m.step); y = wrapY(y + Math.sin(th) * m.step);
      const here = sample(trail, x, y), lit = lightAt(x, y);
      if (here > m.lostThreshold || sample(food, x, y) > 0.12) lost = Math.max(lost - 3, 0); else lost += 1;
      lost += lit * 6;
      if (lost > m.lostMax) {
        // Re-seed on a random agent that is itself on the colony and out of the light.
        const j = Math.floor(random() * count) * 4;
        if (agents[j + 3] < m.lostMax * 0.3 && lightAt(agents[j], agents[j + 1]) < 0.1 && sample(food, agents[j], agents[j + 1]) < 0.12) {
          x = wrapX(agents[j] + (random() - 0.5) * 0.02 * cellsPerUnit); y = wrapY(agents[j + 1] + (random() - 0.5) * 0.02 * cellsPerUnit);
          th = random() * TAU; lost = 0;
        }
      }
      agents[o] = x; agents[o + 1] = y; agents[o + 2] = th % TAU; agents[o + 3] = lost;
    }
    // Deposit (bilinear splat), then diffuse and decay into the new map.
    const prev = trail;
    const dep = new Float32Array(n);
    for (let i = 0; i < count; i++) {
      const x = agents[i * 4] - 0.5, y = agents[i * 4 + 1] - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const xa = wrapX(x0), xb = wrapX(x0 + 1), ya = wrapY(y0), yb = wrapY(y0 + 1);
      const d = m.deposit * (1 + m.foodBoost * Math.min(1, sample(food, agents[i * 4], agents[i * 4 + 1]))) * reinforcement(m, sample(prev, agents[i * 4], agents[i * 4 + 1]));
      dep[ya * width + xa] += d * (1 - fx) * (1 - fy); dep[ya * width + xb] += d * fx * (1 - fy);
      dep[yb * width + xa] += d * (1 - fx) * fy; dep[yb * width + xb] += d * fx * fy;
    }
    for (let y = 0; y < height; y++) {
      const ym = wrapY(y - 1) * width, y0 = y * width, yp = wrapY(y + 1) * width;
      for (let x = 0; x < width; x++) {
        const xm = wrapX(x - 1), xp = wrapX(x + 1);
        const blur = (4 * prev[y0 + x] + 2 * (prev[y0 + xm] + prev[y0 + xp] + prev[ym + x] + prev[yp + x])
          + prev[ym + xm] + prev[ym + xp] + prev[yp + xm] + prev[yp + xp]) / 16;
        const lit = lightAt(x + 0.5, y + 0.5);
        next[y0 + x] = (prev[y0 + x] + (blur - prev[y0 + x]) * m.diffuse) * (m.decay - 0.1 * Math.min(1, lit)) + dep[y0 + x];
      }
    }
    trail = next; next = prev;
    steps++;
  }
  return {
    step, agents, get trail() { return trail; }, food, get steps() { return steps; }, width, height, count,
    setFoods(foods) { state.foods = foods; fillFood(); }, setLight(l) { state.light = l; }, sample: (x, y) => sample(trail, x, y),
  };
}
