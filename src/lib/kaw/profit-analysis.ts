// ─────────────────────────────────────────────────────────────────────────────
// 수익 분석 (구 "기간 성과") — 순수 계산 엔진
//
// ## 기간 정의 — 각 period 를 **독립적으로** 계산한다
//
//   daily   : 그 거래일 **시가** → 같은 거래일 **종가**
//   monthly : 그 달 **첫 거래일 시가** → 그 달 **마지막 거래일 종가**
//   yearly  : 그 해 **첫 거래일 시가** → 그 해 **마지막(또는 최신) 거래일 종가**
//
// **monthly/yearly 를 daily 로 합성하지 않는다.** 포함하는 갭이 다르기 때문이다:
//
//   daily   은 하루 장중만 보므로 **모든 오버나이트 갭을 버린다**
//   monthly 는 첫 시가 → 말 종가라 **기간 내부 오버나이트 갭을 전부 포함한다**
//
// 그래서 `Π(1+일간) ≠ 월간` 이고 `Σ 월간 ≠ 연간` 이다. 버그가 아니라 정의의 결과다.
// 정확한 bridge 는 다음 **항등식**이고 테스트가 이것을 고정한다:
//
//   segmentProfit([O,C]) = Σ dailyProfit(d) + Σ gapProfit(d)        … (bridge)
//   gapProfit(d) = V_open(d) − V_close(이전 거래일)
//
// 흐름은 전부 거래일(유효일)에만 들어오므로 갭 구간에 외부흐름이 끼지 않는다.
//
// ## 손익 분해 — 체결시각이 필요 없다
//
// `V_close − V_open − F` 를 전개하면 `F` 와 `C_open` 이 **소거되고** 세 항만 남는다:
//
//   ① term1 = Σ H_open(t)·( P_close(t) − P_open(t) )     기존 보유분 장중 평가손익
//   ② term2 = Σ Δq(t)·P_close(t) + netCashDelta          당일 매매분 손익
//   ③ costs = 보고된 수수료·세금
//
//   profit = ① + ② − ③
//
// ②를 "체결단가"로 쓰지 않고 **증권사가 보고한 순현금이동(netCashDelta)** 으로 쓰는 것이
// 중요하다. 같은 날 같은 종목을 사고팔면 Δq 는 순증감인데 금액은 총액이라, 가중평균
// 단가로 쓰면 항등식이 깨진다. 보고 금액을 쓰면 **정의상 정확**하다.
//
// 성질:
//   · 체결시각을 쓰지 않는다 (①②③ 어디에도 없다)
//   · **예수금 수준의 상수 오차에 불변** — ε 가 C_open·C_close 에서 소거된다
//   · **당일 외부흐름의 시각에도 불변** — F 가 소거된다
//   · 내부 매매는 F 에 **한 번도** 더해지지 않는다. H 와 C 를 동시에 움직일 뿐이다
//
// anchor 구간은 체결가를 모르므로 **종가 체결로 가정**해 ② = 0 으로 둔다
// (`holdings-timeline.ts` 참고). 없는 매매 손익을 만들지 않고, 총자산이 리밸런싱을
// 가로질러 연속이다.
//
// ## 정확도를 손익과 분리해 보고한다
//
//   L1  known market/trading P&L   = ①+②−③       가격·체결로 **정확**
//   L2  known external cashflow    = F            장부가 source of truth, **정확**
//   L3  unobserved cash income     = 이자·분배금   **범위로만** (하한 확정, 상한은 anchor 있을 때)
//
// L1 을 total return 이라고 부르지 않는다. 수익률도 단일값이 아니라 **범위**로 낸다.
// 비례배분 같은 단일 추정값은 만들지 않는다.
//
// ## fail closed
//
// 그 날 양수 보유 종목 중 하나라도 시가 또는 종가가 없으면 그 계좌·그 날짜를 평가하지
// 않는다. 전체 scope 는 **그 날짜에 성과 구간에 들어온 계좌가 모두 평가된 날만** point 로
// 만든다 — 한 계좌가 빠진 날을 합산하면 자산이 급락한 것처럼 보인다.
// "아직 시작 안 한 계좌 = 0"과 "데이터가 빠진 계좌"는 **반드시 구분한다.**
// ─────────────────────────────────────────────────────────────────────────────

import type { PriceBarsByTicker } from "./useHistoricalPrices";
import type { EstimateReason, EstimatedDay } from "./estimate-provenance";
import type { AccountCoverage, CashQuality, SpanKind } from "./ledger-coverage";
import { worstCashQuality } from "./ledger-coverage";
import type { HoldingsDay, Holdings } from "./holdings-timeline";
import {
  cashAtClose,
  cashAtOpen,
  flowEffectiveDate,
  incomeLowerBoundBetween,
  type CashFlowInput,
  type DerivedCashSeries,
} from "./derived-cash";

export type PeriodId = "daily" | "monthly" | "yearly";

/** 가격 series 에 등장하는 모든 날짜(= 거래일). 오름차순. 휴장일을 만들어내지 않는다. */
export function tradingDatesOf(bars: PriceBarsByTicker): string[] {
  const dates = new Set<string>();
  for (const byDate of Object.values(bars ?? {})) {
    for (const [date, bar] of Object.entries(byDate ?? {})) {
      if (bar && bar.open > 0 && bar.close > 0) dates.add(date);
    }
  }
  return [...dates].sort();
}

/** 보유수량 평가. 가격이 없는 종목이 하나라도 있으면 `null`(partial 금지). */
export function valuate(
  holdings: Holdings,
  bars: PriceBarsByTicker,
  date: string,
  side: "open" | "close",
): { value: number; missing: string[] } | null {
  let value = 0;
  const missing: string[] = [];
  for (const [ticker, qty] of Object.entries(holdings)) {
    if (!(qty > 0)) continue;
    const bar = bars[ticker]?.[date];
    const p = bar ? bar[side] : undefined;
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
      missing.push(ticker);
      continue;
    }
    value += qty * p;
  }
  if (missing.length) return null;
  return { value, missing };
}

// ── 계좌별 예수금 series ────────────────────────────────────────────────────

