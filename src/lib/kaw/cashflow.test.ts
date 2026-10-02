import { describe, it, expect } from "vitest";
import {
  buildMigratedCashflows,
  computeAccountTotals,
  cumulativePrincipal,
  findScheduledCashflow,
  netCashflowByDate,
  periodOf,
  principalAsOf,
  type CashflowEntry,
  type CashflowHistoryLike,
} from "./cashflow";

// 기존(2차 작업 전) 누적 납입원금 계산식. migration 이 무손실인지 대조하는 기준으로만 쓴다.
function legacyPrincipal(history: readonly CashflowHistoryLike[]): number {
  if (!history.length) return 0;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  return sorted[0].baseAmount + sorted.slice(1).reduce((s, h) => s + Math.max(0, h.deposit ?? 0), 0);
}

// production(soye/hyeobi) 의 실제 모양을 축약한 fixture — 날짜/금액 패턴을 그대로 가져왔다.
const retirementHistory: CashflowHistoryLike[] = [
  { id: "h1", date: "2025-09-10", baseAmount: 65_177_647, deposit: 0 },
  { id: "h2", date: "2025-09-26", baseAmount: 67_783_181, deposit: 580_423 },
  { id: "h3", date: "2026-01-26", baseAmount: 77_940_393, deposit: 688_074 },
  { id: "h4", date: "2026-01-30", baseAmount: 79_562_094, deposit: 0 },
  { id: "h5", date: "2026-10-01", baseAmount: 79_813_653, deposit: 688_074 },
];

describe("cumulativePrincipal — 장부 합계가 원금 정의", () => {
  it("빈 장부는 0", () => {
    expect(cumulativePrincipal(undefined)).toBe(0);
    expect(cumulativePrincipal([])).toBe(0);
  });

  it("입금은 더하고 출금은 뺀다 (외부 입금 누계 - 외부 출금 누계)", () => {
    const flows: CashflowEntry[] = [
      { id: "a", date: "2026-01-01", amount: 10_000_000, type: "deposit" },
      { id: "b", date: "2026-02-01", amount: 500_000, type: "deposit" },
      { id: "c", date: "2026-07-15", amount: -15_000_000, type: "withdrawal" },
    ];
    expect(cumulativePrincipal(flows)).toBe(-4_500_000);
  });
});

describe("buildMigratedCashflows — 기존 history 복원은 무손실", () => {
  it("복원된 장부의 합계가 기존 계산식과 1원도 다르지 않다", () => {
    const flows = buildMigratedCashflows(retirementHistory);
    expect(cumulativePrincipal(flows)).toBe(legacyPrincipal(retirementHistory));
    expect(cumulativePrincipal(flows)).toBe(65_177_647 + 580_423 + 688_074 + 688_074);
  });

  it("첫 기록은 시작 보유자산 1건(adjustment), 이후 deposit>0 만 입금으로 기록한다", () => {
    const flows = buildMigratedCashflows(retirementHistory);
    expect(flows[0]).toMatchObject({
      date: "2025-09-10", amount: 65_177_647, type: "adjustment", source: "migration",
    });
    // deposit 이 0 인 기록(h4)은 장부에 들어가지 않는다
    expect(flows.filter((f) => f.type === "deposit")).toHaveLength(3);
    expect(flows.every((f) => f.source === "migration")).toBe(true);
  });

  it("첫 기록의 deposit 은 더하지 않는다 (기존 계산식과 같게 유지)", () => {
    const h: CashflowHistoryLike[] = [
      { id: "x1", date: "2026-01-01", baseAmount: 1_000_000, deposit: 777_777 },
      { id: "x2", date: "2026-02-01", baseAmount: 1_500_000, deposit: 400_000 },
    ];
    expect(cumulativePrincipal(buildMigratedCashflows(h))).toBe(1_400_000);
    expect(cumulativePrincipal(buildMigratedCashflows(h))).toBe(legacyPrincipal(h));
  });

  it("history 가 없으면 빈 장부", () => {
    expect(buildMigratedCashflows([])).toEqual([]);
    expect(buildMigratedCashflows(undefined)).toEqual([]);
  });

  it("날짜가 역순으로 저장돼 있어도 같은 결과", () => {
    const reversed = [...retirementHistory].reverse();
    expect(cumulativePrincipal(buildMigratedCashflows(reversed)))
      .toBe(cumulativePrincipal(buildMigratedCashflows(retirementHistory)));
  });
});

