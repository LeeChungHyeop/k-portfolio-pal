// ─────────────────────────────────────────────────────────────────────────────
// 승인형 주문 — 브라우저 쪽 (판단·요청·상태 표시 모델)
//
// 이 모듈은 **순수 함수 + fetch 주입**이다. React 도 DOM 도 모른다(그래서 node 테스트로 고정된다).
//
//   · 기본 OFF: 빌드 flag `VITE_KAW_KIS_ORDER_UI === "on"` 이 아니면 화면 자체가 없다
//   · 연금저축(22)·api 모드·등록된 active 계좌에서만 보인다 — 아니면 숨긴다(서버가 한 번 더 막는다)
//   · 주문 POST(`submit`)는 **최종 승인 단계(phase "final")에서 begin_submit 이 통과한 뒤 한 번만**
//     나간다. 준비(prepare)는 주문을 보내지 않는다
//   · 응답을 못 받으면 **불명**이다. 자동 재전송·자동 재주문이 없다
//   · 승인 토큰은 메모리에만 둔다(새로고침하면 사라지고, 서버 의도는 남는다)
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokerAccountInstance } from "./broker-account";
import { kisApiQueryGate, type ApiQueryGate } from "./broker-connection";
import { getSessionToken } from "./auth";
import { ORDER_POLICY } from "./order-intent";

// ── 대상 고정 ───────────────────────────────────────────────────────────────

/** 이 UI 가 만들 수 있는 주문은 이것 하나다. 입력 필드가 없다. */
export const ORDER_TARGET = Object.freeze({
  accountType: "pension" as const,
  productCode: ORDER_POLICY.productCode,
  ticker: ORDER_POLICY.allowedTickers[0],
  tickerName: "TIGER 미국S&P500",
  quantity: 1,
});

export const ORDER_UI_ENV_KEY = "VITE_KAW_KIS_ORDER_UI";

/** 정확히 "on" 일 때만 켜진다(`false`/`off`/`1`/`true` 로 켜지지 않는다). */
export const isOrderUiEnabled = (v: unknown): boolean => v === "on";

export type OrderUiGate =
  | { visible: true; instance: BrokerAccountInstance }
  | { visible: false; reason: "ui_disabled" | Extract<ApiQueryGate, { allowed: false }>["reason"] };

export function orderUiGate(
  registry: readonly BrokerAccountInstance[],
  today: string,
  uiFlag: unknown,
): OrderUiGate {
  if (!isOrderUiEnabled(uiFlag)) return { visible: false, reason: "ui_disabled" };
  const g = kisApiQueryGate(registry, ORDER_TARGET.accountType, today, ORDER_TARGET.productCode);
  if (!g.allowed) return { visible: false, reason: g.reason };
  return { visible: true, instance: g.instance };
}

// ── 서버 응답 모양 (order-handlers.ts publicIntent 의 사본) ─────────────────

export type IntentState =
  | "proposed" | "submitting" | "accepted" | "rejected" | "unknown"
  | "open" | "partially_filled" | "filled" | "cancelled" | "expired";

export interface IntentView {
  id: string;
  state: IntentState;
  ticker: string;
  quantity: number;
  limitPrice: number;
  amount: number;
  side: string;
  ordDvsn: string;
  accountInstanceId: string;
  attempt: number;
  orderNo: string | null;
  orderTime: string | null;
  approvalExpiresAt: string;
  evidence: { filledQty: number; avgPrice: number | null; matchedBy: string } | null;
  lastInquiryAt: string | null;
  ambiguous: boolean;
  lastError: string | null;
  executionConfirmed: boolean;
  ledgerEligible: boolean;
  needsUserConfirmation?: boolean;
}

export interface ConfirmView {
  ticker: string;
  quantity: number;
  limitPrice: number;
  amount: number;
  accountInstanceId: string;
}

// ── 요청 ────────────────────────────────────────────────────────────────────

type Fetch = typeof fetch;

export type PrepareOutcome =
  | { kind: "prepared"; intent: IntentView; approvalToken: string; confirm: ConfirmView }
  /** 같은 주문이 이미 있다 — 새로 만들지 않았다 */
  | { kind: "existing"; intent: IntentView }
  | { kind: "disabled" }
  | { kind: "denied" }
  | { kind: "unauthenticated" }
  | { kind: "blocked"; code: string; message: string }
  | { kind: "unavailable"; message: string };

