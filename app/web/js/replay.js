// Replay — the survey night, walker by walker, on a 2D canvas in local metres.
// export default { mount(el, LUX), show(params), hide() }

const TZ = 'America/Chicago';
const NIGHT_SEC_PER_REAL_SEC = 240;      // 1 night-minute per 0.25 s at 1×
const RECENT = 120;                       // seconds of "fresh" trail
const BREAK_GAP_S = 20, BREAK_GAP_M = 60; // split trails on GPS dropouts
const ACTIVE_GRACE = 15;                  // a walker counts as "out" this long after the last reading

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtClock = (s) => clockFmt.format(new Date(s * 1000)).replace(' AM', ' am').replace(' PM', ' pm');
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

function lowerBound(arr, v) { // first index with arr[i] > v  (i.e. count of items <= v)
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}
function hexToRgb(h) {
  const m = h.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [154, 163, 178];
}

let L, root, canvas, ctx, bgCanvas, bgDirty = true;
let sessions = [], walkers = [], allSec, allDarkCum, photosBySession = new Map();
let tMin = 0, tMax = 1, T = 0, playing = false, speed = 1, raf = 0, lastTs = 0;
let view = { cx: 0, cy: 0, s: 1 };   // world centre (m) + scale (px per m)
let W = 0, H = 0, dpr = 1;
let ui = {};
let popup = null;

function css() {
  if (document.getElementById('css-replay')) return;
  const l = document.createElement('link'); l.id = 'css-replay'; l.rel = 'stylesheet'; l.href = 'css/replay.css';
  document.head.appendChild(l);
}

// ---------- data ----------
function prepare(rows, photos) {
  const bySes = new Map();
  for (const r of rows) {
    if (r.x == null || r.y == null || r.sec == null) continue;
    if (!bySes.has(r.session)) bySes.set(r.session, []);
    bySes.get(r.session).push(r);
  }
  sessions = [...bySes.entries()].map(([id, rs]) => {
    rs.sort((a, b) => a.sec - b.sec);
    const n = rs.length;
    const t = new Float64Array(n), x = new Float32Array(n), y = new Float32Array(n), lux = new Float32Array(n), dist = new Float64Array(n);
    const brk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = rs[i]; t[i] = r.sec; x[i] = r.x; y[i] = r.y; lux[i] = r.lux ?? 0;
      if (i) {
        const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
        const gap = t[i] - t[i - 1];
        brk[i] = gap > BREAK_GAP_S || d > BREAK_GAP_M ? 1 : 0;
        dist[i] = dist[i - 1] + (brk[i] ? 0 : d);
      }
    }
    const w = +rs[0].walker || +(id.match(/^W(\d)/) || [0, 0])[1] || 0;
    return { id, walker: w, n, t, x, y, lux, dist, brk, t0: t[0], t1: t[n - 1], color: L.walkerColor(w), rgb: hexToRgb(L.walkerColor(w)) };
  }).sort((a, b) => a.t0 - b.t0);

  const secs = [];
  for (const s of sessions) for (let i = 0; i < s.n; i++) secs.push([s.t[i], s.lux[i] < 5 ? 1 : 0]);
  secs.sort((a, b) => a[0] - b[0]);
  allSec = new Float64Array(secs.length); allDarkCum = new Uint32Array(secs.length + 1);
  secs.forEach((v, i) => { allSec[i] = v[0]; allDarkCum[i + 1] = allDarkCum[i] + v[1]; });
  tMin = sessions.length ? Math.min(...sessions.map((s) => s.t0)) : 0;
  tMax = sessions.length ? Math.max(...sessions.map((s) => s.t1)) : 1;

  walkers = [1, 2, 3, 4].map((w) => ({ w, color: L.walkerColor(w), sessions: sessions.filter((s) => s.walker === w) })).filter((w) => w.sessions.length);

  for (const p of photos) {
    if (p.session == null || p.epoch == null) continue;
    if (!photosBySession.has(p.session)) photosBySession.set(p.session, []);
    photosBySession.get(p.session).push(p);
  }
  for (const arr of photosBySession.values()) arr.sort((a, b) => a.epoch - b.epoch);
}

