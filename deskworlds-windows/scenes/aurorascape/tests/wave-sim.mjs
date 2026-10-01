import assert from 'node:assert/strict';
import { createWaveSim, SIM, simConstants, simShader } from '../src/wave-sim.js';

const N = 128;
const cellX = (sim, i) => SIM.minX + (i + 0.5) * sim.dx, cellZ = (sim, j) => SIM.minZ + (j + 0.5) * sim.dx;

// Stable: the energy of a struck pond never grows and the field stays finite over 10k steps.
{
  const sim = createWaveSim(N);
  sim.inject(0, SIM.minZ + SIM.size / 2, 3, 0.05, 0.5);
  const e0 = sim.energy();
  let prev = e0, grew = 0, maxH = 0;
  for (let s = 0; s < 10000; s++) {
    sim.step();
    if (s % 100 === 0) {
      const e = sim.energy();
      assert.ok(Number.isFinite(e));
      if (e > prev * 1.0005) grew++;
      prev = e;
    }
    if (s % 500 === 0) for (const x of sim.h) { assert.ok(Number.isFinite(x)); maxH = Math.max(maxH, Math.abs(x)); }
  }
  assert.equal(grew, 0, 'energy never grows');
  assert.ok(sim.energy() < e0 * 0.05, `energy decays (${(sim.energy() / e0).toExponential(2)})`);
  assert.ok(maxH < 2, 'heights stay small');
  assert.ok(simConstants(N).k < 0.25 && simConstants(256).k < 0.25, 'well inside the CFL limit');
}

// A droplet spreads symmetrically: the ring is round and its radius grows at about c.
{
  const sim = createWaveSim(N);
  const cx = 0, cz = SIM.minZ + SIM.size / 2;
  sim.inject(cx, cz, 2.5, 0.04);
  const T = 3.0, steps = Math.round(T / SIM.step);
  for (let s = 0; s < steps; s++) sim.step();
  const mid = N / 2;
  let sym = 0, norm = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const mi = N - 1 - i, mj = N - 1 - j;
    sym += Math.abs(sim.h[j * N + i] - sim.h[j * N + mi]) + Math.abs(sim.h[j * N + i] - sim.h[mj * N + i]);
    norm += Math.abs(sim.h[j * N + i]) * 2;
  }
  assert.ok(sym / norm < 0.05, `droplet is symmetric (${(sym / norm).toFixed(4)})`);
  // radial position of the strongest ring
  let best = 0, bestR = 0;
  for (let i = mid; i < N; i++) { const a = Math.abs(sim.h[mid * N + i]); if (a > best) { best = a; bestR = (i - mid + 0.5) * sim.dx; } }
  assert.ok(bestR > 0.5 * SIM.c * T && bestR < 1.1 * SIM.c * T, `ring radius ${bestR.toFixed(1)} m after ${T} s (c*t = ${(SIM.c * T).toFixed(1)})`);
  assert.ok(Math.abs(sim.h[mid * N + mid]) < best, 'the centre has moved on');
}

// Reflection: a pulse that meets the edge comes back, softened (not cancelled, not amplified).
{
  const sim = createWaveSim(N);
  const cz = SIM.minZ + SIM.size / 2, x0 = SIM.minX + SIM.size * 0.72;
  sim.inject(x0, cz, 3, 0.05);
  const mid = N / 2;
  // Track the right-moving front's amplitude at a probe 12 m before the edge, then the reflection.
  const probe = N - 1 - Math.round(60 / sim.dx);
  let incoming = 0, reflected = 0, tIn = 0;
  for (let s = 0; s < 2400; s++) {
    sim.step();
    const a = sim.h[mid * N + probe], t = s * SIM.step;
    if (t < 3.5) { if (Math.abs(a) > incoming) { incoming = Math.abs(a); tIn = t; } }
    else if (Math.abs(a) > reflected) reflected = Math.abs(a);
  }
  assert.ok(incoming > 1e-4, 'the pulse reached the probe');
  assert.ok(reflected > 0.12 * incoming, `a reflection returns (${(reflected / incoming).toFixed(2)} of incoming)`);
  assert.ok(reflected < 1.05 * incoming, 'the reflection is not amplified');
}

// Foam: injected agitation fades; the shader is generated from the same constants.
{
  const sim = createWaveSim(N);
  sim.inject(0, SIM.minZ + 150, 2, 0, 1);
  const f0 = Math.max(...sim.foam);
  for (let s = 0; s < 600; s++) sim.step();
  assert.ok(Math.max(...sim.foam) < f0 * 0.01, 'foam fades');
  const glsl = simShader(256);
  assert.ok(glsl.includes(simConstants(256).k.toFixed(6)) && glsl.includes('uD['));
}
console.log('ok wave-sim');
