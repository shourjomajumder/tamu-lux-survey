// Data — the dataset as a scrolling page: headline numbers, distributions, worst spots, downloads, dictionary, method.
// export default { mount(el, LUX), show(params), hide() }

const TZ = 'America/Chicago';
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtTime = (s) => timeFmt.format(new Date(s * 1000)).replace(' AM', ' am').replace(' PM', ' pm');
const nf = (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

const LEVELS = [ // representative lux for drawing each level *as light*
  ['Dark', 0.6, 'under 1 lux'], ['Very dim', 2, '1–3 lux'], ['Dim', 4, '3–5 lux'],
  ['Adequate', 7, '5–10 lux'], ['Well lit', 18, '10–30 lux'], ['Bright', 60, '30+ lux'],
];
const LIGHT_TYPES = [
  ['sodium / amber', 'Sodium / amber', 2000], ['warm white LED', 'Warm white LED', 3000],
  ['neutral white LED', 'Neutral white LED', 4000], ['cool white LED', 'Cool white LED', 5700],
];

const FILES = [
  ['summary.json', 'Headline counts for the whole survey: filtering, lamps, warnings, light-level shares.'],
  ['readings_1hz.csv', 'One clean light reading per second per walker, with position and heading.'],
  ['path_lighting.geojson', 'Light on every surveyed 5 m stretch: median, minimum, average, evenness, canopy.'],
  ['lamps.geojson', 'Streetlights triangulated from photos: height, colour temperature, brightness, confidence.'],
  ['lamps_possibly_out.geojson', 'Fixtures that were seen but appeared dark when faced — worth checking.'],
  ['warnings.geojson', 'Low-light stretches below the ~5 lux walkway guideline, with severity.'],
  ['activity.geojson', 'Where and when people, bicycles and vehicles were detected (positions only, no images).'],
  ['photos_index.csv', 'Every privacy-blurred photo: time, position, compass heading. Images not shipped.'],
  ['trees.geojson', 'Tree crowns along the paths (canopy that can block lamplight).'],
  ['buildings.geojson', 'Building footprints with heights.'],
  ['emergency_phones.geojson', 'Blue-light emergency phones.'],
];

const DICT = {
  'summary.json': [
    ['generated', 'ISO 8601 UTC', 'When the pipeline produced this release'],
    ['sessions', 'count', 'Walks recorded (one per walker per start/stop)'],
    ['readings_filter.raw', 'count', 'Light readings captured (~15 per second)'],
    ['readings_filter.vehicle', 'count', 'Removed: within ±2 s of a detected vehicle (headlights)'],
    ['readings_filter.spike', 'count', 'Removed: short isolated spikes'],
    ['readings_filter.kept', 'count', 'Clean readings used everywhere else'],
    ['readings_1hz', 'count', 'Rows in readings_1hz.csv'],
    ['lamps', 'count', 'Streetlights located'],
    ['lamps_possibly_out', 'count', 'Fixtures that may be out'],
    ['trees · emergency_phones', 'count', 'Features in those files'],
    ['path_segments', 'count', 'Features in path_lighting.geojson'],
    ['warnings · warnings_high', 'count', 'Low-light warnings, and how many are high severity'],
    ['activity_points', 'count', 'Detections in activity.geojson'],
    ['lamp_accuracy_vs_osm', 'object | null', 'Agreement with OpenStreetMap street_lamp nodes (found_within_10m, 0–1)'],
    ['osm_street_lamps', 'count', 'OpenStreetMap street lamps in the area'],
    ['level_share', 'fraction 0–1', 'Share of surveyed stretches at each light level, Dark … Bright'],
  ],
  'readings_1hz.csv': [
    ['sec', 'unix seconds, UTC', 'Time of the reading'],
    ['lux', 'lux', 'Median illuminance in that second (front camera under a diffuser)'],
    ['lat · lon', 'degrees (WGS 84)', 'Phone GPS position'],
    ['h_acc', 'metres', 'GPS horizontal accuracy reported by the phone'],
    ['yaw', 'degrees from true north', 'Phone heading'],
    ['session', 'text', 'Walk id, e.g. W1_2026-11-07_184140'],
    ['walker', '1–4', 'Which of the four walkers'],
    ['x · y', 'metres', 'Local east / north offset from 30.615 N, 96.340 W'],
  ],
  'path_lighting.geojson': [
    ['geometry', 'LineString | Point', 'A 5 m stretch of an OSM footpath, or a 5 m cell where no path matched'],
    ['readings', 'count', 'Readings that fell on this stretch'],
    ['walkers', 'list of 1–4', 'Which walkers covered it'],
    ['lux_median · lux_min · lux_avg', 'lux', 'Light on the stretch'],
    ['evenness', 'ratio', 'lux_avg ÷ lux_min (1 = perfectly even; high = patchy)'],
    ['level', 'text', 'Dark / Very dim / Dim / Adequate / Well lit / Bright'],
    ['canopy', '0–1 | null', 'Share of overhead view covered by trees'],
    ['osm_way', 'id', 'OpenStreetMap way the stretch belongs to (if matched)'],
    ['path_type', 'text', 'OSM path type, or "off-network"'],
    ['name', 'text', 'Path or street name, if any'],
    ['nearest_emergency_phone_m', 'metres', 'Distance to the nearest blue-light phone'],
  ],
  'lamps.geojson': [
    ['id', 'text', 'Lamp id, e.g. L0001'],
    ['height_m', 'metres', 'Estimated height above ground (kept only 2.5–15 m)'],
    ['rays · pairs', 'count', 'Sightings (rays) and ray pairs that intersected here'],
    ['spread_m', 'metres', 'Scatter of the ray intersections (smaller = more certain)'],
    ['cct_k', 'Kelvin', 'Correlated colour temperature of the light'],
    ['brightness', '0–255', 'Relative brightness in the short-exposure photos'],
    ['sessions', 'list', 'Walks that saw this lamp'],
    ['lux_near · lux_ring', 'lux', 'Measured light right under the lamp, and in a ring around it'],
    ['peak_ratio', 'ratio', 'lux_near ÷ lux_ring (does the ground light up under it?)'],
    ['confidence', '0–1', 'Overall confidence this is a real lamp'],
    ['light_type', 'text', 'sodium / amber · warm white LED · neutral white LED · cool white LED'],
  ],
  'lamps_possibly_out.geojson': [
    ['kind', 'text', 'Fixture type, e.g. streetlight'],
    ['sightings', 'count', 'Times the fixture was seen in photos'],
    ['dark_snapshots_facing', 'count', 'Short-exposure snapshots facing it in which it was dark'],
    ['status', 'text', '"possibly out"'],
    ['conf', '0–1', 'Confidence it is out'],
  ],
  'warnings.geojson': [
    ['severity', 'high | medium | low', 'How far below the guideline, and for how long'],
    ['length_m', 'metres', 'Length of the dim stretch'],
    ['lux_median', 'lux', 'Typical light on it'],
    ['level', 'text', 'Light level word'],
    ['path', 'text', 'Path name, or "off-network"'],
    ['text', 'text', 'Plain-language description'],
  ],
  'activity.geojson': [
    ['kind', 'person | bicycle | vehicle', 'What was detected'],
    ['t', 'unix seconds, UTC', 'When'],
    ['session', 'text', 'Which walk saw it'],
  ],
  'photos_index.csv': [
    ['session · walker', 'text · 1–4', 'Which walk'],
    ['index', 'count', 'Photo number within the walk (used by Street View)'],
    ['file', 'path', 'File name inside the walk (images are not shipped)'],
    ['epoch', 'unix seconds, UTC', 'Capture time'],
    ['lat · lon', 'degrees (WGS 84)', 'Position'],
    ['heading_deg', 'degrees from true north', 'Direction the back camera faced'],
    ['linear_y', 'linear 0–1', 'Mean scene brightness of the photo'],
  ],
  'trees.geojson': [
    ['crown_radius_m', 'metres', 'Crown radius'], ['height_m', 'metres', 'Tree height'], ['source', 'text', 'Where the tree came from'],
  ],
  'buildings.geojson': [['name', 'text', 'Building name'], ['height_m', 'metres', 'Height']],
  'emergency_phones.geojson': [['source', 'text', 'Where the phone location came from']],
};

// CCT (K) -> sRGB (Tanner Helland approximation)
function cctRGB(k) {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * (t - 60) ** -0.1332047592; g = 288.1221695283 * (t - 60) ** -0.0755148492; }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.round(Math.max(0, Math.min(255, v)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const warnIcon = (sz = 12) => `<svg class="dt-warn" width="${sz}" height="${sz}" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 11 10.4H1z" fill="#c00000" stroke="#c00000" stroke-width="1" stroke-linejoin="round"/></svg>`;

let L, root, chartCleanup = null;

function css() {
  if (document.getElementById('css-data')) return;
  const l = document.createElement('link'); l.id = 'css-data'; l.rel = 'stylesheet'; l.href = 'css/data.css';
  document.head.appendChild(l);
}

// ---------- sections ----------
function heroHTML(paths) {
  const f = paths.features || [];
  const withLux = f.filter((x) => x.properties && x.properties.lux_median != null);
  const below = withLux.filter((x) => x.properties.lux_median < 5).length;
  const share = withLux.length ? below / withLux.length : null;
  const dark = withLux.filter((x) => x.properties.lux_median < 1).length;
  const answer = share == null ? 'Path data is not available yet.'
    : `About ${Math.round(share * 100)}% of the surveyed paths fall below the ~5 lux walkway guideline.`;
  return `
  <header class="dt-hero">
    <p class="dt-eyebrow label">Texas A&amp;M · Build-A-Dataset · night of 7 November 2026</p>
    <h1>How dark is Texas A&amp;M at night?</h1>
    <p class="dt-answer">${answer}</p>
    ${share == null ? '' : `<p class="dt-sub">${nf(below)} of ${nf(withLux.length)} five-metre stretches we walked measured under 5 lux; ${nf(dark)} were under 1 lux (Dark).</p>`}
  </header>`;
}

function bigHTML(s, nPhotos, activity, nWalkers) {
  const kinds = {};
  (activity.features || []).forEach((f) => { const k = f.properties?.kind; if (k) kinds[k] = (kinds[k] || 0) + 1; });
  const objCount = s.activity_points ?? (activity.features || []).length;
  const objSub = Object.keys(kinds).length
    ? ['person', 'bicycle', 'vehicle'].filter((k) => kinds[k]).map((k) => `${nf(kinds[k])} ${k === 'person' ? 'people' : k + 's'}`).join(' · ')
    : 'people, bicycles, vehicles';
  const rf = s.readings_filter || {};
  const carRemoved = (rf.vehicle || 0) + (rf.spike || 0);
  const acc = s.lamp_accuracy_vs_osm;
  let accVal = '—', accSub = 'No OpenStreetMap lamps to compare with yet', accLabel = 'Lamp accuracy vs OpenStreetMap';
  if (acc && acc.found_within_10m != null) {
    const v = acc.found_within_10m; accVal = pct(v <= 1 ? v : v / 100); accSub = 'of OSM street lamps found within 10 m';
  } else if (s.osm_street_lamps != null && s.lamps) {
    accVal = `${Math.round(s.lamps / Math.max(1, s.osm_street_lamps))}×`; accLabel = 'More lamps than OpenStreetMap';
    accSub = `OSM maps ${nf(s.osm_street_lamps)} street lamps in this area; this survey located ${nf(s.lamps)}`;
  }
  const cells = [
    [nf(s.sessions), 'Walks', nWalkers ? `${nWalkers} walkers, one evening` : 'one evening'],
    [nf(rf.kept), 'Clean light readings', rf.raw ? `of ${nf(rf.raw)} captured` : ''],
    [nf(nPhotos), 'Photos', 'faces and plates blurred'],
    [nf(objCount), 'Objects detected', objSub],
    ...(s.trees ? [[nf(s.trees), 'Trees mapped', s.trees_from_canopy ? `${nf(s.trees_from_canopy)} from measured canopy over paths` : 'from OpenStreetMap']] : []),
    [nf(s.lamps), 'Streetlights located', 'triangulated from photos'],
    [nf(s.lamps_possibly_out), 'Lamps possibly out', 'seen, but dark when faced'],
    [nf(carRemoved), 'Car-light moments removed', `${nf(rf.vehicle)} near vehicles · ${nf(rf.spike)} spikes`],
    [nf(s.warnings), 'Low-light warnings', s.warnings_high ? `${nf(s.warnings_high)} high severity` : 'stretches under ~5 lux'],
    [accVal, accLabel, accSub],
  ];
  return `
  <section class="dt-section" aria-labelledby="dt-h-num">
    <h2 id="dt-h-num" class="dt-rp-sr">The dataset in numbers</h2>
    <div class="dt-grid">
      ${cells.map(([v, l, sub]) => `<div class="dt-cell"><div class="big">${v}</div><div class="dt-cell-l">${l}</div>${sub ? `<div class="label">${sub}</div>` : ''}</div>`).join('')}
    </div>
  </section>`;
}

function levelsHTML(s) {
  const share = s.level_share || {};
  const maxShare = Math.max(0.01, ...LEVELS.map(([n]) => share[n] ?? 0));
  const rows = LEVELS.map(([name, rep, range]) => {
    const v = share[name] ?? 0;
    const g = L.glow(rep);
    const glowPx = Math.round(g * 18);
    return `<div class="dt-lv">
      <div class="dt-lv-name">${name}<span class="label">${range}</span></div>
      <div class="dt-lv-track" role="img" aria-label="${name}: ${pct(v, 1)}">
        <div class="dt-lv-fill" style="width:${((v / maxShare) * 100).toFixed(2)}%;background:rgba(var(--light-rgb),${(0.04 + g * 0.96).toFixed(3)});box-shadow:0 0 ${glowPx}px ${Math.round(glowPx / 3)}px rgba(var(--light-rgb),${(g * 0.35).toFixed(3)})"></div>
      </div>
      <div class="dt-lv-v">${pct(v, 0)}</div>
    </div>`;
  }).join('');
  const under5 = (share.Dark || 0) + (share['Very dim'] || 0) + (share.Dim || 0);
  return `
  <section class="dt-section" aria-labelledby="dt-h-lv">
    <h2 id="dt-h-lv">Light along the paths</h2>
    <p class="dt-lede">Share of surveyed 5 m stretches at each level. Each bar is drawn as light: the darker the level, the less it glows. ${pct(under5)} of stretches are Dim or darker.</p>
    <div class="dt-levels">${rows}</div>
  </section>`;
}

function nightHTML() {
  return `
  <section class="dt-section" aria-labelledby="dt-h-night">
    <h2 id="dt-h-night">Light through the night</h2>
    <p class="dt-lede">Median light per 10 minutes, all walkers together, on a log scale. Dashed line: ~5 lux walkway guideline. The first short walks were tests at dusk.</p>
    <div class="dt-chart" role="img" aria-label="Median lux over the night in 10-minute bins"></div>
  </section>`;
}

function drawNight(host, rows) {
  const BIN = 600;
  const bins = new Map();
  for (const r of rows) {
    if (r.sec == null || r.lux == null) continue;
    const b = Math.floor(r.sec / BIN) * BIN;
    if (!bins.has(b)) bins.set(b, { lux: [], walkers: new Set() });
    const o = bins.get(b); o.lux.push(r.lux); o.walkers.add(r.walker);
  }
  const data = [...bins.entries()].filter(([, o]) => o.lux.length >= 20)
    .map(([b, o]) => ({ t: b + BIN / 2, b, med: median(o.lux), n: o.lux.length, w: o.walkers.size, dark: o.lux.filter((x) => x < 5).length / o.lux.length }))
    .sort((a, b) => a.t - b.t);
  if (!data.length) { host.innerHTML = '<p class="label">No readings.</p>'; return; }

  const render = () => {
    const Wd = Math.max(320, host.clientWidth), Hd = 260;
    const m = { l: 44, r: 16, t: 16, b: 30 };
    const t0 = data[0].b, t1 = data[data.length - 1].b + BIN;
    const yMin = 0.3, yMax = Math.max(60, ...data.map((d) => d.med)) * 1.15;
    const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (Wd - m.l - m.r);
    const Y = (v) => m.t + (1 - Math.log(Math.max(yMin, v) / yMin) / Math.log(yMax / yMin)) * (Hd - m.t - m.b);
    // split into runs where bins are contiguous
    const runs = []; let cur = [];
    data.forEach((d, i) => { if (i && d.b - data[i - 1].b > BIN) { runs.push(cur); cur = []; } cur.push(d); });
    runs.push(cur);
    const line = (run) => run.map((d, i) => `${i ? 'L' : 'M'}${X(d.t).toFixed(1)},${Y(d.med).toFixed(1)}`).join('');
    const area = (run) => `${line(run)}L${X(run[run.length - 1].t).toFixed(1)},${Y(yMin)}L${X(run[0].t).toFixed(1)},${Y(yMin)}Z`;
    const yt = [1, 5, 10, 30, 100].filter((v) => v < yMax);
    const xt = []; const step = 1800; for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) xt.push(t);
    const every = Math.max(1, Math.ceil(72 / ((step / (t1 - t0)) * (Wd - m.l - m.r))));
    const thin = xt.filter((_, i) => i % every === 0);
    host.innerHTML = `
      <svg width="${Wd}" height="${Hd}" viewBox="0 0 ${Wd} ${Hd}">
        <defs><linearGradient id="dt-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgb(255,226,170)" stop-opacity=".22"/><stop offset="1" stop-color="rgb(255,226,170)" stop-opacity="0"/></linearGradient></defs>
        ${yt.map((v) => `<line x1="${m.l}" x2="${Wd - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 5 ? 'dt-guide' : 'dt-grid-l'}"/>
          <text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="dt-ax">${v}</text>`).join('')}
        <text x="${m.l - 8}" y="${m.t - 4}" text-anchor="end" class="dt-ax">lux</text>
        ${thin.map((t) => `<text x="${X(t)}" y="${Hd - 8}" text-anchor="middle" class="dt-ax">${fmtTime(t)}</text>`).join('')}
        ${runs.map((r) => `<path d="${area(r)}" fill="url(#dt-area)"/>`).join('')}
        ${runs.map((r) => `<path d="${line(r)}" class="dt-line"/>`).join('')}
        ${data.map((d) => `<circle cx="${X(d.t)}" cy="${Y(d.med)}" r="1.8" class="dt-pt"/>`).join('')}
        ${runs.slice(1).map((r, i) => { const a = runs[i][runs[i].length - 1], bb = r[0]; return bb.t - a.t > 2400 ? `<text x="${(X(a.t) + X(bb.t)) / 2}" y="${Y(1.6)}" text-anchor="middle" class="dt-ax dt-gap">no one walking</text>` : ''; }).join('')}
        <line class="dt-cursor" y1="${m.t}" y2="${Hd - m.b}" x1="0" x2="0" visibility="hidden"/>
        <circle class="dt-cdot" r="4" cx="0" cy="0" visibility="hidden"/>
        <rect x="${m.l}" y="0" width="${Wd - m.l - m.r}" height="${Hd}" fill="transparent" class="dt-hit"/>
      </svg>
      <div class="tooltip dt-tip" hidden></div>`;
    const svg = host.querySelector('svg'), tip = host.querySelector('.dt-tip');
    const cl = svg.querySelector('.dt-cursor'), cd = svg.querySelector('.dt-cdot');
    const hit = svg.querySelector('.dt-hit');
    const move = (e) => {
      const r = svg.getBoundingClientRect(); const px = e.clientX - r.left;
      let best = data[0]; for (const d of data) if (Math.abs(X(d.t) - px) < Math.abs(X(best.t) - px)) best = d;
      const x = X(best.t), y = Y(best.med);
      cl.setAttribute('x1', x); cl.setAttribute('x2', x); cd.setAttribute('cx', x); cd.setAttribute('cy', y);
      cl.setAttribute('visibility', 'visible'); cd.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<div class="dt-tip-t">${fmtTime(best.b)} – ${fmtTime(best.b + BIN)}</div>
        <div><span class="dt-tip-v">${L.fmtLux(best.med)}</span> lux median · ${L.level(best.med)}</div>
        <div class="label">${nf(best.n)} readings · ${best.w} walker${best.w > 1 ? 's' : ''} · ${pct(best.dark)} under 5 lux</div>`;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Wd - tw - 4, Math.max(4, x + 14))}px`;
      tip.style.top = `${Math.max(0, y - 70)}px`;
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cl.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); });
  };
  render();
  const ro = new ResizeObserver(() => render()); ro.observe(host);
  chartCleanup = () => ro.disconnect();
}

