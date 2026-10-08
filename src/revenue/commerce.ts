import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { ulid } from "ulid";
import type { AutomatonDatabase } from "../types.js";
import { createWork, executeWorkBundle } from "../orchestration/work-engine.js";

const REVENUE_ROOT = process.env.RITTY_REVENUE_ROOT || "/root/.automaton/revenue";
const DEFAULT_PRICE_CENTS = (() => {
  const requested = Number(process.env.RITTY_OFFER_PRICE_CENTS || "39700");
  return Math.min(50000, Math.max(20000, Number.isFinite(requested) ? requested : 39700));
})();

function now(): string {
  return new Date().toISOString();
}

function publicBaseUrl(): string {
  return (
    process.env.RITTY_PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
      : "https://ritty-production.up.railway.app")
  ).replace(/\/+$/, "");
}

function ensureColumn(db: AutomatonDatabase, table: string, column: string, type: string): void {
  try {
    db.raw.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
  } catch {
    // Column already exists or legacy SQLite does not expose it.
  }
}

export function ensureRevenueCommerceSchema(db: AutomatonDatabase): void {
  const raw = db.raw;

  raw.exec(
    "CREATE TABLE IF NOT EXISTS revenue_messages (" +
      "id TEXT PRIMARY KEY," +
      "lead_id TEXT NOT NULL," +
      "channel TEXT NOT NULL," +
      "destination TEXT," +
      "subject TEXT," +
      "body TEXT NOT NULL," +
      "status TEXT NOT NULL DEFAULT 'draft'," +
      "provider_id TEXT," +
      "created_at TEXT NOT NULL," +
      "updated_at TEXT NOT NULL" +
    ");" +
    "CREATE INDEX IF NOT EXISTS idx_revenue_messages_lead ON revenue_messages(lead_id, created_at DESC);" +

    "CREATE TABLE IF NOT EXISTS revenue_checkouts (" +
      "id TEXT PRIMARY KEY," +
      "lead_id TEXT NOT NULL," +
      "offer_id TEXT," +
      "provider TEXT NOT NULL DEFAULT 'stripe'," +
      "provider_checkout_id TEXT," +
      "url TEXT," +
      "amount_cents INTEGER NOT NULL," +
      "currency TEXT NOT NULL DEFAULT 'brl'," +
      "status TEXT NOT NULL DEFAULT 'created'," +
      "created_at TEXT NOT NULL," +
      "updated_at TEXT NOT NULL" +
    ");" +
    "CREATE INDEX IF NOT EXISTS idx_revenue_checkouts_lead ON revenue_checkouts(lead_id, created_at DESC);" +

    "CREATE TABLE IF NOT EXISTS revenue_costs (" +
      "id TEXT PRIMARY KEY," +
      "category TEXT NOT NULL," +
      "amount_cents INTEGER NOT NULL DEFAULT 0," +
      "description TEXT," +
      "created_at TEXT NOT NULL" +
    ");" +
    "CREATE INDEX IF NOT EXISTS idx_revenue_costs_created ON revenue_costs(created_at DESC);" +

    "CREATE TABLE IF NOT EXISTS revenue_fulfillments (" +
      "id TEXT PRIMARY KEY," +
      "lead_id TEXT NOT NULL," +
      "offer_id TEXT," +
      "status TEXT NOT NULL DEFAULT 'queued'," +
      "work_id TEXT," +
      "preview_url TEXT," +
      "published_url TEXT," +
      "delivery_email TEXT," +
      "error TEXT," +
      "created_at TEXT NOT NULL," +
      "updated_at TEXT NOT NULL" +
    ");" +
    "CREATE INDEX IF NOT EXISTS idx_revenue_fulfillments_lead ON revenue_fulfillments(lead_id, created_at DESC);",
  );

  ensureColumn(db, "revenue_leads", "email", "TEXT");
  ensureColumn(db, "revenue_leads", "phone", "TEXT");
  ensureColumn(db, "revenue_leads", "contact_url", "TEXT");
  ensureColumn(db, "revenue_leads", "opportunity", "TEXT");
  ensureColumn(db, "revenue_leads", "evidence_url", "TEXT");
  ensureColumn(db, "revenue_offers", "preview_url", "TEXT");
  ensureColumn(db, "revenue_offers", "checkout_url", "TEXT");
  ensureColumn(db, "revenue_leads", "site_analysis", "TEXT");
  ensureColumn(db, "revenue_leads", "services", "TEXT");
  ensureColumn(db, "revenue_leads", "business_type", "TEXT");
  ensureColumn(db, "revenue_leads", "site_score", "INTEGER");

  fs.mkdirSync(path.join(REVENUE_ROOT, "offers"), { recursive: true });
  fs.mkdirSync(path.join(REVENUE_ROOT, "demos"), { recursive: true });
  fs.mkdirSync(path.join(REVENUE_ROOT, "fulfillments"), { recursive: true });
}

function privateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "0.0.0.0" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local")
  ) {
    return true;
  }

  const ip = net.isIP(lower);
  if (ip === 4) {
    const parts = lower.split(".").map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (
    ip === 6 &&
    (lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:"))
  ) {
    return true;
  }
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http/https public URLs are allowed.");
  }
  if (privateHostname(url.hostname)) throw new Error("Blocked private/local URL.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((x) => privateHostname(x.address))) {
    throw new Error("Blocked hostname resolving to a private/local address.");
  }
  return url;
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPublicPage(rawUrl: string): Promise<{
  url: string;
  status: number;
  title: string;
  text: string;
  html: string;
  emails: string[];
  phones: string[];
  whatsapp: string | null;
  contactUrl: string | null;
  socials: string[];
  signals: string[];
}> {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "RITTY-Revenue-Research/2.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    const html = (await response.text()).slice(0, 900000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = decodeHtml(html).slice(0, 18000);

    const emails = Array.from(
      new Set(
        (html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
          .map((x) => x.toLowerCase())
          .filter((x) => !/example\.(com|org|net)$/.test(x))
          .slice(0, 8),
      ),
    );

    const phones = Array.from(
      new Set(
        (html.match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-.\s]?\d{4}/g) || [])
          .map((x) => x.replace(/[^\d+]/g, ""))
          .filter((x) => x.replace(/\D/g, "").length >= 10)
          .slice(0, 8),
      ),
    );

    const whatsappMatch =
      html.match(/https?:\/\/(?:api\.)?wa\.me\/\d+[^"'\s<]*/i) ||
      html.match(/https?:\/\/(?:www\.)?whatsapp\.com[^"'\s<]*/i);
    const whatsapp = whatsappMatch ? whatsappMatch[0] : null;

    const links = Array.from(html.matchAll(/href=["']([^"']+)["']/gi)).map((m) => m[1]);
    const contactLink = links.find((href) => /(?:contato|contact|fale|atendimento)/i.test(href));
    const contactUrl = contactLink
      ? new URL(contactLink, response.url || url.toString()).toString()
      : null;
    const socials = links
      .filter((href) => /instagram\.com|facebook\.com|tiktok\.com/i.test(href))
      .slice(0, 6);

    const signals: string[] = [];
    const lower = (html + " " + text).toLowerCase();
    if (!/^https:\/\//i.test(response.url || url.toString())) {
      signals.push("O site pesquisado não terminou em HTTPS.");
    }
    if (!/<meta[^>]+name=["']viewport["'][^>]*>/i.test(html)) {
      signals.push("Não foi detectada meta viewport.");
    }
    if (/site em construção|under construction|coming soon|em breve|em manutenc/i.test(lower)) {
      signals.push("A presença digital parece incompleta ou em manutenção.");
    }
    if (/whatsapp|wa\.me/i.test(lower)) {
      signals.push("Há canal público de WhatsApp detectável.");
    }
    if (/instagram|facebook|tiktok/i.test(lower)) {
      signals.push("Há redes sociais públicas vinculadas.");
    }
    if (!/(comprar|orcamento|orçamento|contato|whatsapp|fale conosco|agendar|solicitar)/i.test(text)) {
      signals.push("Não foi detectado um CTA comercial claro.");
    }
    if (!emails.length && !phones.length && !whatsapp && !contactUrl) {
      signals.push("Não foi localizado contato direto no HTML público.");
    }

    return {
      url: response.url || url.toString(),
      status: response.status,
      title: decodeHtml(titleMatch ? titleMatch[1] : "").slice(0, 200),
      text,
      html,
      emails,
      phones,
      whatsapp,
      contactUrl,
      socials,
      signals,
    };
  } finally {
    clearTimeout(timer);
  }
}

function escHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(input: string): string {
  return escHtml(input).replace(/'/g, "&#39;");
}


function extractMetaContent(html: string, name: string): string {
  const re = new RegExp("<meta[^>]+(?:name|property)=[\"']" + name + "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", "i");
  return decodeHtml(html.match(re)?.[1] || "").trim().slice(0, 320);
}

function extractHeadings(html: string): string[] {
  return Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((m) => decodeHtml(m[1] || "").replace(/\s+/g, " ").trim())
    .filter((x) => x.length >= 3 && x.length <= 140)
    .slice(0, 18);
}

function inferBusinessProfile(title: string, text: string, headings: string[]): { type: string; services: string[] } {
  const lower = (title + " " + text + " " + headings.join(" ")).toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/(restaurante|pizzaria|hamburguer|bar|cafeteria|padaria|delivery|gastronomia)/i, "gastronomia"],
    [/(clínica|clinica|odontologia|dentista|fisioterapia|psicologia|médico|medico)/i, "saúde"],
    [/(estética|estetica|beleza|salão|salao|barbearia|cabelo|unhas)/i, "beleza e estética"],
    [/(imobiliária|imobiliaria|corretor|apartamento|loteamento|imóveis|imoveis)/i, "imobiliário"],
    [/(advocacia|advogado|jurídico|juridico|escritório de advocacia)/i, "serviços jurídicos"],
    [/(contabilidade|contador|contábil|contabil|financeiro)/i, "contabilidade e finanças"],
    [/(automotivo|auto center|oficina|funilaria|lava[- ]?jato|estética automotiva|mecânica|mecanica)/i, "automotivo"],
    [/(construção|construcao|engenharia|arquitetura|reformas?|obra)/i, "construção e engenharia"],
    [/(limpeza|facilities|conservação|conservacao|terceirização|terceirizacao)/i, "serviços"],
    [/(escola|curso|educação|educacao|faculdade|treinamento)/i, "educação"],
    [/(software|saas|tecnologia|tecnologia da informação|desenvolvimento de software)/i, "tecnologia"],
    [/(loja|e-commerce|ecommerce|comprar|produtos|catálogo|catalogo)/i, "varejo"],
  ];
  const type = rules.find(([re]) => re.test(lower))?.[1] || "negócio local";
  const generic = /^(home|início|inicio|sobre nós|sobre|contato|fale conosco|serviços|servicos|produtos|quem somos|nossos serviços|nossos servicos|menu)$/i;
  const services = Array.from(new Set(
    headings
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length >= 4 && x.length <= 70 && !generic.test(x))
      .slice(0, 6),
  ));
  return { type, services };
}

function analyzeSite(page: {
  title: string;
  text: string;
  html: string;
  status: number;
  url: string;
  emails: string[];
  phones: string[];
  whatsapp: string | null;
  contactUrl: string | null;
  socials: string[];
}): {
  score: number;
  businessType: string;
  services: string[];
  metaDescription: string;
  h1: string[];
  strengths: string[];
  issues: string[];
  priorities: string[];
  evidence: Record<string, unknown>;
  primaryOpportunity: string;
} {
  const headings = extractHeadings(page.html);
  const h1 = Array.from(page.html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi))
    .map((m) => decodeHtml(m[1] || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
  const metaDescription = extractMetaContent(page.html, "description");
  const lower = (page.html + " " + page.text).toLowerCase();
  const ctaTerms = Array.from(page.text.match(/\b(comprar|orçamento|orcamento|contato|whatsapp|fale conosco|agendar|solicitar|reservar|pedir|atendimento)\b/gi) || []);
  const imageMatches = Array.from(page.html.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0]);
  const imagesWithoutAlt = imageMatches.filter((x) => !/\balt\s*=\s*["'][^"']+["']/i.test(x)).length;
  const titleLength = page.title.trim().length;
  const wordCount = page.text.split(/\s+/).filter(Boolean).length;
  const profile = inferBusinessProfile(page.title, page.text, headings);

  let score = 82;
  const issues: string[] = [];
  const strengths: string[] = [];

  if (!/^https:\/\//i.test(page.url)) { score -= 7; issues.push("O site ainda não termina em HTTPS."); }
  else strengths.push("HTTPS ativo.");
  if (!/<meta[^>]+name=["']viewport["'][^>]*>/i.test(page.html)) { score -= 10; issues.push("A estrutura não declara meta viewport; isso pode prejudicar a experiência mobile."); }
  else strengths.push("Meta viewport detectada.");
  if (!h1.length) { score -= 9; issues.push("Não foi identificado um H1 claro para explicar a proposta principal da página."); }
  else if (h1.length > 1) { score -= 4; issues.push("Há mais de um H1; a hierarquia da mensagem principal pode ficar menos clara."); }
  else strengths.push("Uma mensagem principal em H1 foi detectada.");
  if (!metaDescription) { score -= 6; issues.push("Não foi identificada uma meta description útil para busca/compartilhamento."); }
  else strengths.push("Meta description presente.");
  if (titleLength < 18 || titleLength > 70) { score -= 4; issues.push("O título da página está pouco orientado a clareza/descoberta."); }
  else strengths.push("Título da página com tamanho razoável.");
  if (!ctaTerms.length) { score -= 13; issues.push("Não foi detectado um CTA comercial claro (ex.: orçamento, agendamento, WhatsApp ou compra)."); }
  else strengths.push("CTA/ação comercial detectado.");
  if (!page.emails.length && !page.phones.length && !page.whatsapp && !page.contactUrl) { score -= 12; issues.push("Não foi localizado um canal direto de contato no HTML público."); }
  else strengths.push("Canal de contato público detectado.");
  if (page.whatsapp) strengths.push("WhatsApp público detectado.");
  if (page.socials.length) strengths.push("Redes sociais públicas vinculadas.");
  if (!/canonical/i.test(page.html)) { score -= 3; issues.push("Não foi detectada uma URL canônica."); }
  if (!/og:title/i.test(page.html)) { score -= 2; issues.push("Não foi detectado og:title para compartilhamento social."); }
  if (imageMatches.length >= 4 && imagesWithoutAlt / imageMatches.length > 0.35) { score -= 4; issues.push("Parte relevante das imagens não possui alt text detectável."); }
  if (wordCount < 250) { score -= 7; issues.push("O conteúdo visível é curto; falta contexto para explicar oferta, diferenciais e confiança."); }
  else strengths.push("Conteúdo textual suficiente para análise comercial.");
  if (/site em construção|under construction|coming soon|em breve|em manutenção|em manutenc/i.test(lower)) { score -= 12; issues.push("Há sinais de presença digital incompleta/manutenção."); }

  const uniqueIssues = Array.from(new Set(issues)).slice(0, 8);
  const priorities = uniqueIssues.slice(0, 3);
  const evidence = {
    pageTitle: page.title,
    h1,
    metaDescription: metaDescription || null,
    ctaTerms: Array.from(new Set(ctaTerms.map((x) => x.toLowerCase()))).slice(0, 8),
    detectedEmails: page.emails.slice(0, 3),
    detectedPhones: page.phones.slice(0, 3),
    whatsapp: Boolean(page.whatsapp),
    socialCount: page.socials.length,
    headings: headings.slice(0, 8),
    wordCount,
    images: imageMatches.length,
    imagesWithoutAlt,
    httpStatus: page.status,
    checkedUrl: page.url,
  };

  let primaryOpportunity =
    priorities[0] ||
    "Organizar melhor a apresentação da oferta e criar uma jornada mais clara para transformar visita em contato.";
  if (/CTA/i.test(primaryOpportunity) || /orçamento|agendamento|whatsapp|compra/i.test(primaryOpportunity)) {
    primaryOpportunity = "A página apresenta a empresa, mas o próximo passo comercial não fica claro o bastante. A principal melhoria é tornar oferta + CTA visíveis logo no primeiro contato com o visitante.";
  } else if (/mobile|viewport/i.test(primaryOpportunity)) {
    primaryOpportunity = "A experiência mobile precisa de uma base mais consistente. A primeira melhoria é reorganizar a hierarquia e os CTAs para telas pequenas, priorizando leitura e ação.";
  } else if (/meta description|título|URL canônica|og:title/i.test(primaryOpportunity)) {
    primaryOpportunity = "A estrutura técnica e de descoberta pode comunicar melhor a empresa. A primeira melhoria é alinhar título, descrição, hierarquia e conteúdo para facilitar entendimento e compartilhamento.";
  } else if (/conteúdo|contexto/i.test(primaryOpportunity)) {
    primaryOpportunity = "O site explica pouco sobre oferta e diferenciais. A primeira melhoria é transformar o conteúdo em uma jornada comercial: o que a empresa faz, por que escolher e como entrar em contato.";
  }

  return {
    score: Math.max(25, Math.min(98, score)),
    businessType: profile.type,
    services: profile.services,
    metaDescription,
    h1,
    strengths: Array.from(new Set(strengths)).slice(0, 8),
    issues: uniqueIssues,
    priorities,
    evidence,
    primaryOpportunity,
  };
}

function safeProjectName(name: string): string {
  return (
    "ritty-" +
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42)
  );
}

function getLead(db: AutomatonDatabase, leadId: string): any {
  ensureRevenueCommerceSchema(db);
  return db.raw.prepare("SELECT * FROM revenue_leads WHERE id=? LIMIT 1").get(leadId) as any;
}

async function enrichLeadInternal(db: AutomatonDatabase, leadId: string): Promise<any> {
  const lead = getLead(db, leadId);
  if (!lead) throw new Error("Lead not found: " + leadId);
  if (!lead.website) throw new Error("Lead has no public website URL to research.");

  const page = await fetchPublicPage(String(lead.website));
  const analysis = analyzeSite(page);
  const email = page.emails[0] || null;
  const phone = page.phones[0] || null;
  const contact = email || phone || page.whatsapp || page.contactUrl || null;
  const opportunity = String(lead.opportunity || "").trim() || analysis.primaryOpportunity;

  const evidence = {
    source: page.url,
    title: page.title,
    httpStatus: page.status,
    signals: page.signals,
    socials: page.socials,
    contact,
    contactUrl: page.contactUrl,
    researchedAt: now(),
  };

  db.raw.prepare(
    "UPDATE revenue_leads SET name=?,website=?,contact=?,email=?,phone=?,contact_url=?,opportunity=?,evidence_url=?,site_analysis=?,services=?,business_type=?,site_score=?,notes=?,updated_at=? WHERE id=?",
  ).run(
    page.title || lead.name,
    page.url,
    contact,
    email,
    phone,
    page.contactUrl || page.whatsapp || null,
    opportunity,
    page.url,
    JSON.stringify(analysis),
    JSON.stringify(analysis.services),
    analysis.businessType,
    analysis.score,
    JSON.stringify(evidence),
    now(),
    lead.id,
  );

  return getLead(db, lead.id);
}

function buildDemoSite(lead: any): {
  files: Array<{ path: string; content: string }>;
  title: string;
} {
  const name = String(lead.name || "Sua Empresa").trim().slice(0, 90);
  const type = String(lead.business_type || "negócio local").trim();
  const opportunity = String(lead.opportunity || "Uma presença digital mais clara e orientada à conversão.").replace(/\s+/g, " ").slice(0, 360);
  let analysis: any = {};
  try { analysis = JSON.parse(String(lead.site_analysis || "{}")); } catch {}
  let services: string[] = [];
  try { services = JSON.parse(String(lead.services || "[]")); } catch {}
  services = services.filter(Boolean).slice(0, 6);
  const issues: string[] = Array.isArray(analysis.priorities) ? analysis.priorities.slice(0, 3) : [];
  const strengths: string[] = Array.isArray(analysis.strengths) ? analysis.strengths.slice(0, 3) : [];
  const phone = String(lead.phone || lead.contact || "").replace(/[^0-9+]/g, "");
  const email = String(lead.email || "");
  const cta = phone ? "https://wa.me/" + phone.replace(/^\+/, "") : email ? "mailto:" + email : "#contato";
  const accentMap: Record<string, string> = {
    "gastronomia": "#f2a93b",
    "saúde": "#66d6c2",
    "beleza e estética": "#d8a4ff",
    "imobiliário": "#7db7ff",
    "serviços jurídicos": "#d9c38c",
    "contabilidade e finanças": "#8ee3a7",
    "automotivo": "#ff6f61",
    "construção e engenharia": "#e4c76a",
    "tecnologia": "#78a9ff",
    "varejo": "#f4c64f",
  };
  const accent = accentMap[type] || "#f4c64f";
  const serviceCards = services.length
    ? services.map((service, i) => "<article><span class='index'>0" + String(i + 1) + "</span><h3>" + escHtml(service) + "</h3><p>Oferta apresentada com clareza, benefício principal e caminho direto para o próximo passo.</p></article>").join("")
    : "<article><span class='index'>01</span><h3>Oferta</h3><p>Estrutura para apresentar serviços, diferenciais e próximos passos com clareza.</p></article>" +
      "<article><span class='index'>02</span><h3>Confiança</h3><p>Provas e informações essenciais organizadas para reduzir dúvidas antes do contato.</p></article>" +
      "<article><span class='index'>03</span><h3>Contato</h3><p>Um CTA claro para transformar interesse em conversa.</p></article>";
  const issueCards = (issues.length ? issues : ["Hierarquia comercial pode ser mais direta."]).map((issue, i) =>
    "<div class='diag'><span>0" + String(i + 1) + "</span><p>" + escHtml(issue) + "</p></div>"
  ).join("");
  const strengthLine = strengths.length ? strengths.map(escHtml).join(" · ") : "Base atual identificada e pronta para evolução.";
  const title = name + " — experiência digital";

  const html =
    "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<meta name='description' content='" + escAttr(opportunity) + "'><title>" + escHtml(title) + "</title><link rel='stylesheet' href='style.css'></head>" +
    "<body><div class='scene' aria-hidden='true'><div class='orb orb-a'></div><div class='orb orb-b'></div><div class='grid3d'></div></div><header><div><span class='eyebrow'>DEMONSTRAÇÃO PERSONALIZADA</span><strong>" + escHtml(name) + "</strong><small>" + escHtml(type) + "</small></div>" +
    "<a class='top-cta' href='" + escAttr(cta) + "'>Falar agora</a></header>" +
    "<main><section class='hero reveal'><div class='hero-copy'><span class='eyebrow'>UMA NOVA EXPERIÊNCIA PARA " + escHtml(name.toUpperCase().slice(0, 50)) + "</span>" +
    "<h1>Mais clareza. Mais confiança. Um caminho melhor até o contato.</h1><p>" + escHtml(opportunity) + "</p>" +
    "<div class='actions'><a class='cta' href='" + escAttr(cta) + "'>Quero falar com a equipe</a><a class='ghost' href='" + escAttr(String(lead.website || "#")) + "' target='_blank' rel='noreferrer'>Ver site atual</a></div>" +
    "<div class='proof'><b>Base analisada:</b> " + escHtml(strengthLine) + "</div></div>" +
    "<div class='visual'><div class='ring'></div><div class='core'></div><span>" + escHtml(String(analysis.score || "—")) + "<small>/100 análise</small></span></div></section>" +
    "<section class='reveal'><div class='section-head'><span class='eyebrow'>O QUE PODE FICAR MAIS FORTE</span><h2>Diagnóstico comercial</h2></div><div class='diag-grid'>" + issueCards + "</div></section>" +
    "<section class='reveal'><div class='section-head'><span class='eyebrow'>ESTRUTURA PROPOSTA</span><h2>Uma experiência pensada para o que " + escHtml(name) + " vende.</h2></div><div class='cards'>" + serviceCards + "</div></section>" +
    "<section class='contact reveal' id='contato'><span class='eyebrow'>PRÓXIMO PASSO</span><h2>O próximo clique pode ser o começo da conversa.</h2>" +
    "<p>Esta é uma demonstração. A versão final pode receber identidade visual, fotos, textos, provas sociais e integrações reais da empresa.</p>" +
    "<a class='cta' href='" + escAttr(cta) + "'>Solicitar proposta</a></section></main><script src='script.js'></script></body></html>";

  const css =
    ":root{--bg:#060606;--panel:#101010;--text:#f7f5ee;--muted:#a7a39a;--line:#232323;--accent:" + accent + "}" +
    "*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(900px 520px at 86% -4%,rgba(255,255,255,.08),transparent 58%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}" +
    "header{height:78px;padding:0 6vw;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:sticky;top:0;background:#070707e8;backdrop-filter:blur(16px);z-index:10}header strong{display:block;font-size:18px;letter-spacing:.01em}header small{display:block;color:var(--muted);font-size:10px;margin-top:3px;text-transform:capitalize}.eyebrow{display:block;color:var(--accent);font-size:9px;font-weight:850;letter-spacing:.18em;margin-bottom:8px}.top-cta,.cta{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:999px;background:var(--accent);color:#080808;padding:12px 17px;font-weight:850;box-shadow:0 16px 40px rgba(0,0,0,.24)}.ghost{display:inline-flex;align-items:center;text-decoration:none;border:1px solid #343434;border-radius:999px;color:var(--text);padding:12px 17px;font-weight:750}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}.hero{min-height:760px;display:grid;grid-template-columns:1.15fr .85fr;align-items:center;gap:5vw}.hero-copy{max-width:780px}.hero h1{font-size:clamp(52px,8vw,100px);line-height:.91;letter-spacing:-.055em;margin:10px 0 24px}.hero p{max-width:680px;color:var(--muted);font-size:19px;line-height:1.65;margin:0 0 8px}.proof{margin-top:24px;color:#c8c4bb;font-size:11px;line-height:1.6;max-width:650px}.visual{width:min(34vw,400px);aspect-ratio:1;border-radius:40%;position:relative;justify-self:end;background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.11),transparent 62%);border:1px solid rgba(255,255,255,.16);transform:rotate(16deg);box-shadow:0 50px 120px rgba(0,0,0,.28)}.visual .ring{position:absolute;inset:10%;border:1px solid var(--accent);opacity:.55;border-radius:42%;animation:spin 16s linear infinite}.visual .core{position:absolute;inset:28%;border-radius:50%;background:radial-gradient(circle at 38% 36%,#fff 0 2%,var(--accent) 15%,transparent 68%);filter:blur(1px)}.visual span{position:absolute;inset:auto 0 14%;text-align:center;font-weight:900;font-size:34px;transform:rotate(-16deg)}.visual span small{display:block;font-size:9px;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}.section-head{max-width:780px;margin:0 0 24px}.section-head h2{font-size:clamp(34px,6vw,66px);line-height:.98;letter-spacing:-.045em;margin:8px 0 0}.diag-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.diag{padding:24px;border:1px solid var(--line);border-radius:22px;background:#0d0d0d}.diag span{font-size:10px;color:var(--accent);font-weight:900}.diag p{margin:12px 0 0;color:#ddd9d0;line-height:1.55}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cards article,.contact{border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,#121212,#0b0b0b);padding:26px}.index{font-size:9px;color:var(--accent);letter-spacing:.18em;font-weight:900}.cards h3{font-size:24px;margin:16px 0 8px}.cards p,.contact p{color:var(--muted);line-height:1.65}.contact{margin:24px 0 90px;padding:40px}.contact h2{max-width:850px;font-size:clamp(38px,6vw,70px);line-height:.98;letter-spacing:-.05em;margin:0 0 14px}@keyframes spin{to{transform:rotate(360deg)}}.scene{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:-1;perspective:900px}.grid3d{position:absolute;width:90vw;height:90vw;left:50%;top:28%;transform:translate(-50%,-50%) rotateX(64deg);background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(circle,black,transparent 68%);animation:gridFloat 14s ease-in-out infinite}.orb{position:absolute;border-radius:50%;transform:translate(var(--mx,0),var(--my,0));transition:transform .25s ease-out}.orb-a{width:260px;height:260px;right:4%;top:10%;background:radial-gradient(circle at 35% 30%,#fff9 0 3%,var(--accent) 10%,transparent 62%);filter:blur(2px);animation:orbA 8s ease-in-out infinite}.orb-b{width:180px;height:180px;left:2%;bottom:8%;background:radial-gradient(circle,#ffffff33,transparent 68%);animation:orbB 10s ease-in-out infinite}.reveal{opacity:0;transform:translateY(24px);transition:opacity .8s ease,transform .8s ease}.reveal.visible{opacity:1;transform:none}.cards article,.diag{transition:transform .35s ease,box-shadow .35s ease}.cards article:hover,.diag:hover{transform:translateY(-8px) rotateX(2deg) rotateY(-2deg);box-shadow:0 24px 60px #0008}@keyframes orbA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-35px,25px,0) scale(1.08)}}@keyframes orbB{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(25px,-35px,0)}}@keyframes gridFloat{0%,100%{transform:translate(-50%,-50%) rotateX(64deg)}50%{transform:translate(-50%,-50%) rotateX(64deg) translateY(22px)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}@media(max-width:800px){header{padding:0 18px}.hero{min-height:720px;grid-template-columns:1fr;gap:20px}.visual{width:min(78vw,340px);justify-self:center;order:-1}.hero h1{font-size:clamp(52px,15vw,82px)}.diag-grid,.cards{grid-template-columns:1fr}main{padding:0 18px 70px}.top-cta{padding:10px 13px}.proof{font-size:10px}}";

  return {
    files: [
      { path: "index.html", content: html },
      { path: "style.css", content: css },
      { path: "script.js", content: "document.addEventListener('DOMContentLoaded',function(){document.body.dataset.ready='true';const root=document.documentElement;const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('visible')),{threshold:.12});document.querySelectorAll('.reveal').forEach(e=>io.observe(e));window.addEventListener('pointermove',e=>{root.style.setProperty('--mx',((e.clientX/innerWidth)-.5)*28+'px');root.style.setProperty('--my',((e.clientY/innerHeight)-.5)*28+'px')},{passive:true});});" },
    ],
    title,
  };
}

async function createDemoForLead(db: AutomatonDatabase, lead: any, offer: any): Promise<string> {
  const existing = offer && offer.preview_url ? String(offer.preview_url) : "";
  if (existing) return existing;

  const site = buildDemoSite(lead);
  const work = createWork(db, {
    title: "Sales demo — " + lead.name,
    description: "Criar uma demonstração pública personalizada para o prospect " + lead.name + ".",
    type: "sales-demo",
    customer: lead.name,
    successCriteria: "index.html, style.css e script.js existem e passam a validação.",
  });

  const result = await executeWorkBundle(
    db,
    work.id,
    {
      files: site.files,
      testCommand: "test -s index.html && test -s style.css && test -s script.js",
      artifacts: ["index.html", "style.css", "script.js"],
      summary: "Demonstração personalizada criada e validada para " + lead.name + ".",
    },
  );

  if (!result.completed) throw new Error(result.summary);

  const preview = publicBaseUrl() + "/preview/" + work.id + "/";
  if (offer && offer.id) {
    db.raw
      .prepare("UPDATE revenue_offers SET preview_url=?,updated_at=? WHERE id=?")
      .run(preview, now(), offer.id);
  }
  return preview;
}

export async function enrichLead(db: AutomatonDatabase, leadId: string): Promise<string> {
  try {
    const lead = await enrichLeadInternal(db, leadId);
    return JSON.stringify(
      {
        leadId: lead.id,
        name: lead.name,
        website: lead.website,
        email: lead.email || null,
        phone: lead.phone || null,
        whatsapp: lead.contact_url && /whatsapp|wa\.me/i.test(lead.contact_url) ? lead.contact_url : null,
        contactUrl: lead.contact_url || null,
        opportunity: lead.opportunity || null,
        evidenceUrl: lead.evidence_url || lead.website || null,
      },
      null,
      2,
    );
  } catch (error) {
    return "Lead enrichment failed: " + (error instanceof Error ? error.message : String(error));
  }
}

export async function prepareOutreach(
  db: AutomatonDatabase,
  args: {
    leadId: string;
    previewUrl?: string;
    channel?: "email" | "manual";
    customContext?: string;
  },
): Promise<string> {
  ensureRevenueCommerceSchema(db);
  let lead = await enrichLeadInternal(db, args.leadId);

  let offer = db.raw.prepare("SELECT * FROM revenue_offers WHERE lead_id=? ORDER BY created_at DESC LIMIT 1").get(lead.id) as any;
  if (!offer) {
    const offerId = ulid();
    const proposalPath = path.join(REVENUE_ROOT, "offers", "manual-" + String(lead.id) + "-" + offerId + ".md");
    fs.writeFileSync(proposalPath, [
      "# RITTY — Proposta de melhoria digital",
      "",
      "Prospect: " + lead.name,
      "Site analisado: " + lead.website,
      "Diagnóstico: " + (lead.opportunity || "Melhorar a jornada comercial."),
      "",
      "Esta proposta usa evidências públicas e uma demonstração personalizada como ponto de partida.",
    ].join("\n"), "utf8");
    db.raw.prepare("INSERT INTO revenue_offers (id,lead_id,title,price_cents,status,proposal_path,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      offerId, lead.id, "Site profissional / " + lead.name, DEFAULT_PRICE_CENTS, "draft", proposalPath,
      JSON.stringify({ website: lead.website, opportunity: lead.opportunity, analysis: lead.site_analysis ? JSON.parse(lead.site_analysis) : null }),
      now(), now(),
    );
    offer = db.raw.prepare("SELECT * FROM revenue_offers WHERE id=?").get(offerId) as any;
  }

  const previewUrl = String(args.previewUrl || "").trim() || (await createDemoForLead(db, lead, offer));
  offer = db.raw.prepare("SELECT * FROM revenue_offers WHERE id=?").get(offer.id) as any;

  let analysis: any = {};
  try { analysis = JSON.parse(String(lead.site_analysis || "{}")); } catch {}
  let services: string[] = [];
  try { services = JSON.parse(String(lead.services || "[]")); } catch {}
  const issues = Array.isArray(analysis.priorities) ? analysis.priorities.slice(0, 2) : [];
  const strengths = Array.isArray(analysis.strengths) ? analysis.strengths.slice(0, 2) : [];
  const destination = String(lead.email || lead.contact || lead.contact_url || "").trim();
  const channel = args.channel || (lead.email ? "email" : "manual");
  const subject = "Uma melhoria concreta para " + lead.name;
  const detailLines = issues.length ? issues.map((x: string) => "• " + x).join("\n") : "• Deixar a proposta de valor e o próximo passo comercial mais claros.";
  const strengthLine = strengths.length ? strengths.join(" · ") : "há uma base real para evoluir";
  const serviceLine = services.length ? "Serviços detectados: " + services.slice(0, 3).join(", ") + "." : "";

  const body = [
    "Olá, time da " + lead.name + ",",
    "",
    "Analisei o site atual de vocês e encontrei duas oportunidades claras de melhorar a jornada comercial:",
    detailLines,
    "",
    "Também notei que " + strengthLine.toLowerCase() + ".",
    serviceLine,
    "",
    "Para não ficar só no diagnóstico, preparei uma demonstração personalizada:",
    previewUrl,
    "",
    "A ideia é transformar a estrutura atual em uma experiência mais clara no celular, com oferta, prova e CTA organizados para facilitar o próximo passo.",
    "",
    "Se fizer sentido, eu adapto a demonstração para a identidade e os serviços reais da empresa e envio o escopo fechado.",
    "",
    "Investimento para esta condição inicial: R$ 397,00.",
    "A versão final é personalizada e publicada após a confirmação do pagamento.",
    "",
    "RITTY — Revenue Engine",
    args.customContext ? String(args.customContext).slice(0, 1200) : "",
  ].filter(Boolean).join("\n");

  const existing = db.raw.prepare("SELECT id,body,destination,subject,status FROM revenue_messages WHERE lead_id=? AND status IN ('draft','approved','sent') ORDER BY created_at DESC LIMIT 1").get(lead.id) as any;
  if (existing) {
    return JSON.stringify({
      leadId: lead.id, messageId: existing.id, destination: existing.destination, subject: existing.subject,
      body: existing.body, previewUrl, approvalRequired: existing.status !== "approved" && existing.status !== "sent", status: existing.status, sent: existing.status === "sent",
    }, null, 2);
  }

  const messageId = ulid();
  db.raw.prepare("INSERT INTO revenue_messages (id,lead_id,channel,destination,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    messageId, lead.id, channel, destination || null, subject, body, "draft", now(), now(),
  );

  const actionId = ulid();
  db.raw.prepare("INSERT INTO revenue_actions (id,lead_id,action,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    actionId, lead.id, "send_outreach", "pending_approval",
    JSON.stringify({ messageId, previewUrl, offerId: offer.id, diagnosis: issues }),
    now(), now(),
  );
  db.raw.prepare("UPDATE revenue_leads SET status='proposal',updated_at=? WHERE id=?").run(now(), lead.id);

  return JSON.stringify({
    actionId, messageId, leadId: lead.id, channel, destination, subject, body, previewUrl, offerId: offer.id,
    approvalRequired: true, sent: false,
  }, null, 2);
}

export function approveOutreach(db: AutomatonDatabase, actionId: string): string {
  ensureRevenueCommerceSchema(db);
  const action = db.raw
    .prepare("SELECT * FROM revenue_actions WHERE id=? AND action IN ('send_outreach','follow_up')")
    .get(actionId) as any;
  if (!action) return "Outreach action not found: " + actionId;
  if (action.status !== "pending_approval") {
    return "Outreach action is not awaiting approval. Current status: " + action.status;
  }

  db.raw
    .prepare("UPDATE revenue_actions SET status='approved',updated_at=? WHERE id=?")
    .run(now(), actionId);

  try {
    const payload = JSON.parse(action.payload || "{}");
    if (payload.messageId) {
      db.raw
        .prepare("UPDATE revenue_messages SET status='approved',updated_at=? WHERE id=?")
        .run(now(), payload.messageId);
    }
  } catch {}

  return "OUTREACH_APPROVED " + actionId;
}

async function sendResendEmail(to: string, subject: string, body: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
    }),
  });

  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    throw new Error(
      "Resend " + response.status + ": " + JSON.stringify(payload).slice(0, 900),
    );
  }
  return String(payload.id || "");
}

