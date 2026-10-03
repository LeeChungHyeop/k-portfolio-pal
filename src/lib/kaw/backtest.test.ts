import { describe, it, expect } from "vitest";
import {
  computeGrowthBacktest,
  depositScheduleFor,
  cashflowFingerprint,
  needsBacktestRecompute,
  BACKTEST_SCHEMA_VERSION,
  LEGACY_CASHFLOW_KEY,
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

describe("cashflowFingerprint", () => {
  const base: CashflowEntry[] = [
    { id: "a", date: "2026-01-02", amount: 1_000_000, type: "adjustment", source: "migration" },
    { id: "b", date: "2026-01-25", amount: 500_000, type: "deposit", source: "schedule", timing: "after_close" },
  ];

  it("배열 순서가 바뀌어도 같은 지문이다", () => {
    expect(cashflowFingerprint([...base].reverse())).toBe(cashflowFingerprint(base));
  });

  it("금액이 바뀌면 지문이 바뀐다", () => {
    const changed = [base[0], { ...base[1], amount: 600_000 }];
    expect(cashflowFingerprint(changed)).not.toBe(cashflowFingerprint(base));
  });

  it("날짜가 바뀌면 지문이 바뀐다", () => {
    const changed = [base[0], { ...base[1], date: "2026-01-26" }];
    expect(cashflowFingerprint(changed)).not.toBe(cashflowFingerprint(base));
  });

  it("timing 이 바뀌면 지문이 바뀐다", () => {
    const changed = [base[0], { ...base[1], timing: "same_day" as const }];
    expect(cashflowFingerprint(changed)).not.toBe(cashflowFingerprint(base));
  });

  it("timing 미지정은 same_day 로 정규화한다 — 명시값이 붙어도 지문이 그대로다", () => {
    const implicit: CashflowEntry[] = [{ id: "x", date: "2026-02-02", amount: 100, type: "deposit" }];
    const explicit: CashflowEntry[] = [{ ...implicit[0], timing: "same_day" }];
    expect(cashflowFingerprint(implicit)).toBe(cashflowFingerprint(explicit));
  });

  it("id/source/note 만 바뀌면 지문이 같다 — 메모 수정으로 재계산하지 않는다", () => {
    const cosmetic: CashflowEntry[] = [
      { ...base[0], id: "a2", source: "manual", note: "메모 추가" },
      { ...base[1], id: "b2", source: "manual", note: "오타 수정" },
    ];
    expect(cashflowFingerprint(cosmetic)).toBe(cashflowFingerprint(base));
  });

  it("장부가 없거나 비어 있으면 legacy 폴백 지문이다", () => {
    expect(cashflowFingerprint(undefined)).toBe(LEGACY_CASHFLOW_KEY);
    expect(cashflowFingerprint([])).toBe(LEGACY_CASHFLOW_KEY);
  });

  it("중복 기록(같은 날·같은 금액)을 한 건으로 뭉개지 않는다", () => {
    const twice: CashflowEntry[] = [base[0], base[0]];
    expect(cashflowFingerprint(twice)).not.toBe(cashflowFingerprint([base[0]]));
  });
});

describe("needsBacktestRecompute (장부가 바뀌면 비교선도 다시 계산한다)", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02")];
  const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-02-02", 500_000)];
  const prices = { "2026-01-02": flatPrices(1000), "2026-02-02": flatPrices(1000) };

  /** 계산 결과를 history 에 저장한 상태 — 다음 render 가 보는 모양 */
  const stored = (flows: CashflowEntry[] | undefined) => {
    const points = computeGrowthBacktest(history, prices, undefined, flows);
    return history.map((h, i) => ({ ...h, backtestGrowth: points[i] }));
  };

  it("같은 schemaVersion + 같은 지문 → 재계산하지 않는다", () => {
    const key = cashflowFingerprint(cashflows);
    for (const h of stored(cashflows)) {
      expect(h.backtestGrowth.cashflowKey).toBe(key);
      expect(needsBacktestRecompute(h.backtestGrowth, key)).toBe(false);
    }
  });

  it("금액이 바뀌면 재계산한다", () => {
    const next = [cashflows[0], { ...cashflows[1], amount: 700_000 }];
    for (const h of stored(cashflows)) {
      expect(needsBacktestRecompute(h.backtestGrowth, cashflowFingerprint(next))).toBe(true);
    }
  });

  it("날짜가 바뀌면 재계산한다", () => {
    const next = [cashflows[0], { ...cashflows[1], date: "2026-01-25" }];
    for (const h of stored(cashflows)) {
      expect(needsBacktestRecompute(h.backtestGrowth, cashflowFingerprint(next))).toBe(true);
    }
  });

  it("timing 이 바뀌면 재계산한다", () => {
    const next = [cashflows[0], { ...cashflows[1], timing: "after_close" as const }];
    for (const h of stored(cashflows)) {
      expect(needsBacktestRecompute(h.backtestGrowth, cashflowFingerprint(next))).toBe(true);
    }
  });

  it("note/source/id 만 바뀌면 재계산하지 않는다", () => {
    const cosmetic = cashflows.map((c, i) => ({ ...c, id: `z${i}`, source: "manual", note: "메모" }));
    for (const h of stored(cashflows)) {
      expect(needsBacktestRecompute(h.backtestGrowth, cashflowFingerprint(cosmetic))).toBe(false);
    }
  });

  it("재계산 결과에는 새 지문이 박혀서, 다음 render 에서 또 돌지 않는다 (loop 방지)", () => {
    const next = [cashflows[0], { ...cashflows[1], amount: 700_000 }];
    const key = cashflowFingerprint(next);
    const recomputed = stored(next);
    // 1회 재계산으로 전부 최신 상태가 된다 → 다음 render 의 대상 목록은 비어 있다
    expect(recomputed.filter((h) => needsBacktestRecompute(h.backtestGrowth, key))).toHaveLength(0);
    expect(recomputed[1].backtestGrowth.totalValue).toBe(1_700_000);
  });

  it("장부가 없는 legacy 데이터도 한 번 계산하면 다시 돌지 않는다", () => {
    const key = cashflowFingerprint(undefined);
    expect(key).toBe(LEGACY_CASHFLOW_KEY);
    for (const h of stored(undefined)) {
      expect(needsBacktestRecompute(h.backtestGrowth, key)).toBe(false);
    }
  });

  it("v4 이전처럼 지문이 없는 저장값은 한 번 재계산 대상이다", () => {
    const legacyEntry = { ...stored(cashflows)[0].backtestGrowth, cashflowKey: undefined };
    expect(needsBacktestRecompute(legacyEntry, cashflowFingerprint(cashflows))).toBe(true);
    expect(needsBacktestRecompute({ ...legacyEntry, schemaVersion: 3 }, LEGACY_CASHFLOW_KEY)).toBe(true);
    expect(needsBacktestRecompute(undefined, LEGACY_CASHFLOW_KEY)).toBe(true);
  });
});

