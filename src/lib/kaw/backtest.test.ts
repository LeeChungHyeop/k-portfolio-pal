import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computeGrowthBacktest,
  depositScheduleFor,
  uninvestedCashFor,
  parseHistoryPriceResults,
  isUsablePrice,
  validateHistoricalPricesForBacktest,
  findBacktestResultProblems,
  syncGrowthBacktest,
  isCurrentBacktest,
  currentBacktestOf,
  hasStaleBacktest,
  staleBacktestIds,
  backtestSyncKey,
  BacktestDataError,
  PRICE_CACHE_KEY,
  cashflowFingerprint,
  needsBacktestRecompute,
  BACKTEST_SCHEMA_VERSION,
  LEGACY_CASHFLOW_KEY,
  SAFE_MIX_ACCOUNTS,
  SAFE_MIX_SP500_TICKER,
  SAFE_MIX_WEIGHT,
  accountUsesSafeAssetMix,
} from "./backtest";
import { BUILTIN_TICKERS, ASSET_ORDER, ACCOUNT_IDS, type AccountId, type AssetKey } from "./constants";
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

/** 장마감 후 입금 (퇴직연금 25일) — 그 날 장중에는 쓸 수 없다 */
const afterClose = (date: string, amount: number): CashflowEntry => ({
  ...flow(date, amount),
  timing: "after_close",
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

// ─────────────────────────────────────────────────────────────────────────────
// v6 — benchmark 총액을 반올림된 수익률에서 역산하지 않고 정확한 값으로 저장
// ─────────────────────────────────────────────────────────────────────────────

describe("v6: kospi200Value / sp500Value (정확한 benchmark 총액)", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02", { deposit: 111 })];
  const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-02-02", 500_000)];
  // 역산했다면 오차가 보이도록 "안 떨어지는" 가격 변화를 쓴다
  const prices = { "2026-01-02": flatPrices(1013), "2026-02-02": flatPrices(1097) };

  it("schemaVersion 이 6 이다", () => {
    expect(BACKTEST_SCHEMA_VERSION).toBe(6);
  });

  it("weighted backtest 의 totalValue 가 직접 저장된다 (수익률에서 역산하지 않는다)", () => {
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    for (const p of points) {
      expect(typeof p.kospi200Value).toBe("number");
      expect(typeof p.sp500Value).toBe("number");
    }
    // 코스피200 비교선은 지수 100% 라 "유닛 × 그 시점 가격" 과 정확히 같다.
    // 첫 시점: 1,000,000 / 1013 유닛
    expect(points[0].kospi200Value).toBeCloseTo((1_000_000 / 1013) * 1013, 6);
    // 두 번째 시점: 1,000,000 이 1097/1013 로 드리프트 + 500,000 입금
    const expected2 = (1_000_000 / 1013) * 1097 + 500_000;
    expect(points[1].kospi200Value).toBeCloseTo(expected2, 6);
    expect(points[1].sp500Value).toBeCloseTo(expected2, 6);
    // 반올림된 pct 에서 역산한 값과는 실제로 다르다 → 역산 금지가 의미 있는 차이다
    const principal = 1_500_000;
    const backCalculated = principal * (1 + points[1].kospi200Pct! / 100);
    expect(Math.abs(backCalculated - points[1].kospi200Value!)).toBeGreaterThan(1);
  });

  it("kospi200Value / sp500Value 와 pct 가 같은 원금 기준으로 수학적으로 일치한다", () => {
    const safePrices = { "2026-01-02": 2003, "2026-02-02": 2111 };
    const points = computeGrowthBacktest(history, prices, safePrices, cashflows);
    const principals = [1_000_000, 1_500_000]; // 장부 누적 순입금 (미투자 현금 없음)
    const pctOf = (value: number, principal: number) =>
      Math.round(((value - principal) / principal) * 10000) / 100;

    points.forEach((p, i) => {
      expect(pctOf(p.kospi200Value!, principals[i])).toBe(p.kospi200Pct);
      expect(pctOf(p.sp500Value!, principals[i])).toBe(p.sp500Pct);
      // 성장형도 같은 원금 기준이다 — 세 선이 한 차트에서 비교 가능하다는 근거
      expect(pctOf(p.totalValue, principals[i])).toBe(p.returnPct);
    });
  });

  it("안전자산 30% 다리 평가액까지 포함된 금액이다 (퇴직연금/IRP)", () => {
    const safePrices = { "2026-01-02": 2000, "2026-02-02": 2000 };
    const points = computeGrowthBacktest(history, prices, safePrices, cashflows);
    const p0 = points[0];
    const byUnits = p0.kospiUnits * 1013 + p0.kospiSafeUnits * 1013;
    expect(p0.kospi200Value).toBeCloseTo(byUnits, 6);
    expect(p0.sp500Value).toBeCloseTo(p0.sp500Units * 1013 + p0.sp500SafeUnits * 2000, 6);
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

describe("투자 가능 시점 (same_day / after_close)", () => {
  const history = [entry("2026-09-25", { baseAmount: 1_000_000 }), entry("2026-10-25"), entry("2026-11-25")];

  it("same_day 입금이 history 날짜와 같으면 그 시점 투자액에 포함된다", () => {
    const cashflows = [flow("2026-09-25", 1_000_000), flow("2026-10-25", 688_074)];
    expect(depositScheduleFor(history, cashflows)).toEqual([1_000_000, 688_074, 0]);
    expect(uninvestedCashFor(history, cashflows)).toEqual([0, 0, 0]);
  });

  it("after_close 입금이 history 날짜와 같으면 그 시점 투자액에 들어가지 않는다", () => {
    const cashflows = [flow("2026-09-25", 1_000_000), afterClose("2026-10-25", 688_074)];
    const buckets = depositScheduleFor(history, cashflows);
    expect(buckets[1]).toBe(0); // 10/25 에는 아직 못 산다
    // 그 대신 그 시점에는 현금으로 들고 있다 (원금에는 이미 들어가 있다)
    expect(uninvestedCashFor(history, cashflows)[1]).toBe(688_074);
  });

  it("같은 after_close 입금이 다음 history 시점에는 투자액에 포함된다", () => {
    const cashflows = [flow("2026-09-25", 1_000_000), afterClose("2026-10-25", 688_074)];
    expect(depositScheduleFor(history, cashflows)).toEqual([1_000_000, 0, 688_074]);
    expect(uninvestedCashFor(history, cashflows)).toEqual([0, 688_074, 0]);
  });

  it("첫 history 날짜와 같은 날 after_close 입금도 조기 투자되지 않는다", () => {
    const cashflows = [afterClose("2026-09-25", 1_000_000), flow("2026-10-25", 688_074)];
    expect(depositScheduleFor(history, cashflows)).toEqual([0, 1_688_074, 0]);
    expect(uninvestedCashFor(history, cashflows)[0]).toBe(1_000_000);
  });

  it("투자 당일 비교선 수익률이 꺼지지 않는다 — 미투자분은 현금으로 평가·원금 양쪽에 들어간다", () => {
    const cashflows = [flow("2026-09-25", 1_000_000), afterClose("2026-10-25", 688_074)];
    const prices = {
      "2026-09-25": flatPrices(1000),
      "2026-10-25": flatPrices(1000),
      "2026-11-25": flatPrices(1000),
    };
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    // 가격이 그대로니 세 시점 모두 0% 여야 한다 (10/25 에 -40% 로 꺼지지 않는다)
    expect(points[1].returnPct).toBe(0);
    expect(points[1].kospi200Pct).toBe(0);
    expect(points[1].sp500Pct).toBe(0);
    // 10/25 평가액에는 미투자 현금이 포함되고, 보유 유닛은 투자된 100만원분 그대로다
    expect(points[1].totalValue).toBe(1_688_074);
    expect(points[1].kospiUnits).toBeCloseTo(1_000_000 / 1000, 6);
    // 11/25 에는 실제로 매수된다
    expect(points[2].totalValue).toBe(1_688_074);
    expect(points[2].kospiUnits).toBeCloseTo(1_688_074 / 1000, 6);
    expect(points[2].returnPct).toBe(0);
  });

  it("timing 을 바꾸면 지문이 달라지고 계산 결과도 실제로 달라진다", () => {
    const sameDay = [flow("2026-09-25", 1_000_000), flow("2026-10-25", 688_074)];
    const afterCloseFlows = [flow("2026-09-25", 1_000_000), afterClose("2026-10-25", 688_074)];
    expect(cashflowFingerprint(sameDay)).not.toBe(cashflowFingerprint(afterCloseFlows));

    // 10/25 에 주가가 10% 오른 경우: same_day 면 오른 가격에 전액 매수, after_close 면 현금 보유
    const prices = {
      "2026-09-25": flatPrices(1000),
      "2026-10-25": flatPrices(1100),
      "2026-11-25": flatPrices(1100),
    };
    const a = computeGrowthBacktest(history, prices, undefined, sameDay);
    const b = computeGrowthBacktest(history, prices, undefined, afterCloseFlows);
    expect(a[1].kospiUnits).not.toBeCloseTo(b[1].kospiUnits, 6);
    expect(a[1].kospiUnits).toBeCloseTo((1_100_000 + 688_074) / 1100, 6);
    expect(b[1].kospiUnits).toBeCloseTo(1_100_000 / 1100, 6); // 현금 688,074 는 아직 미투자
    // 평가액(현금 포함)은 같은 날 같지만, 다음 시점부터 투자 시점 차이가 남는다
    expect(a[1].totalValue).toBeCloseTo(b[1].totalValue, 6);
    expect(needsBacktestRecompute(a[1], cashflowFingerprint(afterCloseFlows))).toBe(true);
  });
});

// 지수비교/대시보드 공용 컴포넌트 — 계산 로직이 여기 한 곳에만 있다
const BENCHMARK_CHART_SRC = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "components", "kaw", "PortfolioBenchmarkChart.tsx"),
  "utf8",
);

describe("PortfolioBenchmarkChart: 미투자 현금 판정 근거", () => {
  const src = BENCHMARK_CHART_SRC;

  it('"현재" 포인트의 미투자 현금은 투자 가능액 기준이다 (같은 날 after_close 입금 포함)', () => {
    expect(src).toContain("미투자 = cumDeposit - investedPrincipalAsOf(cashflows, last.date)");
  });

  it("실제수익률의 분모는 장부 누적원금(principalAsOf) 그대로다", () => {
    expect(src).toContain("cumDepositByDate.set(h.date, principalAsOf(cashflows, h.date))");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 과거 시세 조회 실패(0원)가 "정상 가격"으로 굳던 버그 (v5)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseHistoryPriceResults — 실패 가격은 가격이 아니다", () => {
  it("성공한 종목만 돌려준다 (price 0 / source failed 는 제외)", () => {
    const out = parseHistoryPriceResults({
      "360750": { price: 10_000, source: "naver" },
      "294400": { price: 0, source: "failed" },
    });
    expect(out).toEqual({ "360750": 10_000 });
    expect("294400" in out).toBe(false);
  });

  it("source 가 failed 면 price 가 양수라도 믿지 않는다", () => {
    expect(parseHistoryPriceResults({ "294400": { price: 123, source: "failed" } })).toEqual({});
  });

  it("비정상 값(음수·NaN·null·문자열·누락)은 모두 제외한다", () => {
    expect(
      parseHistoryPriceResults({
        a: { price: -1, source: "naver" },
        b: { price: Number.NaN, source: "naver" },
        c: { price: null, source: "naver" },
        d: { price: "10000", source: "naver" },
        e: { source: "naver" },
      }),
    ).toEqual({});
  });

  it("results 가 없으면 빈 map", () => {
    expect(parseHistoryPriceResults(undefined)).toEqual({});
  });
});

describe("isUsablePrice — 캐시 missing 판정 기준", () => {
  it("0 이하·비정상은 '아직 가격 없음'이다 (재조회 대상)", () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "10000", {}]) {
      expect(isUsablePrice(v)).toBe(false);
    }
  });

  it("양수만 쓸 수 있는 가격이다 (재조회하지 않음)", () => {
    expect(isUsablePrice(1)).toBe(true);
    expect(isUsablePrice(10_000)).toBe(true);
  });
});

describe("PRICE_CACHE_KEY", () => {
  it("v4 로 올라가 기존 0 캐시가 폐기된다", () => {
    expect(PRICE_CACHE_KEY).toBe("kaw.backtest.prices.v4");
  });
});

describe("validateHistoricalPricesForBacktest — fail-closed 기준", () => {
  const dates = ["2026-01-02", "2026-02-02"];
  const ok = { "2026-01-02": flatPrices(1000), "2026-02-02": flatPrices(1000) };

  it("가격이 충분하면 문제 없음", () => {
    expect(validateHistoricalPricesForBacktest(dates, ok)).toEqual([]);
  });

  it("첫 시점에 성장형 가격이 전부 없으면 실패한다", () => {
    const byAsset = { "2026-01-02": {}, "2026-02-02": flatPrices(1000) };
    const problems = validateHistoricalPricesForBacktest(dates, byAsset);
    expect(problems.some((m) => m.includes("첫 시점") && m.includes("성장형"))).toBe(true);
  });

  it("첫 시점에 kr(코스피200 주 leg)이 없으면 실패한다", () => {
    const byAsset = {
      "2026-01-02": flatPrices(1000, { kr: undefined }),
      "2026-02-02": flatPrices(1000),
    };
    expect(validateHistoricalPricesForBacktest(dates, byAsset).some((m) => m.includes("kr"))).toBe(true);
  });

  it("첫 시점에 us(S&P500 주 leg)이 없으면 실패한다", () => {
    const byAsset = {
      "2026-01-02": flatPrices(1000, { us: undefined }),
      "2026-02-02": flatPrices(1000),
    };
    expect(validateHistoricalPricesForBacktest(dates, byAsset).some((m) => m.includes("us"))).toBe(true);
  });

  it("안전자산 다리(ktb30)만 없는 건 허용한다 — 상장 전이면 비중 재배분이 정답이다", () => {
    const byAsset = {
      "2026-01-02": flatPrices(1000, { ktb30: undefined }),
      "2026-02-02": flatPrices(1000, { ktb30: undefined }),
    };
    expect(validateHistoricalPricesForBacktest(dates, byAsset)).toEqual([]);
  });

  it("0 은 가격으로 보지 않는다 (서버 실패 응답이 흘러들어온 경우)", () => {
    const byAsset = { "2026-01-02": flatPrices(0), "2026-02-02": flatPrices(0) };
    expect(validateHistoricalPricesForBacktest(dates, byAsset).length).toBeGreaterThan(0);
  });
});

describe("findBacktestResultProblems — 결과 sanity check", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02")];
  const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-02-02", 500_000)];
  const prices = { "2026-01-02": flatPrices(1000), "2026-02-02": flatPrices(1000) };

  it("정상 계산 결과는 통과한다", () => {
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    expect(findBacktestResultProblems(points, prices)).toEqual([]);
  });

  it("production 오염 모양(units 비었고 totalValue 가 납입액만)은 걸러낸다", () => {
    // 가격이 하나도 없는 상태에서 계산하면 실제로 이 모양이 나온다
    const noPrices = { "2026-01-02": {}, "2026-02-02": {} };
    const points = computeGrowthBacktest(history, noPrices, undefined, cashflows);
    expect(points[1].units).toEqual({});
    // 아무것도 못 샀으니 드리프트가 0 이고 그 시점 납입액만 남는다 — production 증상과 같은 모양
    // (retirement 688,074 / pension 500,000 / irp 250,000 = 각 계좌의 최신 월 납입액)
    expect(points[1].totalValue).toBe(500_000);
    expect(findBacktestResultProblems(points, noPrices).length).toBeGreaterThan(0);
  });

  it("kr 가격이 있는데 코스피 유닛이 전 구간 0 이면 걸러낸다", () => {
    const points = computeGrowthBacktest(history, prices, undefined, cashflows);
    const broken = points.map((p) => ({ ...p, kospiUnits: 0 }));
    expect(findBacktestResultProblems(broken, prices).some((m) => m.includes("코스피200"))).toBe(true);
  });

  it("돈이 들어간 적 없는 계좌는 0 이어도 정상이다", () => {
    const empty = computeGrowthBacktest([entry("2026-01-02")], prices, undefined, []);
    expect(findBacktestResultProblems(empty, prices)).toEqual([]);
  });

  it("빈 결과는 문제 없음", () => {
    expect(findBacktestResultProblems([], prices)).toEqual([]);
  });
});

describe("syncGrowthBacktest — 실패하면 아무것도 저장하지 않는다", () => {
  const history = [entry("2026-01-02", { baseAmount: 1_000_000 }), entry("2026-02-02")];
  const cashflows = [flow("2026-01-02", 1_000_000), flow("2026-02-02", 500_000)];

  /** /api/naver/history-price 와 localStorage 를 가짜로 세운다 */
  const withFakeEnv = async (
    respond: (tickers: string[], date: string) => Record<string, { price: number; source: string }>,
    run: () => Promise<void>,
  ) => {
    const store = new Map<string, string>();
    const calls: { date: string; tickers: string[] }[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const prevFetch = g.fetch;
    const prevLs = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    g.fetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { tickers: string[]; date: string };
      calls.push({ date: body.date, tickers: body.tickers });
      return { json: async () => ({ results: respond(body.tickers, body.date) }) };
    };
    try {
      await run();
    } finally {
      g.fetch = prevFetch;
      g.localStorage = prevLs;
    }
    return { calls, store };
  };

  const allOk = (tickers: string[]) =>
    Object.fromEntries(tickers.map((t) => [t, { price: 1000, source: "naver" }]));
  const allFailed = (tickers: string[]) =>
    Object.fromEntries(tickers.map((t) => [t, { price: 0, source: "failed" }]));

  it("모든 시세 조회가 실패하면 throw 하고 결과를 만들지 않는다 (현재 버전으로 덮어쓰지 않음)", async () => {
    let saved: unknown = "not-called";
    await withFakeEnv(allFailed, async () => {
      await expect(
        syncGrowthBacktest(history, { cashflows, label: "퇴직연금" }),
      ).rejects.toBeInstanceOf(BacktestDataError);
      // onResult 로 넘길 결과가 아예 없다 → setHistoryBacktest 호출 대상이 되지 않는다
      saved = await syncGrowthBacktest(history, { cashflows }).catch(() => null);
    });
    expect(saved).toBeNull();
  });

  it("실패 가격(0)은 캐시에 저장되지 않아 다음에 다시 조회된다", async () => {
    const { calls, store } = await withFakeEnv(allFailed, async () => {
      await syncGrowthBacktest(history, { cashflows }).catch(() => null);
      await syncGrowthBacktest(history, { cashflows }).catch(() => null);
    });
    // 같은 날짜를 두 번째 호출에서도 다시 조회했다 (0 이 "조회 완료"로 굳지 않았다)
    expect(calls.filter((c) => c.date === "20260102").length).toBe(2);
    const cached = JSON.parse(store.get(PRICE_CACHE_KEY) ?? "{}") as Record<string, Record<string, number>>;
    expect(Object.values(cached["2026-01-02"] ?? {}).some((v) => v === 0)).toBe(false);
  });

  it("정상 가격이면 현재 schemaVersion + cashflowKey 로 저장되고, 두 번째엔 재조회하지 않는다", async () => {
    let result: Record<string, { schemaVersion: number; cashflowKey?: string }> = {};
    const { calls } = await withFakeEnv(allOk, async () => {
      result = await syncGrowthBacktest(history, { cashflows });
      await syncGrowthBacktest(history, { cashflows }); // 캐시 히트 → 추가 조회 없음
    });
    const key = cashflowFingerprint(cashflows);
    for (const h of history) {
      expect(result[h.id].schemaVersion).toBe(BACKTEST_SCHEMA_VERSION);
      expect(result[h.id].cashflowKey).toBe(key);
    }
    expect(calls.length).toBe(history.length); // 두 번째 호출에서는 조회가 없었다
  });

  it("저장값에 정확한 benchmark 총액(kospi200Value / sp500Value)이 들어 있다 (v6)", async () => {
    let result: Record<string, { kospi200Value?: number | null; sp500Value?: number | null }> = {};
    await withFakeEnv(allOk, async () => {
      result = await syncGrowthBacktest(history, { cashflows });
    });
    for (const h of history) {
      expect(result[h.id].kospi200Value).toBeGreaterThan(0);
      expect(result[h.id].sp500Value).toBeGreaterThan(0);
    }
  });

  it("kr(코스피 주 leg)만 전 구간 실패해도 저장하지 않는다", async () => {
    const krTicker = BUILTIN_TICKERS.kr!;
    await withFakeEnv(
      (tickers) =>
        Object.fromEntries(
          tickers.map((t) => [
            t,
            t === krTicker ? { price: 0, source: "failed" } : { price: 1000, source: "naver" },
          ]),
        ),
      async () => {
        await expect(syncGrowthBacktest(history, { cashflows })).rejects.toBeInstanceOf(BacktestDataError);
      },
    );
  });

  it("us(S&P500 주 leg)만 전 구간 실패해도 저장하지 않는다", async () => {
    const usTicker = BUILTIN_TICKERS.us!;
    await withFakeEnv(
      (tickers) =>
        Object.fromEntries(
          tickers.map((t) => [
            t,
            t === usTicker ? { price: 0, source: "failed" } : { price: 1000, source: "naver" },
          ]),
        ),
      async () => {
        await expect(syncGrowthBacktest(history, { cashflows })).rejects.toBeInstanceOf(BacktestDataError);
      },
    );
  });

  it("안전자산 leg(438080)만 실패하면 계산은 성공한다 — 남은 다리로 재배분", async () => {
    let result: Record<string, { schemaVersion: number }> = {};
    await withFakeEnv(
      (tickers) =>
        Object.fromEntries(
          tickers.map((t) => [
            t,
            t === SAFE_MIX_SP500_TICKER ? { price: 0, source: "failed" } : { price: 1000, source: "naver" },
          ]),
        ),
      async () => {
        result = await syncGrowthBacktest(history, { cashflows, safeAssetMix: true });
      },
    );
    expect(Object.keys(result)).toHaveLength(history.length);
    expect(result[history[0].id].schemaVersion).toBe(BACKTEST_SCHEMA_VERSION);
  });

  it("중간 날짜만 조회 실패하면 직전 종가로 계산을 이어간다 (저장됨)", async () => {
    let result: Record<string, { totalValue: number }> = {};
    await withFakeEnv(
      (tickers, date) => (date === "20260202" ? allFailed(tickers) : allOk(tickers)),
      async () => {
        result = await syncGrowthBacktest(history, { cashflows });
      },
    );
    // 2월 가격이 없어도 1월 종가 carry-forward 로 평가된다 — 자산가치가 유지된다
    expect(result[history[1].id].totalValue).toBe(1_500_000);
  });
});

describe("오염된 v4 결과는 다시 계산된다", () => {
  it("schemaVersion 4 + 같은 fingerprint 도 재계산 대상이다", () => {
    const cashflows = [flow("2026-01-02", 1_000_000)];
    const key = cashflowFingerprint(cashflows);
    // production 에 저장된 오염 모양: units 비었고 totalValue 가 납입액만, 그런데 key 는 정상
    const polluted = {
      totalValue: 688_074,
      returnPct: 0,
      units: {},
      kospi200Pct: 0,
      sp500Pct: 0,
      kospiUnits: 0,
      sp500Units: 0,
      kospiSafeUnits: 0,
      sp500SafeUnits: 0,
      schemaVersion: 4,
      cashflowKey: key,
    };
    expect(needsBacktestRecompute(polluted, key)).toBe(true);
    expect(BACKTEST_SCHEMA_VERSION).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stale backtestGrowth 화면 차단 + 보고 있는 탭만 계산
// ─────────────────────────────────────────────────────────────────────────────

/** production 에 저장된 오염 모양 (units 비었고 totalValue 가 월 납입액, 수익률 -99%대) */
const pollutedV4 = (cashflowKey: string) => ({
  totalValue: 688_074,
  returnPct: -99.07,
  units: {},
  kospi200Pct: -99.07,
  sp500Pct: -99.07,
  kospiUnits: 0,
  sp500Units: 0,
  kospiSafeUnits: 0,
  sp500SafeUnits: 0,
  schemaVersion: 4,
  cashflowKey,
});

describe("stale 판정 — schemaVersion 과 장부 지문이 둘 다 맞아야 current", () => {
  const cashflows = [flow("2026-01-02", 1_000_000)];
  const key = cashflowFingerprint(cashflows);
  const otherKey = cashflowFingerprint([flow("2026-01-02", 999)]);

  it("v4 + 현재 fingerprint → stale", () => {
    const e = pollutedV4(key);
    expect(isCurrentBacktest(e, key)).toBe(false);
    expect(needsBacktestRecompute(e, key)).toBe(true);
    expect(currentBacktestOf(e, key)).toBeUndefined();
  });

  it("현재 버전 + fingerprint mismatch → stale", () => {
    const e = { ...pollutedV4(otherKey), schemaVersion: BACKTEST_SCHEMA_VERSION };
    expect(isCurrentBacktest(e, key)).toBe(false);
    expect(currentBacktestOf(e, key)).toBeUndefined();
  });

  it("현재 버전 + fingerprint match → current", () => {
    const e = { ...pollutedV4(key), schemaVersion: BACKTEST_SCHEMA_VERSION };
    expect(isCurrentBacktest(e, key)).toBe(true);
    expect(currentBacktestOf(e, key)).toBe(e);
  });

  it("저장값이 없으면 stale", () => {
    expect(isCurrentBacktest(undefined, key)).toBe(false);
    expect(currentBacktestOf(undefined, key)).toBeUndefined();
  });

  it("오염된 v4 의 688,074 / -99.07 은 화면 데이터로 쓰이지 않는다", () => {
    const e = pollutedV4(key);
    const usable = currentBacktestOf(e, key);
    // 차트는 이 게이트를 통과한 값만 읽는다 → totalValue/수익률 모두 접근 불가
    expect(usable).toBeUndefined();
    expect(usable?.totalValue).toBeUndefined();
    expect(usable?.returnPct).toBeUndefined();
    expect(usable?.kospi200Pct).toBeUndefined();
  });

  it("history 중 하나라도 stale 이면 그 계좌는 차트를 그리지 않는다", () => {
    const current = { ...pollutedV4(key), schemaVersion: BACKTEST_SCHEMA_VERSION };
    const mixed = [
      { ...entry("2026-01-02"), backtestGrowth: current },
      { ...entry("2026-02-02"), backtestGrowth: pollutedV4(key) }, // v4 하나 섞임
    ];
    expect(hasStaleBacktest(mixed, key)).toBe(true);
    expect(staleBacktestIds(mixed, key)).toEqual(["h-2026-02-02"]);

    const allCurrent = mixed.map((h) => ({ ...h, backtestGrowth: current }));
    expect(hasStaleBacktest(allCurrent, key)).toBe(false);
    expect(staleBacktestIds(allCurrent, key)).toEqual([]);
  });
});

describe("backtestSyncKey — 보고 있는 탭만 계산한다", () => {
  const cashflows = [flow("2026-01-02", 1_000_000)];
  const key = cashflowFingerprint(cashflows);
  const staleHistory = [{ ...entry("2026-01-02"), backtestGrowth: pollutedV4(key) }];
  const currentHistory = [
    { ...entry("2026-01-02"), backtestGrowth: { ...pollutedV4(key), schemaVersion: BACKTEST_SCHEMA_VERSION } },
  ];

  it("enabled=false 면 stale 이어도 트리거가 비어 있다 (요청/계산 없음)", () => {
    expect(backtestSyncKey(staleHistory, key, false)).toBe("");
  });

  it("enabled=true + stale → 트리거가 생긴다", () => {
    expect(backtestSyncKey(staleHistory, key, true)).toBe(`${key}|h-2026-01-02`);
  });

  it("enabled=true + current → 트리거 없음 (재계산하지 않음)", () => {
    expect(backtestSyncKey(currentHistory, key, true)).toBe("");
  });

  it("장부가 또 바뀌면 대상 목록이 같아도 트리거가 달라진다", () => {
    const otherKey = cashflowFingerprint([flow("2026-01-02", 999)]);
    expect(backtestSyncKey(staleHistory, otherKey, true)).not.toBe(
      backtestSyncKey(staleHistory, key, true),
    );
  });

  it("4계좌 중 선택된 탭만 트리거가 생긴다", () => {
    const byAccount = { retirement: staleHistory, isa: staleHistory, pension: staleHistory, irp: staleHistory };
    const active = (tab: AccountId) =>
      ACCOUNT_IDS.filter((id) => backtestSyncKey(byAccount[id], key, tab === id) !== "");
    expect(active("retirement")).toEqual(["retirement"]);
    expect(active("isa")).toEqual(["isa"]);
    // 탭을 바꾸면 새 계좌만 돈다
    expect(active("pension")).toEqual(["pension"]);
    expect(active("irp")).toEqual(["irp"]);
  });

  it("실패한 계좌는 stale 상태로 남고, 기존 v4 를 current 로 취급하지 않는다", () => {
    // syncGrowthBacktest 가 실패하면 저장이 없으므로 history 는 그대로 v4 다
    expect(hasStaleBacktest(staleHistory, key)).toBe(true);
    expect(currentBacktestOf(staleHistory[0].backtestGrowth, key)).toBeUndefined();
    // 다시 그 탭을 보면 또 시도된다
    expect(backtestSyncKey(staleHistory, key, true)).not.toBe("");
  });
});

describe("PortfolioBenchmarkChart: stale 차단 / 탭 게이팅 근거 (구조 검증)", () => {
  const src = BENCHMARK_CHART_SRC;

  it("차트 데이터는 currentBacktestOf 게이트를 통과한 값만 쓴다", () => {
    expect(src).toContain("const bt = currentBacktestOf(h.backtestGrowth, cashflowKey)");
    expect(src).toContain("const lastBt = currentBacktestOf(last.backtestGrowth, cashflowKey)");
    // 저장값을 직접 읽는 경로가 남아 있지 않다
    expect(src).not.toContain("last.backtestGrowth.units");
    expect(src).not.toContain("const bt = h.backtestGrowth;");
  });

  it("stale 이면 차트를 렌더하지 않는다 (동기 판정)", () => {
    expect(src).toContain("const stale = staleByAccount[id]");
    expect(src).toContain("const showCharts = !stale && dataByAccount[id].length >= 1");
    expect(src).toContain("hasStaleBacktest(acc.history, cashflowFingerprint(acc.cashflows))");
  });

  it("계좌 4개 hook 을 모두 호출하되 보고 있는 탭만 enabled 다", () => {
    for (const id of ["retirement", "isa", "pension", "irp"]) {
      expect(src).toContain(`enabled: tab === "${id}"`);
    }
    expect((src.match(/useEnsureGrowthBacktest\(/g) ?? []).length).toBe(4);
  });
});
