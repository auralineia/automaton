import http from "node:http";
import fs from "node:fs";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="theme-color" content="#050a14"/>
<title>RITTY — Autonomous AI Agent</title>
<style>
:root{--bg:#050a14;--panel:#08111f;--text:#f0f6ff;--muted:#7890a9;--line:#10243b;--blue:#397dff;--green:#1ee59d;--red:#ff5c6c;--violet:#8172ff}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}body{overflow-x:hidden}
button,input,textarea{font:inherit}button{cursor:pointer}
.app{min-height:100vh;background:radial-gradient(900px 650px at 31% 0%,rgba(34,89,176,.11),transparent 60%),linear-gradient(180deg,#050a14,#050b16 55%,#040913)}
.topbar{height:76px;border-bottom:1px solid rgba(103,164,255,.11);display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:rgba(4,9,18,.86);backdrop-filter:blur(18px);position:sticky;top:0;z-index:50}
.brand{display:flex;align-items:center;gap:12px}.brand-mark{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:#63a6ff;font-weight:900;font-size:25px;background:linear-gradient(145deg,#132b52,#0a1425);border:1px solid #214a84;box-shadow:0 0 26px rgba(53,118,255,.16)}.brand-copy small{display:block;color:#6f86a1;font-size:10px;letter-spacing:.16em;font-weight:700}.brand-copy strong{display:block;font-size:21px;letter-spacing:.08em}
.system-chip{display:flex;align-items:center;gap:11px;color:#dbebff}.system-chip .live{font-size:13px;font-weight:750}.system-chip small{display:block;color:#66819f;font-size:10px;margin-top:2px}.live-dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 15px rgba(30,229,157,.85)}
.header-right{display:flex;align-items:center;gap:20px}.clock{font-size:10px;color:#69809b;letter-spacing:.08em;text-align:right}.icon-btn{width:38px;height:38px;border:1px solid #132a47;background:#0a1422;color:#8fa7c2;border-radius:50%;display:grid;place-items:center}
.layout{display:grid;grid-template-columns:212px minmax(0,1fr);min-height:calc(100vh - 76px)}.sidebar{border-right:1px solid rgba(72,129,201,.11);background:rgba(5,11,20,.68);padding:18px 12px;display:flex;flex-direction:column}.nav{display:grid;gap:5px}.nav button{border:1px solid transparent;background:transparent;color:#7590ad;text-align:left;padding:12px 13px;border-radius:10px;display:flex;align-items:center;gap:10px;font-size:12px;transition:.18s}.nav button:hover,.nav button.active{background:linear-gradient(90deg,rgba(55,125,255,.18),rgba(55,125,255,.05));border-color:rgba(63,133,255,.18);color:#dceaff}.nav .ico{width:18px;text-align:center;color:#708daf}.sidebar-foot{margin-top:auto;padding:14px 10px;color:#55708e;font-size:9px;line-height:1.5}.sidebar-foot b{color:#7d9bb8}
.content{padding:20px;max-width:1500px;width:100%;margin:0 auto}.hero-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(350px,.72fr);gap:18px}.hero,.providers,.metric,.panel,.logs,.chat{border:1px solid rgba(72,129,201,.16);background:linear-gradient(180deg,rgba(10,20,35,.98),rgba(6,14,25,.98));box-shadow:0 22px 70px rgba(0,0,0,.2)}
.hero{min-height:284px;border-radius:15px;padding:18px;display:grid;grid-template-columns:55% 45%;overflow:hidden;position:relative}.hero-copy{padding:10px 10px 10px 14px;display:flex;flex-direction:column;justify-content:center;position:relative;z-index:3}.hero-kicker{font-size:11px;letter-spacing:.06em;color:#6f89a7}.hero h1{font-size:30px;margin:7px 0 2px;letter-spacing:.03em}.hero h1 span{color:#7fb7ff}.hero-sub{font-size:12px;color:#7790aa;max-width:410px;line-height:1.6}.hero-state{display:flex;align-items:center;gap:10px;margin-top:20px;color:#dfeeff;font-size:13px;font-weight:800}.hero-state small{display:block;color:#5e7893;font-size:10px;font-weight:500;margin-top:3px}
.robot-scene{position:relative;display:grid;place-items:center;overflow:hidden}.robot-floor{position:absolute;left:6%;right:4%;bottom:7%;height:34px;border-radius:50%;background:radial-gradient(ellipse,rgba(49,130,255,.44),rgba(49,130,255,.02) 68%,transparent 70%);filter:blur(1px)}.robot{width:150px;height:164px;position:relative;filter:drop-shadow(0 25px 28px rgba(0,0,0,.48));animation:float 4.5s ease-in-out infinite}.robot .head{position:absolute;top:5px;left:30px;width:92px;height:76px;border-radius:34px;background:linear-gradient(145deg,#1c2b41,#0b1523);border:2px solid #3d638d;box-shadow:inset 0 0 20px rgba(82,159,255,.1),0 0 30px rgba(63,132,255,.1)}.robot .visor{position:absolute;left:13px;right:13px;top:20px;height:32px;border-radius:18px;background:#020711;border:1px solid #1b3b68;display:flex;align-items:center;justify-content:center;gap:22px}.robot .eye{width:12px;height:5px;border-radius:99px;background:#51a8ff;box-shadow:0 0 11px #51a8ff}.robot .ear{position:absolute;top:29px;width:15px;height:20px;background:#17263b;border:1px solid #385579;border-radius:7px}.robot .ear.l{left:-6px}.robot .ear.r{right:-6px}.robot .body{position:absolute;left:18px;right:18px;top:79px;height:77px;border-radius:30px 30px 16px 16px;background:linear-gradient(145deg,#21334b,#0d1727);border:2px solid #395b80;box-shadow:inset 0 0 28px rgba(47,120,223,.08)}.robot .core{position:absolute;left:50%;top:26px;transform:translateX(-50%);width:31px;height:31px;border-radius:50%;background:radial-gradient(circle,#b9e5ff 0,#56a8ff 27%,#173c70 64%,#0a1422 67%);box-shadow:0 0 25px rgba(79,167,255,.5)}.robot .arm{position:absolute;top:92px;width:22px;height:59px;border-radius:12px;background:linear-gradient(180deg,#1b2a40,#0a1422);border:1px solid #365477}.robot .arm.l{left:0;transform:rotate(8deg)}.robot .arm.r{right:0;transform:rotate(-8deg)}.robot .leg{position:absolute;bottom:-12px;width:29px;height:25px;background:#101b2a;border:1px solid #2f4c6b;border-radius:8px}.robot .leg.l{left:43px}.robot .leg.r{right:43px}@keyframes float{50%{transform:translateY(-7px)}}
.providers{border-radius:15px;padding:16px}.panel-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.panel-title strong{font-size:13px}.panel-title span{color:#607793;font-size:9px;letter-spacing:.12em}.provider{border:1px solid rgba(83,127,178,.14);background:linear-gradient(180deg,#0a1626,#08111e);border-radius:12px;padding:13px;margin-bottom:9px;display:grid;grid-template-columns:36px 1fr auto 12px;gap:11px;align-items:center;cursor:pointer;transition:.18s}.provider:hover{transform:translateY(-1px);border-color:#214b80}.provider-icon{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#101d31;border:1px solid #284362;font-weight:900}.provider-icon.groq{color:#ff6d60}.provider-icon.gemini{color:#88a7ff}.provider-icon.fallback{color:#8f8aff}.provider b{display:block;font-size:11px}.provider small{display:block;font-size:9px;color:#667e99;margin-top:4px}.provider-status{font-size:9px;font-weight:800;padding:5px 7px;border-radius:999px;background:rgba(31,227,157,.08);color:#59e4b4;border:1px solid rgba(31,227,157,.12);white-space:nowrap}.provider-status.bad{color:#ff8d98;background:rgba(255,92,108,.08);border-color:rgba(255,92,108,.14)}.provider-arrow{color:#5c7590;font-size:16px}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:13px;margin-top:14px}.metric{border-radius:13px;padding:15px;min-height:113px}.metric .mi{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#0d1b2f;border:1px solid #1b3d67;color:#78a8ff;font-size:13px}.metric h4{font-size:10px;color:#728aa5;font-weight:650;margin:10px 0 3px}.metric strong{font-size:19px}.metric small{display:block;color:#5e7894;font-size:9px;margin-top:3px}
.main-grid{display:grid;grid-template-columns:1.05fr 1.12fr .72fr;gap:14px;margin-top:14px}.panel{border-radius:14px;padding:15px}.feed{display:grid;gap:7px;max-height:285px;overflow:auto}.feed-row{display:grid;grid-template-columns:8px 1fr auto;gap:9px;align-items:center;padding:10px 9px;border:1px solid rgba(76,119,167,.1);background:#08121f;border-radius:10px}.fdot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(30,229,157,.45)}.fdot.bad{background:var(--red);box-shadow:0 0 10px rgba(255,92,108,.45)}.feed-row b{font-size:10px}.feed-row small{display:block;font-size:8px;color:#59728d;margin-top:3px}.feed-row em{font-style:normal;font-size:8px;color:#6d86a1}
.bars{height:185px;display:flex;align-items:end;gap:8px;border-bottom:1px solid #10243a;padding:0 3px;margin-top:17px}.bar{flex:1;min-width:9px;height:20%;border-radius:5px 5px 0 0;background:linear-gradient(180deg,#6e7eff,#4352d7);box-shadow:0 0 18px rgba(89,105,255,.16);position:relative}.bar span{position:absolute;left:50%;bottom:-18px;transform:translateX(-50%);font-size:7px;color:#506984;white-space:nowrap}.usage-line{margin-top:17px}.usage-row{display:grid;grid-template-columns:55px 1fr 38px;align-items:center;gap:8px;margin:10px 0;font-size:9px;color:#6b849e}.usage-row i{display:block;height:6px;background:#12253c;border-radius:99px;overflow:hidden}.usage-row i b{display:block;height:100%;border-radius:99px;background:#5f72ff}.usage-row i b.red{background:#ff5d6e}.usage-row i b.pink{background:#ea8ae6}.health{display:grid;gap:8px}.health-row{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;border:1px solid rgba(79,123,173,.11);background:#08121f;border-radius:10px;font-size:9px;color:#7190ad}.health-row b{color:#54e3ae;font-size:9px}.health-row b.warn{color:#ff9a66}.backoff{margin-top:10px;border:1px solid rgba(83,120,174,.16);border-radius:11px;padding:12px;background:linear-gradient(180deg,#0a1628,#07101c)}.backoff strong{display:block;color:#54e3ae;font-size:15px;margin-top:5px}.backoff small{color:#607994;font-size:8px}
.lower{display:grid;grid-template-columns:1.15fr 1fr;gap:14px;margin-top:14px}.logs{border-radius:14px;padding:15px}.log-list{font-family:"SFMono-Regular",Consolas,monospace;font-size:8px;line-height:1.8;max-height:190px;overflow:auto;background:#050b13;border:1px solid #0e2033;border-radius:10px;padding:11px;color:#8098b1}.log-line{display:flex;gap:8px}.log-time{color:#45627f}.log-level{font-weight:800}.log-level.info{color:#42d9bb}.log-level.warn{color:#f0b45d}.log-level.error{color:#ff6d78}.log-msg{color:#8fa6bc}
.chat{border-radius:14px;padding:15px;display:flex;flex-direction:column}.chat-feed{height:193px;overflow:auto;display:grid;gap:10px;padding-right:3px}.chat-empty{display:grid;place-items:center;height:100%;color:#58708b;font-size:10px}.msg{max-width:88%;padding:10px 11px;border-radius:12px;font-size:10px;line-height:1.45;border:1px solid rgba(79,124,176,.13)}.msg.user{justify-self:end;background:rgba(54,119,255,.1);color:#cfe1ff}.msg.agent{justify-self:start;background:#08131f;color:#a7bdd3}.msg small{display:block;color:#55708b;font-size:7px;margin-bottom:4px}.chat-actions{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}.quick{border:1px solid #173654;background:#091525;border-radius:999px;color:#7895b2;padding:7px 9px;font-size:8px}.quick:hover{border-color:#2c68ad;color:#b6d3f1}.chat-form{display:grid;grid-template-columns:1fr 48px;gap:7px}.chat-form textarea{min-height:44px;max-height:110px;resize:none;border:1px solid #16304d;background:#050c16;color:#e5eff9;border-radius:11px;padding:11px;outline:none;font-size:10px}.send{border:0;border-radius:11px;background:linear-gradient(160deg,#4a89ff,#255ed3);color:#fff;font-weight:900;font-size:16px}.hint{font-size:8px;color:#506982;margin-top:7px}
.footer{display:flex;justify-content:space-between;align-items:center;color:#47617b;font-size:8px;padding:17px 3px 3px}.footer .online{color:#52dfb0}
.modal-wrap{position:fixed;inset:0;background:rgba(2,7,13,.75);backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:18px;z-index:100}.modal-wrap.open{display:flex}.modal{width:min(680px,100%);max-height:85vh;overflow:auto;border:1px solid #234a79;border-radius:15px;background:#07111f;box-shadow:0 30px 90px rgba(0,0,0,.6);padding:17px}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.modal-head h3{margin:0;font-size:15px}.close{border:1px solid #1b3a5f;background:#0a1728;color:#89a6c4;border-radius:8px;width:30px;height:30px}.modal-grid{display:grid;gap:8px}.detail{padding:10px;border:1px solid #122944;border-radius:10px;background:#081523}.detail b{font-size:10px}.detail small{display:block;color:#607b97;margin-top:4px;font-size:8px;line-height:1.5}
@media(max-width:1080px){.layout{grid-template-columns:72px minmax(0,1fr)}.sidebar{padding:18px 9px}.nav button{justify-content:center;padding:12px}.nav button span:last-child,.sidebar-foot{display:none}.hero-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(3,1fr)}.main-grid{grid-template-columns:1fr 1fr}.health-panel{grid-column:span 2}.lower{grid-template-columns:1fr}}
@media(max-width:700px){.topbar{height:62px;padding:0 12px}.brand-mark{width:33px;height:33px}.brand-copy strong{font-size:17px}.brand-copy small{display:none}.system-chip small,.clock{display:none}.layout{grid-template-columns:1fr}.sidebar{position:sticky;top:62px;z-index:40;border-right:0;border-bottom:1px solid rgba(72,129,201,.1);padding:7px 8px}.nav{display:flex;overflow:auto}.nav button{flex:0 0 auto;padding:9px 10px}.nav button span:last-child{display:inline}.content{padding:10px 8px}.hero{grid-template-columns:1fr;min-height:430px}.hero-copy{padding:12px}.robot-scene{min-height:210px;order:-1}.metrics{grid-template-columns:1fr 1fr}.main-grid{grid-template-columns:1fr}.health-panel{grid-column:auto}.lower{grid-template-columns:1fr}.hero h1{font-size:26px}.provider{grid-template-columns:32px 1fr auto 12px}.bars{height:145px}}
</style>
</head>
<body>
<div class="app">
<header class="topbar">
<div class="brand"><div class="brand-mark">R</div><div class="brand-copy"><small>AUTOMATON</small><strong>RITTY</strong></div></div>
<div class="system-chip"><span class="live-dot" id="topDot"></span><div><div class="live" id="topState">Sistema Online</div><small id="topSub">RITTY está operando normalmente</small></div></div>
<div class="header-right"><div class="clock"><div id="dateNow">--</div><div id="clockNow">--:--</div></div><button class="icon-btn" id="themeBtn" aria-label="Alternar visual">◐</button></div>
</header>
<div class="layout">
<aside class="sidebar">
<nav class="nav">
<button class="active" data-panel="dashboard"><span class="ico">⌂</span><span>Dashboard</span></button>
<button data-panel="cycles"><span class="ico">◷</span><span>Ciclos</span></button>
<button data-panel="tasks"><span class="ico">▤</span><span>Tarefas</span></button>
<button data-panel="workers"><span class="ico">♙</span><span>Workers</span></button>
<button data-panel="tools"><span class="ico">⚒</span><span>Ferramentas</span></button>
<button data-panel="skills"><span class="ico">◇</span><span>Habilidades</span></button>
<button data-panel="logs"><span class="ico">▣</span><span>Logs</span></button>
<button data-panel="settings"><span class="ico">⚙</span><span>Configurações</span></button>
</nav>
<div class="sidebar-foot"><b>AUTOMATON</b><br/>MORE THAN AI<br/><br/>RITTY <span id="versionSide">—</span></div>
</aside>
<main class="content">
<section class="hero-grid">
<div class="hero">
<div class="hero-copy"><div class="hero-kicker">RITTY</div><h1>Agente Autônomo de <span>Criação de Valor</span></h1><div class="hero-sub">Sistema autônomo conectado ao runtime local, memória persistente, ferramentas, workers e política de execução.</div><div class="hero-state"><span class="live-dot"></span><div><div id="heroState">ONLINE</div><small id="heroDetail">Operando com controle de ciclo e proteção de quota.</small></div></div></div>
<div class="robot-scene"><div class="robot-floor"></div><div class="robot"><div class="head"><div class="visor"><i class="eye"></i><i class="eye"></i></div><i class="ear l"></i><i class="ear r"></i></div><div class="body"><div class="core"></div></div><i class="arm l"></i><i class="arm r"></i><i class="leg l"></i><i class="leg r"></i></div></div>
</div>
<section class="providers">
<div class="panel-title"><strong>Provedores de IA</strong><span>LIVE</span></div>
<div class="provider" data-provider="groq"><div class="provider-icon groq">G</div><div><b>Groq</b><small id="groqMeta">—</small></div><div class="provider-status" id="groqStatus">—</div><div class="provider-arrow">›</div></div>
<div class="provider" data-provider="gemini"><div class="provider-icon gemini">✦</div><div><b>Gemini</b><small id="geminiMeta">—</small></div><div class="provider-status" id="geminiStatus">—</div><div class="provider-arrow">›</div></div>
<div class="provider" data-provider="fallback"><div class="provider-icon fallback">◌</div><div><b>Fallback</b><small id="fallbackMeta">—</small></div><div class="provider-status" id="fallbackStatus">—</div><div class="provider-arrow">›</div></div>
</section>
</section>
<section class="metrics">
<div class="metric"><div class="mi">◔</div><h4>Ciclos Totais</h4><strong id="mTurns">0</strong><small>Histórico mantido</small></div>
<div class="metric"><div class="mi">↻</div><h4>Ciclo Atual</h4><strong id="mCycle">—</strong><small id="mCycleSub">—</small></div>
<div class="metric"><div class="mi">✓</div><h4>Tarefas</h4><strong id="mTasks">0</strong><small id="mTasksSub">Pendentes</small></div>
<div class="metric"><div class="mi">♙</div><h4>Workers</h4><strong id="mWorkers">0</strong><small>Ativos</small></div>
<div class="metric"><div class="mi">◷</div><h4>Uptime</h4><strong id="mUptime">—</strong><small>Desde o último boot</small></div>
</section>
<section class="main-grid">
<div class="panel"><div class="panel-title"><strong>Atividade Recente</strong><span id="activityCount">0 eventos</span></div><div class="feed" id="activityFeed"></div></div>
<div class="panel"><div class="panel-title"><strong>Uso de Tokens (Hoje)</strong><span id="tokenToday">0</span></div><div class="usage-line"><div class="usage-row"><span>Groq</span><i><b class="red" id="groqBar"></b></i><em id="groqPct">0%</em></div><div class="usage-row"><span>Gemini</span><i><b class="pink" id="geminiBar"></b></i><em id="geminiPct">0%</em></div><div class="usage-row"><span>Outros</span><i><b id="otherBar"></b></i><em id="otherPct">0%</em></div></div><div class="bars" id="tokenBars"></div></div>
<div class="panel health-panel"><div class="panel-title"><strong>Sistema</strong><span>HEALTH</span></div><div class="health" id="healthList"></div><div class="backoff"><span style="font-size:8px;color:#607b96">BACKOFF GLOBAL</span><strong id="backoffState">—</strong><small id="backoffMeta">—</small></div></div>
</section>
<section class="lower">
<div class="logs"><div class="panel-title"><strong>Logs do Sistema</strong><span id="logCount">—</span></div><div class="log-list" id="logList"></div></div>
<div class="chat"><div class="panel-title"><strong>Chat com RITTY</strong><span>CREATOR CHANNEL ↗</span></div><div class="chat-feed" id="chatFeed"><div class="chat-empty">Mande uma tarefa para o RITTY.</div></div><div class="chat-actions"><button class="quick" data-quick="status">Status do sistema</button><button class="quick" data-quick="task">Criar tarefa</button><button class="quick" data-quick="wake">Acordar RITTY</button><button class="quick" data-quick="tasks">Ver tarefas</button></div><form id="chatForm" class="chat-form"><textarea id="chatInput" maxlength="64000" rows="1" placeholder="Digite um comando para o RITTY..."></textarea><button id="chatSend" class="send" type="submit">➤</button></form><div class="hint" id="chatHint">A tarefa entra na fila do runtime.</div></div>
</section>
<footer class="footer"><span>RITTY <b id="footerVersion">—</b> &nbsp;|&nbsp; Automaton</span><span>Disciplina hoje. Liberdade amanhã.</span><span class="online">● Online</span></footer>
</main>
</div>
</div>
<div class="modal-wrap" id="modalWrap"><div class="modal"><div class="modal-head"><h3 id="modalTitle">RITTY</h3><button class="close" id="modalClose">×</button></div><div class="modal-grid" id="modalBody"></div></div></div>
<script>
let lastData=null;
const $=id=>document.getElementById(id);
const esc=v=>String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function fmtTime(v){try{return new Date(v).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){return "—";}}
function fmtDate(v){try{return new Date(v).toLocaleDateString("pt-BR",{day:"2-digit",month:"short",year:"numeric"});}catch(e){return "—";}}
function fmtUp(sec){if(sec==null)return "—";let s=Math.max(0,Math.floor(sec)),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return d?d+"d "+h+"h":h?h+"h "+m+"m":m+"m";}
function pct(v){return Math.max(0,Math.min(100,Number(v)||0));}
function providerClass(status){return status==="quota_exhausted"||status==="unavailable"?"bad":"";}
function providerLabel(status){return status==="quota_exhausted"?"Quota esgotada":status==="configured"?"Pronto":status==="unavailable"?"Indisponível":"Aguardando";}
function renderBars(history){const max=Math.max(1,...(history||[]).map(x=>Number(x.tokens)||0));$("tokenBars").innerHTML=(history||[]).map(x=>'<div class="bar" style="height:'+Math.max(8,(Number(x.tokens)||0)/max*100)+'%"><span>'+esc(x.label)+'</span></div>').join("")||'<div style="color:#506982;font-size:9px">Sem dados.</div>';}
function renderChat(d){const turns=d.chatTurns||[];$("chatFeed").innerHTML=turns.length?turns.slice(-14).map(t=>'<div class="msg user"><small>'+esc(t.inputSource||"creator")+' · '+esc(fmtTime(t.timestamp))+'</small>'+esc(t.input||"")+'</div><div class="msg agent"><small>RITTY</small>'+esc(t.response||"RITTY processando...")+'</div>').join(""):'<div class="chat-empty">Mande uma tarefa para o RITTY.</div>';$("chatFeed").scrollTop=$("chatFeed").scrollHeight;}
function renderHealth(d){const h=d.system||{};const rows=[["Railway",h.runtimeOk,"Online"],["Banco de Dados",h.dbOk,"SQLite"],["Volume Persistente",h.persistenceOk,"Ativo"],["Rede / APIs",h.networkHint,"Conectada"],["Memória",h.memoryMb+" MB","Uso do processo"]];$("healthList").innerHTML=rows.map(r=>'<div class="health-row"><span>'+esc(r[0])+'</span><b class="'+(r[1]===false?"warn":"")+'">'+esc(String(r[2]||r[1]))+'</b></div>').join("");}
function openModal(title,html){$("modalTitle").textContent=title;$("modalBody").innerHTML=html;$("modalWrap").classList.add("open");}
function renderPanel(kind){const d=lastData||{};if(kind==="dashboard"){window.scrollTo({top:0,behavior:"smooth"});return;}if(kind==="cycles"){const turns=d.recentTurns||[];openModal("Ciclos",turns.map((t,i)=>'<div class="detail"><b>#'+(i+1)+' · '+esc(t.state)+'</b><small>'+esc(fmtTime(t.timestamp))+' · '+esc(t.toolCalls)+' ferramentas · '+esc(t.tokens||0)+' tokens · ID '+esc(t.id)+'</small></div>').join("")||'<div class="detail">Sem ciclos registrados.</div>');}else if(kind==="tasks"){const goals=d.goals||[];const tasks=d.tasks||[];openModal("Tarefas",goals.concat(tasks).slice(0,50).map(x=>'<div class="detail"><b>'+esc(x.title||x.name||"Tarefa")+'</b><small>'+esc(x.status||"")+(x.priority!=null?" · prioridade "+esc(x.priority):"")+(x.assignedTo?" · "+esc(x.assignedTo):"")+'</small></div>').join("")||'<div class="detail">Nenhuma tarefa encontrada.</div>');}else if(kind==="workers"){openModal("Workers",(d.children||[]).map(c=>'<div class="detail"><b>'+esc(c.name)+'</b><small>Status: '+esc(c.status)+'</small></div>').join("")||'<div class="detail"><b>0 workers persistidos</b><small>O pool local aparece no estado das tarefas quando estiver executando.</small></div>');}else if(kind==="tools"){openModal("Ferramentas",(d.recentTools||[]).map(t=>'<div class="detail"><b>'+esc(t.name)+'</b><small>'+esc(t.timestamp)+' · '+esc(t.durationMs==null?"—":t.durationMs+"ms")+(t.failed?" · FALHA":"")+'</small></div>').join("")||'<div class="detail">Sem chamadas recentes.</div>');}else if(kind==="skills"){openModal("Habilidades",(d.skills||[]).map(s=>'<div class="detail"><b>'+esc(s.name)+'</b><small>'+esc(s.description||"")+'</small></div>').join("")||'<div class="detail">Nenhuma habilidade ativa.</div>');}else if(kind==="logs"){openModal("Logs",(d.systemLogs||[]).map(l=>'<div class="detail"><b>'+esc(l.level)+' · '+esc(l.timestamp)+'</b><small>'+esc(l.message)+'</small></div>').join("")||'<div class="detail">Sem logs recentes.</div>');}else if(kind==="settings"){openModal("Configurações",'<div class="detail"><b>Modelo</b><small>'+esc(d.identity&&d.identity.model)+'</small></div><div class="detail"><b>Versão</b><small>'+esc(d.identity&&d.identity.version)+'</small></div><div class="detail"><b>Modo</b><small>'+esc(d.system&&d.system.mode)+'</small></div><div class="detail"><b>Backoff</b><small>'+esc(d.backoffUntil||"Nenhum")+'</small></div>');}}
async function wake(){$("chatHint").textContent="Tentando acordar o RITTY...";try{const r=await fetch("/api/wake",{method:"POST"});const x=await r.json();$("chatHint").textContent=x.message||"Solicitação enviada.";await load();}catch(e){$("chatHint").textContent="Não foi possível acordar o runtime.";}}
async function load(){try{const r=await fetch("/api/dashboard",{cache:"no-store"});if(!r.ok)throw Error();const d=await r.json();lastData=d;const online=!!d.connected;$("topState").textContent=d.runtime&&d.runtime.state==="sleeping"?"Sistema Online · Pausado":"Sistema Online";$("topSub").textContent=d.runtime&&d.runtime.state==="sleeping"?"RITTY está em modo de pausa":"RITTY está operando normalmente";$("topDot").style.background=online?"#1ee59d":"#ff5c6c";$("heroState").textContent=String((d.runtime&&d.runtime.state)||"unknown").toUpperCase();$("heroDetail").textContent=d.backoffUntil?"Proteção de quota ativa. Nenhum novo ciclo será iniciado.":"Operando com controle de ciclo e proteção de quota.";$("mTurns").textContent=(d.metrics&&d.metrics.turnsTotal)||0;$("mCycle").textContent=d.runtime&&d.runtime.state==="sleeping"?"Dormindo":"Ativo";$("mCycleSub").textContent=d.backoffUntil?"Retoma após "+fmtDate(d.backoffUntil)+" · "+fmtTime(d.backoffUntil):"Executando normalmente";const ts=d.taskSummary||{};$("mTasks").textContent=(ts.pending||0)+(ts.running||0)+(ts.assigned||0);$("mTasksSub").textContent=(ts.running||0)+" em execução · "+(ts.pending||0)+" pendentes";$("mWorkers").textContent=(d.metrics&&d.metrics.childrenAlive)||0;$("mUptime").textContent=fmtUp(d.runtime&&d.runtime.uptimeSeconds);$("versionSide").textContent=d.identity&&d.identity.version?"v"+d.identity.version:"—";$("footerVersion").textContent=d.identity&&d.identity.version?"v"+d.identity.version:"—";const p=d.providers||[];for(const x of p){const id=x.id==="groq"?"groq":x.id==="gemini"?"gemini":"fallback";$(id+"Meta").textContent=x.meta||"—";$(id+"Status").textContent=providerLabel(x.status);$(id+"Status").className="provider-status "+providerClass(x.status);}const toks=d.tokens||{};$("tokenToday").textContent=(toks.today||0).toLocaleString("pt-BR")+" tokens";$("groqBar").style.width=pct(toks.groqPct)+"%";$("groqPct").textContent=pct(toks.groqPct)+"%";$("geminiBar").style.width=pct(toks.geminiPct)+"%";$("geminiPct").textContent=pct(toks.geminiPct)+"%";$("otherBar").style.width=pct(toks.otherPct)+"%";$("otherPct").textContent=pct(toks.otherPct)+"%";renderBars(toks.history||[]);const acts=d.recentTurns||[];$("activityCount").textContent=acts.length+" eventos";$("activityFeed").innerHTML=acts.slice(0,8).map(t=>'<div class="feed-row"><span class="fdot '+(t.state==="error"?"bad":"")+'"></span><div><b>Turn '+esc(t.id.slice(0,8))+'</b><small>'+esc(fmtTime(t.timestamp))+' · '+esc(t.state)+'</small></div><em>'+esc(t.toolCalls||0)+' tools</em></div>').join("")||'<div class="chat-empty">Sem atividade recente.</div>';renderHealth(d);renderChat(d);$("backoffState").textContent=d.backoffUntil?"Ativo":"Inativo";$("backoffState").style.color=d.backoffUntil?"#ff9a66":"#54e3ae";$("backoffMeta").textContent=d.backoffUntil?"Próximo ciclo permitido: "+fmtTime(d.backoffUntil)+" · "+fmtDate(d.backoffUntil):"Nenhum bloqueio de quota registrado";const logs=d.systemLogs||[];$("logCount").textContent=logs.length+" registros";$("logList").innerHTML=logs.slice(0,32).map(l=>'<div class="log-line"><span class="log-time">'+esc(fmtTime(l.timestamp))+'</span><span class="log-level '+String(l.level||"info").toLowerCase()+'">['+esc(l.level)+']</span><span class="log-msg">'+esc(l.message)+'</span></div>').join("")||"Sem logs.";}catch(e){$("topState").textContent="Sistema Offline";$("topSub").textContent="Dashboard sem acesso ao runtime";$("topDot").style.background="#ff5c6c";}}
document.querySelectorAll(".nav button").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".nav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");renderPanel(b.dataset.panel);}));
document.querySelectorAll(".provider").forEach(b=>b.addEventListener("click",()=>{const id=b.dataset.provider;const x=(lastData&&lastData.providers||[]).find(p=>p.id===id);openModal(id==="groq"?"Groq":id==="gemini"?"Gemini":"Fallback",'<div class="detail"><b>Status</b><small>'+esc(x?providerLabel(x.status):"—")+'</small></div><div class="detail"><b>Detalhes</b><small>'+esc(x&&x.meta||"Sem dados.")+'</small></div>');}));
document.querySelectorAll(".quick").forEach(b=>b.addEventListener("click",async()=>{const k=b.dataset.quick;if(k==="wake"){await wake();return;}if(k==="tasks"){renderPanel("tasks");return;}if(k==="status"){$("chatInput").value="Mostre o status completo do RITTY, sem executar operações financeiras.";$("chatInput").focus();return;}if(k==="task"){$("chatInput").value="Crie uma tarefa interna de diagnóstico do sistema e aguarde execução.";$("chatInput").focus();return;}}));
$("chatForm").addEventListener("submit",async e=>{e.preventDefault();const input=$("chatInput");const message=input.value.trim();if(!message)return;$("chatSend").disabled=true;$("chatHint").textContent="Enviando para o runtime...";try{const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message})});const x=await r.json();if(!r.ok)throw Error(x.error||"Falha ao enviar");input.value="";$("chatHint").textContent="Enviado. O runtime processará na próxima execução.";await load();}catch(err){$("chatHint").textContent=String(err&&err.message||err);}finally{$("chatSend").disabled=false;input.focus();}});
$("themeBtn").addEventListener("click",()=>{document.documentElement.classList.toggle("alt");localStorage.setItem("ritty-alt",document.documentElement.classList.contains("alt")?"1":"0");});
$("modalClose").addEventListener("click",()=>$("modalWrap").classList.remove("open"));$("modalWrap").addEventListener("click",e=>{if(e.target===$("modalWrap"))$("modalWrap").classList.remove("open")});
setInterval(()=>{const n=new Date();$("clockNow").textContent=n.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});$("dateNow").textContent=fmtDate(n);},1000);
load();setInterval(load,5000);
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

  const rawProviderErrors = db.raw.prepare(
    "SELECT tc.error,t.timestamp FROM tool_calls tc JOIN turns t ON t.id=tc.turn_id WHERE tc.error IS NOT NULL ORDER BY t.timestamp DESC LIMIT 120",
  ).all() as any[];
  const providerErrorText = rawProviderErrors.map((r: any) => String(r.error ?? "")).join("\n");
  const quotaPattern = /429|rate.?limit|quota|resource.?exhausted|tokens per day|tokens per minute|tpd|all providers failed|no providers available/i;
  const groqExhausted = Boolean(process.env.GROQ_API_KEY) && /groq/i.test(providerErrorText) && quotaPattern.test(providerErrorText);
  const geminiExhausted = Boolean(process.env.GEMINI_API_KEY) && /gemini/i.test(providerErrorText) && quotaPattern.test(providerErrorText);

  const tokenRows = db.raw.prepare(
    "SELECT timestamp, token_usage FROM turns WHERE timestamp >= datetime('now','-7 days') ORDER BY timestamp ASC LIMIT 1200",
  ).all() as any[];
  const historyMap: Record<string, number> = {};
  let tokensToday = 0;
  for (const row of tokenRows) {
    const ts = String(row.timestamp ?? "");
    const key = ts.slice(0, 10) || "unknown";
    const tokens = jsonNumber(row.token_usage);
    historyMap[key] = (historyMap[key] ?? 0) + tokens;
    if (key === now.slice(0, 10)) tokensToday += tokens;
  }
  const history = Object.entries(historyMap).slice(-7).map(([key, tokens]) => ({
    label: key.slice(5).replace("-", "/"),
    tokens,
  }));
  const groqDailyLimit = Number(process.env.GROQ_DAILY_TOKENS || 200000);
  const geminiDailyLimit = Number(process.env.GEMINI_DAILY_REQUESTS || 20);
  const providerModels = {
    groq: process.env.RITTY_MODEL || "openai/gpt-oss-120b",
    gemini: process.env.RITTY_GEMINI_FALLBACK_MODEL || "gemini-3.8-flash",
  };
  const providerList = [
    {
      id: "groq",
      status: !process.env.GROQ_API_KEY ? "unavailable" : groqExhausted ? "quota_exhausted" : "configured",
      meta: !process.env.GROQ_API_KEY ? "Chave não configurada" : (groqExhausted ? "Quota/provedor bloqueado" : providerModels.groq),
    },
    {
      id: "gemini",
      status: !process.env.GEMINI_API_KEY ? "unavailable" : geminiExhausted ? "quota_exhausted" : "configured",
      meta: !process.env.GEMINI_API_KEY ? "Chave não configurada" : (geminiExhausted ? "Quota/provedor bloqueado" : providerModels.gemini),
    },
    {
      id: "fallback",
      status: groqExhausted && geminiExhausted ? "quota_exhausted" : "configured",
      meta: groqExhausted && geminiExhausted ? "Aguardando reset automático" : "Ativado automaticamente",
    },
  ];
  const groqPct = groqExhausted ? 100 : Math.min(100, Math.round(tokensToday / Math.max(1, groqDailyLimit) * 100));
  const geminiPct = geminiExhausted ? 100 : Math.min(100, Math.round(tokensToday / Math.max(1, geminiDailyLimit) * 100));
  const otherPct = Math.max(0, 100 - Math.max(groqPct, Math.min(100, geminiPct)));

  const backoffUntil = db.getKV("inference_backoff_until");
  const sleepUntil = db.getKV("sleep_until");
  const dbPath = (process.env.RITTY_DB_PATH || config.dbPath || "").replace(/^~\//, (process.env.HOME || "") + "/");
  const dbOk = Boolean(dbPath && fs.existsSync(dbPath));
  const persistenceOk = Boolean((process.env.HOME || "") && fs.existsSync((process.env.HOME || "") + "/.automaton"));
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const taskSummary: Record<string, number> = { pending: 0, assigned: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  const tasks = tableExists(db, "task_graph")
    ? db.raw.prepare("SELECT id,title,status,assigned_to as assignedTo,priority,created_at as createdAt FROM task_graph ORDER BY created_at DESC LIMIT 40").all() as any[]
    : [];
  for (const t of tasks) taskSummary[String(t.status ?? "pending")] = (taskSummary[String(t.status ?? "pending")] ?? 0) + 1;
  const goals = tableExists(db, "goals")
    ? db.raw.prepare("SELECT id,title,status,created_at as createdAt FROM goals ORDER BY created_at DESC LIMIT 24").all() as any[]
    : [];
  const systemLogs: Array<{timestamp:string;level:string;message:string}> = [];
  const bootAt = db.getKV("runtime_last_boot");
  if (bootAt) systemLogs.push({ timestamp: bootAt, level: "INFO", message: "Runtime inicializado com banco persistente." });
  for (const r of rawProviderErrors.slice(0, 8)) {
    systemLogs.push({ timestamp: String(r.timestamp ?? now), level: "ERROR", message: String(r.error ?? "Falha do provedor").slice(0, 240) });
  }
  if (backoffUntil) systemLogs.unshift({ timestamp: now, level: "WARN", message: "Backoff global ativo até " + backoffUntil + "." });
  if (sleepUntil) systemLogs.unshift({ timestamp: now, level: "WARN", message: "Runtime em pausa até " + sleepUntil + "." });
  for (const t of recentTurns.slice(0, 8)) {
    systemLogs.push({ timestamp: t.timestamp, level: t.state === "error" ? "ERROR" : "INFO", message: "Turn " + t.id.slice(0, 8) + " · " + t.state + " · " + t.toolCalls + " tools" });
  }

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
    chatTurns: db.raw.prepare("SELECT id,timestamp,input,input_source,thinking,tool_calls,state FROM turns WHERE input_source IN ('creator','agent') AND input IS NOT NULL ORDER BY timestamp DESC LIMIT 24").all().map((row: any) => ({
      id: String(row.id),
      timestamp: String(row.timestamp),
      input: String(row.input ?? ""),
      inputSource: String(row.input_source ?? "agent"),
      response: (() => {
        const thinking = String(row.thinking ?? "").trim();
        if (thinking) return thinking;
        try {
          const tools = JSON.parse(String(row.tool_calls || "[]"));
          if (Array.isArray(tools) && tools.length) {
            const successful = tools.filter((tool: any) => !tool?.error);
            const last = successful[successful.length - 1] ?? tools[tools.length - 1];
            const result = typeof last?.result === "string" ? last.result.trim() : "";
            if (result) return result.slice(0, 12000);
            return `Concluído — ${tools.length} ferramenta(s) executada(s).`;
          }
        } catch {}
        return row.state === "error" ? "Falha ao processar esta tarefa." : "Tarefa concluída.";
      })(),
      toolCalls: (() => {
        try {
          const tools = JSON.parse(String(row.tool_calls || "[]"));
          return Array.isArray(tools) ? tools.map((tool: any) => ({
            name: String(tool?.name ?? "unknown"),
            arguments: tool?.arguments ?? {},
            result: typeof tool?.result === "string" ? tool.result.slice(0, 12000) : tool?.result ?? null,
            error: tool?.error ?? null,
          })) : [];
        } catch {
          return [];
        }
      })(),
    })).reverse(),
    providers: providerList,
    tokens: { today: tokensToday, groqPct, geminiPct, otherPct, history, dailyGroqLimit: groqDailyLimit, dailyGeminiLimit: geminiDailyLimit },
    system: { runtimeOk: true, dbOk, persistenceOk, networkHint: providerList.some((p) => p.status === "configured"), memoryMb, mode: process.env.RITTY_MODE || "standard" },
    taskSummary,
    tasks,
    goals,
    systemLogs,
    backoffUntil: backoffUntil || null,
    sleepUntil: sleepUntil || null,
    chatPending: (() => {
      const row = db.raw.prepare("SELECT id,content,status,received_at,retry_count,max_retries FROM inbox_messages WHERE from_address = ? ORDER BY received_at DESC LIMIT 1").get("dashboard://creator") as any;
      const active = db.getKV("creator_task_active");
      if (!row && !active) return null;
      return {
        id: String(row?.id ?? "active-creator-task"),
        content: String(row?.content ?? active ?? ""),
        status: active && (!row || row.status === "processed") ? "in_progress" : String(row?.status ?? "received"),
        receivedAt: String(row?.received_at ?? ""),
        retryCount: Number(row?.retry_count ?? 0),
        maxRetries: Number(row?.max_retries ?? 3),
      };
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

    if (pathname === "/api/wake" && req.method === "POST") {
      try {
        const backoff = db.getKV("inference_backoff_until");
        const ts = backoff ? Date.parse(backoff) : NaN;
        if (Number.isFinite(ts) && ts > Date.now()) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Backoff ainda ativo até " + backoff + ". O runtime não será forçado a consumir quota." }));
          return;
        }
        db.deleteKV("sleep_until");
        db.setAgentState("waking");
        db.raw.prepare("INSERT INTO wake_events (source, reason, payload) VALUES (?, ?, ?)").run("dashboard", "manual wake", JSON.stringify({}));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, message: "RITTY acordado. O próximo ciclo disponível será processado pelo runtime." }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "Não foi possível acordar o runtime." }));
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
