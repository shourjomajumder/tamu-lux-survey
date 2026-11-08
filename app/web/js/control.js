// Survey Control — the team's control room: walkers, route assignment, coverage and route suggestions.
// export default { mount(el, LUX), show(params), hide() }
// Backend (header x-control-pass on everything except /api/status):
//   GET  /api/control        -> { ok, walkers:[{id,name,color,assignment,last,created,app}], assignments }   (old backend: { ok, assignments, apps })
//   POST /api/control        {action: add_walker | remove_walker | assign | clear, ...}
// A walker's data (heartbeat, trail, position) only counts if it is newer than the walker's `created` time —
// a new walker that reuses an old id never shows the previous walker's data. `app` = last startup hello from the phone.
//   GET  /api/coverage       -> { ok, bin_m, covered:[[[lon,lat],[lon,lat]],...], routes:[{id,name,length_m,covered_pct,uncovered_m}] }
//   GET  /api/suggest        -> { ok, suggestions:[{route_id,name,length_m,uncovered_m,covered_pct}] }
//   GET  /api/status?trail=1 (public) -> live heartbeats + trails
//   GET  /api/files?walker=N&since=<created> -> { ok, files:[{key,session,path,kind,size,t,url}] }  (uploads every 5 min, polled 30 s)
// Walker stats read 0 until the assigned route is >=95% covered or the walk ended; the bar still follows coverage.
// Anything missing falls back: walkers kept in localStorage, coverage/suggestions computed here from
// readings_1hz.csv + route_library.json in 10 m bins.
// "Collected" is drawn on the PLANNED route geometry only (straight route pieces), never as GPS trails.