describe("예수금(cashBalance)은 납입원금에 섞이지 않는다", () => {
  // 실제 상황: 688,074원을 납입해 ETF 를 사고 3,621원이 예수금으로 남았다.
  // 원금은 688,074원이고, 3,621원을 다시 더하면 이중계산이다.
  const flows = buildMigratedCashflows(retirementHistory);
  const principal = cumulativePrincipal(flows);

  it("예수금이 변해도 누적 납입원금은 변하지 않는다", () => {
    const a = computeAccountTotals(79_480_585, 3_621, flows);
    const b = computeAccountTotals(79_480_585, 9_999_999, flows);
    expect(a.principal).toBe(principal);
    expect(b.principal).toBe(principal);
    expect(a.principal).toBe(b.principal);
  });

  it("총자산에는 예수금이 포함된다 (totalAsset = ETF + cash)", () => {
    const t = computeAccountTotals(79_480_585, 3_621, flows);
    expect(t.totalAsset).toBe(79_480_585 + 3_621);
  });

  it("gain = totalAsset - cumulativePrincipal", () => {
    const t = computeAccountTotals(79_480_585, 3_621, flows);
    expect(t.gain).toBe(t.totalAsset - t.principal);
    expect(t.gain).toBe(79_484_206 - principal);
  });

  it("principal + cashBalance 를 원금으로 쓰는 (잘못된) 식과 결과가 다르다", () => {
    const t = computeAccountTotals(79_480_585, 3_621, flows);
    const wrongPrincipal = principal + 3_621;
    expect(t.principal).not.toBe(wrongPrincipal);
    expect(wrongPrincipal - t.principal).toBe(3_621); // 정확히 예수금만큼 이중계산됐을 값
  });

  it("예수금 미입력(undefined)은 0으로 계산하되 cashEntered 로 구분된다", () => {
    const un = computeAccountTotals(1_000_000, undefined, flows);
    const zero = computeAccountTotals(1_000_000, 0, flows);
    expect(un.cashBalance).toBe(0);
    expect(un.cashEntered).toBe(false);
    expect(zero.cashEntered).toBe(true);
    expect(un.totalAsset).toBe(zero.totalAsset);
  });

  it("수익률 = gain / principal, 원금이 0이면 null", () => {
    const t = computeAccountTotals(11_000_000, 0, [
      { id: "a", date: "2026-01-01", amount: 10_000_000, type: "deposit" },
    ]);
    expect(t.returnPct).toBeCloseTo(10, 10);
    expect(computeAccountTotals(100, 0, []).returnPct).toBeNull();
  });
});

describe("buildMigratedCashflows — period 기록", () => {
  it("실제 history 날짜의 월을 period 로 기록한다", () => {
    const flows = buildMigratedCashflows(retirementHistory);
    expect(flows[0].period).toBe("2025-09");
    expect(flows.map((f) => f.period)).toEqual(["2025-09", "2025-09", "2026-01", "2026-10"]);
    expect(flows.every((f) => f.period === periodOf(f.date))).toBe(true);
  });

  it("같은 달에 입금 기록이 둘이면 합치지 않는다 (복원 손실 방지)", () => {
    // 실제 ISA 2026-06: 06-18 과 06-26 에 각각 3,000,000
    const isaJune: CashflowHistoryLike[] = [
      { id: "i1", date: "2026-01-26", baseAmount: 9_169_961, deposit: 0 },
      { id: "i2", date: "2026-06-18", baseAmount: 70_226_320, deposit: 3_000_000 },
      { id: "i3", date: "2026-06-26", baseAmount: 74_142_700, deposit: 3_000_000 },
    ];
    const flows = buildMigratedCashflows(isaJune);
    const june = flows.filter((f) => f.period === "2026-06");
    expect(june).toHaveLength(2);
    expect(cumulativePrincipal(flows)).toBe(legacyPrincipal(isaJune));
    expect(cumulativePrincipal(flows)).toBe(9_169_961 + 6_000_000);
  });
});

