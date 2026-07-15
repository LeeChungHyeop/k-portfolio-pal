import { useEffect, useMemo, useState } from "react";
import { ASSET_ORDER, PROFILE_PRESETS, type AssetKey } from "./constants";
import { BUILTIN_TICKERS, type HistoryEntry } from "./store";

// 계산 로직이 바뀔 때마다 올려서, 이전 버전 로직으로 저장된 backtestGrowth를 자동으로 재계산 대상으로 표시한다.
// v2: 가격 데이터가 없는 자산(상장 전 등)의 비중이 재배분 없이 그냥 증발하던 버그 수정
export const BACKTEST_SCHEMA_VERSION = 2;

// 계좌 히스토리 한 시점에 저장해 두는 "성장형으로 쭉 운용했다면"의 스냅샷.
// 리밸런싱 시점마다 한 번만 계산해서 HistoryEntry에 영구 저장해 두고,
// 이후에는 새로 생긴 날짜만 계산하면 되도록 한다 (매번 전체 재계산 방지).
export interface BacktestGrowth {
  totalValue: number;
  returnPct: number | null;
  units: Partial<Record<AssetKey, number>>; // 다음 시점 드리프트 계산을 위한 보유 유닛 스냅샷
  kospi200Pct: number | null; // 실제와 같은 시점·같은 금액을 코스피200(KIWOOM 200TR)에 매번 넣었다면의 누적수익률
  sp500Pct: number | null; // 실제와 같은 시점·같은 금액을 S&P500(TIGER 미국S&P500, KRW 환산)에 매번 넣었다면의 누적수익률
  kospiUnits: number; // 다음 시점 드리프트 및 실시간 "현재" 포인트 계산용 보유 유닛 스냅샷
  sp500Units: number;
  schemaVersion: number;
}

interface DatedBacktestPoint extends BacktestGrowth {
  date: string;
}

// 단일 자산에 실제와 동일한 입금 스케줄(baseAmount/deposit)을 그대로 매번 몰아넣었다면을 시뮬레이션.
// 코스피200/S&P500 비교선에 쓰는데, "계좌 시작일에 한 번에 사서 보유"가 아니라 "낼 때마다 그 지수를 샀다면"으로
// 계산해야 실제/성장형 라인과 같은 기준(납입 타이밍 반영)으로 비교가 가능하다.
function computeSingleAssetBacktest(
  sorted: HistoryEntry[],
  pricesByDate: Record<string, Partial<Record<AssetKey, number>>>,
  assetKey: AssetKey,
): { pct: number | null; units: number }[] {
  let units = 0;
  let cumDeposit = 0;
  let lastValue = 0; // 가격 데이터가 일시적으로 없을 때 직전 평가액을 유지하기 위한 폴백 (0으로 리셋되지 않도록)
  return sorted.map((h, i) => {
    const price = pricesByDate[h.date]?.[assetKey] ?? 0;
    const depositAmt = i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
    cumDeposit += depositAmt;
    const driftedValue = price > 0 ? units * price : lastValue;
    const totalValue = driftedValue + depositAmt;
    units = price > 0 ? totalValue / price : units;
    lastValue = totalValue;
    const pct = cumDeposit > 0 ? Math.round(((totalValue - cumDeposit) / cumDeposit) * 10000) / 100 : null;
    return { pct, units };
  });
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
  // 특정 날짜에 시세 조회가 안 될 때(신규 상장 전 등) 드리프트 평가에 쓸 직전 알려진 가격
  const lastKnownPrice: Partial<Record<AssetKey, number>> = {};
  let cumDeposit = 0;

  const kospiPoints = computeSingleAssetBacktest(sorted, pricesByDate, "kr");
  const sp500Points = computeSingleAssetBacktest(sorted, pricesByDate, "us");

  return sorted.map((h, i) => {
    const prices = pricesByDate[h.date] ?? {};

    // 이전 시점 보유 유닛을 오늘 가격(없으면 직전 알려진 가격)으로 평가 — 상장 전이라 가격이 없다고
    // 이미 보유 중인 자산의 가치를 0으로 취급하면 안 되므로 폴백을 둔다.
    const driftedValue = ASSET_ORDER.reduce((sum, key) => {
      const heldUnits = units[key] ?? 0;
      if (heldUnits <= 0) return sum;
      const p = (prices[key] ?? 0) > 0 ? prices[key]! : (lastKnownPrice[key] ?? 0);
      return sum + heldUnits * p;
    }, 0);

    const depositAmt = i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
    cumDeposit += depositAmt;
    const totalValue = driftedValue + depositAmt;

    // 성장형 비중으로 재배분 — 이번 시점에 가격이 없는 자산(상장 전 등)은 매수하지 못하므로,
    // 그 비중만큼 돈이 증발하지 않도록 가격이 있는 나머지 자산끼리 비중을 비례 재분배한다.
    const availableKeys = ASSET_ORDER.filter((key) => (prices[key] ?? 0) > 0);
    const availableWeightSum = availableKeys.reduce((sum, key) => sum + (weights[key] ?? 0), 0);
    ASSET_ORDER.forEach((key) => {
      const p = prices[key] ?? 0;
      if (p <= 0) return; // 가격 없음 — 이 시점엔 매수 안 함 (기존 보유량 그대로 유지)
      lastKnownPrice[key] = p;
      const adjustedWeight = availableWeightSum > 0 ? ((weights[key] ?? 0) / availableWeightSum) * 100 : 0;
      const targetValue = (totalValue * adjustedWeight) / 100;
      units[key] = targetValue / p;
    });

    const returnPct =
      cumDeposit > 0 ? Math.round(((totalValue - cumDeposit) / cumDeposit) * 10000) / 100 : null;

    return {
      date: h.date,
      totalValue,
      returnPct,
      units: { ...units },
      kospi200Pct: kospiPoints[i].pct,
      sp500Pct: sp500Points[i].pct,
      kospiUnits: kospiPoints[i].units,
      sp500Units: sp500Points[i].units,
      schemaVersion: BACKTEST_SCHEMA_VERSION,
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
    const { totalValue, returnPct, units, kospi200Pct, sp500Pct, kospiUnits, sp500Units, schemaVersion } = points[i];
    result[h.id] = { totalValue, returnPct, units, kospi200Pct, sp500Pct, kospiUnits, sp500Units, schemaVersion };
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

  // backtestGrowth가 아예 없거나, 현재 계산 로직 버전(BACKTEST_SCHEMA_VERSION)보다 낮은 버전으로 저장된 경우 재계산 대상
  const missingKey = useMemo(
    () =>
      history
        .filter((h) => !h.backtestGrowth || h.backtestGrowth.schemaVersion !== BACKTEST_SCHEMA_VERSION)
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
