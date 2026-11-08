// 3D Scan — compact WebGL2 Gaussian-splat viewer for the antimatter15 .splat format.
// 32 bytes/splat: position f32×3, scale f32×3, rgba u8×4, rotation u8×4 (q = (b-128)/128, w first).
// Data: <base>/spots.json = [{spot, session, start_index, lat, lon, brightness, photos}], <base>/<spot>.splat
// <base> defaults to data/splats/. Testing override in the hash: #scan?splats=dev/splats_fixture
// Rendering follows antimatter15/splat: instanced quads, 2D covariance projected in the vertex shader,
// depth sort (16-bit counting sort) in a Web Worker, premultiplied alpha — here drawn back-to-front.

const DEFAULT_BASE = 'data/splats/';
const ROW_BYTES = 32;
const FOV = 50 * Math.PI / 180;
const BG = [0x08 / 255, 0x09 / 255, 0x0b / 255];

let LUX, root, ui = {}, gl, prog, U = {}, tex, idxBuf, worker, ro;
const S = {
  base: null, spotsP: null, spots: [], cur: null, visible: false, raf: 0, showToken: 0,
  n: 0, sortedN: 0, positions: null, workerBusy: false, lastSortView: null, needSort: false,
  cam: { target: [0, 0, 0], yaw: Math.PI, pitch: 0.3, dist: 5, upSign: -1 }, home: null,
  interacted: false, framedAt: 0, abort: null, lastT: 0, loaded: false, drawGen: 0, lastKey: '',
};

/* ------------------------------------------------------------------ math */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function camBasis() {
  const c = S.cam, up = [0, c.upSign, 0];           // upSign -1 → world up is −Y (COLMAP default)
  const e1 = [1, 0, 0], e2 = [0, 0, 1];
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const dir = [0, 1, 2].map((k) => cp * (Math.sin(c.yaw) * e1[k] + Math.cos(c.yaw) * e2[k]) + sp * up[k]);
  const eye = c.target.map((t, k) => t + dir[k] * c.dist);
  const f = norm(sub(c.target, eye));
  const r = norm(cross(f, up));
  const d = cross(f, r);                             // camera y points down (COLMAP camera convention)
  return { eye, f, r, d };
}
function viewMatrix() {
  const { eye, f, r, d } = camBasis();
  return [r[0], d[0], f[0], 0, r[1], d[1], f[1], 0, r[2], d[2], f[2], 0, -dot(r, eye), -dot(d, eye), -dot(f, eye), 1];
}
function projMatrix(fx, fy, w, h, zn, zf) {
  return [2 * fx / w, 0, 0, 0, 0, -2 * fy / h, 0, 0, 0, 0, zf / (zf - zn), 1, 0, 0, -(zf * zn) / (zf - zn), 0];
}

/* ------------------------------------------------------------------ shaders */
const VS = `#version 300 es
precision highp float; precision highp int;
uniform highp usampler2D u_texture;
uniform mat4 projection, view;
uniform vec2 focal, viewport;
in vec2 position;
in int index;
out vec4 vColor; out vec2 vPosition;
void main () {
  uvec4 cen = texelFetch(u_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
  vec4 cam = view * vec4(uintBitsToFloat(cen.xyz), 1.0);
  vec4 pos2d = projection * cam;
  float clip = 1.2 * pos2d.w;
  if (pos2d.z < -clip || pos2d.x < -clip || pos2d.x > clip || pos2d.y < -clip || pos2d.y > clip) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
  }
  uvec4 cov = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);
  vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
  mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);
  mat3 J = mat3(focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z),
                0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z),
                0., 0., 0.);
  mat3 T = transpose(mat3(view)) * J;
  mat3 cov2d = transpose(T) * Vrk * T;
  float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
  float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
  float lambda1 = mid + radius, lambda2 = mid - radius;
  if (lambda2 < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
  vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
  vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);
  vColor = clamp(pos2d.z / pos2d.w + 1.0, 0.0, 1.0) *
    vec4((cov.w) & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
  vPosition = position;
  vec2 vCenter = vec2(pos2d) / pos2d.w;
  gl_Position = vec4(vCenter + position.x * majorAxis / viewport + position.y * minorAxis / viewport, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec4 vColor; in vec2 vPosition;
out vec4 fragColor;
void main () {
  float A = -dot(vPosition, vPosition);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(B * vColor.rgb, B);   // premultiplied
}`;

