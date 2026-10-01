// All GLSL for the plate. Three's ShaderMaterial compiles these as GLSL ES 3.00 (varying/texture2D/gl_FragColor are mapped).
// Plate coordinates Q: x in [0, 16/9), y in [0, 1), y up. The trail map covers exactly that rectangle and wraps.

export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------------------------------------
// Physarum agents (Jones 2010). One texel per agent: x, y (plate units), heading, lost-counter.
// ---------------------------------------------------------------------------------------------------------
export const AGENT_FRAG = /* glsl */`
precision highp float;
precision highp int;
uniform sampler2D uAgents;
uniform sampler2D uTrail;     // R slime trail, G chemoattractant, B memory
uniform vec2 uWorld;
uniform float uFrame;
uniform vec4 uSense;          // sensor angle, sensor distance, turn angle, step
uniform vec4 uWeights;        // food weight, light weight, lost threshold, lost max
uniform vec4 uCursor;         // x, y, radius, strength (0 = off)
uniform vec3 uMore;           // wobble, agents per row, food immunity
uniform vec2 uMore2;          // lost counter growth while on food, re-seed jitter
uniform float uForager;
varying vec2 vUv;

uint hashU(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(inout uint s) { s = hashU(s); return float(s >> 8) * (1.0 / 16777216.0); }
vec2 dirv(float a) { return vec2(cos(a), sin(a)); }
float lightAt(vec2 p) { vec2 d = p - uCursor.xy; return uCursor.w * exp(-dot(d, d) / (uCursor.z * uCursor.z)); }
float sense(vec2 p, float foodW) {
  vec4 t = texture2D(uTrail, p / uWorld);
  return t.r + foodW * t.g - uWeights.y * lightAt(p);
}
void main() {
  vec4 a = texture2D(uAgents, vUv);
  vec2 p = a.xy; float th = a.z; float lost = a.w;
  uint s = hashU(uint(gl_FragCoord.x) + uint(gl_FragCoord.y) * uint(uMore.y) + uint(uFrame) * 747796405u + 2891336453u);
  float SA = uSense.x, SO = uSense.y, RA = uSense.z, SS = uSense.w;
  // one agent in uForager is a forager: only foragers smell the food and linger on it
  uint id = uint(gl_FragCoord.x) + uint(gl_FragCoord.y) * uint(uMore.y);
  bool forager = uForager > 0.5 && (id % uint(uForager)) == 0u;
  float fw = forager ? uWeights.x : 0.0;
  float C = sense(p + dirv(th) * SO, fw), L = sense(p + dirv(th + SA) * SO, fw), R = sense(p + dirv(th - SA) * SO, fw);
  float r1 = rnd(s), r2 = rnd(s);
  if (C > L && C > R) { }
  else if (C < L && C < R) th += (r1 < 0.5 ? -RA : RA);
  else if (L < R) th -= RA;
  else if (R < L) th += RA;
  th += (r2 - 0.5) * uMore.x;
  p += dirv(th) * SS;
  p = mod(p, uWorld);
  vec4 here = texture2D(uTrail, p / uWorld);
  float lit = lightAt(p);
  if (forager && here.g > uMore.z) lost += uMore2.x; else if (here.r > uWeights.z) lost = max(lost - 3.0, 0.0); else lost += 1.0;
  lost += lit * 6.0;
  if (lost > uWeights.w) {
    // Lost agents are re-seeded next to a random agent that is itself on the colony and out of the light.
    vec2 ruv = vec2(rnd(s), rnd(s));
    vec4 b = texture2D(uAgents, ruv);
    if (b.w < uWeights.w * 0.3 && lightAt(b.xy) < 0.1 && texture2D(uTrail, b.xy / uWorld).g < uMore.z) {
      p = mod(b.xy + (vec2(rnd(s), rnd(s)) - 0.5) * 2.0 * uMore2.y, uWorld);
      th = rnd(s) * 6.2831853; lost = 0.0;
    }
  }
  gl_FragColor = vec4(p, mod(th, 6.2831853), lost);
}
`;

// Each agent is splatted as one bilinear point into the trail map (additive blending).
export const SPLAT_VERT = /* glsl */`
precision highp float;
uniform sampler2D uAgents;
uniform sampler2D uTrail;     // read for the food under the agent: this is the PREVIOUS map, not the one being drawn
uniform vec2 uWorld;
uniform vec3 uDeposit;        // deposit, food boost, reinforcement
uniform vec2 uReinforce;      // reinforcement scale (trail value at which it reaches 1)
varying float vDep;
void main() {
  vec4 a = texture2D(uAgents, position.xy);
  vec2 uv = a.xy / uWorld;
  vec4 here = texture2D(uTrail, uv);
  vDep = uDeposit.x * (1.0 + uDeposit.y * min(here.g, 1.0)) * (1.0 + uDeposit.z * min(uReinforce.y, here.r / uReinforce.x));
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vDep = min(vDep, 40.0);
  gl_PointSize = 2.0;
}
`;
export const SPLAT_FRAG = /* glsl */`
precision highp float;
varying float vDep;
void main() {
  vec2 t = 1.0 - abs(gl_PointCoord * 2.0 - 1.0);
  gl_FragColor = vec4(vDep * t.x * t.y, 0.0, 0.0, 0.0);
}
`;