const DEFAULT_API = 'https://tamu-lux-survey.netlify.app';
const PIN_KEY = 'lux-control-pin';
const ROSTER_KEY = 'lux-control-roster';
const STATUS_MS = 2000, CONTROL_MS = 10000, CONTROL_FAST_MS = 3000, COVERAGE_MS = 30000, FETCH_TIMEOUT = 8000;
const PHONE_S = 120;   // a hello or heartbeat this recent = "Phone connected"
const LIVE_S = 20, BREAK_GAP_S = 20, BREAK_GAP_M = 60, AUTO_ADD_S = 120;
const BIN_M = 10, NEAR_M = 15;   // a 10 m route bin is collected when a reading lies within 15 m of it
const N_SUGGEST = 5;
const TZ = 'America/Chicago';
// One colour language: brand red (#c00000) = collected + walkers; routes are neutral (faint grey, dashed when assigned).
const RED = '#c00000';
const colorFor = () => RED;
const COLLECTED = RED;
const DONE_FRAC = 0.95;            // walker stats stay at zero until the route is this covered (or the walk ended)
const ENDED_S = 600;               // no heartbeat this long after some progress = walk ended
const FILES_MS = 30000, BATCH_GAP_S = 90;

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtClock = (s) => clockFmt.format(new Date(s * 1000)).replace(' AM', ' am').replace(' PM', ' pm');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
const frac = (v) => { v = num(v); return v == null ? null : (v > 1.0001 ? v / 100 : v); }; // 0-1 or %
const toSec = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  if (!Number.isNaN(+v)) return toSec(+v);
  const n = Date.parse(v); return Number.isNaN(n) ? null : n / 1000;
};
const km = (m) => `${((+m || 0) / 1000).toFixed(1)} km`;
function fmtAge(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} m`;
  return `${Math.round(s / 3600)} h`;
}
function hexToRgb(h) {
  const m = String(h).replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [154, 163, 178];
}
const store = {
  get() { try { return sessionStorage.getItem(PIN_KEY); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(PIN_KEY, v); } catch { /* private mode */ } },
  clear() { try { sessionStorage.removeItem(PIN_KEY); } catch { /* ignore */ } },
};
const local = {
  read() {
    try { const j = JSON.parse(localStorage.getItem(ROSTER_KEY) || 'null'); return { walkers: Array.isArray(j?.walkers) ? j.walkers : [], removed: j?.removed && typeof j.removed === 'object' ? j.removed : {} }; }
    catch { return { walkers: [], removed: {} }; }
  },
  write(v) { try { localStorage.setItem(ROSTER_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
};
function apiBase() {
  const qs = (location.hash.split('?')[1] || '');
  const o = new URLSearchParams(qs).get('api');
  return (o || DEFAULT_API).replace(/\/+$/, '');
}
async function req(path, opts = {}) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try { return await fetch(apiBase() + path, { ...opts, signal: ac.signal, cache: 'no-store' }); }
  finally { clearTimeout(tm); }
}

// ---------- state ----------
let L, root, canvas, ctx, bgCanvas, bgDirty = true;
let W = 0, H = 0, dpr = 1;
const view = { cx: 0, cy: 0, s: 1 };
let ui = {};
let readingPts = [], buildings = [], routes = [], routeById = new Map();
const BYPASS_CODE = '4586';   // owner asked for a visible lock that can be bypassed without a PIN
let pin = null, state = 'locked', visible = false, triedStored = false;
let mode = null;                 // 'new' (walkers come from the backend) | 'old' (walkers kept locally)
let serverRoster = [];           // [{id,name,color}] from GET /api/control
let roster = [];                 // merged: server + local-only walkers
let lastById = {};               // id -> last {lat,lon,t,heading,route_pct} (new backend)
let createdById = {};            // id -> created (s); anything older belongs to an earlier walker with that id
let appById = {};                // id -> {device, app_version, seen_at} from the phone's startup hello
let localTrails = {};            // id -> trail built from lastById when /api/status has none
let status = null, statusLocal = 0, statusFails = 0, controlFails = 0;
let walkers = {};                // id -> { hb, trail: {x,y,t,lux,col,brk}[], pos:[x,y]|null }
let assign = {};                 // id -> route id (string) | null
let pending = 0;                 // in-flight POSTs (don't let a GET overwrite the optimistic state)
let follow = null, selW = null, hoverRoute = null, selRoute = null, pickFor = null;
let cov = { source: 'local', lines: [], routes: new Map() };   // lines: collected route pieces, [[x,y],...] in metres
let sugg = { source: 'local', list: [] };
let walkCov = {};                // id -> { route, frac, lines } what this walker's own trail covered of their assigned route
let luxAcc = {};                 // id -> { c: created, last: t, sum, n } running lux average from heartbeats
let filesById = {};              // id -> [{key,session,path,kind,size,t,url}] newest first (uploads after `created`)
let filesOpen = new Set(), filesOK = false, tFiles = 0;   // feed shows once /api/files answers with a list
let tStatus = 0, tControl = 0, tTick = 0, tCov = 0, raf = 0, localCovAt = 0;

function css() {
  if (document.getElementById('css-control')) return;
  const l = document.createElement('link'); l.id = 'css-control'; l.rel = 'stylesheet'; l.href = 'css/control.css';
  document.head.appendChild(l);
}
const colorOf = () => RED;
const nameOf = (id) => roster.find((w) => w.id === id)?.name || `Walker ${id}`;
const ids = () => roster.map((w) => w.id);

// ---------- geometry ----------
const toScreen = (x, y) => [W / 2 + (x - view.cx) * view.s, H / 2 - (y - view.cy) * view.s];
const toWorld = (px, py) => [view.cx + (px - W / 2) / view.s, view.cy - (py - H / 2) / view.s];
const isWide = () => W > 900;

function fit() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const r of routes) for (const [x, y] of r.xy) add(x, y);
  for (const w of Object.values(walkers)) if (w.pos) add(...w.pos);
  if (x0 === Infinity) for (const r of readingPts) add(r[0], r[1]);
  if (x0 === Infinity) { x0 = -1500; x1 = 1500; y0 = -1500; y1 = 1500; }
  const wide = isWide();
  const padL = wide ? 330 : 16, padR = wide ? 370 : 16, padT = wide ? 84 : 230, padB = wide ? 40 : 110;
  const aw = Math.max(80, W - padL - padR), ah = Math.max(80, H - padT - padB);
  view.s = Math.min(aw / (x1 - x0 || 1), ah / (y1 - y0 || 1));
  const fcx = padL + aw / 2, fcy = padT + ah / 2;
  view.cx = (x0 + x1) / 2 - (fcx - W / 2) / view.s;
  view.cy = (y0 + y1) / 2 + (fcy - H / 2) / view.s;
  bgDirty = true;
}
function centreOn(x, y) {
  // keep the followed walker in the middle of the free map area, not under a panel
  const wide = isWide();
  const off = wide ? (330 - 370) / 2 : 0, offY = wide ? 0 : (230 - 110) / 2;
  view.cx = x - off / view.s; view.cy = y - offY / view.s;
  bgDirty = true;
}

function resize() {
  const r = root.getBoundingClientRect();
  const first = W === 0;
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
  if (first || W < 2) fit();
  bgDirty = true; requestDraw();
}

// ---------- coverage (client-side fallback, 10 m bins) ----------
function makeGrid(pts) {
  const g = new Map();
  for (const [x, y] of pts) {
    const k = `${Math.floor(x / BIN_M)},${Math.floor(y / BIN_M)}`;
    let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(x, y);
  }
  return g;
}
function near(g, x, y) {
  const i = Math.floor(x / BIN_M), j = Math.floor(y / BIN_M), r2 = NEAR_M * NEAR_M;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const a = g.get(`${i + di},${j + dj}`); if (!a) continue;
    for (let k = 0; k < a.length; k += 2) if ((a[k] - x) ** 2 + (a[k + 1] - y) ** 2 <= r2) return true;
  }
  return false;
}
function routeStats(r, g, lines) {
  let len = 0, unc = 0, carry = 0, cur = null;
  for (let i = 1; i < r.xy.length; i++) {
    const [ax, ay] = r.xy[i - 1], [bx, by] = r.xy[i];
    const d = Math.hypot(bx - ax, by - ay); if (!d) continue;
    // walk this segment in pieces that line up with a running 10 m grid along the route
    let s = 0;
    while (s < d) {
      const step = Math.min(BIN_M - carry, d - s);
      const m = (s + step / 2) / d;
      if (!near(g, ax + (bx - ax) * m, ay + (by - ay) * m)) { unc += step; if (cur) { lines.push(cur); cur = null; } }
      else {
        // collected piece: keep it on the route line (route vertices + bin ends), never the GPS points
        const f0 = s / d, f1 = (s + step) / d;
        if (!cur) cur = [[ax + (bx - ax) * f0, ay + (by - ay) * f0]];
        cur.push([ax + (bx - ax) * f1, ay + (by - ay) * f1]);
      }
      len += step; s += step; carry = (carry + step) % BIN_M;
      if (BIN_M - carry < 1e-6) carry = 0;
    }
  }
  if (cur) lines.push(cur);
  return { length_m: len, uncovered_m: unc, covered_pct: len ? (1 - unc / len) * 100 : 0 };
}
function computeLocalCoverage() {
  const pts = readingPts.slice();
  for (const w of Object.values(walkers)) for (const p of w.trail) if (p.col) pts.push([p.x, p.y]);
  const g = makeGrid(pts);
  const out = new Map(), lines = [];
  for (const r of routes) out.set(String(r.id), { id: r.id, name: r.name, ...routeStats(r, g, lines) });
  localCovAt = Date.now();
  out.lines = lines;
  return out;
}
function refreshLocal(force = false) {
  if (!routes.length) return;
  if (!force && Date.now() - localCovAt < 10000) return;
  if (cov.source === 'local') { cov.routes = computeLocalCoverage(); cov.lines = cov.routes.lines; bgDirty = true; requestDraw(); }
  if (sugg.source === 'local') sugg.list = localSuggestions();
  updateSuggestions(); updateWalkerSelects();
}
function localSuggestions() {
  const src = cov.routes.size ? cov.routes : computeLocalCoverage();
  return [...src.values()].map((c) => ({ route_id: c.id, name: c.name, length_m: c.length_m, uncovered_m: c.uncovered_m, covered_pct: c.covered_pct }))
    .filter((c) => Number(c.route_id) > 100)
    .sort((a, b) => (b.uncovered_m / (b.length_m || 1)) - (a.uncovered_m / (a.length_m || 1)));
}

// ---------- drawing ----------
function strokeLines(c, lines) {
  if (!lines || !lines.length) return;
  // one path for everything so overlapping routes don't stack the alpha
  c.beginPath();
  for (const ln of lines) ln.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? c.lineTo(px, py) : c.moveTo(px, py); });
  c.stroke();
}
function drawBackground() {
  const b = bgCanvas.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0); b.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.strokeStyle = 'rgba(255,255,255,0.06)'; b.lineWidth = 1;
  for (const ring of buildings) {
    b.beginPath();
    ring.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? b.lineTo(px, py) : b.moveTo(px, py); });
    b.closePath(); b.stroke();
  }
  bgDirty = false;
}
function requestDraw() { if (!raf && visible) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function polyline(xy, close = false) {
  ctx.beginPath();
  xy.forEach(([x, y], i) => { const [px, py] = toScreen(x, y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  if (close) ctx.closePath();
}
const nowSec = () => (status ? (num(status.now) ?? statusLocal / 1000) + (Date.now() - statusLocal) / 1000 : Date.now() / 1000);
function walkerAge(w) {
  const hb = walkers[w]?.hb;
  if (!hb) return null;
  const rec = toSec(hb.receivedAt) ?? toSec(hb.t);
  return rec == null ? null : nowSec() - rec;
}
const isLive = (w) => { const a = walkerAge(w); return a != null && a <= LIVE_S; };

function draw() {
  if (!ctx || !W) return;
  if (bgDirty) drawBackground();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgCanvas, 0, 0);
  if (state !== 'unlocked') return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';

  const preview = routeById.get(String(hoverRoute ?? selRoute ?? ''));
  const assigned = new Set(ids().map((w) => assign[w]).filter(Boolean));
  // unassigned routes: faint neutral grey
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(200,204,212,${preview ? 0.08 : 0.16})`;
  for (const r of routes) {
    if (assigned.has(String(r.id)) || r === preview) continue;
    polyline(r.xy); ctx.stroke();
  }
  // assigned routes: light-grey dashes (the collected red below replaces them where walked)
  ctx.setLineDash([6, 4]); ctx.lineWidth = 1.4;
  ctx.strokeStyle = `rgba(226,228,233,${preview ? 0.35 : 0.85})`;
  for (const id of assigned) {
    const r = routeById.get(String(id));
    if (!r || r === preview) continue;
    polyline(r.xy); ctx.stroke();
  }
  ctx.setLineDash([]);
  // collected: solid red route pieces on top (server/local coverage + what each walker covered of their route)
  ctx.strokeStyle = COLLECTED; ctx.lineWidth = 3; ctx.miterLimit = 4;
  strokeLines(ctx, cov.lines);
  for (const w of ids()) strokeLines(ctx, walkCov[w]?.lines);
  // previewed route: bright neutral
  if (preview) {
    ctx.strokeStyle = 'rgba(8,9,11,.85)'; ctx.lineWidth = 5; polyline(preview.xy); ctx.stroke();
    ctx.strokeStyle = '#f2f3f5'; ctx.lineWidth = 2; polyline(preview.xy); ctx.stroke();
    const [sx, sy] = toScreen(...preview.xy[0]);
    ctx.fillStyle = '#08090b'; ctx.strokeStyle = '#f2f3f5'; ctx.lineWidth = 2;
    ctx.fillRect(sx - 4.5, sy - 4.5, 9, 9); ctx.strokeRect(sx - 4.5, sy - 4.5, 9, 9);
  }

  // no GPS trails on the map: what they collected shows up as red route pieces (coverage)
  // heads
  ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
  for (const w of ids()) {
    const wk = walkers[w]; if (!wk || !wk.pos) continue;
    const live = isLive(w);
    const col = live ? colorOf(w) : '#6b7079';
    const [cr, cg, cb] = hexToRgb(col);
    const [px, py] = toScreen(...wk.pos);
    const acc = num(wk.hb?.h_acc);
    if (live && acc && acc * view.s > 10) {
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.06)`; ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.3)`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, acc * view.s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    const hd = num(wk.hb?.heading);
    if (hd != null && hd >= 0 && live) {
      const a = (hd * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
      const tip = [px + dx * 15, py + dy * 15], bx = px + dx * 8, by = py + dy * 8;
      ctx.fillStyle = col; ctx.beginPath();
      ctx.moveTo(...tip); ctx.lineTo(bx - dy * 4.5, by + dx * 4.5); ctx.lineTo(bx + dy * 4.5, by - dx * 4.5); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = col; ctx.fillRect(px - 5, py - 5, 10, 10);
    ctx.strokeStyle = 'rgba(8,9,11,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(px - 5, py - 5, 10, 10);
    if (follow === w || selW === w) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1; ctx.strokeRect(px - 9, py - 9, 18, 18); }
    const age = walkerAge(w);
    const label = live ? nameOf(w) : `${nameOf(w)} · no signal ${fmtAge(age ?? 0)}`;
    ctx.fillStyle = live ? 'rgba(232,233,236,.92)' : '#8b9099';
    ctx.fillText(label, px + 12, py - 10);
  }
}

