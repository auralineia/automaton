import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AutomatonDatabase } from "../types.js";
import { URL } from "node:url";
import {
  ensureRevenueCommerceSchema,
  revenueMetrics,
  approveOutreach,
  sendApprovedOutreach,
  recordLeadResponse,
  approveCheckout,
  createStripeCheckout,
  fulfillPaidOrder,
  handleStripeWebhook,
  confirmStripeSuccess,
  buildFinalSite,
} from "../revenue/commerce.js";
import { revenueAutopilotCycle } from "../revenue/engine.js";

function readBody(req: http.IncomingMessage, maxBytes = 70000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function authorized(req: http.IncomingMessage): boolean {
  const expected = process.env.RITTY_REVENUE_APPROVAL_TOKEN;
  if (!expected) return false;
  return String(req.headers.authorization || "") === "Bearer " + expected;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export async function handleRevenueRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: AutomatonDatabase,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  const handled =
    pathname.startsWith("/sites/") ||
    pathname === "/revenue/test-site" ||
    pathname === "/revenue" ||
    pathname === "/api/revenue" ||
    pathname.startsWith("/api/revenue/") ||
    pathname === "/webhooks/stripe" ||
    pathname === "/revenue/success" ||
    pathname === "/revenue/cancelled";

  if (!handled) return false;

  if (pathname === "/revenue/test-site" && req.method === "GET") {
    const lead = {
      name: "Ateliê Bella Guarujá",
      opportunity: "Salão de beleza feminino premium no Guarujá, com foco em beleza, autocuidado e experiência.",
      phone: "+5513999999999",
      email: "contato@ateliebellaguaruja.test",
    };
    const built = buildFinalSite(lead);
    const requested = url.searchParams.get("file") || "index.html";
    const file = built.files.find((item) => item.path === requested);
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Test file not found");
      return true;
    }
    const type = requested.endsWith(".css") ? "text/css; charset=utf-8" :
      requested.endsWith(".js") ? "text/javascript; charset=utf-8" :
      "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(file.content);
    return true;
  }

  if (pathname.startsWith("/sites/") && req.method === "GET") {
    const match = pathname.match(/^\/sites\/([A-Za-z0-9_-]+)\/?(.*)$/);
    const fulfillmentId = match?.[1] || "";
    const requested = match?.[2] || "index.html";
    const allowed = new Set(["index.html", "style.css", "script.js"]);
    const fileName = allowed.has(requested) ? requested : "";
    if (!fulfillmentId || !fileName) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Not found");
      return true;
    }
    const root = path.join(process.env.RITTY_REVENUE_ROOT || "/root/.automaton/revenue", "fulfillments");
    const target = path.join(root, fulfillmentId, fileName);
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid path");
      return true;
    }
    try {
      const body = fs.readFileSync(target);
      const type = fileName.endsWith(".css") ? "text/css; charset=utf-8" :
        fileName.endsWith(".js") ? "text/javascript; charset=utf-8" :
        "text/html; charset=utf-8";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Site not found");
    }
    return true;
  }

  ensureRevenueCommerceSchema(db);

  if (pathname === "/revenue" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(`<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#070707">
<title>RITTY — Revenue Command Center</title>
<style>
:root{--bg:#070707;--panel:#101010;--line:#252525;--text:#f7f5ef;--muted:#8d8981;--gold:#f4c64f;--green:#4ee0a5;--red:#ff6876}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(650px 350px at 100% 0,#2b2308,transparent 62%),var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif}
main{max-width:1180px;margin:auto;padding:20px 15px 60px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}.ey{font-size:10px;letter-spacing:.2em;color:var(--gold);font-weight:900}.title{font-size:clamp(32px,5vw,48px);line-height:.98;letter-spacing:-.055em;font-weight:900;margin:8px 0}.sub{color:var(--muted);font-size:13px;line-height:1.5;max-width:680px}.actions{display:flex;gap:8px}.btn{border:1px solid #4a3c16;background:#181305;color:#ffe18a;padding:11px 14px;border-radius:12px;font-weight:850;cursor:pointer}.btn.secondary{background:#0c121a;border-color:#2a425d;color:#b9d2ef}.status{display:flex;align-items:center;gap:7px;color:#858178;font-size:10px;margin-top:9px}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}
.creator,.panel{background:#0d0d0d;border:1px solid var(--line);border-radius:17px}.creator{padding:15px;margin-bottom:13px}.creatorHead,.panelHead{display:flex;justify-content:space-between;align-items:center;gap:10px}.creatorTitle{font-size:10px;letter-spacing:.2em;color:var(--gold);font-weight:900}.lock{font-size:10px;color:#666}.token{width:100%;margin-top:10px;padding:12px;border:1px solid #2b4059;border-radius:11px;background:#080d13;color:#fff}.hint{font-size:9px;color:#666;margin-top:7px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:13px}.metric{background:linear-gradient(180deg,#141414,#0d0d0d);border:1px solid var(--line);border-radius:14px;padding:13px}.ml{font-size:9px;color:#77736b;text-transform:uppercase;letter-spacing:.08em}.mv{font-size:22px;font-weight:900;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gold{color:#ffdc73}.green{color:var(--green)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.panel{padding:14px;min-width:0}.panelHead{margin-bottom:9px}.panel h2{font-size:14px;margin:0}.count{font-size:9px;color:#888;background:#181818;border:1px solid #292929;border-radius:99px;padding:4px 7px}.row{background:#111;border:1px solid #202020;border-radius:12px;padding:11px;margin:7px 0}.rowTop{display:flex;justify-content:space-between;gap:8px}.row b{font-size:12px}.meta{font-size:9px;line-height:1.5;color:#777;margin-top:5px;overflow-wrap:anywhere}.pill{font-size:8px;padding:3px 6px;border-radius:99px;margin-left:4px;background:#191919;border:1px solid #282828;color:#aaa}.pill.ok{color:#59dfaf;border-color:#214a3b}.pill.warn{color:#f3ca63;border-color:#4a3b17}.pill.bad{color:#ff7581;border-color:#4c2027}.row a{color:var(--gold);text-decoration:none}.empty{color:#666;font-size:10px;padding:15px 2px}.actionBtns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.mini{padding:7px 9px;font-size:9px}.msg{margin-top:7px;padding-top:7px;border-top:1px solid #202020;color:#aaa;font-size:9px;white-space:pre-wrap;line-height:1.5}.next{background:linear-gradient(145deg,#191408,#0d0d0d);border:1px solid #3c3318;border-radius:13px;padding:13px}.nextBig{font-size:20px;font-weight:900;color:#ffdc73}.bar{height:6px;background:#202020;border-radius:99px;margin:10px 0;overflow:hidden}.bar i{display:block;height:100%;background:var(--gold)}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#181818;border:1px solid #3a3216;padding:11px 14px;border-radius:12px;display:none;z-index:9;font-size:10px;max-width:90%}
@media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:1fr}}
@media(max-width:560px){main{padding:17px 11px 50px}.top{display:block}.actions{margin-top:13px}.actions .btn{flex:1}.title{font-size:36px}.metrics{grid-template-columns:repeat(2,1fr)}.metric{padding:11px}.mv{font-size:20px}}
</style></head><body><main>
<div class="top"><div><div class="ey">RITTY / REVENUE ENGINE</div><div class="title">Da oportunidade<br>ao pagamento.</div><div class="sub">Centro de comando das vendas: leads reais → diagnóstico → proposta → contato → checkout → entrega.</div><div class="status"><span class="dot"></span><span id="status">Conectando…</span></div></div><div class="actions"><button class="btn" id="searchBtn" onclick="runCycle()">Pesquisar leads</button><button class="btn secondary" onclick="load()">Atualizar</button></div></div>
<section class="creator"><div class="creatorHead"><div class="creatorTitle">CONTROLE DO CREATOR</div><div class="lock">Ações de venda exigem aprovação</div></div><input id="token" class="token" type="password" placeholder="Token de aprovação do Revenue Engine"><div class="hint">Usado somente para aprovar contatos e checkouts.</div></section>
<section id="metrics" class="metrics"></section>
<div class="grid">
<section class="panel"><div class="panelHead"><h2>Leads / oportunidades</h2><span id="leadCount" class="count">0</span></div><div id="leads"></div></section>
<section class="panel"><div class="panelHead"><h2>Ações pendentes</h2><span id="actionCount" class="count">0</span></div><div id="actions"></div></section>
<section class="panel"><div class="panelHead"><h2>Checkouts</h2><span id="checkoutCount" class="count">0</span></div><div id="checkouts"></div></section>
<section class="panel"><div class="panelHead"><h2>Próximo passo</h2></div><div id="next"></div></section>
</div></main><div id="toast" class="toast"></div>
<script>
const tokenEl=document.getElementById('token');try{tokenEl.value=localStorage.getItem('rittyRevenueToken')||''}catch(e){}
tokenEl.addEventListener('input',()=>{try{localStorage.setItem('rittyRevenueToken',tokenEl.value)}catch(e){}});
const esc=s=>String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const money=n=>'R$ '+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
function toast(s){const e=document.getElementById('toast');e.textContent=s;e.style.display='block';clearTimeout(window.__t);window.__t=setTimeout(()=>e.style.display='none',3500)}
function pill(s){const x=String(s||'');const c=/won|paid|executed|approved|delivered|sent/.test(x)?'ok':/failed|lost|rejected/.test(x)?'bad':'warn';return '<span class="pill '+c+'">'+esc(x)+'</span>'}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},tokenEl.value?{'Authorization':'Bearer '+tokenEl.value}:{},{'Content-Type':'application/json'});const r=await fetch(path,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
async function load(){try{const j=await api('/api/revenue');const m=j.metrics||{},f=m.funnel||{},leads=j.leads||[],actions=j.actions||[],checkouts=j.checkouts||[];
document.getElementById('metrics').innerHTML=[['Leads',f.leads||0,''],['Contatos',f.contacted||0,''],['Respostas',f.responses||0,''],['Interessados',f.interested||0,'gold'],['Propostas',f.proposals||0,''],['Vendas',f.sales||0,'green'],['Receita',money(m.revenueBRL),'gold'],['Lucro líquido',money(m.netProfitBRL),'green']].map(x=>'<div class="metric"><div class="ml">'+x[0]+'</div><div class="mv '+x[2]+'">'+x[1]+'</div></div>').join('');
document.getElementById('leadCount').textContent=leads.length;document.getElementById('actionCount').textContent=actions.length;document.getElementById('checkoutCount').textContent=checkouts.length;
document.getElementById('leads').innerHTML=leads.length?leads.map(l=>'<div class="row"><div class="rowTop"><b>'+esc(l.name)+'</b>'+pill(l.status)+'</div><div class="meta">'+esc(l.website||'sem site')+' · oportunidade '+esc(l.score)+'/100 · '+esc(l.status||'')+'<br>'+esc(l.email||l.phone||l.contact||'sem contato público')+'</div></div>').join(''):'<div class="empty">Nenhum lead ainda.</div>';
document.getElementById('actions').innerHTML=actions.length?actions.map(a=>{let p={};try{p=typeof a.payload==='string'?JSON.parse(a.payload):a.payload||{}}catch(e){}let b='';if(a.action==='send_outreach'&&a.status==='pending_approval')b='<button class="btn secondary mini" onclick="approve(\\''+esc(a.id)+'\\',\\'send_outreach\\')">Aprovar contato</button>';else if(a.action==='send_outreach'&&a.status==='approved'&&a.channel==='email')b='<button class="btn mini" onclick="sendOutreach(\\''+esc(a.id)+'\\')">Enviar e-mail</button>';else if(a.action==='create_checkout'&&a.status==='pending_approval')b='<button class="btn secondary mini" onclick="approve(\\''+esc(a.id)+'\\',\\'create_checkout\\')">Aprovar checkout</button>';else if(a.action==='create_checkout'&&a.status==='approved')b='<button class="btn mini" onclick="createCheckout(\\''+esc(a.lead_id)+'\\',\\''+esc(p.offerId||'')+'\\')">Criar checkout</button>';return '<div class="row"><div class="rowTop"><b>'+esc(a.action)+'</b>'+pill(a.status)+'</div><div class="meta">Lead: '+esc(a.lead_id)+'<br>'+esc(a.destination||'')+(a.previewUrl?'<br><a href="'+esc(a.previewUrl)+'" target="_blank">Abrir demo →</a>':'')+'</div>'+(a.body?'<details><summary style="margin-top:7px;color:#f4c64f;font-size:9px">Ver mensagem</summary><div class="msg">'+esc(a.body)+'</div></details>':'')+(b?'<div class="actionBtns">'+b+'</div>':'')+'</div>'}).join(''):'<div class="empty">Nenhuma ação pendente.</div>';
document.getElementById('checkouts').innerHTML=checkouts.length?checkouts.map(c=>'<div class="row"><div class="rowTop"><b>'+money((c.amount_cents||0)/100)+'</b>'+pill(c.status)+'</div><div class="meta">'+esc(c.lead_id)+'<br>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank">Abrir checkout →</a>':'sem link')+'</div></div>').join(''):'<div class="empty">Nenhum checkout criado ainda.</div>';
const p=Math.min(100,Math.round(((f.leads||0)/100)*100));document.getElementById('next').innerHTML='<div class="next"><div class="nextBig">'+(f.leads||0)+' leads encontrados</div><div class="meta">Meta: 100 leads → 20 respostas → 5 propostas → 1 venda.</div><div class="bar"><i style="width:'+p+'%"></i></div><div class="meta">Custos de inferência: '+money(m.costTracking?.inferenceCostsBRL)+'<br>Outros custos: '+money(m.costTracking?.manualCostsBRL)+'<br>Lucro líquido: '+money(m.netProfitBRL)+'</div></div>';
document.getElementById('status').textContent='Revenue Engine online · atualização automática';}catch(e){document.getElementById('status').textContent='Painel online · erro ao carregar dados';toast('Erro ao carregar: '+e.message)}}
async function approve(id,action){try{await api(action==='send_outreach'?'/api/revenue/outreach/approve':'/api/revenue/checkout/approve',{method:'POST',body:JSON.stringify({actionId:id})});toast('Aprovado.');load()}catch(e){toast(e.message)}}
async function sendOutreach(id){try{const j=await api('/api/revenue/outreach/send',{method:'POST',body:JSON.stringify({actionId:id})});toast(j.result||'E-mail enviado.');load()}catch(e){toast(e.message)}}
async function createCheckout(leadId,offerId){try{const j=await api('/api/revenue/checkout',{method:'POST',body:JSON.stringify({leadId:leadId,offerId:offerId})});toast('Checkout criado.');if(j.url)window.open(j.url,'_blank');load()}catch(e){toast(e.message)}}
async function runCycle(){const b=document.getElementById('searchBtn');try{b.disabled=true;b.textContent='Pesquisando…';const j=await api('/api/revenue/autopilot',{method:'POST',body:JSON.stringify({niche:'empresas que podem melhorar o site',location:'Brasil',limit:6})});toast(j.result||'Ciclo concluído.');await load()}catch(e){toast(e.message)}finally{b.disabled=false;b.textContent='Pesquisar leads'}}
load();setInterval(load,15000);
</script></body></html>`);
    return true;
  }

  if (pathname === "/api/revenue" && req.method === "GET") {
    try {
      const metrics = JSON.parse(revenueMetrics(db));
      const leads = db.raw.prepare(
        "SELECT id,name,website,email,phone,contact,contact_url,opportunity,score,status,updated_at FROM revenue_leads ORDER BY score DESC,updated_at DESC LIMIT 60",
      ).all();
      const actions = db.raw.prepare(
        "SELECT a.id,a.lead_id,a.action,a.status,a.payload,a.created_at,a.updated_at,m.channel,m.destination,m.body,m.subject FROM revenue_actions a LEFT JOIN revenue_messages m ON m.id=json_extract(a.payload,'$.messageId') WHERE a.status IN ('pending_approval','approved') ORDER BY a.updated_at DESC LIMIT 100",
      ).all();
      const checkouts = db.raw.prepare(
        "SELECT id,lead_id,offer_id,url,amount_cents,status,created_at,updated_at FROM revenue_checkouts ORDER BY created_at DESC LIMIT 50",
      ).all();
      json(res, 200, { metrics, leads, actions, checkouts });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/autopilot" && req.method === "POST") {
    if (!authorized(req)) { json(res, 401, { error: "revenue_approval_token_required" }); return true; }
    try {
      const body = JSON.parse(await readBody(req)) as { niche?: string; location?: string; limit?: number; priceCents?: number };
      const result = await revenueAutopilotCycle(db, {
        niche: typeof body.niche === "string" ? body.niche : undefined,
        location: typeof body.location === "string" ? body.location : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        priceCents: typeof body.priceCents === "number" ? body.priceCents : undefined,
      });
      json(res, 200, { result });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/outreach/approve" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { actionId?: string };
      json(res, 200, { result: approveOutreach(db, String(body.actionId || "")) });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/outreach/send" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { actionId?: string };
      json(res, 200, { result: await sendApprovedOutreach(db, String(body.actionId || "")) });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/response" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as {
        leadId?: string;
        stage?: string;
        response?: string;
      };
      if (!["replied", "interested", "lost"].includes(String(body.stage))) {
        json(res, 400, { error: "invalid_stage" });
        return true;
      }
      json(
        res,
        200,
        {
          result: recordLeadResponse(db, {
            leadId: String(body.leadId || ""),
            stage: body.stage as "replied" | "interested" | "lost",
            response: String(body.response || ""),
          }),
        },
      );
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/checkout/approve" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { actionId?: string };
      json(res, 200, { result: approveCheckout(db, String(body.actionId || "")) });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/checkout" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as {
        leadId?: string;
        offerId?: string;
        amountCents?: number;
        approved?: boolean;
      };
      const result = await createStripeCheckout(db, {
        leadId: String(body.leadId || ""),
        offerId: typeof body.offerId === "string" ? body.offerId : undefined,
        amountCents: typeof body.amountCents === "number" ? body.amountCents : undefined,
        approved: body.approved === true,
      });
      json(res, 200, JSON.parse(result));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/revenue/fulfill" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "revenue_approval_required" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { leadId?: string; offerId?: string };
      const result = await fulfillPaidOrder(
        db,
        String(body.leadId || ""),
        typeof body.offerId === "string" ? body.offerId : undefined,
      );
      json(res, 200, JSON.parse(result));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/webhooks/stripe" && req.method === "POST") {
    try {
      const rawBody = await readBody(req, 1000000);
      const signature = String(req.headers["stripe-signature"] || "");
      const result = await handleStripeWebhook(db, rawBody, signature);
      json(res, 200, { received: true, result });
    } catch (error) {
      json(res, 400, {
        received: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (pathname === "/revenue/success" && req.method === "GET") {
    const sessionId = url.searchParams.get("session_id") || "";
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Pagamento recebido</h1><p>Session id ausente.</p>");
      return true;
    }
    try {
      const result = await confirmStripeSuccess(db, sessionId);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
        "<body style='font-family:system-ui;background:#050505;color:#f7f5ef;padding:30px'>" +
        "<h1>Pagamento confirmado ✅</h1><pre style='white-space:pre-wrap;background:#111;padding:16px;border-radius:12px'>" +
        String(result).replace(/</g, "&lt;") +
        "</pre></body>",
      );
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Pagamento ainda não processado</h1><p>" +
        String(error instanceof Error ? error.message : error).replace(/[<>]/g, "") +
        "</p>",
      );
    }
    return true;
  }

  if (pathname === "/revenue/cancelled" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Checkout cancelado</h1><p>Nenhum pagamento foi confirmado.</p>");
    return true;
  }

  return true;
}
