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
    pathname === "/revenue" ||
    pathname === "/api/revenue" ||
    pathname.startsWith("/api/revenue/") ||
    pathname === "/webhooks/stripe" ||
    pathname === "/revenue/success" ||
    pathname === "/revenue/cancelled";

  if (!handled) return false;

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
    res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RITTY — Revenue Engine</title><style>
:root{--bg:#050505;--panel:#0d0d0d;--line:#242424;--text:#f6f4ee;--muted:#9b988f;--accent:#f4c64f;--green:#50e0ae;--red:#ff6876}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 80% 0%,#2a2308,transparent 60%),var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif}main{max-width:1250px;margin:auto;padding:28px 18px 80px}.top{display:flex;justify-content:space-between;gap:15px;align-items:end;margin-bottom:20px}.ey{font-size:10px;letter-spacing:.18em;color:var(--accent);font-weight:800}.title{font-size:38px;font-weight:900;letter-spacing:-.04em;margin:5px 0}.sub{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #3a3216;background:#171406;color:#f8df86;padding:10px 13px;border-radius:10px;font-weight:800;cursor:pointer}.btn.secondary{background:#0b1118;border-color:#26394e;color:#a9bfd8}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px}.card{background:linear-gradient(180deg,#111,#090909);border:1px solid var(--line);border-radius:13px;padding:14px}.card small{color:#77736a;font-size:9px}.card strong{display:block;font-size:23px;margin-top:6px}.profit{color:var(--green)}.layout{display:grid;grid-template-columns:1.25fr .75fr;gap:14px}.panel{background:#0b0b0b;border:1px solid var(--line);border-radius:14px;padding:15px;margin-bottom:14px}.panel h2{font-size:13px;margin:0 0 12px}.row{border:1px solid #1c1c1c;background:#0f0f0f;border-radius:11px;padding:12px;margin:8px 0}.row b{font-size:12px}.meta{color:#77746c;font-size:9px;margin-top:5px;line-height:1.5}.pill{display:inline-block;padding:4px 7px;border-radius:999px;background:#171717;color:#aaa;font-size:8px;margin-left:5px}.pill.warn{color:#f3ca63}.pill.ok{color:#58dfaf}.pill.bad{color:#ff7581}.row a{color:#f4c64f;text-decoration:none}.empty{color:#666;font-size:11px;padding:15px 0}.token{width:100%;padding:11px;border-radius:9px;border:1px solid #28394d;background:#080d13;color:#fff;margin:7px 0}.toast{position:fixed;right:15px;bottom:15px;background:#121212;border:1px solid #3a3216;padding:12px 14px;border-radius:10px;display:none;max-width:360px;font-size:11px}
@media(max-width:900px){.grid{grid-template-columns:repeat(3,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:repeat(2,1fr)}.title{font-size:30px}}
</style></head><body><main><div class="top"><div><div class="ey">RITTY / REVENUE ENGINE</div><div class="title">Da oportunidade ao pagamento.</div><div class="sub">Pesquisa real → demo → aprovação humana → contato → checkout → entrega → lucro.</div></div><div class="actions"><button class="btn" onclick="runCycle()">Pesquisar leads</button><button class="btn secondary" onclick="load()">Atualizar</button></div></div>
<div class="panel"><div class="ey">CONTROLE DO CREATOR</div><input id="token" class="token" type="password" placeholder="Token de aprovação do Revenue Engine"></div>
<div id="metrics" class="grid"></div><div class="layout"><section><div class="panel"><h2>Leads / oportunidades</h2><div id="leads"></div></div><div class="panel"><h2>Ações pendentes</h2><div id="actions"></div></div></section><aside><div class="panel"><h2>Checkouts</h2><div id="checkouts"></div></div><div class="panel"><h2>Próximo passo</h2><div id="next"></div></div></aside></div></main><div id="toast" class="toast"></div>
<script>
const tokenEl=document.getElementById('token');
try{tokenEl.value=localStorage.getItem('rittyRevenueToken')||''}catch{}
tokenEl.addEventListener('input',()=>{try{localStorage.setItem('rittyRevenueToken',tokenEl.value)}catch{}});
document.querySelectorAll('button').forEach(b=>{b.type='button';b.style.touchAction='manipulation';b.style.pointerEvents='auto'});
const esc=s=>String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const money=n=>'R$ '+Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
function toast(s){const e=document.getElementById('toast');e.textContent=s;e.style.display='block';setTimeout(()=>e.style.display='none',3500)}
async function api(path,opts={}){opts.headers={...(opts.headers||{}),'Authorization':'Bearer '+tokenEl.value,'Content-Type':'application/json'};const r=await fetch(path,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);return j}
function pill(s){const x=String(s||'');return '<span class="pill '+(/won|paid|executed|approved|delivered|sent/.test(x)?'ok':/failed|lost/.test(x)?'bad':'warn')+'">'+esc(x)+'</span>'}
function manualUrl(destination,body){const digits=String(destination||'').replace(/\D/g,'');if(digits.length>=10)return 'https://wa.me/'+digits+'?text='+encodeURIComponent(String(body||''));return destination||'#'}
async function load(){try{const j=await api('/api/revenue');const m=j.metrics;document.getElementById('metrics').innerHTML=[
['Leads',m.funnel.leads],['Respostas',m.funnel.responses],['Propostas',m.funnel.proposals],['Vendas',m.funnel.sales],['Receita',money(m.revenueBRL)],['Lucro líquido',money(m.netProfitBRL)]
].map(x=>'<div class="card"><small>'+x[0]+'</small><strong class="'+(x[0]=='Lucro líquido'?'profit':'')+'">'+x[1]+'</strong></div>').join('');
document.getElementById('leads').innerHTML=j.leads.length?j.leads.map(l=>'<div class="row"><b>'+esc(l.name)+'</b>'+pill(l.status)+'<div class="meta">'+esc(l.website||'sem site')+' · score '+esc(l.score)+' · '+esc(l.opportunity||'oportunidade ainda não enriquecida')+'<br>'+esc(l.email||l.phone||l.contact||'sem contato público detectado')+'</div></div>').join(''):'<div class="empty">Nenhum lead ainda. Clique em Pesquisar leads.</div>';
document.getElementById('actions').innerHTML=j.actions.length?j.actions.map(a=>{let p={};try{p=typeof a.payload==='string'?JSON.parse(a.payload):a.payload||{}}catch{}const b=[];if(a.action==='send_outreach'&&a.status==='pending_approval')b.push('<button class="btn secondary" onclick="approve(\''+esc(a.id)+'\',\'send_outreach\')">Aprovar contato</button>');if(a.action==='send_outreach'&&a.status==='approved'){if(a.channel==='email')b.push('<button class="btn" onclick="sendOutreach(\''+esc(a.id)+'\')">Enviar e-mail</button>');else if(a.destination)b.push('<a class="btn" href="'+esc(manualUrl(a.destination,a.body||''))+'" target="_blank">Abrir contato</a>');}if(a.action==='create_checkout'&&a.status==='pending_approval')b.push('<button class="btn secondary" onclick="approve(\''+esc(a.id)+'\',\'create_checkout\')">Aprovar checkout</button>');if(a.action==='create_checkout'&&a.status==='approved')b.push('<button class="btn" onclick="createCheckout(\''+esc(a.lead_id)+'\',\''+esc(p.offerId||'')+'\')">Criar checkout</button>');return '<div class="row"><b>'+esc(a.action)+'</b>'+pill(a.status)+'<div class="meta">Lead: '+esc(a.lead_id)+' · '+esc(a.updated_at)+(a.destination?'<br>Contato: '+esc(a.destination):'')+(a.previewUrl?'<br><a href="'+esc(a.previewUrl)+'" target="_blank">Abrir demo →</a>':'')+(a.body?'<br><details><summary>Ver mensagem</summary><div style="white-space:pre-wrap;margin-top:8px">'+esc(a.body)+'</div></details>':'')+'</div>'+b.join(' ')+'</div>'}).join(''):'<div class="empty">Nenhuma aprovação pendente.</div>';
document.getElementById('checkouts').innerHTML=j.checkouts.length?j.checkouts.map(c=>'<div class="row"><b>'+money(c.amount_cents/100)+'</b>'+pill(c.status)+'<div class="meta">'+esc(c.lead_id)+'<br>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank">Abrir checkout →</a>':'sem link')+'</div></div>').join(''):'<div class="empty">Nenhum checkout.</div>';
document.getElementById('next').innerHTML='<div class="meta">Meta de referência: 100 leads → 20 respostas → 5 propostas → 1 venda.<br><br>Custos automáticos de inferência: '+money(m.costTracking.inferenceCostsBRL)+'<br>Outros custos: '+money(m.costTracking.manualCostsBRL)+'<br>Margem: '+money(m.netProfitBRL)+'</div>';
}catch(e){toast(e.message)}}
async function approve(id,action){try{const path=action==='send_outreach'?'/api/revenue/outreach/approve':'/api/revenue/checkout/approve';await api(path,{method:'POST',body:JSON.stringify({actionId:id})});toast('Aprovado.');load()}catch(e){toast(e.message)}}
async function sendOutreach(id){try{const j=await api('/api/revenue/outreach/send',{method:'POST',body:JSON.stringify({actionId:id})});toast(j.result||'E-mail enviado.');load()}catch(e){toast(e.message)}}
async function createCheckout(leadId,offerId){try{const j=await api('/api/revenue/checkout',{method:'POST',body:JSON.stringify({leadId,offerId})});toast('Checkout criado.');if(j.url)window.open(j.url,'_blank');load()}catch(e){toast(e.message)}}
async function runCycle(){try{toast('Pesquisando empresas reais...');const j=await api('/api/revenue/autopilot',{method:'POST',body:JSON.stringify({niche:'empresas que podem melhorar o site',location:'Brasil',limit:6})});toast(j.result||'Ciclo concluído.');load()}catch(e){toast(e.message)}}
try{load()}catch(e){toast(e.message||String(e))} setInterval(()=>{try{load()}catch{}},15000);
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
