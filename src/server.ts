import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleWebhookRequest } from "./lib/telegram";

// Cloudflare Workers environment bindings
export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
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
      return handleWebhookRequest(request, env.TELEGRAM_BOT_TOKEN, env.ANTHROPIC_API_KEY);
    }

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
