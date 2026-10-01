import { AURORA_GLSL, ALT_MIN, ALT_MAX, EARTH_R } from './aurora-model.js';
import { simShader, SIM } from './wave-sim.js';
import { NJ } from './rig.js';
export { simShader };

// Every shader in the scene. Linear HDR throughout; the output pass tone-maps once.

export const COMMON = /* glsl */`
#define PI 3.14159265
#define TAU 6.28318531
uniform sampler2D uNoise;
float hash11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz)*p3.zy); }
float ign(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// Smooth value noise from one fetch of a random texture.
float tn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f); return texture2D(uNoise, (i + f + 0.5)/256.0).r; }
float tfbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a*tn(p); p = p*2.02 + vec2(17.3, 9.1); a *= 0.5; } return v; }
float tfbm3(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ v += a*tn(p); p = p*2.02 + vec2(17.3, 9.1); a *= 0.5; } return v; }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// The fjord, in metres. Keep in step with behaviour.js (fjordCenter, fjordHalfWidth).
export const FJORD_GLSL = /* glsl */`
float fjC(float z){ return 26.0*sin(z*0.0016 + 0.4) - 6.0 + 520.0*pow(smoothstep(400.0, 5200.0, -z), 1.2); }
float fjW(float z){ return (240.0 + 30.0*sin(z*0.0049 + 1.1))*(1.0 + 0.9*smoothstep(900.0, 3200.0, -z)); }
#define HEAD_Z -6400.0
`;

export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Full-screen quad that also carries the world-space view ray of each corner.
export const RAY_VERT = /* glsl */`
uniform mat4 uInvVP;
uniform vec3 uCam;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vUv = uv;
  vec4 w = uInvVP*vec4(position.xy, 1.0, 1.0);
  vRay = w.xyz/w.w - uCam;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// --- aurora: plan-view field ------------------------------------------------------------------
// The curtains live in a map of the sky seen from above: where the ribbons are, how bright,
// how far the curl-noise warp has displaced them, and how hard the electrons are. It is
// redrawn every frame; the view-ray march then needs one fetch per altitude step.
export const MAP = { x0: -800, x1: 800, z0: -950, z1: -80 };

export const AURORA_MAP_FRAG = /* glsl */`
${COMMON}
uniform float uTime, uAct, uExpand;
varying vec2 vUv;
// A divergence-free flow built from seven travelling waves: the stream function is a sum of
// sines, the velocity its curl. Analytic, smooth, and cheap enough to nest three times.
vec2 flow(vec2 p, float t){
  vec2 v = vec2(0.0);
  const vec3 W[7] = vec3[7](
    vec3( 0.955, 0.296, 1.00), vec3( 0.454, 0.891, 1.37), vec3(-0.323, 0.946, 1.89), vec3(-0.904, 0.427, 2.55),
    vec3(-0.897,-0.442, 3.30), vec3(-0.017,-1.000, 4.20), vec3( 0.550,-0.835, 5.40));
  for (int i = 0; i < 7; i++){
    vec2 k = W[i].xy*W[i].z;
    float ph = dot(k, p) + t*(0.6 + 0.37*float(i)) + float(i)*2.17;
    v += cos(ph)*vec2(k.y, -k.x)/W[i].z/W[i].z;
  }
  return v;
}
float n1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f); return mix(hash11(i), hash11(i + 1.0), f); }
void main(){
  vec2 q = vec2(mix(${MAP.x0.toFixed(1)}, ${MAP.x1.toFixed(1)}, vUv.x), mix(${MAP.z0.toFixed(1)}, ${MAP.z1.toFixed(1)}, vUv.y));
  float t = uTime;
  float wob = 0.85 + 0.55*uAct;
  vec2 w1 = flow(q/360.0, t*0.018)*85.0*wob;
  vec2 w2 = flow((q + w1)/125.0, t*0.04 + 5.0)*28.0*wob;
  vec2 w3 = flow((q + w1 + w2)/46.0, t*0.085 + 11.0)*(5.0 + 4.0*uAct);
  vec2 p = q + w1 + w2 + w3;

  float rho = 0.0, hard = 0.0, ray = 0.0;
  for (int k = 0; k < 3; k++){
    float fk = float(k);
    float zc = -250.0 - 190.0*fk - uExpand*(75.0 + 35.0*fk)
      + (46.0 - 8.0*fk)*sin(p.x*(0.0062 + 0.0012*fk) + fk*1.9 + t*0.019)
      + (21.0 + 6.0*fk)*sin(p.x*(0.0151 - 0.0013*fk) + fk*0.7 - t*0.027)
      + 8.0*sin(p.x*0.034 + t*0.06 + fk);
    float d = p.y - zc;
    float wd = (3.4 + 3.0*n1(p.x/85.0 + fk*9.0 + t*0.03))*(1.0 + 0.35*uAct);
    float prof = exp(-(d*d)/(wd*wd)) + 0.12*exp(-(d*d)/(7.0*wd*wd));
    // brightness along the ribbon: slow patches, plus quick travelling rays when the sky is active
    float slow = 0.5 + 0.5*sin(p.x*(0.0105 + 0.002*fk) + t*0.045*(1.0 + 0.3*fk) + 2.2*sin(p.x*0.0037 - t*0.03 + fk));
    float fast = 0.5 + 0.5*sin(p.x*0.047 - t*(0.55 + 0.2*fk) + 3.0*sin(p.x*0.013 + t*0.11 + fk*2.0));
    float br = 0.34 + 0.66*pow(slow, 1.7) + uAct*0.75*pow(fast, 3.0);
    float ends = smoothstep(-790.0, -560.0, q.x)*(1.0 - smoothstep(560.0, 790.0, q.x));
    float strength = (fk == 0.0 ? 1.0 : fk == 1.0 ? 0.62 : 0.34);
    float e = 0.5 + 0.28*sin(p.x*0.0083 + t*0.031 + fk*1.3) + 0.22*uAct*sin(p.x*0.02 - t*0.2);
    float c = prof*br*ends*strength;
    rho += c; hard += c*clamp(e, 0.0, 1.0); ray += c*(0.4 + 0.6*fast);
  }
  hard = rho > 1e-4 ? hard/rho : 0.5;
  ray = rho > 1e-4 ? ray/rho : 0.0;
  gl_FragColor = vec4(rho, w1.x + w2.x + w3.x, hard, ray);
}
`;

