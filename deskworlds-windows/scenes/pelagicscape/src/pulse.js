// Jellyfish bell pulsation: kinematics only, no rendering. The same functions exist as GLSL below.
//
// A pulse phase p in [0, 1) runs the cycle: a fast power stroke (contraction, the first TC of the cycle)
// then a slow passive relaxation (elastic recoil of the mesogloea), about 1:2 in time as in a real moon jelly.
// The contraction starts at the bell margin, where the pacemakers sit, and travels toward the apex, so the
// margin leads: a point at normalised distance s from the apex (0 apex, 1 margin) lags the margin by (1-s)*LAG.
//
// The bell is a surface of revolution whose radius/height profile is recomputed from the local contraction
// every frame (meridian below); nothing about its shape is stored.

export const TC = 0.34;          // fraction of the cycle spent contracting
export const LAG = 0.11;         // phase delay of the apex behind the margin
export const PROFILE = {
  A: 1.5,                        // meridian arc angle: 1.5 rad is almost a hemisphere
  H0: 0.64,                      // resting height, in bell radii
  FLARE: 0.1,                    // resting skirt flare
  KR: 0.34,                      // radius lost at full contraction
  KH: 0.5,                       // height gained at full contraction
  KD: 0.2,                       // how far the margin drops (swings inward and down) at full contraction
  T0: 0.19, TM: 0.012,           // wall thickness at the apex and at the margin, in bell radii
  KT: 0.45,                      // the wall thickens as the bell squeezes
  SHIFT: 0.34,                   // centres the bell vertically
};

const clamp01 = x => Math.min(1, Math.max(0, x));
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const wrap = p => p - Math.floor(p);

// Contraction in [0, 1] at pulse phase p: rises monotonically over [0, TC], falls monotonically after.
export function contraction(p) {
  p = wrap(p);
  return p < TC ? ease(p / TC) : 1 - ease((p - TC) / (1 - TC));
}

// Local contraction at distance s from the apex (s = 1 at the margin).
export function localContraction(p, s, amp = 1) {
  return amp * contraction(wrap(p - (1 - s) * LAG));
}

// Share of the stroke's impulse delivered per unit of phase: integrates to 1 over [0, TC].
export function thrustProfile(p) {
  p = wrap(p);
  if (p >= TC) return 0;
  const x = p / TC;
  return 6 * x * (1 - x) / TC;
}

// Velocity gained from one power stroke (units/s): bigger animals and harder strokes go faster.
export function strokeImpulse(size, vigor = 1) {
  return 0.85 * Math.sqrt(size) * Math.max(0.05, vigor);
}

// The bell outline at arc parameter s in [0, 1] and local contraction c, in bell radii: out = [r, y].
export function meridian(s, c, out) {
  const { A, H0, FLARE, KR, KH, KD } = PROFILE;
  const a = s * A;
  const rr = Math.sin(a) / Math.sin(A) * (1 + FLARE * s ** 5);
  const yy = (Math.cos(a) - Math.cos(A)) / (1 - Math.cos(A));
  out[0] = rr * (1 - KR * c * (0.3 + 0.7 * s * s));
  out[1] = H0 * yy * (1 + KH * c * (1 - s)) - KD * c * s * s * s - PROFILE.SHIFT * H0;
  return out;
}

export function thickness(s, c) {
  const { T0, TM, KT } = PROFILE;
  return (TM + T0 * Math.max(0, 1 - s * s) ** 1.3) * (1 + KT * c);
}

// Margin point of a bell of radius R at azimuth phi, local to the bell (y along the axis, apex up).
const m = [0, 0];
export function marginPoint(R, p, amp, phi, out) {
  meridian(1, localContraction(p, 1, amp), m);
  out[0] = m[0] * R * Math.cos(phi); out[1] = m[1] * R; out[2] = m[0] * R * Math.sin(phi);
  return out;
}
export function apexPoint(R, p, amp, out) {
  meridian(0, localContraction(p, 0, amp), m);
  out[0] = 0; out[1] = m[1] * R; out[2] = 0;
  return out;
}

const g = x => x.toFixed(5);
// The same kinematics as GLSL: contract(p), meridian(s, c), wallThickness(s, c).
export const PULSE_GLSL = `
float pelEase(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float pelContract(float p) {
  p = fract(p);
  return p < ${g(TC)} ? pelEase(p / ${g(TC)}) : 1.0 - pelEase((p - ${g(TC)}) / ${g(1 - TC)});
}
vec2 pelMeridian(float s, float c) {
  float a = s * ${g(PROFILE.A)};
  float rr = sin(a) / ${g(Math.sin(PROFILE.A))} * (1.0 + ${g(PROFILE.FLARE)} * pow(s, 5.0));
  float yy = (cos(a) - ${g(Math.cos(PROFILE.A))}) / ${g(1 - Math.cos(PROFILE.A))};
  return vec2(rr * (1.0 - ${g(PROFILE.KR)} * c * (0.3 + 0.7 * s * s)),
    ${g(PROFILE.H0)} * yy * (1.0 + ${g(PROFILE.KH)} * c * (1.0 - s)) - ${g(PROFILE.KD)} * c * s * s * s - ${g(PROFILE.SHIFT * PROFILE.H0)});
}
float pelThick(float s, float c) {
  return (${g(PROFILE.TM)} + ${g(PROFILE.T0)} * pow(max(0.0, 1.0 - s * s), 1.3)) * (1.0 + ${g(PROFILE.KT)} * c);
}
const float PEL_LAG = ${g(LAG)};
`;
