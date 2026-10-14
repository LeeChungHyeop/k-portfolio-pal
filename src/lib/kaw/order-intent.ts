// ─────────────────────────────────────────────────────────────────────────────
// 주문 의도(order intent) — 순수 도메인 모듈
//
// 실주문은 **되돌릴 수 없고 응답이 유실될 수 있다.** 그래서 "주문을 보낸다"가 아니라
// "주문 의도를 저장하고, 그 의도를 정해진 상태 전이로만 앞으로 보낸다"로 모델링한다.
// 이 모듈에는 네트워크도 저장소도 없다 — 정책·상태 전이·증거 판정만 있다.
//
// ── 핵심 원칙 ──────────────────────────────────────────────────────────────
//
//   1. **접수 ≠ 체결.** `accepted`(주문번호를 받았다)는 체결을 말하지 않는다. 체결은
//      체결조회에서 읽은 `filledQty` 가 있어야만 `filled`/`partially_filled` 다
//   2. **응답이 불명이면 재주문하지 않는다.** 타임아웃·네트워크 오류·해석 불가는
//      `unknown` 이고, `unknown` 에서 나가는 길은 **조회**뿐이다(재전송 없음)
//   3. **보내기 전에 저장한다.** `submitting` 이 영속된 뒤에만 요청이 나간다. 재시작 후
//      `submitting` 이 남아 있으면 "보냈을 수도 있다"로 읽는다
//   4. **승인은 1회성이다.** 승인 토큰은 해시만 저장하고, `submitting` 전이와 같은 쓰기에서
//      소비한다
//   5. **정책은 코드다.** 첫 실주문은 360750 · 1주 · 지정가 · 매수로 제한한다. 환경
//      변수로 넓힐 수 없다(넓히려면 코드와 테스트를 바꿔야 한다)
//   6. **체결 증거 전에는 원장에 기록하지 않는다.** `ledgerEligibility` 가 그 게이트다
// ─────────────────────────────────────────────────────────────────────────────

import { stableDigest } from "./rebalance-plan";

// ── 정책 ────────────────────────────────────────────────────────────────────

export const ORDER_POLICY = Object.freeze({
  version: 1,
  productCode: "22",
  side: "buy",
  /** 지정가 */
  ordDvsn: "00",
  /** 첫 실주문 대상. 이 목록 밖의 종목은 의도 단계에서 거부한다 */
  allowedTickers: ["360750"] as readonly string[],
  maxQuantity: 1,
  /** 건당 상한(원). 지정가 × 수량 */
  maxOrderAmount: 100_000,
  /** 주문 직전 현재가가 의도 단가에서 이만큼(%) 넘게 벗어나면 보내지 않는다 */
  priceDriftTolerancePct: 1,
  /** 승인 토큰 유효 시간(초) */
  approvalTtlSeconds: 120,
  /** `submitting` 이 이 시간(초)보다 오래 남아 있으면 응답 유실로 본다 */
  submittingStaleSeconds: 30,
} as const);

export type OrderSide = "buy";

// ── 상태 ────────────────────────────────────────────────────────────────────

export type OrderState =
  /** 의도가 저장됐고 승인을 기다린다 (토큰 미소비) */
  | "proposed"
  /** 요청을 보내려고 한다. **영속된 뒤에만** 요청이 나간다 */
  | "submitting"
  /** 증권사가 주문번호를 줬다 — 접수. 체결이 아니다 */
  | "accepted"
  /** 증권사가 명시적으로 거부했다 (rt_cd≠0) — 주문은 존재하지 않는다 */
  | "rejected"
  /** 접수 여부를 모른다(타임아웃·네트워크·해석 불가). **조회로만 해소한다** */
  | "unknown"
  /** 체결조회로 확인: 접수됐고 체결 수량이 0 이다(미체결) */
  | "open"
  /** 체결조회로 확인: 일부 체결 */
  | "partially_filled"
  /** 체결조회로 확인: 전량 체결 */
  | "filled"
  /** 체결조회로 확인: 취소됨(우리가 취소한 것이 아니다 — 취소 기능은 없다) */
  | "cancelled"
  /** 승인 기한이 지나 쓸 수 없다 */
  | "expired"
  /**
   * **수동 해소**: 응답 불명이던 주문을 사용자가 "증권사에 없음"으로 정리했다. 장 마감 후
   * 체결조회에서 조건이 같은 주문이 하나도 없다는 **증권사 조회 결과**가 있을 때만 서버가
   * 허용한다(order-service.ts resolveOrder). 주문번호가 없고, 체결 증거도 없다.
   */
  | "dismissed";