// --- aurora: the view-ray march ------------------------------------------------------------------
// Each pixel marches between 80 and 300 km altitude on the curved Earth, one fetch of the plan
// map per step. Steps are jittered per pixel with interleaved-gradient (blue-noise-like) noise, and
// the map is read at a mip level matched to the step length, so a grazing ray averages the
// curtains it crosses instead of aliasing against them.
export const AURORA_FRAG = /* glsl */`
${COMMON}
${AURORA_GLSL}
uniform sampler2D uMap;
uniform float uTime, uGain, uAct, uFrame, uPixAng, uTexKm;
uniform int uSteps;
varying vec3 vRay;
varying vec2 vUv;
float n1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f); return mix(hash11(i), hash11(i + 1.0), f); }
void main(){
  vec3 rd = normalize(vRay);
  vec3 col = vec3(0.0);
  float y = rd.y;
  if (y > 0.006){
    float R = ${EARTH_R.toFixed(1)};
    float N = float(uSteps);
    float dH = (${ALT_MAX.toFixed(1)} - ${ALT_MIN.toFixed(1)})/N;
    float jit = fract(ign(gl_FragCoord.xy) + uFrame*0.61803398);
    float Ry = R*y;
    float T = 1.0;
    float rxz = length(rd.xz);
    for (int i = 0; i < 64; i++){
      if (i >= uSteps) break;
      float h = ${ALT_MIN.toFixed(1)} + (float(i) + jit)*dH;
      float sq = sqrt(Ry*Ry + 2.0*R*h + h*h);
      float t = sq - Ry;
      float dt = dH*(R + h)/sq;
      vec2 q = rd.xz*t;
      vec2 uv = (q - vec2(${MAP.x0.toFixed(1)}, ${MAP.z0.toFixed(1)}))/vec2(${(MAP.x1 - MAP.x0).toFixed(1)}, ${(MAP.z1 - MAP.z0).toFixed(1)});
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0){
        float lod = clamp(log2(max(dt*rxz*1.4/uTexKm, 1.0)), 0.0, 6.0);
        vec4 m = textureLod(uMap, uv, lod);
        if (m.r > 0.004){
          float xp = q.x + m.g;
          // Vertical rays: noise across the curtain, constant up the field line. Rays narrower than a
          // pixel's footprint on the curtain fade out instead of aliasing into speckle.
          float fp = t*uPixAng*1.6;
          float a1 = 1.0 - smoothstep(0.25, 0.8, fp/4.0), a2 = 1.0 - smoothstep(0.25, 0.8, fp/1.7), a3 = 1.0 - smoothstep(0.25, 0.8, fp/15.0);
          float s1 = n1(xp/4.0 + uTime*0.06), s2 = n1(xp/1.7 - uTime*0.17 + 7.0), s3 = n1(xp/15.0 + uTime*0.025 + 3.0);
          float rays = (1.0 + (0.20 + 1.35*pow(s1, 1.7) - 1.0)*a1*(0.5 + 0.5*m.a))*(1.0 + (0.5 + 0.9*s2 - 1.0)*a2*0.7)*(1.0 + (0.55 + 0.9*s3 - 1.0)*a3);
          // rays differ in how far down they reach
          float hh = h + 12.0*(s1 - 0.5)*a1 - 10.0*m.a;
          vec3 e = auroraColor(hh, m.b, dH*dH/12.0);
          col += T*e*(m.r*rays*dt*0.024);
          T *= exp(-m.r*dt*0.0006);
        }
      }
    }
    col *= smoothstep(0.006, 0.08, y);
  }
  gl_FragColor = vec4(col*uGain, 1.0);
}
`;

// --- stars and Milky Way ---------------------------------------------------------------------------
export const STARS_GLSL = /* glsl */`
uniform float uTime, uStarCell, uPixAng;
const vec3 POLE = vec3(0.0, 0.9336, -0.3584);
const vec3 CE1 = vec3(0.0, -0.3584, -0.9336);
const vec3 CE2 = vec3(-1.0, 0.0, 0.0);
const vec3 MW_POLE = vec3(0.6246, -0.3903, -0.6764);
// celestial coordinates of a direction: x = ra*cos(dec), y = dec; the sky turns slowly about the pole
vec3 celestial(vec3 rd, out vec2 ch){
  float dec = asin(clamp(dot(rd, POLE), -1.0, 1.0));
  float ra = atan(dot(rd, CE2), dot(rd, CE1)) + uTime*3.0e-4;
  ch = vec2(ra*cos(dec), dec);
  return vec3(cos(dec)*cos(ra), cos(dec)*sin(ra), sin(dec));
}
// One star per cell at most, hashed; magnitudes follow a power law: many faint, a few bright.
vec3 stars(vec3 rd, float spread){
  vec2 ch; celestial(rd, ch);
  vec2 p = ch/uStarCell, id = floor(p), f = fract(p);
  float ex = hash21(id + 3.7);
  if (ex > 0.62) return vec3(0.0);
  vec2 pos = 0.22 + 0.56*hash22(id + 13.1);
  float m = hash21(id + 7.7);
  float B = min(0.03*pow(1.0/(1.0 - 0.999*m), 0.85), 2.4);
  vec2 dv = (f - pos)*uStarCell;
  float sig = uPixAng*(0.62 + 0.3*log(1.0 + B*3.0))*spread;
  float I = B*exp(-dot(dv, dv)/(sig*sig));
  I += B*0.05*exp(-length(dv)/(uPixAng*3.0*spread))*step(0.6, B);          // halo of the bright ones
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float h = hash21(id + 91.3);
  float tw = 1.0 + (0.14 + 0.55*exp(-max(el, 0.0)*11.0))*sin(uTime*(2.5 + 8.0*h) + h*40.0);
  float ext = exp(-0.18/max(sin(el), 0.03));
  vec3 tint = mix(vec3(0.62, 0.76, 1.0), vec3(1.0, 0.80, 0.58), smoothstep(0.1, 0.95, hash21(id + 55.5)));
  tint = mix(vec3(1.0), tint, 0.65);
  return tint*I*tw*ext;
}
vec3 milkyWay(vec3 rd){
  vec2 ch; vec3 c = celestial(rd, ch);
  float lat = dot(c, MW_POLE);
  float band = exp(-pow(lat/0.20, 2.0));
  if (band < 0.01) return vec3(0.0);
  vec3 u1 = normalize(cross(MW_POLE, vec3(0.0, 0.0, 1.0))), u2 = cross(MW_POLE, u1);
  float lon = atan(dot(c, u2), dot(c, u1));
  vec2 g = vec2(lon*4.5, lat*10.0);
  float cloud = tfbm(g + vec2(3.0, 1.0));
  float fine = tfbm3(g*3.3 + 7.0);
  float lane = smoothstep(0.52, 0.85, tfbm(vec2(lon*6.0, lat*26.0) + 21.0))*exp(-pow(lat/0.075, 2.0));
  float core = 0.6 + 0.8*exp(-pow((lon - 0.4)/0.9, 2.0));
  float I = band*(0.2 + 1.2*cloud)*(0.6 + 0.8*fine)*core*(1.0 - 0.8*lane);
  vec3 tint = mix(vec3(0.44, 0.54, 0.95), vec3(1.0, 0.80, 0.58), exp(-pow((lon - 0.4)/0.7, 2.0))*exp(-pow(lat/0.12, 2.0)));
  return tint*I*0.0095;
}
vec3 nightSky(vec3 rd, float starSpread){
  float el = asin(clamp(rd.y, -1.0, 1.0));
  vec3 col = vec3(0.00055, 0.00100, 0.00200)*(1.0 - 0.35*smoothstep(0.0, 0.8, el));
  col += vec3(0.0017, 0.0032, 0.0018)*exp(-max(el, 0.0)*8.5) + vec3(0.0016, 0.0020, 0.0036)*0.45*exp(-max(el, 0.0)*2.2);   // airglow, faint at the horizon
  col += milkyWay(rd);
  col += stars(rd, starSpread);
  return col;
}
`;

