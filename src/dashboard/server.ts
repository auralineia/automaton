import http from "node:http";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#07080c" />
<title>RITTY / Command Center</title>
<style>
:root{
  --bg:#07080c;--panel:rgba(15,18,26,.82);--panel2:rgba(19,23,32,.72);--line:rgba(255,255,255,.08);
  --text:#f5f7fb;--muted:#8d96a8;--cyan:#56f0d0;--violet:#9d8cff;--danger:#ff6f91;--amber:#ffc766;
  --shadow:0 20px 60px rgba(0,0,0,.28);--radius:22px;
}
*{box-sizing:border-box}html{background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}
body{margin:0;min-height:100vh;background:
radial-gradient(900px 500px at 15% -10%,rgba(86,240,208,.13),transparent 55%),
radial-gradient(800px 420px at 90% 0%,rgba(157,140,255,.14),transparent 55%),var(--bg)}
button{font:inherit;color:inherit}.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;padding:22px 16px;border-right:1px solid var(--line);background:rgba(7,8,12,.68);backdrop-filter:blur(22px)}
.brand{padding:12px 12px 22px}.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--muted);text-transform:uppercase}
.brand h1{margin:7px 0 0;font-size:26px;letter-spacing:-.04em}.brand h1 span{color:var(--cyan)}
.nav{display:grid;gap:6px}.nav a{display:flex;gap:10px;align-items:center;padding:11px 12px;border-radius:13px;color:#b8bfcc;text-decoration:none;font-size:14px}.nav a:hover{background:rgba(255,255,255,.045);color:#fff}
.side-footer{position:absolute;left:16px;right:16px;bottom:18px}.connection{padding:12px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.025)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--amber);box-shadow:0 0 18px currentColor}.dot.ok{background:var(--cyan)}.dot.bad{background:var(--danger)}
.main{padding:22px 24px 110px;max-width:1500px;width:100%;margin:auto}.topbar{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:18px}
.topbar h2{margin:0;font-size:22px;letter-spacing:-.03em}.status-line{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px}
.refresh{border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:12px;padding:9px 12px;cursor:pointer}.refresh:active{transform:scale(.98)}
.hero{display:grid;grid-template-columns:1.4fr .8fr;gap:16px;margin-bottom:16px}.hero-card,.panel{border:1px solid var(--line);background:linear-gradient(180deg,rgba(21,25,35,.88),rgba(11,13,19,.88));box-shadow:var(--shadow);border-radius:var(--radius)}
.hero-card{padding:24px;position:relative;overflow:hidden}.hero-card:after{content:"";position:absolute;inset:auto -20% -60% 45%;height:220px;background:radial-gradient(circle,rgba(86,240,208,.16),transparent 65%);pointer-events:none}
.hero h3{margin:0;font-size:38px;letter-spacing:-.055em}.hero p{color:var(--muted);margin:7px 0 18px;max-width:650px;line-height:1.5}.pillrow{display:flex;gap:8px;flex-wrap:wrap}.pill{font-size:12px;color:#cbd2dc;border:1px solid var(--line);padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.025)}.pill.live{color:#071412;background:var(--cyan);border-color:transparent;font-weight:700}
.orbit{min-height:190px;display:grid;place-items:center;position:relative}.orb{width:130px;height:130px;border-radius:50%;background:
radial-gradient(circle at 35% 32%,#fff,rgba(255,255,255,.7) 7%,rgba(86,240,208,.65) 20%,rgba(86,240,208,.12) 58%,transparent 72%);
filter:drop-shadow(0 0 35px rgba(86,240,208,.33));animation:breathe 4.8s ease-in-out infinite}.orb:before,.orb:after{content:"";position:absolute;inset:24%;border:1px solid rgba(157,140,255,.55);border-radius:48%;transform:rotate(38deg);animation:spin 11s linear infinite}.orb:after{inset:20%;transform:rotate(-52deg);border-color:rgba(86,240,208,.42);animation-direction:reverse;animation-duration:15s}@keyframes breathe{50%{transform:scale(1.08)}}@keyframes spin{to{transform:rotate(398deg)}}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.metric{padding:18px}.metric .label{font-size:12px;color:var(--muted)}.metric .value{font-size:28px;font-weight:700;letter-spacing:-.04em;margin-top:8px}.metric .sub{font-size:11px;color:#788294;margin-top:5px}
.two{display:grid;grid-template-columns:1.25fr .95fr;gap:16px;margin-bottom:16px}.panel{padding:18px}.panel-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:13px}.panel-head h4{margin:0;font-size:15px}.panel-head span{font-size:11px;color:var(--muted)}
.list{display:grid;gap:7px}.row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:11px 10px;border:1px solid rgba(255,255,255,.055);border-radius:14px;background:rgba(255,255,255,.018)}
.row .name{font-size:13px}.row .meta{font-size:11px;color:var(--muted)}.row .right{font-size:11px;color:#aab3c2}.oktxt{color:var(--cyan)}.errtxt{color:var(--danger)}.muted{color:var(--muted)}
.columns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.skill{padding:11px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.055);background:rgba(255,255,255,.02)}.skill strong{font-size:13px}.skill p{margin:4px 0 0;font-size:11px;line-height:1.4;color:var(--muted)}
.note{font-size:11px;color:var(--muted);padding:10px 2px}.footer{margin-top:16px;color:#687386;font-size:11px;text-align:center}
.mobile-nav{display:none}
@media(max-width:1000px){.hero{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,1fr)}.two,.columns{grid-template-columns:1fr}.orbit{min-height:150px}}
@media(max-width:720px){.app{display:block}.sidebar{display:none}.main{padding:14px 12px 96px}.topbar h2{font-size:18px}.hero-card{padding:19px}.hero h3{font-size:31px}.grid{gap:9px}.metric{padding:15px}.metric .value{font-size:24px}.panel{padding:14px}.mobile-nav{position:fixed;z-index:50;left:10px;right:10px;bottom:10px;display:grid;grid-template-columns:repeat(4,1fr);gap:5px;padding:7px;border:1px solid var(--line);border-radius:18px;background:rgba(11,13,19,.92);backdrop-filter:blur(22px);box-shadow:var(--shadow)}.mobile-nav a{padding:8px 4px;text-align:center;color:#8f98a8;text-decoration:none;font-size:10px}.mobile-nav a.active{color:var(--cyan)}}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="eyebrow">AUTONOMOUS RUNTIME</div><h1>RITT<span>Y</span></h1></div>
    <nav class="nav">
      <a href="#overview">Overview</a><a href="#activity">Activity</a><a href="#skills">Skills</a><a href="#system">System</a>
    </nav>
    <div class="side-footer">
      <div class="connection"><div class="eyebrow">CONNECTION</div><div style="margin-top:8px;font-size:13px"><span id="sideDot" class="dot"></span> <span id="sideStatus">Conectando…</span></div><div id="sideUpdated" class="note">Aguardando leitura</div></div>
    </div>
  </aside>
  <main class="main">
    <div class="topbar">
      <div><div class="eyebrow">RITTY / COMMAND CENTER</div><h2 id="topTitle">Leitura operacional</h2></div>
      <div style="display:flex;gap:8px;align-items:center"><div class="status-line"><span id="mainDot" class="dot"></span><span id="mainStatus">Conectando…</span></div><button id="refresh" class="refresh">Atualizar</button></div>
    </div>

    <section id="overview" class="hero">
      <div class="hero-card">
        <div class="eyebrow">LIVE RUNTIME</div>
        <h3 id="heroName">RITTY</h3>
        <p id="heroDesc">Painel somente leitura do runtime autônomo. Os números abaixo são lidos diretamente do processo e do banco local do agente.</p>
        <div class="pillrow"><span id="statePill" class="pill">Estado —</span><span id="modelPill" class="pill">Modelo —</span><span class="pill">READ ONLY</span></div>
      </div>
      <div class="hero-card orbit"><div class="orb" aria-hidden="true"></div></div>
    </section>

    <section class="grid">
      <div class="panel metric"><div class="label">Estado atual</div><div class="value" id="mState">—</div><div class="sub">fonte: runtime</div></div>
      <div class="panel metric"><div class="label">Ciclos / turns</div><div class="value" id="mTurns">—</div><div class="sub" id="mTurnsSub">total</div></div>
      <div class="panel metric"><div class="label">Skills ativas</div><div class="value" id="mSkills">—</div><div class="sub">carregadas no banco</div></div>
      <div class="panel metric"><div class="label">Uptime</div><div class="value" id="mUptime">—</div><div class="sub">processo atual</div></div>
    </section>

    <section id="activity" class="two">
      <div class="panel">
        <div class="panel-head"><h4>Atividade recente</h4><span id="activityWindow">últimos registros</span></div>
        <div id="turnList" class="list"></div>
        <div class="note">O painel não expõe prompts, pensamentos, argumentos de ferramentas ou resultados brutos.</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h4>Ferramentas</h4><span id="toolSummary">—</span></div>
        <div id="toolList" class="list"></div>
      </div>
    </section>

    <section id="skills" class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h4>Skills / capacidades</h4><span id="skillSummary">—</span></div>
      <div id="skillList" class="list"></div>
    </section>

    <section id="system" class="columns">
      <div class="panel"><div class="panel-head"><h4>Heartbeats</h4><span id="hbSummary">—</span></div><div id="hbList" class="list"></div></div>
      <div class="panel"><div class="panel-head"><h4>Workers / children</h4><span id="childSummary">—</span></div><div id="childList" class="list"></div></div>
      <div class="panel"><div class="panel-head"><h4>Saúde observada</h4><span>somente leitura</span></div>
        <div class="list">
          <div class="row"><div class="dot ok"></div><div><div class="name">Runtime</div><div class="meta">processo respondeu ao painel</div></div><div class="right oktxt" id="healthRuntime">OK</div></div>
          <div class="row"><div class="dot"></div><div><div class="name">Atualização</div><div class="meta" id="healthUpdated">—</div></div><div class="right">LIVE</div></div>
          <div class="row"><div class="dot"></div><div><div class="name">Falhas recentes</div><div class="meta">tool calls com erro · última hora</div></div><div class="right" id="healthErrors">—</div></div>
        </div>
        <div class="panel-head" style="margin-top:15px"><h4>Erros recentes</h4><span id="errorSummary">sanitizados</span></div>
        <div id="errorList" class="list"></div>
      </div>
    </section>
    <div class="footer">RITTY Command Center · leitura operacional · sem controles financeiros</div>
  </main>
</div>
<nav class="mobile-nav"><a class="active" href="#overview">Visão</a><a href="#activity">Atividade</a><a href="#skills">Skills</a><a href="#system">Sistema</a></nav>
<script>
const $ = function(id){ return document.getElementById(id); };
const esc = function(v){
  return String(v == null ? "" : v)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
};
function fmtTime(v){
  if(!v) return "—";
  try{
    return new Date(v).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }catch(e){ return v; }
}
function fmtAge(v){
  if(!v) return "—";
  var s=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/1000));
  if(s<60) return String(s)+"s atrás";
  if(s<3600) return String(Math.floor(s/60))+"min atrás";
  return String(Math.floor(s/3600))+"h atrás";
}
function fmtUp(sec){
  if(sec==null) return "—";
  var s=Math.floor(sec);
  var d=Math.floor(s/86400); s%=86400;
  var h=Math.floor(s/3600); s%=3600;
  var m=Math.floor(s/60);
  return d ? String(d)+"d "+String(h)+"h" : String(h)+"h "+String(m)+"m";
}
function setConn(ok,text){
  $("mainDot").className="dot "+(ok?"ok":"bad");
  $("sideDot").className="dot "+(ok?"ok":"bad");
  $("mainStatus").textContent=text;
  $("sideStatus").textContent=text;
}
function rowHtml(title,meta,right,rightClass){
  rightClass=rightClass||"";
  var dotClass=rightClass==="errtxt" ? "bad" : "ok";
  return '<div class="row"><div class="dot '+dotClass+'"></div><div><div class="name">'+esc(title)+'</div><div class="meta">'+esc(meta)+'</div></div><div class="right '+rightClass+'">'+esc(right)+'</div></div>';
}
function render(d){
  setConn(true,"Conectado");
  $("sideUpdated").textContent="Atualizado "+fmtTime(d.generatedAt);
  $("healthUpdated").textContent=fmtAge(d.generatedAt)+(d.apiLatencyMs!=null?" · API "+String(d.apiLatencyMs)+" ms":"");
  $("heroName").textContent=d.identity.name;
  $("mState").textContent=d.runtime.state;
  $("mTurns").textContent=d.metrics.turnsTotal;
  $("mTurnsSub").textContent=String(d.metrics.turns1h)+" na última hora";
  $("mSkills").textContent=d.metrics.skills;
  $("mUptime").textContent=fmtUp(d.runtime.uptimeSeconds);
  $("statePill").textContent="Estado · "+d.runtime.state;
  $("modelPill").textContent="Modelo · "+d.identity.model;
  $("healthErrors").textContent=d.metrics.errors1h;
  $("toolSummary").textContent=String(d.metrics.toolCalls1h)+" calls / 1h";
  $("activityWindow").textContent="mais recentes";
  $("hbSummary").textContent=String(d.metrics.heartbeatsActive)+" ativos";
  $("childSummary").textContent=String(d.metrics.childrenAlive)+" vivos";
  $("skillSummary").textContent=String(d.metrics.skills)+" ativas";

  $("turnList").innerHTML=d.recentTurns.length
    ? d.recentTurns.map(function(t){
        return rowHtml("Turn "+t.id.slice(0,10),fmtTime(t.timestamp)+" · "+String(t.toolCalls||0)+" tools",t.state,t.state==="error"?"errtxt":"");
      }).join("")
    : '<div class="note">Nenhum turn registrado ainda.</div>';

  $("toolList").innerHTML=d.recentTools.length
    ? d.recentTools.map(function(t){
        return rowHtml(t.name,fmtTime(t.timestamp),t.failed?"FALHOU":(t.durationMs?String(Math.round(t.durationMs))+" ms":"OK"),t.failed?"errtxt":"");
      }).join("")
    : '<div class="note">Nenhuma ferramenta registrada ainda.</div>';

  $("skillList").innerHTML=d.skills.length
    ? d.skills.map(function(s){
        return '<div class="skill"><strong>'+esc(s.name)+'</strong><p>'+esc(s.description||"Sem descrição.")+'</p></div>';
      }).join("")
    : '<div class="note">Nenhuma skill ativa.</div>';

  $("hbList").innerHTML=d.heartbeats.length
    ? d.heartbeats.map(function(h){
        return rowHtml(h.name,(h.schedule||"sem agenda")+" · último "+fmtAge(h.lastRun),h.enabled?"ATIVO":"OFF",h.enabled?"":"errtxt");
      }).join("")
    : '<div class="note">Nenhum heartbeat configurado.</div>';

  $("childList").innerHTML=d.children.length
    ? d.children.slice(0,8).map(function(ch){
        return rowHtml(ch.name||"worker",ch.status||"sem status",ch.status==="dead"?"DEAD":"VIVO",ch.status==="dead"?"errtxt":"");
      }).join("")
    : '<div class="note">Nenhum child/worker registrado.</div>';

  $("errorSummary").textContent=d.recentErrors.length ? String(d.recentErrors.length)+" registros" : "nenhum";
  $("errorList").innerHTML=d.recentErrors.length
    ? d.recentErrors.map(function(e){
        return rowHtml(e.name,e.category+" · "+fmtTime(e.timestamp),"ERRO","errtxt");
      }).join("")
    : '<div class="note">Nenhum erro recente registrado.</div>';
}
async function load(){
  try{
    var started=performance.now();
    var r=await fetch("/api/dashboard",{cache:"no-store"});
    if(!r.ok) throw new Error("dashboard "+r.status);
    var d=await r.json();
    d.apiLatencyMs=Math.round(performance.now()-started);
    render(d);
  }catch(e){
    setConn(false,"Sem conexão");
    $("sideUpdated").textContent="Não foi possível ler o runtime";
    $("healthRuntime").textContent="ERRO";
  }
}
$("refresh").addEventListener("click",load);
load();
setInterval(load,5000);
</script>
</body></html>`;

function safeInt(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function tableExists(db: AutomatonDatabase, table: string): boolean {
  return Boolean(
    db.raw.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(table),
  );
}

function jsonNumber(value: unknown): number {
  if (typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value) as { totalTokens?: unknown };
    return typeof parsed.totalTokens === "number" ? parsed.totalTokens : 0;
  } catch {
    return 0;
  }
}

function buildSnapshot(db: AutomatonDatabase, config: AutomatonConfig) {
  const turnCount = db.getTurnCount();
  const now = new Date().toISOString();
  const turns1h = safeInt(
    (db.raw.prepare(
      "SELECT COUNT(*) AS count FROM turns WHERE julianday(timestamp) >= julianday('now','-1 hour')",
    ).get() as { count?: number }).count,
  );
  const toolCalls1h = safeInt(
    (db.raw.prepare(
      "SELECT COUNT(*) AS count FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id WHERE julianday(t.timestamp) >= julianday('now','-1 hour')",
    ).get() as { count?: number }).count,
  );
  const errors1h = safeInt(
    (db.raw.prepare(
      "SELECT COUNT(*) AS count FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id WHERE tc.error IS NOT NULL AND julianday(t.timestamp) >= julianday('now','-1 hour')",
    ).get() as { count?: number }).count,
  );

  const state = db.getAgentState();
  const startTime = db.getKV("start_time");
  const skills = db.getSkills(true).map((s) => ({ name: s.name, description: s.description }));
  const heartbeats = db.getHeartbeatEntries().map((h) => ({
    name: h.name, schedule: h.schedule, enabled: Boolean(h.enabled), lastRun: h.lastRun ?? null,
  }));
  const children = db.getChildren().map((c) => ({
    name: c.name, status: c.status,
  }));

  const recentTurns = db.raw.prepare(
    "SELECT id,timestamp,state,tool_calls,token_usage FROM turns ORDER BY timestamp DESC LIMIT 14",
  ).all().map((row: any) => ({
    id: String(row.id),
    timestamp: String(row.timestamp),
    state: String(row.state ?? "unknown"),
    toolCalls: (() => { try { return JSON.parse(String(row.tool_calls||"[]")).length; } catch { return 0; } })(),
    tokens: jsonNumber(row.token_usage),
  }));

  const recentTools = db.raw.prepare(
    "SELECT tc.name,tc.duration_ms,tc.error,t.timestamp FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id ORDER BY t.timestamp DESC LIMIT 24",
  ).all().map((row: any) => ({
    name: String(row.name ?? "unknown"),
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    failed: row.error != null,
    timestamp: String(row.timestamp),
  }));

  const recentErrors = db.raw.prepare(
    "SELECT tc.name,tc.error,t.timestamp FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id WHERE tc.error IS NOT NULL ORDER BY t.timestamp DESC LIMIT 8",
  ).all().map((row: any) => {
    const raw = String(row.error ?? "").toLowerCase();
    const category =
      /429|rate.?limit|quota|resource.?exhausted/.test(raw) ? "Limite de provedor" :
      /timeout|timed out|deadline/.test(raw) ? "Timeout" :
      /network|fetch|socket|econn|dns/.test(raw) ? "Rede" :
      "Falha de ferramenta";
    return {
      name: String(row.name ?? "unknown"),
      category,
      timestamp: String(row.timestamp),
    };
  });

  const lastTurn = recentTurns[0]?.timestamp ?? null;
  const childrenAlive = children.filter((c) => !["dead","failed","cleaned_up"].includes(c.status)).length;
  const heartbeatsActive = heartbeats.filter((h) => h.enabled).length;

  const runtime = {
    state,
    uptimeSeconds: process.uptime(),
    startTime,
    lastTurnAt: lastTurn,
  };

  const identity = {
    name: config.name,
    model: config.inferenceModel,
    version: config.version,
  };

  return {
    connected: true,
    generatedAt: now,
    identity,
    runtime,
    metrics: {
      turnsTotal: turnCount,
      turns1h,
      toolCalls1h,
      errors1h,
      skills: skills.length,
      heartbeatsActive,
      childrenAlive,
    },
    recentTurns,
    recentTools,
    recentErrors,
    skills,
    heartbeats,
    children,
  };
}

export function startDashboardServer(options: { db: AutomatonDatabase; config: AutomatonConfig }): http.Server | null {
  const { db, config } = options;
  const port = Number(process.env.PORT || process.env.RITTY_DASHBOARD_PORT || 8787);
  const host = "0.0.0.0";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");

    if (pathname === "/" || pathname === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (pathname === "/api/dashboard") {
      try {
        const payload = buildSnapshot(db, config);
        const body = JSON.stringify(payload);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(body);
      } catch {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ connected: false, error: "dashboard_unavailable" }));
      }
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, runtime: db.getAgentState(), timestamp: new Date().toISOString() }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.on("error", (error) => {
    process.stderr.write(`[dashboard] server error: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  server.listen(port, host, () => {
    process.stdout.write(`[dashboard] RITTY Command Center listening on http://${host}:${port}\n`);
  });

  return server;
}
