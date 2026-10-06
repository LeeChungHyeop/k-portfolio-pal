// 과거 구간 평가액 복원 규칙을 테스트로 고정한다.
//
// production 식별자(실제 family_code / profile)나 실제 계좌 데이터는 쓰지 않는다 —
// 계좌 id 는 앱의 상수(ACCOUNT_IDS)만 쓰고 수량·가격은 전부 합성값이다.
import { describe, it, expect } from "vitest";
import { ACCOUNT_IDS } from "./constants";
import {
  anchorAsOf,
  anchorTickers,
  buildPerformanceTimeline,
  buildReconstructedRows,
  firstActualSnapshotDates,
  mergeTimeline,
  reconstructionPlan,
  timelineHasReconstructed,
  tradingDatesOf,
  validAnchors,
  type PerformanceTimelineRow,
  type PriceSeriesByTicker,
  type ReconstructionAccountInput,
} from "./historical-performance";
import { aggregateByDate, calculatePerformance, type DailySnapshotRow } from "./performance";
import type { SnapshotHistoryLike } from "./snapshot";

// ── 테스트 픽스처 ───────────────────────────────────────────────────────────
const T_A = "100000";
const T_B = "200000";
const ETF_A = "테스트 ETF A";
const ETF_B = "테스트 ETF B";

const library = [
  { defaultEtf: ETF_A, ticker: T_A },
  { defaultEtf: ETF_B, ticker: T_B },
];

/** rowId → 수량/ETF명 스냅샷을 가진 history entry */
function entry(
  date: string,
  holdings: Record<string, { etf: string; qty: number }>,
  extra: Partial<SnapshotHistoryLike> = {},
): SnapshotHistoryLike & { rowHoldingsSnap?: Record<string, number> } {
  return {
    date,
    rowQuantitiesSnap: Object.fromEntries(
      Object.entries(holdings).map(([rowId, h]) => [rowId, h.qty]),
    ),
    rowEtfSnap: Object.fromEntries(
      Object.entries(holdings).map(([rowId, h]) => [rowId, h.etf]),
    ),
    ...extra,
  };
}

function series(map: Record<string, Record<string, number>>): PriceSeriesByTicker {
  return map;
}

const ACC = ACCOUNT_IDS[0];
const ACC2 = ACCOUNT_IDS[1];

// ─────────────────────────────────────────────────────────────────────────────
describe("validAnchors / anchorAsOf", () => {
  it("양수 보유수량이 없는 entry 는 anchor 가 아니다", () => {
    const anchors = validAnchors([
      entry("2026-01-02", { r1: { etf: ETF_A, qty: 0 } }),
      { date: "2026-01-03" },
      { date: "2026-01-04", rowQuantitiesSnap: {} },
      entry("2026-01-05", { r1: { etf: ETF_A, qty: 3 } }),
    ]);
    expect(anchors.map((a) => a.date)).toEqual(["2026-01-05"]);
  });

  it("정렬이 뒤섞여 있어도 날짜 오름차순으로 돌려주고, 당일 anchor 를 포함한다", () => {
    const anchors = validAnchors([
      entry("2026-03-02", { r1: { etf: ETF_A, qty: 2 } }),
      entry("2026-01-02", { r1: { etf: ETF_A, qty: 1 } }),
    ]);
    expect(anchors.map((a) => a.date)).toEqual(["2026-01-02", "2026-03-02"]);
    expect(anchorAsOf(anchors, "2026-01-02")?.date).toBe("2026-01-02");
    expect(anchorAsOf(anchors, "2026-02-20")?.date).toBe("2026-01-02");
    expect(anchorAsOf(anchors, "2026-03-05")?.date).toBe("2026-03-02");
    expect(anchorAsOf(anchors, "2026-01-01")).toBeUndefined();
  });
});