// --- sky, land and haze -------------------------------------------------------------------------------
export const SKY_FRAG = /* glsl */`
${COMMON}
${FJORD_GLSL}
${STARS_GLSL}
uniform sampler2D uAurora;
uniform vec2 uRes;
uniform vec3 uCam, uAmb;
uniform int uBisect;
varying vec3 vRay;
varying vec2 vUv;

// wall surface x = c(z) + s*(W(z) + g(y, z)): leans back and is carved by noise
float wallG(float y, float z, float s){
  return 0.5*y + 36.0*tfbm3(vec2(y*0.011 + s*3.0, z*0.0075)) + 14.0*tn(vec2(y*0.045, z*0.03 + s*5.0)) - 25.0;
}
float crest(float z, float s){
  float n = tfbm(vec2(z*0.0012 + s*7.3, s*3.1));
  float r = 1.0 - abs(2.0*tn(vec2(z*0.0017 + s*3.0, 1.7)) - 1.0);
  float far = smoothstep(150.0, 2600.0, -z);
  return 90.0 + 70.0*n + far*(150.0 + 1150.0*n*n*n + 300.0*r*r);
}
float crestHead(float x){
  float n = tfbm(vec2(x*0.0016 + 4.0, 9.0));
  float r = 1.0 - abs(2.0*tn(vec2(x*0.0021, 4.7)) - 1.0);
  return 520.0 + 1100.0*smoothstep(60.0, 1100.0, abs(x - fjC(HEAD_Z))) + 520.0*n + 260.0*r*r;
}
vec3 skyLight(vec3 n){
  vec3 Lc = normalize(vec3(0.1, 0.65, -0.75));
  float upl = pow(max(n.y, 0.0), 1.5);
  return uAmb*(0.07 + 0.75*upl) + uAmb*0.30*vec3(0.8, 1.0, 0.9)*max(dot(n, Lc), 0.0)*3.2;
}
vec3 rockShade(vec3 p, vec3 n, float t, vec2 w){
  float ne = tfbm3(w*0.05);
  float ne2 = mix(0.5, tn(w*0.4), 1.0/(1.0 + t/200.0));
  float pch = tfbm(w*0.007 + 3.0);
  float gul = tn(vec2(w.x*0.022, w.y*0.0045)) * 0.6 + 0.4*tn(vec2(w.x*0.07, w.y*0.012));   // vertical gullies
  // snow settles on ledges and in gullies, and covers the high ground
  float snow = smoothstep(0.66, 0.80, pch + 0.0013*p.y + 0.18*n.y + 0.5*(gul - 0.5) + 0.2*(ne - 0.5));
  vec3 rock = vec3(0.022, 0.024, 0.030)*(0.55 + 0.9*ne)*(0.8 + 0.4*ne2);
  vec3 snowc = vec3(0.50, 0.62, 0.76)*(0.7 + 0.45*ne2);
  vec3 alb = mix(rock, snowc, snow);
  vec3 L = skyLight(n);
  return alb*L*(1.0 + 0.5*snow)*(0.55 + 0.9*gul);
}
vec3 hazeColor(){ return uAmb*0.16 + vec3(0.0012, 0.0022, 0.0042); }

// distant ranges: silhouettes in angle, as ridged noise in the lateral position
float rangeTop(float x, float k){
  float n = tfbm(vec2(x*0.00042 + k*11.0, k*5.0));
  float r = 1.0 - abs(2.0*tn(vec2(x*0.0011 + k*3.0, k + 0.5)) - 1.0);
  return 520.0 + 1750.0*n*n + 520.0*r*r;
}

void main(){
  vec3 ro = uCam, rd = normalize(vRay);
  vec2 suv = gl_FragCoord.xy/uRes;
  vec3 sky = nightSky(rd, 1.0);
  vec3 au = texture2D(uAurora, suv).rgb;
  vec3 glow = textureLod(uAurora, suv, 4.0).rgb*0.09 + textureLod(uAurora, suv, 6.0).rgb*0.16;
  vec3 col = sky + au + glow;

  float tPlane = rd.y < -1e-4 ? -ro.y/rd.y : 1e9;
  float tHead = rd.z < -1e-4 ? (HEAD_Z - ro.z)/rd.z : 1e9;
  float tLimit = min(tPlane, tHead);
  float s = rd.x >= 0.0 ? 1.0 : -1.0;
  float tHit = -1.0;
  vec3 hp = vec3(0.0), hn = vec3(0.0, 1.0, 0.0);
  bool wall = false;

  // side wall: bracket the crossing with growing steps, then bisect and finish with a secant step
  if (rd.x*s > 1e-5){
    float tmax = min(tLimit, 14000.0);
    float t0 = 0.0, t1 = 12.0, f0 = -fjW(ro.z), f1 = 0.0; bool found = false;
    for (int i = 0; i < 16; i++){
      vec3 p = ro + rd*t1;
      f1 = s*(p.x - fjC(p.z)) - fjW(p.z) - wallG(max(p.y, 0.0), p.z, s);
      if (f1 > 0.0){ found = true; break; }
      t0 = t1; f0 = f1; t1 = t1*1.55;
      if (t1 > tmax){
        t1 = tmax; vec3 q = ro + rd*t1;
        f1 = s*(q.x - fjC(q.z)) - fjW(q.z) - wallG(max(q.y, 0.0), q.z, s);
        if (f1 > 0.0) found = true;
        break;
      }
    }
    if (found){
      for (int i = 0; i < 12; i++){
        if (i >= uBisect) break;
        float tm = 0.5*(t0 + t1);
        vec3 p = ro + rd*tm;
        float f = s*(p.x - fjC(p.z)) - fjW(p.z) - wallG(max(p.y, 0.0), p.z, s);
        if (f > 0.0){ t1 = tm; f1 = f; } else { t0 = tm; f0 = f; }
      }
      float tt = t0 + (t1 - t0)*clamp(-f0/max(f1 - f0, 1e-4), 0.0, 1.0);
      vec3 p = ro + rd*tt;
      if (p.y < crest(p.z, s) && p.y > -2.0 && tt <= tLimit + 1.0){
        tHit = tt; hp = p; wall = true;
        float e = 3.0;
        float gy = (wallG(p.y + e, p.z, s) - wallG(max(p.y - e, 0.0), p.z, s))/(p.y + e - max(p.y - e, 0.0));
        float gz = (wallG(p.y, p.z + e, s) - wallG(p.y, p.z - e, s))/(2.0*e);
        float wz = (fjW(p.z + e) - fjW(p.z - e))/(2.0*e) + (fjC(p.z + e) - fjC(p.z - e))/(2.0*e)*s;
        hn = normalize(vec3(-s, s*gy, s*(gz + wz)*0.9 + 0.0));
        float dl = 1.0/(1.0 + tt/160.0);
        hn = normalize(hn + 0.9*dl*(vec3(tn(p.yz*0.08), tn(p.xz*0.08 + 5.0), tn(p.xy*0.08 + 9.0)) - 0.5));
      }
    }
  }
  // the head of the fjord
  if (tHead < 1e8 && (tHit < 0.0 || tHead < tHit) && tHead <= tPlane){
    vec3 p = ro + rd*tHead;
    if (p.y < crestHead(p.x) && p.y > -2.0){
      tHit = tHead; hp = p; wall = false;
      float nx = tfbm3(p.xy*0.01) - 0.5, ny = tfbm3(p.xy*0.013 + 8.0) - 0.5;
      float cr = crestHead(p.x);
      hn = normalize(vec3(nx*1.6, 0.2 + ny*0.8 + 1.4*smoothstep(0.45, 0.0, (cr - p.y)/cr), 1.0));
    }
  }
  bool water = false;
  if (tHit < 0.0 && rd.y < -1e-4){
    water = true;
    vec3 p = ro + rd*tPlane;
    if (p.z < HEAD_Z + 1.0) water = false;
  }
  float alpha = 1.0;
  if (water) alpha = 0.0;
  else if (tHit > 0.0){
    vec3 land = rockShade(hp, hn, tHit, wall ? vec2(hp.z*0.8 + hp.x*0.2, hp.y) : vec2(hp.x, hp.y));
    // aerial perspective and the low fog that sits on the water along the shore
    float haze = 1.0 - exp(-tHit/16000.0);
    float fogn = 0.6 + 0.8*tfbm3(hp.xz*0.0035 + vec2(uTime*0.004, 0.0));
    float lowFog = exp(-max(hp.y, 0.0)/20.0)*(1.0 - exp(-tHit/520.0))*fogn*0.5;
    land = mix(land, hazeColor(), clamp(haze, 0.0, 0.85));
    land = mix(land, uAmb*0.30 + vec3(0.0020, 0.0030, 0.0046), clamp(lowFog, 0.0, 0.85));
    col = land;
  } else if (rd.y > 0.0){
    // beyond the near walls: far ranges, each a silhouette at a distance
    float rxz = length(rd.xz);
    float tanEl = rd.y/max(rxz, 1e-3);
    float az = atan(rd.x, -rd.z);
    float ca = max(cos(az), 0.2);
    for (int k = 0; k < 3; k++){
      float D = 9000.0 + 8500.0*float(k)*(1.0 + 0.35*float(k));
      float range = D/ca;
      float H = rangeTop(D*tan(az), float(k));
      float h = ro.y + tanEl*range;
      if (h < H){
        float ne = tfbm3(vec2(D*tan(az)*0.004, h*0.004) + float(k)*5.0);
        float snow = smoothstep(480.0 + 120.0*ne, 1000.0, h);
        float edge = smoothstep(0.0, 0.22, (H - h)/H);
        vec3 alb = mix(vec3(0.030, 0.033, 0.040), vec3(0.62, 0.70, 0.80), snow*(0.5 + 0.7*ne));
        vec3 land = alb*uAmb*(1.6 + 1.2*(1.0 - edge) + 1.4*ne);
        float haze = 1.0 - exp(-range/(9000.0 + 6000.0*float(k)));
        land = mix(land, hazeColor()*(1.0 + 0.3*float(k)), clamp(haze*1.15, 0.0, 0.95));
        col = land;
        break;
      }
    }
  }
  gl_FragColor = vec4(col, alpha);
}
`;