// ---------- data from the server ----------
// true when timestamp `t` (s) is after walker `id` was created (or the walker has no created time)
function fresh(id, t) {
  const c = num(createdById[id]);
  if (c == null) return true;
  t = toSec(t);
  return t != null && t > c;
}
const hbTime = (hb) => (hb ? toSec(hb.receivedAt) ?? toSec(hb.t) : null);
function hbFromLast(id) {
  const l = lastById[id];
  if (!l || num(l.lat) == null || num(l.lon) == null) return null;
  if (!fresh(id, toSec(l.receivedAt) ?? toSec(l.t))) return null;
  return { ...l, receivedAt: toSec(l.receivedAt) ?? toSec(l.t), t: toSec(l.t) };
}
function rebuildWalkers() {
  const hbs = status?.walkers || {}, trails = status?.trails || {};
  const next = {};
  for (const w of ids()) {
    let hb = hbs[w] ?? hbs[String(w)] ?? null;
    if (hb && !fresh(w, hbTime(hb))) hb = null;   // last night's walker with the same id
    const fromLast = hbFromLast(w);
    if (fromLast && (!hb || (toSec(fromLast.receivedAt) ?? 0) > (toSec(hb.receivedAt) ?? toSec(hb.t) ?? 0))) hb = { ...(hb || {}), ...fromLast };
    const raw = trails[w] ?? trails[String(w)];
    let trail = [];
    if (Array.isArray(raw) && raw.length) {
      for (const p of raw) {
        const [t, lat, lon, lux, col] = p;
        if (num(lat) == null || num(lon) == null) continue;
        const [x, y] = L.toXY(+lat, +lon);
        const prev = trail[trail.length - 1];
        const ts = toSec(t) ?? 0;
        if (!fresh(w, ts)) continue;
        const brk = prev ? (ts - prev.t > BREAK_GAP_S || Math.hypot(x - prev.x, y - prev.y) > BREAK_GAP_M) : false;
        trail.push({ t: ts, x, y, lux: num(lux), col: col !== false && col !== 0, brk });
      }
    } else trail = (localTrails[w] || []).filter((p) => fresh(w, p.t));
    let pos = null;
    if (hb && num(hb.lat) != null && num(hb.lon) != null) pos = L.toXY(+hb.lat, +hb.lon);
    else if (trail.length) pos = [trail[trail.length - 1].x, trail[trail.length - 1].y];
    next[w] = { hb, trail, pos };
  }
  walkers = next;
  computeWalkCov();
  if (follow && walkers[follow]?.pos) centreOn(...walkers[follow].pos);
}
// What each walker's own trail covered of the route they were given (dashes -> red as they walk), plus lux average.
function computeWalkCov() {
  const out = {};
  for (const w of ids()) {
    const wk = walkers[w], r = routeById.get(String(assign[w] ?? ''));
    const hb = wk?.hb;
    // running lux average over the walk (one sample per heartbeat)
    const c = createdById[w] ?? null, t = hbTime(hb), lx = num(hb?.lux);
    let a = luxAcc[w];
    if (!a || a.c !== c) a = luxAcc[w] = { c, last: null, sum: 0, n: 0 };
    if (t != null && lx != null && t !== a.last && hb.collecting !== false) { a.last = t; a.sum += lx; a.n++; }
    if (!r || !wk) continue;
    const pts = wk.trail.filter((p) => p.col).map((p) => [p.x, p.y]);
    if (wk.pos && hb?.collecting !== false) pts.push(wk.pos);
    if (!pts.length) { out[w] = { route: String(r.id), frac: 0, lines: [] }; continue; }
    const lines = [], st = routeStats(r, makeGrid(pts), lines);
    out[w] = { route: String(r.id), frac: st.covered_pct / 100, lines };
  }
  walkCov = out;
}
function walkLux(w) {
  const vals = (walkers[w]?.trail || []).filter((p) => p.col && p.lux != null).map((p) => p.lux);
  if (vals.length >= 3) return vals.reduce((x, y) => x + y, 0) / vals.length;
  const a = luxAcc[w];
  return a && a.n ? a.sum / a.n : null;
}
function ingestStatus(s) {
  status = s; statusLocal = Date.now();
  if (mode === 'old') autoAddLive();
  rebuildWalkers();
  updateWalkers(); refreshLocal(); requestDraw();
}
// old backend: a walker who is live on /api/status but not on the list shows up by itself
function autoAddLive() {
  const hbs = status?.walkers || {};
  const st = local.read(); let changed = false;
  for (const [k, hb] of Object.entries(hbs)) {
    const id = +k; if (!(id >= 1) || !hb || roster.some((w) => w.id === id)) continue;
    const rec = toSec(hb.receivedAt) ?? toSec(hb.t); if (rec == null || nowSec() - rec > AUTO_ADD_S) continue;
    if (st.removed[id] && st.removed[id] >= rec) continue;
    st.walkers.push({ id, name: `Walker ${id}`, color: colorFor(id), created: rec - 1 }); delete st.removed[id]; changed = true;
  }
  if (changed) { local.write(st); mergeRoster(); renderWalkers(); }
}
function normWalker(w) {
  const id = +(w?.id ?? w?.walker);
  if (!(id >= 1)) return null;
  const color = RED;
  return { id, name: String(w.name || '').trim() || `Walker ${id}`, color, created: toSec(w.created) };
}
function mergeRoster() {
  const st = local.read();
  const out = serverRoster.slice();
  for (const w of st.walkers) { const n = normWalker(w); if (n && !out.some((o) => o.id === n.id)) out.push(n); }
  out.sort((a, b) => a.id - b.id);
  for (const w of out) if (w.created != null) createdById[w.id] = Math.max(createdById[w.id] ?? -Infinity, w.created);
  const changed = JSON.stringify(out) !== JSON.stringify(roster);
  roster = out;
  if (selW != null && !roster.some((w) => w.id === selW)) selW = null;
  if (follow != null && !roster.some((w) => w.id === follow)) follow = null;
  return changed;
}
function normAssign(a) {
  const out = {};
  const val = (v) => (v == null || v === '' ? null : typeof v === 'object' ? (v.route_id ?? v.id ?? v.route ?? null) : v);
  if (Array.isArray(a)) { for (const it of a) if (it && +it.walker >= 1) out[+it.walker] = val(it.route_id ?? it.id); }
  else if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) { const id = +String(k).replace(/^W/i, ''); if (id >= 1) out[id] = val(v); }
  for (const k of Object.keys(out)) out[k] = out[k] != null ? String(out[k]) : null;
  return out;
}
function ingestControl(j) {
  if (!j || !j.ok) return;
  let a;
  if (Array.isArray(j.walkers)) {
    mode = 'new';
    serverRoster = j.walkers.map(normWalker).filter(Boolean);
    a = normAssign(j.assignments || {});
    lastById = {}; createdById = {}; appById = {};
    for (const w of j.walkers) {
      const id = +(w?.id ?? w?.walker); if (!(id >= 1)) continue;
      if (toSec(w.created) != null) {
        createdById[id] = toSec(w.created);
        if (localTrails[id]) localTrails[id] = localTrails[id].filter((p) => p.t > createdById[id]);
      }
      if (w.app && fresh(id, w.app.seen_at)) appById[id] = w.app;
      if (w.assignment !== undefined) a[id] = w.assignment && w.assignment.route_id != null ? String(w.assignment.route_id) : null;
      if (w.last && fresh(id, toSec(w.last.receivedAt) ?? toSec(w.last.t))) {
        lastById[id] = w.last;
        const p = w.last; if (num(p.lat) == null || num(p.lon) == null) continue;
        const [x, y] = L.toXY(+p.lat, +p.lon), t = toSec(p.t) ?? Date.now() / 1000;
        const tr = (localTrails[id] ||= []), prev = tr[tr.length - 1];
        if (!prev || prev.t !== t) {
          const brk = prev ? (t - prev.t > BREAK_GAP_S * 3 || Math.hypot(x - prev.x, y - prev.y) > BREAK_GAP_M) : false;
          tr.push({ t, x, y, lux: num(p.lux), col: p.collecting !== false, brk });
          if (tr.length > 4000) tr.splice(0, tr.length - 4000);
        }
      }
    }
  } else {
    mode = 'old';
    serverRoster = [];
    a = normAssign(j.assignments);
    appById = {};
    if (j.apps && typeof j.apps === 'object') for (const [k, v] of Object.entries(j.apps)) if (+k >= 1 && v) appById[+k] = v;
  }
  assign = a;
  if (mergeRoster()) renderWalkers();
  rebuildWalkers();
  updateWalkers(); updateWalkerSelects(); updateSuggestions(); requestDraw();
}