export async function sendApprovedOutreach(
  db: AutomatonDatabase,
  actionId: string,
): Promise<string> {
  ensureRevenueCommerceSchema(db);
  const action = db.raw
    .prepare("SELECT * FROM revenue_actions WHERE id=? AND action IN ('send_outreach','follow_up')")
    .get(actionId) as any;
  if (!action) return "Outreach action not found: " + actionId;
  if (action.status !== "approved") {
    return "Outreach is not approved. Human approval is required before any external message.";
  }

  let payload: any = {};
  try {
    payload = JSON.parse(action.payload || "{}");
  } catch {}

  const message = db.raw
    .prepare("SELECT * FROM revenue_messages WHERE id=?")
    .get(payload.messageId) as any;
  if (!message) return "Prepared outreach message not found.";
  if (message.channel !== "email") {
    return "Only email sending is automated. Use the prepared manual message for other channels.";
  }
  if (!message.destination || !/@/.test(String(message.destination))) {
    return "No usable public email is stored for this lead.";
  }

  try {
    const providerId = await sendResendEmail(
      String(message.destination),
      String(message.subject || "Uma ideia rápida"),
      String(message.body),
    );

    db.raw
      .prepare("UPDATE revenue_messages SET status='sent',provider_id=?,updated_at=? WHERE id=?")
      .run(providerId, now(), message.id);
    db.raw
      .prepare("UPDATE revenue_actions SET status='executed',updated_at=? WHERE id=?")
      .run(now(), actionId);
    db.raw
      .prepare("UPDATE revenue_leads SET status='contacted',updated_at=? WHERE id=?")
      .run(now(), message.lead_id);

    return "OUTREACH_SENT lead=" + message.lead_id + " providerId=" + providerId;
  } catch (error) {
    db.raw
      .prepare("UPDATE revenue_messages SET status='failed',updated_at=? WHERE id=?")
      .run(now(), message.id);
    return "OUTREACH_SEND_FAILED " + (error instanceof Error ? error.message : String(error));
  }
}

