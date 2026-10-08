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
    "<a class='cta' href='" + escAttr(cta) + "'>Solicitar proposta</a></section></main><script src='script.js?v=adaptive-20261008'></script></body></html>";

  const css =
    ":root{--bg:#060606;--panel:#101010;--text:#f7f5ee;--muted:#a7a39a;--line:#232323;--accent:" + accent + "}" +
    "*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(900px 520px at 86% -4%,rgba(255,255,255,.08),transparent 58%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}" +
    "header{height:78px;padding:0 6vw;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:sticky;top:0;background:#070707e8;backdrop-filter:blur(16px);z-index:10}header strong{display:block;font-size:18px;letter-spacing:.01em}header small{display:block;color:var(--muted);font-size:10px;margin-top:3px;text-transform:capitalize}.eyebrow{display:block;color:var(--accent);font-size:9px;font-weight:850;letter-spacing:.18em;margin-bottom:8px}.top-cta,.cta{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:999px;background:var(--accent);color:#080808;padding:12px 17px;font-weight:850;box-shadow:0 16px 40px rgba(0,0,0,.24)}.ghost{display:inline-flex;align-items:center;text-decoration:none;border:1px solid #343434;border-radius:999px;color:var(--text);padding:12px 17px;font-weight:750}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}.hero{min-height:760px;display:grid;grid-template-columns:1.15fr .85fr;align-items:center;gap:5vw}.hero-copy{max-width:780px}.hero h1{font-size:clamp(52px,8vw,100px);line-height:.91;letter-spacing:-.055em;margin:10px 0 24px}.hero p{max-width:680px;color:var(--muted);font-size:19px;line-height:1.65;margin:0 0 8px}.proof{margin-top:24px;color:#c8c4bb;font-size:11px;line-height:1.6;max-width:650px}.visual{width:min(34vw,400px);aspect-ratio:1;border-radius:40%;position:relative;justify-self:end;background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.11),transparent 62%);border:1px solid rgba(255,255,255,.16);transform:rotate(16deg);box-shadow:0 50px 120px rgba(0,0,0,.28)}.visual .ring{position:absolute;inset:10%;border:1px solid var(--accent);opacity:.55;border-radius:42%;animation:spin 16s linear infinite}.visual .core{position:absolute;inset:28%;border-radius:50%;background:radial-gradient(circle at 38% 36%,#fff 0 2%,var(--accent) 15%,transparent 68%);filter:blur(1px)}.visual span{position:absolute;inset:auto 0 14%;text-align:center;font-weight:900;font-size:34px;transform:rotate(-16deg)}.visual span small{display:block;font-size:9px;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}.section-head{max-width:780px;margin:0 0 24px}.section-head h2{font-size:clamp(34px,6vw,66px);line-height:.98;letter-spacing:-.045em;margin:8px 0 0}.diag-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.diag{padding:24px;border:1px solid var(--line);border-radius:22px;background:#0d0d0d}.diag span{font-size:10px;color:var(--accent);font-weight:900}.diag p{margin:12px 0 0;color:#ddd9d0;line-height:1.55}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.cards article,.contact{border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,#121212,#0b0b0b);padding:26px}.index{font-size:9px;color:var(--accent);letter-spacing:.18em;font-weight:900}.cards h3{font-size:24px;margin:16px 0 8px}.cards p,.contact p{color:var(--muted);line-height:1.65}.contact{margin:24px 0 90px;padding:40px}.contact h2{max-width:850px;font-size:clamp(38px,6vw,70px);line-height:.98;letter-spacing:-.05em;margin:0 0 14px}@keyframes spin{to{transform:rotate(360deg)}}.scene{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:-1;perspective:900px}.grid3d{position:absolute;width:90vw;height:90vw;left:50%;top:28%;transform:translate(-50%,-50%) rotateX(64deg);background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(circle,black,transparent 68%);animation:gridFloat 14s ease-in-out infinite}.orb{position:absolute;border-radius:50%;transform:translate(var(--mx,0),var(--my,0));transition:transform .25s ease-out}.orb-a{width:260px;height:260px;right:4%;top:10%;background:radial-gradient(circle at 35% 30%,#fff9 0 3%,var(--accent) 10%,transparent 62%);filter:blur(2px);animation:orbA 8s ease-in-out infinite}.orb-b{width:180px;height:180px;left:2%;bottom:8%;background:radial-gradient(circle,#ffffff33,transparent 68%);animation:orbB 10s ease-in-out infinite}.reveal{opacity:0;transform:translateY(24px);transition:opacity .8s ease,transform .8s ease}.reveal.visible{opacity:1;transform:none}.cards article,.diag{transition:transform .35s ease,box-shadow .35s ease}.cards article:hover,.diag:hover{transform:translateY(-8px) rotateX(2deg) rotateY(-2deg);box-shadow:0 24px 60px #0008}@keyframes orbA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-35px,25px,0) scale(1.08)}}@keyframes orbB{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(25px,-35px,0)}}@keyframes gridFloat{0%,100%{transform:translate(-50%,-50%) rotateX(64deg)}50%{transform:translate(-50%,-50%) rotateX(64deg) translateY(22px)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}@media(max-width:800px){header{padding:0 18px}.hero{min-height:720px;grid-template-columns:1fr;gap:20px}.visual{width:min(78vw,340px);justify-self:center;order:-1}.hero h1{font-size:clamp(52px,15vw,82px)}.diag-grid,.cards{grid-template-columns:1fr}main{padding:0 18px 70px}.top-cta{padding:10px 13px}.proof{font-size:10px}}";

  return {
    files: [
      { path: "index.html", content: html },
      { path: "style.css", content: finalCss },
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
  const opportunity = String(lead.opportunity || "Uma presença digital mais clara e orientada à conversão.").replace(/\s+/g, " ").slice(0, 360);
  const email = String(lead.email || "");
  const phone = String(lead.phone || lead.contact || "").replace(/[^0-9+]/g, "");
  const cta = phone ? "https://wa.me/" + phone.replace(/^\+/, "") : email ? "mailto:" + email : "#contato";
  const corpus = [name, opportunity, String(lead.business_type || ""), String(lead.services || "")].join(" ").toLowerCase();
  const has = (words: string[]) => words.some((word) => corpus.includes(word));
  const isClinic = has(["clínica","clinica","estética avançada","estetica avancada","dermatologia","harmonização","harmonizacao","botox","toxina","bioestimulador","laser facial","laser","skin","pele","procedimentos faciais","contorno corporal","medicina estética","medicina estetica"]);
  const isDelicate = !isClinic && has(["salão","salao","beleza","estética","estetica","spa","cabelo","manicure","pedicure","maquiagem","sobrancelha","lash","noiva","autocuidado","wellness","flor","boutique","moda"]);
  const isBold = !isClinic && has(["automotivo","lava-rápido","lava rapido","barbearia","oficina","mecânica","mecanica","funilaria","auto elétrica","academia","crossfit","tattoo","industrial","motors"]);
  const isPremium = !isClinic && !isDelicate && !isBold && has(["arquitetura","engenharia","imobili","advocacia","advogado","contabilidade","finanças","financeiro","consultoria","joias","odont","clínica","clinica","fisioterapia"]);
  const isSensory = !isClinic && !isDelicate && !isBold && has(["restaurante","pizzaria","café","cafe","gastronomia","hotel","bar","vinho","chef"]);
  const profile = isClinic ? "clinic" : isDelicate ? "delicate" : isBold ? "bold" : isPremium ? "premium" : isSensory ? "sensory" : "modern";

  const palette = profile === "clinic"
    ? { bg:"#f5f1ec", text:"#241f1c", muted:"#766e68", accent:"#a66f5c", accent2:"#d9b6a8", line:"rgba(55,40,32,.14)", panel:"rgba(255,255,255,.76)", display:"Georgia, 'Times New Roman', serif" }
    : profile === "delicate"
      ? { bg:"#f8f1ef", text:"#2b2327", muted:"#786b70", accent:"#bd718b", accent2:"#e9c3cf", line:"rgba(65,40,50,.13)", panel:"rgba(255,255,255,.64)", display:"Georgia, 'Times New Roman', serif" }
      : profile === "bold"
      ? { bg:"#07080a", text:"#f4f5f7", muted:"#8f969f", accent:"#ff5b35", accent2:"#ffb347", line:"rgba(255,255,255,.12)", panel:"rgba(15,17,20,.78)", display:"Inter,ui-sans-serif,system-ui,sans-serif" }
      : profile === "premium"
        ? { bg:"#0c0c0b", text:"#f4f0e7", muted:"#a49e91", accent:"#c5a66b", accent2:"#f0ddaa", line:"rgba(255,255,255,.12)", panel:"rgba(20,19,17,.76)", display:"Georgia, 'Times New Roman', serif" }
        : profile === "sensory"
          ? { bg:"#100c09", text:"#f7eee4", muted:"#b7a69a", accent:"#d59a61", accent2:"#f2d0a8", line:"rgba(255,255,255,.12)", panel:"rgba(26,18,14,.76)", display:"Georgia, 'Times New Roman', serif" }
          : { bg:"#070a10", text:"#eef3fb", muted:"#9ba8b8", accent:"#78a8ff", accent2:"#b8d2ff", line:"rgba(255,255,255,.11)", panel:"rgba(14,19,28,.78)", display:"Inter,ui-sans-serif,system-ui,sans-serif" };

  const title = profile === "clinic"
    ? "Estética avançada com naturalidade, precisão e cuidado."
    : profile === "delicate"
      ? "A sua beleza merece uma experiência à altura."
      : profile === "bold"
        ? "Presença forte. Movimento. Resultado."
        : profile === "premium"
          ? "Credibilidade que se percebe antes de ser explicada."
          : profile === "sensory"
            ? "Uma experiência que começa antes do primeiro pedido."
            : "Uma presença digital feita para transformar atenção em negócio.";

  const subtitle = profile === "clinic"
    ? "Uma experiência premium em Belo Horizonte para quem busca protocolos personalizados, resultados elegantes e atendimento que começa antes do primeiro procedimento."
    : profile === "delicate"
      ? "Um espaço digital feminino, sofisticado e acolhedor — pensado para transmitir cuidado, desejo e confiança desde o primeiro olhar."
      : profile === "bold"
        ? "Uma experiência visual de alto impacto, com ritmo, contraste e caminhos diretos para orçamento, agenda ou venda."
        : profile === "premium"
          ? "Uma experiência editorial, precisa e silenciosa — feita para posicionar valor, autoridade e confiança."
          : profile === "sensory"
            ? "Atmosfera, identidade e desejo em uma experiência digital que traduz o clima do negócio antes do contato."
            : opportunity;

  const serviceList = (() => {
    try {
      const parsed = Array.isArray(lead.services) ? lead.services : JSON.parse(String(lead.services || "[]"));
      if (Array.isArray(parsed) && parsed.length) return parsed.map((x) => String(x)).filter(Boolean).slice(0,4);
    } catch {}
    if (profile === "clinic") return ["Avaliação personalizada","Toxina botulínica","Bioestimuladores","Harmonização facial","Tecnologias para pele","Contorno corporal"];
    if (profile === "delicate") return ["Corte & finalização","Coloração","Manicure & pedicure","Beleza & autocuidado"];
    if (profile === "bold") return ["Serviços principais","Experiência premium","Atendimento sob medida","Orçamento rápido"];
    if (profile === "premium") return ["Consultoria especializada","Atendimento personalizado","Soluções sob medida","Relacionamento"];
    if (profile === "sensory") return ["Experiência","Cardápio / serviços","Ambiente","Reservas"];
    return ["Serviço principal","Soluções","Atendimento","Contato"];
  })();

  const labels = profile === "clinic"
    ? ["NATURALIDADE","PRECISÃO","CUIDADO"]
    : profile === "delicate"
      ? ["ESSÊNCIA","DETALHE","EXPERIÊNCIA"]
    : profile === "bold"
      ? ["IMPACTO","PERFORMANCE","RESULTADO"]
      : profile === "premium"
        ? ["PRECISÃO","AUTORIDADE","EXCELÊNCIA"]
        : profile === "sensory"
          ? ["ATMOSFERA","DESEJO","EXPERIÊNCIA"]
          : ["PERSONALIDADE","MOVIMENTO","CONVERSÃO"];

  const serviceCards = serviceList.map((service, i) =>
    "<article class='service-card reveal-card'><span class='service-index'>0" + String(i + 1) + "</span><h3>" + escHtml(service) + "</h3><p>" +
    (profile === "clinic" ? "Informação clara, benefício bem apresentado e um caminho elegante até a avaliação." : profile === "delicate" ? "Apresentação leve, visual e envolvente para valorizar o cuidado por trás de cada serviço." : profile === "bold" ? "Informação direta, visual forte e caminho curto até a ação." : profile === "premium" ? "Contexto, benefício e confiança organizados com linguagem visual sofisticada." : "Benefício e próximo passo apresentados sem fricção.") +
    "</p></article>"
  ).join("");

  const clinicHeader = profile === "clinic"
    ? "<div class='brand'><span class='clinic-mark'>" + escHtml(name.slice(0,1).toUpperCase() || "A") + "</span><div><span class='clinic-kicker'>CLÍNICA DE ESTÉTICA</span><strong>" + escHtml(name) + "</strong></div></div><nav><a href='#servicos'>Tratamentos</a><a href='#experiencia'>Experiência</a><a href='#contato'>Contato</a></nav><span class='clinic-place'>BELO HORIZONTE · MG</span><a class='top-cta' href='" + escAttr(cta) + "'>Agendar avaliação</a>"
    : "<div class='brand'><span>" + labels.join(" · ") + "</span><strong>" + escHtml(name) + "</strong></div><nav><a href='#servicos'>Serviços</a><a href='#experiencia'>Experiência</a></nav><a class='top-cta' href='" + escAttr(cta) + "'>" + (profile === "delicate" ? "Agendar" : "Falar agora") + "</a>";
  const clinicKicker = profile === "clinic" ? "ESTÉTICA AVANÇADA · BELO HORIZONTE · MG" : clinicKicker;
  const clinicHeroObject = profile === "clinic"
    ? "<div class='hero-object clinic-hero-object' aria-hidden='true'><div class='clinic-photo'></div><div class='clinic-orbit clinic-orbit-a'></div><div class='clinic-orbit clinic-orbit-b'></div><div class='clinic-float clinic-float-a'>ATENDIMENTO<br><strong>Com hora marcada</strong></div><div class='clinic-float clinic-float-b'>PROTOCOLOS<br><strong>Pensados para você</strong></div></div>"
    : clinicHeroObject";
  const clinicStatement = profile === "clinic" ? "Beleza que não precisa parecer feita." : profile === "delicate" ? "Delicadeza não significa fragilidade. Significa saber onde colocar cada detalhe." : profile === "bold" ? "Impacto não precisa gritar. Precisa ter intenção." : profile === "premium" ? "Menos ruído. Mais percepção de valor." : profile === "sensory" ? "O ambiente também vende. A tela precisa fazer sentir." : "Tecnologia sem cara de template.";
  const clinicExperience = profile === "clinic" ? "Uma clínica onde técnica e acolhimento andam juntos." : profile === "delicate" ? "Uma atmosfera leve, feminina e contemporânea." : profile === "bold" ? "Ritmo visual para negócios que vivem de energia." : profile === "premium" ? "Uma linguagem visual que deixa o posicionamento respirar." : profile === "sensory" ? "Textura, profundidade e movimento para criar desejo." : "Cada movimento tem um motivo.";
  const clinicContact = profile === "clinic" ? "Seu cuidado merece uma experiência à altura." : profile === "delicate" ? "Seu momento começa antes de chegar ao salão." : profile === "bold" ? "Pronto para colocar a marca em movimento?" : profile === "premium" ? "Uma presença à altura do que você entrega." : profile === "sensory" ? "A experiência começa no primeiro olhar." : "Vamos transformar atenção em conversa.";
  const html =
    "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>" +
    "<meta name='theme-color' content='" + palette.bg + "'><meta name='description' content='" + escAttr(opportunity) + "'>" +
    "<title>" + escHtml(name) + " — experiência digital</title><link rel='stylesheet' href='style.css?v=ritty-adaptive-20261008'></head>" +
    "<body class='profile-" + profile + "'>" +
    "<div class='noise' aria-hidden='true'></div><div class='scene' aria-hidden='true'><div class='light light-a'></div><div class='light light-b'></div><div class='orb orb-a'></div><div class='orb orb-b'></div><div class='ring ring-a'></div><div class='ring ring-b'></div></div>" +
    "<header>" + clinicHeader + "</header>" +
    "<main>" +
    "<section class='hero reveal'><div class='hero-copy'><span class='eyebrow'>" +
    (profile === "delicate" ? "BELEZA · FEMININO · SOFT LUXURY" : profile === "bold" ? "HIGH IMPACT · PRESENÇA · ENERGIA" : profile === "premium" ? "EDITORIAL · PRECISÃO · VALOR" : profile === "sensory" ? "ATMOSFERA · DESEJO · EXPERIÊNCIA" : "IDENTIDADE · 3D · MOVIMENTO") +
    "</span><h1>" + escHtml(title) + "</h1><p>" + escHtml(subtitle) + "</p><div class='actions'><a class='cta' href='" + escAttr(cta) + "'>" + (profile === "delicate" ? "Quero conhecer" : "Entrar em contato") + "</a><a class='ghost' href='#experiencia'>Explorar experiência <span>↓</span></a></div></div>" +
    "<div class='hero-object' aria-hidden='true'><div class='petal p1'></div><div class='petal p2'></div><div class='petal p3'></div><div class='petal p4'></div><div class='object-core'></div><div class='orbit o1'></div><div class='orbit o2'></div><div class='object-caption'>" + (profile === "delicate" ? "SOFT LUXURY" : profile === "bold" ? "HIGH IMPACT" : profile === "premium" ? "EDITORIAL" : profile === "sensory" ? "ATMOSPHERIC" : "MODERN") + "<small>3D ART DIRECTION</small></div></div></section>" +
    "<section class='statement reveal'><span class='eyebrow'>01 / DIREÇÃO</span><h2>" +
    clinicStatement +
    "</h2><p>" + escHtml(opportunity) + "</p></section>" +
    "<section id='servicos' class='services reveal'><div class='section-head'><span class='eyebrow'>" + (profile === "clinic" ? "02 / TRATAMENTOS" : "02 / O QUE IMPORTA") + "</span><h2>" + (profile === "clinic" ? "Escolhas precisas para o que você busca." : "Uma estrutura que acompanha o jeito que " + escHtml(name) + " vende.") + "</h2></div><div class='service-grid'>" + serviceCards + "</div></section>" +
    "<section id='experiencia' class='experience reveal'><div class='experience-visual'><div class='depth depth-1'></div><div class='depth depth-2'></div><div class='depth depth-3'></div><span>" + (profile === "delicate" ? "FEEL" : profile === "bold" ? "MOVE" : profile === "premium" ? "VALUE" : profile === "sensory" ? "TASTE" : "CREATE") + "</span></div><div class='experience-copy'><span class='eyebrow'>03 / EXPERIÊNCIA</span><h2>" +
    clinicExperience +
    "</h2><div class='feature-list'><div><b>01</b><span>" + escHtml(labels[0]) + "</span><p>Direção visual coerente com a personalidade real do negócio.</p></div><div><b>02</b><span>" + escHtml(labels[1]) + "</span><p>Profundidade, microinterações e movimento usados com intenção.</p></div><div><b>03</b><span>" + escHtml(labels[2]) + "</span><p>CTA claro sem transformar a experiência em um painel genérico.</p></div></div></div></section>" +
    "<section class='contact reveal' id='contato'><div><span class='eyebrow'>04 / PRÓXIMO PASSO</span><h2>" +
    clinicContact +
    "</h2><p>Esta demonstração é uma amostra da direção. A versão final recebe identidade, fotos, textos, provas sociais e integrações reais.</p><a class='cta' href='" + escAttr(cta) + "'>" + (profile === "delicate" ? "Agendar atendimento" : "Solicitar atendimento") + "</a></div><div class='contact-orb'></div></section>" +
    "</main><script src='script.js?v=ritty-adaptive-20261008'></script></body></html>";

  const css =
    ":root{--bg:" + palette.bg + ";--text:" + palette.text + ";--muted:" + palette.muted + ";--accent:" + palette.accent + ";--accent2:" + palette.accent2 + ";--line:" + palette.line + ";--panel:" + palette.panel + ";--display:" + palette.display + "}" +
    "*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;overflow-x:hidden;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}body:before{content:'';position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 20%,rgba(255,255,255,.035),transparent 42%);z-index:-2}" +
    "header{height:82px;padding:0 5vw;display:flex;align-items:center;gap:30px;position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 78%,transparent);backdrop-filter:blur(20px)}.brand{margin-right:auto}.brand span{display:block;color:var(--accent);font-size:8px;font-weight:900;letter-spacing:.2em;margin-bottom:6px}.brand strong{font-size:18px;letter-spacing:-.02em}nav{display:flex;gap:22px}nav a{color:var(--muted);text-decoration:none;font-size:11px}nav a:hover{color:var(--text)}.top-cta,.cta{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:999px;background:var(--accent);color:" + (profile === "delicate" ? "#3b252b" : "#070707") + ";padding:13px 19px;font-weight:850;box-shadow:0 18px 50px color-mix(in srgb,var(--accent) 20%,transparent);transition:transform .35s ease,box-shadow .35s ease}.top-cta:hover,.cta:hover{transform:translateY(-4px);box-shadow:0 24px 70px color-mix(in srgb,var(--accent) 30%,transparent)}" +
    "main{max-width:1280px;margin:0 auto;padding:0 5vw 120px}.scene{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:-1;perspective:1200px}.light{position:absolute;border-radius:50%;filter:blur(70px);opacity:.3}.light-a{width:600px;height:600px;right:-220px;top:-100px;background:var(--accent);animation:lightA 12s ease-in-out infinite}.light-b{width:420px;height:420px;left:-200px;bottom:-120px;background:var(--accent2);opacity:.12;animation:lightB 15s ease-in-out infinite}.orb{position:absolute;border-radius:50%;transform-style:preserve-3d}.orb-a{width:210px;height:210px;right:7%;top:34%;background:radial-gradient(circle at 35% 30%,#fff8 0 3%,var(--accent) 12%,transparent 66%);filter:blur(3px);animation:orbA 8s ease-in-out infinite}.orb-b{width:120px;height:120px;left:4%;top:68%;background:radial-gradient(circle,#fff5,transparent 68%);animation:orbB 10s ease-in-out infinite}.ring{position:absolute;border:1px solid color-mix(in srgb,var(--accent) 38%,transparent);border-radius:50%;transform-style:preserve-3d}.ring-a{width:440px;height:440px;right:-100px;top:28%;transform:rotateX(70deg);animation:ringA 20s linear infinite}.ring-b{width:300px;height:300px;left:-120px;bottom:4%;transform:rotateY(68deg);animation:ringB 17s linear infinite}" +
    ".hero{min-height:840px;display:grid;grid-template-columns:1.04fr .96fr;align-items:center;gap:5vw}.hero-copy{max-width:800px}.eyebrow{color:var(--accent);font-size:9px;font-weight:900;letter-spacing:.2em}.hero h1{font-family:var(--display);font-size:clamp(58px,8.2vw,112px);line-height:.88;letter-spacing:-.06em;font-weight:" + (profile === "delicate" || profile === "premium" || profile === "sensory" ? "500" : "800") + ";margin:16px 0 25px}.profile-delicate .hero h1{font-size:clamp(58px,7.4vw,98px);letter-spacing:-.045em}.hero p{max-width:690px;color:var(--muted);font-size:18px;line-height:1.75}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.ghost{display:inline-flex;gap:9px;align-items:center;text-decoration:none;color:var(--text);border:1px solid var(--line);background:var(--panel);padding:13px 18px;border-radius:999px;font-weight:750;backdrop-filter:blur(18px)}.ghost span{color:var(--accent)}" +
    ".hero-object{height:min(48vw,610px);min-height:390px;position:relative;transform-style:preserve-3d;isolation:isolate}.hero-object:before{content:'';position:absolute;inset:8%;border:1px solid var(--line);border-radius:42% 58% 50% 50%;background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 56%);box-shadow:0 60px 130px rgba(0,0,0,.18);transform:rotate(-9deg) rotateX(14deg);animation:objectFloat 8s ease-in-out infinite}.object-core{position:absolute;width:34%;aspect-ratio:1;border-radius:50%;left:33%;top:31%;background:radial-gradient(circle at 33% 28%,#fff 0 2%,var(--accent2) 8%,var(--accent) 25%,transparent 68%);filter:blur(.5px);box-shadow:0 0 100px color-mix(in srgb,var(--accent) 42%,transparent);animation:corePulse 5s ease-in-out infinite}.orbit{position:absolute;border:1px solid color-mix(in srgb,var(--accent) 65%,transparent);border-radius:50%;left:18%;top:24%;width:64%;height:50%;transform-style:preserve-3d}.o1{transform:rotateX(68deg) rotateZ(-12deg);animation:orbit1 12s linear infinite}.o2{transform:rotateY(66deg) rotateZ(20deg);opacity:.55;animation:orbit2 15s linear infinite}.petal{display:block;position:absolute;width:25%;height:43%;left:37.5%;top:28%;border-radius:70% 30% 65% 35%;background:linear-gradient(145deg,color-mix(in srgb,var(--accent2) 75%,white),color-mix(in srgb,var(--accent) 75%,transparent));filter:drop-shadow(0 20px 35px color-mix(in srgb,var(--accent) 20%,transparent));transform-origin:50% 100%;opacity:" + (profile === "delicate" ? ".72" : "0") + "}.p1{transform:rotate(0deg) translateY(-25px)}.p2{transform:rotate(90deg) translateY(-25px)}.p3{transform:rotate(180deg) translateY(-25px)}.p4{transform:rotate(270deg) translateY(-25px)}.profile-delicate .petal{animation:petalBreath 6s ease-in-out infinite}.object-caption{position:absolute;bottom:4%;left:8%;color:var(--accent);font-size:10px;font-weight:900;letter-spacing:.18em}.object-caption small{display:block;color:var(--muted);font-size:8px;margin-top:7px;letter-spacing:.13em}" +
    ".statement{padding:120px 0 150px;max-width:980px}.statement h2,.section-head h2,.experience-copy h2,.contact h2{font-family:var(--display);font-weight:500;line-height:.97;letter-spacing:-.05em}.statement h2{font-size:clamp(42px,6.5vw,80px);margin:16px 0}.statement p{max-width:760px;color:var(--muted);font-size:17px;line-height:1.75}.section-head{max-width:900px;margin-bottom:30px}.section-head h2{font-size:clamp(40px,6vw,72px);margin:13px 0}.service-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.service-card{min-height:280px;padding:28px;border:1px solid var(--line);border-radius:" + (profile === "delicate" ? "30px" : "22px") + ";background:var(--panel);backdrop-filter:blur(20px);transition:transform .5s cubic-bezier(.2,.8,.2,1),box-shadow .5s ease}.service-card:hover{transform:translate3d(0,-12px,25px) rotateX(2deg) rotateY(-2deg);box-shadow:0 35px 90px rgba(0,0,0,.18)}.service-index{color:var(--accent);font-size:9px;font-weight:900;letter-spacing:.18em}.service-card h3{font-family:var(--display);font-size:28px;line-height:1.05;margin:24px 0 12px}.service-card p{color:var(--muted);font-size:13px;line-height:1.7}" +
    ".experience{display:grid;grid-template-columns:.9fr 1.1fr;gap:7vw;align-items:center;padding:170px 0}.experience-visual{height:520px;position:relative;transform-style:preserve-3d;display:grid;place-items:center}.experience-visual span{font-size:clamp(50px,8vw,100px);font-family:var(--display);font-weight:500;letter-spacing:-.07em;color:var(--accent);transform:translateZ(90px);text-shadow:0 20px 80px color-mix(in srgb,var(--accent) 30%,transparent)}.depth{position:absolute;border:1px solid var(--line);border-radius:50%;transform-style:preserve-3d}.depth-1{width:80%;height:65%;transform:rotateX(67deg);animation:depth1 9s linear infinite}.depth-2{width:62%;height:50%;transform:rotateY(66deg) rotateZ(20deg);animation:depth2 11s linear infinite}.depth-3{width:42%;height:42%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 22%,transparent),transparent 68%);box-shadow:0 0 100px color-mix(in srgb,var(--accent) 28%,transparent);animation:corePulse 5s ease-in-out infinite}.experience-copy h2{font-size:clamp(42px,6vw,76px);margin:15px 0 35px}.feature-list{display:grid;gap:0;border-top:1px solid var(--line)}.feature-list div{display:grid;grid-template-columns:42px 1fr;gap:8px;padding:18px 0;border-bottom:1px solid var(--line)}.feature-list b{color:var(--accent);font-size:9px}.feature-list span{font-family:var(--display);font-size:21px}.feature-list p{grid-column:2;color:var(--muted);margin:0;font-size:12px;line-height:1.6}" +
    ".contact{position:relative;overflow:hidden;padding:70px;border:1px solid var(--line);border-radius:36px;background:var(--panel);backdrop-filter:blur(22px);min-height:430px;display:flex;align-items:center}.contact>div:first-child{position:relative;z-index:3;max-width:900px}.contact h2{font-size:clamp(48px,7vw,88px);margin:15px 0}.contact p{max-width:680px;color:var(--muted);line-height:1.7;margin-bottom:25px}.contact-orb{position:absolute;right:-100px;bottom:-180px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff6 0 2%,var(--accent) 10%,transparent 62%);filter:blur(8px);opacity:.48;animation:contactFloat 9s ease-in-out infinite}" +
    ".reveal{opacity:0;transform:translateY(42px);transition:opacity 1s cubic-bezier(.2,.7,.2,1),transform 1s cubic-bezier(.2,.7,.2,1)}.reveal.visible{opacity:1;transform:none}.reveal-card{animation:cardIn .9s both}@keyframes lightA{50%{transform:translate3d(-60px,45px,0) scale(1.08)}}@keyframes lightB{50%{transform:translate3d(40px,-50px,0) scale(1.1)}}@keyframes orbA{50%{transform:translate3d(-35px,25px,60px) scale(1.08)}}@keyframes orbB{50%{transform:translate3d(30px,-35px,20px)}}@keyframes ringA{to{transform:rotateX(70deg) rotateZ(360deg)}}@keyframes ringB{to{transform:rotateY(68deg) rotateZ(-360deg)}}@keyframes objectFloat{50%{transform:rotate(-5deg) rotateX(22deg) translate3d(0,-18px,35px)}}@keyframes corePulse{50%{transform:scale(1.16) translateZ(30px)}}@keyframes orbit1{to{transform:rotateX(68deg) rotateZ(372deg)}}@keyframes orbit2{to{transform:rotateY(66deg) rotateZ(-340deg)}}@keyframes petalBreath{50%{filter:drop-shadow(0 30px 55px color-mix(in srgb,var(--accent) 30%,transparent));opacity:.95;transform:scale(1.08) rotate(4deg)}}@keyframes depth1{to{transform:rotateX(67deg) rotateZ(360deg)}}@keyframes depth2{to{transform:rotateY(66deg) rotateZ(-340deg)}}@keyframes contactFloat{50%{transform:translate3d(-40px,-45px,30px) scale(1.08)}}@keyframes cardIn{from{opacity:.5;transform:translateY(16px) rotateX(3deg)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}@media(max-width:900px){header{padding:0 18px}nav{display:none}.hero{grid-template-columns:1fr;min-height:0;padding-top:55px;gap:15px}.hero-object{min-height:390px;height:72vw;order:-1}.statement{padding:90px 0}.service-grid{grid-template-columns:1fr 1fr}.experience{grid-template-columns:1fr;padding:100px 0}.experience-visual{height:360px}.contact{padding:42px 28px}}@media(max-width:560px){header{height:74px}.brand span{display:none}.brand strong{font-size:15px}.top-cta{font-size:11px;padding:10px 13px}main{padding-left:18px;padding-right:18px}.hero h1{font-size:clamp(48px,14vw,76px)}.profile-delicate .hero h1{font-size:clamp(50px,14vw,74px)}.hero p{font-size:16px}.actions{flex-direction:column;align-items:stretch}.actions a{justify-content:center}.hero-object{min-height:300px}.service-grid{grid-template-columns:1fr}.service-card{min-height:220px}.statement{padding:80px 0 100px}.experience{padding:90px 0}.experience-visual{height:280px}.contact{min-height:420px;padding:36px 24px;border-radius:28px}.contact h2{font-size:clamp(43px,13vw,65px)}}";


    const finalCss = profile === "clinic"
      ? css + ".profile-clinic{--clinic-shadow:rgba(73,49,40,.13)}.profile-clinic header{height:88px;background:rgba(247,243,238,.88);box-shadow:0 10px 35px rgba(55,39,31,.05)}.profile-clinic .brand{align-items:center;gap:11px}.profile-clinic .clinic-mark{width:38px;height:38px;border:1px solid var(--accent);border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-size:18px;color:var(--accent)}.profile-clinic .clinic-kicker{display:block;color:var(--accent);font-size:7px;letter-spacing:.18em;font-weight:900;margin-bottom:3px}.profile-clinic .brand strong{font-family:var(--display);font-weight:500;font-size:18px}.profile-clinic .clinic-place{font-size:7px;letter-spacing:.14em;color:var(--muted);padding:10px 12px;border:1px solid var(--line);border-radius:99px}.profile-clinic .top-cta{background:#241f1c;color:#fff8f2;padding:13px 18px}.profile-clinic .hero{min-height:820px;background:radial-gradient(500px 420px at 85% 18%,rgba(166,111,92,.10),transparent 70%);border-radius:0}.profile-clinic .hero h1{font-family:var(--display);font-weight:500;letter-spacing:-.055em;max-width:760px}.profile-clinic .hero p{color:#756b64}.profile-clinic .hero-object{height:min(52vw,640px);min-height:430px}.profile-clinic .clinic-hero-object{display:grid;place-items:center}.profile-clinic .clinic-hero-object:before{display:none}.profile-clinic .clinic-photo{width:min(420px,74%);height:540px;border-radius:220px 220px 28px 28px;background:linear-gradient(180deg,rgba(27,20,17,.04),rgba(27,20,17,.25)),url('https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1100&q=88');background-size:cover;background-position:center 18%;box-shadow:0 45px 100px var(--clinic-shadow);transform:rotateY(calc(var(--mx,0px)*.13)) rotateX(calc(var(--my,0px)*-.1));transition:transform .18s ease;z-index:3}.profile-clinic .clinic-photo:before{content:'';position:absolute;inset:10px;border:1px solid rgba(255,255,255,.5);border-radius:210px 210px 20px 20px}.clinic-orbit{position:absolute;border:1px solid rgba(166,111,92,.35);border-radius:50%;z-index:1}.clinic-orbit-a{width:560px;height:370px;transform:rotateX(68deg);animation:clinicOrbitA 18s linear infinite}.clinic-orbit-b{width:450px;height:295px;transform:rotateY(65deg) rotateZ(18deg);animation:clinicOrbitB 21s linear infinite}.clinic-float{position:absolute;z-index:4;padding:11px 13px;border:1px solid rgba(55,40,32,.1);border-radius:13px;background:rgba(255,253,249,.86);backdrop-filter:blur(15px);box-shadow:0 18px 50px rgba(67,45,37,.1);font-size:7px;letter-spacing:.14em;color:var(--accent);font-weight:900}.clinic-float strong{display:block;color:var(--text);font-family:var(--display);font-size:14px;letter-spacing:0;margin-top:4px;font-weight:500}.clinic-float-a{right:1%;top:14%}.clinic-float-b{left:1%;bottom:10%}.profile-clinic .statement{padding-top:100px}.profile-clinic .statement h2,.profile-clinic .section-head h2,.profile-clinic .experience-copy h2,.profile-clinic .contact h2{font-family:var(--display);font-weight:500}.profile-clinic .service-grid{grid-template-columns:repeat(3,1fr)}.profile-clinic .service-card{background:rgba(255,253,249,.72);border-radius:24px;min-height:300px;box-shadow:0 12px 40px rgba(67,45,37,.05)}.profile-clinic .service-card h3{font-family:var(--display);font-weight:500;font-size:30px}.profile-clinic .service-card:hover{box-shadow:0 32px 70px rgba(67,45,37,.12);border-color:rgba(166,111,92,.35)}.profile-clinic .experience{padding-top:140px;padding-bottom:140px}.profile-clinic .contact{background:#241f1c;border-color:#241f1c;border-radius:34px}.profile-clinic .contact-orb{background:radial-gradient(circle at 35% 30%,#fff7 0 2%,#a66f5c 12%,transparent 63%)}@keyframes clinicOrbitA{to{transform:rotateX(68deg) rotateZ(360deg)}}@keyframes clinicOrbitB{to{transform:rotateY(65deg) rotateZ(-340deg)}}@media(max-width:900px){.profile-clinic .clinic-place{display:none}.profile-clinic .hero{min-height:0;padding-top:40px}.profile-clinic .hero-object{min-height:390px;height:72vw;order:-1}.profile-clinic .clinic-photo{height:430px}.profile-clinic .service-grid{grid-template-columns:1fr 1fr}}@media(max-width:560px){.profile-clinic header{height:74px}.profile-clinic .clinic-kicker{font-size:6px}.profile-clinic .clinic-mark{width:34px;height:34px}.profile-clinic .hero h1{font-size:clamp(49px,14vw,74px)}.profile-clinic .clinic-photo{height:350px}.profile-clinic .clinic-orbit-a{width:420px;height:280px}.profile-clinic .clinic-orbit-b{width:340px;height:230px}.profile-clinic .service-grid{grid-template-columns:1fr}}"
      : css;
  const js = "document.addEventListener('DOMContentLoaded',function(){const root=document.documentElement;const io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)e.target.classList.add('visible')})},{threshold:.12});document.querySelectorAll('.reveal').forEach(function(e){io.observe(e)});window.addEventListener('pointermove',function(e){root.style.setProperty('--mx',((e.clientX/innerWidth)-.5)*34+'px');root.style.setProperty('--my',((e.clientY/innerHeight)-.5)*34+'px')},{passive:true});document.querySelectorAll('.service-card').forEach(function(card,i){card.style.animationDelay=(i*90)+'ms'});});";

  return {
    files: [
      { path: "index.html", content: html },
      { path: "style.css", content: css },
      { path: "script.js", content: js },
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