async function pollStatus() {
  clearTimeout(tStatus);
  if (!visible || state !== 'unlocked') return;
  try {
    const r = await req('/api/status?trail=1');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ingestStatus(await r.json());
    statusFails = 0;
  } catch { statusFails++; }
  updateReconnect();
  if (visible && state === 'unlocked') tStatus = setTimeout(pollStatus, STATUS_MS);
}
async function pollControl() {
  clearTimeout(tControl);
  if (!visible || state !== 'unlocked') return;
  try {
    const r = await req('/api/control', { headers: { 'x-control-pass': pin } });
    if (r.status === 401 || r.status === 403) { lock('The code changed. Enter it again.'); return; }
    if (r.ok) { const j = await r.json(); if (j && j.ok && !pending) ingestControl(j); controlFails = 0; } else controlFails++;
  } catch { controlFails++; }
  updateReconnect();
  if (visible && state === 'unlocked') tControl = setTimeout(pollControl, mode === 'new' ? CONTROL_FAST_MS : CONTROL_MS);
}
function updateReconnect() {
  // new backend: live positions come with /api/control; old backend: from /api/status
  const fails = mode === 'new' ? controlFails : statusFails;
  if (ui.reconnect) ui.reconnect.hidden = fails === 0;
}
async function getJSON(path) {
  const r = await req(path, { headers: { 'x-control-pass': pin } });
  if (r.status === 401 || r.status === 403) { lock('The code changed. Enter it again.'); throw new Error('locked'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !j.ok) throw new Error('bad response');
  return j;
}
async function pollCoverage() {
  clearTimeout(tCov);
  if (!visible || state !== 'unlocked') return;
  const [c, s] = await Promise.allSettled([getJSON('/api/coverage'), getJSON('/api/suggest')]);
  if (state !== 'unlocked') return;
  if (c.status === 'fulfilled' && Array.isArray(c.value.covered)) {
    const lines = [];   // already route-bin pieces: draw as-is
    for (const p of c.value.covered) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const ln = p.filter((q) => Array.isArray(q) && num(q[0]) != null && num(q[1]) != null).map(([lon, lat]) => L.toXY(+lat, +lon));
      if (ln.length > 1) lines.push(ln);
    }
    const rs = new Map();
    for (const r of c.value.routes || []) {
      if (r?.id == null) continue;
      const len = num(r.length_m) ?? +(routeById.get(String(r.id))?.total || 0);
      const unc = num(r.uncovered_m) ?? (num(r.covered_pct) != null ? len * (1 - frac(r.covered_pct)) : len);
      rs.set(String(r.id), { id: r.id, name: r.name, length_m: len, uncovered_m: unc, covered_pct: len ? (1 - unc / len) * 100 : 0 });
    }
    const loc = computeLocalCoverage();
    for (const [k, v] of loc) if (!rs.has(k)) rs.set(k, v);   // routes the server didn't list
    cov = { source: 'server', lines, routes: rs };
  } else {
    const rs = computeLocalCoverage();
    cov = { source: 'local', lines: rs.lines, routes: rs };
  }
  if (s.status === 'fulfilled' && Array.isArray(s.value.suggestions)) {
    sugg = { source: 'server', list: s.value.suggestions.filter((x) => x && x.route_id != null) };
  } else {
    sugg = { source: 'local', list: localSuggestions() };
  }
  bgDirty = true;
  updateSuggestions(); updateWalkerSelects(); requestDraw();
  if (visible && state === 'unlocked') tCov = setTimeout(pollCoverage, COVERAGE_MS);
}
function startLoops() {
  if (state !== 'unlocked' || !visible) return;
  pollStatus(); pollCoverage(); pollFiles();
  clearTimeout(tControl); tControl = setTimeout(pollControl, mode === 'new' ? CONTROL_FAST_MS : CONTROL_MS);
  clearInterval(tTick); tTick = setInterval(() => { updateWalkers(); requestDraw(); }, 1000);
}
function stopLoops() {
  clearTimeout(tStatus); clearTimeout(tControl); clearTimeout(tCov); clearTimeout(tFiles); clearInterval(tTick);
  cancelAnimationFrame(raf); raf = 0;
}

