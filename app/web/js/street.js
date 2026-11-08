// Night Street View — walk a survey route frame by frame, with depth parallax from per-frame disparity maps.
// Data (CONTRACT.md): <base>/index.json = [{s, i, lat, lon, h, p, t, lux}], frames <base>/<s>/<i>.jpg and <i>_d.png.
// <base> defaults to data/streetview/. For testing, a relative override can be passed in the hash:
//   #street?sv=dev/streetview_fixture      (only plain relative paths are accepted)
import * as THREE from 'three';

const DEFAULT_BASE = 'data/streetview/';
const STEP_MS = 650;         // playback: time per frame
const FADE_MS = 260;         // cross-fade between frames
const PRELOAD = 6;           // frames ahead to preload
const CACHE_MAX = 18;        // decoded frames kept on the GPU (each ≈ 1.8 MB with mips)
const PARALLAX = 0.022;      // max uv offset from pointer
const LAMP_MAX_M = 150;

let LUX, root, renderer, material, scene, camera, ro;
let ui = {};
const S = {
  base: null, indexP: null, index: null, sessions: new Map(), order: [],
  session: null, frames: [], k: 0, target: 0,
  playing: false, lastStep: 0, visible: false, raf: 0,
  fadeStart: -1e9, dir: 0, A: null, B: null,
  off: { x: 0, y: 0 }, offT: { x: 0, y: 0 }, sway: 0,
  cache: new Map(), lamps: null, mapGeom: null, hashTimer: 0, showToken: 0,
};

