// ─────────────────────────────────────────────────────────────────────────────
// ETF 매수 주문안 계산 — 순수 모듈 (계산·미리보기 전용)
//
// 목표 비중으로 ETF 별 **매수 수량**을 계산한다. 주문을 만들거나 보내지 않는다 —
// 이 모듈의 출력은 "이렇게 사면 된다"는 **미리보기**이고, 실제 API 주문·원장 기록은 이
// 단계에 없다(005 원칙 1: 계획/주장은 체결이 아니다).
//
// ── 기존 리밸런싱 계산과 같은 식을 쓴다 (AccountPage.tsx effectiveRows) ──────
//
//   기준금액 = ETF 평가액 + 실제 예수금
//   목표금액 = 기준금액 × 비중
//   수량     = floor(금액 / 현재가)          — 목표를 넘겨 사지 않는다
//
// 거기에 이 모듈이 **더하는 것**은 세 가지뿐이다:
//   · 예산 상한 — 사려는 금액이 쓸 수 있는 돈을 넘지 않는다(정수 수량, 초과 방지)
//   · 현금 여유분 — 호가 변동·수수료 대비로 일부를 남긴다
//   · 출처 — 가격·예수금·보유수량·매수가능금액이 어디서 왔고 언제 기준인지 같이 낸다
//
// ── 원칙 ───────────────────────────────────────────────────────────────────
//
//   1. **매도 안 한다.** 비중을 넘은 종목은 그대로 두고 부족한 종목만 산다
//   2. **모르는 값을 0 으로 채우지 않는다.** 예수금·보유수량·시세를 모르면 그 계산을
//      하지 않고 사유를 낸다. **입력/조회하지 않은 보유수량은 0 주가 아니다**
//   3. **매수가능금액이 확인되지 않으면 "예상"이다.** 예수금을 상한으로 쓰되 확정 주문안
//      이 아니라고 표시한다
//   4. **조회값은 검증된 것만 쓴다.** API 모드는 `ready` 인 조회 결과만 쓰고, 아니면
//      계산하지 않는다. 계산만 제공 모드는 사용자가 입력한 값을 쓴다
//   5. **계좌 식별이 미검증이면 경고한다.** 22/29 동일 종합계좌번호 가정은 검증되지 않았다
//   6. **평가가 불완전하면 "참고용"이다.** 평가에서 빠진 보유가 있으면 계좌 전체 목표 비중을
//      정확히 계산할 수 없다. 그것을 "덜 사니까 안전하다"고 말하지 않는다
//   7. **현금 기반 신규 매수는 별도 추가매수다.** 기존 보유가 있으면 전체 리밸런싱이
//      아니라고 표시하고 보유 반영 전략으로의 전환을 안내한다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import {
  KIS_ACCOUNT_IDENTITY,
  type BuyPlanInputs,
} from "./kis-account-observe";

// ── 입력 ────────────────────────────────────────────────────────────────────

export type PriceSource = "kis" | "naver" | "history" | "manual" | "unavailable";

export interface PriceQuote {
  /** 모르면 null (0 이 아니다) */
  price: number | null;
  source: PriceSource;
  /** 그 가격의 기준 시각/날짜 (ISO 또는 YYYY-MM-DD). 모르면 null */
  asOf: string | null;
}

export interface PlanRow {
  rowId: string;
  label: string;
  etfName: string;
  /** 종목코드. 없으면(현금성 행 등) 살 수 없다 */
  ticker: string | null;
  allocPct: number;
  orphaned: boolean;
}

