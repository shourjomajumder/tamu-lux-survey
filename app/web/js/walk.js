// Walker mode — a phone page for one walker during a live survey.
// Sign in as Walker N (1–4 on the picker; any number via #walk?w=N) with the team code, share location with Survey Control (heartbeat every 3 s),
// receive a route assignment (polled every 10 s) and get turn-by-turn guidance along it on a 2D canvas map.
// Module API: default export { mount(el, LUX), show(params), hide() }.

const DEFAULT_API = 'https://tamu-lux-survey.netlify.app';
const HEARTBEAT_MS = 3000;
const POLL_MS = 10000;
const SNAP_M = 40;          // accept a route match within this distance
const OFF_ROUTE_M = 25;     // banner beyond this
const BUZZ_M = 20;          // vibrate this far before a turn
const WIN_BACK = 30, WIN_AHEAD = 160;   // progress search window (m along route)
const LIVE_STALE_MS = 12000;
// same fixed palette as Survey Control (first four = --w1..--w4)
const PALETTE = ['#5aa9ff', '#ff9f43', '#7ee0a1', '#d58cff', '#ffd84d', '#3fd5d5', '#ff6fb5', '#c7cdd6'];
const walkerColor = (n) => (n >= 1 && n <= 4 ? L.walkerColor(n) : PALETTE[(Math.max(1, n) - 1) % PALETTE.length]);
const LS = { walker: 'lux.walk.walker', code: 'lux.walk.code', prog: 'lux.walk.progress' };

let L = null, root = null, ui = {};
let API = DEFAULT_API;

// session state
let walker = null, code = '', live = false, visible = false;
let watchId = null, wakeLock = null, battery = null;
let fix = null;                 // {lat, lon, x, y, acc, speed, course, t}
let geoErr = null;              // null | 'denied' | 'unavailable' | 'insecure' | 'timeout'
let compass = null;             // degrees clockwise from north, from DeviceOrientation
let hbTimer = 0, pollTimer = 0, tickTimer = 0, hbInFlight = false, pollInFlight = false;
let lastOk = 0, netFail = false;

// route state
let assignment = null, route = null, R = null;   // R = prepared route geometry
let assignKey = '';
let prog = null, offM = null, buzzed = new Set(), wasOff = false, routeStart = 0;

// map state
let ctx = null, W = 0, H = 0, dpr = 1, raf = 0, dirty = true;
let cam = { cx: 0, cy: 0, s: 1.6 }, follow = true, headingUp = false;
let ctxData = { bld: [], dots: null };
const pointers = new Map(); let gesture = null;

// ---------- helpers ----------
const $ = (s) => root.querySelector(s);
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();
function fmtDist(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.max(5, Math.round(m / 5) * 5)} m`;
}
function fmtDur(s) {
  s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
function toEpochMs(at) {
  if (at == null) return null;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;
  const n = Date.parse(at); return isNaN(n) ? null : n;
}
function lcFirst(s) { return s ? s[0].toLowerCase() + s.slice(1) : s; }

// ---------- icons ----------
const ICON = {
  start: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
  straight: '<path d="M12 20V5M6.5 10.5 12 5l5.5 5.5"/>',
  left: '<path d="M16 20v-7a4 4 0 0 0-4-4H5M9 5 5 9l4 4"/>',
  right: '<path d="M8 20v-7a4 4 0 0 1 4-4h7M15 5l4 4-4 4"/>',
  'slight-left': '<path d="M15 20v-6.5L8 6.5M8 12.5v-6h6"/>',
  'slight-right': '<path d="M9 20v-6.5l7-7M10 6.5h6v6"/>',
  'sharp-left': '<path d="M15 20V5L6 14M6 8v6h6"/>',
  'sharp-right': '<path d="M9 20V5l9 9M18 8v6h-6"/>',
  uturn: '<path d="M16 20V10a4 4 0 0 0-8 0v7M4.5 13.5 8 17l3.5-3.5"/>',
  finish: '<path d="M6 21V4M6 4h11l-2.2 4L17 12H6"/>',
  off: '<path d="M12 3.2 21.6 19.8H2.4z" style="fill:var(--warn);stroke:var(--warn)" stroke-linejoin="miter"/>',
  wait: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  recenter: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  compass: '<path d="M12 3 16 13H8z" fill="currentColor" stroke="none"/><path d="M12 21 8 13h8z"/>',
};
const icon = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.straight}</svg>`;

// ---------- css ----------
function css() {
  if (document.getElementById('css-walk')) return;
  const l = document.createElement('link'); l.id = 'css-walk'; l.rel = 'stylesheet'; l.href = 'css/walk.css';
  document.head.appendChild(l);
}

// ---------- network ----------
async function api(method, body) {
  const url = method === 'GET' ? `${API}/api/control?walker=${walker}` : `${API}/api/control`;
  const opt = { method, headers: { 'x-control-pass': code }, cache: 'no-store' };
  if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000); opt.signal = ctrl.signal;
  try {
    const r = await fetch(url, opt);
    let j = null; try { j = await r.json(); } catch { /* empty */ }
    return { status: r.status, ok: r.ok && j?.ok !== false, json: j };
  } finally { clearTimeout(to); }
}

