// Springtails (Collembola): tiny dark specks that rest, then flick their spring-tail and hop away
// ballistically when the cursor's light or shadow gets close. Pure CPU, no three.js.
export const SPRING = Object.freeze({
  count: 7,
  trigger: 0.125,            // cursor distance that startles one
  hopMin: 0.1, hopMax: 0.2,  // hop length, plate units
  airMin: 0.28, airMax: 0.4, // flight time, seconds
  peak: 0.03,                // apex height above the plate, plate units
  crouch: 0.09,              // the pause while the tail is cocked
  settle: 0.35,              // after landing, before it may hop again
  idleMin: 7, idleMax: 24,   // an unprovoked hop every so often
});

const TAU = Math.PI * 2;
const REST = 0, CROUCH = 1, AIR = 2, SETTLE = 3;

export function createSpringtails({ random, count = SPRING.count, bounds }) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({
      x: bounds.minX + random() * (bounds.maxX - bounds.minX), y: bounds.minY + random() * (bounds.maxY - bounds.minY), z: 0,
      heading: random() * TAU, state: REST, t: 0, x0: 0, y0: 0, dx: 0, dy: 0, vz: 0, g: 0, T: 0,
      idle: SPRING.idleMin + random() * (SPRING.idleMax - SPRING.idleMin), flick: 0, stretch: 1, pitch: 0, twitch: random() * TAU,
      pendingDir: 0, pendingLen: 0, hops: 0,
    });
  }
  const clampDir = (s, dir, len, b) => {
    // Rotate the hop toward the middle of the allowed area until it lands inside.
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const toMid = Math.atan2(cy - s.y, cx - s.x);
    for (let k = 0; k < 8; k++) {
      const x = s.x + Math.cos(dir) * len, y = s.y + Math.sin(dir) * len;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return dir;
      let d = Math.atan2(Math.sin(toMid - dir), Math.cos(toMid - dir));
      dir += d * 0.5;
    }
    return toMid;
  };
  function begin(s, dir, len, b) {
    s.pendingDir = clampDir(s, dir, len, b); s.pendingLen = len;
    s.state = CROUCH; s.t = 0;
  }
  function launch(s) {
    s.T = SPRING.airMin + random() * (SPRING.airMax - SPRING.airMin);
    s.x0 = s.x; s.y0 = s.y; s.dx = Math.cos(s.pendingDir) * s.pendingLen; s.dy = Math.sin(s.pendingDir) * s.pendingLen;
    s.vz = 4 * SPRING.peak / s.T; s.g = 2 * s.vz / s.T;
    s.state = AIR; s.t = 0; s.flick = 1; s.hops++;
  }
  return {
    springtails: list,
    step(dt, env) {
      const b = env.bounds, light = env.light;
      for (const s of list) {
        s.t += dt;
        s.flick = Math.max(0, s.flick - dt / 0.14);
        s.twitch += dt * (2 + (s.hops % 3));
        if (s.state === REST || s.state === SETTLE) {
          s.stretch += (1 - s.stretch) * Math.min(1, dt * 14); s.pitch += (0 - s.pitch) * Math.min(1, dt * 10);
          if (s.state === SETTLE && s.t >= SPRING.settle) { s.state = REST; s.t = 0; }
          if (s.state === REST) {
            s.idle -= dt;
            if (light && light.presence > 0.3) {
              const dx = s.x - light.x, dy = s.y - light.y, d = Math.hypot(dx, dy);
              if (d < SPRING.trigger) {
                const away = Math.atan2(dy, dx) + (random() - 0.5) * 0.9;
                begin(s, away, SPRING.hopMin + random() * (SPRING.hopMax - SPRING.hopMin), b);
                continue;
              }
            }
            if (s.idle <= 0) {
              begin(s, random() * TAU, SPRING.hopMin * 0.6 + random() * SPRING.hopMin, b);
              s.idle = SPRING.idleMin + random() * (SPRING.idleMax - SPRING.idleMin);
            }
          }
        } else if (s.state === CROUCH) {
          // The body squashes and turns to face away while the tail is cocked.
          s.heading += Math.atan2(Math.sin(s.pendingDir - s.heading), Math.cos(s.pendingDir - s.heading)) * Math.min(1, dt * 25);
          s.stretch += (0.82 - s.stretch) * Math.min(1, dt * 20);
          if (s.t >= SPRING.crouch) launch(s);
        } else if (s.state === AIR) {
          const u = Math.min(s.t, s.T), k = u / s.T;
          s.x = s.x0 + s.dx * k; s.y = s.y0 + s.dy * k; s.z = Math.max(0, s.vz * u - 0.5 * s.g * u * u);
          s.heading = s.pendingDir + 0.9 * s.flick * Math.sin(s.t * 40) * 0.3;
          s.stretch = 1 + 0.45 * Math.max(s.flick, 0.35) * Math.sin(Math.PI * k);
          s.pitch = (s.vz - s.g * u) / (Math.hypot(s.dx, s.dy) / s.T + 1e-6) * 0.5;
          if (s.t >= s.T) {
            s.x = s.x0 + s.dx; s.y = s.y0 + s.dy; s.z = 0; s.state = SETTLE; s.t = 0; s.pitch = 0; s.stretch = 0.9;
          }
        }
      }
    },
    // x, y, height, heading | stretch, pitch, flick, twitch; returns count.
    pack(A, B) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        A[i * 4] = s.x; A[i * 4 + 1] = s.y; A[i * 4 + 2] = s.z; A[i * 4 + 3] = s.heading;
        B[i * 4] = s.stretch; B[i * 4 + 1] = s.pitch; B[i * 4 + 2] = s.flick; B[i * 4 + 3] = s.twitch;
      }
      return list.length;
    },
  };
}
