/**
 * 리밸런싱 기록이 없는 달의 **carry-forward 월말 평가** 계산 테스트.
 *
 * 핵심 계약(보간이 아니다):
 *   - 그 달 이전의 가장 최근 확정 리밸런싱(anchor) 보유수량을 **그대로** 들고 있었다고 본다
 *   - target 달에 목표비중으로 재리밸런싱하지 않는다
 *   - 실제 기록이 있는 달은 synthetic 이 덮어쓰지 않는다
 *   - 진행 중인 달은 만들지 않는다 ("현재" live point 담당)
 *   - 가격이 없으면 그 series 만 null (0원으로 계산하지 않는다)
 */
import { describe, it, expect } from "vitest";
import {
  BENCHMARK_SOURCE_PRIORITY, buildCarryForwardPoints, carryForwardAnchor, carryForwardGapMonths,
  carryForwardPlan, carryForwardTickersFor, emptyPoint, mergeBenchmarkRows, monthEndDate, nextMonth,
  type AssetLibraryEntry, type BenchmarkPoint,
} from "./benchmark-series";
import { BACKTEST_SCHEMA_VERSION, SAFE_MIX_SP500_TICKER, cashflowFingerprint } from "./backtest";
import { BUILTIN_TICKERS } from "./constants";
import type { CashflowEntry } from "./cashflow";
import type { HistoryEntry } from "./store";
import { withDbBenchmark } from "@/components/kaw/PortfolioBenchmarkChart";
import { RETIREMENT_DB_BENCHMARK } from "./retirement-db-benchmark";

const ETF_US = "TIGER 미국S&P500";
const ETF_CUSTOM = "커스텀 테마ETF"; // BUILTIN_TICKERS 에 없는 종목 — 라이브러리에서 resolve 돼야 한다
const T_US = BUILTIN_TICKERS.us!;
const T_KR = BUILTIN_TICKERS.kr!;
const T_KTB30 = BUILTIN_TICKERS.ktb30!;
const T_CUSTOM = "999999";

const LIBRARY: AssetLibraryEntry[] = [
  { defaultEtf: ETF_US, ticker: T_US },
  { defaultEtf: ETF_CUSTOM, ticker: T_CUSTOM },
  { defaultEtf: "티커없는종목" },
];

const flow = (date: string, amount: number): CashflowEntry => ({
  id: `cf:${date}:${amount}`, date, amount, type: amount >= 0 ? "deposit" : "withdrawal",
});

/** 보유수량/benchmark 유닛을 다 채운 확정 리밸런싱 기록. */
function entry(
  id: string,
  date: string,
  cashflowKey: string,
  over: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    id, date, baseAmount: 0, totalValue: 0, deposit: 0, returnPct: null,
    cashBalance: 500,
    rowQuantitiesSnap: { r1: 10, r2: 4 },
    rowEtfSnap: { r1: ETF_US, r2: ETF_CUSTOM },
    backtestGrowth: {
      totalValue: 0, returnPct: null,
      units: { us: 2, kr: 3 },
      kospi200Pct: null, sp500Pct: null,
      kospiUnits: 5, sp500Units: 7, kospiSafeUnits: 11, sp500SafeUnits: 13,
      schemaVersion: BACKTEST_SCHEMA_VERSION, cashflowKey,
    },
    ...over,
  };
}

/** 2026-07-31 / 2026-08-31 월말 가격표 (두 날짜 모두 같은 값으로 두면 검증이 단순해진다) */
const PRICES: Record<string, number> = {
  [T_US]: 100, [T_KR]: 200, [T_KTB30]: 300, [SAFE_MIX_SP500_TICKER]: 400, [T_CUSTOM]: 50,
};
const pricesAt = (...dates: string[]) =>
  Object.fromEntries(dates.map((d) => [d, { ...PRICES }]));

// ── 월 생성 규칙 ────────────────────────────────────────────────────────────

