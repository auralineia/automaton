import http from "node:http";
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
  if (!expected) return true;
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
    pathname === "/revenue" ||
    pathname === "/api/revenue" ||
    pathname.startsWith("/api/revenue/") ||
    pathname === "/webhooks/stripe" ||
    pathname === "/revenue/success" ||
    pathname === "/revenue/cancelled";

  if (!handled) return false;

  ensureRevenueCommerceSchema(db);

  if (pathname === "/revenue" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<body style='font-family:system-ui;background:#050505;color:#f7f5ef;padding:28px'>" +
      "<h1>RITTY — Revenue Engine</h1>" +
      "<p>Pipeline: prospecção → abordagem → aprovação → checkout → pagamento → entrega.</p>" +
      "<p><a style='color:#f4c64f' href='/api/revenue'>Abrir dados do pipeline</a></p></body>",
    );
    return true;
  }

  if (pathname === "/api/revenue" && req.method === "GET") {
    try {
      const metrics = JSON.parse(revenueMetrics(db));
      const leads = db.raw.prepare(
        "SELECT id,name,website,email,phone,contact,contact_url,opportunity,score,status,updated_at FROM revenue_leads ORDER BY score DESC,updated_at DESC LIMIT 60",
      ).all();
      const actions = db.raw.prepare(
        "SELECT id,lead_id,action,status,payload,created_at,updated_at FROM revenue_actions WHERE status IN ('pending_approval','approved') ORDER BY updated_at DESC LIMIT 100",
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
