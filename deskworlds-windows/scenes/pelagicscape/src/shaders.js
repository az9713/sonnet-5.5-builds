import { PULSE_GLSL } from './pulse.js';
import { COMB_GLSL } from './comb.js';

// Everything is rendered into one linear-HDR target with two outputs: premultiplied colour (rgb, a) and a circle of
// confusion channel (coc*w, 0, 0, w) that a later pass uses for depth of field. All scene materials use GLSL3 so they
// can write both.

const OUT = /* glsl */`
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gCoc;
`;

const COMMON = /* glsl */`
uniform float uTime;
uniform float uFocus;      // focal distance
uniform float uCoc;        // circle of confusion, in pixels, at relative defocus 1
uniform float uCocMax;
vec3 waterTrans(float d) { return exp(-vec3(0.13, 0.058, 0.040) * d); }
// Objects keep a little more of their own colour than the open water does, or every red or pink animal would turn blue.
vec3 objTrans(float d) { return exp(-vec3(0.075, 0.040, 0.032) * d); }
float cocOf(float d) { return min(uCocMax, uCoc * abs(d - uFocus) / max(d, 0.1)); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
vec3 rainbow(float h) { return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))); }
`;

// ---------------------------------------------------------------------------------------------- jellyfish bell
export const BELL_VERT = /* glsl */`
uniform vec3 uCenter, uX, uY, uZ;
uniform float uR, uPhase, uAmp, uSeed, uLobes;
uniform vec2 uOval;
uniform float uTime;
attribute vec2 aP;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;       // radial param in the resting disc, azimuth, wall thickness, inner flag
varying vec2 vState;      // arc parameter s, local contraction
varying float vDepth;
${PULSE_GLSL}
vec3 bellLocal(float s, float phi, float inner, out float cLoc, out float th) {
  cLoc = uAmp * pelContract(uPhase - (1.0 - s) * PEL_LAG);
  float e = 0.004, s0 = clamp(s, e, 1.0 - e);
  vec2 m = pelMeridian(s, cLoc);
  th = pelThick(s, cLoc);
  if (inner > 0.5) {
    vec2 T = normalize(pelMeridian(s0 + e, cLoc) - pelMeridian(s0 - e, cLoc));
    m -= vec2(-T.y, T.x) * th;
  }
  float sw = pow(s, 6.0);
  float ov = sin(2.0 * phi + uOval.x + uTime * 0.21) * 0.035 + sin(3.0 * phi + uOval.y - uTime * 0.17) * 0.02;
  float r = m.x * (1.0 + ov * (0.4 + 0.6 * s) * (0.5 + 0.5 * cLoc));
  float y = m.y;
  float lobe = 0.5 + 0.5 * cos(phi * uLobes);
  y -= 0.055 * sw * lobe * (1.0 + 0.4 * cLoc);
  r *= 1.0 + 0.02 * (1.0 - lobe) * sw;
  y += 0.014 * sin(phi * uLobes * 0.5 - uTime * 2.1 + 5.0 * uPhase) * sw;
  return vec3(r * cos(phi), y, r * sin(phi));
}
void main() {
  float t = aP.x, inner = t > 0.5 ? 1.0 : 0.0;
  float s = inner > 0.5 ? 2.0 - 2.0 * t : 2.0 * t;
  float phi = aP.y * 6.28318530;
  float c, th, c2, th2;
  vec3 P = bellLocal(s, phi, inner, c, th);
  float sn = clamp(s, 0.012, 0.985);          // normals are taken a little off the poles, where the lathe degenerates
  vec3 Pn = bellLocal(sn, phi, inner, c2, th2);
  vec3 Ps = bellLocal(sn + 0.01, phi, inner, c2, th2);
  vec3 Pp = bellLocal(sn, phi + 0.03, inner, c2, th2);
  vec3 n = -cross(Ps - Pn, Pp - Pn);
  n = normalize(n + vec3(0.0, 1e-9, 0.0)) * (inner > 0.5 ? -1.0 : 1.0);
  vec3 local = P * uR;
  vec3 world = uCenter + uX * local.x + uY * local.y + uZ * local.z;
  vNormal = uX * n.x + uY * n.y + uZ * n.z;
  vWorld = world;
  vInfo = vec4(sin(s * 1.5) / sin(1.5), phi, th, inner);
  vState = vec2(s, c);
  vec4 vp = viewMatrix * vec4(world, 1.0);
  vDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

export const BELL_FRAG = /* glsl */`
${OUT}
${COMMON}
uniform float uPass;
uniform vec3 uBody, uGonad, uMargin;
uniform float uSeed, uLobes, uExposure;
uniform float uPhase;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vInfo;
varying vec2 vState;
varying float vDepth;