export type SubmitOutcome =
  | { kind: "accepted"; intent: IntentView }
  | { kind: "rejected"; intent: IntentView }
  /** 접수 여부를 모른다. 다시 주문하면 안 된다 */
  | { kind: "unknown"; intent: IntentView | null; transport: boolean }
  | { kind: "already_processed"; intent: IntentView | null }
  | { kind: "expired" }
  /** 전송하지 않았음이 확실한 거절(검증 실패) */
  | { kind: "not_sent"; code: string; message: string }
  | { kind: "disabled" }
  | { kind: "denied" }
  | { kind: "unauthenticated" };

export type StatusOutcome =
  | { kind: "status"; intent: IntentView; inFlight: boolean; inquiryFailed: boolean; message?: string }
  | { kind: "disabled" }
  | { kind: "denied" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable"; message: string };

const NOT_SENT_TEXT: Record<string, string> = {
  policy_violation: "주문 정책 밖의 요청이라 전송하지 않았습니다.",
  no_price: "현재가를 확인하지 못해 전송하지 않았습니다.",
  price_unavailable: "현재가를 확인하지 못해 전송하지 않았습니다.",
  price_drift: "현재가가 승인한 가격에서 크게 벗어나 전송하지 않았습니다. 다시 준비해 주세요.",
  buying_power_unverified: "매수가능금액을 확인하지 못해 전송하지 않았습니다.",
  buying_power_insufficient: "매수가능금액이 부족해 전송하지 않았습니다.",
  account_not_ready: "주문할 수 있는 연금저축 계좌가 등록돼 있지 않습니다.",
  account_changed: "계좌 정보가 바뀌어 전송하지 않았습니다.",
  confirm_mismatch: "확인한 내용과 서버의 주문 내용이 달라 전송하지 않았습니다.",
  bad_token: "승인이 유효하지 않아 전송하지 않았습니다. 다시 준비해 주세요.",
  not_found: "주문 의도를 찾지 못했습니다.",
  store_error: "주문 기록을 저장하지 못해 전송하지 않았습니다.",
  open_intent_exists: "진행 중인 다른 주문이 있어 전송하지 않았습니다.",
};

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 준비 — 주문을 보내지 않는다. 의도와 1회성 승인 토큰을 받는다. */
export async function requestPrepare(fetchImpl: Fetch = fetch): Promise<PrepareOutcome> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthenticated" };
  let res: Response;
  try {
    res = await fetchImpl("/api/kis/order/prepare", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ticker: ORDER_TARGET.ticker, quantity: ORDER_TARGET.quantity }),
    });
  } catch {
    return { kind: "unavailable", message: "서버에 연결하지 못했습니다. 주문은 전송되지 않았습니다." };
  }
  const body = await readJson(res);
  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403) {
    return body?.error === "order_disabled" ? { kind: "disabled" } : { kind: "denied" };
  }
  if (res.ok && body?.intent && typeof body.approvalToken === "string" && body.confirm) {
    return {
      kind: "prepared",
      intent: body.intent as IntentView,
      approvalToken: body.approvalToken,
      confirm: body.confirm as ConfirmView,
    };
  }
  const err = typeof body?.error === "string" ? body.error : "";
  if ((err === "duplicate" || err === "open_intent_exists") && body?.intent) {
    return { kind: "existing", intent: body.intent as IntentView };
  }
  if (err === "policy_violation" && Array.isArray(body?.messages)) {
    return { kind: "blocked", code: err, message: (body!.messages as string[]).join(" ") };
  }
  if (err === "buying_power_insufficient") {
    return { kind: "blocked", code: err, message: "매수가능금액이 부족합니다." };
  }
  if (err) return { kind: "blocked", code: err, message: NOT_SENT_TEXT[err] ?? "주문을 준비하지 못했습니다." };
  return { kind: "unavailable", message: `서버가 응답하지 못했습니다 (HTTP ${res.status}).` };
}

/**
 * 제출 — **주문이 나가는 유일한 요청이다.** 호출 전에 반드시 phase "final" 이어야 한다
 * (`orderFlowReducer` 의 `begin_submit` 이 통과해야만 호출한다).
 * 재시도하지 않는다. 응답을 받지 못하면 `unknown`(transport) 이다.
 */
