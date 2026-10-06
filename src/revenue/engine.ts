import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { ulid } from "ulid";
import type { AutomatonDatabase } from "../types.js";

const REVENUE_ROOT = process.env.RITTY_REVENUE_ROOT || "/root/.automaton/revenue";
const DEFAULT_PRICE_CENTS = Number(process.env.RITTY_OFFER_PRICE_CENTS || 150000);

function now(): string { return new Date().toISOString(); }

export function ensureRevenueSchema(db: AutomatonDatabase): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS revenue_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      source TEXT,
      query TEXT,
      location TEXT,
      contact TEXT,
      snippet TEXT,
      notes TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revenue_leads_status_score ON revenue_leads(status, score DESC);
    CREATE TABLE IF NOT EXISTS revenue_offers (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      title TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      proposal_path TEXT NOT NULL,
      evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revenue_offers_lead ON revenue_offers(lead_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS revenue_events (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'BRL',
      confirmed INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revenue_events_created ON revenue_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS revenue_actions (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  fs.mkdirSync(REVENUE_ROOT, { recursive: true });
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
}

function hostnameIsBlocked(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (["localhost", "0.0.0.0"].includes(lower) || lower.endsWith(".localhost") || lower.endsWith(".local")) return true;
  const ip = net.isIP(lower);
  if (ip === 4) {
    const [a,b] = lower.split(".").map(Number);
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (ip === 6 && (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:"))) return true;
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are allowed.");
  if (hostnameIsBlocked(url.hostname)) throw new Error("Blocked private/local URL.");
  const answers = await dns.lookup(url.hostname, { all: true });
  if (!answers.length || answers.some((a) => hostnameIsBlocked(a.address))) throw new Error("Blocked hostname resolving to private/local address.");
  return url;
}

async function fetchPublicText(rawUrl: string): Promise<{ url: string; status: number; title: string; text: string }> {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "RITTY-Revenue-Research/1.0", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
    });
    const body = (await response.text()).slice(0, 700_000);
    const titleMatch = body.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
    return { url: response.url || url.toString(), status: response.status, title: decodeHtml(titleMatch?.[1] || "").slice(0, 200), text: decodeHtml(body).slice(0, 16_000) };
  } finally { clearTimeout(timer); }
}

async function searchDuckDuckGo(query: string, limit = 6): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(searchUrl, { signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 RITTY/1.0", accept: "text/html" } });
    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const rx = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>[\\s\\S]*?<a[^>]+class="result__snippet"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = rx.exec(html)) && results.length < limit) {
      let href = match[1];
      try {
        const parsed = new URL(href, "https://html.duckduckgo.com");
        const target = parsed.searchParams.get("uddg");
        if (target) href = decodeURIComponent(target);
      } catch {}
      if (!/^https?:\\/\\//i.test(href)) continue;
      results.push({ title: decodeHtml(match[2]).slice(0, 220), url: href, snippet: decodeHtml(match[3]).slice(0, 420) });
    }
    return results;
  } finally { clearTimeout(timer); }
}

function heuristicScore(text: string, url: string): { score: number; reasons: string[] } {
  const lower = (text + " " + url).toLowerCase();
  let score = 30;
  const reasons: string[] = [];
  if (url.includes(".com.br")) { score += 10; reasons.push("domínio brasileiro"); }
  if (/whatsapp|wa\\.me/.test(lower)) { score += 18; reasons.push("WhatsApp público"); }
  if (/contato|contact|telefone|phone/.test(lower)) { score += 10; reasons.push("canal de contato detectado"); }
  if (/instagram|facebook|tiktok/.test(lower)) { score += 6; reasons.push("rede social mencionada"); }
  if (/site em construção|under construction|coming soon|em breve/.test(lower)) { score += 16; reasons.push("presença digital incompleta"); }
  if (/©\\s*20(1[0-9]|2[0-4])/.test(lower)) { score += 8; reasons.push("sinal de site antigo"); }
  if (/http:\\/\\//.test(lower) && !/https:\\/\\//.test(lower)) { score += 6; reasons.push("site sem HTTPS no conteúdo"); }
  return { score: Math.min(100, score), reasons };
}

function ensureLead(db: AutomatonDatabase, lead: { name: string; website?: string; source: string; query: string; location?: string; snippet?: string }): string {
  ensureRevenueSchema(db);
  const existing = db.raw.prepare("SELECT id FROM revenue_leads WHERE lower(COALESCE(website,'')) = lower(?) LIMIT 1").get(lead.website || "") as { id: string } | undefined;
  if (existing) {
    db.raw.prepare("UPDATE revenue_leads SET updated_at=?, snippet=COALESCE(?,snippet), query=COALESCE(?,query), location=COALESCE(?,location) WHERE id=?").run(now(), lead.snippet || null, lead.query || null, lead.location || null, existing.id);
    return existing.id;
  }
  const id = ulid();
  db.raw.prepare("INSERT INTO revenue_leads (id,name,website,source,query,location,snippet,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, lead.name, lead.website || null, lead.source, lead.query, lead.location || null, lead.snippet || null, now(), now());
  return id;
}

export async function revenueAutopilotCycle(db: AutomatonDatabase, options: { niche?: string; location?: string; limit?: number; priceCents?: number } = {}): Promise<string> {
  ensureRevenueSchema(db);
  const niche = options.niche || process.env.RITTY_REVENUE_NICHE || "empresas locais com site fraco ou desatualizado";
  const location = options.location || process.env.RITTY_REVENUE_REGION || "Brasil";
  const limit = Math.max(3, Math.min(8, options.limit || 5));
  const priceCents = Number.isFinite(options.priceCents) && (options.priceCents || 0) > 0 ? Number(options.priceCents) : DEFAULT_PRICE_CENTS;
  const query = `site:.com.br "${niche}" "${location}"`;
  let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
  try { searchResults = await searchDuckDuckGo(query, limit); }
  catch (error) { return `Revenue engine could not search public web: ${error instanceof Error ? error.message : String(error)}`; }

  const candidateIds: string[] = [];
  for (const result of searchResults) {
    try {
      const id = ensureLead(db, { name: result.title || new URL(result.url).hostname, website: result.url, source: "duckduckgo", query, location, snippet: result.snippet });
      candidateIds.push(id);
    } catch {}
  }

  let researched = 0;
  let best: { id: string; score: number; name: string; website: string; reasons: string[] } | null = null;
  for (const id of candidateIds) {
    const row = db.raw.prepare("SELECT id,name,website,snippet FROM revenue_leads WHERE id=?").get(id) as { id: string; name: string; website: string | null; snippet: string | null } | undefined;
    if (!row?.website) continue;
    try {
      const page = await fetchPublicText(row.website);
      const scored = heuristicScore(page.text + " " + (row.snippet || "") + " " + page.title, page.url);
      db.raw.prepare("UPDATE revenue_leads SET website=?,score=?,notes=?,status=?,updated_at=? WHERE id=?").run(page.url, scored.score, JSON.stringify({ title: page.title, reasons: scored.reasons, status: page.status }), "qualified", now(), id);
      researched++;
      if (!best || scored.score > best.score) best = { id, score: scored.score, name: row.name, website: page.url, reasons: scored.reasons };
    } catch (error) {
      db.raw.prepare("UPDATE revenue_leads SET notes=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify({ researchError: error instanceof Error ? error.message : String(error) }), "research_failed", now(), id);
    }
  }

  if (!best) return `Revenue engine searched ${searchResults.length} public results but could not research a usable prospect.`;

  const offerId = ulid();
  const safeName = best.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 70) || best.id;
  const offerDir = path.join(REVENUE_ROOT, "offers");
  fs.mkdirSync(offerDir, { recursive: true });
  const proposalPath = path.join(offerDir, `${safeName}-${offerId}.md`);
  const proposal = [
    "# RITTY — Proposta de melhoria digital",
    "",
    `Cliente/prospect: ${best.name}`,
    `Site analisado: ${best.website}`,
    `Score da oportunidade: ${best.score}/100`,
    "",
    "## Evidências encontradas",
    ...best.reasons.map((x) => `- ${x}`),
    "",
    "## Oferta",
    "- Landing page/site profissional focado em conversão.",
    "- Estrutura mobile-first.",
    "- CTA direto para WhatsApp/contato.",
    "- Performance, SEO básico e analytics.",
    "- Publicação de uma versão demonstrável antes do fechamento.",
    "",
    `Preço sugerido: R$ ${(priceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`,
    "",
    "## Próximo passo",
    "Revisão humana antes de qualquer contato externo. Nenhuma mensagem foi enviada automaticamente.",
    "",
    `Gerado pelo RITTY em ${now()}`,
  ].join("\\n");
  fs.writeFileSync(proposalPath, proposal, "utf8");

  db.raw.prepare("INSERT INTO revenue_offers (id,lead_id,title,price_cents,status,proposal_path,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    offerId, best.id, `Site profissional / ${best.name}`, priceCents, "draft", proposalPath,
    JSON.stringify({ score: best.score, reasons: best.reasons, researched }), now(), now(),
  );
  db.raw.prepare("INSERT INTO revenue_actions (id,lead_id,action,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    ulid(), best.id, "review_and_contact_prospect", "pending_approval",
    JSON.stringify({ offerId, proposalPath, priceCents }), now(), now(),
  );

  return [
    "REVENUE CYCLE COMPLETE",
    `Prospects discovered: ${searchResults.length}`,
    `Prospects researched: ${researched}`,
    `Best lead: ${best.name}`,
    `Website: ${best.website}`,
    `Score: ${best.score}/100`,
    `Offer: R$ ${(priceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`,
    `Proposal: ${proposalPath}`,
    "External outreach: NOT SENT (creator approval required).",
    "Financial movement: NOT PERFORMED.",
  ].join("\\n");
}

export function revenuePipeline(db: AutomatonDatabase): string {
  ensureRevenueSchema(db);
  const leads = db.raw.prepare("SELECT status, COUNT(*) as count FROM revenue_leads GROUP BY status ORDER BY status").all() as Array<{status:string;count:number}>;
  const summary = {
    leads: Number((db.raw.prepare("SELECT COUNT(*) as c FROM revenue_leads").get() as any)?.c || 0),
    qualified: Number((db.raw.prepare("SELECT COUNT(*) as c FROM revenue_leads WHERE status='qualified'").get() as any)?.c || 0),
    offers: Number((db.raw.prepare("SELECT COUNT(*) as c FROM revenue_offers").get() as any)?.c || 0),
    pendingApproval: Number((db.raw.prepare("SELECT COUNT(*) as c FROM revenue_actions WHERE status='pending_approval'").get() as any)?.c || 0),
    confirmedRevenueCents: Number((db.raw.prepare("SELECT COALESCE(SUM(amount_cents),0) as c FROM revenue_events WHERE confirmed=1").get() as any)?.c || 0),
    breakdown: leads,
  };
  return JSON.stringify(summary, null, 2);
}

export function recordConfirmedRevenue(db: AutomatonDatabase, args: { leadId?: string; amountCents: number; type?: string; notes?: string; confirmed: boolean }): string {
  ensureRevenueSchema(db);
  if (!args.confirmed) return "Revenue event rejected: confirmed must be true. This tool only records a creator-confirmed sale; it never moves money.";
  if (!Number.isFinite(args.amountCents) || args.amountCents <= 0) return "Revenue event rejected: amountCents must be a positive number.";
  const id = ulid();
  db.raw.prepare("INSERT INTO revenue_events (id,lead_id,type,amount_cents,currency,confirmed,notes,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, args.leadId || null, args.type || "sale", Math.round(args.amountCents), "BRL", 1, args.notes || null, now());
  if (args.leadId) db.raw.prepare("UPDATE revenue_leads SET status='won',updated_at=? WHERE id=?").run(now(), args.leadId);
  return `Recorded confirmed revenue: R$ ${(args.amountCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}. No payment or transfer was executed by RITTY.`;
}

export function revenueNextAction(db: AutomatonDatabase): string {
  ensureRevenueSchema(db);
  const row = db.raw.prepare(
    `SELECT a.id,a.action,a.status,a.payload,l.name,l.website,l.score,o.proposal_path,o.price_cents
     FROM revenue_actions a
     LEFT JOIN revenue_leads l ON l.id=a.lead_id
     LEFT JOIN revenue_offers o ON o.id=json_extract(a.payload,'$.offerId')
     WHERE a.status='pending_approval'
     ORDER BY COALESCE(l.score,0) DESC,a.created_at ASC LIMIT 1`
  ).get() as any;
  return row ? JSON.stringify(row, null, 2) : "No pending revenue action. Run revenue_autopilot_cycle to create the next sales opportunity.";
}