/** 더 이상 앞으로 가지 않는 상태. 새 주문 의도를 막지 않는다. */
export const TERMINAL_STATES: readonly OrderState[] = [
  "rejected", "filled", "cancelled", "expired", "dismissed",
];

/** 주문이 증권사에 **존재할 수 있는** 상태. 같은 의도의 재전송을 금지한다. */
export const POSSIBLY_PLACED_STATES: readonly OrderState[] = [
  "submitting", "accepted", "unknown", "open", "partially_filled", "filled",
];

export const isTerminal = (s: OrderState) => TERMINAL_STATES.includes(s);

/** 허용되는 전이. 이 표에 없는 전이는 코드가 거부한다. */
const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  proposed: ["submitting", "expired"],
  // 재시작 후 조회로 곧바로 접수/체결을 읽을 수 있다(submitting 이 남아 있던 경우).
  // dismissed 는 수동 해소(증권사 조회 근거)로만 간다.
  submitting: ["accepted", "rejected", "unknown", "open", "partially_filled", "filled", "cancelled", "dismissed"],
  // unknown → 조회로 해소: 접수/체결 증거가 나오면 앞으로, 아무것도 못 찾으면 그대로
  unknown: ["accepted", "open", "partially_filled", "filled", "cancelled", "unknown", "dismissed"],
  accepted: ["open", "partially_filled", "filled", "cancelled", "accepted"],
  open: ["partially_filled", "filled", "cancelled", "open"],
  partially_filled: ["partially_filled", "filled", "cancelled"],
  rejected: [],
  filled: [],
  cancelled: [],
  expired: [],
  dismissed: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

// ── 의도 ────────────────────────────────────────────────────────────────────

export interface OrderScope {
  familyCode: string;
  profile: string;
}

export interface ExecutionEvidence {
  /** 체결조회에서 읽은 체결 수량 */
  filledQty: number;
  /** 평균 체결가. 모르면 null */
  avgPrice: number | null;
  /** 증거를 만든 조회. 이것이 아니면 체결 증거가 아니다 */
  source: "inquire_daily_ccld";
  /**
   * 어떻게 이 주문과 대응됐는가.
   *   order_no     증권사 **주문 응답**이 준 주문번호로 대응(우리가 보낸 주문임이 확실)
   *   user_linked  사용자가 수동으로 연결한 주문번호로 대응 — 증권사 기록만으로는 앱이 보낸
   *                주문인지 직접 매매인지 구별할 수 없다. **체결 확정·원장 근거가 아니다**
   *   heuristic    조건 일치(과거 호환. 지금은 만들지 않는다)
   */
  matchedBy: "order_no" | "user_linked" | "heuristic";
  at: string;
}

/** 주문번호의 출처. 응답이 준 번호만 "우리 주문"의 증거다. */
export type OrderNoSource = "broker_response" | "user_linked";

export interface OrderIntent {
  id: string;
  scope: OrderScope;
  /** 같은 주문의 중복 생성을 막는 키 (같은 계좌·날짜·종목·수량·단가·시도 번호) */
  idempotencyKey: string;
  attempt: number;

  accountInstanceId: string;
  broker: "kis";
  productCode: "22";
  side: OrderSide;
  ticker: string;
  quantity: number;
  limitPrice: number;
  ordDvsn: "00";
  /** quantity × limitPrice */
  amount: number;
  /** 의도를 만든 시점의 매수가능조회 결과(참고). 주문 직전에 다시 조회한다 */
  buyingPowerAtProposal: { amount: number; qty: number } | null;

  state: OrderState;
  /** 낙관적 잠금. 쓸 때마다 +1 */
  version: number;

  // 승인 — 토큰 원문은 저장하지 않는다
  approvalTokenHash: string;
  approvalExpiresAt: string;
  approvalConsumedAt: string | null;

  // 접수
  submitStartedAt: string | null;
  orderNo: string | null;
  /** 주문번호 출처. 없으면(null/미기록) 응답 번호로 보지 않는다 — 단, 기존 행 호환을 위해 orderNo 가 있고 이 값이 없으면 broker_response 로 읽는다 */
  orderNoSource?: OrderNoSource | null;
  orderOrgNo: string | null;
  orderTime: string | null;