/* ------------------------------------------------------------------ helpers */
function safeBase(p) {
  if (!p) return DEFAULT_BASE;
  if (/^[\w\-./]+$/.test(p) && !p.includes('..') && !p.startsWith('/') && !p.includes('//')) return p.replace(/\/?$/, '/');
  return DEFAULT_BASE;
}
const walkerOf = (s) => +((/^W(\d+)/.exec(s || '') || [])[1] || 0);
// prefer an explicit walker field (w / walker) on the index row, else parse it from the session name
const walkerOfRow = (f) => { const w = f && (f.w ?? f.walker); return w != null && !Number.isNaN(+w) ? +w : walkerOf(f && f.s); };
const PEG = new Image(); PEG.src = 'img/pegman_small.png'; PEG.onload = () => drawMap();
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (h) => COMPASS[Math.round((((h % 360) + 360) % 360) / 45) % 8];
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }).toLowerCase();
const warnIcon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 21.6 19.8H2.4z" fill="var(--warn)" stroke="var(--warn)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ GL */
const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform sampler2D tA, dA, tB, dB;
uniform float uMix, uZoomA, uZoomB, uAspA, uAspB;
uniform vec2 uOff, uRes;
varying vec2 vUv;
vec3 frame(sampler2D t, sampler2D d, float ia, float zoom) {
  float sa = uRes.x / uRes.y;
  vec2 contain = sa > ia ? vec2(ia / sa, 1.0) : vec2(1.0, sa / ia);
  vec2 cover   = sa > ia ? vec2(1.0, sa / ia) : vec2(ia / sa, 1.0);
  vec2 fit = min(cover, contain * 1.16) * zoom;           // slightly larger than contain: margin for parallax
  vec2 uv = (vUv - 0.5) / fit + 0.5;
  // depth parallax: near (bright disparity) moves more; two fixed-point steps reduce smearing at edges
  float disp = texture2D(d, clamp(uv, 0.0, 1.0), 0.5).r;
  vec2 p = uv + uOff * (disp - 0.25);
  disp = texture2D(d, clamp(p, 0.0, 1.0), 0.5).r;
  p = uv + uOff * (disp - 0.25);
  vec3 sharp = texture2D(t, clamp(p, 0.001, 0.999)).rgb;
  // ambient fill outside the photo: its own edge pixels smeared outward, heavily blurred, fading to black
  vec2 out2 = max(max(-uv, uv - 1.0), 0.0) * vec2(ia, 1.0);
  vec3 bg = texture2D(t, clamp(uv, 0.0, 1.0), 6.0).rgb * 0.55 * exp(-length(out2) * 2.2);
  vec2 e = smoothstep(vec2(-0.01), vec2(0.12, 0.06), uv) * smoothstep(vec2(1.01), vec2(0.88, 0.94), uv);
  return mix(bg, sharp, e.x * e.y);
}
void main() {
  vec3 c = mix(frame(tA, dA, uAspA, uZoomA), frame(tB, dB, uAspB, uZoomB), uMix);
  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= mix(0.5, 1.0, smoothstep(1.15, 0.3, length(q)));
  gl_FragColor = vec4(c, 1.0);
}`;

function solidTex(v) {
  const t = new THREE.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1);
  t.needsUpdate = true; return t;
}
const BLACK = { tex: null, dtex: null, asp: 0.5625 };

function initGL(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // pass the JPEG values straight through
  BLACK.tex = solidTex(0); BLACK.dtex = solidTex(64);
  material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tA: { value: BLACK.tex }, dA: { value: BLACK.dtex }, tB: { value: BLACK.tex }, dB: { value: BLACK.dtex },
      uMix: { value: 1 }, uZoomA: { value: 1 }, uZoomB: { value: 1 }, uAspA: { value: 0.5625 }, uAspB: { value: 0.5625 },
      uOff: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2(1, 1) },
    },
  });
  scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  S.A = S.B = BLACK;
}

function resize() {
  if (!renderer) return;
  const w = root.clientWidth, h = root.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  material.uniforms.uRes.value.set(w, h);
  drawStrip(); drawMap();
}

/* ------------------------------------------------------------------ frame cache */
function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(url));
    im.src = url;
  });
}
function makeTex(img, mips) {
  const t = new THREE.Texture(img);
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function getFrame(f) {
  const key = `${f.s}/${f.i}`;
  let e = S.cache.get(key);
  if (e) { S.cache.delete(key); S.cache.set(key, e); return e; }   // LRU touch
  e = { key, ready: false, failed: false };
  const base = S.base;
  e.p = (async () => {
    try {
      const [img, dimg] = await Promise.all([
        loadImage(`${base}${f.s}/${f.i}.jpg`),
        loadImage(`${base}${f.s}/${f.i}_d.png`).catch(() => null),  // depth is optional
      ]);
      e.tex = makeTex(img, true);
      e.dtex = dimg ? makeTex(dimg, true) : null;
      e.asp = img.naturalWidth / img.naturalHeight;
      e.ready = true;
    } catch { e.failed = true; }
    return e;
  })();
  S.cache.set(key, e);
  evict();
  return e;
}
function evict() {
  if (S.cache.size <= CACHE_MAX) return;
  const keep = new Set([S.A?.key, S.B?.key]);
  for (let j = 0; j <= PRELOAD; j++) { const f = S.frames[S.target + j]; if (f) keep.add(`${f.s}/${f.i}`); }
  for (const [key, e] of S.cache) {
    if (S.cache.size <= CACHE_MAX) break;
    if (keep.has(key)) continue;
    e.tex?.dispose(); e.dtex?.dispose();
    S.cache.delete(key);
  }
}
function preload(k) {
  for (let j = 1; j <= PRELOAD; j++) { const f = S.frames[k + j]; if (f) getFrame(f); }
  if (S.frames[k - 1]) getFrame(S.frames[k - 1]);
}

/* ------------------------------------------------------------------ navigation */
function goTo(k, { user = true } = {}) {
  if (!S.frames.length) return;
  k = Math.max(0, Math.min(S.frames.length - 1, k));
  const prev = S.target;
  S.target = k;
  updateHud(k);
  if (user) scheduleHash();
  const f = S.frames[k];
  const e = getFrame(f);
  preload(k);
  ui.frameMsg.hidden = true;
  e.p.then((e2) => {
    if (S.target !== k || S.frames[k] !== f) return;   // superseded
    if (e2.failed) { ui.frameMsg.hidden = false; return; }
    if (S.B === e2) return;
    const now = performance.now();
    const t = (now - S.fadeStart) / FADE_MS;
    if (t < 0.5) { /* mid-fade: keep the older frame as A */ } else S.A = S.B;
    S.B = e2;
    S.dir = Math.abs(k - prev) === 1 ? Math.sign(k - prev) : 0;
    S.fadeStart = now;
    S.k = k;
  });
}
function step(d) { goTo(S.target + d); }
function setPlaying(p) {
  S.playing = p && S.frames.length > 1;
  if (S.playing && S.target >= S.frames.length - 1) goTo(0);
  S.lastStep = performance.now();
  ui.play.textContent = S.playing ? 'Pause' : 'Play';
  ui.play.setAttribute('aria-label', S.playing ? 'Pause walk' : 'Play walk');
}
function scheduleHash() {
  clearTimeout(S.hashTimer);
  S.hashTimer = setTimeout(() => {
    if (!S.visible || !S.session) return;
    const p = { session: S.session, index: S.frames[S.target].i };
    if (S.base !== DEFAULT_BASE) p.sv = S.base.replace(/\/$/, '');
    history.replaceState(null, '', `#street?${new URLSearchParams(p)}`);   // no hashchange → no re-show
  }, 350);
}

