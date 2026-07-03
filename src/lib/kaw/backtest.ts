import { useEffect, useMemo, useState } from "react";
import { ASSET_ORDER, PROFILE_PRESETS, type AssetKey } from "./constants";
import { BUILTIN_TICKERS, type HistoryEntry } from "./store";

// 계좌 히스토리 한 시점에 저장해 두는 "성장형으로 쭉 운용했다면"의 스냅샷.
// 리밸런싱 시점마다 한 번만 계산해서 HistoryEntry에 영구 저장해 두고,
// 이후에는 새로 생긴 날짜만 계산하면 되도록 한다 (매번 전체 재계산 방지).
export interface BacktestGrowth {
  totalValue: number;
  returnPct: number | null;
  units: Partial<Record<AssetKey, number>>; // 다음 시점 드리프트 계산을 위한 보유 유닛 스냅샷
  kospi200Pct: number | null; // 계좌 시작일 대비 코스피200(KIWOOM 200TR) 등락률
  sp500Pct: number | null; // 계좌 시작일 대비 S&P500(TIGER 미국S&P500, KRW 환산) 등락률
}

interface DatedBacktestPoint extends BacktestGrowth {
  date: string;
}

// 계좌의 실제 입금 흐름(baseAmount/deposit)은 그대로 두고, 매 리밸런싱 시점마다
// "성장형" 고정 비중으로 전량 재배분했다고 가정한 가상 계좌를 시뮬레이션한다.
export function computeGrowthBacktest(
  history: HistoryEntry[],
  pricesByDate: Record<string, Partial<Record<AssetKey, number>>>,
): DatedBacktestPoint[] {
  const weights = PROFILE_PRESETS.growth;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const units: Partial<Record<AssetKey, number>> = {};
  let cumDeposit = 0;

  // 지수 등락률 기준선: 계좌 시작일의 코스피200/S&P500 프록시 가격
  const basePrices = sorted.length ? (pricesByDate[sorted[0].date] ?? {}) : {};
  const baseKospi = basePrices.kr;
  const baseSp500 = basePrices.us;
  const pctSince = (base: number | undefined, cur: number | undefined) =>
    base && base > 0 && cur && cur > 0 ? Math.round(((cur - base) / base) * 10000) / 100 : null;

  return sorted.map((h, i) => {
    const prices = pricesByDate[h.date] ?? {};

    // 이전 시점 보유 유닛을 오늘 가격으로 평가 (다음 리밸런싱 전까지의 드리프트 반영)
    const driftedValue = ASSET_ORDER.reduce(
      (sum, key) => sum + (units[key] ?? 0) * (prices[key] ?? 0),
      0,
    );

    const depositAmt = i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
    cumDeposit += depositAmt;
    const totalValue = driftedValue + depositAmt;

    // 성장형 비중으로 전량 재배분
    ASSET_ORDER.forEach((key) => {
      const p = prices[key] ?? 0;
      const targetValue = (totalValue * (weights[key] ?? 0)) / 100;
      units[key] = p > 0 ? targetValue / p : (units[key] ?? 0);
    });

    const returnPct =
      cumDeposit > 0 ? Math.round(((totalValue - cumDeposit) / cumDeposit) * 10000) / 100 : null;

    return {
      date: h.date,
      totalValue,
      returnPct,
      units: { ...units },
      kospi200Pct: pctSince(baseKospi, prices.kr),
      sp500Pct: pctSince(baseSp500, prices.us),
    };
  });
}

// ── 과거 종가 조회 + localStorage 캐싱 ──────────────────────────────────────
// v2: 과거 종가 페이지 추정 버그 수정 이전에 브라우저에 저장된 실패(0원) 캐시를 무효화하기 위해 버전업
const PRICE_CACHE_KEY = "kaw.backtest.prices.v2";

function loadPriceCache(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePriceCache(cache: Record<string, Record<string, number>>) {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 저장 실패는 무시 */
  }
}