/* sort worker: 16-bit counting sort of view depth, far → near */
const WORKER_SRC = `
let pos = null, n = 0;
onmessage = (e) => {
  const d = e.data;
  if (d.positions) { pos = d.positions; n = d.count; }
  if (d.view) {
    if (!n) { postMessage({ depthIndex: new Uint32Array(0), count: 0 }); return; }
    const v = d.view, keys = new Int32Array(n);
    let mx = -2147483648, mn = 2147483647;
    for (let i = 0; i < n; i++) {
      const k = ((v[2] * pos[3 * i] + v[6] * pos[3 * i + 1] + v[10] * pos[3 * i + 2]) * 4096) | 0;
      keys[i] = k; if (k > mx) mx = k; if (k < mn) mn = k;
    }
    const inv = 65535 / Math.max(1, mx - mn), counts = new Uint32Array(65536);
    for (let i = 0; i < n; i++) { keys[i] = 65535 - (((keys[i] - mn) * inv) | 0); counts[keys[i]]++; }
    const starts = new Uint32Array(65536);
    for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
    const depthIndex = new Uint32Array(n);
    for (let i = 0; i < n; i++) depthIndex[starts[keys[i]]++] = i;
    postMessage({ depthIndex, count: n }, [depthIndex.buffer]);
  }
};`;

/* ------------------------------------------------------------------ GL setup */
function initGL() {
  gl = ui.canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 unavailable');
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  for (const k of ['projection', 'view', 'focal', 'viewport', 'u_texture']) U[k] = gl.getUniformLocation(prog, k);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);     // back-to-front, premultiplied

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
  const aIdx = gl.getAttribLocation(prog, 'index');
  gl.enableVertexAttribArray(aIdx);
  gl.vertexAttribIPointer(aIdx, 1, gl.INT, false, 0, 0);
  gl.vertexAttribDivisor(aIdx, 1);

  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [p, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
  gl.uniform1i(U.u_texture, 0);

  worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
  worker.onmessage = (e) => {
    S.workerBusy = false;
    const { depthIndex, count } = e.data;
    if (count > S.n) return;                         // stale (spot switched)
    gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
    S.sortedN = count; S.drawGen++;
  };
}

/* ------------------------------------------------------------------ splat parsing */
const _f = new Float32Array(1), _i = new Int32Array(_f.buffer);
function toHalf(v) {
  _f[0] = v; const x = _i[0];
  const s = (x >> 16) & 0x8000; let e = ((x >> 23) & 0xff) - 127 + 15; let m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m = (m | 0x800000) >> (1 - e); return s | (m >> 13); }
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | (m >> 13);
}
const packHalf = (a, b) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;