function selectSession(s, index) {
  const frames = S.sessions.get(s);
  if (!frames) return;
  const changed = s !== S.session;
  S.session = s; S.frames = frames;
  ui.select.value = s;
  let k = changed ? 0 : S.target;
  if (index != null && index !== '' && !Number.isNaN(+index)) {
    let best = Infinity;
    frames.forEach((f, j) => { const d = Math.abs(f.i - +index); if (d < best) { best = d; k = j; } });
  }
  if (changed) { buildMapGeom(); dropIn(); }
  goTo(k, { user: false });
  drawStrip(); drawMap();
}

/* playful "you've landed" moment on entering a walk */
function dropIn() {
  const el = ui.drop;
  if (!el || reduceMotion()) return;
  el.hidden = false;
  el.classList.remove('sv-drop-go'); void el.offsetWidth;   // restart the animation
  el.classList.add('sv-drop-go');
  clearTimeout(S.dropTimer);
  S.dropTimer = setTimeout(() => { el.hidden = true; el.classList.remove('sv-drop-go'); }, 950);
}

/* ------------------------------------------------------------------ HUD */
function updateHud(k) {
  const f = S.frames[k];
  if (!f) return;
  const lux = f.lux;
  ui.lux.textContent = LUX.fmtLux(lux);
  const lvl = LUX.level(lux);
  ui.level.innerHTML = lux != null && lux < 3
    ? `${warnIcon(lux < 1 ? 14 : 12)}<span>${lvl}</span><span class="sv-guide">below the ~5 lux walkway guideline</span>`
    : `<span>${lvl}</span>`;
  ui.lightBlock.style.setProperty('--g', LUX.glow(lux).toFixed(3));
  ui.facing.textContent = f.h == null ? '—' : `${Math.round(((f.h % 360) + 360) % 360)}° ${compass(f.h)}`;
  ui.frame.textContent = `${k + 1} of ${S.frames.length}`;
  const w = walkerOfRow(f);
  ui.walker.textContent = w ? `Walker ${w}` : '—';
  ui.dot.style.background = LUX.walkerColor(w);
  ui.lamp.textContent = lampText(f);
  ui.strip.setAttribute('aria-valuenow', k + 1);
  ui.strip.setAttribute('aria-valuetext', `Frame ${k + 1} of ${S.frames.length}, ${LUX.fmtLux(lux)} lux, ${lvl}`);
  drawStrip(); drawMap();
}

function lampText(f) {
  if (!S.lamps || !S.lamps.length) return '—';
  const [x, y] = LUX.toXY(f.lat, f.lon);
  let best = null, bd = Infinity;
  for (const L of S.lamps) { const d = Math.hypot(L.x - x, L.y - y); if (d < bd) { bd = d; best = L; } }
  if (!best || bd > LAMP_MAX_M) return `none within ${LAMP_MAX_M} m`;
  let where = 'here';
  if (bd >= 2 && f.h != null) {
    const brg = Math.atan2(best.x - x, best.y - y) * 180 / Math.PI;
    const rel = ((brg - f.h + 540) % 360) - 180;
    where = Math.abs(rel) <= 45 ? 'ahead' : Math.abs(rel) >= 135 ? 'behind' : rel > 0 ? 'to the right' : 'to the left';
  }
  return `${Math.round(bd)} m ${where}`;
}