export interface AccountCashInput {
  accountId: string;
  coverage: AccountCoverage;
  /**
   * 원장 구간의 보수 모델 예수금.
   *
   * **계좌 개시일부터 만들어야 한다.** `incomeLB` 가 "그 시점까지의 running min" 이라
   * 표시 구간만으로 만들면 그 앞의 결손이 빠져 값이 틀어진다(실측: retirement 를
   * 전략시작부터 만들면 모델 예수금이 21M 으로 나왔다 — 60.9M 입금이 구간 밖이라
   * 매수만 반영된 탓이다).
   */
  derived: DerivedCashSeries;
  flows: readonly CashFlowInput[];
  /** 가격이 존재하는 **전체** 거래일. 흐름 유효일 계산에 쓴다(표시 구간이 아니다) */
  tradingDates: readonly string[];
}

export interface CashSeries {
  open: ReadonlyMap<string, number>;
  close: ReadonlyMap<string, number>;
  quality: ReadonlyMap<string, CashQuality>;
}

/**
 * 거래일별 예수금.
 *
 *   date <= ledgerCutoff  → 보수 모델(원장+장부 유도). `derived`
 *   date >  ledgerCutoff  → **anchor 암시**: cash(D) = cash(D−1) + F(D) − Σ Δq·P_close(D)
 *                           (anchor 수량 변화를 종가 체결로 가정). `anchor-implied`
 *
 * cutoff 이후에 외부 입금이 들어왔는데 그 뒤로 anchor 가 아직 없으면, 그 돈이 현금으로
 * 그냥 있었다고 보는 것이므로 `cashflow-pending` 으로 표시한다 — 맞을 가능성이 높지만
 * **검증되지 않은 가정**이다. 음수가 되면 가정이 깨진 것이므로 `unknown` 이다.
 */
export function buildCashSeries(
  input: AccountCashInput,
  days: readonly HoldingsDay[],
  bars: PriceBarsByTicker,
): CashSeries {
  const open = new Map<string, number>();
  const close = new Map<string, number>();
  const quality = new Map<string, CashQuality>();
  const cutoff = input.coverage.ledgerCutoff;

  // 유효일별 외부흐름 (cutoff 이후 구간에서 직접 더하기 위해).
  // **표시 구간이 아니라 전체 거래일**로 유효일을 잡는다 — 표시 구간만 쓰면 그 앞의
  // 흐름이 첫 표시일로 끌려와 쌓인다.
  const flowByDate = new Map<string, number>();
  const tradingDates = input.tradingDates;
  for (const f of input.flows) {
    const e = flowEffectiveDate(tradingDates, f);
    if (e) flowByDate.set(e, (flowByDate.get(e) ?? 0) + f.amount);
  }
  const lastAnchorFlowDate = [...flowByDate.keys()].sort().pop() ?? null;

  let carry = 0;
  let sawAnchorRegion = false;
  for (const day of days) {
    if (cutoff && day.date <= cutoff) {
      const o = cashAtOpen(input.derived, day.date);
      const c = cashAtClose(input.derived, day.date);
      open.set(day.date, o);
      close.set(day.date, c);
      quality.set(day.date, "derived");
      carry = c;
      continue;
    }
    // anchor 구간
    sawAnchorRegion = true;
    const o = carry;
    const f = flowByDate.get(day.date) ?? 0;
    // anchor 수량 변화를 종가로 평가해 현금 소요를 유도한다
    let spend = 0;
    let priced = true;
    const tickers = new Set([...Object.keys(day.openHoldings), ...Object.keys(day.closeHoldings)]);
    for (const t of tickers) {
      const dq = (day.closeHoldings[t] ?? 0) - (day.openHoldings[t] ?? 0);
      if (dq === 0) continue;
      const p = bars[t]?.[day.date]?.close;
      if (typeof p !== "number" || !(p > 0)) {
        priced = false;
        break;
      }
      spend += dq * p;
    }
    const c = priced ? o + f - spend : Number.NaN;
    open.set(day.date, o);
    close.set(day.date, Number.isFinite(c) ? c : o);
    let q: CashQuality = priced ? "anchor-implied" : "unknown";
    if (priced && c < 0) q = "unknown";
    if (
      q === "anchor-implied" &&
      lastAnchorFlowDate &&
      cutoff &&
      lastAnchorFlowDate > cutoff &&
      day.date >= lastAnchorFlowDate &&
      !day.traded
    ) {
      q = "cashflow-pending";
    }
    quality.set(day.date, q);
    carry = Number.isFinite(c) ? c : o;
  }
  void sawAnchorRegion;
  return { open, close, quality };
}

// ── 계좌·날짜 평가 ──────────────────────────────────────────────────────────

export interface AccountDayValuation {
  date: string;
  accountId: string;
  vOpen: number;
  vClose: number;
  /** ① 기존 보유분 장중 평가손익 */
  term1: number;
  /** ② 당일 매매분 손익 */
  term2: number;
  /** ③ 보고된 수수료·세금 */
  costs: number;
  holdingsSource: HoldingsDay["source"];
  cashQuality: CashQuality;
  usable: boolean;
  missing: readonly string[];
}

