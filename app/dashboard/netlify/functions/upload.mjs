// POST /api/upload?key=w1/<session>/<path> — one file (or CSV piece) from a phone at a checkpoint.
// Also logs the upload (time, size, path) in the "filelog" store for the Survey Control live feed.
import { getStore } from "@netlify/blobs";
import { logKey } from "../lib/filelog.mjs";
const KEY = process.env.LIVE_KEY || "tamu-lux-2026";

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (req.headers.get("x-live-key") !== KEY) return new Response("bad key", { status: 401 });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!/^w[1-4]\/[A-Za-z0-9_\-.\/@]+$/.test(key) || key.includes("..")) return new Response("bad key name", { status: 400 });
  const body = await req.arrayBuffer();
  if (!body.byteLength) return new Response("empty", { status: 400 });
  const t = Date.now() / 1000;
  await getStore("files").set(key, body, { metadata: { size: body.byteLength, t } });
  try { await getStore("filelog").set(logKey(key, t, body.byteLength), "1"); } catch { /* feed only; the file itself is saved */ }
  return Response.json({ ok: true, key, size: body.byteLength });
};
export const config = { path: "/api/upload" };
