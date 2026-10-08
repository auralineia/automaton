import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { ulid } from "ulid";
import type { AutomatonDatabase } from "../types.js";
import { enrichLead, prepareOutreach, ensureRevenueCommerceSchema } from "./commerce.js";

const REVENUE_ROOT = process.env.RITTY_REVENUE_ROOT || "/root/.automaton/revenue";
const DEFAULT_PRICE_CENTS = Number(process.env.RITTY_OFFER_PRICE_CENTS || 39700);

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

async function verifyStripeConnectivity(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.log("[revenue] Stripe config: MISSING_STRIPE_SECRET_KEY");
    return;
  }
  try {
    const response = await fetch("https://api.stripe.com/v1/balance", {
      headers: { authorization: "Bearer " + secret },
    });
    console.log("[revenue] Stripe connectivity:", response.ok ? "OK" : "FAILED_HTTP_" + response.status);
  } catch (error) {
    console.log("[revenue] Stripe connectivity: FAILED_NETWORK", error instanceof Error ? error.message : String(error));
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return { url: response.url || url.toString(), status: response.status, title: decodeHtml(titleMatch?.[1] || "").slice(0, 200), text: decodeHtml(body).slice(0, 16_000) };
  } finally { clearTimeout(timer); }
}

async function searchDuckDuckGo(query: string, limit = 6): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 RITTY/1.0", accept: "text/html" },
    });
    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const marker = 'class="result__a"';
    let cursor = 0;

    while (results.length < limit) {
      const markerIndex = html.indexOf(marker, cursor);
      if (markerIndex < 0) break;

      const hrefToken = 'href="';
      const hrefStart = html.lastIndexOf(hrefToken, markerIndex);
      if (hrefStart < 0) {
        cursor = markerIndex + marker.length;
        continue;
      }

      const valueStart = hrefStart + hrefToken.length;
      const valueEnd = html.indexOf('"', valueStart);
      const titleStart = html.indexOf(">", markerIndex);
      const titleEnd = titleStart >= 0 ? html.indexOf("</a>", titleStart + 1) : -1;

      if (valueEnd < 0 || titleStart < 0 || titleEnd < 0) {
        cursor = markerIndex + marker.length;
        continue;
      }

      let href = html.slice(valueStart, valueEnd);
      const rawTitle = html.slice(titleStart + 1, titleEnd);

      try {
        const parsed = new URL(href, "https://html.duckduckgo.com");
        const target = parsed.searchParams.get("uddg");
        if (target) href = decodeURIComponent(target);
      } catch {}

      if (/^https?:\/\//i.test(href)) {
        results.push({
          title: decodeHtml(rawTitle).slice(0, 220),
          url: href,
          snippet: "",
        });
      }

      cursor = titleEnd + 4;
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function searchBing(query: string, limit = 8): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const searchUrl = "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=" + String(limit);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const items = html.split(/<li class="b_algo"/i).slice(1);
    for (const item of items) {
      if (results.length >= limit) break;
      const match = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!match) continue;
      const url = match[1];
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (!host.includes(".") || host.length < 5) continue;
      if (/(instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|bing\.com|google\.com|duckduckgo\.com|wikipedia\.org)/i.test(host)) continue;
      } catch { continue; }
      const caption = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      results.push({
        title: decodeHtml(match[2]).slice(0, 220),
        url,
        snippet: decodeHtml(caption ? caption[1] : item.slice(0, 1200)).slice(0, 700),
      });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function searchBingRss(query: string, limit = 8): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const searchUrl = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 RITTY/1.0", accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.1" },
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const items = xml.split(/<item>/i).slice(1);
    for (const item of items) {
      if (results.length >= limit) break;
      const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "";
      const description = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "";
      const url = link.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (!host.includes(".") || host.length < 5) continue;
        if (/(instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|bing\.com|google\.com|duckduckgo\.com|wikipedia\.org)/i.test(host)) continue;
      } catch { continue; }
      results.push({ title: decodeHtml(title).slice(0,220), url, snippet: decodeHtml(description).slice(0,700) });
    }
    return results;
  } finally { clearTimeout(timer); }
}

