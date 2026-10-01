import assert from 'node:assert/strict';
import { createFood, FLAKE } from '../src/food.js';
import { randomGenerator } from '../../shared/random.js';

const bounds = { minX: 0.2, maxX: 1.6, minY: 0.12, maxY: 0.88 };
const DT = 1 / 60;

// A feed drops 3-5 flakes inside the bounds, kept apart.
for (let seed = 1; seed <= 20; seed++) {
  const food = createFood(randomGenerator(seed));
  const made = food.feedRandom(bounds);
  assert.ok(made.length >= FLAKE.feedMin && made.length <= FLAKE.feedMax, `3-5 flakes (${made.length})`);
  for (const f of made) assert.ok(f.x >= bounds.minX && f.x <= bounds.maxX && f.y >= bounds.minY && f.y <= bounds.maxY);
  let closest = Infinity;
  for (let i = 0; i < made.length; i++) for (let j = i + 1; j < made.length; j++) closest = Math.min(closest, Math.hypot(made[i].x - made[j].x, made[i].y - made[j].y));
  assert.ok(closest > 0.08, `Flakes do not pile up (${closest.toFixed(3)})`);
}

// Lifecycle: ramps in, dissolves to zero over 40-60 s, is never negative or above one, then is gone.
{
  const food = createFood(randomGenerator(3));
  const flake = food.drop(1, 0.5);
  assert.ok(flake.life >= FLAKE.lifeMin && flake.life <= FLAKE.lifeMax);
  const life = flake.life;
  let t = 0, peak = 0, last = 0, rising = true;
  while (food.flakes.length) {
    const w = food.whole(flake), a = food.attract(flake);
    assert.ok(w >= 0 && w <= 1 && a >= 0 && a <= 1 && Number.isFinite(w), 'whole stays in 0..1');
    peak = Math.max(peak, w);
    if (t > FLAKE.rampIn + 0.1) { assert.ok(w <= last + 1e-9, 'It only dissolves once settled'); rising = false; }
    last = w;
    food.step(DT); t += DT;
    assert.ok(t < life + 1, 'It is removed on time');
  }
  assert.ok(peak > 0.99, 'It starts whole');
  assert.ok(!rising && Math.abs(t - life) < 0.05, `Gone after its life (${t.toFixed(1)} of ${life.toFixed(1)} s)`);
  assert.equal(food.whole(flake), 0, 'Dissolved to zero');
  assert.ok(life >= 40 && life <= 60);
}

// Mid-life it is smaller than at the start, and the attractant fades with it.
{
  const food = createFood(randomGenerator(8));
  const f = food.drop(1, 0.5);
  for (let i = 0; i < 300; i++) food.step(DT);
  const early = food.whole(f);
  for (let i = 0; i < Math.round(f.life * 0.6 * 60); i++) food.step(DT);
  assert.ok(food.whole(f) < early * 0.6, 'Smaller mid-life');
  assert.ok(food.attract(f) < 1);
}

// The plate holds a bounded number; the oldest goes first; packing lists only live flakes.
{
  const food = createFood(randomGenerator(2));
  for (let i = 0; i < 30; i++) food.drop(0.5 + i * 0.03, 0.5);
  assert.equal(food.flakes.length, FLAKE.max);
  assert.ok(food.flakes[0].id > 18, 'Oldest flakes were replaced');
  for (let i = 0; i < 120; i++) food.step(DT);
  const A = new Float32Array(FLAKE.max * 4), B = new Float32Array(FLAKE.max * 4);
  const n = food.pack(A, B);
  assert.equal(n, FLAKE.max);
  for (let i = 0; i < n * 4; i++) assert.ok(Number.isFinite(A[i]) && Number.isFinite(B[i]));
}

// Same seed, same flakes.
{
  const a = createFood(randomGenerator(5)), b = createFood(randomGenerator(5));
  a.feedRandom(bounds); b.feedRandom(bounds);
  assert.deepEqual(a.flakes, b.flakes);
}
console.log('ok food: 3-5 flakes per feed, ramp in, dissolve to exactly zero in 40-60 s, never negative, capped, deterministic');