/* strip: one bar per frame, brightness = light */
function drawStrip() {
  const c = ui.stripCanvas;
  if (!c || !S.frames.length) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const n = S.frames.length, bw = w / n, gap = bw > 4 ? 1 : 0;
  g.fillStyle = 'rgba(255,255,255,.035)';
  g.fillRect(0, 0, w, h);
  S.frames.forEach((f, j) => {
    const a = LUX.glow(f.lux);
    if (a <= 0) return;
    g.fillStyle = `rgba(255,226,170,${a.toFixed(3)})`;
    g.fillRect(j * bw, 0, Math.max(bw - gap, 0.6), h);
  });
  const x = (S.target + 0.5) * bw;
  g.fillStyle = '#fff';
  g.fillRect(Math.round(x) - 1, -2, 2, h + 4);
}

/* mini map: track drawn as light, north up */
function buildMapGeom() {
  const pts = S.frames.map((f) => LUX.toXY(f.lat, f.lon));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const span = Math.max(x1 - x0, (y1 - y0) * 1.5, 140) * 1.15;
  S.mapGeom = { pts, cx, cy, span };
}
function drawMap() {
  const c = ui.mapCanvas, G = S.mapGeom;
  if (!c || !G || G.pts.length !== S.frames.length) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const sc = w / G.span;
  const P = (x, y) => [w / 2 + (x - G.cx) * sc, h / 2 - (y - G.cy) * sc];
  G.P = P; G.sc = sc;
  // streetlights in view
  if (S.lamps) {
    for (const L of S.lamps) {
      const [px, py] = P(L.x, L.y);
      if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
      const r = g.createRadialGradient(px, py, 0, px, py, 7);
      r.addColorStop(0, 'rgba(255,226,170,.35)'); r.addColorStop(1, 'rgba(255,226,170,0)');
      g.fillStyle = r; g.fillRect(px - 7, py - 7, 14, 14);
      g.fillStyle = 'rgba(255,226,170,.8)'; g.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
    }
  }
  // track
  g.lineCap = 'round'; g.lineWidth = 2;
  for (let j = 1; j < G.pts.length; j++) {
    const a = P(...G.pts[j - 1]), b = P(...G.pts[j]);
    const glow = LUX.glow((S.frames[j - 1].lux + S.frames[j].lux) / 2);
    g.strokeStyle = `rgba(255,226,170,${(0.12 + 0.88 * glow).toFixed(3)})`;
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  }
  // current position + facing
  const f = S.frames[S.target];
  if (f) {
    const [px, py] = P(...G.pts[S.target]);
    if (f.h != null) {                       // translucent view cone in the facing direction
      const a = (f.h - 90) * Math.PI / 180, R = 34;
      const cg = g.createRadialGradient(px, py, 0, px, py, R);
      cg.addColorStop(0, 'rgba(255,255,255,.34)'); cg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = cg;
      g.beginPath(); g.moveTo(px, py); g.arc(px, py, R, a - 0.5, a + 0.5); g.closePath(); g.fill();
    }
    if (PEG.complete && PEG.naturalHeight) { // the street-view figure, feet on the position
      const ph = 26, pw = ph * PEG.naturalWidth / PEG.naturalHeight;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.ellipse(px, py, pw * 0.55, 2.2, 0, 0, Math.PI * 2); g.fill();
      g.drawImage(PEG, px - pw / 2, py - ph + 1, pw, ph);
    } else {
      g.fillStyle = '#fff'; g.strokeStyle = '#08090b'; g.lineWidth = 2;
      g.beginPath(); g.arc(px, py, 4, 0, Math.PI * 2); g.stroke(); g.fill();
    }
  }
  // north + scale
  g.fillStyle = 'rgba(139,144,153,1)'; g.font = '500 10px Inter, system-ui, sans-serif';
  g.fillText('N', w - 14, 14);
  const m = niceScale(60 / sc);
  g.fillRect(10, h - 12, m * sc, 1);
  g.fillText(`${m} m`, 10, h - 16);
}
const niceScale = (v) => [10, 20, 25, 50, 100, 200, 250, 500].find((s) => s >= v) || 1000;

