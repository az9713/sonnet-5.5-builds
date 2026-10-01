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
  const sim = createWaveSim(256);
  const cx = 0, cz = SIM.minZ + SIM.size / 2;
  sim.inject(cx, cz, 2.5, 0.04);
  const T = 3.0, steps = Math.round(T / SIM.step);
  for (let s = 0; s < steps; s++) sim.step();
  const NN = 256, mid = NN / 2;
  let sym = 0, norm = 0;
  for (let j = 0; j < NN; j++) for (let i = 0; i < NN; i++) {
    const mi = NN - 1 - i, mj = NN - 1 - j;
    sym += Math.abs(sim.h[j * NN + i] - sim.h[j * NN + mi]) + Math.abs(sim.h[j * NN + i] - sim.h[mj * NN + i]);
    norm += Math.abs(sim.h[j * NN + i]) * 2;
  }
  assert.ok(sym / norm < 0.05, `droplet is symmetric (${(sym / norm).toFixed(4)})`);
  // radial position of the strongest ring
  let best = 0, bestR = 0;
  for (let i = mid; i < NN; i++) { const r = (i - mid + 0.5) * sim.dx; if (r < 0.3 * SIM.c * T) continue; const a = Math.abs(sim.h[mid * NN + i]); if (a > best) { best = a; bestR = r; } }
  assert.ok(bestR > 0.6 * SIM.c * T && bestR < 1.15 * SIM.c * T, `ring radius ${bestR.toFixed(1)} m after ${T} s (c*t = ${(SIM.c * T).toFixed(1)})`);
  assert.ok(best > 5e-4, 'a clear ring is travelling outward');
}

// Reflection: a pulse that meets the edge comes back, softened (not cancelled, not amplified).
{
  const NN = 192, sim = createWaveSim(NN);
  const cz = SIM.minZ + SIM.size / 2, edge = SIM.minX + SIM.size;
  const dEdge = 90, dProbe = 30;
  sim.inject(edge - dEdge, cz, 3, 0.05);
  const mid = NN / 2, probe = NN - 1 - Math.round(dProbe / sim.dx);
  const tIn = (dEdge - dProbe) / SIM.c, tBack = (dEdge + dProbe) / SIM.c;
  let incoming = 0, reflected = 0;
  for (let s = 0; s < Math.round((tBack + 6) / SIM.step); s++) {
    sim.step();
    const a = Math.abs(sim.h[mid * NN + probe]), t = (s + 1) * SIM.step;
    if (t > tIn - 3 && t < tIn + 3) incoming = Math.max(incoming, a);
    else if (t > tBack - 3 && t < tBack + 6) reflected = Math.max(reflected, a);
  }
  assert.ok(incoming > 1e-4, 'the pulse reached the probe');
  assert.ok(reflected > 0.15 * incoming, `a reflection returns (${(reflected / incoming).toFixed(2)} of incoming)`);
  assert.ok(reflected < 1.0 * incoming, 'the reflection is not amplified');
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
