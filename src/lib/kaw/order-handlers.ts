// ─────────────────────────────────────────────────────────────────────────────
// 승인형 주문 HTTP 핸들러 (Cloudflare Worker, server-only)
//
//   POST /api/kis/order/prepare   의도 생성 + 1회성 승인 토큰 발급 (주문하지 않는다)
//   POST /api/kis/order/submit    승인 토큰 + 확인 echo 로 제출 (여기서만 주문이 나간다)
//   GET  /api/kis/order/status    체결조회로 접수·체결 상태를 해소한다 (주문하지 않는다)
//   POST /api/kis/order/resolve   응답 불명 의도의 수동 해소 — 증권사 조회 근거가 있을 때만 (주문하지 않는다)
//
// ── 통과해야 하는 문 (앞이 막히면 뒤를 실행하지 않는다) ─────────────────────
//
//   1. 서버 기능 flag `KIS_ORDER_ENABLED === "on"` — **기본 OFF**. 꺼져 있으면 403 이고
//      DB·토큰·증권사를 건드리지 않는다
//   2. 서명 검증된 세션
//   3. 가족 코드 + 프로필 소유권 (`authorizeKisAccess` — 조회 권한과 같은 함수)
//   4. 계좌 instance: 이 프로필 레지스트리에서 KIS 22 가 등록·active·API 모드여야 한다
//      (sentinel·계산만 제공·상품코드 불일치는 거부)
//   5. 그 뒤에 서비스(order-service.ts)의 정책·재검증·1회성 승인
//
// 응답에는 계좌번호·키·토큰·원본 응답이 없다. 승인 토큰 원문은 **prepare 응답에만** 있다.
// ─────────────────────────────────────────────────────────────────────────────

import { json, requireSession, serviceClient } from "./data-server";
import { fetchKisPrices, getKisAccessToken, type KVLike } from "./kis-server";
import { fetchBuyingPower } from "./kis-buying-power";
import { inquireDailyCcld, placeCashBuyOrder, type FetchLike } from "./kis-order";
import { authorizeKisAccess, parseBrokerAccounts, type KisAccountEnv } from "./kis-account-read";
import { kisApiQueryGate } from "./broker-connection";
import { kstDateString } from "./snapshot";
import { isExecutionConfirmed, newApprovalToken, ORDER_POLICY, ledgerEligibility, type OrderIntent } from "./order-intent";
import { SupabaseOrderStore, type OrderIntentStore } from "./order-store";
import {
  prepareOrder, reconcileOrder, resolveOrder, submitOrder,
  type BrokerPort, type ConfirmEcho, type OrderServiceDeps,
} from "./order-service";
import type { KisAccountCredentials } from "./kis-account-server";

export interface OrderEnv extends KisAccountEnv {
  /** 서버 기능 flag. 정확히 "on" 일 때만 켜진다. 기본 꺼짐 */
  KIS_ORDER_ENABLED?: string;
}

/** 테스트가 증권사·저장소·시계를 바꿔 끼우는 지점. 운영 경로는 모두 기본값이다. */
export interface OrderHandlerOverrides {
  store?: OrderIntentStore;
  broker?: BrokerPort;
  fetchImpl?: FetchLike;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
}

export const isOrderEnabled = (env: OrderEnv): boolean => env.KIS_ORDER_ENABLED === "on";

/** 의도를 응답으로. 승인 토큰 해시·내부 필드는 싣지 않는다. */
export function publicIntent(i: OrderIntent) {
  return {
    id: i.id,
    state: i.state,
    ticker: i.ticker,
    quantity: i.quantity,
    limitPrice: i.limitPrice,
    amount: i.amount,
    side: i.side,
    ordDvsn: i.ordDvsn,
    accountInstanceId: i.accountInstanceId,
    attempt: i.attempt,
    orderNo: i.orderNo,
    orderTime: i.orderTime,
    approvalExpiresAt: i.approvalExpiresAt,
    evidence: i.evidence,
    lastInquiryAt: i.lastInquiryAt,
    ambiguous: i.ambiguous,
    // 주문번호로 연결되지 않은 후보만 있다 — 사용자 확인 전에는 체결로 다루지 않는다.
    needsUserConfirmation: (i.ambiguous && !i.orderNo) || i.orderNoSource === "user_linked",
    lastError: i.lastError,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    // 접수와 체결을 섞지 않는다: 체결 증거가 있을 때만 true
    // 증권사 주문 응답의 번호로 대응된 체결조회 증거가 있을 때만 true(수동 연결은 확정 아님)
    executionConfirmed: isExecutionConfirmed(i),
    orderNoSource: i.orderNoSource ?? (i.orderNo ? "broker_response" : null),
    ledgerEligible: ledgerEligibility(i).eligible,
  };
}