  // 체결 증거
  evidence: ExecutionEvidence | null;
  lastInquiryAt: string | null;
  /** 조회에서 조건이 여러 개 일치해 어느 것인지 가릴 수 없다 — 사람이 확인해야 한다 */
  ambiguous: boolean;

  /** 마지막 오류 사유(민감값 제거됨) */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  policyVersion: number;
}

// ── 의도 검증 (정책) ────────────────────────────────────────────────────────

export interface ProposalInput {
  ticker: string;
  quantity: number;
  limitPrice: number;
}

export type PolicyViolation =
  | "ticker_not_allowed"
  | "quantity_invalid"
  | "quantity_exceeds_limit"
  | "price_invalid"
  | "amount_exceeds_limit";

/** 의도가 정책 안인가. 위반 사유 목록(비어 있으면 통과). */
export function checkPolicy(p: ProposalInput): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  if (!/^[A-Z0-9]{6}$/.test(p.ticker) || !ORDER_POLICY.allowedTickers.includes(p.ticker)) {
    v.push("ticker_not_allowed");
  }
  if (!Number.isInteger(p.quantity) || p.quantity <= 0) v.push("quantity_invalid");
  else if (p.quantity > ORDER_POLICY.maxQuantity) v.push("quantity_exceeds_limit");
  if (!Number.isInteger(p.limitPrice) || p.limitPrice <= 0) v.push("price_invalid");
  else if (p.quantity > 0 && p.quantity * p.limitPrice > ORDER_POLICY.maxOrderAmount) {
    v.push("amount_exceeds_limit");
  }
  return v;
}

export const POLICY_VIOLATION_TEXT: Readonly<Record<PolicyViolation, string>> = {
  ticker_not_allowed: "첫 실주문은 TIGER 미국S&P500(360750)만 허용됩니다.",
  quantity_invalid: "수량은 1 이상의 정수여야 합니다.",
  quantity_exceeds_limit: `첫 실주문은 ${ORDER_POLICY.maxQuantity}주까지만 허용됩니다.`,
  price_invalid: "지정가는 1 이상의 정수여야 합니다.",
  amount_exceeds_limit: `건당 주문금액은 ${ORDER_POLICY.maxOrderAmount.toLocaleString("ko-KR")}원 이하여야 합니다.`,
};

// ── 멱등 키 ─────────────────────────────────────────────────────────────────

/**
 * 같은 계좌·같은 영업일·같은 종목·수량·단가·방향은 **같은 키**다. 그래서 같은 주문이
 * 두 번 만들어질 수 없다. 이미 거부된(rejected)·만료된 의도가 있을 때만 시도 번호를
 * 올려 새 의도를 허용한다(호출부가 `attempt` 를 정한다).
 */
export function idempotencyKeyOf(
  accountInstanceId: string,
  businessDate: string,
  p: ProposalInput,
  attempt: number,
): string {
  const base = [
    accountInstanceId, businessDate, "buy", p.ticker, String(p.quantity), String(p.limitPrice),
  ].join("|");
  return `ord:${stableDigest(base)}#${attempt}`;
}

// ── 승인 토큰 ───────────────────────────────────────────────────────────────

/** SHA-256 hex. Workers·node 의 Web Crypto 를 쓴다. 토큰 원문은 어디에도 저장하지 않는다. */
export async function hashApprovalToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`order-approval:${token}`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 길이가 같을 때만 문자별로 누적 비교한다(조기 종료 없음). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newApprovalToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 응답 분류 ───────────────────────────────────────────────────────────────

export interface PlaceResponse {
  /** 네트워크/타임아웃/중단이면 0 */
  httpStatus: number;
  rtCd?: string;
  msgCd?: string;
  msg1?: string;
  orderNo?: string | null;
  orderOrgNo?: string | null;
  orderTime?: string | null;
  /** fetch 자체가 실패했다(응답을 받지 못했다) */
  transportError?: string;
  timedOut?: boolean;
  /** 본문을 JSON 으로 읽지 못했다 */
  unparseable?: boolean;
}

export type PlaceOutcome =
  | { kind: "accepted"; orderNo: string; orderOrgNo: string | null; orderTime: string | null }
  | { kind: "rejected"; error: string }
  | { kind: "unknown"; reason: string };

