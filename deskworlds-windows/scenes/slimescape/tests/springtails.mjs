import assert from 'node:assert/strict';
import { createSpringtails, SPRING } from '../src/springtails.js';
import { randomGenerator } from '../../shared/random.js';

const DT = 1 / 60;
const bounds = { minX: 0.25, maxX: 1.55, minY: 0.12, maxY: 0.88 };
const inside = s => s.x >= bounds.minX - 1e-6 && s.x <= bounds.maxX + 1e-6 && s.y >= bounds.minY - 1e-6 && s.y <= bounds.maxY + 1e-6;
const makeEnv = (light) => ({ bounds, light });
const trace = (seed, seconds, lightFn) => {
  const st = createSpringtails({ random: randomGenerator(seed), bounds });
  const out = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * DT;
    st.step(DT, makeEnv(lightFn ? lightFn(t, st) : null));
    if (i % 5 === 0) out.push(st.springtails.map(s => [s.x, s.y, s.z, s.state].map(v => Math.round(v * 1e5))));
  }
  return { st, out };
};

// Deterministic per seed.
{
  const a = trace(4, 40), b = trace(4, 40), c = trace(5, 40);
  assert.deepEqual(a.out, b.out);
  assert.notDeepEqual(a.out, c.out);
}

// With nothing around they rest, but still hop now and then; always finite and inside the plate.
{
  const { st } = trace(2, 90);
  let hops = 0;
  for (const s of st.springtails) { hops += s.hops; assert.ok([s.x, s.y, s.z, s.heading, s.stretch, s.pitch].every(Number.isFinite)); assert.ok(inside(s)); assert.ok(s.z >= 0); }
  assert.ok(hops >= 3, `Unprovoked hops happen (${hops})`);
}

// A cursor close by startles one: it crouches, flicks, flies a parabola and lands, further from the light.
{
  const st = createSpringtails({ random: randomGenerator(9), bounds, count: 1 });
  const s = st.springtails[0];
  s.x = 0.9; s.y = 0.5; s.idle = 1e9;
  const light = { x: 0.9 - 0.05, y: 0.5, presence: 1 };
  const start = { x: s.x, y: s.y }, d0 = Math.hypot(s.x - light.x, s.y - light.y);
  let peak = 0, airFrames = 0, sawCrouch = false, sawFlick = false, x0 = 0, landed = false;
  for (let i = 0; i < 120 && !landed; i++) {
    st.step(DT, makeEnv(i < 30 ? light : { ...light, presence: 0 }));
    if (s.state === 1) sawCrouch = true;
    if (s.state === 2) { airFrames++; peak = Math.max(peak, s.z); if (s.flick > 0.5) sawFlick = true; assert.ok(s.z >= 0); }
    if (s.state === 3 && airFrames > 0) landed = true;
  }
  assert.ok(sawCrouch && sawFlick, 'It crouches and flicks its tail');
  assert.ok(landed, 'It lands');
  assert.equal(s.z, 0, 'Landed exactly on the plate');
  assert.ok(peak > SPRING.peak * 0.6 && peak <= SPRING.peak * 1.05, `Apex height is bounded (${peak.toFixed(3)})`);
  const hop = Math.hypot(s.x - start.x, s.y - start.y);
  assert.ok(hop >= SPRING.hopMin * 0.5 && hop <= SPRING.hopMax * 1.01, `Hop length in range (${hop.toFixed(3)})`);
  const d1 = Math.hypot(s.x - light.x, s.y - light.y);
  assert.ok(d1 > d0 + 0.05, `It ends further from the light (${d0.toFixed(2)} -> ${d1.toFixed(2)})`);
  assert.ok(airFrames / 60 >= SPRING.airMin - 0.02 && airFrames / 60 <= SPRING.airMax + 0.03, 'Flight time in range');
  assert.ok(inside(s));
}

// Chased around by a cursor for a long time they stay inside the plate with finite state, and the hop is a parabola.
{
  const { st } = trace(6, 120, (t, st) => { const s = st.springtails[(Math.floor(t / 3)) % st.springtails.length]; return { x: s.x + 0.03 * Math.cos(t), y: s.y + 0.03 * Math.sin(t), presence: 1 }; });
  for (const s of st.springtails) { assert.ok(inside(s)); assert.ok([s.x, s.y, s.z].every(Number.isFinite)); }
  const one = createSpringtails({ random: randomGenerator(1), bounds, count: 1 });
  const s = one.springtails[0]; s.x = 0.9; s.y = 0.5; s.idle = 0;
  const zs = [];
  for (let i = 0; i < 90; i++) { one.step(DT, makeEnv(null)); if (s.state === 2) zs.push(s.z); }
  // second difference of a parabola is constant (-g dt^2)
  const dd = zs.slice(2, -3).map((_, i) => zs[i + 2] - 2 * zs[i + 1] + zs[i]);
  const mean = dd.reduce((a, b) => a + b, 0) / dd.length;
  assert.ok(dd.every(v => Math.abs(v - mean) < Math.abs(mean) * 0.05 + 1e-7), 'The hop is a parabola');
  assert.ok(mean < 0);
}
console.log('ok springtails: rest, crouch, flick, ballistic parabola, land, flee the light, deterministic, bounded');
