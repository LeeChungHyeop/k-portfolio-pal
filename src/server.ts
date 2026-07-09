import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleWebhookRequest } from "./lib/telegram";
import { fetchKisPrices, fetchNaverHistoryPrices } from "./lib/kaw/kis-server";
import {
  handleAuthFamily, handleVerifyPin, handleVerifyMaster, handleVerifySecretQuestion,
  handleSetPin, handleSetMaster, handleAddProfile, handleRestoreProfile, handleDeleteProfile,
  handleDataGet, handleDataPost,
} from "./lib/kaw/data-server";

// Cloudflare Workers environment bindings
export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SESSION_SECRET?: string;
  ACCESS_CODE?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RATE_LIMIT?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  [key: string]: unknown;
}

type ServerEntry = {
  fetch: (request: Request, env: Env, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown) {
    const { pathname } = new URL(request.url);

    // ── Telegram webhook ────────────────────────────────────────────────
    if (pathname === "/api/webhook/telegram" && request.method === "POST") {
      return handleWebhookRequest(request, env.TELEGRAM_BOT_TOKEN, env.ANTHROPIC_API_KEY, env.TELEGRAM_WEBHOOK_SECRET);
    }

    // ── (1회성) 텔레그램 웹훅에 secret_token 등록 — ACCESS_CODE로 보호 ──────
    if (pathname === "/api/admin/telegram-webhook-setup" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { code?: unknown };
      if (body.code !== env.ACCESS_CODE) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ error: "TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET not configured" }, { status: 503 });
      }
      const webhookUrl = new URL("/api/webhook/telegram", request.url).toString();
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: env.TELEGRAM_WEBHOOK_SECRET }),
      });
      return Response.json(await res.json(), { status: res.status });
    }

    // ── KIS 실시간 주가 프록시 ─────────────────────────────────────────
    if (pathname === "/api/kis/price" && request.method === "POST") {
      if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
        return Response.json({ error: "KIS credentials not configured" }, { status: 503 });
      }
      try {
        const body = await request.json() as { tickers?: unknown };
        const tickers = Array.isArray(body?.tickers) ? (body.tickers as string[]).filter(t => typeof t === "string" && /^[A-Z0-9]{6}$/i.test(t)).slice(0, 20) : [];
        if (!tickers.length) return Response.json({ results: {}, timestamp: new Date().toISOString() });
        const { results, timestamp } = await fetchKisPrices(tickers, env.KIS_APP_KEY, env.KIS_APP_SECRET, env.RATE_LIMIT);
        return Response.json({ results, timestamp }, { headers: { "Cache-Control": "no-store" } });
      } catch (err) {
        console.error("KIS price error:", err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // ── Naver 과거 종가 프록시 (KIS 불필요) ───────────────────────────────
    if (pathname === "/api/naver/history-price" && request.method === "POST") {
      try {
        const body = await request.json() as { tickers?: unknown; date?: unknown };
        const tickers = Array.isArray(body?.tickers)
          ? (body.tickers as string[]).filter(t => typeof t === "string" && /^[A-Z0-9]{6}$/i.test(t)).slice(0, 20)
          : [];
        const date = typeof body?.date === "string" && /^\d{8}$/.test(body.date) ? body.date : "";
        if (!tickers.length || !date) return Response.json({ results: {}, timestamp: new Date().toISOString() });
        const { results, timestamp } = await fetchNaverHistoryPrices(tickers, date);
        return Response.json({ results, timestamp }, { headers: { "Cache-Control": "no-store" } });
      } catch (err) {
        console.error("Naver history price error:", err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // ── 가족/프로필 인증 (Supabase는 서버에서만 접근, 브라우저는 이 API만 사용) ──
    if (pathname === "/api/auth/family" && request.method === "POST") return handleAuthFamily(request, env);
    if (pathname === "/api/auth/verify-pin" && request.method === "POST") return handleVerifyPin(request, env);
    if (pathname === "/api/auth/verify-master" && request.method === "POST") return handleVerifyMaster(request, env);
    if (pathname === "/api/auth/verify-secret-question" && request.method === "POST") return handleVerifySecretQuestion(request, env);
    if (pathname === "/api/auth/set-pin" && request.method === "POST") return handleSetPin(request, env);
    if (pathname === "/api/auth/set-master" && request.method === "POST") return handleSetMaster(request, env);
    if (pathname === "/api/auth/add-profile" && request.method === "POST") return handleAddProfile(request, env);
    if (pathname === "/api/auth/restore-profile" && request.method === "POST") return handleRestoreProfile(request, env);
    if (pathname === "/api/auth/soft-delete-profile" && request.method === "POST") return handleDeleteProfile(request, env, false);
    if (pathname === "/api/auth/hard-delete-profile" && request.method === "POST") return handleDeleteProfile(request, env, true);

    // ── 계좌 데이터 (세션 토큰 필요) ──────────────────────────────────────
    if (pathname === "/api/data" && request.method === "GET") return handleDataGet(request, env);
    if (pathname === "/api/data" && request.method === "POST") return handleDataPost(request, env);

    // ── TanStack Start app (SSR + static) ───────────────────────────────
    try {
      const handler = await getServerEntry();
      const raw = await handler.fetch(request, env, ctx);
      const response = await normalizeCatastrophicSsrResponse(raw);
      // Prevent iOS Safari from caching the HTML document
      if ((response.headers.get("content-type") ?? "").includes("text/html")) {
        const h = new Headers(response.headers);
        h.set("Cache-Control", "no-store");
        return new Response(response.body, { status: response.status, headers: h });
      }
      return response;
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