async function poll() {
  if (!live || pollInFlight) return;
  pollInFlight = true;
  try {
    const r = await api('GET');
    if (r.status === 401) return kicked();
    if (r.ok) { markOk(); applyAssignment(r.json.assignment || null, r.json.route || null); } else markFail();
  } catch { markFail(); } finally { pollInFlight = false; }
}

async function heartbeat() {
  if (!live || !visible || hbInFlight || !fix || document.visibilityState === 'hidden') return;
  hbInFlight = true;
  const heading = currentHeading();
  const body = {
    action: 'heartbeat', walker,
    lat: +fix.lat.toFixed(7), lon: +fix.lon.toFixed(7),
    h_acc: fix.acc != null ? Math.round(fix.acc * 10) / 10 : null,
    heading: heading != null ? Math.round(heading) : null,
    speed: fix.speed != null ? Math.round(fix.speed * 100) / 100 : null,
    route_id: route ? route.id : null,
    route_pct: route && prog != null ? Math.round((prog / R.total) * 1000) / 1000 : null,
    progress_m: route && prog != null ? Math.round(prog) : null,
    off_route_m: route && offM != null ? Math.round(offM) : null,
    battery: battery ? Math.round(battery.level * 100) / 100 : null,
    t: Math.floor(now() / 1000),
  };
  try {
    const r = await api('POST', body);
    if (r.status === 401) return kicked();
    if (r.ok) {
      markOk();
      const a = r.json?.assignment ?? null;
      if (keyOf(a) !== assignKey) poll();     // assignment changed: fetch the route
    } else markFail();
  } catch { markFail(); } finally { hbInFlight = false; }
}

function markOk() { lastOk = now(); netFail = false; updateStatus(); }
function markFail() { netFail = true; updateStatus(); }

function kicked() {
  stop();
  showJoin('The team code changed — sign in again.');
}

// ---------- assignment ----------
const keyOf = (a) => (a && a.route_id != null ? `${a.route_id}|${a.at ?? ''}` : '');

function applyAssignment(a, rt) {
  const k = keyOf(a);
  if (k === assignKey && (!a || route)) return;
  if (a && !rt) return;   // wait for a response that carries the route
  assignKey = k; assignment = a;
  if (a && rt) {
    route = rt; R = prepRoute(rt);
    const saved = (() => { try { return JSON.parse(lsGet(LS.prog) || 'null'); } catch { return null; } })();
    prog = saved && saved.key === `${walker}|${k}` ? saved.prog : null;
    offM = null; buzzed = new Set(); wasOff = false;
    routeStart = toEpochMs(a.at) || now();
    toast(`New route assigned: ${rt.name}`);
    if (!toastMute) vibrate([80, 60, 80]);
    if (fix) snap();
  } else {
    if (route) toast('Route cleared by Survey Control');
    route = null; R = null; prog = null; offM = null;
  }
  renderGuide(); renderSheet(); dirty = true;
}

function prepRoute(rt) {
  const n = rt.pts.length, x = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = L.toXY(rt.pts[i][0], rt.pts[i][1]); x[i] = a; y[i] = b;
    cum[i] = rt.cum && rt.cum.length === n ? rt.cum[i] : (i ? cum[i - 1] + Math.hypot(a - x[i - 1], b - y[i - 1]) : 0);
  }
  const total = rt.total || cum[n - 1] || 1;
  const steps = (rt.steps || []).slice().sort((p, q) => p.at - q.at);
  return { n, x, y, cum, total, steps };
}

function pointAt(s) {
  const { cum, x, y, n } = R;
  if (s <= 0) return [x[0], y[0]]; if (s >= cum[n - 1]) return [x[n - 1], y[n - 1]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const f = (s - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
  return [x[lo] + (x[hi] - x[lo]) * f, y[lo] + (y[hi] - y[lo]) * f];
}

// nearest point on route segments whose span overlaps [s0, s1]; returns {d, s}
function nearest(px, py, s0 = -Infinity, s1 = Infinity, prefer = false) {
  const { x, y, cum, n } = R; let best = { d: Infinity, s: null }; const cands = [];
  for (let i = 0; i < n - 1; i++) {
    if (cum[i + 1] < s0 || cum[i] > s1) continue;
    const dx = x[i + 1] - x[i], dy = y[i + 1] - y[i], L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - x[i]) * dx + (py - y[i]) * dy) / L2 : 0; t = clamp(t, 0, 1);
    const d = Math.hypot(px - (x[i] + dx * t), py - (y[i] + dy * t));
    const s = cum[i] + (cum[i + 1] - cum[i]) * t;
    if (prefer) cands.push({ d, s });
    if (d < best.d) best = { d, s };
  }
  if (prefer && best.s != null) {
    // out-and-back routes pass the same spot twice: take the earliest pass that is about as close
    const ok = cands.filter((c) => c.d <= best.d + 8).sort((a, b) => a.s - b.s);
    if (ok.length) return ok[0];
  }
  return best;
}

