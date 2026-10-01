import assert from 'node:assert/strict';
import { createWorld, FIXED_STEP, BOUNDS, TRANSITIONS, MODES, CURSOR, fjordCenter, fjordHalfWidth, SHORE_MARGIN, NET } from '../src/behaviour.js';
import { NJ } from '../src/rig.js';
import { randomGenerator } from '../../shared/random.js';

const make = (seed, opts = {}) => createWorld({ random: randomGenerator(seed), visualRandom: randomGenerator(seed + 99), ...opts });
const run = (world, seconds, each = () => {}) => { for (let i = 0; i < Math.round(seconds / FIXED_STEP); i++) { world.step(FIXED_STEP); each(world, i); } };

// Determinism: the same seed gives the same whales; a different seed does not.
{
  const a = make(5), b = make(5), c = make(6);
  run(a, 40); run(b, 40); run(c, 40);
  assert.deepEqual(a.summary(), b.summary());
  assert.notDeepEqual(a.summary(), c.summary());
}

// A long run: everything finite, inside the box and the fjord, valid transitions only, no collisions.
for (const seed of [1, 2, 3]) {
  const world = make(seed);
  let minSep = 1e9, blows = 0, maxTail = -1e9, dives = 0;
  const seen = new Set();
  run(world, 420, (w, i) => {
    for (const q of w.whales) {
      assert.ok([q.x, q.y, q.z, q.yaw, q.pitch, q.roll, q.speed, q.arch, q.gape].every(Number.isFinite), 'finite pose');
      assert.ok(q.x >= BOUNDS.minX - 1 && q.x <= BOUNDS.maxX + 1, `x ${q.x} within the box`);
      if (!['spiral', 'netBelow', 'lunge'].includes(q.mode)) assert.ok(q.z >= BOUNDS.minZ - 0.01 && q.z <= BOUNDS.maxZ + 0.01, `z ${q.z} within the box`);
      assert.ok(q.y >= -12.01 && q.y <= 3.21, `depth ${q.y}`);
      assert.ok(Math.abs(q.x - fjordCenter(q.z)) < fjordHalfWidth(q.z) - SHORE_MARGIN + 12, 'off the shore');
      assert.ok(q.z <= BOUNDS.maxZ + 0.01, 'clear of the camera');
      maxTail = Math.max(maxTail, q.rig.P[(NJ - 1) * 3 + 1]);
      for (const v of q.rig.P) assert.ok(Number.isFinite(v));
      seen.add(q.mode);
    }
    if (i % 10 === 0) for (let a = 0; a < w.whales.length; a++) for (let b = a + 1; b < w.whales.length; b++) {
      const A = w.whales[a], B = w.whales[b];
      if (Math.abs(A.y - B.y) < 5) minSep = Math.min(minSep, Math.hypot(A.x - B.x, A.z - B.z));
    }
    const d = w.disturbances;
    assert.ok(d.count <= 48);
    for (let k = 0; k < d.count; k++) assert.ok([d.data[k * 4], d.data[k * 4 + 1], d.data[k * 4 + 2], d.data[k * 4 + 3], d.foam[k]].every(Number.isFinite));
  });
  assert.equal(world.stats.invalid, 0, 'only valid mode transitions');
  for (const e of world.log) if (e.type === 'mode') assert.ok(TRANSITIONS[e.from].includes(e.to), `${e.from} -> ${e.to}`);
  assert.ok(minSep > 7, `whales keep apart (min ${minSep.toFixed(1)} m)`);
  assert.ok(world.stats.blows >= 6, `${world.stats.blows} blows`);
  for (const m of ['travel', 'breath', 'dive', 'submerged', 'ascend']) assert.ok(seen.has(m), `visited ${m}`);
  assert.ok(maxTail > 0.5, `a terminal dive lifts the flukes clear (${maxTail.toFixed(2)} m)`);
  // a blow only happens when the blowhole is out of the water, and only in a breath
  for (const e of world.log) if (e.type === 'blow') {
    assert.ok(e.y > 0.04, `blow with the blowhole at ${e.y}`);
    const mode = [...world.log].reverse().find((m) => m.type === 'mode' && m.i === e.i && m.t <= e.t);
    assert.equal(mode.to, 'breath', 'blows happen in the breath mode');
  }
  assert.ok(world.particles.count > 0 || world.stats.blows > 0);
}