// A small soft blur over the half-resolution aurora: the march's residual noise is blue (interleaved
// gradient jitter), so a 5x5 tent removes it and leaves the soft sheets.
export const BLUR_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(uSrc, vUv).rgb*0.25;
  c += (texture2D(uSrc, vUv + uTexel*vec2(1.5, 0.0)).rgb + texture2D(uSrc, vUv - uTexel*vec2(1.5, 0.0)).rgb
      + texture2D(uSrc, vUv + uTexel*vec2(0.0, 1.5)).rgb + texture2D(uSrc, vUv - uTexel*vec2(0.0, 1.5)).rgb)*0.125;
  c += (texture2D(uSrc, vUv + uTexel*vec2(1.5, 1.5)).rgb + texture2D(uSrc, vUv + uTexel*vec2(-1.5, 1.5)).rgb
      + texture2D(uSrc, vUv + uTexel*vec2(1.5, -1.5)).rgb + texture2D(uSrc, vUv - uTexel*vec2(1.5, 1.5)).rgb)*0.0625;
  gl_FragColor = vec4(c, 1.0);
}
`;

// --- bloom and the final grade -----------------------------------------------------------------------
export const DOWN_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uFirst;
varying vec2 vUv;
vec3 fetch(vec2 o){ return texture2D(uSrc, vUv + uTexel*o).rgb; }
void main(){
  vec3 a = fetch(vec2(-2.0, -2.0)), b = fetch(vec2(0.0, -2.0)), c = fetch(vec2(2.0, -2.0));
  vec3 d = fetch(vec2(-2.0, 0.0)), e = fetch(vec2(0.0, 0.0)), f = fetch(vec2(2.0, 0.0));
  vec3 g = fetch(vec2(-2.0, 2.0)), h = fetch(vec2(0.0, 2.0)), i = fetch(vec2(2.0, 2.0));
  vec3 j = fetch(vec2(-1.0, -1.0)), k = fetch(vec2(1.0, -1.0)), l = fetch(vec2(-1.0, 1.0)), m = fetch(vec2(1.0, 1.0));
  vec3 col = e*0.125 + (a + c + g + i)*0.03125 + (b + d + f + h)*0.0625 + (j + k + l + m)*0.125;
  // the first level keeps only what is bright enough to glow, and tames fireflies
  if (uFirst > 0.5) { float L = max(max(col.r, col.g), col.b); col *= clamp((L - 0.12)/max(L, 1e-4), 0.0, 1.0); col = min(col, vec3(24.0)); }
  gl_FragColor = vec4(col, 1.0);
}
`;
export const UP_FRAG = /* glsl */`
uniform sampler2D uSrc, uBase;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 fetch(vec2 o){ return texture2D(uSrc, vUv + uTexel*o).rgb; }
void main(){
  vec3 s = fetch(vec2(-1.0, -1.0)) + fetch(vec2(1.0, -1.0)) + fetch(vec2(-1.0, 1.0)) + fetch(vec2(1.0, 1.0))
    + 2.0*(fetch(vec2(0.0, -1.0)) + fetch(vec2(0.0, 1.0)) + fetch(vec2(-1.0, 0.0)) + fetch(vec2(1.0, 0.0))) + 4.0*fetch(vec2(0.0));
  gl_FragColor = vec4(texture2D(uBase, vUv).rgb + s/16.0*uWeight, 1.0);
}
`;
export const OUTPUT_FRAG = /* glsl */`
uniform sampler2D uBeauty, uBloom;
uniform vec2 uRes;
uniform float uExposure, uBloomGain, uFrame, uCA, uVignette;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p){ vec3 q = fract(vec3(p.xyx)*0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
void main(){
  vec2 c = vUv - 0.5;
  float r2 = dot(c*vec2(uRes.x/uRes.y, 1.0), c*vec2(uRes.x/uRes.y, 1.0));
  // chromatic aberration grows toward the corners
  vec2 off = c*(uCA*r2);
  vec3 beauty = vec3(texture2D(uBeauty, vUv + off).r, texture2D(uBeauty, vUv).g, texture2D(uBeauty, vUv - off).b);
  vec3 bloom = texture2D(uBloom, vUv).rgb;
  // a little lens glow: the wide bloom also lifts the deep shadows, like light inside the lens
  vec3 hdr = (beauty + bloom*uBloomGain)*uExposure;
  vec3 a = aces(hdr);
  float L = max(luma(hdr), 1e-5);
  vec3 b = clamp(hdr*(luma(aces(vec3(L)))/L), 0.0, 1.0);          // hue-preserving branch keeps the greens saturated
  vec3 mapped = mix(a, b, 0.45);
  float vig = 1.0 - uVignette*smoothstep(0.15, 0.75, r2*1.6);
  mapped *= vig;
  vec3 srgb = pow(max(mapped, 0.0), vec3(1.0/2.2));
  srgb += (hash(gl_FragCoord.xy + uFrame) + hash(gl_FragCoord.xy*1.7 - uFrame) - 1.0)/255.0;
  gl_FragColor = vec4(srgb, 1.0);
}
`.replace('uniform vec2 uRes;', 'uniform vec2 uRes;\nfloat luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }');

