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
  /**
   * 이 값을 계산할 때 쓴 cashflow 장부의 지문(`cashflowFingerprint`).
   * 지금 장부의 지문과 다르면 schemaVersion 이 같아도 다시 계산해야 한다 — 그래야 과거 입금을
   * 보정했을 때 실제수익률(장부에서 즉시 계산)과 비교선(저장값)이 서로 다른 원금을 쓰지 않는다.
   * v4 이전에 저장된 값에는 이 필드가 없다(undefined → 한 번 재계산된 뒤 채워진다).
   */
  cashflowKey?: string;
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

/** 장부가 없어 history 조각으로 폴백한 상태를 가리키는 지문. 폴백 의미를 지문 쪽에서도 유지한다. */
export const LEGACY_CASHFLOW_KEY = "legacy";

/**
 * 저장된 백테스트를 다시 계산해야 하는지 판정하기 위한 **장부 지문**.
 *
 * 담는 값은 benchmark 계산에 실제로 영향을 주는 것만이다:
 *   - `date`   — 어느 시점에 투입된 돈인지 (시점별 투입액과 누적원금이 달라진다)
 *   - `amount` — 얼마인지
 *   - `timing` — 장마감 후 입금은 그 날 장중에 쓸 수 없다. 지금 계산은 날짜만 보지만
 *                귀속 구간 규칙(performance.ts)과 같은 입력이라 지문에 포함해 둔다.
 * `id` / `source` / `note` 는 담지 않는다 — 메모만 고쳤다고 재계산할 이유가 없다.
 *
 * 배열 순서에 흔들리지 않도록 조합한 문자열을 정렬한다. `timing` 미지정은 performance.ts 와
 * 같은 규칙으로 `same_day` 로 정규화한다(나중에 명시값이 붙어도 지문이 바뀌지 않는다).
 */
export function cashflowFingerprint(cashflows: readonly CashflowEntry[] | undefined): string {
  if (!cashflows?.length) return LEGACY_CASHFLOW_KEY;
  return cashflows
    .map((c) => `${c.date}|${c.amount}|${c.timing ?? "same_day"}`)
    .sort()
    .join(",");
}

// 여러 자산을 고정 비중으로 섞어(예: 지수 70% + 안전자산 30%) 실제와 동일한 입금 스케줄로 매번
// 재배분해 샀다면을 시뮬레이션. leg 가 하나면 단일 자산(100%), 여럿이면 비중대로 나눠 담는다.
function computeWeightedBacktest(
  sorted: HistoryEntry[],
  depositAmts: number[],
  legs: { weight: number; priceOf: (date: string) => number | undefined }[],
): { pct: number | null; units: number[] }[] {
  const units = legs.map(() => 0);
  const lastKnownPrice = legs.map(() => 0);
  let cumDeposit = 0;
  let lastValue = 0; // 모든 다리의 가격이 없을 때 직전 평가액을 유지하기 위한 폴백
  return sorted.map((h, i) => {
    const depositAmt = depositAmts[i] ?? 0;
    cumDeposit += depositAmt;
    // 이 시점에 쓸 다리별 가격. 조회가 안 된 다리는 **직전에 알려진 가격**으로 평가한다 —
    // 이미 보유 중인 다리를 0원으로 취급하면 그 비중만큼 평가액이 꺼졌다가 다음 시점에 되살아난다
    // (운영 경로는 fetchHistoricalPrices 가 이미 carry-forward 하지만, 여기서도 자체적으로 막는다).
    // 한 번도 가격이 없었던 다리(상장 전)는 0이며, 그건 아래에서 비중 재배분으로 처리된다.
    const priceAt = legs.map((leg, li) => {
      const p = leg.priceOf(h.date) ?? 0;
      if (p > 0) lastKnownPrice[li] = p;
      return p > 0 ? p : lastKnownPrice[li];
    });
    const anyPriced = priceAt.some((p) => p > 0);
    const drifted = anyPriced
      ? legs.reduce((sum, _leg, li) => sum + units[li] * priceAt[li], 0)
      : lastValue;
    const totalValue = drifted + depositAmt;
    // 아직 상장 전이라 가격이 한 번도 없었던 다리는 이번 시점에 못 사므로, 그 비중만큼 돈이
    // 증발하지 않도록 가격이 있는 다리끼리 비중을 비례 재배분한다 (단일 자산 비교선과 금액이 맞아야 한다).
    const pricedWeightSum = legs.reduce(
      (sum, leg, li) => sum + (priceAt[li] > 0 ? leg.weight : 0),
      0,
    );
    legs.forEach((leg, li) => {
      if (priceAt[li] > 0 && pricedWeightSum > 0) {
        units[li] = (totalValue * (leg.weight / pricedWeightSum)) / priceAt[li];
      }
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
  const cashflowKey = cashflowFingerprint(cashflows);
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
      cashflowKey,
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
      kospiUnits, sp500Units, kospiSafeUnits, sp500SafeUnits, schemaVersion, cashflowKey,
    } = points[i];
    result[h.id] = {
      totalValue, returnPct, units, kospi200Pct, sp500Pct,
      kospiUnits, sp500Units, kospiSafeUnits, sp500SafeUnits, schemaVersion, cashflowKey,
    };
  });
  return result;
}

/**
 * 저장된 스냅샷이 지금 기준으로 다시 계산되어야 하는가.
 *   - 아예 없음 (신규 계좌 / 과거 백필 대상)
 *   - 계산 로직 버전이 다름 (schemaVersion)
 *   - **계산에 쓴 장부가 지금 장부와 다름** (cashflowKey) — 과거 입금을 보정하면 비교선도 따라와야 한다
 */
export function needsBacktestRecompute(
  entry: HistoryEntry["backtestGrowth"],
  cashflowKey: string,
): boolean {
  if (!entry) return true;
  if (entry.schemaVersion !== BACKTEST_SCHEMA_VERSION) return true;
  return entry.cashflowKey !== cashflowKey;
}

// 히스토리 중 다시 계산해야 할 항목이 있으면 한 번만 조용히 계산해서 onResult로 넘겨준다.
export function useEnsureGrowthBacktest(
  history: HistoryEntry[],
  onResult: (updates: Record<string, BacktestGrowth>) => void,
  { cashflows, safeAssetMix = false }: BacktestContext = {},
) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(false);

  const cashflowKey = useMemo(() => cashflowFingerprint(cashflows), [cashflows]);
  const staleIds = useMemo(
    () =>
      history
        .filter((h) => needsBacktestRecompute(h.backtestGrowth, cashflowKey))
        .map((h) => h.id)
        .join(","),
    [history, cashflowKey],
  );

  // 재계산 트리거. **대상 목록만으로 트리거하면 안 된다** — 장부가 또 바뀌어 대상 목록이 그대로일
  // 때(예: 전 구간이 이미 대상) 새 장부로 다시 돌지 않기 때문이다. 그래서 지문을 같이 넣는다.
  // 대상이 없으면 빈 문자열이라 effect 는 즉시 반환한다. 계산 결과에는 지금 지문이 박혀 저장되므로
  // 다음 render 에서 staleIds 가 비고, setHistoryBacktest → 재계산 loop 는 생기지 않는다.
  const syncKey = staleIds ? `${cashflowKey}|${staleIds}` : "";

  useEffect(() => {
    if (!syncKey) return;
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
  }, [syncKey, safeAssetMix]);

  return { syncing, error };
}