/* ------------------------------------------------------------------ render loop */
function frameLoop(now) {
  if (!S.visible) return;
  S.raf = requestAnimationFrame(frameLoop);
  const U = material.uniforms;
  // playback
  if (S.playing && now - S.lastStep > STEP_MS) {
    if (S.target >= S.frames.length - 1) setPlaying(false);
    else {
      const next = S.frames[S.target + 1];
      const e = S.cache.get(`${next.s}/${next.i}`);
      if (S.target !== S.k || !e || e.ready || e.failed) { step(1); S.lastStep = now; }   // wait for the next frame to decode
    }
  }
  // cross-fade + a slight push-in so consecutive frames feel like walking
  const t = Math.min(1, Math.max(0, (now - S.fadeStart) / FADE_MS));
  const e = t * t * (3 - 2 * t);
  U.uMix.value = e;
  const A = S.A || BLACK, B = S.B || BLACK;
  U.tA.value = A.tex || BLACK.tex; U.dA.value = A.dtex || BLACK.dtex; U.uAspA.value = A.asp || 0.5625;
  U.tB.value = B.tex || BLACK.tex; U.dB.value = B.dtex || BLACK.dtex; U.uAspB.value = B.asp || 0.5625;
  U.uZoomA.value = 1 + 0.04 * S.dir * e;
  U.uZoomB.value = 1 - 0.03 * S.dir * (1 - e);
  // parallax: pointer + gentle walking sway while playing
  S.sway += ((S.playing ? 1 : 0) - S.sway) * 0.03;
  const ts = now / 1000;
  S.off.x += (S.offT.x - S.off.x) * 0.08;
  S.off.y += (S.offT.y - S.off.y) * 0.08;
  U.uOff.value.set(
    S.off.x + S.sway * (0.008 * Math.sin(ts * 0.9)) + 0.002 * Math.sin(ts * 0.31),
    S.off.y + S.sway * (0.003 * Math.sin(ts * 1.8)) + 0.0012 * Math.sin(ts * 0.23),
  );
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ input */
function onKey(ev) {
  if (!S.visible || !S.frames.length) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'select' || tag === 'input' || tag === 'textarea') return;
  if (ev.key === 'ArrowRight') { step(1); ev.preventDefault(); }
  else if (ev.key === 'ArrowLeft') { step(-1); ev.preventDefault(); }
  else if (ev.key === ' ' || ev.code === 'Space') {
    if (tag === 'button' && ev.target !== ui.play) return;
    if (ev.target === ui.play) return;            // the button handles its own activation
    setPlaying(!S.playing); ev.preventDefault();
  }
}
function onPointer(ev) {
  const r = ui.canvas.getBoundingClientRect();
  const nx = (ev.clientX - r.left) / r.width - 0.5, ny = (ev.clientY - r.top) / r.height - 0.5;
  S.offT.x = Math.max(-1, Math.min(1, nx * 2)) * PARALLAX;
  S.offT.y = -Math.max(-1, Math.min(1, ny * 2)) * PARALLAX * 0.6;
}
function stripScrub(ev) {
  const r = ui.stripCanvas.getBoundingClientRect();
  const k = Math.floor((ev.clientX - r.left) / r.width * S.frames.length);
  if (k !== S.target) goTo(k);
}
function stripHover(ev) {
  const r = ui.stripCanvas.getBoundingClientRect();
  const k = Math.floor((ev.clientX - r.left) / r.width * S.frames.length);
  const f = S.frames[k];
  if (!f) { ui.tip.hidden = true; return; }
  ui.tip.hidden = false;
  ui.tip.textContent = `${LUX.fmtLux(f.lux)} lux · ${LUX.level(f.lux)}`;
  const rr = root.getBoundingClientRect();
  ui.tip.style.left = `${ev.clientX - rr.left}px`;
  ui.tip.style.top = `${r.top - rr.top - 40}px`;
}