describe("anchorTickers — 기존 자산 라이브러리로 ETF명 → ticker", () => {
  it("양수 수량 종목만, 라이브러리의 ticker 로 resolve 한다", () => {
    const a = entry("2026-01-02", {
      r1: { etf: ETF_A, qty: 5 },
      r2: { etf: ETF_B, qty: 0 },
      r3: { etf: "라이브러리에 없는 ETF", qty: 7 },
    });
    expect(anchorTickers(a, library).sort()).toEqual([T_A]);
  });
});

// ── 1~4: 평가액 정의 ────────────────────────────────────────────────────────
describe("복원 평가액 정의", () => {
  const accounts: ReconstructionAccountInput[] = [{
    accountId: ACC,
    history: [entry("2026-01-02", {
      r1: { etf: ETF_A, qty: 10 },
      r2: { etf: ETF_B, qty: 4 },
    }, { rowHoldingsSnap: { r1: 999_999_999, r2: 888_888_888 } } as Partial<SnapshotHistoryLike>)],
  }];
  const prices = series({
    [T_A]: { "2026-01-02": 1_000 },
    [T_B]: { "2026-01-02": 2_500 },
  });

  const rows = buildReconstructedRows({
    accounts, library, actualSnapshots: [], priceSeries: prices,
  });

  it("(1) rowQuantitiesSnap × 그 날 종가로 marketValue 를 만든다", () => {
    expect(rows).toHaveLength(1);
    // 10×1,000 + 4×2,500 = 20,000
    expect(rows[0].marketValue).toBe(20_000);
  });

  it("(2) rowHoldingsSnap 금액은 계산에 전혀 쓰지 않는다", () => {
    expect(rows[0].marketValue).toBe(20_000);
    expect(rows[0].totalAssetValue).toBe(20_000);
    expect(rows[0].marketValue).not.toBe(999_999_999 + 888_888_888);
  });

  it("(3) 복원 구간의 cashBalance 는 0 이다", () => {
    expect(rows[0].cashBalance).toBe(0);
  });

  it("(4) totalAssetValue = marketValue 다", () => {
    expect(rows[0].totalAssetValue).toBe(rows[0].marketValue);
  });

  it("source 가 reconstructed 로 표시된다", () => {
    expect(rows[0].source).toBe("reconstructed");
  });
});

// ── 5~6: carry-forward ─────────────────────────────────────────────────────
describe("보유수량 carry-forward", () => {
  const accounts: ReconstructionAccountInput[] = [{
    accountId: ACC,
    history: [
      entry("2026-08-28", { r1: { etf: ETF_A, qty: 100 }, r2: { etf: ETF_B, qty: 50 } }),
      entry("2026-10-02", { r1: { etf: ETF_A, qty: 120 }, r2: { etf: ETF_B, qty: 40 } }),
    ],
  }];
  // 거래일: 8/28, 9/01, 10/01, 10/02 (주말/휴장일을 만들어내지 않는다)
  const prices = series({
    [T_A]: { "2026-08-28": 10, "2026-09-01": 11, "2026-10-01": 12, "2026-10-02": 13 },
    [T_B]: { "2026-08-28": 20, "2026-09-01": 21, "2026-10-01": 22, "2026-10-02": 23 },
  });
  const rows = buildReconstructedRows({
    accounts, library, actualSnapshots: [], priceSeries: prices,
  });
  const byDate = new Map(rows.map((r) => [r.snapshotDate, r]));

  it("(5) 다음 history 전까지 이전 수량을 유지하고, 날짜별 그 날 종가를 적용한다", () => {
    expect(byDate.get("2026-08-28")!.marketValue).toBe(100 * 10 + 50 * 20); // 2,000
    expect(byDate.get("2026-09-01")!.marketValue).toBe(100 * 11 + 50 * 21); // 2,150
    expect(byDate.get("2026-10-01")!.marketValue).toBe(100 * 12 + 50 * 22); // 2,300
  });

  it("(6) 새 history 날짜부터 새 수량을 쓴다", () => {
    expect(byDate.get("2026-10-02")!.marketValue).toBe(120 * 13 + 40 * 23); // 2,480
  });

  it("첫 anchor 이전 거래일에는 행을 만들지 않는다", () => {
    const earlier = buildReconstructedRows({
      accounts, library, actualSnapshots: [],
      priceSeries: series({
        [T_A]: { "2026-08-01": 9, "2026-08-28": 10 },
        [T_B]: { "2026-08-01": 19, "2026-08-28": 20 },
      }),
    });
    expect(earlier.map((r) => r.snapshotDate)).toEqual(["2026-08-28"]);
  });

  it("거래일은 가격 데이터가 있는 날짜만이다 (주말/휴장일을 생성하지 않는다)", () => {
    expect(rows.map((r) => r.snapshotDate))
      .toEqual(["2026-08-28", "2026-09-01", "2026-10-01", "2026-10-02"]);
    expect(tradingDatesOf(prices))
      .toEqual(["2026-08-28", "2026-09-01", "2026-10-01", "2026-10-02"]);
  });
});

