// Dictyostelium slugs: translucent pale-gold bodies that crawl across the plate. Each is a chain of
// segments. The head steers (wander noise, phototaxis toward the cursor light, avoidance of the dense
// slime network); every other segment is a spring-damped follower, so the tail visibly lags in a turn,
// and a peristaltic wave swells the width as it travels down the body. Pure CPU, no three.js.
export const SLUG = Object.freeze({
  segments: 10,
  gap: 0.0172,             // rest spacing between segment centres, plate units
  radius: 0.0165,          // body radius at the swollen middle
  speed: 0.045,            // cruising speed, plate units per second
  maxTurn: 1.0,            // rad/s the head can turn
  lightRange: 0.6,         // slugs notice the cursor light within this distance
  lightStop: 0.05,         // and settle this close to it
  look: 0.075,             // avoidance look-ahead distance
  avoid: 0.18,             // density (0..1) that slugs refuse to cross
  trailPoints: 150, trailSpacing: 0.011, trailLife: 34,
  lag: 15, zeta: 0.55,     // follower spring (rad/s) and damping ratio; the tail is a little softer
  stiffness: 0.28,         // how much of the previous segment's direction a follower keeps (bending resistance)
});

const TAU = Math.PI * 2;
const wrapAngle = a => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createSlugs({ random, count = 4, bounds, segments = SLUG.segments }) {
  const slugs = [];
  const placed = [];
  for (let k = 0; k < count; k++) {
    let x = 0, y = 0;
    for (let tries = 0; tries < 30; tries++) {
      x = bounds.minX + random() * (bounds.maxX - bounds.minX);
      y = bounds.minY + random() * (bounds.maxY - bounds.minY);
      if (!placed.some(p => Math.hypot(p.x - x, p.y - y) < 0.3)) break;
    }
    placed.push({ x, y });
    const heading = random() * TAU;
    const s = {
      n: segments, heading, turn: 0, speed: SLUG.speed * (0.8 + random() * 0.4), seed: random() * 100, phase: random() * TAU,
      x: new Float32Array(segments), y: new Float32Array(segments), vx: new Float32Array(segments), vy: new Float32Array(segments),
      r: new Float32Array(segments), wave: new Float32Array(segments), gap: SLUG.gap * (0.9 + random() * 0.2),
      trailX: new Float32Array(SLUG.trailPoints), trailY: new Float32Array(SLUG.trailPoints), trailT: new Float32Array(SLUG.trailPoints),
      stop: SLUG.lightStop * (0.7 + random() * 1.8), trailHead: 0, trailCount: 0, lastTX: x, lastTY: y, moved: 0, near: 0, avoiding: 0,
    };
    for (let i = 0; i < segments; i++) { s.x[i] = x - Math.cos(heading) * s.gap * i; s.y[i] = y - Math.sin(heading) * s.gap * i; }
    slugs.push(s);
  }
  let time = 0;

  const smoothNoise = (t, seed) => 0.62 * Math.sin(t * 0.31 + seed) + 0.38 * Math.sin(t * 0.83 + seed * 2.7) + 0.2 * Math.sin(t * 1.9 + seed * 5.1);

  function stepSlug(s, dt, env) {
    const hx = s.x[0], hy = s.y[0];
    const cx = Math.cos(s.heading), cy = Math.sin(s.heading);
    // 1. Where does it want to go?
    let want = smoothNoise(time, s.seed) * 0.55;          // rad/s of wander
    // Phototaxis: the cursor is a light source, and slugs lean toward it when it is in range.
    s.near = 0;
    let slow = 1;
    const light = env.light;
    if (light && light.presence > 0.02) {
      const dx = light.x - hx, dy = light.y - hy, d = Math.hypot(dx, dy);
      const w = light.presence * smooth(SLUG.lightRange, SLUG.lightRange * 0.3, d);
      if (w > 0) {
        s.near = w;
        want = want * (1 - w) + wrapAngle(Math.atan2(dy, dx) - s.heading) * 2.2 * w;
        if (d < s.stop * 3) slow = smooth(s.stop * 0.6, s.stop * 3, d);
      }
    }
    // Slugs keep out of each other's way: the head veers off any body that is close.
    for (const o of slugs) {
      if (o === s) continue;
      for (let i = 0; i < o.n; i += 2) {
        const dx = hx - o.x[i], dy = hy - o.y[i], d = Math.hypot(dx, dy);
        if (d < 0.09 && d > 1e-6) {
          const w = smooth(0.09, 0.03, d);
          const err = wrapAngle(Math.atan2(dy, dx) - s.heading);
          want += err * 1.8 * w * (Math.abs(err) < 2.4 ? 1 : 0.4);
          slow *= 1 - 0.3 * w;
        }
      }
    }
    // Avoidance: look ahead left, centre and right, and turn toward the emptier side.
    let avoid = 0;
    if (env.field) {
      const la = SLUG.look;
      const fl = env.field(hx + Math.cos(s.heading + 0.75) * la, hy + Math.sin(s.heading + 0.75) * la);
      const fc = env.field(hx + cx * la, hy + cy * la);
      const fr = env.field(hx + Math.cos(s.heading - 0.75) * la, hy + Math.sin(s.heading - 0.75) * la);
      const fh = env.field(hx, hy);
      const over = Math.max(fl, fc, fr, fh);
      if (over > SLUG.avoid * 0.5) {
        const strength = smooth(SLUG.avoid * 0.5, SLUG.avoid * 1.6, over);
        const side = fl === fr ? (s.seed % 2 < 1 ? 1 : -1) : (fl < fr ? 1 : -1);
        avoid = side * 2.4 * (0.4 + 0.6 * smooth(0, SLUG.avoid, fc));
        want = want * (1 - strength * 0.85) + avoid * strength;
        slow *= 1 - 0.5 * strength;
      }
      s.avoiding = avoid;
    }
    // Stay in view: lean toward the middle of the allowed area when near its edge.
    const b = env.bounds;
    if (b) {
      const ex = Math.max(b.minX - hx, 0, hx - b.maxX), ey = Math.max(b.minY - hy, 0, hy - b.maxY);
      const m = 0.07;
      const px = hx < b.minX + m ? (b.minX + m - hx) / m : hx > b.maxX - m ? (hx - (b.maxX - m)) / m : 0;
      const py = hy < b.minY + m ? (b.minY + m - hy) / m : hy > b.maxY - m ? (hy - (b.maxY - m)) / m : 0;
      const e = Math.min(1, Math.max(px, py));
      if (e > 0) {
        const tx = (b.minX + b.maxX) / 2 - hx, ty = (b.minY + b.maxY) / 2 - hy;
        want = want * (1 - e) + wrapAngle(Math.atan2(ty, tx) - s.heading) * 2.4 * e;
      }
      if (ex > 0 || ey > 0) slow *= 0.5;
    }
    // 2. Turn (with inertia, so the body swings round) and advance the head.
    want = Math.max(-SLUG.maxTurn, Math.min(SLUG.maxTurn, want));
    s.turn += (want - s.turn) * Math.min(1, dt * 3.5);
    s.heading = wrapAngle(s.heading + s.turn * dt);
    // Slugs lurch a little: the speed pulses slowly with the body wave.
    const lurch = 0.85 + 0.3 * (0.5 + 0.5 * Math.sin(time * 0.9 + s.phase));
    const v = s.speed * lurch * slow * (1 + 0.6 * s.near);
    s.x[0] += Math.cos(s.heading) * v * dt; s.y[0] += Math.sin(s.heading) * v * dt;
    s.vx[0] = Math.cos(s.heading) * v; s.vy[0] = Math.sin(s.heading) * v;

    // 3. Spring-damped followers.
    for (let i = 1; i < s.n; i++) {
      const w = SLUG.lag * (1 - 0.35 * (i / s.n));
      const gap = s.gap * (1 + 0.1 * Math.sin(TAU * 0.9 * (i / s.n) - time * 2.2 + s.phase));
      let dx = s.x[i] - s.x[i - 1], dy = s.y[i] - s.y[i - 1];
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) { dx = -Math.cos(s.heading); dy = -Math.sin(s.heading); d = 1; }
      let ux = dx / d, uy = dy / d;
      if (i >= 2) {
        // Bending resistance: lean toward the direction of the segment ahead.
        let px = s.x[i - 1] - s.x[i - 2], py = s.y[i - 1] - s.y[i - 2];
        const pd = Math.hypot(px, py) || 1;
        px /= pd; py /= pd;
        ux = ux * (1 - SLUG.stiffness) + px * SLUG.stiffness; uy = uy * (1 - SLUG.stiffness) + py * SLUG.stiffness;
        const un = Math.hypot(ux, uy) || 1; ux /= un; uy /= un;
      }
      const tx = s.x[i - 1] + ux * gap, ty = s.y[i - 1] + uy * gap;
      const c = 2 * SLUG.zeta * w;
      s.vx[i] += (w * w * (tx - s.x[i]) - c * (s.vx[i] - s.vx[i - 1])) * dt;
      s.vy[i] += (w * w * (ty - s.y[i]) - c * (s.vy[i] - s.vy[i - 1])) * dt;
      s.x[i] += s.vx[i] * dt; s.y[i] += s.vy[i] * dt;
      // A hard bound on the spacing, so no input can tear the chain apart or fold it up.
      dx = s.x[i] - s.x[i - 1]; dy = s.y[i] - s.y[i - 1]; d = Math.hypot(dx, dy);
      const lo = s.gap * 0.62, hi = s.gap * 1.38;
      if (d > hi || d < lo) {
        const target = d > hi ? hi : lo, k = d > 1e-6 ? target / d : 0;
        s.x[i] = s.x[i - 1] + (d > 1e-6 ? dx * k : -Math.cos(s.heading) * target);
        s.y[i] = s.y[i - 1] + (d > 1e-6 ? dy * k : -Math.sin(s.heading) * target);
      }
    }
    // 4. Width: a body profile with a peristaltic wave running from head to tail.
    for (let i = 0; i < s.n; i++) {
      const u = i / (s.n - 1);
      const profile = u < 0.5 ? 0.42 + 0.58 * Math.sin(Math.PI * u) : 1 - 0.28 * ((u - 0.5) * 2) ** 2;
      const wave = Math.sin(TAU * (0.95 * u - 0.32 * time) + s.phase);
      s.wave[i] = wave;
      s.r[i] = SLUG.radius * profile * (1 + 0.17 * wave);
    }
    // 5. The slime trail: a point every so often at the tail end.
    const lx = s.x[s.n - 1], ly = s.y[s.n - 1];
    if (Math.hypot(lx - s.lastTX, ly - s.lastTY) >= SLUG.trailSpacing) {
      s.trailX[s.trailHead] = lx; s.trailY[s.trailHead] = ly; s.trailT[s.trailHead] = time;
      s.trailHead = (s.trailHead + 1) % SLUG.trailPoints; s.trailCount = Math.min(SLUG.trailPoints, s.trailCount + 1);
      s.lastTX = lx; s.lastTY = ly;
    }
  }

  return {
    slugs,
    get time() { return time; },
    step(dt, env) {
      time += dt;
      for (const s of slugs) stepSlug(s, dt, env);
    },
    // Rows of the float texture the shader reads: per slug, per segment (x, y, radius, wave).
    pack(out) {
      for (let k = 0; k < slugs.length; k++) {
        const s = slugs[k];
        for (let i = 0; i < s.n; i++) { const o = (k * s.n + i) * 4; out[o] = s.x[i]; out[o + 1] = s.y[i]; out[o + 2] = s.r[i]; out[o + 3] = s.wave[i]; }
      }
    },
    // The slug's trail oldest first, as x, y, fade (1 fresh .. 0 gone). Returns the number of points written.
    trail(s, out, now = time) {
      let n = 0;
      const start = (s.trailHead - s.trailCount + SLUG.trailPoints) % SLUG.trailPoints;
      for (let i = 0; i < s.trailCount; i++) {
        const j = (start + i) % SLUG.trailPoints;
        const age = now - s.trailT[j];
        const fade = 1 - smooth(SLUG.trailLife * 0.25, SLUG.trailLife, age);
        if (fade <= 0.001) continue;
        out[n * 3] = s.trailX[j]; out[n * 3 + 1] = s.trailY[j]; out[n * 3 + 2] = fade; n++;
      }
      return n;
    },
  };
}
