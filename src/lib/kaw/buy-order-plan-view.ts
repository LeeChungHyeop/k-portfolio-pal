// ─────────────────────────────────────────────────────────────────────────────
// 매수 주문안 → 화면 문구 (순수)
//
// 미리보기이므로 "주문", "체결", "확정" 같은 표현을 쓰지 않는다. 매수가능금액이 확인되지
// 않은 주문안은 어디서든 "예상"으로 읽힌다.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BudgetBasis,
  BuyOrderPlan,
  LineNote,
  PlanScope,
  PriceSource,
  Strategy,
  WarningLevel,
} from "./buy-order-plan";

export const LINE_NOTE_TEXT: Readonly<Record<LineNote, string>> = {
  non_tradable: "매수 대상 아님 (종목코드 없음/비중 0)",
  price_missing: "시세 없음 — 제외",
  holdings_not_entered: "보유수량 미입력 — 0주로 가정하지 않고 제외",
  already_at_target: "목표 도달",
  overweight_no_sell: "목표 초과 (매도하지 않음)",
  below_one_share: "1주 미만",
  budget_limited: "예산 한도로 일부만",
};

export const PRICE_SOURCE_TEXT: Readonly<Record<PriceSource, string>> = {
  kis: "KIS 실시간",
  naver: "네이버(대체)",
  history: "과거 종가",
  manual: "수동 입력",
  unavailable: "없음",
};

export const BUDGET_BASIS_TEXT: Readonly<Record<BudgetBasis, string>> = {
  buying_power: "매수가능금액(확인됨)",
  cash_upper_bound: "예수금(상한 추정 — 매수가능금액 미확인)",
  manual_cash: "입력한 예수금",
};

export const STRATEGY_TEXT: Readonly<Record<Strategy, string>> = {
  cash_new_buy: "현금 기반 신규 매수",
  with_holdings: "보유 수량 반영",
};

export const SCOPE_TEXT: Readonly<Record<PlanScope, string>> = {
  rebalance_buys: "보유를 반영한 리밸런싱 매수",
  additional_purchase: "별도 추가매수 (기존 보유는 목표에 넣지 않음)",
};

export const WARNING_LEVEL_ORDER: Readonly<Record<WarningLevel, number>> = {
  critical: 0, caution: 1, info: 2,
};

/** 심각한 경고가 먼저 오도록 정렬한다. 원본을 변형하지 않는다. */
export function sortedWarnings(plan: BuyOrderPlan) {
  return [...plan.warnings].sort(
    (a, b) => WARNING_LEVEL_ORDER[a.level] - WARNING_LEVEL_ORDER[b.level],
  );
}

/**
 * 제목 옆 배지. 예상/확인과 **참고용**을 구분한다. 평가가 불완전하면 매수가능금액이
 * 확인됐더라도 "참고용"이다 — 계좌 전체 목표 비중을 계산하지 못했기 때문이다.
 */
export function orderabilityBadge(plan: BuyOrderPlan): { text: string; tone: "warn" | "ok" | "blocked" } {
  if (plan.status === "blocked") return { text: "계산 불가", tone: "blocked" };
  if (plan.reliability === "reference_only") {
    return { text: "참고용 (평가 불완전 — 계좌 전체 비중을 계산하지 못함)", tone: "warn" };
  }
  return plan.orderability === "estimate_only"
    ? { text: "예상 주문안 (매수가능금액 미확인)", tone: "warn" }
    : { text: "매수가능금액 확인됨", tone: "ok" };
}

/**
 * 전략 전환 안내. 지금 전략이 이 계좌 상태에 맞지 않으면 전환할 전략과 문구를 낸다.
 * 자동으로 바꾸지 않는다 — 사용자가 누른다.
 */
export function strategySwitchHint(plan: BuyOrderPlan): { to: Strategy; text: string } | null {
  if (plan.status !== "ready") return null;
  if (plan.recommendedStrategy === plan.strategy) return null;
  return plan.recommendedStrategy === "with_holdings"
    ? {
        to: "with_holdings",
        text:
          plan.holdingsBasis === "has_holdings"
            ? "기존 보유가 있어 전체 리밸런싱 기준으로 보려면 '보유 수량 반영'으로 전환하세요."
            : "기존 보유를 확인한 뒤 '보유 수량 반영'으로 전환하면 전체 리밸런싱 기준으로 계산합니다.",
      }
    : {
        to: "cash_new_buy",
        text: "기존 보유가 0 으로 확인된 계좌입니다. '현금 기반 신규 매수'로 전환할 수 있습니다.",
      };
}

/** ISO/날짜 → "10/12 15:04" 같은 짧은 표기. 모르면 "기준시각 미상". */
export function formatAsOf(asOf: string | null): string {
  if (!asOf) return "기준시각 미상";
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return `${asOf.slice(5).replace("-", "/")} 종가`;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return "기준시각 미상";
  // KST 로 표기한다(서버 시각은 UTC).
  const kst = new Date(t + 9 * 3_600_000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}
