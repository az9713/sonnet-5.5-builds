// Shaders for the cosmic web. Light is accumulated additively as linear HDR in a half-float target, bloomed, tone
// mapped and dithered once at the end.
import { swirlGLSL } from './morph.js';

// Projected-plane lens (see lens.js): solves beta = theta - E^2 theta / (theta^2 + c^2) for the primary image
// (outside the Einstein ring) or, with SECOND defined, the secondary one (inside it, on the far side).
const LENS = /* glsl */`
uniform vec4 uLens;       // centre px (xy), Einstein radius px, core px
uniform float uLensDepth; // sources nearer than this are in front of the mass and are not lensed
void lensImage(vec2 pos, float weight, out vec2 image, out vec2 dir, out float tang, out float rad, out bool culled) {
  vec2 beta = pos - uLens.xy;
  float b = length(beta);
  float E = uLens.z * weight, c2 = uLens.w * uLens.w;
  dir = b > 1e-3 ? beta / b : vec2(1.0, 0.0);
  image = pos; tang = 1.0; rad = 1.0; culled = false;
  if (E < 0.5) return;
  float disc = sqrt(b * b + 4.0 * E * E);
#ifdef SECOND
  if (b > 5.0 * E) { culled = true; return; }
  float th = 0.5 * (b - disc);
#else
  float th = 0.5 * (b + disc);
#endif
  float slope = 1.0;
  for (int i = 0; i < 5; i++) {
    float d = th * th + c2;
    float f = th - E * E * th / d - b;
    slope = 1.0 - E * E * (c2 - th * th) / (d * d);
    float s = abs(slope) < 0.08 ? (slope < 0.0 ? -0.08 : 0.08) : slope;
    th -= clamp(f / s, -0.5 * (abs(th) + 1.0), 0.5 * (abs(th) + 1.0));
  }
  image = uLens.xy + dir * th;
  tang = min(abs(th) / max(b, 1e-3), 7.0);
  rad = min(1.0 / max(abs(slope), 0.1), 4.0);
}
`;

// Density colour ramp over log10 of the local density: voids stay black, sheets are deep violet, filaments blue-white,
// the densest knots amber-gold.
const RAMP = /* glsl */`
vec3 ramp(float l) {
  vec3 c = vec3(0.012, 0.010, 0.050);
  c = mix(c, vec3(0.20, 0.07, 0.58), smoothstep(-0.6, 0.1, l));
  c = mix(c, vec3(0.22, 0.34, 1.00), smoothstep(0.0, 0.55, l));
  c = mix(c, vec3(0.70, 0.86, 1.00), smoothstep(0.4, 0.95, l));
  c = mix(c, vec3(1.00, 0.74, 0.30), smoothstep(0.85, 1.4, l));
  c = mix(c, vec3(1.00, 0.50, 0.12), smoothstep(1.4, 2.2, l));
  return c;
}
// Mycelium: bioluminescent, teal in the thin threads through pale gold to amber in the dense cores.
vec3 rampMycelium(float l) {
  vec3 c = vec3(0.010, 0.030, 0.030);
  c = mix(c, vec3(0.05, 0.42, 0.38), smoothstep(-0.9, 0.3, l));
  c = mix(c, vec3(0.45, 0.85, 0.62), smoothstep(0.2, 0.9, l));
  c = mix(c, vec3(1.00, 0.90, 0.58), smoothstep(0.8, 1.6, l));
  c = mix(c, vec3(1.00, 0.55, 0.16), smoothstep(1.6, 2.6, l));
  return c;
}
`;