describe("findScheduledCashflow — 정기납입 확정 여부는 schedule 기록만 본다", () => {
  const base = buildMigratedCashflows(retirementHistory);

  it("복원된(migration) 기록은 정기납입 확정으로 보지 않는다", () => {
    // 10/1 리밸런싱으로 복원된 2026-10 기록은 실제로는 9월분 돈이다.
    // 이걸 10월 정기납입 완료로 취급하면 10월 입금이 영구히 누락된다.
    expect(base.some((c) => c.period === "2026-10")).toBe(true);
    expect(findScheduledCashflow(base, "sched:retirement", "2026-10")).toBeUndefined();
  });

  it("수동 기록도 정기납입 확정으로 보지 않는다", () => {
    const manual: CashflowEntry[] = [
      { id: "m1", date: "2026-11-10", amount: 688_074, type: "deposit", source: "manual", period: "2026-11" },
    ];
    expect(findScheduledCashflow(manual, "sched:retirement", "2026-11")).toBeUndefined();
  });

  it("레거시 rebalance 기록도 정기납입 확정으로 보지 않는다", () => {
    const legacy: CashflowEntry[] = [
      { id: "rb:x", date: "2026-11-05", amount: 688_074, type: "deposit", source: "rebalance", period: "2026-11" },
    ];
    expect(findScheduledCashflow(legacy, "sched:retirement", "2026-11")).toBeUndefined();
  });

  it("source/scheduleId/period 가 모두 맞는 기록만 찾는다", () => {
    const flows: CashflowEntry[] = [
      { id: "s1", date: "2026-11-25", amount: 688_074, type: "deposit", source: "schedule", scheduleId: "sched:retirement", period: "2026-11" },
    ];
    expect(findScheduledCashflow(flows, "sched:retirement", "2026-11")).toBeDefined();
    expect(findScheduledCashflow(flows, "sched:retirement", "2026-12")).toBeUndefined();
    expect(findScheduledCashflow(flows, "sched:pension", "2026-11")).toBeUndefined();
  });
});

describe("manual cashflow", () => {
  it("같은 날짜·같은 금액 2건이 모두 유지된다", () => {
    const flows: CashflowEntry[] = [
      { id: "m1", date: "2026-11-10", amount: 1_000_000, type: "deposit", source: "manual", period: "2026-11" },
      { id: "m2", date: "2026-11-10", amount: 1_000_000, type: "deposit", source: "manual", period: "2026-11" },
    ];
    expect(cumulativePrincipal(flows)).toBe(2_000_000);
  });

  it("수동 출금은 그대로 원금에서 빠진다", () => {
    const flows: CashflowEntry[] = [
      { id: "a", date: "2026-01-01", amount: 10_000_000, type: "deposit", source: "manual" },
      { id: "b", date: "2026-07-15", amount: -15_000_000, type: "withdrawal", source: "manual" },
    ];
    expect(cumulativePrincipal(flows)).toBe(-5_000_000);
  });
});

describe("netCashflowByDate — 기간 수익률용 날짜별 순흐름", () => {
  it("같은 날 입금과 출금을 합산한다", () => {
    const m = netCashflowByDate([
      { id: "a", date: "2026-07-15", amount: 500_000, type: "deposit" },
      { id: "b", date: "2026-07-15", amount: -15_000_000, type: "withdrawal" },
      { id: "c", date: "2026-08-01", amount: 250_000, type: "deposit" },
    ]);
    expect(m.get("2026-07-15")).toBe(-14_500_000);
    expect(m.get("2026-08-01")).toBe(250_000);
    expect(m.get("2026-09-01")).toBeUndefined();
  });
});

describe("principalAsOf", () => {
  const cashflows: CashflowEntry[] = [
    { id: "a", date: "2026-01-02", amount: 1_000_000, type: "adjustment" },
    { id: "b", date: "2026-01-25", amount: 500_000, type: "deposit" },
    { id: "c", date: "2026-02-10", amount: -200_000, type: "withdrawal" },
  ];

  it("기준일(포함)까지의 순입금만 센다", () => {
    expect(principalAsOf(cashflows, "2026-01-01")).toBe(0);
    expect(principalAsOf(cashflows, "2026-01-02")).toBe(1_000_000);
    expect(principalAsOf(cashflows, "2026-01-25")).toBe(1_500_000);
    expect(principalAsOf(cashflows, "2026-02-09")).toBe(1_500_000);
    expect(principalAsOf(cashflows, "2026-02-10")).toBe(1_300_000);
  });

  it("마지막 날짜 이후 기준이면 전체 합계(cumulativePrincipal)와 같다", () => {
    expect(principalAsOf(cashflows, "2026-12-31")).toBe(cumulativePrincipal(cashflows));
  });

  it("장부가 없으면 0 이다 — 추정하지 않는다", () => {
    expect(principalAsOf(undefined, "2026-02-10")).toBe(0);
    expect(principalAsOf([], "2026-02-10")).toBe(0);
  });
});