export type BalanceInput =
  /** 계산만 제공(기타 증권사 포함): 사용자가 입력한 값 */
  | {
      kind: "manual";
      /**
       * rowId → 수량. **키가 없는 행은 입력하지 않은 것이다**(0 주가 아니다). 0 주라면
       * 0 을 입력한 것이다.
       */
      quantities: Record<string, number>;
      /** 예수금. 입력한 적이 없으면 null — 0 이 아니다 */
      cash: number | null;
      cashAsOf?: string | null;
    }
  /** API 모드: 서버가 돌려준 조회 결과(`BuyPlanInputs`) */
  | {
      kind: "kis_api";
      plan: BuyPlanInputs;
      /** 조회 시각 */
      observedAt: string;
      /** 확인된 매수가능금액. 없으면 예수금을 상한으로 쓰는 "예상"이다 */
      buyingPower?: { amount: number; asOf: string } | null;
    };

export type Strategy =
  /** 예수금을 비중대로 나눠 **새로 산다**. 이미 가진 수량은 목표 계산에 넣지 않는다 */
  | "cash_new_buy"
  /** 가진 수량을 반영해 부족분만 산다 (기존 리밸런싱과 같은 기준금액) */
  | "with_holdings";

export interface PlanOptions {
  accountType: AccountId;
  /** 없으면 연금저축=cash_new_buy, 그 외=with_holdings */
  strategy?: Strategy;
  /** 현금 여유 비율 (기본 0.5%) */
  reserveRate?: number;
  /** 최소 여유금 (기본 1,000원) */
  minReserve?: number;
  /** 시세가 이보다 오래되면 경고 (기본 30분) */
  staleAfterMinutes?: number;
  /** 지금 시각(ISO). 테스트 주입용 */
  now?: string;
}

export const DEFAULT_RESERVE_RATE = 0.005;
export const DEFAULT_MIN_RESERVE = 1_000;
export const DEFAULT_STALE_MINUTES = 30;

/**
 * 계좌 종류별 기본 전략. 연금저축은 현금 기반 신규 매수, IRP 는 보유 수량을 반영한다.
 *
 * 이 기본값은 **기존 보유가 없는 연금저축**에 맞다. 기존 보유가 있거나 확인되지 않았으면
 * 결과의 `recommendedStrategy` 와 경고가 그 사실을 알려준다(전략을 자동으로 바꾸지는 않는다).
 */
export function defaultStrategy(accountType: AccountId): Strategy {
  return accountType === "pension" ? "cash_new_buy" : "with_holdings";
}

// ── 출력 ────────────────────────────────────────────────────────────────────

export type LineNote =
  | "non_tradable"
  | "price_missing"
  /** 보유수량을 입력/조회하지 않았다 — 0 주로 가정하지 않고 이 종목은 사지 않는다 */
  | "holdings_not_entered"
  | "already_at_target"
  | "overweight_no_sell"
  | "below_one_share"
  | "budget_limited";

export interface BuyOrderLine {
  rowId: string;
  label: string;
  etfName: string;
  ticker: string | null;
  targetWeightPct: number;
  price: PriceQuote;
  /** 지금 보유 수량. 입력/조회하지 않았으면 null (0 이 아니다) */
  currentQty: number | null;
  /** 목표 수량(정수). 시세가 없으면 null */
  targetQty: number | null;
  /** 이번에 살 수량(정수, ≥ 0) */
  buyQty: number;
  /** buyQty × 현재가. 시세가 없으면 0 */
  estimatedAmount: number;
  note: LineNote | null;
}

export type WarningLevel = "info" | "caution" | "critical";

export interface PlanWarning {
  code:
    | "estimate_only"
    | "account_identity_unverified"
    | "price_missing"
    | "price_stale"
    | "price_not_live"
    | "unmapped_holdings"
    | "weights_not_100"
    | "holdings_unknown_for_target"
    | "holdings_valuation_incomplete"
    /** 현금 기반 신규 매수인데 기존 보유가 있다 — 전체 리밸런싱이 아니라 별도 추가매수다 */
    | "new_buy_ignores_holdings"
    /** 현금 기반 신규 매수인데 기존 보유를 확인하지 못했다 */
    | "new_buy_holdings_unconfirmed"
    | "holdings_not_entered"
    /** 평가금액이 불완전해 계좌 전체 목표 비중을 정확히 계산할 수 없다 */
    | "valuation_incomplete";
  level: WarningLevel;
  message: string;
}

