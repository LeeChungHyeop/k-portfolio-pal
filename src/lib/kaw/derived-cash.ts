// ─────────────────────────────────────────────────────────────────────────────
// 유도 예수금 (derived cash) — 순수 모듈
//
// 과거 일별 실제 예수금 기록이 **없다.** 그런데 `cashBalance: 0` 으로 두면 수익 분석이
// 틀어진다 — 월 납입금이 입금일부터 다음 리밸런싱까지 현금으로 머물기 때문에, 0 으로
// 두면 **입금일에 가짜 손실, 리밸런싱일에 가짜 이익**이 생긴다(F 는 입금일에 귀속되는데
// 자산 증가는 리밸런싱일에 나타나므로).
//
// 그래서 원장(매수·매도)과 cashflow 장부(외부 입출금)로 예수금을 유도한다.
//
//   derivedCash(D) = Σ[외부 입출금 ≤ D] − Σ[매수금액 ≤ D] + Σ[매도금액 ≤ D]
//                    − Σ[**보고된** 수수료·세금 ≤ D]
//
// `fee`/`tax` 가 null 인 건은 **0 으로 채우지 않는다** — 없는 사실을 만들지 않는다.
// 부족분은 아래 residual 로 흡수되고 그 안에서 보고된다.
//
// ## 닫히지 않는다 — 미관측 현금수입이 있다 (실측)
//
// 실측 결손(일 단위):  retirement −1,658,004 @2026-08-28 / isa −187,723 /
// pension −58,116 / irp −19,392. 정체는 **대기자금 이자 + ETF 분배금**이다.
// retirement 의 첫 결손 −593,795 는 60M 대기자금이 5.5개월간 받은 이자와 자릿수가 맞고
// (60M × 5.5/12 × 약 2% ≈ 55만원), 이후 완만한 증가는 분배금 재투자로 설명된다.
//
// **이자와 분배금은 음수가 될 수 없다 → 미관측 수입은 단조 비감소다.** 이 성질만으로
// 양쪽 상한이 나온다.
//
// ## 보수 모델 — 비음수 예수금 경로
//
//   incomeLB(D) = max(0, −min{ derivedCash(s) : s ≤ D })
//   cash(D)     = derivedCash(D) + incomeLB(D)
//
// 성질:
//   1. 절대 음수가 되지 않는다 (불가능한 상태를 만들지 않는다)
//   2. 미관측 수입이 **꼭 필요해진 순간보다 먼저** 들어왔다고 가정하지 않는다
//   3. 결손이 없던 구간에서는 derivedCash 와 **정확히 같다**
//   4. 비음수 제약을 만족하는 모든 실제 경로 중 **점별 최소값** → 자산을 과대평가하지 않는다
//   5. 조정 파라미터가 **하나도 없다**
//
// 실증: retirement 2026-10-01 보수모델 2,534원 vs 실제 예수금 3,621원 — **차이 1,087원**
// (약 75M 계좌에서 0.0015%). 결손 톱니가 매달 0 을 때려 incomeLB 증분이 거의 완전히
// 강제되기 때문이다. 그리고 2025-09-25 입금일에는 모델 예수금이 **580,423원**(= 그 달
// 납입금)이 되고 다음 거래일 리밸런싱 후 **0원**이 된다 — 톱니를 정확히 재현한다.
//
// ## 손익에는 영향이 없다 (중요)
//
// 수익 분석의 손익은 `V_close − V_open − F` 이고, 전개하면 `C_open` 이 **소거된다**
// (`profit-analysis.ts` 의 ①②③ 분해 참고). 즉 예수금 수준에 상수 오차 ε 가 있어도
// **손익 금액은 변하지 않는다.** 영향을 받는 것은 분모(V_open)뿐이고, 그 폭이 R 이다.
//
// ## 외부흐름은 **유효일**에 들어온다
//
// `after_close` 입금(퇴직연금 25일 저녁)은 그 날 장중에 쓸 수 없다. 그래서 흐름마다
// **유효일**(same_day → 그 날 이상 첫 거래일 / after_close → 그 날보다 큰 첫 거래일)을
// 계산해 그 날짜에 현금이 생긴 것으로 본다. 수익률의 F 귀속도 **같은 유효일**을 쓰므로
// (`profit-analysis.ts`) 자산과 분자가 어긋나지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContributionTiming } from "./cashflow";

/** 외부 입출금 1건 (입금 +, 출금 −) */
export interface CashFlowInput {
  /** 실제 입출금일 YYYY-MM-DD */
  date: string;
  amount: number;
  timing?: ContributionTiming;
}

/** 내부 매매 1건 — 현금과 주식을 교환한다. 외부흐름이 **아니다**. */
export interface CashTradeInput {
  /** 실효 거래일 YYYY-MM-DD */
  date: string;
  side: "buy" | "sell";
  /** 증권사가 보고한 거래대금. quantity × price 로 재계산하지 않는다. */
  amount: number;
  /** 보고되지 않았으면 null — 0 으로 채우지 않는다 */
  fee: number | null;
  tax: number | null;
}

export interface DerivedCashInput {
  flows: readonly CashFlowInput[];
  trades: readonly CashTradeInput[];
  /** 가격이 존재하는 거래일(오름차순). 유효일 계산에 쓴다. */
  tradingDates: readonly string[];
}