// ── 7: fail closed ─────────────────────────────────────────────────────────
describe("(7) 한 종목 가격 누락 시 partial valuation 을 만들지 않는다", () => {
  const accounts: ReconstructionAccountInput[] = [{
    accountId: ACC,
    history: [entry("2026-01-02", { r1: { etf: ETF_A, qty: 10 }, r2: { etf: ETF_B, qty: 5 } })],
  }];

  it("B 가격이 없는 날짜는 행 전체를 건너뛴다", () => {
    const rows = buildReconstructedRows({
      accounts, library, actualSnapshots: [],
      priceSeries: series({
        [T_A]: { "2026-01-02": 100, "2026-01-05": 110 },
        [T_B]: { "2026-01-02": 200 }, // 1/05 누락
      }),
    });
    expect(rows.map((r) => r.snapshotDate)).toEqual(["2026-01-02"]);
    expect(rows[0].marketValue).toBe(10 * 100 + 5 * 200);
  });

  it("0 이나 음수 가격도 '없음'으로 본다 (fail closed)", () => {
    const rows = buildReconstructedRows({
      accounts, library, actualSnapshots: [],
      priceSeries: series({
        [T_A]: { "2026-01-02": 100 },
        [T_B]: { "2026-01-02": 0 },
      }),
    });
    expect(rows).toEqual([]);
  });

  it("라이브러리에 ticker 가 없는 종목을 보유하면 그 계좌·날짜 행을 만들지 않는다", () => {
    const rows = buildReconstructedRows({
      accounts: [{
        accountId: ACC,
        history: [entry("2026-01-02", {
          r1: { etf: ETF_A, qty: 10 },
          r2: { etf: "매핑 없는 ETF", qty: 1 },
        })],
      }],
      library, actualSnapshots: [],
      priceSeries: series({ [T_A]: { "2026-01-02": 100 } }),
    });
    expect(rows).toEqual([]);
  });

  it("가격 series 가 비면 아무 행도 만들지 않는다 (fail closed)", () => {
    expect(buildReconstructedRows({
      accounts, library, actualSnapshots: [], priceSeries: {},
    })).toEqual([]);
  });
});