// --- the water -----------------------------------------------------------------------------------------
// Fresnel (Schlick) reflection of the sky render, looked up through the surface normal: the
// height-field simulation plus a gentle swell plus fine ripples. A reflected direction is projected
// back into the sky image, so the mirrored aurora is the very pixels drawn above it, stretched a
// little vertically by the ripples.
export const WATER_FRAG = /* glsl */`
${COMMON}
${FJORD_GLSL}
${STARS_GLSL}
uniform sampler2D uSky, uSim;
uniform vec2 uRes;
uniform vec3 uCam, uAmb;
uniform mat4 uView, uProj;
uniform float uSimN, uFrame;
uniform int uTaps;
varying vec3 vRay;
varying vec2 vUv;
const vec2 SIM_MIN = vec2(${SIM.minX.toFixed(1)}, ${SIM.minZ.toFixed(1)});
const float SIM_SIZE = ${SIM.size.toFixed(1)};

// a long, low swell: three directional waves; returns the slope
vec2 swell(vec2 p, float t){
  vec2 s = vec2(0.0);
  s += vec2(0.20, -0.98)*0.018*0.165*cos(dot(p, vec2(0.20, -0.98))*0.165 - t*0.42);
  s += vec2(-0.60, -0.80)*0.012*0.30*cos(dot(p, vec2(-0.60, -0.80))*0.30 - t*0.56 + 1.3);
  s += vec2(0.80, -0.60)*0.007*0.52*cos(dot(p, vec2(0.80, -0.60))*0.52 - t*0.74 + 2.1);
  return s;
}
vec2 microRipples(vec2 p, float t){
  vec2 q = p*0.55 + vec2(t*0.11, -t*0.07);
  vec2 q2 = p*1.3 + vec2(-t*0.13, t*0.09) + 11.0;
  const float e = 0.12;
  vec2 g1 = vec2(tn(q + vec2(e, 0.0)) - tn(q - vec2(e, 0.0)), tn(q + vec2(0.0, e)) - tn(q - vec2(0.0, e)))/(2.0*e)*0.55;
  vec2 g2 = vec2(tn(q2 + vec2(e, 0.0)) - tn(q2 - vec2(e, 0.0)), tn(q2 + vec2(0.0, e)) - tn(q2 - vec2(0.0, e)))/(2.0*e)*1.3;
  return g1*0.55 + g2*0.45;
}
vec3 skyLookup(vec3 r, float spread){
  vec3 v = (uView*vec4(r, 0.0)).xyz;
  vec4 c = uProj*vec4(v, 0.0);
  vec2 uv = c.xy/max(c.w, 1e-3)*0.5 + 0.5;
  float over = smoothstep(0.985, 1.0, uv.y);   // reflected directions above the frame fade to the top row
  uv.y = min(uv.y, 0.998); uv.x = clamp(uv.x, 0.001, 0.999);
  vec3 sum = vec3(0.0); float wsum = 0.0;
  for (int i = -4; i <= 4; i++){
    if (i < -uTaps || i > uTaps) continue;
    float f = float(i)/float(max(uTaps, 1));
    float w = exp(-f*f*2.2);
    sum += w*texture2D(uSky, vec2(uv.x, clamp(uv.y + f*spread, 0.0, 0.998))).rgb; wsum += w;
  }
  return sum/wsum;
}
void main(){
  vec4 sk = texture2D(uSky, vUv);
  if (sk.a > 0.5){ gl_FragColor = vec4(sk.rgb, 1.0); return; }
  vec3 rd = normalize(vRay);
  float t = -uCam.y/rd.y;
  vec3 p = uCam + rd*t;
  vec2 xz = p.xz;
  float dist = t;

  // the simulated surface: gradient from neighbouring texels, faded toward the domain edge
  vec2 suv = (xz - SIM_MIN)/SIM_SIZE;
  float inside = smoothstep(0.0, 0.03, suv.x)*(1.0 - smoothstep(0.97, 1.0, suv.x))*smoothstep(0.0, 0.03, suv.y)*(1.0 - smoothstep(0.97, 1.0, suv.y));
  vec2 slopeSim = vec2(0.0); float foam = 0.0, velo = 0.0, hSim = 0.0;
  if (inside > 0.0){
    float e = 1.0/uSimN, dx = SIM_SIZE*e;
    vec4 c0 = texture2D(uSim, suv);
    float hx1 = texture2D(uSim, suv + vec2(e, 0.0)).r, hx0 = texture2D(uSim, suv - vec2(e, 0.0)).r;
    float hz1 = texture2D(uSim, suv + vec2(0.0, e)).r, hz0 = texture2D(uSim, suv - vec2(0.0, e)).r;
    slopeSim = vec2(hx1 - hx0, hz1 - hz0)/(2.0*dx)*inside;
    foam = c0.b*inside; velo = c0.g*inside; hSim = c0.r*inside;
  }
  float far = 1.0/(1.0 + dist/170.0);
  vec2 slope = slopeSim*3.0*(0.35 + 0.65*far) + swell(xz, uTime)*(0.5 + 0.5*far) + microRipples(xz, uTime)*0.007*exp(-dist/130.0);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 V = -rd;
  float cosT = clamp(dot(n, V), 0.0, 1.0);
  float F = 0.02 + 0.98*pow(1.0 - cosT, 5.0);
  vec3 r = reflect(rd, n);
  r.y = max(r.y, 0.004); r = normalize(r);
  // ripples smear the reflection vertically
  float spread = 0.0016 + 0.7*length(slope)*0.35;
  vec3 refl = skyLookup(r, spread);
  // glitter: stars reflected off the micro-ripples, stretched upward
  vec2 gj = vec2(tn(gl_FragCoord.xy*0.45 + vec2(uTime*0.9, 0.0)), tn(gl_FragCoord.xy*0.37 + vec2(3.0, uTime*1.3))) - 0.5;
  vec3 rg = normalize(r + vec3(gj.x*0.010, gj.y*0.020, gj.x*0.004)*(0.5 + 0.5*length(slope)*8.0));
  refl += stars(rg, 1.6)*0.9;

  vec3 body = vec3(0.00100, 0.00280, 0.00420) + uAmb*vec3(0.16, 0.42, 0.36)*0.20;
  // agitation and foam, lit by the aurora
  float fn = 0.55 + 0.9*tn(xz*1.7 + uTime*vec2(0.3, -0.2));
  float foamAmt = clamp(foam*fn + smoothstep(0.006, 0.03, abs(velo))*0.12, 0.0, 1.0);
  vec3 foamCol = (uAmb*6.5 + vec3(0.0035, 0.0048, 0.0055))*foamAmt;
  vec3 col = body*(1.0 - F) + refl*F*(1.0 - 0.8*foamAmt) + foamCol;
  // wave crests catch the glow of the sky: rings read on dark water
  float rip = clamp(length(slopeSim)*16.0, 0.0, 1.0);
  col += (uAmb*3.0 + vec3(0.0006, 0.0010, 0.0014))*rip*rip*(0.4 + 0.6*F);
  float crestL = pow(clamp(hSim*55.0, 0.0, 1.0), 1.5);
  col += (uAmb*2.2 + vec3(0.0005, 0.0009, 0.0012))*crestL*(0.4 + 0.6*F);

  // the low fog that lies on the water
  float fogn = 0.55 + 0.9*tfbm3(xz*0.006 + vec2(uTime*0.006, 0.0));
  float fog = (1.0 - exp(-dist/520.0))*fogn*0.30;
  col = mix(col, uAmb*0.30 + vec3(0.0020, 0.0030, 0.0046), clamp(fog, 0.0, 0.7));
  gl_FragColor = vec4(col, 0.0);
}
`;

