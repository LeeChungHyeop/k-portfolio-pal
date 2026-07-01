import { useEffect, useMemo, useState } from "react";
import { ASSET_ORDER, PROFILE_PRESETS, type AccountId, type AssetKey } from "./constants";
import { BUILTIN_TICKERS, type HistoryEntry } from "./store";

export interface BacktestPoint {
  date: string;
  totalValue: number;
  returnPct: number | null;
}

// 계좌의 실제 입금 흐름(baseAmount/deposit)은 그대로 두고, 매 리밸런싱 시점마다
// "성장형" 고정 비중으로 전량 재배분했다고 가정한 가상 계좌를 시뮬레이션한다.
export function computeGrowthBacktest(
  history: HistoryEntry[],
  pricesByDate: Record<string, Partial<Record<AssetKey, number>>>,
): BacktestPoint[] {
  const weights = PROFILE_PRESETS.growth;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const units: Partial<Record<AssetKey, number>> = {};
  let cumDeposit = 0;

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

    return { date: h.date, totalValue, returnPct };
  });
}

// ── 과거 종가 조회 + localStorage 캐싱 ──────────────────────────────────────
const PRICE_CACHE_KEY = "kaw.backtest.prices.v1";

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
export async function fetchHistoricalPrices(
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

// 계좌들의 히스토리 날짜를 모아 한 번에 과거 종가를 조회하는 훅
export function useGrowthBacktestPrices(historiesByAccount: Record<AccountId, HistoryEntry[]>) {
  const [pricesByDate, setPricesByDate] = useState<
    Record<string, Partial<Record<AssetKey, number>>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const datesKey = useMemo(() => {
    const set = new Set<string>();
    Object.values(historiesByAccount).forEach((h) => h.forEach((e) => set.add(e.date)));
    return [...set].sort().join(",");
  }, [historiesByAccount]);

  useEffect(() => {
    if (!datesKey) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchHistoricalPrices(datesKey.split(","))
      .then((res) => {
        if (!cancelled) setPricesByDate(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [datesKey]);

  return { pricesByDate, loading, error };
}
