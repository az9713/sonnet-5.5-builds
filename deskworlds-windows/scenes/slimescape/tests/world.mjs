import assert from 'node:assert/strict';
import { createWorld, FIXED_STEP, PROBE } from '../src/world.js';
import { createView } from '../src/view.js';
import { WORLD_W } from '../src/agents-ref.js';
import { randomGenerator } from '../../shared/random.js';

// The camera: cover-fits the 16:9 plate on any display, maps pointer fractions to plate coordinates, and drifts only slowly.
{
  const v = createView();
  for (const aspect of [16 / 9, 21 / 9, 4 / 3, 9 / 16, 1]) {
    v.setAspect(aspect);
    for (let t = 0; t < 600; t += 7.3) {
      v.update(t);
      assert.ok(Math.abs(v.halfW / v.halfH - aspect) < 1e-9, 'The visible rectangle has the display shape');
      assert.ok(v.halfW <= WORLD_W / 2 / 1.03 + 1e-9 && v.halfH <= 0.5 / 1.03 + 1e-9, 'Zoomed in a little, never out past the plate');
    }
  }
  v.setAspect(16 / 9); v.update(0);
  const mid = v.project(0.5, 0.5), tl = v.project(0, 0), br = v.project(1, 1);
  assert.ok(Math.abs(mid.x - v.cx) < 1e-9 && Math.abs(mid.y - v.cy) < 1e-9);
  assert.ok(tl.x < br.x && tl.y > br.y, 'Plate y runs up, screen y runs down');
  const before = { x: v.cx, y: v.cy }; v.update(0.5);
  assert.ok(Math.hypot(v.cx - before.x, v.cy - before.y) < 0.002, 'Drift is slow');
}

const bounds = { minX: 0.3, maxX: 1.5, minY: 0.15, maxY: 0.85 };
const makeWorld = seed => createWorld({ random: randomGenerator(seed), bounds: { ...bounds } });
const snapshot = w => JSON.stringify([w.slugs.slugs.map(s => [...s.x].map(x => Math.round(x * 1e5))), w.springtails.springtails.map(s => [s.x, s.y].map(x => Math.round(x * 1e5))), w.food.flakes.map(f => f.id)]);

// The world is deterministic by seed and stays finite when the pointer, flakes and a probe map are all in play.
{
  const run = seed => {
    const w = makeWorld(seed);
    for (let i = 0; i < PROBE.w * PROBE.h; i++) w.probe.data[i] = (Math.sin(i * 0.37) * 0.5 + 0.5) * 0.3;
    w.probe.valid = true;
    for (let i = 0; i < 60 * 40; i++) {
      if (i === 100) w.food.feedRandom(bounds);
      if (i % 240 === 0) w.point(0.4 + 1.0 * ((i / 240) % 2), 0.5);
      if (i % 240 === 150) w.release();
      w.step(FIXED_STEP);
    }
    return w;
  };
  const a = run(3), b = run(3), c = run(4);
  assert.equal(snapshot(a), snapshot(b)); assert.notEqual(snapshot(a), snapshot(c));
  for (const s of a.slugs.slugs) for (let i = 0; i < s.n; i++) assert.ok(Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]));
  assert.ok(a.cursor.presence >= 0 && a.cursor.presence <= 1, 'Cursor presence is a fraction');
}

// The lamp eases to the pointer, fades in and out, and a sampled density map reads back bilinearly.
{
  const w = makeWorld(1);
  w.point(1.2, 0.3);
  for (let i = 0; i < 90; i++) w.step(FIXED_STEP);
  assert.ok(w.cursor.presence > 0.95 && Math.hypot(w.cursor.x - 1.2, w.cursor.y - 0.3) < 0.01);
  w.release();
  for (let i = 0; i < 60 * 6; i++) w.step(FIXED_STEP);
  assert.ok(w.cursor.presence < 0.02, 'The lamp fades when the pointer leaves');
  assert.equal(w.env.field(0.5, 0.5), 0, 'No probe yet: no avoidance');
  w.probe.data.fill(0.25); w.probe.valid = true;
  assert.ok(Math.abs(w.env.field(1.0, 0.5) - 0.25) < 1e-6 && Math.abs(w.env.field(-0.2, 1.3) - 0.25) < 1e-6, 'The map wraps like the plate');
}
console.log('ok world: camera cover-fit and drift, deterministic world, lamp easing, probe sampling');
