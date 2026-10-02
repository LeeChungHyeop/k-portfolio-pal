import { describe, it, expect } from "vitest";
import { ACCOUNT_IDS } from "./constants";
import {
  aggregateByDate,
  aggregateCashflows,
  calculatePerformance,
  computePeriodPerformance,
  type DailySnapshotRow,
  type DatePoint,
  type PerformanceCashflow,
} from "./performance";

function snap(date: string, accountId: string, total: number, cash = 0): DailySnapshotRow {
  return {
    snapshotDate: date,
    accountId,
    marketValue: total - cash,
    cashBalance: cash,
    totalAssetValue: total,
  };
}

function flow(date: string, accountId: string, amount: number): PerformanceCashflow {
  return { date, accountId, amount };
}

/** 그 날 네 계좌 전부의 스냅샷을 만든다 (각 계좌 total 을 지정) */
function allFour(date: string, totals: [number, number, number, number]): DailySnapshotRow[] {
  return ACCOUNT_IDS.map((id, i) => snap(date, id, totals[i]));
}

const ALL = { requireAccountIds: ACCOUNT_IDS } as const;
const point = (date: string, total: number, accountCount = 1): DatePoint => ({ date, total, accountCount });

// ─────────────────────────────────────────────────────────────────────────────
// 2. 전체 scope 는 네 계좌 스냅샷이 모두 있는 날짜만 쓴다
// ─────────────────────────────────────────────────────────────────────────────

