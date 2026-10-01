import { createRig, NJ, IP, FIXED_STEP } from './rig.js';
import { BODY_LEN } from './whale-shape.js';
import { createParticles } from './particles.js';
import { SIM } from './wave-sim.js';

// The world of the fjord: what the whales want (a small state machine each), how their bodies
// answer (kinematic dynamics feeding the rig), what they stir up in the water, and the cursor
// that draws or frightens them. Nothing here draws; it produces the uniforms and the lists of
// disturbances the renderer and the wave simulation consume.
export { FIXED_STEP };

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (x, target, rate, dt) => x + (target - x) * (1 - Math.exp(-rate * dt));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const CAMERA = { x: 0, y: 3.2, z: 0 };
// The fjord, in metres, shared with the land and water shaders (keep in step with
// FJORD_GLSL in shaders.js): centre line and half width of the water.
export const fjordCenter = (z) => 26 * Math.sin(z * 0.0016 + 0.4) - 6 + 520 * sstep(400, 5200, -z) ** 1.2;
export const fjordHalfWidth = (z) => (240 + 30 * Math.sin(z * 0.0049 + 1.1)) * (1 + 0.9 * sstep(900, 3200, -z));
export const BOUNDS = { minX: -128, maxX: 128, minZ: -150, maxZ: -38, shoreMargin: 42 };
export const SHORE_MARGIN = BOUNDS.shoreMargin;
const VIEW = 0.62;      // whales keep to the wedge the camera sees: |x| < VIEW * distance
export const inFjord = (x, z, margin = 0) => Math.abs(x - fjordCenter(z)) < fjordHalfWidth(z) - margin;

// Cursor speed is in screen widths per second: below SLOW it is a patient hand, above FAST a swat.
export const CURSOR = { slow: 0.4, fast: 1.5, curiousRange: 150, fleeRange: 80, standoff: 12 };

export const MODES = ['travel', 'breath', 'dive', 'submerged', 'ascend', 'curious', 'flee', 'netApproach', 'spiral', 'netBelow', 'lunge'];
export const TRANSITIONS = {
  travel: ['breath', 'curious', 'flee', 'netApproach'],
  breath: ['travel', 'dive', 'curious', 'flee'],
  dive: ['submerged', 'flee'],
  submerged: ['ascend', 'curious', 'flee', 'netApproach'],
  ascend: ['travel', 'curious', 'flee', 'netApproach'],
  curious: ['travel', 'flee'],
  flee: ['submerged'],
  netApproach: ['spiral'],
  spiral: ['netBelow'],
  netBelow: ['lunge'],
  lunge: ['ascend'],
};
const SURFACE_MODES = new Set(['travel', 'breath', 'curious', 'ascend']);
const NET_MODES = new Set(['netApproach', 'spiral', 'netBelow', 'lunge']);
export const NET = { radius: 6.8, spiralTime: 13, belowTime: 3.6, lungeTime: 5.6, speed: 3.3 };
const MAXD = SIM.maxDisturbances;
const SAMPLE_JOINTS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 23];