float horseshoe(vec2 q, float k, float seed) {
  float ang = k * 1.5707963 + 0.7853982 + 0.08 * sin(seed + k);
  vec2 out_ = vec2(cos(ang), sin(ang));
  vec2 d = q - out_ * 0.47;
  float L = length(d);
  float ring = exp(-pow((L - 0.17) / 0.036, 2.0));
  float gap = smoothstep(0.25, 0.7, dot(d / (L + 1e-4), out_));
  float fill = exp(-pow(L / 0.2, 2.0)) * 0.10;
  return (ring + fill) * (1.0 - gap);
}
float lineAt(float cnt, float a, float rr, float w) {
  float f = abs(fract(a * cnt) - 0.5);
  float arc = (0.5 - f) / cnt * 6.28318 * max(rr, 0.04);
  return exp(-pow(arc / w, 2.0));
}
float canals(float rr, float a) {
  a += 0.006 * sin(rr * 23.0 + uSeed) + 0.004 * sin(rr * 51.0 + uSeed * 2.0);
  float c = lineAt(8.0, a, rr, 0.011) * smoothstep(0.12, 0.2, rr);
  c += lineAt(16.0, a + 0.03 * rr, rr, 0.008) * smoothstep(0.5, 0.58, rr) * 0.8;
  c += lineAt(32.0, a, rr, 0.006) * smoothstep(0.76, 0.84, rr) * 0.6;
  c += exp(-pow((rr - 0.94) / 0.012, 2.0)) * 0.9;
  return c * (1.0 - smoothstep(0.985, 1.0, rr));
}
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNormal);
  float ndv = dot(N, V);
  if (uPass > 0.5 ? ndv < 0.0 : ndv >= 0.0) discard;
  float an = clamp(abs(ndv), 0.0, 1.0);
  float rr = vInfo.x, phi = vInfo.y, th = vInfo.z, inner = vInfo.w, s = vState.x, contr = vState.y;
  float a = phi / 6.28318;
  vec2 q = rr * vec2(cos(phi), sin(phi));

  float fres = pow(1.0 - an, 3.0);
  float path = th * 0.5 / max(an, 0.16);
  float dens = 1.0 - exp(-13.0 * path);
  float thin = exp(-th * 26.0);

  // subsurface colour: pale where thin, deeper where thick; lit softly from above
  vec3 L = normalize(vec3(0.18, 1.0, 0.28));
  float wrap = 0.5 + 0.5 * dot(N, L);
  vec3 deep = uBody * vec3(0.55, 0.62, 0.9), pale = mix(uBody, vec3(0.8, 0.9, 1.0), 0.3);
  vec3 sub = mix(deep, pale, thin);
  vec3 col = sub * dens * (0.040 + 0.10 * wrap);
  col += mix(uBody, vec3(0.7, 0.9, 1.0), 0.5) * fres * (0.16 + 0.22 * wrap);
  // thin-film shimmer on the rim: the mesogloea acts as a lens and a prism
  col += rainbow(an * 1.3 + uSeed * 0.01 + s * 0.4) * fres * 0.07;

  // margin: thin, bright, tinted; scalloped lappets pick up the light
  float lobeW = 0.5 + 0.5 * cos(phi * uLobes);
  float rim = smoothstep(0.86, 1.0, s);
  col += uMargin * rim * rim * (0.20 + 0.28 * (1.0 - lobeW) + 0.5 * fres);
  col += vec3(0.8, 0.9, 1.0) * exp(-pow((s - 0.994) / 0.006, 2.0)) * 0.55 * (0.5 + 0.5 * lobeW);

  // organs: horseshoe gonads and radial canals on the subumbrella, seen through the bell wall
  float breathe = 0.82 + 0.18 * sin(uTime * 0.9 + uSeed) + 0.25 * contr;
  float gon = 0.0;
  if (inner > 0.5) {
    for (int k = 0; k < 4; k++) gon += horseshoe(q, float(k), uSeed);
    float gn = 0.7 + 0.5 * vnoise(q * 16.0 + uSeed) + 0.25 * vnoise(q * 40.0);
    col += uGonad * gon * gn * breathe * (0.7 + 0.5 * an) * 1.15;
    col += mix(uBody, vec3(0.8, 0.9, 1.0), 0.3) * canals(rr, a) * 0.11;
    // the manubrium at the very centre
    col += uGonad * exp(-pow(rr / 0.07, 2.0)) * 0.5;
  } else {
    col += mix(uBody, vec3(1.0), 0.5) * canals(rr, a) * 0.025 * (1.0 - fres);
    // nematocyst speckle across the exumbrella
    vec2 sp = q * 46.0, cell = floor(sp), f = fract(sp) - 0.5;
    float h = hash21(cell + uSeed), h2 = hash21(cell * 1.7 + 3.1);
    vec2 jit = (vec2(h2, fract(h * 7.3)) - 0.5) * 0.6;
    float dotm = smoothstep(0.17, 0.0, length(f - jit)) * step(0.7, h);
    float tw = 0.55 + 0.45 * sin(uTime * (1.0 + 3.0 * h2) + h * 40.0);
    col += vec3(0.7, 0.9, 1.0) * dotm * tw * 0.35 * (0.4 + 0.6 * an);
  }

  col *= objTrans(vDepth) * uExposure;
  float alpha = dens * 0.68;
  float w = clamp(alpha + dot(col, vec3(0.3, 0.5, 0.2)) * 1.4, 0.0, 1.0);
  gColor = vec4(col, alpha);
  gCoc = vec4(cocOf(vDepth) * w, 0.0, 0.0, w);
}
`;

// ---------------------------------------------------------------------------------------------- tentacles and oral arms
export const THREAD_VERT = /* glsl */`
uniform sampler2D uNodes;
uniform float uN;               // nodes per chain
uniform float uWidth;           // root half-width, world units
uniform float uKind;            // 0 tentacle, 1 oral arm, 2 feeding tentacle
uniform float uPxScale;         // pixels per world unit at distance 1
uniform float uTime;
attribute float aU;
attribute float aSide;
attribute vec4 aInst;           // row, seed, width scale, spare
varying float vArc;
varying float vV;               // across the ribbon, -1..1
varying float vT;               // 0 root .. 1 tip
varying float vSeed;
varying float vDepth;
varying float vAlpha;
varying float vRuffle;
vec4 nodeAt(int i, int row) { return texelFetch(uNodes, ivec2(clamp(i, 0, int(uN) - 1), row), 0); }
void main() {
  int row = int(aInst.x + 0.5);
  float u = aU;
  int i1 = int(floor(u)); float f = u - float(i1);
  vec4 n0 = nodeAt(i1 - 1, row), n1 = nodeAt(i1, row), n2 = nodeAt(i1 + 1, row), n3 = nodeAt(i1 + 2, row);
  float f2 = f * f, f3 = f2 * f;
  vec4 p = 0.5 * ((2.0 * n1) + (-n0 + n2) * f + (2.0 * n0 - 5.0 * n1 + 4.0 * n2 - n3) * f2 + (-n0 + 3.0 * n1 - 3.0 * n2 + n3) * f3);
  vec3 tang = 0.5 * ((-n0.xyz + n2.xyz) + (2.0 * (2.0 * n0.xyz - 5.0 * n1.xyz + 4.0 * n2.xyz - n3.xyz)) * f + (3.0 * (-n0.xyz + 3.0 * n1.xyz - 3.0 * n2.xyz + n3.xyz)) * f2);
  tang = normalize(tang + vec3(1e-5));
  float t = u / (uN - 1.0);
  vec3 toCam = cameraPosition - p.xyz;
  float dist = length(toCam);
  vec3 side = normalize(cross(tang, toCam / dist));
  float taper = uKind > 0.5 && uKind < 1.5 ? (0.35 + 0.65 * sin(3.14159 * (0.2 + 0.7 * t))) * (1.0 - 0.55 * t) : (1.0 - 0.8 * t);
  float ruffle = 0.0;
  if (uKind > 0.5 && uKind < 1.5) ruffle = 0.4 * sin(p.w * 34.0 + aSide * 1.4 + uTime * 0.9 + aInst.y * 9.0) * smoothstep(0.0, 0.25, t) + 0.15 * sin(p.w * 71.0 - uTime * 1.3 + aInst.y * 5.0);
  float w = uWidth * aInst.z * taper * (1.0 + ruffle);
  float minW = 0.75 * dist / uPxScale;
  float wEff = max(w, minW);
  vAlpha = w / wEff;
  vec3 pos = p.xyz + side * aSide * wEff;
  vArc = p.w; vV = aSide; vT = t; vSeed = aInst.y; vRuffle = ruffle;
  vec4 vp = viewMatrix * vec4(pos, 1.0);
  vDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

export const THREAD_FRAG = /* glsl */`
${OUT}
${COMMON}
uniform vec3 uColor;
uniform float uKind, uBead, uGain, uExposure;
varying float vArc, vV, vT, vSeed, vDepth, vAlpha, vRuffle;
void main() {
  float across = exp(-vV * vV * 2.6);
  float bp = vArc / uBead;
  float cellId = floor(bp + vSeed * 31.0);
  float h = hash11(cellId * 1.37 + vSeed * 91.0);
  float bead = pow(0.5 + 0.5 * cos(6.28318 * (bp + vSeed * 7.0)), 10.0);
  float tw = pow(h, 3.0) * (0.45 + 0.55 * sin(uTime * (1.5 + 3.0 * h) + h * 50.0));
  vec3 base = mix(uColor, vec3(0.8, 0.95, 1.0), 0.35);
  float root = smoothstep(0.0, 0.07, vT), tip = 1.0 - smoothstep(0.75, 1.0, vT);
  vec3 col;
  float edge;
  if (uKind > 0.5 && uKind < 1.5) {
    // oral arm: a frilled ribbon, translucent, brighter along its ruffled edges
    edge = pow(abs(vV), 3.0);
    float veins = 0.5 + 0.5 * sin(vArc * 90.0 + vV * 4.0 + vSeed * 9.0);
    col = uColor * (0.10 + 0.22 * edge + 0.05 * veins) + base * (0.18 * edge * (0.7 + 0.5 * vRuffle));
    col *= smoothstep(1.0, 0.8, abs(vV));
    col += base * bead * 0.6 * tw * across;
    col *= root * (0.35 + 0.65 * tip);
  } else {
    col = base * (0.075 + 0.05 * uKind) * across + base * bead * (0.35 + 2.4 * tw) * across * (uKind > 1.5 ? 0.7 : 1.0);
    col *= root * tip;
  }
  col *= uGain * vAlpha * objTrans(vDepth) * uExposure;
  float w = clamp(dot(col, vec3(0.3, 0.5, 0.2)) * 3.0, 0.0, 1.0);
  gColor = vec4(col, min(0.06, w * 0.12));
  gCoc = vec4(cocOf(vDepth) * w, 0.0, 0.0, w);
}
`;

// ---------------------------------------------------------------------------------------------- comb jelly
export const COMB_VERT = /* glsl */`
uniform vec3 uCenter, uX, uY, uZ;
uniform float uSize, uSeed, uTime, uExt;
attribute vec2 aP;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying vec2 vUV;
varying float vDepth;
vec3 eggPos(float u, float phi) {
  float r = pow(max(sin(3.14159265 * u), 0.0), 0.72) * (1.0 - 0.2 * u) * 0.95;
  r *= 1.0 + 0.045 * sin(3.0 * phi + uTime * 0.7 + uSeed) * sin(3.14159 * u) + 0.03 * sin(uTime * 1.3 + uSeed * 2.0);
  float y = 1.15 * (0.5 - u);
  return vec3(r * cos(phi), y, r * sin(phi));
}
void main() {
  float u = aP.x, phi = aP.y * 6.28318530;
  vec3 P = eggPos(u, phi);
  float un = clamp(u, 0.02, 0.97);
  vec3 Pn = eggPos(un, phi), Pu = eggPos(un + 0.01, phi), Pp = eggPos(un, phi + 0.03);
  vec3 n = normalize(cross(Pu - Pn, Pp - Pn) + vec3(0.0, 1e-9, 0.0));
  if (dot(n, vec3(Pn.x, 0.0, Pn.z)) < 0.0) n = -n;
  vec3 local = P * uSize * 2.0;
  vec3 world = uCenter + uX * local.x + uY * local.y + uZ * local.z;
  vWorld = world; vNormal = uX * n.x + uY * n.y + uZ * n.z; vLocal = P; vUV = vec2(u, phi);
  vec4 vp = viewMatrix * vec4(world, 1.0);
  vDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

export const COMB_FRAG = /* glsl */`
${OUT}
${COMMON}
${COMB_GLSL}
uniform float uSeed, uExposure, uGain;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
varying vec2 vUV;
varying float vDepth;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNormal);
  float an = clamp(abs(dot(N, V)), 0.0, 1.0);
  float u = vUV.x, phi = vUV.y;
  float a8 = phi / 6.28318 * COMB_ROWS;
  float rowD = abs(fract(a8 + 0.5) - 0.5);
  float rowId = floor(a8 + 0.5);
  float rowOff = hash11(rowId * 3.7 + uSeed) * 0.12;
  float r = max(length(vLocal.xz), 0.05);
  float arc = rowD / COMB_ROWS * 6.28318 * r;
  float rowMask = exp(-pow(arc / 0.017, 2.0));
  float uu = (u - 0.1) / 0.78;
  float inRow = step(0.0, uu) * step(uu, 1.0);
  float fi = uu * COMB_PLATES, cell = floor(fi), fr = fract(fi);
  float bar = 0.55 + 0.45 * smoothstep(0.1, 0.3, fr) * (1.0 - smoothstep(0.55, 0.8, fr));
  // the beat is a travelling wave: phase is continuous along the row, so the glint is a band that sweeps along it
  float ph = combPhase(uTime, fi, rowOff);
  float glint = combGlint(ph);
  // diffraction: the colour depends on the beat phase, the plate's position and the angle you see it from
  float hue = ph * 0.6 + uu * 0.25 + an * 0.45 + dot(normalize(vec3(V.x, 0.0, V.z) + 1e-4), vec3(cos(vUV.y), 0.0, sin(vUV.y))) * 0.18;
  vec3 irid = mix(rainbow(hue), vec3(0.8, 0.92, 1.0), 0.28);
  float limb = 0.6 + 0.8 * (1.0 - an);
  float line = rowMask * inRow * bar;
  vec3 col = irid * glint * line * limb * 1.7;
  col += mix(irid, vec3(0.35, 0.65, 1.0), 0.65) * line * 0.12;   // plates at rest still catch a little light
  // nearly invisible body: a cool rim and a faint inner glow, and the apical organ
  float fres = pow(1.0 - an, 2.6);
  col += vec3(0.20, 0.42, 0.95) * fres * 0.05 + vec3(0.12, 0.45, 0.8) * pow(an, 2.0) * 0.014;
  col += vec3(0.6, 0.9, 1.0) * exp(-pow(u / 0.035, 2.0)) * 0.35;
  col *= uGain * objTrans(vDepth) * uExposure;
  float w = clamp(dot(col, vec3(0.3, 0.5, 0.2)) * 2.0, 0.0, 1.0);
  gColor = vec4(col, 0.0);
  gCoc = vec4(cocOf(vDepth) * w, 0.0, 0.0, w);
}
`;

// ---------------------------------------------------------------------------------------------- plankton, marine snow, ring markers
export const POINTS_VERT = /* glsl */`
uniform vec2 uSlice;            // keeps only points whose view depth lies in (x, y]
uniform float uPxScale;
uniform float uTime, uFocus, uCoc, uCocMax, uMaxSize, uPlanktonGain, uScale;
attribute float aE;
attribute vec2 aKind;
varying vec3 vColor;
varying float vFade;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 waterTrans(float d) { return exp(-vec3(0.13, 0.058, 0.040) * d); }
// Objects keep a little more of their own colour than the open water does, or every red or pink animal would turn blue.
vec3 objTrans(float d) { return exp(-vec3(0.075, 0.040, 0.032) * d); }
void main() {
  vec4 vp = viewMatrix * vec4(position, 1.0);
  float d = -vp.z;
  float kind = aKind.x, rnd = aKind.y;
  float coc = min(uCocMax, uCoc * abs(d - uFocus) / max(d, 0.1));
  float size = max(2.2 * uScale, 2.0 * coc + 1.2);
  float e = aE;
  vec3 col;
  float inten;
  if (kind < 0.5) {
    // dinoflagellate flash: blue-cyan, white-hot at the peak
    float peak = smoothstep(0.75, 1.3, e);
    col = mix(vec3(0.035, 0.28, 1.0), vec3(0.55, 0.9, 1.0), peak) * (0.6 + 0.4 * e);
    inten = e * e * uPlanktonGain;
    if (e < 0.004) inten = 0.0;
  } else if (kind < 1.5) {
    // marine snow: catches the filtered light from above, glints as it turns
    float tw = pow(abs(sin(uTime * (0.5 + rnd) + rnd * 60.0)), 6.0);
    float lit = smoothstep(-6.0, 5.0, position.y);
    col = vec3(0.35, 0.62, 0.85);
    inten = (0.012 + 0.06 * tw) * (0.5 + 0.8 * lit);
    size = max(1.7 * uScale, 2.0 * coc + 1.0);
  } else {
    float peak = smoothstep(0.6, 1.0, e);
    col = mix(vec3(0.06, 0.4, 1.0), vec3(0.7, 0.95, 1.0), peak);
    inten = e * 2.6 * uPlanktonGain * 0.35;
    size = max(size, 4.0 * uScale);
  }
  size = min(size, uMaxSize);
  float area = pow(max(size, 2.4 * uScale) / (2.4 * uScale), 1.6);
  vColor = col * inten / area * waterTrans(d);
  vFade = 1.0;
  bool inSlice = d > uSlice.x && d <= uSlice.y && inten > 0.0;
  gl_PointSize = size;
  gl_Position = inSlice ? projectionMatrix * vp : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const POINTS_FRAG = /* glsl */`
${OUT}
varying vec3 vColor;
varying float vFade;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float soft = smoothstep(1.0, 0.45, r);
  float core = exp(-r * r * 3.0);
  gColor = vec4(vColor * (0.55 * soft + 0.9 * core), 0.0);
  gCoc = vec4(0.0);
}
`;

// ---------------------------------------------------------------------------------------------- post
export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const DOWN_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(uSrc, vUv + uTexel * vec2(-2.0, -2.0)), b = texture2D(uSrc, vUv + uTexel * vec2(0.0, -2.0)), c = texture2D(uSrc, vUv + uTexel * vec2(2.0, -2.0));
  vec4 d = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 0.0)), e = texture2D(uSrc, vUv), f = texture2D(uSrc, vUv + uTexel * vec2(2.0, 0.0));
  vec4 g = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 2.0)), h = texture2D(uSrc, vUv + uTexel * vec2(0.0, 2.0)), i = texture2D(uSrc, vUv + uTexel * vec2(2.0, 2.0));
  vec4 j = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)), k = texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0));
  vec4 l = texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)), m = texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
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