export async function requestSubmit(
  intentId: string,
  approvalToken: string,
  confirm: ConfirmView,
  fetchImpl: Fetch = fetch,
): Promise<SubmitOutcome> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthenticated" };
  let res: Response;
  try {
    res = await fetchImpl("/api/kis/order/submit", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ intentId, approvalToken, confirm }),
    });
  } catch {
    // 요청이 서버에 닿았는지 알 수 없다 — 전송 안 됨으로 단정하지 않는다.
    return { kind: "unknown", intent: null, transport: true };
  }
  const body = await readJson(res);
  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403 && body?.error === "order_disabled") return { kind: "disabled" };
  if (res.status === 403 && body?.error !== "bad_token") return { kind: "denied" };

  const intent = (body?.intent as IntentView | undefined) ?? null;
  if (res.status === 200 && body?.outcome === "accepted" && intent) return { kind: "accepted", intent };
  if (body?.outcome === "rejected" && intent) return { kind: "rejected", intent };
  if (res.status === 202 || body?.outcome === "unknown") return { kind: "unknown", intent, transport: false };
  if (body?.error === "already_processed") return { kind: "already_processed", intent };
  if (body?.error === "expired") return { kind: "expired" };
  if (typeof body?.error === "string") {
    return {
      kind: "not_sent", code: body.error,
      message: NOT_SENT_TEXT[body.error] ?? "전송하지 않았습니다.",
    };
  }
  // 2xx 인데 해석할 수 없음 / 5xx — 보냈을 수 있다.
  return { kind: "unknown", intent, transport: false };
}