/**
 * 주문 응답 → 결과. **불명은 거부가 아니다.**
 *
 *   accepted  HTTP 2xx + rt_cd "0" + 주문번호가 있다
 *   rejected  응답을 받았고 rt_cd 가 "0" 이 아니다 — 증권사가 명시적으로 거부했다
 *   unknown   그 외 전부: 응답 없음·타임아웃·5xx·본문 해석 불가·rt_cd 0 인데 주문번호 없음
 *
 * rt_cd 0 인데 주문번호가 없는 응답을 성공으로 올리지 않는다 — 접수 여부를 모르는
 * 것이고, 조회로만 해소한다.
 */
export function classifyPlaceResponse(r: PlaceResponse): PlaceOutcome {
  if (r.transportError || r.httpStatus === 0) {
    return {
      kind: "unknown",
      reason: r.timedOut ? "응답 시간 초과 — 접수 여부를 알 수 없습니다" : "응답을 받지 못했습니다 — 접수 여부를 알 수 없습니다",
    };
  }
  if (r.unparseable) {
    return { kind: "unknown", reason: "응답을 해석하지 못했습니다 — 접수 여부를 알 수 없습니다" };
  }
  if (r.httpStatus >= 500) {
    return { kind: "unknown", reason: `서버 오류(HTTP ${r.httpStatus}) — 접수 여부를 알 수 없습니다` };
  }
  if (r.rtCd === undefined) {
    return { kind: "unknown", reason: `성공 여부를 알 수 없는 응답입니다 (HTTP ${r.httpStatus})` };
  }
  if (r.rtCd !== "0") {
    return { kind: "rejected", error: `${r.msgCd ?? "-"} ${r.msg1 ?? ""}`.trim() };
  }
  if (r.httpStatus < 200 || r.httpStatus >= 300) {
    return { kind: "unknown", reason: `성공 여부를 알 수 없는 응답입니다 (HTTP ${r.httpStatus})` };
  }
  if (!r.orderNo) {
    return { kind: "unknown", reason: "접수 응답에 주문번호가 없습니다 — 접수 여부를 조회로 확인해야 합니다" };
  }
  return {
    kind: "accepted",
    orderNo: r.orderNo,
    orderOrgNo: r.orderOrgNo ?? null,
    orderTime: r.orderTime ?? null,
  };
}

// ── 체결조회 해석 ───────────────────────────────────────────────────────────

/** 체결조회 한 행. 숫자를 못 읽은 필드는 null (0 이 아니다) */
export interface ExecutionRow {
  orderNo: string | null;
  ticker: string | null;
  orderQty: number | null;
  orderPrice: number | null;
  orderTime: string | null;
  filledQty: number | null;
  avgPrice: number | null;
  remainingQty: number | null;
  cancelled: boolean | null;
  /** 02 = 매수 */
  sideCode: string | null;
  /** 주문일 YYYYMMDD(ord_dt). 기간 조회에서 날짜를 구별하는 데 쓴다. 모르면 null/미기록 */
  orderDate?: string | null;
}

export type ReconcileVerdict =
  /** 우리 주문을 찾았고 상태를 읽었다 */
  | {
      kind: "matched";
      state: "accepted" | "open" | "partially_filled" | "filled" | "cancelled";
      matchedBy: "order_no" | "heuristic";
      orderNo: string | null;
      filledQty: number;
      avgPrice: number | null;
    }
  /** 아무것도 찾지 못했다 — **주문이 없다는 증거가 아니다**(조회 지연·다른 날짜 가능) */
  | { kind: "not_found" }
  /** 조건이 일치하는 행이 둘 이상이다 — 어느 것인지 가릴 수 없다 */
  | { kind: "ambiguous"; count: number }
  /**
   * 주문번호를 모르는 상태에서 조건이 비슷한 행을 찾았다. **우리 주문이라는 증거가 아니다** —
   * 같은 종목·수량·가격의 수동매매일 수 있다. 후보로만 보이고, 주문번호 채택·상태 승격·
   * 체결 주장은 하지 않는다.
   */
  | { kind: "candidate"; count: number }
  /** 찾았지만 수량 필드를 읽지 못해 체결 여부를 판정할 수 없다 */
  | { kind: "unreadable" };

