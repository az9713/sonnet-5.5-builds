import assert from 'node:assert/strict';
import { contraction, localContraction, thrustProfile, strokeImpulse, meridian, marginPoint, TC, LAG, PROFILE } from '../src/pulse.js';

// 1. Contraction profile: monotonic rise over the power stroke, monotonic fall over relaxation, bounded.
let prev = -1, peakP = 0, peak = -1;
for (let i = 0; i <= 1000; i++) {
  const p = i / 1000, c = contraction(p);
  assert.ok(c >= 0 && c <= 1 && Number.isFinite(c));
  if (p <= TC) assert.ok(c >= prev - 1e-12, 'rises through the stroke');
  else assert.ok(c <= prev + 1e-12, 'falls through relaxation');
  if (c > peak) { peak = c; peakP = p; }
  prev = c;
}
assert.ok(Math.abs(peakP - TC) < 2e-3 && peak > 0.999, 'peak at the end of the power stroke');
assert.ok(Math.abs(contraction(0) - contraction(1)) < 1e-9, 'periodic');
assert.ok(TC < 0.5 && (1 - TC) / TC > 1.8, 'relaxation is at least about twice as slow as the stroke');

// 2. The margin leads the apex: it reaches full contraction earlier in the cycle.
function peakPhase(s) {
  let best = -1, at = 0;
  for (let i = 0; i < 2000; i++) { const p = i / 2000, c = localContraction(p, s); if (c > best) { best = c; at = p; } }
  return at;
}
const pm = peakPhase(1), pa = peakPhase(0.0), pmid = peakPhase(0.5);
assert.ok(pm < pmid && pmid < pa, 'peak phase increases from margin to apex');
assert.ok(Math.abs((pa - pm) - LAG) < 2e-3, 'apex lags the margin by LAG');
// the margin is already contracting while the apex has barely moved
assert.ok(localContraction(0.1, 1) > localContraction(0.1, 0) + 0.2);

// 3. Geometry: contraction narrows the margin, grows the height, thickens the wall; shape stays finite.
const r0 = [0, 0], r1 = [0, 0];
meridian(1, 0, r0); meridian(1, 1, r1);
assert.ok(r1[0] < r0[0] * 0.8, 'margin radius shrinks');
meridian(0, 0, r0); meridian(0, 1, r1);
assert.ok(r1[1] > r0[1] + 0.1, 'apex rises relative to the centre');
for (let i = 0; i <= 20; i++) for (let k = 0; k <= 10; k++) { meridian(i / 20, k / 10, r0); assert.ok(r0.every(Number.isFinite)); }
const a = [0, 0, 0], b = [0, 0, 0];
marginPoint(1, 0, 1, 0, a); marginPoint(1, TC, 1, 0, b);
assert.ok(b[0] < a[0] && b[1] < a[1], 'margin swings in and down during the stroke');

// 4. Thrust integrates to one over the stroke and is zero in relaxation.
let sum = 0; const N = 20000;
for (let i = 0; i < N; i++) sum += thrustProfile((i + 0.5) / N) / N;
assert.ok(Math.abs(sum - 1) < 1e-3, 'thrust profile integrates to 1: ' + sum);
assert.equal(thrustProfile(0.7), 0);

// 5. Impulse per stroke is positive and the velocity drag-decays to zero afterwards.
for (const size of [0.3, 0.5, 1, 1.5]) assert.ok(strokeImpulse(size, 1) > 0 && strokeImpulse(size, 0) > 0);
assert.ok(strokeImpulse(1, 1.4) > strokeImpulse(1, 0.6), 'harder strokes are stronger');
{
  const dt = 1 / 60, drag = 1.3, f = 0.5;
  let v = 0, p = 0, x = 0, vmax = 0, strokes = 0, quiet = null;
  for (let step = 0; step < 60 * 60; step++) {
    const stroking = step < 60 * 12;                      // twelve seconds of pulsing, then nothing
    if (stroking) {
      const j = strokeImpulse(1, 1);
      v += j * thrustProfile(p) * f * dt;
      const before = p; p += f * dt; if (Math.floor(p) !== Math.floor(before)) strokes++;
    }
    v *= Math.exp(-drag * dt); x += v * dt; vmax = Math.max(vmax, v);
    assert.ok(v >= 0 && Number.isFinite(v));
    if (step === 60 * 12 + 60 * 8) quiet = v;
  }
  assert.ok(strokes >= 5 && vmax > 0.2 && x > 1, 'strokes push the animal forward');
  assert.ok(quiet < vmax * 0.01 && v < 1e-6, 'velocity decays to zero after the last stroke');
}
console.log('ok pulse');