// --- whales ----------------------------------------------------------------------------------------------------
// Vertex: every point is placed from the live spine (Catmull-Rom through the joints) plus the fin
// shapes, evaluated per vertex from parameters: nothing is a stored pose. Fragment: skin.
export const WHALE_VERT = /* glsl */`
#define NJ ${NJ}
#define PI 3.14159265
uniform vec3 uSP[NJ];
uniform vec3 uST[NJ];
uniform vec3 uSU[NJ];
uniform float uJD, uScale, uTime, uGape, uPleat, uMirror, uSeed;
uniform vec3 uLag[12];
uniform float uWet[NJ];
attribute vec3 aNrm;
attribute vec4 aMisc;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vRest;
varying vec3 vRestN;
varying vec4 vMisc;
varying float vWet;
varying float vPart;

void spineFrame(float s, out vec3 P, out vec3 T, out vec3 U){
  float f = s/uJD;
  float sc = clamp(f, 0.0, float(NJ) - 1.0001);
  int i = int(sc); float a = sc - float(i);
  int i0 = max(i - 1, 0), i2 = min(i + 1, NJ - 1), i3 = min(i + 2, NJ - 1);
  vec3 p0 = uSP[i0], p1 = uSP[i], p2 = uSP[i2], p3 = uSP[i3];
  float a2 = a*a, a3 = a2*a;
  P = 0.5*((2.0*p1) + (-p0 + p2)*a + (2.0*p0 - 5.0*p1 + 4.0*p2 - p3)*a2 + (-p0 + 3.0*p1 - 3.0*p2 + p3)*a3);
  T = normalize(mix(uST[i], uST[i2], a));
  U = mix(uSU[i], uSU[i2], a);
  U = normalize(U - T*dot(U, T));
  P -= T*((f - sc)*uJD);
}
float wetAt(float s){ float f = clamp(s/uJD, 0.0, float(NJ) - 1.0001); int i = int(f); return mix(uWet[i], uWet[min(i + 1, NJ - 1)], f - float(i)); }
vec3 lagFor(int fin, float u){
  float k = clamp(u, 0.0, 1.0)*3.0;
  vec3 l = mix(uLag[fin*4], uLag[fin*4 + 1], clamp(k, 0.0, 1.0));
  l = mix(l, uLag[fin*4 + 2], clamp(k - 1.0, 0.0, 1.0));
  return mix(l, uLag[fin*4 + 3], clamp(k - 2.0, 0.0, 1.0));
}

// ---- body ----
void bodyPoint(vec3 rest, vec3 nr, out vec3 pos, out vec3 N){
  float sR = rest.x, y = rest.y, z = rest.z;
  // gape: the lower jaw swings down about a hinge behind the mouth, and the throat pouch fills
  float yM = -0.2;
  float jaw = smoothstep(4.7, 3.0, sR)*smoothstep(yM + 0.30, yM - 0.25, y);
  float ang = uGape*0.8*jaw;
  vec2 rel = vec2(sR - 3.9, y + 0.2);
  float ca = cos(ang), sa = sin(ang);
  vec2 rr = vec2(rel.x*ca - rel.y*sa, rel.x*sa + rel.y*ca);
  sR = 3.9 + rr.x; y = -0.2 + rr.y;
  vec2 nn = vec2(nr.x*ca - nr.y*sa, nr.x*sa + nr.y*ca);
  nr = normalize(vec3(nn, nr.z));
  float pm = smoothstep(0.4, 2.6, rest.x)*(1.0 - smoothstep(5.2, 8.2, rest.x));
  float belly = smoothstep(-0.1, -0.7, nr.y);
  float swell = uGape*0.5 + uPleat*0.06;
  y *= 1.0 + 0.46*swell*pm*belly; z *= 1.0 + 0.55*swell*pm*belly;
  vec3 P, T, U; spineFrame(sR*uScale, P, T, U);
  vec3 S = cross(T, U);
  pos = P + U*(y*uScale) + S*(z*uScale);
  N = normalize(-T*nr.x + U*nr.y + S*nr.z);
}

// ---- flippers: parameters u (root to tip), v (leading to trailing edge), side (top / underside)
float flipChord(float u){ return 0.30*(1.0 - u) + 0.62*sin(PI*pow(u, 0.8))*(1.0 - 0.25*u) + 0.04; }
void flipperFrame(float sg, out vec3 dirA, out vec3 ch, out vec3 n0){
  dirA = normalize(vec3(-0.30, -0.70, 0.60*sg));
  ch = normalize(vec3(1.0, 0.0, 0.0) - dirA*dirA.x);
  n0 = cross(dirA, ch);
  if (n0.y < 0.0) n0 = -n0;
}
vec3 flipperOff(float u, float v, float side, float sg){
  vec3 dirA, ch, n0; flipperFrame(sg, dirA, ch, n0);
  float c = flipChord(u);
  float kb = 0.05*pow(abs(sin(u*PI*8.0)), 0.7)*smoothstep(0.05, 0.2, u)*(1.0 - smoothstep(0.85, 1.0, u));   // the knobbly leading edge
  float fwdPos = 0.28*c + kb - v*c;
  float th = side*0.11*(1.0 - 0.55*u)*pow(sin(PI*clamp(v, 0.0, 1.0)), 0.7);
  vec3 off = vec3(0.0, -0.55, sg*0.95) + dirA*(u*${(4.2).toFixed(2)}) + ch*fwdPos + n0*th;
  int fin = sg > 0.0 ? 2 : 1;
  vec3 lag = lagFor(fin, u);
  float w = pow(u, 1.4);
  off += lag*w*vec3(1.0, 1.0, 1.0);
  // slow, uneven sway of the whole flipper
  off += n0*(0.22*u*u*sin(0.9*uTime + 1.7*u + sg*2.0 + uSeed*6.0) + 0.1*u*sin(1.9*uTime + uSeed));
  return off*uScale;
}
void flipperPoint(float u, float v, float side, float sg, out vec3 pos, out vec3 N){
  float sr = 3.3*uScale;
  vec3 P, T, U; spineFrame(sr, P, T, U); vec3 S = cross(T, U);
  vec3 off = flipperOff(u, v, side, sg);
  pos = P + T*off.x + U*off.y + S*off.z;
  float e = 0.012;
  vec3 a = flipperOff(min(u + e, 1.0), v, 0.0, sg) - flipperOff(max(u - e, 0.0), v, 0.0, sg);
  vec3 b = flipperOff(u, min(v + e, 1.0), 0.0, sg) - flipperOff(u, max(v - e, 0.0), 0.0, sg);
  vec3 dirA, ch, n0; flipperFrame(sg, dirA, ch, n0);
  vec3 nl = cross(a, b);
  if (dot(nl, n0) < 0.0) nl = -nl;
  nl = normalize(nl + 1e-6*n0)*side;
  vec3 edge = normalize(b + 1e-6*ch)*sign(v - 0.5);
  nl = normalize(mix(nl, edge, smoothstep(0.80, 1.0, abs(2.0*v - 1.0))));
  N = normalize(T*nl.x + U*nl.y + S*nl.z);
}

// ---- fluke: u across the span (-1..1), v from the leading to the trailing edge
vec3 flukeOff(float u, float v, float side){
  float au = abs(u);
  float c = 1.30*(1.0 - 0.80*pow(au, 1.6)) + 0.03;
  float xl = -0.50 + 1.10*pow(au, 1.45) + 0.32*pow(au, 3.0);
  float notch = 0.34*exp(-pow(u/0.085, 2.0));
  float serr = 0.05*pow(abs(sin(au*PI*9.0)), 1.4)*smoothstep(0.14, 0.3, au)*(1.0 - smoothstep(0.86, 1.0, au))*smoothstep(0.65, 1.0, v);
  float x = xl + (c - notch)*v + serr;
  float th = side*0.075*(1.0 - 0.75*au)*(0.3 + 0.7*pow(sin(PI*clamp(v, 0.0, 1.0)), 0.6));
  vec3 off = vec3(-x, th + 0.10*au*au, u*${(1.95).toFixed(2)});
  vec3 lag = lagFor(0, au);
  off += vec3(lag.x*0.4, lag.y, lag.z*0.5)*pow(au, 1.25)*(0.55 + 0.45*v);
  return off*uScale;
}
void flukePoint(float u, float v, float side, out vec3 pos, out vec3 N){
  vec3 P, T, U; spineFrame(${(12.6).toFixed(2)}*uScale, P, T, U); vec3 S = cross(T, U);
  vec3 off = flukeOff(u, v, side);
  pos = P + T*off.x + U*off.y + S*off.z;
  float e = 0.012;
  vec3 a = flukeOff(min(u + e, 1.0), v, 0.0) - flukeOff(max(u - e, -1.0), v, 0.0);
  vec3 b = flukeOff(u, min(v + e, 1.0), 0.0) - flukeOff(u, max(v - e, 0.0), 0.0);
  vec3 nl = cross(a, b);
  if (nl.y < 0.0) nl = -nl;
  nl = normalize(nl + vec3(0.0, 1e-6, 0.0))*side;
  vec3 edge = normalize(b + vec3(1e-6, 0.0, 0.0))*sign(v - 0.5);
  nl = normalize(mix(nl, edge, smoothstep(0.80, 1.0, abs(2.0*v - 1.0))));
  N = normalize(T*nl.x + U*nl.y + S*nl.z);
}

void main(){
  float part = aMisc.x;
  vec3 pos, N;
  vWet = 0.0;
  if (part < 0.5){
    bodyPoint(position, aNrm, pos, N);
    vWet = wetAt(position.x*uScale);
  } else if (part < 1.5){
    flukePoint(position.x, position.y, position.z, pos, N);
    vWet = wetAt(${(12.6).toFixed(2)}*uScale);
  } else {
    float sg = part < 2.5 ? -1.0 : 1.0;
    flipperPoint(position.x, position.y, position.z, sg, pos, N);
    vWet = wetAt(3.3*uScale);
  }
  vRest = position; vRestN = aNrm; vMisc = aMisc; vPart = part;
  vWorld = pos; vN = N;
  if (uMirror > 0.5){
    vWorld.y = -vWorld.y; vN.y = -vN.y;
    // the mirror image trembles with the ripples
    vWorld.x += 0.05*sin(vWorld.z*0.9 + uTime*1.7 + vWorld.y*2.5);
  }
  gl_Position = projectionMatrix*viewMatrix*vec4(vWorld, 1.0);
}
`;

