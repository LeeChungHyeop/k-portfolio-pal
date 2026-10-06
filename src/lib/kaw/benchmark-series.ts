// ─────────────────────────────────────────────────────────────────────────────
// "내 포트폴리오 vs 시장" 금액 비교 차트의 시점(point) 정의와, 리밸런싱 기록이 없는 달을
// **직전 확정 보유수량 carry-forward 평가**로 채우는 계산.
//
// ## carry-forward 는 보간이 아니다
//
// 어떤 달에 리밸런싱 기록이 없으면, 그 달 point 는 "값을 두 점 사이에서 적당히 끼워 넣은 것"이
// 아니다. 그 달 **이전의 가장 최근 확정 리밸런싱**(anchor)의 보유수량/benchmark 유닛을
// **그대로 들고 있었다고 보고**, 그 달 월말 종가로 다시 평가한 금액이다. 가상의 리밸런싱을
// 끼워 넣지 않는다 — 목표비중 재배분을 하지 않는 것이 이 계산의 핵심이다.
//
// 그래서 이 값은 "리밸런싱 기록이 없는 기간에는 보유수량이 바뀌지 않았다"는 가정과 한 세트다.
// 그 기간에 들어온 외부 입출금은 아직 투자되지 않은 **현금**으로만 더한다(네 series 모두 동일).
//
// ## 저장하지 않는다
//
// 여기서 만들어지는 point 는 **화면 계산에서만 존재하는 파생값**이다. `account.history` 에
// 넣지 않고, `setHistoryBacktest` 로 저장하지 않고, DB 에도 쓰지 않는다. 저장하면 실제
// 리밸런싱 기록과 구별이 안 되고, 장부가 바뀌었을 때 따라 갱신되지 않는다.
//
// ## daily snapshot 과의 관계 (향후)
//
// `source` 를 point 에 달아 두는 이유가 이것이다. 나중에 같은 달에 실제 daily snapshot 이
// 있으면 `"snapshot"` 같은 source 를 하나 더 두고 `BENCHMARK_SOURCE_PRIORITY` 에서
// carry_forward 보다 앞세우면 된다 — 계산식을 건드리지 않고 교체할 수 있게 둔 구조다.
// (이번 작업에서는 snapshot 통합을 하지 않는다.)
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { ASSET_ORDER, BUILTIN_TICKERS } from "./constants";
import type { HistoryEntry } from "./store";
import {
  SAFE_MIX_SP500_TICKER, currentBacktestOf, fetchTickerPricesForDates, isUsablePrice,
} from "./backtest";
import { investedPrincipalAsOf, principalAsOf, type CashflowEntry } from "./cashflow";
import { kstMonthString } from "./snapshot";

/**
 * 그 point 가 어디서 나왔는지. 사용자에게 보여주는 라벨이 아니라 **계산 출처 메타데이터**다.
 *   history      — 실제 리밸런싱 기록
 *   carry_forward — 기록 없는 달을 직전 확정 보유수량으로 월말 평가한 파생 point
 *   live         — 실시간 시세 기준 "현재"
 *   db_only      — 투자 기록이 없고 DB 유지 가정값만 있는 달
 */
export type BenchmarkPointSource = "history" | "carry_forward" | "live" | "db_only";

/**
 * 금액 비교 차트의 한 시점. 같은 시점에 없는 series 는 null 이고, **보간하지 않는다.**
 * (carry-forward 는 보간이 아니다 — 파일 상단 주석 참고.)
 */
export interface BenchmarkPoint {
  label: string; // x축 표시 (YYYY.MM 또는 "현재")
  date: string; // 그 포인트의 실제 일자 (YYYY-MM-DD) 또는 "현재"
  sortDate: string; // 정렬 전용
  source: BenchmarkPointSource;
  actualValue: number | null;
  actualPct: number | null;
  growthValue: number | null;
  growthPct: number | null;
  kospiValue: number | null;
  kospiPct: number | null;
  sp500Value: number | null;
  sp500Pct: number | null;
  /** 퇴직연금 전용 — DB 유지 가정 예상 퇴직급여 (투자 수익률 개념이 없어 % 가 없다) */
  dbValue: number | null;
}