export const POINT_VERT = /* glsl */`
uniform vec2 uRes;
uniform vec3 uCam;            // camera position, box units
uniform float uD;             // linear growth factor
uniform float uFrom, uTo, uM; // structures blended and global progress
uniform float uSpread, uSwirlAmp, uTime, uStreak;
uniform vec3 uCenter;         // where the transition front starts
uniform vec3 uRay;            // cursor ray, view space
uniform vec3 uPull;           // strength, angular radius, depth
uniform vec2 uFocus;          // focus depth, aperture px
uniform float uH;             // lattice spacing, box units
uniform float uSize;          // kernel sigma of a web particle relative to the local spacing
uniform float uEps;           // thickness floor of a collapsed sheet, in lattice spacings
uniform float uStructSigma;   // kernel sigma of a neural / mycelial point, box units
uniform float uStructGain;
uniform float uWebGain;       // brightens the young, low-contrast web
uniform float uGain, uCap, uMinSigma, uSoft;
uniform float uDustPass;
uniform float uDustSize, uDustGain;
attribute vec3 aPsi;
attribute vec3 aHd;           // diagonal of d psi_i / d q_j
attribute vec3 aHo;           // its off-diagonal: xy, xz, yz
attribute vec4 aNeural;
attribute vec4 aMyc;
attribute vec4 aRand;
attribute vec2 aPulse;
varying vec3 vColor;
flat varying vec4 vShape;
flat varying vec2 vDir;
${LENS}
${RAMP}
${swirlGLSL()}
vec3 wrapD(vec3 d) { return d - floor(d + 0.5); }
float det3(mat3 m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) - m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2]) + m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2]);
}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vShape = vec4(1.0); vDir = vec2(1.0, 0.0); }
void main() {
  // Zel'dovich: x = q + D psi. Each particle is the image of a lattice cell: the cell's footprint is the gaussian
  // whose covariance is the cell mapped by F = I + D H, so the sprite is stretched along void flows and squeezed
  // flat across a collapsing sheet or filament. The density 1 / det F then follows from the same matrix.
  vec3 webPos = position + uD * aPsi;
  mat3 F = mat3(1.0 + uD * aHd.x, uD * aHo.x, uD * aHo.y, uD * aHo.x, 1.0 + uD * aHd.y, uD * aHo.z, uD * aHo.y, uD * aHo.z, 1.0 + uD * aHd.z);
  mat3 G = F * F;
  // sigma along each axis = h * |1 + D lambda| * size (so neighbours always overlap, however squeezed) plus a thin floor.
  mat3 Sweb = uH * uH * (uSize * uSize * G + mat3(uEps * uEps));
  float logWeb = -0.5 * log(det3(G + mat3(uSoft * uSoft))) * 0.4342945;
  mat3 Sstruct = mat3(uStructSigma * uStructSigma);
  vec3 A; float lA, gA; mat3 SA;
  if (uFrom < 0.5) { A = webPos; lA = logWeb; SA = Sweb; gA = uWebGain; }
  else if (uFrom < 1.5) { A = aNeural.xyz; lA = aNeural.w * 3.0 - 0.6; SA = Sstruct; gA = uStructGain; }
  else { A = aMyc.xyz; lA = aMyc.w * 3.0 - 0.6; SA = Sstruct; gA = uStructGain; }
  vec3 P = A; float l = lA, s = 0.0, gain = gA;
  mat3 S = SA;
  float wN = uFrom > 0.5 && uFrom < 1.5 ? 1.0 : 0.0, wM = uFrom > 1.5 ? 1.0 : 0.0;
  if (uM > 0.0) {
    vec3 B; float lB, gB; mat3 SB;
    if (uTo < 0.5) { B = webPos; lB = logWeb; SB = Sweb; gB = uWebGain; }
    else if (uTo < 1.5) { B = aNeural.xyz; lB = aNeural.w * 3.0 - 0.6; SB = Sstruct; gB = uStructGain; }
    else { B = aMyc.xyz; lB = aMyc.w * 3.0 - 0.6; SB = Sstruct; gB = uStructGain; }
    // The front sweeps outward from uCenter through the lattice, so neighbouring particles leave together.
    float off = clamp(length(wrapD(position - uCenter)) / 0.75 + (aRand.x - 0.5) * 0.12, 0.0, 1.0);
    float m = clamp(uM * (1.0 + uSpread) - uSpread * off, 0.0, 1.0);
    s = m * m * (3.0 - 2.0 * m);
    vec3 mid = A + s * wrapD(B - A);
    P = mid + uSwirlAmp * 4.0 * s * (1.0 - s) * swirl(mid, uTime);
    l = mix(lA, lB, s);
    gain = pow(gA, 1.0 - s) * pow(gB, s);
    S = SA + (SB - SA) * s;
    // Matter in transit is smeared along its path: a streak whose length peaks mid-transition.
    vec3 dlt = wrapD(B - A);
    float dl = length(dlt);
    vec3 vd = dlt / max(dl, 1e-5);
    float st = uStreak * dl * 4.0 * s * (1.0 - s);
    S += st * st * mat3(vd * vd.x, vd * vd.y, vd * vd.z);
    wN = mix(wN, uTo > 0.5 && uTo < 1.5 ? 1.0 : 0.0, s);
    wM = mix(wM, uTo > 1.5 ? 1.0 : 0.0, s);
  }
  if (uDustPass > 0.5) { S = mat3(uDustSize * uDustSize); gain = uDustGain; }
  vec3 rel = P - uCam;
  rel -= floor(rel + 0.5);
  vec3 ar = abs(rel);
  float edge = smoothstep(0.5, 0.34, ar.x) * smoothstep(0.5, 0.34, ar.y) * smoothstep(0.5, 0.34, ar.z);
  vec3 view = mat3(viewMatrix) * rel;
  // The cursor leans matter toward its ray: a soft pull on the offset from the ray, strongest near the mass.
  if (uPull.x > 0.001) {
    float t = max(dot(view, uRay), 1e-3);
    vec3 perp = view - t * uRay;
    float ang2 = dot(perp, perp) / (t * t);
    float g = exp(-ang2 / (uPull.y * uPull.y)) * exp(-pow((t - uPull.z) / 0.3, 2.0));
    view -= perp * (uPull.x * g * 0.6);
  }
  float d = -view.z;
  vec4 clip = projectionMatrix * vec4(view, 1.0);
  if (d < 0.012 || edge < 0.002) { cull(); return; }
  float focal = projectionMatrix[1][1] * 0.5 * uRes.y;
  // Project the covariance to the screen: Sigma_screen = J R Sigma R^T J^T.
  mat3 R = mat3(viewMatrix);
  mat3 Sv = R * S * transpose(R);
  vec3 j0 = focal / d * vec3(1.0, 0.0, view.x / d), j1 = focal / d * vec3(0.0, 1.0, view.y / d);
  vec3 s0 = Sv * j0, s1 = Sv * j1;
  float a = dot(j0, s0), b = dot(j0, s1), c = dot(j1, s1);
  float coc = uFocus.y * abs(d - uFocus.x) / d;                 // circle of confusion, px
  float blur = 0.09 * coc * coc;
  a += blur; c += blur;
  // Weak lensing by the cursor's point mass: the sprite is sheared by the lens's Jacobian.
  vec2 pos = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  vec2 img, dir; float tang, rad; bool culled;
  float lw = smoothstep(0.8 * uLensDepth, 1.2 * uLensDepth, d);
  lensImage(pos, lw, img, dir, tang, rad, culled);
  if (culled) { cull(); return; }
  if (tang != 1.0 || rad != 1.0) {
    mat2 M = mat2(tang) + (rad - tang) * mat2(dir.x * dir.x, dir.x * dir.y, dir.x * dir.y, dir.y * dir.y);
    mat2 L = M * mat2(a, b, b, c) * M;
    a = L[0][0]; b = L[0][1]; c = L[1][1];
  }
  // Principal axes of the screen ellipse.
  float mean = 0.5 * (a + c), diff = sqrt(0.25 * (a - c) * (a - c) + b * b);
  float l1 = max(mean + diff, uMinSigma * uMinSigma), l2 = max(mean - diff, uMinSigma * uMinSigma);
  float phi = 0.5 * atan(2.0 * b, a - c);
  vec2 major = vec2(cos(phi), sin(phi));
  float s1x = sqrt(l1), s2x = sqrt(l2);
  // Flux per particle is fixed, so surface brightness is flux / area: dense, squeezed sprites burn bright, and the
  // spread-out sprites of voids are faint. Lensing magnifies flux with area.
  float mu = min(tang * rad, 12.0);
  float amp = uGain * gain * mu / (s1x * s2x);
  float lum = 0.05 + 0.95 * pow(smoothstep(-0.7, 1.5, l), 1.5);
  vec3 col = mix(ramp(l), rampMycelium(l), clamp(wM, 0.0, 1.0));
  col *= vec3(1.0 - 0.12 * aRand.z, 1.0, 1.0 + 0.12 * aRand.z);
  float tw = 0.9 + 0.1 * sin(uTime * (0.6 + aRand.w) + aRand.w * 40.0);
  float pn = 0.5 + 0.5 * sin(6.2831853 * (aPulse.x * 5.0 - uTime * 0.28));
  float pm = 0.5 + 0.5 * sin(6.2831853 * (aPulse.y * 4.0 - uTime * 0.22));
  float boost = 1.0 + 2.6 * wN * pow(pn, 8.0) + 1.4 * wM * pow(pm, 8.0);
  amp *= lum * boost * tw * edge * smoothstep(0.07, 0.2, d);
  if (uDustPass > 0.5) {
    amp = uGain * gain * mu / (s1x * s2x) * smoothstep(-0.2, 1.4, l) * edge * smoothstep(0.07, 0.25, d);
    col = mix(vec3(0.20, 0.16, 0.55), col, 0.35);
  }
#ifdef SECOND
  amp *= 0.25;
#endif
  float ex = sqrt(max(a, 0.0)), ey = sqrt(max(c, 0.0));
  float need = 2.0 * 3.1 * max(max(ex, ey), uMinSigma);
  float size_px = clamp(need, 2.0, uCap);
  // A sprite wider than the cap is shrunk, not cut: a truncated gaussian would show its square edge.
  float k = min(1.0, uCap / need);
  vColor = col * amp;
  vShape = vec4(s1x * k, s2x * k, size_px, 1.0);
  vDir = major;
  gl_PointSize = size_px;
  gl_Position = vec4((img / uRes * 2.0 - 1.0) * clip.w, clip.z, clip.w);
}
`;