// ---------- live file feed (phones upload every 5 min) ----------
async function pollFiles() {
  clearTimeout(tFiles);
  if (!visible || state !== 'unlocked') return;
  await Promise.all(ids().map(async (w) => {
    const c = num(createdById[w]);
    try {
      const r = await req(`/api/files?walker=${w}${c != null ? `&since=${Math.floor(c)}` : ''}`, { headers: { 'x-control-pass': pin } });
      if (!r.ok) return;   // older backend (no feed): the section stays hidden
      const j = await r.json();
      if (!j || !j.ok || !Array.isArray(j.files)) return;
      filesOK = true;
      filesById[w] = j.files.filter((f) => f && num(f.t) != null && fresh(w, f.t)).sort((a, b) => b.t - a.t);
    } catch { /* keep the last list */ }
  }));
  if (state !== 'unlocked') return;
  for (const w of ids()) renderFiles(w);
  if (visible && state === 'unlocked') tFiles = setTimeout(pollFiles, FILES_MS);
}
// newest first; a new upload starts after a quiet gap or when the session changes
function uploadBatches(files) {
  const out = [];
  let b = null, prevT = null;
  for (const f of files) {
    if (!b || prevT - f.t > BATCH_GAP_S || (f.session && b.session && f.session !== b.session)) {
      b = { t: f.t, session: f.session || '', photos: [], lights: [], csv: new Set(), json: new Set(), other: 0 }; out.push(b);
    }
    if (!b.session && f.session) b.session = f.session;
    if (f.kind === 'photo') b.photos.push(f);
    else if (f.kind === 'light') b.lights.push(f);
    else if (f.kind === 'csv') b.csv.add(String(f.path).replace(/^csv\//, '').replace(/@.*$/, ''));
    else if (f.kind === 'json') b.json.add(String(f.path).split('/').pop());
    else b.other++;
    prevT = f.t;
  }
  return out;
}
function batchLine(b) {
  const link = (list, word) => {
    const n = list.length; if (!n) return null;
    const txt = `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
    const u = list.find((f) => f.url)?.url;
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="Open the newest ${word}">${txt}</a>` : txt;
  };
  return [link(b.photos, 'photo'), link(b.lights, 'snapshot'), b.csv.size ? `${b.csv.size} CSV` : null,
    ...[...b.json].sort().map(esc), b.other ? `${b.other} other` : null].filter(Boolean).join(' · ');
}
function renderFiles(w) {
  const el = ui.wlist?.querySelector(`.ct-w[data-w="${w}"]`); if (!el) return;
  const box = el.querySelector('.ct-files');
  const files = filesById[w] || [];
  el._files = true;
  if (!filesOK && !files.length) { box.hidden = true; box.innerHTML = ''; return; }
  const bs = uploadBatches(files), open = filesOpen.has(w);
  const shown = open ? bs.slice(0, 12) : bs.slice(0, 1);
  const html = `<button class="ct-fhead" type="button" aria-expanded="${open}"${bs.length > 1 ? '' : ' disabled'}><span>Files</span><span class="ct-fcount">${bs.length ? `${bs.length} upload${bs.length === 1 ? '' : 's'}` : 'none yet'}</span>${bs.length > 1 ? '<span class="ct-chev" aria-hidden="true"></span>' : ''}</button>
    ${shown.length ? `<ol class="ct-flist">${shown.map((b) => `<li${b.session ? ` title="${esc(b.session)}"` : ''}><span class="ct-ft">${fmtClock(b.t)}</span><span class="ct-fwhat">${batchLine(b)}</span></li>`).join('')}</ol>` : ''}`;
  if (box.innerHTML !== html) {
    box.innerHTML = html;
    box.querySelector('.ct-fhead').addEventListener('click', () => { if (filesOpen.has(w)) filesOpen.delete(w); else filesOpen.add(w); renderFiles(w); });
  }
  box.hidden = false;
}

// ---------- lock ----------
async function verify(code, silent = false) {
  ui.lockMsg.textContent = silent ? 'Checking…' : '';
  ui.lockMsg.className = 'ct-lock-msg';
  ui.retry.hidden = true; ui.unlock.disabled = true; ui.unlock.textContent = 'Checking…';
  let r;
  try { r = await req('/api/control', { headers: { 'x-control-pass': code } }); }
  catch { r = null; }
  ui.unlock.disabled = false; ui.unlock.textContent = 'Unlock';
  if (r && r.ok) {
    let j = null; try { j = await r.json(); } catch { /* fall through */ }
    if (j && j.ok) { pin = code; store.set(code); unlock(j); return; }
  }
  if (r && (r.status === 401 || r.status === 403)) {
    if (silent) { store.clear(); ui.lockMsg.textContent = ''; ui.pin.focus(); return; }
    ui.lockMsg.textContent = 'Wrong code'; ui.lockMsg.classList.add('err');
    ui.card.classList.remove('shake'); void ui.card.offsetWidth; ui.card.classList.add('shake');
    ui.pin.value = BYPASS_CODE; ui.pin.focus();
    return;
  }
  // unreachable, not deployed yet (404), or a server error
  ui.lockMsg.innerHTML = `Can’t reach the control server<span class="ct-lock-detail">${r ? `HTTP ${r.status}${r.status === 404 ? ' · backend not deployed?' : ''}` : 'No response'}</span>`;
  ui.lockMsg.classList.add('err');
  ui.retry.hidden = false;
  ui.retry.dataset.code = code;
}
function unlock(j) {
  state = 'unlocked';
  ui.lock.hidden = true; ui.app.hidden = false;
  ingestControl(j);
  renderWalkers(); updateWalkers();
  if (!cov.routes.size) { cov.routes = computeLocalCoverage(); cov.lines = cov.routes.lines; sugg = { source: 'local', list: localSuggestions() }; updateSuggestions(); updateWalkerSelects(); }
  bgDirty = true; resize();
  startLoops();
}
function lock(msg = '') {
  stopLoops();
  state = 'locked'; pin = null; store.clear(); follow = null; selW = null; selRoute = null; hoverRoute = null; pickFor = null;
  ui.app.hidden = true; ui.lock.hidden = false;
  ui.pin.value = BYPASS_CODE; ui.lockMsg.textContent = msg; ui.lockMsg.className = 'ct-lock-msg' + (msg ? ' err' : '');
  ui.retry.hidden = true;
  bgDirty = true; requestDraw();
  setTimeout(() => ui.pin.focus(), 0);
}

// ---------- UI ----------
function buildUI() {
  root.innerHTML = `
    <canvas class="ct-canvas" aria-label="Live map of the walkers. Drag to pan, scroll or pinch to zoom, double-click to fit."></canvas>
    <div class="ct-lock" role="dialog" aria-modal="true" aria-labelledby="ct-lock-title">
      <form class="panel ct-card" novalidate>
        <h1 id="ct-lock-title" class="ct-lock-title">Survey Control</h1>
        <p class="ct-lock-sub">Enter the 4-digit team code.</p>
        <label class="ct-sr" for="ct-pin">Team code</label>
        <input id="ct-pin" class="ct-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="••••" value="4586">
        <button class="btn primary ct-unlock" type="submit">Unlock</button>
        <div class="ct-lock-msg" role="status" aria-live="polite"></div>
        <button class="btn ct-retry" type="button" hidden>Retry</button>
      </form>
    </div>
    <div class="ct-app" hidden>
      <div class="ct-pills" aria-live="polite">
        <span class="ct-pill ct-reconnect" hidden><span class="ct-spin" aria-hidden="true"></span>Reconnecting…</span>
        <span class="ct-pill ct-following" hidden><span class="ct-dot"></span><span class="ct-ftext"></span><button class="ct-x" type="button" aria-label="Stop following">×</button></span>
      </div>
      <aside class="panel ct-walkers" aria-label="Walkers">
        <div class="ct-head"><span class="ct-h">Walkers</span><span class="ct-wcount label"></span></div>
        <div class="ct-wlist"></div>
        <p class="ct-wempty">No walkers yet.</p>
        <form class="ct-addform" novalidate hidden>
          <label class="ct-sr" for="ct-addname">Walker name</label>
          <input id="ct-addname" class="ct-addname" type="text" maxlength="40" autocomplete="off" placeholder="Name (optional)">
          <button class="ct-addok" type="submit">Add</button>
          <button class="ct-addx" type="button" aria-label="Cancel">×</button>
        </form>
        <button class="ct-add" type="button">+ Add walker</button>
      </aside>
      <aside class="panel ct-sugg" aria-label="Suggested routes">
        <button class="ct-head ct-stoggle" type="button" aria-expanded="true"><span class="ct-h">Suggested routes</span><span class="ct-chev" aria-hidden="true"></span></button>
        <div class="ct-sbody">
          <ol class="ct-slist"></ol>
          <div class="ct-legend label"><span><i class="ct-lg-red"></i>Collected</span><span><i class="ct-lg-dash"></i>Assigned</span><span><i class="ct-lg-walk"></i>Walking</span></div>
        </div>
      </aside>
      <button class="btn ct-fit" type="button" aria-label="Fit map to all routes">Fit</button>
      <div class="ct-toast" role="status" aria-live="polite" hidden></div>
    </div>`;
  const q = (s) => root.querySelector(s);
  canvas = q('.ct-canvas'); ctx = canvas.getContext('2d'); bgCanvas = document.createElement('canvas');
  ui = {
    lock: q('.ct-lock'), card: q('.ct-card'), pin: q('.ct-pin'), unlock: q('.ct-unlock'), lockMsg: q('.ct-lock-msg'), retry: q('.ct-retry'),
    app: q('.ct-app'), reconnect: q('.ct-reconnect'), following: q('.ct-following'), ftext: q('.ct-ftext'),
    wlist: q('.ct-wlist'), wempty: q('.ct-wempty'), wcount: q('.ct-wcount'), add: q('.ct-add'), addform: q('.ct-addform'), addname: q('.ct-addname'),
    sugg: q('.ct-sugg'), stoggle: q('.ct-stoggle'), slist: q('.ct-slist'), toast: q('.ct-toast'),
  };
  ui.card.addEventListener('submit', (e) => {
    e.preventDefault();
    // demo bypass: Unlock with an empty box goes straight in (the lock is for show)
    const code = ui.pin.value.trim() || BYPASS_CODE;
    if (!/^\d{4}$/.test(code)) {
      ui.lockMsg.textContent = 'The code is 4 digits'; ui.lockMsg.className = 'ct-lock-msg err';
      ui.card.classList.remove('shake'); void ui.card.offsetWidth; ui.card.classList.add('shake');
      return;
    }
    verify(code);
  });
  ui.pin.addEventListener('input', () => { ui.pin.value = ui.pin.value.replace(/\D/g, '').slice(0, 4); });
  ui.retry.addEventListener('click', () => verify(ui.retry.dataset.code || ui.pin.value.trim(), !ui.pin.value && !!store.get()));
  // add walker
  const openAdd = () => { ui.addform.hidden = false; ui.add.hidden = true; ui.addname.value = ''; ui.addname.focus(); };
  const closeAdd = () => { ui.addform.hidden = true; ui.add.hidden = false; };
  ui.add.addEventListener('click', openAdd);
  ui.openAdd = openAdd;
  q('.ct-addx').addEventListener('click', closeAdd);
  ui.addname.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAdd(); });
  ui.addform.addEventListener('submit', (e) => { e.preventDefault(); const n = ui.addname.value.trim(); closeAdd(); addWalker(n); });

  q('.ct-x').addEventListener('click', () => setFollow(null));
  q('.ct-fit').addEventListener('click', () => { setFollow(null); fit(); requestDraw(); });
  ui.stoggle.addEventListener('click', () => {
    const open = ui.stoggle.getAttribute('aria-expanded') !== 'true';
    ui.stoggle.setAttribute('aria-expanded', String(open)); ui.sugg.classList.toggle('closed', !open);
  });
  if (window.matchMedia('(max-width: 760px)').matches) {
    ui.stoggle.setAttribute('aria-expanded', 'false'); ui.sugg.classList.add('closed');
  }
  renderWalkers(); updateSuggestions();
}