export function emptyPoint(
  label: string,
  date: string,
  sortDate: string,
  source: BenchmarkPointSource,
): BenchmarkPoint {
  return {
    label, date, sortDate, source,
    actualValue: null, actualPct: null,
    growthValue: null, growthPct: null,
    kospiValue: null, kospiPct: null,
    sp500Value: null, sp500Pct: null,
    dbValue: null,
  };
}

/** 같은 달에 여러 출처가 겹칠 때 어느 쪽을 쓰는가. 실제 기록이 파생값에 덮이지 않게 한다. */
export const BENCHMARK_SOURCE_PRIORITY: Record<BenchmarkPointSource, number> = {
  history: 3,
  live: 3,
  carry_forward: 2,
  db_only: 1,
};

/** 자산 라이브러리에서 이 계산이 실제로 읽는 필드만. (store 의 AssetDef 와 구조적으로 호환) */
export interface AssetLibraryEntry {
  defaultEtf: string;
  ticker?: string;
}

/** ETF 명 → 종목코드. 커스텀 종목도 라이브러리에 ticker 가 있으면 그대로 resolve 된다. */
export function resolveEtfTicker(
  library: readonly AssetLibraryEntry[],
  etfName: string | undefined,
): string | undefined {
  if (!etfName) return undefined;
  return library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker;
}

export const benchmarkMonthLabel = (month: string): string => month.replace("-", ".");

/** YYYY-MM → 그 달 **달력상 말일** YYYY-MM-DD. 거래일 보정은 서버가 한다(요청일 이하 최신 종가). */
export function monthEndDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** YYYY-MM → 다음 달 YYYY-MM */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m 은 0-based 로 다음 달
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * carry-forward 로 채울 달 목록 (YYYY-MM, 오름차순).
 *
 *   - 첫 리밸런싱 기록이 있는 달부터 **직전 달까지**를 본다.
 *   - 실제 기록이 있는 달은 제외한다 (그 달은 실제 point 가 담당하고 덮어쓰지 않는다).
 *   - **진행 중인 달은 만들지 않는다** — 그 달은 실시간 "현재" point 가 담당한다.
 *     (월말이 아직 오지 않았는데 월말 종가를 요청하면 중간값이 월말로 굳는다.)
 *   - 마지막 기록 이후로도 완료된 달이면 채운다 (예: 8월 기록 / 9월 없음 / 지금 10월 → 9월 생성).
 */
export function carryForwardGapMonths(
  history: readonly HistoryEntry[],
  nowMonth: string = kstMonthString(),
): string[] {
  if (!history.length) return [];
  const months = new Set(history.map((h) => h.date.slice(0, 7)));
  const first = [...months].sort()[0];
  const out: string[] = [];
  let m = first;
  // 데이터 이상으로 끝나지 않는 루프가 되지 않도록 상한을 둔다(50년).
  for (let guard = 0; m < nowMonth && guard < 600; guard += 1) {
    if (!months.has(m)) out.push(m);
    m = nextMonth(m);
  }
  return out;
}

/**
 * 그 달의 anchor = **target 달 이전의 가장 최근 확정 리밸런싱**.
 * "직전 달"이 아니다 — 여러 달 연속 비어 있으면 모두 같은 anchor 를 쓴다.
 */
export function carryForwardAnchor(
  history: readonly HistoryEntry[],
  month: string,
): HistoryEntry | undefined {
  const monthStart = `${month}-01`;
  let best: HistoryEntry | undefined;
  for (const h of history) {
    if (h.date >= monthStart) continue;
    if (!best || h.date > best.date) best = h;
  }
  return best;
}