function isLikelyEditorialResult(title: string, snippet: string): boolean {
  const lower = (title + " " + snippet).toLowerCase();
  return /\b(ranking|rankings|lista das|lista de|maiores|melhores|top \d+|guia de|comparativo|como escolher|o que é|notícias|noticia|blog)\b/i.test(lower);
}

function cleanupRejectedRevenueLeads(db: AutomatonDatabase): void {
  ensureRevenueSchema(db);
  const rows = db.raw.prepare(
    "SELECT id,name,website,notes FROM revenue_leads WHERE status NOT IN ('won','paid','checkout','fulfillment')"
  ).all() as Array<{ id: string; name: string; website: string | null; notes: string | null }>;

  for (const row of rows) {
    if (!isLikelyNonCommercialProspect(row.name || "", row.notes || "", row.website || "")) continue;
    db.raw.prepare("UPDATE revenue_leads SET status='rejected',updated_at=? WHERE id=?").run(now(), row.id);
    db.raw.prepare("UPDATE revenue_offers SET status='cancelled',updated_at=? WHERE lead_id=? AND status NOT IN ('won','cancelled')").run(now(), row.id);
    db.raw.prepare("UPDATE revenue_actions SET status='cancelled',updated_at=? WHERE lead_id=? AND status IN ('pending_approval','approved')").run(now(), row.id);
  }
}

function isLikelyNonCommercialProspect(title: string, text: string, url: string): boolean {
  const lower = (title + " " + text + " " + url).toLowerCase();
  let markers = 0;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (/\.(edu|gov|mil)(\.[a-z]{2})?$/.test(host) || /\.(ac|edu)\.[a-z]{2}$/.test(host)) {
      return true;
    }
    if (/^(www\.)?(university|universidade|college|faculdade|school|gov|government|cityof|countyof)/i.test(host)) {
      return true;
    }
    if (/(choose-location|select-location|investor|annual-report|careers|press-room|corporate)/i.test(pathname)) {
      markers += 2;
    }
  } catch {}

  if (/\b(university|universidade|college|faculdade|campus|faculty|students|professor|department|school district|government|governmental|ministry)\b/i.test(lower)) markers += 2;
  if (/\b(investor relations|annual report|shareholders|press release|corporate headquarters|global home|select your location|choose your location|supplier portal)\b/i.test(lower)) markers += 2;
  if (/\b(fedex|ups|dhl|amazon|microsoft|oracle|ibm|accenture|deloitte|pwc|ey|kpmg)\b/i.test(lower)) markers += 2;

  return markers >= 2;
}

