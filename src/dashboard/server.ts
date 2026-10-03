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
@media(max-width:620px){.room-header{padding:0 13px;height:56px}.tiny{display:none}.ops-room{padding:10px 8px}.back-wall{height:300px}.main-screen{width:68%;left:16%;height:195px;top:58px;padding:13px 14px}.screen-value{font-size:36px;margin-top:17px}.screen-chart{height:50px}.side-screen{display:none}.floor{height:360px;transform:perspective(850px) rotateX(53deg) scale(.97)}.desk{transform:scale(.53) translateZ(25px)}.center-console{transform:translate(-50%,-50%) translateZ(30px) scale(.68)}.floor-caption{font-size:7px;bottom:15px;white-space:nowrap}.bottom-panel{padding:0 8px 18px;gap:10px}.panel-card{padding:12px}.feed,.chat-feed{max-height:210px}.chat-form{grid-template-columns:1fr 76px}.chat-form button{padding:0 10px;font-size:0}.chat-form button b{font-size:17px}.mobile-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:0 8px 16px}.mobile-metrics>div{border:1px solid rgba(255,255,255,.08);background:#0c1016;border-radius:12px;padding:9px}.mobile-metrics span{display:block;font-size:8px;color:#68717d;letter-spacing:.12em}.mobile-metrics b{display:block;margin-top:4px;font-size:13px}}
/* ─────────────────────────────────────────────────────────────
   RITTY 3D OPERATIONS FLOOR — immersive office
   Pure CSS/HTML so it works on Railway without extra assets.
   ───────────────────────────────────────────────────────────── */
body{background:#05070a}
.ops-room{max-width:1540px;padding-top:18px}
.back-wall{height:390px;background:linear-gradient(180deg,#0b1118 0%,#111b24 55%,#071016 100%);border-color:rgba(96,214,255,.22);box-shadow:inset 0 -80px 120px rgba(0,0,0,.55)}
.back-wall:before,.back-wall:after{width:24%;opacity:.7;background:linear-gradient(90deg,rgba(1,5,10,.96),rgba(20,40,52,.18),rgba(1,5,10,.96))}
.wall-topline{color:#7c96a7}
.wall-grid-lines{background:linear-gradient(rgba(99,219,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(99,219,255,.025) 1px,transparent 1px);background-size:48px 48px}
.wall-screen{border-color:#2b6676;background:linear-gradient(145deg,#071319,#071f28);box-shadow:0 0 0 1px rgba(103,225,255,.12),0 24px 45px rgba(0,0,0,.48),inset 0 0 30px rgba(67,222,255,.08)}
.main-screen{height:246px;top:73px;padding:18px 22px}
.screen-value{color:#67efff;text-shadow:0 0 28px rgba(103,239,255,.38)}
.screen-chart i{background:linear-gradient(to top,rgba(67,222,255,.05),rgba(67,222,255,.72))}
.side-screen strong{color:#74e8ff}

/* Main 3D viewport */
.floor{height:545px;margin-top:-2px;position:relative;overflow:hidden;
  background:
    radial-gradient(ellipse at 50% 54%,rgba(60,227,255,.12),transparent 33%),
    linear-gradient(145deg,#27313a 0%,#1c242b 48%,#12191f 100%);
  border:1px solid rgba(100,221,255,.28);
  box-shadow:0 0 0 4px rgba(76,210,255,.04),0 35px 90px rgba(0,0,0,.62);
  transform:perspective(1200px) rotateX(50deg) scale(.97);
  transform-origin:top center;transform-style:preserve-3d;
}
.floor:before{content:"";position:absolute;inset:-20%;
  background:
    linear-gradient(90deg,rgba(91,226,255,.08) 1px,transparent 1px),
    linear-gradient(rgba(91,226,255,.06) 1px,transparent 1px);
  background-size:52px 52px;transform:translateZ(0);pointer-events:none}
.floor:after{content:"";position:absolute;left:7%;right:7%;top:10%;height:2px;background:linear-gradient(90deg,transparent,rgba(99,228,255,.7),transparent);box-shadow:0 0 24px rgba(99,228,255,.45);transform:translateZ(2px)}

.office-shell{position:absolute;inset:0;transform-style:preserve-3d}
.room-back, .room-side, .room-window, .ceiling-beam{position:absolute;transform-style:preserve-3d;pointer-events:none}
.room-back{left:6%;right:6%;top:7%;height:62%;background:linear-gradient(180deg,#0a1219,#101d25);border:1px solid rgba(113,224,255,.16);transform:translateZ(14px);box-shadow:inset 0 0 80px rgba(0,0,0,.42)}
.room-back:after{content:"";position:absolute;inset:16px;background:linear-gradient(180deg,rgba(85,219,255,.025),transparent);border:1px solid rgba(85,219,255,.05)}
.room-side{width:12%;height:62%;top:7%;background:linear-gradient(165deg,#101a22,#050a0e);border:1px solid rgba(94,204,234,.1);transform:translateZ(15px) rotateY(62deg);transform-origin:left center}
.room-side.left{left:0}.room-side.right{right:0;transform-origin:right center;transform:translateZ(15px) rotateY(-62deg)}
.room-window{left:20%;right:20%;top:10%;height:38%;background:linear-gradient(180deg,#061a2a,#071e2d 55%,#030b12);border:1px solid rgba(107,223,255,.25);box-shadow:inset 0 0 55px rgba(71,202,255,.12),0 0 24px rgba(71,202,255,.08);transform:translateZ(23px)}
.room-window:before{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 0 38%,rgba(150,236,255,.12) 40%,transparent 42%),linear-gradient(90deg,transparent 0 49%,rgba(110,222,255,.16) 50%,transparent 51%)}
.room-window:after{content:"RITTY  //  AUTONOMOUS OPERATIONS";position:absolute;right:16px;bottom:11px;color:rgba(130,224,255,.55);font-size:8px;letter-spacing:.15em}
.ceiling-beam{top:7%;height:4px;width:30%;background:linear-gradient(90deg,transparent,#62e7ff,transparent);box-shadow:0 0 22px rgba(98,231,255,.6);transform:translateZ(44px)}
.ceiling-beam.b1{left:11%}.ceiling-beam.b2{left:35%;width:30%}.ceiling-beam.b3{right:11%}

.office-title{position:absolute;left:50%;top:8%;transform:translate(-50%,-50%) translateZ(38px);color:#d8f8ff;font-size:18px;font-weight:900;letter-spacing:.25em;text-shadow:0 0 24px rgba(100,231,255,.35);white-space:nowrap}
.office-subtitle{position:absolute;left:50%;top:12%;transform:translate(-50%,-50%) translateZ(35px);font-size:7px;letter-spacing:.32em;color:#5d8999;white-space:nowrap}

.holo-ring{position:absolute;left:50%;top:43%;width:310px;height:180px;transform:translate(-50%,-50%) translateZ(48px);border:1px solid rgba(98,236,255,.16);border-radius:50%;box-shadow:0 0 35px rgba(98,236,255,.08);animation:holoFloat 5s ease-in-out infinite}
.holo-ring:before,.holo-ring:after{content:"";position:absolute;inset:19px;border:1px solid rgba(113,224,255,.12);border-radius:50%;transform:rotateX(62deg) rotateZ(18deg)}
.holo-ring:after{inset:38px;transform:rotateX(68deg) rotateZ(-21deg)}
.holo-core{position:absolute;left:50%;top:38%;width:85px;height:85px;transform:translate(-50%,-50%) translateZ(78px);border-radius:42% 58% 52% 48%/54% 42% 58% 46%;background:radial-gradient(circle at 35% 30%,#c8fbff 0,#62e7ff 18%,#14728a 55%,rgba(5,20,25,.1) 78%);box-shadow:0 0 25px rgba(98,231,255,.7),0 0 85px rgba(98,231,255,.25);animation:corePulse 3.8s ease-in-out infinite;transform-style:preserve-3d}
.holo-core:before{content:"";position:absolute;inset:-15px;border:1px solid rgba(129,237,255,.5);border-radius:50%;transform:rotateX(69deg) rotateY(14deg);box-shadow:0 0 18px rgba(129,237,255,.35)}
.holo-core:after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;transform:translate(-50%,-50%);border-radius:50%;background:#efffff;box-shadow:0 0 20px 8px rgba(155,245,255,.65)}

.workstation{position:absolute;width:235px;height:140px;transform-style:preserve-3d}
.ws-left{left:7%;top:40%;transform:translateZ(52px) rotateY(8deg)}
.ws-right{right:7%;top:40%;transform:translateZ(52px) rotateY(-8deg)}
.ws-back-left{left:10%;bottom:4%;transform:translateZ(35px) rotateY(5deg) scale(.9)}
.ws-back-right{right:10%;bottom:4%;transform:translateZ(35px) rotateY(-5deg) scale(.9)}
.ws-desk{position:absolute;left:0;right:0;bottom:0;height:62px;background:linear-gradient(150deg,#39434a,#161d23);border:1px solid rgba(145,214,228,.22);box-shadow:0 12px 0 #0a0f14,0 24px 28px rgba(0,0,0,.48);transform:translateZ(10px)}
.ws-top{position:absolute;left:35px;right:35px;top:6px;height:13px;background:linear-gradient(180deg,#5f737b,#263238);border:1px solid rgba(171,230,239,.18);transform:translateZ(22px);box-shadow:0 8px 0 #1b252b}
.ws-monitor{position:absolute;left:54px;top:-42px;width:126px;height:64px;background:linear-gradient(155deg,#061419,#081e24);border:2px solid #2f7e91;box-shadow:0 0 0 1px rgba(102,231,255,.12),0 0 24px rgba(102,231,255,.08);transform:translateZ(34px);padding:9px 10px}
.ws-monitor b{display:block;font-size:9px;letter-spacing:.12em;color:#d4f6ff}
.ws-monitor small{display:block;margin-top:11px;color:#5fe6ff;font-size:8px}
.ws-monitor i{position:absolute;left:7px;right:7px;top:36px;height:1px;background:rgba(102,231,255,.72);box-shadow:0 0 8px rgba(102,231,255,.9);animation:scanMonitor 2.4s ease-in-out infinite}
.ws-chair{position:absolute;left:84px;bottom:-37px;width:62px;height:36px;background:#11171c;border:1px solid #38444b;border-radius:10px 10px 4px 4px;transform:translateZ(9px)}
.bot{position:absolute;left:100px;top:51px;width:31px;height:42px;transform:translateZ(36px);transform-style:preserve-3d}
.bot-head{position:absolute;left:2px;top:0;width:27px;height:27px;border-radius:42%;background:linear-gradient(145deg,#b9fbff,#1b7688);border:1px solid rgba(190,255,255,.52);box-shadow:0 0 24px rgba(98,231,255,.36)}
.bot-head:before{content:"";position:absolute;left:6px;right:6px;top:10px;height:4px;border-radius:999px;background:#041115;box-shadow:0 0 7px #63eaff}
.bot-head:after{content:"";position:absolute;left:11px;top:-10px;width:5px;height:10px;border-radius:999px;background:#63eaff;box-shadow:0 0 12px #63eaff}
.bot-body{position:absolute;left:5px;top:26px;width:21px;height:17px;border-radius:6px;background:linear-gradient(145deg,#6bcddd,#143842);border:1px solid rgba(181,247,255,.25);box-shadow:0 7px 13px rgba(0,0,0,.25)}
.bot-body:after{content:"";position:absolute;left:8px;top:5px;width:5px;height:5px;border-radius:50%;background:#bffbff;box-shadow:0 0 9px #bffbff}
.data-stream{position:absolute;right:30px;top:17%;width:120px;height:180px;transform:translateZ(40px);opacity:.5}
.data-stream span{display:block;height:2px;margin:12px 0;background:linear-gradient(90deg,transparent,#66e8ff);animation:dataFlow 2.8s linear infinite}
.data-stream span:nth-child(2){width:82%;margin-left:18%}.data-stream span:nth-child(3){width:68%}.data-stream span:nth-child(4){width:92%;margin-left:8%}.data-stream span:nth-child(5){width:57%;margin-left:31%}.data-stream span:nth-child(6){width:76%}

.rack{position:absolute;width:82px;height:160px;bottom:11%;transform:translateZ(39px);background:linear-gradient(145deg,#11191f,#05090d);border:1px solid rgba(122,204,220,.2);box-shadow:14px 18px 26px rgba(0,0,0,.4)}
.rack.left{left:2%}.rack.right{right:2%}
.rack h4{margin:9px 8px 5px;font-size:7px;color:#6e98a4;letter-spacing:.14em}
.rack .rack-unit{height:16px;margin:5px 7px;border:1px solid rgba(93,219,255,.11);background:#091117;position:relative}
.rack .rack-unit:after{content:"";position:absolute;right:7px;top:6px;width:4px;height:4px;border-radius:50%;background:#60eaff;box-shadow:0 0 8px #60eaff}
.rack .rack-unit i{display:block;width:38%;height:1px;margin:7px 0 0 6px;background:#345764}

.stat-puck{position:absolute;padding:7px 10px;border:1px solid rgba(117,224,255,.16);background:rgba(4,11,15,.72);border-radius:999px;backdrop-filter:blur(8px);font-size:8px;letter-spacing:.08em;color:#7ea4b1;transform:translateZ(52px)}
.p1{left:29%;bottom:15%}.p2{right:29%;bottom:15%}
.stat-puck b{color:#d5f8ff;margin-left:5px}

.floor-caption{bottom:18px;background:rgba(2,8,11,.82);border-color:rgba(113,224,255,.18)}
.pill-live{color:#62eaff}.pill-live i{background:#62eaff;box-shadow:0 0 10px #62eaff}

@keyframes holoFloat{0%,100%{transform:translate(-50%,-50%) translateZ(48px) rotateZ(-2deg)}50%{transform:translate(-50%,-52%) translateZ(56px) rotateZ(2deg)}}
@keyframes corePulse{0%,100%{filter:saturate(.95);transform:translate(-50%,-50%) translateZ(78px) scale(.93) rotate(0)}50%{filter:saturate(1.35);transform:translate(-50%,-52%) translateZ(88px) scale(1.08) rotate(10deg)}}
@keyframes scanMonitor{0%,100%{top:35px;opacity:.45}50%{top:53px;opacity:1}}
@keyframes dataFlow{0%{transform:translateX(-18px);opacity:0}25%{opacity:.9}100%{transform:translateX(30px);opacity:0}}

@media(max-width:900px){
  .back-wall{height:350px}.floor{height:470px}
  .workstation{transform:scale(.78) translateZ(44px)}.ws-right{right:-1%}.ws-left{left:-1%}
  .ws-back-left{left:0}.ws-back-right{right:0}
  .rack{transform:translateZ(31px) scale(.8)}.data-stream{right:8px}
}
@media(max-width:620px){
  .back-wall{height:280px}.main-screen{width:70%;left:15%;height:180px;top:56px}.screen-value{font-size:34px}
  .floor{height:370px;transform:perspective(900px) rotateX(54deg) scale(.98)}
  .office-title{font-size:12px;top:8%}.office-subtitle{font-size:6px}
  .workstation{transform:scale(.55) translateZ(38px)}.ws-left{left:-8%;top:41%}.ws-right{right:-8%;top:41%}
  .ws-back-left{left:-3%;bottom:0}.ws-back-right{right:-3%;bottom:0}
  .holo-ring{width:250px;height:150px}.holo-core{width:70px;height:70px}
  .rack{display:none}.data-stream{display:none}.stat-puck{font-size:7px}.p1{left:18%;bottom:19%}.p2{right:18%;bottom:19%}
  .floor-caption{font-size:7px}
}


/* Habbo-inspired pixel office: framed, tile-based room */
.command-room{background:#101820}
.ops-room{max-width:1260px;padding:18px 18px 10px}
.back-wall{height:310px;border:4px solid #253947;border-bottom:0;background:linear-gradient(180deg,#91b9c8 0%,#b8d2d4 58%,#637f89 59%,#344b56 100%);box-shadow:inset 0 0 0 5px #45616d,inset 0 -22px 0 rgba(13,28,38,.24)}
.back-wall:before,.back-wall:after{width:12%;opacity:1;background:linear-gradient(90deg,#304753,#78939b 48%,#304753);border-left:4px solid #243b46;border-right:4px solid #243b46}
.wall-topline{color:#1b3440;font-weight:900;text-shadow:0 1px #d8e9e9}
.wall-grid-lines{opacity:.25;background-size:32px 32px}
.wall-screen{border:4px solid #293d47;border-radius:0;background:#172c35;box-shadow:inset 0 0 0 3px #66838c,5px 6px 0 rgba(16,32,42,.55)}
.main-screen{height:205px;top:66px;padding:14px 16px}
.screen-value{font-size:43px;color:#8ff6dc;text-shadow:2px 2px #1d554d}
.screen-chart{height:55px}
.side-screen{height:100px;top:120px;padding:10px 12px}
.side-screen strong{font-size:21px}
.floor{height:440px;margin-top:0;transform:none;transform-origin:center;background-color:#b6a48b;
 background-image:linear-gradient(30deg,transparent 48%,rgba(67,50,40,.2) 49%,rgba(67,50,40,.2) 51%,transparent 52%),linear-gradient(150deg,transparent 48%,rgba(67,50,40,.2) 49%,rgba(67,50,40,.2) 51%,transparent 52%),linear-gradient(180deg,#d5c6a7,#9d8c75);
 background-size:52px 30px,52px 30px,100% 100%;
 border:5px solid #293d47;box-shadow:inset 0 0 0 5px #d8c7a3,0 8px 0 #18262d,0 22px 45px rgba(0,0,0,.4);perspective:1000px}
.floor:before{inset:0;background-image:linear-gradient(30deg,transparent 48.5%,rgba(81,63,47,.32) 49%,rgba(81,63,47,.32) 51%,transparent 51.5%),linear-gradient(150deg,transparent 48.5%,rgba(81,63,47,.32) 49%,rgba(81,63,47,.32) 51%,transparent 51.5%);background-size:52px 30px;opacity:.9}
.floor:after{display:none}
.floor-border{inset:5px;border:4px solid #5a4937;box-shadow:inset 0 0 0 3px #e3d2af}
.office-shell{inset:0;transform-style:preserve-3d}
.room-back{left:7%;right:7%;top:4%;height:34%;background:linear-gradient(180deg,#c2d9d8,#91b5b7 80%,#6c929b);border:5px solid #526b70;box-shadow:inset 0 -10px #718e91,5px 6px 0 rgba(45,53,50,.3);transform:none}
.room-back:after{inset:10px;border:3px solid rgba(58,83,88,.45);background:repeating-linear-gradient(90deg,transparent 0 48px,rgba(65,91,95,.15) 49px 52px)}
.room-side{width:8%;height:36%;top:4%;background:linear-gradient(90deg,#718c8d,#b4cbbe);border:4px solid #526b70;transform:none;box-shadow:inset 0 0 0 4px rgba(226,232,209,.35)}
.room-side.left{left:0}.room-side.right{right:0;transform:none}
.room-window{left:26%;right:26%;top:7%;height:25%;background:linear-gradient(180deg,#74b8d4,#c1e4e2 75%,#6b9298);border:5px solid #475e66;box-shadow:inset 0 0 0 4px #d2d8c6,5px 6px 0 rgba(45,53,50,.28);transform:none}
.room-window:before{background:linear-gradient(90deg,transparent 47%,#526d73 48% 52%,transparent 53%),linear-gradient(180deg,transparent 45%,#526d73 46% 52%,transparent 53%)}
.room-window:after{color:#254550;font-size:8px;font-weight:900}
.ceiling-beam{display:none}
.office-title{top:3%;font-size:13px;letter-spacing:.12em;color:#f8f2d8;text-shadow:2px 2px #40545a,3px 3px #253840;transform:translate(-50%,-50%)}
.office-subtitle{top:7%;font-size:7px;letter-spacing:.15em;color:#294b55;transform:translate(-50%,-50%)}
.holo-ring,.holo-core{display:none}
.workstation{width:170px;height:110px;transform-style:flat;filter:drop-shadow(5px 7px 0 rgba(47,38,30,.22))}
.ws-left{left:13%;top:40%;transform:none}.ws-right{right:13%;top:40%;transform:none}
.ws-back-left{left:17%;bottom:5%;transform:none}.ws-back-right{right:17%;bottom:5%;transform:none}
.ws-desk{left:0;right:0;bottom:0;height:44px;background:linear-gradient(180deg,#b17b4b 0 20%,#87552f 21% 100%);border:4px solid #68462e;box-shadow:inset 0 4px #d8a16a,0 8px 0 #583b2a;transform:none;border-radius:0}
.ws-top{left:20px;right:20px;top:13px;height:12px;background:#d4a06c;border:3px solid #80552f;transform:none;box-shadow:none}
.ws-monitor{left:43px;top:-25px;width:84px;height:49px;background:#243c46;border:4px solid #536c70;box-shadow:inset 0 0 0 3px #111f26;transform:none;padding:5px}
.ws-monitor b{font-size:7px;color:#e6ead7}.ws-monitor small{font-size:7px;margin-top:5px;color:#77f0c9}.ws-monitor i{left:5px;right:5px;top:22px}
.ws-chair{left:60px;bottom:-27px;width:42px;height:25px;background:#547d83;border:4px solid #344e59;border-radius:0;transform:none;box-shadow:0 5px 0 #293e47}
.bot{left:70px;top:31px;width:28px;height:38px;transform:none}
.bot-head{left:0;top:0;width:27px;height:22px;border-radius:3px;background:linear-gradient(180deg,#f2c69d 0 65%,#6b4539 66%);border:3px solid #604a42;box-shadow:2px 3px 0 rgba(0,0,0,.25)}
.bot-head:before{left:5px;right:5px;top:8px;height:4px;border-radius:0;background:#26323a;box-shadow:0 0 0 1px #e9f4e9}
.bot-head:after{display:none}
.bot-body{left:3px;top:21px;width:22px;height:17px;border-radius:2px;background:linear-gradient(90deg,#4b87a0 0 25%,#c6e1d9 26% 74%,#4b87a0 75%);border:2px solid #465c61;box-shadow:2px 3px 0 rgba(0,0,0,.22)}
.bot-body:after{left:7px;top:4px;width:4px;height:4px;border-radius:0;background:#f7e5a6;box-shadow:none}
.rack{width:54px;height:110px;bottom:7%;background:#6f7772;border:4px solid #46565a;box-shadow:5px 6px 0 rgba(47,38,30,.28);transform:none}
.rack.left{left:3%}.rack.right{right:3%}.rack h4{font-size:6px;color:#e8e2ca}.rack .rack-unit{height:11px;margin:4px 4px;background:#2b4147;border:2px solid #89918a}.rack .rack-unit:after{right:4px;top:3px;width:4px;height:4px}
.data-stream{display:none}
.stat-puck{border:3px solid #45575b;border-radius:0;background:#253a40;color:#b8d2cb;box-shadow:3px 4px 0 rgba(0,0,0,.28);font-size:7px;transform:none}
.stat-puck b{color:#f1d780}.p1{left:36%;bottom:8%}.p2{right:36%;bottom:8%}
.floor-caption{bottom:8px;border:3px solid #45575b;border-radius:0;background:#263b41;color:#e1e5d2;box-shadow:3px 4px 0 rgba(0,0,0,.3);transform:translateX(-50%);font-size:8px}
@media(max-width:620px){
 .ops-room{padding:8px 7px}.back-wall{height:245px}
 .main-screen{width:68%;left:16%;height:160px;top:48px;padding:10px}
 .screen-value{font-size:29px}.screen-chart{height:38px}
 .floor{height:385px;transform:none}
 .office-title{font-size:9px;top:3%}.office-subtitle{font-size:5px;top:7%}
 .room-window{left:24%;right:24%;height:22%}
 .workstation{transform:scale(.68);transform-origin:top left}
 .ws-left{left:1%;top:38%}.ws-right{right:-4%;top:38%;transform:scale(.68);transform-origin:top right}
 .ws-back-left{left:2%;bottom:8%;transform:scale(.62);transform-origin:bottom left}
 .ws-back-right{right:1%;bottom:8%;transform:scale(.62);transform-origin:bottom right}
 .rack{display:none}.stat-puck{font-size:6px;padding:5px}.p1{left:28%;bottom:17%}.p2{right:28%;bottom:17%}
 .floor-caption{bottom:5px;font-size:6px;gap:6px;padding:5px 7px}
}
@media(prefers-reduced-motion:reduce){.scan,.bot-head,.holo-ring,.holo-core{animation:none!important}}

</style>
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
      <div class="floor-border"></div>
      <div class="office-shell">
        <div class="room-back"></div>
        <div class="room-side left"></div><div class="room-side right"></div>
        <div class="room-window"></div>
        <div class="ceiling-beam b1"></div><div class="ceiling-beam b2"></div><div class="ceiling-beam b3"></div>
        <div class="office-title">RITTY OPERATIONS FLOOR</div>
        <div class="office-subtitle">AUTONOMOUS INTELLIGENCE · LIVE CONTROL</div>

        <div class="holo-ring"></div><div class="holo-core"></div>

        <div class="workstation ws-left">
          <div class="ws-monitor"><i></i><b>WORKER A</b><small id="agentA">IDLE</small></div>
          <div class="ws-top"></div><div class="ws-desk"></div><div class="ws-chair"></div>
          <div class="bot"><div class="bot-head"></div><div class="bot-body"></div></div>
        </div>

        <div class="workstation ws-right">
          <div class="ws-monitor"><i></i><b>WORKER B</b><small id="agentB">IDLE</small></div>
          <div class="ws-top"></div><div class="ws-desk"></div><div class="ws-chair"></div>
          <div class="bot"><div class="bot-head"></div><div class="bot-body"></div></div>
        </div>

        <div class="workstation ws-back-left">
          <div class="ws-monitor"><i></i><b>WORKER C</b><small id="agentC">IDLE</small></div>
          <div class="ws-top"></div><div class="ws-desk"></div><div class="ws-chair"></div>
          <div class="bot"><div class="bot-head"></div><div class="bot-body"></div></div>
        </div>

        <div class="workstation ws-back-right">
          <div class="ws-monitor"><i></i><b>WORKER D</b><small id="agentD">IDLE</small></div>
          <div class="ws-top"></div><div class="ws-desk"></div><div class="ws-chair"></div>
          <div class="bot"><div class="bot-head"></div><div class="bot-body"></div></div>
        </div>

        <div class="rack left"><h4>NODE A</h4><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div></div>
        <div class="rack right"><h4>NODE B</h4><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div><div class="rack-unit"><i></i></div></div>

        <div class="data-stream"><span></span><span></span><span></span><span></span><span></span><span></span></div>

        <div class="stat-puck p1">RUNTIME <b id="consoleState">ONLINE</b></div>
        <div class="stat-puck p2">SKILLS <b id="consoleSkills">0</b> · HB <b id="consoleHB">0</b></div>

        <div class="floor-caption"><span>OPERATIONS</span><span class="pill-live"><i></i> LIVE</span><span id="floorMeta">0 cycles · 0 skills</span></div>
      </div>
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
    if(d.chatPending && d.chatPending.status === "failed"){ $("chatHint").textContent="RITTY não conseguiu executar esta tarefa. A tentativa máxima foi atingida."; }
    else if(d.chatPending && d.chatPending.status === "received"){ $("chatHint").textContent="Tarefa na fila — aguardando a próxima execução do RITTY."; }
    else if(d.chatPending && d.chatPending.status === "in_progress"){ $("chatHint").textContent="RITTY está processando esta tarefa agora…"; }
    else if(d.chatPending && d.chatPending.status === "processed"){ $("chatHint").textContent="Tarefa processada pelo RITTY."; }
  }catch(e){$("roomStatus").textContent="OFFLINE";}
}
$("chatForm").addEventListener("submit",async e=>{
  e.preventDefault(); const input=$("chatInput"); const message=input.value.trim(); if(!message)return;
  $("chatSend").disabled=true; $("chatHint").textContent="Enviando para o runtime…";
  try{
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message})});
    const d=await r.json(); if(!r.ok) throw Error(d.error||"Falha ao enviar");
    input.value=""; $("chatHint").textContent="Enviado ao runtime. Acompanhe o estado abaixo."; await load();
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