export const WHALE_FRAG = /* glsl */`
${COMMON}
uniform vec3 uCam, uAmb, uAurG, uAurM;
uniform float uTime, uMirror, uSeed, uSimN, uGape;
uniform sampler2D uSim;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vRest;
varying vec3 vRestN;
varying vec4 vMisc;
varying float vWet;
varying float vPart;
const vec2 SIM_MIN = vec2(${SIM.minX.toFixed(1)}, ${SIM.minZ.toFixed(1)});
const float SIM_SIZE = ${SIM.size.toFixed(1)};

vec3 envSky(vec3 R){
  float north = smoothstep(0.1, -0.5, R.z);
  float band = exp(-pow((R.y - 0.36)/0.30, 2.0));
  float low = exp(-pow((R.y - 0.14)/0.16, 2.0));
  return uAurG*north*(0.35 + 0.65*band)*0.5 + uAurM*north*low*0.35 + uAmb*0.5;
}
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vWorld);
  if (dot(N, V) < 0.0 && vPart < 0.5) N = N;     // closed body: back faces are hidden by depth
  float origY = uMirror > 0.5 ? -vWorld.y : vWorld.y;
  vec3 Wn = uMirror > 0.5 ? vec3(vN.x, -vN.y, vN.z) : vN;   // not used further
  vec2 suv = (vWorld.xz - SIM_MIN)/SIM_SIZE;
  float wh = 0.0;
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) wh = texture2D(uSim, suv).r*1.0;
  float d = wh - origY;                    // depth below the water surface (m)

  // ---- skin ----
  vec3 albedo = vec3(0.020, 0.024, 0.032);
  float white = 0.0, bump = 0.0, scar = 0.0, barn = 0.0, rough = 0.0;
  vec3 R3 = vRest;
  if (vPart < 0.5){
    float t = vRest.x/12.6;
    float jag = tfbm3(vec2(vRest.x*0.45 + uSeed*7.0, vRest.z*1.3)) - 0.5;
    float bellyM = smoothstep(-0.12, -0.55, vRestN.y + 0.55*jag)*smoothstep(0.03, 0.16, t)*(1.0 - smoothstep(0.46, 0.74, t + 0.28*jag));
    float flank = smoothstep(0.64, 0.8, tfbm3(vec2(vRest.x*0.28 + uSeed*3.0, vRest.y*0.8 + vRest.z*0.5)))*(1.0 - smoothstep(0.1, -0.3, vRestN.y))*smoothstep(0.35, 0.6, t);
    white = clamp(bellyM + 0.55*flank, 0.0, 1.0);
    // ventral pleats: long grooves from the chin toward the navel
    float groove = 0.5 + 0.5*cos(vRest.z*PI/0.14);
    float pl = smoothstep(-0.35, -0.8, vRestN.y)*smoothstep(0.02, 0.1, t)*(1.0 - smoothstep(0.38, 0.55, t));
    bump += pl*(groove - 0.5)*0.6;
    albedo *= 1.0 - 0.18*pl*(1.0 - groove);
    // tubercles on the head and a knobbly rostrum
    float head = 1.0 - smoothstep(0.04, 0.22, t);
    vec2 hp = vec2(vRest.x*2.6, vRest.z*2.6 + vRest.y*1.4);
    vec2 hi = floor(hp), hf = fract(hp);
    vec2 hc = 0.3 + 0.4*hash22(hi + uSeed*13.0);
    float hd = length(hf - hc);
    float hk = step(0.35, hash21(hi + 4.0))*(1.0 - smoothstep(0.1, 0.22, hd));
    bump += head*hk*0.9 * smoothstep(-0.2, 0.5, vRestN.y);
    // barnacle clusters: pale, on the head, the chin and now and then along the back
    vec2 bp = vec2(vRest.x*3.4, vRest.z*3.4 + vRest.y*2.0) + uSeed*5.0;
    vec2 bi = floor(bp), bf = fract(bp);
    float bm = smoothstep(0.62, 0.8, tfbm3(bp*0.33 + 5.0))*(0.4 + 0.8*head);
    float bd = length(bf - (0.25 + 0.5*hash22(bi)));
    barn = bm*(1.0 - smoothstep(0.1, 0.2, bd))*step(0.3, hash21(bi + 2.0));
    // scars: thin pale wandering lines
    float sr = 1.0 - abs(2.0*tfbm3(vec2(vRest.x*0.9 + uSeed*9.0, vRest.z*2.2 + vRest.y*1.7)) - 1.0);
    scar = smoothstep(0.955, 0.985, sr)*0.55;
    // mottling
    albedo *= 0.75 + 0.8*tfbm3(vRest.xz*1.7 + vRest.y);
    // the mouth line and the open mouth
    float mouth = smoothstep(0.1, 0.0, abs(vRest.y + 0.2 + 0.05*vRest.x))*(1.0 - smoothstep(2.5, 4.4, vRest.x))*smoothstep(0.1, 0.4, vRest.x);
    albedo *= 1.0 - 0.7*mouth;
    float open = uGape*smoothstep(0.35, -0.2, vRest.y + 0.2)*(1.0 - smoothstep(3.0, 4.6, vRest.x))*step(0.0, -vRestN.y + 0.55);
    albedo = mix(albedo, vec3(0.18, 0.05, 0.06), clamp(open*1.2, 0.0, 0.85));
  } else if (vPart < 1.5){
    float au = abs(vRest.x), v = vRest.y, side = vRest.z;
    float n = tfbm(vec2(vRest.x*2.1 + uSeed*5.0, v*3.0 + uSeed));
    float under = side < 0.0 ? 1.0 : 0.0;
    white = under*smoothstep(0.38, 0.62, n + 0.2*(1.0 - au*0.5) - 0.25*v);
    float tr = smoothstep(0.78, 1.0, v)*0.5;
    scar = smoothstep(0.95, 0.985, 1.0 - abs(2.0*tfbm3(vec2(vRest.x*3.0, v*6.0) + uSeed) - 1.0))*0.45;
    albedo *= 0.8 + 0.6*tfbm3(vec2(vRest.x*4.0, v*4.0));
    albedo += vec3(0.01)*tr;
    float edgeBump = pow(abs(sin(au*PI*9.0)), 1.4)*smoothstep(0.7, 1.0, v);
    bump += edgeBump*0.2;
  } else {
    float u = vRest.x, v = vRest.y, side = vRest.z;
    float under = side < 0.0 ? 1.0 : 0.0;
    float n = tfbm3(vec2(u*3.0 + uSeed*3.0, v*3.0 + uSeed));
    white = under*(0.78 + 0.22*smoothstep(0.3, 0.6, n)) + (1.0 - under)*0.06*smoothstep(0.6, 0.8, n);
    // knobbly leading edge: barnacles and bumps along it
    float lead = (1.0 - smoothstep(0.0, 0.22, v))*smoothstep(0.04, 0.2, u);
    vec2 bp = vec2(u*16.0, v*9.0);
    vec2 bi = floor(bp), bf = fract(bp);
    barn = lead*(1.0 - smoothstep(0.12, 0.28, length(bf - (0.25 + 0.5*hash22(bi + uSeed*7.0)))))*step(0.4, hash21(bi + 3.0))*0.9;
    bump += lead*0.5*pow(abs(sin(u*PI*8.0)), 0.7);
    albedo *= 0.8 + 0.5*tfbm3(vec2(u*6.0, v*5.0));
  }
  // bump from derivatives of a procedural height
  {
    vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
    float h = bump + barn*0.7;
    float dhx = dFdx(h), dhy = dFdy(h);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det)*(dhx*r1 + dhy*r2);
    N = normalize(abs(det)*N - grad*0.045);
  }
  vec3 skinWhite = vec3(0.30, 0.33, 0.38);
  albedo = mix(albedo, skinWhite, white);
  albedo = mix(albedo, vec3(0.50, 0.52, 0.5), clamp(scar*(1.0 - white*0.4), 0.0, 1.0));
  albedo = mix(albedo, vec3(0.38, 0.37, 0.33), barn);

  // ---- wet film ----
  float wet = max(vWet, step(0.0, d));
  float streak = tn(vec2(vWorld.x*3.0 + vWorld.z*2.3, vWorld.y*0.6 + uTime*0.8*vWet*0.0 + uTime*0.0)*vec2(1.0, 1.0) + vec2(0.0, -uTime*0.9*vWet));
  float film = vWet*smoothstep(0.38, 0.85, streak)*(1.0 - step(0.0, d))*(0.4 + 0.6*smoothstep(-0.2, 0.6, N.y));
  albedo *= 1.0 - 0.38*wet;

  // ---- light: the aurora is the only lamp ----
  vec3 Lg = normalize(vec3(0.10, 0.60, -0.80)), Lm = normalize(vec3(-0.45, 0.35, -0.82));
  float up = 0.5 + 0.5*N.y;
  vec3 irr = uAmb*(0.7 + 2.0*up) + uAurG*0.07*max(dot(N, Lg), 0.0) + uAurM*0.06*max(dot(N, Lm), 0.0);
  irr += uAmb*0.8*max(-N.y, 0.0);                 // the mirror below throws the sky back up
  vec3 col = albedo*irr;
  float NV = clamp(dot(N, V), 0.0, 1.0);
  // wet specular: a sharp sky reflection (Schlick) and the two aurora lamps as highlights
  vec3 Rv = reflect(-V, N);
  float Fs = 0.03 + 0.97*pow(1.0 - NV, 5.0);
  float gloss = 0.25 + 0.75*wet + film;
  col += envSky(Rv)*Fs*gloss*0.55;
  vec3 H1 = normalize(V + Lg), H2 = normalize(V + Lm);
  float sh = mix(60.0, 380.0, clamp(wet, 0.0, 1.0));
  col += uAurG*pow(max(dot(N, H1), 0.0), sh)*(0.05 + 0.5*gloss)*0.45;
  col += uAurM*pow(max(dot(N, H2), 0.0), sh*0.8)*(0.04 + 0.4*gloss)*0.35;
  // rim: green on one side, magenta on the other
  float rim = pow(1.0 - NV, 2.6)*(0.25 + 0.75*up);
  col += rim*mix(uAurG*0.9, uAurM*1.5, smoothstep(-0.7, 0.8, N.x + 0.2*sin(vRest.x*0.4)))*0.3;
  // the thin bright film draining off the skin
  col += film*(uAurG*0.12 + uAmb*0.8)*(0.3 + Fs);

  // ---- the waterline ----
  float dB = clamp(d, 0.0, 40.0);
  vec3 deep = vec3(0.0010, 0.0030, 0.0046) + uAmb*vec3(0.12, 0.30, 0.26)*0.2;
  vec3 trans = exp(-dB*vec3(0.34, 0.17, 0.12));
  col = col*trans*(1.0 - 0.6*(1.0 - exp(-dB*0.5))) + deep*(1.0 - exp(-dB*0.5))*0.6;
  float meniscus = exp(-pow(d/0.07, 2.0));
  col += meniscus*(uAurG*0.18 + uAmb*1.2);
  float alpha = d > 0.0 ? exp(-dB*0.19)*0.82 : 1.0;
  if (uMirror > 0.5){
    // the reflected whale: only what is above the water, faint and dim
    float refl = 0.62*smoothstep(-0.3, 0.25, origY - wh);
    alpha = refl;
    col *= 0.55;
  }
  gl_FragColor = vec4(col*alpha, alpha);
}
`;