function nearestPhoto(session, sec) {
  const arr = photosBySession.get(session);
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].epoch < sec) lo = m + 1; else hi = m; }
  const c = [arr[lo], arr[lo - 1]].filter(Boolean);
  return c.sort((a, b) => Math.abs(a.epoch - sec) - Math.abs(b.epoch - sec))[0];
}

// index of last reading with t <= T, or -1
function idxAt(s, tt) { return lowerBound(s.t, tt) - 1; }

// ---------- view transform ----------
const toScreen = (x, y) => [W / 2 + (x - view.cx) * view.s, H / 2 - (y - view.cy) * view.s];
const toWorld = (px, py) => [view.cx + (px - W / 2) / view.s, view.cy - (py - H / 2) / view.s];

function fit() {
  if (!sessions.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of sessions) for (let i = 0; i < s.n; i++) {
    if (s.x[i] < x0) x0 = s.x[i]; if (s.x[i] > x1) x1 = s.x[i];
    if (s.y[i] < y0) y0 = s.y[i]; if (s.y[i] > y1) y1 = s.y[i];
  }
  // keep clear of the top bar, legend (left) and bottom panel
  const wide = W > 900;
  const padL = wide ? 300 : 16, padR = wide ? 40 : 16, padT = wide ? 90 : 210, padB = wide ? 150 : 200;
  const aw = Math.max(100, W - padL - padR), ah = Math.max(100, H - padT - padB);
  view.s = Math.min(aw / (x1 - x0 || 1), ah / (y1 - y0 || 1));
  // centre the data inside the free area
  const fcx = padL + aw / 2, fcy = padT + ah / 2;
  view.cx = (x0 + x1) / 2 - (fcx - W / 2) / view.s;
  view.cy = (y0 + y1) / 2 + (fcy - H / 2) / view.s;
  bgDirty = true;
}

function resize() {
  const r = root.getBoundingClientRect();
  const nw = Math.max(1, r.width), nh = Math.max(1, r.height);
  const first = W === 0;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  // keep the same world point in the centre when resizing
  W = nw; H = nh;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
  if (first) fit();
  bgDirty = true; draw();
}

// ---------- drawing ----------
let buildings = [];
function drawBackground() {
  const b = bgCanvas.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  // building outlines (very faint)
  if (buildings.length) {
    b.strokeStyle = 'rgba(255,255,255,0.06)'; b.lineWidth = 1;
    for (const ring of buildings) {
      b.beginPath();
      ring.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? b.lineTo(px, py) : b.moveTo(px, py); });
      b.closePath(); b.stroke();
    }
  }
  // measured light, as light: soft warm dots
  const r = Math.max(1.4, Math.min(6, view.s * 2.6));
  bgDensity = Math.max(0.35, Math.min(1, view.s * 0.9));
  b.globalCompositeOperation = 'lighter';
  for (const s of sessions) for (let i = 0; i < s.n; i++) {
    const g = L.glow(s.lux[i]);
    if (g <= 0.01) continue;
    const [px, py] = toScreen(s.x[i], s.y[i]);
    if (px < -10 || py < -10 || px > W + 10 || py > H + 10) continue;
    b.globalAlpha = Math.min(1, g * 0.25 * bgDensity);
    b.drawImage(sprite, px - r, py - r, r * 2, r * 2);
  }
  b.globalAlpha = 1; b.globalCompositeOperation = 'source-over';
  bgDirty = false;
}

let sprite, bgDensity = 1;
function makeSprite() {
  sprite = document.createElement('canvas'); sprite.width = sprite.height = 64;
  const g = sprite.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,226,170,1)'); grad.addColorStop(0.35, 'rgba(255,226,170,.45)'); grad.addColorStop(1, 'rgba(255,226,170,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
}