// ── 8~9: 실제 스냅샷 우선 ──────────────────────────────────────────────────
describe("실제 snapshot 우선 규칙", () => {
  const actual: DailySnapshotRow[] = [
    { snapshotDate: "2026-10-04", accountId: ACC, marketValue: 7_777, cashBalance: 3, totalAssetValue: 7_780 },
    { snapshotDate: "2026-10-06", accountId: ACC, marketValue: 7_900, cashBalance: 3, totalAssetValue: 7_903 },
  ];
  const accounts: ReconstructionAccountInput[] = [{
    accountId: ACC,
    history: [entry("2026-10-01", { r1: { etf: ETF_A, qty: 10 } })],
  }];
  const prices = series({
    [T_A]: {
      "2026-10-01": 100, "2026-10-02": 101,
      "2026-10-04": 102, "2026-10-05": 103, "2026-10-06": 104,
    },
  });

  it("firstActualSnapshotDates 는 계좌별 첫 실제 스냅샷 날짜를 돌려준다", () => {
    expect(firstActualSnapshotDates(actual).get(ACC)).toBe("2026-10-04");
  });

  it("(9) 첫 actual snapshot 이후로는 reconstructed 행을 만들지 않는다", () => {
    const rows = buildReconstructedRows({
      accounts, library, actualSnapshots: actual, priceSeries: prices,
    });
    expect(rows.map((r) => r.snapshotDate)).toEqual(["2026-10-01", "2026-10-02"]);
    // actual snapshot 시대의 빠진 날짜(10-05)를 history 로 메우지 않는다
    expect(rows.some((r) => r.snapshotDate === "2026-10-05")).toBe(false);
  });

  it("(8) 같은 날짜가 양쪽에 있으면 actual snapshot 이 이긴다", () => {
    const reconstructedSameDay: PerformanceTimelineRow[] = [{
      snapshotDate: "2026-10-04", accountId: ACC,
      marketValue: 1, cashBalance: 0, totalAssetValue: 1, source: "reconstructed",
    }];
    const merged = mergeTimeline(actual, reconstructedSameDay);
    const hit = merged.filter((r) => r.snapshotDate === "2026-10-04");
    expect(hit).toHaveLength(1);
    expect(hit[0].source).toBe("snapshot");
    expect(hit[0].totalAssetValue).toBe(7_780);
  });

  it("merge 결과는 날짜 오름차순이고 actual 은 snapshot source 로 표시된다", () => {
    const merged = buildPerformanceTimeline({
      accounts, library, actualSnapshots: actual, priceSeries: prices,
    });
    expect(merged.map((r) => `${r.snapshotDate}:${r.source}`)).toEqual([
      "2026-10-01:reconstructed",
      "2026-10-02:reconstructed",
      "2026-10-04:snapshot",
      "2026-10-06:snapshot",
    ]);
  });
});

// ── 10: 계좌별 시작일이 다름 ───────────────────────────────────────────────
describe("(10) 계좌별 reconstruction 시작일이 다르다", () => {
  const accounts: ReconstructionAccountInput[] = [
    { accountId: ACC, history: [entry("2026-01-02", { r1: { etf: ETF_A, qty: 10 } })] },
    { accountId: ACC2, history: [entry("2026-01-06", { r1: { etf: ETF_A, qty: 20 } })] },
  ];
  const prices = series({
    [T_A]: { "2026-01-02": 100, "2026-01-05": 100, "2026-01-06": 100, "2026-01-07": 100 },
  });

  it("각 계좌는 자기 첫 anchor 날짜부터 시작한다", () => {
    const rows = buildReconstructedRows({
      accounts, library, actualSnapshots: [], priceSeries: prices,
    });
    const dates = (id: string) =>
      rows.filter((r) => r.accountId === id).map((r) => r.snapshotDate);
    expect(dates(ACC)).toEqual(["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"]);
    expect(dates(ACC2)).toEqual(["2026-01-06", "2026-01-07"]);
  });

  it("계좌별로 첫 actual snapshot 날짜(복원 상한)가 따로 적용된다", () => {
    const rows = buildReconstructedRows({
      accounts, library, priceSeries: prices,
      actualSnapshots: [
        { snapshotDate: "2026-01-06", accountId: ACC, marketValue: 1, cashBalance: 0, totalAssetValue: 1 },
      ],
    });
    const dates = (id: string) =>
      rows.filter((r) => r.accountId === id).map((r) => r.snapshotDate);
    expect(dates(ACC)).toEqual(["2026-01-02", "2026-01-05"]);
    expect(dates(ACC2)).toEqual(["2026-01-06", "2026-01-07"]);
  });

  it("history 가 없는 계좌는 복원되지 않는다", () => {
    const rows = buildReconstructedRows({
      accounts: [{ accountId: ACC, history: [] }],
      library, actualSnapshots: [], priceSeries: prices,
    });
    expect(rows).toEqual([]);
  });
});