export function recordLeadResponse(
  db: AutomatonDatabase,
  args: { leadId: string; stage: "replied" | "interested" | "lost"; response: string },
): string {
  ensureRevenueCommerceSchema(db);
  const lead = getLead(db, args.leadId);
  if (!lead) return "Lead not found: " + args.leadId;

  const responseText = String(args.response || "").trim().slice(0, 6000);
  db.raw.prepare("UPDATE revenue_leads SET status=?,notes=COALESCE(notes,'') || ?,updated_at=? WHERE id=?").run(
    args.stage, "\nResposta (" + now() + "): " + responseText, now(), lead.id,
  );
  db.raw.prepare("INSERT INTO revenue_events (id,lead_id,type,amount_cents,currency,confirmed,notes,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
    ulid(), lead.id, "response_received", 0, "BRL", 0, args.stage + ": " + responseText.slice(0, 500), now(),
  );

  if (args.stage === "replied") {
    const existing = db.raw.prepare("SELECT id FROM revenue_actions WHERE lead_id=? AND action='follow_up' AND status IN ('pending_approval','approved') ORDER BY created_at DESC LIMIT 1").get(lead.id) as any;
    if (!existing) {
      const lastMessage = db.raw.prepare(
        "SELECT subject,channel FROM revenue_messages WHERE lead_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1",
      ).get(lead.id) as any;
      const channel = lastMessage?.channel === "email" ? "email" : "manual";
      const subject = lastMessage?.subject ? "Re: " + String(lastMessage.subject).replace(/^Re:\s*/i, "") : "Re: uma melhoria concreta para " + lead.name;
      const latestOfferForReply = db.raw.prepare(
        "SELECT preview_url FROM revenue_offers WHERE lead_id=? ORDER BY created_at DESC LIMIT 1",
      ).get(lead.id) as any;
      const previewUrl = String(latestOfferForReply?.preview_url || "");
      const body = [
        "Olá, time da " + lead.name + ",",
        "",
        "Obrigado pela resposta. Vi a mensagem e consigo seguir por aqui.",
        "",
        "A demonstração que preparei continua disponível:",
        previewUrl || lead.website || "",
        "",
        "Posso ajustar a proposta para a identidade e os serviços reais de vocês.",
        "Nesta condição inicial, a entrega completa fica em R$ 397,00.",
        "",
        "Se fizer sentido, me diga qual ponto vocês querem priorizar e eu sigo daí.",
        "",
        "RITTY — Revenue Engine",
      ].filter(Boolean).join("\n");
      const messageId = ulid();
      db.raw.prepare("INSERT INTO revenue_messages (id,lead_id,channel,destination,subject,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        messageId, lead.id, channel, lead.email || lead.contact || lead.contact_url || null, subject, body, "draft", now(), now(),
      );
      db.raw.prepare("INSERT INTO revenue_actions (id,lead_id,action,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
        ulid(), lead.id, "follow_up", "pending_approval",
        JSON.stringify({ messageId, reason: "Resposta recebida; resposta de continuidade preparada.", response: responseText }),
        now(), now(),
      );
    }
  }

  if (args.stage === "interested") {
    db.raw.prepare("INSERT INTO revenue_events (id,lead_id,type,amount_cents,currency,confirmed,notes,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
      ulid(), lead.id, "interest_confirmed", 0, "BRL", 0, "Interesse confirmado.", now(),
    );

    const latestOffer = db.raw.prepare(
      "SELECT id,price_cents FROM revenue_offers WHERE lead_id=? ORDER BY created_at DESC LIMIT 1",
    ).get(lead.id) as any;
    const existing = db.raw.prepare("SELECT id,status FROM revenue_actions WHERE lead_id=? AND action='create_checkout' AND status IN ('pending_approval','approved') ORDER BY created_at DESC LIMIT 1").get(lead.id) as any;
    if (!existing) {
      db.raw.prepare("INSERT INTO revenue_actions (id,lead_id,action,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
        ulid(), lead.id, "create_checkout", "pending_approval",
        JSON.stringify({
          reason: "Interesse confirmado; checkout pronto para aprovação humana.",
          nextStep: "approve_checkout",
          offerId: latestOffer?.id || null,
          amountCents: Math.min(50000, Math.max(20000, Number(latestOffer?.price_cents || DEFAULT_PRICE_CENTS))),
        }),
        now(), now(),
      );
    }
  }

  return "Lead " + lead.name + " moved to " + args.stage + ".";
}

