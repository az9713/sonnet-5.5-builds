import assert from 'node:assert/strict';
import { createRig, NJ, IP, FIXED_STEP, LAG_DELAYS } from '../src/rig.js';
import { BODY_LEN } from '../src/whale-shape.js';

const dist = (rig, i) => Math.hypot(rig.P[i * 3] - rig.P[(i + 1) * 3], rig.P[i * 3 + 1] - rig.P[(i + 1) * 3 + 1], rig.P[i * 3 + 2] - rig.P[(i + 1) * 3 + 2]);
const pose = (t, o = {}) => ({ x: 0, y: -1, z: -80 - t * 0, yaw: Math.PI / 2, pitch: 0, roll: 0, speed: 2, ...o });

// Joint spacing is preserved and nothing goes NaN over a long, hard run (turning, arching, beating).
{
  const rig = createRig({ scale: 1 });
  let worst = 0, last = null;
  for (let s = 0; s < 60 * 600; s++) {
    const t = s * FIXED_STEP;
    const c = pose(t, {
      yawRate: 0.3 * Math.sin(t * 0.21), pitchRate: 0.2 * Math.sin(t * 0.37), arch: 0.5 + 0.5 * Math.sin(t * 0.11), beat: 0.5 + 0.5 * Math.sin(t * 0.07),
      yaw: Math.PI / 2 + 0.8 * Math.sin(t * 0.13), pitch: 0.4 * Math.sin(t * 0.17), roll: 0.5 * Math.sin(t * 0.09),
    });
    rig.step(FIXED_STEP, c);
    if (s % 30 === 0) {
      for (let i = 0; i < NJ - 1; i++) worst = Math.max(worst, Math.abs(dist(rig, i) - rig.JD) / rig.JD);
      for (const v of rig.P) assert.ok(Number.isFinite(v));
      for (const v of rig.T) assert.ok(Number.isFinite(v));
      for (const v of rig.U) assert.ok(Number.isFinite(v));
      for (const v of rig.lag) assert.ok(Number.isFinite(v));
    }
  }
  assert.ok(worst < 1e-4, `joint spacing preserved (max relative error ${worst})`);
  assert.ok(Math.abs(rig.JD * (NJ - 1) - BODY_LEN) < 1e-9);
}

// Dorsoventral undulation: amplitude grows toward the tail and the phase lags the head.
{
  const rig = createRig({ scale: 1 });
  const ly = (i) => { // joint height in the body frame
    const d = [rig.P[i * 3] - rig.P[IP * 3], rig.P[i * 3 + 1] - rig.P[IP * 3 + 1], rig.P[i * 3 + 2] - rig.P[IP * 3 + 2]];
    return d[0] * rig.Up[0] + d[1] * rig.Up[1] + d[2] * rig.Up[2];
  };
  const N = 60 * 60, series = Array.from({ length: NJ }, () => new Float64Array(N));
  for (let s = 0; s < 60 * 20 + N; s++) {
    rig.step(FIXED_STEP, pose(s * FIXED_STEP, { beat: 0.6 }));
    if (s >= 60 * 20) for (let i = 0; i < NJ; i++) series[i][s - 60 * 20] = ly(i);
  }
  const amp = (x) => { const m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length) * Math.SQRT2; };
  const a = series.map(amp);
  for (let i = IP + 2; i < NJ; i++) assert.ok(a[i] > a[i - 1] * 0.999, `amplitude grows toward the tail (joint ${i}: ${a[i].toFixed(3)})`);
  assert.ok(a[NJ - 1] > 5 * a[IP + 2] && a[NJ - 1] > 0.3, `tail swings ${a[NJ - 1].toFixed(2)} m vs ${a[IP + 2].toFixed(3)} m near the pivot`);
  assert.ok(a[0] < a[NJ - 1] * 0.6, 'the head swings less than the tail');
  // phase: cross-correlate each joint's series with a mid-body reference; the tail lags it
  const lagOf = (x, ref) => {
    let best = 0, bestLag = 0; const max = 70;
    for (let L = 0; L < max; L++) { let sum = 0; for (let n = 0; n < N - max; n++) sum += ref[n] * x[n + L]; if (sum > best) { best = sum; bestLag = L; } }
    return bestLag;
  };
  const ref = series[IP + 6];
  const lagMid = lagOf(series[IP + 6], ref), lagTail = lagOf(series[NJ - 1], ref), lagLate = lagOf(series[NJ - 4], ref);
  assert.ok(lagTail > lagMid + 3 && lagTail >= lagLate, `tail phase lags (mid ${lagMid}, joint ${NJ - 4}: ${lagLate}, tail ${lagTail} steps)`);
}

