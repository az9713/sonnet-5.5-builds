// Oat flakes. A flake lands, soaks, and is slowly consumed over 40-60 s. While it lasts it is a source of
// chemoattractant (render.js writes it into the trail map as a wide soft Gaussian).
export const FLAKE = Object.freeze({
  max: 12, feedMin: 3, feedMax: 5, lifeMin: 40, lifeMax: 60,
  rampIn: 1.4,                 // seconds for the flake to settle and start to leak attractant
  radiusMin: 0.03, radiusMax: 0.05,
  attractRadius: 0.16,         // sigma of the wide Gaussian, plate units
  separation: 0.2,
});

// Scent: faint unseen sources of chemoattractant that come and go, so a plasmodium that is never fed still
// forages: it keeps sending fronts toward wherever the plate happens to smell good, and re-routes afterwards.
export const SCENT = Object.freeze({ max: 2, everyMin: 12, everyMax: 26, lifeMin: 22, lifeMax: 34, peak: 0.5, ramp: 4, fade: 7, sigma: 0.14, margin: 0.12 });

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createFood(random, arena = { w: 16 / 9, h: 1 }) {
  const flakes = [], scents = [];
  let nextId = 1, scentTimer = 3 + random() * 6;
  const api = {
    flakes, scents,
    // Drop one flake; the oldest goes when the plate is full.
    drop(x, y, options = {}) {
      if (flakes.length >= FLAKE.max) flakes.shift();
      const flake = {
        id: nextId++, x, y, age: options.delay ? -options.delay : 0,
        life: FLAKE.lifeMin + random() * (FLAKE.lifeMax - FLAKE.lifeMin),
        radius: FLAKE.radiusMin + random() * (FLAKE.radiusMax - FLAKE.radiusMin),
        angle: random() * Math.PI * 2, aspect: 1.15 + random() * 0.5, seed: random(),
      };
      flakes.push(flake);
      return flake;
    },
    // 3-5 flakes at random places inside bounds {minX,maxX,minY,maxY}, kept apart from each other.
    feedRandom(bounds, count = FLAKE.feedMin + Math.floor(random() * (FLAKE.feedMax - FLAKE.feedMin + 1))) {
      const made = [];
      for (let k = 0; k < count; k++) {
        let x = 0, y = 0;
        for (let tries = 0; tries < 24; tries++) {
          x = bounds.minX + random() * (bounds.maxX - bounds.minX);
          y = bounds.minY + random() * (bounds.maxY - bounds.minY);
          if (![...flakes, ...made].some(f => Math.hypot(f.x - x, f.y - y) < FLAKE.separation)) break;
        }
        made.push(api.drop(x, y, { delay: k * 0.35 }));
      }
      return made;
    },
    step(dt) {
      for (const f of flakes) f.age += dt;
      for (let i = flakes.length - 1; i >= 0; i--) if (flakes[i].age >= flakes[i].life) flakes.splice(i, 1);
      for (const c of scents) c.age += dt;
      for (let i = scents.length - 1; i >= 0; i--) if (scents[i].age >= scents[i].life) scents.splice(i, 1);
      scentTimer -= dt;
      if (scentTimer <= 0) {
        scentTimer = SCENT.everyMin + random() * (SCENT.everyMax - SCENT.everyMin);
        if (scents.length < SCENT.max) {
          scents.push({
            x: SCENT.margin + random() * (arena.w - 2 * SCENT.margin), y: SCENT.margin + random() * (arena.h - 2 * SCENT.margin), age: 0,
            life: SCENT.lifeMin + random() * (SCENT.lifeMax - SCENT.lifeMin),
          });
        }
      }
    },
    scentAmount(c) { return SCENT.peak * smooth(0, SCENT.ramp, c.age) * (1 - smooth(c.life - SCENT.fade, c.life, c.age)); },
    // The attractant sources as the simulation sees them: x, y, amplitude, sigma (flakes first, then scents).
    packSources(out) {
      let n = 0;
      for (const f of flakes) {
        const a = api.attract(f);
        if (a <= 0) continue;
        out[n * 4] = f.x; out[n * 4 + 1] = f.y; out[n * 4 + 2] = a; out[n * 4 + 3] = FLAKE.attractRadius * (0.8 + 0.5 * f.seed); n++;
      }
      for (const c of scents) {
        const a = api.scentAmount(c);
        if (a <= 0) continue;
        out[n * 4] = c.x; out[n * 4 + 1] = c.y; out[n * 4 + 2] = a; out[n * 4 + 3] = SCENT.sigma; n++;
      }
      return n;
    },
    // 0..1: how much of the flake is left (also how big it draws).
    whole(f) {
      if (f.age < 0) return 0;
      return Math.max(0, Math.min(1, smooth(0, FLAKE.rampIn, f.age) * (1 - smooth(f.life * 0.12, f.life, f.age))));
    },
    // The attractant leaks while the flake is intact and dries as it is eaten.
    attract(f) { return Math.sqrt(api.whole(f)); },
    // Packs flakes for the shaders: A = x, y, radius, whole; B = angle, aspect, seed, attract. Returns the count.
    pack(A, B) {
      let n = 0;
      for (const f of flakes) {
        const w = api.whole(f);
        if (w <= 0) continue;
        A[n * 4] = f.x; A[n * 4 + 1] = f.y; A[n * 4 + 2] = f.radius; A[n * 4 + 3] = w;
        B[n * 4] = f.angle; B[n * 4 + 1] = f.aspect; B[n * 4 + 2] = f.seed; B[n * 4 + 3] = Math.sqrt(w);
        n++;
      }
      return n;
    },
    clear() { flakes.length = 0; scents.length = 0; },
  };
  return api;
}