// ── 핸들러 본체 ─────────────────────────────────────────────────────────────

interface Resolved {
  deps: OrderServiceDeps;
  actor: string;
  ctx: { scope: { familyCode: string; profile: string }; accountInstanceId: string };
}

/**
 * 게이트를 통과한 요청에서 서비스 의존성을 만든다. 증권사 호출은 여기서 묶는다.
 * `registryOverride` 는 테스트 전용이다(운영에서는 DB 의 `_meta` 를 읽는다).
 */
async function resolve(
  request: Request, env: OrderEnv, ov: OrderHandlerOverrides, registryOverride?: unknown,
): Promise<Resolved | Response> {
  if (!isOrderEnabled(env)) {
    return json({ error: "order_disabled", message: "주문 기능이 꺼져 있습니다." }, 403);
  }
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);

  const auth = authorizeKisAccess(session, env);
  if (!auth.ok) return json({ error: "이 프로필에는 주문 권한이 없습니다." }, 403);

  const { KIS_APP_KEY: appKey, KIS_APP_SECRET: appSecret, KIS_ACCOUNT_CANO: cano } = env;
  if (!appKey || !appSecret || !cano || !/^\d{8}$/.test(cano)) {
    return json({ unavailable: true, error: "증권사 설정이 없습니다." }, 503);
  }
  const cred: KisAccountCredentials = { appKey, appSecret, cano };

  // 계좌 instance — 서버가 이 프로필의 레지스트리에서 직접 확인한다.
  let rawRegistry: unknown = registryOverride;
  if (rawRegistry === undefined) {
    const client = serviceClient(env);
    if (!client) return json({ error: "서버 설정 오류" }, 503);
    const { data } = await client.from("kaw_data").select("data")
      .eq("family_code", session.code).eq("profile", session.profile)
      .eq("account_type", "_meta").maybeSingle();
    rawRegistry = (data?.data as { brokerAccounts?: unknown } | null)?.brokerAccounts;
  }
  const registry = parseBrokerAccounts(rawRegistry);
  const gate = kisApiQueryGate(registry, "pension", kstDateString(), ORDER_POLICY.productCode);
  if (!gate.allowed) {
    return json({ error: "account_not_ready", reason: gate.reason, message: "주문할 수 있는 연금저축 계좌가 등록돼 있지 않습니다." }, 409);
  }

  // 저장소: 주입되지 않으면 Supabase. 테이블이 없으면 쓰기가 실패한다(메모리 대체 없음).
  let store = ov.store;
  if (!store) {
    const client = serviceClient(env);
    if (!client) return json({ error: "서버 설정 오류" }, 503);
    store = new SupabaseOrderStore(client);
  }

  const fetchImpl: FetchLike = ov.fetchImpl ?? ((url, init) => fetch(url, init));
  let broker = ov.broker;
  if (!broker) {
    let token: string;
    try {
      token = await getKisAccessToken(appKey, appSecret, env.RATE_LIMIT as KVLike | undefined);
    } catch {
      return json({ unavailable: true, error: "증권사 인증에 실패했습니다." }, 503);
    }
    broker = {
      quote: async (ticker) => {
        const r = await fetchKisPrices([ticker], appKey, appSecret);
        const p = r.results[ticker];
        return { price: p && p.price > 0 && Number.isInteger(p.price) ? p.price : null, asOf: r.timestamp };
      },
      buyingPower: (ticker, unitPrice) =>
        fetchBuyingPower(cred, token, { ticker, unitPrice, ordDvsn: "00" }, "22"),
      place: (req) => placeCashBuyOrder(cred, token, req, fetchImpl),
      inquire: async (q) => {
        const r = await inquireDailyCcld(cred, token, {
          ticker: q.ticker, date: q.date, orderNo: q.orderNo, ...(q.endDate ? { endDate: q.endDate } : {}),
        }, fetchImpl);
        return {
          ok: r.ok, rows: r.rows, hasMore: r.hasMore, complete: r.complete,
          ...(r.ok ? {} : { error: r.msg1 ?? r.transportError ?? "조회 실패" }),
        };
      },
    };
  }

  return {
    deps: {
      store, broker, enabled: true,
      now: ov.now ?? (() => new Date()),
      newId: ov.newId ?? (() => crypto.randomUUID()),
      newToken: ov.newToken ?? newApprovalToken,
    },
    actor: session.profile,
    ctx: {
      scope: { familyCode: session.code, profile: session.profile },
      accountInstanceId: gate.instance.id,
    },
  };
}