// ── 11: 전체 scope requireAccountIds ───────────────────────────────────────
describe("(11) 전체 scope 의 requireAccountIds 규칙이 유지된다", () => {
  const accounts: ReconstructionAccountInput[] = [
    { accountId: ACC, history: [entry("2026-01-02", { r1: { etf: ETF_A, qty: 10 } })] },
    { accountId: ACC2, history: [entry("2026-01-06", { r1: { etf: ETF_A, qty: 20 } })] },
  ];
  const prices = series({
    [T_A]: { "2026-01-02": 100, "2026-01-06": 110, "2026-01-07": 120 },
  });
  const timeline = buildPerformanceTimeline({
    accounts, library, actualSnapshots: [], priceSeries: prices,
  });

  it("두 계좌 모두 있는 날짜만 전체 point 가 된다 (시작일이 늦는 쪽을 따라간다)", () => {
    const points = aggregateByDate(timeline, { requireAccountIds: [ACC, ACC2] });
    expect(points.map((p) => p.date)).toEqual(["2026-01-06", "2026-01-07"]);
    expect(points[0].total).toBe(10 * 110 + 20 * 110);
  });

  it("계좌별 scope 는 그 계좌 행만 있으면 계산한다", () => {
    const points = aggregateByDate(timeline, { accountIds: [ACC] });
    expect(points.map((p) => p.date)).toEqual(["2026-01-02", "2026-01-06", "2026-01-07"]);
  });

  it("한 계좌라도 그 날 복원이 실패하면 전체 point 가 만들어지지 않는다", () => {
    const partial = buildPerformanceTimeline({
      accounts: [
        { accountId: ACC, history: [entry("2026-01-02", { r1: { etf: ETF_A, qty: 10 } })] },
        { accountId: ACC2, history: [entry("2026-01-02", { r1: { etf: ETF_B, qty: 20 } })] },
      ],
      library, actualSnapshots: [],
      priceSeries: series({
        [T_A]: { "2026-01-02": 100, "2026-01-06": 110 },
        [T_B]: { "2026-01-02": 200 }, // ACC2 는 1/06 평가 불가
      }),
    });
    const points = aggregateByDate(partial, { requireAccountIds: [ACC, ACC2] });
    expect(points.map((p) => p.date)).toEqual(["2026-01-02"]);
  });
});