class SplatStore {
  constructor(cap) { this.alloc(cap); this.n = 0; }
  alloc(cap) {
    const old = this;
    const H = Math.max(1, Math.ceil(cap / 1024));
    const td = new Uint32Array(2048 * H * 4), pos = new Float32Array(cap * 3);
    if (old.texdata) { td.set(old.texdata.subarray(0, Math.min(old.texdata.length, td.length))); pos.set(old.pos.subarray(0, Math.min(old.pos.length, pos.length))); }
    this.cap = cap; this.H = H; this.texdata = td; this.pos = pos;
    this.texF = new Float32Array(td.buffer); this.texU8 = new Uint8Array(td.buffer);
  }
  add(bytes, count) {   // bytes: Uint8Array of count*32 bytes (aligned copy)
    if (this.n + count > this.cap) this.alloc(Math.max(this.cap * 2, this.n + count));
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, count * 8);
    const td = this.texdata, tf = this.texF, t8 = this.texU8, pos = this.pos;
    for (let j = 0; j < count; j++) {
      const i = this.n + j;
      const x = f[8 * j], y = f[8 * j + 1], z = f[8 * j + 2];
      pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
      tf[8 * i] = x; tf[8 * i + 1] = y; tf[8 * i + 2] = z;
      const b = 32 * j;
      t8[4 * (8 * i + 7)] = bytes[b + 24]; t8[4 * (8 * i + 7) + 1] = bytes[b + 25];
      t8[4 * (8 * i + 7) + 2] = bytes[b + 26]; t8[4 * (8 * i + 7) + 3] = bytes[b + 27];
      const sx = f[8 * j + 3], sy = f[8 * j + 4], sz = f[8 * j + 5];
      let qw = (bytes[b + 28] - 128) / 128, qx = (bytes[b + 29] - 128) / 128, qy = (bytes[b + 30] - 128) / 128, qz = (bytes[b + 31] - 128) / 128;
      const ql = Math.hypot(qw, qx, qy, qz) || 1; qw /= ql; qx /= ql; qy /= ql; qz /= ql;
      const M = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy),
        2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx),
        2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy),
      ];
      M[0] *= sx; M[1] *= sx; M[2] *= sx; M[3] *= sy; M[4] *= sy; M[5] *= sy; M[6] *= sz; M[7] *= sz; M[8] *= sz;
      const s0 = M[0] * M[0] + M[3] * M[3] + M[6] * M[6], s1 = M[0] * M[1] + M[3] * M[4] + M[6] * M[7];
      const s2 = M[0] * M[2] + M[3] * M[5] + M[6] * M[8], s3 = M[1] * M[1] + M[4] * M[4] + M[7] * M[7];
      const s4 = M[1] * M[2] + M[4] * M[5] + M[7] * M[8], s5 = M[2] * M[2] + M[5] * M[5] + M[8] * M[8];
      td[8 * i + 4] = packHalf(4 * s0, 4 * s1);
      td[8 * i + 5] = packHalf(4 * s2, 4 * s3);
      td[8 * i + 6] = packHalf(4 * s4, 4 * s5);
    }
    this.n += count;
  }
}

/* robust bounds: box of the 5–95th percentiles per axis (ignores floaters) */
function robustFrame(pos, n) {
  const step = Math.max(1, Math.floor(n / 20000));
  const ax = [[], [], []];
  for (let i = 0; i < n; i += step) for (let k = 0; k < 3; k++) { const v = pos[3 * i + k]; if (Number.isFinite(v)) ax[k].push(v); }
  const lo = [], hi = [];
  for (let k = 0; k < 3; k++) {
    const a = ax[k].sort((p, q) => p - q);
    lo[k] = a[Math.floor(a.length * 0.05)] ?? 0; hi[k] = a[Math.floor(a.length * 0.95)] ?? 0;
  }
  const center = lo.map((l, k) => (l + hi[k]) / 2);
  const radius = Math.max(0.05, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  return { center, radius };
}

function frameCamera() {
  if (!S.n) return;
  const { center, radius } = robustFrame(S.store.pos, S.n);
  S.home = { target: center, dist: radius / Math.tan(FOV / 2) * 1.05, radius };
  Object.assign(S.cam, { target: [...center], dist: S.home.dist, yaw: Math.PI + 0.35, pitch: 0.28 });
  S.needSort = true;
}

/* ------------------------------------------------------------------ loading */
async function loadSplat(spot) {
  S.abort?.abort();
  const ac = new AbortController(); S.abort = ac;
  S.store = new SplatStore(65536); S.n = 0; S.sortedN = 0; S.loaded = false; S.interacted = false; S.framedAt = 0;
  worker.postMessage({ positions: new Float32Array(0), count: 0 });
  ui.sceneMsg.hidden = true;
  setProgress('Loading scan…');
  let res;
  try {
    res = await fetch(`${S.base}${encodeURIComponent(spot.spot)}.splat`, { signal: ac.signal });
    if (!res.ok) throw new Error(`${res.status}`);
  } catch (e) {
    if (ac.signal.aborted) return;
    setProgress('');
    ui.sceneMsg.hidden = false;
    const note = ui.about.querySelector('.sc-note');
    if (note) note.textContent = 'No 3D model for this spot yet. The photos and light readings are still on the map.';
    return;
  }
  const total = +res.headers.get('content-length') || 0;
  if (total) S.store.alloc(Math.ceil(total / ROW_BYTES));
  const reader = res.body.getReader();
  let carry = new Uint8Array(0), bytes = 0, lastUpload = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (ac.signal.aborted) return;
      if (value) {
        bytes += value.length;
        const buf = new Uint8Array(carry.length + value.length);
        buf.set(carry); buf.set(value, carry.length);
        const count = Math.floor(buf.length / ROW_BYTES);
        if (count) S.store.add(buf.subarray(0, count * ROW_BYTES).slice(), count);   // slice → 4-byte aligned copy
        carry = buf.slice(count * ROW_BYTES);
        setProgress(total ? `Loading scan… ${Math.round(100 * bytes / total)}%` : `Loading scan… ${(bytes / 1e6).toFixed(1)} MB`);
      }
      const now = performance.now();
      if (done || now - lastUpload > 250) { upload(); lastUpload = now; }
      if (done) break;
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    console.warn('scan: stream error', e);
  }
  S.loaded = true;
  if (!S.n) { setProgress(''); ui.sceneMsg.hidden = false; return; }
  if (!S.interacted) frameCamera();
  setProgress('');
  ui.count.textContent = `${S.n.toLocaleString()} splats`;
}