/** 전송 시작 시각(KST HHMMSS)에서 1분 뺀 값. 시계 오차 여유. 모르면 null */
export function kstClockFloor(submitStartedAt: string | null | undefined): string | null {
  if (!submitStartedAt) return null;
  const ms = Date.parse(submitStartedAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 9 * 3_600_000 - 60_000).toISOString().slice(11, 19).replace(/:/g, "");
}

/**
 * 조회 행들에서 이 의도의 주문을 찾아 상태를 판정한다.
 *
 * 대응 규칙:
 *   · 주문번호를 알면 **주문번호가 같은 행**만 본다(다른 조건은 보지 않는다)
 *   · 모르면(응답 유실) 종목·매수·수량·지정가가 같은 행을 **후보(candidate)로만** 센다.
 *     후보는 우리 주문의 증거가 아니다 — 같은 조건의 수동매매와 구별할 수 없다. 주문시각은
 *     후보 필터로만 쓰고, 번호 채택·체결 판정은 하지 않는다
 *
 * 체결 판정은 **체결 수량**으로만 한다: 0 이면 미체결, 주문 수량 미만이면 일부 체결, 같으면
 * 전량 체결. 체결 수량을 읽지 못하면 `unreadable` 이다 — 접수됐다고 체결로 올리지 않는다.
 */
export function judgeExecution(
  intent: Pick<OrderIntent, "orderNo" | "ticker" | "quantity" | "limitPrice"> & { submitStartedAt?: string | null },
  rows: readonly ExecutionRow[],
): ReconcileVerdict {
  if (!intent.orderNo) {
    // 주문번호를 모른다 — **어떤 행도 우리 주문으로 확정하지 않는다.** 조건이 맞는 행은
    // 후보일 뿐이다(같은 종목·수량·가격의 수동매매와 구별할 수 없다). 주문시각은 후보를
    // 좁히는 필터로만 쓰고, 시각이 맞아도 체결 증거가 되지 않는다.
    const floor = kstClockFloor(intent.submitStartedAt);
    const cands = rows.filter(
      (r) =>
        r.ticker === intent.ticker &&
        (r.sideCode === null || r.sideCode === "02") &&
        r.orderQty === intent.quantity &&
        r.orderPrice === intent.limitPrice &&
        (floor === null || r.orderTime === null || r.orderTime >= floor),
    );
    if (cands.length === 0) return { kind: "not_found" };
    return { kind: "candidate", count: cands.length };
  }
  const matchedBy = "order_no" as const;
  const candidates = rows.filter((r) => r.orderNo === intent.orderNo);
  if (candidates.length === 0) return { kind: "not_found" };
  if (candidates.length > 1) return { kind: "ambiguous", count: candidates.length };

  const r = candidates[0];
  if (r.cancelled === true) {
    return {
      kind: "matched", state: "cancelled", matchedBy, orderNo: r.orderNo,
      filledQty: r.filledQty ?? 0, avgPrice: r.avgPrice,
    };
  }
  if (r.filledQty === null || r.orderQty === null) return { kind: "unreadable" };
  const filled = r.filledQty;
  const state =
    filled <= 0 ? "open"
      : filled >= r.orderQty ? "filled"
      : "partially_filled";
  return { kind: "matched", state, matchedBy, orderNo: r.orderNo, filledQty: filled, avgPrice: r.avgPrice };
}

// ── 원장 게이트 ─────────────────────────────────────────────────────────────

export type LedgerEligibility =
  | { eligible: true; filledQty: number; avgPrice: number | null; orderNo: string }
  | { eligible: false; reason: string };

/**
 * 거래 원장(Transaction Ledger)에 기록해도 되는가. **체결 증거가 있을 때만 true 다.**
 *
 *   · 접수(accepted)·미체결(open)·응답 불명(unknown)은 체결이 아니다
 *   · 증거는 체결조회에서 읽은 체결 수량이다
 *   · 조건 일치(heuristic)로만 대응된 증거는 **사람이 확인하기 전까지** 원장 근거가 아니다
 *
 * 이 함수는 판정만 한다 — 원장에 쓰지 않는다(이 단계에 원장 기록 경로가 없다).
 */
