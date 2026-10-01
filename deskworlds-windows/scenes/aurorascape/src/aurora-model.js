// Auroral physics reduced to a few pure functions. The shaders carry the same numbers
// (see GLSL below), so what the tests check is what the sky draws.
//
// Emission by altitude, from the atomic physics:
//   557.7 nm atomic oxygen, green: the 0.7 s metastable state survives collisions only in
//         thin air, so it glows from the lowest edge up to ~200 km and peaks near 110-150 km.
//   630.0 nm atomic oxygen, red: a 110 s lifetime, so it is quenched below ~200 km and
//         shows only at the top of the curtain.
//   427.8 nm N2+ (first negative), blue-violet, and the N2 first-positive band, pink-magenta:
//         molecular nitrogen reaches the lowest altitudes, giving the pink lower fringe at 90-100 km.
// `hard` is how energetic the precipitating electrons are: hard electrons reach lower
// (the whole profile slides down and the pink fringe strengthens); soft ones stay high and red.

export const ALT_MIN = 80;     // km, bottom of the marched shell
export const ALT_MAX = 300;    // km, top of the marched shell
export const EARTH_R = 6371;   // km

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const COLORS = {
  green: [0.09, 1.0, 0.30],
  red: [1.0, 0.035, 0.03],
  blue: [0.28, 0.32, 1.0],
  pink: [1.0, 0.16, 0.55],
};

export function emissionWeights(h, hard = 0.5) {
  const e = h + 22 * (hard - 0.5);    // effective altitude on the reference profile
  const green = e < 125 ? Math.exp(-(((e - 125) / 15) ** 2)) : Math.exp(-(((e - 125) / 48) ** 2));
  const redTop = Math.exp(-((Math.max(e - 275, 0) / 55) ** 2));
  const red = sstep(196, 270, e) * redTop * (1.15 - 0.9 * hard);
  const blue = 0.55 * Math.exp(-(((e - 108) / 22) ** 2));
  const pink = (0.3 + 0.9 * hard) * Math.exp(-(((e - 94) / 8.5) ** 2));
  return { green, red, blue, pink };
}

export function colorByAltitude(h, hard = 0.5, out = [0, 0, 0]) {
  const w = emissionWeights(h, hard);
  for (let c = 0; c < 3; c++) out[c] = w.green * COLORS.green[c] + w.red * COLORS.red[c] + w.blue * COLORS.blue[c] + w.pink * COLORS.pink[c];
  return out;
}

// --- time structure ---------------------------------------------------------------------------
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// Substorms: a growth phase of slowly brightening arcs, a sudden onset (breakup) that
// brightens, moves poleward and turns on rapid ray activity, an expansion, then a recovery.
// The gaps between onsets are uneven (150-290 s), fixed by a hash so any time can be asked.
const STORM_START = -34;     // the first onset is a few seconds after the scene starts
const onsets = [STORM_START + 40];
function onsetAt(k) {
  while (onsets.length <= k) onsets.push(onsets[onsets.length - 1] + 150 + 140 * hash(onsets.length * 3.17 + 0.5));
  return onsets[k];
}

export function substorm(t) {
  let k = 0;
  while (onsetAt(k + 1) <= t) k++;
  const dt = t - onsetAt(k);                       // seconds since this onset (negative: growth phase)
  const next = onsetAt(k + 1) - onsetAt(k);
  let level, act;
  if (k === 0 && dt < 0) {
    level = 0.45 + 0.2 * sstep(-40, 0, dt); act = 0.1;
  } else if (dt < 0) { level = 0.4; act = 0.1; } else {
    const rise = sstep(0, 9, dt), fall = 1 - sstep(60, next - 25, dt);
    level = 0.45 + 0.95 * rise * (0.35 + 0.65 * fall);
    act = rise * (0.25 + 0.75 * (1 - sstep(25, 110, dt))) ;
  }
  // The previous event's recovery leaves a tail before the growth phase of the next.
  const growth = sstep(next - 40, next, dt) * 0.25;
  level = level * (1 - growth) + (0.5 + 0.2) * growth;
  const expand = sstep(0, 45, dt) * (1 - sstep(70, 170, dt));   // poleward expansion of the arcs
  return { level: clamp(level, 0.25, 1.5), act: clamp(act, 0, 1), expand: clamp(expand, 0, 1), onset: dt };
}

// Aperiodic pulsations: incommensurate slow sines, never the same twice over a visit.
export function pulse(t) {
  const a = Math.sin(t * 0.211 + 1.3 * Math.sin(t * 0.043) + 0.4);
  const b = Math.sin(t * 0.137 + 2.0) * Math.sin(t * 0.0731 + 0.7);
  const c = Math.sin(t * 0.53 + 3.0 * Math.sin(t * 0.0171));
  return clamp(0.82 + 0.16 * a + 0.12 * b + 0.05 * c, 0.4, 1.15);
}

export function auroraEnergy(t) {
  const s = substorm(t);
  return s.level * pulse(t);
}

// Mean colour of the light the aurora throws on the land, the water, the whales and the mist
// (linear RGB, small: it lights things at night). The curtains are mostly green; active phases
// add magenta from the low fringe.
export function auroraAmbient(t, out = [0, 0, 0]) {
  const s = substorm(t), e = s.level * pulse(t);
  const mag = 0.18 + 0.55 * s.act;
  out[0] = e * (0.014 + 0.050 * mag);
  out[1] = e * 0.095;
  out[2] = e * (0.040 + 0.040 * mag);
  return out;
}

export const AURORA_GLSL = /* glsl */`
// Mirrors aurora-model.js emissionWeights().
// blur is dH^2/12 for a marching step dH: the profile is pre-integrated over the step (a box
// filter, approximated by widening each Gaussian) so a few jittered steps do not alias.
float gaussW(float e, float mu, float sg, float blur){ float sf = sqrt(sg*sg + blur); return (sg/sf)*exp(-pow((e - mu)/sf, 2.0)); }
vec4 auroraWeights(float h, float hard, float blur) {
  float e = h + 22.0*(hard - 0.5);
  float g = gaussW(e, 125.0, e < 125.0 ? 15.0 : 48.0, blur);
  float r = smoothstep(196.0, 270.0, e)*(1.15 - 0.9*hard)*exp(-pow(max(e - 275.0, 0.0)/sqrt(55.0*55.0 + blur), 2.0));
  float b = 0.55*gaussW(e, 108.0, 22.0, blur);
  float p = (0.3 + 0.9*hard)*gaussW(e, 94.0, 8.5, blur);
  return vec4(g, r, b, p);
}
const vec3 AU_GREEN = vec3(${COLORS.green.join(', ')});
const vec3 AU_RED = vec3(${COLORS.red.join(', ')});
const vec3 AU_BLUE = vec3(${COLORS.blue.join(', ')});
const vec3 AU_PINK = vec3(${COLORS.pink.join(', ')});
vec3 auroraColor(float h, float hard, float blur) {
  vec4 w = auroraWeights(h, hard, blur);
  return w.x*AU_GREEN + w.y*AU_RED + w.z*AU_BLUE + w.w*AU_PINK;
}
`;
