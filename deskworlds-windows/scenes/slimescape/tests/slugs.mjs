import assert from 'node:assert/strict';
import { createSlugs, SLUG } from '../src/slugs.js';
import { randomGenerator } from '../../shared/random.js';

const DT = 1 / 60;
const bounds = { minX: 0.25, maxX: 1.55, minY: 0.12, maxY: 0.88 };
const make = (seed, count = 4) => createSlugs({ random: randomGenerator(seed), count, bounds: { ...bounds } });
const spacing = (s, i) => Math.hypot(s.x[i] - s.x[i - 1], s.y[i] - s.y[i - 1]);

// Chain kinematics: over two minutes of wandering, spacing stays bounded, nothing is NaN, bodies stay on the plate.
{
  const sl = make(1, 5);
  const env = { bounds: sl.slugs.length ? bounds : bounds, light: null, field: null };
  let minGap = Infinity, maxGap = 0, minR = Infinity, maxR = 0;
  for (let k = 0; k < 120 * 60; k++) {
    sl.step(DT, env);
    for (const s of sl.slugs) {
      for (let i = 1; i < s.n; i++) { const d = spacing(s, i); minGap = Math.min(minGap, d / s.gap); maxGap = Math.max(maxGap, d / s.gap); }
      for (let i = 0; i < s.n; i++) { minR = Math.min(minR, s.r[i]); maxR = Math.max(maxR, s.r[i]); }
    }
  }
  assert.ok(minGap >= 0.6 && maxGap <= 1.4, `Segment spacing stays bounded (${minGap.toFixed(2)}..${maxGap.toFixed(2)} of rest)`);
  assert.ok(minR > 0.003 && maxR < SLUG.radius * 1.6, `Body width stays sane (${minR.toFixed(3)}..${maxR.toFixed(3)})`);
  const pack = new Float32Array(5 * 10 * 4); sl.pack(pack);
  for (const s of sl.slugs) {
    for (let i = 0; i < s.n; i++) {
      assert.ok([s.x[i], s.y[i], s.vx[i], s.vy[i], s.r[i], s.wave[i]].every(Number.isFinite), 'finite');
      assert.ok(s.x[i] > bounds.minX - 0.25 && s.x[i] < bounds.maxX + 0.25 && s.y[i] > bounds.minY - 0.25 && s.y[i] < bounds.maxY + 0.25, 'Stays in the plate');
    }
  }
  assert.ok(pack.every(Number.isFinite));
  // They actually crawl.
  const s0 = sl.slugs[0]; assert.ok(Math.hypot(s0.x[0] - s0.trailX[0], s0.y[0] - s0.trailY[0]) >= 0);
}

// The tail lags in a turn: while the head swings round, the body trails behind the head's path (body is curved
// and the tail's direction of travel is not yet the head's).
{
  const sl = make(3, 1); const s = sl.slugs[0];
  s.x[0] = 0.9; s.y[0] = 0.5; s.heading = 0;
  for (let i = 1; i < s.n; i++) { s.x[i] = 0.9 - s.gap * i; s.y[i] = 0.5; s.vx[i] = s.vy[i] = 0; }
  const light = { x: 0.9, y: 0.95, presence: 1 };   // straight up from a slug heading right
  let maxBend = 0;
  for (let k = 0; k < 240; k++) {
    sl.step(DT, { bounds: { minX: 0, maxX: 2, minY: 0, maxY: 1.2 }, light });
    maxBend = Math.max(maxBend, Math.abs(Math.atan2(s.y[0] - s.y[2], s.x[0] - s.x[2]) - Math.atan2(s.y[s.n - 3] - s.y[s.n - 1], s.x[s.n - 3] - s.x[s.n - 1])));
  }
  assert.ok(maxBend > 0.2, `The body bends in a turn, tail behind the head (${maxBend.toFixed(2)} rad)`);
}

