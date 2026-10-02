import { describe, it, expect } from "vitest";
import {
  computeGrowthBacktest,
  depositScheduleFor,
  BACKTEST_SCHEMA_VERSION,
  SAFE_MIX_ACCOUNTS,
  SAFE_MIX_WEIGHT,
  accountUsesSafeAssetMix,
} from "./backtest";
import { BUILTIN_TICKERS, ASSET_ORDER, type AssetKey } from "./constants";
import type { CashflowEntry } from "./cashflow";
import type { HistoryEntry } from "./store";

const entry = (date: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `h-${date}`,
  date,
  baseAmount: 0,
  totalValue: 0,
  deposit: 0,
  returnPct: null,
  ...over,
});

const flow = (date: string, amount: number): CashflowEntry => ({
  id: `c-${date}-${amount}`,
  date,
  amount,
  type: amount >= 0 ? "deposit" : "withdrawal",
});

/** 모든 자산이 같은 가격인 날짜 행 */
const flatPrices = (price: number, except: Partial<Record<AssetKey, number | undefined>> = {}) =>
  Object.fromEntries(
    ASSET_ORDER.map((k) => [k, k in except ? except[k] : price]).filter(([, v]) => v !== undefined),
  ) as Partial<Record<AssetKey, number>>;

describe("depositScheduleFor", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02", { deposit: 111 })];

  it("장부가 있으면 (직전 시점, 이 시점] 구간의 순입금을 쓴다 — history.deposit 은 보지 않는다", () => {
    const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-01-20", 500_000), flow("2026-02-02", 300_000)];
    expect(depositScheduleFor(history, cashflows)).toEqual([1_000_000, 800_000]);
  });

  it("출금은 음수로 그대로 반영한다", () => {
    const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-01-15", -200_000)];
    expect(depositScheduleFor(history, cashflows)).toEqual([1_000_000, -200_000]);
  });

  it("마지막 시점 이후의 입금은 아직 투자되지 않았으므로 제외한다", () => {
    const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-03-25", 700_000)];
    expect(depositScheduleFor(history, cashflows)).toEqual([1_000_000, 0]);
  });

  it("장부가 없으면 기존 조각(baseAmount + deposit)으로 폴백한다", () => {
    expect(depositScheduleFor(history, undefined)).toEqual([1_000_000, 111]);
    expect(depositScheduleFor(history, [])).toEqual([1_000_000, 111]);
  });
});

describe("computeGrowthBacktest", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02", { deposit: 111 })];
  const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-02-02", 500_000)];
  const prices = { "2026-01-02": flatPrices(1000), "2026-02-02": flatPrices(1000) };

  it("누적 납입원금을 장부에서 가져온다 (history.deposit=111 이 아니라 500,000 입금)", () => {
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    expect(points[0].totalValue).toBe(1_000_000);
    expect(points[1].totalValue).toBe(1_500_000);
    expect(points[1].returnPct).toBe(0); // 가격이 그대로니 원금 대비 0%
    expect(points[1].schemaVersion).toBe(BACKTEST_SCHEMA_VERSION);
  });

  it("현금성자산도 성장형 비중(5%)대로 매수된다 — 정정된 종목코드 449170", () => {
    expect(BUILTIN_TICKERS.cash).toBe("449170");
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    expect(points[0].units.cash).toBeCloseTo((1_000_000 * 0.05) / 1000, 6);
  });

  it("안전자산 혼합이 없으면 지수 100% 그대로다", () => {
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    expect(points[0].kospiUnits).toBeCloseTo(1_000_000 / 1000, 6);
    expect(points[0].kospiSafeUnits).toBe(0);
    expect(points[0].sp500SafeUnits).toBe(0);
  });

  it("퇴직연금/IRP 안전자산 30% 다리가 실제로 생성된다 (코스피=국고채30년, S&P500=438080)", () => {
    const safePrices = { "2026-01-02": 2000, "2026-02-02": 2000 };
    const points = computeGrowthBacktest(history, prices, safePrices, cashflows);

    // 코스피200 비교선: 지수 70% + 국고채30년 30%
    expect(points[0].kospiUnits).toBeCloseTo((1_000_000 * (1 - SAFE_MIX_WEIGHT)) / 1000, 6);
    expect(points[0].kospiSafeUnits).toBeCloseTo((1_000_000 * SAFE_MIX_WEIGHT) / 1000, 6);
    // S&P500 비교선: 지수 70% + 혼합형 ETF 30% (단가 2,000원이라 유닛은 절반)
    expect(points[0].sp500Units).toBeCloseTo((1_000_000 * (1 - SAFE_MIX_WEIGHT)) / 1000, 6);
    expect(points[0].sp500SafeUnits).toBeCloseTo((1_000_000 * SAFE_MIX_WEIGHT) / 2000, 6);

    // 두 번째 시점에도 입금(50만)이 70/30 으로 재배분된다
    expect(points[1].kospiUnits).toBeCloseTo((1_500_000 * (1 - SAFE_MIX_WEIGHT)) / 1000, 6);
    expect(points[1].kospiSafeUnits).toBeCloseTo((1_500_000 * SAFE_MIX_WEIGHT) / 1000, 6);
    expect(points[1].kospi200Pct).toBe(0);
    expect(points[1].sp500Pct).toBe(0);
  });

  it("안전자산 다리에 가격이 없으면 그 30%가 증발하지 않고 지수로 재배분된다", () => {
    // 국고채30년 상장 전이라 가격이 없는 상황
    const noKtb = {
      "2026-01-02": flatPrices(1000, { ktb30: undefined }),
      "2026-02-02": flatPrices(1000, { ktb30: undefined }),
    };
    const points = computeGrowthBacktest(history, noKtb, { "2026-01-02": undefined, "2026-02-02": undefined }, cashflows);
    expect(points[0].kospiSafeUnits).toBe(0);
    expect(points[0].kospiUnits).toBeCloseTo(1_000_000 / 1000, 6); // 70만이 아니라 100만 전액
    expect(points[0].sp500Units).toBeCloseTo(1_000_000 / 1000, 6);
    expect(points[1].kospi200Pct).toBe(0); // 30% 가 사라져 -30% 로 보이지 않는다
    expect(points[1].sp500Pct).toBe(0);
  });

  it("가격이 오르면 안전자산 다리까지 합산해 수익률이 난다", () => {
    const up = { "2026-01-02": flatPrices(1000), "2026-02-02": flatPrices(1100) };
    const safePrices = { "2026-01-02": 1000, "2026-02-02": 1100 };
    const points = computeGrowthBacktest(history, up, safePrices, cashflows);
    // 1,000,000 → 1,100,000 (+10%) 후 500,000 입금 = 1,600,000 / 원금 1,500,000
    expect(points[1].kospi200Pct).toBeCloseTo(6.67, 2);
    expect(points[1].sp500Pct).toBeCloseTo(6.67, 2);
    expect(points[1].returnPct).toBeCloseTo(6.67, 2);
  });
});

describe("안전자산 혼합 대상 계좌", () => {
  it("퇴직연금/IRP 만 해당한다", () => {
    expect([...SAFE_MIX_ACCOUNTS]).toEqual(["retirement", "irp"]);
    expect(accountUsesSafeAssetMix("retirement")).toBe(true);
    expect(accountUsesSafeAssetMix("irp")).toBe(true);
    expect(accountUsesSafeAssetMix("isa")).toBe(false);
    expect(accountUsesSafeAssetMix("pension")).toBe(false);
  });
});