function draw() {
  if (!ctx) return;
  if (bgDirty) drawBackground();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const heads = [];
  for (const s of sessions) {
    if (s.t0 > T) continue;
    const k = idxAt(s, T);
    if (k < 0) continue;
    const [r, g, bl] = s.rgb;
    // full trail (thin, faint)
    strokeRange(s, 0, k, `rgba(${r},${g},${bl},0.6)`, 1.1);
    // last ~2 min (brighter)
    const kr = Math.max(0, lowerBound(s.t, T - RECENT) - 1);
    strokeRange(s, kr, k, `rgba(${r},${g},${bl},0.95)`, 2);
    if (T <= s.t1 + ACTIVE_GRACE) heads.push([s, k]);
  }
  for (const [s, k] of heads) {
    const [px, py] = toScreen(s.x[k], s.y[k]);
    const [r, g, bl] = s.rgb;
    const halo = ctx.createRadialGradient(px, py, 0, px, py, 22);
    halo.addColorStop(0, `rgba(${r},${g},${bl},0.45)`); halo.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(8,9,11,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  if (popup) {
    const [px, py] = toScreen(popup.x, popup.y);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    placePopup();
  }
}

function strokeRange(s, a, b, style, width) {
  if (b <= a) return;
  ctx.strokeStyle = style; ctx.lineWidth = width;
  ctx.beginPath();
  let [px, py] = toScreen(s.x[a], s.y[a]); ctx.moveTo(px, py);
  for (let i = a + 1; i <= b; i++) {
    [px, py] = toScreen(s.x[i], s.y[i]);
    if (s.brk[i]) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// ---------- UI ----------
function buildUI() {
  root.innerHTML = `
    <canvas class="rp-canvas" aria-label="Map replay of the survey walks. Drag to pan, scroll to zoom, click a trail to open Street View."></canvas>
    <aside class="panel rp-legend" aria-label="Walkers">
      <div class="rp-legend-head label">Walkers</div>
      <ul class="rp-walkers"></ul>
      <p class="rp-hint">Drag to pan · scroll to zoom · click a trail</p>
    </aside>
    <div class="panel rp-popup" hidden role="dialog" aria-label="Trail point"></div>
    <div class="panel rp-bar">
      <button class="btn primary rp-play" type="button" aria-label="Play">Play</button>
      <div class="rp-clock" aria-live="off">—</div>
      <div class="rp-time">
        <label class="rp-sr" for="rp-slider">Time of night</label>
        <input id="rp-slider" class="rp-slider" type="range" min="0" max="1" step="1" value="0">
        <div class="rp-ends label"><span class="rp-start"></span><span class="rp-end"></span></div>
      </div>
      <div class="rp-speeds" role="group" aria-label="Playback speed">
        <button class="chip" type="button" data-speed="1" aria-pressed="true">1×</button>
        <button class="chip" type="button" data-speed="4" aria-pressed="false">4×</button>
        <button class="chip" type="button" data-speed="16" aria-pressed="false">16×</button>
      </div>
      <dl class="rp-stats">
        <div><dt class="label">Walkers out</dt><dd class="rp-out">0</dd></div>
        <div><dt class="label">Readings so far</dt><dd class="rp-count">0</dd></div>
        <div><dt class="label">Dark so far</dt><dd class="rp-dark">—</dd></div>
      </dl>
    </div>`;
  const q = (s) => root.querySelector(s);
  canvas = q('.rp-canvas'); ctx = canvas.getContext('2d');
  bgCanvas = document.createElement('canvas');
  ui = {
    play: q('.rp-play'), clock: q('.rp-clock'), slider: q('.rp-slider'), start: q('.rp-start'), end: q('.rp-end'),
    out: q('.rp-out'), count: q('.rp-count'), dark: q('.rp-dark'), walkers: q('.rp-walkers'), popup: q('.rp-popup'),
    speeds: [...root.querySelectorAll('[data-speed]')],
  };
  ui.slider.min = tMin; ui.slider.max = tMax; ui.slider.value = tMin;
  ui.start.textContent = fmtClock(tMin); ui.end.textContent = fmtClock(tMax);
  ui.slider.addEventListener('input', () => { setT(+ui.slider.value); });
  ui.play.addEventListener('click', () => (playing ? pause() : play()));
  ui.speeds.forEach((b) => b.addEventListener('click', () => {
    speed = +b.dataset.speed;
    ui.speeds.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  ui.walkers.innerHTML = walkers.map((w) => `
    <li class="rp-w${w.sessions.length ? '' : ' none'}" data-w="${w.w}">
      <span class="rp-dot" style="background:${w.color}"></span>
      <div class="rp-wbody">
        <div class="rp-wname">Walker ${w.w}<span class="rp-wnow"></span></div>
        <div class="rp-wmeta label"></div>
      </div>
    </li>`).join('');
  ui.wrows = walkers.map((w) => ({ now: ui.walkers.querySelector(`[data-w="${w.w}"] .rp-wnow`), meta: ui.walkers.querySelector(`[data-w="${w.w}"] .rp-wmeta`) }));
}

function updateUI() {
  ui.clock.textContent = fmtClock(T);
  if (+ui.slider.value !== Math.round(T)) ui.slider.value = Math.round(T);
  ui.slider.setAttribute('aria-valuetext', fmtClock(T));
  const n = lowerBound(allSec, T);
  ui.count.textContent = n.toLocaleString();
  ui.dark.textContent = n ? `${Math.round((allDarkCum[n] / n) * 100)}%` : '—';
  let out = 0;
  walkers.forEach((w, wi) => {
    let cnt = 0, dist = 0, cur = null;
    for (const s of w.sessions) {
      const k = idxAt(s, T);
      if (k < 0) continue;
      cnt += k + 1; dist += s.dist[k];
      if (T <= s.t1 + ACTIVE_GRACE) cur = s.lux[k];
    }
    if (cur != null) out++;
    const row = ui.wrows[wi];
    if (!w.sessions.length) { row.meta.textContent = 'No readings'; row.now.textContent = ''; return; }
    row.meta.textContent = cnt ? `${cnt.toLocaleString()} readings · ${fmtDist(dist)}` : `Starts ${fmtClock(w.sessions[0].t0)}`;
    row.now.textContent = cur != null ? `${L.fmtLux(cur)} lux · ${L.level(cur)}` : (cnt ? 'Not walking' : '');
    row.now.classList.toggle('off', cur == null);
  });
  ui.out.textContent = out;
}

function setT(t) {
  T = Math.max(tMin, Math.min(tMax, t));
  updateUI(); draw();
}

// ---------- playback ----------
function play() {
  if (T >= tMax) T = tMin;
  playing = true; ui.play.textContent = 'Pause'; ui.play.setAttribute('aria-label', 'Pause');
  lastTs = 0; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
}
function pause() {
  playing = false; ui.play.textContent = 'Play'; ui.play.setAttribute('aria-label', 'Play');
  cancelAnimationFrame(raf);
}
function tick(ts) {
  if (!playing) return;
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  let nt = T + dt * NIGHT_SEC_PER_REAL_SEC * speed;
  // skip long stretches when nobody is out
  const anyActive = sessions.some((s) => s.t0 <= nt && nt <= s.t1 + ACTIVE_GRACE);
  if (!anyActive) {
    const next = sessions.filter((s) => s.t0 > nt).reduce((m, s) => Math.min(m, s.t0), Infinity);
    if (next !== Infinity && next - nt > 90) nt = next - 20;
  }
  if (nt >= tMax) { setT(tMax); pause(); return; }
  setT(nt);
  raf = requestAnimationFrame(tick);
}

// ---------- interaction ----------
function pick(px, py) {
  let best = null, bd = 14 * 14;
  for (const s of sessions) {
    if (s.t0 > T) continue;
    const k = idxAt(s, T);
    for (let i = 0; i <= k; i++) {
      const [sx, sy] = toScreen(s.x[i], s.y[i]);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      // prefer current heads by small bias
      const dd = i === k && T <= s.t1 + ACTIVE_GRACE ? d * 0.5 : d;
      if (dd < bd) { bd = dd; best = { s, i }; }
    }
  }
  return best;
}

function openPopup(hit) {
  const { s, i } = hit;
  const sec = s.t[i], lux = s.lux[i];
  const ph = nearestPhoto(s.id, sec);
  popup = { x: s.x[i], y: s.y[i] };
  const link = ph && Math.abs(ph.epoch - sec) < 30
    ? `<a href="#street?session=${encodeURIComponent(s.id)}&index=${ph.index}" class="rp-go" data-session="${s.id}" data-index="${ph.index}">Open Street View here →</a>`
    : '<span class="label">No photo near this moment</span>';
  ui.popup.innerHTML = `
    <button class="rp-x" type="button" aria-label="Close">×</button>
    <div class="rp-ptitle"><span class="rp-dot" style="background:${s.color}"></span>Walker ${s.walker} · ${fmtClock(sec)}</div>
    <div class="rp-plux"><span class="rp-pval">${L.fmtLux(lux)}</span> lux <span class="muted">· ${L.level(lux)}</span></div>
    ${link}`;
  ui.popup.hidden = false;
  ui.popup.querySelector('.rp-x').onclick = closePopup;
  const go = ui.popup.querySelector('.rp-go');
  if (go) go.onclick = (e) => { e.preventDefault(); L.go('street', { session: go.dataset.session, index: go.dataset.index }); };
  draw();
}
function closePopup() { popup = null; ui.popup.hidden = true; draw(); }
function placePopup() {
  if (!popup) return;
  const [px, py] = toScreen(popup.x, popup.y);
  const w = ui.popup.offsetWidth || 220, h = ui.popup.offsetHeight || 100;
  let left = px + 16, top = py - h / 2;
  if (left + w > W - 12) left = px - w - 16;
  top = Math.max(76, Math.min(H - h - 12, top));
  ui.popup.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function bindInput() {
  const pts = new Map();
  let moved = false, pinch0 = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.offsetX, e.offsetY]); moved = false;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: view.s }; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) {
      const hit = pick(e.offsetX, e.offsetY);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      return;
    }
    const prev = pts.get(e.pointerId);
    const dx = e.offsetX - prev[0], dy = e.offsetY - prev[1];
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (Math.abs(dx) + Math.abs(dy) > 0) moved = moved || Math.abs(dx) + Math.abs(dy) > 2;
    if (pts.size === 1) {
      view.cx -= dx / view.s; view.cy += dy / view.s;
      canvas.style.cursor = 'grabbing';
    } else if (pts.size === 2 && pinch0) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch0.s * d) / pinch0.d / view.s);
      moved = true;
    }
    bgDirty = true; draw();
  });
  const up = (e) => {
    const wasOne = pts.size === 1;
    pts.delete(e.pointerId); pinch0 = null;
    canvas.style.cursor = 'grab';
    if (wasOne && !moved && e.type === 'pointerup') {
      const hit = pick(e.offsetX, e.offsetY);
      if (hit) openPopup(hit); else if (popup) closePopup();
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    bgDirty = true; draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { fit(); draw(); });
  window.addEventListener('keydown', (e) => {
    if (!root.classList.contains('active') || e.target.closest('input,button,a')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  });
}
function zoomAt(px, py, f) {
  const ns = Math.max(0.05, Math.min(40, view.s * f));
  const [wx, wy] = toWorld(px, py);
  view.s = ns;
  view.cx = wx - (px - W / 2) / ns; view.cy = wy + (py - H / 2) / ns;
}

// ---------- module ----------
export default {
  async mount(el, LUX) {
    L = LUX; root = el; css();
    const [rows, photos, bld] = await Promise.all([
      L.load('readings_1hz.csv'),
      L.load('photos_index.csv').catch(() => []),
      L.load('buildings.geojson').catch(() => ({ features: [] })),
    ]);
    prepare(rows, photos);
    buildings = [];
    for (const f of bld.features || []) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const p of polys) if (p[0]) buildings.push(p[0].map(([lon, lat]) => L.toXY(lat, lon)));
    }
    makeSprite();
    buildUI();
    bindInput();
    T = tMax; // open on the whole night; Play replays from the start
    new ResizeObserver(() => resize()).observe(root);
    resize();
    updateUI();
  },
  show(params) {
    if (params && params.t) setT(+params.t);
    resize();
  },
  hide() { pause(); },
};