export function approveCheckout(db: AutomatonDatabase, actionId: string): string {
  ensureRevenueCommerceSchema(db);
  const action = db.raw
    .prepare("SELECT * FROM revenue_actions WHERE id=? AND action='create_checkout'")
    .get(actionId) as any;
  if (!action) return "Checkout approval action not found: " + actionId;
  if (action.status !== "pending_approval") {
    return "Checkout action is not awaiting approval. Current status: " + action.status;
  }
  db.raw
    .prepare("UPDATE revenue_actions SET status='approved',updated_at=? WHERE id=?")
    .run(now(), actionId);
  return "CHECKOUT_APPROVED " + actionId;
}

function latestApprovedCheckoutAction(db: AutomatonDatabase, leadId: string): any {
  return db.raw
    .prepare(
      "SELECT * FROM revenue_actions WHERE lead_id=? AND action='create_checkout' AND status='approved' ORDER BY created_at DESC LIMIT 1",
    )
    .get(leadId) as any;
}

export async function createStripeCheckout(
  db: AutomatonDatabase,
  args: {
    leadId: string;
    offerId?: string;
    amountCents?: number;
    approved?: boolean;
  },
): Promise<string> {
  ensureRevenueCommerceSchema(db);

  const lead = getLead(db, args.leadId);
  if (!lead) return "Lead not found: " + args.leadId;

  const directCreatorApproval = args.approved === true;
  const approvedAction = latestApprovedCheckoutAction(db, lead.id);
  if (!directCreatorApproval && !approvedAction) {
    return "Checkout requires human approval. Approve the create_checkout action first.";
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return "Stripe is not configured. Set STRIPE_SECRET_KEY before creating live checkouts.";
  }

  const offer = args.offerId
    ? (db.raw
        .prepare("SELECT * FROM revenue_offers WHERE id=? AND lead_id=?")
        .get(args.offerId, lead.id) as any)
    : (db.raw
        .prepare("SELECT * FROM revenue_offers WHERE lead_id=? ORDER BY created_at DESC LIMIT 1")
        .get(lead.id) as any);

  const requestedAmount = Math.round(Number(args.amountCents || offer?.price_cents || DEFAULT_PRICE_CENTS));
  const amountCents = Math.min(50000, Math.max(20000, Number.isFinite(requestedAmount) ? requestedAmount : DEFAULT_PRICE_CENTS));

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set(
    "success_url",
    publicBaseUrl() + "/revenue/success?session_id={CHECKOUT_SESSION_ID}",
  );
  params.set("cancel_url", publicBaseUrl() + "/revenue/cancelled");
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "brl");
  params.set(
    "line_items[0][price_data][product_data][name]",
    "Site profissional — " + lead.name,
  );
  params.set(
    "line_items[0][price_data][product_data][description]",
    "Criação, personalização e publicação de site profissional.",
  );
  params.set("line_items[0][price_data][unit_amount]", String(amountCents));
  params.set("metadata[leadId]", String(lead.id));
  params.set("metadata[offerId]", String(offer?.id || ""));
  params.set("metadata[service]", "website");
  params.set("customer_creation", "always");

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const session = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    throw new Error(
      "Stripe " + response.status + ": " + JSON.stringify(session).slice(0, 1000),
    );
  }

  const checkoutId = ulid();
  db.raw
    .prepare(
      "INSERT INTO revenue_checkouts (id,lead_id,offer_id,provider,provider_checkout_id,url,amount_cents,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      checkoutId,
      lead.id,
      offer?.id || null,
      "stripe",
      session.id,
      session.url,
      amountCents,
      "brl",
      "created",
      now(),
      now(),
    );

  if (offer?.id) {
    db.raw
      .prepare("UPDATE revenue_offers SET status='checkout',checkout_url=?,updated_at=? WHERE id=?")
      .run(session.url, now(), offer.id);
  }

  db.raw
    .prepare("UPDATE revenue_leads SET status='checkout',updated_at=? WHERE id=?")
    .run(now(), lead.id);

  if (approvedAction) {
    db.raw
      .prepare("UPDATE revenue_actions SET status='executed',updated_at=? WHERE id=?")
      .run(now(), approvedAction.id);
  }

  return JSON.stringify(
    {
      checkoutId,
      provider: "stripe",
      providerCheckoutId: session.id,
      url: session.url,
      amountCents,
      amountBRL: amountCents / 100,
      leadId: lead.id,
      offerId: offer?.id || null,
    },
    null,
    2,
  );
}

