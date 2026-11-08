// Light Map — 3D night aerial of the survey. Light is drawn as light (additive warm glow), never a colour ramp.
import * as THREE from 'three';

const WARM = new THREE.Color('#ffe2aa');
const GREY = new THREE.Color(0.11, 0.115, 0.125);
const WARN = new THREE.Color('#c00000');   // brand warning red (CSS: var(--warn); logo triangle)
const GUIDE_LUX = 5;
const TZ = 'America/Chicago';
const API = 'https://tamu-lux-survey.netlify.app';   // MongoDB API (same default as js/control.js); everything falls back to static data
const API_MS = 4000;
const EYE = 1.6;          // walk-through eye height (m)
const WK_FOV = 68;        // walk-through vertical field of view
const SV_BASE = 'data/streetview/';
// pre-survey test runs (W1, 5:20-5:48 pm, same spot repeated) - hidden, same filter as js/street.js
const TEST_RUNS = new Set(['W1_2026-11-07_172047', 'W1_2026-11-07_172920', 'W1_2026-11-07_174431']);

// GET/POST the MongoDB API; resolves to the JSON body when {ok:true}, otherwise null (never throws, 4 s timeout)
async function api(path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), API_MS);
  try {
    const r = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// local metres (x east, y north) -> world (x, up, -north)
const W = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

let L; // LUX
const S = {}; // view state

/* ------------------------------------------------------------------ shaders */
const SPLAT_VS = `
attribute vec3 iPos; attribute float iSize; attribute vec3 iColor;
uniform float uPx; uniform float uMinPx; uniform float uFade;
varying vec2 vQ; varying vec3 vC;
void main(){
  vec4 c = viewMatrix * vec4(iPos, 1.0);
  float mpp = -c.z * uPx;
  float r = max(iSize, uMinPx * mpp);
  vQ = position.xz;
  vC = iColor * pow(iSize / r, uFade);
  gl_Position = projectionMatrix * viewMatrix * vec4(iPos + vec3(position.x * r, 0.0, position.z * r), 1.0);
}`;
const SPLAT_FS = `
uniform int uMode; uniform float uGain; uniform float uK; uniform float uOpacity;
varying vec2 vQ; varying vec3 vC;
void main(){
  float d = length(vQ); if (d > 1.0) discard;
  float a;
  if (uMode == 0) { a = (exp(-uK * d * d) - exp(-uK)) / (1.0 - exp(-uK)); }
  else if (uMode == 1) { float ring = smoothstep(0.74, 0.8, d) * (1.0 - smoothstep(0.92, 0.98, d));
    float ang = atan(vQ.y, vQ.x); a = ring * step(0.0, sin(ang * 7.0)); }
  else if (uMode == 2) { a = 1.0 - smoothstep(0.45, 1.0, d); }
  else { a = smoothstep(0.78, 0.86, d) * (1.0 - smoothstep(0.93, 0.99, d)); }
  gl_FragColor = vec4(vC * uGain, a * uOpacity);
}`;

const RIB_VS = `
attribute vec3 aA; attribute vec3 aB; attribute float aSide; attribute float aEnd; attribute vec3 aCol; attribute float aDist;
uniform float uPx; uniform float uMinPx; uniform float uWidth; uniform float uFade;
varying float vS; varying vec3 vC; varying float vD; varying float vAl; varying float vLen; varying float vHw;
void main(){
  vec2 d = aB.xz - aA.xz; float l = length(d); vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
  vec3 P = mix(aA, aB, aEnd);
  vec3 perp = vec3(-dir.y, 0.0, dir.x);
  float mpp = -(viewMatrix * vec4(P, 1.0)).z * uPx;
  float hw = max(uWidth, uMinPx * mpp);
  float ext = aEnd > 0.5 ? hw : -hw;           // extend past the ends; fragment blends neighbours to sum to 1
  vAl = (aEnd > 0.5 ? l : 0.0) + ext; vLen = l; vHw = hw;
  vS = aSide; vD = aDist + vAl; vC = aCol * pow(uWidth / hw, uFade);
  gl_Position = projectionMatrix * viewMatrix * vec4(P + perp * aSide * hw + vec3(dir.x, 0.0, dir.y) * ext, 1.0);
}`;
const RIB_FS = `
uniform float uK; uniform float uGain; uniform float uOpacity; uniform float uDash; uniform int uFlat;
varying float vS; varying vec3 vC; varying float vD; varying float vAl; varying float vLen; varying float vHw;
void main(){
  float s = abs(vS);
  float a = uFlat == 2 ? 1.0 - smoothstep(0.86, 1.0, s) : uFlat == 1 ? 1.0 - smoothstep(0.6, 1.0, s) : (exp(-uK * s * s) - exp(-uK)) / (1.0 - exp(-uK));
  a *= smoothstep(-vHw, vHw, vAl) - smoothstep(-vHw, vHw, vAl - vLen);
  if (uDash > 0.0 && fract(vD / uDash) > 0.55) discard;
  gl_FragColor = vec4(vC * uGain, a * uOpacity);
}`;

const PT_VS = `
attribute float aSize; attribute vec3 aCol; attribute float aAlpha;
uniform float uPx; uniform float uWorld; uniform float uMinPx; uniform float uMaxPx; uniform float uDpr;
varying vec3 vC; varying float vA;
void main(){
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float mpp = -mv.z * uPx;
  float px = clamp(aSize * uWorld / mpp, aSize * uMinPx, aSize * uMaxPx);
  gl_PointSize = px * uDpr;
  vC = aCol; vA = aAlpha;
  gl_Position = projectionMatrix * mv;
}`;
const PT_FS = `
uniform int uMode; uniform float uOpacity;
varying vec3 vC; varying float vA;
float sdTri(vec2 p){ const float k = 1.7320508; p.x = abs(p.x) - 1.0; p.y = p.y + 1.0 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0, 0.0); return -length(p) * sign(p.y); }
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0; float d = length(q);
  if (uMode == 0) {               // lamp bulb: hot core + soft glow
    if (d > 1.0) discard;
    float core = exp(-d * d * 60.0); float glow = exp(-d * d * 7.0) * 0.45;
    vec3 c = mix(vC, vec3(1.0), core * 0.85);
    gl_FragColor = vec4(c, (core + glow) * vA * uOpacity);
  } else if (uMode == 1) {        // warning triangle
    vec2 p = vec2(q.x, -q.y + 0.18) * 1.18;
    float sd = sdTri(p);
    float a = 1.0 - smoothstep(-0.06, 0.04, sd);
    if (a <= 0.0) discard;
    float rim = smoothstep(-0.24, -0.16, sd);          // logo style: 40 % fill + solid stroke
    gl_FragColor = vec4(vC, a * mix(0.4, 1.0, rim) * vA * uOpacity);
  } else {                        // soft dot
    if (d > 1.0) discard;
    gl_FragColor = vec4(vC, (1.0 - smoothstep(0.45, 1.0, d)) * vA * uOpacity);
  }
}`;

function uni(extra) {
  return { uPx: S.uPx, uDpr: S.uDpr, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])) };
}

function splatLayer(items, { mode = 0, k = 4, gain = 1, opacity = 1, minPx = 0, fade = 0, blending = THREE.AdditiveBlending, order = 2 }) {
  const n = items.length;
  const base = new THREE.InstancedBufferGeometry();
  base.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
  base.setIndex([0, 2, 1, 0, 3, 2]);
  const pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3);
  items.forEach((it, i) => {
    pos[i * 3] = it.x; pos[i * 3 + 1] = it.h ?? 0.1; pos[i * 3 + 2] = -it.y;
    size[i] = it.r; col[i * 3] = it.c.r; col[i * 3 + 1] = it.c.g; col[i * 3 + 2] = it.c.b;
  });
  base.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  base.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 1));
  base.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3));
  base.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPLAT_VS, fragmentShader: SPLAT_FS, transparent: true, depthWrite: false, blending, side: THREE.DoubleSide,
    uniforms: uni({ uMode: mode, uK: k, uGain: gain, uOpacity: opacity, uMinPx: minPx, uFade: fade }),
  });
  const m = new THREE.Mesh(base, mat); m.frustumCulled = false; m.renderOrder = order;
  return m;
}

// segs: [{a:[x,y], b:[x,y], c:Color, d0}] -> ribbon mesh
function ribbonLayer(segs, { width = 2, k = 4, gain = 1, opacity = 1, minPx = 0, fade = 0, flat = 0, dash = 0, h = 0.15, order = 3, blending = THREE.AdditiveBlending }) {
  const n = segs.length;
  const A = new Float32Array(n * 12), B = new Float32Array(n * 12), side = new Float32Array(n * 4), end = new Float32Array(n * 4),
    col = new Float32Array(n * 12), dist = new Float32Array(n * 4), idx = new Uint32Array(n * 6);
  segs.forEach((s, i) => {
    for (let v = 0; v < 4; v++) {
      const j = i * 4 + v;
      A.set([s.a[0], h, -s.a[1]], j * 3); B.set([s.b[0], h, -s.b[1]], j * 3);
      side[j] = v === 0 || v === 3 ? -1 : 1; end[j] = v < 2 ? 0 : 1;
      col.set([s.c.r, s.c.g, s.c.b], j * 3);
      dist[j] = s.d0 || 0;
    }
    idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(A, 3));
  g.setAttribute('aA', new THREE.BufferAttribute(A, 3)); g.setAttribute('aB', new THREE.BufferAttribute(B, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3)); g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: RIB_VS, fragmentShader: RIB_FS, transparent: true, depthWrite: false, blending, side: THREE.DoubleSide,
    uniforms: uni({ uWidth: width, uK: k, uGain: gain, uOpacity: opacity, uMinPx: minPx, uFade: fade, uFlat: flat, uDash: dash }),
  });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = order;
  return m;
}

function pointsLayer(items, { mode = 2, world = 2, minPx = 2, maxPx = 8, opacity = 1, blending = THREE.NormalBlending, order = 8 }) {
  const n = items.length;
  const pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3), al = new Float32Array(n);
  items.forEach((it, i) => {
    pos.set([it.x, it.h ?? 0, -it.y], i * 3); size[i] = it.s ?? 1; col.set([it.c.r, it.c.g, it.c.b], i * 3); al[i] = it.a ?? 1;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false, blending,
    uniforms: uni({ uMode: mode, uWorld: world, uMinPx: minPx, uMaxPx: maxPx, uOpacity: opacity }),
  });
  const p = new THREE.Points(g, mat); p.frustumCulled = false; p.renderOrder = order;
  return p;
}

// Simulated light raster: R = perceived brightness (LUX.glow * 255), A = inside simulated area.
const SIM_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SIM_FS = `
uniform sampler2D uTex; uniform vec3 uColor; uniform float uGain;
varying vec2 vUv;
void main(){
  vec4 t = texture2D(uTex, vUv);
  float v = pow(smoothstep(0.25, 1.0, t.r), 1.4);
  gl_FragColor = vec4(uColor * v * uGain, t.a);
}`;

// Photo point cloud: positions in local metres (world y up), sRGB colours written straight to the sRGB canvas.
const PC_VS = `
attribute vec3 color;
uniform float uPx; uniform float uDpr; uniform float uWorld; uniform float uExp;
varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float mpp = max(-mv.z, 0.01) * uPx;
  gl_PointSize = clamp(uWorld / mpp, 1.4, 5.0) * uDpr;
  vC = min(color * uExp, vec3(1.0));
  gl_Position = projectionMatrix * mv;
}`;
const PC_FS = `
varying vec3 vC;
uniform float uOpacity;
void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; if (dot(q, q) > 1.0) discard; gl_FragColor = vec4(vC, uOpacity); }`;

/* ------------------------------------------------------------------ helpers */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const pct = (v) => `${Math.round(v * 100)}%`;
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const clock = (unix) => new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).toLowerCase();

function lampTint(p) {
  const t = p.light_type || '';
  const k = p.cct_k;
  if (t.startsWith('sodium') || (k && k < 2600)) return new THREE.Color('#ffb466');
  if (t.startsWith('warm') || (k && k < 3500)) return new THREE.Color('#ffd8a0');
  if (t.startsWith('neutral') || (k && k < 5000)) return new THREE.Color('#fff0dc');
  return new THREE.Color('#e6eeff');
}

class Grid {
  constructor(cell) { this.c = cell; this.m = new Map(); }
  key(x, y) { return `${Math.floor(x / this.c)},${Math.floor(y / this.c)}`; }
  add(x, y, v) { const k = this.key(x, y); let a = this.m.get(k); if (!a) this.m.set(k, (a = [])); a.push(v); }
  near(x, y, r, fn) {
    const c = this.c, x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c), y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const a = this.m.get(`${i},${j}`); if (a) for (const v of a) fn(v); }
  }
}

async function loadSafe(name) {
  try { const d = await L.load(name); return d && d.features ? d.features : (Array.isArray(d) ? d : []); } catch (e) { console.warn(`map: ${name} unavailable`, e.message); return []; }
}

/* ------------------------------------------------------------------ min-heap for Dijkstra */
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() { const k = this.k, v = this.v; const top = v[0]; const lk = k.pop(), lv = v.pop(); const n = k.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; }
    return top; }
  get size() { return this.k.length; }
}

/* ------------------------------------------------------------------ map-style camera controller
   State: ground target, distance d, bearing (heading, rad, clockwise from north), tilt (rad from straight down).
   Left-drag grabs the ground; wheel/pinch zoom toward the cursor; right/Ctrl-drag rotate + tilt; Shift-drag tilt. */
const DEF_TILT = THREE.MathUtils.degToRad(50);
const MAX_TILT = THREE.MathUtils.degToRad(75);
const TAU = Math.PI * 2;
const wrapPi = (a) => { a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a; };
const easeIO = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

class MapCam {
  constructor(camera, dom) {
    this.cam = camera; this.dom = dom;
    this.target = new THREE.Vector3(); this.d = 1500; this.bearing = 0; this.tilt = DEF_TILT;
    this.minDistance = 25; this.maxDistance = 9000; this.maxTilt = MAX_TILT;
    this.enabled = true; this.bounds = null; this.uPx = 0.001;
    this.vel = null; this.zoom = null; this.anim = null;
    this.onChange = () => {}; this.onInteract = () => {};
    this._ray = new THREE.Raycaster(); this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._last = '';
  }

  // place the camera from the state (clamped); fires onChange when anything moved
  update() {
    const c = this.cam, b = this.bounds;
    this.d = THREE.MathUtils.clamp(this.d, this.minDistance, this.maxDistance);
    this.tilt = THREE.MathUtils.clamp(this.tilt, 0, this.maxTilt);
    this.bearing = wrapPi(this.bearing);
    if (b) {
      this.target.x = THREE.MathUtils.clamp(this.target.x, b.x0, b.x1);
      this.target.z = THREE.MathUtils.clamp(this.target.z, -b.y1, -b.y0);
    }
    const s = Math.sin(this.tilt), co = Math.cos(this.tilt), fx = Math.sin(this.bearing), fz = -Math.cos(this.bearing);
    c.position.set(this.target.x - fx * this.d * s, this.target.y + this.d * co, this.target.z - fz * this.d * s);
    c.rotation.set(-(Math.PI / 2 - this.tilt), -this.bearing, 0, 'YXZ');
    c.updateMatrixWorld();
    const key = `${c.position.x.toFixed(3)},${c.position.y.toFixed(3)},${c.position.z.toFixed(3)},${this.bearing.toFixed(4)},${this.tilt.toFixed(4)}`;
    if (key !== this._last) { this._last = key; this.onChange(); }
  }

  // adopt whatever pose the camera has (after Fly through); target = the point it looks at
  syncFromCamera(look) {
    const c = this.cam, dir = look.clone().sub(c.position);
    this.d = Math.max(this.minDistance, dir.length()); dir.normalize();
    this.tilt = Math.acos(THREE.MathUtils.clamp(-dir.y, -1, 1));
    this.bearing = Math.atan2(dir.x, -dir.z);
    this.target.copy(c.position).addScaledVector(dir, this.d);
    this.update();
  }

  // ground point (y = 0) under a canvas-relative pixel, or null
  hit(sx, sy) {
    const w = this.dom.clientWidth, h = this.dom.clientHeight; if (!w || !h) return null;
    this._ray.setFromCamera({ x: (sx / w) * 2 - 1, y: -(sy / h) * 2 + 1 }, this.cam);
    const p = new THREE.Vector3();
    if (!this._ray.ray.intersectPlane(this._plane, p)) return null;
    const lim = Math.max(this.d * 5, 400);
    return p.distanceTo(this.cam.position) < lim ? p : null;
  }

  // move the target so the ground under (px,py) ends up under (qx,qy); returns world delta
  panPx(px, py, qx, qy) {
    const a = this.hit(px, py), b = this.hit(qx, qy);
    let dx, dz;
    if (a && b) { dx = a.x - b.x; dz = a.z - b.z; } else {      // near the horizon: plain screen-space pan
      const mpp = this.d * this.uPx, sx = (qx - px) * mpp, sy = (qy - py) * mpp / Math.max(0.25, Math.cos(this.tilt));
      const cb = Math.cos(this.bearing), sb = Math.sin(this.bearing);
      dx = -cb * sx + sb * sy; dz = -sb * sx - cb * sy;
    }
    this.target.x += dx; this.target.z += dz; this.update();
    return { dx, dz };
  }

  // run fn (which changes d/bearing/tilt) while keeping the ground under (sx,sy) fixed
  anchored(sx, sy, fn) {
    const a = sx == null ? null : this.hit(sx, sy);
    fn(); this.update();
    if (!a) return;
    const b = this.hit(sx, sy);
    if (b) { this.target.x += a.x - b.x; this.target.z += a.z - b.z; this.update(); }
  }

  // smooth zoom by factor (<1 = in) toward canvas pixel (sx,sy)
  zoomBy(f, sx, sy) {
    this.anim = null; this.vel = null;
    const goal = Math.log(THREE.MathUtils.clamp((this.zoom ? Math.exp(this.zoom.goal) : this.d) * f, this.minDistance, this.maxDistance));
    this.zoom = { goal, sx, sy };
  }

  // animate to a pose {x, z (world), d, bearing, tilt}; missing keys keep their value
  animateTo(to, dur = 900) {
    this.vel = null; this.zoom = null;
    const from = { x: this.target.x, z: this.target.z, ld: Math.log(this.d), b: this.bearing, t: this.tilt };
    const dest = { x: to.x ?? from.x, z: to.z ?? from.z, ld: Math.log(THREE.MathUtils.clamp(to.d ?? this.d, this.minDistance, this.maxDistance)),
      b: from.b + wrapPi((to.bearing ?? from.b) - from.b), t: THREE.MathUtils.clamp(to.tilt ?? from.t, 0, this.maxTilt) };
    this.anim = { from, dest, t0: performance.now(), dur };
  }

  stop() { this.vel = null; this.zoom = null; this.anim = null; }

  // per-frame: inertia, smooth zoom, animations. dt in ms
  tick(now, dt) {
    if (!this.enabled) return;
    if (this.anim) {
      const a = this.anim, k = easeIO(Math.min(1, (now - a.t0) / a.dur)), f = a.from, t = a.dest;
      this.target.x = f.x + (t.x - f.x) * k; this.target.z = f.z + (t.z - f.z) * k;
      this.d = Math.exp(f.ld + (t.ld - f.ld) * k); this.bearing = f.b + (t.b - f.b) * k; this.tilt = f.t + (t.t - f.t) * k;
      if (k >= 1) this.anim = null;
    }
    if (this.zoom) {
      const z = this.zoom, cur = Math.log(this.d), nl = cur + (z.goal - cur) * (1 - Math.exp(-dt / 85));
      const done = Math.abs(z.goal - nl) < 0.002;
      this.anchored(z.sx, z.sy, () => { this.d = Math.exp(done ? z.goal : nl); });
      if (done) this.zoom = null;
    }
    if (this.vel) {
      const v = this.vel, k = Math.exp(-dt / 260);
      this.target.x += v.x * dt; this.target.z += v.z * dt; v.x *= k; v.z *= k;
      if (Math.hypot(v.x, v.z) / (this.d * this.uPx) < 0.02) this.vel = null;   // slower than 0.02 px/ms
    }
    this.update();
  }

  get busy() { return !!(this.anim || this.zoom || this.vel); }
}