// Shore and neighbours: a whale headed straight for the bank turns away; two on a collision course part.
{
  const world = make(11, { whales: 2 });
  const [a, b] = world.whales;
  const c = fjordCenter(-100), hw = fjordHalfWidth(-100);
  a.x = c + hw - SHORE_MARGIN - 28; a.z = -100; a.yaw = 0; a.mode = 'travel'; a.goalX = c + hw + 100; a.goalZ = -100; a.travelFor = 999;
  b.x = -100; b.z = -60; b.mode = 'submerged'; b.y = -8; b.submergedFor = 999;
  let maxX = -1e9;
  run(world, 60, (w) => { maxX = Math.max(maxX, a.x); });
  assert.ok(maxX < c + hw - SHORE_MARGIN + 14, `stops short of the shore (${maxX.toFixed(1)} vs ${(c + hw - SHORE_MARGIN).toFixed(1)})`);
  // collision course
  const w2 = make(12, { whales: 2 });
  const [p, q] = w2.whales;
  p.x = -30; p.z = -90; p.yaw = 0; p.mode = 'travel'; p.travelFor = 999; p.goalX = 40; p.goalZ = -90; p.y = -1.1;
  q.x = 30; q.z = -90; q.yaw = Math.PI; q.mode = 'travel'; q.travelFor = 999; q.goalX = -40; q.goalZ = -90; q.y = -1.1;
  let min = 1e9;
  run(w2, 40, () => { min = Math.min(min, Math.hypot(p.x - q.x, p.z - q.z)); });
  assert.ok(min > 8, `head-on whales slip past each other (${min.toFixed(1)} m)`);
}

// Curiosity: a slow cursor draws the nearest whale to a standoff; a fast one sends it diving away.
{
  const world = make(21, { whales: 1, netAt: 1e9 });
  const w = world.whales[0];
  w.x = -40; w.z = -110; w.yaw = Math.PI / 2; w.mode = 'travel'; w.travelFor = 999; w.goalX = -40; w.goalZ = -130; w.y = -1.1;
  const cx = 20, cz = -80;
  const d0 = Math.hypot(w.x - cx, w.z - cz);
  let curious = false, best = 1e9;
  for (let i = 0; i < 60 * 70; i++) {
    world.setCursor(cx + 0.4 * Math.sin(i * 0.01), cz, 0.08);
    world.step(FIXED_STEP);
    if (w.mode === 'curious') curious = true;
    best = Math.min(best, Math.hypot(w.x - cx, w.z - cz));
  }
  assert.ok(curious, 'the whale becomes curious');
  assert.ok(best < d0 * 0.45 && best < CURSOR.standoff + 12, `approached from ${d0.toFixed(0)} m to ${best.toFixed(1)} m`);
  assert.ok(best > 5, `keeps a standoff (${best.toFixed(1)} m)`);
  // now a swat: fast motion close by
  const d1 = Math.hypot(w.x - cx, w.z - cz);
  let fled = false, deepest = 0;
  for (let i = 0; i < 60 * 10; i++) {
    const wiggle = i < 60 * 2 ? Math.sin(i * 0.5) * 12 : 0;
    world.setCursor(cx + wiggle, cz, i < 60 * 2 ? 3.0 : 0.05);
    world.step(FIXED_STEP);
    if (w.mode === 'flee') fled = true;
    deepest = Math.min(deepest, w.y);
  }
  assert.ok(fled, 'a fast cursor startles the whale');
  assert.ok(deepest < -4, `it dives (${deepest.toFixed(1)} m)`);
  const d2 = Math.hypot(w.x - cx, w.z - cz);
  assert.ok(d2 > d1 + 4, `and swims away (${d1.toFixed(0)} -> ${d2.toFixed(0)} m)`);
  assert.ok(!world.cursor.active || world.stats.flees >= 1);
}