// Turning: the body bends after the head, more toward the tail, with delay.
{
  const rig = createRig({ scale: 1 });
  for (let s = 0; s < 120; s++) rig.step(FIXED_STEP, pose(0, { beat: 0 }));
  const k0 = rig.kTurn.slice();
  for (let s = 0; s < 60 * 3; s++) rig.step(FIXED_STEP, pose(0, { beat: 0, yawRate: 0.25 }));
  assert.ok(Math.abs(rig.kTurn[NJ - 1]) > 0.01, 'the tail bends');
  assert.ok(Math.abs(rig.kTurn[2]) < 1e-9, 'the head does not bend');
  let tHead = null, tTail = null;
  const rig2 = createRig({ scale: 1 });
  for (let s = 0; s < 60 * 8; s++) {
    rig2.step(FIXED_STEP, pose(0, { beat: 0, yawRate: 0.25 }));
    const t = s * FIXED_STEP, tgt = Math.abs(rig2.kTurn[NJ - 1]);
    if (tHead === null && Math.abs(rig2.kTurn[IP + 3]) > 0.5 * 0.2 * 0.2) tHead = t;
    if (tTail === null && tgt > 0.5 * 0.2 * 0.2) tTail = t;
  }
  assert.ok(tHead !== null && tTail !== null && tTail > tHead, `the tail answers later (${tHead}, ${tTail})`);
}

// Fin lag: after a sharp turn the fluke tip trails behind the root, then settles.
{
  const rig = createRig({ scale: 1 });
  for (let s = 0; s < 240; s++) rig.step(FIXED_STEP, pose(0, { beat: 0, speed: 2 }));
  const series = [[], [], [], []];
  const z = (d) => rig.lag[d * 3 + 2];
  for (let s = 0; s < 60 * 12; s++) {
    const turning = s < 60 * 1.2;
    rig.step(FIXED_STEP, pose(0, { beat: 0, speed: 2, yawRate: turning ? 0.4 : 0 }));
    for (let d = 0; d < 4; d++) series[d].push(z(d));
  }
  const peakAt = (x) => { let b = 0, at = 0; x.forEach((v, i) => { if (Math.abs(v) > b) { b = Math.abs(v); at = i; } }); return [at, b]; };
  const [t0, a0] = peakAt(series[0]), [t3, a3] = peakAt(series[3]);
  assert.ok(a0 > 0.05, `the fluke root is displaced (${a0.toFixed(3)} m)`);
  assert.ok(t3 - t0 >= Math.round(LAG_DELAYS[3] / FIXED_STEP) * 0.8, `the tip peaks later (${t0} -> ${t3} steps)`);
  // sign: a left/right turn swings the lag opposite to the yaw rate
  assert.ok(Math.sign(series[0][t0]) === -1, 'trails opposite the turn');
  // settles: no endless oscillation
  const tail = series[3].slice(60 * 10);
  assert.ok(Math.max(...tail.map(Math.abs)) < 0.01, 'settles without ringing forever');
  // it does overshoot a little (underdamped): the root sign flips at least once
  let flips = 0; for (let i = 1; i < series[0].length; i++) if (series[0][i] * series[0][i - 1] < 0) flips++;
  assert.ok(flips >= 1, 'underdamped spring overshoots');
}

// The bend and the trailing are big enough to see: a steady turn swings the tail more than a metre sideways
// of the head's line, and a dive pitch-over drags the fluke's tip behind its root by tens of centimetres.
{
  const rig = createRig({ scale: 1.2 });
  for (let s = 0; s < 60 * 8; s++) rig.step(FIXED_STEP, pose(0, { beat: 0.3, speed: 1.6, yawRate: 0.14 }));
  const tail = [rig.P[(NJ - 1) * 3] - rig.P[IP * 3], rig.P[(NJ - 1) * 3 + 1] - rig.P[IP * 3 + 1], rig.P[(NJ - 1) * 3 + 2] - rig.P[IP * 3 + 2]];
  const side = tail[0] * rig.S[0] + tail[1] * rig.S[1] + tail[2] * rig.S[2];
  assert.ok(Math.abs(side) > 1.0, `the tail bends ${Math.abs(side).toFixed(2)} m off the head line in a turn`);
  const r2 = createRig({ scale: 1.2 });
  for (let s = 0; s < 240; s++) r2.step(FIXED_STEP, pose(0, { beat: 0.3, speed: 1.9 }));
  let tipMax = 0, rootMax = 0;
  for (let s = 0; s < 60 * 3; s++) {
    r2.step(FIXED_STEP, pose(0, { beat: 0.35, speed: 1.9, pitchRate: s < 90 ? -0.5 : 0, arch: 0.9 }));
    tipMax = Math.max(tipMax, Math.hypot(r2.lag[0 * 3 + 9], r2.lag[0 * 3 + 10], r2.lag[0 * 3 + 11]));
    rootMax = Math.max(rootMax, Math.hypot(r2.lag[0], r2.lag[1], r2.lag[2]));
  }
  assert.ok(tipMax > 0.3, `the fluke trails ${tipMax.toFixed(2)} m on a dive`);
}

// Blowhole is on the top of the head, ahead of the pivot.
{
  const rig = createRig({ scale: 1 });
  rig.step(FIXED_STEP, pose(0, { y: -0.6 }));
  const b = rig.blowhole([0, 0, 0]);
  assert.ok(b[1] > -0.6 && b[1] < 0.8, `blowhole height ${b[1]}`);
  assert.ok(b[2] < rig.P[IP * 3 + 2], 'ahead of the pivot (the whale swims toward -z)');
}
console.log('ok rig');