describe("안전자산 다리 가격이 중간에 한 번 빠지는 경우", () => {
  // production 경로(fetchHistoricalPrices)는 byAsset/byTicker 모두 직전 종가를 carry-forward 하므로
  // 실제로는 구멍이 생기지 않는다. 그 보정이 깨져 구멍이 들어와도 가치가 증발하지 않아야 한다.
  const history = [
    entry("2026-01-02", { baseAmount: 1_000_000 }),
    entry("2026-02-02"),
    entry("2026-03-02"),
  ];
  const cashflows = [flow("2026-01-02", 1_000_000)];

  it("중간 시점에 leg 가격이 없어도 평가액이 0으로 증발하지 않는다", () => {
    const prices = {
      "2026-01-02": flatPrices(1000),
      "2026-02-02": flatPrices(1000, { ktb30: undefined }),
      "2026-03-02": flatPrices(1000),
    };
    const safePrices = { "2026-01-02": 1000, "2026-02-02": undefined, "2026-03-02": 1000 };
    const points = computeGrowthBacktest(history, prices, safePrices, cashflows);

    // 가격이 그대로니 세 시점 모두 원금 그대로여야 한다 (구멍 난 시점에 -30% 가 되지 않는다)
    expect(points[1].kospi200Pct).toBe(0);
    expect(points[1].sp500Pct).toBe(0);
    expect(points[2].kospi200Pct).toBe(0);
    expect(points[2].sp500Pct).toBe(0);
    // 구멍 난 시점에도 직전 종가로 평가·재배분해 70/30 을 유지한다 (유닛이 떠돌지 않는다)
    expect(points[1].kospiUnits).toBeCloseTo((1_000_000 * (1 - SAFE_MIX_WEIGHT)) / 1000, 6);
    expect(points[1].kospiSafeUnits).toBeCloseTo((1_000_000 * SAFE_MIX_WEIGHT) / 1000, 6);
    expect(points[2].kospiUnits).toBeCloseTo((1_000_000 * (1 - SAFE_MIX_WEIGHT)) / 1000, 6);
    expect(points[2].kospiSafeUnits).toBeCloseTo((1_000_000 * SAFE_MIX_WEIGHT) / 1000, 6);
  });
});
