// /api/files — uploaded walk files (Netlify Blobs "files").
// Auth: x-live-key (phones, pull.mjs) or x-control-pass (Survey Control); ?k= / ?pass= also accepted so a photo link opens in a tab.
//   GET ?prefix=w1/                 -> { keys:[...] }                         (pull.mjs, unchanged)
//   GET ?get=w1/<session>/...       -> the file (image/jpeg for .jpg, json, csv, else octet-stream)
//   GET ?walker=N[&since=<unix s>]  -> { ok, walker, files:[{key,session,path,kind,size,t,url}] } newest first
//        kind: photo | light | csv | json | other; url = ?get= link carrying the control pass (photos/lights only)
import { getStore } from "@netlify/blobs";
import { CORS, PASS, LIVE_KEY } from "../lib/db.mjs";
import { parseLogKey, fileInfo } from "../lib/filelog.mjs";

const MAX_FILES = 3000, META_MAX = 400;
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", json: "application/json", csv: "text/csv" };
const j = (o, s = 200) => Response.json(o, { status: s, headers: CORS });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url), q = url.searchParams;
  const live = (req.headers.get("x-live-key") || q.get("k")) === LIVE_KEY;
  const ctl = (req.headers.get("x-control-pass") || q.get("pass")) === PASS;
  if (!live && !ctl) return new Response("bad key", { status: 401, headers: CORS });
  const store = getStore("files");

  const get = q.get("get");
  if (get) {
    const data = await store.get(get, { type: "arrayBuffer" });
    if (!data) return new Response("not found", { status: 404, headers: CORS });
    const ext = (/\.([a-z0-9]+)(@|$)/i.exec(get)?.[1] || "").toLowerCase();
    return new Response(data, { headers: { ...CORS, "content-type": TYPES[ext] || "application/octet-stream" } });
  }

  const w = q.get("walker");
  if (w != null) {
    const n = +w;
    if (!(n >= 1 && n <= 99)) return j({ ok: false, error: "bad walker" }, 400);
    const since = Number(q.get("since")) || 0;
    let files = [];
    const { blobs } = await getStore("filelog").list({ prefix: `w${n}/` });
    for (const b of blobs) { const f = parseLogKey(b.key); if (f && f.t > since) files.push(f); }
    if (!blobs.length) {
      // uploads from before the feed log existed: read the metadata saved with each file
      const { blobs: fb } = await store.list({ prefix: `w${n}/` });
      const keys = fb.map((b) => b.key).slice(-META_MAX);
      for (let i = 0; i < keys.length; i += 25) {
        const got = await Promise.all(keys.slice(i, i + 25).map((k) => store.getMetadata(k).catch(() => null)));
        got.forEach((m, k) => {
          const t = Number(m?.metadata?.t) || null;
          if (t != null && t > since) files.push(fileInfo(keys[i + k], t, Number(m.metadata.size) || null));
        });
      }
    }
    files.sort((a, b) => b.t - a.t);
    files = files.slice(0, MAX_FILES);
    const base = `${url.origin}/api/files?pass=${encodeURIComponent(PASS)}&get=`;
    for (const f of files) f.url = f.kind === "photo" || f.kind === "light" ? base + encodeURIComponent(f.key) : null;
    return j({ ok: true, walker: n, files });
  }

  const { blobs } = await store.list({ prefix: q.get("prefix") || "" });
  return Response.json({ keys: blobs.map((b) => b.key) }, { headers: CORS });
};
export const config = { path: "/api/files" };
