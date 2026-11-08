// Download everything the phones uploaded into ./downloads, then stitch the CSV pieces.
// Usage (in the LuxDashboard folder):  node pull.mjs            (or: node pull.mjs w1)
import fs from "node:fs";
import path from "node:path";

const SITE = process.env.SITE || "https://tamu-lux-survey.netlify.app";
const KEY = process.env.LIVE_KEY || "tamu-lux-2026";
const prefix = process.argv[2] ? process.argv[2].replace(/\/?$/, "/") : "";
const OUT = path.resolve("downloads");

const list = await fetch(`${SITE}/api/files?prefix=${encodeURIComponent(prefix)}`, { headers: { "x-live-key": KEY } });
if (!list.ok) { console.error("List failed:", list.status, await list.text()); process.exit(1); }
const { keys } = await list.json();
console.log(`${keys.length} files on the server`);

let got = 0, skipped = 0;
const todo = keys.filter((k) => {
  const p = path.join(OUT, k);
  if (fs.existsSync(p) && !k.endsWith(".json")) { skipped++; return false; }
  return true;
});
async function worker() {
  while (todo.length) {
    const k = todo.shift();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${SITE}/api/files?get=${encodeURIComponent(k)}`, { headers: { "x-live-key": KEY } });
        if (!r.ok) throw new Error(r.status);
        const p = path.join(OUT, k);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
        got++;
        if (got % 100 === 0) console.log(`  ${got} downloaded…`);
        break;
      } catch (e) { if (attempt === 3) console.error("  failed:", k, e.message); }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`Downloaded ${got}, already had ${skipped}.`);

// Stitch csv/<name>.csv@<offset> pieces into <session>/<name>.csv
for (const w of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
  const wdir = path.join(OUT, w);
  if (!fs.statSync(wdir).isDirectory()) continue;
  for (const s of fs.readdirSync(wdir)) {
    const cdir = path.join(wdir, s, "csv");
    if (!fs.existsSync(cdir)) continue;
    const groups = {};
    for (const f of fs.readdirSync(cdir)) {
      const m = f.match(/^(.+\.csv)@(\d+)$/);
      if (m) (groups[m[1]] ||= []).push([Number(m[2]), f]);
    }
    for (const [name, parts] of Object.entries(groups)) {
      parts.sort((a, b) => a[0] - b[0]);
      let expected = 0, gap = false;
      const bufs = parts.map(([off, f]) => {
        if (off !== expected) gap = true;
        const b = fs.readFileSync(path.join(cdir, f));
        expected = off + b.length;
        return b;
      });
      fs.writeFileSync(path.join(wdir, s, name), Buffer.concat(bufs));
      if (gap) console.warn(`  ${w}/${s}/${name}: a piece is missing (still uploading?)`);
    }
  }
}
console.log(`Done. Data is in ${OUT}`);
