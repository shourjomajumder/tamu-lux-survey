// App shell: hash router, lazy view loading, shared data loader, cross-view events.
// Every view module (js/<view>.js) default-exports { mount(el, LUX), show(params), hide() }.
// mount() is called once, the first time the view is shown.

const cache = new Map();

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const v = l.split(','); const o = {};
    head.forEach((h, i) => { const x = v[i]; o[h] = x === '' || x === undefined ? null : (isNaN(+x) ? x : +x); });
    return o;
  });
}

export const LUX = {
  // load('lamps.geojson') -> parsed JSON;  load('readings_1hz.csv') -> array of row objects (numbers parsed)
  async load(name) {
    if (!cache.has(name)) {
      cache.set(name, fetch(`data/${name}`).then(async (r) => {
        if (!r.ok) throw new Error(`${name}: ${r.status}`);
        return name.endsWith('.csv') ? parseCSV(await r.text()) : r.json();
      }));
    }
    return cache.get(name);
  },
  // tiny event bus for cross-view actions
  _ev: {},
  on(type, fn) { (this._ev[type] ||= []).push(fn); },
  emit(type, detail) { (this._ev[type] || []).forEach((f) => f(detail)); },
  // navigate to a view with params, e.g. LUX.go('street', {session:'W1_...', index: 120})
  go(view, params = {}) {
    const q = new URLSearchParams(params).toString();
    location.hash = q ? `${view}?${q}` : view;
  },
  // plain-language light level (never a colour scale)
  level(lux) {
    if (lux == null || Number.isNaN(lux)) return 'No data';
    if (lux < 1) return 'Dark'; if (lux < 3) return 'Very dim'; if (lux < 5) return 'Dim';
    if (lux < 10) return 'Adequate'; if (lux < 30) return 'Well lit'; return 'Bright';
  },
  fmtLux(lux) { return lux == null ? '—' : (lux < 10 ? lux.toFixed(1) : Math.round(lux).toString()); },
  walkerColor(w) { return getComputedStyle(document.documentElement).getPropertyValue(`--w${w}`).trim() || '#9aa3b2'; },
  // perceptual brightness 0..1 for drawing light as light (log scale, 0.3 lux -> 0, 60 lux -> 1)
  glow(lux) { if (!lux || lux <= 0.3) return 0; return Math.max(0, Math.min(1, Math.log(lux / 0.3) / Math.log(200))); },
  // local metres around campus origin (same as the pipeline's geo.py)
  LAT0: 30.6150, LON0: -96.3400,
  toXY(lat, lon) { const mLon = 111320 * Math.cos(this.LAT0 * Math.PI / 180); return [(lon - this.LON0) * mLon, (lat - this.LAT0) * 111320]; },
  toLL(x, y) { const mLon = 111320 * Math.cos(this.LAT0 * Math.PI / 180); return [this.LAT0 + y / 111320, this.LON0 + x / mLon]; },
};
window.LUX = LUX;

const views = {};
let current = null;

async function route() {
  let [name, qs] = (location.hash.slice(1) || 'map').split('?');
  if (name === 'street') name = 'map';   // Street View retired: old links open the Light Map walk-through (same session/index params)
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  const view = ['map', 'street', 'replay', 'scan', 'data', 'control', 'walk'].includes(name) ? name : 'map';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.dataset.view === view));
  if (current && current !== view && views[current]) views[current].hide?.();
  const el = document.getElementById(`view-${view}`);
  if (!views[view]) {
    el.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const mod = await import(`./${view}.js`);
      views[view] = mod.default;
      el.innerHTML = '';
      await views[view].mount(el, LUX);
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="loading">This view could not load (${e.message}).</div>`;
      current = view; return;
    }
  }
  current = view;
  views[view].show?.(params);
}

window.addEventListener('hashchange', route);

route();
