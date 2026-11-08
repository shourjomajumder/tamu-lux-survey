// Upload feed index: one empty blob per upload in the "filelog" store, all info in the key:
//   w1/<t_ms 13 digits>_<size>_<encodeURIComponent(path after "w1/")>
export function logKey(key, t, size) {
  const i = key.indexOf("/");
  return `${key.slice(0, i)}/${String(Math.round(t * 1000)).padStart(13, "0")}_${size}_${encodeURIComponent(key.slice(i + 1))}`;
}
export function parseLogKey(lk) {
  const m = /^(w\d+)\/(\d{13})_(\d+)_(.+)$/.exec(lk);
  if (!m) return null;
  let rest; try { rest = decodeURIComponent(m[4]); } catch { return null; }
  return fileInfo(`${m[1]}/${rest}`, +m[2] / 1000, +m[3]);
}
// w1/<session>/photos/x.jpg -> {key, walker, session, path, kind, t, size}
export function fileInfo(key, t, size) {
  const parts = key.split("/");
  const walker = +String(parts[0]).replace(/^w/, "");
  const session = parts.length > 2 ? parts[1] : "";
  const path = parts.slice(parts.length > 2 ? 2 : 1).join("/");
  const kind = /^photos\//.test(path) ? "photo" : /^lights\//.test(path) ? "light"
    : /^csv\//.test(path) || /\.csv(@|$)/.test(path) ? "csv" : /\.json$/.test(path) ? "json" : "other";
  return { key, walker, session, path, kind, t: t ?? null, size: size ?? null };
}