export function createWorld({ random = Math.random, visualRandom = random, whales = 3, particleCapacity = 2600, netAt = null } = {}) {
  const rand = (a, b) => a + random() * (b - a);
  const particles = createParticles({ capacity: particleCapacity, random: visualRandom });
  // Disturbances for the wave simulation, refilled every step: x, z, radius, amount | foam
  const dist = new Float32Array(MAXD * 4), distFoam = new Float32Array(MAXD);
  let distCount = 0;
  const log = [];
  const stats = { blows: 0, dives: 0, lunges: 0, nets: 0, invalid: 0, flees: 0, curious: 0 };
  const cursor = { active: false, x: 0, z: 0, speed: 0, movedAt: -1e9, fast: 0, drip: 0, travel: 0, havePrev: false };
  const net = { state: 'idle', nextAt: netAt ?? rand(18, 28), who: -1, cx: 0, cz: 0, theta0: 0, dir: 1, ringAge: 0, last: -1e9 };
  let time = 0;

  const emit = (type, i, extra = {}) => { if (log.length < 8192) log.push({ t: time, type, i, ...extra }); };

  function makeWhale(i, spec) {
    const scale = spec.scale ?? 1;
    const w = {
      id: i, scale, rig: createRig({ scale, phase: rand(0, TAU) }),
      x: spec.x, y: spec.y, z: spec.z, yaw: spec.yaw ?? Math.PI / 2, pitch: 0, roll: 0,
      speed: spec.speed ?? 1.6, yawRate: 0, pitchRate: 0, vy: 0,
      mode: spec.mode ?? 'travel', modeT: 0, breathsLeft: spec.breaths ?? 3, travelFor: spec.travelFor ?? rand(2, 6),
      goalX: 0, goalZ: 0, goalYaw: spec.yaw ?? Math.PI / 2, depth: -1.15, arch: 0, beat: 0.3, gape: 0, rollGoal: 0,
      blown: false, blowAt: 0, lastBlow: -99, lastSlap: -99, fleeUntil: 0, cooldownCurious: 0, hasNet: false,
      holeY: -1, dripT: 0, ascendX: 0, ascendZ: 0, submergedFor: 0,
      lungeYaw: 0, spiralTau: 0, spiralFrom: [0, 0, 0], lungeFrom: [0, 0, 0], lastSplashIn: -99,
      _hole: [0, 0, 0], _pt: [0, 0, 0], _prevJointY: new Float32Array(NJ),
    };
    pickWaypoint(w);
    return w;
  }

  const ws = [];
  const specs = [
    { x: -30, y: -1.15, z: -78, yaw: Math.PI / 2 + 0.25, scale: 1.12, mode: 'travel', travelFor: 1.5, breaths: 3 },
    { x: 32, y: -6.5, z: -104, yaw: Math.PI / 2 - 0.3, scale: 1.02, mode: 'submerged', breaths: 4 },
    { x: 50, y: -1.15, z: -58, yaw: Math.PI / 2 + 0.7, scale: 1.2, mode: 'travel', travelFor: 9, breaths: 2 },
  ];
  for (let i = 0; i < whales; i++) {
    const s = specs[i % specs.length];
    ws.push(makeWhale(i, { ...s, x: s.x + rand(-6, 6), z: s.z + rand(-8, 8), yaw: s.yaw + rand(-0.2, 0.2) }));
  }
  if (ws[1]) ws[1].submergedFor = rand(5, 9);
  // settle each rig into its starting pose so the first steps carry no jump
  for (const w of ws) for (let k = 0; k < 4; k++) w.rig.step(FIXED_STEP, { x: w.x, y: w.y, z: w.z, yaw: w.yaw, pitch: 0, roll: 0, speed: w.speed, beat: 0.3 });

  function pickWaypoint(w) {
    let best = null, bestScore = -1e9;
    for (let k = 0; k < 10; k++) {
      const gz = BOUNDS.maxZ - 14 - (BOUNDS.maxZ - BOUNDS.minZ - 40) * Math.pow(random(), 1.35), reach = Math.min(BOUNDS.maxX - 20, VIEW * -gz);
      const gx = rand(-reach, reach);
      if (!inFjord(gx, gz, SHORE_MARGIN + 10)) continue;
      let score = Math.min(60, Math.hypot(gx - w.x, gz - w.z)) * 0.25 + rand(0, 8);
      // not straight across the bow of another whale, and not right on top of one
      for (const o of ws) if (o !== w) score += Math.min(Math.hypot(gx - o.x, gz - o.z), 45) * 0.35;
      const dyaw = Math.abs(wrapPi(Math.atan2(-(gz - w.z), gx - w.x) - w.yaw));
      score -= dyaw * 5;
      // a recently frightened whale picks somewhere well away from the cursor
      if (cursor.active && time - cursor.fast < 40) score += Math.min(Math.hypot(gx - cursor.x, gz - cursor.z), 90) * 0.6;
      if (score > bestScore) { bestScore = score; best = [gx, gz]; }
    }
    if (!best) best = [fjordCenter(-110), -110];
    w.goalX = best[0]; w.goalZ = best[1];
  }

  function setMode(w, mode) {
    if (!TRANSITIONS[w.mode].includes(mode)) { stats.invalid++; emit('invalid', w.id, { from: w.mode, to: mode }); return false; }
    const from = w.mode;
    w.mode = mode; w.modeT = 0; w.blown = false;
    emit('mode', w.id, { from, to: mode });
    switch (mode) {
      case 'travel': pickWaypoint(w); w.travelFor = from === 'ascend' ? rand(1.5, 3.5) : rand(5, 10); if (from === 'ascend') w.breathsLeft = 3 + Math.floor(random() * 3); break;
      case 'breath': w.blowAt = rand(1.1, 1.7); break;
      case 'dive': stats.dives++; break;
      case 'submerged': w.fromFlee = from === 'flee'; w.submergedFor = from === 'flee' ? rand(9, 14) : rand(11, 22); w.depth = -rand(6, 9.5); pickWaypoint(w); break;
      case 'ascend': {
        // surface somewhere ahead, inside the frame
        for (let k = 0; k < 12; k++) {
          const ax = w.x + Math.cos(w.yaw) * rand(10, 40) + rand(-20, 20), az = w.z - Math.sin(w.yaw) * rand(10, 40) + rand(-10, 10);
          w.ascendZ = clamp(az, BOUNDS.minZ + 26, BOUNDS.maxZ - 14);
          w.ascendX = clamp(ax, Math.max(BOUNDS.minX + 20, VIEW * w.ascendZ), Math.min(BOUNDS.maxX - 20, -VIEW * w.ascendZ));
          if (inFjord(w.ascendX, w.ascendZ, SHORE_MARGIN + 8)) break;
        }
        break;
      }
      case 'curious': stats.curious++; w.cooldownCurious = time + 40; break;
      case 'flee': stats.flees++; w.fleeUntil = time + 3; break;
      case 'spiral': w.spiralTau = 0; w.spiralFrom = [w.x, w.y, w.z]; break;
      case 'netBelow': w.lungeFrom = [w.x, w.y, w.z]; break;
      case 'lunge': stats.lunges++; break;
      default:
    }
    return true;
  }

  // --- the cursor ---------------------------------------------------------------------------
  function setCursor(x, z, speed = 0) {
    if (x === null) { cursor.active = false; cursor.havePrev = false; return; }
    cursor.active = true;
    const moved = cursor.havePrev ? Math.hypot(x - cursor.x, z - cursor.z) : 0;
    cursor.havePrev = true; cursor.travel += moved;
    cursor.x = x; cursor.z = z;
    cursor.speed = speed;
    if (moved > 0.05 || speed > 0.02) cursor.movedAt = time;
    if (speed > CURSOR.fast) cursor.fast = time;
  }

  // --- steering ----------------------------------------------------------------------------
  const avoid = [0, 0];
  function avoidance(w) {
    avoid[0] = 0; avoid[1] = 0;
    const c = fjordCenter(w.z), hw = fjordHalfWidth(w.z);
    const edgeL = (w.x - (c - hw)) - SHORE_MARGIN, edgeR = ((c + hw) - w.x) - SHORE_MARGIN;
    if (edgeL < 30) avoid[0] += clamp((30 - edgeL) / 30, 0, 1.5);
    if (edgeR < 30) avoid[0] -= clamp((30 - edgeR) / 30, 0, 1.5);
    if (w.x < BOUNDS.minX + 18) avoid[0] += (BOUNDS.minX + 18 - w.x) / 18;
    if (w.x > BOUNDS.maxX - 18) avoid[0] -= (w.x - (BOUNDS.maxX - 18)) / 18;
    const wedge = VIEW * -w.z + 6;   // too far to the side: swim back into view
    if (Math.abs(w.x) > wedge) avoid[0] -= Math.sign(w.x) * clamp((Math.abs(w.x) - wedge) / 24, 0, 1.2);
    if (w.z > BOUNDS.maxZ - 26) avoid[1] -= clamp((w.z - (BOUNDS.maxZ - 26)) / 26, 0, 1.5);   // keep clear of the camera
    if (w.z < BOUNDS.minZ + 16) avoid[1] += clamp((BOUNDS.minZ + 16 - w.z) / 16, 0, 1.5);
    for (const o of ws) {
      if (o === w) continue;
      const dx = w.x - o.x, dz = w.z - o.z, d = Math.hypot(dx, dz) + 1e-6;
      const dy = Math.abs(w.y - o.y);
      const range = dy > 6 ? 12 : 30;
      if (d < range) { const k = (range - d) / range; avoid[0] += dx / d * k * 1.6; avoid[1] += dz / d * k * 1.6; }
    }
    return avoid;
  }
  function headToward(w, tx, tz, weight = 2.2) {
    let dx = tx - w.x, dz = tz - w.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const a = avoidance(w);
    dx += a[0] * weight; dz += a[1] * weight;
    w.goalYaw = Math.atan2(-dz, dx);
    return d;
  }

  // --- the brain: one mode per whale -----------------------------------------------------------
  const tmp = [0, 0, 0];
  function think(w, dt) {
    w.modeT += dt;
    let speedT = 1.7, depthT = -1.15, beat = 0.35, archT = 0, rollT = 0, gapeT = 0, turn = 0.14;
    const nz = Math.sin(time * 0.17 + w.id * 2.3) * 0.5 + Math.sin(time * 0.071 + w.id) * 0.5;
    switch (w.mode) {
      case 'travel': {
        const d = headToward(w, w.goalX, w.goalZ);
        speedT = 1.5 + 0.5 * nz; depthT = -1.2 + 0.2 * nz; beat = 0.3 + 0.1 * nz;
        if (d < 14) pickWaypoint(w);
        if (w.modeT > w.travelFor) setMode(w, 'breath');
        break;
      }
      case 'breath': {
        const t = w.modeT;
        // the head comes up and the whale blows; the back arches and rolls; then it settles
        speedT = 1.2; beat = 0.2;
        const lift = sstep(0.0, 1.0, t) * (1 - sstep(2.4, 3.4, t));
        depthT = -1.2 + 0.7 * lift + 0.15 * sstep(2.6, 4.2, t) * (1 - sstep(5.0, 6.5, t));
        archT = 0.65 * sstep(1.8, 3.6, t) * (1 - sstep(5.6, 7.4, t));
        rollT = 0.55 * Math.sin(clamp((t - 1.6) / 5.6, 0, 1) * Math.PI) * (w.id % 2 ? -1 : 1);
        headToward(w, w.goalX, w.goalZ);
        w.pitchBias = 0.14 * lift;
        if (!w.blown && t > w.blowAt) {
          w.rig.blowhole(w._hole);
          w.holeY = w._hole[1];
          if (w.holeY > 0.04) { blow(w); w.blown = true; } else if (t > w.blowAt + 1.4) w.blown = true;   // the head never broke the surface: no blow
        }
        if (t > 8.2) {
          w.breathsLeft--;
          setMode(w, w.breathsLeft > 0 ? 'travel' : 'dive');
        }
        break;
      }
      case 'dive': {
        // the terminal dive: a deep arch, the nose pitched steeply down, the flukes lifted clear
        const t = w.modeT;
        speedT = 2.2; beat = 0.55; archT = 0.95 * sstep(0, 1.8, t);
        depthT = -9;
        w.pitchBias = -0.5 * sstep(0.3, 2.4, t);
        if (w.y < -5.2 || t > 14) setMode(w, 'submerged');
        break;
      }
      case 'submerged': {
        const d = headToward(w, w.goalX, w.goalZ, 1.6);
        speedT = 2.4; beat = 0.5; depthT = w.depth + 1.2 * nz;
        if (w.fromFlee && w.modeT < 8) turn = 0.5; else w.fromFlee = false;
        if (d < 12) pickWaypoint(w);
        if (w.modeT > w.submergedFor) setMode(w, 'ascend');
        break;
      }
      case 'ascend': {
        headToward(w, w.ascendX, w.ascendZ, 1.4);
        speedT = 2.0; beat = 0.5; depthT = -1.1; w.pitchBias = 0.0;
        if (w.y > -1.7) setMode(w, 'travel');
        break;
      }
      case 'curious': {
        const gone = !cursor.active || cursor.speed > CURSOR.fast;
        // stand off a few body lengths from the ripples, on the side it came from
        let dx = w.x - cursor.x, dz = w.z - cursor.z, d = Math.hypot(dx, dz) || 1;
        const tx = cursor.x + dx / d * CURSOR.standoff, tz = cursor.z + dz / d * CURSOR.standoff;
        const gap = Math.hypot(tx - w.x, tz - w.z);
        if (d > CURSOR.standoff + 3) headToward(w, tx, tz, 1.2);
        else { w.goalYaw = Math.atan2(-(cursor.z - w.z), cursor.x - w.x); }
        speedT = clamp(gap * 0.16, 0.0, 2.0); depthT = -1.25; beat = 0.18 + 0.1 * nz; turn = 0.16;
        if (gone || w.modeT > 60 || time - cursor.movedAt > 30 || d > 190) setMode(w, 'travel');
        break;
      }
      case 'flee': {
        const dx = w.x - cursor.x, dz = w.z - cursor.z;
        w.goalYaw = Math.atan2(-dz, dx);
        const a = avoidance(w);
        if (Math.abs(a[0]) + Math.abs(a[1]) > 0.2) { let ux = dx, uz = dz; const l = Math.hypot(ux, uz) || 1; ux = ux / l + a[0] * 1.5; uz = uz / l + a[1] * 1.5; w.goalYaw = Math.atan2(-uz, ux); }
        speedT = 3.4; beat = 0.9; depthT = -9; turn = 0.8; archT = 0.7 * sstep(0, 1, w.modeT);
        w.pitchBias = -0.35;
        if (w.modeT > 2.6 || w.y < -4.5) setMode(w, 'submerged');
        break;
      }
      case 'netApproach': {
        // swim to the start of the spiral, deep
        const sx = net.cx + Math.cos(net.theta0) * NET.radius, sz = net.cz + Math.sin(net.theta0) * NET.radius;
        const d = headToward(w, sx, sz, 0.8);
        speedT = 3.0; beat = 0.6; depthT = -8.6; turn = 0.2;
        if (d < 5 && Math.abs(w.y + 8.6) < 1.8 && w.modeT > 1) setMode(w, 'spiral');
        if (w.modeT > 50) { endNet(); setMode(w, 'spiral'); }
        break;
      }
      case 'spiral': case 'netBelow': case 'lunge':
        netScript(w, dt);
        return;
      default:
    }
    // --- common dynamics ---
    const bias = w.pitchBias || 0;
    let pitchT = clamp((depthT - w.y) * 0.24, -0.55, 0.55);
    if (bias) pitchT = w.mode === 'dive' || w.mode === 'flee' ? bias : clamp(pitchT + bias, -0.9, 0.9);
    // limit turning to what a long body can do, less when slow
    const tr = turn * clamp(0.4 + w.speed / 1.6, 0.35, 1.4);
    const yawErr = wrapPi(w.goalYaw - w.yaw);
    const yawRateT = clamp(yawErr * 0.9, -tr, tr);
    w.yawRate = approach(w.yawRate, yawRateT, 1.6, dt);
    w.yaw = wrapPi(w.yaw + w.yawRate * dt);
    const pitchRateT = clamp((pitchT - w.pitch) * 0.9, -0.5, 0.5);
    w.pitchRate = approach(w.pitchRate, pitchRateT, 2.2, dt);
    w.pitch = clamp(w.pitch + w.pitchRate * dt, -1.35, 1.0);
    w.roll = approach(w.roll, rollT - w.yawRate * 1.1, 1.4, dt);
    w.speed = approach(w.speed, speedT, 0.55, dt);
    w.arch = archT; w.beat = beat; w.gape = approach(w.gape, gapeT, 3, dt);
    const cp = Math.cos(w.pitch);
    w.x += cp * Math.cos(w.yaw) * w.speed * dt;
    w.z += -cp * Math.sin(w.yaw) * w.speed * dt;
    w.y += Math.sin(w.pitch) * w.speed * dt;
    // buoyancy keeps a surface whale from rising out of the water on its own
    if (w.mode !== 'ascend' && w.mode !== 'breath' && w.y > -0.7) w.y -= (w.y + 0.7) * 0.8 * dt;
  }

  // --- the bubble net --------------------------------------------------------------------------
  function endNet() { net.state = 'idle'; net.last = time; net.nextAt = time + rand(95, 160); }
  function startNet() {
    // choose a whale not in the middle of something that matters
    let best = null, bestScore = -1;
    for (const w of ws) {
      if (NET_MODES.has(w.mode) || w.mode === 'flee' || w.mode === 'curious' || w.mode === 'dive') continue;
      if (w.mode === 'ascend' && w.y > -3) continue;
      const score = rand(0, 1) + (w.mode === 'submerged' ? 1 : 0);
      if (score > bestScore) { best = w; bestScore = score; }
    }
    if (!best) { net.nextAt = time + 6; return; }
    net.who = best.id; net.state = 'active';
    // the ring is centred well inside the fjord and in view
    for (let k = 0; k < 14; k++) {
      net.cx = rand(-38, 38); net.cz = rand(-118, -78);
      if (inFjord(net.cx, net.cz, SHORE_MARGIN + 30) && Math.hypot(net.cx - best.x, net.cz - best.z) > 24) break;
    }
    net.theta0 = Math.atan2(best.z - net.cz, best.x - net.cx); net.dir = random() < 0.5 ? 1 : -1;
    best.hasNet = true;
    stats.nets++;
    emit('net', best.id, { cx: net.cx, cz: net.cz });
    if (best.mode === 'breath') { best.breathsLeft = 0; setMode(best, 'travel'); }
    if (best.mode === 'travel' || best.mode === 'ascend' || best.mode === 'submerged') setMode(best, 'netApproach');
    else { net.state = 'idle'; net.nextAt = time + 5; }
  }

  // Kinematic scripts for the three stages. The whale is placed along the path and its yaw/pitch
  // follow the path's tangent, so the rig bends it round the ring exactly as it would a turn.
  function netScript(w, dt) {
    const R = NET.radius;
    if (w.mode === 'spiral') {
      w.spiralTau += dt;
      const u = w.spiralTau / NET.spiralTime, e = sstep(0, 0.12, u);
      const omega = NET.speed * e / R;
      net.theta0 += net.dir * omega * dt;
      const radius = R * (0.9 + 0.1 * Math.sin(u * 5));
      const tx = net.cx + Math.cos(net.theta0) * radius, tz = net.cz + Math.sin(net.theta0) * radius;
      const ty = -8.6 + 6.0 * Math.pow(u, 0.9);
      const dx = tx - w.x, dz = tz - w.z, dy = ty - w.y;
      const px = w.x, py = w.y, pz = w.z;
      w.x = approach(w.x, tx, 6, dt); w.z = approach(w.z, tz, 6, dt); w.y = approach(w.y, ty, 3, dt);
      const hx = w.x - px, hz = w.z - pz, hy = w.y - py;
      const hl = Math.hypot(hx, hz);
      if (hl > 1e-5) {
        const yawT = Math.atan2(-hz, hx), yawErr = wrapPi(yawT - w.yaw);
        w.yawRate = approach(w.yawRate, clamp(yawErr * 4, -1, 1), 5, dt);
        w.yaw = wrapPi(w.yaw + w.yawRate * dt);
      }
      w.speed = approach(w.speed, Math.hypot(hx, hz, hy) / dt, 3, dt);
      w.pitchRate = approach(w.pitchRate, (clamp(Math.atan2(hy, Math.max(hl, 1e-4)), -0.6, 0.6) - w.pitch) * 1.5, 3, dt);
      w.pitch += w.pitchRate * dt;
      w.roll = approach(w.roll, -net.dir * 0.5 * e, 1.5, dt);   // banked into the circle, belly to the centre
      w.arch = 0.15; w.beat = 0.7; w.gape = approach(w.gape, 0, 3, dt);
      // bubbles are released in a ring: from the underside, a few per step
      if (e > 0.5) {
        const nb = random() < 0.8 ? 1 : 2;
        for (let b = 0; b < nb; b++) {
          const j = 2 + Math.floor(random() * 7);
          w.rig.at(j * w.rig.JD, w._pt);
          if (w._pt[1] < -1.2) particles.bubble(w._pt[0] + rand(-0.5, 0.5), w._pt[1] - 0.8, w._pt[2] + rand(-0.5, 0.5), rand(0.18, 0.42));
        }
      }
      if (u >= 1) { net.ringAge = 0; setMode(w, 'netBelow'); }
    } else if (w.mode === 'netBelow') {
      // swing in beneath the middle of the ring
      const u = clamp(w.modeT / NET.belowTime, 0, 1), e = sstep(0, 1, u);
      const f = w.lungeFrom;
      const tx = f[0] + (net.cx - f[0]) * e, tz = f[2] + (net.cz - f[2]) * e, ty = f[1] + (-10.2 - f[1]) * e;
      const px = w.x, pz = w.z, py = w.y;
      w.x = tx; w.z = tz; w.y = ty;
      const hx = w.x - px, hz = w.z - pz;
      if (Math.hypot(hx, hz) > 1e-4) {
        const yawT = Math.atan2(-hz, hx);
        w.yawRate = approach(w.yawRate, clamp(wrapPi(yawT - w.yaw) * 2.5, -0.6, 0.6), 4, dt);
        w.yaw = wrapPi(w.yaw + w.yawRate * dt);
      }
      w.speed = approach(w.speed, 2.5, 1, dt);
      w.pitch = approach(w.pitch, -0.35 * (1 - u) + 0.3 * u, 2, dt);
      w.pitchRate = 0; w.roll = approach(w.roll, 0, 2, dt); w.arch = approach(w.arch, 0, 1, dt); w.beat = 0.5;
      if (u >= 1) { w.lungeYaw = w.yaw; setMode(w, 'lunge'); }
    } else {
      const tau = w.modeT, T = NET.lungeTime;
      // rise (ease out) to the apex, then fall back
      const riseT = 3.1;
      let y, vy;
      if (tau < riseT) { const s = tau / riseT; y = -10.2 + 11.1 * (1 - (1 - s) * (1 - s)); vy = 11.1 * 2 * (1 - s) / riseT; }
      else { const u = (tau - riseT) / (T - riseT); y = 0.9 - 7.2 * u * u; vy = -14.4 * u / (T - riseT); }
      w.y = y; w.vy = vy;
      const flat = 1.6;
      const over = sstep(2.5, 4.0, tau);
      const pitchT = (1.18 * (1 - over) - 1.05 * over) * (tau < 0.4 ? sstep(0, 0.4, tau) * 0.5 + 0.5 : 1);
      w.pitchRate = approach(w.pitchRate, (pitchT - w.pitch) * 3, 6, dt);
      w.pitch += w.pitchRate * dt;
      w.speed = flat;
      w.x += Math.cos(w.yaw) * flat * dt * 0.6; w.z += -Math.sin(w.yaw) * flat * dt * 0.6;
      w.yawRate = approach(w.yawRate, 0.03, 1, dt); w.yaw = wrapPi(w.yaw + w.yawRate * dt);
      w.roll = approach(w.roll, 1.45 * sstep(3.0, 4.6, tau) * (w.id % 2 ? -1 : 1), 2.2, dt);
      w.arch = approach(w.arch, 0.3 * sstep(1.5, 3.2, tau), 2, dt); w.beat = 0.8;
      w.gape = approach(w.gape, sstep(1.4, 2.2, tau) * (1 - sstep(3.4, 4.4, tau)), 4, dt);
      if (tau >= T) { endNet(); net.ringAge = 0; w.hasNet = false; w.breathsLeft = 2; setMode(w, 'ascend'); }
    }
    w.arch = clamp(w.arch, 0, 1);
  }

  // --- blow, splash, wake -----------------------------------------------------------------------
  function blow(w) {
    w.rig.blowhole(w._hole);
    w.lastBlow = time; stats.blows++;
    particles.spout(w._hole[0], w._hole[1] + 0.05, w._hole[2], 0.9 + 0.2 * random(), 0.85);
    emit('blow', w.id, { y: w._hole[1], x: w._hole[0], z: w._hole[2] });
    addDisturbance(w._hole[0], w._hole[2], 1.6, 0.004, 0.2);
  }
  function addDisturbance(x, z, radius, amount, foam = 0) {
    if (distCount >= MAXD) return;
    const o = distCount * 4;
    dist[o] = x; dist[o + 1] = z; dist[o + 2] = radius; dist[o + 3] = amount; distFoam[distCount] = foam;
    distCount++;
  }

  function stir(w, dt) {
    const rig = w.rig, P = rig.P, sc = w.scale;
    let slap = 0;
    for (let n = 0; n < SAMPLE_JOINTS.length; n++) {
      const i = SAMPLE_JOINTS[n], x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const u = i / (NJ - 1);
      const r = sc * (1.25 * Math.sin(Math.PI * clamp(u * 1.1 + 0.02, 0, 1)) ** 0.8 + 0.18);
      const vy = rig.jointVY[i];
      const depth = -y;                           // positive below the surface
      const reach = r + 1.2;
      if (Math.abs(vy) < 1e-4 || depth > reach + 2.5 || depth < -(r + 2)) continue;
      // inside the surface layer a vertical motion pushes water; deeper, a broad swell
      const g = depth < reach ? 1 : Math.exp(-(((depth - reach) / 1.6) ** 2));
      let amt = clamp(vy * 0.0016 * r / 1.2 * g, -0.018, 0.018);
      let foam = Math.abs(vy) > 1.8 ? clamp(Math.abs(vy) * 0.03, 0, 0.35) * g : 0;
      if (i >= 21 && Math.abs(vy) > 4.4 && depth < reach) { slap = Math.max(slap, Math.abs(vy)); amt = clamp(vy * 0.0035, -0.04, 0.04); foam = 0.6; }
      if (Math.abs(amt) > 2e-5 || foam > 0) addDisturbance(x, z, r * 0.9 + 1.0, amt, foam);
    }
    // the bow wave and the wake of a swimmer at the surface
    if (w.speed > 0.5 && P[1] > -2.4) addDisturbance(P[0], P[2], 2.2 * sc, 0.0013 * Math.min(w.speed, 3), 0.05);
    if (slap > 0 && time - w.lastSlap > 0.3) { w.lastSlap = time; particles.splash(P[(NJ - 1) * 3], P[(NJ - 1) * 3 + 2], clamp(slap / 8, 0.15, 1), 0.2); emit('slap', w.id, { v: slap }); }
    // the fluke of a diving whale drips as it rises clear
    if (P[(NJ - 1) * 3 + 1] > 0.3 && (w.dripT -= dt) < 0) {
      w.dripT = 0.05 + 0.1 * random();
      const l = (NJ - 1) * 3; particles.drip(P[l] + rand(-1.2, 1.2) * 0, P[l + 1], P[l + 2]);
      particles.drip(P[l] + rand(-0.9, 0.9), P[l + 1] - 0.1, P[l + 2] + rand(-0.4, 0.4));
    }
    // a breach or a lunge: the splash as the head leaves and as the body falls back
    if (w.mode === 'lunge') {
      const y = w.y;
      if (w.modeT > 1.2 && y > -0.3 && !w.exited) { w.exited = true; particles.splash(P[0], P[2], 0.9, 0.2); addDisturbance(P[0], P[2], 5, 0.035, 1); emit('exit', w.id); }
      if (y < 0.1 && w.modeT > 3.3 && time - w.lastSplashIn > 2) {
        w.lastSplashIn = time; particles.splash(P[IP * 3], P[IP * 3 + 2], 1.4, 0.3); emit('splashdown', w.id);
        for (let j = 2; j < NJ; j += 4) addDisturbance(P[j * 3], P[j * 3 + 2], 4.5, -0.06, 1);
      }
    } else w.exited = false;
  }

  // --- the step ---------------------------------------------------------------------------------
  function step(dt) {
    time += dt;
    distCount = 0;
    // cursor ripples are injected by the caller (it knows the screen); here only the whales' reactions
    // net schedule
    if (net.state === 'idle' && time >= net.nextAt) startNet();
    if (net.state === 'active') net.ringAge += dt;

    // curiosity and fright
    const slowCursor = cursor.active && cursor.speed < CURSOR.slow && time - cursor.movedAt < 20;
    const fastCursor = cursor.active && time - cursor.fast < 0.5 && cursor.speed > CURSOR.slow * 2;
    if (cursor.active) {
      let nearest = null, nd = 1e9, curious = null;
      for (const w of ws) {
        const d = Math.hypot(w.x - cursor.x, w.z - cursor.z);
        if (w.mode === 'curious') curious = w;
        if (d < nd && !NET_MODES.has(w.mode)) { nd = d; nearest = w; }
      }
      if (fastCursor) {
        for (const w of ws) {
          if (NET_MODES.has(w.mode) || w.mode === 'dive' || w.mode === 'flee' || w.mode === 'submerged') continue;
          if (Math.hypot(w.x - cursor.x, w.z - cursor.z) < CURSOR.fleeRange && w.y > -5) setMode(w, 'flee');
        }
      } else if (slowCursor && !curious && nearest && nd < CURSOR.curiousRange && time > nearest.cooldownCurious) {
        if (['travel', 'submerged', 'ascend', 'breath'].includes(nearest.mode) && !nearest.hasNet && time - cursor.fast > 3) {
          if (nearest.mode === 'breath' && nearest.modeT < 7) { /* finish the breath first */ } else setMode(nearest, 'curious');
        }
      }
    }

    for (const w of ws) {
      think(w, dt);
      constrain(w);
      // the rig follows the pose
      w.rig.step(dt, {
        x: w.x, y: w.y, z: w.z, yaw: w.yaw, pitch: w.pitch, roll: w.roll, speed: w.speed, yawRate: w.yawRate,
        pitchRate: w.pitchRate, beat: w.beat, arch: w.arch,
      });
      w.pitchBias = 0;
      stir(w, dt);
    }
    // bubbles reaching the surface boil the water
    particles.step(dt);
    for (let e = 0; e < particles.eventCount; e++) {
      const ex = particles.events[e * 3], ez = particles.events[e * 3 + 1], k = particles.events[e * 3 + 2];
      if (k >= 1) addDisturbance(ex, ez, 1.3, 0.0016, 0.3);
      else addDisturbance(ex, ez, 0.7, 0.0015 * k, 0.06);
    }
    particles.clearEvents();
    // The cursor's own marks: a wake along its path, and a slow drip ring while it rests.
    if (cursor.active) {
      if (cursor.travel > 0.02) {
        const a = clamp(cursor.travel * 0.0035, 0.0007, 0.011);
        addDisturbance(cursor.x, cursor.z, 1.7, a, clamp(a * 10, 0, 0.22));
        cursor.travel = 0;
      }
      if (time - cursor.drip > 1.35 && time - cursor.movedAt > 0.25) { cursor.drip = time; addDisturbance(cursor.x, cursor.z, 1.5, 0.010, 0.1); }
    }
  }

  // hard limits: inside the box and the fjord, away from the camera, apart from each other
  function constrain(w) {
    const rig = w.rig;
    const c = fjordCenter(w.z), hw = fjordHalfWidth(w.z);
    const lo = Math.max(BOUNDS.minX, c - hw + SHORE_MARGIN - 10), hi = Math.min(BOUNDS.maxX, c + hw - SHORE_MARGIN + 10);
    if (w.mode !== 'spiral' && w.mode !== 'netBelow' && w.mode !== 'lunge') {
      w.x = clamp(w.x, lo, hi); w.z = clamp(w.z, BOUNDS.minZ, BOUNDS.maxZ);
    } else { w.x = clamp(w.x, BOUNDS.minX, BOUNDS.maxX); w.z = clamp(w.z, BOUNDS.minZ - 4, BOUNDS.maxZ); }
    w.y = clamp(w.y, -12, 3.2);
    for (const o of ws) {
      if (o === w || Math.abs(o.y - w.y) > 7) continue;
      const dx = w.x - o.x, dz = w.z - o.z, d = Math.hypot(dx, dz);
      if (d < 11) { const k = (11 - d) * 0.5 / (d + 1e-6); w.x += dx * k * 0.5; w.z += dz * k * 0.5; }
    }
  }

  function summary() {
    return ws.map((w) => ({ id: w.id, mode: w.mode, x: w.x, y: w.y, z: w.z, yaw: w.yaw, speed: w.speed }));
  }

  return {
    whales: ws, particles, cursor, net, stats, log, summary,
    get time() { return time; },
    get disturbances() { return { data: dist, foam: distFoam, count: distCount }; },
    step, setCursor,
    addDisturbance,
    // The cursor's own marks on the water (the caller supplies where and how hard).
    ripple(x, z, amount, radius = 1.8, foam = 0) { addDisturbance(x, z, radius, amount, foam); },
    diagnostics() {
      return {
        time, whales: ws.map((w) => ({ mode: w.mode, x: +w.x.toFixed(1), y: +w.y.toFixed(2), z: +w.z.toFixed(1) })),
        blows: stats.blows, dives: stats.dives, lunges: stats.lunges, nets: stats.nets, net: net.state,
        particles: particles.count, disturbances: distCount, invalidTransitions: stats.invalid,
        cursor: cursor.active,
      };
    },
  };
}