function upload() {
  const st = S.store;
  if (st.n === S.n) return;
  S.n = st.n;
  const H = Math.ceil(S.n / 1024);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, st.texdata.subarray(0, 2048 * H * 4));
  worker.postMessage({ positions: st.pos.slice(0, S.n * 3), count: S.n });
  // frame early (first ~third of an importance-sorted file already shows the scene), refine at the end
  if (!S.interacted && (!S.framedAt || S.n > S.framedAt * 2)) { frameCamera(); S.framedAt = S.n; }
  S.needSort = true;
}

function setProgress(t) { ui.progress.textContent = t; ui.progress.hidden = !t; }

/* ------------------------------------------------------------------ render */
function render(now) {
  if (!S.visible) return;
  S.raf = requestAnimationFrame(render);
  if (!S.sortedN) S.lastKey = '';
  const dt = Math.min(0.05, (now - (S.lastT || now)) / 1000); S.lastT = now;
  if (!S.interacted && S.n) { S.cam.yaw += dt * 0.08 * -S.cam.upSign; S.needSort = true; }   // slow drift until touched
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(ui.canvas.clientWidth * dpr), h = Math.round(ui.canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (ui.canvas.width !== w || ui.canvas.height !== h) { ui.canvas.width = w; ui.canvas.height = h; }
  // draw only when something changed (camera, sort result, size) — saves battery once the user stops
  const c = S.cam, key = `${w}|${h}|${c.yaw}|${c.pitch}|${c.dist}|${c.target}|${c.upSign}|${S.sortedN}|${S.drawGen}`;
  if (key === S.lastKey) { maybeSort(); return; }
  S.lastKey = key;
  gl.viewport(0, 0, w, h);
  gl.clearColor(BG[0], BG[1], BG[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!S.sortedN) { maybeSort(); return; }
  const fy = h / (2 * Math.tan(FOV / 2)), fx = fy;
  const r = S.home?.radius || 1;
  const zn = Math.max(0.01, Math.min(S.cam.dist * 0.02, r * 0.02)), zf = S.cam.dist + r * 60;
  const view = viewMatrix();
  gl.useProgram(prog);
  gl.uniformMatrix4fv(U.projection, false, projMatrix(fx, fy, w, h, zn, zf));
  gl.uniformMatrix4fv(U.view, false, view);
  gl.uniform2fv(U.focal, [fx, fy]);
  gl.uniform2fv(U.viewport, [w, h]);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, S.sortedN);
  maybeSort(view);
}
function maybeSort(view = viewMatrix()) {
  if (S.workerBusy || !S.n) return;
  const last = S.lastSortView;
  const changed = !last || S.needSort || Math.abs(view[2] * last[2] + view[6] * last[6] + view[10] * last[10] - 1) > 0.0005 ||
    Math.abs(view[14] - last[14]) > 1e-3 * (S.home?.radius || 1);
  if (!changed) return;
  S.workerBusy = true; S.needSort = false; S.lastSortView = view;
  worker.postMessage({ view });
}

/* ------------------------------------------------------------------ controls */
function initControls() {
  const c = ui.canvas, ptrs = new Map();
  let mode = null, last = null, pinch = 0;
  const touched = () => { S.interacted = true; };
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); touched();
    mode = ptrs.size >= 2 ? 'pinch' : (e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'rotate');
    last = [e.clientX, e.clientY];
    if (mode === 'pinch') { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); last = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    c.classList.add('sc-dragging');
  });
  c.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    const cam = S.cam;
    if (mode === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (pinch) cam.dist = clampDist(cam.dist * pinch / d);
      pan(mid[0] - last[0], mid[1] - last[1]);
      pinch = d; last = mid; return;
    }
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    last = [e.clientX, e.clientY];
    if (mode === 'rotate') {
      cam.yaw -= dx * 0.006 * -cam.upSign;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.005));
    } else if (mode === 'pan') pan(dx, dy);
  });
  const end = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) { mode = null; c.classList.remove('sc-dragging'); } else if (ptrs.size === 1) { mode = 'rotate'; last = [...ptrs.values()][0]; } };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', (e) => {
    e.preventDefault(); touched();
    S.cam.dist = clampDist(S.cam.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }, { passive: false });
  c.addEventListener('dblclick', () => resetView());
}
function pan(dx, dy) {
  const { r, d } = camBasis(), cam = S.cam;
  const k = cam.dist * 2 * Math.tan(FOV / 2) / (ui.canvas.clientHeight || 1);
  for (let i = 0; i < 3; i++) cam.target[i] -= (r[i] * dx + d[i] * dy) * k;
}
const clampDist = (d) => { const r = S.home?.radius || 1; return Math.max(r * 0.05, Math.min(r * 30, d)); };
function resetView() { if (S.home) { Object.assign(S.cam, { target: [...S.home.target], dist: S.home.dist, yaw: Math.PI + 0.35, pitch: 0.28 }); } }