/* ------------------------------------------------------------------ data */
// pre-survey test runs (W1, 5:20-5:48 pm, same spot repeated) - hidden
const TEST_RUNS = new Set(['W1_2026-11-07_172047', 'W1_2026-11-07_172920', 'W1_2026-11-07_174431']);
async function loadIndex(base) {
  const r = await fetch(`${base}index.json`);
  if (!r.ok) throw new Error(`index.json ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('empty index');
  const sessions = new Map();
  for (const f of rows) {
    if (f.s == null || f.i == null || f.lat == null || f.lon == null) continue;
    if (TEST_RUNS.has(f.s)) continue;
    if (!sessions.has(f.s)) sessions.set(f.s, []);
    sessions.get(f.s).push(f);
  }
  for (const a of sessions.values()) a.sort((p, q) => p.i - q.i);
  const order = [...sessions.keys()].sort((a, b) => (sessions.get(a)[0].t || 0) - (sessions.get(b)[0].t || 0) || a.localeCompare(b));
  return { sessions, order };
}

function showMessage(title, sub) {
  ui.msg.innerHTML = `<div class="sv-msg-in"><div class="sv-msg-title">${title}</div>${sub ? `<div class="label">${sub}</div>` : ''}</div>`;
  ui.msg.hidden = false;
  root.classList.add('sv-empty');
}

/* ------------------------------------------------------------------ module */
export default {
  async mount(el, lux) {
    LUX = lux; root = el;
    if (!document.querySelector('link[data-view-css="street"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'css/street.css'; l.dataset.viewCss = 'street';
      document.head.appendChild(l);
    }
    el.innerHTML = `
      <canvas class="sv-gl" aria-label="Street View frame with depth parallax — move the pointer to look around"></canvas>
      <div class="sv-shade" aria-hidden="true"></div>
      <div class="sv-top">
        <label class="label" for="sv-walk">Walk</label>
        <select id="sv-walk" class="sv-select"></select>
      </div>
      <div class="sv-framemsg label" hidden>This frame could not be loaded</div>
      <div class="sv-hud">
        <div class="sv-row">
          <div class="sv-stats">
            <div class="sv-light">
              <div class="label">Light here</div>
              <div class="sv-luxrow"><span class="big sv-lux">—</span><span class="sv-unit">lux</span></div>
              <div class="sv-level"></div>
            </div>
            <dl class="sv-facts">
              <div><dt class="label">Facing</dt><dd class="sv-facing">—</dd></div>
              <div><dt class="label">Frame</dt><dd class="sv-frame">—</dd></div>
              <div><dt class="label">Walker</dt><dd><span class="sv-dot" aria-hidden="true"></span><span class="sv-walker">—</span></dd></div>
              <div><dt class="label">Nearest streetlight</dt><dd class="sv-lamp">—</dd></div>
            </dl>
          </div>
          <div class="sv-map panel"><canvas aria-label="Mini map of this walk, north up. Click to jump."></canvas></div>
        </div>
        <div class="sv-controls">
          <button class="btn sv-prev" type="button" aria-label="Previous frame">Previous</button>
          <button class="btn primary sv-play" type="button" aria-label="Play walk">Play</button>
          <button class="btn sv-next" type="button" aria-label="Next frame">Next</button>
          <div class="sv-stripwrap">
            <div class="label sv-striplabel">Light along this walk</div>
            <div class="sv-strip" role="slider" tabindex="0" aria-label="Light along this walk — drag to move" aria-valuemin="1"><canvas></canvas></div>
          </div>
        </div>
      </div>
      <div class="tooltip sv-tip" hidden></div>
      <img class="sv-drop" src="img/pegman.png" alt="" aria-hidden="true" hidden>
      <div class="loading sv-msg" hidden></div>`;
    const q = (s) => el.querySelector(s);
    ui = {
      canvas: q('.sv-gl'), select: q('.sv-select'), msg: q('.sv-msg'), frameMsg: q('.sv-framemsg'),
      lux: q('.sv-lux'), level: q('.sv-level'), lightBlock: q('.sv-light'), facing: q('.sv-facing'), frame: q('.sv-frame'),
      walker: q('.sv-walker'), dot: q('.sv-dot'), lamp: q('.sv-lamp'), mapCanvas: q('.sv-map canvas'),
      drop: q('.sv-drop'), prev: q('.sv-prev'), play: q('.sv-play'), next: q('.sv-next'), strip: q('.sv-strip'), stripCanvas: q('.sv-strip canvas'), tip: q('.sv-tip'),
    };
    try { initGL(ui.canvas); } catch (e) {
      console.warn('Street View: WebGL unavailable', e);
      showMessage('Street View needs WebGL', 'Your browser could not start WebGL.');
      renderer = null;
    }
    ui.prev.onclick = () => step(-1);
    ui.next.onclick = () => step(1);
    ui.play.onclick = () => setPlaying(!S.playing);
    ui.select.onchange = () => { setPlaying(false); selectSession(ui.select.value); scheduleHash(); };
    ui.canvas.addEventListener('pointermove', onPointer);
    ui.canvas.addEventListener('pointerdown', onPointer);
    ui.canvas.addEventListener('pointerleave', () => { S.offT.x = S.offT.y = 0; });
    let scrubbing = false;
    ui.strip.addEventListener('pointerdown', (ev) => { scrubbing = true; ui.strip.setPointerCapture(ev.pointerId); setPlaying(false); stripScrub(ev); });
    ui.strip.addEventListener('pointermove', (ev) => { if (scrubbing) stripScrub(ev); stripHover(ev); });
    ui.strip.addEventListener('pointerup', () => { scrubbing = false; });
    ui.strip.addEventListener('pointerleave', () => { ui.tip.hidden = true; });
    ui.mapCanvas.addEventListener('click', (ev) => {
      const G = S.mapGeom; if (!G?.P) return;
      const r = ui.mapCanvas.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      let best = -1, bd = Infinity;
      G.pts.forEach((p, j) => { const [px, py] = G.P(...p); const d = (px - mx) ** 2 + (py - my) ** 2; if (d < bd) { bd = d; best = j; } });
      if (best >= 0 && bd < 400) { setPlaying(false); goTo(best); }
    });
    ro = new ResizeObserver(resize); ro.observe(el);
    // lamps for "nearest streetlight" + mini map (optional)
    LUX.load('lamps.geojson').then((g) => {
      S.lamps = (g.features || []).filter((f) => f.geometry?.type === 'Point').map((f) => {
        const [x, y] = LUX.toXY(f.geometry.coordinates[1], f.geometry.coordinates[0]); return { x, y };
      });
      if (S.frames.length) { updateHud(S.target); }
    }).catch(() => {});
  },

  async show(params = {}) {
    S.visible = true;
    window.addEventListener('keydown', onKey);
    const token = ++S.showToken;
    const base = safeBase(params.sv);
    if (base !== S.base) {
      S.base = base; S.indexP = loadIndex(base);
      for (const e of S.cache.values()) { e.tex?.dispose(); e.dtex?.dispose(); }
      S.cache.clear(); S.A = S.B = BLACK; S.session = null; S.frames = []; S.mapGeom = null; S.sessions = null;
    }
    if (!renderer) return;
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(frameLoop);
    let idx;
    try { idx = await S.indexP; } catch (e) {
      if (token !== S.showToken) return;
      cancelAnimationFrame(S.raf);
      S.base = null;                       // retry on the next visit
      showMessage('Street View frames are still processing', 'The walk photos are being privacy-blurred and depth-mapped. Check back soon.');
      return;
    }
    if (token !== S.showToken) return;
    ui.msg.hidden = true; root.classList.remove('sv-empty');
    if (S.sessions !== idx.sessions) {
      S.sessions = idx.sessions; S.order = idx.order;
      ui.select.innerHTML = idx.order.map((s) => {
        const a = idx.sessions.get(s), w = walkerOfRow(a[0]);
        const label = `${w ? `Walker ${w}` : s} · ${a[0].t ? fmtTime(a[0].t) : s} · ${a.length} frames`;
        return `<option value="${s.replace(/"/g, '&quot;')}">${label}</option>`;
      }).join('');
    }
    const s = idx.sessions.has(params.session) ? params.session : (S.session || idx.order[0]);
    const wasSession = S.session;
    selectSession(s, params.index);
    if (wasSession === s && !S.entered) dropIn();
    S.entered = true;
    resize();
  },

  hide() {
    S.visible = false;
    setPlaying(false);
    cancelAnimationFrame(S.raf);
    window.removeEventListener('keydown', onKey);
    clearTimeout(S.hashTimer);
    if (ui.tip) ui.tip.hidden = true;
    S.entered = false;
  },
};
