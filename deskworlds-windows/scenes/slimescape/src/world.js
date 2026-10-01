// The CPU side of the plate: the cursor light, oat flakes, slugs and springtails, stepped at a fixed
// 1/60 s, plus the coarse map of slime density the GPU hands back so slugs can steer around the network.
// Pure JavaScript; main.js drives it and render.js draws it.
import { WORLD_W } from './agents-ref.js';
import { createFood } from './food.js';
import { createSlugs } from './slugs.js';
import { createSpringtails } from './springtails.js';

export const FIXED_STEP = 1 / 60;
export const PROBE = Object.freeze({ w: 64, h: 36 });

export function createWorld({ random, bounds, slugCount = 4, springtailCount = 7 }) {
  const food = createFood(random);
  const slugs = createSlugs({ random, count: slugCount, bounds });
  const springtails = createSpringtails({ random, count: springtailCount, bounds });
  // Density (0..1) of slime over the whole plate, filled from the GPU every half second or so.
  const probe = { data: new Float32Array(PROBE.w * PROBE.h), valid: false };
  // The cursor is a lamp: it eases toward the pointer, and its presence fades in and out.
  const cursor = { x: WORLD_W / 2, y: 0.5, tx: WORLD_W / 2, ty: 0.5, presence: 0, target: 0, held: false };
  const env = { bounds, light: cursor, field: null };
  env.field = (x, y) => {
    if (!probe.valid) return 0;
    const u = (x / WORLD_W) * PROBE.w - 0.5, v = y * PROBE.h - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const at = (i, j) => probe.data[(((j % PROBE.h) + PROBE.h) % PROBE.h) * PROBE.w + (((i % PROBE.w) + PROBE.w) % PROBE.w)];
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  let time = 0;
  const world = {
    food, slugs, springtails, probe, cursor, env,
    get time() { return time; },
    setBounds(b) { Object.assign(bounds, b); },
    point(x, y) { cursor.tx = x; cursor.ty = y; cursor.target = 1; if (cursor.presence < 0.02) { cursor.x = x; cursor.y = y; } },
    release() { cursor.target = 0; },
    step(dt) {
      time += dt;
      // Ease the lamp toward the pointer (frame-rate independent) and fade it in and out.
      const k = 1 - Math.exp(-dt * 9);
      cursor.x += (cursor.tx - cursor.x) * k; cursor.y += (cursor.ty - cursor.y) * k;
      cursor.presence += (cursor.target - cursor.presence) * (1 - Math.exp(-dt * (cursor.target > cursor.presence ? 5 : 1.6)));
      food.step(dt);
      slugs.step(dt, env);
      springtails.step(dt, env);
    },
  };
  return world;
}