describe("carryForwardGapMonths", () => {
  const h = (date: string) => entry(date, date, "k");

  it("중간에 비어 있는 달 하나를 채운다", () => {
    const history = [h("2026-06-10"), h("2026-08-28")];
    expect(carryForwardGapMonths(history, "2026-09")).toEqual(["2026-07"]);
  });

  it("연속으로 비어 있는 달 전부를 채운다", () => {
    const history = [h("2026-06-10"), h("2026-09-15")];
    expect(carryForwardGapMonths(history, "2026-10")).toEqual(["2026-07", "2026-08"]);
  });

  it("실제 기록이 있는 달은 목록에 없다", () => {
    const history = [h("2026-06-10"), h("2026-07-03"), h("2026-08-28")];
    expect(carryForwardGapMonths(history, "2026-09")).toEqual([]);
  });

  it("진행 중인 달은 만들지 않는다 (현재 live point 담당)", () => {
    const history = [h("2026-08-28")];
    // 지금이 2026-09 면 09 는 아직 진행 중 → 생성 안 함
    expect(carryForwardGapMonths(history, "2026-09")).toEqual([]);
    // 지금이 2026-10 이면 09 는 완료된 달 → 생성
    expect(carryForwardGapMonths(history, "2026-10")).toEqual(["2026-09"]);
  });

  it("첫 기록보다 앞선 달은 만들지 않는다", () => {
    const history = [h("2026-06-10")];
    expect(carryForwardGapMonths(history, "2026-07")).toEqual([]);
    expect(carryForwardGapMonths([], "2026-07")).toEqual([]);
  });

  it("해를 넘어가도 이어진다", () => {
    const history = [h("2025-11-10"), h("2026-02-02")];
    expect(carryForwardGapMonths(history, "2026-03")).toEqual(["2025-12", "2026-01"]);
  });
});

describe("monthEndDate / nextMonth", () => {
  it("달력상 말일이다 (주말·휴장일이라고 0 으로 처리하지 않는다 — 서버가 이하 최신 종가를 준다)", () => {
    expect(monthEndDate("2026-09")).toBe("2026-09-30");
    expect(monthEndDate("2026-02")).toBe("2026-02-28");
    expect(monthEndDate("2024-02")).toBe("2024-02-29");
    expect(monthEndDate("2026-12")).toBe("2026-12-31");
  });
  it("다음 달", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-01")).toBe("2026-02");
  });
});

describe("carryForwardAnchor", () => {
  it("'이전 달'이 아니라 target 달 이전 가장 최근 확정 리밸런싱이다", () => {
    const history = [entry("a", "2026-06-10", "k"), entry("b", "2026-09-15", "k")];
    expect(carryForwardAnchor(history, "2026-07")?.id).toBe("a");
    expect(carryForwardAnchor(history, "2026-08")?.id).toBe("a"); // 7월이 비어도 6월을 쓴다
    expect(carryForwardAnchor(history, "2026-10")?.id).toBe("b");
  });

  it("같은 달 안의 기록은 anchor 가 아니다 (그 달은 gap 이 아니다)", () => {
    const history = [entry("a", "2026-07-05", "k")];
    expect(carryForwardAnchor(history, "2026-07")).toBeUndefined();
  });
});

describe("carryForwardTickersFor", () => {
  const cf = [flow("2026-06-01", 1_000_000)];
  const key = cashflowFingerprint(cf);

  it("커스텀 보유종목도 라이브러리에서 resolve 한다", () => {
    const t = carryForwardTickersFor(entry("a", "2026-06-10", key), LIBRARY, false);
    expect(t).toContain(T_CUSTOM);
    expect(t).toContain(T_US);
    expect(t).toContain(T_KR);
    expect(t).not.toContain(T_KTB30);
    expect(t).not.toContain(SAFE_MIX_SP500_TICKER);
  });

  it("safe mix 계좌면 안전자산 다리 종목까지 조회 대상이다", () => {
    const t = carryForwardTickersFor(entry("a", "2026-06-10", key), LIBRARY, true);
    expect(t).toContain(T_KTB30);
    expect(t).toContain(SAFE_MIX_SP500_TICKER);
  });

  it("plan 은 각 gap 달의 월말 날짜를 모은다", () => {
    const history = [entry("a", "2026-06-10", key), entry("b", "2026-09-15", key)];
    const plan = carryForwardPlan(history, LIBRARY, false, "2026-10");
    expect(plan.months).toEqual(["2026-07", "2026-08"]);
    expect(plan.dates).toEqual(["2026-07-31", "2026-08-31"]);
  });
});