function verifyStripeSignature(rawBody: string, signature: string, secret: string): boolean {
  const parts = signature
    .split(",")
    .map((item) => item.trim().split("="));
  const timestamp = parts.find((item) => item[0] === "t")?.[1];
  const signatures = parts
    .filter((item) => item[0] === "v1")
    .map((item) => item[1])
    .filter(Boolean);

  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + "." + rawBody)
    .digest("hex");

  return signatures.some((candidate) => {
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, "utf8"),
        Buffer.from(candidate, "utf8"),
      );
    } catch {
      return false;
    }
  });
}

async function getStripeSession(sessionId: string): Promise<any> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured.");

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId),
    {
      headers: { authorization: "Bearer " + secret },
    },
  );
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    throw new Error(
      "Stripe " + response.status + ": " + JSON.stringify(payload).slice(0, 900),
    );
  }
  return payload;
}

async function processPaidStripeSession(
  db: AutomatonDatabase,
  session: any,
): Promise<string> {
  ensureRevenueCommerceSchema(db);

  if (session.payment_status !== "paid") {
    return "Stripe session is not paid yet.";
  }

  const leadId = String(session.metadata?.leadId || "");
  const offerId = String(session.metadata?.offerId || "") || undefined;
  if (!leadId) throw new Error("Stripe session missing leadId metadata.");

  const lead = getLead(db, leadId);
  if (!lead) throw new Error("Lead not found from Stripe metadata: " + leadId);

  const email = String(session.customer_details?.email || "");
  if (email) {
    db.raw
      .prepare("UPDATE revenue_leads SET email=?,updated_at=? WHERE id=?")
      .run(email, now(), lead.id);
  }

  db.raw
    .prepare("UPDATE revenue_checkouts SET status='paid',updated_at=? WHERE provider_checkout_id=?")
    .run(now(), String(session.id));

  db.raw
    .prepare("UPDATE revenue_leads SET status='paid',updated_at=? WHERE id=?")
    .run(now(), lead.id);

  const amount = Math.round(Number(session.amount_total || 0));

  db.raw
    .prepare(
      "INSERT OR IGNORE INTO revenue_events (id,lead_id,type,amount_cents,currency,confirmed,notes,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      "stripe-" + String(session.id),
      lead.id,
      "payment_confirmed",
      amount,
      "BRL",
      1,
      "Stripe checkout " + String(session.id),
      now(),
    );

  const existing = db.raw
    .prepare(
      "SELECT id,status FROM revenue_fulfillments WHERE lead_id=? AND status IN ('running','delivered') ORDER BY created_at DESC LIMIT 1",
    )
    .get(lead.id) as any;

  if (existing) {
    return "STRIPE_PAYMENT_ALREADY_FULFILLED lead=" + lead.id;
  }

  const fulfillment = await fulfillPaidOrder(db, lead.id, offerId);
  return "STRIPE_PAYMENT_CONFIRMED " + fulfillment;
}