function heuristicScore(text: string, url: string): { score: number; reasons: string[] } {
  const lower = (text + " " + url).toLowerCase();
  let score = 30;
  const reasons: string[] = [];
  if (url.includes(".com.br")) { score += 10; reasons.push("domínio brasileiro"); }
  if (/whatsapp|wa\.me/.test(lower)) { score += 18; reasons.push("WhatsApp público"); }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) { score += 14; reasons.push("e-mail público"); }
  if (/contato|contact|telefone|phone/.test(lower)) { score += 10; reasons.push("canal de contato detectado"); }
  if (/instagram|facebook|tiktok/.test(lower)) { score += 6; reasons.push("rede social mencionada"); }
  if (/site em construção|under construction|coming soon|em breve/.test(lower)) { score += 16; reasons.push("presença digital incompleta"); }
  if (/©\s*20(1[0-9]|2[0-4])/.test(lower)) { score += 8; reasons.push("sinal de site antigo"); }
  if (/http:\/\//.test(lower) && !/https:\/\//.test(lower)) { score += 6; reasons.push("site sem HTTPS no conteúdo"); }
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


function createDueFollowUps(db: AutomatonDatabase): void {
  ensureRevenueCommerceSchema(db);
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const rows = db.raw.prepare(
    `SELECT l.id,l.name,l.email,l.contact,l.contact_url,o.preview_url
     FROM revenue_leads l
     LEFT JOIN revenue_offers o ON o.id=(
       SELECT id FROM revenue_offers WHERE lead_id=l.id ORDER BY created_at DESC LIMIT 1
     )
     WHERE l.status='contacted'
       AND l.email IS NOT NULL
       AND l.email!=''
       AND EXISTS(
         SELECT 1 FROM revenue_messages m
         WHERE m.lead_id=l.id AND m.status='sent' AND m.created_at<=?
       )
       AND NOT EXISTS(
         SELECT 1 FROM revenue_events e
         WHERE e.lead_id=l.id AND e.type='response_received'
       )
       AND NOT EXISTS(
         SELECT 1 FROM revenue_actions a
         WHERE a.lead_id=l.id AND a.action='follow_up' AND a.status IN ('pending_approval','approved')
       )
     ORDER BY l.updated_at ASC LIMIT 6`,
  ).all(cutoff) as Array<any>;

  for (const row of rows) {
    const previewUrl = String(row.preview_url || row.contact_url || "");
    const messageId = ulid();
    const body = [
      "Olá, time da " + row.name + ",",
      "",
      "Só passando para deixar a demonstração personalizada que preparei:",
      previewUrl,
      "",
      "Encontrei alguns pontos no site atual que podem ficar mais claros no celular e no caminho até o contato.",
      "Nesta condição inicial, a implementação completa fica em R$ 397,00.",
      "",
      "Se fizer sentido, responda este e-mail e eu sigo com a adaptação.",
      "",
      "RITTY — Revenue Engine",
    ].filter(Boolean).join("\\n");
    db.raw.prepare(
      "INSERT INTO revenue_messages (id,lead_id,channel,destination,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      messageId, row.id, "email", row.email || row.contact || null,
      "Só deixando a demonstração por aqui", body, "draft", now(), now(),
    );
    db.raw.prepare(
      "INSERT INTO revenue_actions (id,lead_id,action,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      ulid(), row.id, "follow_up", "pending_approval",
      JSON.stringify({ messageId, reason: "Sem resposta após 72h; follow-up preparado.", previewUrl }),
      now(), now(),
    );
  }
}

export async function revenueAutopilotCycle(db: AutomatonDatabase, options: { niche?: string; location?: string; limit?: number; priceCents?: number } = {}): Promise<string> {
  ensureRevenueSchema(db);
  cleanupRejectedRevenueLeads(db);
  createDueFollowUps(db);
  const niche = options.niche || process.env.RITTY_REVENUE_NICHE || "negócios locais";
  const location = options.location || process.env.RITTY_REVENUE_REGION || "Brasil";
  const limit = Math.max(3, Math.min(8, options.limit || 5));
  const requestedPriceCents =
    Number.isFinite(options.priceCents) && (options.priceCents || 0) > 0
      ? Number(options.priceCents)
      : DEFAULT_PRICE_CENTS;
  const priceCents = Math.min(50000, Math.max(20000, requestedPriceCents));
  const normalizedLocation = location.toLowerCase();
  const brazilTarget = /(^|\\b)(brasil|brazil|br|são paulo|sao paulo|rio de janeiro|brasília|brasilia)(\\b|$)/i.test(location);
  const globalTarget = /(^|\\b)(global|world|worldwide|mundo|international|internacional)(\\b|$)/i.test(normalizedLocation);
  const domainHint = brazilTarget && !globalTarget ? "site:.com.br " : "";
  const locationPhrase = globalTarget ? "" : " " + location;
  const baseQuery = domainHint + niche + locationPhrase + " -ranking -lista -melhores -maiores -top -wikipedia";
  const query = baseQuery.trim();
  let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
  try {
    const queries = [
      query,
      (domainHint + niche + locationPhrase + " contato").trim(),
      (domainHint + niche + locationPhrase + " orçamento").trim(),
    ].filter((value, index, all) => value && all.indexOf(value) === index);

    for (const q of queries) {
      const found = await searchDuckDuckGo(q, Math.min(limit, 6));
      searchResults.push(...found);
      if (searchResults.length >= limit) break;
    }
    if (searchResults.length < limit) {
      for (const q of queries) {
        const found = await searchBing(q, Math.min(limit, 8));
        searchResults.push(...found);
        if (searchResults.length >= limit) break;
      }
    }
    if (searchResults.length < limit) {
      for (const q of queries) {
        const found = await searchBingRss(q, Math.min(limit, 8));
        searchResults.push(...found);
        if (searchResults.length >= limit) break;
      }
    }

    const seen = new Set<string>();
    searchResults = searchResults.filter((item) => {
      try {
        const canonical = new URL(item.url).origin.toLowerCase();
        if (seen.has(canonical)) return false;
        seen.add(canonical);
        return true;
      } catch {
        return false;
      }
    }).slice(0, limit);
  } catch (error) {
    return "Revenue engine could not search public web: " + (error instanceof Error ? error.message : String(error));
  }
  await verifyStripeConnectivity();

  const candidateIds: string[] = [];
  for (const result of searchResults) {
    try {
      const discovered = new URL(result.url);
      const host = discovered.hostname.toLowerCase();
      if (!host.includes(".") || host.length < 5) continue;
      if (isLikelyNonCommercialProspect(result.title, result.snippet, result.url)) continue;
      if (/(instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|bing\.com|google\.com|duckduckgo\.com|wikipedia\.org)/i.test(host)) continue;
      if (isLikelyEditorialResult(result.title, result.snippet)) continue;
      const id = ensureLead(db, { name: result.title || host, website: result.url, source: "public-search", query, location, snippet: result.snippet });
      candidateIds.push(id);
    } catch {}
  }

  let researched = 0;
  const candidates: Array<{ id: string; score: number; name: string; website: string; reasons: string[] }> = [];
  for (const id of candidateIds) {
    const row = db.raw.prepare("SELECT id,name,website,snippet FROM revenue_leads WHERE id=?").get(id) as { id: string; name: string; website: string | null; snippet: string | null } | undefined;
    if (!row?.website) continue;
    try {
      const discovered = new URL(row.website);
      const homepage = new URL("/", discovered.origin).toString();
      const page = await fetchPublicText(homepage);
      try {
        const host = new URL(page.url).hostname.toLowerCase();
        const discoveredHost = discovered.hostname.toLowerCase().replace(/^www\./, "");
        const finalHost = host.replace(/^www\./, "");
        if (!host.includes(".") || finalHost !== discoveredHost || /wikipedia\.org|bing\.com|google\.com|duckduckgo\.com/i.test(host)) {
          db.raw.prepare("UPDATE revenue_leads SET status=?,updated_at=? WHERE id=?").run("rejected", now(), id);
          continue;
        }
      } catch { continue; }
      if (
        page.status >= 400 ||
        page.text.trim().length < 120 ||
        isLikelyEditorialResult(page.title, page.text.slice(0, 3000)) ||
        isLikelyNonCommercialProspect(page.title, page.text, page.url)
      ) {
        db.raw.prepare("UPDATE revenue_leads SET status=?,updated_at=? WHERE id=?").run("rejected", now(), id);
        continue;
      }
      const scored = heuristicScore(page.text + " " + (row.snippet || "") + " " + page.title, page.url);
      const businessName = page.title || row.name;
      db.raw.prepare("UPDATE revenue_leads SET name=?,website=?,score=?,notes=?,status=?,updated_at=? WHERE id=?").run(businessName, page.url, scored.score, JSON.stringify({ title: page.title, reasons: scored.reasons, status: page.status, validatedHomepage: true }), "qualified", now(), id);
      researched++;
      candidates.push({ id, score: scored.score, name: businessName, website: page.url, reasons: scored.reasons });
    } catch (error) {
      db.raw.prepare("UPDATE revenue_leads SET notes=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify({ researchError: error instanceof Error ? error.message : String(error) }), "research_failed", now(), id);
    }
  }

  if (!candidates.length) return `Revenue engine searched ${searchResults.length} public results but could not research a usable prospect.`;

  candidates.sort((a, b) => b.score - a.score);
  let best: {
    id: string;
    score: number;
    name: string;
    website: string;
    reasons: string[];
    opportunity: string;
    services: string;
    businessType: string;
    siteAnalysis: string;
  } | null = null;
  for (const candidate of candidates.slice(0, 3)) {
    const activeOffer = db.raw.prepare(
      "SELECT id,status FROM revenue_offers WHERE lead_id=? AND status NOT IN ('cancelled','failed') ORDER BY created_at DESC LIMIT 1",
    ).get(candidate.id) as { id: string; status: string } | undefined;
    if (activeOffer) continue;
    try {
      await enrichLead(db, candidate.id);
      const enriched = db.raw.prepare("SELECT id,name,website,email,phone,contact,contact_url,opportunity,site_analysis,services,business_type,site_score FROM revenue_leads WHERE id=?").get(candidate.id) as any;
      if (enriched) {
        const hasDirectContact = Boolean(enriched.email || enriched.phone || enriched.contact || enriched.contact_url);
        let analysis: any = {};
        try { analysis = JSON.parse(String(enriched.site_analysis || "{}")); } catch {}
        const issueCount = Array.isArray(analysis.issues) ? analysis.issues.length : 0;
        const siteQuality = Number(enriched.site_score || 0);
        const opportunityScore = Math.min(
          100,
          Math.round(
            Number(candidate.score || 0) * 0.42 +
            Math.max(0, 100 - siteQuality) * 0.48 +
            (hasDirectContact ? 10 : 0),
          ),
        );

        if (!hasDirectContact) {
          db.raw.prepare("UPDATE revenue_leads SET status='rejected',notes=?,updated_at=? WHERE id=?").run(
            "Rejeitado: não há e-mail, telefone, WhatsApp ou página de contato pública utilizável.",
            now(), candidate.id,
          );
          continue;
        }

        if (siteQuality > 84 && issueCount < 2) {
          db.raw.prepare("UPDATE revenue_leads SET status='rejected',notes=?,updated_at=? WHERE id=?").run(
            "Rejeitado: site já apresenta qualidade alta e poucas oportunidades claras para uma oferta de redesign de entrada.",
            now(), candidate.id,
          );
          continue;
        }

        if (opportunityScore < 52) {
          db.raw.prepare("UPDATE revenue_leads SET status='qualified_low_opportunity',score=?,updated_at=? WHERE id=?").run(
            opportunityScore, now(), candidate.id,
          );
          continue;
        }

        db.raw.prepare("UPDATE revenue_leads SET score=?,notes=?,updated_at=? WHERE id=?").run(
          opportunityScore,
          JSON.stringify({
            opportunityScore,
            siteQuality,
            issueCount,
            hasDirectContact,
            reasons: candidate.reasons,
            priorities: analysis.priorities || [],
          }),
          now(), candidate.id,
        );

        best = {
          id: enriched.id,
          score: opportunityScore,
          name: enriched.name || candidate.name,
          website: enriched.website || candidate.website,
          reasons: candidate.reasons.concat(
            Array.isArray(analysis.priorities) ? analysis.priorities.slice(0, 2) : [],
          ),
          opportunity: String(enriched.opportunity || ""),
          services: String(enriched.services || "[]"),
          businessType: String(enriched.business_type || "negócio local"),
          siteAnalysis: String(enriched.site_analysis || "{}"),
        };
        break;
      }
    } catch {}
  }
  if (!best) {
    return [
      "REVENUE CYCLE COMPLETE",
      "Prospects discovered: " + searchResults.length,
      "Prospects researched: " + researched,
      "No new prospect was selected because the qualified results already have an active offer.",
      "Duplicate offer/outreach creation: BLOCKED.",
      "Financial movement: NOT PERFORMED.",
    ].join("\n");
  }

  const offerId = ulid();
  const safeName = best.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 70) || best.id;
  const offerDir = path.join(REVENUE_ROOT, "offers");
  fs.mkdirSync(offerDir, { recursive: true });
  const proposalPath = path.join(offerDir, `${safeName}-${offerId}.md`);
  let proposalAnalysis: any = {};
  try { proposalAnalysis = JSON.parse(best.siteAnalysis || "{}"); } catch {}
  let proposalServices: string[] = [];
  try { proposalServices = JSON.parse(best.services || "[]"); } catch {}
  const proposalIssues = Array.isArray(proposalAnalysis.priorities) ? proposalAnalysis.priorities.slice(0, 4) : [];
  const proposalStrengths = Array.isArray(proposalAnalysis.strengths) ? proposalAnalysis.strengths.slice(0, 4) : [];
  const proposal = [
    "# RITTY — Proposta de melhoria digital",
    "",
    `Cliente/prospect: ${best.name}`,
    `Site analisado: ${best.website}`,
    `Perfil detectado: ${best.businessType}`,
    `Índice de oportunidade: ${best.score}/100`,
    "",
    "## Diagnóstico comercial",
    best.opportunity || "Melhorar a clareza da oferta e o caminho até o contato.",
    "",
    "### Pontos que já funcionam",
    ...(proposalStrengths.length ? proposalStrengths.map((x: string) => "- " + x) : ["- Há uma presença digital existente que pode ser aproveitada."]),
    "",
    "### Pontos prioritários para corrigir",
    ...(proposalIssues.length ? proposalIssues.map((x: string) => "- " + x) : best.reasons.map((x) => "- " + x)),
    "",
    "### Serviços detectados no site",
    ...(proposalServices.length ? proposalServices.map((x: string) => "- " + x) : ["- Conteúdo de serviço precisa ser reorganizado na versão final."]),
    "",
    "## Escopo proposto",
    "- Redesign da página principal com hierarquia comercial clara.",
    "- Estrutura mobile-first e responsiva.",
    "- CTA principal conectado ao canal real da empresa.",
    "- Seções de oferta, confiança/provas e contato.",
    "- SEO técnico básico, metadados e compartilhamento.",
    "- Publicação da versão final após aprovação do cliente.",
    "",
    "## Demonstração",
    "Uma prévia navegável é gerada pelo RITTY antes do fechamento para facilitar a decisão.",
    "",
    `Investimento sugerido: R$ ${(priceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`,
    "",
    "## Próximo passo",
    "Revisão humana antes de qualquer contato externo. Nenhuma mensagem foi enviada automaticamente.",
    "",
    `Gerado pelo RITTY em ${now()}`,
  ].join("\n");
  fs.writeFileSync(proposalPath, proposal, "utf8");

  db.raw.prepare("INSERT INTO revenue_offers (id,lead_id,title,price_cents,status,proposal_path,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    offerId, best.id, `Site profissional / ${best.name}`, priceCents, "draft", proposalPath,
    JSON.stringify({ score: best.score, reasons: best.reasons, researched }), now(), now(),
  );
  let outreach = "";
  try {
    outreach = await prepareOutreach(db, { leadId: best.id });
  } catch (error) {
    outreach = "Outreach preparation failed: " + (error instanceof Error ? error.message : String(error));
  }

  return [
    "REVENUE CYCLE COMPLETE",
    `Prospects discovered: ${searchResults.length}`,
    `Prospects researched: ${researched}`,
    `Best lead: ${best.name}`,
    `Website: ${best.website}`,
    `Score: ${best.score}/100`,
    `Offer: R$ ${(priceCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`,
    `Proposal: ${proposalPath}`,
    "Outreach prepared: " + (outreach ? "YES" : "NO"),
    outreach.slice(0, 1800),
    "External outreach: NOT SENT (creator approval required).",
    "Financial movement: NOT PERFORMED.",
  ].join("\n");
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