export function valuateAccountDays(
  days: readonly HoldingsDay[],
  cash: CashSeries,
  bars: PriceBarsByTicker,
): AccountDayValuation[] {
  const out: AccountDayValuation[] = [];
  for (const day of days) {
    const mo = valuate(day.openHoldings, bars, day.date, "open");
    const mc = valuate(day.closeHoldings, bars, day.date, "close");
    const cashOpen = cash.open.get(day.date) ?? 0;
    const cashClose = cash.close.get(day.date) ?? 0;
    const cashQuality = cash.quality.get(day.date) ?? "unknown";

    if (!mo || !mc || day.unresolved.length) {
      const missing = [
        ...(mo ? [] : missingOf(day.openHoldings, bars, day.date, "open")),
        ...(mc ? [] : missingOf(day.closeHoldings, bars, day.date, "close")),
        ...day.unresolved,
      ];
      out.push({
        date: day.date,
        accountId: day.accountId,
        vOpen: 0,
        vClose: 0,
        term1: 0,
        term2: 0,
        costs: 0,
        holdingsSource: day.source,
        cashQuality,
        usable: false,
        missing: [...new Set(missing)],
      });
      continue;
    }

    // ① Σ H_open·(P_close − P_open)
    let term1 = 0;
    for (const [t, q] of Object.entries(day.openHoldings)) {
      if (!(q > 0)) continue;
      const bar = bars[t]?.[day.date];
      if (!bar) continue; // 위에서 이미 걸러졌다
      term1 += q * (bar.close - bar.open);
    }
    // ② Σ Δq·P_close + netCashDelta  (anchor 구간은 종가 체결 가정 → 0)
    let term2 = 0;
    if (day.netCashDelta !== null) {
      let dqClose = 0;
      const tickers = new Set([
        ...Object.keys(day.openHoldings),
        ...Object.keys(day.closeHoldings),
      ]);
      for (const t of tickers) {
        const dq = (day.closeHoldings[t] ?? 0) - (day.openHoldings[t] ?? 0);
        if (dq === 0) continue;
        const p = bars[t]?.[day.date]?.close;
        if (typeof p !== "number" || !(p > 0)) continue;
        dqClose += dq * p;
      }
      term2 = dqClose + day.netCashDelta;
    }

    out.push({
      date: day.date,
      accountId: day.accountId,
      vOpen: mo.value + cashOpen,
      vClose: mc.value + cashClose,
      term1,
      term2,
      costs: day.reportedCosts,
      holdingsSource: day.source,
      cashQuality,
      usable: true,
      missing: [],
    });
  }
  return out;
}

function missingOf(
  holdings: Holdings,
  bars: PriceBarsByTicker,
  date: string,
  side: "open" | "close",
): string[] {
  const out: string[] = [];
  for (const [t, q] of Object.entries(holdings)) {
    if (!(q > 0)) continue;
    const p = bars[t]?.[date]?.[side];
    if (typeof p !== "number" || !(p > 0)) out.push(t);
  }
  return out;
}

// ── scope 합산 ──────────────────────────────────────────────────────────────

export interface ScopeDay {
  date: string;
  vOpen: number;
  vClose: number;
  term1: number;
  term2: number;
  costs: number;
  holdingsSources: readonly HoldingsDay["source"][];
  cashQuality: CashQuality;
}

/**
 * scope 안 계좌를 날짜별로 합산한다.
 *
 * 그 날짜에 **성과 구간에 들어온** 계좌는 **모두 평가돼 있어야** point 를 만든다.
 * 아직 시작하지 않은 계좌는 자산 0 으로 더한다 — 그건 **사실**이고 결측이 아니다.
 */
export function aggregateScope(
  valuations: readonly AccountDayValuation[],
  coverages: readonly AccountCoverage[],
  scopeAccountIds: readonly string[],
): ScopeDay[] {
  const inScope = new Set(scopeAccountIds);
  const covById = new Map(coverages.map((c) => [c.accountId as string, c]));
  const byDate = new Map<string, AccountDayValuation[]>();
  for (const v of valuations) {
    if (!inScope.has(v.accountId)) continue;
    const list = byDate.get(v.date) ?? [];
    list.push(v);
    byDate.set(v.date, list);
  }

  const out: ScopeDay[] = [];
  for (const [date, list] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const required = scopeAccountIds.filter((id) => {
      const c = covById.get(id);
      return !!c?.performanceStart && date >= c.performanceStart;
    });
    const present = new Map(list.map((v) => [v.accountId, v]));
    let complete = true;
    for (const id of required) {
      const v = present.get(id);
      if (!v || !v.usable) {
        complete = false;
        break;
      }
    }
    if (!complete || !required.length) continue;

    let vOpen = 0,
      vClose = 0,
      term1 = 0,
      term2 = 0,
      costs = 0;
    const sources: HoldingsDay["source"][] = [];
    const qualities: CashQuality[] = [];
    for (const id of required) {
      const v = present.get(id)!;
      vOpen += v.vOpen;
      vClose += v.vClose;
      term1 += v.term1;
      term2 += v.term2;
      costs += v.costs;
      sources.push(v.holdingsSource);
      qualities.push(v.cashQuality);
    }
    out.push({
      date,
      vOpen,
      vClose,
      term1,
      term2,
      costs,
      holdingsSources: sources,
      cashQuality: worstCashQuality(qualities),
    });
  }
  return out;
}

// ── 구간 만들기 ─────────────────────────────────────────────────────────────

export interface Segment {
  key: string;
  label: string;
  /** 구간 시작 거래일 (이 날 **시가**) */
  openDate: string;
  /** 구간 끝 거래일 (이 날 **종가**) */
  closeDate: string;
  /** 이 구간 안의 usable 거래일 (오름차순) */
  dates: readonly string[];
}

const bucketKey = (date: string, period: PeriodId): string =>
  period === "daily" ? date : period === "monthly" ? date.slice(0, 7) : date.slice(0, 4);

function bucketLabel(key: string, period: PeriodId, open: string, close: string): string {
  if (period === "daily") return key.slice(5).replace("-", "/");
  if (period === "monthly") return key.replace("-", ".");
  // 연간은 실제 거래일 범위를 라벨에 같이 보여준다 — "1월 1일" 같은 가짜 날짜를 쓰지 않는다
  return `${key}년 (${open.slice(5).replace("-", "/")}~${close.slice(5).replace("-", "/")})`;
}

/**
 * usable 거래일 → period 구간. **달력이 아니라 실제 거래일**로 경계를 잡는다.
 * 거래일이 1일뿐인 구간은 daily 에서만 만든다 — 월·연은 시가→종가가 하루로 쪼그라들면
 * 그 기간을 대표하지 못한다.
 */