/* ------------------------------------------------------------------ the view */
export default {
  async mount(el, LUX) {
    L = LUX;
    S.el = el;
    if (!document.querySelector('link[data-view-css="map"]')) {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'css/map.css'; link.dataset.viewCss = 'map';
      document.head.appendChild(link);
    }
    this._introOverlay();
    S.uPx = { value: 0.001 }; S.uDpr = { value: 1 };

    const [path, lamps, warns, trees, blds, marks] = await Promise.all([
      'path_lighting.geojson', 'lamps.geojson', 'warnings.geojson', 'trees.geojson', 'buildings.geojson',
      'landmarks.geojson',
    ].map(loadSafe));
    S.data = { path, lamps, warns, trees, blds, marks };
    S.sim = await this._loadSim();
    try { S.pcMeta = await L.load('pointcloud/meta.json'); if (!S.pcMeta || !S.pcMeta.points) S.pcMeta = null; } catch (e) { S.pcMeta = null; }

    // renderer
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
      el.innerHTML = '<div class="loading">The 3D map needs WebGL, which this browser has turned off.</div>';
      if (S.intro) { S.intro.ov.remove(); S.intro.st.remove(); document.body.classList.remove('lux-intro', 'lux-intro-logo'); S.intro = null; }
      return;
    }
    S.renderer = renderer;
    renderer.setClearColor(0x08090b, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Three-dimensional map of measured night-time light on the Texas A&M campus');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.classList.add('map-gl');

    const scene = (S.scene = new THREE.Scene());
    scene.fog = new THREE.Fog(0x08090b, 3000, 12000);
    const camera = (S.camera = new THREE.PerspectiveCamera(40, 1, 2, 60000));

    scene.add(new THREE.HemisphereLight(0x8090a8, 0x0a0b0d, 0.55));
    const moon = new THREE.DirectionalLight(0xa8b4cc, 0.5); moon.position.set(-0.4, 1, 0.6); scene.add(moon);

    this._buildScene();
    const controls = (S.controls = new MapCam(camera, renderer.domElement));
    const e = S.ext, pad = 350;
    controls.bounds = { x0: e.x0 - pad, x1: e.x1 + pad, y0: e.y0 - pad, y1: e.y1 + pad };
    controls.onChange = () => { S.dirty = true; S.camMoved = true; };
    this._buildUI();
    this._buildLabels();
    this._frame();

    S.ro = new ResizeObserver(() => this._resize()); S.ro.observe(el);
    this._resize();
    this._bindPointer();
    S.mounted = true;
    this._introStart();
    if (/[?&]debug\b/.test(location.search)) window.__lightmap = { S, view: this, THREE };   // test hook only
  },

  show(params = {}) {
    if (!S.renderer) return;
    S.visible = true; S.dirty = true;
    this._resize();
    if (!S.raf) S.raf = requestAnimationFrame(this._loop.bind(this));
    if (params.session != null && params.index != null) {   // old Street View links open Light View at that frame
      this._svFrames().then((fr) => {
        const run = fr.sess.get(params.session), i = +params.index;
        const f = run && (run.find((q) => q.i === i) || run.reduce((a, q) => (Math.abs(q.i - i) < Math.abs(a.i - i) ? q : a), run[0]));
        if (f) this._wkEnter(f.x, f.y, f.h != null ? THREE.MathUtils.degToRad(f.h) : this._pathHeading(f.x, f.y));
      });
      try { history.replaceState(null, '', '#map'); } catch (e) { /* ignore */ }
      return;
    }
    const lat = parseFloat(params.lat), lon = parseFloat(params.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const [x, y] = L.toXY(lat, lon);
      this._flyTo(x, y, 360);
      this._mark(x, y);
    }
  },

  hide() {
    if (S.intro) this._introEnd(true);
    S.visible = false;
    if (S.wk) S.wk.keys.clear();
    if (S.raf) cancelAnimationFrame(S.raf); S.raf = null;
    if (S.tip) S.tip.hidden = true;
  },

  async _loadSim() {
    try {
      const meta = await L.load('light_map.json');
      const img = new Image(); img.src = 'data/light_map.png';
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, cv.width, cv.height).data; // un-premultiplied RGBA for hover sampling
      return { meta, img, px, w: cv.width, h: cv.height };
    } catch (e) { console.warn('map: simulated light unavailable', e.message); return null; }
  },

  // lux at local metres from the simulated raster, or null outside the simulated area
  _simLux(x, y) {
    const sm = S.sim; if (!sm) return null;
    const b = sm.meta.bounds_local_m;
    const c = Math.floor(((x - b.x0) / (b.x1 - b.x0)) * sm.w), r = Math.floor(((b.y1 - y) / (b.y1 - b.y0)) * sm.h);
    if (c < 0 || r < 0 || c >= sm.w || r >= sm.h) return null;
    const i = (r * sm.w + c) * 4;
    if (sm.px[i + 3] < 128) return null;
    return 0.3 * Math.pow(200, sm.px[i] / 255);
  },

  /* ---------------------------------------------------------------- scene */
  _buildScene() {
    const { path, lamps, warns, trees, blds } = S.data;
    const scene = S.scene;
    S.layers = { light: [], sim: [], lamps: [], trees: [], warn: [], route: [] };
    if (S.sim) {
      const b = S.sim.meta.bounds_local_m;
      const tex = new THREE.Texture(S.sim.img); tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4; tex.needsUpdate = true;
      const mat = new THREE.ShaderMaterial({
        vertexShader: SIM_VS, fragmentShader: SIM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTex: { value: tex }, uColor: { value: WARM.clone() }, uGain: { value: 0.95 } },
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0).rotateX(-Math.PI / 2), mat);
      plane.position.set((b.x0 + b.x1) / 2, 0.05, -(b.y0 + b.y1) / 2); plane.renderOrder = 1;
      S.layers.sim.push(plane);
    }
    S.pick = new Grid(25); S.items = [];
    const addItem = (it) => { S.items.push(it); S.pick.add(it.x, it.y, it); };

    // extent
    const xs = [], ys = [];
    const addExt = (x, y) => { xs.push(x); ys.push(y); };
    // ground
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x0b0c0f, depthWrite: false });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), groundMat);
    ground.renderOrder = -2; scene.add(ground);

    // ---- path light
    const cellsCore = [], cellsHalo = [], segCore = [], segHalo = [], segDim = [];
    for (const f of path) {
      const p = f.properties || {}, g = f.geometry; if (!g) continue;
      const lux = p.lux_median, gl = L.glow(lux);
      if (g.type === 'Point') {
        const [x, y] = L.toXY(g.coordinates[1], g.coordinates[0]); addExt(x, y);
        const e = Math.pow(gl, 2.4);
        if (e < 0.01) cellsCore.push({ x, y, r: 2.2, c: GREY.clone() });
        else {
          cellsCore.push({ x, y, r: 4.2 + 1.4 * gl, c: WARM.clone().multiplyScalar(0.8 * e).add(GREY.clone().multiplyScalar(0.55)) });
          if (e > 0.12) cellsHalo.push({ x, y, r: 8 + 12 * gl, c: WARM.clone().multiplyScalar(0.2 * e) });
        }
        addItem({ t: 'path', x, y, h: 0, f, kind: 'cell' });
      } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
        const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        for (const cs of parts) {
          const pts = cs.map((c) => L.toXY(c[1], c[0]));
          let len = 0;
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i]; addExt(a[0], a[1]); addExt(b[0], b[1]);
            len += Math.hypot(b[0] - a[0], b[1] - a[1]);
            const e = Math.pow(gl, 2.4);
            if (e < 0.01) segDim.push({ a, b, c: GREY.clone().multiplyScalar(1.3) });
            else {
              segCore.push({ a, b, c: WARM.clone().multiplyScalar(1.1 * e).add(GREY.clone().multiplyScalar(0.7)) });
              if (e > 0.08) segHalo.push({ a, b, c: WARM.clone().multiplyScalar(0.3 * e) });
            }
          }
          const mid = pts[Math.floor(pts.length / 2)], mid0 = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
          addItem({ t: 'path', x: (mid[0] + mid0[0]) / 2, y: (mid[1] + mid0[1]) / 2, h: 0, f, kind: 'stretch', len });
        }
      }
    }
    const light = S.layers.light;
    const tag = (m, halo) => { m.userData.halo = halo; m.userData.base = { ...Object.fromEntries(['uWidth', 'uGain', 'uMinPx'].filter((k) => m.material.uniforms[k]).map((k) => [k, m.material.uniforms[k].value])) }; return m; };
    if (cellsHalo.length) light.push(tag(splatLayer(cellsHalo, { k: 3.2, minPx: 3, fade: 1.2, order: 2 }), true));
    if (cellsCore.length) light.push(tag(splatLayer(cellsCore, { k: 2.8, minPx: 1.1, fade: 0.9, order: 3 }), false));
    if (segHalo.length) light.push(tag(ribbonLayer(segHalo, { width: 11, k: 3, minPx: 5, fade: 0.9, order: 2 }), true));
    if (segCore.length) light.push(tag(ribbonLayer(segCore, { width: 3, k: 2.6, minPx: 1.6, fade: 0.45, order: 3 }), false));
    if (segDim.length) light.push(ribbonLayer(segDim, { width: 0.6, flat: 1, minPx: 0.7, fade: 0.5, order: 3 }));

    // ---- lamps
    const bulbs = [], pools = [], poles = [];
    for (const f of lamps) {
      const p = f.properties || {}, g = f.geometry; if (!g) continue;
      const [x, y] = L.toXY(g.coordinates[1], g.coordinates[0]); addExt(x, y);
      const h = p.height_m || 4, tint = lampTint(p);
      const near = p.lux_near ?? p.lux_ring ?? null;
      const gl = near != null ? L.glow(near) : 0.25;
      const conf = p.confidence ?? 0.6;
      bulbs.push({ x, y, h, c: tint, s: 0.75 + 0.5 * gl, a: 0.55 + 0.45 * conf });
      pools.push({ x, y, h: 0.08, r: 6 + 12 * gl, c: tint.clone().multiplyScalar(0.03 + 0.16 * gl * gl) });
      poles.push(x, 0, -y, x, h, -y);
      addItem({ t: 'lamp', x, y, h, f });
    }
    const lampL = S.layers.lamps;
    if (pools.length) { S.pools = splatLayer(pools, { k: 2.6, minPx: 2, fade: 1.4, order: 1 }); lampL.push(S.pools); }
    if (poles.length) {
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(poles), 3));
      const pl = new THREE.LineSegments(pg, new THREE.LineBasicMaterial({ color: 0x3a3e46, transparent: true, opacity: 0.55, depthWrite: false }));
      pl.renderOrder = 4; lampL.push(pl);
    }
    if (bulbs.length) lampL.push(pointsLayer(bulbs, { mode: 0, world: 5, minPx: 7, maxPx: 34, blending: THREE.AdditiveBlending, order: 10 }));

    // ---- trees
    const treeL = S.layers.trees;
    const tr = trees.filter((f) => f.geometry && f.geometry.type === 'Point');
    if (tr.length) {
      const crownG = new THREE.IcosahedronGeometry(1, 1);
      const trunkG = new THREE.CylinderGeometry(0.1, 0.16, 1, 6).translate(0, 0.5, 0);
      const crownM = new THREE.MeshLambertMaterial({ color: 0x2a3631, flatShading: true, transparent: true, opacity: 0.62, depthWrite: false });
      const trunkM = new THREE.MeshLambertMaterial({ color: 0x1d2023, transparent: true, opacity: 0.7, depthWrite: false });
      const crowns = new THREE.InstancedMesh(crownG, crownM, tr.length);
      const trunks = new THREE.InstancedMesh(trunkG, trunkM, tr.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), po = new THREE.Vector3();
      const shadows = [];
      tr.forEach((f, i) => {
        const p = f.properties || {};
        const [x, y] = L.toXY(f.geometry.coordinates[1], f.geometry.coordinates[0]);
        const cr = Math.max(1, p.crown_radius_m || 3), ht = Math.max(cr * 1.4, p.height_m || 8);
        const trunkH = Math.max(1, ht - cr * 1.5);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % 6.283);
        m.compose(po.set(x, 0, -y), q, sc.set(cr * 0.6, trunkH + cr * 0.1, cr * 0.6)); trunks.setMatrixAt(i, m);
        m.compose(po.set(x, trunkH + cr * 0.75, -y), q, sc.set(cr, cr * 0.82, cr)); crowns.setMatrixAt(i, m);
        shadows.push({ x, y, h: 0.04, r: cr * 1.1, c: new THREE.Color(0, 0, 0) });
        addItem({ t: 'tree', x, y, h: trunkH + cr, f });
      });
      crowns.computeBoundingSphere(); trunks.computeBoundingSphere(); crowns.renderOrder = 1;
      treeL.push(splatLayer(shadows, { mode: 2, opacity: 0.55, blending: THREE.NormalBlending, order: 0 }), trunks, crowns);
    }

    // ---- buildings
    const bGeoms = [];
    for (const f of blds) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      const h = (f.properties && f.properties.height_m) || 10;
      const nm = f.properties && f.properties.name;
      if (nm && polys[0] && polys[0][0]) {
        const r0 = polys[0][0]; let sx = 0, sy = 0;
        r0.forEach((c) => { const [x, y] = L.toXY(c[1], c[0]); sx += x; sy += y; });
        addItem({ t: 'bld', x: sx / r0.length, y: sy / r0.length, h, f });
      }
      for (const rings of polys) {
        const toV = (r) => r.map((c) => { const [x, y] = L.toXY(c[1], c[0]); return new THREE.Vector2(x, y); });
        const shape = new THREE.Shape(toV(rings[0]));
        rings.slice(1).forEach((r) => shape.holes.push(new THREE.Path(toV(r))));
        try {
          const eg = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2);
          bGeoms.push(eg);
        } catch (e) { /* skip bad polygon */ }
      }
    }
    if (bGeoms.length) {
      let n = 0; const gs = bGeoms.map((g) => (g.index ? g.toNonIndexed() : g)); gs.forEach((g) => (n += g.attributes.position.count));
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
      for (const g of gs) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
      const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      const mesh = new THREE.Mesh(mg, new THREE.MeshLambertMaterial({ color: 0x171a21, emissive: 0x0a0b0f, transparent: true, opacity: 1 }));   // transparent fixed: ghosting = opacity only, no recompile
      S.bld = mesh;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mg, 25), new THREE.LineBasicMaterial({ color: 0x343944, transparent: true, opacity: 0.55 }));
      S.bldEdges = edges; scene.add(mesh, edges);
    }

    // ---- warnings
    const sevS = { high: 1.45, medium: 1, low: 0.72 };
    const wpts = [];
    for (const f of warns) {
      const g = f.geometry; if (!g || g.type !== 'Point') continue;
      const p = f.properties || {};
      const [x, y] = L.toXY(g.coordinates[1], g.coordinates[0]);
      wpts.push({ x, y, h: 3, c: WARN, s: 1, a: 0.9 });   // all warning markers the same size
      addItem({ t: 'warn', x, y, h: 3, f });
    }
    if (wpts.length) S.layers.warn.push(pointsLayer(wpts, { mode: 1, world: 4, minPx: 4.5, maxPx: 14, order: 9 }));

    // ---- selection / fly-to markers
    S.selMark = splatLayer([{ x: 0, y: 0, h: 0.3, r: 5, c: new THREE.Color(0.95, 0.95, 0.95) }], { mode: 3, minPx: 11, opacity: 0.85, blending: THREE.NormalBlending, order: 11 });
    S.selMark.visible = false; scene.add(S.selMark);
    S.flyMark = splatLayer([{ x: 0, y: 0, h: 0.3, r: 9, c: WARM }], { mode: 3, minPx: 16, opacity: 0.9, blending: THREE.NormalBlending, order: 11 });
    S.flyMark.visible = false; scene.add(S.flyMark);

    for (const k of Object.keys(S.layers)) S.layers[k].forEach((o) => scene.add(o));

    // extent + faint 100 m grid
    if (!xs.length) { xs.push(-600, 600); ys.push(-400, 400); }
    const q = (a, p) => { const s = [...a].sort((u, v) => u - v); return s[Math.floor(p * (s.length - 1))]; };
    S.ext = { x0: q(xs, 0.005), x1: q(xs, 0.995), y0: q(ys, 0.005), y1: q(ys, 0.995) };
    const e = S.ext, pad = 800, step = 100;
    const gx0 = Math.floor((e.x0 - pad) / step) * step, gx1 = Math.ceil((e.x1 + pad) / step) * step;
    const gy0 = Math.floor((e.y0 - pad) / step) * step, gy1 = Math.ceil((e.y1 + pad) / step) * step;
    const gl = [];
    for (let x = gx0; x <= gx1; x += step) gl.push(x, 0.02, -gy0, x, 0.02, -gy1);
    for (let y = gy0; y <= gy1; y += step) gl.push(gx0, 0.02, -y, gx1, 0.02, -y);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gl), 3));
    const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.6, depthWrite: false }));
    grid.renderOrder = -1; scene.add(grid);
  },

  /* ---------------------------------------------------------------- UI */
  _buildUI() {
    const el = S.el;
    const d = S.data;
    // ---- layers panel (top-right)
    const lp = (S.layersEl = document.createElement('aside')); lp.className = 'panel map-layers'; lp.setAttribute('aria-label', 'Map layers');
    const pm = S.pcMeta;
    const defs = [
      ['light', 'Measured light', true, d.path.length],
      ['sim', 'Simulated light', true, S.sim ? 1 : 0],
      ['lamps', 'Streetlights', true, d.lamps.length],
      ['trees', 'Trees', true, d.trees.length],
      ['warn', 'Low-light warnings', true, d.warns.length],
      ['pc', 'Photo point cloud', false, pm ? 1 : 0],
      ['sv', 'Photo coverage', false, 1],
    ];
    const err = S.sim?.meta?.validation_map?.median_abs_error_lux;
    const tips = {
      light: 'Path brightness = measured light',
      sim: `Lamp physics + shadows, fitted to readings${err != null ? ` · ±${(+err).toFixed(1)} lux on unmeasured stretches` : ''}`,
      lamps: 'Streetlights found in the survey photos',
      pc: pm ? 'Points from blurred survey photos placed by GPS + phone orientation (expect ghosting where walks overlap)' : 'Point cloud still processing',
      sv: 'Where survey photos exist — drag the figure here for Light View',
    };
    lp.innerHTML = `<button type="button" class="map-layers-h" aria-expanded="true" aria-controls="map-layers-body">
        <span>Layers</span><svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>
      <div class="map-layers-body" id="map-layers-body"></div>`;
    const body = lp.querySelector('.map-layers-body');
    S.on = {}; S.ck = {};
    for (const [key, label, on, n] of defs) {
      const empty = !n;
      S.on[key] = on && !empty;
      const row = document.createElement('label'); row.className = 'map-ck';
      if (tips[key]) row.title = empty && key !== 'pc' ? `No ${label.toLowerCase()} data in this build yet` : tips[key];
      const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = S.on[key]; ck.disabled = empty; ck.dataset.k = key;
      const txt = document.createElement('span'); txt.textContent = label;
      if (key === 'warn') txt.insertAdjacentHTML('afterbegin', '<svg class="map-tri map-ck-tri" viewBox="0 0 12 11" aria-hidden="true"><path d="M6 1.4 10.9 10.2H1.1z"/></svg>');
      row.append(ck, txt);
      if (key === 'pc') {
        S.pcNote = document.createElement('span'); S.pcNote.className = 'map-ck-note';
        S.pcNote.textContent = pm ? `${Math.round((pm.points * (pm.bytes_per_point || 9)) / 1e6)} MB` : 'processing';
        row.append(S.pcNote); S.pcChip = ck;
      }
      S.ck[key] = ck;
      ck.addEventListener('change', () => {
        S.on[key] = ck.checked;
        if (key === 'pc') this._pcToggle(S.on[key]);
        else if (key === 'sv') this._svToggle(S.on[key]);
        else this._applyVis();
        S.dirty = true;
      });
      body.appendChild(row);
    }
    // ---- route planner: the primary card, top-left under the logo (search From / To like a maps app)
    const rc = (S.rtEl = document.createElement('section')); rc.className = 'map-rtc'; rc.setAttribute('aria-label', 'Route planner');
    const pinSvg = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 13.2S1.6 8.6 1.6 5.4a4.4 4.4 0 0 1 8.8 0C10.4 8.6 6 13.2 6 13.2z"/><circle cx="6" cy="5.4" r="1.5"/></svg>';
    const field = (k) => `<div class="map-rt-f" data-end="${k}"><i class="map-rt-dot ${k ? 'to' : 'from'}" aria-hidden="true"></i>
        <input class="map-rt-in" id="map-rt-in${k}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="map-rt-sug"
          autocomplete="off" spellcheck="false" enterkeyhint="${k ? 'go' : 'next'}" placeholder="${k ? 'To' : 'From'} — campus place or address" aria-label="${k ? 'To' : 'From'}">
        <button type="button" class="map-rt-pin" data-end="${k}" aria-pressed="false" aria-label="Pick ${k ? 'To' : 'From'} on the map" title="Pick on the map">${pinSvg}</button></div>`;
    rc.innerHTML = `<button type="button" class="map-rtc-h" aria-expanded="true" aria-controls="map-rt-body">
        <svg class="map-rtc-ic" viewBox="0 0 14 14" aria-hidden="true"><circle cx="3" cy="11" r="1.6"/><circle cx="11" cy="3" r="1.6"/><path d="M3 9.2V7.5C3 5.8 4.2 5 6 5h2c1.6 0 3-.4 3-2.2"/></svg>
        <span>Route</span><svg class="map-rtc-chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>
      <div class="map-rt" id="map-rt-body">
        <div class="map-rt-ends">
          <div class="map-rt-rows">${field(0)}${field(1)}</div>
          <div class="map-rt-tools">
            <button type="button" class="map-rt-ic" data-act="swap" aria-label="Swap start and destination" title="Swap"><svg viewBox="0 0 12 14" aria-hidden="true"><path d="M3.5 12.5V2M1 4.5 3.5 2 6 4.5M8.5 1.5V12M6 9.5l2.5 2.5L11 9.5"/></svg></button>
            <button type="button" class="map-rt-ic" data-act="clear" aria-label="Clear route" title="Clear"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>
          </div>
        </div>
        <ul class="map-rt-sug" id="map-rt-sug" role="listbox" aria-label="Suggestions" hidden></ul>
        <div class="map-rt-out" aria-live="polite">
          <div class="map-rt-res"></div>
          <div class="map-rt-msg"></div>
          <div class="map-rt-go" hidden>
            <button type="button" class="map-rt-b primary" data-act="fly" aria-label="Fly through the best-lit route in Light View">Fly through</button>
          </div>
        </div>
      </div>`;
    const rt = (S.routeBox = rc.querySelector('.map-rt'));
    S.rtIn = [...rt.querySelectorAll('.map-rt-in')]; S.rtSugEl = rt.querySelector('.map-rt-sug');
    S.rtPts = [null, null]; S.rtLbl = [null, null]; S.rtPin = null; S.rtMeshes = [];
    S.rtIn.forEach((inp, k) => this._rtBindInput(inp, k));
    rt.querySelectorAll('.map-rt-pin').forEach((b) => b.addEventListener('click', () => {
      const k = +b.dataset.end; S.rtPin = S.rtPin === k ? null : k; this._rtSugClose(); this._routeUI();
    }));
    // keep focus in the field while a suggestion is clicked
    S.rtSugEl.addEventListener('pointerdown', (e) => e.preventDefault());
    S.rtSugEl.addEventListener('click', (e) => {
      const li = e.target.closest('[role="option"]'); if (!li || S.rtFocus == null) return;
      this._rtChoose(S.rtFocus, S.rtSug[+li.dataset.i]);
    });
    rt.querySelector('[data-act="swap"]').addEventListener('click', () => this._routeSwap());
    rt.querySelector('[data-act="clear"]').addEventListener('click', () => this._routeReset());
    rt.querySelector('[data-act="fly"]').addEventListener('click', () => this._rtView(true));
    const rh = rc.querySelector('.map-rtc-h');
    S.setRouteOpen = (o) => {
      rc.classList.toggle('closed', !o); rh.setAttribute('aria-expanded', String(o));
      if (o && S.W <= 760 && S.setLayersOpen) S.setLayersOpen(false);
      if (!o) { S.rtPin = null; this._rtSugClose(); }
      this._routeMode(o); S.camMoved = true;
    };
    rh.addEventListener('click', () => S.setRouteOpen(!S.routeOn));
    el.appendChild(rc);
    // live MongoDB stats (hidden unless the API answers)
    const lv = (S.liveEl = document.createElement('div')); lv.className = 'map-live'; lv.hidden = true; lv.setAttribute('aria-live', 'polite');
    lv.innerHTML = `<div class="map-live-h">Live · MongoDB</div><div class="map-live-s"></div>
      <div class="map-live-k">Darkest</div><div class="map-live-l"></div>`;
    lv.addEventListener('click', (e) => {
      const b = e.target.closest('.map-live-i'); if (!b || !S.liveItems) return;
      const it = S.liveItems[+b.dataset.i]; if (it) this._liveFly(it, b.dataset.l === 'near' ? S.nearItems : [it]);
    });
    body.appendChild(lv);
    el.appendChild(lp);
    // live stats block removed on request (kept: route score from MongoDB)
    const head = lp.querySelector('.map-layers-h');
    S.layersOpen = (el.clientWidth || window.innerWidth) > 760;
    const setOpen = (o) => {
      S.layersOpen = o; lp.classList.toggle('closed', !o); head.setAttribute('aria-expanded', String(o)); S.camMoved = true;
      if (o && S.W <= 760 && S.routeOn && S.setRouteOpen) S.setRouteOpen(false);
    };
    setOpen(S.layersOpen); S.setLayersOpen = setOpen;
    head.addEventListener('click', () => setOpen(!S.layersOpen));
    S.setRouteOpen(true);   // route search is the primary UI
    this._applyVis();

    // ---- bottom-right: Light View figure dock above the map controls
    const br = document.createElement('div'); br.className = 'map-br';
    const dock = document.createElement('button'); dock.type = 'button'; dock.className = 'map-peg-dock';
    dock.setAttribute('aria-label', 'Drag onto a path to open Light View');
    dock.title = 'Drag onto a path for Light View';
    dock.innerHTML = '<img src="img/pegman_small.png" alt="" draggable="false">';
    const ctl = document.createElement('div'); ctl.className = 'map-ctl'; ctl.setAttribute('role', 'group'); ctl.setAttribute('aria-label', 'Map controls');
    ctl.innerHTML = `<div class="map-zoom">
        <button type="button" class="map-cb" data-c="in" aria-label="Zoom in" title="Zoom in"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10"/></svg></button>
        <button type="button" class="map-cb" data-c="out" aria-label="Zoom out" title="Zoom out"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h10"/></svg></button>
      </div>
      <button type="button" class="map-cb map-compass" data-c="north" aria-label="Reset to north" title="Reset to north">
        <svg viewBox="0 0 24 24" aria-hidden="true"><g class="map-needle"><path class="n" d="M12 3.5 14.6 12H9.4z"/><path class="s" d="M12 20.5 9.4 12h5.2z"/></g></svg></button>
      <button type="button" class="map-cb map-dim" data-c="dim" aria-label="Switch to 2D view" title="Switch to 2D view">2D</button>`;
    br.append(dock, ctl); el.appendChild(br); S.brEl = br;
    S.needle = ctl.querySelector('.map-needle'); S.dimBtn = ctl.querySelector('.map-dim');
    ctl.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const c = S.controls;
      if (b.dataset.c === 'in') c.zoomBy(0.5, S.W / 2, S.H / 2);
      else if (b.dataset.c === 'out') c.zoomBy(2, S.W / 2, S.H / 2);
      else if (b.dataset.c === 'north') c.animateTo({ bearing: 0, tilt: DEF_TILT }, 700);
      else if (b.dataset.c === 'dim') c.animateTo(c.tilt < 0.05 ? { tilt: DEF_TILT } : { tilt: 0, bearing: 0 }, 750);
      S.dirty = true;
    });
    S.pegDock = dock;
    S.pegNote = document.createElement('div'); S.pegNote.className = 'tooltip map-peg-note'; S.pegNote.hidden = true; el.appendChild(S.pegNote);
    this._bindPegman();

    S.tip = document.createElement('div'); S.tip.className = 'tooltip map-tip'; S.tip.hidden = true; el.appendChild(S.tip);

    S.panel = document.createElement('aside'); S.panel.className = 'panel map-panel'; S.panel.hidden = true; S.panel.setAttribute('aria-live', 'polite');
    el.appendChild(S.panel);

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.visible) this._closePanel(); });
  },

  // compass needle + 2D/3D label follow the camera
  _syncCtl() {
    const c = S.controls; if (!c || !S.needle) return;
    S.needle.setAttribute('transform', `rotate(${(-c.bearing * 180) / Math.PI} 12 12)`);
    const flat = c.tilt < 0.05;
    if (S.dimFlat !== flat) {
      S.dimFlat = flat; S.dimBtn.textContent = flat ? '3D' : '2D';
      const t = flat ? 'Switch to 3D view' : 'Switch to 2D view'; S.dimBtn.setAttribute('aria-label', t); S.dimBtn.title = t;
    }
  },

  _applyVis() {
    for (const k of Object.keys(S.layers)) if (k !== 'route') S.layers[k].forEach((o) => (o.visible = !!S.on[k]));
    const sim = !!S.on.sim;
    if (S.pools) S.pools.visible = S.on.lamps && !sim;       // the simulation replaces the generic lamp pools
    for (const m of S.layers.light) {                         // measured ribbons stay on top, thinner/dimmer over the sim
      const u = m.material.uniforms, b = m.userData.base; if (!b) continue;
      if (m.userData.halo) { m.visible = S.on.light && !sim; continue; }
      if (u.uWidth && b.uWidth != null) u.uWidth.value = sim ? b.uWidth * 0.55 : b.uWidth;
      if (u.uMinPx && b.uMinPx != null) u.uMinPx.value = sim ? b.uMinPx * 0.75 : b.uMinPx;
      u.uGain.value = sim ? b.uGain * 0.7 : b.uGain;
    }
    const pc = !!S.on.pc, wk = (!!S.wk && !S.wk.exiting) || !!S.introFly;
    if (wk) {   // walk-through: eye-level view of the point cloud; floating / heavy overlays off
      [...S.layers.sim, ...S.layers.trees, ...S.layers.warn].forEach((o) => (o.visible = false));
      for (const m of S.layers.light) if (m.userData.halo) m.visible = false;
      if (S.pools) S.pools.visible = !!S.on.lamps;
      if (S.pegHL) S.pegHL.visible = false;
      if (S.nearHL) S.nearHL.visible = false;
      for (const m of S.layers.light) {   // a narrower, dimmer glow so the street underneath stays readable
        const b = m.userData.base; if (m.userData.halo || !b) continue;
        m.material.uniforms.uGain.value = b.uGain * 0.4;
        if (b.uWidth != null) m.material.uniforms.uWidth.value = b.uWidth * 0.45;
      }
    }
    S.layers.route.forEach((o) => (o.visible = !!S.routeOn && !wk));   // in Light View the route is drawn on the ground instead
    if (S.wkStreets) S.wkStreets.visible = wk;
    if (S.wkRoute) S.wkRoute.visible = wk;
    const ghost = pc && (!wk || !!S.pcPoints);
    if (S.bld) {
      const m = S.bld.material; m.opacity = ghost ? (wk ? 0.12 : 0.3) : 1; m.depthWrite = !ghost;
      S.bld.renderOrder = ghost ? 6 : 0; S.bldEdges.material.opacity = ghost ? (wk ? 0.12 : 0.25) : 0.55;
    }
    if (S.pcPoints) S.pcPoints.visible = pc;
    // ground-level viewing needs a closer near plane and freer tilt
    if (S.controls) {
      S.camera.near = wk ? 0.25 : pc ? 0.4 : 2; S.camera.updateProjectionMatrix();
      if (!S.wk) { S.controls.minDistance = pc ? 3 : 25; S.controls.maxTilt = pc ? 1.55 : MAX_TILT; S.controls.update(); }
    }
    S.dirty = true;
  },

  /* ---------------------------------------------------------------- photo frames (Street View index) */
  // Frames: data/streetview/index.json rows {s, i, lat, lon, h, p?, t?, lux?}; falls back to photos_index.csv positions.
  _svFrames() {
    if (!S.svFrames) {
      S.svFrames = (async () => {
        let rows = null;
        try {
          const ix = await L.load('streetview/index.json');
          if (Array.isArray(ix) && ix.length) rows = ix.map((f) => ({ s: f.s, i: f.i, lat: f.lat, lon: f.lon, h: f.h, p: f.p, t: f.t, lux: f.lux, w: f.w ?? f.walker }));
        } catch (e) { /* not shipped yet: fall back to photo positions */ }
        if (!rows) {
          try {
            rows = (await L.load('photos_index.csv')).map((r) => ({ s: r.session, i: r.index, lat: r.lat, lon: r.lon, h: r.heading_deg, t: r.epoch, w: r.walker }));
          } catch (e) { rows = []; }
        }
        const g = new Grid(20), hl = [], seen = new Set(), sess = new Map();
        for (const r of rows) {
          if (r.lat == null || r.lon == null || r.s == null || r.i == null) continue;
          if (TEST_RUNS.has(r.s)) continue;
          const [x, y] = L.toXY(r.lat, r.lon); r.x = x; r.y = y; g.add(x, y, r);
          if (!sess.has(r.s)) sess.set(r.s, []);
          sess.get(r.s).push(r);
          const k = `${Math.round(x / 3)},${Math.round(y / 3)}`;   // one highlight dot per ~3 m
          if (!seen.has(k)) { seen.add(k); hl.push({ x, y, h: 0.2, r: 2.2, c: new THREE.Color(0.62, 0.7, 0.85).multiplyScalar(0.8) }); }
        }
        let n = 0;
        for (const a of sess.values()) { a.sort((p, q) => p.i - q.i); a.forEach((r, k) => { r.k = k; r.run = a; }); n += a.length; }
        if (hl.length) {
          S.pegHL = splatLayer(hl, { k: 2.5, minPx: 3, fade: 0.4, order: 4 }); S.pegHL.visible = false; S.scene.add(S.pegHL);
        }
        return { grid: g, n, sess };
      })();
    }
    return S.svFrames;
  },

  _pegHighlight(on) {
    S.pegHot = on;
    if (S.pegHL) S.pegHL.visible = !S.wk && (on || !!S.on.sv);
    S.dirty = true;
  },

  _bindPegman() {
    const dock = S.pegDock;
    this._svFrames().then((f) => {
      if (f.n || S.pcMeta) return;
      dock.disabled = true; dock.title = 'Light View is not available yet';
      S.ck.sv.disabled = true; S.ck.sv.checked = false; S.on.sv = false; S.ck.sv.parentElement.title = 'Photos are not available yet';
    });
    let drag = null;
    const fig = document.createElement('img'); fig.src = 'img/pegman.png'; fig.alt = ''; fig.className = 'map-peg-fig'; fig.hidden = true; fig.draggable = false;
    S.el.appendChild(fig);
    const place = (cx, cy) => { const r = S.el.getBoundingClientRect(); fig.style.left = `${cx - r.left}px`; fig.style.top = `${cy - r.top}px`; };
    dock.addEventListener('pointerdown', (e) => {
      if (dock.disabled || e.button > 0) return;
      e.preventDefault(); dock.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
    });
    dock.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      if (!drag.moved) {
        drag.moved = true; clearTimeout(S.pegHintT);
        fig.classList.remove('back'); fig.hidden = false; dock.classList.add('empty');
        S.tip.hidden = true; S.pegNote.hidden = true; this._pegHighlight(true);
      }
      place(e.clientX, e.clientY);
    });
    const end = async (e, cancel) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (!d.moved) return;
      const ok = !cancel && (await this._pegDrop(e.clientX, e.clientY));
      this._pegHighlight(false);
      if (ok) { fig.hidden = true; dock.classList.remove('empty'); return; }
      // spring back to the dock
      const dr = dock.getBoundingClientRect();
      fig.classList.add('back'); place(dr.left + dr.width / 2, dr.top + dr.height * 0.85);
      setTimeout(() => { fig.hidden = true; fig.classList.remove('back'); dock.classList.remove('empty'); }, 420);
      if (!cancel) {
        const r = S.el.getBoundingClientRect();
        S.pegNote.textContent = 'Nothing walked here — drop it on a highlighted path';
        S.pegNote.hidden = false;
        S.pegNote.style.right = `${r.right - dr.left + 10}px`; S.pegNote.style.top = `${dr.top - r.top + dr.height / 2 - 16}px`;
        clearTimeout(S.pegNoteT); S.pegNoteT = setTimeout(() => (S.pegNote.hidden = true), 2800);
      }
    };
    dock.addEventListener('pointerup', (e) => end(e, false));
    dock.addEventListener('pointercancel', (e) => end(e, true));
    dock.addEventListener('click', async (e) => {
      if (e.detail === 0) {   // keyboard: walk through at the centre of the view
        const t = S.controls.target;
        if (!(await this._wkAt(t.x, -t.z, 120))) this._pegHint();
        return;
      }
      this._pegHint();       // plain click: show where photos exist for 3 s
    });
  },

  async _svToggle(on) {
    await this._svFrames();
    this._pegHighlight(!!S.pegHot);
  },

  async _pegHint() {
    await this._svFrames();
    this._pegHighlight(true); clearTimeout(S.pegHintT);
    S.pegHintT = setTimeout(() => this._pegHighlight(false), 3000);
  },

  async _svNearest(x, y, r) {
    const f = await this._svFrames(); let best = null, bd = r;
    f.grid.near(x, y, r, (fr) => { const d = Math.hypot(fr.x - x, fr.y - y); if (d <= bd) { bd = d; best = fr; } });
    return best;
  },

  async _pegDrop(cx, cy) {
    const g = this._ground(cx, cy); if (!g) return false;
    return this._wkAt(g.x, g.y, 40);
  },

  // enter the walk-through near (x, y): snap to the nearest photo frame, else to a walked path (point cloud only)
  async _wkAt(x, y, r) {
    const f = await this._svNearest(x, y, r);
    if (f) { this._wkEnter(f.x, f.y, f.h != null ? THREE.MathUtils.degToRad(f.h) : this._pathHeading(f.x, f.y)); return true; }
    if (!S.pcMeta) return false;
    if (S.graph === undefined) S.graph = this._buildGraph();
    const G = S.graph; if (!G) return false;
    const id = this._snap(x, y); if (id < 0 || Math.hypot(G.x[id] - x, G.y[id] - y) > r) return false;
    this._wkEnter(G.x[id], G.y[id], this._pathHeading(G.x[id], G.y[id]));
    return true;
  },

  // heading (rad, clockwise from north) along the nearest walked path
  _pathHeading(x, y) {
    if (S.graph === undefined) S.graph = this._buildGraph();
    const G = S.graph; if (!G) return 0;
    const id = this._snap(x, y); if (id < 0) return 0;
    const e = G.adj[id].find((a) => !a.gap) || G.adj[id][0]; if (!e) return 0;
    return Math.atan2(G.x[e.to] - G.x[id], G.y[e.to] - G.y[id]);
  },

  /* ---------------------------------------------------------------- Light View (point cloud at eye height, stuck to the paths) */
  _G() { if (S.graph === undefined) S.graph = this._buildGraph(); return S.graph; },

  // polyline {pts, cum, len} in local metres
  _poly(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { pts, cum, len: cum[cum.length - 1] };
  },

  _polyAt(P, s) {
    const { pts, cum } = P; if (pts.length < 2) return pts[0].slice();
    s = THREE.MathUtils.clamp(s, 0, P.len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const l = cum[hi] - cum[lo], k = l > 1e-6 ? (s - cum[lo]) / l : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * k, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * k];
  },

  // heading (rad, clockwise from north) looking ~8 m ahead along the polyline
  _polyYaw(P, s) {
    const s0 = Math.max(0, Math.min(s, P.len - 8)), a = this._polyAt(P, s0), b = this._polyAt(P, Math.min(P.len, s0 + 8));
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  },

  // nearest distance-along s of the polyline to (x, y)
  _polyNear(P, x, y) {
    let best = 0, bd = Infinity;
    for (let i = 1; i < P.pts.length; i++) {
      const [ax, ay] = P.pts[i - 1], dx = P.pts[i][0] - ax, dy = P.pts[i][1] - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < bd) { bd = d; best = P.cum[i - 1] + t * (P.cum[i] - P.cum[i - 1]); }
    }
    return { s: best, d: bd };
  },

  // nearest point on the walkable path network: {e (edge id), t (0..1 from a to b), x, y, d}
  _onGraph(x, y, rmax = 250) {
    const G = this._G(); if (!G) return null;
    let best = null;
    for (const r of [15, 45, 120, 250]) {
      if (r > rmax && best) break;
      const rr = Math.min(r, rmax);
      G.eg.near(x, y, rr, (id) => {
        const E = G.edges[id], ax = G.x[E.a], ay = G.y[E.a], dx = G.x[E.b] - ax, dy = G.y[E.b] - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? THREE.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
        const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px - x, py - y) + (E.gap ? 0.5 : 0);   // measured paths win ties
        if (!best || d < best.d) best = { e: id, t, x: px, y: py, d };
      });
      if ((best && best.d <= rr) || r >= rmax) break;
    }
    return best && best.d <= rmax ? best : null;
  },

  _edgePt(e, t) { const G = S.graph, E = G.edges[e]; return [G.x[E.a] + (G.x[E.b] - G.x[E.a]) * t, G.y[E.a] + (G.y[E.b] - G.y[E.a]) * t]; },
  _edgeYaw(e, dir) { const G = S.graph, E = G.edges[e]; return Math.atan2((G.x[E.b] - G.x[E.a]) * dir, (G.y[E.b] - G.y[E.a]) * dir); },

  // move `dist` metres along the paths from S.wk.on, heading as close to `yaw` as the network allows; returns metres moved
  _wkAlong(dist, yaw) {
    const w = S.wk, G = S.graph; let { e, t } = w.on;
    const hx = Math.sin(yaw), hy = Math.cos(yaw);
    let E = G.edges[e];
    let dir = (G.x[E.b] - G.x[E.a]) * hx + (G.y[E.b] - G.y[E.a]) * hy >= 0 ? 1 : -1;
    let left = dist, moved = 0;
    for (let guard = 0; left > 1e-6 && guard < 200; guard++) {
      E = G.edges[e];
      const len = Math.max(E.len, 1e-3), room = (dir > 0 ? 1 - t : t) * len;
      if (left < room) { t += (dir * left) / len; moved += left; left = 0; break; }
      left -= room; moved += room; t = dir > 0 ? 1 : 0;
      const node = dir > 0 ? E.b : E.a;
      let nb = null, bs = -Infinity;                 // junction: take the branch closest to where you look
      for (const a of G.adj[node]) {
        if (a.id === e) continue;
        const dx = G.x[a.to] - G.x[node], dy = G.y[a.to] - G.y[node], l = Math.hypot(dx, dy) || 1, sc = (dx * hx + dy * hy) / l;
        if (sc > bs) { bs = sc; nb = a; }
      }
      if (!nb) break;                                // dead end
      e = nb.id; dir = G.edges[e].a === node ? 1 : -1; t = dir > 0 ? 0 : 1;
    }
    [w.x, w.y] = this._edgePt(e, t);
    w.on = { e, t, dir, x: w.x, y: w.y };
    return moved;
  },

  // shortest walk along the network between two on-graph points (polyline), or null
  _graphPath(A, B, maxLen = 1200) {
    const G = S.graph;
    if (A.e === B.e) return this._poly([[A.x, A.y], [B.x, B.y]]);
    const EA = G.edges[A.e], EB = G.edges[B.e];
    const dist = new Map(), prev = new Map(), done = new Set(), h = new Heap();
    const seed = (v, d) => { if (d < (dist.get(v) ?? Infinity)) { dist.set(v, d); prev.set(v, -1); h.push(d, v); } };
    seed(EA.a, A.t * EA.len); seed(EA.b, (1 - A.t) * EA.len);
    const goal = new Map([[EB.a, B.t * EB.len], [EB.b, (1 - B.t) * EB.len]]);
    let best = Infinity, end = -1;
    while (h.size) {
      const u = h.pop(); if (done.has(u)) continue; done.add(u);
      const du = dist.get(u); if (du >= best || du > maxLen) break;
      if (goal.has(u) && du + goal.get(u) < best) { best = du + goal.get(u); end = u; }
      for (const a of G.adj[u]) {
        const nd = du + a.len;
        if (nd < (dist.get(a.to) ?? Infinity)) { dist.set(a.to, nd); prev.set(a.to, u); h.push(nd, a.to); }
      }
    }
    if (end < 0) return null;
    const nodes = []; for (let v = end; v !== -1; v = prev.get(v)) nodes.push(v); nodes.reverse();
    return this._poly([[A.x, A.y], ...nodes.map((v) => [G.x[v], G.y[v]]), [B.x, B.y]]);
  },

  _buildWalkUI() {
    const w = (S.wkEl = document.createElement('div')); w.className = 'map-wk'; w.hidden = true;
    w.innerHTML = `<div class="map-wk-bar">
        <span class="map-wk-tag">Light View</span>
        <button type="button" class="map-wk-btn map-wk-play" aria-pressed="false">Play</button>
        <span class="map-wk-rt" hidden>
          <button type="button" class="map-wk-btn map-wk-step" data-d="-1" aria-label="Step back along the route" title="Back (S)">◀</button>
          <button type="button" class="map-wk-btn map-wk-step" data-d="1" aria-label="Step forward along the route" title="Forward (W)">▶</button>
          <span class="map-wk-prog" aria-live="off"><span class="map-wk-pt">0 m</span><span class="map-wk-trk"><i></i></span></span>
        </span>
        <span class="map-wk-hint"></span>
      </div>
      <button type="button" class="map-wk-btn map-wk-x" aria-label="Exit Light View" title="Exit (Esc)">×</button>
      <div class="map-wk-msg" hidden></div>
      <div class="map-wk-side">
        <figure class="map-wk-ph">
          <button type="button" class="map-wk-img" aria-label="Enlarge photo"><img alt="" draggable="false"><span class="map-wk-none">No photo here</span><span class="map-wk-phl">Photos</span></button>
          <figcaption class="map-wk-cap">—</figcaption>
          <div class="map-wk-strip" role="group" aria-label="Neighbouring photos"></div>
        </figure>
        <div class="map-wk-mm"><canvas aria-label="Overview map — click to walk there"></canvas></div>
      </div>
      <div class="map-wk-lb" hidden><img alt=""><button type="button" class="map-wk-btn map-wk-lbx" aria-label="Close photo">×</button></div>`;
    S.el.appendChild(w);
    const q = (s) => w.querySelector(s);
    S.wkUI = { play: q('.map-wk-play'), x: q('.map-wk-x'), msg: q('.map-wk-msg'), ph: q('.map-wk-ph'), btn: q('.map-wk-img'), img: q('.map-wk-img img'),
      cap: q('.map-wk-cap'), strip: q('.map-wk-strip'), mm: q('.map-wk-mm canvas'), lb: q('.map-wk-lb'), lbImg: q('.map-wk-lb img'), hint: q('.map-wk-hint'),
      rt: q('.map-wk-rt'), pt: q('.map-wk-pt'), fill: q('.map-wk-trk i') };
    const u = S.wkUI;
    u.x.addEventListener('click', () => this._wkExit());
    u.play.addEventListener('click', () => { this._wkPlay(); S.renderer.domElement.focus({ preventScroll: true }); });   // keep Space from re-triggering the button
    w.querySelectorAll('.map-wk-step').forEach((b) => b.addEventListener('click', () => this._rtStep(+b.dataset.d)));
    u.img.addEventListener('error', () => { u.btn.classList.add('none'); });
    u.img.addEventListener('load', () => { u.btn.classList.remove('none'); });
    u.btn.addEventListener('click', () => {
      if (u.btn.classList.contains('none') || !S.wk || !S.wk.frame) return;
      u.lbImg.src = u.img.src; u.lb.hidden = false;
    });
    u.lb.addEventListener('click', () => { u.lb.hidden = true; });
    u.strip.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !S.wk || !S.wk.frame) return;
      const f = S.wk.frame.run[+b.dataset.k]; if (f) this._wkGo(f.x, f.y, f.h != null ? THREE.MathUtils.degToRad(f.h) : null, f);
    });
    u.mm.addEventListener('click', (e) => {
      if (!S.wk || !S.mm) return;
      const r = u.mm.getBoundingClientRect(), k = S.mm.ppm;   // css px per metre on the minimap
      this._wkGo(S.wk.x + (e.clientX - r.left - r.width / 2) / k, S.wk.y - (e.clientY - r.top - r.height / 2) / k, null);
    });
    // input on the main canvas in Light View
    const cv = S.renderer.domElement; let g = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!S.wk || S.wk.exiting) return;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: 0 };
      cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', (e) => {
      if (!S.wk || !g || e.pointerId !== g.id) return;
      const k = THREE.MathUtils.degToRad(S.camera.fov) / Math.max(1, S.H);   // one pixel ≈ one pixel of view
      S.wk.yaw -= (e.clientX - g.x) * k; S.wk.pitch = THREE.MathUtils.clamp(S.wk.pitch + (e.clientY - g.y) * k, -1.25, 1.25);
      g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.x0, e.clientY - g.y0)); g.x = e.clientX; g.y = e.clientY;
      S.wk.moved = true; S.wk.hold = performance.now() + 1600;   // looking around: don't steer the view for a moment
    });
    const up = (e) => {
      if (!S.wk || !g || e.pointerId !== g.id) return;
      const gg = g; g = null; cv.style.cursor = '';
      if (gg.moved > 4 || e.button > 0) return;
      const hit = this._ground(e.clientX, e.clientY);         // click: walk there along the paths
      if (hit && Math.hypot(hit.x - S.wk.x, hit.y - S.wk.y) > 0.5) this._wkGo(hit.x, hit.y, null);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { g = null; });
    cv.addEventListener('wheel', (e) => {
      if (!S.wk || S.wk.exiting) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const dy = THREE.MathUtils.clamp(e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1), -200, 200), step = -dy * 0.03;
      const w = S.wk, r = w.route;
      if (r) { r.playing = false; r.goal = THREE.MathUtils.clamp((r.goal ?? r.s) + step, 0, r.P.len); this._wkPlayUI(); }
      else { w.auto = false; w.go = null; w.push += step; this._wkPlayUI(); }
    }, { passive: false });
    const keyMap = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'tl', d: 'tr', arrowleft: 'tl', arrowright: 'tr', q: 'tl', e: 'tr' };
    document.addEventListener('keydown', (e) => {
      if (!S.wk || !S.visible || S.wk.exiting) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'Escape') { e.preventDefault(); if (!S.wkUI.lb.hidden) S.wkUI.lb.hidden = true; else this._wkExit(); return; }
      const k = keyMap[e.key.toLowerCase()];
      if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const w = S.wk;
      if (k === 'f' || k === 'b') { w.go = null; w.auto = false; if (w.route) { w.route.playing = false; w.route.goal = null; } this._wkPlayUI(); }
      w.keys.add(k); w.fast = e.shiftKey;
    }, true);
    document.addEventListener('keyup', (e) => {
      if (!S.wk) return;
      const k = keyMap[e.key.toLowerCase()]; if (k) S.wk.keys.delete(k);
      S.wk.fast = e.shiftKey;
    }, true);
    window.addEventListener('blur', () => { if (S.wk) S.wk.keys.clear(); });
  },

  _wkPose(x, y, yaw, pitch) {
    const p = new THREE.Vector3(x, EYE, -y);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, -yaw, 0, 'YXZ'));
    return { p, q };
  },

  // smooth camera move from the current pose to (p, q, fov); fn runs at the end
  _camTween(p1, q1, fov1, dur, fn) {
    const c = S.camera;
    S.camTw = { p0: c.position.clone(), q0: c.quaternion.clone(), f0: c.fov, p1, q1, f1: fov1, t0: performance.now(), dur, fn };
  },

  _setFov(f) {
    const c = S.camera; if (Math.abs(c.fov - f) < 1e-4) return;
    c.fov = f; c.updateProjectionMatrix();
    S.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(f) / 2)) / (S.H || 1);
  },

  // Fly through (auto) or Walk it (manual) along the planned best-lit route
  _rtView(fly) {
    const r = S.route; if (!r || !r.lit || r.lit.pts.length < 2) return;
    const P = this._poly(r.lit.pts); if (P.len < 1) return;
    const dur = THREE.MathUtils.clamp(P.len / 25, 25, 60);    // whole route in 25-60 s
    const route = { P, s: 0, goal: null, playing: fly, speed: P.len / dur, t0: performance.now() };
    this._wkEnter(P.pts[0][0], P.pts[0][1], this._polyYaw(P, 0), { route });
  },

  _wkEnter(x, y, yaw, o = {}) {
    if (S.wk && !S.wk.exiting) {
      if (o.route) { S.wk.route = o.route; S.wk.go = null; S.wk.auto = false; [S.wk.x, S.wk.y] = [x, y]; S.wk.yaw = yaw; S.wk.moved = true; this._wkGround(); this._wkMode(); }
      else this._wkGo(x, y, yaw);
      return;
    }
    if (S.wk && S.wk.exiting) { S.camTw = null; S.wk = null; }
    if (!S.wkEl) this._buildWalkUI();
    this._closePanel(); S.tip.hidden = true; S.pegNote.hidden = true;
    const c = S.controls; c.stop();
    let on = null;
    if (!o.route) { on = this._onGraph(x, y, 60); if (on) { x = on.x; y = on.y; } }   // stuck to the paths
    S.wk = { x, y, yaw: yaw || 0, pitch: -0.06, keys: new Set(), moved: true, frameT: 0, on, route: o.route || null, push: 0, auto: false, hold: 0,
      prev: { pc: !!S.on.pc, x: c.target.x, z: c.target.z, d: c.d, bearing: c.bearing, tilt: c.tilt, fov: S.camera.fov } };
    c.enabled = false;
    S.el.classList.add('wk'); S.wkEl.hidden = false;
    S.wkLayout = true; this._resize();   // 3D view shrinks to its 2/3; photo + minimap get the other third
    const u = S.wkUI;
    u.lb.hidden = true;
    this._wkGround();
    if (S.pcMeta) {
      S.on.pc = true; if (S.ck.pc) S.ck.pc.checked = true;
      this._pcToggle(true);
      u.msg.hidden = true;
    } else {
      u.msg.textContent = 'Point cloud not available yet — photos only'; u.msg.hidden = false;
      this._applyVis();
    }
    this._wkMode();
    this._mmBuild();
    const { p, q } = this._wkPose(S.wk.x, S.wk.y, S.wk.yaw, S.wk.pitch);
    S.wk.entering = true;
    this._camTween(p, q, WK_FOV, 1400, () => {
      if (!S.wk) return;
      S.wk.entering = false;
      if (S.wk.route) S.wk.route.t0 = performance.now();
    });
    this._wkPhoto(true);
    S.dirty = true; S.camMoved = true;
    setTimeout(() => S.renderer.domElement.focus({ preventScroll: true }), 0);
  },

  // bar contents for the current mode (free / route)
  _wkMode() {
    const w = S.wk, u = S.wkUI; if (!w || !u) return;
    u.hint.textContent = w.route ? 'Drag to look · ↑/↓ to move' : 'Drag to look · ↑/↓ to walk · ←/→ to turn · click a path';
    S.wkEl.classList.toggle('rt', !!w.route);
    this._wkPlayUI();
  },

  _wkPlayUI() {
    const w = S.wk, u = S.wkUI; if (!w || !u) return;
    const r = w.route, on = r ? !!r.playing : !!w.auto;
    const t = on ? 'Pause' : r && r.s >= r.P.len - 0.5 ? 'Replay' : 'Play';
    if (u.play.textContent !== t) u.play.textContent = t;
    u.play.setAttribute('aria-pressed', String(on));
    u.play.setAttribute('aria-label', r ? `${t} the fly-through` : `${t} walking along the path`);
    u.rt.hidden = !r;
    u.play.hidden = !r;   // Play/Pause only for route fly-throughs; pin-drop Light View is walk-only
    if (r) {
      const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
      const txt = `${r.s >= r.P.len - 0.5 ? km(r.P.len) : km(r.s)} of ${km(r.P.len)}`;
      if (u.pt.textContent !== txt) u.pt.textContent = txt;
      u.fill.style.width = `${((100 * r.s) / Math.max(1e-6, r.P.len)).toFixed(2)}%`;
    }
  },

  _wkExit() {
    const w = S.wk; if (!w || w.exiting) return;
    w.exiting = true; w.keys.clear(); w.go = null; w.auto = false;
    S.wkUI.lb.hidden = true; S.wkEl.hidden = true; S.el.classList.remove('wk');
    S.wkLayout = false; this._resize();
    if (S.nearHL) S.nearHL.visible = true;
    // restore the map camera exactly as it was
    const c = S.controls, cam = S.camera, pr = w.prev;
    const p0 = cam.position.clone(), q0 = cam.quaternion.clone(), f0 = cam.fov;
    this._setFov(pr.fov);
    c.target.set(pr.x, 0, pr.z); c.d = pr.d; c.bearing = pr.bearing; c.tilt = pr.tilt;
    c.minDistance = pr.pc ? 3 : 25; c.maxTilt = pr.pc ? 1.55 : MAX_TILT;
    c.update();
    const p1 = cam.position.clone(), q1 = cam.quaternion.clone();
    cam.position.copy(p0); cam.quaternion.copy(q0); this._setFov(f0); cam.updateMatrixWorld();
    this._camTween(p1, q1, pr.fov, 1100, () => {
      S.wk = null;
      S.on.pc = pr.pc; if (S.ck.pc) S.ck.pc.checked = pr.pc;
      c.enabled = true; c._last = ''; c.update();
      this._applyVis(); this._pegHighlight(false);
      S.camMoved = true; S.dirty = true;
    });
    this._applyVis();
  },

  // walk to (x, y) along the paths (route mode: to the nearest point of the route); yaw null = face the way you walk
  _wkGo(x, y, yaw, frame = null) {
    const w = S.wk; if (!w || w.exiting) return;
    if (frame) w.pin = frame;
    if (w.route) {
      const r = w.route, n = this._polyNear(r.P, x, y);
      if (n.d > 80) return;
      r.playing = false; r.goal = n.s; this._wkPlayUI();
      return;
    }
    const to = this._onGraph(x, y, 60);
    let P = null;
    if (to) {
      if (!w.on) w.on = this._onGraph(w.x, w.y, 60);
      if (w.on) P = this._graphPath(w.on, to, 1200);
      if (!P) P = this._poly([[w.x, w.y], [to.x, to.y]]);
    } else {
      if (S.graph) return;                         // nothing walkable there
      P = this._poly([[w.x, w.y], [x, y]]);        // no path network at all: glide freely
    }
    w.auto = false; w.push = 0; this._wkPlayUI();
    w.go = { P, to, t0: performance.now(), dur: THREE.MathUtils.clamp(P.len * 70, 350, 4500), y0: w.yaw, yaw, p0: w.pitch, frame };
    w.on = null;   // re-snapped on arrival (or wherever the glide is interrupted)
  },

  _wkPlay() {
    const w = S.wk; if (!w || w.exiting) return;
    const r = w.route;
    if (r) {
      if (!r.playing && r.s >= r.P.len - 0.5) { r.s = 0; r.goal = null; [w.x, w.y] = this._polyAt(r.P, 0); w.yaw = this._polyYaw(r.P, 0); w.moved = true; }
      r.playing = !r.playing; r.goal = null; r.t0 = performance.now();
    } else {
      w.go = null; w.keys.clear();
      if (!w.on) w.on = this._onGraph(w.x, w.y, 60);
      if (!w.on && !w.auto) { S.wkUI.hint.textContent = 'No walked path here to play'; return; }
      w.auto = !w.auto; w.autoT0 = performance.now();
    }
    this._wkPlayUI();
  },

  _rtStep(d) {
    const w = S.wk, r = w && w.route; if (!r) return;
    r.playing = false; r.goal = THREE.MathUtils.clamp((r.goal ?? r.s) + d * 15, 0, r.P.len);
    this._wkPlayUI();
  },

  // per frame in Light View: transitions, keys, glides, then minimap + photo
  _wkTick(now, dt) {
    const w = S.wk, cam = S.camera;
    if (S.camTw) {
      const t = S.camTw, k = easeIO(Math.min(1, (now - t.t0) / t.dur));
      cam.position.lerpVectors(t.p0, t.p1, k); cam.quaternion.slerpQuaternions(t.q0, t.q1, k);
      this._setFov(t.f0 + (t.f1 - t.f0) * k); cam.updateMatrixWorld();
      S.dirty = true; S.camMoved = true;
      if (k >= 1) { S.camTw = null; t.fn && t.fn(); }
      if (w && !w.exiting) this._wkHud(now);
      return;
    }
    if (!w || w.exiting) return;
    const sec = dt / 1000, K = w.keys, steer = (target, tau) => { if (now > (w.hold || 0)) w.yaw += wrapPi(target - w.yaw) * (1 - Math.exp(-dt / tau)); };
    const turn = (K.has('tr') ? 1 : 0) - (K.has('tl') ? 1 : 0);
    if (turn) { w.yaw += turn * 2.2 * sec; w.moved = true; w.hold = now + 900; }
    const fw = (K.has('f') ? 1 : 0) - (K.has('b') ? 1 : 0), v = w.fast ? 40 : 16;
    if (w.route) {
      const r = w.route, s0 = r.s;
      if (fw) { r.s += fw * v * sec; w.pin = null; }
      else if (r.goal != null) { const d = r.goal - r.s; r.s = Math.abs(d) < 0.05 ? r.goal : r.s + d * (1 - Math.exp(-dt / 260)); if (r.s === r.goal) r.goal = null; }
      else if (r.playing) r.s += r.speed * Math.min(1, (now - r.t0) / 1200) * sec;
      r.s = THREE.MathUtils.clamp(r.s, 0, r.P.len);
      if (r.playing && r.s >= r.P.len) r.playing = false;
      if (r.s !== s0) {
        [w.x, w.y] = this._polyAt(r.P, r.s);
        steer(this._polyYaw(r.P, r.s), r.playing ? 520 : 380);
        w.moved = true; this._wkPlayUI();
      }
    } else if (w.go) {
      const g = w.go, k = Math.min(1, (now - g.t0) / g.dur), e = easeIO(k), s = g.P.len * e;
      [w.x, w.y] = this._polyAt(g.P, s);
      if (g.yaw != null) w.yaw = g.y0 + wrapPi(g.yaw - g.y0) * e;
      else if (g.P.len > 2 && k < 1) steer(this._polyYaw(g.P, s), 300);
      if (g.frame) w.pitch = g.p0 + (-0.06 - g.p0) * e;
      if (k >= 1) { w.go = null; w.on = g.to ? { e: g.to.e, t: g.to.t, x: g.to.x, y: g.to.y } : null; }
      w.moved = true;
    } else {
      let dist = 0, back = false;
      if (fw) { dist = v * sec; back = fw < 0; }
      else if (w.auto) dist = 5 * Math.min(1, (now - w.autoT0) / 900) * sec;     // brisk walk
      if (w.push) {
        const take = Math.abs(w.push) < 0.05 ? w.push : w.push * (1 - Math.exp(-dt / 140)); w.push -= take;
        if (!dist) { dist = Math.abs(take); back = take < 0; }
      }
      if (dist > 0) {
        w.moved = true; if (fw) w.pin = null;
        if (!w.on && S.graph) w.on = this._onGraph(w.x, w.y, 60);
        if (w.on) {
          const moved = this._wkAlong(dist, back ? w.yaw + Math.PI : w.yaw);
          if (w.auto && moved < dist * 0.5) { w.auto = false; S.wkUI.hint.textContent = 'End of the path'; this._wkPlayUI(); }
          steer(this._edgeYaw(w.on.e, w.on.dir) + (back ? Math.PI : 0), 420);
        } else {   // no path network: free movement
          const sg = back ? -1 : 1; w.x += Math.sin(w.yaw) * dist * sg; w.y += Math.cos(w.yaw) * dist * sg;
        }
      }
    }
    if (w.moved) {
      const e = S.ext, pad = 400;
      w.x = THREE.MathUtils.clamp(w.x, e.x0 - pad, e.x1 + pad); w.y = THREE.MathUtils.clamp(w.y, e.y0 - pad, e.y1 + pad);
      const { p, q } = this._wkPose(w.x, w.y, w.yaw, w.pitch);
      cam.position.copy(p); cam.quaternion.copy(q); cam.updateMatrixWorld();
      S.dirty = true; S.camMoved = true;
      this._wkHud(now);
      w.moved = false;
    }
  },

  // streets on the ground beneath you + the planned route in white (Light View only)
  _wkGround() {
    const G = this._G();
    if (G && !S.wkStreets) {
      const grey = new THREE.Color(0.6, 0.62, 0.66), gapC = new THREE.Color(0.34, 0.35, 0.38);
      const segs = G.edges.map((E) => ({ a: [G.x[E.a], G.y[E.a]], b: [G.x[E.b], G.y[E.b]], c: E.gap ? gapC : grey }));
      S.wkStreets = ribbonLayer(segs, { width: 1.25, flat: 2, minPx: 0.55, fade: 0.7, opacity: 0.28, blending: THREE.NormalBlending, h: 0.08, order: 1 });
      S.wkStreets.visible = false; S.scene.add(S.wkStreets);
    }
    if (S.wkRoute) { S.scene.remove(S.wkRoute); S.wkRoute.geometry.dispose(); S.wkRoute.material.dispose(); S.wkRoute = null; }
    const w = S.wk, P = w && w.route ? w.route.P : S.routeOn && S.route && S.route.lit ? this._poly(S.route.lit.pts) : null;
    S.wkRouteP = P;
    if (P && P.pts.length > 1) {
      const white = new THREE.Color(0.95, 0.95, 0.95), segs = [];
      for (let i = 1; i < P.pts.length; i++) segs.push({ a: P.pts[i - 1], b: P.pts[i], c: white });
      S.wkRoute = ribbonLayer(segs, { width: 0.22, flat: 2, minPx: 1.1, fade: 0.25, opacity: 0.85, blending: THREE.NormalBlending, h: 0.12, order: 5 });
      S.wkRoute.visible = !!w; S.scene.add(S.wkRoute);
    }
    S.dirty = true;
  },

  _wkHud(now) {
    this._mmDraw();
    const w = S.wk; if (!w) return;
    if (now - (w.frameT || 0) > 140) { w.frameT = now; this._wkPhoto(); }
  },

  // nearest photo to the camera; frames facing the view direction win ties
  async _wkPhoto(force) {
    const w = S.wk; if (!w) return;
    const fr = await this._svFrames(); if (!S.wk) return;
    let f = w.pin && Math.hypot(w.pin.x - w.x, w.pin.y - w.y) < 15 ? w.pin : null;
    if (!f) {
      let best = null, bs = Infinity;
      const yawDeg = THREE.MathUtils.radToDeg(w.yaw);
      fr.grid.near(w.x, w.y, 40, (r) => {
        const d = Math.hypot(r.x - w.x, r.y - w.y); if (d > 40) return;
        const da = r.h == null ? 90 : Math.abs(((r.h - yawDeg) % 360 + 540) % 360 - 180);
        const sc = d + da * 0.12;
        if (sc < bs) { bs = sc; best = r; }
      });
      f = best;
    }
    if (f === w.frame && !force) return;
    w.frame = f;
    const u = S.wkUI;
    if (!f) {
      u.btn.classList.add('none'); u.img.removeAttribute('src'); u.cap.textContent = fr.n ? 'No photo within 40 m' : 'Photos not available yet';
      u.strip.innerHTML = ''; return;
    }
    const src = (r) => `${SV_BASE}${encodeURIComponent(r.s)}/${encodeURIComponent(r.i)}.jpg`;
    u.img.src = src(f);
    const wn = f.w != null && !Number.isNaN(+f.w) ? +f.w : +((/^W(\d+)/.exec(f.s) || [])[1] || 0);
    u.cap.textContent = [wn ? `Walker ${wn}` : null, f.t ? clock(f.t) : null, f.lux != null ? `${L.fmtLux(f.lux)} lux` : null].filter(Boolean).join(' · ') || '—';
    // 5 neighbouring frames from the same walk, spaced ~2 frames apart
    const run = f.run, ks = [];
    for (let o = -2; o <= 2; o++) { const k = f.k + o * 2; if (k >= 0 && k < run.length) ks.push(k); }
    u.strip.innerHTML = ks.map((k) => `<button type="button" data-k="${k}" class="${k === f.k ? 'on' : ''}" aria-label="Photo ${k + 1} of this walk"><img src="${src(run[k])}" alt="" loading="lazy" draggable="false" onerror="this.style.visibility='hidden'"></button>`).join('');
  },

  /* ---- minimap: north-up 2D render of buildings + walked paths (glow only) */
  _mmBuild() {
    if (S.mm) { this._mmSize(); return; }
    const e = S.ext, pad = 300;
    const x0 = e.x0 - pad, x1 = e.x1 + pad, y0 = e.y0 - pad, y1 = e.y1 + pad;
    const k = Math.min(1.6, 4096 / Math.max(x1 - x0, y1 - y0));
    const W = Math.ceil((x1 - x0) * k), H = Math.ceil((y1 - y0) * k);
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const g = off.getContext('2d');
    const X = (x) => (x - x0) * k, Y = (y) => (y1 - y) * k;
    g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#181b22'; g.strokeStyle = '#2b2f38'; g.lineWidth = 1;
    for (const f of S.data.blds) {
      const gm = f.geometry; if (!gm) continue;
      const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : [];
      for (const rings of polys) {
        g.beginPath();
        for (const r of rings) r.forEach((c, i) => { const [x, y] = L.toXY(c[1], c[0]); i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); });
        g.fill('evenodd'); g.stroke();
      }
    }
    g.lineCap = 'round';
    const lit = [];
    for (const f of S.data.path) {
      const gm = f.geometry; if (!gm) continue;
      const parts = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : [];
      const gl = L.glow(f.properties?.lux_median);
      for (const cs of parts) {
        g.beginPath();
        cs.forEach((c, i) => { const [x, y] = L.toXY(c[1], c[0]); i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); });
        if (gl < 0.05) { g.strokeStyle = 'rgba(120,124,132,.55)'; g.lineWidth = 1.2; g.stroke(); } else lit.push([cs, gl]);
      }
    }
    g.globalCompositeOperation = 'lighter';
    for (const pass of [[5, 0.18], [1.8, 0.95]]) {
      for (const [cs, gl] of lit) {
        g.beginPath();
        cs.forEach((c, i) => { const [x, y] = L.toXY(c[1], c[0]); i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); });
        g.strokeStyle = `rgba(255,226,170,${(pass[1] * (0.25 + 0.75 * gl)).toFixed(3)})`; g.lineWidth = pass[0]; g.stroke();
      }
    }
    g.globalCompositeOperation = 'source-over';
    S.mm = { off, k, x0, y1, cv: S.wkUI.mm, ctx: S.wkUI.mm.getContext('2d'), span: 340 };
    this._mmSize();
  },

  _mmSize() {
    const m = S.mm, cv = m.cv, r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    m.w = w; m.h = h; m.dpr = dpr; m.ppm = w / m.span;
  },

  _mmDraw() {
    const m = S.mm, w = S.wk; if (!m || !w) return;
    const br = m.cv.getBoundingClientRect();
    if (!m.w || Math.round(br.width) !== m.w || Math.round(br.height) !== m.h) this._mmSize();
    const g = m.ctx, ppm = m.ppm;
    g.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, m.w, m.h);
    const sw = m.w / ppm * m.k, sh = m.h / ppm * m.k;
    const sx = (w.x - m.x0) * m.k - sw / 2, sy = (m.y1 - w.y) * m.k - sh / 2;
    g.imageSmoothingEnabled = true;
    g.drawImage(m.off, sx, sy, sw, sh, 0, 0, m.w, m.h);
    const cx = m.w / 2, cy = m.h / 2;
    // planned route: white ahead, dimmed behind
    const P = S.wkRouteP;
    if (P && P.pts.length > 1) {
      const X = (x) => cx + (x - w.x) * ppm, Y = (y) => cy - (y - w.y) * ppm;
      const at = w.route ? w.route.s : 0, cut = w.route ? this._polyAt(P, at) : null;
      const line = (from, to, style, lw) => {
        g.beginPath(); let first = true;
        if (from > 0 && cut && style === 'a') { g.moveTo(X(cut[0]), Y(cut[1])); first = false; }
        for (let i = 0; i < P.pts.length; i++) {
          if (P.cum[i] < from || P.cum[i] > to) continue;
          const [x, y] = P.pts[i]; if (first) { g.moveTo(X(x), Y(y)); first = false; } else g.lineTo(X(x), Y(y));
        }
        if (to < P.len && cut) g.lineTo(X(cut[0]), Y(cut[1]));
        g.strokeStyle = style === 'a' ? 'rgba(242,242,242,.95)' : 'rgba(242,242,242,.3)'; g.lineWidth = lw; g.stroke();
      };
      g.lineJoin = 'miter'; g.lineCap = 'butt';
      if (w.route && at > 0) line(0, at, 'b', 2);
      line(w.route ? at : 0, P.len, 'a', 2);
      const end = P.pts[P.pts.length - 1], st = P.pts[0];
      g.fillStyle = '#f2f2f2'; g.fillRect(X(st[0]) - 3, Y(st[1]) - 3, 6, 6);
      g.fillStyle = '#ffe2aa'; g.fillRect(X(end[0]) - 3, Y(end[1]) - 3, 6, 6);
    }
    // view cone + position
    const a = w.yaw - Math.PI / 2;
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(S.camera.fov) / 2) * (S.W / Math.max(1, S.H)));
    const R = Math.max(46, Math.min(m.w, m.h) * 0.16);
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grd.addColorStop(0, 'rgba(242,242,242,.42)'); grd.addColorStop(1, 'rgba(242,242,242,0)');
    g.fillStyle = grd; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a - half, a + half); g.closePath(); g.fill();
    g.fillStyle = '#f2f2f2'; g.strokeStyle = '#08090b'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, 4.5, 0, TAU); g.fill(); g.stroke();
    // north tick
    g.fillStyle = '#8b9099'; g.font = '500 9px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('N', m.w - 10, 13);
  },

  /* ---------------------------------------------------------------- photo point cloud */
  _pcToggle(on) {
    if (on && !S.pcLoading && !S.pcPoints) this._pcLoad();
    this._applyVis();
  },

  async _pcLoad() {
    const meta = S.pcMeta, BPP = meta.bytes_per_point || 9, N = meta.points;
    S.pcLoading = true; S.pcChip.setAttribute('aria-busy', 'true');
    const pos = new Float32Array(N * 3), col = new Uint8Array(N * 3);
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3), ca = new THREE.BufferAttribute(col, 3, true);
    g.setAttribute('position', pa); g.setAttribute('color', ca); g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PC_VS, fragmentShader: PC_FS, transparent: true,   // fixed so the intro fade is a uniform, never a recompile
      uniforms: { uPx: S.uPx, uDpr: S.uDpr, uWorld: { value: 0.35 }, uExp: { value: 1.35 }, uOpacity: { value: 1 } },
    });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.visible = !!S.on.pc;
    S.pcPoints = pts; S.scene.add(pts);
    const mb = S.pcNote.textContent;
    const label = (t) => { S.pcNote.textContent = t; };
    let n = 0, uploaded = 0, lastUi = 0;
    const carry = new Uint8Array(BPP); let carryLen = 0;
    const put = (dv, o) => {   // one record at byte offset o of DataView dv
      if (n >= N) return;
      pos[n * 3] = dv.getInt16(o, true) * 0.1; pos[n * 3 + 1] = dv.getInt16(o + 4, true) * 0.1; pos[n * 3 + 2] = -dv.getInt16(o + 2, true) * 0.1;
      col[n * 3] = dv.getUint8(o + 6); col[n * 3 + 1] = dv.getUint8(o + 7); col[n * 3 + 2] = dv.getUint8(o + 8);
      n++;
    };
    const flush = () => {
      if (n === uploaded) return;
      pa.clearUpdateRanges?.(); ca.clearUpdateRanges?.();
      pa.addUpdateRange(uploaded * 3, (n - uploaded) * 3); ca.addUpdateRange(uploaded * 3, (n - uploaded) * 3);
      pa.needsUpdate = true; ca.needsUpdate = true; uploaded = n; g.setDrawRange(0, n); S.dirty = true;
    };
    try {
      const r = await fetch('data/pointcloud/campus.bin');
      if (!r.ok || !r.body) throw new Error(`campus.bin: ${r.status}`);
      const total = +r.headers.get('content-length') || N * BPP;
      const reader = r.body.getReader(); let got = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        got += value.length;
        let i = 0;
        if (carryLen) {   // finish a record split across chunks
          const need = Math.min(BPP - carryLen, value.length);
          carry.set(value.subarray(0, need), carryLen); carryLen += need; i = need;
          if (carryLen === BPP) { put(new DataView(carry.buffer), 0); carryLen = 0; }
        }
        const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
        const whole = i + Math.floor((value.length - i) / BPP) * BPP;
        for (let o = i; o < whole; o += BPP) put(dv, o);
        if (whole < value.length) { carry.set(value.subarray(whole)); carryLen = value.length - whole; }
        const now = performance.now();
        if (now - lastUi > 120 && !(S.intro && S.intro.phase === 'pull')) {   // upload in slices; never during the intro pull-up
          S.pcFrac = got / total;
          lastUi = now; flush(); label(`${Math.min(99, Math.round((got / total) * 100))}%`);
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      flush(); label(mb); S.pcFrac = 1;
    } catch (e) {
      console.warn('map: point cloud failed', e.message);
      label('unavailable'); S.pcChip.parentElement.title = 'Point cloud still processing';
    }
    S.pcChip.removeAttribute('aria-busy'); S.pcLoading = false;
  },

  /* ---------------------------------------------------------------- intro: logo over a short Light View fly-through, then pull up to the map */
  // Shown on a plain visit only (#map or no hash). ~3 s fly + ~2 s pull-up; any click / key / wheel skips.
  _introOverlay() {
    let bootHash = location.hash;   // only when the page was OPENED on the map (not on a later tab switch)
    try { const nav = performance.getEntriesByType('navigation')[0]; if (nav && nav.name) bootHash = new URL(nav.name).hash; } catch (e) { /* keep location.hash */ }
    if (!/^(#(map)?)?$/.test(bootHash) || !/^(#(map)?)?$/.test(location.hash)) return;
    const ov = document.createElement('div'); ov.className = 'map-intro'; ov.setAttribute('aria-hidden', 'true');
    ov.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;';
    // backdrop is its own layer so the dim / reveal is an opacity (compositor) transition, never a repaint
    ov.innerHTML = '<div class="map-intro-bg" style="position:absolute;inset:0;background:#08090b"></div><div class="map-intro-c"><img class="map-intro-logo" src="img/logo.svg" alt="" draggable="false" width="276" height="130" style="display:block;width:min(276px,58vw);height:auto;aspect-ratio:92.61/43.69"><div class="map-intro-bar"><i></i></div></div>';
    const st = document.createElement('style'); st.dataset.intro = '1';
    st.textContent = 'body.lux-intro .topbar{opacity:0;pointer-events:none}body.lux-intro-logo .topbar .logo{visibility:hidden}';
    document.head.appendChild(st); document.body.appendChild(ov); document.body.classList.add('lux-intro', 'lux-intro-logo');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    S.intro = { phase: 'wait', t0: performance.now(), ov, st, reduce, bg: ov.querySelector('.map-intro-bg'), logo: ov.querySelector('.map-intro-logo'), fill: ov.querySelector('.map-intro-bar i') };
  },

  _introStart() {
    const I = S.intro; if (!I) return;
    S.el.classList.add('intro');
    S.controls.enabled = false;
    I.prevPc = !!S.on.pc;
    I.skip = (e) => { if (e.type === 'keydown' && /^(Shift|Control|Alt|Meta)$/.test(e.key)) return; this._introEnd(true); };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((t) => window.addEventListener(t, I.skip, { capture: true, passive: true }));
    if (I.reduce) return;
    if (S.pcMeta) { S.on.pc = true; this._pcToggle(true); }
    const go = (f) => { if (S.intro !== I) return; I.path = this._introPath(f); this._prewarm(); };
    this._svFrames().then(go, () => go(null));
  },

  // While the logo + loading bar cover the canvas: build the Light View street ribbons, upload the light-map texture and
  // draw every layer once (all visible) so programs are compiled and all buffers are on the GPU before anything moves.
  _prewarm() {
    if (S.prewarmed || !S.renderer) return;
    S.prewarmed = true;
    const r = S.renderer, sc = S.scene, t0 = performance.now();
    this._wkGround();
    for (const m of S.layers.sim) if (m.material.uniforms.uTex) r.initTexture(m.material.uniforms.uTex.value);
    const vis = [];
    sc.traverse((o) => { if (o !== sc) { vis.push([o, o.visible]); o.visible = true; } });
    const pc = S.pcPoints, pv = pc && pc.material.uniforms.uOpacity.value;
    if (pc) pc.material.uniforms.uOpacity.value = 0.5;
    try { r.render(sc, S.camera); } catch (e) { /* ignore */ }
    if (pc) pc.material.uniforms.uOpacity.value = pv;
    vis.forEach(([o, v]) => { o.visible = v; });
    S.prewarmMs = performance.now() - t0; S.prewarmT = performance.now();
    S.dirty = true;
  },

  // the most interesting ~100 m of walked path: measured brightness + streetlights + photo density (≈ point-cloud density)
  _introPath(fr) {
    // owner's pick: the long bright straight walk on the north side of Simpson Drill Field (open sky, dense cloud, 18–39 lux)
    {
      const [ax, ay] = L.toXY(30.613568, -96.3437773), [bx, by] = L.toXY(30.6144863, -96.3424245);
      const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 5)), pts = [];
      for (let i = 0; i <= n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
      return this._poly(pts);
    }
    // eslint-disable-next-line no-unreachable
    const G = this._G(); if (!G || !G.edges.length) return null;
    const near = (x, y, r, t) => { let n = 0; S.pick.near(x, y, r, (it) => { if (it.t === t && Math.hypot(it.x - x, it.y - y) < r) n++; }); return n; };
    const ph = (x, y) => { if (!fr) return 0; let n = 0; fr.grid.near(x, y, 8, (r) => { if (Math.hypot(r.x - x, r.y - y) < 8) n++; }); return Math.min(12, n); };
    const sc = G.edges.map((E) => {
      if (E.gap) return -1;
      const mx = (G.x[E.a] + G.x[E.b]) / 2, my = (G.y[E.a] + G.y[E.b]) / 2;
      return E.len * (1.5 * (E.gl || 0) + 0.35 * Math.min(3, near(mx, my, 14, 'lamp')) + 0.08 * ph(mx, my));
    });
    const n = G.x.length, stepN = Math.max(1, Math.floor(n / 500));
    let best = null;
    for (let s0 = 0; s0 < n; s0 += stepN) {
      for (const first of G.adj[s0]) {
        if (first.gap) continue;
        let node = s0, e = first, len = 0, score = 0; const seen = new Set([s0]), pts = [[G.x[s0], G.y[s0]]];
        let dx = G.x[e.to] - G.x[node], dy = G.y[e.to] - G.y[node];
        for (let k = 0; k < 400 && e && len < 110; k++) {
          len += e.len; score += sc[e.id]; node = e.to; seen.add(node); pts.push([G.x[node], G.y[node]]);
          const l0 = Math.hypot(dx, dy) || 1; let nb = null, bs = 0.5;   // keep going straight-ish (within 60°)
          for (const a of G.adj[node]) {
            if (a.gap || a.id === e.id || seen.has(a.to)) continue;
            const ex = G.x[a.to] - G.x[node], ey = G.y[a.to] - G.y[node], s = (ex * dx + ey * dy) / (l0 * (Math.hypot(ex, ey) || 1));
            if (s > bs) { bs = s; nb = a; }
          }
          if (nb) { dx = G.x[nb.to] - G.x[node]; dy = G.y[nb.to] - G.y[node]; }
          e = nb;
        }
        if (len >= 80 && (!best || score > best.score)) best = { score, pts };
      }
    }
    return best ? this._poly(best.pts) : null;
  },

  _introTick(now) {
    const I = S.intro; if (!I) return;
    const el = now - I.t0;
    if (I.phase === 'wait') {
      const frac = S.pcMeta ? (S.pcPoints && !S.pcLoading ? 1 : S.pcFrac || 0) : 0;
      if (I.fill) I.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      if (I.reduce) { this._introFade(); return; }
      // always fly the owner's stretch: wait up to ~3 s for the point cloud, then fly anyway (points stream in)
      const ok = I.path && ((S.pcPoints && (frac >= 0.6 || !S.pcLoading)) || el > 3000);
      const warm = (S.prewarmT && now - S.prewarmT > 120) || el > 3600;
      if (ok && warm) this._introFly(now);
      else if (!I.path && el > 3500) this._introZoom(now);
      else if (el > 6000) this._introZoom(now);
    } else if (I.phase === 'fly') {
      const k = Math.min(1, (now - I.f0) / 3000), P = I.path, s = P.len * k;
      const [x, y] = this._polyAt(P, s), yaw = this._polyYaw(P, Math.min(s, P.len - 1));
      I.yaw = I.yaw == null ? yaw : I.yaw + wrapPi(yaw - I.yaw) * 0.12;
      const cam = S.camera; cam.position.set(x, 2.2, -y);
      cam.quaternion.setFromEuler(new THREE.Euler(-0.07, -I.yaw, 0, 'YXZ')); cam.updateMatrixWorld();
      S.dirty = true; S.camMoved = true;
      if (k >= 1) this._introPull(now);
    } else if (I.phase === 'pull') {
      // uniforms / material scalars only: no buffer writes, no program switches
      const k = Math.min(1, (now - I.p0) / 950), e = k * k * (3 - 2 * k), pc = S.pcPoints;
      if (pc && pc.visible && !I.prevPc) {
        const u = pc.material.uniforms.uOpacity; u.value = 1 - e;
        if (u.value < 0.03) pc.visible = false;               // nearly gone: stop drawing 270k+ points
      }
      const k2 = Math.min(1, (now - I.p0) / 1600), e2 = k2 * k2 * (3 - 2 * k2);
      if (I.bld) { S.bld.material.opacity = I.bld[0] + (I.bld[1] - I.bld[0]) * e2; S.bldEdges.material.opacity = I.bld[2] + (I.bld[3] - I.bld[2]) * e2; }
      for (const [u, g] of I.gains || []) u.value = g * e2;
      if (I.late && S.camera.position.y > 45) { I.late.forEach((o) => { o.visible = true; }); I.late = null; }
      S.dirty = true;
    } else if (I.phase === 'zoom' && now - I.p0 > 2050) this._introEnd(false);
  },

  _introFly(now) {
    const I = S.intro; I.phase = 'fly'; I.f0 = now;
    this._prewarm();
    S.introFly = true; this._wkGround(); this._applyVis(); this._setFov(WK_FOV);
    I.ov.classList.add('fly'); I.bg.style.opacity = '0.38';
  },

  // logo slides into its top-left spot while the map UI fades in
  _introLogo(dur) {
    const I = S.intro, tgt = document.querySelector('.topbar .logo'); if (!I || !I.logo) return;
    I.ov.classList.add('out'); I.bg.style.opacity = '0';
    if (tgt) {
      const a = I.logo.getBoundingClientRect(), b = tgt.getBoundingClientRect();
      if (a.width && b.width) {
        I.logo.style.transition = `transform ${dur}ms cubic-bezier(.65,0,.35,1)`;
        I.logo.style.transform = `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${b.top + b.height / 2 - (a.top + a.height / 2)}px) scale(${b.width / a.width})`;
      }
    }
    setTimeout(() => { if (S.intro === I) S.el.classList.remove('intro'); }, dur * 0.4);
    setTimeout(() => { if (S.intro === I) document.body.classList.remove('lux-intro'); }, dur * 0.55);
  },

  // the frame pose (normal map view) without moving the camera
  _framePose() {
    const cam = S.camera, p = cam.position.clone(), q = cam.quaternion.clone();
    this._frame();
    const out = { p: cam.position.clone(), q: cam.quaternion.clone() };
    cam.position.copy(p); cam.quaternion.copy(q); cam.updateMatrixWorld();
    return out;
  },

  _introPull(now) {
    const I = S.intro; I.phase = 'pull'; I.p0 = now;
    const cam = S.camera, cp = cam.position.clone(), cq = cam.quaternion.clone();   // _applyVis re-places the map camera: keep the eye-level pose
    const b0 = S.bld ? [S.bld.material.opacity, S.bldEdges.material.opacity] : null;
    // final map state right away (layers built + compiled during the fly); only uniforms animate from here on
    S.introFly = false; S.on.pc = I.prevPc; this._applyVis();
    if (b0) { I.bld = [b0[0], S.bld.material.opacity, b0[1], S.bldEdges.material.opacity]; S.bld.material.opacity = b0[0]; S.bldEdges.material.opacity = b0[1]; }
    I.gains = S.layers.sim.filter((m) => m.visible).map((m) => [m.material.uniforms.uGain, m.material.uniforms.uGain.value]);
    I.gains.forEach(([u]) => { u.value = 0; });
    // big additive glows (sim raster, halos, lamp pools) are pure overdraw at eye level: keep them off until the camera has risen
    I.late = [...S.layers.sim, ...S.layers.light.filter((m) => m.userData.halo), S.pools].filter((o) => o && o.visible);
    I.late.forEach((o) => { o.visible = false; });
    const pc = S.pcPoints;
    if (pc) { pc.material.depthWrite = false; pc.visible = true; S.camera.near = 0.4; S.camera.updateProjectionMatrix(); }   // GL state only
    cam.position.copy(cp); cam.quaternion.copy(cq); cam.updateMatrixWorld();
    const { p, q } = this._framePose();
    this._camTween(p, q, 40, 2000, () => this._introEnd(false));
    this._introLogo(2000);
  },

  // point cloud not ready in time: logo + zoom-out over the map
  _introZoom(now) {
    const I = S.intro; I.phase = 'zoom'; I.p0 = now;
    S.on.pc = I.prevPc; this._applyVis();
    const c = S.controls; this._frame();
    const d = c.d, b = c.bearing, t = c.tilt;
    c.d = d * 0.32; c.bearing = b - 0.45; c.tilt = Math.min(c.maxTilt, t + 0.25); c.update();
    c.enabled = true; c.animateTo({ d, bearing: b, tilt: t }, 2000);
    this._introLogo(2000);
  },

  // prefers-reduced-motion: logo fade only
  _introFade() {
    const I = S.intro; I.phase = 'fade';
    I.ov.style.transition = 'opacity .6s ease'; I.ov.style.opacity = '0';
    S.el.classList.remove('intro'); document.body.classList.remove('lux-intro');
    setTimeout(() => this._introEnd(false), 620);
  },

  _introEnd(skip) {
    const I = S.intro; if (!I) return;
    S.intro = null; S.introFly = false;
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((t) => window.removeEventListener(t, I.skip, { capture: true }));
    if (I.phase !== 'zoom' || skip) S.camTw = null;
    this._setFov(40);
    const c = S.controls;
    if (skip || I.phase !== 'zoom') this._frame();
    c.enabled = true;
    S.on.pc = I.prevPc;
    const pc = S.pcPoints;
    if (pc) { const m = pc.material; m.uniforms.uOpacity.value = 1; m.depthWrite = true; }
    if (I.gains) I.gains.forEach(([u, g]) => { u.value = g; });
    this._applyVis();
    S.el.classList.remove('intro'); document.body.classList.remove('lux-intro', 'lux-intro-logo');
    setTimeout(() => this._resize(), 300);   // full pixel ratio again once nothing is animating
    const ov = I.ov;
    if (skip) { ov.style.transition = 'opacity .25s ease'; ov.style.opacity = '0'; setTimeout(() => { ov.remove(); I.st.remove(); }, 260); }
    else { ov.remove(); I.st.remove(); }
    S.camMoved = true; S.dirty = true;
  },

  /* ---------------------------------------------------------------- camera */
  _resize() {
    const r = S.renderer; if (!r) return;
    const v = this._vp(), w = v.w, h = v.h;
    if (!w || !h) return;
    const cs = r.domElement.style;
    cs.left = `${v.x}px`; cs.top = `${v.y}px`;
    const dpr = Math.min(S.intro ? 1.5 : 2, window.devicePixelRatio || 1);   // capped while the intro animates
    const sz = r.getSize(new THREE.Vector2());
    if (r.getPixelRatio() !== dpr || sz.x !== w || sz.y !== h) { r.setPixelRatio(dpr); r.setSize(w, h, false); }   // setSize always reallocates the canvas
    r.domElement.style.width = `${w}px`; r.domElement.style.height = `${h}px`;
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
    S.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(S.camera.fov) / 2)) / h;
    S.uDpr.value = dpr; S.W = w; S.H = h; S.camMoved = true;
    if (S.mm && S.wk) { this._mmSize(); this._mmDraw(); }
    if (!S.framed) { this._frame(); }
    S.dirty = true;
  },

  // the 3D viewport inside the view: whole view, or in Light View the right 2/3 (phone portrait: the top 60 %)
  _vp() {
    const W = S.el.clientWidth || window.innerWidth, H = S.el.clientHeight || window.innerHeight;
    if (!S.wkLayout) return { x: 0, y: 0, w: W, h: H };
    if (W <= 760 && H >= W) return { x: 0, y: 0, w: W, h: Math.round(H * 0.6) };
    const x = Math.round(W / 3); return { x, y: 0, w: W - x, h: H };
  },

  _frame() {
    if (!S.controls || !S.ext) return;
    const e = S.ext, cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
    const w = e.x1 - e.x0, h = e.y1 - e.y0;
    const aspect = S.camera.aspect || 1.6, t = Math.tan(THREE.MathUtils.degToRad(S.camera.fov) / 2);
    const dist = Math.max((w * 0.92) / aspect, h * Math.cos(DEF_TILT) * 1.15) / (2 * t);
    const c = S.controls; c.stop();
    c.target.set(cx, 0, -cy); c.d = dist; c.bearing = 0; c.tilt = DEF_TILT;
    c.update();
    S.framed = !!S.el.clientWidth;
  },

  _flyTo(x, y, dist) {
    S.controls.animateTo({ x, z: -y, d: dist ?? Math.min(S.controls.d, 300) }, 1300);
  },

  _mark(x, y) {
    const a = S.flyMark.geometry.attributes.iPos; a.setXYZ(0, x, 0.3, -y); a.needsUpdate = true;
    S.flyMark.visible = true; S.flyUntil = performance.now() + 6000; S.dirty = true;
  },

  _loop(now) {
    S.raf = S.visible ? requestAnimationFrame(this._loop.bind(this)) : null;
    const dt = Math.min(64, now - (S.lastT || now)); S.lastT = now;
    if (S.flyMark.visible) {
      const left = S.flyUntil - now;
      S.flyMark.material.uniforms.uOpacity.value = Math.max(0, Math.min(0.9, left / 1500)) * (0.65 + 0.35 * Math.sin(now / 260));
      if (left <= 0) S.flyMark.visible = false; S.dirty = true;
    }
    S.controls.uPx = S.uPx.value;
    if (S.intro) this._introTick(now);
    if (S.wk || S.camTw) this._wkTick(now, dt);
    else S.controls.tick(now, dt);
    if (S.intro) { if (S.camMoved) { S.camMoved = false; S.lblPending = true; } }   // no label DOM work while the intro animates
    else if (S.camMoved || S.lblPending) { S.camMoved = false; S.lblPending = false; this._syncCtl(); this._layoutLabels(now); }
    else if (S.lblStale && now - S.lblT > 110) this._layoutLabels(now, true);
    if (S.dirty) {
      const dist = S.wk ? 30 : S.controls.d;
      S.scene.fog.near = Math.max(400, dist * 1.6); S.scene.fog.far = Math.max(2500, dist * 6);
      if (S.dashMats) S.dashMats.forEach((m) => (m.uniforms.uDash.value = Math.max(6, dist * S.uPx.value * 14)));
      S.renderer.render(S.scene, S.camera);
      S.dirty = false;
    }
  },

  /* ---------------------------------------------------------------- place labels */
  _buildLabels() {
    const items = [], byName = new Map();
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const add = (it) => {
      const k = it.name.toLowerCase(), o = byName.get(k);
      if (o && o.pri >= it.pri) return;
      if (o) items.splice(items.indexOf(o), 1);
      byName.set(k, it); items.push(it);
    };
    for (const f of S.data.blds) {
      const nm = f.properties && f.properties.name, g = f.geometry; if (!nm || !g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      let best = null;
      for (const rings of polys) {     // area centroid of the largest outer ring
        const pts = (rings[0] || []).map((c) => L.toXY(c[1], c[0])); let A = 0, cx = 0, cy = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const cr = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; A += cr; cx += (pts[j][0] + pts[i][0]) * cr; cy += (pts[j][1] + pts[i][1]) * cr;
        }
        if (Math.abs(A) < 1e-6) continue;
        const a = Math.abs(A / 2);
        if (!best || a > best.area) best = { area: a, x: cx / (3 * A), y: cy / (3 * A) };
      }
      if (!best) continue;
      const name = String(nm).replace(/\s+-\s+Dorm\s+\d+$/i, '').trim();
      add({ name, kind: 'bld', x: best.x, y: best.y, h: (f.properties.height_m || 10) + 0.5, area: best.area, r: Math.sqrt(best.area) / 2,
        pri: 1 + Math.min(0.9, best.area / 20000) });
    }
    for (const f of S.data.marks || []) {
      const p = f.properties || {}, g = f.geometry; if (!p.name || !g || g.type !== 'Point') continue;
      const [x, y] = L.toXY(g.coordinates[1], g.coordinates[0]);
      const kind = ['field', 'building', 'plaza', 'landmark'].includes(p.kind) ? p.kind : 'landmark';
      const name = String(p.name).trim();
      if (/^(lot \w+|golf lot)$/i.test(name) || name.length > 34) continue;     // parking lots + long historical-marker titles = clutter
      if (kind !== 'field' && kind !== 'plaza') {      // the same place already labelled from its footprint?
        const n = norm(name);
        if (items.some((o) => { const m = norm(o.name); return (m === n || m.includes(n) || n.includes(m)) && Math.hypot(o.x - x, o.y - y) < 120; })) continue;
      }
      add({ name, kind, x, y, h: kind === 'building' ? 10 : 0.5, r: 0, pri: { field: 4, plaza: 3, building: 1.5, landmark: 1.2 }[kind] });
    }
    S.lbl = items;
    const box = (S.lblBox = document.createElement('div')); box.className = 'map-labels'; box.setAttribute('aria-hidden', 'true');
    for (const it of items) {
      const e = document.createElement('div'); e.className = `map-lbl k-${it.kind}`; e.textContent = it.name;
      it.el = e; it.on = false; box.appendChild(e);
    }
    S.el.insertBefore(box, S.renderer.domElement.nextSibling);
    const measure = () => { for (const it of items) { it.w = it.el.offsetWidth; it.hgt = it.el.offsetHeight; } S.camMoved = true; };
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  },

  // project + greedy collision culling. Positions follow every camera change; the culling pass runs at most ~9×/s,
  // plus once after motion settles (lblStale).
  _layoutLabels(now, settle = false) {
    const items = S.lbl; if (!items || !items.length) return;
    const W = S.W, H = S.H, cam = S.camera, v = new THREE.Vector3();
    const show = !S.wk && cam.position.y > 14;   // no labels at eye level (they would pile up on the horizon)
    const cull = settle || !S.lblT || now - S.lblT > 110;
    for (const it of items) {
      v.set(it.x, it.h, -it.y).applyMatrix4(cam.matrixWorldInverse);
      const z = -v.z;
      if (!show || z <= 1) { it.vis = 0; it.sx = null; continue; }
      v.applyMatrix4(cam.projectionMatrix);
      it.sx = (v.x + 1) / 2 * W; it.sy = (1 - v.y) / 2 * H;
      const mpp = z * S.uPx.value;
      // zoom-dependent visibility: fields from afar, landmarks mid, buildings once they are big enough on screen
      let a;
      if (it.kind === 'bld') { const px = (2 * it.r) / mpp; a = THREE.MathUtils.smoothstep(px, 38, 56); }
      else { const lim = { field: 7, plaza: 3, building: 1.1, landmark: 0.85 }[it.kind]; a = 1 - THREE.MathUtils.smoothstep(mpp, lim * 0.8, lim); }
      if (it.sx < -100 || it.sx > W + 100 || it.sy < 58 || it.sy > H + 40) a = 0;
      it.vis = a;
    }
    if (cull) {
      S.lblT = now;
      const cand = items.filter((it) => it.vis > 0.05).sort((p, q) => (q.pri + (q.on ? 0.6 : 0)) - (p.pri + (p.on ? 0.6 : 0)));
      const placed = [];
      const pad = 6, er = S.el.getBoundingClientRect();
      for (const u of [S.layersEl, S.brEl, S.panel, S.rtEl]) {     // keep labels out from under the UI
        if (!u || u.hidden) continue; const r = u.getBoundingClientRect();
        if (r.width) placed.push([r.left - er.left, r.top - er.top, r.right - er.left, r.bottom - er.top]);
      }
      for (const it of items) it.keep = false;
      for (const it of cand) {
        const w = (it.w || it.name.length * 6.5) / 2 + pad, h = (it.hgt || 14) / 2 + pad;
        const r = [it.sx - w, it.sy - h, it.sx + w, it.sy + h];
        if (r[0] + pad < 2 || r[2] - pad > W - 2 || r[1] + pad < 58) continue;
        if (placed.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) continue;
        placed.push(r); it.keep = true;
      }
    }
    S.lblStale = !cull;
    for (const it of items) {
      const on = it.keep && it.vis > 0.05;
      if (on) {
        it.el.style.transform = `translate(${it.sx.toFixed(1)}px, ${it.sy.toFixed(1)}px) translate(-50%, -50%)`;
        it.el.style.opacity = it.vis.toFixed(2);
      } else if (it.on) it.el.style.opacity = '0';
      it.on = on;
    }
  },

  /* ---------------------------------------------------------------- picking */
  _ground(cx, cy) {
    const r = S.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, S.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, y: -hit.z, dist: hit.distanceTo(S.camera.position), sx: cx - r.left, sy: cy - r.top, rect: r };
  },

  _pick(cx, cy) {
    const g = this._ground(cx, cy); if (!g) return null;
    const mpp = g.dist * S.uPx.value;
    const rad = 24 * mpp + 16;
    const thr = { lamp: 14, warn: 11, path: 10, tree: 10, bld: 16 };
    S.on.always = true;
    const layerOf = { lamp: 'lamps', warn: 'warn', path: 'light', tree: 'trees', bld: 'always' };
    let best = null, bestS = 1;
    const v = new THREE.Vector3();
    S.pick.near(g.x, g.y, rad, (it) => {
      if (!S.on[layerOf[it.t]]) return;
      v.set(it.x, it.h || 0, -it.y).project(S.camera);
      if (v.z > 1) return;
      const px = ((v.x + 1) / 2) * g.rect.width, py = ((1 - v.y) / 2) * g.rect.height;
      const s = Math.hypot(px - g.sx, py - g.sy) / thr[it.t];
      if (s < bestS) { bestS = s; best = it; }
    });
    return best;
  },

  // hover text: only path light and warnings get one (level word + measured lux)
  _tipText(it) {
    const p = it.f.properties || {};
    if (it.t === 'warn') return p.lux_median != null ? `${L.fmtLux(p.lux_median)} lux` : '';
    if (it.t === 'path') return p.lux_median != null ? `${L.level(p.lux_median)} · ${L.fmtLux(p.lux_median)} lux` : (p.level || '');
    return '';
  },

  _bindPointer() {
    const cv = S.renderer.domElement, c = S.controls;
    cv.tabIndex = 0;
    cv.setAttribute('role', 'application'); cv.setAttribute('aria-roledescription', 'map');
    cv.setAttribute('aria-label', 'Three-dimensional map of measured night-time light on the Texas A&M campus. Drag to pan, scroll to zoom, right-drag to rotate and tilt; arrow keys pan, plus and minus zoom, Shift with arrows rotates and tilts.');
    const rel = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const ptrs = new Map();       // pointerId -> {x, y}
    let g = null;                 // current gesture
    let lastTap = null;
    const interact = () => { c.stop(); S.tip.hidden = true; };

    // ---- hover tooltips
    let pending = null;
    const hover = (e) => {
      pending = e;
      if (S.hoverRaf) return;
      S.hoverRaf = requestAnimationFrame(() => {
        S.hoverRaf = null; const ev = pending; if (!ev || !S.visible || g || S.wk) return;
        const it = this._pick(ev.clientX, ev.clientY);
        cv.style.cursor = S.routeOn && S.graph && S.rtPin != null ? 'crosshair' : it ? 'pointer' : '';
        let text = it ? this._tipText(it) : null;
        if (!it && S.on.sim) {
          const gr = this._ground(ev.clientX, ev.clientY);
          const lux = gr ? this._simLux(gr.x, gr.y) : null;
          if (lux != null) text = `${L.level(lux)} · ~${L.fmtLux(lux)} lux (simulated)`;
        }
        if (!text) { S.tip.hidden = true; return; }
        const r = S.el.getBoundingClientRect();
        S.tip.textContent = text; S.tip.hidden = false;
        let x = ev.clientX - r.left + 14; const y = ev.clientY - r.top + 16;
        const tw = S.tip.offsetWidth;
        if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 14;
        S.tip.style.left = `${x}px`; S.tip.style.top = `${y}px`;
      });
    };
    cv.addEventListener('pointerleave', () => { S.tip.hidden = true; pending = null; });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    const twoFinger = () => {
      const [a, b] = [...ptrs.values()];
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), a: { ...a }, b: { ...b } };
    };

    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      if (S.wk) return;
      const [x, y] = rel(e);
      ptrs.set(e.pointerId, { x, y });
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      interact();
      if (ptrs.size === 1) {
        const rot = e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey;
        g = { kind: rot ? 'rotate' : e.shiftKey ? 'tilt' : 'pan', id: e.pointerId, x0: x, y0: y, x, y, moved: 0, touch: e.pointerType === 'touch',
          samples: [], button: e.button, t0: performance.now() };
        if (g.kind === 'pan') cv.style.cursor = 'grabbing';
      } else if (ptrs.size === 2) {
        g = { kind: 'two', mode: null, last: twoFinger(), start: twoFinger(), moved: 99 };
      } else g = { kind: 'none', moved: 99 };
    });

    cv.addEventListener('pointermove', (e) => {
      if (S.wk) return;
      const p = ptrs.get(e.pointerId);
      if (!p) { if (!e.buttons) hover(e); return; }
      const [x, y] = rel(e);
      if (g && (g.kind === 'pan' || g.kind === 'rotate' || g.kind === 'tilt') && e.pointerId === g.id) {
        const dx = x - g.x, dy = y - g.y; g.moved = Math.max(g.moved, Math.hypot(x - g.x0, y - g.y0));
        if (g.moved > 4 || g.kind !== 'pan') {
          if (g.kind === 'pan') {
            const d = c.panPx(g.x, g.y, x, y), now = performance.now();
            g.samples.push({ t: now, dx: d.dx, dz: d.dz }); while (g.samples.length && now - g.samples[0].t > 100) g.samples.shift();
          } else if (g.kind === 'rotate') {
            c.bearing -= dx * 0.006; c.tilt -= dy * 0.006; c.update();
          } else { c.tilt -= dy * 0.006; c.update(); }
          g.x = x; g.y = y;
        }
        p.x = x; p.y = y; S.tip.hidden = true; return;
      }
      p.x = x; p.y = y;
      if (g && g.kind === 'two' && ptrs.size === 2) {
        const now = twoFinger(), last = g.last, st = g.start;
        if (!g.mode) {
          const da = { x: now.a.x - st.a.x, y: now.a.y - st.a.y }, db = { x: now.b.x - st.b.x, y: now.b.y - st.b.y };
          if (Math.hypot(da.x, da.y) + Math.hypot(db.x, db.y) > 14) {
            const vert = Math.abs(da.y) > 2 * Math.abs(da.x) && Math.abs(db.y) > 2 * Math.abs(db.x) && da.y * db.y > 0 && Math.abs(now.dist - st.dist) < 0.12 * st.dist;
            g.mode = vert ? 'tilt' : 'pinch';
          } else return;
        }
        if (g.mode === 'tilt') { c.tilt -= (now.cy - last.cy) * 0.006; c.update(); }
        else {
          c.panPx(last.cx, last.cy, now.cx, now.cy);
          const f = now.dist > 1 && last.dist > 1 ? last.dist / now.dist : 1;
          c.anchored(now.cx, now.cy, () => { c.d *= f; c.bearing -= wrapPi(now.ang - last.ang); });
        }
        g.last = now;
      }
    });

    const up = (e, cancel) => {
      if (!ptrs.has(e.pointerId)) return;
      const [x, y] = rel(e);
      ptrs.delete(e.pointerId);
      const gg = g;
      if (gg && gg.kind === 'two') {
        // lifting one finger of a pinch: carry on panning with the other, no click
        if (ptrs.size === 1) { const [id, p] = [...ptrs.entries()][0]; g = { kind: 'pan', id, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: 99, samples: [], touch: true }; }
        else g = null;
        return;
      }
      if (ptrs.size) return;
      g = null; cv.style.cursor = '';
      if (!gg || cancel) return;
      if (gg.kind === 'pan' && gg.moved > 4) {          // inertia from the last ~100 ms of motion
        const now = performance.now(), sm = gg.samples;
        if (sm.length >= 2 && now - sm[sm.length - 1].t < 50) {
          const span = Math.max(16, now - sm[0].t);
          let sx = 0, sz = 0; sm.forEach((s) => { sx += s.dx; sz += s.dz; });
          c.vel = { x: sx / span, z: sz / span };
          const pxms = Math.hypot(c.vel.x, c.vel.z) / (c.d * c.uPx);
          if (pxms > 4) { c.vel.x *= 4 / pxms; c.vel.z *= 4 / pxms; }
        }
        return;
      }
      if (gg.moved > 4 || gg.kind !== 'pan' || gg.button > 0) return;   // a drag is never a click
      // tap / click
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 24) {
        lastTap = null;
        if (gg.touch) c.zoomBy(0.5, x, y);               // double-tap zoom (mouse uses dblclick)
        return;
      }
      lastTap = { t: now, x, y };
      this._click(e.clientX, e.clientY);
    };
    cv.addEventListener('pointerup', (e) => up(e, false));
    cv.addEventListener('pointercancel', (e) => up(e, true));

    cv.addEventListener('dblclick', (e) => {
      e.preventDefault(); if (S.wk) return; interact();
      const [x, y] = rel(e);
      c.zoomBy(e.altKey || e.shiftKey ? 2 : 0.5, x, y);
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (S.wk) return;
      c.anim = null; c.vel = null;
      const [x, y] = rel(e);
      let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      dy = THREE.MathUtils.clamp(dy, -240, 240);
      c.zoomBy(Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0022)), x, y);
      S.tip.hidden = true;
    }, { passive: false });

    cv.addEventListener('keydown', (e) => {
      if (S.wk) return;
      const k = e.key; let used = true;
      const pan = (fx, fy) => {   // screen-direction nudge with inertia
        c.anim = null; c.zoom = null;
        const mpp = c.d * c.uPx, cb = Math.cos(c.bearing), sb = Math.sin(c.bearing), v = 0.9 * mpp;   // ~0.9 px/ms
        const sx = fx * v, sy = fy * v / Math.max(0.35, Math.cos(c.tilt));
        c.vel = { x: cb * sx + sb * sy, z: sb * sx - cb * sy };
      };
      if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) c.animateTo({ bearing: c.bearing + (k === 'ArrowLeft' ? -1 : 1) * Math.PI / 12 }, 280);
      else if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) c.animateTo({ tilt: c.tilt + (k === 'ArrowUp' ? 1 : -1) * Math.PI / 18 }, 280);
      else if (k === 'ArrowLeft') pan(-1, 0);
      else if (k === 'ArrowRight') pan(1, 0);
      else if (k === 'ArrowUp') pan(0, 1);
      else if (k === 'ArrowDown') pan(0, -1);
      else if (k === '+' || k === '=') c.zoomBy(0.6, S.W / 2, S.H / 2);
      else if (k === '-' || k === '_') c.zoomBy(1 / 0.6, S.W / 2, S.H / 2);
      else used = false;
      if (used) e.preventDefault();
    });
  },

  _click(cx, cy) {
    if (S.routeOn && S.graph && S.rtPin != null) { this._routeClick(cx, cy); return; }
    const it = this._pick(cx, cy);
    if (S.tip) S.tip.hidden = true;
    if (it) this._openPanel(it); else this._closePanel();
  },

  /* ---------------------------------------------------------------- panel */
  _closePanel() {
    if (S.panel) S.panel.hidden = true;
    S.camMoved = true;
    if (S.selMark) { S.selMark.visible = false; S.dirty = true; }
  },

  async _openPanel(it) {
    const p = it.f.properties || {};
    const a = S.selMark.geometry.attributes.iPos; a.setXYZ(0, it.x, 0.3, -it.y); a.needsUpdate = true;
    S.selMark.geometry.attributes.iSize.setX(0, it.t === 'lamp' ? 7 : 5); S.selMark.geometry.attributes.iSize.needsUpdate = true;
    S.selMark.visible = true; S.dirty = true;
    const row = (k, v) => (v == null || v === '' ? '' : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
    let html = '', photos = false;   // 'Photos nearby' removed on request
    const lw = (ws) => (Array.isArray(ws) && ws.length ? ws.map((w) => `W${w}`).join(', ') : null);
    const head = (lux, label) => `<div class="label">${label}</div>
        <div class="map-big"><span class="big">${L.fmtLux(lux)}</span> lux</div>
        <div class="map-lvl"><i class="map-swatch" style="--g:${L.glow(lux).toFixed(2)}"></i>${esc(L.level(lux))}</div>`;
    if (it.t === 'path') {
      html = `${head(p.lux_median, 'Measured')}
        <dl class="map-dl">${row('Length', it.kind === 'stretch' && it.len ? `${Math.round(it.len)} m` : null)}${row('Path', esc(p.name || '') || null)}
          ${row('Minimum', p.lux_min != null ? `${L.fmtLux(p.lux_min)} lux` : null)}${row('Walkers', lw(p.walkers))}</dl>`;
    } else if (it.t === 'warn') {
      html = `${head(p.lux_median, '<svg class="map-tri" viewBox="0 0 12 11" aria-hidden="true"><path d="M6 1.4 10.9 10.2H1.1z"/></svg> Low light')}
        <dl class="map-dl">${row('Length', p.length_m != null ? `${Math.round(p.length_m)} m` : null)}${row('Path', esc(p.path || '') || null)}${row('Severity', esc(p.severity || '') || null)}</dl>`;
    } else if (it.t === 'lamp') {
      html = `<div class="label">Streetlight</div>
        <div class="map-h">${p.height_m != null ? `${p.height_m.toFixed(1)} m` : 'Streetlight'}</div>
        <dl class="map-dl">${row('Type', esc(p.light_type || '') || null)}${row('Colour', p.cct_k ? `${Math.round(p.cct_k).toLocaleString()} K` : null)}
          ${row('Beneath', p.lux_near != null ? `${L.fmtLux(p.lux_near)} lux` : null)}${row('Reach', p.reach_m != null && p.reach_m >= 1 ? `~${Math.round(p.reach_m)} m` : null)}
          ${row('Confidence', p.confidence != null ? pct(p.confidence) : null)}</dl>`;
    } else if (it.t === 'tree') {
      html = `<div class="label">Tree</div><div class="map-h">${p.height_m ? `${Math.round(p.height_m)} m` : 'Tree'}</div>
        <dl class="map-dl">${row('Crown', p.crown_radius_m ? `${Math.round(p.crown_radius_m * 2)} m` : null)}</dl>`;
    } else if (it.t === 'bld') {
      html = `<div class="label">Building</div><div class="map-h">${esc(p.name)}</div><dl class="map-dl">${row('Height', p.height_m ? `${Math.round(p.height_m)} m` : null)}</dl>`;
    }
    S.panel.innerHTML = `<button class="map-close" type="button" aria-label="Close details">×</button>${html}${photos ? '<div class="map-photos"><div class="label">Photos nearby</div><div class="map-ph-list muted">…</div></div>' : ''}`;
    S.panel.hidden = false; S.camMoved = true;
    if (S.W <= 760 && S.setLayersOpen) S.setLayersOpen(false);
    S.panel.querySelector('.map-close').addEventListener('click', () => this._closePanel());
    S.panel.scrollTop = 0;
    if (photos) {
      const tok = (S.panelTok = (S.panelTok || 0) + 1);
      const list = await this._photosNear(it.x, it.y, 25, 4);
      if (tok !== S.panelTok) return;
      const box = S.panel.querySelector('.map-ph-list');
      if (!box) return;
      if (!list) { box.textContent = 'Unavailable'; return; }
      if (!list.length) { box.textContent = 'None within 25 m'; return; }
      box.classList.remove('muted');
      box.innerHTML = list.map(({ r, d }, i) => `<button type="button" class="map-ph" data-i="${i}">
          <span>${r.epoch ? clock(r.epoch) : '—'}${r.heading_deg != null ? ` · ${compass(r.heading_deg)}` : ''}</span>
          <span class="muted">${Math.round(d)} m</span></button>`).join('')
        + `<button type="button" class="btn primary map-walk">Light View here</button>`;
      const go = async (r) => {
        const fr = await this._svFrames(), run = fr.sess.get(r.session), f = run && run.find((q) => q.i === r.index);
        if (f) this._wkEnter(f.x, f.y, f.h != null ? THREE.MathUtils.degToRad(f.h) : this._pathHeading(f.x, f.y));
        else this._wkEnter(r._x, r._y, r.heading_deg != null ? THREE.MathUtils.degToRad(r.heading_deg) : this._pathHeading(r._x, r._y));
      };
      box.querySelectorAll('.map-ph').forEach((b) => b.addEventListener('click', () => go(list[+b.dataset.i].r)));
      box.querySelector('.map-walk').addEventListener('click', () => go(list[0].r));
    }
  },

  async _photosNear(x, y, r, n) {
    if (!S.photoGrid) {
      S.photoGrid = (async () => {
        try {
          const rows = await L.load('photos_index.csv');
          const g = new Grid(25);
          for (const row of rows) {
            if (row.lat == null || row.lon == null) continue;
            const [px, py] = L.toXY(row.lat, row.lon); row._x = px; row._y = py; g.add(px, py, row);
          }
          return g;
        } catch (e) { console.warn('map: photos_index unavailable', e.message); return null; }
      })();
    }
    const g = await S.photoGrid; if (!g) return null;
    const out = [];
    g.near(x, y, r, (row) => { const d = Math.hypot(row._x - x, row._y - y); if (d <= r) out.push({ r: row, d }); });
    out.sort((a, b) => a.d - b.d);
    // prefer distinct moments: skip photos within 12 s of an already chosen one from the same session
    const pick = [];
    for (const o of out) {
      if (pick.some((p) => p.r.session === o.r.session && Math.abs((p.r.epoch || 0) - (o.r.epoch || 0)) < 12)) continue;
      pick.push(o); if (pick.length >= n) break;
    }
    return pick;
  },

  /* ---------------------------------------------------------------- live MongoDB hooks (all optional) */
  _lineItem(it, i, list, extra = '') {
    let nm = it.name;
    if (!nm) {   // unnamed footpath: name it after the nearest building / field
      const c = it.lat != null ? [it.lat, it.lon] : (it.coords && it.coords.length ? [it.coords[0][1], it.coords[0][0]] : null);
      if (c) { const [x, y] = L.toXY(c[0], c[1]); const pn = this._placeName(x, y); if (pn !== 'Dropped pin') nm = `Path ${pn.toLowerCase().startsWith('near') ? pn.replace(/^Near/, 'near') : pn}`; }
    }
    return `<button type="button" class="map-live-i" data-i="${i}" data-l="${list}"><span>${esc(nm || 'Footpath')}</span><span class="muted">${L.fmtLux(it.lux_median)} lux${extra}</span></button>`;
  },

  async _liveStats() {
    const j = await api('/api/stats');
    const lv = S.liveEl; if (!lv) return;
    if (!j || typeof j.share_below_5 !== 'number') { lv.hidden = true; return; }
    const parts = [`${pct(j.share_below_5)} of paths below ${GUIDE_LUX} lux`];
    if (j.median_lux != null) parts.push(`median ${L.fmtLux(j.median_lux)} lux`);
    lv.querySelector('.map-live-s').textContent = parts.join(' · ');
    const dk = (Array.isArray(j.darkest) ? j.darkest : []).filter((d) => d && (d.lat != null || (d.coords && d.coords.length))).slice(0, 5);
    S.darkItems = dk; S.liveItems = [...dk, ...(S.nearItems || [])];
    lv.querySelector('.map-live-k').hidden = !dk.length;
    lv.querySelector('.map-live-l').innerHTML = dk.map((d, i) => this._lineItem(d, i, 'dark')).join('');
    lv.hidden = false;
  },

  // centre (local metres) of a stretch from the API
  _liveXY(it) {
    if (it.lat != null && it.lon != null) return L.toXY(it.lat, it.lon);
    const c = it.coords[Math.floor(it.coords.length / 2)]; return L.toXY(c[1], c[0]);
  },

  _liveFly(it, all) {
    if (S.wk) return;
    const [x, y] = this._liveXY(it);
    this._liveHL(all || [it]);
    this._flyTo(x, y, 320); this._mark(x, y);
  },

  // white hairline over API stretches (no colour scale)
  _liveHL(items) {
    if (S.nearHL) { S.scene.remove(S.nearHL); S.nearHL.geometry.dispose(); S.nearHL.material.dispose(); S.nearHL = null; }
    const segs = [];
    for (const it of items || []) {
      const cs = Array.isArray(it.coords) ? it.coords : [];
      for (let i = 1; i < cs.length; i++) segs.push({ a: L.toXY(cs[i - 1][1], cs[i - 1][0]), b: L.toXY(cs[i][1], cs[i][0]), c: new THREE.Color(0.95, 0.95, 0.95) });
    }
    if (!segs.length) { S.dirty = true; return; }
    S.nearHL = ribbonLayer(segs, { width: 1.6, flat: 1, minPx: 2.2, opacity: 0.95, blending: THREE.NormalBlending, h: 0.7, order: 12 });
    S.scene.add(S.nearHL); S.dirty = true;
  },

  async _nearMe() {
    const lv = S.liveEl, box = lv.querySelector('.map-near-l'), btn = lv.querySelector('.map-near');
    btn.disabled = true; btn.textContent = 'Locating…';
    const e = S.ext, pad = 600;
    const pos = await new Promise((res) => {
      if (!navigator.geolocation) { res(null); return; }
      const t = setTimeout(() => res(null), 6000);
      navigator.geolocation.getCurrentPosition((p) => { clearTimeout(t); res(p.coords); }, () => { clearTimeout(t); res(null); }, { timeout: 5500, maximumAge: 60000 });
    });
    let lat, lon, here = false;
    if (pos) {
      const [x, y] = L.toXY(pos.latitude, pos.longitude);
      if (x > e.x0 - pad && x < e.x1 + pad && y > e.y0 - pad && y < e.y1 + pad) { lat = pos.latitude; lon = pos.longitude; here = true; }
    }
    if (!here) { const t = S.controls.target; [lat, lon] = L.toLL(t.x, -t.z); }
    btn.textContent = 'Near me';
    const j = await api(`/api/near?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&r=200`);
    btn.disabled = false;
    const list = j && Array.isArray(j.stretches) ? j.stretches.filter((d) => d && ((d.coords && d.coords.length) || d.lat != null)) : [];
    if (!j) { box.innerHTML = ''; this._liveHL(null); return; }
    list.sort((a, b) => (a.lux_median ?? 1e9) - (b.lux_median ?? 1e9));
    const top = list.slice(0, 3);
    S.nearItems = top;
    const off = (S.darkItems || []).length;
    S.liveItems = [...(S.darkItems || []), ...top];
    const head = `<div class="map-live-k">${here ? 'Darkest near you' : 'Darkest near map centre'}${typeof j.share_below_5 === 'number' ? ` · ${pct(j.share_below_5)} below ${GUIDE_LUX} lux` : ''}</div>`;
    box.innerHTML = top.length ? head + top.map((d, i) => this._lineItem(d, off + i, 'near', d.dist_m != null ? ` · ${Math.round(d.dist_m)} m` : '')).join('')
      : `<div class="map-live-k">Nothing measured within 200 m</div>`;
    this._liveHL(top);
    const [x, y] = L.toXY(lat, lon);
    if (here) this._mark(x, y);
    if (top.length) this._flyTo(x, y, Math.max(380, Math.min(S.controls.d, 700)));
  },

  async _routeScore(pts) {
    const tok = (S.rtTok = (S.rtTok || 0) + 1);
    const coords = pts.map(([x, y]) => { const [la, lo] = L.toLL(x, y); return [+lo.toFixed(7), +la.toFixed(7)]; });
    const j = await api('/api/route-score', { coords });
    if (tok !== S.rtTok || !S.route || !j || j.median_lux == null) return;
    const bits = [`Median ${L.fmtLux(j.median_lux)} lux`];
    if (typeof j.share_below_5 === 'number') bits.push(`${pct(j.share_below_5)} below ${GUIDE_LUX} lux`);
    const dk = j.darkest && j.darkest.lux != null ? j.darkest.lux : j.min_lux;
    if (dk != null) bits.push(`darkest ${L.fmtLux(dk)} lux`);
    S.route.live = bits.join(' · ');
    this._routeUI();
  },

  /* ---------------------------------------------------------------- route planner */
  _routeMode(on) {
    S.routeOn = on;
    S.layers.route.forEach((o) => (o.visible = on));
    if (!on) { S.renderer.domElement.style.cursor = ''; S.dirty = true; return; }
    if (S.graph === undefined) S.graph = this._buildGraph();
    this._closePanel();
    this._routeUI();
  },

  // inputs, pin buttons, route summary and the hint line
  _routeUI(msg) {
    const box = S.routeBox; if (!box) return;
    const G = S.graph;
    if (!G) {
      box.querySelector('.map-rt-ends').hidden = true; box.querySelector('.map-rt-res').innerHTML = ''; box.querySelector('.map-rt-go').hidden = true;
      box.querySelector('.map-rt-msg').textContent = 'No mapped paths yet';
      return;
    }
    S.rtIn.forEach((inp, k) => {
      if (document.activeElement !== inp) inp.value = S.rtPts[k] == null ? '' : (S.rtLbl[k] || this._placeName(G.x[S.rtPts[k]], G.y[S.rtPts[k]]));
    });
    box.querySelectorAll('.map-rt-pin').forEach((b) => b.setAttribute('aria-pressed', String(S.rtPin === +b.dataset.end)));
    box.querySelectorAll('.map-rt-f').forEach((f) => f.classList.toggle('pin', S.rtPin === +f.dataset.end));
    const r = S.route, res = box.querySelector('.map-rt-res');
    const lv = r && r.live;
    const mins = (m) => `${Math.max(1, Math.round(m / 1.35 / 60))} min`;   // ~1.35 m/s walking
    res.innerHTML = r ? `<div class="map-rt-opt lit"><i class="map-ln"></i><span class="map-rt-on">Best-lit</span><span class="map-rt-t">${mins(r.lit.len)}</span>
          <span class="map-rt-d">${fmtM(r.lit.len)} · ${pct(r.lit.dark)} dark</span></div>
        <div class="map-rt-opt"><i class="map-ln short"></i><span class="map-rt-on">Shortest</span><span class="map-rt-t">${mins(r.short.len)}</span>
          <span class="map-rt-d">${fmtM(r.short.len)} · ${pct(r.short.dark)} dark</span></div>
        ${lv ? `<div class="map-rt-live">${esc(lv)}</div>` : ''}` : '';
    const nm = (k) => (k ? 'To' : 'From');
    box.querySelector('.map-rt-msg').textContent = msg ?? (S.rtPin != null ? `Click the map to set ${nm(S.rtPin)}` : r ? `Dark = under ${GUIDE_LUX} lux` : '');
    box.querySelector('.map-rt-go').hidden = !r;
    S.renderer.domElement.style.cursor = S.rtPin != null ? 'crosshair' : '';
  },

  // nearest labelled place, for endpoints picked on the map
  _placeName(x, y) {
    let best = null, bd = 140;
    for (const it of S.lbl || []) { const d = Math.hypot(it.x - x, it.y - y) - (it.r || 0); if (d < bd) { bd = d; best = it; } }
    return best ? `Near ${best.name}` : 'Dropped pin';
  },

  /* ---- route search: campus places (landmarks, buildings, named paths), My location, OpenStreetMap addresses */
  _rtIndex() {
    if (S.rtIdx) return S.rtIdx;
    const out = [], seen = new Map();
    const add = (name, kind, x, y, pri) => {
      name = String(name).replace(/\s+-\s+Dorm\s+\d+$/i, '').trim(); if (!name) return;
      const lc = name.toLowerCase(), o = seen.get(lc);
      if (o && o.pri >= pri) return;
      const it = { name, kind, x, y, pri, lc, words: lc.split(/[^a-z0-9&']+/).filter(Boolean) };
      if (o) out[out.indexOf(o)] = it; else out.push(it);
      seen.set(lc, it);
    };
    for (const f of S.data.blds) {
      const nm = f.properties && f.properties.name, g = f.geometry; if (!nm || !g) continue;
      const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null); if (!ring || !ring.length) continue;
      let sx = 0, sy = 0; ring.forEach((c) => { const [x, y] = L.toXY(c[1], c[0]); sx += x; sy += y; });
      add(nm, 'Building', sx / ring.length, sy / ring.length, 3);
    }
    const kinds = { field: 'Field', plaza: 'Plaza', building: 'Building', landmark: 'Landmark' };
    for (const f of S.data.marks || []) {
      const p = f.properties || {}, g = f.geometry; if (!p.name || !g || g.type !== 'Point') continue;
      const [x, y] = L.toXY(g.coordinates[1], g.coordinates[0]);
      add(p.name, /^(lot \w+|golf lot)$/i.test(p.name) ? 'Parking' : kinds[p.kind] || 'Landmark', x, y, p.kind === 'field' ? 4 : 2);
    }
    const byName = new Map();   // named paths / streets: the vertex nearest the middle of all their stretches
    for (const f of S.data.path) {
      const p = f.properties || {}, g = f.geometry; if (!p.name || !g || g.type !== 'LineString') continue;
      let a = byName.get(p.name); if (!a) byName.set(p.name, (a = { pts: [], type: p.path_type }));
      for (const c of g.coordinates) a.pts.push(L.toXY(c[1], c[0]));
    }
    for (const [nm, a] of byName) {
      let mx = 0, my = 0; a.pts.forEach(([x, y]) => { mx += x; my += y; }); mx /= a.pts.length; my /= a.pts.length;
      let best = a.pts[0], bd = Infinity; for (const q of a.pts) { const d = Math.hypot(q[0] - mx, q[1] - my); if (d < bd) { bd = d; best = q; } }
      add(nm, /road|street|boulevard|drive|avenue|lane|parkway/i.test(nm) ? 'Street' : 'Path', best[0], best[1], 1);
    }
    return (S.rtIdx = out);
  },

  _rtMatch(q) {
    const ql = q.trim().toLowerCase(); if (!ql) return [];
    const toks = ql.split(/[^a-z0-9&']+/).filter(Boolean);
    const res = [];
    for (const it of this._rtIndex()) {
      let sc = 0;
      if (it.lc.startsWith(ql)) sc = 100;
      else if (it.words.some((w) => w.startsWith(ql))) sc = 80;
      else if (it.lc.includes(ql)) sc = 60;
      else if (toks.length > 1 && toks.every((t) => it.words.some((w) => w.startsWith(t)))) sc = 50;
      if (!sc) continue;
      res.push([sc + it.pri * 2 - it.name.length * 0.05, it]);
    }
    return res.sort((a, b) => b[0] - a[0]).slice(0, 6).map((r) => r[1]);
  },

  _rtBindInput(inp, k) {
    inp.addEventListener('focus', () => { S.rtFocus = k; if (S.rtPin != null) { S.rtPin = null; this._routeUI(); } this._rtSuggest(k); inp.select(); });
    inp.addEventListener('blur', () => {
      setTimeout(() => { if (S.rtFocus === k && document.activeElement !== inp) { this._rtSugClose(); this._routeUI(); } }, 120);
    });
    inp.addEventListener('input', () => {
      if (!inp.value.trim() && S.rtPts[k] != null) { S.rtPts[k] = null; S.rtLbl[k] = null; this._routeCompute(); }
      this._rtSuggest(k); this._rtGeo(k);
    });
    inp.addEventListener('keydown', (e) => {
      const n = (S.rtSug || []).length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!n) return;
        S.rtSel = ((S.rtSel ?? -1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; this._rtSugDraw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = S.rtSug && (S.rtSug[S.rtSel ?? -1] || S.rtSug.find((s) => s.kind !== 'me' && !s.note));
        if (it) this._rtChoose(k, it);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); this._rtSugClose(); inp.blur(); this._routeUI();   // back to the chosen place
      }
    });
  },

  // suggestion list for field k: My location, campus matches, then OpenStreetMap addresses (when they arrive)
  _rtSuggest(k) {
    const q = S.rtIn[k].value.trim();
    const items = [{ kind: 'me', name: 'My location', sub: 'Uses this device’s location' }];
    items.push(...this._rtMatch(q));
    const g = S.rtGeoRes;
    if (q.length >= 3) {
      if (g && g.q === q.toLowerCase()) {
        if (g.items.length) items.push(...g.items.map((it, i) => ({ ...it, head: i === 0 })));
        else if (items.length === 1) items.push({ kind: 'addr', note: true, name: 'No campus place or address found', head: true });
      } else items.push({ kind: 'addr', note: true, name: 'Searching addresses…', head: true });
    }
    S.rtSug = items; S.rtSel = q && items.length > 1 && items[1].kind !== 'addr' ? 1 : null; S.rtFocus = k;
    this._rtSugDraw();
  },

  _rtSugDraw() {
    const ul = S.rtSugEl, k = S.rtFocus, items = S.rtSug || [];
    if (k == null || !items.length) { this._rtSugClose(); return; }
    const icon = (it) => (it.kind === 'me' ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M11 1 1 5.2l4.4 1.4L6.8 11z"/></svg>'
      : it.kind === 'addr' ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 5.5 6 2l4 3.5V10H2z"/></svg>'
      : '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11S2.5 7.4 2.5 4.9a3.5 3.5 0 0 1 7 0C9.5 7.4 6 11 6 11z"/></svg>');
    ul.innerHTML = items.map((it, i) => `${it.head ? '<li class="map-rt-sh" role="presentation">Addresses · © OpenStreetMap</li>' : ''}${it.note
      ? `<li class="map-rt-note" role="presentation">${esc(it.name)}</li>`
      : `<li role="option" id="map-rt-o${i}" data-i="${i}" aria-selected="${S.rtSel === i}" class="${S.rtSel === i ? 'on' : ''} k-${it.kind === 'me' ? 'me' : it.kind === 'addr' ? 'addr' : 'place'}">
          ${icon(it)}<span class="map-rt-sn">${esc(it.name)}</span><span class="map-rt-ss">${esc(it.sub || it.kind)}</span></li>`}`).join('');
    ul.hidden = false; S.rtEl.classList.add('sug');
    S.rtIn.forEach((inp, j) => { inp.setAttribute('aria-expanded', String(j === k)); if (j === k && S.rtSel != null) inp.setAttribute('aria-activedescendant', `map-rt-o${S.rtSel}`); else inp.removeAttribute('aria-activedescendant'); });
    const on = ul.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  },

  _rtSugClose() {
    if (!S.rtSugEl) return;
    S.rtSugEl.hidden = true; S.rtSugEl.innerHTML = ''; S.rtEl.classList.remove('sug'); S.rtFocus = null; S.rtSug = null; S.rtSel = null;
    S.rtIn.forEach((inp) => { inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); });
  },

  // OpenStreetMap Nominatim, limited to the campus box: 400 ms debounce, at most one request per second, 5 results
  _rtGeo(k) {
    clearTimeout(S.rtGeoT);
    const q0 = S.rtIn[k].value.trim();
    if (q0.length < 3) return;
    S.rtGeoCache = S.rtGeoCache || new Map();
    const key = q0.toLowerCase();
    if (S.rtGeoCache.has(key)) { S.rtGeoRes = { q: key, items: S.rtGeoCache.get(key) }; if (S.rtFocus === k) this._rtSuggest(k); return; }
    S.rtGeoT = setTimeout(async () => {
      const wait = (S.rtGeoLast || 0) + 1000 - performance.now();
      if (wait > 0) { S.rtGeoT = setTimeout(() => this._rtGeo(k), wait); return; }
      if (S.rtIn[k].value.trim() !== q0) return;
      S.rtGeoLast = performance.now();
      if (S.rtGeoCtl) S.rtGeoCtl.abort();
      const ctl = (S.rtGeoCtl = new AbortController());
      const e = S.ext, pad = 300, [la0, lo0] = L.toLL(e.x0 - pad, e.y0 - pad), [la1, lo1] = L.toLL(e.x1 + pad, e.y1 + pad);
      const vb = [Math.min(lo0, lo1), Math.max(la0, la1), Math.max(lo0, lo1), Math.min(la0, la1)].map((v) => v.toFixed(5)).join(',');
      let items = [];
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q0)}&viewbox=${vb}&bounded=1&limit=5&accept-language=en`,
          { signal: ctl.signal, headers: { Accept: 'application/json' } });
        const j = r.ok ? await r.json() : [];
        for (const it of (Array.isArray(j) ? j : []).slice(0, 5)) {
          const lat = +it.lat, lon = +it.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const [x, y] = L.toXY(lat, lon);
          const parts = String(it.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
          const name = it.name || parts[0] || 'Address';
          const sub = parts.filter((p) => p !== name && !/^(texas|united states|brazos county)$/i.test(p) && !/^\d{5}$/.test(p)).slice(0, 3).join(', ');
          items.push({ kind: 'addr', name, sub: sub || 'Address', x, y });
        }
      } catch (err) { if (err.name === 'AbortError') return; items = []; }
      S.rtGeoCache.set(q0.toLowerCase(), items);
      S.rtGeoRes = { q: q0.toLowerCase(), items };
      if (S.rtFocus === k && S.rtIn[k].value.trim() === q0) this._rtSuggest(k);
    }, 400);
  },

  async _rtChoose(k, it) {
    if (!it || it.note) return;
    const inp = S.rtIn[k];
    if (it.kind === 'me') {
      inp.value = 'Locating…'; this._rtSugClose();
      const pos = await new Promise((res) => {
        if (!navigator.geolocation) { res(null); return; }
        const t = setTimeout(() => res(null), 8000);
        navigator.geolocation.getCurrentPosition((p) => { clearTimeout(t); res(p.coords); }, () => { clearTimeout(t); res(null); }, { enableHighAccuracy: true, timeout: 7500, maximumAge: 30000 });
      });
      inp.value = S.rtLbl[k] || '';
      if (!pos) { this._routeUI('Location unavailable'); return; }
      const [x, y] = L.toXY(pos.latitude, pos.longitude), e = S.ext, pad = 300;
      if (!(x > e.x0 - pad && x < e.x1 + pad && y > e.y0 - pad && y < e.y1 + pad)) { this._routeUI('You’re off campus'); return; }
      if (this._rtSetEnd(k, x, y, 'My location')) this._rtNext(k);
      return;
    }
    this._rtSugClose();
    if (this._rtSetEnd(k, it.x, it.y, it.name)) this._rtNext(k);
  },

  // after choosing: move on to the other field if it is still empty, otherwise leave the fields
  _rtNext(k) {
    const o = 1 - k;
    if (S.rtPts[o] == null) S.rtIn[o].focus(); else S.rtIn[k].blur();
    this._routeUI();
  },

  // set end k from local metres: snapped to the nearest node of the walkable network (same connected piece as the other end)
  _rtSetEnd(k, x, y, label) {
    const G = this._G(); if (!G) return false;
    const other = S.rtPts[1 - k];
    let id = this._snap(x, y);
    if (id >= 0 && other != null && G.comp(id) !== G.comp(other)) id = this._snap(x, y, G.comp(other));
    if (id < 0) { S.rtIn[k].value = ''; this._routeUI(`${label} is not near a mapped path`); return false; }
    S.rtPts[k] = id; S.rtLbl[k] = label;
    S.rtIn[k].value = label;
    this._routeCompute();
    if (S.route) { const b = S.route.lit.pts; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      b.forEach(([px, py]) => { x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); });
      this._flyTo((x0 + x1) / 2, (y0 + y1) / 2, THREE.MathUtils.clamp(Math.max(x1 - x0, y1 - y0) * 2.1, 260, 2400));
    } else this._flyTo(G.x[id], G.y[id], Math.min(S.controls.d, 600));
    return true;
  },

  _buildGraph() {
    const nodesX = [], nodesY = [], adj = [];
    const grid = new Grid(4);
    const node = (x, y) => {
      let best = -1, bd = 2;
      grid.near(x, y, 2, (i) => { const d = Math.hypot(nodesX[i] - x, nodesY[i] - y); if (d <= bd) { bd = d; best = i; } });
      if (best >= 0) return best;
      const i = nodesX.length; nodesX.push(x); nodesY.push(y); adj.push([]); grid.add(x, y, i); return i;
    };
    let edges = 0;
    for (const f of S.data.path) {
      const g = f.geometry; if (!g) continue;
      const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      const lux = f.properties?.lux_median;
      const gl = L.glow(lux);
      for (const cs of parts) {
        let prev = null;
        for (const c of cs) {
          const [x, y] = L.toXY(c[1], c[0]); const id = node(x, y);
          if (prev != null && prev !== id) {
            const len = Math.hypot(nodesX[id] - nodesX[prev], nodesY[id] - nodesY[prev]);
            const e = { len, lux, gl, dark: lux == null || lux < GUIDE_LUX };
            adj[prev].push({ to: id, ...e }); adj[id].push({ to: prev, ...e }); edges++;
          }
          prev = id;
        }
      }
    }
    if (!edges) return null;
    const ng = new Grid(30); nodesX.forEach((x, i) => ng.add(x, nodesY[i], i));
    // Stretches exist only where someone walked, so the network has small gaps. Bridge each dead end to the
    // nearest node of a different connected piece within 30 m; bridges count as unmeasured (dark) in the stats.
    const par = nodesX.map((_, i) => i);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    adj.forEach((es, i) => es.forEach((e) => { par[find(i)] = find(e.to); }));
    let bridges = 0;
    for (let i = 0; i < nodesX.length; i++) {
      if (adj[i].length !== 1) continue;
      let best = -1, bd = 30;
      ng.near(nodesX[i], nodesY[i], 30, (j) => {
        if (find(j) === find(i)) return;
        const d = Math.hypot(nodesX[j] - nodesX[i], nodesY[j] - nodesY[i]); if (d < bd) { bd = d; best = j; }
      });
      if (best < 0) continue;
      const e = { len: Math.max(bd, 0.1), lux: null, gl: 0, dark: true, gap: true };
      adj[i].push({ to: best, ...e }); adj[best].push({ to: i, ...e }); par[find(i)] = find(best); bridges++;
    }
    // undirected edge list (both adjacency entries share an id) + a 20 m grid over edge boxes for snapping onto paths
    const elist = [], eid = new Map(), eg = new Grid(20);
    adj.forEach((es, i) => es.forEach((e) => {
      const k = i < e.to ? `${i},${e.to}` : `${e.to},${i}`;
      let id = eid.get(k);
      if (id == null) { id = elist.length; eid.set(k, id); elist.push({ a: Math.min(i, e.to), b: Math.max(i, e.to), len: e.len, gap: !!e.gap, gl: e.gl || 0 }); }
      e.id = id;
    }));
    elist.forEach((E, id) => {
      const x0 = Math.floor(Math.min(nodesX[E.a], nodesX[E.b]) / 20), x1 = Math.floor(Math.max(nodesX[E.a], nodesX[E.b]) / 20);
      const y0 = Math.floor(Math.min(nodesY[E.a], nodesY[E.b]) / 20), y1 = Math.floor(Math.max(nodesY[E.a], nodesY[E.b]) / 20);
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = `${i},${j}`; let a = eg.m.get(k); if (!a) eg.m.set(k, (a = [])); a.push(id); }
    });
    return { x: nodesX, y: nodesY, adj, grid: ng, comp: (i) => find(i), bridges, edges: elist, eg };
  },

  _snap(x, y, comp = null) {
    const G = S.graph; let best = -1, bd = Infinity;
    for (const r of [30, 90, 250]) {
      G.grid.near(x, y, r, (i) => { if (comp != null && G.comp(i) !== comp) return; const d = Math.hypot(G.x[i] - x, G.y[i] - y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) break;
    }
    return best >= 0 && bd <= 250 ? best : -1;
  },

  _dijkstra(s, t, cost) {
    const G = S.graph, n = G.x.length;
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), pe = new Array(n);
    const h = new Heap(); dist[s] = 0; h.push(0, s);
    while (h.size) {
      const u = h.pop(); if (u === t) break;
      const du = dist[u];
      for (const e of G.adj[u]) {
        const nd = du + cost(e);
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; pe[e.to] = e; h.push(nd, e.to); }
      }
    }
    if (!Number.isFinite(dist[t])) return null;
    const pts = [], es = [];
    for (let v = t; v !== -1; v = prev[v]) { pts.push([G.x[v], G.y[v]]); if (pe[v] && v !== s) es.push(pe[v]); }
    pts.reverse();
    const len = es.reduce((a, e) => a + e.len, 0), dark = es.reduce((a, e) => a + (e.dark ? e.len : 0), 0);
    const gap = es.reduce((a, e) => a + (e.gap ? e.len : 0), 0);
    return { pts, len, dark: len ? dark / len : 0, gap };
  },

  // pick-on-map (pin button armed): the next map click sets that end
  _routeClick(cx, cy) {
    const g = this._ground(cx, cy); if (!g) return;
    const k = S.rtPin; if (k == null) return;
    const id = this._snap(g.x, g.y);
    const label = id >= 0 ? this._placeName(S.graph.x[id], S.graph.y[id]) : 'Dropped pin';
    if (this._rtSetEnd(k, g.x, g.y, label)) { S.rtPin = S.rtPts[1 - k] == null ? 1 - k : null; this._routeUI(); }
  },

  _routeSwap() {
    if (!S.rtPts) return;
    S.rtPts.reverse(); S.rtLbl.reverse(); if (S.rtPin != null) S.rtPin = 1 - S.rtPin;
    this._routeCompute();
  },

  _routeReset() { S.rtPts = [null, null]; S.rtLbl = [null, null]; S.rtPin = null; S.rtIn.forEach((i) => { i.value = ''; }); this._routeCompute(); },

  _routeCompute() {
    this._clearRoute();
    this._drawEnds();
    const [a, b] = S.rtPts;
    if (a == null || b == null) { this._routeUI(); return; }
    const short = this._dijkstra(a, b, (e) => e.len);
    const lit = this._dijkstra(a, b, (e) => e.len * (1 + 6 * (1 - e.gl)));
    if (!short || !lit) { S.route = null; this._routeUI('Not connected'); return; }
    S.route = { short, lit };
    this._routeScore(lit.pts);
    const toSegs = (pts, c) => { const out = []; let d = 0; for (let i = 1; i < pts.length; i++) { out.push({ a: pts[i - 1], b: pts[i], c, d0: d }); d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); } return out; };
    const litM = ribbonLayer(toSegs(lit.pts, WARM), { width: 2.4, flat: 1, minPx: 3.2, opacity: 0.95, blending: THREE.NormalBlending, h: 0.5, order: 12 });
    const shortM = ribbonLayer(toSegs(short.pts, new THREE.Color(0.62, 0.64, 0.68)), { width: 0.9, flat: 1, minPx: 1.4, opacity: 0.9, dash: 8, blending: THREE.NormalBlending, h: 0.6, order: 13 });
    S.dashMats = [shortM.material];
    S.rtMeshes.push(litM, shortM); S.scene.add(litM, shortM); S.layers.route.push(litM, shortM);
    this._routeUI();
    S.dirty = true;
  },

  _clearRoute() {
    (S.rtMeshes || []).forEach((m) => { S.scene.remove(m); m.geometry.dispose(); m.material.dispose(); S.layers.route = S.layers.route.filter((o) => o !== m); });
    S.rtMeshes = []; S.dashMats = null; S.route = null; S.dirty = true;
  },

  _drawEnds() {
    const G = S.graph; if (!G) return;
    const pts = [];
    S.rtPts.forEach((i, k) => { if (i != null) pts.push({ x: G.x[i], y: G.y[i], h: 0.8, c: k ? WARM : new THREE.Color(0.95, 0.95, 0.95), s: 1 }); });
    if (!pts.length) return;
    const m = pointsLayer(pts, { mode: 2, world: 4, minPx: 8, maxPx: 13, order: 14 });
    S.rtMeshes.push(m); S.scene.add(m); S.layers.route.push(m); S.dirty = true;
  },
};