// ── 12~14: 성과 계산 + cashflow ────────────────────────────────────────────
describe("성과 계산 연결", () => {
  const accounts: ReconstructionAccountInput[] = [{
    accountId: ACC,
    history: [entry("2026-09-01", { r1: { etf: ETF_A, qty: 100 } })],
  }];
  // 9월 복원 구간(9/01, 9/30) + 10월 실제 스냅샷 구간(10/05)
  const prices = series({
    [T_A]: { "2026-09-01": 100, "2026-09-30": 110, "2026-10-05": 120 },
  });
  const actual: DailySnapshotRow[] = [{
    snapshotDate: "2026-10-05", accountId: ACC,
    marketValue: 12_000, cashBalance: 500, totalAssetValue: 12_500,
  }];
  const timeline = buildPerformanceTimeline({
    accounts, library, actualSnapshots: actual, priceSeries: prices,
  });

  it("(12) reconstructed → actual 경계에서 월간 성과가 정상 계산된다", () => {
    const perf = calculatePerformance(timeline, [], { accountIds: [ACC] }, "monthly");
    expect(perf.map((p) => p.key)).toEqual(["2026-09", "2026-10"]);

    // 9월: 구간 내부 첫 행(9/01)이 V0 (앞 행이 없으므로 partial)
    expect(perf[0]).toMatchObject({
      fromDate: "2026-09-01", toDate: "2026-09-30",
      beginningTotal: 10_000, endingTotal: 11_000, partial: true, netCashflow: 0,
    });
    expect(perf[0].profit).toBe(1_000);

    // 10월: V0 = 복원 마지막 행(9/30), V1 = 실제 스냅샷(10/05) — 경계를 가로지른다
    expect(perf[1]).toMatchObject({
      fromDate: "2026-09-30", toDate: "2026-10-05",
      beginningTotal: 11_000, endingTotal: 12_500, partial: false,
    });
  });

  it("(13) 기존 cashflow Modified Dietz 가 그대로 반영된다", () => {
    const perf = calculatePerformance(
      timeline,
      [{ accountId: ACC, date: "2026-10-01", amount: 1_000 }],
      { accountIds: [ACC] },
      "monthly",
    );
    const oct = perf.find((p) => p.key === "2026-10")!;
    expect(oct.netCashflow).toBe(1_000);
    // profit = 12,500 - 11,000 - 1,000
    expect(oct.profit).toBe(500);
    // T = 9/30~10/05 = 5일, ti = 1일 → w = 4/5
    expect(oct.averageCapital).toBe(11_000 + 1_000 * 0.8);
    expect(oct.returnPct).toBeCloseTo((500 / 11_800) * 100, 10);
  });

  it("(14) cashflow 금액은 복원 평가액에 더해지지 않는다", () => {
    const withFlow = buildPerformanceTimeline({
      accounts: [{
        accountId: ACC,
        history: accounts[0].history,
        cashflowDates: ["2026-09-15"],
      }],
      library, actualSnapshots: actual, priceSeries: prices,
    });
    const sep30 = withFlow.find((r) => r.snapshotDate === "2026-09-30")!;
    const plain = timeline.find((r) => r.snapshotDate === "2026-09-30")!;
    // 장부에 입금이 있어도 평가액은 수량 × 종가 그대로다
    expect(sep30.totalAssetValue).toBe(100 * 110);
    expect(sep30.totalAssetValue).toBe(plain.totalAssetValue);
    expect(sep30.cashBalance).toBe(0);
  });

  it("anchor 이후 cashflow 가 있는 구간은 approximate 로 표시된다 (수량 추정은 하지 않는다)", () => {
    const withFlow = buildReconstructedRows({
      accounts: [{
        accountId: ACC,
        history: accounts[0].history,
        cashflowDates: ["2026-09-15"],
      }],
      library, actualSnapshots: actual, priceSeries: prices,
    });
    const byDate = new Map(withFlow.map((r) => [r.snapshotDate, r]));
    // anchor 당일(9/01)은 아직 입금 전이다
    expect(byDate.get("2026-09-01")!.approximate).toBeUndefined();
    expect(byDate.get("2026-09-30")!.approximate).toBe(true);
  });

  it("다음 anchor 가 생기면 그 이후 구간은 다시 approximate 가 아니다", () => {
    const rows = buildReconstructedRows({
      accounts: [{
        accountId: ACC,
        history: [
          entry("2026-09-01", { r1: { etf: ETF_A, qty: 100 } }),
          entry("2026-09-30", { r1: { etf: ETF_A, qty: 120 } }),
        ],
        cashflowDates: ["2026-09-15"],
      }],
      library, actualSnapshots: actual, priceSeries: prices,
    });
    const byDate = new Map(rows.map((r) => [r.snapshotDate, r]));
    expect(byDate.get("2026-09-30")!.approximate).toBeUndefined();
    expect(byDate.get("2026-09-30")!.marketValue).toBe(120 * 110);
  });
});