function shortName(r) { return r.kind === 'recheck' ? String(r.name).replace(/^Dark-spot recheck\s*·\s*/i, 'Recheck · ') : r.name; }
const covOf = (id) => cov.routes.get(String(id));

// ----- walkers panel -----
function routeOptions() {
  const grp = (title, rs) => rs.length ? `<optgroup label="${title}">${rs.map((r) => `<option value="${esc(r.id)}">${esc(shortName(r))}</option>`).join('')}</optgroup>` : '';
  return `<option value="">No route</option>${grp('Survey loops', routes.filter((r) => r.kind !== 'recheck'))}${grp('Rechecks', routes.filter((r) => r.kind === 'recheck'))}`;
}
function renderWalkers() {
  if (!ui.wlist) return;
  const opts = routeOptions();
  const have = new Map([...ui.wlist.children].map((el) => [+el.dataset.w, el]));
  const keep = new Set(ids());
  for (const [id, el] of have) if (!keep.has(id)) el.remove();
  roster.forEach((w, i) => {
    let el = have.get(w.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ct-w'; el.dataset.w = String(w.id); el.tabIndex = 0; el.setAttribute('role', 'button');
      el.innerHTML = `
        <div class="ct-wtop"><span class="ct-dot"></span><span class="ct-wname"></span><span class="ct-tag ct-off" hidden>Off route</span><span class="ct-status"></span><button class="ct-rm" type="button" aria-label="Remove walker">×</button></div>
        <label class="ct-sr" for="ct-wsel-${w.id}">Route</label>
        <select class="ct-wsel" id="ct-wsel-${w.id}">${opts}</select>
        <div class="ct-prog"><span class="ct-bar"><span class="ct-fill"></span></span><span class="ct-pct"></span></div>
        <div class="ct-stats"></div>
        <div class="ct-files" hidden></div>`;
      const id = w.id;
      el.addEventListener('click', (e) => { if (e.target.closest('select, button, a, .ct-files')) return; toggleSelect(id); });
      el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); toggleSelect(id); } });
      const sel = el.querySelector('.ct-wsel');
      sel.addEventListener('change', () => { const v = sel.value; if (v) doAssign(id, v); else doClear(id); });
      sel.addEventListener('focus', () => { if (assign[id]) { hoverRoute = assign[id]; requestDraw(); } });
      sel.addEventListener('blur', () => { hoverRoute = null; requestDraw(); });
      const rm = el.querySelector('.ct-rm');
      rm.addEventListener('click', () => {
        if (!rm.classList.contains('armed')) {
          rm.classList.add('armed'); rm.textContent = 'Remove?';
          clearTimeout(rm._t); rm._t = setTimeout(() => { rm.classList.remove('armed'); rm.textContent = '×'; }, 3000);
          return;
        }
        clearTimeout(rm._t); removeWalker(id);
      });
    }
    el.style.setProperty('--wc', w.color);
    el.querySelector('.ct-wname').textContent = w.name;
    if (!el._files) renderFiles(w.id);
    if (ui.wlist.children[i] !== el) ui.wlist.insertBefore(el, ui.wlist.children[i] || null);
  });
  ui.wempty.hidden = roster.length > 0;
  ui.wcount.textContent = roster.length ? String(roster.length) : '';
  updateWalkerSelects(); updateWalkers();
}
function updateWalkerSelects() {
  if (!ui.wlist) return;
  for (const el of ui.wlist.querySelectorAll('.ct-w')) {
    const id = +el.dataset.w, sel = el.querySelector('.ct-wsel');
    for (const o of sel.querySelectorAll('option[value]')) {
      if (!o.value) continue;
      const r = routeById.get(o.value); if (!r) continue;
      const by = ids().filter((w) => w !== id && assign[w] === o.value);
      o.textContent = `${shortName(r)} · ${km(r.total)}${by.length ? ` · ${by.map(nameOf).join(', ')}` : ''}`;
    }
    const v = assign[id] ?? '';
    if (sel.value !== v && document.activeElement !== sel) sel.value = v;
  }
}
function toggleSelect(id) {
  if (selW === id) { selW = null; setFollow(null); }
  else { selW = id; if (walkers[id]?.pos) setFollow(id); else setFollow(null); }
  pickFor = null; updateSuggestions(); updateWalkers(); requestDraw();
}
function updateWalkers() {
  if (!ui.wlist) return;
  for (const c of ui.wlist.querySelectorAll('.ct-w')) {
    const w = +c.dataset.w;
    const wk = walkers[w], hb = wk?.hb;
    const age = walkerAge(w), live = age != null && age <= LIVE_S;
    const st = c.querySelector('.ct-status');
    const ph = phoneState(w);
    let txt, cls;
    if (live) { txt = hb.collecting === false ? 'Live · paused' : 'Live'; cls = 'live'; }
    else if (hb && !(ph.hello && ph.age <= PHONE_S && ph.at > (hbTime(hb) ?? 0))) { txt = `No signal ${fmtAge(age ?? 0)}`; cls = 'lost'; }
    else { txt = ph.text; cls = ph.cls; }   // no walk data yet (or the app was reopened since): show the phone link
    if (st.textContent !== txt) st.textContent = txt;
    st.className = `ct-status ${cls}`;
    const tip = ph.app ? [ph.app.device, ph.app.app_version && `app ${ph.app.app_version}`].filter(Boolean).join(' · ') : '';
    if (st.title !== tip) st.title = tip;
    c.classList.toggle('stale', !!hb && !live); c.classList.toggle('idle', !hb);
    c.classList.toggle('on', selW === w); c.setAttribute('aria-pressed', String(selW === w));
    const off = num(hb?.off_route_m);
    const offEl = c.querySelector('.ct-off');
    offEl.hidden = !(off != null && off > 25 && live);
    offEl.title = off != null ? `${Math.round(off)} m from the route` : '';
    const r = routeById.get(String(assign[w] ?? ''));
    let p = frac(hb?.route_pct ?? hb?.coverage ?? hb?.captured);
    if (hb?.route_id != null && r && String(hb.route_id) !== String(r.id)) p = null;   // progress is for an older route
    const mine = walkCov[w];
    if (r && mine && mine.route === String(r.id)) p = Math.max(p ?? 0, mine.frac);
    const pc = p == null ? 0 : Math.max(0, Math.min(1, p));
    const ended = !!hb && (hb.ended === true || hb.finished === true || /^(ended|done|finished|stopped)/i.test(String(hb.state || hb.status || ''))
      || (age != null && age > ENDED_S && pc > 0));
    const done = (!!r && pc >= DONE_FRAC) || ended;
    const prog = c.querySelector('.ct-prog');
    prog.hidden = !r;
    if (r) {
      c.querySelector('.ct-fill').style.width = `${(pc * 100).toFixed(1)}%`;   // the bar follows coverage
      c.querySelector('.ct-pct').textContent = `${Math.round(pc * 100)}%`;   // matches the bar; lux/photos stay 0 until done
    }
    // numbers read zero until the route is basically walked (or the walk ended)
    let luxHtml = '<b>0</b> lux', nph = 0;
    if (done) {
      const avg = walkLux(w);
      if (avg != null) luxHtml = `<b>${L.fmtLux(avg)}</b> lux ${esc(L.level(avg))}`;
      nph = num(hb?.photos) ?? (filesById[w] || []).filter((f) => f.kind === 'photo').length;
    }
    const stats = [`<span>${luxHtml}</span>`, `<span><b>${nph.toLocaleString()}</b> photos</span>`];
    const se = c.querySelector('.ct-stats'), sh = stats.join('');
    if (se.innerHTML !== sh) se.innerHTML = sh;
    se.hidden = false;
    c.classList.toggle('done', done);
  }
  updateFollow();
}

