import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleWebhookRequest } from "./lib/telegram";
import {
  fetchKisPrices, fetchNaverHistoryPrices, fetchNaverHistorySeries,
  historySeriesRangeError, HISTORY_SERIES_MAX_TICKERS,
} from "./lib/kaw/kis-server";
import {
  handleAuthFamily, handleVerifyPin, handleVerifyMaster, handleVerifySecretQuestion,
  handleSetPin, handleSetMaster, handleAddProfile, handleRestoreProfile, handleDeleteProfile,
  handleDataGet, handleDataPost, upsertLivePrices, listLivePriceTickers,
  handleSnapshotsGet, writeDailySnapshots, kstTimeString, requireSession,
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

// ── 예정된 시세 갱신 (Cloudflare Cron) ──────────────────────────────────────
// 아무도 앱을 열지 않아도 kaw_live_prices 가 최신에 가까운 값을 갖도록 주기적으로 채운다.
// 조회 대상은 assetLibrary 에 등록된 unique ticker 만(중복 호출 없음). KIS 토큰 KV 캐시,
// Naver fallback, 적재 로직은 모두 기존 함수를 그대로 재사용한다 — 중복 구현하지 않는다.
async function refreshLivePrices(env: Env): Promise<void> {
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
    console.log("예정된 시세 갱신 생략: KIS 인증 정보 미설정");
    return;
  }
  const tickers = await listLivePriceTickers(env);
  if (!tickers.length) {
    console.log("예정된 시세 갱신 생략: 대상 ticker 없음");
    return;
  }
  const { results, timestamp } = await fetchKisPrices(
    tickers,
    env.KIS_APP_KEY,
    env.KIS_APP_SECRET,
    env.RATE_LIMIT,
  );
  await upsertLivePrices(env, results, timestamp);
  const ok = Object.values(results).filter((r) => r.price > 0).length;
  console.log(`예정된 시세 갱신: ${ok}/${tickers.length}건 성공 (${timestamp})`);
}

// ── 하루 1회 자산 스냅샷 ────────────────────────────────────────────────────
// 시세 cron 은 그대로 두고, **그 날의 마지막 슬롯(한국시간 15:40)** 에만 이어서 스냅샷을 쓴다.
// 15:40 조회값이 장 마감 이후 최종 종가 역할을 하므로 그 시점 평가액이 그 날의 종가 평가액이다.
// 슬롯 판정은 Cloudflare 가 알려준 예정 시각(scheduledTime)으로 하고, 없으면 현재 시각으로 본다.
const DAILY_SNAPSHOT_KST_TIME = "15:40";

function isDailySnapshotSlot(event: unknown): boolean {
  const scheduledTime = (event as { scheduledTime?: number } | null)?.scheduledTime;
  const at = typeof scheduledTime === "number" ? new Date(scheduledTime) : new Date();
  return kstTimeString(at) === DAILY_SNAPSHOT_KST_TIME;
}

export default {
  // wrangler.jsonc 의 crons 가 이 핸들러를 부른다. 앱의 요청 처리(fetch)와는 완전히 분리돼 있다.
  async scheduled(event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil((async () => {
      // 시세를 먼저 갱신해야 스냅샷이 최신 시세로 평가된다. 시세 갱신이 실패해도 스냅샷
      // 쪽에서 "신선한 시세 없음"으로 그 날 행을 건너뛰므로 틀린 값이 남지는 않는다.
      await refreshLivePrices(env).catch((e) => console.error("예정된 시세 갱신 실패:", e));
      if (!isDailySnapshotSlot(event)) return;
      try {
        const { written, skipped } = await writeDailySnapshots(env);
        console.log(`일별 자산 스냅샷: ${written}건 적재` + (skipped.length ? ` / 건너뜀 ${skipped.length}건: ${skipped.join("; ")}` : ""));
      } catch (e) {
        console.error("일별 자산 스냅샷 실패:", e);
      }
    })());
  },

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
        // 응답은 그대로 내려주고, read-only 분석용 시세 캐시 적재는 백그라운드 best-effort로만 처리한다.
        // 실패해도 이 요청의 응답에는 영향이 없다.
        const cacheWrite = upsertLivePrices(env, results, timestamp).catch((e) =>
          console.error("시세 캐시 적재 실패:", e),
        );
        const waitUntil = (ctx as { waitUntil?: (p: Promise<unknown>) => void } | null)?.waitUntil;
        if (typeof waitUntil === "function") waitUntil.call(ctx, cacheWrite);
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

    // ── Naver 과거 종가 **구간** 조회 (과거 성과 복원용, 세션 토큰 필요) ────
    //
    // 날짜 1개용인 /api/naver/history-price 와 달리 종목당 요청 1회로 구간 전체를 받는다.
    // 거래일마다 호출하는 경로를 만들지 않기 위한 endpoint 다 (kis-server.ts 주석 참고).
    //
    // 가격 자체는 public data 지만, 구간 × 종목 수만큼 외부 API 를 부르는 경로라서
    // 기존 /api/data · /api/snapshots 와 같은 세션 토큰 인증을 요구하고 범위 상한을 둔다.
    if (pathname === "/api/naver/history-series" && request.method === "POST") {
      if (!(await requireSession(request, env))) {
        return Response.json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, { status: 401 });
      }
      try {
        const body = await request.json() as { tickers?: unknown; from?: unknown; to?: unknown };
        const tickers = Array.isArray(body?.tickers)
          ? [...new Set((body.tickers as string[])
              .filter((t) => typeof t === "string" && /^[A-Z0-9]{6}$/i.test(t)))]
            .slice(0, HISTORY_SERIES_MAX_TICKERS)
          : [];
        const from = typeof body?.from === "string" ? body.from : "";
        const to = typeof body?.to === "string" ? body.to : "";
        const rangeError = historySeriesRangeError(tickers, from, to);
        if (rangeError) return Response.json({ error: rangeError }, { status: 400 });
        const { series, failed, timestamp } = await fetchNaverHistorySeries(tickers, from, to);
        return Response.json({ series, failed, timestamp }, { headers: { "Cache-Control": "no-store" } });
      } catch (err) {
        console.error("Naver history series error:", err);
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

    // ── 일별 자산 스냅샷 읽기 (기간 성과용, 세션 토큰 필요) ─────────────────
    if (pathname === "/api/snapshots" && request.method === "GET") return handleSnapshotsGet(request, env);

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