export interface PlanBlocker {
  code:
    | "cash_unknown"
    | "api_not_ready"
    | "no_tradable_rows"
    | "weights_invalid";
  message: string;
}

export type BudgetBasis = "buying_power" | "cash_upper_bound" | "manual_cash";

/**
 * 기존 보유에 대해 **무엇을 알고 있는가**.
 *   confirmed_zero  매수 대상 종목 전부가 0 주로 확인됐다(0 을 입력했거나 조회로 확인)
 *   has_holdings    보유가 있다
 *   not_confirmed   일부 또는 전부를 입력/조회하지 않았다 — **0 이라고 가정하지 않는다**
 */
export type HoldingsBasis = "confirmed_zero" | "has_holdings" | "not_confirmed";

/**
 * 이 안이 무엇인가.
 *   rebalance_buys       보유를 반영해 부족분을 사는 안(기존 리밸런싱의 매수 쪽)
 *   additional_purchase  현금으로 비중대로 **새로 사는 별도 추가매수** — 보유는 목표에 넣지
 *                        않는다. 기존 보유가 있으면 이것은 전체 리밸런싱이 아니다
 */
export type PlanScope = "rebalance_buys" | "additional_purchase";

export interface BuyOrderPlan {
  /** blocked 이면 lines 는 비어 있고 계산하지 않았다 */
  status: "ready" | "blocked";
  mode: "manual" | "kis_api";
  accountType: AccountId;
  strategy: Strategy;
  /** estimate_only: 매수가능금액 미확인 — 확정 주문안이 아니다 */
  orderability: "estimate_only" | "budget_verified";
  scope: PlanScope;
  /** 기존 보유에 대해 아는 것. cash_new_buy 의 적합성 판단 근거다 */
  holdingsBasis: HoldingsBasis;
  /**
   * 평가가 완전한가. **reference_only 는 "덜 사니 안전하다"가 아니다** — 평가에서 빠진 보유가
   * 있으면 계좌 전체 목표 비중을 정확히 계산할 수 없고, 어느 종목은 의도보다 많거나
   * 적게 담길 수 있다. 참고용으로만 본다.
   */
  reliability: "complete" | "reference_only";
  incompleteReasons: string[];
  /** 이 계좌 상태에 맞는 전략. 지금 전략과 다르면 화면이 전환을 안내한다 */
  recommendedStrategy: Strategy;
  blockers: PlanBlocker[];
  warnings: PlanWarning[];
  lines: BuyOrderLine[];
  budget: {
    basis: BudgetBasis;
    /** 예산의 원천 금액(매수가능금액 또는 예수금) */
    amount: number;
    reserve: number;
    spendable: number;
  } | null;
  totals: {
    /** 목표금액 계산의 기준금액 */
    planningBase: number;
    totalBuyAmount: number;
    /** 예수금 − 매수 합계. 여유분이 포함된다 */
    remainingCash: number;
    /** 시세가 없어 평가하지 못한 보유 종목 수 */
    unpricedHoldings: number;
  } | null;
  sources: {
    prices: Array<{ ticker: string; source: PriceSource; asOf: string | null }>;
    cash: { source: "manual_input" | "kis_api"; asOf: string | null };
    holdings: { source: "manual_input" | "kis_api"; asOf: string | null };
    buyingPower: { source: "kis_api" | null; asOf: string | null; verified: boolean };
  };
  /** 가진 종목 중 이 투자성향의 행에 없는 것 (ticker → 수량) */
  unmappedHoldings: Record<string, number>;
}

// ── 계산 ────────────────────────────────────────────────────────────────────

const isPosPrice = (p: number | null): p is number =>
  typeof p === "number" && Number.isFinite(p) && p > 0;

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

function minutesBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60_000;
}

/** 안전 상한 — 입력이 이상해도 무한 루프를 돌지 않는다. */
const MAX_ITERATIONS = 1_000_000;