// Depth of field: every pixel reads the image at the mip level that matches its (dilated) circle of confusion.
export const DOF_FRAG = /* glsl */`
uniform sampler2D uL0, uL1, uL2, uL3, uL4;
uniform sampler2D uC0, uC2, uC3;
uniform vec2 uTexel;
varying vec2 vUv;
vec4 blur4(sampler2D t, vec2 uv, vec2 texel) {
  return 0.25 * (texture2D(t, uv + texel * vec2(-0.5, -0.5)) + texture2D(t, uv + texel * vec2(0.5, -0.5)) + texture2D(t, uv + texel * vec2(-0.5, 0.5)) + texture2D(t, uv + texel * vec2(0.5, 0.5)));
}
vec4 level(float k, vec2 uv) {
  if (k < 0.5) return texture2D(uL0, uv);
  if (k < 1.5) return blur4(uL1, uv, uTexel * 2.0);
  if (k < 2.5) return blur4(uL2, uv, uTexel * 4.0);
  if (k < 3.5) return blur4(uL3, uv, uTexel * 8.0);
  return blur4(uL4, uv, uTexel * 16.0);
}
void main() {
  vec4 c0 = texture2D(uC0, vUv);
  float own = c0.a > 0.004 ? c0.r / c0.a : 0.0;
  vec4 c2 = blur4(uC2, vUv, uTexel * 4.0), c3 = blur4(uC3, vUv, uTexel * 8.0);
  float m2 = c2.a > 0.01 ? c2.r / c2.a : 0.0, m3 = c3.a > 0.02 ? c3.r / c3.a : 0.0;
  float coc = max(own, max(m2, m3 * 0.95));
  float lod = clamp(log2(max(coc, 1.0)) + 0.35, 0.0, 4.0);
  float fl = floor(lod), fr = lod - fl;
  vec4 a = level(fl, vUv);
  vec4 b = fr > 0.01 ? level(min(fl + 1.0, 4.0), vUv) : a;
  gl_FragColor = mix(a, b, fr);
}
`;