export function buildSegments(dates: readonly string[], period: PeriodId): Segment[] {
  const buckets = new Map<string, string[]>();
  for (const d of dates) {
    const k = bucketKey(d, period);
    const list = buckets.get(k) ?? [];
    list.push(d);
    buckets.set(k, list);
  }
  const out: Segment[] = [];
  for (const [key, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort();
    if (period !== "daily" && sorted.length < 2) continue;
    const openDate = sorted[0];
    const closeDate = sorted[sorted.length - 1];
    out.push({
      key,
      label: bucketLabel(key, period, openDate, closeDate),
      openDate,
      closeDate,
      dates: sorted,
    });
  }
  return out;
}

// ── 구간 손익 ───────────────────────────────────────────────────────────────

/** 부분 성과를 이루는 검증된 연속 구간(run) 하나 — 첫 거래일 시가 → 마지막 거래일 종가, 기존 `segmentProfit` 결과 */
export interface PartialRun {
  openDate: string;
  closeDate: string;
  /** 이 run 이 포함하는 거래일 수 */
  tradingDays: number;
  beginningTotal: number;
  endingTotal: number;
  netCashflow: number;
  knownProfit: number;
  averageCapital: number;
  returnPctLow: number | null;
  returnPctHigh: number | null;
  denominatorEstimated: boolean;
}

/**
 * 월간·연간 구간 전체는 미확정이지만 **확인 가능한 연속 구간만** 따로 모은 부분 성과.
 *
 * 구간 전체 결과(`PeriodResult`의 나머지 필드)를 **대체하지 않는다** — 전체가 미확정이면 그대로 미확정이고,
 * 이 필드는 그와 별개의 지표다.
 *
 * ## 산식
 *   · run 마다 기존 `segmentProfit`(첫 날 시가 → 마지막 날 종가, 구간 안 외부흐름·Modified Dietz 분모)
 *   · 수익률  = Π(1 + r_i) − 1   (run 별 수익률의 **연결수익률**)
 *   · 손익    = Σ P_i             (확인된 run 의 손익만)
 *
 * ## 읽는 법 (중요)
 *   연결수익률은 **제외된 기간의 수익률을 0% 로 확정한 것이 아니다.** 제외 기간을 계산에서 뺀 값이고,
 *   이 기간 전체를 대표하지 않는다. 제외 기간의 시작·종료 평가액을 직접 이은 값도 아니다.
 *   run 하나라도 수익률이 계산 불가(null)이면 부분 수익률도 null 이다 — 0% 를 대입하지 않는다.
 */
export interface PartialPerformance {
  runs: readonly PartialRun[];
  /** 부분 성과에 포함된 거래일 / 제외된 거래일 (오름차순) */
  includedDates: readonly string[];
  excludedDays: readonly { date: string; reasons: readonly EstimateReason[] }[];
  /**
   * 커버리지 분자·분모 — **가격이 확인돼 평가할 수 있었던** 거래일 기준이다 (전체 거래일 기준이 아니다).
   * 가격이 없어 평가하지 못한 날(`unpricedDays`)과 가격이 전혀 없는 날은 분모에 들어 있지 않다.
   * 전체 거래일을 정확히 판별할 근거가 없으므로 화면에서는 반드시 "가격 확인일 기준"이라고 쓴다.
   */
  measuredDays: number;
  totalDays: number;
  /**
   * 이 구간 안에서 평가 불가(가격 누락 등)라 거래일 목록에서 빠진 날짜. 분모에 없으므로 따로 알린다.
   * 평가 행이 있는 날만 알 수 있다 — 어떤 종목도 가격이 없는 날은 휴장일과 구별할 수 없어 여기에도 없다.
   */
  unpricedDays: readonly string[];
  /**
   * run 사이의 끊김 중 **제외된 거래일로 설명되지 않는** 곳의 수.
   * 가격이 없어 평가하지 못한 날 등에 추정이 숨어 있어 run 이 갈라진 경우다 — 커버리지 분모(평가 가능한 거래일)에
   * 들어 있지 않은 미확인 기간이 있다는 뜻이므로 그대로 알린다.
   */
  unmeasuredBreaks: number;
  knownProfit: number;
  returnPctLow: number | null;
  returnPctHigh: number | null;
  /** run 중 하나라도 수익률 분모가 추정에 기대면 true — 부분 수익률도 근사값이다 */
  denominatorEstimated: boolean;
  basis: "linked-modified-dietz";
}

export interface PeriodResult {
  key: string;
  label: string;
  openDate: string;
  closeDate: string;
  beginningTotal: number;
  endingTotal: number;
  /** L2 — 구간에 귀속되는 순외부흐름 */
  netCashflow: number;
  /**
   * 기간 손익 = `V_close − V_open − F`.
   *
   * **이미 L3 하한을 포함하고 있다.** 예수금이 `derivedCash + incomeLB` 라서
   * `V_close − V_open` 안에 그 구간의 `ΔincomeLB` 가 들어 있기 때문이다. 그래서
   * 수익률을 낼 때 `incomeLowerBound` 를 **다시 더하면 이중계산**이다(실제로 그랬다).
   * 보수 모델 기준의 **총수익 하한**이라고 읽으면 된다.
   */
  knownProfit: number;
  /**
   * 이 구간 손익 안에 들어 있는 **미관측 현금수입(이자·분배금)의 하한**.
   * `knownProfit` 의 부분집합이며 따로 더하는 값이 아니다 — 설명용이다.
   */
  incomeLowerBound: number;
  /**
   * 미관측 현금수입의 **상한** = 하한 + 아직 설명되지 않은 잔차 R.
   * cutoff 정렬 cash checkpoint 가 없는 계좌가 섞이면 `null`(상한 미정).
   */
  incomeUpperBound: number | null;
  /** 상한까지 갔을 때 손익에 **추가로** 더해질 수 있는 금액 (= R 합). 상한 미정이면 null */
  incomeHeadroom: number | null;
  /** 분모 (Modified Dietz) */
  averageCapital: number;
  /** 수익률 하한 % */
  returnPctLow: number | null;
  /** 수익률 상한 %. L3 상한이 없으면 null */
  returnPctHigh: number | null;
  holdingsSources: readonly HoldingsDay["source"][];
  cashQuality: CashQuality;
  span: SpanKind;
  /**
   * 모든 날이 ledger + derived 이고, **추정 거래가 하나도 없는가.**
   * 원장 source 가 ledger 라는 이유만으로 true 가 되지 않는다 — 가격 대용 추정 매도가
   * 구간 안에 있으면 false 다 (`estimated`).
   */
  exact: boolean;
  /**
   * 구간 안(시작일~끝일)에 추정 거래(사용자 승인 가격 대용 청산)가 있는가.
   * true 면 이 구간의 손익·수익률은 **확정값이 아니라 계산 참고값**이다. 숫자는 고치지 않는다.
   * 다른 날짜·다른 계좌의 구간은 영향받지 않는다.
   */
  estimated: boolean;
  /**
   * 추정 청산대금의 오차가 이 구간 손익에서 **상쇄된다고 입증됐고**, 수익률 분모(시작 총자산)에만 남는가.
   *
   * 입증 조건은 `cashErrorCancels` 에 있다(구간이 원장 cutoff 뒤이거나, 구간 안에서 파생 예수금이
   * 청산 이후 새 최저점을 만들지 않는다). 입증하지 못하면 이 값이 아니라 `estimated`
   * (`cash_error_not_cancelled`)가 켜지고 손익도 참고값이다. `estimated` 와 배타적이다.
   *
   * **손익이 "확정"이라는 뜻이 아니다.** 이 값은 추정 청산대금에 대한 판정일 뿐이고, 현금 품질
   * (`cashQuality`)·보유수량 출처(`holdingsSources`)·미관측 현금수입(L3)은 각자 독립으로 판정된다.
   */
  denominatorEstimated: boolean;
  /** 추정 사유 (estimated 일 때만 비어 있지 않다) */
  estimateReasons: readonly EstimateReason[];
  /** 구간 안의 추정 거래 날짜 (오름차순) */
  estimatedDates: readonly string[];
  /**
   * 구간 전체는 `estimated` 인데 확인 가능한 연속 구간이 있을 때의 부분 성과. 그 외에는 null.
   * 월간·연간에서만 만든다(일간은 하루가 곧 구간이다).
   */
  partial: PartialPerformance | null;
}

/**
 * 추정 청산대금의 오차가 이 구간의 시작·종료 현금에서 **동일하게 상쇄되는가** — 입증할 수 있을 때만 true.
 *
 * ## 왜 "상수 오차는 상쇄된다"만으로는 안 되는가
 *
 * 청산대금이 ε 만큼 틀리면 그 날 이후 파생 예수금 `derived(s)` 가 모두 ε 만큼 이동한다. 그런데 현금 모델은
 * `cash = derived + incomeLB`, `incomeLB(t) = max(0, −min_{s≤t} derived(s))` (running-min)라서
 * 구간 손익 `V_close − V_open − F` 안에 `ΔincomeLB` 가 들어 있다. ΔincomeLB 는 ε 에 따라 달라질 수 있다
 * (예: 이전 현금 100, 대금 100 → 다음 날 250 매수는 파생 −50 → incomeLB 50 → 손익 +50,
 *  대금 200 이면 파생 +50 → incomeLB 0 → 손익 0). 현재 모델에서 ΔincomeLB 가 0 이라는 사실은
 * 다른 대금 가정에서도 0 이라는 증거가 아니다.
 *
 * ## 입증 가능한 두 경우 (ε 의 부호·크기를 모른 채로도 성립한다)
 *
 *  (a) 구간 시작이 원장 cutoff **뒤**다. cutoff 뒤의 현금은 `c = c_prev + f − spend` 로만 움직이고
 *      running-min 항이 없다 → 시작·종료 현금의 차가 ε 와 무관하다.
 *  (b) 구간(의 원장 부분 [open, min(close, cutoff)]) 안의 모든 이벤트 날짜에서 파생 예수금이
 *      `M = min{ derived(s) : 마지막 추정일 ≤ s < open }` 이상이다. 그러면 어떤 ε 에서도
 *      구간 안에서 새 running-min 이 생기지 않아 ΔincomeLB = 0 이다.
 *      (추정이 여러 번이면 각 대금의 오차는 서로 독립이고, 마지막 추정일 이후의 이동량은 구간 안에서 상수다.)
 *
 * 둘 다 아니면 입증 불가 → false (손익도 참고값). `derived` 가 없으면 입증할 수 없다.
 */
export function cashErrorCancels(
  derived: DerivedCashSeries | null | undefined,
  ledgerCutoff: string | null,
  lastEstimateDate: string,
  openDate: string,
  closeDate: string,
): boolean {
  if (!derived) return false;
  if (ledgerCutoff !== null && openDate > ledgerCutoff) return true; // (a)
  const effClose = ledgerCutoff !== null && closeDate > ledgerCutoff ? ledgerCutoff : closeDate;
  const dates = derived.dates;
  if (!dates.includes(lastEstimateDate)) return false; // 이 현금 경로에서 추정 대금의 위치를 모른다
  let prevMin = Number.POSITIVE_INFINITY;
  let segMin = Number.POSITIVE_INFINITY;
  for (const d of dates) {
    const v = derived.byDate.get(d)?.derived;
    if (typeof v !== "number") return false;
    if (d >= lastEstimateDate && d < openDate) prevMin = Math.min(prevMin, v);
    else if (d >= openDate && d <= effClose) segMin = Math.min(segMin, v);
  }
  if (segMin === Number.POSITIVE_INFINITY) return true; // 구간 안에 현금 이벤트가 없다 — 현금이 그대로다
  if (prevMin === Number.POSITIVE_INFINITY) return false; // 시작 전 기준점이 없다
  return segMin >= prevMin; // (b)
}

/** 막대 Y축 범위. null(생략된 막대)은 범위에 영향을 주지 않고, 0 은 기준선으로 항상 포함한다. */
export function barYDomain(values: readonly (number | null)[]): [number, number] {
  const vals = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return [0, 1];
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.08 || 1;
  return [lo - pad, hi + pad];
}

/**
 * 막대·요약에 쓸 **확정 값**. 계산 불가(null)와 추정 포함(참고값)은 0 이 아니라 `null` 이다.
 * 실제 계산 결과 0 은 0 으로 남는다.
 */
export function confirmedBarValue(r: PeriodResult, metric: "pct" | "amount"): number | null {
  if (r.estimated) return null;
  const v = metric === "pct" ? r.returnPctLow : r.knownProfit;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 차트에 그릴 값과 종류. 확정 막대가 있으면 `confirmed`, 구간 전체는 미확정이지만 부분 성과가 있으면 `partial`
 * (값이 null 이면 그리지 않는다), 그 외는 막대 없음(`none`).
 */
export function chartBar(
  r: PeriodResult,
  metric: "pct" | "amount",
): { value: number | null; kind: "confirmed" | "partial" | "none" } {
  const confirmed = confirmedBarValue(r, metric);
  if (confirmed !== null) return { value: confirmed, kind: "confirmed" };
  if (r.estimated && r.partial) {
    const v = metric === "pct" ? r.partial.returnPctLow : r.partial.knownProfit;
    if (typeof v === "number" && Number.isFinite(v)) return { value: v, kind: "partial" };
  }
  return { value: null, kind: "none" };
}

const DAY_MS = 86_400_000;
const dayDiff = (from: string, to: string): number => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
};

export interface FlowPoint {
  /** 유효일 (거래일) */
  date: string;
  amount: number;
}

/**
 * 구간이 추정의 영향을 받는가 — 서로 독립적으로 판정한다 (`segmentProfit` 과 부분 성과가 같은 판정을 쓴다).
 *
 *   · 추정 날짜가 구간 안에 있다 → 체결가 대용이 손익에 직접 들어간다
 *   · 실제 매도일이 불확실한 창 [windowStart, date] 과 구간이 겹친다 → 그 사이 보유 노출이 불확실하다
 *   · 추정 날짜가 구간 시작 전이다 → 시작 예수금에 추정 청산대금이 섞여 있다.
 *       그 오차가 구간 손익에서 **상쇄된다는 근거가 있을 때만** 분모만 추정(denominatorEstimated),
 *       근거가 없으면 손익도 참고값이다 (cash_error_not_cancelled)
 */
export function classifyEstimates(
  seg: Segment,
  estimates: readonly EstimatedDay[],
  cancels: (accountId: string, lastEstimateDate: string, seg: Segment) => boolean,
): {
  estimated: boolean;
  denominatorEstimated: boolean;
  estimateReasons: EstimateReason[];
  estimatedDates: string[];
} {
  const reasons = new Set<EstimateReason>();
  const dates = new Set<string>();
  const priorByAccount = new Map<string, string>(); // 계좌 → 구간 시작 전 마지막 추정 날짜
  for (const e of estimates) {
    const inside = e.date >= seg.openDate && e.date <= seg.closeDate;
    const dateOpen = e.reasons.includes("exit_date_unconfirmed");
    const inWindow =
      dateOpen &&
      seg.openDate <= e.date &&
      (e.windowStart === null || seg.closeDate >= e.windowStart);
    if (inside || inWindow) {
      (inside ? e.reasons : (["exit_date_unconfirmed"] as const)).forEach((r) => reasons.add(r));
      dates.add(e.date);
    } else if (e.date < seg.openDate) {
      const prev = priorByAccount.get(e.accountId);
      if (!prev || e.date > prev) priorByAccount.set(e.accountId, e.date);
    }
  }
  let denominatorEstimated = false;
  if (reasons.size === 0) {
    for (const [accountId, lastDate] of priorByAccount) {
      if (cancels(accountId, lastDate, seg)) {
        denominatorEstimated = true;
      } else {
        reasons.add("cash_error_not_cancelled");
        dates.add(lastDate);
      }
    }
    if (reasons.size > 0) denominatorEstimated = false; // 한 계좌라도 입증 못 하면 손익이 참고값이다
  }
  const estimated = reasons.size > 0;
  const estimateReasons = [...reasons];
  const estimatedDates = [...dates].sort();
  return { estimated, denominatorEstimated, estimateReasons, estimatedDates };
}

/**
 * 한 구간의 손익·수익률.
 *
 *   profit = V_close(C) − V_open(O) − F
 *
 * **분모는 이 구간의 시작자본 + 시간가중 외부흐름뿐이다.** 일간 구간의 자본을 합산해
 * 만들지 않는다 — 260 거래일을 더하면 수백억이 나와 수익률이 0 에 수렴한다.
 *
 * **분자에 `incomeLowerBound` 를 더하지 않는다.** 예수금이 `derivedCash + incomeLB` 라서
 * `V_close − V_open` 안에 이미 그 구간의 `ΔincomeLB` 가 들어 있다. 더하면 이중계산이고,
 * 실제로 2026 전체가 −0.82% 대신 −0.02% 로 나왔다.
 */
export function segmentProfit(
  seg: Segment,
  scopeDays: readonly ScopeDay[],
  flows: readonly FlowPoint[],
  /**
   * `recognized` — 이 구간 손익에 **이미 포함된** 미관측 수입 하한(설명용).
   * `headroom`   — 상한까지 갔을 때 **추가로** 더해질 수 있는 금액(= R 합). 모르면 null.
   */
  income: { recognized: number; headroom: number | null },
  span: SpanKind,
  /** 이 구간에 걸린 추정 거래. 없으면 생략 */
  estimates: readonly EstimatedDay[] = [],
  /**
   * 구간 시작 전의 추정 청산대금 오차가 이 구간 손익에서 상쇄된다고 **입증**할 수 있는가.
   * 기본은 입증 불가(false) — 근거 없이 손익을 확정으로 취급하지 않는다.
   */
  cancels: (accountId: string, lastEstimateDate: string, seg: Segment) => boolean = () => false,
): PeriodResult {
  const byDate = new Map(scopeDays.map((d) => [d.date, d]));
  const openDay = byDate.get(seg.openDate)!;
  const closeDay = byDate.get(seg.closeDate)!;

  const T = dayDiff(seg.openDate, seg.closeDate);
  let netCashflow = 0;
  let weighted = 0;
  for (const f of flows) {
    if (!f.amount) continue;
    if (f.date < seg.openDate || f.date > seg.closeDate) continue;
    netCashflow += f.amount;
    const ti = dayDiff(seg.openDate, f.date);
    const w = T > 0 ? Math.max(0, Math.min(1, (T - ti) / T)) : 0;
    weighted += f.amount * w;
  }

  const knownProfit = closeDay.vClose - openDay.vOpen - netCashflow;
  const averageCapital = openDay.vOpen + weighted;

  const sources = [...new Set(seg.dates.flatMap((d) => byDate.get(d)?.holdingsSources ?? []))];
  const cashQuality = worstCashQuality(
    seg.dates.map((d) => byDate.get(d)?.cashQuality ?? "unknown"),
  );
  const { estimated, denominatorEstimated, estimateReasons, estimatedDates } = classifyEstimates(
    seg, estimates, cancels,
  );
  const exact =
    sources.every((s) => s === "ledger") && cashQuality === "derived" && !estimated && !denominatorEstimated;

  const pct = (profit: number) => (averageCapital > 0 ? (profit / averageCapital) * 100 : null);

  return {
    key: seg.key,
    label: seg.label,
    openDate: seg.openDate,
    closeDate: seg.closeDate,
    beginningTotal: openDay.vOpen,
    endingTotal: closeDay.vClose,
    netCashflow,
    knownProfit,
    incomeLowerBound: income.recognized,
    incomeUpperBound: income.headroom === null ? null : income.recognized + income.headroom,
    incomeHeadroom: income.headroom,
    averageCapital,
    // 하한 = 손익 그대로(이미 ΔincomeLB 포함). 상한 = 아직 설명 안 된 잔차만큼 더한 값.
    returnPctLow: pct(knownProfit),
    returnPctHigh: income.headroom === null ? null : pct(knownProfit + income.headroom),
    holdingsSources: sources,
    cashQuality,
    span,
    exact,
    estimated,
    denominatorEstimated,
    estimateReasons,
    estimatedDates,
    partial: null,
  };
}

/** 두 연속 usable 거래일 사이의 **기간 외 갭** 손익. 어떤 period 에도 귀속되지 않는다. */
export function gapProfit(prev: ScopeDay, next: ScopeDay): number {
  return next.vOpen - prev.vClose;
}

// ── 최상위 ──────────────────────────────────────────────────────────────────

export interface ComputeInput {
  valuations: readonly AccountDayValuation[];
  coverages: readonly AccountCoverage[];
  scopeAccountIds: readonly string[];
  period: PeriodId;
  /** 계좌별 유효일 흐름 — 그 계좌 성과 구간 안의 것만 들어와야 한다 */
  flows: readonly FlowPoint[];
  /** 계좌별 미관측 수입 하한/상한 계산용 */
  incomeSources: readonly {
    accountId: string;
    derived: DerivedCashSeries;
    /** 상한 R. cutoff 정렬 checkpoint 가 없으면 null */
    cap: number | null;
  }[];
  /**
   * 추정 거래(가격 대용 청산)가 있는 (계좌, 날짜). scope 안 계좌의 것만 구간에 반영된다.
   * 생략하면 기존 동작과 같다.
   */
  estimatedDays?: readonly EstimatedDay[];
}

/**
 * 계좌가 성과 구간에 **합류하면서 들고 들어온 자본**.
 *
 * 계좌는 자기 `performanceStart` 부터 합산에 들어오고 그 전에는 자산 0 이다(사실이다).
 * 그런데 합류 시점의 `V_open` 이 0 이 아니면 — 예컨대 ISA 는 2026-01-06 에 9,112,312원이
 * 입금되고 **다음 거래일**인 01-07 부터 성과 구간이 시작한다 — 전체 scope 입장에서는
 * "없던 자산이 갑자기 생긴" 것이 된다. 그 돈은 **외부에서 들어온 자본**이므로 반드시
 * 외부흐름으로 세야 한다. 세지 않으면 그만큼이 통째로 수익으로 둔갑한다.
 *
 * 실제로 그랬다: 2026 전체 손익이 계좌별 합보다 정확히 9,112,312원 많았다.
 *
 * 합류일이 구간 시작일과 **같으면** 그 자본은 이미 `beginningTotal` 에 들어 있으므로
 * 흐름으로 세지 않는다(호출부에서 `date > seg.openDate` 로 거른다).
 */
export function accountJoinFlows(
  valuations: readonly AccountDayValuation[],
  coverages: readonly AccountCoverage[],
  scopeAccountIds: readonly string[],
): FlowPoint[] {
  const out: FlowPoint[] = [];
  for (const id of scopeAccountIds) {
    const cv = coverages.find((c) => c.accountId === id);
    if (!cv?.performanceStart) continue;
    const v = valuations.find((x) => x.accountId === id && x.date === cv.performanceStart);
    if (v?.usable && v.vOpen !== 0) out.push({ date: cv.performanceStart, amount: v.vOpen });
  }
  return out;
}

export function computeProfitAnalysis(input: ComputeInput): PeriodResult[] {
  const scopeDays = aggregateScope(input.valuations, input.coverages, input.scopeAccountIds);
  if (scopeDays.length < 1) return [];
  const dates = scopeDays.map((d) => d.date);
  const segments = buildSegments(dates, input.period);
  if (!segments.length) return [];

  const first = dates[0];
  const last = dates[dates.length - 1];
  const inScope = new Set(input.scopeAccountIds);
  const sources = input.incomeSources.filter((s) => inScope.has(s.accountId));
  const joins = accountJoinFlows(input.valuations, input.coverages, input.scopeAccountIds);
  const estimates = (input.estimatedDays ?? []).filter((e) => inScope.has(e.accountId));
  const derivedByAccount = new Map(input.incomeSources.map((s) => [s.accountId, s.derived]));
  const cutoffByAccount = new Map(input.coverages.map((c) => [c.accountId as string, c.ledgerCutoff]));
  // 추정 청산대금 오차의 상쇄 입증 — 입증하지 못하면(derived 없음 포함) false
  const cancels = (accountId: string, lastEstimateDate: string, seg: Segment): boolean =>
    cashErrorCancels(
      derivedByAccount.get(accountId),
      cutoffByAccount.get(accountId) ?? null,
      lastEstimateDate,
      seg.openDate,
      seg.closeDate,
    );

  const scopeDaySet = new Set(dates);
  /** 한 구간(또는 run)을 기존 계산식으로 평가한다 — 구간 전체와 부분 성과의 run 이 같은 함수를 쓴다 */
  const resultFor = (seg: Segment): PeriodResult => {
    let recognized = 0;
    let capSum = 0;
    let anyCapMissing = false;
    for (const s of sources) {
      recognized += incomeLowerBoundBetween(s.derived, seg.openDate, seg.closeDate);
      if (s.cap === null) anyCapMissing = true;
      else capSum += s.cap;
    }
    // 구간 **도중에** 합류한 계좌의 자본만 외부흐름에 더한다.
    const segFlows = [...input.flows, ...joins.filter((j) => j.date > seg.openDate)];
    return segmentProfit(
      seg,
      scopeDays,
      segFlows,
      { recognized, headroom: anyCapMissing ? null : capSum },
      spanOfSegment(seg, input.period, first, last),
      estimates,
      cancels,
    );
  };

  return segments.map((seg) => {
    const result = resultFor(seg);
    // 월간·연간에서 구간 전체가 미확정이면 확인 가능한 연속 구간만 따로 모은다 (구간 전체 결과는 그대로 둔다)
    if (input.period === "daily" || !result.estimated) return result;
    // 평가 불가라 거래일 목록에서 빠진 날 — 부분 성과 커버리지 분모에 없다는 사실을 알리기 위해 따로 모은다
    const unpriced = [
      ...new Set(
        input.valuations
          .filter((v) => inScope.has(v.accountId) && v.date >= seg.openDate && v.date <= seg.closeDate && !scopeDaySet.has(v.date))
          .map((v) => v.date),
      ),
    ];
    return { ...result, partial: computePartialPerformance(seg, resultFor, unpriced) };
  });
}

/**
 * 구간 안의 **검증된 연속 거래일(run)** 을 찾아 부분 성과를 만든다. 확인 가능한 run 이 없으면 null.
 *
 * 탐욕적 확장 — 날짜를 앞에서부터 보면서:
 *   1. 그 하루 구간 [d, d] 가 추정의 영향을 받으면 **제외 일자**(사유 기록)
 *   2. 아니면 새 run 을 시작하고, 다음 거래일을 붙여도 **run 전체를 다시 검증했을 때** 추정이 아닌 동안만 확장한다.
 *      하루씩은 정상이어도 합친 구간이 검증에 실패하면(예: 현금 상쇄를 입증하지 못함) 거기서 run 을 끊는다.
 * 추정은 구간이 넓어질수록 단조롭게 늘어난다(창·추정일이 구간에 걸리거나, 새 현금 최저점이 생기면 하루에서도 실패한다).
 * 그래서 확장에 성공한 run 의 모든 날은 개별로도 정상이다.
 *
 * run 사이의 제외 기간은 평가액을 직접 이어 계산하지 않는다 — 각 run 이 자기 시가·종가로 독립 계산된다.
 */
export function computePartialPerformance(
  seg: Segment,
  resultFor: (seg: Segment) => PeriodResult,
  /** 이 구간에서 평가 불가라 거래일 목록에서 빠진 날짜 (커버리지 분모에 없는 날) */
  unpricedDays: readonly string[] = [],
): PartialPerformance | null {
  const dates = seg.dates;
  const asSeg = (from: number, to: number): Segment => ({
    key: seg.key, label: seg.label, openDate: dates[from], closeDate: dates[to], dates: dates.slice(from, to + 1),
  });

  const runs: PartialRun[] = [];
  const excludedDays: { date: string; reasons: readonly EstimateReason[] }[] = [];
  const includedDates: string[] = [];

  let i = 0;
  while (i < dates.length) {
    const single = resultFor(asSeg(i, i));
    if (single.estimated) {
      excludedDays.push({ date: dates[i], reasons: single.estimateReasons });
      i += 1;
      continue;
    }
    let j = i;
    let accepted = single;
    while (j + 1 < dates.length) {
      const next = resultFor(asSeg(i, j + 1));
      if (next.estimated) break;
      accepted = next;
      j += 1;
    }
    runs.push({
      openDate: dates[i],
      closeDate: dates[j],
      tradingDays: j - i + 1,
      beginningTotal: accepted.beginningTotal,
      endingTotal: accepted.endingTotal,
      netCashflow: accepted.netCashflow,
      knownProfit: accepted.knownProfit,
      averageCapital: accepted.averageCapital,
      returnPctLow: accepted.returnPctLow,
      returnPctHigh: accepted.returnPctHigh,
      denominatorEstimated: accepted.denominatorEstimated,
    });
    includedDates.push(...dates.slice(i, j + 1));
    i = j + 1;
  }
  if (!runs.length) return null;

  // run 사이 끊김 중 제외된 (평가 가능한) 거래일로 설명되지 않는 곳 — 평가 불가일에 숨은 추정 등
  let unmeasuredBreaks = 0;
  for (let k = 0; k + 1 < runs.length; k++) {
    const between = excludedDays.some((e) => e.date > runs[k].closeDate && e.date < runs[k + 1].openDate);
    if (!between) unmeasuredBreaks += 1;
  }

  // 연결수익률 — run 하나라도 null 이면 null (0% 를 대입하지 않는다)
  const link = (get: (r: PartialRun) => number | null): number | null => {
    let acc = 1;
    for (const r of runs) {
      const v = get(r);
      if (v === null || !Number.isFinite(v)) return null;
      acc *= 1 + v / 100;
    }
    return (acc - 1) * 100;
  };

  return {
    runs,
    includedDates,
    excludedDays,
    measuredDays: includedDates.length,
    totalDays: dates.length,
    unmeasuredBreaks,
    unpricedDays: [...unpricedDays].sort(),
    knownProfit: runs.reduce((a, r) => a + r.knownProfit, 0),
    returnPctLow: link((r) => r.returnPctLow),
    returnPctHigh: link((r) => r.returnPctHigh),
    denominatorEstimated: runs.some((r) => r.denominatorEstimated),
    basis: "linked-modified-dietz",
  };
}

/**
 * 구간이 달력상 기간 전체를 덮는가.
 *
 *   `account-inception` — 구간의 시작이 **전체 timeline 의 첫 날**이고, 그게 그 bucket 의
 *                         달력 시작보다 늦다. 즉 계좌·전략이 기간 중간에 시작했다
 *   `in-progress`       — 구간의 끝이 **전체 timeline 의 마지막 날**이다. 아직 진행 중
 *   `full`              — 그 외
 *
 * daily 는 하루가 곧 기간이므로 항상 `full` 이다.
 */
export function spanOfSegment(
  seg: Segment,
  period: PeriodId,
  firstUsableDate: string,
  lastUsableDate: string,
): SpanKind {
  if (period === "daily") return "full";
  const calendarStart = period === "monthly" ? `${seg.key}-01` : `${seg.key}-01-01`;
  if (seg.openDate === firstUsableDate && seg.openDate > calendarStart) return "account-inception";
  if (seg.closeDate === lastUsableDate) return "in-progress";
  return "full";
}