function warningsHTML(w) {
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = (w.features || []).filter((f) => f.geometry?.coordinates).slice()
    .sort((a, b) => (rank[a.properties.severity] ?? 3) - (rank[b.properties.severity] ?? 3)
      || (b.properties.length_m ?? 0) - (a.properties.length_m ?? 0)
      || (a.properties.lux_median ?? 99) - (b.properties.lux_median ?? 99));
  const top = [];
  for (const f of sorted) { // one per spot: skip warnings within 25 m of one already listed
    const [lon, lat] = f.geometry.coordinates; const [x, y] = L.toXY(lat, lon);
    if (top.some((t) => Math.hypot(t._x - x, t._y - y) < 25)) continue;
    top.push(Object.assign({ _x: x, _y: y }, f));
    if (top.length === 15) break;
  }
  const pathName = (p) => (!p || p === 'off-network' ? '<span class="muted">Unnamed path</span>' : esc(p));
  const rows = top.map((f, i) => {
    const p = f.properties; const [lon, lat] = f.geometry.coordinates;
    const sz = p.severity === 'high' ? 14 : p.severity === 'medium' ? 12 : 10;
    return `<tr>
      <td class="dt-n">${i + 1}</td>
      <td>${pathName(p.path)}</td>
      <td><span class="dt-sev dt-sev-${esc(p.severity)}">${warnIcon(sz)}<span class="dt-sev-t">${esc(p.severity)}</span></span></td>
      <td class="dt-hm">${esc(p.level || L.level(p.lux_median))}</td>
      <td class="dt-num">${L.fmtLux(p.lux_median)}</td>
      <td class="dt-num">${p.length_m != null ? `${Math.round(p.length_m)} m` : '—'}</td>
      <td class="dt-coord muted">${lat.toFixed(5)}, ${lon.toFixed(5)}</td>
      <td class="dt-go"><a href="#map?lat=${lat}&lon=${lon}" data-lat="${lat}" data-lon="${lon}" aria-label="View warning ${i + 1} on the map">View</a></td>
    </tr>`;
  }).join('');
  return `
  <section class="dt-section" aria-labelledby="dt-h-warn">
    <h2 id="dt-h-warn">Darkest stretches</h2>
    <p class="dt-lede">The 15 worst of ${nf((w.features || []).length)} low-light warnings — highest severity first, then longest, then darkest; one per spot (at least 25 m apart).</p>
    <div class="dt-table-wrap"><table class="dt-table">
      <thead><tr><th scope="col">#</th><th scope="col">Path</th><th scope="col">Severity</th><th scope="col" class="dt-hm">Level</th><th scope="col" class="dt-num">Lux</th><th scope="col" class="dt-num">Length</th><th scope="col" class="dt-coord">Location</th><th scope="col"><span class="dt-rp-sr">Map</span></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No warnings.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

function lampsOutHTML(o) {
  const top = (o.features || []).filter((f) => f.geometry?.coordinates).slice()
    .sort((a, b) => (b.properties.dark_snapshots_facing ?? 0) - (a.properties.dark_snapshots_facing ?? 0)
      || (b.properties.sightings ?? 0) - (a.properties.sightings ?? 0))
    .slice(0, 15);
  const rows = top.map((f, i) => {
    const p = f.properties; const [lon, lat] = f.geometry.coordinates;
    return `<tr>
      <td class="dt-n">${i + 1}</td>
      <td>${esc(p.kind ? (p.kind[0].toUpperCase() + p.kind.slice(1)).replace(/_/g, ' ') : 'Fixture')}</td>
      <td class="dt-num">${nf(p.dark_snapshots_facing)}</td>
      <td class="dt-num">${nf(p.sightings)}</td>
      <td class="dt-num">${p.conf != null ? pct(p.conf) : '—'}</td>
      <td class="dt-coord muted">${lat.toFixed(5)}, ${lon.toFixed(5)}</td>
      <td class="dt-go"><a href="#map?lat=${lat}&lon=${lon}" data-lat="${lat}" data-lon="${lon}" aria-label="View fixture ${i + 1} on the map">View</a></td>
    </tr>`;
  }).join('');
  return `
  <section class="dt-section" aria-labelledby="dt-h-out">
    <h2 id="dt-h-out">Lamps to check</h2>
    <p class="dt-lede">${nf((o.features || []).length)} fixtures were seen in the regular photos but stayed dark in the short-exposure snapshots taken while facing them. These have the most dark snapshots.</p>
    <div class="dt-table-wrap"><table class="dt-table">
      <thead><tr><th scope="col">#</th><th scope="col">Fixture</th><th scope="col" class="dt-num">Dark snapshots facing</th><th scope="col" class="dt-num">Sightings</th><th scope="col" class="dt-num">Confidence out</th><th scope="col" class="dt-coord">Location</th><th scope="col"><span class="dt-rp-sr">Map</span></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">None flagged.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

function colourHTML(lamps) {
  const f = (lamps.features || []).filter((x) => x.properties);
  const groups = LIGHT_TYPES.map(([key, label, fallback]) => {
    const g = f.filter((x) => x.properties.light_type === key).sort((a, b) => (a.properties.cct_k ?? 0) - (b.properties.cct_k ?? 0));
    const ccts = g.map((x) => x.properties.cct_k).filter((v) => v != null);
    const med = median(ccts);
    return { key, label, n: g.length, med, dots: g.map((x) => cctRGB(x.properties.cct_k ?? fallback)), swatch: cctRGB(med ?? fallback) };
  });
  const total = f.length || 1;
  return `
  <section class="dt-section" aria-labelledby="dt-h-col">
    <h2 id="dt-h-col">Streetlight colour</h2>
    <p class="dt-lede">Every located lamp, one dot each, tinted to its measured colour temperature — the only colour on this page, because it is the lamps' own.</p>
    <div class="dt-cct">
      ${groups.map((g) => `<div class="dt-cct-row${g.n ? '' : ' empty'}">
        <div class="dt-cct-h"><span class="dt-cct-sw" style="background:${g.swatch}"></span>${g.label}
          <span class="label">${nf(g.n)} · ${pct(g.n / total)}${g.med ? ` · median ${nf(Math.round(g.med / 100) * 100)} K` : ''}</span></div>
        <div class="dt-dots" role="img" aria-label="${g.label}: ${g.n} lamps">${g.dots.map((c) => `<i style="background:${c}"></i>`).join('') || '<span class="label">None found</span>'}</div>
      </div>`).join('')}
    </div>
  </section>`;
}

function downloadsHTML() {
  return `
  <section class="dt-section" aria-labelledby="dt-h-dl">
    <h2 id="dt-h-dl">Download the dataset</h2>
    <p class="dt-lede">Open data: GeoJSON in WGS 84, CSV with a header row. Times are unix seconds (UTC).</p>
    <ul class="dt-files">
      ${FILES.map(([name, desc]) => `<li>
        <a href="data/${name}" download="${name}" class="dt-file">${name}</a>
        <span class="dt-file-d">${desc}</span>
        <span class="dt-file-s label" data-size="${name}">…</span>
      </li>`).join('')}
    </ul>
    <p class="dt-atlas">Also in MongoDB Atlas: database <code>lux_survey</code> (walks, readings, photos, detections) with 2dsphere indexes.</p>
  </section>`;
}

function dictHTML() {
  return `
  <section class="dt-section" aria-labelledby="dt-h-dict">
    <h2 id="dt-h-dict">Data dictionary</h2>
    <p class="dt-lede">Units: lux · metres · degrees from true north · unix seconds (UTC) · Kelvin. Positions are WGS 84; local x / y are metres east / north of 30.615 N, 96.340 W.</p>
    <div class="dt-dict">
      ${Object.entries(DICT).map(([file, fields]) => `<details>
        <summary><span class="dt-dict-f">${file}</span><span class="label">${fields.length} field${fields.length > 1 ? 's' : ''}</span></summary>
        <table class="dt-table dt-dict-t">
          <thead><tr><th scope="col">Field</th><th scope="col">Unit</th><th scope="col">Meaning</th></tr></thead>
          <tbody>${fields.map(([k, u, d]) => `<tr><td><code>${esc(k)}</code></td><td class="muted">${esc(u)}</td><td>${esc(d)}</td></tr>`).join('')}</tbody>
        </table>
      </details>`).join('')}
    </div>
  </section>`;
}

function methodHTML() {
  return `
  <section class="dt-section dt-method" aria-labelledby="dt-h-m">
    <h2 id="dt-h-m">Method</h2>
    <div class="dt-cols">
      <p><strong>Walking.</strong> Four walkers covered the main campus on foot after dark, each carrying an iPhone running a custom recording app.</p>
      <p><strong>Measuring light.</strong> The front camera, under a diffuser, measured light about 15 times a second. Illuminance comes from the exposure settings and image brightness: lux = K·N² / (t·ISO) · (Y / 0.18), with K = 250.</p>
      <p><strong>Photographing.</strong> The back camera took a photo every second, plus a very short exposure every 5 seconds in which only light sources remain visible.</p>
      <p><strong>Privacy.</strong> Faces and licence plates were blurred on a GPU (YOLOv8 plus a face model) before anything was stored.</p>
      <p><strong>Finding streetlights.</strong> Lamps were triangulated by intersecting rays toward each light source from at least two positions, kept only if 2.5–15 m above the ground, then verified against the light readings beneath them.</p>
      <p><strong>Removing car lights.</strong> Readings within ±2 s of a detected vehicle, and short isolated spikes, were dropped so headlights do not count as street lighting.</p>
      <p><strong>Paths.</strong> Footpaths come from OpenStreetMap, cut into 5 m stretches; readings off any mapped path form 5 m cells. Each stretch is compared with a ~5 lux walkway guideline.</p>
    </div>
    <h3>Limitations</h3>
    <p class="dt-limits">A phone camera is not a calibrated lux meter: absolute values may be off by a constant factor, though comparisons between places hold. GPS is accurate to roughly 5–15 m, so a reading can land on a neighbouring path. Night photos are noisy, which limits object and lamp detection — some lamps are missed, and a “possibly out” fixture should be checked in person.</p>
  </section>`;
}

async function fillSizes() {
  await Promise.all(FILES.map(async ([name]) => {
    const el = root.querySelector(`[data-size="${name}"]`);
    if (!el) return;
    let size = null;
    try {
      const r = await fetch(`data/${name}`, { method: 'HEAD' });
      if (r.ok) { const h = r.headers.get('content-length'); if (h) size = +h; } else { el.textContent = 'not available'; return; }
    } catch { /* ignore */ }
    let note = '';
    if (name.endsWith('.geojson') && (size == null || size < 200)) {
      try { const d = await L.load(name); const n = (d.features || []).length; if (!n) note = ' · empty for now'; } catch { /* ignore */ }
    }
    el.textContent = `${fmtBytes(size)}${note}`;
  }));
}

export default {
  async mount(el, LUX) {
    L = LUX; root = el; css();
    const [summary, paths, warnings, lampsOut, lamps, activity, photos, rows] = await Promise.all([
      L.load('summary.json'),
      L.load('path_lighting.geojson').catch(() => ({ features: [] })),
      L.load('warnings.geojson').catch(() => ({ features: [] })),
      L.load('lamps_possibly_out.geojson').catch(() => ({ features: [] })),
      L.load('lamps.geojson').catch(() => ({ features: [] })),
      L.load('activity.geojson').catch(() => ({ features: [] })),
      L.load('photos_index.csv').catch(() => []),
      L.load('readings_1hz.csv').catch(() => []),
    ]);
    el.innerHTML = `<div class="dt-page">
      ${heroHTML(paths)}
      ${bigHTML(summary, photos.length, activity, new Set(rows.map((r) => r.walker).filter((w) => w != null)).size)}
      ${levelsHTML(summary)}
      ${nightHTML()}
      ${warningsHTML(warnings)}
      ${lampsOutHTML(lampsOut)}
      ${colourHTML(lamps)}
      ${downloadsHTML()}
      ${dictHTML()}
      ${methodHTML()}
      <footer class="dt-foot label">Generated ${summary.generated ? esc(new Date(summary.generated).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })) + ' (Central)' : ''} · Night-Light Survey, TAMU Datathon 2026</footer>
    </div>`;
    drawNight(el.querySelector('.dt-chart'), rows);
    el.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-lat]');
      if (!a) return;
      e.preventDefault();
      L.go('map', { lat: a.dataset.lat, lon: a.dataset.lon });
    });
    fillSizes();
  },
  show() {},
  hide() {},
};