/** 한 anchor 를 월말 평가하려면 어떤 종목코드가 필요한가 (실제 보유 + 성장형 + 지수 다리). */
export function carryForwardTickersFor(
  anchor: HistoryEntry,
  library: readonly AssetLibraryEntry[],
  safeAssetMix: boolean,
): string[] {
  const out = new Set<string>();
  // 실제(커스텀) 보유 종목 — BUILTIN_TICKERS 에 없는 커스텀 종목도 있으므로 라이브러리에서 찾는다.
  const qty = anchor.rowQuantitiesSnap ?? {};
  const etf = anchor.rowEtfSnap ?? {};
  for (const [rowId, q] of Object.entries(qty)) {
    if (!(q > 0)) continue;
    const t = resolveEtfTicker(library, etf[rowId]);
    if (t) out.add(t);
  }
  const bt = anchor.backtestGrowth;
  if (bt) {
    ASSET_ORDER.forEach((k) => {
      if (!((bt.units[k] ?? 0) > 0)) return;
      const t = BUILTIN_TICKERS[k];
      if (t) out.add(t);
    });
    if ((bt.kospiUnits ?? 0) > 0 && BUILTIN_TICKERS.kr) out.add(BUILTIN_TICKERS.kr);
    if ((bt.sp500Units ?? 0) > 0 && BUILTIN_TICKERS.us) out.add(BUILTIN_TICKERS.us);
    if (safeAssetMix) {
      if ((bt.kospiSafeUnits ?? 0) > 0 && BUILTIN_TICKERS.ktb30) out.add(BUILTIN_TICKERS.ktb30);
      if ((bt.sp500SafeUnits ?? 0) > 0) out.add(SAFE_MIX_SP500_TICKER);
    }
  }
  return [...out];
}

/** 어떤 달·어떤 종목의 과거 종가를 받아와야 하는지 (네트워크 요청 계획). 순수 함수다. */
export interface CarryForwardPlan {
  months: string[];
  /** 각 달의 월말 날짜 (YYYY-MM-DD) */
  dates: string[];
  tickers: string[];
}

export function carryForwardPlan(
  history: readonly HistoryEntry[],
  library: readonly AssetLibraryEntry[],
  safeAssetMix: boolean,
  nowMonth: string = kstMonthString(),
): CarryForwardPlan {
  const months = carryForwardGapMonths(history, nowMonth);
  const tickers = new Set<string>();
  const dates: string[] = [];
  months.forEach((month) => {
    const anchor = carryForwardAnchor(history, month);
    if (!anchor) return;
    dates.push(monthEndDate(month));
    carryForwardTickersFor(anchor, library, safeAssetMix).forEach((t) => tickers.add(t));
  });
  return { months, dates: [...new Set(dates)].sort(), tickers: [...tickers].sort() };
}

/** 장부가 없는 옛 데이터용 폴백 — 기존 계산식(첫 기록 baseAmount + 이후 deposit) 그대로. */
function legacyPrincipalUpTo(sorted: readonly HistoryEntry[], date: string): number {
  let sum = 0;
  sorted.forEach((h, i) => {
    if (h.date > date) return;
    sum += i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
  });
  return sum;
}

/**
 * 보유 유닛 × 월말 종가. **fail-closed** — 유닛이 있는 다리 중 하나라도 가격이 없으면 `null`.
 * (0원으로 계산하지 않는다. 다른 series 는 각자 따로 판정되므로 같이 버려지지 않는다.)
 */
function evalLegs(
  legs: readonly { units: number; ticker: string | undefined }[],
  px: Record<string, number>,
): number | null {
  let sum = 0;
  let held = false;
  for (const leg of legs) {
    if (!(leg.units > 0)) continue;
    const p = leg.ticker ? px[leg.ticker] : undefined;
    if (!isUsablePrice(p)) return null;
    sum += leg.units * p;
    held = true;
  }
  return held ? sum : null;
}

export interface CarryForwardOptions {
  history: readonly HistoryEntry[];
  cashflows: readonly CashflowEntry[] | undefined;
  /** 지금 장부 지문 — anchor 의 저장된 benchmark 가 stale 이면 쓰지 않는다 */
  cashflowKey: string;
  library: readonly AssetLibraryEntry[];
  safeAssetMix: boolean;
  /** date(YYYY-MM-DD) → ticker → 종가. **없는 값은 키가 없다**(0 으로 두지 않는다). */
  pricesByDate: Record<string, Record<string, number>>;
  nowMonth?: string;
}