// Diffuse + decay + chemoattractant from flakes + the photophobic light.
export const DIFFUSE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform vec2 uWorld;
uniform vec4 uDiffuse;        // blend toward blur, decay, extra decay in light, memory rate
uniform vec4 uCursor;         // x, y, radius, strength
uniform vec4 uFoods[14];      // x, y, amplitude, sigma (flakes, then unseen scents)
uniform int uFoodCount;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTrail, vUv);
  vec3 s = c.rgb * 4.0
    + (texture2D(uTrail, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(uTrail, vUv - vec2(uTexel.x, 0.0)).rgb
     + texture2D(uTrail, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(uTrail, vUv - vec2(0.0, uTexel.y)).rgb) * 2.0
    + texture2D(uTrail, vUv + uTexel).rgb + texture2D(uTrail, vUv - uTexel).rgb
    + texture2D(uTrail, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture2D(uTrail, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
  s *= (1.0 / 16.0);
  vec2 Q = vUv * uWorld;
  vec2 dl = Q - uCursor.xy;
  float lit = uCursor.w * exp(-dot(dl, dl) / (uCursor.z * uCursor.z));
  float r = min(mix(c.r, s.r, uDiffuse.x) * (uDiffuse.y - uDiffuse.z * min(lit, 1.0)), 6000.0);
  float b = mix(s.b, s.r, uDiffuse.w);
  float food = 0.0;
  for (int i = 0; i < 14; i++) {
    if (i >= uFoodCount) break;
    vec4 f = uFoods[i];
    vec2 d = Q - f.xy;
    float d2 = dot(d, d);
    food += f.z * (0.35 * exp(-d2 / (2.0 * f.w * f.w)) + 0.4 * exp(-d2 / (2.0 * 0.09 * f.w * f.w)) + 0.25 / (1.0 + d2 / (0.64 * f.w * f.w)));
  }
  // a numerical accident must never spread: one bad texel would blur across the whole plate
  if (isnan(r) || isinf(r)) r = 0.0;
  if (isnan(b) || isinf(b)) b = 0.0;
  gl_FragColor = vec4(r, food, b, 1.0);
}
`;

// The trail averaged to a coarse map: AO halo and glow in the scene pass, and the source of the CPU probe.
export const SOFT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uTrail;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 s = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += texture2D(uTrail, vUv + (vec2(float(i), float(j)) - 1.5) * 2.0 * uTexel);
  gl_FragColor = s * (1.0 / 16.0);
}
`;
export const PROBE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSoft;
uniform float uScale;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(uSoft, vUv);
  gl_FragColor = vec4(1.0 - exp(-s.r / uScale), clamp(s.g, 0.0, 1.0), 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------
// Shared GLSL: noise, light.
// ---------------------------------------------------------------------------------------------------------
const COMMON = /* glsl */`
#define TAU 6.2831853
const vec3 KEY = vec3(-0.50, 0.56, 0.66);       // normalised in main: the warm key light, up and to the left
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x + s * p.y, -s * p.x + c * p.y); }
`;

// ---------------------------------------------------------------------------------------------------------
// The plate: agar, flakes, and the plasmodium as a lit, translucent height field.
// ---------------------------------------------------------------------------------------------------------
export const SCENE_FRAG = COMMON + /* glsl */`
precision highp float;
uniform sampler2D uTrail;
uniform sampler2D uSoft;
uniform vec4 uView;           // centre xy, half extents xy, in plate units
uniform vec2 uWorld;
uniform vec2 uMapSize;
uniform float uTime;
uniform vec4 uCursor;         // x, y, presence, radius
uniform vec4 uLamp;           // x, y, intensity
uniform vec4 uFlakeA[12];     // x, y, radius, whole
uniform vec4 uFlakeB[12];     // angle, aspect, seed, attract
uniform int uFlakeCount;
uniform vec4 uTune;           // density scale, bump, grain, wave gain
uniform vec4 uTune2;          // flow amplitude, glow, shadow, quality (0 eco .. 2 detail)
varying vec2 vUv;

vec3 sat3(vec3 c, float s) { return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, s); }

float dens(vec2 uv) { return 1.0 - exp(-texture2D(uTrail, uv).r / uTune.x); }

// air bubbles and condensation beads in the agar: rim, dark lens and a window highlight
vec4 bubbles(vec2 Q, float sc, float seed, float density, vec2 L) {
  vec2 cell = floor(Q * sc);
  vec2 h = h22(cell + seed);
  if (h21(cell + seed + 7.7) > density) return vec4(0.0);
  vec2 c = (cell + 0.3 + 0.4 * h22(cell + seed + 3.1)) / sc;
  float r = (0.10 + 0.17 * h21(cell + seed + 1.3)) / sc;
  vec2 q = (Q - c) / r;
  float d = length(q);
  float rim = smoothstep(0.72, 1.0, d) * (1.0 - smoothstep(1.0, 1.12, d));
  float lens = (1.0 - smoothstep(0.9, 1.05, d)) * (0.25 + 0.4 * dot(normalize(q + 1e-4), -L));
  float hi = exp(-9.0 * dot(q - L * 0.55, q - L * 0.55));
  return vec4(rim * (0.5 + 0.8 * max(dot(normalize(q + 1e-4), L), 0.0)), lens, hi, rim);
}

void main() {
  vec2 Q = uView.xy + (vUv - 0.5) * 2.0 * uView.zw;
  vec3 Lk = normalize(KEY);
  vec2 L2 = normalize(Lk.xy);
  vec2 tuv = Q / uWorld;
  vec2 tx = 1.0 / uMapSize;
  float time = uTime;

  // ----- the lamp: a soft pool of light on the plate, drifting a little; the cursor adds its own warm pool
  vec2 dp = (Q - uLamp.xy) * vec2(1.0, 1.15);
  float pool = 0.32 + 0.68 * exp(-dot(dp, dp) / 0.62);
  pool *= uLamp.z;
  vec2 dc = Q - uCursor.xy;
  float cpool = uCursor.z * exp(-dot(dc, dc) / (uCursor.w * uCursor.w));
  float lightMul = pool + 2.4 * cpool;

  // ----- the agar
  float big = fbm(Q * 3.2 + 4.0);
  float fine = vn(Q * 150.0);
  vec2 bumpG = vec2(vn(Q * 44.0 + vec2(0.7, 0.0)) - vn(Q * 44.0 - vec2(0.7, 0.0)), vn(Q * 44.0 + vec2(0.0, 0.7)) - vn(Q * 44.0 - vec2(0.0, 0.7)));
  vec3 an = normalize(vec3(-(bumpG * 0.35 + (vec2(fbm(Q * 5.0 + vec2(0.3, 0.0)) - fbm(Q * 5.0 - vec2(0.3, 0.0)), fbm(Q * 5.0 + vec2(0.0, 0.3)) - fbm(Q * 5.0 - vec2(0.0, 0.3)))) * 0.9), 1.0));
  vec3 albedo = mix(vec3(0.020, 0.022, 0.009), vec3(0.027, 0.020, 0.008), smoothstep(0.35, 0.7, big)) * (0.85 + 0.3 * fine);
  float dif = max(dot(an, Lk), 0.0);
  vec3 plate = albedo * (0.22 + 1.05 * lightMul * dif / max(Lk.z, 0.3));
  // translucent medium: a faint amber-green glow from within, brightest under the lamp
  plate += vec3(0.006, 0.0075, 0.0018) * (0.4 + 1.6 * lightMul) * (0.6 + 0.8 * big);
  // wet sheen: the lamp reflected in the gel, broken up by the surface undulation
  vec3 Hh = normalize(Lk + vec3(0.0, 0.0, 1.0));
  float sheen = pow(max(dot(an, Hh), 0.0), 220.0) * 0.12 + pow(max(dot(an, Hh), 0.0), 24.0) * 0.008;
  plate += vec3(1.0, 0.86, 0.62) * sheen * lightMul * 0.55;
  // fine scratches in the gel catching the light
  float scr = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 p = rot(Q, 0.45 + float(k) * 1.9);
    float ridge = 1.0 - abs(2.0 * vn(vec2(p.x * 3.3 + float(k) * 9.0, p.y * 170.0)) - 1.0);
    scr += pow(ridge, 48.0) * smoothstep(0.70, 0.90, vn(p * 2.4 + float(k) * 13.0));
  }
  plate += vec3(1.0, 0.9, 0.7) * scr * 0.016 * lightMul;
  // bubbles and beads
  vec4 b1 = bubbles(Q, 9.0, 3.0, 0.14, L2), b2 = bubbles(Q, 21.0, 11.0, 0.12, L2), b3 = bubbles(Q, 47.0, 23.0, 0.08, L2);
  vec4 bb = b1 + b2 * 0.9 + b3 * 0.7;
  plate = plate * (1.0 - 0.55 * clamp(bb.y, 0.0, 1.0)) + vec3(0.95, 0.9, 0.7) * (bb.x * 0.03 + bb.z * 0.30) * (0.4 + lightMul);

  // ----- slime shadow on the agar and a faint yellow bleed of light around the network, from rings of taps at a few radii
  float shadow = 0.0, halo = 0.0;
  {
    int ring = uTune2.w > 0.5 ? 8 : 5;
    float fr = 1.0 / float(ring);
    for (int k = 0; k < 8; k++) {
      if (k >= ring) break;
      float ang = (float(k) + 0.5) * 6.2831853 * fr;
      vec2 dir = vec2(cos(ang), sin(ang)) / uWorld;
      shadow += dens(tuv + vec2(0.0075, -0.009) / uWorld + dir * 0.010);
      halo += 0.55 * dens(tuv + dir * 0.016) + 0.45 * dens(tuv + dir * 0.038);
    }
    shadow *= fr; halo *= fr;
    shadow = smoothstep(0.0, 0.7, shadow);
  }
  plate *= 1.0 - uTune2.z * shadow;
  plate += vec3(0.30, 0.20, 0.035) * halo * uTune2.y * (0.4 + 0.6 * lightMul);

  // ----- oat flakes, under the slime
  for (int i = 0; i < 12; i++) {
    if (i >= uFlakeCount) break;
    vec4 fa = uFlakeA[i], fb = uFlakeB[i];
    vec2 d = Q - fa.xy;
    float reach = fa.z * 2.4;
    if (dot(d, d) > reach * reach) continue;
    float w = fa.w;
    float size = fa.z * (0.48 + 0.52 * smoothstep(0.0, 1.0, w));
    vec2 q = rot(d, fb.x); q.y /= fb.y;
    float edgeN = fbm(q / size * 2.6 + fb.z * 40.0);
    float rr = length(q) / size + (edgeN - 0.5) * 0.45 - (1.0 - w) * 0.25 * (edgeN);
    float inside = 1.0 - smoothstep(0.86, 1.0, rr);
    // soft pillow of an oat flake: slightly domed, with a papery grain
    vec2 dir = q / size;
    vec3 fn = normalize(vec3(-dir * 0.5 + (vec2(vn(q * 260.0), vn(q * 260.0 + 9.0)) - 0.5) * 0.35, 1.0));
    float grain = 0.62 * vn(q * 120.0 + fb.z * 30.0) + 0.38 * vn(q * 310.0);
    float edge = smoothstep(0.45, 1.0, rr);
    vec3 cream = vec3(0.64, 0.52, 0.31) * (0.70 + 0.55 * grain);
    float fd = max(dot(fn, Lk), 0.0);
    vec3 fcol = cream * (0.15 + 0.95 * lightMul * fd / Lk.z) + vec3(0.30, 0.20, 0.06) * (0.2 + 0.8 * edge) * (0.4 + lightMul);
    fcol += vec3(1.0, 0.9, 0.7) * pow(max(dot(fn, Hh), 0.0), 40.0) * 0.5 * lightMul * (0.3 + 0.7 * w);
    float alpha = inside * smoothstep(0.0, 0.3, w) * (0.5 + 0.45 * w);
    // a dark soft contact shadow and a bright wet meniscus at the rim
    float shd = 1.0 - smoothstep(0.9, 1.5, length(rot(d + vec2(0.006, -0.008), fb.x) * vec2(1.0, 1.0 / fb.y)) / size);
    plate *= 1.0 - 0.45 * shd * smoothstep(0.0, 0.4, w) * (1.0 - inside * 0.5);
    plate += vec3(0.8, 0.7, 0.5) * 0.06 * smoothstep(0.9, 1.0, rr) * (1.0 - smoothstep(1.0, 1.25, rr)) * lightMul;
    plate = mix(plate, fcol, alpha);
  }

  // ----- the plasmodium: density -> height field
  float KS = uTune.x;
  float d0 = texture2D(uTrail, tuv).r;
  float dL = texture2D(uTrail, tuv - vec2(1.4 * tx.x, 0.0)).r, dR = texture2D(uTrail, tuv + vec2(1.4 * tx.x, 0.0)).r;
  float dD = texture2D(uTrail, tuv - vec2(0.0, 1.4 * tx.y)).r, dU = texture2D(uTrail, tuv + vec2(0.0, 1.4 * tx.y)).r;
  float dA = texture2D(uTrail, tuv + vec2(1.3, 1.3) * tx).r, dB = texture2D(uTrail, tuv + vec2(-1.3, 1.3) * tx).r;
  float dC = texture2D(uTrail, tuv + vec2(1.3, -1.3) * tx).r, dE = texture2D(uTrail, tuv + vec2(-1.3, -1.3) * tx).r;
  float sm = (d0 * 4.0 + (dL + dR + dD + dU) * 1.5 + (dA + dB + dC + dE) * 0.5) / 12.0;
  float a = 1.0 - exp(-sm / KS);
  vec2 g = vec2(1.0 - exp(-dR / KS) - (1.0 - exp(-dL / KS)), 1.0 - exp(-dU / KS) - (1.0 - exp(-dD / KS)));
  float gl = length(g);
  float cover0 = smoothstep(0.04, 0.30, a);

  vec3 col = plate;
  if (cover0 > 0.002) {
    // --- shuttle streaming: cytoplasm slides back and forth along the veins, each region on its own slow clock
    vec2 Qs = Q * 1.5;
    float nA = fbm(Qs * 0.7 + vec2(time * 0.013, -time * 0.009));
    float nB = fbm(Qs * 0.5 + vec2(-time * 0.011, time * 0.012) + 9.0);
    float th1 = 1.15 + 0.5 * sin(time * 0.021) + 1.6 * (fbm(Qs * 0.35 + 3.0) - 0.5);
    float th2 = -0.7 + 0.5 * sin(time * 0.017 + 1.0) + 1.6 * (fbm(Qs * 0.3 + 11.0) - 0.5);
    float phT = TAU * time / 7.6 + 7.0 * (nA - 0.5) - dot(vec2(cos(th1), sin(th1)), Q) * TAU / 0.42;
    float phK = TAU * time / 13.2 + 6.0 * (nB - 0.5) - dot(vec2(cos(th2), sin(th2)), Q) * TAU / 0.6;
    float ts = smoothstep(0.28, 0.78, a);                      // thick tubes pulse slowly, thin fronts quickly
    float ph = mix(phT, phK, ts);
    float wv = 0.5 + 0.5 * sin(ph);
    // tube width breathes with the wave
    float ab = a * (0.90 + 0.20 * wv * uTune.w);
    float cover = smoothstep(0.13, 0.55, ab);
    // flow direction: a slowly turning field projected onto the vein tangent (no sign ambiguity across a vein)
    vec2 nn = g / max(gl, 1e-5);
    float certainty = smoothstep(0.004, 0.03, gl);
    float tv = TAU * fbm(Q * 1.1 + time * 0.016);
    vec2 v0 = vec2(cos(tv), sin(tv));
    vec2 tang = v0 - nn * dot(nn, v0) * certainty;
    vec2 disp = tang * uTune2.x * sin(ph + 1.5708) * (1.25 - 0.55 * ts);
    vec2 qg = Q - disp;
    float g1 = vn(qg * 150.0), g2 = vn((qg - disp * 0.6) * 330.0 + 7.3);
    float grainv = 0.62 * g1 + 0.38 * g2 - 0.5;
    // --- colour: lemon fronts, amber trunks, pale hot cores on the wave crest
    vec3 thinC = vec3(1.0, 0.86, 0.26), midC = vec3(0.98, 0.64, 0.10), thickC = vec3(0.86, 0.38, 0.03);
    vec3 alb = mix(mix(thinC, midC, smoothstep(0.08, 0.5, ab)), thickC, smoothstep(0.5, 1.0, ab));
    alb = mix(alb, vec3(1.0, 0.95, 0.66), 0.38 * wv * (1.0 - ts));
    float trans = 1.25 - 0.38 * ab;                              // thin parts transmit more light
    vec3 emis = alb * (0.22 + 0.55 * uTune.w * wv) * trans * (1.0 + uTune.z * grainv * 2.0);
    // --- the surface: a soft tube cross-section lit by the key, wet specular, cool rim
    vec2 bumpN = g * uTune.y + (vec2(vn(qg * 160.0 + 3.0), vn(qg * 160.0 + 21.0)) - 0.5) * 0.10 * smoothstep(0.1, 0.5, ab);
    vec3 N = normalize(vec3(-bumpN, 1.0));
    float ndl = dot(N, Lk);
    float dif2 = clamp(ndl * 0.75 + 0.25, 0.0, 1.5);
    vec3 keyCol = vec3(1.0, 0.80, 0.52) * 1.15;
    float wet = 0.55 + 0.45 * vn(Q * 33.0 + time * 0.05);
    float spec = pow(max(dot(N, Hh), 0.0), 48.0) * 1.1 * wet + pow(max(dot(N, Hh), 0.0), 12.0) * 0.10;
    float rim = pow(1.0 - clamp(N.z, 0.0, 1.0), 2.0);
    vec3 rimCol = vec3(0.22, 0.55, 0.78);
    vec3 H2 = normalize(vec3(0.5, -0.45, 0.75) + vec3(0.0, 0.0, 1.0));
    float spec2 = pow(max(dot(N, H2), 0.0), 40.0) * 0.5;
    vec3 body = alb * (keyCol * dif2 * (0.35 + 0.65 * lightMul) + vec3(0.10, 0.12, 0.08)) * 0.40;
    vec3 slime = emis + body + vec3(1.0, 0.92, 0.74) * spec * (0.4 + lightMul) * 0.7 + rimCol * rim * (0.35 + 0.5 * wv) * 0.22 + vec3(0.5, 0.75, 0.9) * spec2 * 0.12;
    // soft translucent edges: the plate shows through thin parts
    col = mix(plate * (1.0 - 0.35 * cover), slime, cover * mix(0.92, 0.985, ts));
    // light scattered in the thin sheet around the veins
    col += alb * smoothstep(0.02, 0.30, a) * (1.0 - cover) * 0.55 * (0.45 + wv);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------
// Slugs: smooth union of soft spheres, evaluated per fragment inside a bounding quad.
// ---------------------------------------------------------------------------------------------------------
export const SLUG_VERT = /* glsl */`
precision highp float;
attribute vec4 aBox;     // centre xy, half extents xy (plate units)
attribute float aId;
uniform vec4 uView;
varying vec2 vQ;
varying float vId;
void main() {
  vQ = aBox.xy + position.xy * aBox.zw;
  vId = aId;
  gl_Position = vec4((vQ - uView.xy) / uView.zw, 0.0, 1.0);
}
`;
export const slugFrag = segments => COMMON + /* glsl */`
precision highp float;
#define SEG ${segments}
uniform sampler2D uSlugs;
uniform vec4 uCursor;
uniform vec4 uLamp;
uniform float uTime;
varying vec2 vQ;
varying float vId;
void main() {
  int row = int(vId + 0.5);
  float f = 0.0, along = 0.0, wave = 0.0, ws = 0.0, shadowF = 0.0, rbar = 0.0;
  vec2 grad = vec2(0.0);
  vec3 Lk = normalize(KEY);
  vec2 off = -Lk.xy * 0.011;                 // contact shadow falls away from the key light
  for (int i = 0; i < SEG; i++) {
    vec4 s = texelFetch(uSlugs, ivec2(i, row), 0);
    vec2 d = vQ - s.xy;
    float r2 = s.z * s.z;
    float e = exp(-0.9 * dot(d, d) / r2);
    f += e; grad += e * (-1.8 * d / r2);
    along += e * float(i) / float(SEG - 1); wave += e * s.w; ws += e; rbar += e * s.z;
    vec2 ds = vQ - s.xy - off;
    shadowF += exp(-0.55 * dot(ds, ds) / r2);
  }
  float T = 0.9;
  float cover = smoothstep(T * 0.78, T * 1.18, f);
  float shadow = smoothstep(0.35, 1.1, shadowF) * 0.38 * (1.0 - cover * 0.5);
  if (cover < 0.002 && shadow < 0.002) discard;
  along /= max(ws, 1e-4); wave /= max(ws, 1e-4); rbar /= max(ws, 1e-4);
  vec2 Nxy = -grad * rbar * 0.5 / (f + 0.25);
  vec3 N = normalize(vec3(Nxy, 1.0));
  vec2 dc = vQ - uCursor.xy;
  float cpool = uCursor.z * exp(-dot(dc, dc) / (uCursor.w * uCursor.w));
  vec2 dp = (vQ - uLamp.xy) * vec2(1.0, 1.15);
  float lightMul = (0.32 + 0.68 * exp(-dot(dp, dp) / 0.62)) * uLamp.z + 2.4 * cpool;
  float thick = clamp((f - T) / 1.1, 0.0, 1.0);
  float g1 = vn(vQ * 300.0 + vec2(uTime * 0.2, 0.0)) * 0.6 + vn(vQ * 640.0) * 0.4;
  // pale translucent gold: a clear sheath, a denser amber core, brighter and more opaque toward the head
  vec3 base = mix(vec3(0.92, 0.70, 0.30), vec3(0.98, 0.82, 0.46), (1.0 - along) * 0.6);
  float dif = clamp(dot(N, Lk) * 0.7 + 0.3, 0.0, 1.3);
  float rim = pow(1.0 - N.z, 2.0);
  vec3 Hh = normalize(Lk + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, Hh), 0.0), 60.0) * 1.2 + pow(max(dot(N, Hh), 0.0), 12.0) * 0.08;
  float core = N.z * N.z;                                    // the middle of the body is the thickest part
  vec3 inner = vec3(0.80, 0.45, 0.08) * (0.10 + 0.34 * core) * (1.0 + 0.25 * wave) * (0.8 + 0.4 * g1);
  vec3 col = base * (vec3(1.0, 0.85, 0.6) * dif * (0.18 + 0.50 * lightMul) + 0.06) + inner
    + vec3(1.0, 0.94, 0.78) * spec * (0.3 + lightMul) * 0.8 + vec3(0.95, 0.80, 0.55) * rim * 0.22 + vec3(0.30, 0.62, 0.85) * rim * 0.10;
  float alpha = cover * mix(0.82, 0.62, along * along);
  // premultiplied: body over a soft contact shadow
  float outA = alpha + shadow * (1.0 - alpha);
  gl_FragColor = vec4(col * alpha, outA);
}
`;

// The slime a slug leaves behind: a faint glossy ribbon.
export const TRAIL_VERT = /* glsl */`
precision highp float;
attribute float aFade;
attribute float aSide;
uniform vec4 uView;
varying float vFade;
varying float vSide;
varying vec2 vQ;
void main() {
  vFade = aFade; vSide = aSide; vQ = position.xy;
  gl_Position = vec4((position.xy - uView.xy) / uView.zw, 0.0, 1.0);
}
`;
export const TRAIL_FRAG = COMMON + /* glsl */`
precision highp float;
uniform vec4 uCursor;
uniform vec4 uLamp;
varying float vFade;
varying float vSide;
varying vec2 vQ;
void main() {
  float across = 1.0 - vSide * vSide;
  float a = vFade * across * across;
  vec2 dc = vQ - uCursor.xy;
  float lightMul = (0.35 + 0.65 * exp(-dot(vQ - uLamp.xy, vQ - uLamp.xy) / 0.7)) * uLamp.z + 2.4 * uCursor.z * exp(-dot(dc, dc) / (uCursor.w * uCursor.w));
  float sheen = 0.5 + 0.5 * vn(vQ * 90.0);
  vec3 c = vec3(1.0, 0.80, 0.45) * a * (0.003 + 0.02 * lightMul * sheen);
  gl_FragColor = vec4(c, 0.0);
}
`;

// Springtails: a tiny dark body, hop stretch, a flicked tail and a contact shadow that softens with height.
export const SPRING_VERT = /* glsl */`
precision highp float;
attribute vec4 aA;       // x, y, height, heading
attribute vec4 aB;       // stretch, pitch, flick, twitch
uniform vec4 uView;
varying vec2 vL;
varying vec4 vA;
varying vec4 vB;
void main() {
  vL = position.xy; vA = aA; vB = aB;
  vec2 Q = aA.xy + position.xy * 0.045;
  gl_Position = vec4((Q - uView.xy) / uView.zw, 0.0, 1.0);
}
`;
export const SPRING_FRAG = COMMON + /* glsl */`
precision highp float;
uniform vec4 uCursor;
uniform vec4 uLamp;
varying vec2 vL;
varying vec4 vA;
varying vec4 vB;
float sdEll(vec2 p, vec2 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-5); }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
void main() {
  vec3 Lk = normalize(KEY);
  vec2 d = vL * 0.045 / 1.45;                      // the springtail is drawn 1.45x its nominal size
  float z = vA.z;
  float lift = 1.0 + z * 5.0;                     // nearer the lens while airborne
  vec2 p = rot(d, vA.w);
  p.x /= vB.x; p.y *= (1.0 + (vB.x - 1.0) * 0.6);
  p /= lift;
  // body: head, thorax and abdomen as a smooth union; the furcula is a thin spur flicked from the rear
  float head = length(p - vec2(0.0075, 0.0)) - 0.0034;
  float thorax = sdEll(p - vec2(0.0005, 0.0), vec2(0.0058, 0.0040));
  float abdo = sdEll(p - vec2(-0.0062, 0.0), vec2(0.0062, 0.0042));
  float body = smin(smin(head, thorax, 0.004), abdo, 0.004);
  float flick = vB.z;
  vec2 tp = p - vec2(-0.010, 0.0);
  float ang = -2.6 * flick + 0.25;
  float fur = abs(dot(rot(tp, ang), vec2(0.0, 1.0))) - 0.0006;
  float furc = max(fur, max(-tp.x - 0.0095 * (0.5 + flick), tp.x - 0.002));
  float anti = 0.00055;
  float bodyA = 1.0 - smoothstep(-anti, anti, body);
  float furA = (1.0 - smoothstep(-0.0003, 0.0004, furc)) * 0.7;
  // antennae twitching at rest
  float tw = sin(vB.w * 3.0) * 0.4;
  vec2 ap = p - vec2(0.0105, 0.0);
  float ant = min(abs(dot(rot(ap, 0.7 + tw), vec2(0.0, 1.0))), abs(dot(rot(ap, -0.7 - tw), vec2(0.0, 1.0)))) - 0.00028;
  float antA = (1.0 - smoothstep(-0.0002, 0.0003, max(ant, max(-ap.x, ap.x - 0.0075)))) * 0.55;
  float a = max(bodyA, max(furA, antA));
  // shading: slate-purple body with a wet highlight
  vec2 n2 = normalize(p + 1e-5);
  float hi = exp(-160000.0 * dot(p - vec2(0.0022, 0.0018), p - vec2(0.0022, 0.0018)));
  vec3 col = vec3(0.050, 0.042, 0.036) * (0.6 + 0.5 * clamp(0.5 + 0.5 * dot(n2, vec2(-0.5, 0.6)), 0.0, 1.0)) + vec3(0.9, 0.85, 0.75) * hi * 0.40;
  // contact shadow: offset away from the key, sharper on the plate and wider and fainter in the air
  vec2 sp = rot(d + vec2(0.0035, -0.0042) * (1.0 + z * 18.0), vA.w);
  float sh = sdEll(sp, vec2(0.0125, 0.0058) * (1.0 + z * 6.0));
  float soft = 0.0025 + z * 0.05;
  float shA = (1.0 - smoothstep(-soft, soft, sh)) * 0.5 / (1.0 + z * 14.0);
  float outA = a + shA * (1.0 - a);
  gl_FragColor = vec4(col * a, outA);
}
`;

// Drifting specks: condensation and spores floating between the lens and the plate, out of focus.
export const SPECK_VERT = /* glsl */`
precision highp float;
attribute vec4 aSeed;
uniform vec4 uView;
uniform float uTime;
uniform float uAspect;
varying vec2 vL;
varying vec3 vP;       // size, blur, fade
void main() {
  float sz = aSeed.z * aSeed.z;
  vec2 vel = (vec2(fract(aSeed.w * 7.31), fract(aSeed.w * 13.7)) - 0.5) * 0.012 * (0.4 + sz * 3.0);
  vec2 p01 = fract(aSeed.xy + vel * uTime + 0.012 * vec2(sin(uTime * (0.13 + aSeed.w * 0.2) + aSeed.x * 40.0), cos(uTime * (0.11 + aSeed.z * 0.2) + aSeed.y * 40.0)));
  float edge = smoothstep(0.0, 0.06, p01.x) * smoothstep(1.0, 0.94, p01.x) * smoothstep(0.0, 0.06, p01.y) * smoothstep(1.0, 0.94, p01.y);
  float size = mix(0.0022, 0.016, sz);
  float blur = mix(0.25, 0.85, fract(aSeed.w * 3.7) * (0.3 + sz));
  vL = position.xy;
  vP = vec3(size, blur, edge);
  vec2 Q = uView.xy + (p01 * 2.0 - 1.0) * uView.zw + position.xy * size * (1.0 + blur * 0.6);
  gl_Position = vec4((Q - uView.xy) / uView.zw, 0.0, 1.0);
}
`;
export const SPECK_FRAG = /* glsl */`
precision highp float;
varying vec2 vL;
varying vec3 vP;
void main() {
  float r = length(vL);
  if (r > 1.0) discard;
  float edge = 1.0 - smoothstep(1.0 - vP.y, 1.0, r);
  float ring = smoothstep(0.45, 0.95, r) * edge;
  float hi = exp(-7.0 * dot(vL - vec2(-0.32, 0.34), vL - vec2(-0.32, 0.34)));
  float k = vP.z * (0.06 + 0.8 * smoothstep(0.003, 0.016, vP.x));
  vec3 c = vec3(0.85, 0.90, 0.75) * (0.015 * edge + 0.10 * ring + 0.45 * hi * (1.0 - vP.y * 0.5)) * k;
  gl_FragColor = vec4(c, 0.0);
}
`;

// ---------------------------------------------------------------------------------------------------------
// Post: depth of field (variable-radius gather), bloom pyramid, and the final composite.
// ---------------------------------------------------------------------------------------------------------
export const DOF_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec4 uDof;        // focus ring radius, max circle of confusion (px), aspect, taps
uniform float uFrame;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 c = (vUv - 0.5) * vec2(uDof.z, 1.0);
  float r = length(c * vec2(1.0, 1.12));
  float coc = uDof.y * (0.04 + 0.96 * smoothstep(0.13, 0.62, abs(r - uDof.x)));
  coc += uDof.y * 0.45 * smoothstep(0.6, 1.0, r);
  coc = min(coc, uDof.y);
  vec3 sum = texture2D(uSrc, vUv).rgb;
  float wsum = 1.0;
  if (coc > 0.7) {
    float rot0 = ign(gl_FragCoord.xy + uFrame * 5.3) * 6.2831853;
    int taps = int(uDof.w);
    for (int i = 0; i < 28; i++) {
      if (i >= taps) break;
      float fi = (float(i) + 0.5) / uDof.w;
      float ang = fi * 17.3 + rot0;            // golden-ish spiral
      float rad = sqrt(fi) * coc;
      vec2 o = vec2(cos(ang), sin(ang)) * rad * uTexel;
      vec3 s = texture2D(uSrc, vUv + o).rgb;
      float w = 1.0 + dot(s, vec3(0.33)) * 0.6;    // bright things bloom a little into bokeh
      sum += s * w; wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

export const DOWN_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uKnee;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(uSrc, vUv + uTexel * o).rgb; }
void main() {
  vec3 a = tap(vec2(-2.0, -2.0)), b = tap(vec2(0.0, -2.0)), c = tap(vec2(2.0, -2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, 2.0)), h = tap(vec2(0.0, 2.0)), i = tap(vec2(2.0, 2.0));
  vec3 j = tap(vec2(-1.0, -1.0)), k = tap(vec2(1.0, -1.0)), l = tap(vec2(-1.0, 1.0)), m = tap(vec2(1.0, 1.0));
  vec3 s = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  // the first level only keeps what is bright enough to glow
  float lum = dot(s, vec3(0.3333));
  s *= mix(1.0, smoothstep(0.0, 1.0, lum / max(uKnee, 1e-4)), step(0.0001, uKnee));
  gl_FragColor = vec4(s, 1.0);
}
`;
export const UP_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(uSrc, vUv + uTexel * o).rgb; }
void main() {
  vec3 s = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))
    + 2.0 * (tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0))) + 4.0 * tap(vec2(0.0));
  gl_FragColor = vec4(texture2D(uBase, vUv).rgb + s / 16.0 * uWeight, 1.0);
}
`;

export const OUTPUT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uBeauty;
uniform sampler2D uBloom;
uniform vec4 uOut;        // exposure, bloom gain, chromatic fringe, vignette
uniform vec3 uTint;       // bloom tint
uniform float uAspect;
uniform float uFrame;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c);
  // lateral chromatic aberration: red and blue fringe apart toward the edges of the frame
  vec2 off = (vUv - 0.5) * uOut.z * (0.15 + r * r * 2.2);
  vec3 beauty = vec3(texture2D(uBeauty, vUv + off).r, texture2D(uBeauty, vUv).g, texture2D(uBeauty, vUv - off).b);
  vec3 bloom = texture2D(uBloom, vUv).rgb * uTint * uOut.y;
  vec3 hdr = (beauty + bloom) * uOut.x;
  // vignette: the lens and lamp fall off toward the corners
  float vig = 1.0 - uOut.w * smoothstep(0.30, 1.05, r * 1.08);
  hdr *= vig * vig * 0.5 + 0.5 * vig;
  vec3 mapped = aces(hdr);
  vec3 srgb = pow(max(mapped, 0.0), vec3(1.0 / 2.2));
  srgb += (hash(gl_FragCoord.xy + uFrame) + hash(gl_FragCoord.xy * 1.7 - uFrame) - 1.0) / 255.0;
  gl_FragColor = vec4(srgb, 1.0);
}
`;