export const OUTPUT_FRAG = /* glsl */`
uniform sampler2D uBeauty;
uniform sampler2D uBloom;
uniform float uExposure, uBloomGain, uFrame, uTime, uAspect, uCA, uShaft;
uniform vec3 uHalo;
varying vec2 vUv;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(vec2(i, 3.7)), hash(vec2(i + 1.0, 3.7)), f); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// Deep water: near-black blue below, a little more light overhead, and a few faint shafts fading with depth.
vec3 water(vec2 uv) {
  float h = uv.y;
  vec3 col = mix(vec3(0.0004, 0.0016, 0.0050), vec3(0.0028, 0.0130, 0.0300), smoothstep(0.05, 1.0, h));
  col += vec3(0.0020, 0.014, 0.024) * pow(h, 4.0);
  vec2 src = vec2(0.38 + 0.04 * sin(uTime * 0.021), 1.55);
  vec2 d = vec2((uv.x - src.x) * uAspect, src.y - uv.y);
  float ang = atan(d.x, d.y);
  float t = uTime;
  float s = 0.0;
  s += smoothstep(0.35, 1.0, vn(ang * 7.0 + t * 0.021 + 1.0)) * 0.9;
  s += smoothstep(0.45, 1.0, vn(ang * 13.0 - t * 0.033 + 7.0)) * 0.55;
  s += smoothstep(0.5, 1.0, vn(ang * 25.0 + t * 0.047 + 3.0)) * 0.3;
  float fade = exp(-(1.0 - h) * 2.6) * smoothstep(0.0, 0.55, h);
  float side = exp(-pow(ang * 1.3, 2.0) * 0.8);
  col += vec3(0.007, 0.042, 0.060) * s * fade * side * uShaft;
  return col;
}
void main() {
  vec2 c = vUv - 0.5;
  vec2 shift = c * (0.5 + length(c)) * uCA;
  vec4 mid = texture2D(uBeauty, vUv);
  vec3 beauty = vec3(texture2D(uBeauty, vUv + shift).r, mid.g, texture2D(uBeauty, vUv - shift).b);
  float cover = clamp(mid.a, 0.0, 1.0);
  vec3 bloom = (texture2D(uBloom, vUv + shift * 0.5).rgb) * uHalo * uBloomGain;
  vec3 hdr = (beauty + bloom + water(vUv) * (1.0 - cover)) * uExposure;
  float vig = 1.0 - 0.62 * pow(length(c * vec2(0.9, 1.15)) * 1.25, 2.4);
  hdr *= clamp(vig, 0.0, 1.0);
  vec3 mapped = aces(hdr);
  mapped = mix(vec3(dot(mapped, vec3(0.2126, 0.7152, 0.0722))), mapped, 1.16);
  vec3 srgb = pow(max(mapped, 0.0), vec3(1.0 / 2.2));
  srgb += (hash(gl_FragCoord.xy + uFrame) + hash(gl_FragCoord.xy * 1.7 - uFrame) - 1.0) / 255.0 * 1.2;
  gl_FragColor = vec4(srgb, 1.0);
}
`;