/**
 * 리밸런싱 기록이 없는 완료된 달들의 carry-forward point.
 *
 * 각 달의 계산(모두 anchor 시점 유닛을 **그대로 유지**한 평가다 — 재리밸런싱 없음):
 *   실제(커스텀) = Σ(anchor.rowQuantitiesSnap × 월말 종가) + anchor 예수금 + anchor 이후 순입출금
 *   성장형       = Σ(anchor.units[자산] × 월말 종가) + 미투자 현금
 *   KOSPI200     = anchor.kospiUnits × kr 월말가 (+ safe mix 면 kospiSafeUnits × ktb30) + 미투자 현금
 *   S&P500       = anchor.sp500Units × us 월말가 (+ safe mix 면 sp500SafeUnits × 438080) + 미투자 현금
 *   누적수익률    = (평가액 - principalAsOf(장부, 월말)) / principalAsOf(장부, 월말)
 *
 * "미투자 현금" = 월말까지의 누적 납입원금 - anchor 시점에 투자 가능했던 누적액. 기존
 * `uninvestedCashFor` / live point 와 같은 정의다 — 분모(원금)에 들어간 돈이므로 분자에도 현금으로 둔다.
 */
export function buildCarryForwardPoints(o: CarryForwardOptions): BenchmarkPoint[] {
  const sorted = [...o.history].sort((a, b) => a.date.localeCompare(b.date));
  const months = carryForwardGapMonths(sorted, o.nowMonth ?? kstMonthString());
  const hasLedger = !!o.cashflows?.length;

  const out: BenchmarkPoint[] = [];
  months.forEach((month) => {
    const anchor = carryForwardAnchor(sorted, month);
    if (!anchor) return;
    const date = monthEndDate(month);
    const px = o.pricesByDate[date];
    if (!px) return; // 아직 가격을 받지 못했다 — point 를 만들지 않는다

    // 원금 기준은 기존 실제 point(principalAsOf) / backtest(투자분 + 미투자현금) 와 동일하다.
    const principal = hasLedger
      ? principalAsOf(o.cashflows, date)
      : legacyPrincipalUpTo(sorted, anchor.date);
    const uninvested = hasLedger
      ? principal - investedPrincipalAsOf(o.cashflows, anchor.date)
      : 0;
    // 실제 쪽은 anchor 의 실제 예수금에서 출발해 그 뒤 순입출금을 더한다.
    const actualCash = hasLedger
      ? (anchor.cashBalance ?? 0) + (principal - principalAsOf(o.cashflows, anchor.date))
      : (anchor.cashBalance ?? 0);

    const pctOf = (value: number | null) =>
      value !== null && principal > 0
        ? Math.round(((value - principal) / principal) * 10000) / 100
        : null;

    // ── 실제(커스텀) — anchor 의 보유수량 스냅샷 × 월말 종가
    let actualValue: number | null = null;
    const qty = anchor.rowQuantitiesSnap;
    const etf = anchor.rowEtfSnap;
    if (qty && etf) {
      const legs = Object.entries(qty).map(([rowId, q]) => ({
        units: q,
        ticker: resolveEtfTicker(o.library, etf[rowId]),
      }));
      const etfValue = evalLegs(legs, px);
      if (etfValue !== null) actualValue = etfValue + actualCash;
    }

    // ── 비교선 — stale 저장값으로는 만들지 않는다 (오염된 유닛이 차트로 새지 않게)
    const bt = currentBacktestOf(anchor.backtestGrowth, o.cashflowKey);
    const growthRaw = bt
      ? evalLegs(
          ASSET_ORDER.map((k) => ({ units: bt.units[k] ?? 0, ticker: BUILTIN_TICKERS[k] })),
          px,
        )
      : null;
    const kospiRaw = bt
      ? evalLegs(
          [
            { units: bt.kospiUnits ?? 0, ticker: BUILTIN_TICKERS.kr },
            ...(o.safeAssetMix
              ? [{ units: bt.kospiSafeUnits ?? 0, ticker: BUILTIN_TICKERS.ktb30 }]
              : []),
          ],
          px,
        )
      : null;
    const sp500Raw = bt
      ? evalLegs(
          [
            { units: bt.sp500Units ?? 0, ticker: BUILTIN_TICKERS.us },
            ...(o.safeAssetMix
              ? [{ units: bt.sp500SafeUnits ?? 0, ticker: SAFE_MIX_SP500_TICKER }]
              : []),
          ],
          px,
        )
      : null;

    const growthValue = growthRaw === null ? null : growthRaw + uninvested;
    const kospiValue = kospiRaw === null ? null : kospiRaw + uninvested;
    const sp500Value = sp500Raw === null ? null : sp500Raw + uninvested;

    // 네 series 전부 계산 불가면 빈 행을 만들지 않는다.
    if (actualValue === null && growthValue === null && kospiValue === null && sp500Value === null) {
      return;
    }

    out.push({
      ...emptyPoint(benchmarkMonthLabel(month), date, date, "carry_forward"),
      actualValue,
      actualPct: pctOf(actualValue),
      growthValue,
      growthPct: pctOf(growthValue),
      kospiValue,
      kospiPct: pctOf(kospiValue),
      sp500Value,
      sp500Pct: pctOf(sp500Value),
    });
  });
  return out;
}