// Phone link: "Phone connected" (hello or heartbeat in the last 2 min), "Phone seen 14 min ago", or "Waiting for phone".
function phoneState(w) {
  const app = appById[w] || null;
  const helloAt = app ? toSec(app.seen_at) : null;
  const hbAt = hbTime(walkers[w]?.hb);
  const at = Math.max(helloAt ?? -Infinity, hbAt ?? -Infinity);
  if (!Number.isFinite(at)) return { text: 'Waiting for phone', cls: 'idle', app, at: null, age: null, hello: false };
  const age = Math.max(0, nowSec() - at), hello = helloAt != null && helloAt >= (hbAt ?? -Infinity);
  if (age <= PHONE_S) return { text: 'Phone connected', cls: 'ready', app, at, age, hello };
  const m = Math.round(age / 60);
  const ago = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return { text: `Phone seen ${ago} ago`, cls: 'idle', app, at, age, hello };
}

// ----- suggestions panel -----
function updateSuggestions() {
  if (!ui.slist) return;
  if (hoverRoute != null && ids().some((w) => assign[w] === String(hoverRoute))) hoverRoute = null;
  const assigned = new Set(ids().map((w) => assign[w]).filter(Boolean));
  const list = sugg.list.filter((s) => !assigned.has(String(s.route_id)) && routeById.has(String(s.route_id)))
    .filter((s) => (num(s.uncovered_m) ?? 1e9) >= 50).slice(0, N_SUGGEST);
  if (!routes.length) { ui.slist.innerHTML = '<li class="ct-snone">No route library.</li>'; return; }
  if (!list.length) { ui.slist.innerHTML = '<li class="ct-snone">Nothing new left to suggest.</li>'; return; }
  const target = assignTarget();
  ui.slist.innerHTML = list.map((s) => {
    const r = routeById.get(String(s.route_id));
    const c = covOf(s.route_id);
    const len = num(s.length_m) ?? c?.length_m ?? +r.total;
    const id = String(r.id);
    const picking = pickFor === id;
    return `<li class="ct-s${selRoute === id ? ' sel' : ''}" data-id="${esc(id)}">
      <button class="ct-shead" type="button" aria-pressed="${selRoute === id}">
        <span class="ct-swatch" aria-hidden="true"></span>
        <span class="ct-stext"><span class="ct-sname">${esc(r.name)}</span><span class="ct-smeta">${km(len)}</span></span>
      </button>
      <button class="ct-sgo" type="button"${target ? ` title="Assign to ${esc(nameOf(target))}"` : ''}>Assign${target && roster.length > 1 ? ` ${esc(nameOf(target))}` : ''} →</button>
      ${picking ? `<div class="ct-pick" role="group" aria-label="Assign to"><span class="label">To</span>${roster.map((w) => `<button type="button" data-w="${w.id}"><span class="ct-dot"></span>${esc(w.name)}</button>`).join('')}</div>` : ''}
    </li>`;
  }).join('');
  for (const li of ui.slist.querySelectorAll('.ct-s')) {
    const id = li.dataset.id;
    const enter = () => { hoverRoute = id; requestDraw(); };
    const leave = () => { if (hoverRoute === id) { hoverRoute = null; requestDraw(); } };
    li.addEventListener('mouseenter', enter); li.addEventListener('mouseleave', leave);
    li.querySelector('.ct-shead').addEventListener('click', () => { selRoute = selRoute === id ? null : id; updateSuggestions(); requestDraw(); });
    li.querySelector('.ct-sgo').addEventListener('click', () => assignSuggestion(id));
    li.querySelectorAll('.ct-pick button').forEach((b) => b.addEventListener('click', () => { pickFor = null; doAssign(+b.dataset.w, id); }));
  }
}
function assignTarget() {
  if (selW != null && roster.some((w) => w.id === selW)) return selW;
  if (roster.length === 1) return roster[0].id;
  return null;
}
function assignSuggestion(id) {
  if (!roster.length) { toast('Add a walker first'); ui.openAdd?.(); return; }
  const t = assignTarget();
  if (t != null) { pickFor = null; doAssign(t, id); return; }
  pickFor = pickFor === id ? null : id; updateSuggestions();
}

