import assert from 'node:assert/strict';
import { emissionWeights, colorByAltitude, substorm, pulse, auroraEnergy, auroraAmbient, ALT_MIN, ALT_MAX } from '../src/aurora-model.js';

// Green peaks between 110 and 150 km; red exists only above ~200 km; the pink fringe is low.
{
  for (const hard of [0.2, 0.5, 0.8]) {
    let gPeak = 0, gAt = 0, pAt = 0, pPeak = 0, rLow = 0, rPeak = 0, rAt = 0;
    for (let h = ALT_MIN; h <= ALT_MAX; h += 0.25) {
      const w = emissionWeights(h, hard);
      if (w.green > gPeak) { gPeak = w.green; gAt = h; }
      if (w.pink > pPeak) { pPeak = w.pink; pAt = h; }
      if (w.red > rPeak) { rPeak = w.red; rAt = h; }
      if (h < 184 || (hard === 0.5 && h < 195)) rLow = Math.max(rLow, w.red);
    }
    if (hard === 0.5) assert.ok(gAt >= 110 && gAt <= 150, `green peaks at ${gAt} km`);
    assert.ok(gAt >= 100 && gAt <= 160, `green peak ${gAt} km for hardness ${hard}`);
    assert.equal(rLow, 0, 'no red below ~185-195 km');
    assert.ok(rAt > 220, `red peaks high (${rAt} km)`);
    assert.ok(pAt < 105 && pAt < gAt, `pink fringe sits under the green (${pAt} km)`);
  }
  // Harder precipitation slides the whole profile down.
  const peak = (hard) => { let best = 0, at = 0; for (let h = 80; h < 220; h += 0.5) { const g = emissionWeights(h, hard).green; if (g > best) { best = g; at = h; } } return at; };
  assert.ok(peak(0.9) < peak(0.1), 'hard electrons glow lower');
}

// Colour is continuous, bounded, non-negative; green is the dominant channel at the peak.
{
  const c = [0, 0, 0], d = [0, 0, 0];
  let maxJump = 0, maxVal = 0;
  for (let h = ALT_MIN; h < ALT_MAX; h += 0.1) {
    colorByAltitude(h, 0.5, c); colorByAltitude(h + 0.1, 0.5, d);
    for (let k = 0; k < 3; k++) { assert.ok(Number.isFinite(c[k]) && c[k] >= 0); maxVal = Math.max(maxVal, c[k]); maxJump = Math.max(maxJump, Math.abs(c[k] - d[k])); }
  }
  assert.ok(maxJump < 0.08, `continuous (max step ${maxJump.toFixed(3)} per 0.1 km)`);
  assert.ok(maxVal <= 2.0, `bounded (${maxVal.toFixed(2)})`);
  colorByAltitude(130, 0.5, c);
  assert.ok(c[1] > c[0] * 3 && c[1] > c[2] * 2, 'green dominates at 130 km');
  colorByAltitude(250, 0.4, c);
  assert.ok(c[0] > c[1] * 3, 'red dominates at the top');
}

// The substorm cycle: finite, bounded, aperiodic, with onsets 150-290 s apart.
{
  let lo = 9, hi = 0;
  for (let t = 0; t < 3600; t += 0.5) {
    const s = substorm(t), e = auroraEnergy(t), p = pulse(t);
    assert.ok([s.level, s.act, s.expand, e, p].every(Number.isFinite));
    assert.ok(s.act >= 0 && s.act <= 1 && s.expand >= 0 && s.expand <= 1);
    assert.ok(p >= 0.4 && p <= 1.15);
    lo = Math.min(lo, e); hi = Math.max(hi, e);
  }
  assert.ok(lo > 0.1 && hi < 1.8 && hi / lo > 1.8, `energy ranges ${lo.toFixed(2)}..${hi.toFixed(2)}`);
  // Never repeats: compare windows one nominal period apart.
  for (const period of [60, 120, 200, 240]) {
    let diff = 0; for (let t = 0; t < 300; t += 1) diff += Math.abs(auroraEnergy(t) - auroraEnergy(t + period));
    assert.ok(diff / 300 > 0.03, `no repeat at ${period} s`);
  }
  // Onsets: act jumps from low to high.
  const onsets = []; let prev = substorm(0);
  for (let t = 0.5; t < 1500; t += 0.5) { const s = substorm(t); if (s.onset < prev.onset && s.onset >= 0) onsets.push(t); prev = s; }
  assert.ok(onsets.length >= 4);
  for (let i = 1; i < onsets.length; i++) { const g = onsets[i] - onsets[i - 1]; assert.ok(g >= 149 && g <= 292, `onset gap ${g}`); }
  assert.ok(substorm(12).act > 0.3 && substorm(0).level > 0.6, 'the scene opens with a lively sky');
  const amb = auroraAmbient(10);
  assert.ok(amb.every((v) => v > 0 && v < 0.3) && amb[1] > amb[0]);
}
console.log('ok aurora-model');
