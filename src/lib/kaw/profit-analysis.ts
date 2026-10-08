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
  /** 모든 날이 ledger + derived 인가 */
  exact: boolean;
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
  const exact = sources.every((s) => s === "ledger") && cashQuality === "derived";

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

  return segments.map((seg) => {
    let recognized = 0;
    let capSum = 0;
    let anyCapMissing = false;
    for (const s of sources) {
      recognized += incomeLowerBoundBetween(s.derived, seg.openDate, seg.closeDate);
      if (s.cap === null) anyCapMissing = true;
      else capSum += s.cap;
    }
    return segmentProfit(
      seg,
      scopeDays,
      input.flows,
      { recognized, headroom: anyCapMissing ? null : capSum },
      spanOfSegment(seg, input.period, first, last),
    );
  });
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