export const POINT_FRAG = /* glsl */`
varying vec3 vColor;
flat varying vec4 vShape;
flat varying vec2 vDir;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  pc.y = -pc.y;
  vec2 c = pc * vShape.z;
  vec2 u = vec2(dot(c, vDir), dot(c, vec2(-vDir.y, vDir.x)));
  float e = 0.5 * (u.x * u.x / (vShape.x * vShape.x) + u.y * u.y / (vShape.y * vShape.y));
  float w = exp(-e) * smoothstep(0.5, 0.37, max(abs(pc.x), abs(pc.y)));
  gl_FragColor = vec4(vColor * w, 1.0);
}
`;

// Distant galaxies: elliptical smudges at infinity (direction only, so no parallax), lensed like everything else.
export const GALAXY_VERT = /* glsl */`
uniform vec2 uRes;
uniform float uGalaxyGain, uMinSigma, uCap;
attribute vec4 aShape;
attribute vec3 aTint;
varying vec3 vColor;
flat varying vec4 vShape;
flat varying vec2 vDir;
${LENS}
void main() {
  vec3 v = mat3(viewMatrix) * position;
  if (v.z > -0.1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vShape = vec4(1.0); vDir = vec2(1.0, 0.0); return; }
  vec4 clip = projectionMatrix * vec4(v, 1.0);
  float focal = projectionMatrix[1][1] * 0.5 * uRes.y;
  float major = max(aShape.x * focal / (-v.z), 0.9);
  float minor = max(major * aShape.y, 0.6);
  vec2 pos = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  vec2 img, dir; float tang, rad; bool culled;
  lensImage(pos, 1.0, img, dir, tang, rad, culled);
  if (culled) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vShape = vec4(1.0); vDir = vec2(1.0, 0.0); return; }
  vec2 own = vec2(cos(aShape.z), sin(aShape.z));
  float lensed = clamp((max(tang, 1.0 / max(rad, 0.05)) - 1.15) * 1.5, 0.0, 1.0);
  vec2 d = normalize(mix(own, dir, lensed));
  float sa0 = mix(major, major * rad, lensed), sb0 = mix(minor, major * tang, lensed);
  float sa = max(sa0, 0.5), sb = max(sb0, 0.5);
  // Surface brightness is conserved by lensing; a sprite squeezed below a pixel keeps its flux, not its peak.
  vColor = aTint * aShape.w * uGalaxyGain * min(1.0, sa0 * sb0 / (sa * sb));
#ifdef SECOND
  vColor *= 0.18;   // the inner image is the demagnified, faint one
#endif
  float need = 2.0 * 5.0 * max(sa, sb);
  float size_px = clamp(need, 3.0, uCap);
  float k = size_px / need;
  if (k < 1.0) { sa *= k; sb *= k; }
  vShape = vec4(sa, sb, size_px, 1.0);
  vDir = d;
  gl_PointSize = size_px;
  gl_Position = vec4((img / uRes * 2.0 - 1.0) * clip.w, clip.z, clip.w);
}
`;