// The cursor stirs the water by itself: a wake while moving, a drip ring while resting.
{
  const world = make(31, { whales: 1, netAt: 1e9 });
  world.whales[0].x = 100; world.whales[0].z = -140;
  const near = (x, z) => { const d = world.disturbances; let n = 0; for (let k = 0; k < d.count; k++) if (Math.hypot(d.data[k * 4] - x, d.data[k * 4 + 1] - z) < 0.01 && d.data[k * 4 + 2] > 1.4) n++; return n; };
  let wake = 0, amp = 0;
  for (let i = 0; i < 120; i++) { const x = -10 + i * 0.2; world.setCursor(x, -60, 0.3); world.step(FIXED_STEP); wake += near(x, -60); }
  assert.ok(wake >= 100, `a moving cursor leaves a wake (${wake} of 120 steps)`);
  let drips = 0;
  for (let i = 0; i < 300; i++) { world.setCursor(14, -60, 0); world.step(FIXED_STEP); const d = world.disturbances; for (let k = 0; k < d.count; k++) if (Math.hypot(d.data[k * 4] - 14, d.data[k * 4 + 1] + 60) < 0.01) { drips++; amp = Math.max(amp, d.data[k * 4 + 3]); } }
  assert.ok(drips >= 6 && drips <= 12, `a resting cursor taps out ring trains (${drips} pulses in 5 s)`);
  assert.ok(amp > 0.02 && amp < 0.08, 'rings are gentle');
  world.setCursor(null);
  let after = 0; for (let i = 0; i < 120; i++) { world.step(FIXED_STEP); after += near(14, -60); }
  assert.equal(after, 0, 'lifting the cursor stops the ripples');
}

// The bubble net: approach deep, spiral up releasing bubbles, swing below the ring, lunge through it with the mouth open.
{
  const world = make(41, { netAt: 4 });
  const order = [];
  let maxBubbles = 0, apex = -99, gape = 0, foamSurface = 0, surfaceBubbles = 0, spiralDepth = [99, -99];
  const netWhale = () => world.whales.find((q) => ['netApproach', 'spiral', 'netBelow', 'lunge'].includes(q.mode));
  run(world, 110, (w) => {
    const q = netWhale();
    if (q) {
      if (order[order.length - 1] !== q.mode) order.push(q.mode);
      if (q.mode === 'spiral') { spiralDepth = [Math.min(spiralDepth[0], q.y), Math.max(spiralDepth[1], q.y)]; }
      if (q.mode === 'lunge') { apex = Math.max(apex, q.rig.P[0 * 3 + 1]); gape = Math.max(gape, q.gape); }
      let b = 0; const P = w.particles; for (let i = 0; i < P.count; i++) if (P.read(i).kind === 1) b++;
      maxBubbles = Math.max(maxBubbles, b);
    }
    const P = w.particles; let s = 0; for (let i = 0; i < P.count; i++) if (P.read(i).kind === 3) s++;
    surfaceBubbles = Math.max(surfaceBubbles, s);
    const d = w.disturbances; for (let k = 0; k < d.count; k++) if (d.foam[k] >= 0.25) foamSurface++;
  });
  assert.deepEqual(order, ['netApproach', 'spiral', 'netBelow', 'lunge'], `net stages ${order}`);
  assert.equal(world.stats.nets, 1);
  assert.ok(maxBubbles > 150, `bubbles released (${maxBubbles})`);
  assert.ok(surfaceBubbles > 20, `the ring boils at the surface (${surfaceBubbles} foam bubbles)`);
  assert.ok(foamSurface > 20, 'bubbles agitate the water');
  assert.ok(spiralDepth[1] - spiralDepth[0] > 3, `the spiral rises (${spiralDepth.map((v) => v.toFixed(1))})`);
  assert.ok(apex > 1.2, `the lunge breaks the surface with the head (${apex.toFixed(1)} m)`);
  assert.ok(gape > 0.8, `mouth open (${gape.toFixed(2)})`);
  assert.ok(world.log.some((e) => e.type === 'exit') && world.log.some((e) => e.type === 'splashdown'), 'splash on the way out and back');
  assert.ok(NET.radius > 3);
}
console.log('ok behaviour');