// ── 평가 계산 ───────────────────────────────────────────────────────────────

describe("buildCarryForwardPoints — 네 series 평가", () => {
  const cf = [flow("2026-06-01", 1_000_000)];
  const key = cashflowFingerprint(cf);
  const history = [entry("a", "2026-06-10", key)];

  const base = {
    history, cashflows: cf, cashflowKey: key, library: LIBRARY,
    pricesByDate: pricesAt("2026-07-31"), nowMonth: "2026-08",
  };

  it("anchor 보유수량 × 월말 종가 — 재리밸런싱하지 않는다", () => {
    const [p] = buildCarryForwardPoints({ ...base, safeAssetMix: false });
    expect(p.label).toBe("2026.07");
    expect(p.date).toBe("2026-07-31");
    expect(p.source).toBe("carry_forward");
    // 실제 = 10 × 100(TIGER) + 4 × 50(커스텀) + anchor 예수금 500
    expect(p.actualValue).toBe(10 * 100 + 4 * 50 + 500);
    // 성장형 = units 그대로 (us 2, kr 3) — 성장형 목표비중으로 다시 담지 않는다
    expect(p.growthValue).toBe(2 * 100 + 3 * 200);
    expect(p.kospiValue).toBe(5 * 200);
    expect(p.sp500Value).toBe(7 * 100);
  });

  it("누적수익률 분모는 target 월말 principalAsOf 다", () => {
    const [p] = buildCarryForwardPoints({ ...base, safeAssetMix: false });
    const principal = 1_000_000;
    expect(p.growthPct).toBe(
      Math.round(((p.growthValue! - principal) / principal) * 10000) / 100,
    );
    expect(p.actualPct).toBe(
      Math.round(((p.actualValue! - principal) / principal) * 10000) / 100,
    );
  });

  it("여러 달 연속 비어 있으면 모두 같은 anchor 를 쓰고 값이 흔들리지 않는다", () => {
    const pts = buildCarryForwardPoints({
      ...base, safeAssetMix: false,
      pricesByDate: pricesAt("2026-07-31", "2026-08-31"),
      nowMonth: "2026-09",
    });
    expect(pts.map((p) => p.label)).toEqual(["2026.07", "2026.08"]);
    // 같은 가격표 + 같은 anchor 유닛 → 평가액도 같다 (중간에 재리밸런싱이 끼지 않았다는 뜻)
    expect(pts[0].growthValue).toBe(pts[1].growthValue);
    expect(pts[0].kospiValue).toBe(pts[1].kospiValue);
  });

  it("safe mix(퇴직연금/IRP)는 안전자산 다리를 더한다", () => {
    const [p] = buildCarryForwardPoints({ ...base, safeAssetMix: true });
    expect(p.kospiValue).toBe(5 * 200 + 11 * 300);
    expect(p.sp500Value).toBe(7 * 100 + 13 * 400);
  });

  it("safe mix 가 아니면 안전자산 다리를 더하지 않는다", () => {
    const [p] = buildCarryForwardPoints({ ...base, safeAssetMix: false });
    expect(p.kospiValue).toBe(5 * 200);
    expect(p.sp500Value).toBe(7 * 100);
  });
});