// 계좌 시작일의 코스피200/S&P500 프록시 기준가를 캐시에서 조회 (이미 syncGrowthBacktest가 채워둔 캐시를 재사용, 추가 네트워크 요청 없음)
export function getCachedIndexBasePrices(startDate: string): { kr?: number; us?: number } {
  const byTicker = loadPriceCache()[startDate] ?? {};
  const krTicker = BUILTIN_TICKERS.kr;
  const usTicker = BUILTIN_TICKERS.us;
  return {
    kr: krTicker ? byTicker[krTicker] : undefined,
    us: usTicker ? byTicker[usTicker] : undefined,
  };
}

const GROWTH_TICKERS = ASSET_ORDER.map((k) => BUILTIN_TICKERS[k]).filter((t): t is string => !!t);

async function fetchPricesForDate(date: string): Promise<Record<string, number>> {
  const res = await fetch("/api/naver/history-price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tickers: GROWTH_TICKERS, date: date.replace(/-/g, "") }),
  });
  const data = (await res.json()) as { results?: Record<string, { price: number }> };
  const byTicker: Record<string, number> = {};
  for (const [ticker, r] of Object.entries(data.results ?? {})) byTicker[ticker] = r.price;
  return byTicker;
}

// 주어진 날짜들에 대해 자산별 과거 종가를 가져온다 (캐시 우선, 결측치는 직전 값으로 보정)
async function fetchHistoricalPrices(
  dates: string[],
): Promise<Record<string, Partial<Record<AssetKey, number>>>> {
  const sortedDates = [...new Set(dates)].sort();
  const cache = loadPriceCache();
  const missingDates = sortedDates.filter((d) => !cache[d]);

  for (const date of missingDates) {
    cache[date] = await fetchPricesForDate(date);
  }
  if (missingDates.length) savePriceCache(cache);

  const lastKnown: Partial<Record<AssetKey, number>> = {};
  const result: Record<string, Partial<Record<AssetKey, number>>> = {};
  for (const date of sortedDates) {
    const byTicker = cache[date] ?? {};
    const byAsset: Partial<Record<AssetKey, number>> = {};
    for (const key of ASSET_ORDER) {
      const ticker = BUILTIN_TICKERS[key];
      const p = ticker ? byTicker[ticker] : undefined;
      const value = p && p > 0 ? p : lastKnown[key];
      if (value) {
        byAsset[key] = value;
        lastKnown[key] = value;
      }
    }
    result[date] = byAsset;
  }
  return result;
}

// 계좌 히스토리 전체에 대해 성장형 백테스트를 계산해 entryId → 결과 맵으로 반환.
// 날짜별 종가는 로컬 캐시를 거치므로, 이미 계산된 적 있는 날짜는 네트워크 호출 없이 즉시 처리된다.
export async function syncGrowthBacktest(
  history: HistoryEntry[],
): Promise<Record<string, BacktestGrowth>> {
  if (!history.length) return {};
  const pricesByDate = await fetchHistoricalPrices(history.map((h) => h.date));
  const points = computeGrowthBacktest(history, pricesByDate);
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const result: Record<string, BacktestGrowth> = {};
  sorted.forEach((h, i) => {
    const { totalValue, returnPct, units, kospi200Pct, sp500Pct } = points[i];
    result[h.id] = { totalValue, returnPct, units, kospi200Pct, sp500Pct };
  });
  return result;
}

// 히스토리 중 backtestGrowth가 없는 항목이 있으면 (신규 계좌 또는 과거 백필 대상)
// 한 번만 조용히 계산해서 onResult로 넘겨준다.
export function useEnsureGrowthBacktest(
  history: HistoryEntry[],
  onResult: (updates: Record<string, BacktestGrowth>) => void,
) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(false);

  // backtestGrowth가 아예 없거나, 코스피200/S&P500 필드 추가 이전 버전(구 스키마)으로 저장된 경우 재계산 대상
  const missingKey = useMemo(
    () =>
      history
        .filter((h) => !h.backtestGrowth || h.backtestGrowth.kospi200Pct === undefined)
        .map((h) => h.id)
        .join(","),
    [history],
  );

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    setSyncing(true);
    setError(false);
    syncGrowthBacktest(history)
      .then((result) => {
        if (!cancelled) onResult(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  return { syncing, error };
}
