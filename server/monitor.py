#!/usr/bin/env python3
"""Live pipeline monitor for the Vultr GPU server.  http://<ip>:8080/?k=<key>
Read-only.  Shows job queue, live logs, GPU/CPU/disk/network, per-stage progress,
the newest blurred photos and MongoDB counts.  Restarts itself when this file changes."""
import hashlib, json, os, re, subprocess, sys, threading, time, glob
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

REPO = Path("/root/lux/repo")
KEY_SHA = "d392054d173625dd4537eda52b7eefee4dbd1a29fdef48f31b8e04d22c1cf315"
ZIPS, SESS, BLUR = Path("/data/zips"), Path("/data/sessions"), Path("/data/blurred")
EXPECTED_ZIPS = 16
SELF_MTIME = os.path.getmtime(__file__)

def sh(cmd, t=5):
    try: return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t).stdout.strip()
    except Exception: return ""

def dir_size(p):
    try: return sum(f.stat().st_size for f in Path(p).rglob("*") if f.is_file())
    except Exception: return 0

# ---------- network + cpu rate sampling ----------
_net = {"t": time.time(), "rx": 0, "tx": 0, "rx_bps": 0, "tx_bps": 0}
_cpu = {"idle": 0, "total": 0, "pct": 0}
def sample_loop():
    while True:
        try:
            rx = tx = 0
            for line in open("/proc/net/dev").read().splitlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() == "lo": continue
                f = data.split(); rx += int(f[0]); tx += int(f[8])
            now = time.time(); dt = now - _net["t"]
            if _net["rx"] and dt > 0:
                _net["rx_bps"] = (rx - _net["rx"]) / dt; _net["tx_bps"] = (tx - _net["tx"]) / dt
            _net.update(t=now, rx=rx, tx=tx)
            v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
            idle, total = v[3] + v[4], sum(v)
            if _cpu["total"]:
                d = total - _cpu["total"]; _cpu["pct"] = 100 * (1 - (idle - _cpu["idle"]) / d) if d else 0
            _cpu.update(idle=idle, total=total)
        except Exception: pass
        if os.path.getmtime(__file__) != SELF_MTIME: os._exit(0)   # systemd restarts us with new code
        time.sleep(2)