const isResponse = (v: Resolved | Response): v is Response => v instanceof Response;

export async function handleOrderPrepare(
  request: Request, env: OrderEnv, ov: OrderHandlerOverrides = {}, registryOverride?: unknown,
): Promise<Response> {
  const r = await resolve(request, env, ov, registryOverride);
  if (isResponse(r)) return r;

  const body = (await request.json().catch(() => null)) as { ticker?: unknown; quantity?: unknown } | null;
  if (!body || typeof body.ticker !== "string" || typeof body.quantity !== "number") {
    return json({ error: "ticker(문자열)와 quantity(숫자)가 필요합니다." }, 400);
  }
  const res = await prepareOrder(r.ctx, { ticker: body.ticker, quantity: body.quantity }, r.deps);
  switch (res.kind) {
    case "disabled": return json({ error: "order_disabled" }, 403);
    case "policy_violation": return json({ error: "policy_violation", messages: res.messages }, 422);
    case "no_price": return json({ error: "no_price", message: "현재가를 확인하지 못했습니다." }, 409);
    case "buying_power_unverified": return json({ error: "buying_power_unverified" }, 409);
    case "buying_power_insufficient":
      return json({ error: "buying_power_insufficient", availableAmount: res.availableAmount, availableQty: res.availableQty }, 409);
    case "duplicate": return json({ error: "duplicate", intent: publicIntent(res.intent) }, 409);
    case "open_intent_exists": return json({ error: "open_intent_exists", intent: publicIntent(res.intent) }, 409);
    case "store_error": return json({ error: "store_error", message: res.message }, 503);
    case "proposed":
      return json({
        intent: publicIntent(res.intent),
        // 원문은 이 응답에만 있고, 서버에는 해시만 남는다. 1회성이다.
        approvalToken: res.approvalToken,
        confirm: {
          ticker: res.intent.ticker, quantity: res.intent.quantity, limitPrice: res.intent.limitPrice,
          amount: res.intent.amount, accountInstanceId: res.intent.accountInstanceId,
        } satisfies ConfirmEcho,
        policy: {
          maxQuantity: ORDER_POLICY.maxQuantity, maxOrderAmount: ORDER_POLICY.maxOrderAmount,
          approvalTtlSeconds: ORDER_POLICY.approvalTtlSeconds,
        },
        // 이 기능은 22 의 주문 지원이 공식 문서로 확인되지 않았다 — 사용자에게 그대로 알린다.
        notice: "연금저축(22) 주문 API 지원은 공식 문서로 확인되지 않았습니다. 이 주문 자체가 지원 여부를 확인하는 첫 시도입니다.",
      });
  }
}

export async function handleOrderSubmit(
  request: Request, env: OrderEnv, ov: OrderHandlerOverrides = {}, registryOverride?: unknown,
): Promise<Response> {
  const r = await resolve(request, env, ov, registryOverride);
  if (isResponse(r)) return r;

  const body = (await request.json().catch(() => null)) as
    | { intentId?: unknown; approvalToken?: unknown; confirm?: unknown } | null;
  if (!body || typeof body.intentId !== "string" || typeof body.approvalToken !== "string"
      || typeof body.confirm !== "object" || body.confirm === null) {
    return json({ error: "intentId, approvalToken, confirm 이 필요합니다." }, 400);
  }
  const res = await submitOrder(
    r.ctx,
    { intentId: body.intentId, approvalToken: body.approvalToken, confirm: body.confirm as ConfirmEcho },
    r.deps,
  );
  switch (res.kind) {
    case "disabled": return json({ error: "order_disabled" }, 403);
    case "not_found": return json({ error: "not_found" }, 404);
    case "already_processed":
      return json({ error: "already_processed", intent: publicIntent(res.intent) }, 409);
    case "expired": return json({ error: "expired", intent: publicIntent(res.intent) }, 410);
    case "bad_token": return json({ error: "bad_token" }, 403);
    case "confirm_mismatch": return json({ error: "confirm_mismatch", field: res.field }, 409);
    case "account_changed": return json({ error: "account_changed" }, 409);
    case "policy_violation": return json({ error: "policy_violation", messages: res.messages }, 422);
    case "price_unavailable": return json({ error: "price_unavailable" }, 409);
    case "price_drift":
      return json({ error: "price_drift", intentPrice: res.intentPrice, currentPrice: res.currentPrice, driftPct: res.driftPct }, 409);
    case "buying_power_unverified": return json({ error: "buying_power_unverified" }, 409);
    case "buying_power_insufficient":
      return json({ error: "buying_power_insufficient", availableAmount: res.availableAmount, availableQty: res.availableQty }, 409);
    case "open_intent_exists": return json({ error: "open_intent_exists", intent: publicIntent(res.intent) }, 409);
    case "store_error": return json({ error: "store_error", message: res.message, sent: false }, 503);
    case "accepted":
      // 접수다. 체결이 아니다 — 체결은 status 조회로 확인한다.
      return json({ outcome: "accepted", executionConfirmed: false, intent: publicIntent(res.intent) });
    case "rejected":
      return json({ outcome: "rejected", intent: publicIntent(res.intent) }, 422);
    case "unknown":
      return json({
        outcome: "unknown",
        recorded: res.recorded,
        message: "접수 여부를 알 수 없습니다. 다시 주문하지 말고 상태를 조회하세요.",
        intent: publicIntent(res.intent),
      }, 202);
  }
}