/** 상태 조회 — 체결조회로 접수·체결을 확인한다. 주문을 보내지 않는다. */
export async function requestStatus(intentId: string, fetchImpl: Fetch = fetch): Promise<StatusOutcome> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthenticated" };
  let res: Response;
  try {
    res = await fetchImpl(`/api/kis/order/status?intentId=${encodeURIComponent(intentId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { kind: "unavailable", message: "서버에 연결하지 못했습니다." };
  }
  const body = await readJson(res);
  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403) return body?.error === "order_disabled" ? { kind: "disabled" } : { kind: "denied" };
  if (res.ok && body?.intent) {
    return {
      kind: "status",
      intent: body.intent as IntentView,
      inFlight: body.inFlight === true,
      inquiryFailed: body.inquiryFailed === true,
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
  }
  return { kind: "unavailable", message: `상태를 조회하지 못했습니다 (HTTP ${res.status}).` };
}

// ── 상태 표시 모델 ──────────────────────────────────────────────────────────

export type Tone = "neutral" | "info" | "warn" | "danger" | "success";

export interface OrderDisplay {
  label: string;
  tone: Tone;
  headline: string;
  detail: string;
  /** 체결 증거(체결조회)가 있는가. 접수·미체결·불명은 false */
  executionConfirmed: boolean;
  /** 새 주문을 다시 준비해도 되는가 — 거부·만료·취소만 true. 불명·접수·미체결은 false */
  canPrepareAgain: boolean;
  /** 상태 조회 버튼을 보일 상태인가 */
  canInquire: boolean;
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function describeOrder(i: IntentView): OrderDisplay {
  const filled = i.evidence?.filledQty ?? 0;
  // 서버가 말한 값만 믿는다 — 접수·불명을 체결로 올리지 않는다.
  const confirmed = i.executionConfirmed === true && i.evidence !== null;
  switch (i.state) {
    case "proposed":
      return { label: "승인 대기", tone: "info", headline: "아직 주문하지 않았습니다.",
        detail: "승인 기한 안에 최종 승인해야 주문이 전송됩니다.",
        executionConfirmed: false, canPrepareAgain: false, canInquire: false };
    case "submitting":
      return { label: "전송 중", tone: "warn", headline: "주문을 전송했거나 전송 중입니다.",
        detail: "응답을 확인하는 중입니다. 다시 주문하지 말고 상태를 조회하세요.",
        executionConfirmed: false, canPrepareAgain: false, canInquire: true };
    case "accepted":
      return { label: "접수", tone: "info", headline: "증권사가 주문을 접수했습니다. 체결된 것은 아닙니다.",
        detail: "체결 여부는 상태 조회로 확인합니다.",
        executionConfirmed: false, canPrepareAgain: false, canInquire: true };
    case "open":
      return { label: "미체결", tone: "info", headline: "접수됐고 아직 체결되지 않았습니다.",
        detail: "체결조회에서 주문번호로 확인된 상태입니다.",
        executionConfirmed: false, canPrepareAgain: false, canInquire: true };
    case "partially_filled":
      return { label: "부분체결", tone: "warn",
        headline: `${i.quantity}주 중 ${filled}주가 체결됐습니다.`,
        detail: "나머지는 아직 체결되지 않았습니다.",
        executionConfirmed: confirmed, canPrepareAgain: false, canInquire: true };
    case "filled":
      return { label: "체결", tone: "success",
        headline: `${filled || i.quantity}주 체결이 확인됐습니다.`,
        detail: i.evidence?.avgPrice ? `체결 평균가 ${won(i.evidence.avgPrice)}` : "체결조회로 확인됐습니다.",
        executionConfirmed: confirmed, canPrepareAgain: false, canInquire: false };
    case "rejected":
      return { label: "거부", tone: "danger", headline: "증권사가 주문을 거부했습니다.",
        detail: i.lastError ?? "주문은 나가지 않았습니다.",
        executionConfirmed: false, canPrepareAgain: true, canInquire: false };
    case "cancelled":
      return { label: "취소됨", tone: "neutral", headline: "주문이 취소된 것으로 조회됩니다.",
        detail: filled > 0 ? `취소 전 ${filled}주가 체결됐습니다.` : "체결된 수량이 없습니다.",
        executionConfirmed: confirmed, canPrepareAgain: true, canInquire: false };
    case "expired":
      return { label: "만료", tone: "neutral", headline: "승인 기한이 지나 주문이 만들어지지 않았습니다.",
        detail: "주문은 전송되지 않았습니다.",
        executionConfirmed: false, canPrepareAgain: true, canInquire: false };
    case "unknown":
    default:
      if (i.needsUserConfirmation || (i.ambiguous && !i.orderNo)) {
        return { label: "확인 필요", tone: "danger",
          headline: "주문 접수 여부를 확정하지 못했습니다.",
          detail: "조건이 같은 체결 후보가 있으나 직접 매매일 수 있어 이 주문의 체결로 확정하지 않습니다. "
            + "증권사 앱에서 확인하세요. 다시 주문하지 마세요.",
          executionConfirmed: false, canPrepareAgain: false, canInquire: true };
      }
      return { label: "불명", tone: "danger",
        headline: "주문이 접수됐는지 알 수 없습니다.",
        detail: "다시 주문하지 말고 상태를 조회하거나 증권사 앱에서 확인하세요.",
        executionConfirmed: false, canPrepareAgain: false, canInquire: true };
  }
}

// ── 단계 상태기계 ───────────────────────────────────────────────────────────

export type Phase = "idle" | "preparing" | "review" | "final" | "sending" | "done" | "error";

export interface FlowState {
  phase: Phase;
  intent: IntentView | null;
  /** 1회성 승인 토큰 — 메모리에만. done/idle 로 가면 버린다 */
  token: string | null;
  confirm: ConfirmView | null;
  message: string | null;
  /** 응답을 못 받아 결과를 모른다(전송 여부 불명) */
  lost: boolean;
}

export const INITIAL_FLOW: FlowState = {
  phase: "idle", intent: null, token: null, confirm: null, message: null, lost: false,
};

export type FlowEvent =
  | { type: "start_prepare" }
  | { type: "prepared"; intent: IntentView; token: string; confirm: ConfirmView }
  | { type: "existing"; intent: IntentView }
  | { type: "acknowledge" }
  | { type: "back" }
  | { type: "begin_submit" }
  | { type: "submitted"; intent: IntentView }
  | { type: "submit_lost"; intent: IntentView | null }
  | { type: "not_sent"; message: string }
  | { type: "expired" }
  | { type: "status"; intent: IntentView }
  /** 새로고침 뒤 저장된 의도 id 로 상태를 조회해 이어서 본다 */
  | { type: "resumed"; intent: IntentView }
  | { type: "failed"; message: string }
  | { type: "reset" };

/**
 * 순수 상태기계. **상태가 바뀌지 않으면 같은 객체를 돌려준다** — 호출부는 `next === state`
 * 이면 아무 것도 보내지 않는다(더블클릭·재진입 방지).
 */
export function flowReducer(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case "start_prepare":
      if (s.phase !== "idle" && s.phase !== "error") return s;
      return { ...INITIAL_FLOW, phase: "preparing" };

    case "prepared":
      if (s.phase !== "preparing") return s;
      return { phase: "review", intent: e.intent, token: e.token, confirm: e.confirm, message: null, lost: false };

    case "existing":
      if (s.phase !== "preparing") return s;
      return { ...INITIAL_FLOW, phase: "done", intent: e.intent };

    case "acknowledge":
      if (s.phase !== "review") return s;
      return { ...s, phase: "final" };

    case "back":
      if (s.phase !== "review" && s.phase !== "final") return s;
      return { ...INITIAL_FLOW };

    case "begin_submit":
      // 주문 POST 의 유일한 관문 — 최종 승인 단계에서만 통과한다.
      if (s.phase !== "final" || !s.intent || !s.token || !s.confirm) return s;
      return { ...s, phase: "sending" };

    case "submitted":
      if (s.phase !== "sending") return s;
      return { phase: "done", intent: e.intent, token: null, confirm: null, message: null, lost: false };

    case "submit_lost":
      if (s.phase !== "sending") return s;
      return {
        phase: "done", intent: e.intent ?? s.intent, token: null, confirm: null, lost: true,
        message: "응답을 받지 못했습니다. 주문이 접수됐을 수 있으니 다시 주문하지 말고 상태를 조회하세요.",
      };

    case "not_sent":
      if (s.phase !== "sending") return s;
      return { ...INITIAL_FLOW, phase: "error", message: e.message };

    case "expired":
      if (s.phase !== "review" && s.phase !== "final") return s;
      return { ...INITIAL_FLOW, message: "승인 기한이 지났습니다. 주문은 전송되지 않았습니다. 처음부터 다시 준비해 주세요." };

    case "status":
      if (s.phase !== "done") return s;
      return { ...s, intent: e.intent, message: null };

    case "resumed":
      if (s.phase !== "idle") return s;
      return { ...INITIAL_FLOW, phase: "done", intent: e.intent };

    case "failed":
      if (s.phase !== "preparing") return s;
      return { ...INITIAL_FLOW, phase: "error", message: e.message };

    case "reset": {
      if (s.phase === "error") return { ...INITIAL_FLOW };
      if (s.phase !== "done" || s.lost || !s.intent) return s;
      return describeOrder(s.intent).canPrepareAgain ? { ...INITIAL_FLOW } : s;
    }
  }
}

/** 승인 기한까지 남은 초. 모르면 0 */
export function secondsLeft(approvalExpiresAt: string, nowMs: number): number {
  const t = Date.parse(approvalExpiresAt);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : 0;
}

/**
 * 서버가 준 의도가 이 UI 가 만들려던 주문과 같은가. 다르면 **검토 화면으로 가지 않는다.**
 * (계좌·종목·수량·가격·금액을 사용자가 보는 값 그대로 승인하게 하려는 재확인이다)
 */
export function verifyPrepared(
  intent: IntentView,
  confirm: ConfirmView,
  expectedAccountInstanceId: string,
): { ok: true } | { ok: false; reason: string } {
  if (intent.ticker !== ORDER_TARGET.ticker) return { ok: false, reason: "종목이 예상과 다릅니다." };
  if (intent.quantity !== ORDER_TARGET.quantity) return { ok: false, reason: "수량이 예상과 다릅니다." };
  if (intent.side !== "buy" || intent.ordDvsn !== "00") return { ok: false, reason: "주문 방식이 예상과 다릅니다." };
  if (intent.accountInstanceId !== expectedAccountInstanceId) {
    return { ok: false, reason: "서버가 선택한 계좌가 화면의 연금저축 계좌와 다릅니다." };
  }
  if (!Number.isInteger(intent.limitPrice) || intent.limitPrice <= 0) return { ok: false, reason: "지정가가 올바르지 않습니다." };
  if (intent.amount !== intent.limitPrice * intent.quantity) return { ok: false, reason: "주문금액이 수량×가격과 다릅니다." };
  if (
    confirm.ticker !== intent.ticker || confirm.quantity !== intent.quantity
    || confirm.limitPrice !== intent.limitPrice || confirm.amount !== intent.amount
    || confirm.accountInstanceId !== intent.accountInstanceId
  ) {
    return { ok: false, reason: "서버의 확인 내용이 주문 내용과 다릅니다." };
  }
  return { ok: true };
}

/** 새로고침 뒤 상태 조회에 쓸 의도 id 의 저장 키(토큰은 저장하지 않는다). */
export const lastIntentKey = (accountInstanceId: string) => `kaw.order.lastIntent.${accountInstanceId}`;