// ----- actions -----
async function post(body) {
  const r = await req('/api/control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-pass': pin }, body: JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) { lock('The code changed. Enter it again.'); const e = new Error('locked'); e.locked = true; throw e; }
  const j = r.ok ? await r.json().catch(() => null) : null;
  return { status: r.status, ok: !!(j && j.ok), j };
}
function afterPost(j) {
  if (!j) return;
  if (Array.isArray(j.walkers)) ingestControl(j);
  else if (j.assignments) { assign = { ...assign, ...normAssign(j.assignments) }; updateAll(); }
}
function updateAll() { computeWalkCov(); updateWalkers(); updateWalkerSelects(); updateSuggestions(); requestDraw(); }
async function postAssign(body, optimistic, okMsg) {
  const before = { ...assign };
  assign = { ...assign, ...optimistic }; updateAll();
  pending++;
  try {
    const { ok, j, status: st } = await post(body);
    if (!ok) throw new Error(st === 400 ? 'server said no' : `HTTP ${st}`);
    pending--;
    afterPost(j);
    toast(okMsg);
  } catch (e) {
    pending--;
    if (e.locked) return;
    assign = before; updateAll();
    toast(`Couldn’t save (${e.message === 'server said no' ? 'server said no' : 'connection'}). Try again.`, true);
  }
}
function doAssign(w, id) {
  hoverRoute = null;   // the suggestion list is rebuilt, so its mouseleave never fires
  if (assign[w] === String(id)) return;
  const r = routeById.get(String(id));
  postAssign({ action: 'assign', walker: w, route_id: r?.id ?? id }, { [w]: String(id) }, `${shortName(r || { name: id })} → ${nameOf(w)}`);
}
function doClear(w) {
  postAssign({ action: 'clear', walker: w }, { [w]: null }, `${nameOf(w)} unassigned`);
}
function nextId() {
  const used = new Set([...ids(), ...Object.keys(assign).filter((k) => assign[k]).map(Number)]);
  let id = 1; while (used.has(id)) id++;
  return id;
}
async function addWalker(name) {
  const id = nextId(), color = colorFor(id);
  name = (name || '').trim() || `Walker ${id}`;
  if (mode === 'new') {
    try {
      const { ok, j } = await post({ action: 'add_walker', name, color });
      if (ok && j.walker) {
        const n = normWalker(j.walker);
        if (n && !serverRoster.some((w) => w.id === n.id)) serverRoster.push(n);
        if (Array.isArray(j.walkers)) ingestControl(j); else if (mergeRoster()) renderWalkers();
        toast(`${n?.name || name} added`); return;
      }
    } catch (e) { if (e.locked) return; }
  }
  // old backend (or add_walker not supported): keep the walker in this browser
  const st = local.read();
  st.walkers = st.walkers.filter((w) => +w.id !== id); st.walkers.push({ id, name, color, created: nowSec() }); delete st.removed[id];
  createdById[id] = nowSec(); delete localTrails[id];
  local.write(st);
  if (mergeRoster()) renderWalkers();
  rebuildWalkers(); updateAll();
  toast(`${name} added`);
}
async function removeWalker(id) {
  const name = nameOf(id);
  if (mode === 'new' && serverRoster.some((w) => w.id === id)) {
    try {
      const { ok, j } = await post({ action: 'remove_walker', walker: id });
      if (!ok) throw new Error('no');
      serverRoster = serverRoster.filter((w) => w.id !== id);
      if (Array.isArray(j?.walkers)) ingestControl(j);
    } catch (e) { if (e.locked) return; toast(`Couldn’t remove ${name}. Try again.`, true); renderWalkers(); return; }
  } else if (assign[id]) {
    try { await post({ action: 'clear', walker: id }); } catch (e) { if (e.locked) return; }
  }
  const st = local.read();
  st.walkers = st.walkers.filter((w) => +w.id !== id); st.removed[id] = nowSec();
  local.write(st);
  delete assign[id]; delete localTrails[id]; delete appById[id]; delete createdById[id]; delete filesById[id]; delete luxAcc[id]; filesOpen.delete(id);
  if (selW === id) selW = null;
  if (follow === id) follow = null;
  mergeRoster(); renderWalkers(); rebuildWalkers(); updateAll();
  toast(`${name} removed`);
}
let toastT = 0;
function toast(msg, err = false) {
  ui.toast.textContent = msg; ui.toast.classList.toggle('err', err); ui.toast.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { ui.toast.hidden = true; }, 4200);
}

function setFollow(w) {
  follow = w;
  if (w && walkers[w]?.pos) { if (view.s < 0.9) view.s = 1.2; centreOn(...walkers[w].pos); }
  updateFollow(); requestDraw();
}
function updateFollow() {
  if (!ui.following) return;
  ui.following.hidden = !follow;
  if (follow) { ui.following.style.setProperty('--wc', colorOf(follow)); ui.ftext.textContent = `Following ${nameOf(follow)}`; }
}

// ---------- input ----------
function bindInput() {
  const pts = new Map();
  let pinch0 = null, moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.offsetX, e.offsetY]); moved = false;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s: view.s }; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) { canvas.style.cursor = pickWalker(e.offsetX, e.offsetY) ? 'pointer' : 'grab'; return; }
    const prev = pts.get(e.pointerId);
    const dx = e.offsetX - prev[0], dy = e.offsetY - prev[1];
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    if (pts.size === 1) {
      if (moved && follow) setFollow(null);
      view.cx -= dx / view.s; view.cy += dy / view.s; canvas.style.cursor = 'grabbing';
    } else if (pts.size === 2 && pinch0) {
      const [a, b] = [...pts.values()];
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch0.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch0.d / view.s);
      moved = true;
    }
    bgDirty = true; requestDraw();
  });
  const up = (e) => {
    const one = pts.size === 1;
    pts.delete(e.pointerId); pinch0 = null; canvas.style.cursor = 'grab';
    if (one && !moved && e.type === 'pointerup' && state === 'unlocked') {
      const w = pickWalker(e.offsetX, e.offsetY);
      if (w) toggleSelect(w);
    }
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    if (follow && walkers[follow]?.pos) { view.s = Math.max(0.05, Math.min(40, view.s * f)); centreOn(...walkers[follow].pos); }
    else zoomAt(e.offsetX, e.offsetY, f);
    bgDirty = true; requestDraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { setFollow(null); fit(); requestDraw(); });
}
function pickWalker(px, py) {
  if (state !== 'unlocked') return null;
  let best = null, bd = 16 * 16;
  for (const w of ids()) {
    const p = walkers[w]?.pos; if (!p) continue;
    const [sx, sy] = toScreen(...p); const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}
function zoomAt(px, py, f) {
  const ns = Math.max(0.05, Math.min(40, view.s * f));
  const [wx, wy] = toWorld(px, py);
  view.s = ns; view.cx = wx - (px - W / 2) / ns; view.cy = wy + (py - H / 2) / ns;
}

// ---------- module ----------
export default {
  async mount(el, LUX) {
    L = LUX; root = el; css();
    const [rows, bld, lib] = await Promise.all([
      L.load('readings_1hz.csv').catch(() => []),
      L.load('buildings.geojson').catch(() => ({ features: [] })),
      L.load('route_library.json').catch(() => []),
    ]);
    readingPts = [];
    for (const r of rows) {
      const xy = r.x != null && r.y != null ? [r.x, r.y] : (r.lat != null && r.lon != null ? L.toXY(r.lat, r.lon) : null);
      if (xy) readingPts.push(xy);
    }
    buildings = [];
    for (const f of bld.features || []) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const p of polys) if (p[0]) buildings.push(p[0].map(([lon, lat]) => L.toXY(lat, lon)));
    }
    routes = (Array.isArray(lib) ? lib : []).filter((r) => r && Array.isArray(r.pts) && r.pts.length > 1)
      .map((r) => ({ ...r, xy: r.pts.map(([lat, lon]) => L.toXY(lat, lon)) }));
    routeById = new Map(routes.map((r) => [String(r.id), r]));
    buildUI();
    bindInput();
    new ResizeObserver(() => { if (visible) resize(); }).observe(root);
  },
  show() {
    visible = true;
    resize();
    if (state === 'unlocked') { startLoops(); return; }
    if (!triedStored) {
      triedStored = true;
      const saved = store.get();
      if (saved) { verify(saved, true); return; }
    }
    setTimeout(() => ui.pin?.focus(), 0);
  },
  hide() { visible = false; stopLoops(); },
};