export const GALAXY_FRAG = /* glsl */`
varying vec3 vColor;
flat varying vec4 vShape;
flat varying vec2 vDir;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  pc.y = -pc.y;
  vec2 c = pc * vShape.z;
  vec2 u = vec2(dot(c, vDir), dot(c, vec2(-vDir.y, vDir.x)));
  float rn = sqrt(u.x * u.x / (vShape.x * vShape.x) + u.y * u.y / (vShape.y * vShape.y));
  // A Sersic-like cusp with a faint extended disc.
  float w = (exp(-2.6 * sqrt(rn)) * 0.9 + 0.1 * exp(-0.5 * rn * rn * 0.3)) * smoothstep(0.5, 0.36, max(abs(pc.x), abs(pc.y)));
  gl_FragColor = vec4(vColor * w, 1.0);
}
`;

export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Bloom is a pyramid of 13-tap downsamples and tent upsamples: scattering of bright light in the optics and the eye.
export const DOWN_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 a = texture2D(uSrc, vUv + uTexel * vec2(-2.0, -2.0)).rgb, b = texture2D(uSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb, c = texture2D(uSrc, vUv + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 d = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb, e = texture2D(uSrc, vUv).rgb, f = texture2D(uSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 2.0)).rgb, h = texture2D(uSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb, i = texture2D(uSrc, vUv + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 j = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb, k = texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 l = texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb, m = texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}
`;

export const UP_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb
    + 2.0 * (texture2D(uSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb
      + texture2D(uSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb)
    + 4.0 * texture2D(uSrc, vUv).rgb;
  gl_FragColor = vec4(texture2D(uBase, vUv).rgb + s / 16.0 * uWeight, 1.0);
}
`;

export const OUTPUT_FRAG = /* glsl */`
uniform sampler2D uBeauty;
uniform sampler2D uBloom;
uniform vec3 uHalo;
uniform float uExposure;
uniform float uBloomGain;
uniform float uFrame;
uniform vec2 uOutRes;
uniform float uOverscan;
uniform vec4 uLensOut;   // centre in 0..1 uv (xy), Einstein radius in output px (z), strength 0..1 (w)
varying vec2 vUv;
vec3 filmic(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec2 huv = (vUv - 0.5) / uOverscan + 0.5;   // the particle target spans a little more than the screen
  vec3 beauty = texture2D(uBeauty, huv).rgb;
  vec3 bloom = texture2D(uBloom, huv).rgb * uHalo * uBloomGain;
  vec3 hdr = beauty + bloom;
  // The Einstein ring: the faint image of everything behind the mass smeared into a thin glowing circle.
  if (uLensOut.w > 0.002) {
    vec2 dv = (vUv - uLensOut.xy) * uOutRes;
    float r = length(dv);
    float ring = exp(-0.5 * pow((r - uLensOut.z) / (0.06 * uLensOut.z + 1.5), 2.0));
    float lum = dot(bloom, vec3(0.3, 0.5, 0.2)) / max(uBloomGain, 1e-3);
    hdr += vec3(0.55, 0.7, 1.0) * ring * uLensOut.w * (0.012 + 0.22 * lum);
  }
  // A whisper of cold light fills the dark so the black has depth, falling off to the corners.
  vec2 p = vUv - 0.5;
  p.x *= uOutRes.x / uOutRes.y;
  float r2 = dot(p, p);
  hdr += vec3(0.00022, 0.00032, 0.00085) * exp(-r2 * 2.2);
  hdr *= uExposure * (1.0 - 0.55 * smoothstep(0.12, 0.95, r2 * 1.2));
  // Tone map mostly on the brightest channel so a knot keeps its amber and a filament its blue instead of both burning to white.
  float peak = max(max(hdr.r, hdr.g), max(hdr.b, 1e-5));
  vec3 mapped = mix(filmic(hdr), hdr * (filmic(vec3(peak)).x / peak), 0.65);
  mapped = mix(vec3(dot(mapped, vec3(0.2126, 0.7152, 0.0722))), mapped, 1.15);
  vec3 srgb = pow(max(mapped, 0.0), vec3(1.0 / 2.2));
  srgb += (hash(gl_FragCoord.xy + uFrame) + hash(gl_FragCoord.xy * 1.7 - uFrame) - 1.0) / 255.0;
  gl_FragColor = vec4(srgb, 1.0);
}
`;
