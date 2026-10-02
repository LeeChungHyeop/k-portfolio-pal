import { useEffect, useMemo, useState } from "react";
import { ASSET_ORDER, PROFILE_PRESETS, type AccountId, type AssetKey } from "./constants";
import { BUILTIN_TICKERS, type HistoryEntry } from "./store";
import { principalAsOf, type CashflowEntry } from "./cashflow";

// 계산 로직이 바뀔 때마다 올려서, 이전 버전 로직으로 저장된 backtestGrowth를 자동으로 재계산 대상으로 표시한다.
// v2: 가격 데이터가 없는 자산(상장 전 등)의 비중이 재배분 없이 그냥 증발하던 버그 수정
// v3: 퇴직연금/IRP는 법상 안전자산 30% 이상 편입 의무가 있어, 코스피200/S&P500 비교선도 100% 몰빵이 아니라
//     "지수 70% + 안전자산 30%"로 계산하도록 변경 (퇴직연금/IRP 전용, ISA/연금저축펀드는 기존 100% 그대로)
// v4: (1) 현금성자산 종목코드 오류(429000 → 449170) 정정 전에 계산된 값 무효화,
//     (2) 누적 납입원금을 history.deposit 조각이 아니라 **cashflow 장부**에서 가져오도록 변경,
//     (3) 안전자산 다리에 가격이 없을 때 그 30%가 증발하던 문제 수정(남은 다리로 비중 재배분)
export const BACKTEST_SCHEMA_VERSION = 4;

// 퇴직연금/IRP는 법상 안전자산(위험자산 아닌 자산) 30% 이상 편입 의무가 있어, 지수 비교선도
// "지수 70% + 안전자산 30%"로 계산한다. ISA/연금저축펀드는 규제 대상이 아니라 지수 100% 그대로다.
// 판정 근거는 이 한 곳뿐이다 — 화면/저장 양쪽이 같은 값을 쓰도록 여기서만 정의한다.
export const SAFE_MIX_ACCOUNTS: readonly AccountId[] = ["retirement", "irp"];
export const SAFE_MIX_WEIGHT = 0.3;
export const accountUsesSafeAssetMix = (id: AccountId): boolean => SAFE_MIX_ACCOUNTS.includes(id);

// 퇴직연금/IRP의 S&P500 비교선에서 안전자산 30%로 편입한다고 가정하는 종목 — 우리 자산 라이브러리의
// 9개 기본 자산에 없는 별도 종목이라 티커를 직접 지정한다 (ACE 미국S&P500미국채혼합50액티브).
export const SAFE_MIX_SP500_TICKER = "438080";
// 코스피200 비교선의 안전자산 30%는 이미 기본 자산에 있는 국고채30년(ktb30, RISE KIS국고채30년Enhanced)을 그대로 쓴다.
const SAFE_MIX_KOSPI_ASSET: AssetKey = "ktb30";

// 계좌 히스토리 한 시점에 저장해 두는 "성장형으로 쭉 운용했다면"의 스냅샷.
// 리밸런싱 시점마다 한 번만 계산해서 HistoryEntry에 영구 저장해 두고,
// 이후에는 새로 생긴 날짜만 계산하면 되도록 한다 (매번 전체 재계산 방지).
export interface BacktestGrowth {
  totalValue: number;
  returnPct: number | null;
  units: Partial<Record<AssetKey, number>>; // 다음 시점 드리프트 계산을 위한 보유 유닛 스냅샷
  kospi200Pct: number | null; // 실제와 같은 시점·같은 금액을 코스피200(KIWOOM 200TR)에 매번 넣었다면의 누적수익률
  sp500Pct: number | null; // 실제와 같은 시점·같은 금액을 S&P500(TIGER 미국S&P500, KRW 환산)에 매번 넣었다면의 누적수익률
  kospiUnits: number; // 다음 시점 드리프트 및 실시간 "현재" 포인트 계산용 보유 유닛 스냅샷 (지수 쪽 비중)
  sp500Units: number;
  kospiSafeUnits: number; // 퇴직연금/IRP 전용 — 코스피200 비교선의 안전자산(30%, 국고채30년) 보유 유닛
  sp500SafeUnits: number; // 퇴직연금/IRP 전용 — S&P500 비교선의 안전자산(30%, ACE 미국S&P500미국채혼합50액티브) 보유 유닛
  schemaVersion: number;
}