/* ------------------------------------------------------------------ UI */
const walkerOf = (s) => +((/^W(\d+)/.exec(s || '') || [])[1] || 0);
function walkLabel(s) {
  const m = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(s || '');
  const w = walkerOf(s);
  if (!m) return s || '—';
  const hh = +m[4], t = `${(hh % 12) || 12}:${m[5]} ${hh < 12 ? 'am' : 'pm'}`;
  return `${w ? `Walker ${w} · ` : ''}${t} walk`;
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderList() {
  ui.list.innerHTML = S.spots.map((s, j) => `
    <li><button type="button" class="sc-spot" data-j="${j}" aria-pressed="${s === S.cur}">
      <span class="sc-spot-name">Spot ${j + 1}</span><span class="sc-spot-sub">${s.photos != null ? `${esc(s.photos)} photos` : ''}</span>
    </button></li>`).join('');
  ui.list.querySelectorAll('.sc-spot').forEach((b) => { b.onclick = () => selectSpot(S.spots[+b.dataset.j], true); });
}
function renderAbout(s) {
  const j = S.spots.indexOf(s) + 1;
  ui.about.innerHTML = `
    <div class="label">About this scan</div>
    <div class="sc-about-title">Spot ${j}</div>
    <dl>
      <div><dt class="label">Walk</dt><dd>${esc(walkLabel(s.session))}</dd></div>
      <div><dt class="label">Photos</dt><dd>${s.photos != null ? esc(s.photos) : '—'}</dd></div>
    </dl>
    <p class="sc-note">Rebuilt in 3D from night photos taken on the walk. Every photo was privacy-blurred before reconstruction.</p>
    <div class="sc-links">
      ${s.lat != null ? '<a href="#" class="sc-maplink">Show on light map</a>' : ''}
      ${s.session && s.start_index != null ? '<a href="#" class="sc-svlink">Open in Street View</a>' : ''}
    </div>
    <div class="label sc-count"></div>`;
  ui.count = ui.about.querySelector('.sc-count');
  ui.about.querySelector('.sc-maplink')?.addEventListener('click', (e) => { e.preventDefault(); LUX.go('map', { lat: s.lat, lon: s.lon }); });
  ui.about.querySelector('.sc-svlink')?.addEventListener('click', (e) => { e.preventDefault(); LUX.go('street', { session: s.session, index: s.start_index }); });
}
function selectSpot(s, user) {
  if (!s) return;
  if (s === S.cur && !user) return;
  if (s === S.cur && S.n) return;
  S.cur = s;
  renderList(); renderAbout(s);
  if (user) {
    const p = { spot: s.spot };
    if (S.base !== DEFAULT_BASE) p.splats = S.base.replace(/\/$/, '');
    history.replaceState(null, '', `#scan?${new URLSearchParams(p)}`);
  }
  loadSplat(s);
}

function showMessage(title) {
  ui.msg.innerHTML = `<div class="sc-msg-in"><div class="sc-msg-title">${title}</div></div>`;
  ui.msg.hidden = false; root.classList.add('sc-empty');
}
function safeBase(p) {
  if (!p) return DEFAULT_BASE;
  if (/^[\w\-./]+$/.test(p) && !p.includes('..') && !p.startsWith('/') && !p.includes('//')) return p.replace(/\/?$/, '/');
  return DEFAULT_BASE;
}
async function loadSpots(base) {
  const r = await fetch(`${base}spots.json`);
  if (!r.ok) throw new Error(`spots.json ${r.status}`);
  const a = await r.json();
  if (!Array.isArray(a) || !a.length) throw new Error('no spots');
  return a.filter((s) => s && s.spot != null);
}

const MISSING = '3D scans are still processing (or this spot could not be reconstructed from night photos)';

export default {
  async mount(el, lux) {
    LUX = lux; root = el;
    if (!document.querySelector('link[data-view-css="scan"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'css/scan.css'; l.dataset.viewCss = 'scan';
      document.head.appendChild(l);
    }
    el.innerHTML = `
      <canvas class="sc-gl" aria-label="3D Gaussian-splat scan. Drag to orbit, scroll to zoom, right-drag to pan, double-click to reset."></canvas>
      <nav class="sc-side" aria-label="Scanned spots">
        <div class="label">Scanned spots</div>
        <ul class="sc-list"></ul>
      </nav>
      <div class="sc-tools">
        <button type="button" class="chip sc-flip" aria-label="Flip the scan upside down">Flip</button>
        <button type="button" class="chip sc-reset" aria-label="Reset the view">Reset view</button>
      </div>
      <div class="sc-progress label" role="status" aria-live="polite" hidden></div>
      <div class="sc-scenemsg" hidden><div class="sc-msg-title">${MISSING}</div></div>
      <aside class="panel sc-about" aria-label="About this scan"></aside>
      <div class="sc-hint label">Drag to orbit · scroll to zoom · right-drag to pan</div>
      <div class="loading sc-msg" hidden></div>`;
    const q = (s) => el.querySelector(s);
    ui = { canvas: q('.sc-gl'), list: q('.sc-list'), progress: q('.sc-progress'), sceneMsg: q('.sc-scenemsg'), about: q('.sc-about'), msg: q('.sc-msg'), count: null };
    try { initGL(); } catch (e) {
      console.warn('3D Scan: WebGL2 unavailable', e);
      showMessage('3D scans need WebGL 2, which this browser could not start.');
      gl = null; return;
    }
    initControls();
    q('.sc-flip').onclick = () => { S.cam.upSign *= -1; S.cam.pitch = Math.abs(S.cam.pitch); S.needSort = true; };
    q('.sc-reset').onclick = () => resetView();
  },

  async show(params = {}) {
    S.visible = true;
    if (!gl) return;
    const token = ++S.showToken;
    const base = safeBase(params.splats);
    if (base !== S.base) { S.base = base; S.spotsP = loadSpots(base); S.cur = null; }
    cancelAnimationFrame(S.raf);
    S.lastT = 0; S.lastKey = "";
    S.raf = requestAnimationFrame(render);
    let spots;
    try { spots = await S.spotsP; } catch {
      if (token !== S.showToken) return;
      S.base = null;                                   // retry on the next visit
      cancelAnimationFrame(S.raf);
      showMessage(MISSING);
      return;
    }
    if (token !== S.showToken) return;
    ui.msg.hidden = true; root.classList.remove('sc-empty');
    S.spots = spots;
    const want = params.spot != null ? spots.find((s) => String(s.spot) === String(params.spot)) : null;
    const s = want || S.cur || spots[0];
    if (s !== S.cur) selectSpot(s, false); else { renderList(); }
  },

  hide() {
    S.visible = false;
    cancelAnimationFrame(S.raf);
  },
};