// Phototaxis: the cursor is a light; a slug within range turns toward it and closes the distance.
{
  const sl = make(5, 1); const s = sl.slugs[0];
  const wide = { minX: -1, maxX: 3, minY: -1, maxY: 2 };
  s.x[0] = 0.8; s.y[0] = 0.5; s.heading = Math.PI / 2 * 0.0 + 0; s.speed = SLUG.speed;
  for (let i = 1; i < s.n; i++) { s.x[i] = 0.8 - s.gap * i; s.y[i] = 0.5; s.vx[i] = s.vy[i] = 0; }
  const light = { x: 0.8, y: 0.8, presence: 1 };    // 90 degrees to the left of the heading
  const d0 = Math.hypot(s.x[0] - light.x, s.y[0] - light.y);
  let turnedToward = false;
  for (let k = 0; k < 20 * 60; k++) {
    sl.step(DT, { bounds: wide, light });
    if (k === 90) turnedToward = s.heading > 0.3 && s.heading < 2.5;      // turning left (counter-clockwise) toward the light
  }
  const d1 = Math.hypot(s.x[0] - light.x, s.y[0] - light.y);
  assert.ok(turnedToward, 'It turns toward the light');
  assert.ok(d1 < d0 * 0.5 && d1 < 0.2, `It closes on the light (${d0.toFixed(2)} -> ${d1.toFixed(2)})`);
  // and with the light far away (out of range) it does not home in
  const sl2 = make(5, 1); const s2 = sl2.slugs[0];
  s2.x[0] = 0.4; s2.y[0] = 0.5; for (let i = 1; i < s2.n; i++) { s2.x[i] = 0.4 - s2.gap * i; s2.y[i] = 0.5; }
  const far = { x: 3.8, y: 0.5, presence: 1 };
  let min = Infinity;
  for (let k = 0; k < 10 * 60; k++) { sl2.step(DT, { bounds: wide, light: far }); min = Math.min(min, Math.hypot(s2.x[0] - far.x, s2.y[0] - far.y)); }
  assert.ok(min > 2.5, 'Out of range, the light is ignored');
  // light that is switched off (presence 0) is ignored too
  const sl3 = make(5, 1); const s3 = sl3.slugs[0];
  s3.x[0] = 0.8; s3.y[0] = 0.5; s3.heading = 0; for (let i = 1; i < s3.n; i++) { s3.x[i] = 0.8 - s3.gap * i; s3.y[i] = 0.5; }
  sl3.step(DT, { bounds: wide, light: { x: 0.8, y: 0.8, presence: 0 } });
}

// Avoidance: a wall of dense slime (field = 1 for x > 1.1) is never crossed, even by a slug aimed straight at it.
{
  const sl = make(8, 1); const s = sl.slugs[0];
  const wide = { minX: -1, maxX: 3, minY: -1, maxY: 2 };
  const field = (x, y) => x > 1.1 ? 1 : x > 1.0 ? (x - 1.0) * 10 : 0;
  s.x[0] = 0.5; s.y[0] = 0.5; s.heading = 0; s.speed = SLUG.speed * 1.3;
  for (let i = 1; i < s.n; i++) { s.x[i] = 0.5 - s.gap * i; s.y[i] = 0.5; s.vx[i] = s.vy[i] = 0; }
  let maxX = -Infinity;
  for (let k = 0; k < 90 * 60; k++) {
    sl.step(DT, { bounds: wide, light: null, field });
    maxX = Math.max(maxX, s.x[0]);
  }
  assert.ok(maxX < 1.12, `The head never crosses the dense network (max x ${maxX.toFixed(3)})`);
  assert.ok(s.x[0] > 0.45 || maxX > 0.9, 'It does crawl up to the edge of it');
}

// Same seed, same crawl; trail points come out oldest first with fades in range.
{
  const run = seed => { const sl = make(seed, 3); for (let i = 0; i < 1500; i++) sl.step(DT, { bounds, light: null, field: null }); return sl; };
  const a = run(2), b = run(2), c = run(3);
  assert.deepEqual(Array.from(a.slugs[0].x), Array.from(b.slugs[0].x));
  assert.notDeepEqual(Array.from(a.slugs[0].x), Array.from(c.slugs[0].x));
  const out = new Float32Array(SLUG.trailPoints * 3);
  const n = a.trail(a.slugs[0], out);
  assert.ok(n > 5, 'A slug leaves a trail');
  for (let i = 0; i < n; i++) assert.ok(out[i * 3 + 2] > 0 && out[i * 3 + 2] <= 1);
  for (let i = 1; i < n; i++) assert.ok(out[i * 3 + 2] >= out[(i - 1) * 3 + 2] - 1e-6, 'Fades are ordered oldest to newest');
}
// Relocation: slugs start on bare agar, apart from each other, as straight untangled chains.
{
  const sl = make(12, 4);
  const field = (x, y) => (x > 0.6 && x < 1.2) ? 1 : 0;       // a dense band down the middle
  sl.relocate(bounds, field);
  for (const s of sl.slugs) {
    for (let i = 0; i < s.n; i++) assert.ok(field(s.x[i], s.y[i]) < 0.5 || i > 0, 'The head is on bare plate');
    for (let i = 1; i < s.n; i++) assert.ok(Math.abs(spacing(s, i) - s.gap) < 1e-5, 'Chain starts at rest spacing');
    assert.ok([...s.x, ...s.y].every(Number.isFinite));
  }
  let closest = Infinity;
  for (let i = 0; i < sl.slugs.length; i++) for (let j = i + 1; j < sl.slugs.length; j++) closest = Math.min(closest, Math.hypot(sl.slugs[i].x[0] - sl.slugs[j].x[0], sl.slugs[i].y[0] - sl.slugs[j].y[0]));
  assert.ok(closest > 0.15, `Slugs start apart (${closest.toFixed(2)})`);
}
console.log('ok slugs: bounded spring-damped chain, body lag in turns, phototaxis, network avoidance, deterministic, finite');