interface DatedBacktestPoint extends BacktestGrowth {
  date: string;
}

// ── 시점별 투입 원금 ───────────────────────────────────────────────────────
//
// 누적 납입원금의 유일한 근거는 **cashflow 장부**다 (cashflow.ts §1). history.deposit 은
// 리밸런싱 기록의 메모일 뿐이고, 리밸런싱 사이에 들어온 입금이나 출금은 담지 못한다.
//
// 각 리밸런싱 시점에 "그때 새로 들어온 돈"은 (직전 시점, 이 시점] 구간의 순입금이며,
// 첫 시점은 그 날짜까지의 전부(= 시작 보유자산 포함)다. 마지막 시점 이후의 입금은
// 아직 투자되지 않은 돈이므로 여기에 넣지 않는다 — 화면의 "현재" 포인트에서 예수금으로 더한다.
//
// 장부가 없으면(옛 데이터·단위테스트) 기존 조각으로 폴백한다.
export function depositScheduleFor(
  sorted: readonly HistoryEntry[],
  cashflows: readonly CashflowEntry[] | undefined,
): number[] {
  if (!cashflows?.length) {
    return sorted.map((h, i) => (i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0)));
  }
  let prev = 0;
  return sorted.map((h) => {
    const upTo = principalAsOf(cashflows, h.date);
    const amt = upTo - prev;
    prev = upTo;
    return amt;
  });
}

// 여러 자산을 고정 비중으로 섞어(예: 지수 70% + 안전자산 30%) 실제와 동일한 입금 스케줄로 매번
// 재배분해 샀다면을 시뮬레이션. leg 가 하나면 단일 자산(100%), 여럿이면 비중대로 나눠 담는다.
function computeWeightedBacktest(
  sorted: HistoryEntry[],
  depositAmts: number[],
  legs: { weight: number; priceOf: (date: string) => number | undefined }[],
): { pct: number | null; units: number[] }[] {
  const units = legs.map(() => 0);
  let cumDeposit = 0;
  let lastValue = 0; // 가격 데이터가 일시적으로 없을 때 직전 평가액을 유지하기 위한 폴백
  return sorted.map((h, i) => {
    const depositAmt = depositAmts[i] ?? 0;
    cumDeposit += depositAmt;
    const anyPriced = legs.some((leg) => (leg.priceOf(h.date) ?? 0) > 0);
    const drifted = anyPriced
      ? legs.reduce((sum, leg, li) => sum + units[li] * (leg.priceOf(h.date) ?? 0), 0)
      : lastValue;
    const totalValue = drifted + depositAmt;
    // 가격이 없는 다리(상장 전 등)는 이번 시점에 못 사므로, 그 비중만큼 돈이 증발하지 않도록
    // 가격이 있는 다리끼리 비중을 비례 재배분한다 (단일 자산 비교선과 금액이 맞아야 한다).
    const pricedWeightSum = legs.reduce(
      (sum, leg) => sum + ((leg.priceOf(h.date) ?? 0) > 0 ? leg.weight : 0),
      0,
    );
    legs.forEach((leg, li) => {
      const p = leg.priceOf(h.date) ?? 0;
      if (p > 0 && pricedWeightSum > 0) units[li] = (totalValue * (leg.weight / pricedWeightSum)) / p;
    });
    lastValue = totalValue;
    const pct = cumDeposit > 0 ? Math.round(((totalValue - cumDeposit) / cumDeposit) * 10000) / 100 : null;
    return { pct, units: [...units] };
  });
}