/**
 * 같은 라벨(YYYY.MM)의 행을 하나로 합친다. **실제 기록이 carry-forward 에 덮이지 않는다** —
 * 우선순위는 `BENCHMARK_SOURCE_PRIORITY` 가 정한다(향후 daily snapshot 도 여기에 끼운다).
 */
export function mergeBenchmarkRows(...groups: readonly BenchmarkPoint[][]): BenchmarkPoint[] {
  const byLabel = new Map<string, BenchmarkPoint>();
  groups.flat().forEach((p) => {
    const existing = byLabel.get(p.label);
    if (
      existing
      && BENCHMARK_SOURCE_PRIORITY[existing.source] >= BENCHMARK_SOURCE_PRIORITY[p.source]
    ) {
      return;
    }
    byLabel.set(p.label, { ...p });
  });
  return [...byLabel.values()].sort((a, b) => a.sortDate.localeCompare(b.sortDate));
}

/**
 * 기록 없는 달의 월말 종가를 받아와 carry-forward point 를 만든다.
 *
 * `enabled` 가 false 면 요청도 계산도 하지 않는다 — 비교 차트는 계좌 4개의 hook 을 React 규칙대로
 * 항상 호출하되 보고 있는 탭만 활성화한다(과거 종가 호출 폭주 방지, `useEnsureGrowthBacktest` 와 동일).
 */
export function useCarryForwardBenchmark(
  history: HistoryEntry[],
  {
    cashflows,
    cashflowKey,
    library,
    safeAssetMix = false,
    enabled = true,
    nowMonth,
  }: {
    cashflows?: readonly CashflowEntry[];
    cashflowKey: string;
    library: readonly AssetLibraryEntry[];
    safeAssetMix?: boolean;
    enabled?: boolean;
    nowMonth?: string;
  },
) {
  const month = nowMonth ?? kstMonthString();
  const plan = useMemo(
    () => carryForwardPlan(history, library, safeAssetMix, month),
    [history, library, safeAssetMix, month],
  );
  const [pricesByDate, setPricesByDate] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const planKey = enabled && plan.dates.length && plan.tickers.length
    ? `${plan.dates.join(",")}|${plan.tickers.join(",")}`
    : "";

  useEffect(() => {
    if (!planKey) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchTickerPricesForDates(plan.dates, plan.tickers)
      .then((r) => {
        if (!cancelled) setPricesByDate(r);
      })
      .catch((err: unknown) => {
        // fail-closed: 받지 못한 가격은 point 를 만들지 않는 쪽으로 끝난다(0원으로 계산하지 않는다).
        console.error("[kaw] 월말 carry-forward 시세 조회 실패:", err);
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const points = useMemo(
    () =>
      enabled
        ? buildCarryForwardPoints({
            history, cashflows, cashflowKey, library, safeAssetMix, pricesByDate, nowMonth: month,
          })
        : [],
    [enabled, history, cashflows, cashflowKey, library, safeAssetMix, pricesByDate, month],
  );

  return { points, loading, error };
}