export async function handleOrderStatus(
  request: Request, env: OrderEnv, ov: OrderHandlerOverrides = {}, registryOverride?: unknown,
): Promise<Response> {
  const r = await resolve(request, env, ov, registryOverride);
  if (isResponse(r)) return r;

  const intentId = new URL(request.url).searchParams.get("intentId");
  if (!intentId) return json({ error: "intentId 가 필요합니다." }, 400);
  const res = await reconcileOrder(r.ctx, intentId, r.deps);
  switch (res.kind) {
    case "disabled": return json({ error: "order_disabled" }, 403);
    case "not_found": return json({ error: "not_found" }, 404);
    case "nothing_to_reconcile": return json({ intent: publicIntent(res.intent) });
    case "in_flight": return json({ intent: publicIntent(res.intent), inFlight: true });
    case "inquiry_failed":
      return json({ intent: publicIntent(res.intent), inquiryFailed: true, message: res.message });
    case "reconciled": return json({ intent: publicIntent(res.intent), verdict: res.verdict.kind });
    case "store_error": return json({ error: "store_error", message: res.message }, 503);
  }
}

/**
 * POST /api/kis/order/resolve  { intentId, action, orderNo?, note, confirmIntentId }
 *
 * 응답 불명 의도의 수동 해소. 서버가 **그 자리에서 체결조회**를 하고 근거가 맞을 때만 바꾼다.
 * 근거가 부족하면 422 이고 아무 것도 쓰지 않는다. 주문·재주문·원장 기록이 없다.
 */
export async function handleOrderResolve(
  request: Request, env: OrderEnv, ov: OrderHandlerOverrides = {}, registryOverride?: unknown,
): Promise<Response> {
  const r = await resolve(request, env, ov, registryOverride);
  if (isResponse(r)) return r;

  const body = (await request.json().catch(() => null)) as
    | { intentId?: unknown; action?: unknown; orderNo?: unknown; note?: unknown; confirmIntentId?: unknown } | null;
  if (!body || typeof body.intentId !== "string" || typeof body.action !== "string"
      || typeof body.note !== "string" || typeof body.confirmIntentId !== "string") {
    return json({ error: "intentId, action, note, confirmIntentId 가 필요합니다." }, 400);
  }
  const res = await resolveOrder(r.ctx, {
    intentId: body.intentId,
    action: body.action as "link_order_no" | "dismiss_not_found",
    orderNo: typeof body.orderNo === "string" ? body.orderNo : null,
    note: body.note,
    confirmIntentId: body.confirmIntentId,
    actor: r.actor,
  }, r.deps);
  switch (res.kind) {
    case "disabled": return json({ error: "order_disabled" }, 403);
    case "not_found": return json({ error: "not_found" }, 404);
    case "bad_input": return json({ error: "bad_input", message: res.message }, 400);
    case "not_resolvable":
      return json({ error: "not_resolvable", message: res.reason, intent: publicIntent(res.intent) }, 409);
    case "order_no_in_use":
      return json({ error: "order_no_in_use", message: "그 주문번호는 다른 주문에 이미 연결돼 있습니다." }, 409);
    case "inquiry_failed":
      return json({ error: "inquiry_failed", message: res.message, intent: publicIntent(res.intent) }, 502);
    case "insufficient_evidence":
      return json({ error: "insufficient_evidence", message: res.reason, intent: publicIntent(res.intent) }, 422);
    case "stale":
      return json({ error: "stale", intent: res.intent ? publicIntent(res.intent) : null }, 409);
    case "store_error": return json({ error: "store_error", message: res.message }, 503);
    case "resolved":
      return json({
        intent: publicIntent(res.intent),
        resolution: {
          action: res.record.action, decidedAt: res.record.decidedAt, actor: res.record.actor,
          prevState: res.record.prevState, newState: res.record.newState,
        },
      });
  }
}