// 계좌의 실제 입금 흐름(baseAmount/deposit)은 그대로 두고, 매 리밸런싱 시점마다
// "성장형" 고정 비중으로 전량 재배분했다고 가정한 가상 계좌를 시뮬레이션한다.
// safeAssetMixPrices가 주어지면(퇴직연금/IRP) 코스피200/S&P500 비교선을 "지수 70% + 안전자산 30%"로 계산한다.
export function computeGrowthBacktest(
  history: HistoryEntry[],
  pricesByDate: Record<string, Partial<Record<AssetKey, number>>>,
  safeAssetMixPrices?: Record<string, number | undefined>,
  cashflows?: readonly CashflowEntry[],
): DatedBacktestPoint[] {
  const weights = PROFILE_PRESETS.growth;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const depositAmts = depositScheduleFor(sorted, cashflows);
  const units: Partial<Record<AssetKey, number>> = {};
  // 특정 날짜에 시세 조회가 안 될 때(신규 상장 전 등) 드리프트 평가에 쓸 직전 알려진 가격
  const lastKnownPrice: Partial<Record<AssetKey, number>> = {};
  let cumDeposit = 0;

  const useSafeMix = !!safeAssetMixPrices;
  const kospiLegs = useSafeMix
    ? [
        { weight: 1 - SAFE_MIX_WEIGHT, priceOf: (d: string) => pricesByDate[d]?.kr },
        { weight: SAFE_MIX_WEIGHT, priceOf: (d: string) => pricesByDate[d]?.[SAFE_MIX_KOSPI_ASSET] },
      ]
    : [{ weight: 1, priceOf: (d: string) => pricesByDate[d]?.kr }];
  const sp500Legs = useSafeMix
    ? [
        { weight: 1 - SAFE_MIX_WEIGHT, priceOf: (d: string) => pricesByDate[d]?.us },
        { weight: SAFE_MIX_WEIGHT, priceOf: (d: string) => safeAssetMixPrices?.[d] },
      ]
    : [{ weight: 1, priceOf: (d: string) => pricesByDate[d]?.us }];
  const kospiPoints = computeWeightedBacktest(sorted, depositAmts, kospiLegs);
  const sp500Points = computeWeightedBacktest(sorted, depositAmts, sp500Legs);

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

    const depositAmt = depositAmts[i] ?? 0;
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
      kospiUnits: kospiPoints[i].units[0],
      sp500Units: sp500Points[i].units[0],
      kospiSafeUnits: kospiPoints[i].units[1] ?? 0,
      sp500SafeUnits: sp500Points[i].units[1] ?? 0,
      schemaVersion: BACKTEST_SCHEMA_VERSION,
    };
  });
}

// ── 과거 종가 조회 + localStorage 캐싱 ──────────────────────────────────────
// v2: 과거 종가 페이지 추정 버그 수정 이전에 브라우저에 저장된 실패(0원) 캐시를 무효화하기 위해 버전업
// v3: 현금성자산 종목코드가 429000(없는 코드) → 449170 으로 정정됐다. 429000 으로 받아둔 0원 캐시가
//     남아 있으면 현금성자산이 영구히 0원으로 계산되므로 키를 올려 전부 다시 받는다.
const PRICE_CACHE_KEY = "kaw.backtest.prices.v3";

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

async function fetchPricesForDate(date: string, tickers: string[]): Promise<Record<string, number>> {
  const res = await fetch("/api/naver/history-price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tickers, date: date.replace(/-/g, "") }),
  });
  const data = (await res.json()) as { results?: Record<string, { price: number }> };
  const byTicker: Record<string, number> = {};
  for (const [ticker, r] of Object.entries(data.results ?? {})) byTicker[ticker] = r.price;
  return byTicker;
}

// 주어진 날짜들에 대해 자산별 과거 종가를 가져온다 (캐시 우선, 결측치는 직전 값으로 보정).
// extraTickers(퇴직연금/IRP 안전자산 혼합용)는 기본 9종목 캐시에 없으면 그 날짜만 추가로 다시 조회한다.
async function fetchHistoricalPrices(
  dates: string[],
  extraTickers: string[] = [],
): Promise<{ byAsset: Record<string, Partial<Record<AssetKey, number>>>; byTicker: Record<string, Record<string, number>> }> {
  const sortedDates = [...new Set(dates)].sort();
  const cache = loadPriceCache();
  const allTickers = [...new Set([...GROWTH_TICKERS, ...extraTickers])];

  // **날짜 행이 있다는 이유로 건너뛰지 않는다.** 그 날짜 캐시가 만들어진 뒤에 추가되거나 정정된
  // 종목(예: 현금성자산 449170, 퇴직연금 안전자산 438080)은 행 안에 비어 있으므로, 날짜별로
  // "아직 없는 종목만" 모아서 그것만 다시 조회한다.
  // 응답에 없던 종목(상장 전·휴장)은 0 으로 박아두지 않는다 — 네트워크 실패와 구분할 수 없어
  // 잘못된 0 이 영구히 남기 때문이다. 그런 날짜는 다음 방문에도 한 번 더 조회되지만,
  // 읽을 때 직전 종가로 보정되므로 계산 결과는 달라지지 않는다.
  let fetchedAny = false;
  for (const date of sortedDates) {
    const row = cache[date] ?? {};
    const needed = allTickers.filter((t) => row[t] === undefined);
    if (!needed.length) continue;
    const fetched = await fetchPricesForDate(date, needed);
    cache[date] = { ...row, ...fetched };
    fetchedAny = true;
  }
  if (fetchedAny) savePriceCache(cache);

  const lastKnown: Partial<Record<AssetKey, number>> = {};
  const lastKnownExtra: Record<string, number> = {};
  const byAsset: Record<string, Partial<Record<AssetKey, number>>> = {};
  const byTicker: Record<string, Record<string, number>> = {};
  for (const date of sortedDates) {
    const cachedRow = cache[date] ?? {};
    const assetRow: Partial<Record<AssetKey, number>> = {};
    for (const key of ASSET_ORDER) {
      const ticker = BUILTIN_TICKERS[key];
      const p = ticker ? cachedRow[ticker] : undefined;
      const value = p && p > 0 ? p : lastKnown[key];
      if (value) {
        assetRow[key] = value;
        lastKnown[key] = value;
      }
    }
    byAsset[date] = assetRow;

    const tickerRow: Record<string, number> = {};
    for (const t of extraTickers) {
      const p = cachedRow[t];
      const value = p && p > 0 ? p : lastKnownExtra[t];
      if (value) {
        tickerRow[t] = value;
        lastKnownExtra[t] = value;
      }
    }
    byTicker[date] = tickerRow;
  }
  return { byAsset, byTicker };
}

