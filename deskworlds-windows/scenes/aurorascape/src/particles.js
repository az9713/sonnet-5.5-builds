// Soft particles: the mist of a blow, spray, drips, and the bubbles of the net. Plain typed
// arrays, a fixed capacity, no allocation per step. Kinds:
//   0 mist puff   1 bubble (rising, under the surface)   2 droplet (ballistic)   3 surface foam bubble
export const MIST = 0, BUBBLE = 1, DROP = 2, FOAM = 3;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createParticles({ capacity = 2600, random = Math.random } = {}) {
  const n = capacity;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n);
  const s0 = new Float32Array(n), s1 = new Float32Array(n), age = new Float32Array(n), life = new Float32Array(n);
  const kind = new Uint8Array(n), seed = new Float32Array(n), peak = new Float32Array(n);
  const posSize = new Float32Array(n * 4), params = new Float32Array(n * 4);
  // surface events (a bubble or a drop reaching the water): x, z, strength
  const events = new Float32Array(256 * 3);
  const wind = [0.9, 0, -0.35];
  let count = 0, nextSlot = 0, eventCount = 0, time = 0;
  const emitters = [];   // spouts in progress: { x, y, z, left, power, height }
  const rand = (a, b) => a + random() * (b - a);

  function add(k) {
    // reuse the oldest slot when full (a ring), so a flood never allocates or fails
    let i;
    if (count < n) { i = count++; } else { i = nextSlot; nextSlot = (nextSlot + 1) % n; }
    kind[i] = k; age[i] = 0; seed[i] = random() * 100;
    return i;
  }
  const api = {
    capacity: n, wind, posSize, params, events,
    get count() { return count; },
    get eventCount() { return eventCount; },
    clearEvents() { eventCount = 0; },
    reset() { count = 0; nextSlot = 0; eventCount = 0; },

    // The blow: a spout lasts about half a second. A narrow fast core of mist climbs three to five
    // metres, then billows and wafts away on the wind.
    spout(px, py, pz, power = 1, heightScale = 1) {
      emitters.push({ x: px, y: py, z: pz, left: Math.round(70 + 20 * power), total: Math.round(70 + 20 * power), power, height: heightScale });
      for (let j = 0; j < 14; j++) {   // droplets thrown out of the spout
        const i = add(DROP), a = random() * TAU, sp = rand(0.4, 2.2);
        x[i] = px; y[i] = py + 0.1; z[i] = pz; vx[i] = Math.cos(a) * sp; vz[i] = Math.sin(a) * sp; vy[i] = rand(2.5, 6.5);
        s0[i] = s1[i] = rand(0.05, 0.1); life[i] = 3; peak[i] = 1;
      }
    },
    bubble(px, py, pz, size) {
      const i = add(BUBBLE);
      x[i] = px; y[i] = py; z[i] = pz; vx[i] = rand(-0.1, 0.1); vz[i] = rand(-0.1, 0.1); vy[i] = rand(0.55, 1.1);
      s0[i] = s1[i] = size * rand(0.7, 1.3); life[i] = 30; peak[i] = rand(0.55, 1);
    },
    // A splash: droplets thrown up, a burst of mist, foam on the water.
    splash(px, pz, power = 1, py = 0.2) {
      const drops = Math.round(14 + 40 * power);
      for (let j = 0; j < drops; j++) {
        const i = add(DROP), a = random() * TAU, sp = rand(0.3, 3.0) * (0.5 + power);
        x[i] = px + rand(-0.6, 0.6); y[i] = py; z[i] = pz + rand(-0.6, 0.6);
        vx[i] = Math.cos(a) * sp; vz[i] = Math.sin(a) * sp; vy[i] = rand(1.5, 4 + 6 * power);
        s0[i] = s1[i] = rand(0.05, 0.16); life[i] = 3; peak[i] = 1;
      }
      const puffs = Math.round(5 + 14 * power);
      for (let j = 0; j < puffs; j++) {
        const i = add(MIST), a = random() * TAU, sp = rand(0.2, 1.6) * (0.5 + power);
        x[i] = px + rand(-0.8, 0.8); y[i] = py; z[i] = pz + rand(-0.8, 0.8);
        vx[i] = Math.cos(a) * sp; vz[i] = Math.sin(a) * sp; vy[i] = rand(0.6, 2.6) * (0.5 + power);
        s0[i] = rand(0.5, 1.0); s1[i] = rand(2.0, 4.5) * (0.6 + 0.5 * power); life[i] = rand(1.8, 3.8); peak[i] = rand(0.12, 0.3);
      }
    },
    drip(px, py, pz) {
      const i = add(DROP);
      x[i] = px + rand(-0.1, 0.1); y[i] = py; z[i] = pz + rand(-0.1, 0.1); vx[i] = rand(-0.2, 0.2); vz[i] = rand(-0.2, 0.2); vy[i] = rand(-0.2, 0.4);
      s0[i] = s1[i] = rand(0.04, 0.08); life[i] = 4; peak[i] = 1;
    },

    step(dt) {
      time += dt;
      for (let e = emitters.length - 1; e >= 0; e--) {
        const em = emitters[e];
        const per = em.total / 36;   // spawn over 30 steps
        let n = Math.min(em.left, Math.floor(per) + (random() < per % 1 ? 1 : 0));
        while (n-- > 0) {
          const i = add(MIST), u = 1 - em.left / em.total;
          em.left--;
          x[i] = em.x + rand(-0.1, 0.1); y[i] = em.y + rand(0, 0.2); z[i] = em.z + rand(-0.1, 0.1);
          const up = (7.2 + 3.6 * random()) * em.height * (0.6 + 0.4 * em.power);
          const a = random() * TAU, sp = rand(0.05, 0.9) * (0.4 + 1.2 * u);
          vx[i] = Math.cos(a) * sp; vz[i] = Math.sin(a) * sp; vy[i] = up * (1 - 0.35 * u);
          s0[i] = rand(0.14, 0.3); s1[i] = rand(0.7, 1.7) * (0.8 + 0.4 * em.power); life[i] = rand(2.4, 5.6); peak[i] = rand(0.1, 0.26);
        }
        if (em.left <= 0) emitters.splice(e, 1);
      }
      const dragM = Math.exp(-1.5 * dt);
      for (let i = 0; i < count; i++) {
        age[i] += dt;
        const k = kind[i];
        if (age[i] >= life[i]) { // remove by swapping with the last
          const last = --count;
          if (i !== last) {
            x[i] = x[last]; y[i] = y[last]; z[i] = z[last]; vx[i] = vx[last]; vy[i] = vy[last]; vz[i] = vz[last];
            s0[i] = s0[last]; s1[i] = s1[last]; age[i] = age[last]; life[i] = life[last]; kind[i] = kind[last]; seed[i] = seed[last]; peak[i] = peak[last];
          }
          if (nextSlot >= count) nextSlot = 0;
          i--; continue;
        }
        if (k === MIST) {
          vx[i] = vx[i] * dragM + wind[0] * 0.5 * dt + Math.sin(time * 0.9 + seed[i] * 3) * 0.25 * dt;
          vz[i] = vz[i] * dragM + wind[2] * 0.5 * dt + Math.cos(time * 0.7 + seed[i] * 5) * 0.25 * dt;
          vy[i] = vy[i] * Math.exp(-2.1 * dt) + 0.08 * dt;
        } else if (k === DROP) {
          vy[i] -= 9.8 * dt;
        } else if (k === BUBBLE) {
          vy[i] += (0.9 - vy[i]) * 0.8 * dt;
          vx[i] += Math.sin(time * 2.1 + seed[i] * 7) * 0.5 * dt - vx[i] * 0.6 * dt;
          vz[i] += Math.cos(time * 1.9 + seed[i] * 9) * 0.5 * dt - vz[i] * 0.6 * dt;
        } else {
          vx[i] *= Math.exp(-1.2 * dt); vz[i] *= Math.exp(-1.2 * dt);
        }
        x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
        if (k === DROP && y[i] < 0.02) {   // a drop lands: a tiny ring in the water
          if (eventCount < 256 && random() < 0.35) { events[eventCount * 3] = x[i]; events[eventCount * 3 + 1] = z[i]; events[eventCount * 3 + 2] = 0.25 + s0[i]; eventCount++; }
          life[i] = 0; // removed next step
        } else if (k === BUBBLE && y[i] >= -0.05) {   // a bubble reaches the surface: foam, and a ripple
          if (eventCount < 256) { events[eventCount * 3] = x[i]; events[eventCount * 3 + 1] = z[i]; events[eventCount * 3 + 2] = 1; eventCount++; }
          kind[i] = FOAM; y[i] = 0.04; vy[i] = 0; age[i] = 0; life[i] = rand(1.2, 3.2); s0[i] = s1[i] * 1.1; s1[i] = s0[i] * 1.8; peak[i] = rand(0.6, 1);
        }
      }
    },

    // Writes the instance buffers; returns how many particles to draw.
    fill() {
      for (let i = 0; i < count; i++) {
        const t = life[i] > 0 ? Math.min(age[i] / life[i], 1) : 1, k = kind[i];
        let a;
        if (k === MIST) a = peak[i] * clamp(age[i] / 0.35, 0, 1) * Math.pow(1 - t, 1.6);
        else if (k === BUBBLE) a = peak[i] * clamp(age[i] / 0.4, 0, 1);
        else if (k === FOAM) a = peak[i] * clamp(age[i] / 0.2, 0, 1) * (1 - t * t);
        else a = life[i] > 0 ? 1 - 0.7 * t : 0;
        const size = k === MIST ? s0[i] + (s1[i] - s0[i]) * Math.pow(t, 0.55) : k === FOAM ? s0[i] + (s1[i] - s0[i]) * t : s0[i];
        posSize[i * 4] = x[i]; posSize[i * 4 + 1] = y[i]; posSize[i * 4 + 2] = z[i]; posSize[i * 4 + 3] = size;
        params[i * 4] = a; params[i * 4 + 1] = k; params[i * 4 + 2] = seed[i]; params[i * 4 + 3] = t;
      }
      return count;
    },
    // for tests
    read(i) { return { x: x[i], y: y[i], z: z[i], kind: kind[i], age: age[i], life: life[i] }; },
  };
  return api;
}
