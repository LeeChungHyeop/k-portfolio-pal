// ─────────────────────────────────────────────────────────────────────────────
// 승인형 주문 서비스 — 의도 생성 · 승인 제출 · 조회 해소 (서버 전용, 의존성 주입)
//
// 이 모듈은 **순서**를 책임진다. 증권사 호출·저장소·시계·난수는 전부 주입받으므로 테스트가
// 모의 응답으로 정상·거부·중복·타임아웃·부분체결·재시작 복구를 재현한다.
//
// ── 제출 순서(submitOrder) — 앞 단계가 막으면 뒤 단계를 실행하지 않는다 ──────
//
//   flag → 의도 존재 → 상태(proposed) → 승인 기한 → 토큰 → 확인 echo → 계좌 instance →
//   정책 → 시세 재검증 → 매수가능금액 재검증 → 열린 의도 없음 →
//   **저장(submitting, 토큰 소비) → 전송 → 결과 저장**
//
//   · 저장이 실패하면 **전송하지 않는다**(보냈는지 모르는 상태를 만들지 않는다)
//   · 전송 뒤 결과 저장이 실패해도 **재전송하지 않는다** — 상태는 submitting 으로 남고
//     조회(reconcile)가 해소한다
//   · 어떤 결과(거부 포함)에서도 같은 의도를 다시 보내는 경로가 없다
// ─────────────────────────────────────────────────────────────────────────────

import {
  ORDER_POLICY,
  POLICY_VIOLATION_TEXT,
  canTransition,
  checkPolicy,
  classifyPlaceResponse,
  constantTimeEqual,
  hashApprovalToken,
  idempotencyKeyOf,
  isTerminal,
  judgeExecution,
  type ExecutionRow,
  type OrderIntent,
  type OrderScope,
  type OrderState,
  type PlaceOutcome,
  type PlaceResponse,
  type PolicyViolation,
  type ReconcileVerdict,
} from "./order-intent";
import type { OrderIntentPatch, OrderIntentStore } from "./order-store";
import { toVerifiedBuyingPower, type BuyingPowerResult } from "./kis-buying-power";
import { kstDateString } from "./snapshot";

// ── 의존성 ──────────────────────────────────────────────────────────────────

export interface BrokerPort {
  /** 현재가(정수 원). 모르면 price null */
  quote(ticker: string): Promise<{ price: number | null; asOf: string }>;
  /** 종목·지정가 기준 매수가능조회 (TTTC8908R, GET) */
  buyingPower(ticker: string, unitPrice: number): Promise<BuyingPowerResult>;
  /** 주문 1회 전송 (TTTC0012U, POST). sent=false 면 아무 것도 전송되지 않았다 */
  place(req: { ticker: string; quantity: number; limitPrice: number }): Promise<PlaceResponse & { sent: boolean }>;
  /** 일별 체결조회 (TTTC0081R, GET) */
  inquire(q: { ticker: string; date: string; orderNo: string | null }): Promise<{
    ok: boolean; rows: ExecutionRow[]; hasMore: boolean; error?: string;
  }>;
}

export interface OrderServiceDeps {
  store: OrderIntentStore;
  broker: BrokerPort;
  /** 서버 기능 flag. **기본 false**. 켜지 않으면 어떤 함수도 증권사를 호출하지 않는다 */
  enabled: boolean;
  now: () => Date;
  newId: () => string;
  newToken: () => string;
}

export interface OrderContext {
  scope: OrderScope;
  /** 지금 레지스트리에서 확인된 KIS 22 instance id */
  accountInstanceId: string;
}

// ── 결과 타입 ───────────────────────────────────────────────────────────────

export type PrepareResult =
  | { kind: "disabled" }
  | { kind: "policy_violation"; violations: PolicyViolation[]; messages: string[] }
  | { kind: "no_price" }
  | { kind: "buying_power_unverified" }
  | { kind: "buying_power_insufficient"; availableAmount: number; availableQty: number }
  /** 이미 진행 중이거나 끝난 같은 주문이 있다 — 새로 만들지 않는다 */
  | { kind: "duplicate"; intent: OrderIntent }
  /** 다른 주문 의도가 아직 끝나지 않았다 */
  | { kind: "open_intent_exists"; intent: OrderIntent }
  | { kind: "store_error"; message: string }
  | { kind: "proposed"; intent: OrderIntent; approvalToken: string };

export interface ConfirmEcho {
  ticker: string;
  quantity: number;
  limitPrice: number;
  amount: number;
  accountInstanceId: string;
}