/**
 * 백테스트 계산에 필요한 계좌 맥락. **두 값 모두 계좌에서 가져와야 한다** —
 * `cashflows` 는 누적 납입원금의 유일한 근거이고, `safeAssetMix` 는 퇴직연금/IRP 여부다
 * (`accountUsesSafeAssetMix(accountId)` 로 정한다). 빠뜨리면 저장된 스냅샷이 화면 계산과
 * 어긋나고, schemaVersion 이 같아서 자동 재계산도 되지 않는다.
 */
export interface BacktestContext {
  cashflows?: readonly CashflowEntry[];
  safeAssetMix?: boolean;
}

// 계좌 히스토리 전체에 대해 성장형 백테스트를 계산해 entryId → 결과 맵으로 반환.
// 날짜별 종가는 로컬 캐시를 거치므로, 이미 계산된 적 있는 날짜는 네트워크 호출 없이 즉시 처리된다.
// safeAssetMix=true면 퇴직연금/IRP 규정(안전자산 30% 이상)에 맞춰 코스피200/S&P500 비교선을 지수 70%+안전자산 30%로 계산한다.
export async function syncGrowthBacktest(
  history: HistoryEntry[],
  { cashflows, safeAssetMix = false }: BacktestContext = {},
): Promise<Record<string, BacktestGrowth>> {
  if (!history.length) return {};
  const extraTickers = safeAssetMix ? [SAFE_MIX_SP500_TICKER] : [];
  const { byAsset, byTicker } = await fetchHistoricalPrices(history.map((h) => h.date), extraTickers);
  const safeAssetMixPrices = safeAssetMix
    ? Object.fromEntries(Object.entries(byTicker).map(([date, row]) => [date, row[SAFE_MIX_SP500_TICKER]]))
    : undefined;
  const points = computeGrowthBacktest(history, byAsset, safeAssetMixPrices, cashflows);
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const result: Record<string, BacktestGrowth> = {};
  sorted.forEach((h, i) => {
    const {
      totalValue, returnPct, units, kospi200Pct, sp500Pct,
      kospiUnits, sp500Units, kospiSafeUnits, sp500SafeUnits, schemaVersion,
    } = points[i];
    result[h.id] = {
      totalValue, returnPct, units, kospi200Pct, sp500Pct,
      kospiUnits, sp500Units, kospiSafeUnits, sp500SafeUnits, schemaVersion,
    };
  });
  return result;
}

// 히스토리 중 backtestGrowth가 없는 항목이 있으면 (신규 계좌 또는 과거 백필 대상)
// 한 번만 조용히 계산해서 onResult로 넘겨준다.
export function useEnsureGrowthBacktest(
  history: HistoryEntry[],
  onResult: (updates: Record<string, BacktestGrowth>) => void,
  { cashflows, safeAssetMix = false }: BacktestContext = {},
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
    syncGrowthBacktest(history, { cashflows, safeAssetMix })
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
  }, [missingKey, safeAssetMix]);

  return { syncing, error };
}