// --- particles ------------------------------------------------------------------------------------------------------
export const PART_VERT = /* glsl */`
attribute vec4 aPosSize;
attribute vec4 aParam;
varying vec2 vC;
varying vec4 vP;
varying float vDepth;
void main(){
  vC = position.xy; vP = aParam;
  vec3 wp = aPosSize.xyz;
  vDepth = max(-wp.y, 0.0);
  float kind = aParam.y;
  vec3 world;
  if (false){
    gl_Position = vec4(0.0);
  } else {
    vec4 vp = viewMatrix*vec4(wp, 1.0);
    vp.xy += position.xy*aPosSize.w;
    gl_Position = projectionMatrix*vp;
  }
}
`;
export const PART_FRAG = /* glsl */`
${COMMON}
uniform vec3 uAmb, uAurG, uAurM;
uniform float uTime;
varying vec2 vC;
varying vec4 vP;
varying float vDepth;
void main(){
  float r = length(vC);
  if (r > 1.0) discard;
  float kind = vP.y, a = vP.x;
  vec3 col = vec3(0.0);
  float k = 0.0;
  if (kind < 0.5){        // mist: a soft, lumpy puff, lit from the aurora side (above and behind)
    vec2 q = vC*1.7 + vP.z*3.0 + vec2(uTime*0.07, -uTime*0.05);
    float n = tfbm3(q)*0.55 + 0.25*tn(q*3.1 + 5.0) + 0.2*tn(q*7.3 + 1.0);
    float d = r + (n - 0.5)*0.95;
    float body = pow(1.0 - smoothstep(0.05, 0.95, d), 1.4);
    float lit = 0.4 + 0.6*smoothstep(-0.9, 0.9, vC.y + 0.35 + (n - 0.5)*0.6);
    col = (uAmb*2.4 + uAurG*0.055 + uAurM*0.022 + vec3(0.004, 0.0055, 0.007))*lit;
    k = body*a*(0.65 + 0.7*n);
  } else if (kind < 1.5){ // bubble: a glinting rim and a bright speck
    float rim = smoothstep(0.5, 0.9, r)*(1.0 - smoothstep(0.9, 1.0, r));
    float spec = exp(-dot(vC - vec2(-0.35, 0.38), vC - vec2(-0.35, 0.38))*14.0);
    float att = exp(-vDepth*0.10);
    col = (uAmb*8.0 + uAurG*0.14 + vec3(0.003, 0.004, 0.005))*(0.4 + rim*1.6) + spec*(uAurG*0.5 + uAmb*8.0 + 0.01);
    k = (0.18 + rim*0.9)*a*att*0.5;
  } else if (kind < 2.5){ // droplet: a tiny bright point
    col = (uAmb*12.0 + uAurG*0.25 + vec3(0.008, 0.01, 0.012));
    k = pow(1.0 - r, 2.0)*a*0.9;
  } else {                // surface foam bubble, glowing
    float rim = smoothstep(0.45, 0.9, r)*(1.0 - smoothstep(0.9, 1.0, r));
    col = (uAmb*10.0 + uAurG*0.18 + vec3(0.004, 0.005, 0.006))*(0.5 + rim);
    k = (0.25 + 0.75*rim)*a*0.7*pow(1.0 - r, 0.5);
  }
  // premultiplied: mist covers what is behind it, glints (alpha 0) only add light
  float cover = kind < 0.5 ? clamp(k, 0.0, 1.0) : 0.0;
  gl_FragColor = vec4(col*k, cover);
}
`;