describe("buildCarryForwardPoints — anchor 이후 미투자 cashflow", () => {
  it("anchor 이후 들어온 돈은 네 series 모두에 현금으로 더해진다", () => {
    const cf = [flow("2026-06-01", 1_000_000), flow("2026-07-20", 100_000)];
    const key = cashflowFingerprint(cf);
    const history = [entry("a", "2026-06-10", key)];
    const [p] = buildCarryForwardPoints({
      history, cashflows: cf, cashflowKey: key, library: LIBRARY, safeAssetMix: false,
      pricesByDate: pricesAt("2026-07-31"), nowMonth: "2026-08",
    });
    // 미투자 현금 100,000 — 성장형/지수에 그대로 더해진다 (그 돈으로 지수를 사지 않는다)
    expect(p.growthValue).toBe(2 * 100 + 3 * 200 + 100_000);
    expect(p.kospiValue).toBe(5 * 200 + 100_000);
    expect(p.sp500Value).toBe(7 * 100 + 100_000);
    // 실제 = anchor 예수금 + 그 뒤 순입금
    expect(p.actualValue).toBe(10 * 100 + 4 * 50 + 500 + 100_000);
    // 분모도 월말 기준 원금이다
    const principal = 1_100_000;
    expect(p.actualPct).toBe(Math.round(((p.actualValue! - principal) / principal) * 10000) / 100);
  });

  it("anchor 당일 장마감 후 입금(after_close)은 anchor 에서 미투자로 남아 다음 달에도 현금이다", () => {
    const cf: CashflowEntry[] = [
      flow("2026-06-01", 1_000_000),
      { ...flow("2026-06-10", 50_000), timing: "after_close" },
    ];
    const key = cashflowFingerprint(cf);
    const history = [entry("a", "2026-06-10", key)];
    const [p] = buildCarryForwardPoints({
      history, cashflows: cf, cashflowKey: key, library: LIBRARY, safeAssetMix: false,
      pricesByDate: pricesAt("2026-07-31"), nowMonth: "2026-08",
    });
    expect(p.growthValue).toBe(2 * 100 + 3 * 200 + 50_000);
  });

  it("출금도 그대로 반영된다 (순액)", () => {
    const cf = [flow("2026-06-01", 1_000_000), flow("2026-07-05", -30_000)];
    const key = cashflowFingerprint(cf);
    const history = [entry("a", "2026-06-10", key)];
    const [p] = buildCarryForwardPoints({
      history, cashflows: cf, cashflowKey: key, library: LIBRARY, safeAssetMix: false,
      pricesByDate: pricesAt("2026-07-31"), nowMonth: "2026-08",
    });
    expect(p.growthValue).toBe(2 * 100 + 3 * 200 - 30_000);
    expect(p.actualValue).toBe(10 * 100 + 4 * 50 + 500 - 30_000);
  });
});

// ── fail-closed ────────────────────────────────────────────────────────────

describe("buildCarryForwardPoints — fail-closed", () => {
  const cf = [flow("2026-06-01", 1_000_000)];
  const key = cashflowFingerprint(cf);
  const history = [entry("a", "2026-06-10", key)];
  const base = {
    history, cashflows: cf, cashflowKey: key, library: LIBRARY,
    safeAssetMix: false, nowMonth: "2026-08",
  };

  it("가격이 빠진 series 만 null 이고 나머지는 살아남는다", () => {
    const px = { "2026-07-31": { ...PRICES } };
    delete px["2026-07-31"][T_KR]; // kr 가 없으면 성장형(kr 보유)과 KOSPI 가 성립하지 않는다
    const [p] = buildCarryForwardPoints({ ...base, pricesByDate: px });
    expect(p.growthValue).toBeNull();
    expect(p.kospiValue).toBeNull();
    expect(p.sp500Value).toBe(7 * 100); // us 는 있으므로 살아남는다
    expect(p.actualValue).toBe(10 * 100 + 4 * 50 + 500);
  });

  it("가격이 0 이면 0원으로 계산하지 않고 null 이다", () => {
    const px = { "2026-07-31": { ...PRICES, [T_US]: 0 } };
    const [p] = buildCarryForwardPoints({ ...base, pricesByDate: px });
    expect(p.sp500Value).toBeNull();
    expect(p.growthValue).toBeNull();
    expect(p.actualValue).toBeNull(); // 실제 보유 종목 가격이 없으면 실제도 null
    expect(p.kospiValue).toBe(5 * 200);
  });

  it("네 series 전부 계산 불가면 빈 행을 만들지 않는다", () => {
    expect(buildCarryForwardPoints({ ...base, pricesByDate: { "2026-07-31": {} } })).toEqual([]);
  });

  it("해당 월말 가격을 아직 못 받았으면 point 를 만들지 않는다", () => {
    expect(buildCarryForwardPoints({ ...base, pricesByDate: {} })).toEqual([]);
  });

  it("anchor 의 저장된 benchmark 가 stale 이면 비교선을 만들지 않는다 (실제는 유지)", () => {
    const stale = [entry("a", "2026-06-10", "다른-장부-지문")];
    const [p] = buildCarryForwardPoints({
      ...base, history: stale, pricesByDate: pricesAt("2026-07-31"),
    });
    expect(p.growthValue).toBeNull();
    expect(p.kospiValue).toBeNull();
    expect(p.sp500Value).toBeNull();
    expect(p.actualValue).toBe(10 * 100 + 4 * 50 + 500);
  });

  it("보유 종목의 ticker 를 resolve 할 수 없으면 실제는 null 이다", () => {
    const noTicker = [
      entry("a", "2026-06-10", key, {
        rowQuantitiesSnap: { r1: 10 }, rowEtfSnap: { r1: "티커없는종목" },
      }),
    ];
    const [p] = buildCarryForwardPoints({
      ...base, history: noTicker, pricesByDate: pricesAt("2026-07-31"),
    });
    expect(p.actualValue).toBeNull();
    expect(p.growthValue).toBe(2 * 100 + 3 * 200);
  });
});