export type SubmitResult =
  | { kind: "disabled" }
  | { kind: "not_found" }
  /** proposed 가 아니다 — 이미 제출됐거나 끝났다. 재전송하지 않는다 */
  | { kind: "already_processed"; intent: OrderIntent }
  | { kind: "expired"; intent: OrderIntent }
  | { kind: "bad_token" }
  | { kind: "confirm_mismatch"; field: keyof ConfirmEcho }
  | { kind: "account_changed" }
  | { kind: "policy_violation"; violations: PolicyViolation[]; messages: string[] }
  | { kind: "price_unavailable" }
  | { kind: "price_drift"; intentPrice: number; currentPrice: number; driftPct: number }
  | { kind: "buying_power_unverified" }
  | { kind: "buying_power_insufficient"; availableAmount: number; availableQty: number }
  | { kind: "open_intent_exists"; intent: OrderIntent }
  /** 저장에 실패해 **전송하지 않았다** */
  | { kind: "store_error"; message: string }
  | { kind: "accepted"; intent: OrderIntent }
  | { kind: "rejected"; intent: OrderIntent }
  /** 접수 여부를 모른다 — 재주문 금지, 조회로 확인해야 한다 */
  | { kind: "unknown"; intent: OrderIntent; recorded: boolean };

export type ReconcileResult =
  | { kind: "disabled" }
  | { kind: "not_found" }
  | { kind: "nothing_to_reconcile"; intent: OrderIntent }
  /** submitting 이 아직 오래되지 않았다 — 전송 중일 수 있다 */
  | { kind: "in_flight"; intent: OrderIntent }
  | { kind: "inquiry_failed"; intent: OrderIntent; message: string }
  | { kind: "reconciled"; intent: OrderIntent; verdict: ReconcileVerdict }
  | { kind: "store_error"; message: string };

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

const yyyymmdd = (isoDate: string) => isoDate.replaceAll("-", "");
const iso = (d: Date) => d.toISOString();

const OPEN_STATES: readonly OrderState[] = [
  "proposed", "submitting", "accepted", "unknown", "open", "partially_filled",
];

function messagesOf(v: PolicyViolation[]): string[] {
  return v.map((x) => POLICY_VIOLATION_TEXT[x]);
}

// ── 의도 생성 ───────────────────────────────────────────────────────────────

/**
 * 주문 의도를 만들고 1회성 승인 토큰을 발급한다. **주문은 보내지 않는다.**
 *
 * 지정가는 서버가 **지금 현재가**로 정한다(클라이언트가 임의 가격을 넣을 수 없다). 매수가능
 * 금액이 확인되지 않거나 모자라면 의도를 만들지 않는다.
 */