// ── 계획(요청 범위) ────────────────────────────────────────────────────────
describe("reconstructionPlan — 네트워크 요청 계획", () => {
  const accounts: ReconstructionAccountInput[] = [
    { accountId: ACC, history: [
      entry("2026-01-02", { r1: { etf: ETF_A, qty: 10 } }),
      entry("2026-05-02", { r1: { etf: ETF_A, qty: 10 }, r2: { etf: ETF_B, qty: 1 } }),
    ] },
    { accountId: ACC2, history: [entry("2026-03-02", { r1: { etf: ETF_B, qty: 20 } })] },
  ];

  it("가장 이른 anchor 부터 복원 상한까지, 필요한 ticker 만 요청한다", () => {
    const plan = reconstructionPlan(accounts, library, [], "2026-10-06")!;
    expect(plan.fromDate).toBe("2026-01-02");
    expect(plan.toDate).toBe("2026-10-06");
    expect(plan.tickers).toEqual([T_A, T_B]);
  });

  it("실제 스냅샷이 있는 계좌의 상한은 그 첫 스냅샷 날짜다", () => {
    const plan = reconstructionPlan(
      accounts, library,
      [
        { snapshotDate: "2026-06-01", accountId: ACC, marketValue: 1, cashBalance: 0, totalAssetValue: 1 },
        { snapshotDate: "2026-06-01", accountId: ACC2, marketValue: 1, cashBalance: 0, totalAssetValue: 1 },
      ],
      "2026-10-06",
    )!;
    expect(plan.toDate).toBe("2026-06-01");
  });

  it("복원할 구간이 없으면 null (요청 자체를 하지 않는다)", () => {
    expect(reconstructionPlan([], library, [], "2026-10-06")).toBeNull();
    expect(reconstructionPlan(
      [{ accountId: ACC, history: [] }], library, [], "2026-10-06",
    )).toBeNull();
    // 첫 anchor 가 이미 actual snapshot 시대라면 복원할 거래일이 없다
    expect(reconstructionPlan(
      [{ accountId: ACC, history: [entry("2026-10-05", { r1: { etf: ETF_A, qty: 1 } })] }],
      library,
      [{ snapshotDate: "2026-10-04", accountId: ACC, marketValue: 1, cashBalance: 0, totalAssetValue: 1 }],
      "2026-10-06",
    )).toBeNull();
  });

  it("ticker 를 못 찾는 보유종목만 있으면 null", () => {
    expect(reconstructionPlan(
      [{ accountId: ACC, history: [entry("2026-01-02", { r1: { etf: "매핑 없음", qty: 5 } })] }],
      library, [], "2026-10-06",
    )).toBeNull();
  });
});

describe("timelineHasReconstructed — 안내 badge 판정", () => {
  const rows: PerformanceTimelineRow[] = [
    { snapshotDate: "2026-09-30", accountId: ACC, marketValue: 1, cashBalance: 0, totalAssetValue: 1, source: "reconstructed" },
    { snapshotDate: "2026-10-05", accountId: ACC, marketValue: 2, cashBalance: 0, totalAssetValue: 2, source: "snapshot" },
    { snapshotDate: "2026-10-06", accountId: ACC, marketValue: 3, cashBalance: 0, totalAssetValue: 3, source: "snapshot" },
  ];

  it("구간에 복원 행이 포함되면 true", () => {
    expect(timelineHasReconstructed(rows, [{ fromDate: "2026-09-30", toDate: "2026-10-05" }])).toBe(true);
  });

  it("snapshot 만으로 된 구간이면 false", () => {
    expect(timelineHasReconstructed(rows, [{ fromDate: "2026-10-05", toDate: "2026-10-06" }])).toBe(false);
  });

  it("scope 밖 계좌의 복원 행은 세지 않는다", () => {
    expect(timelineHasReconstructed(
      rows, [{ fromDate: "2026-09-30", toDate: "2026-10-06" }], { accountIds: [ACC2] },
    )).toBe(false);
  });

  it("구간이 없으면 false", () => {
    expect(timelineHasReconstructed(rows, [])).toBe(false);
  });
});

describe("복원 행은 DB 에 쓰지 않는 파생값이다", () => {
  it("DailySnapshotRow 와 같은 모양이지만 source 메타데이터가 붙는다", () => {
    const rows = buildReconstructedRows({
      accounts: [{ accountId: ACC, history: [entry("2026-01-02", { r1: { etf: ETF_A, qty: 1 } })] }],
      library, actualSnapshots: [], priceSeries: series({ [T_A]: { "2026-01-02": 100 } }),
    });
    expect(Object.keys(rows[0]).sort()).toEqual([
      "accountId", "cashBalance", "marketValue", "snapshotDate", "source", "totalAssetValue",
    ]);
  });
});