export interface DerivedCashSeries {
  /** 이벤트가 있는 날짜(오름차순) */
  dates: readonly string[];
  /** 날짜 → 그 날 **종료 시점** 값 */
  byDate: ReadonlyMap<string, { derived: number; incomeLB: number; cash: number }>;
  /** 마지막 derivedCash */
  finalDerived: number;
  /** 가장 깊은 결손(≤ 0). 결손이 없었으면 0 */
  maxDeficit: number;
  /** 그 결손이 처음 생긴 날짜 */
  maxDeficitDate: string | null;
  /** 전 구간에서 강제되는 최소 누적 미관측 수입 = −maxDeficit */
  totalIncomeLB: number;
}

/**
 * `date` 이상인 첫 거래일 (`strict` 면 `date` 보다 큰 첫 거래일).
 * 거래일을 넘어가면 `null` — 아직 시장이 열리지 않은 흐름이다.
 */
export function effectiveTradingDate(
  tradingDates: readonly string[],
  date: string,
  strict = false,
): string | null {
  for (const d of tradingDates) {
    if (strict ? d > date : d >= date) return d;
  }
  return null;
}

/** 흐름의 유효일 — 돈을 실제로 쓸 수 있게 되는 거래일. */
export function flowEffectiveDate(
  tradingDates: readonly string[],
  flow: CashFlowInput,
): string | null {
  return effectiveTradingDate(
    tradingDates,
    flow.date,
    (flow.timing ?? "same_day") === "after_close",
  );
}

export function buildDerivedCash(input: DerivedCashInput): DerivedCashSeries {
  const perDay = new Map<string, number>();
  const add = (date: string, delta: number) => {
    if (!date || !Number.isFinite(delta)) return;
    perDay.set(date, (perDay.get(date) ?? 0) + delta);
  };

  for (const f of input.flows) {
    const e = flowEffectiveDate(input.tradingDates, f);
    // 아직 거래일이 오지 않은 흐름은 현금에 넣지 않는다 — F 쪽도 같은 규칙으로 빠진다.
    if (e) add(e, f.amount);
  }
  for (const t of input.trades) {
    const gross = t.side === "sell" ? t.amount : -t.amount;
    add(t.date, gross - (t.fee ?? 0) - (t.tax ?? 0));
  }

  const dates = [...perDay.keys()].sort();
  const byDate = new Map<string, { derived: number; incomeLB: number; cash: number }>();
  let derived = 0;
  let runningMin = 0;
  let maxDeficitDate: string | null = null;

  for (const d of dates) {
    derived += perDay.get(d) ?? 0;
    if (derived < runningMin) {
      runningMin = derived;
      maxDeficitDate = d;
    }
    const incomeLB = Math.max(0, -runningMin);
    byDate.set(d, { derived, incomeLB, cash: derived + incomeLB });
  }

  return {
    dates,
    byDate,
    finalDerived: derived,
    maxDeficit: runningMin,
    maxDeficitDate,
    totalIncomeLB: Math.max(0, -runningMin),
  };
}

/**
 * `date` **종료 시점**의 보수 모델 예수금. 그 날 이벤트가 없으면 가장 최근 값을 유지한다
 * (현금은 가만히 있으면 그대로다 — carry-forward 가 사실이다).
 */
export function cashAtClose(series: DerivedCashSeries, date: string): number {
  let out = 0;
  for (const d of series.dates) {
    if (d > date) break;
    out = series.byDate.get(d)?.cash ?? out;
  }
  return out;
}

/**
 * `date` **시작 시점**의 예수금 = 그 날 이벤트를 하나도 반영하지 않은 값
 * (= 직전 이벤트 날짜의 종료 값).
 *
 * 이 정의가 중요하다: 그 날의 매매와 입금이 모두 `cashAtClose − cashAtOpen` 에 들어가고,
 * 그래서 `V_close − V_open − F` 전개에서 내부 매매가 정확히 소거된다.
 * 당일 입금은 `V_open` 에 **들어가지 않는다** — daily 분모가 "장 시작 자산"이라는
 * 정의와 일치한다.
 */
export function cashAtOpen(series: DerivedCashSeries, date: string): number {
  let out = 0;
  for (const d of series.dates) {
    if (d >= date) break;
    out = series.byDate.get(d)?.cash ?? out;
  }
  return out;
}

/**
 * 미관측 수입의 **구간 하한** = incomeLB 증분. 상한은 `+R`(anchor 가 있을 때만) 이다.
 *   ΔincomeLB(P) ≤ L3(P) ≤ ΔincomeLB(P) + R
 */
export function incomeLowerBoundBetween(
  series: DerivedCashSeries,
  openDate: string,
  closeDate: string,
): number {
  const lbAt = (date: string, inclusive: boolean) => {
    let out = 0;
    for (const d of series.dates) {
      if (inclusive ? d > date : d >= date) break;
      out = series.byDate.get(d)?.incomeLB ?? out;
    }
    return out;
  };
  return Math.max(0, lbAt(closeDate, true) - lbAt(openDate, false));
}

/**
 * 미설명 수입의 상한 R = (독립 cash checkpoint) − 보수모델 예수금.
 *
 * **checkpoint 는 원장 cutoff 와 정렬돼 있어야 한다.** cutoff 이후 미적재 거래가 있으면
 * 현재 예수금에는 그 매매의 현금효과까지 섞여 있어서 R 이 "미관측 수입"을 뜻하지 않는다.
 * 그런 계좌는 `null` 을 돌려주고 화면은 **하한만** 쓴다.
 */
export function unexplainedIncomeCap(
  series: DerivedCashSeries,
  checkpoint: { date: string; cashBalance: number } | null,
): number | null {
  if (!checkpoint) return null;
  const model = cashAtClose(series, checkpoint.date);
  const r = checkpoint.cashBalance - model;
  return Number.isFinite(r) ? r : null;
}