function snap() {
  if (!R || !fix) return;
  const { x, y } = fix;
  if (prog == null) {
    const g = nearest(x, y, -Infinity, Infinity, true);
    if (g.d <= SNAP_M) { prog = g.s; offM = g.d; } else offM = null;   // not reached the route yet
  } else {
    const w = nearest(x, y, prog - WIN_BACK, prog + WIN_AHEAD);
    offM = w.d;
    if (w.d <= SNAP_M) prog = Math.max(prog, w.s);
    else {
      // skipped ahead (e.g. walked a shortcut): re-acquire only forward and only when clearly on the line
      const g = nearest(x, y, prog + WIN_AHEAD, Infinity, true);
      if (g.d <= 15) { prog = g.s; offM = g.d; }
    }
  }
  if (prog != null) {
    prog = clamp(prog, 0, R.total);
    lsSet(LS.prog, JSON.stringify({ key: `${walker}|${assignKey}`, prog }));
  }
  // vibrate before turns, and once on going off route
  if (prog != null) {
    const nx = nextStep();
    if (nx && nx.icon !== 'start' && nx.icon !== 'straight' && nx.at - prog <= BUZZ_M && !buzzed.has(nx.i)) {
      buzzed.add(nx.i); vibrate([120, 80, 120]);
    }
    const off = offM != null && offM > OFF_ROUTE_M;
    if (off && !wasOff) vibrate([300]);
    wasOff = off;
  }
}
function vibrate(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch { /* ignore */ } }

function nextStep() {
  if (!R || prog == null) return null;
  return R.steps.find((s) => s.at > prog + 2) || null;
}

// ---------- location + heading ----------
function startGeo() {
  geoErr = null;
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') { geoErr = 'insecure'; renderGuide(); updateStatus(); return; }
  if (!('geolocation' in navigator)) { geoErr = 'unavailable'; renderGuide(); updateStatus(); return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function onPos(p) {
  const c = p.coords; const [x, y] = L.toXY(c.latitude, c.longitude);
  // GPS course when the phone reports one; otherwise derive it from movement since the last clear step
  let course = (c.heading != null && !isNaN(c.heading) && (c.speed ?? 0) > 0.4) ? c.heading : fix?.course ?? null;
  if (course == null || c.heading == null || isNaN(c.heading)) {
    const a = ui.lastMove;
    if (!a) ui.lastMove = [x, y];
    else if (Math.hypot(x - a[0], y - a[1]) > Math.max(4, (c.accuracy || 5) * 0.8)) {
      course = (Math.atan2(x - a[0], y - a[1]) * 180 / Math.PI + 360) % 360; ui.lastMove = [x, y];
    }
  }
  fix = { lat: c.latitude, lon: c.longitude, x, y, acc: c.accuracy, speed: c.speed, course, t: now() };
  geoErr = null;
  snap(); renderGuide(); renderSheet(); updateStatus(); dirty = true;
  if (!ui.hadFix) { ui.hadFix = true; heartbeat(); }
}
function onPosErr(e) {
  if (e.code === 1) geoErr = 'denied';
  else if (e.code === 2) geoErr = 'unavailable';
  else if (!fix) geoErr = 'timeout';
  renderGuide(); updateStatus();
}

function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  h = (h + so + 360) % 360;
  if (compass == null) compass = h;
  else { let d = ((h - compass + 540) % 360) - 180; compass = (compass + d * 0.25 + 360) % 360; }
  dirty = true;
}
function currentHeading() {
  if (compass != null) return compass;
  if (fix && fix.course != null) return fix.course;
  return null;
}
function requestOrientation() {
  // iOS 13+: must be called inside a user gesture
  try {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      return D.requestPermission().then((s) => { if (s === 'granted') listenOrient(); }).catch(() => {});
    }
  } catch { /* ignore */ }
  listenOrient();
  return Promise.resolve();
}
function listenOrient() {
  if (ui.orientOn) return; ui.orientOn = true;
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
  else window.addEventListener('deviceorientation', onOrient);
}