export function buildBuyOrderPlan(
  rows: readonly PlanRow[],
  quotes: Readonly<Record<string, PriceQuote>>,
  balance: BalanceInput,
  options: PlanOptions,
): BuyOrderPlan {
  const strategy = options.strategy ?? defaultStrategy(options.accountType);
  const reserveRate = options.reserveRate ?? DEFAULT_RESERVE_RATE;
  const minReserve = options.minReserve ?? DEFAULT_MIN_RESERVE;
  const staleMin = options.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
  const now = options.now ?? new Date().toISOString();

  const warnings: PlanWarning[] = [];
  const blockers: PlanBlocker[] = [];
  const incomplete: string[] = [];

  const mode = balance.kind === "kis_api" ? "kis_api" : "manual";
  const scope: PlanScope = strategy === "cash_new_buy" ? "additional_purchase" : "rebalance_buys";
  const sources: BuyOrderPlan["sources"] = {
    prices: [],
    cash: {
      source: balance.kind === "kis_api" ? "kis_api" : "manual_input",
      asOf: balance.kind === "kis_api" ? balance.observedAt : (balance.cashAsOf ?? null),
    },
    holdings: {
      source: balance.kind === "kis_api" ? "kis_api" : "manual_input",
      asOf: balance.kind === "kis_api" ? balance.observedAt : null,
    },
    buyingPower: { source: null, asOf: null, verified: false },
  };

  const blocked = (): BuyOrderPlan => ({
    status: "blocked", mode, accountType: options.accountType, strategy,
    orderability: "estimate_only",
    scope, holdingsBasis: "not_confirmed", reliability: "reference_only", incompleteReasons: [],
    recommendedStrategy: strategy,
    blockers, warnings, lines: [], budget: null, totals: null, sources, unmappedHoldings: {},
  });

  // ── 1) 보유수량·예수금 확정 ──────────────────────────────────────────────
  // qtyByRow: 수량(≥0) / null = 입력·조회하지 않았다(0 이 아니다)
  let cash: number | null;
  const qtyByRow: Record<string, number | null> = {};
  let unmapped: Record<string, number> = {};
  let buyingPower: { amount: number; asOf: string } | null = null;

  if (balance.kind === "manual") {
    cash = balance.cash === null ? null : nonNeg(balance.cash);
    // **입력하지 않은 행은 0 주가 아니라 "모름"이다.** 0 주를 입력했으면 0 이다.
    for (const r of rows) {
      qtyByRow[r.rowId] = Object.prototype.hasOwnProperty.call(balance.quantities, r.rowId)
        ? nonNeg(balance.quantities[r.rowId])
        : null;
    }
  } else {
    const p = balance.plan;
    // **검증된 조회값만 쓴다.** 준비되지 않았으면 계산하지 않는다.
    if (!p.ready) {
      for (const b of p.blockers) blockers.push({ code: "api_not_ready", message: b.message });
      if (!p.blockers.length) {
        blockers.push({ code: "api_not_ready", message: "조회 결과가 준비되지 않았습니다." });
      }
      return blocked();
    }
    cash = p.cash;
    const held = p.holdings ?? {};
    const tickers = new Set<string>();
    for (const r of rows) {
      if (r.ticker) {
        // 조회가 준비됨(ready)이면 목록 전체가 관측된 것이라 부재 = 0 주다.
        qtyByRow[r.rowId] = nonNeg(held[r.ticker] ?? 0);
        tickers.add(r.ticker);
      } else {
        qtyByRow[r.rowId] = null; // 종목코드가 없으면 보유수량을 대응시킬 수 없다
      }
    }
    unmapped = Object.fromEntries(
      Object.entries(held).filter(([t, q]) => !tickers.has(t) && q > 0),
    );
    if (balance.buyingPower && Number.isFinite(balance.buyingPower.amount)) {
      buyingPower = balance.buyingPower;
      sources.buyingPower = { source: "kis_api", asOf: balance.buyingPower.asOf, verified: true };
    }
    // 22/29 동일 종합계좌번호 가정은 미검증이다 — 주문 계좌의 식별 근거로 쓰지 않는다.
    warnings.push({
      code: "account_identity_unverified",
      level: "caution",
      message:
        `${KIS_ACCOUNT_IDENTITY.note} 이 주문안은 참고용 미리보기이며 계좌 식별이 확인되기 ` +
        "전에는 주문에 사용할 수 없습니다.",
    });
  }

  if (cash === null) {
    blockers.push({
      code: "cash_unknown",
      message: "예수금을 모릅니다. 예수금을 입력하거나 조회한 뒤에 계산할 수 있습니다 (0원으로 가정하지 않습니다).",
    });
    return blocked();
  }

  // ── 2) 비중 검증 ─────────────────────────────────────────────────────────
  const tradable = rows.filter((r) => r.ticker && r.allocPct > 0 && !r.orphaned);
  const weightSum = rows.reduce((s, r) => s + (r.orphaned ? 0 : nonNeg(r.allocPct)), 0);
  if (!tradable.length) {
    blockers.push({
      code: "no_tradable_rows",
      message: "종목코드가 있고 비중이 0 보다 큰 행이 없어 매수안을 만들 수 없습니다.",
    });
    return blocked();
  }
  if (weightSum > 100.0001) {
    blockers.push({
      code: "weights_invalid",
      message: `목표 비중의 합이 ${weightSum.toFixed(1)}% 로 100% 를 넘어 계산하지 않습니다.`,
    });
    return blocked();
  }
  if (Math.abs(weightSum - 100) > 0.0001) {
    warnings.push({
      code: "weights_not_100",
      level: "info",
      message: `목표 비중의 합이 ${weightSum.toFixed(1)}% 입니다. 남는 비중은 현금으로 둡니다.`,
    });
  }

  // ── 3) 기존 보유에 대해 아는 것 ──────────────────────────────────────────
  const tradableQty = tradable.map((r) => qtyByRow[r.rowId] ?? null);
  const notEnteredRows = tradable.filter((r) => (qtyByRow[r.rowId] ?? null) === null);
  const anyKnownHeld = tradableQty.some((x) => x !== null && x > 0);
  const holdingsBasis: HoldingsBasis =
    notEnteredRows.length > 0 ? "not_confirmed"
      : anyKnownHeld ? "has_holdings"
      : "confirmed_zero";

  // 보유 반영 전략에서 수량을 모르는 행은 **사지 않는다**(0 주로 가정하면 이미 가진 종목을
  // 또 사게 된다).
  if (strategy === "with_holdings" && notEnteredRows.length > 0) {
    warnings.push({
      code: "holdings_not_entered",
      level: "critical",
      message:
        "보유수량을 입력하지 않은 종목은 0 주로 가정하지 않고 매수안에서 제외합니다: " +
        notEnteredRows.map((r) => r.etfName).join(", ") +
        ". 실제로 0 주라면 0 을 입력하세요.",
    });
    incomplete.push("보유수량을 입력하지 않은 종목이 있습니다");
  }

  // ── 4) 시세 ──────────────────────────────────────────────────────────────
  const quoteOf = (r: PlanRow): PriceQuote =>
    (r.ticker ? quotes[r.ticker] : undefined) ?? { price: null, source: "unavailable", asOf: null };

  const missing: string[] = [];
  const stale: string[] = [];
  const notLive = new Set<PriceSource>();
  for (const r of rows) {
    if (!r.ticker) continue;
    const q = quoteOf(r);
    sources.prices.push({ ticker: r.ticker, source: q.source, asOf: q.asOf });
    if (!isPosPrice(q.price)) {
      missing.push(r.etfName);
      continue;
    }
    if (q.source !== "kis") notLive.add(q.source);
    if (q.asOf && /T/.test(q.asOf)) {
      const age = minutesBetween(q.asOf, now);
      if (age !== null && age > staleMin) stale.push(r.etfName);
    }
  }
  if (missing.length) {
    warnings.push({
      code: "price_missing",
      level: "critical",
      message: `시세를 받지 못한 종목은 매수안에서 제외합니다: ${missing.join(", ")}`,
    });
    // 목표 비중을 채울 수 없는 종목이 있다 = 계좌 전체가 목표 비중이 되지 않는다.
    if (tradable.some((r) => missing.includes(r.etfName))) {
      incomplete.push("시세를 받지 못해 계산하지 못한 매수 대상 종목이 있습니다");
    }
  }
  if (stale.length) {
    warnings.push({
      code: "price_stale",
      level: "caution",
      message: `시세 기준 시각이 ${staleMin}분보다 오래됐습니다: ${stale.join(", ")}`,
    });
  }
  if (notLive.size) {
    warnings.push({
      code: "price_not_live",
      level: "caution",
      message:
        "실시간(KIS) 시세가 아닌 값이 섞여 있습니다 (" +
        [...notLive].join(", ") + "). 주문 직전 현재가와 다를 수 있습니다.",
    });
  }

  // ── 5) 보유 평가·기준금액 ────────────────────────────────────────────────
  let heldValue = 0;
  let unpriced = 0;
  for (const r of rows) {
    const q = qtyByRow[r.rowId];
    if (q === null || q === undefined || q <= 0) continue;
    const price = quoteOf(r).price;
    if (isPosPrice(price)) heldValue += q * price;
    else unpriced += 1;
  }
  if (unpriced > 0) {
    warnings.push({
      code: "holdings_valuation_incomplete",
      level: "caution",
      message:
        `보유 중이지만 시세가 없어 평가하지 못한 종목이 ${unpriced}개 있습니다. 계좌 전체 ` +
        "평가금액과 목표 비중을 정확히 계산할 수 없습니다.",
    });
    incomplete.push(`시세가 없어 평가하지 못한 보유 종목이 ${unpriced}개 있습니다`);
  }
  const unmappedCount = Object.keys(unmapped).length;
  if (unmappedCount > 0) {
    warnings.push({
      code: "unmapped_holdings",
      level: "caution",
      message:
        "투자성향에 없는 보유 종목이 있어 이 계산에 넣지 못했습니다: " +
        Object.entries(unmapped).map(([t, q]) => `${t} ${q}주`).join(", ") +
        ". 계좌 전체 목표 비중을 정확히 계산할 수 없습니다.",
    });
    incomplete.push(`투자성향에 없는 보유 종목이 ${unmappedCount}개 있습니다`);
  }

  // ── 6) 예산 ──────────────────────────────────────────────────────────────
  // 매수가능금액이 확인됐으면 그 값과 예수금 중 작은 쪽, 아니면 예수금(상한 추정).
  const budgetAmount = buyingPower ? Math.min(cash, nonNeg(buyingPower.amount)) : cash;
  const basis: BudgetBasis = buyingPower
    ? "buying_power"
    : balance.kind === "kis_api" ? "cash_upper_bound" : "manual_cash";
  const reserve = Math.min(
    budgetAmount,
    Math.max(minReserve, Math.floor(budgetAmount * reserveRate)),
  );
  const spendable = Math.max(0, Math.floor(budgetAmount - reserve));

  const verified = buyingPower !== null;
  if (!verified) {
    warnings.push({
      code: "estimate_only",
      level: "caution",
      message:
        "매수가능금액을 확인하지 못해 예수금을 상한으로 계산한 **예상 주문안**입니다. " +
        "실제 주문 가능 금액과 다를 수 있습니다.",
    });
  }

  // ── 7) 현금 기반 신규 매수의 적합성 ──────────────────────────────────────
  // 이 전략은 보유를 목표에 넣지 않는다. 기존 보유가 있으면 전체 리밸런싱이 아니라
  // **별도 추가매수**이고, 보유를 확인하지 못했으면 0 이라고 가정하지 않았음을 말한다.
  if (strategy === "cash_new_buy") {
    if (holdingsBasis === "has_holdings") {
      const heldNames = tradable
        .filter((r) => (qtyByRow[r.rowId] ?? 0) > 0)
        .map((r) => `${r.etfName} ${qtyByRow[r.rowId]}주`);
      warnings.push({
        code: "new_buy_ignores_holdings",
        level: "caution",
        message:
          `기존 보유가 있습니다 (${heldNames.join(", ")}). 이 안은 보유를 반영한 전체 리밸런싱이 ` +
          "아니라, 현금을 비중대로 새로 사는 **별도 추가매수 안**입니다. 보유를 반영하려면 " +
          "'보유 수량 반영'으로 전환하세요.",
      });
    } else if (holdingsBasis === "not_confirmed") {
      warnings.push({
        code: "new_buy_holdings_unconfirmed",
        level: "caution",
        message:
          "기존 보유를 확인하지 못했습니다 (0 주라고 가정하지 않았습니다). 이미 보유 중인 종목이 " +
          "있으면 이 안은 별도 추가매수가 됩니다. 보유 수량을 입력한 뒤 '보유 수량 반영'으로 " +
          "전환하면 전체 리밸런싱 기준으로 계산합니다.",
      });
    }
    // 평가에서 빠진 보유가 있으면 계좌 전체 비중은 어차피 알 수 없다.
    if (holdingsBasis !== "confirmed_zero") {
      incomplete.push(
        holdingsBasis === "has_holdings"
          ? "기존 보유를 목표에 반영하지 않은 별도 추가매수 안입니다"
          : "기존 보유를 확인하지 못했습니다",
      );
    }
  }

  // ── 8) 목표금액 ──────────────────────────────────────────────────────────
  // with_holdings: 기존 리밸런싱과 같다 — 기준금액 = 보유 평가 + 예수금.
  // cash_new_buy:  쓸 수 있는 돈만 비중대로 나눈다. 기존 보유는 목표에 넣지 않는다.
  const planningBase = strategy === "with_holdings" ? heldValue + cash : spendable;

  if (
    strategy === "with_holdings" && balance.kind === "kis_api" &&
    rows.some((r) => !r.ticker && !r.orphaned && r.allocPct > 0)
  ) {
    warnings.push({
      code: "holdings_unknown_for_target",
      level: "info",
      message: "종목코드가 없는 행(현금성 등)은 매수 대상이 아니라 현금으로 남습니다.",
    });
  }

  interface Work {
    row: PlanRow;
    quote: PriceQuote;
    price: number | null;
    held: number; // 목표 계산에 넣는 보유 평가액
    target: number;
    bought: number;
    qty: number | null;
    canBuy: boolean;
    notEntered: boolean;
  }
  const work: Work[] = rows.map((r) => {
    const quote = quoteOf(r);
    const price = isPosPrice(quote.price) ? quote.price : null;
    const qty = qtyByRow[r.rowId] ?? null;
    const held = strategy === "with_holdings" && price !== null && qty !== null ? qty * price : 0;
    const target = r.ticker && !r.orphaned ? (planningBase * nonNeg(r.allocPct)) / 100 : 0;
    const notEntered = strategy === "with_holdings" && Boolean(r.ticker) && !r.orphaned && qty === null;
    return {
      row: r, quote, price, held, target, bought: 0, qty, notEntered,
      canBuy: Boolean(r.ticker) && !r.orphaned && price !== null && r.allocPct > 0 && !notEntered,
    };
  });

  // ── 9) 정수 수량 배분 (예산 초과 불가, 목표 초과 불가) ───────────────────
  // 남은 부족분이 가장 큰 종목부터 1주씩 산다. 부족분이 한 주 가격보다 작으면 사지 않는다
  // (floor 와 같은 규칙 — 목표를 넘기지 않는다). 예산이 넉넉하면 floor 결과와 같다.
  let remaining = spendable;
  for (let it = 0; it < MAX_ITERATIONS; it += 1) {
    let best: Work | null = null;
    let bestDeficit = 0;
    for (const w of work) {
      if (!w.canBuy || w.price === null) continue;
      if (w.price > remaining) continue;
      const deficit = w.target - (w.held + w.bought * w.price);
      if (deficit + 1e-9 < w.price) continue; // 한 주를 사면 목표를 넘긴다
      if (deficit > bestDeficit) {
        best = w;
        bestDeficit = deficit;
      }
    }
    if (!best || best.price === null) break;
    best.bought += 1;
    remaining -= best.price;
  }

  // ── 10) 줄 구성 ──────────────────────────────────────────────────────────
  const lines: BuyOrderLine[] = work.map((w) => {
    const { row, quote } = w;
    const price = w.price;
    const buyQty = w.bought;
    const estimatedAmount = price === null ? 0 : buyQty * price;

    let targetQty: number | null = null;
    if (price !== null && row.ticker && !row.orphaned) {
      targetQty = Math.floor(w.target / price + 1e-9);
    }

    let note: LineNote | null = null;
    if (!row.ticker || row.orphaned) note = "non_tradable";
    else if (w.notEntered) note = "holdings_not_entered";
    else if (price === null) note = "price_missing";
    else if (row.allocPct <= 0) note = "non_tradable";
    else if (buyQty === 0) {
      const deficit = w.target - w.held;
      if (strategy === "with_holdings" && deficit < 0) note = "overweight_no_sell";
      else if (deficit < price) note = deficit <= 0 ? "already_at_target" : "below_one_share";
      else note = "budget_limited";
    } else {
      const wantQty = Math.floor((w.target - w.held) / price + 1e-9);
      if (buyQty < wantQty) note = "budget_limited";
    }

    return {
      rowId: row.rowId,
      label: row.label,
      etfName: row.etfName,
      ticker: row.ticker,
      targetWeightPct: row.allocPct,
      price: quote,
      currentQty: w.qty,
      targetQty,
      buyQty,
      estimatedAmount,
      note,
    };
  });

  const totalBuyAmount = lines.reduce((s, l) => s + l.estimatedAmount, 0);

  // ── 11) 신뢰도 ───────────────────────────────────────────────────────────
  const reliability: BuyOrderPlan["reliability"] = incomplete.length ? "reference_only" : "complete";
  if (incomplete.length) {
    warnings.push({
      code: "valuation_incomplete",
      level: "critical",
      message:
        "평가가 불완전해 계좌 전체의 목표 비중을 정확히 계산할 수 없습니다 — 이 주문안은 " +
        "**참고용**입니다. 평가에서 빠진 보유는 '덜 사니 안전하다'는 뜻이 아니며, 일부 종목은 " +
        "의도보다 많거나 적게 담길 수 있습니다. (" + incomplete.join(" / ") + ")",
    });
  }

  // 지금 상태에 맞는 전략: 기존 보유가 있거나 확인되지 않았으면 보유 반영이 맞다.
  // 보유 반영은 입력이 없는 행을 사지 않으므로, 확인된 0(또는 연금저축 첫 매수)일 때만
  // 현금 기반 신규 매수를 권한다.
  const recommendedStrategy: Strategy =
    holdingsBasis === "confirmed_zero" && options.accountType === "pension"
      ? "cash_new_buy"
      : holdingsBasis === "confirmed_zero" ? strategy : "with_holdings";

  return {
    status: "ready",
    mode,
    accountType: options.accountType,
    strategy,
    orderability: verified ? "budget_verified" : "estimate_only",
    scope,
    holdingsBasis,
    reliability,
    incompleteReasons: incomplete,
    recommendedStrategy,
    blockers,
    warnings,
    lines,
    budget: { basis, amount: budgetAmount, reserve, spendable },
    totals: {
      planningBase,
      totalBuyAmount,
      remainingCash: cash - totalBuyAmount,
      unpricedHoldings: unpriced,
    },
    sources,
    unmappedHoldings: unmapped,
  };
}