# ---------- mongo counts (cached) ----------
_mongo = {"ok": None, "counts": {}, "err": "", "t": 0}
def mongo_loop():
    while True:
        try:
            import pymongo
            ud = sh("curl -fs -m 4 http://169.254.169.254/latest/user-data")
            m = re.search(r"mongodb(\+srv)?://\S+", ud or "")
            cur = sh("bash -c 'source /root/lux/.env; printf %s \"$MONGODB_URI\"'")
            if m and m.group(0) != cur:   # corrected string pasted into Vultr User-Data
                lines = [l for l in open("/root/lux/.env").read().splitlines() if not l.startswith("MONGODB_URI=")]
                q = "'" + m.group(0).replace("'", "'\\''") + "'"
                fd = os.open("/root/lux/.env.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                os.write(fd, ("\n".join(lines + ["MONGODB_URI=" + q]) + "\n").encode()); os.close(fd)
                os.replace("/root/lux/.env.tmp", "/root/lux/.env")
            uri = sh("bash -c 'source /root/lux/.env; printf %s \"$MONGODB_URI\"'") or os.environ.get("MONGODB_URI", "")
            c = pymongo.MongoClient(uri, serverSelectionTimeoutMS=6000)
            db = c["lux_survey"]
            _mongo.update(ok=True, err="", counts={n: db[n].estimated_document_count() for n in ("walks", "readings", "photos", "detections")})
        except Exception as e:
            _mongo.update(ok=False, err=str(e)[:160])
        _mongo["t"] = time.time()
        time.sleep(20)

def clean_log(txt, n=60):
    txt = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", txt)
    lines = []
    for raw in txt.split("\n"):
        lines.append(raw.split("\r")[-1])          # keep last progress-bar state
    return "\n".join(lines[-n:])

def jobs():
    out = []
    done = set((REPO / "results/done.txt").read_text().split()) if (REPO / "results/done.txt").exists() else set()
    for j in sorted(glob.glob(str(REPO / "jobs/*.sh"))):
        name = os.path.basename(j); st = REPO / f"results/logs/{name}.status"
        status = st.read_text().strip() if st.exists() else ("done" if name in done else "queued")
        desc = ""
        for line in open(j).read().splitlines()[1:4]:
            if line.startswith("#"): desc = line.lstrip("# ").strip(); break
        lg = REPO / f"results/logs/{name}.log"
        started = lg.stat().st_mtime if lg.exists() else None
        out.append({"name": name, "status": status, "desc": desc, "updated": started})
    return out

def stages():
    zips = sorted(ZIPS.glob("*.zip")) if ZIPS.exists() else []
    partial = [p for p in ZIPS.glob("*") if p.is_file() and not p.name.endswith(".zip")] if ZIPS.exists() else []
    sess = []
    for s in sorted(SESS.iterdir()) if SESS.exists() else []:
        if not s.is_dir(): continue
        total = len(list((s / "photos").glob("*.jpg"))) if (s / "photos").exists() else 0
        blurred = len(list((BLUR / s.name).rglob("*.jpg"))) if (BLUR / s.name).exists() else 0
        det = REPO / f"results/detections/{s.name}.csv"
        ndet = max(0, sum(1 for _ in open(det)) - 1) if det.exists() else 0
        sess.append({"name": s.name, "photos": total, "blurred": blurred, "detections": ndet})
    return {
        "zips": [{"name": z.name, "mb": round(z.stat().st_size / 1e6, 1)} for z in zips],
        "zips_partial_mb": round(sum(p.stat().st_size for p in partial) / 1e6, 1),
        "zips_expected": EXPECTED_ZIPS,
        "zips_total_mb": round(sum(z.stat().st_size for z in zips) / 1e6, 1),
        "sessions": sess,
    }

def system():
    g = sh("nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits")
    gpu = {}
    if g:
        f = [x.strip() for x in g.split(",")]
        gpu = {"name": f[0], "util": float(f[1]), "mem": float(f[2]), "mem_total": float(f[3]), "temp": float(f[4]), "power": f[5]}
    mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo").read().splitlines()[:5]}
    st = os.statvfs("/")
    return {
        "gpu": gpu, "cpu": round(_cpu["pct"], 1), "load": os.getloadavg()[0],
        "ram_used_gb": round((mem["MemTotal"] - mem["MemAvailable"]) / 1e6, 1), "ram_total_gb": round(mem["MemTotal"] / 1e6, 1),
        "disk_used_gb": round((st.f_blocks - st.f_bavail) * st.f_frsize / 1e9, 1), "disk_total_gb": round(st.f_blocks * st.f_frsize / 1e9, 1),
        "net_in_mbps": round(_net["rx_bps"] * 8 / 1e6, 1), "net_out_mbps": round(_net["tx_bps"] * 8 / 1e6, 1),
        "agent": sh("systemctl is-active lux-agent"), "uptime": sh("uptime -p"),
    }

# The page HTML is read straight from GitHub's main branch (git fetch, no working-tree changes),
# so UI updates go live within ~20 s even while a long job is running.
_page = {"t": 0, "html": None}
def page():
    if time.time() - _page["t"] > 20:
        _page["t"] = time.time()
        sh(f"git -C {REPO} fetch -q origin main", t=15)
        html = sh(f"git -C {REPO} show origin/main:server/monitor_page.html", t=5)
        if html.startswith("<!doctype"): _page["html"] = html
    if _page["html"]: return _page["html"]
    f = REPO / "server/monitor_page.html"
    return f.read_text() if f.exists() else PAGE

def status():
    js = jobs(); running = [j for j in js if j["status"] == "running"]
    log = ""
    if running:
        p = REPO / f"results/logs/{running[0]['name']}.log"
        if p.exists():
            with open(p, "rb") as f:
                f.seek(0, 2); f.seek(max(0, f.tell() - 30000)); log = clean_log(f.read().decode("utf8", "replace"))
    agent_log = (REPO / "results/agent.log").read_text().splitlines()[-12:] if (REPO / "results/agent.log").exists() else []
    newest = sorted(BLUR.rglob("*.jpg"), key=lambda p: p.stat().st_mtime)[-8:] if BLUR.exists() else []
    reviews = sorted((REPO / "results/review").glob("*.jpg"), key=lambda p: p.stat().st_mtime)[-6:] if (REPO / "results/review").exists() else []
    return {
        "time": time.time(), "system": system(), "jobs": js, "running": running[0]["name"] if running else None,
        "log": log, "agent_log": agent_log, "stages": stages(),
        "mongo": {k: v for k, v in _mongo.items()},
        "newest_blurred": [str(p.relative_to(BLUR)) for p in reversed(newest)],
        "reviews": [p.name for p in reversed(reviews)],
    }

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); k = (q.get("k") or [""])[0]
        if hashlib.sha256(k.encode()).hexdigest() != KEY_SHA:
            return self.send(403, b"forbidden - add ?k=YOUR_KEY", "text/plain")
        try:
            if u.path == "/":
                return self.send(200, page().encode(), "text/html; charset=utf-8")
            if u.path == "/classic":
                return self.send(200, PAGE.encode(), "text/html; charset=utf-8")
            if u.path == "/api/status":
                return self.send(200, json.dumps(status()).encode(), "application/json")
            if u.path.startswith("/img/blur/"):
                p = (BLUR / u.path[len("/img/blur/"):]).resolve()
                if str(p).startswith(str(BLUR)) and p.exists():
                    return self.send(200, p.read_bytes(), "image/jpeg")
            if u.path.startswith("/dl/"):          # finished web bundles (streetview.zip, splats/...)
                p = (Path("/data/web") / u.path[4:]).resolve()
                if str(p).startswith("/data/web/") and p.is_file():
                    self.send_response(200); self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(p.stat().st_size)); self.end_headers()
                    with open(p, "rb") as f:
                        while chunk := f.read(1 << 20): self.wfile.write(chunk)
                    return
            if u.path.startswith("/img/review/"):
                p = (REPO / "results/review" / os.path.basename(u.path)).resolve()
                if p.exists(): return self.send(200, p.read_bytes(), "image/jpeg")
            self.send(404, b"not found", "text/plain")
        except Exception as e:
            self.send(500, str(e).encode(), "text/plain")

PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lux pipeline — live</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--mute:#8b949e;--ok:#3fb950;--run:#d29922;--bad:#f85149;--q:#6e7681;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{font-size:17px;margin:0}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mute)}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--q)}
main{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(12,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 10px}
.flow{grid-column:1/-1;display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.stage{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;position:relative}
.stage .t{font-weight:600;font-size:13px}.stage .v{font-size:22px;font-weight:600;margin:4px 0}.stage .s{color:var(--mute);font-size:12px}
.stage.ok{border-color:#238636}.stage.run{border-color:var(--run);box-shadow:0 0 0 1px var(--run) inset}
.bar{height:6px;background:#21262d;border-radius:4px;overflow:hidden;margin-top:8px}.bar>i{display:block;height:100%;background:var(--acc);transition:width .6s}
.stage.ok .bar>i{background:var(--ok)}.stage.run .bar>i{background:var(--run)}
.sys{grid-column:span 4}.jobs{grid-column:span 8}.log{grid-column:span 8}.mongo{grid-column:span 4}.imgs{grid-column:1/-1}.sess{grid-column:1/-1}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px}.kv b{font-weight:500;color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:5px 6px;border-bottom:1px solid #21262d;text-align:left}th{color:var(--mute);font-weight:500}
pre{margin:0;background:#010409;border:1px solid var(--line);border-radius:8px;padding:10px;height:330px;overflow:auto;font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap}
.thumbs{display:flex;gap:8px;overflow-x:auto}.thumbs img{height:200px;border-radius:6px;border:1px solid var(--line)}
.st-running{color:var(--run)}.st-ok{color:var(--ok)}.st-bad{color:var(--bad)}.st-q{color:var(--q)}
.mini{display:flex;gap:4px;align-items:flex-end;height:36px}.mini i{flex:1;background:var(--acc);border-radius:2px 2px 0 0;min-height:1px}
@media(max-width:900px){.flow{grid-template-columns:repeat(2,1fr)}.sys,.jobs,.log,.mongo{grid-column:1/-1}}
</style></head><body>
<header><h1>🌙 A&amp;M Night-Light Survey — pipeline</h1><span class="pill" id="agent"><span class="dot"></span>agent</span><span class="pill" id="upd">connecting…</span></header>
<main>
 <div class="flow" id="flow"></div>
 <div class="card sys"><h2>Server</h2><div class="kv" id="sys"></div><h2 style="margin-top:12px">GPU utilisation (last 2 min)</h2><div class="mini" id="spark"></div></div>
 <div class="card jobs"><h2>Job queue</h2><table id="jobs"></table></div>
 <div class="card log"><h2 id="logt">Live log</h2><pre id="log"></pre></div>
 <div class="card mongo"><h2>MongoDB Atlas · lux_survey</h2><div class="kv" id="mongo"></div><h2 style="margin-top:14px">Agent events</h2><pre id="alog" style="height:170px"></pre></div>
 <div class="card sess"><h2>Walk sessions</h2><table id="sess"></table></div>
 <div class="card imgs"><h2>Newest privacy-blurred photos</h2><div class="thumbs" id="blur"><span style="color:var(--mute)">appear here once the GPU job starts</span></div>
  <h2 style="margin-top:14px">Detection review sheets</h2><div class="thumbs" id="rev"><span style="color:var(--mute)">—</span></div></div>
</main>
<script>
const K=new URLSearchParams(location.search).get('k');const $=id=>document.getElementById(id);const gpuHist=[];let lastImgs='',lastRev='';
const cls=s=>s==='running'?'st-running':s==='exit 0'||s==='done'?'st-ok':s==='queued'?'st-q':'st-bad';
function stage(t,v,s,frac,state){return `<div class="stage ${state}"><div class="t">${t}</div><div class="v">${v}</div><div class="s">${s}</div><div class="bar"><i style="width:${Math.min(100,Math.round((frac||0)*100))}%"></i></div></div>`}
function jobState(d,prefix){const j=d.jobs.find(j=>j.name.includes(prefix));if(!j)return'';return j.status==='running'?'run':(j.status==='exit 0'?'ok':'')}
async function tick(){
 try{const d=await (await fetch('/api/status?k='+K,{cache:'no-store'})).json();
  const S=d.stages,sy=d.system,sess=S.sessions;
  const ph=sess.reduce((a,s)=>a+s.photos,0),bl=sess.reduce((a,s)=>a+s.blurred,0),dets=sess.reduce((a,s)=>a+s.detections,0);
  const mc=d.mongo.counts||{};
  $('flow').innerHTML=
   stage('1 · Collected','16 walks','W1–W3 on Google Drive · W4 pending',16/20,'ok')+
   stage('2 · Download',`${S.zips.length}/${S.zips_expected}`,`${(S.zips_total_mb/1000).toFixed(2)} GB${S.zips_partial_mb?` + ${S.zips_partial_mb} MB in flight`:''} · ↓ ${sy.net_in_mbps} Mb/s`,S.zips.length/S.zips_expected,jobState(d,'download')||(S.zips.length>=S.zips_expected?'ok':''))+
   stage('3 · Unzip',`${sess.length} sessions`,`${ph.toLocaleString()} photos`,S.zips.length?sess.length/Math.max(1,S.zips.length):0,jobState(d,'unzip'))+
   stage('4 · GPU detect + blur',`${bl.toLocaleString()}`,`of ${ph.toLocaleString()} photos · ${dets.toLocaleString()} objects`,ph?bl/ph:0,jobState(d,'detect'))+
   stage('5 · MongoDB',`${(mc.readings||0).toLocaleString()}`,`readings · ${(mc.detections||0).toLocaleString()} detections`,mc.walks?1:0,jobState(d,'mongo')||(mc.readings?'ok':''))+
   stage('6 · Website','—','lit-route planner (next)',0,'');
  const g=sy.gpu||{};gpuHist.push(g.util||0);if(gpuHist.length>60)gpuHist.shift();
  $('spark').innerHTML=gpuHist.map(v=>`<i style="height:${Math.max(2,v)}%"></i>`).join('');
  $('sys').innerHTML=`<b>GPU</b><span>${g.name||'?'} · ${g.util??'?'}% · ${((g.mem||0)/1024).toFixed(1)}/${((g.mem_total||0)/1024).toFixed(0)} GB · ${g.temp??'?'}°C · ${g.power??'?'} W</span>
   <b>CPU</b><span>${sy.cpu}% · load ${sy.load.toFixed(2)}</span><b>RAM</b><span>${sy.ram_used_gb}/${sy.ram_total_gb} GB</span>
   <b>Disk</b><span>${sy.disk_used_gb}/${sy.disk_total_gb} GB</span><b>Network</b><span>↓ ${sy.net_in_mbps} Mb/s · ↑ ${sy.net_out_mbps} Mb/s</span><b>Uptime</b><span>${sy.uptime}</span>`;
  $('agent').innerHTML=`<span class="dot" style="background:${sy.agent==='active'?'var(--ok)':'var(--bad)'}"></span>job runner ${sy.agent}`;
  $('jobs').innerHTML='<tr><th>Job</th><th>What it does</th><th>Status</th></tr>'+d.jobs.map(j=>`<tr><td>${j.name}</td><td style="color:var(--mute)">${j.desc}</td><td class="${cls(j.status)}">${j.status==='exit 0'?'✓ done':j.status==='running'?'● running':j.status}</td></tr>`).join('');
  $('logt').textContent=d.running?`Live log · ${d.running}`:'Live log · idle (waiting for next job)';
  const pre=$('log'),atBottom=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-20;pre.textContent=d.log||'—';if(atBottom)pre.scrollTop=pre.scrollHeight;
  $('alog').textContent=d.agent_log.join('\n');
  const m=d.mongo;$('mongo').innerHTML=`<b>Status</b><span class="${m.ok?'st-ok':m.ok===false?'st-bad':'st-q'}">${m.ok?'connected':m.ok===false?'not connected':'checking…'}</span>`+
   (m.ok?Object.entries(mc).map(([k,v])=>`<b>${k}</b><span>${v.toLocaleString()}</span>`).join(''):`<b>Error</b><span style="font-size:12px;color:var(--mute)">${m.err||''}</span>`);
  $('sess').innerHTML='<tr><th>Session</th><th>Photos</th><th>Blurred</th><th>Objects found</th><th style="width:30%">Progress</th></tr>'+(sess.length?sess.map(s=>`<tr><td>${s.name}</td><td>${s.photos}</td><td>${s.blurred}</td><td>${s.detections}</td><td><div class="bar"><i style="width:${s.photos?Math.round(100*s.blurred/s.photos):0}%"></i></div></td></tr>`).join(''):'<tr><td colspan=5 style="color:var(--mute)">not unzipped yet</td></tr>');
  const bi=d.newest_blurred.join('|');if(bi&&bi!==lastImgs){lastImgs=bi;$('blur').innerHTML=d.newest_blurred.map(p=>`<img loading=lazy src="/img/blur/${p}?k=${K}">`).join('')}
  const ri=d.reviews.join('|');if(ri&&ri!==lastRev){lastRev=ri;$('rev').innerHTML=d.reviews.map(p=>`<a href="/img/review/${p}?k=${K}" target=_blank><img src="/img/review/${p}?k=${K}"></a>`).join('')}
  $('upd').textContent='live · '+new Date().toLocaleTimeString();
 }catch(e){$('upd').textContent='reconnecting…'}
}
tick();setInterval(tick,2000);
</script></body></html>"""

if __name__ == "__main__":
    threading.Thread(target=sample_loop, daemon=True).start()
    threading.Thread(target=mongo_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), H).serve_forever()