export async function handleStripeWebhook(
  db: AutomatonDatabase,
  rawBody: string,
  signature: string,
): Promise<string> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    throw new Error("Invalid Stripe webhook signature.");
  }

  const event = JSON.parse(rawBody) as any;
  if (event.type === "checkout.session.completed") {
    return processPaidStripeSession(db, event.data?.object || {});
  }
  return "Stripe event " + String(event.type || "unknown") + " ignored safely.";
}

export async function confirmStripeSuccess(
  db: AutomatonDatabase,
  sessionId: string,
): Promise<string> {
  const session = await getStripeSession(sessionId);
  if (
    !session.id ||
    session.mode !== "payment" ||
    String(session.metadata?.service || "") !== "website"
  ) {
    throw new Error("Stripe session is not a RITTY website checkout.");
  }
  return processPaidStripeSession(db, session);
}

export function buildFinalSite(lead: any): {
  files: Array<{ path: string; content: string }>;
  title: string;
} {
  const name = String(lead.name || "Sua Empresa").trim().slice(0, 90);
  const opportunity = String(
    lead.opportunity || "Uma presença digital mais clara e orientada à conversão.",
  ).slice(0, 320);
  const email = String(lead.email || "");
  const phone = String(lead.phone || lead.contact || "").replace(/[^0-9+]/g, "");
  const cta = phone
    ? "https://wa.me/" + phone.replace(/^\+/, "")
    : email
      ? "mailto:" + email
      : "#contato";

  const html =
    "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + escHtml(name) + " — Site</title><link rel='stylesheet' href='style.css'></head>" +
    "<body><div class='scene' aria-hidden='true'><div class='orb orb-a'></div><div class='orb orb-b'></div><div class='grid3d'></div></div><header><div><span class='eyebrow'>PRESENÇA DIGITAL</span><strong>" +
    escHtml(name) +
    "</strong></div><a class='top-cta' href='" +
    escAttr(cta) +
    "'>Falar agora</a></header>" +
    "<main><section class='hero reveal'><div><span class='eyebrow'>A SUA MARCA, ONLINE</span>" +
    "<h1>Uma experiência digital feita para transformar atenção em negócio.</h1><p>" +
    escHtml(opportunity) +
    "</p><a class='cta' href='" +
    escAttr(cta) +
    "'>Entrar em contato</a></div></section>" +
    "<section class='cards'><article><b>Apresentação</b><p>Oferta, diferenciais e proposta de valor organizados para facilitar a decisão.</p></article>" +
    "<article><b>Conversão</b><p>Chamadas para ação claras para aproximar o visitante do próximo passo.</p></article>" +
    "<article><b>Responsivo</b><p>Uma base rápida e adaptada a celular, tablet e desktop.</p></article></section>" +
    "<section class='contact' id='contato'><span class='eyebrow'>CONTATO</span><h2>Vamos conversar.</h2><p>O conteúdo final da marca pode ser personalizado nesta base.</p>" +
    "<a class='cta' href='" +
    escAttr(cta) +
    "'>Solicitar atendimento</a></section></main>" +
    "<script src='script.js'></script></body></html>";

  const css =
    ":root{--bg:#050505;--panel:#101010;--text:#f7f6f2;--muted:#a8a59c;--line:#242424;--accent:#f4c64f}" +
    "*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 80% 0%,#2a2307 0%,transparent 58%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,sans-serif}" +
    "header{height:72px;padding:0 7vw;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:sticky;top:0;background:#070707ee;backdrop-filter:blur(14px);z-index:5}" +
    "header strong{display:block;font-size:18px}.eyebrow{font-size:9px;letter-spacing:.18em;font-weight:800;color:var(--accent);display:block;margin-bottom:6px}.top-cta,.cta{display:inline-flex;text-decoration:none;background:var(--accent);color:#0b0b0b;border-radius:999px;padding:12px 16px;font-weight:850}" +
    "main{max-width:1120px;margin:0 auto;padding:0 7vw 90px}.hero{min-height:650px;display:flex;align-items:center}.hero h1{font-size:clamp(50px,8vw,92px);line-height:.92;letter-spacing:-.05em;max-width:850px;margin:10px 0 22px}.hero p{color:var(--muted);font-size:18px;line-height:1.65;max-width:640px;margin-bottom:28px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.cards article,.contact{background:linear-gradient(180deg,#121212,#0b0b0b);border:1px solid var(--line);border-radius:23px;padding:28px}.cards p,.contact p{color:var(--muted);line-height:1.65}.contact{margin-top:15px;padding:38px}.contact h2{font-size:clamp(34px,5vw,58px);margin:0 0 12px;letter-spacing:-.04em}.scene{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:-1;perspective:900px}.grid3d{position:absolute;width:90vw;height:90vw;left:50%;top:28%;transform:translate(-50%,-50%) rotateX(64deg);background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(circle,black,transparent 68%);animation:gridFloat 14s ease-in-out infinite}.orb{position:absolute;border-radius:50%;transform:translate(var(--mx,0),var(--my,0));transition:transform .25s ease-out}.orb-a{width:260px;height:260px;right:4%;top:10%;background:radial-gradient(circle at 35% 30%,#fff9 0 3%,var(--accent) 10%,transparent 62%);filter:blur(2px);animation:orbA 8s ease-in-out infinite}.orb-b{width:180px;height:180px;left:2%;bottom:8%;background:radial-gradient(circle,#ffffff33,transparent 68%);animation:orbB 10s ease-in-out infinite}.reveal{opacity:0;transform:translateY(24px);transition:opacity .8s ease,transform .8s ease}.reveal.visible{opacity:1;transform:none}.cards article,.diag{transition:transform .35s ease,box-shadow .35s ease}.cards article:hover,.diag:hover{transform:translateY(-8px) rotateX(2deg) rotateY(-2deg);box-shadow:0 24px 60px #0008}@keyframes orbA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-35px,25px,0) scale(1.08)}}@keyframes orbB{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(25px,-35px,0)}}@keyframes gridFloat{0%,100%{transform:translate(-50%,-50%) rotateX(64deg)}50%{transform:translate(-50%,-50%) rotateX(64deg) translateY(22px)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}" +
    "@media(max-width:780px){header{padding:0 18px}.hero{min-height:620px}.cards{grid-template-columns:1fr}main{padding-left:18px;padding-right:18px}}";

  return {
    files: [
      { path: "index.html", content: html },
      { path: "style.css", content: css },
      { path: "script.js", content: "document.body.dataset.ready='true';const root=document.documentElement;const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('visible')),{threshold:.12});document.querySelectorAll('.reveal').forEach(e=>io.observe(e));window.addEventListener('pointermove',e=>{root.style.setProperty('--mx',((e.clientX/innerWidth)-.5)*28+'px');root.style.setProperty('--my',((e.clientY/innerHeight)-.5)*28+'px')},{passive:true});" },
    ],
    title: name + " — Site",
  };
}

async function sendDeliveryEmail(
  to: string,
  url: string,
  name: string,
): Promise<void> {
  if (!to) return;
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error("Resend is not configured for delivery email.");
  }
  await sendResendEmail(
    to,
    "Seu novo site — " + name,
    [
      "Olá, " + name + ".",
      "",
      "Seu pedido foi recebido e processado.",
      "Versão entregue: " + url,
      "",
      "Obrigado,",
      "RITTY",
    ].join("\n"),
  );
}