async function lockScreen() {
  if (!('wakeLock' in navigator) || wakeLock || !live || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { wakeLock = null; }
}
function onVisibility() {
  if (document.visibilityState === 'visible') { lockScreen(); if (live && visible) { poll(); heartbeat(); } }
  updateStatus();
}

// ---------- start / stop ----------
async function start(fromContinue) {
  const orient = requestOrientation();   // first thing in the tap (iOS permission prompt)
  const w = walker, c = (fromContinue ? code : ui.code.value.trim());
  ui.err.textContent = '';
  if (!w) { ui.err.textContent = 'Pick your walker number.'; return; }
  if (!c) { ui.err.textContent = 'Enter the team code.'; ui.code.focus(); return; }
  code = c;
  ui.go.disabled = true; ui.go.textContent = 'Checking…';
  let r;
  try { r = await api('GET'); } catch { r = null; }
  ui.go.disabled = false; ui.go.textContent = 'Start sharing location';
  if (!r) { ui.err.textContent = "Can't reach Survey Control. Check your connection and try again."; return; }
  if (r.status === 401) { ui.err.textContent = 'Wrong code'; lsSet(LS.code, null); renderContinue(); ui.code.select(); return; }
  if (!r.ok) { ui.err.textContent = `Survey Control answered with an error (${r.status}). Try again.`; return; }
  await orient;
  lsSet(LS.walker, String(w)); lsSet(LS.code, c);
  live = true; lastOk = now(); netFail = false;
  assignKey = ''; route = null; R = null; prog = null; ui.hadFix = false; ui.framed = false;
  showMain();
  applyAssignmentQuiet(r.json.assignment || null, r.json.route || null);
  startGeo(); lockScreen();
  if (navigator.getBattery && !battery) navigator.getBattery().then((b) => { battery = b; }).catch(() => {});
  resume();
}
function applyAssignmentQuiet(a, rt) {
  // on sign-in: no "new route" toast for a route that was already assigned
  toastMute = true; applyAssignment(a, rt); toastMute = false;
}
let toastMute = false;

function stop() {
  live = false; pause();
  if (watchId != null) { try { navigator.geolocation.clearWatch(watchId); } catch { /* ignore */ } watchId = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  fix = null; geoErr = null; route = null; R = null; prog = null; assignKey = ''; assignment = null;
  ui.lastMove = null; compass = null;
}

function resume() {
  pause();
  if (!live || !visible) return;
  hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  pollTimer = setInterval(poll, POLL_MS);
  tickTimer = setInterval(() => { renderSheet(); updateStatus(); }, 1000);
  loop();
}
function pause() {
  clearInterval(hbTimer); clearInterval(pollTimer); clearInterval(tickTimer);
  hbTimer = pollTimer = tickTimer = 0;
  cancelAnimationFrame(raf); raf = 0;
}

// ---------- UI: join ----------
function buildDOM() {
  root.innerHTML = `
  <div class="wk-join" role="region" aria-label="Walker sign-in">
    <form class="wk-card" novalidate>
      <h1 class="wk-title">Walker mode</h1>
      <p class="wk-lede muted">Sign in on your phone to get your route from Survey Control.</p>
      <div class="wk-field">
        <div class="label" id="wk-wlab">Walker</div>
        <div class="wk-seg" role="radiogroup" aria-labelledby="wk-wlab">
          ${[1, 2, 3, 4].map((n) => `<button type="button" role="radio" aria-checked="false" data-w="${n}" style="--wc: var(--w${n})">${n}</button>`).join('')}
        </div>
      </div>
      <label class="wk-field"><span class="label">Team code</span>
        <input class="wk-code" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="••••" aria-describedby="wk-err">
      </label>
      <p class="wk-err" id="wk-err" role="alert"></p>
      <button class="btn primary wk-go" type="submit">Start sharing location</button>
      <button class="btn wk-cont" type="button" hidden></button>
      <p class="wk-note muted">Your location is shared with Survey Control while this page is open.</p>
    </form>
  </div>
  <div class="wk-main" hidden>
    <canvas class="wk-canvas" aria-label="Map of your route and position"></canvas>
    <div class="wk-banner panel" aria-live="polite"></div>
    <div class="wk-fabs">
      <button class="wk-fab wk-north" type="button" aria-label="Heading up" aria-pressed="false">${icon('compass')}</button>
      <button class="wk-fab wk-recenter" type="button" aria-label="Recenter on my position" hidden>${icon('recenter')}</button>
    </div>
    <div class="wk-toast" role="status" aria-live="polite"></div>
    <div class="wk-sheet panel">
      <div class="wk-sheet-top">
        <span class="wk-who"><span class="wk-wdot"></span><span class="wk-wname"></span></span>
        <span class="wk-pill" data-s="off"><span class="wk-pdot"></span><span class="wk-ptxt">Location off</span></span>
      </div>
      <div class="wk-route"></div>
      <button class="btn wk-stop" type="button">Stop sharing</button>
    </div>
  </div>`;
  ui.join = $('.wk-join'); ui.main = $('.wk-main');
  ui.form = $('.wk-card'); ui.code = $('.wk-code'); ui.err = $('.wk-err'); ui.go = $('.wk-go'); ui.cont = $('.wk-cont');
  ui.seg = [...root.querySelectorAll('.wk-seg button')];
  ui.canvas = $('.wk-canvas'); ui.banner = $('.wk-banner'); ui.toast = $('.wk-toast');
  ui.sheet = $('.wk-sheet'); ui.route = $('.wk-route'); ui.pill = $('.wk-pill'); ui.ptxt = $('.wk-ptxt');
  ui.wdot = $('.wk-wdot'); ui.wname = $('.wk-wname'); ui.stop = $('.wk-stop');
  ui.north = $('.wk-north'); ui.recenter = $('.wk-recenter');

  ui.seg.forEach((b) => b.addEventListener('click', () => pickWalker(+b.dataset.w)));
  root.querySelector('.wk-seg').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const k = ui.seg.length, i = Math.max(0, ui.seg.findIndex((b) => +b.dataset.w === walker));
    const b = ui.seg[(i + d + k) % k]; pickWalker(+b.dataset.w); b.focus();
  });
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); start(false); });
  ui.cont.addEventListener('click', () => {
    walker = +lsGet(LS.walker); code = lsGet(LS.code) || ''; pickWalker(walker); start(true);
  });
  ui.stop.addEventListener('click', () => {
    if (!ui.stopArm) {
      ui.stopArm = true; ui.stop.textContent = 'Tap again to stop'; ui.stop.classList.add('armed');
      clearTimeout(ui.stopT); ui.stopT = setTimeout(() => { ui.stopArm = false; ui.stop.textContent = 'Stop sharing'; ui.stop.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(ui.stopT); ui.stopArm = false; ui.stop.textContent = 'Stop sharing'; ui.stop.classList.remove('armed');
    stop(); showJoin('');
  });
  ui.north.addEventListener('click', () => {
    headingUp = !headingUp; ui.north.setAttribute('aria-pressed', String(headingUp));
    ui.north.setAttribute('aria-label', headingUp ? 'North up' : 'Heading up');
    if (headingUp) setFollow(true);
    dirty = true;
  });
  ui.recenter.addEventListener('click', () => setFollow(true));
  bindGestures();
}

// walkers added in Survey Control beyond 4 get their own button (from #walk?w=N or a saved sign-in)
function ensureSeg(n) {
  if (!(n > 4) || ui.seg.some((b) => +b.dataset.w === n)) return;
  const seg = root.querySelector('.wk-seg');
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false'); b.dataset.w = String(n);
  b.style.setProperty('--wc', walkerColor(n)); b.textContent = String(n);
  b.addEventListener('click', () => pickWalker(n));
  seg.appendChild(b); ui.seg = [...seg.querySelectorAll('button')];
  seg.style.gridTemplateColumns = `repeat(${ui.seg.length}, 1fr)`;
}
function pickWalker(n) {
  if (n) ensureSeg(n);
  walker = n;
  ui.seg.forEach((b) => { const on = +b.dataset.w === n; b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (!n && b.dataset.w === '1') ? 0 : -1; });
}
function renderContinue() {
  const sw = +lsGet(LS.walker), sc = lsGet(LS.code);
  if (sw >= 1 && sc) { ui.cont.hidden = false; ui.cont.innerHTML = `<span class="wk-cdot" style="background: ${walkerColor(sw)}"></span>Continue as Walker ${sw}`; }
  else ui.cont.hidden = true;
}
function showJoin(msg) {
  ui.main.hidden = true; ui.join.hidden = false;
  const sw = +lsGet(LS.walker); pickWalker(sw >= 1 ? sw : null);
  ui.code.value = ''; ui.err.textContent = msg || '';
  renderContinue();
}
function showMain() {
  ui.join.hidden = true; ui.main.hidden = false;
  const c = walkerColor(walker);
  ui.wdot.style.background = c; ui.wname.textContent = `Walker ${walker}`;
  setFollow(true); placeTop(); resize();
  renderGuide(); renderSheet(); updateStatus();
}

// keep the banner clear of the shared top bar (its height differs on phones)
function placeTop() {
  const tb = document.querySelector('.topbar');
  const h = tb ? Math.ceil(tb.getBoundingClientRect().bottom) : 64;
  root.style.setProperty('--wk-top', `${Math.max(64, h) + 8}px`);
  if (ui.sheet && !ui.main.hidden) root.style.setProperty('--wk-sheet', `${Math.ceil(ui.sheet.offsetHeight)}px`);
}

// ---------- UI: guidance ----------
function renderGuide() {
  if (!ui.banner || !live) return;
  const b = ui.banner; let html = '', mode = '';
  if (geoErr && !fix) {
    mode = 'err';
    const help = {
      denied: 'Location is blocked for this site. iPhone: Settings › Privacy & Security › Location Services › Safari Websites → “While Using the App”, then reload. Android: tap the lock icon in the address bar › Permissions › Location → Allow.',
      unavailable: 'Your phone can’t get a position right now. Turn on Location Services (and Wi-Fi for a faster fix), and step outside away from tall buildings.',
      insecure: 'Location only works over https. Open the site’s https:// address.',
      timeout: 'Still looking for GPS… Step outside and keep the page open.',
    }[geoErr];
    html = `<div class="wk-b-row">${icon('off', 'wk-b-ico warn')}<div class="wk-b-text"><div class="wk-b-main">Location ${geoErr === 'timeout' ? 'not found yet' : 'is off'}</div><div class="wk-b-sub">${esc(help)}</div>
      ${geoErr !== 'insecure' ? '<button class="btn wk-retry" type="button">Try again</button>' : ''}</div></div>`;
  } else if (!route) {
    mode = 'wait';
    html = `<div class="wk-b-row"><span class="wk-pulse" aria-hidden="true"></span><div class="wk-b-text"><div class="wk-b-main">Waiting for Survey Control to assign you a route…</div>
      <div class="wk-b-sub">${fix ? 'Your position is being shared. Stay where you are.' : 'Finding your position…'}</div></div></div>`;
  } else if (!fix) {
    mode = 'wait';
    html = `<div class="wk-b-row"><span class="wk-pulse" aria-hidden="true"></span><div class="wk-b-text"><div class="wk-b-main">Finding your position…</div><div class="wk-b-sub">Route: ${esc(route.name)}</div></div></div>`;
  } else if (prog == null) {
    mode = 'go';
    const d = Math.hypot(fix.x - R.x[0], fix.y - R.y[0]);
    html = `<div class="wk-b-row">${icon('start', 'wk-b-ico')}<div class="wk-b-text"><div class="wk-b-main">Walk to the start of the route <span class="wk-b-dist">· ${fmtDist(d)}</span></div>
      <div class="wk-b-sub">${esc(R.steps[0]?.txt || 'Follow the line on the map to its start')}</div></div></div>`;
  } else if (offM != null && offM > OFF_ROUTE_M) {
    mode = 'off';
    html = `<div class="wk-b-row">${icon('off', 'wk-b-ico warn')}<div class="wk-b-text"><div class="wk-b-main">Off route — head back to the line <span class="wk-b-dist">(${fmtDist(offM)})</span></div>
      <div class="wk-b-sub">Guidance resumes when you are back on the route.</div></div></div>`;
  } else if (prog >= R.total - 15) {
    mode = 'done';
    html = `<div class="wk-b-row">${icon('finish', 'wk-b-ico')}<div class="wk-b-text"><div class="wk-b-main">Route complete</div><div class="wk-b-sub">Nice work. Stop logging and wait for Survey Control.</div></div></div>`;
  } else {
    mode = 'go';
    const nx = nextStep(); const after = nx ? R.steps[R.steps.indexOf(nx) + 1] : null;
    const d = nx ? nx.at - prog : R.total - prog;
    const txt = nx ? nx.txt : 'Continue to the end of the route';
    html = `<div class="wk-b-row">${icon(nx ? nx.icon : 'straight', 'wk-b-ico' + (d <= BUZZ_M ? ' soon' : ''))}<div class="wk-b-text"><div class="wk-b-main">${esc(txt)} <span class="wk-b-dist">· ${fmtDist(d)}</span></div>
      ${nx && nx.hint ? `<div class="wk-b-hint">${esc(nx.hint)}</div>` : ''}
      ${after ? `<div class="wk-b-sub">Then ${esc(lcFirst(after.txt))}</div>` : ''}</div></div>`;
  }
  if (html !== ui.lastBanner) {
    b.innerHTML = html; ui.lastBanner = html; b.dataset.mode = mode;
    b.querySelector('.wk-retry')?.addEventListener('click', () => { startGeo(); });
  }
}

function renderSheet() {
  if (!ui.route || !live) return;
  let html;
  if (!route) html = `<div class="wk-rname muted">No route yet</div>`;
  else {
    const pct = prog != null ? Math.round((prog / R.total) * 100) : 0;
    const left = R.total - (prog ?? 0);
    const t = (now() - routeStart) / 1000;
    html = `<div class="wk-rname"><span class="wk-rdot" style="background:${esc(route.color || '#ffe2aa')}"></span>${esc(route.name)}</div>
      ${route.covers ? `<div class="wk-covers muted">${esc(route.covers)}</div>` : ''}
      <div class="wk-bar" aria-hidden="true"><span style="width:${pct}%; background:${esc(route.color || '#ffe2aa')}"></span></div>
      <dl class="wk-stats">
        <div><dt class="label">Done</dt><dd>${pct}%</dd></div>
        <div><dt class="label">Left</dt><dd>${(left / 1000).toFixed(1)} km</dd></div>
        <div><dt class="label">On route</dt><dd>${fmtDur(t)}</dd></div>
      </dl>`;
  }
  if (html !== ui.lastSheet) { ui.route.innerHTML = html; ui.lastSheet = html; placeTop(); dirty = true; }
}

function updateStatus() {
  if (!ui.pill) return;
  let s, t;
  if (!fix || (geoErr && geoErr !== 'timeout') || now() - (fix?.t || 0) > 30000) { s = 'off'; t = 'Location off'; }
  else if (netFail || now() - lastOk > LIVE_STALE_MS) { s = 're'; t = 'Reconnecting…'; }
  else { s = 'live'; t = 'Live'; }
  if (ui.pill.dataset.s !== s) { ui.pill.dataset.s = s; ui.ptxt.textContent = t; }
}

let toastT = 0;
function toast(msg) {
  if (toastMute || !ui.toast) return;
  ui.toast.textContent = msg; ui.toast.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => ui.toast.classList.remove('on'), 4500);
}

// ---------- map ----------
function resize() {
  if (!ui.canvas || ui.main.hidden) return;
  const r = ui.canvas.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  W = r.width; H = r.height; ui.canvas.width = Math.round(W * dpr); ui.canvas.height = Math.round(H * dpr);
  ctx = ui.canvas.getContext('2d'); placeTop(); dirty = true;
}

function viewRot() { const h = currentHeading(); return headingUp && h != null ? h * Math.PI / 180 : 0; }
function anchor() {
  // where the camera centre sits on screen: between the banner and the bottom sheet
  const top = ui.banner?.getBoundingClientRect().bottom || 120;
  const bot = ui.sheet?.getBoundingClientRect().top || H;
  if (W > 760) {   // desktop: panels sit on the left, centre the map in the space to their right
    const right = ui.sheet?.getBoundingClientRect().right || 0;
    return [(right + W) / 2, H * (headingUp ? 0.62 : 0.5)];
  }
  return [W / 2, clamp(top + (bot - top) * (headingUp ? 0.66 : 0.52), 0, H)];
}
function w2s(x, y, rot, ax, ay) {
  const dx = (x - cam.cx) * cam.s, dy = -(y - cam.cy) * cam.s, c = Math.cos(-rot), s = Math.sin(-rot);
  return [ax + dx * c - dy * s, ay + dx * s + dy * c];
}
function s2w(sx, sy) {
  const rot = viewRot(), [ax, ay] = anchor(); const dx = sx - ax, dy = sy - ay, c = Math.cos(rot), s = Math.sin(rot);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  return [cam.cx + rx / cam.s, cam.cy - ry / cam.s];
}

function setFollow(on) {
  follow = on; if (ui.recenter) ui.recenter.hidden = on;
  if (on && fix) { cam.cx = fix.x; cam.cy = fix.y; }
  dirty = true;
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (follow && fix) {
    const dx = fix.x - cam.cx, dy = fix.y - cam.cy;
    if (Math.abs(dx) + Math.abs(dy) > 0.02) { cam.cx += dx * 0.2; cam.cy += dy * 0.2; dirty = true; }
  }
  if (!fix && route && follow && !ui.framed) { cam.cx = R.x[0]; cam.cy = R.y[0]; ui.framed = true; dirty = true; }
  if (dirty) { dirty = false; draw(); }
}

function draw() {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#08090b'; ctx.fillRect(0, 0, W, H);
  const rot = viewRot(), [ax, ay] = anchor(), P = (x, y) => w2s(x, y, rot, ax, ay);
  const pad = 40, inView = (p) => p[0] > -pad && p[0] < W + pad && p[1] > -pad && p[1] < H + pad;

  // buildings: faint outlines
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.075)'; ctx.fillStyle = 'rgba(255,255,255,.018)';
  const rad = Math.hypot(W, H) / cam.s;   // world metres visible (generous)
  for (const b of ctxData.bld) {
    if (Math.abs(b.cx - cam.cx) > rad || Math.abs(b.cy - cam.cy) > rad) continue;
    ctx.beginPath();
    for (const ring of b.rings) { for (let i = 0; i < ring.length; i += 2) { const p = P(ring[i], ring[i + 1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); } ctx.closePath(); }
    ctx.fill(); ctx.stroke();
  }
  // measured light: very faint warm dots, dark stays dark
  const D = ctxData.dots;
  if (D) {
    const sz = clamp(cam.s * 1.6, 1.2, 3.2);
    ctx.fillStyle = 'rgb(255,226,170)';
    for (let i = 0; i < D.n; i++) {
      const x = D.x[i], y = D.y[i]; if (Math.abs(x - cam.cx) > rad || Math.abs(y - cam.cy) > rad) continue;
      const p = P(x, y); if (!inView(p)) continue;
      ctx.globalAlpha = D.g[i]; ctx.fillRect(p[0] - sz / 2, p[1] - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // route
  if (R) {
    const col = route.color || '#ffe2aa';
    const path = (s0, s1) => {
      ctx.beginPath(); let started = false;
      const a = pointAt(s0); let p = P(a[0], a[1]); ctx.moveTo(p[0], p[1]); started = true;
      for (let i = 0; i < R.n; i++) { if (R.cum[i] <= s0) continue; if (R.cum[i] >= s1) break; p = P(R.x[i], R.y[i]); ctx.lineTo(p[0], p[1]); }
      const b = pointAt(s1); p = P(b[0], b[1]); if (started) ctx.lineTo(p[0], p[1]);
    };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const pg = prog ?? 0, wpx = clamp(cam.s * 3.2, 3, 7);
    if (pg > 0) { path(0, pg); ctx.strokeStyle = col; ctx.globalAlpha = 0.38; ctx.lineWidth = wpx * 0.7; ctx.stroke(); ctx.globalAlpha = 1; }
    path(pg, R.total);
    ctx.strokeStyle = 'rgba(8,9,11,.9)'; ctx.lineWidth = wpx + 4; ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = wpx; ctx.stroke();
    // direction chevrons on the remaining part
    const step = clamp(70 / cam.s, 25, 400);
    ctx.strokeStyle = 'rgba(8,9,11,.75)'; ctx.lineWidth = 1.6;
    for (let s = Math.ceil((pg + 10) / step) * step; s < Math.min(R.total, pg + step * 40); s += step) {
      const a = pointAt(s), b = pointAt(s + 2); const pa = P(a[0], a[1]), pb = P(b[0], b[1]);
      if (!inView(pa)) continue; const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]), k = wpx * 0.55;
      ctx.beginPath();
      ctx.moveTo(pa[0] - Math.cos(ang - 0.7) * k, pa[1] - Math.sin(ang - 0.7) * k); ctx.lineTo(pa[0], pa[1]);
      ctx.lineTo(pa[0] - Math.cos(ang + 0.7) * k, pa[1] - Math.sin(ang + 0.7) * k); ctx.stroke();
    }
    // start / finish marks
    const s0 = P(R.x[0], R.y[0]), s1 = P(R.x[R.n - 1], R.y[R.n - 1]);
    ctx.lineWidth = 2; ctx.strokeStyle = '#f2f2f2'; ctx.fillStyle = '#08090b';
    ctx.beginPath(); ctx.arc(s1[0], s1[1], 6, 0, 7); ctx.fill(); ctx.stroke();
    if (prog == null) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s0[0], s0[1], 7, 0, 7); ctx.fill(); ctx.stroke(); }
    // off route: dashed line back to the nearest point of the route
    if (fix && prog != null && offM != null && offM > OFF_ROUTE_M) {
      const n = nearest(fix.x, fix.y, prog - WIN_BACK, prog + WIN_AHEAD), a = pointAt(n.s), pa = P(a[0], a[1]), pm = P(fix.x, fix.y);
      ctx.setLineDash([4, 5]); ctx.strokeStyle = '#c00000'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(pm[0], pm[1]); ctx.lineTo(pa[0], pa[1]); ctx.stroke(); ctx.setLineDash([]);
    }
    // next turn point
    const nx = nextStep();
    if (nx && nx.icon !== 'finish') { const a = pointAt(nx.at), p = P(a[0], a[1]); ctx.fillStyle = '#f2f2f2'; ctx.strokeStyle = '#08090b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], 4.5, 0, 7); ctx.fill(); ctx.stroke(); }
  }

  // me
  if (fix) {
    const p = P(fix.x, fix.y), c = walkerColor(walker);
    if (fix.acc) {
      const r = fix.acc * cam.s;
      if (r > 8) { ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    const h = currentHeading();
    if (h != null) {
      const a = (h * Math.PI / 180) - rot - Math.PI / 2, spread = 0.42, len = 46;
      const g = ctx.createRadialGradient(p[0], p[1], 4, p[0], p[1], len);
      g.addColorStop(0, hexA(c, 0.55)); g.addColorStop(1, hexA(c, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.arc(p[0], p[1], len, a - spread, a + spread); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = c; ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p[0], p[1], 7.5, 0, 7); ctx.fill(); ctx.stroke();
  }

  // north tick in the compass button
  if (ui.north) ui.north.querySelector('svg').style.transform = `rotate(${-rot}rad)`;
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

async function loadContext() {
  try {
    const gj = await L.load('buildings.geojson');
    ctxData.bld = (gj.features || []).flatMap((f) => {
      const g = f.geometry; if (!g) return [];
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      return polys.map((poly) => {
        let sx = 0, sy = 0, k = 0;
        const rings = poly.map((ring) => { const a = []; for (const [lon, lat] of ring) { const [x, y] = L.toXY(lat, lon); a.push(x, y); sx += x; sy += y; k++; } return a; });
        return { rings, cx: sx / (k || 1), cy: sy / (k || 1) };
      });
    });
    dirty = true;
  } catch { /* context is optional */ }
  try {
    const rows = await L.load('readings_1hz.csv');
    const keep = rows.filter((r) => r.x != null && r.y != null && L.glow(r.lux) > 0.04);
    const n = keep.length, x = new Float32Array(n), y = new Float32Array(n), g = new Float32Array(n);
    keep.forEach((r, i) => { x[i] = r.x; y[i] = r.y; g[i] = 0.05 + L.glow(r.lux) * 0.22; });
    ctxData.dots = { n, x, y, g }; dirty = true;
  } catch { /* optional */ }
}

// ---------- gestures ----------
function bindGestures() {
  const cv = ui.canvas;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.offsetX, e.offsetY]); gesture = null; });
  cv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = [...pointers.values()].map((p) => p.slice());
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    const cur = [...pointers.values()];
    if (cur.length === 1) {
      const [px, py] = prev[0], [qx, qy] = cur[0];
      if (!gesture && Math.hypot(qx - px, qy - py) < 1) return;
      gesture = 'pan';
      const a = s2w(px, py), b = s2w(qx, qy); cam.cx += a[0] - b[0]; cam.cy += a[1] - b[1];
      if (follow) setFollow(false);
      dirty = true;
    } else if (cur.length >= 2 && prev.length >= 2) {
      gesture = 'pinch';
      const d0 = Math.hypot(prev[0][0] - prev[1][0], prev[0][1] - prev[1][1]), d1 = Math.hypot(cur[0][0] - cur[1][0], cur[0][1] - cur[1][1]);
      const m0 = [(prev[0][0] + prev[1][0]) / 2, (prev[0][1] + prev[1][1]) / 2], m1 = [(cur[0][0] + cur[1][0]) / 2, (cur[0][1] + cur[1][1]) / 2];
      zoomAt(m0, d0 > 0 ? d1 / d0 : 1);
      if (!follow) { const a = s2w(m0[0], m0[1]), b = s2w(m1[0], m1[1]); cam.cx += a[0] - b[0]; cam.cy += a[1] - b[1]; }
      dirty = true;
    }
  });
  const up = (e) => { pointers.delete(e.pointerId); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt([e.offsetX, e.offsetY], Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
}
function zoomAt(pt, f) {
  const s1 = clamp(cam.s * f, 0.12, 12);
  if (follow) { cam.s = s1; dirty = true; return; }   // keep my dot anchored while following
  const a = s2w(pt[0], pt[1]); cam.s = s1; const b = s2w(pt[0], pt[1]);
  cam.cx += a[0] - b[0]; cam.cy += a[1] - b[1]; dirty = true;
}

// ---------- module ----------
function readApi(params) {
  const hashQ = new URLSearchParams((location.hash.split('?')[1]) || '');
  const a = params?.api || hashQ.get('api');
  if (a && /^https?:\/\//.test(a)) API = a.replace(/\/+$/, '');
}

export default {
  async mount(el, LUX) {
    L = LUX; root = el; css(); readApi();
    buildDOM(); showJoin('');
    new ResizeObserver(() => resize()).observe(el);
    window.addEventListener('resize', () => { placeTop(); dirty = true; });
    document.addEventListener('visibilitychange', onVisibility);
    loadContext();
  },
  show(params) {
    readApi(params); visible = true; placeTop(); resize();
    const pw = Math.floor(+(params?.w ?? 0));
    if (!live && pw >= 1 && pw < 1000) pickWalker(pw);
    if (live) { lockScreen(); resume(); poll(); }
  },
  hide() { visible = false; pause(); },
};