export async function prepareOrder(
  ctx: OrderContext,
  input: { ticker: string; quantity: number },
  deps: OrderServiceDeps,
): Promise<PrepareResult> {
  if (!deps.enabled) return { kind: "disabled" };

  const quote = await deps.broker.quote(input.ticker);
  if (quote.price === null || !Number.isInteger(quote.price) || quote.price <= 0) {
    return { kind: "no_price" };
  }
  const proposal = { ticker: input.ticker, quantity: input.quantity, limitPrice: quote.price };

  const violations = checkPolicy(proposal);
  if (violations.length) {
    return { kind: "policy_violation", violations, messages: messagesOf(violations) };
  }

  // 매수가능금액(그 지정가 기준)이 확인되고 충분해야 의도를 만든다.
  const bp = toVerifiedBuyingPower(await deps.broker.buyingPower(input.ticker, quote.price));
  if (!bp) return { kind: "buying_power_unverified" };
  const amount = proposal.quantity * proposal.limitPrice;
  if (bp.amount < amount || bp.qty < proposal.quantity) {
    return { kind: "buying_power_insufficient", availableAmount: bp.amount, availableQty: bp.qty };
  }

  const now = deps.now();
  const nowIso = iso(now);
  const businessDate = kstDateString(now);

  // 같은 주문 키 계열을 먼저 본다 — 이미 있으면 새로 만들지 않는다.
  const keyBase = idempotencyKeyOf(ctx.accountInstanceId, businessDate, proposal, 0).replace(/#\d+$/, "");
  const existing = await deps.store.findByKeyBase(ctx.scope, keyBase);
  const last = existing[existing.length - 1];

  if (last) {
    if (last.state === "proposed") {
      const expired = Date.parse(last.approvalExpiresAt) <= now.getTime();
      if (!expired) {
        // 아직 승인 전이다 — 같은 의도에 새 토큰을 발급한다(이전 토큰은 무효가 된다).
        const token = deps.newToken();
        const upd = await deps.store.update(ctx.scope, last.id, last.version, {
          approvalTokenHash: await hashApprovalToken(token),
          approvalExpiresAt: iso(new Date(now.getTime() + ORDER_POLICY.approvalTtlSeconds * 1000)),
        }, nowIso);
        if (!upd.ok) return { kind: "store_error", message: upd.message ?? upd.reason };
        return { kind: "proposed", intent: upd.intent, approvalToken: token };
      }
      // 만료된 의도는 닫고 새 시도로 넘어간다.
      await deps.store.update(ctx.scope, last.id, last.version, { state: "expired" }, nowIso);
    } else if (!isTerminal(last.state) || last.state === "filled" || last.state === "cancelled") {
      // 진행 중이거나 체결/취소까지 끝난 같은 주문 — 같은 키로는 다시 만들 수 없다.
      return { kind: "duplicate", intent: last };
    }
    // rejected / expired 는 새 시도가 허용된다.
  }

  // 다른 의도가 아직 끝나지 않았으면 새 주문을 만들지 않는다(동시에 하나만).
  // (승인 기한이 지난 proposed 는 막지 않는다. 방금 닫은 같은 키의 의도도 제외한다.)
  const open = await deps.store.listOpen(ctx.scope);
  const blocking = open.find((i) => {
    if (i.id === last?.id) return false;
    if (i.state === "proposed") return Date.parse(i.approvalExpiresAt) > now.getTime();
    return OPEN_STATES.includes(i.state);
  });
  if (blocking) return { kind: "open_intent_exists", intent: blocking };

  const attempt = (last?.attempt ?? 0) + 1;
  const token = deps.newToken();
  const intent: OrderIntent = {
    id: deps.newId(),
    scope: ctx.scope,
    idempotencyKey: idempotencyKeyOf(ctx.accountInstanceId, businessDate, proposal, attempt),
    attempt,
    accountInstanceId: ctx.accountInstanceId,
    broker: "kis",
    productCode: "22",
    side: "buy",
    ticker: proposal.ticker,
    quantity: proposal.quantity,
    limitPrice: proposal.limitPrice,
    ordDvsn: "00",
    amount,
    buyingPowerAtProposal: { amount: bp.amount, qty: bp.qty },
    state: "proposed",
    version: 0,
    approvalTokenHash: await hashApprovalToken(token),
    approvalExpiresAt: iso(new Date(now.getTime() + ORDER_POLICY.approvalTtlSeconds * 1000)),
    approvalConsumedAt: null,
    submitStartedAt: null,
    orderNo: null,
    orderOrgNo: null,
    orderTime: null,
    evidence: null,
    lastInquiryAt: null,
    ambiguous: false,
    lastError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    policyVersion: ORDER_POLICY.version,
  };

  const ins = await deps.store.insert(intent);
  if (!ins.ok) {
    if (ins.reason === "duplicate_key") {
      // 동시 요청이 먼저 만들었다 — 그것을 돌려준다.
      const again = await deps.store.findByKeyBase(ctx.scope, keyBase);
      const winner = again[again.length - 1];
      if (winner) return { kind: "duplicate", intent: winner };
    }
    return { kind: "store_error", message: ins.message ?? ins.reason };
  }
  return { kind: "proposed", intent, approvalToken: token };
}

// ── 승인 제출 ───────────────────────────────────────────────────────────────

export async function submitOrder(
  ctx: OrderContext,
  input: { intentId: string; approvalToken: string; confirm: ConfirmEcho },
  deps: OrderServiceDeps,
): Promise<SubmitResult> {
  if (!deps.enabled) return { kind: "disabled" };

  const intent = await deps.store.getById(ctx.scope, input.intentId);
  if (!intent) return { kind: "not_found" };

  // 이미 제출됐거나 끝난 의도는 **무엇도 보내지 않는다.** (토큰 재사용·더블클릭·재시도)
  if (intent.state !== "proposed") return { kind: "already_processed", intent };

  const now = deps.now();
  const nowIso = iso(now);

  if (Date.parse(intent.approvalExpiresAt) <= now.getTime()) {
    const exp = await deps.store.update(ctx.scope, intent.id, intent.version, { state: "expired" }, nowIso);
    return { kind: "expired", intent: exp.ok ? exp.intent : { ...intent, state: "expired" } };
  }

  const given = await hashApprovalToken(input.approvalToken ?? "");
  if (!constantTimeEqual(given, intent.approvalTokenHash)) return { kind: "bad_token" };

  // 주문 직전 재확인: 사용자가 본 값과 저장된 의도가 정확히 같아야 한다.
  const expected: ConfirmEcho = {
    ticker: intent.ticker,
    quantity: intent.quantity,
    limitPrice: intent.limitPrice,
    amount: intent.amount,
    accountInstanceId: intent.accountInstanceId,
  };
  const c = input.confirm;
  for (const f of Object.keys(expected) as Array<keyof ConfirmEcho>) {
    if (c?.[f] !== expected[f]) return { kind: "confirm_mismatch", field: f };
  }
  if (ctx.accountInstanceId !== intent.accountInstanceId) return { kind: "account_changed" };

  const violations = checkPolicy({
    ticker: intent.ticker, quantity: intent.quantity, limitPrice: intent.limitPrice,
  });
  if (violations.length) {
    return { kind: "policy_violation", violations, messages: messagesOf(violations) };
  }

  // 시세 재검증 — 사용자가 승인한 단가에서 크게 벗어났으면 보내지 않는다.
  const quote = await deps.broker.quote(intent.ticker);
  if (quote.price === null || quote.price <= 0) return { kind: "price_unavailable" };
  const driftPct = (Math.abs(quote.price - intent.limitPrice) / intent.limitPrice) * 100;
  if (driftPct > ORDER_POLICY.priceDriftTolerancePct) {
    return { kind: "price_drift", intentPrice: intent.limitPrice, currentPrice: quote.price, driftPct };
  }

  // 매수가능금액 재검증 — **주문할 그 지정가**로 다시 묻는다.
  const bp = toVerifiedBuyingPower(await deps.broker.buyingPower(intent.ticker, intent.limitPrice));
  if (!bp) return { kind: "buying_power_unverified" };
  if (bp.amount < intent.amount || bp.qty < intent.quantity) {
    return { kind: "buying_power_insufficient", availableAmount: bp.amount, availableQty: bp.qty };
  }

  const others = (await deps.store.listOpen(ctx.scope)).filter((i) => i.id !== intent.id && i.state !== "proposed");
  if (others.length) return { kind: "open_intent_exists", intent: others[0] };

  // **보내기 전에 저장한다.** 이 쓰기가 낙관적 잠금 + 토큰 소비다. 이긴 요청 하나만 전송한다.
  const claim = await deps.store.update(ctx.scope, intent.id, intent.version, {
    state: "submitting", approvalConsumedAt: nowIso, submitStartedAt: nowIso,
  }, nowIso);
  if (!claim.ok) {
    if (claim.reason === "stale") {
      const cur = await deps.store.getById(ctx.scope, intent.id);
      return { kind: "already_processed", intent: cur ?? intent };
    }
    return { kind: "store_error", message: claim.message ?? claim.reason };
  }

  // 전송 — 단 한 번.
  let outcome: PlaceOutcome;
  try {
    const resp = await deps.broker.place({
      ticker: intent.ticker, quantity: intent.quantity, limitPrice: intent.limitPrice,
    });
    outcome = resp.sent === false
      ? { kind: "rejected", error: resp.transportError ?? "전송하지 않음" }
      : classifyPlaceResponse(resp);
  } catch (e) {
    // 예외도 "보냈는지 모름"이다.
    outcome = { kind: "unknown", reason: `전송 중 예외 — 접수 여부를 알 수 없습니다 (${String((e as Error)?.message ?? e).slice(0, 60)})` };
  }

  const patch: OrderIntentPatch =
    outcome.kind === "accepted"
      ? { state: "accepted", orderNo: outcome.orderNo, orderOrgNo: outcome.orderOrgNo, orderTime: outcome.orderTime, lastError: null }
      : outcome.kind === "rejected"
        ? { state: "rejected", lastError: outcome.error }
        : { state: "unknown", lastError: outcome.reason };

  const done = await deps.store.update(ctx.scope, intent.id, claim.intent.version, patch, iso(deps.now()));
  if (!done.ok) {
    // 보냈지만 결과를 저장하지 못했다. 상태는 submitting 으로 남고 조회가 해소한다.
    return {
      kind: "unknown",
      intent: { ...claim.intent, lastError: "결과를 저장하지 못했습니다 — 조회로 확인해야 합니다" },
      recorded: false,
    };
  }
  if (outcome.kind === "accepted") return { kind: "accepted", intent: done.intent };
  if (outcome.kind === "rejected") return { kind: "rejected", intent: done.intent };
  return { kind: "unknown", intent: done.intent, recorded: true };
}

// ── 조회 해소 ───────────────────────────────────────────────────────────────

const RECONCILABLE: readonly OrderState[] = [
  "submitting", "accepted", "unknown", "open", "partially_filled",
];

/**
 * 접수·체결 상태를 **체결조회로** 확인한다. 응답이 유실된 주문의 유일한 해소 경로이고,
 * 이 함수는 **주문을 보내지 않는다.**
 *
 * 조회에서 아무것도 못 찾았다는 것은 "주문이 없다"의 증거가 아니다(반영 지연·다른 날짜).
 * 그래서 not_found 에서는 상태를 앞으로 보내지 않고, `rejected` 로 내리지도 않는다.
 */
export async function reconcileOrder(
  ctx: OrderContext,
  intentId: string,
  deps: OrderServiceDeps,
): Promise<ReconcileResult> {
  if (!deps.enabled) return { kind: "disabled" };
  const intent = await deps.store.getById(ctx.scope, intentId);
  if (!intent) return { kind: "not_found" };
  if (!RECONCILABLE.includes(intent.state)) return { kind: "nothing_to_reconcile", intent };

  const now = deps.now();
  const nowIso = iso(now);

  if (intent.state === "submitting" && intent.submitStartedAt) {
    const ageSec = (now.getTime() - Date.parse(intent.submitStartedAt)) / 1000;
    if (ageSec < ORDER_POLICY.submittingStaleSeconds) return { kind: "in_flight", intent };
  }

  // 주문일(KST) 기준 날짜로 조회한다.
  const orderDate = kstDateString(new Date(intent.submitStartedAt ?? intent.createdAt));
  const inq = await deps.broker.inquire({
    ticker: intent.ticker, date: yyyymmdd(orderDate), orderNo: intent.orderNo,
  });
  if (!inq.ok) {
    return { kind: "inquiry_failed", intent, message: inq.error ?? "체결조회에 실패했습니다" };
  }

  const verdict = judgeExecution(intent, inq.rows);
  const patch: OrderIntentPatch = { lastInquiryAt: nowIso };
  let target: OrderState = intent.state;

  if (verdict.kind === "matched") {
    target = verdict.state === "accepted" ? "accepted" : verdict.state;
    if (verdict.orderNo && !intent.orderNo) patch.orderNo = verdict.orderNo;
    patch.ambiguous = false;
    if (verdict.filledQty > 0) {
      patch.evidence = {
        filledQty: verdict.filledQty, avgPrice: verdict.avgPrice,
        source: "inquire_daily_ccld", matchedBy: verdict.matchedBy, at: nowIso,
      };
    }
  } else if (verdict.kind === "candidate") {
    // 주문번호 없이 조건만 비슷한 행 — 후보 표시뿐이다. 번호 채택·상태 승격 없음.
    patch.ambiguous = true;
    patch.lastError = `주문번호를 확인하지 못했습니다. 조건이 같은 주문 후보 ${verdict.count}건이 있으나 직접 매매일 수 있어 체결로 확정하지 않습니다 — 확인이 필요합니다`;
    if (intent.state === "submitting") target = "unknown";
  } else if (verdict.kind === "ambiguous") {
    patch.ambiguous = true;
    patch.lastError = `일치하는 주문이 ${verdict.count}건이라 어느 것인지 가릴 수 없습니다`;
    if (intent.state === "submitting") target = "unknown";
  } else if (verdict.kind === "not_found") {
    patch.lastError = "체결조회에서 이 주문을 찾지 못했습니다 — 주문이 없다는 뜻이 아닙니다";
    if (intent.state === "submitting") target = "unknown";
  } else {
    patch.lastError = "조회 응답의 수량 필드를 읽지 못해 체결 여부를 판정하지 못했습니다";
    if (intent.state === "submitting") target = "unknown";
  }

  if (target !== intent.state) {
    if (!canTransition(intent.state, target)) {
      return { kind: "reconciled", intent, verdict };
    }
    patch.state = target;
  }

  const upd = await deps.store.update(ctx.scope, intent.id, intent.version, patch, nowIso);
  if (!upd.ok) return { kind: "store_error", message: upd.message ?? upd.reason };
  return { kind: "reconciled", intent: upd.intent, verdict };
}