async function publishVercel(
  files: Array<{ path: string; content: string }>,
  projectName: string,
): Promise<string | null> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.log("[revenue] Vercel publish skipped: VERCEL_TOKEN is not configured.");
    return null;
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const query = teamId ? "?teamId=" + encodeURIComponent(teamId) : "";
  const response = await fetch("https://api.vercel.com/v13/deployments" + query, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      target: "production",
      files: files.map((file) => ({ file: file.path, data: file.content })),
      projectSettings: {
        framework: null,
        buildCommand: null,
        outputDirectory: null,
      },
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    throw new Error(
      "Vercel " + response.status + ": " + JSON.stringify(payload).slice(0, 900),
    );
  }

  if (payload.url) return "https://" + String(payload.url).replace(/^https?:\/\//, "");
  if (Array.isArray(payload.alias) && payload.alias[0]) return "https://" + String(payload.alias[0]).replace(/^https?:\/\//, "");
  return null;
}

export async function fulfillPaidOrder(
  db: AutomatonDatabase,
  leadId: string,
  offerId?: string,
): Promise<string> {
  ensureRevenueCommerceSchema(db);
  const lead = getLead(db, leadId);
  if (!lead) throw new Error("Lead not found: " + leadId);

  const existing = db.raw.prepare(
    "SELECT id,status,published_url FROM revenue_fulfillments WHERE lead_id=? AND status IN ('running','delivered') ORDER BY created_at DESC LIMIT 1",
  ).get(lead.id) as any;
  if (existing) {
    return JSON.stringify({
      fulfillmentId: existing.id,
      status: existing.status,
      publishedUrl: existing.published_url || null,
      alreadyProcessed: true,
    });
  }

  const fulfillmentId = ulid();
  db.raw.prepare(
    "INSERT INTO revenue_fulfillments (id,lead_id,offer_id,status,delivery_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(fulfillmentId, lead.id, offerId || null, "running", lead.email || null, now(), now());
  db.raw.prepare("UPDATE revenue_leads SET status='fulfillment',updated_at=? WHERE id=?").run(now(), lead.id);

  try {
    const site = buildFinalSite(lead);
    const work = createWork(db, {
      title: "Entrega paga — " + lead.name,
      description: "Gerar, validar e publicar a versão final do site para " + lead.name + " após pagamento confirmado.",
      type: "revenue-fulfillment",
      customer: lead.name,
      successCriteria: "index.html, style.css e script.js existem e passam a validação.",
    });
    const result = await executeWorkBundle(db, work.id, {
      files: site.files,
      testCommand: "test -s index.html && test -s style.css && test -s script.js",
      artifacts: ["index.html", "style.css", "script.js"],
      summary: "Versão final gerada e validada para " + lead.name + ".",
    });
    if (!result.completed) throw new Error(result.summary);

    const stableDir = path.join(REVENUE_ROOT, "fulfillments", fulfillmentId);
    fs.mkdirSync(stableDir, { recursive: true });
    for (const file of site.files) {
      const target = path.join(stableDir, file.path);
      if (!target.startsWith(stableDir + path.sep)) throw new Error("Unsafe fulfillment path.");
      fs.writeFileSync(target, file.content, "utf8");
    }

    const previewUrl = publicBaseUrl() + "/preview/" + work.id + "/";
    const rittyHostedUrl = publicBaseUrl() + "/sites/" + fulfillmentId + "/";
    let publishedUrl: string | null = rittyHostedUrl;
    let hosting = "ritty";

    try {
      const vercelUrl = await publishVercel(site.files, safeProjectName(lead.name));
      if (vercelUrl) {
        publishedUrl = vercelUrl;
        hosting = "vercel";
      }
    } catch (error) {
      db.raw.prepare("UPDATE revenue_fulfillments SET error=COALESCE(error,'') || ?,updated_at=? WHERE id=?").run(
        " Vercel publish failed: " + (error instanceof Error ? error.message : String(error)), now(), fulfillmentId,
      );
    }

    db.raw.prepare(
      "UPDATE revenue_fulfillments SET status='delivered',work_id=?,preview_url=?,published_url=?,updated_at=? WHERE id=?",
    ).run(work.id, previewUrl, publishedUrl, now(), fulfillmentId);

    db.raw.prepare("UPDATE revenue_leads SET status='won',updated_at=? WHERE id=?").run(now(), lead.id);
    if (offerId) {
      db.raw.prepare("UPDATE revenue_offers SET status='won',preview_url=?,updated_at=? WHERE id=?").run(publishedUrl, now(), offerId);
    }

    await sendDeliveryEmail(
      String(lead.email || ""),
      String(publishedUrl || rittyHostedUrl),
      String(lead.name || "cliente"),
    ).catch((error) => {
      db.raw.prepare("UPDATE revenue_fulfillments SET error=COALESCE(error,'') || ?,updated_at=? WHERE id=?").run(
        " Delivery email failed: " + (error instanceof Error ? error.message : String(error)), now(), fulfillmentId,
      );
    });

    return JSON.stringify({
      fulfillmentId,
      workId: work.id,
      previewUrl,
      publishedUrl,
      hosting,
      status: "delivered",
      title: site.title,
    }, null, 2);
  } catch (error) {
    db.raw.prepare("UPDATE revenue_fulfillments SET status='failed',error=?,updated_at=? WHERE id=?").run(
      error instanceof Error ? error.message : String(error), now(), fulfillmentId,
    );
    throw error;
  }
}

export function recordRevenueCost(
  db: AutomatonDatabase,
  args: { amountCents: number; category: string; description?: string },
): string {
  ensureRevenueCommerceSchema(db);
  if (!Number.isFinite(args.amountCents) || args.amountCents < 0) {
    return "Invalid cost amount.";
  }
  db.raw
    .prepare(
      "INSERT INTO revenue_costs (id,category,amount_cents,description,created_at) VALUES (?,?,?,?,?)",
    )
    .run(
      ulid(),
      String(args.category || "api"),
      Math.round(args.amountCents),
      args.description || null,
      now(),
    );
  return (
    "Recorded cost R$ " +
    (args.amountCents / 100).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
    })
  );
}

function count(db: AutomatonDatabase, query: string): number {
  const row = db.raw.prepare(query).get() as any;
  return Number(row?.c || 0);
}

export function revenueMetrics(db: AutomatonDatabase): string {
  ensureRevenueCommerceSchema(db);
  const raw = db.raw;

  const leads = count(db, "SELECT COUNT(*) c FROM revenue_leads");
  const contacted = count(
    db,
    "SELECT COUNT(*) c FROM revenue_leads WHERE status IN ('contacted','replied','interested','proposal','checkout','paid','fulfillment','won')",
  );
  const responses = count(
    db,
    "SELECT COUNT(*) c FROM revenue_leads WHERE status IN ('replied','interested','proposal','checkout','paid','fulfillment','won')",
  );
  const proposals = count(db, "SELECT COUNT(*) c FROM revenue_offers");
  const sent = count(db, "SELECT COUNT(*) c FROM revenue_messages WHERE status='sent'");
  const sales = count(
    db,
    "SELECT COUNT(*) c FROM revenue_events WHERE type='payment_confirmed' AND confirmed=1",
  );
  const revenue = Number(
    (
      raw
        .prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM revenue_events WHERE confirmed=1")
        .get() as any
    )?.c || 0,
  );
  const manualCosts = Number(
    (
      raw
        .prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM revenue_costs")
        .get() as any
    )?.c || 0,
  );

  // Inference usage is already recorded by the runtime in inference_costs.
  // Fold it into the revenue ledger view automatically so profit never
  // depends on remembering to manually enter every model call.
  const inferenceCosts = Number(
    (
      raw
        .prepare("SELECT COALESCE(SUM(cost_cents),0) c FROM inference_costs")
        .get() as any
    )?.c || 0,
  );
  const costs = manualCosts + inferenceCosts;

  const replyRate = contacted > 0 ? responses / contacted : 0;
  const closeRate = proposals > 0 ? sales / proposals : 0;
  const leadToSale = leads > 0 ? sales / leads : 0;

  const last7Cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const eventRows = raw
    .prepare("SELECT amount_cents,confirmed,created_at FROM revenue_events WHERE confirmed=1")
    .all() as any[];
  const costRows = raw
    .prepare("SELECT amount_cents,created_at FROM revenue_costs")
    .all() as any[];

  let last7Revenue = 0;
  let last7Costs = 0;
  for (const row of eventRows) {
    if (Date.parse(String(row.created_at || "")) >= last7Cutoff) {
      last7Revenue += Number(row.amount_cents || 0);
    }
  }
  for (const row of costRows) {
    if (Date.parse(String(row.created_at || "")) >= last7Cutoff) {
      last7Costs += Number(row.amount_cents || 0);
    }
  }

  return JSON.stringify(
    {
      funnel: {
        leads,
        contacted,
        responses,
        proposals,
        messagesSent: sent,
        sales,
        replyRate: Number(replyRate.toFixed(4)),
        closeRate: Number(closeRate.toFixed(4)),
        leadToSale: Number(leadToSale.toFixed(4)),
        targetScenario: "100 leads -> 20 respostas -> 5 propostas -> 1 venda",
      },
      revenueBRL: revenue / 100,
      costsBRL: costs / 100,
      netProfitBRL: (revenue - costs) / 100,
      profitable: revenue > costs && revenue > 0,
      avgSaleBRL: sales > 0 ? revenue / 100 / sales : 0,
      last7d: {
        revenueBRL: Number((last7Revenue / 100).toFixed(2)),
        costsBRL: Number((last7Costs / 100).toFixed(2)),
        netProfitBRL: Number(((last7Revenue - last7Costs) / 100).toFixed(2)),
      },
      costTracking: {
        manualCostsBRL: manualCosts / 100,
        inferenceCostsBRL: inferenceCosts / 100,
        automaticApiCost: true,
        sources: ["revenue_costs", "inference_costs"],
        note: "Model/API inference costs are pulled automatically from the runtime cost ledger; other operational costs can still be recorded with revenue_record_cost.",
      },
    },
    null,
    2,
  );
}
