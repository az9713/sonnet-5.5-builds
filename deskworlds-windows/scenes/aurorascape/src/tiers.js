import { activeQuality } from '../../shared/render-policy.js';

// What each quality buys. The aurora march steps, the plan-map and march resolutions, the water
// simulation size, the star density and the reflection taps all scale; eco is built to be cheap.
export const TIERS = {
  eco: { steps: 20, auroraScale: 0.5, map: [320, 184], simN: 192, starCell: 0.030, bisect: 8, ss: 2, taps: 1, msaa: 0, levels: 5, landMax: 1920 },
  balanced: { steps: 24, auroraScale: 0.6, map: [512, 288], simN: 256, starCell: 0.022, bisect: 10, ss: 2, taps: 2, msaa: 4, levels: 6, landMax: 2560 },
  detail: { steps: 32, auroraScale: 0.75, map: [640, 360], simN: 384, starCell: 0.018, bisect: 12, ss: 3, taps: 3, msaa: 4, levels: 6, landMax: 3072 },
  native: { steps: 40, auroraScale: 0.8, map: [768, 432], simN: 512, starCell: 0.015, bisect: 12, ss: 3, taps: 4, msaa: 2, levels: 6, landMax: 3072 },
};
export const MAX_LEVELS = Math.max(...Object.values(TIERS).map((t) => t.levels));
export const tierName = (q) => (Object.hasOwn(TIERS, q) ? q : 'balanced');

// The tier in force for a requested quality and a power source ("native" falls back to "balanced"
// on battery, by the shared policy).
export const tierFor = (quality, onBattery = false) => tierName(activeQuality(quality, onBattery));

// Which tier-dependent resources must be rebuilt when going from one tier to another.
export function tierChanges(from, to) {
  const a = TIERS[tierName(from)], b = TIERS[tierName(to)];
  const diff = (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]);
  return {
    sim: diff('simN'),                                   // water simulation targets and shader
    map: diff('map'),                                    // plan-map target and its texel size
    aurora: diff('steps') || diff('auroraScale'),        // march steps and march target size
    land: diff('ss') || diff('bisect') || diff('landMax'), // land bake: re-traced
    bloom: diff('levels'),                               // bloom pyramid depth
    msaa: diff('msaa'),                                  // beauty target samples
    sky: diff('starCell') || diff('taps'),               // uniforms only
  };
}