export function ledgerEligibility(intent: OrderIntent): LedgerEligibility {
  if (intent.state !== "filled" && intent.state !== "partially_filled") {
    return { eligible: false, reason: `체결이 확인되지 않았습니다 (상태: ${intent.state})` };
  }
  const e = intent.evidence;
  if (!e || e.source !== "inquire_daily_ccld") {
    return { eligible: false, reason: "체결조회 증거가 없습니다" };
  }
  if (!(e.filledQty > 0)) return { eligible: false, reason: "체결 수량이 0 입니다" };
  if (e.matchedBy !== "order_no" || !intent.orderNo || intent.orderNoSource === "user_linked") {
    return { eligible: false, reason: "주문번호로 대응되지 않은 증거라 사람의 확인이 필요합니다" };
  }
  if (intent.ambiguous) return { eligible: false, reason: "일치하는 주문이 여러 건이라 확인이 필요합니다" };
  return { eligible: true, filledQty: e.filledQty, avgPrice: e.avgPrice, orderNo: intent.orderNo };
}

// ── 수동 해소 ───────────────────────────────────────────────────────────────
//
// 응답 불명(`unknown`)·전송 중 멈춤(`submitting`)·"확인 필요" 의도는 체결조회만으로 풀리지
// 않을 수 있다(주문번호를 모르면 후보를 확정하지 않기 때문). 사람이 풀되, **사람의 말만으로는
// 아무 것도 확정하지 않는다** — 서버가 그 자리에서 증권사 체결조회를 다시 하고, 증거가 맞을
// 때만 상태를 바꾼다. 두 가지뿐이다:
//
//   link_order_no      사용자가 증권사 앱에서 본 주문번호를 넣는다 → 서버가 그 번호로 조회해
//                      한 건이 있고, 종목·매수·수량·지정가가 같고, 주문시각이 전송 이후일 때만
//                      그 번호를 붙이고 조회 결과대로 접수/미체결/체결을 정한다
//   dismiss_not_found  주문일 장이 끝난 뒤(다음 날 이후) 조회했는데 조건이 같은 주문이 **한 건도**
//                      없을 때만 "미접수(dismissed)"로 정리한다 → 그 뒤에야 새 시도가 열린다
//
// 기록: 해소는 의도 행을 지우지 않고(상태 컬럼만 CAS 로 바꾼다) **별도 감사 행**을 남긴다
// (근거·처리시각·처리자·이전/이후 상태). 원장에는 아무 것도 쓰지 않는다.

export type ResolutionAction = "link_order_no" | "dismiss_not_found";

export const RESOLVABLE_STATES: readonly OrderState[] = ["unknown", "submitting"];

export interface OrderResolutionRecord {
  id: string;
  scope: OrderScope;
  intentId: string;
  action: ResolutionAction;
  /** 처리자: 세션의 프로필. 감사용 */
  actor: string;
  /** 사용자가 적은 근거(증권사 앱에서 무엇을 봤는가) */
  note: string;
  decidedAt: string;
  prevState: OrderState;
  newState: OrderState;
  prevVersion: number;
  /** 서버가 그 자리에서 조회한 증권사 근거 요약. 계좌번호·키는 없다 */
  evidence: Record<string, unknown>;
}

export const RESOLUTION_NOTE_MIN = 5;
export const RESOLUTION_NOTE_MAX = 500;

/** 증권사 주문번호를 비교 가능한 10자리로. 숫자 1~10자리가 아니면 null */
export function normalizeOrderNo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  if (/^0+$/.test(t)) return null;
  return t.padStart(10, "0");
}

/**
 * 체결이 **확정**됐는가 — 증권사 주문 응답의 주문번호로 대응된 체결조회 증거가 있을 때만.
 * 사용자가 연결한 주문번호(user_linked)로 읽은 체결은 화면에 보이되 확정이 아니다.
 */
export function isExecutionConfirmed(i: Pick<OrderIntent, "state" | "evidence" | "orderNo" | "orderNoSource">): boolean {
  return (i.state === "filled" || i.state === "partially_filled")
    && !!i.evidence && i.evidence.source === "inquire_daily_ccld" && i.evidence.filledQty > 0
    && i.evidence.matchedBy === "order_no" && !!i.orderNo && i.orderNoSource !== "user_linked";
}

/** 체결조회(TTTC0081R) 한 번의 조회 기간 한도. 이보다 오래된 주문은 조회 근거로 정리하지 않는다 */
export const CCLD_LOOKBACK_DAYS = 90;
/** 한 페이지 최대 행 수로 본다. 이만큼 오면 다음 페이지가 있을 수 있어 "전부 봤다"고 하지 않는다 */
export const CCLD_PAGE_ROWS = 100;