describe("전체 scope — 4계좌 snapshot 이 모두 있는 날짜만 사용", () => {
  it("4계좌 모두 존재 → 전체 point 생성", () => {
    const pts = aggregateByDate(allFour("2026-10-01", [100, 50, 20, 10]), ALL);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ date: "2026-10-01", total: 180, accountCount: 4 });
  });

  it("1계좌 누락 → 그 날짜 전체 point 없음", () => {
    const rows = [
      snap("2026-10-01", "retirement", 100),
      snap("2026-10-01", "isa", 50),
      snap("2026-10-01", "pension", 20),
      // irp 누락 (시세 미확보로 스냅샷 skip)
    ];
    expect(aggregateByDate(rows, ALL)).toHaveLength(0);
  });

  it("누락일이 전체 자산 급락처럼 보이지 않는다", () => {
    const rows = [
      ...allFour("2026-10-01", [100, 50, 20, 10]),
      // 10-02: irp 누락 → point 자체가 없어야 한다
      snap("2026-10-02", "retirement", 100), snap("2026-10-02", "isa", 50), snap("2026-10-02", "pension", 20),
      ...allFour("2026-10-05", [101, 50, 20, 10]),
    ];
    const pts = aggregateByDate(rows, ALL);
    expect(pts.map((p) => p.date)).toEqual(["2026-10-01", "2026-10-05"]);
    // 급락 구간(-10)이 만들어지지 않는다
    const daily = calculatePerformance(rows, [], ALL, "daily");
    expect(daily).toHaveLength(1);
    expect(daily[0].profit).toBe(1);
    expect(daily.every((p) => p.profit > -10)).toBe(true);
  });

  it("다음날 다시 4계좌 존재 → 불완전했던 전날을 기초점으로 쓰지 않는다", () => {
    const rows = [
      ...allFour("2026-10-01", [100, 50, 20, 10]),         // 완전 (180)
      snap("2026-10-02", "retirement", 100), snap("2026-10-02", "isa", 50), snap("2026-10-02", "pension", 20), // 불완전 (170)
      ...allFour("2026-10-03", [102, 50, 20, 10]),         // 완전 (182)
    ];
    const [d] = calculatePerformance(rows, [], ALL, "daily");
    expect(d.fromDate).toBe("2026-10-01"); // 10-02 가 아니다
    expect(d.beginningTotal).toBe(180);    // 170 이 아니다
    expect(d.toDate).toBe("2026-10-03");
    expect(d.profit).toBe(2);
  });

  it("계좌별 performance 는 그 계좌 snapshot 만 있으면 계산한다", () => {
    const rows = [
      snap("2026-10-01", "isa", 50),
      snap("2026-10-02", "isa", 55),
      // 다른 계좌는 아예 없다
    ];
    const isa = calculatePerformance(rows, [], { accountIds: ["isa"] }, "daily");
    expect(isa).toHaveLength(1);
    expect(isa[0].profit).toBe(5);
    // 같은 데이터로 전체 scope 를 보면 point 가 없다
    expect(calculatePerformance(rows, [], ALL, "daily")).toHaveLength(0);
  });

  it("계좌 간 -cashflow/+cashflow 는 완전 snapshot 날짜에서 합산 0", () => {
    const rows = [
      ...allFour("2026-10-01", [100, 10_000_000, 20, 1_000_000]),
      ...allFour("2026-10-02", [100, 9_000_000, 20, 2_000_000]),
    ];
    const flows = [flow("2026-10-02", "isa", -1_000_000), flow("2026-10-02", "irp", 1_000_000)];
    const [all] = calculatePerformance(rows, flows, ALL, "daily");
    expect(all.netCashflow).toBe(0);
    expect(all.beginningTotal).toBe(all.endingTotal);
    expect(all.profit).toBe(0);
  });

  it("계좌 하나만 보면 이동이 외부흐름으로 보인다 (의도된 동작)", () => {
    const rows = [snap("2026-10-01", "isa", 10_000_000), snap("2026-10-02", "isa", 9_000_000)];
    const flows = [flow("2026-10-02", "isa", -1_000_000), flow("2026-10-02", "irp", 1_000_000)];
    const [isa] = calculatePerformance(rows, flows, { accountIds: ["isa"] }, "daily");
    expect(isa.netCashflow).toBe(-1_000_000); // irp 쪽 +1,000,000 은 scope 밖이라 들어오지 않는다
    expect(isa.profit).toBe(0);
  });

  it("requireAccountIds 없이 집계하면 들어온 계좌를 그대로 더한다", () => {
    const rows = [snap("2026-10-01", "retirement", 100), snap("2026-10-01", "isa", 50)];
    expect(aggregateByDate(rows)).toEqual([point("2026-10-01", 150, 2)]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 외부 입출금의 source of truth 는 항상 현재 cashflow 장부
// ─────────────────────────────────────────────────────────────────────────────

describe("cashflow 는 계산 시점의 장부에서 읽는다 (snapshot 에 저장하지 않는다)", () => {
  // 10-01 1,000,000 → 10-02 1,500,000. 스냅샷은 평가액만 들고 있다.
  const rows = [snap("2026-10-01", "isa", 1_000_000), snap("2026-10-02", "isa", 1_500_000)];
  const isa = { accountIds: ["isa"] };

  it("장부가 비어 있으면 전액이 손익으로 보인다", () => {
    const [d] = calculatePerformance(rows, [], isa, "daily");
    expect(d.netCashflow).toBe(0);
    expect(d.profit).toBe(500_000);
  });

  it("snapshot 생성 후 과거 날짜 cashflow 추가 → 재스냅샷 없이 성과가 즉시 교정된다", () => {
    const [d] = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily");
    expect(d.netCashflow).toBe(500_000);
    expect(d.profit).toBe(0);
    expect(d.returnPct).toBe(0);
  });

  it("과거 cashflow 금액을 수정 → 성과도 수정된 ledger 기준으로 변경된다", () => {
    const a = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily")[0];
    const b = calculatePerformance(rows, [flow("2026-10-02", "isa", 300_000)], isa, "daily")[0];
    expect(a.profit).toBe(0);
    expect(b.netCashflow).toBe(300_000);
    expect(b.profit).toBe(200_000);
  });

  it("cashflow 삭제 → 성과에서 제거된다", () => {
    const withFlow = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily")[0];
    const removed = calculatePerformance(rows, [], isa, "daily")[0];
    expect(withFlow.netCashflow).toBe(500_000);
    expect(removed.netCashflow).toBe(0);
    expect(removed.profit).toBe(500_000);
  });

  it("snapshot 의 total_asset_value 자체는 cashflow 수정으로 변하지 않는다", () => {
    const a = calculatePerformance(rows, [], isa, "daily")[0];
    const b = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily")[0];
    expect(a.beginningTotal).toBe(b.beginningTotal);
    expect(a.endingTotal).toBe(b.endingTotal);
    expect(b.endingTotal).toBe(1_500_000);
    // 스냅샷 행 자체도 그대로다
    expect(rows[1].totalAssetValue).toBe(1_500_000);
  });

  it("스냅샷이 없는 날짜(휴장일·누락일)의 흐름도 구간에 포함된다", () => {
    // 10-03 은 스냅샷이 없지만 그 날 입금이 있었다 → 10-02~10-05 구간에 들어가야 한다
    const r = [snap("2026-10-02", "isa", 1_000_000), snap("2026-10-05", "isa", 1_500_000)];
    const [d] = calculatePerformance(r, [flow("2026-10-03", "isa", 500_000)], isa, "daily");
    expect(d.netCashflow).toBe(500_000);
    expect(d.profit).toBe(0);
  });

  it("구간 시작일의 흐름은 포함하지 않는다 (날짜 > 기초일, <= 기말일)", () => {
    const [d] = calculatePerformance(
      rows,
      [flow("2026-10-01", "isa", 500_000), flow("2026-10-03", "isa", 777)],
      isa, "daily",
    );
    expect(d.netCashflow).toBe(0);
    expect(d.profit).toBe(500_000);
  });

  it("aggregateCashflows 는 scope 밖 계좌를 제외하고 (날짜, timing) 별로 합산한다", () => {
    const out = aggregateCashflows(
      [
        flow("2026-07-15", "isa", 500_000),
        flow("2026-07-15", "isa", -15_000_000),
        flow("2026-07-15", "irp", 250_000),
        flow("2026-08-01", "isa", 250_000),
      ],
      isa,
    );
    expect(out).toEqual([
      { date: "2026-07-15", timing: "same_day", amount: -14_500_000 },
      { date: "2026-08-01", timing: "same_day", amount: 250_000 },
    ]);
  });

  it("같은 날짜라도 timing 이 다르면 따로 센다 (귀속 구간이 다르다)", () => {
    const out = aggregateCashflows([
      { accountId: "isa", date: "2026-10-25", amount: 500_000 },
      { accountId: "isa", date: "2026-10-25", amount: 688_074, timing: "after_close" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.timing).sort()).toEqual(["after_close", "same_day"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 기존 정의 유지 — 기간 손익 / Modified Dietz / 구간 끊기
// ─────────────────────────────────────────────────────────────────────────────

describe("기간 손익 = 기말 - 기초 - 외부흐름", () => {
  const isa = { accountIds: ["isa"] };

  it("입금만 한 날은 손익 0, 수익률 0%", () => {
    const rows = [snap("2026-10-01", "isa", 1_000_000), snap("2026-10-02", "isa", 1_500_000)];
    const [d] = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily");
    expect(d.profit).toBe(0);
    expect(d.returnPct).toBe(0);
  });

  it("단순 (기말-기초)/기초 로 계산하지 않는다", () => {
    const rows = [snap("2026-10-01", "isa", 1_000_000), snap("2026-10-02", "isa", 1_500_000)];
    const [d] = calculatePerformance(rows, [flow("2026-10-02", "isa", 500_000)], isa, "daily");
    expect(d.returnPct).not.toBeCloseTo(50, 6);
  });

  it("출금만 한 날도 손익 0", () => {
    const rows = [snap("2026-07-30", "isa", 70_000_000), snap("2026-07-31", "isa", 55_000_000)];
    const [d] = calculatePerformance(rows, [flow("2026-07-31", "isa", -15_000_000)], isa, "daily");
    expect(d.netCashflow).toBe(-15_000_000);
    expect(d.profit).toBe(0);
  });

  it("순수 시장 변동만 있으면 (기말-기초)/기초 와 같다", () => {
    const rows = [snap("2026-10-01", "isa", 1_000_000), snap("2026-10-02", "isa", 1_020_000)];
    const [d] = calculatePerformance(rows, [], isa, "daily");
    expect(d.profit).toBe(20_000);
    expect(d.returnPct).toBeCloseTo(2, 10);
  });
});

describe("Modified Dietz — 기간 중 들어온 돈은 남은 기간만큼만 분모에 반영", () => {
  const isa = { accountIds: ["isa"] };
  const rows = [
    snap("2026-10-01", "isa", 10_000_000),
    snap("2026-10-06", "isa", 11_000_000),
    snap("2026-10-11", "isa", 11_200_000),
  ];
  const flows = [flow("2026-10-06", "isa", 1_000_000)];

  it("월간 구간의 분모 = 기초자산 + Σ(흐름 x 남은기간비율)", () => {
    const [m] = calculatePerformance(rows, flows, isa, "monthly");
    expect(m.fromDate).toBe("2026-10-01");
    expect(m.toDate).toBe("2026-10-11");
    expect(m.partial).toBe(true);
    expect(m.netCashflow).toBe(1_000_000);
    expect(m.profit).toBe(200_000);
    // T = 10일, 흐름은 5일째 → w = (10-5)/10 = 0.5
    expect(m.averageCapital).toBe(10_500_000);
    expect(m.returnPct).toBeCloseTo(200_000 / 10_500_000 * 100, 10);
  });

  it("같은 날 구간(T=0)이면 분모는 기초자산", () => {
    const pts = [point("2026-10-01", 1_000_000), point("2026-10-01", 1_000_000)];
    const out = computePeriodPerformance(pts, "daily", [{ date: "2026-10-01", timing: "same_day", amount: 500_000 }]);
    expect(out.every((p) => p.averageCapital === 1_000_000)).toBe(true);
  });

  it("분모가 0 이하면 수익률은 null (가짜 숫자를 만들지 않는다)", () => {
    const pts = [point("2026-10-01", 0), point("2026-10-02", 0)];
    expect(computePeriodPerformance(pts, "daily")[0].returnPct).toBeNull();
  });
});

describe("구간 끊기", () => {
  const isa = { accountIds: ["isa"] };
  const rows = [
    snap("2026-09-28", "isa", 1_000_000),
    snap("2026-09-29", "isa", 1_010_000),
    snap("2026-10-01", "isa", 1_020_000),
    snap("2026-10-02", "isa", 1_030_000),
  ];

  it("일간은 연속한 두 스냅샷 (첫 스냅샷은 앞이 없어 구간이 되지 않는다)", () => {
    const d = calculatePerformance(rows, [], isa, "daily");
    expect(d.map((p) => [p.fromDate, p.toDate])).toEqual([
      ["2026-09-28", "2026-09-29"],
      ["2026-09-29", "2026-10-01"],
      ["2026-10-01", "2026-10-02"],
    ]);
  });

  it("월간은 전월 마지막 스냅샷을 기초로 쓴다", () => {
    const m = calculatePerformance(rows, [], isa, "monthly");
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ key: "2026-09", fromDate: "2026-09-28", toDate: "2026-09-29", partial: true });
    expect(m[1]).toMatchObject({ key: "2026-10", fromDate: "2026-09-29", toDate: "2026-10-02", partial: false });
    expect(m[1].profit).toBe(20_000);
  });

  it("연간도 같은 방식 — 전년 마지막 스냅샷이 기초", () => {
    const y = calculatePerformance(
      [snap("2025-12-30", "isa", 100), snap("2026-01-02", "isa", 110), snap("2026-12-30", "isa", 150)],
      [], isa, "yearly",
    );
    expect(y).toHaveLength(1); // 2025 는 스냅샷 1개뿐 → 제외
    expect(y[0]).toMatchObject({ key: "2026", fromDate: "2025-12-30", toDate: "2026-12-30", partial: false });
    expect(y[0].profit).toBe(50);
  });

  it("스냅샷이 1개뿐이면 결과가 없다 (가짜 0% 를 만들지 않는다)", () => {
    expect(calculatePerformance([snap("2026-10-01", "isa", 100)], [], isa, "daily")).toEqual([]);
    expect(calculatePerformance([snap("2026-10-01", "isa", 100)], [], isa, "monthly")).toEqual([]);
    expect(calculatePerformance([], [], isa, "daily")).toEqual([]);
  });

  it("스냅샷이 2개면 구간 1개", () => {
    expect(calculatePerformance(rows.slice(0, 2), [], isa, "daily")).toHaveLength(1);
  });

  it("날짜 오름차순으로 정렬된다", () => {
    const pts = aggregateByDate([snap("2026-10-05", "isa", 1), snap("2026-10-01", "isa", 2)], isa);
    expect(pts.map((p) => p.date)).toEqual(["2026-10-01", "2026-10-05"]);
  });
});