// ── 병합 ───────────────────────────────────────────────────────────────────

describe("mergeBenchmarkRows", () => {
  const withValue = (p: BenchmarkPoint, v: number) => ({ ...p, actualValue: v });

  it("실제 기록이 있는 달은 synthetic 이 덮어쓰지 않는다", () => {
    const hist = withValue(emptyPoint("2026.07", "2026-07-03", "2026-07-03", "history"), 111);
    const synth = withValue(emptyPoint("2026.07", "2026-07-31", "2026-07-31", "carry_forward"), 222);
    expect(mergeBenchmarkRows([hist], [synth]).map((r) => [r.source, r.actualValue]))
      .toEqual([["history", 111]]);
    // 순서를 바꿔도 결과가 같다
    expect(mergeBenchmarkRows([synth], [hist]).map((r) => [r.source, r.actualValue]))
      .toEqual([["history", 111]]);
  });

  it("출처 우선순위: 실제 기록·현재 > carry-forward > DB only", () => {
    expect(BENCHMARK_SOURCE_PRIORITY.history).toBeGreaterThan(BENCHMARK_SOURCE_PRIORITY.carry_forward);
    expect(BENCHMARK_SOURCE_PRIORITY.live).toBeGreaterThan(BENCHMARK_SOURCE_PRIORITY.carry_forward);
    expect(BENCHMARK_SOURCE_PRIORITY.carry_forward).toBeGreaterThan(BENCHMARK_SOURCE_PRIORITY.db_only);
  });

  it("sortDate 순으로 정렬되고 '현재' 가 마지막이다", () => {
    const rows = mergeBenchmarkRows(
      [emptyPoint("2026.08", "2026-08-28", "2026-08-28", "history")],
      [emptyPoint("2026.09", "2026-09-30", "2026-09-30", "carry_forward")],
      [emptyPoint("현재", "현재", "9999-12-31", "live")],
    );
    expect(rows.map((r) => r.label)).toEqual(["2026.08", "2026.09", "현재"]);
  });
});

describe("withDbBenchmark — DB 는 투자 series 를 만들어내지 않고 얹힌다", () => {
  it("DB only 였던 2026.09 행에 carry-forward 투자 series 가 합쳐진다", () => {
    const db2609 = RETIREMENT_DB_BENCHMARK.find((p) => p.month === "2026-09")!;
    const synth: BenchmarkPoint = {
      ...emptyPoint("2026.09", "2026-09-30", "2026-09-30", "carry_forward"),
      actualValue: 70_000_000, actualPct: 5,
      growthValue: 71_000_000, growthPct: 6,
      kospiValue: 72_000_000, kospiPct: 7,
      sp500Value: 73_000_000, sp500Pct: 8,
    };
    const rows = withDbBenchmark([synth]);
    const row = rows.find((r) => r.label === "2026.09")!;
    expect(row.dbValue).toBe(db2609.value);
    expect(row.actualValue).toBe(70_000_000);
    expect(row.growthValue).toBe(71_000_000);
    expect(row.kospiValue).toBe(72_000_000);
    expect(row.sp500Value).toBe(73_000_000);
    expect(row.source).toBe("carry_forward");
  });

  it("투자 기록이 없는 달은 db_only 로 남고 투자값을 만들어 넣지 않는다", () => {
    const rows = withDbBenchmark([]);
    const first = rows.find((r) => r.label === "2025.03")!;
    expect(first.source).toBe("db_only");
    expect(first.actualValue).toBeNull();
    expect(first.growthValue).toBeNull();
  });
});
