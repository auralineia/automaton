import http from "node:http";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#07080c" />
<title>RITTY / Command Center</title>
<style>:root{--bg:#07090d;--gold:#e3b72f;--ink:#f3f4f6;--muted:#8e96a3;--cyan:#59f4d2;--purple:#9b8cff;--red:#ff5d79}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#07090d;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}body{overflow-x:hidden}
.command-room{min-height:100vh;background:radial-gradient(900px 500px at 50% 8%,rgba(61,83,103,.18),transparent 60%),linear-gradient(#06080c,#0a0d12 48%,#080a0e)}
.room-header{height:64px;display:flex;justify-content:space-between;align-items:center;padding:0 24px;border-bottom:1px solid rgba(229,190,52,.2);background:rgba(7,9,13,.92);position:sticky;top:0;z-index:30;backdrop-filter:blur(16px)}
.room-brand{display:flex;gap:11px;align-items:center}.brand-mark{width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(227,183,47,.65);border-radius:8px;color:var(--gold);font-weight:900}.tiny{font-size:9px;letter-spacing:.18em;color:#7f8794}.room-brand strong{font-size:18px;letter-spacing:.08em}.room-status{display:flex;gap:9px;align-items:center;font-size:11px;letter-spacing:.12em;color:#b4bbc5}.sep{color:#4b5360}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#f3b942;box-shadow:0 0 16px currentColor}.dot.ok{background:var(--cyan)}
.ops-room{max-width:1500px;margin:0 auto;padding:20px 22px 12px}.back-wall{height:420px;position:relative;overflow:hidden;border:1px solid rgba(229,190,52,.22);border-bottom:none;background:linear-gradient(180deg,#171b21,#22272d 65%,#15181d);box-shadow:inset 0 0 100px rgba(0,0,0,.6)}
.back-wall:before,.back-wall:after{content:"";position:absolute;top:0;bottom:0;width:18%;background:linear-gradient(90deg,rgba(8,10,14,.95),rgba(37,40,43,.2),rgba(8,10,14,.95));opacity:.7}.back-wall:before{left:0}.back-wall:after{right:0}
.wall-topline{position:absolute;left:24px;right:24px;top:17px;display:flex;justify-content:space-between;font-size:10px;color:#a7afb8;letter-spacing:.14em}
.wall-screen{position:absolute;background:linear-gradient(145deg,#0a1417,#0c2322);border:2px solid #aa8528;box-shadow:0 0 0 3px rgba(229,190,52,.08),0 15px 30px rgba(0,0,0,.4),inset 0 0 22px rgba(77,255,198,.08);border-radius:3px}.main-screen{width:54%;height:270px;left:23%;top:72px;padding:19px 22px}.screen-top,.screen-footer{display:flex;justify-content:space-between;color:#62eecb;font-size:10px;letter-spacing:.1em}.screen-value{font-size:54px;line-height:1;margin-top:27px;font-weight:800;color:#62f0ce}.screen-label{font-size:9px;color:#71817f;letter-spacing:.2em;margin-top:5px}.screen-chart{height:84px;display:flex;align-items:end;gap:5px;margin-top:17px;border-bottom:1px solid rgba(92,242,206,.2)}.screen-chart i{flex:1;background:linear-gradient(to top,rgba(45,226,183,.08),rgba(45,226,183,.6));height:40%;display:block}.screen-chart i:nth-child(1){height:20%}.screen-chart i:nth-child(2){height:42%}.screen-chart i:nth-child(3){height:31%}.screen-chart i:nth-child(4){height:59%}.screen-chart i:nth-child(5){height:45%}.screen-chart i:nth-child(6){height:71%}.screen-chart i:nth-child(7){height:61%}.screen-chart i:nth-child(8){height:86%}.screen-chart i:nth-child(9){height:76%}.screen-chart i:nth-child(10){height:92%}.screen-footer{margin-top:12px;color:#8fa5a1;letter-spacing:.02em}.screen-footer b{color:#e8edf0}.side-screen{width:18%;height:118px;top:146px;padding:15px 17px}.left-screen{left:2.5%}.right-screen{right:2.5%}.screen-title{color:#8b949e;font-size:9px;letter-spacing:.15em}.side-screen strong{display:block;font-size:25px;margin-top:14px;color:#e9c95f}.side-screen small{display:block;color:#687178;font-size:8px;margin-top:5px}.wall-grid-lines{position:absolute;inset:0;background:linear-gradient(rgba(229,190,52,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(229,190,52,.035) 1px,transparent 1px);background-size:44px 44px;pointer-events:none}
.floor{height:500px;position:relative;margin-top:-2px;overflow:hidden;background:linear-gradient(145deg,#4d5054,#303339 55%,#3a3b3f);border:1px solid #9d7925;box-shadow:0 0 0 4px rgba(229,190,52,.06),0 35px 65px rgba(0,0,0,.55);transform:perspective(1000px) rotateX(52deg) scale(.97);transform-origin:top center;transform-style:preserve-3d}.floor:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(239,196,75,.13) 1px,transparent 1px),linear-gradient(rgba(239,196,75,.1) 1px,transparent 1px);background-size:44px 44px}.floor-border{position:absolute;inset:0;border:3px solid rgba(227,183,47,.8);box-shadow:inset 0 0 0 8px rgba(0,0,0,.14)}.floor-glow{position:absolute;left:25%;right:25%;top:20%;height:42%;background:radial-gradient(ellipse,rgba(87,246,211,.08),transparent 70%)}
.desk{position:absolute;width:230px;height:118px;transform:translateZ(25px);transform-style:preserve-3d}.desk-body{position:absolute;left:0;right:0;bottom:0;height:78px;background:linear-gradient(145deg,#65686b,#383a3e);border:2px solid #999b9d;box-shadow:0 11px 0 #23262a,0 20px 22px rgba(0,0,0,.38)}.agent-screen{position:absolute;z-index:2;left:55px;top:-42px;width:120px;height:65px;padding:9px 10px;background:linear-gradient(160deg,#10181a,#08110f);border:2px solid #b38c2b;box-shadow:0 0 18px rgba(78,255,213,.12);transform:translateZ(20px)}.agent-screen b{display:block;font-size:9px;color:#dce4e5;letter-spacing:.08em}.agent-screen small{display:block;font-size:8px;color:#64f0ca;margin-top:12px}.scan{position:absolute;left:7px;right:7px;top:28px;height:1px;background:rgba(92,246,205,.5);box-shadow:0 0 9px rgba(92,246,205,.7);animation:scan 2.6s ease-in-out infinite}@keyframes scan{50%{top:54px}}.chair{position:absolute;left:86px;bottom:-46px;width:57px;height:32px;background:#24272c;border:2px solid #484c52;transform:translateZ(10px)}.agent-head{position:absolute;left:104px;top:44px;width:27px;height:27px;border-radius:50%;background:linear-gradient(145deg,#57eecb,#113831);box-shadow:0 0 18px rgba(70,246,211,.32);transform:translateZ(38px)}.agent-head:after{content:"";position:absolute;left:4px;right:4px;top:14px;height:4px;background:#0b1615;border-radius:50%}.agent-head.violet{background:linear-gradient(145deg,#b69cff,#3b2d70);box-shadow:0 0 18px rgba(155,140,255,.3)}.agent-head.blue{background:linear-gradient(145deg,#69a8ff,#19355c)}.agent-head.gold{background:linear-gradient(145deg,#f1d069,#5b4310)}.agent-left-top{left:11%;top:13%}.agent-right-top{right:11%;top:13%}.agent-left-bottom{left:7%;bottom:9%}.agent-right-bottom{right:7%;bottom:9%}
.center-console{position:absolute;left:50%;top:39%;width:290px;height:165px;transform:translate(-50%,-50%) translateZ(34px);transform-style:preserve-3d}.console-screen{position:absolute;left:33px;right:33px;top:0;height:102px;background:linear-gradient(160deg,#081716,#102c29);border:2px solid #b18b2f;box-shadow:inset 0 0 35px rgba(69,241,203,.1),0 12px 19px rgba(0,0,0,.42);padding:16px}.console-brand{font-size:18px;font-weight:900;letter-spacing:.18em;color:#68f0cc;margin-bottom:9px}.console-line{display:flex;justify-content:space-between;font-size:9px;color:#8da09d;margin-top:7px}.console-line b{color:#e7c95f}.console-base{position:absolute;left:10px;right:10px;bottom:0;height:52px;background:linear-gradient(145deg,#6b6d70,#303338);border:2px solid #919396;box-shadow:0 10px 0 #22252a,0 16px 20px rgba(0,0,0,.5)}
.floor-caption{position:absolute;left:50%;bottom:25px;transform:translateX(-50%) translateZ(38px);display:flex;align-items:center;gap:11px;padding:9px 14px;border:1px solid rgba(255,255,255,.14);border-radius:99px;background:rgba(8,10,14,.74);backdrop-filter:blur(10px);font-size:9px;letter-spacing:.1em;color:#b7bec6}.pill-live{color:#62f0ce}.pill-live i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#62f0ce;box-shadow:0 0 10px #62f0ce;margin-right:4px}
.bottom-panel{max-width:1500px;margin:18px auto 0;display:grid;grid-template-columns:1fr 1.35fr;gap:18px;padding:0 22px 28px}.panel-card{border:1px solid rgba(255,255,255,.09);background:linear-gradient(180deg,rgba(19,23,30,.94),rgba(9,12,17,.96));border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.25);padding:16px}.panel-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:13px}.panel-heading span{color:#707986;font-size:9px;letter-spacing:.11em}.feed,.chat-feed{max-height:245px;overflow:auto}.feed-row{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;padding:10px;border:1px solid rgba(255,255,255,.05);border-radius:11px;margin-bottom:7px}.feed-dot{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 10px var(--cyan)}.feed-dot.bad{background:var(--red);box-shadow:0 0 10px var(--red)}.feed-row b{font-size:11px}.feed-row small{display:block;color:#6f7782;font-size:9px;margin-top:3px}.feed-row>strong{font-size:9px;color:#aeb6c2}
.chat-feed{display:flex;flex-direction:column;gap:10px;padding-right:4px}.chat-empty{color:#6f7784;text-align:center;padding:22px;font-size:11px}.chat-item{padding:9px 2px}.chat-meta{display:flex;justify-content:space-between;color:#6e7784;font-size:8px;text-transform:uppercase;letter-spacing:.08em}.chat-user,.chat-agent{margin-top:6px;padding:9px 11px;border-radius:12px;line-height:1.45;font-size:11px;white-space:pre-wrap;word-break:break-word}.chat-user{background:rgba(227,183,47,.08);border:1px solid rgba(227,183,47,.16)}.chat-agent{background:rgba(83,240,207,.06);border:1px solid rgba(83,240,207,.12);color:#d7e7e4}.agent-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--cyan);margin-right:7px;box-shadow:0 0 8px var(--cyan)}.chat-form{display:grid;grid-template-columns:1fr auto;gap:9px;margin-top:10px}.chat-form textarea{width:100%;resize:none;min-height:44px;max-height:120px;padding:12px 13px;color:#ecf0f3;background:#0a0d12;border:1px solid rgba(255,255,255,.1);border-radius:12px;outline:none}.chat-form button{border:0;border-radius:12px;padding:0 15px;background:linear-gradient(135deg,#e3b72f,#b88d1e);color:#101217;font-weight:800;cursor:pointer}.chat-form button:disabled{opacity:.55}.chat-form button b{font-size:17px;margin-left:5px}.chat-hint{color:#5f6874;font-size:9px;margin-top:8px}.mobile-metrics{display:none}
@media(max-width:900px){.back-wall{height:360px}.floor{height:410px}.desk{transform:scale(.7) translateZ(25px)}.agent-left-top{left:2%;top:10%}.agent-right-top{right:2%;top:10%}.agent-left-bottom{left:-2%;bottom:6%}.agent-right-bottom{right:-2%;bottom:6%}.center-console{transform:translate(-50%,-50%) translateZ(32px) scale(.82)}.bottom-panel{grid-template-columns:1fr}}
@media(max-width:620px){.room-header{padding:0 13px;height:56px}.tiny{display:none}.ops-room{padding:10px 8px}.back-wall{height:300px}.main-screen{width:68%;left:16%;height:195px;top:58px;padding:13px 14px}.screen-value{font-size:36px;margin-top:17px}.screen-chart{height:50px}.side-screen{display:none}.floor{height:360px;transform:perspective(850px) rotateX(53deg) scale(.97)}.desk{transform:scale(.53) translateZ(25px)}.center-console{transform:translate(-50%,-50%) translateZ(30px) scale(.68)}.floor-caption{font-size:7px;bottom:15px;white-space:nowrap}.bottom-panel{padding:0 8px 18px;gap:10px}.panel-card{padding:12px}.feed,.chat-feed{max-height:210px}.chat-form{grid-template-columns:1fr 76px}.chat-form button{padding:0 10px;font-size:0}.chat-form button b{font-size:17px}.mobile-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:0 8px 16px}.mobile-metrics>div{border:1px solid rgba(255,255,255,.08);background:#0c1016;border-radius:12px;padding:9px}.mobile-metrics span{display:block;font-size:8px;color:#68717d;letter-spacing:.12em}.mobile-metrics b{display:block;margin-top:4px;font-size:13px}}</style>
</head>
<body>
<div class="command-room">
  <div class="room-header">
    <div class="room-brand"><span class="brand-mark">R</span><div><div class="tiny">AUTOMATON COMMAND CENTER</div><strong>RITTY</strong></div></div>
    <div class="room-status"><span class="dot ok" id="roomDot"></span><span id="roomStatus">ONLINE</span><span class="sep">•</span><span id="roomClock">--:--:--</span></div>
  </div>
  <main class="ops-room" id="overview">
    <div class="back-wall">
      <div class="wall-topline"><span>RITTY OPERATIONS FLOOR</span><span id="wallUptime">UPTIME —</span></div>
      <div class="wall-screen main-screen">
        <div class="screen-top"><span>LIVE PERFORMANCE</span><span id="screenState">RUNNING</span></div>
        <div class="screen-value" id="screenTurns">0</div>
        <div class="screen-label">TOTAL TURNS</div>
        <div class="screen-chart"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="screen-footer"><span><b id="screenTools">0</b> tool calls / 1h</span><span><b id="screenErrors">0</b> failures / 1h</span></div>
      </div>
      <div class="wall-screen side-screen left-screen"><div class="screen-title">RUNTIME</div><strong id="wRuntime">—</strong><small>LIVE STATE</small></div>
      <div class="wall-screen side-screen right-screen"><div class="screen-title">WORKFORCE</div><strong id="wWorkers">0</strong><small>ACTIVE WORKERS</small></div>
      <div class="wall-grid-lines"></div>
    </div>
    <div class="floor">
      <div class="floor-border"></div><div class="floor-glow"></div>
      <div class="desk agent agent-left-top"><div class="agent-screen"><span class="scan"></span><b>WORKER A</b><small id="agentA">IDLE</small></div><div class="desk-body"></div><div class="chair"></div><div class="agent-head"></div></div>
      <div class="desk agent agent-right-top"><div class="agent-screen"><span class="scan"></span><b>WORKER B</b><small id="agentB">IDLE</small></div><div class="desk-body"></div><div class="chair"></div><div class="agent-head violet"></div></div>
      <div class="desk agent agent-left-bottom"><div class="agent-screen"><span class="scan"></span><b>WORKER C</b><small id="agentC">IDLE</small></div><div class="desk-body"></div><div class="chair"></div><div class="agent-head blue"></div></div>
      <div class="desk agent agent-right-bottom"><div class="agent-screen"><span class="scan"></span><b>WORKER D</b><small id="agentD">IDLE</small></div><div class="desk-body"></div><div class="chair"></div><div class="agent-head gold"></div></div>
      <div class="center-console"><div class="console-screen"><div class="console-brand">RITTY</div><div class="console-line"><span>STATUS</span><b id="consoleState">ONLINE</b></div><div class="console-line"><span>SKILLS</span><b id="consoleSkills">0</b></div><div class="console-line"><span>HEARTBEATS</span><b id="consoleHB">0</b></div></div><div class="console-base"></div></div>
      <div class="floor-caption"><span>OPERATIONS</span><span class="pill-live"><i></i> LIVE</span><span id="floorMeta">0 cycles · 0 skills</span></div>
    </div>
  </main>
  <section class="bottom-panel">
    <div class="panel-card activity-card"><div class="panel-heading"><strong>Recent Activity</strong><span id="activityCount">0 events</span></div><div id="activityFeed" class="feed"></div></div>
    <div class="panel-card chat-card">
      <div class="panel-heading"><strong>Talk to RITTY</strong><span>CREATOR COMMAND CHANNEL</span></div>
      <div id="chatFeed" class="chat-feed"><div class="chat-empty">Mande uma tarefa para o RITTY.</div></div>
      <form id="chatForm" class="chat-form"><textarea id="chatInput" maxlength="64000" rows="1" placeholder="Digite uma tarefa para o RITTY…"></textarea><button id="chatSend" type="submit">Enviar <b>↗</b></button></form>
      <div id="chatHint" class="chat-hint">A tarefa entra na fila do runtime.</div>
    </div>
  </section>
  <section class="mobile-metrics"><div><span>STATE</span><b id="mState">—</b></div><div><span>TURNS</span><b id="mTurns">0</b></div><div><span>SKILLS</span><b id="mSkills">0</b></div><div><span>UPTIME</span><b id="mUptime">—</b></div></section>
</div>
<script>
const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function fmtTime(v){try{return new Date(v).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){return "—";}}
function fmtUp(sec){if(sec==null)return "—";let s=Math.floor(sec),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d?d+"d "+h+"h":h+"h "+m+"m";}
function renderChat(d){
  const turns=d.chatTurns||[];
  $("chatFeed").innerHTML=turns.length?turns.map(t=>'<div class="chat-item"><div class="chat-meta"><span>'+esc(t.inputSource||"RITTY")+'</span><time>'+esc(fmtTime(t.timestamp))+'</time></div><div class="chat-user">'+esc(t.input||"")+'</div><div class="chat-agent"><span class="agent-dot"></span>'+esc(t.response||"RITTY processando…")+'</div></div>').join(""):'<div class="chat-empty">Mande uma tarefa para o RITTY.</div>';
  $("chatFeed").scrollTop=$("chatFeed").scrollHeight;
}
async function load(){
  try{
    const r=await fetch("/api/dashboard",{cache:"no-store"}); if(!r.ok) throw Error();
    const d=await r.json();
    $("roomStatus").textContent=d.connected?"ONLINE":"OFFLINE"; $("roomClock").textContent=new Date().toLocaleTimeString("pt-BR");
    $("wallUptime").textContent="UPTIME "+fmtUp(d.runtime.uptimeSeconds);
    $("screenState").textContent=String(d.runtime.state).toUpperCase(); $("screenTurns").textContent=d.metrics.turnsTotal; $("screenTools").textContent=d.metrics.toolCalls1h; $("screenErrors").textContent=d.metrics.errors1h;
    $("wRuntime").textContent=String(d.runtime.state).toUpperCase(); $("wWorkers").textContent=d.metrics.childrenAlive; $("consoleState").textContent=String(d.runtime.state).toUpperCase(); $("consoleSkills").textContent=d.metrics.skills; $("consoleHB").textContent=d.metrics.heartbeatsActive;
    $("floorMeta").textContent=d.metrics.turnsTotal+" cycles · "+d.metrics.skills+" skills";
    $("mState").textContent=d.runtime.state; $("mTurns").textContent=d.metrics.turnsTotal; $("mSkills").textContent=d.metrics.skills; $("mUptime").textContent=fmtUp(d.runtime.uptimeSeconds);
    const children=d.children||[]; ["A","B","C","D"].forEach((x,i)=>{const c=children[i];$("agent"+x).textContent=c?(c.status||"RUNNING").toUpperCase():"IDLE";});
    const acts=(d.recentTurns||[]).slice(0,8); $("activityCount").textContent=acts.length+" events";
    $("activityFeed").innerHTML=acts.length?acts.map(t=>'<div class="feed-row"><div class="feed-dot '+(t.state==="error"?"bad":"")+'"></div><div><b>Turn '+esc(t.id.slice(0,8))+'</b><small>'+esc(fmtTime(t.timestamp))+' · '+esc(t.state)+'</small></div><strong>'+esc(t.toolCalls||0)+' tools</strong></div>').join(""):'<div class="chat-empty">Sem atividade recente.</div>';
    renderChat(d);
    if(d.chatPending && d.chatPending.status === "failed"){ $("chatHint").textContent="RITTY não conseguiu executar a tarefa ainda. Verifique o estado do provedor."; }
    else if(d.chatPending && d.chatPending.status === "received"){ $("chatHint").textContent="Tarefa na fila. RITTY aguardará uma janela de inferência disponível."; }
    else if(d.chatPending && d.chatPending.status === "in_progress"){ $("chatHint").textContent="RITTY está processando esta tarefa agora…"; }
  }catch(e){$("roomStatus").textContent="OFFLINE";}
}
$("chatForm").addEventListener("submit",async e=>{
  e.preventDefault(); const input=$("chatInput"); const message=input.value.trim(); if(!message)return;
  $("chatSend").disabled=true; $("chatHint").textContent="Enviando para o runtime…";
  try{
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message})});
    const d=await r.json(); if(!r.ok) throw Error(d.error||"Falha ao enviar");
    input.value=""; $("chatHint").textContent="Enviado. RITTY vai processar na próxima execução."; load();
  }catch(err){$("chatHint").textContent=String(err.message||err);}
  finally{$("chatSend").disabled=false;input.focus();}
});
load(); setInterval(load,5000);
</script>
</body></html>`;

function requireUlid(): string {
  return "dash-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

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
    chatTurns: db.raw.prepare("SELECT id,timestamp,input,input_source,thinking FROM turns WHERE input_source IN ('creator','agent') AND input IS NOT NULL ORDER BY timestamp DESC LIMIT 24").all().map((row: any) => ({ id: String(row.id), timestamp: String(row.timestamp), input: String(row.input ?? ""), inputSource: String(row.input_source ?? "agent"), response: String(row.thinking ?? "") })).reverse(),
    chatPending: (() => {
      const row = db.raw.prepare("SELECT id,content,status,received_at,retry_count,max_retries FROM inbox_messages WHERE from_address = ? ORDER BY received_at DESC LIMIT 1").get("dashboard://creator") as any;
      if (!row) return null;
      return { id: String(row.id), content: String(row.content ?? ""), status: String(row.status ?? "received"), receivedAt: String(row.received_at ?? ""), retryCount: Number(row.retry_count ?? 0), maxRetries: Number(row.max_retries ?? 3) };
    })(),
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

    if (pathname === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 70000) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as { message?: unknown };
          const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
          if (!message) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "empty_message" })); return; }
          if (message.length > 64000) { res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "message_too_long" })); return; }
          const id = requireUlid();
          db.raw.prepare("INSERT OR IGNORE INTO inbox_messages (id, from_address, to_address, content, received_at, status, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, 'received', 0, 3)").run(id, "dashboard://creator", config.walletAddress, message, new Date().toISOString());
          db.deleteKV("sleep_until");
          db.raw.prepare("INSERT INTO wake_events (source, reason, payload) VALUES (?, ?, ?)").run("dashboard", "manual request", JSON.stringify({ messageId: id }));
          db.setAgentState("waking");
          db.setKV("dashboard_last_message_at", new Date().toISOString());
          res.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ queued: true, id }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "chat_unavailable" }));
        }
      });
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
