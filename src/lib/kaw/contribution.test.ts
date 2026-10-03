import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  amountForPeriod,
  confirmContribution,
  createInitialSchedule,
  currentAmountVersion,
  nextPeriod,
  pendingContributions,
  scheduledDate,
  upsertAmountVersion,
  type RecurringContributionSchedule,
} from "./contribution";
import {
  buildMigratedCashflows,
  cumulativePrincipal,
  type CashflowEntry,
  type CashflowHistoryLike,
} from "./cashflow";
import { calculatePerformance, type DailySnapshotRow, type PerformanceCashflow } from "./performance";

const pension = (over: Partial<RecurringContributionSchedule> = {}): RecurringContributionSchedule => ({
  id: "sched:pension",
  enabled: true,
  dayOfMonth: 25,
  timing: "same_day",
  amountVersions: [{ effectiveFrom: "2026-10", amount: 500_000 }],
  ...over,
});

const retirement = (over: Partial<RecurringContributionSchedule> = {}): RecurringContributionSchedule => ({
  id: "sched:retirement",
  enabled: true,
  dayOfMonth: 25,
  timing: "after_close",
  amountVersions: [{ effectiveFrom: "2026-10", amount: 688_074 }],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 금액 버전 — 덮어쓰지 않고 "언제부터 얼마"를 쌓는다
// ─────────────────────────────────────────────────────────────────────────────

describe("금액 version — effectiveFrom 기준으로 그 달 금액을 찾는다", () => {
  const s = retirement({
    amountVersions: [
      { effectiveFrom: "2026-10", amount: 688_074 },
      { effectiveFrom: "2027-03", amount: 712_000 },
    ],
  });

  it("2027-02 = 688074, 2027-03 = 712000", () => {
    expect(amountForPeriod(s, "2027-02")).toBe(688_074);
    expect(amountForPeriod(s, "2027-03")).toBe(712_000);
  });

  it("시작월과 그 사이 달들도 이전 버전을 쓴다", () => {
    expect(amountForPeriod(s, "2026-10")).toBe(688_074);
    expect(amountForPeriod(s, "2026-12")).toBe(688_074);
    expect(amountForPeriod(s, "2027-01")).toBe(688_074);
  });

  it("이후 달은 계속 최신 버전", () => {
    expect(amountForPeriod(s, "2027-04")).toBe(712_000);
    expect(amountForPeriod(s, "2030-12")).toBe(712_000);
  });

  it("스케줄 시작 이전의 달은 null — 금액을 추정하지 않는다", () => {
    expect(amountForPeriod(s, "2026-09")).toBeNull();
    expect(amountForPeriod(s, "2025-01")).toBeNull();
  });

  it("버전 배열 순서가 뒤섞여 있어도 결과가 같다", () => {
    const shuffled = retirement({
      amountVersions: [
        { effectiveFrom: "2027-03", amount: 712_000 },
        { effectiveFrom: "2026-10", amount: 688_074 },
      ],
    });
    expect(amountForPeriod(shuffled, "2027-02")).toBe(688_074);
    expect(amountForPeriod(shuffled, "2027-03")).toBe(712_000);
  });

  it("currentAmountVersion 은 적용 중인 버전을 돌려준다", () => {
    expect(currentAmountVersion(s, "2027-02")).toEqual({ effectiveFrom: "2026-10", amount: 688_074 });
    expect(currentAmountVersion(s, "2027-03")).toEqual({ effectiveFrom: "2027-03", amount: 712_000 });
    expect(currentAmountVersion(s, "2026-09")).toBeNull();
  });
});

describe("upsertAmountVersion — 기존 버전을 덮어쓰지 않는다", () => {
  const base = [{ effectiveFrom: "2026-10", amount: 688_074 }];

  it("새 시작월은 추가된다 (과거 버전 보존)", () => {
    const out = upsertAmountVersion(base, "2027-03", 712_000);
    expect(out).toEqual([
      { effectiveFrom: "2026-10", amount: 688_074 },
      { effectiveFrom: "2027-03", amount: 712_000 },
    ]);
    expect(base).toEqual([{ effectiveFrom: "2026-10", amount: 688_074 }]); // 원본 불변
  });

  it("같은 시작월이면 그 달 금액만 교체한다 (버전이 둘로 늘지 않는다)", () => {
    const out = upsertAmountVersion(base, "2026-10", 700_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ effectiveFrom: "2026-10", amount: 700_000 });
  });

  it("시작월 오름차순으로 정렬된다", () => {
    let out = upsertAmountVersion([], "2027-03", 712_000);
    out = upsertAmountVersion(out, "2026-10", 688_074);
    expect(out.map((v) => v.effectiveFrom)).toEqual(["2026-10", "2027-03"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 날짜 계산
// ─────────────────────────────────────────────────────────────────────────────

describe("예정일", () => {
  it("scheduledDate 는 그 달에 없는 날을 말일로 당긴다", () => {
    expect(scheduledDate("2026-10", 25)).toBe("2026-10-25");
    expect(scheduledDate("2026-02", 31)).toBe("2026-02-28");
    expect(scheduledDate("2028-02", 31)).toBe("2028-02-29"); // 윤년
    expect(scheduledDate("2026-10", 0)).toBe("2026-10-01");
  });

  it("nextPeriod 는 연말을 넘어간다", () => {
    expect(nextPeriod("2026-10")).toBe("2026-11");
    expect(nextPeriod("2026-12")).toBe("2027-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pending 계산 — 예정일이 지났고 아직 장부에 없는 달만
// ─────────────────────────────────────────────────────────────────────────────

describe("pendingContributions", () => {
  it("예정일이 지났고 장부에 없으면 pending", () => {
    const out = pendingContributions(pension(), [], { today: "2026-10-28" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      scheduleId: "sched:pension", period: "2026-10", scheduledOn: "2026-10-25", expectedAmount: 500_000,
    });
  });

  // 납입일 이전에는 절대 뜨지 않는다 — 오늘이 10/02 인데 25일 납입이 보이면 안 된다.
  it("10/02 → pending 없음", () => {
    expect(pendingContributions(pension(), [], { today: "2026-10-02" })).toEqual([]);
    expect(pendingContributions(retirement(), [], { today: "2026-10-02" })).toEqual([]);
  });

  it("10/24 → pending 없음", () => {
    expect(pendingContributions(pension(), [], { today: "2026-10-24" })).toEqual([]);
    expect(pendingContributions(retirement(), [], { today: "2026-10-24" })).toEqual([]);
  });

  it("10/25 → 미확정이면 pending 있음 (당일 포함)", () => {
    expect(pendingContributions(pension(), [], { today: "2026-10-25" })).toHaveLength(1);
    expect(pendingContributions(retirement(), [], { today: "2026-10-25" })).toHaveLength(1);
  });

  it("confirm 후 → pending 없음", () => {
    const s = pension();
    const flows = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    expect(pendingContributions(s, flows, { today: "2026-10-25" })).toEqual([]);
    expect(pendingContributions(s, flows, { today: "2026-10-31" })).toEqual([]);
  });

  it("스케줄이 꺼져 있으면 pending 없음", () => {
    expect(pendingContributions(pension({ enabled: false }), [], { today: "2026-10-28" })).toEqual([]);
    expect(pendingContributions(undefined, [], { today: "2026-10-28" })).toEqual([]);
  });

  it("스케줄 시작 이전의 달은 pending 으로 만들지 않는다 (과거를 추정하지 않는다)", () => {
    // effectiveFrom 2026-10 → 2026-09 는 금액 버전이 없다
    const out = pendingContributions(pension(), [], { today: "2026-10-28", lookbackMonths: 6 });
    expect(out.map((p) => p.period)).toEqual(["2026-10"]);
  });

  it("이미 확정된 달은 pending 아님", () => {
    const s = pension();
    const flows = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    expect(pendingContributions(s, flows, { today: "2026-10-28" })).toEqual([]);
  });

  it("복원된(migration) 기록이 그 달에 있어도 pending 을 막지 않는다", () => {
    // 9/25 에 실제 입금된 688,074 가 10/1 리밸런싱 저장으로 **10월** 기록으로 복원됐다.
    // 이것을 10월 정기납입 완료로 취급하면 10월 입금이 영구히 누락된다.
    const history: CashflowHistoryLike[] = [
      { id: "h1", date: "2025-09-10", baseAmount: 65_177_647, deposit: 0 },
      { id: "h2", date: "2026-10-01", baseAmount: 79_813_653, deposit: 688_074 },
    ];
    const restored = buildMigratedCashflows(history);
    const out = pendingContributions(retirement(), restored, { today: "2026-10-25" });
    expect(out).toHaveLength(1);
    expect(out[0].period).toBe("2026-10");
  });

  it("수동/레거시 기록도 pending 을 막지 않는다", () => {
    const flows: CashflowEntry[] = [
      { id: "m1", date: "2026-10-10", amount: 500_000, type: "deposit", source: "manual", period: "2026-10" },
      { id: "rb:x", date: "2026-10-12", amount: 500_000, type: "deposit", source: "rebalance", period: "2026-10" },
    ];
    expect(pendingContributions(pension(), flows, { today: "2026-10-25" })).toHaveLength(1);
  });

  it("여러 달이 밀려 있으면 오래된 달부터 나온다", () => {
    const s = pension({ amountVersions: [{ effectiveFrom: "2026-09", amount: 500_000 }] });
    const out = pendingContributions(s, [], { today: "2026-11-26", lookbackMonths: 3 });
    expect(out.map((p) => p.period)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 입금 확인 → cashflow 1건
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmContribution — (scheduleId, period) 가 유일한 identity", () => {
  const s = pension();

  it("입금 확인 1회 → cashflow 1건, 원금은 정확히 amount 만 증가", () => {
    const before = cumulativePrincipal([]);
    const after = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      date: "2026-10-25", amount: 500_000, type: "deposit",
      source: "schedule", scheduleId: "sched:pension", period: "2026-10",
    });
    expect(cumulativePrincipal(after) - before).toBe(500_000);
  });

  it("같은 schedule + 같은 period 로 2회 confirm → cashflow 1건", () => {
    let f = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    f = confirmContribution(f, { schedule: s, period: "2026-10", amount: 500_000 });
    f = confirmContribution(f, { schedule: s, period: "2026-10", amount: 500_000 });
    expect(f).toHaveLength(1);
    expect(cumulativePrincipal(f)).toBe(500_000);
  });

  it("같은 달을 다른 금액으로 다시 확인하면 1건이며 금액이 갱신된다", () => {
    let f = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    f = confirmContribution(f, { schedule: s, period: "2026-10", amount: 520_000 });
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(520_000);
    expect(cumulativePrincipal(f)).toBe(520_000);
  });

  it("다음 달은 새 1건", () => {
    let f = confirmContribution([], { schedule: s, period: "2026-10", amount: 500_000 });
    f = confirmContribution(f, { schedule: s, period: "2026-11", amount: 500_000 });
    expect(f).toHaveLength(2);
    expect(f.map((c) => c.period)).toEqual(["2026-10", "2026-11"]);
    expect(cumulativePrincipal(f)).toBe(1_000_000);
  });

  it("계좌(스케줄)가 다르면 같은 달도 별개다", () => {
    let f = confirmContribution([], { schedule: pension(), period: "2026-10", amount: 500_000 });
    f = confirmContribution(f, { schedule: retirement(), period: "2026-10", amount: 688_074 });
    expect(f).toHaveLength(2);
  });

  it("입금 미확인 상태에서는 원금이 변하지 않는다", () => {
    const restored = buildMigratedCashflows([
      { id: "h1", date: "2026-01-26", baseAmount: 10_000_000, deposit: 0 },
    ]);
    const principalBefore = cumulativePrincipal(restored);
    // pending 이 있어도 장부는 그대로다
    expect(pendingContributions(pension(), restored, { today: "2026-10-28" })).toHaveLength(1);
    expect(cumulativePrincipal(restored)).toBe(principalBefore);
  });

  it("금액 0 이하는 기록하지 않는다", () => {
    expect(confirmContribution([], { schedule: s, period: "2026-10", amount: 0 })).toHaveLength(0);
    expect(confirmContribution([], { schedule: s, period: "2026-10", amount: -1 })).toHaveLength(0);
  });

  it("수동 기록과 섞여도 서로 간섭하지 않는다", () => {
    const manual: CashflowEntry[] = [
      { id: "m1", date: "2026-10-10", amount: 1_000_000, type: "deposit", source: "manual", period: "2026-10" },
      { id: "m2", date: "2026-10-10", amount: 1_000_000, type: "deposit", source: "manual", period: "2026-10" },
    ];
    const f = confirmContribution(manual, { schedule: s, period: "2026-10", amount: 500_000 });
    expect(f).toHaveLength(3); // 수동 2건 유지 + 정기 1건
    expect(cumulativePrincipal(f)).toBe(2_500_000);
    // 다시 확인해도 수동 기록은 건드리지 않고 정기 1건만 유지
    const again = confirmContribution(f, { schedule: s, period: "2026-10", amount: 500_000 });
    expect(again).toHaveLength(3);
  });

  it("after_close 도 date 는 실제 입금일(25일) 그대로이고 timing 이 기록된다", () => {
    const f = confirmContribution([], { schedule: retirement(), period: "2026-10", amount: 688_074 });
    expect(f[0].date).toBe("2026-10-25");   // 26일/다음 스냅샷으로 밀지 않는다
    expect(f[0].timing).toBe("after_close");
    expect(f[0].period).toBe("2026-10");
  });

  it("same_day 는 timing 이 same_day 로 기록된다", () => {
    const f = confirmContribution([], { schedule: pension(), period: "2026-10", amount: 500_000 });
    expect(f[0].date).toBe("2026-10-25");
    expect(f[0].timing).toBe("same_day");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// after_close 와 기간 성과 — 25일 구간으로 소급되지 않는다
// ─────────────────────────────────────────────────────────────────────────────

describe("retirement after_close — 날짜는 25일, 귀속만 다음 구간", () => {
  const flows = confirmContribution([], { schedule: retirement(), period: "2026-10", amount: 688_074 });
  const perfFlows: PerformanceCashflow[] = flows.map((c) => ({
    accountId: "retirement", date: c.date, amount: c.amount, timing: c.timing,
  }));
  // 23일 100,000,000 → 25일 100,500,000(시장 +50만) → 27일 101,188,074(+688,074 입금)
  const snaps: DailySnapshotRow[] = [
    { snapshotDate: "2026-10-23", accountId: "retirement", marketValue: 100_000_000, cashBalance: 0, totalAssetValue: 100_000_000 },
    { snapshotDate: "2026-10-25", accountId: "retirement", marketValue: 100_500_000, cashBalance: 0, totalAssetValue: 100_500_000 },
    { snapshotDate: "2026-10-27", accountId: "retirement", marketValue: 100_500_000, cashBalance: 688_074, totalAssetValue: 101_188_074 },
  ];
  const scope = { accountIds: ["retirement"] };

  it("장부에는 실제 입금일 25일로 남는다", () => {
    expect(flows[0].date).toBe("2026-10-25");
  });

  it("이전 snapshot → 25일 구간에는 미포함", () => {
    const daily = calculatePerformance(snaps, perfFlows, scope, "daily");
    const to25 = daily.find((p) => p.toDate === "2026-10-25")!;
    expect(to25.fromDate).toBe("2026-10-23");
    expect(to25.netCashflow).toBe(0);
    expect(to25.profit).toBe(500_000); // 순수 시장 변동만
  });

  it("25일 → 다음 유효 snapshot 구간에는 포함", () => {
    const daily = calculatePerformance(snaps, perfFlows, scope, "daily");
    const to27 = daily.find((p) => p.toDate === "2026-10-27")!;
    expect(to27.fromDate).toBe("2026-10-25");
    expect(to27.netCashflow).toBe(688_074);
    expect(to27.profit).toBe(0); // 입금뿐이고 평가액은 그대로
  });

  it("구간 시작 직후에 들어온 돈이므로 분모 가중치는 1 이다", () => {
    const daily = calculatePerformance(snaps, perfFlows, scope, "daily");
    const to27 = daily.find((p) => p.toDate === "2026-10-27")!;
    expect(to27.averageCapital).toBe(100_500_000 + 688_074);
  });

  it("같은 입금을 same_day 로 기록하면(잘못된 처리) 25일 구간 손익이 틀어진다", () => {
    const wrong: PerformanceCashflow[] = [{ accountId: "retirement", date: "2026-10-25", amount: 688_074 }];
    const daily = calculatePerformance(snaps, wrong, scope, "daily");
    const to25 = daily.find((p) => p.toDate === "2026-10-25")!;
    expect(to25.netCashflow).toBe(688_074);
    expect(to25.profit).toBe(500_000 - 688_074); // 음수로 왜곡 — 그래서 timing 으로 귀속을 조정한다
  });

  it("25일이 휴일이라 25일 snapshot 이 없으면 전후 유효 snapshot 사이 구간에 포함된다", () => {
    // 공휴일 달력을 만들지 않는다 — 24일·28일 스냅샷만 있으면 24~28 구간에 들어간다
    const holiday: DailySnapshotRow[] = [
      { snapshotDate: "2026-10-24", accountId: "retirement", marketValue: 100_000_000, cashBalance: 0, totalAssetValue: 100_000_000 },
      { snapshotDate: "2026-10-28", accountId: "retirement", marketValue: 100_000_000, cashBalance: 688_074, totalAssetValue: 100_688_074 },
    ];
    const [d] = calculatePerformance(holiday, perfFlows, scope, "daily");
    expect(d.fromDate).toBe("2026-10-24");
    expect(d.toDate).toBe("2026-10-28");
    expect(d.netCashflow).toBe(688_074);
    expect(d.profit).toBe(0);
  });

  it("25일 이후에 시작하는 구간에는 다시 들어가지 않는다 (한 번만 센다)", () => {
    const later: DailySnapshotRow[] = [
      ...snaps,
      { snapshotDate: "2026-10-28", accountId: "retirement", marketValue: 101_188_074, cashBalance: 0, totalAssetValue: 101_188_074 },
    ];
    const daily = calculatePerformance(later, perfFlows, scope, "daily");
    expect(daily.reduce((sum, p) => sum + p.netCashflow, 0)).toBe(688_074);
    const to28 = daily.find((p) => p.toDate === "2026-10-28")!;
    expect(to28.netCashflow).toBe(0);
  });

  it("월간 성과는 그 달 입금을 한 번만 센다", () => {
    const monthly = calculatePerformance(snaps, perfFlows, scope, "monthly");
    expect(monthly).toHaveLength(1);
    expect(monthly[0].netCashflow).toBe(688_074);
    expect(monthly[0].profit).toBe(500_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pending 은 성과·원금에 포함되지 않는다
// ─────────────────────────────────────────────────────────────────────────────

describe("pending schedule 은 성과·원금에 포함되지 않는다", () => {
  const snaps: DailySnapshotRow[] = [
    { snapshotDate: "2026-10-23", accountId: "pension", marketValue: 10_000_000, cashBalance: 0, totalAssetValue: 10_000_000 },
    { snapshotDate: "2026-10-27", accountId: "pension", marketValue: 10_000_000, cashBalance: 500_000, totalAssetValue: 10_500_000 },
  ];
  const scope = { accountIds: ["pension"] };

  it("입금 미확인이면 확정 cashflow 가 없어 그 증가분이 손익으로 보인다", () => {
    const [d] = calculatePerformance(snaps, [], scope, "daily");
    expect(d.netCashflow).toBe(0);
    expect(d.profit).toBe(500_000);
  });

  it("입금 확인 후에는 외부흐름으로 빠지고 손익이 0이 된다", () => {
    const flows = confirmContribution([], { schedule: pension(), period: "2026-10", amount: 500_000 });
    const perfFlows: PerformanceCashflow[] = flows.map((c) => ({ accountId: "pension", date: c.date, amount: c.amount, timing: c.timing }));
    const [d] = calculatePerformance(snaps, perfFlows, scope, "daily");
    expect(d.netCashflow).toBe(500_000);
    expect(d.profit).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 저장은 cashflow 를 만들거나 수정하지 않는다
//
// 입금과 리밸런싱은 독립된 이벤트다(입금 → 예수금 → 나중에 매수). 그래서
// history.deposit / addHistory() 는 cashflow 의 source of truth 가 아니다.
// 이 규칙은 store 의 addHistory 구현에 있어서 순수 함수로 테스트할 수 없으므로,
// 회귀를 막기 위해 **해당 구현에 장부를 건드리는 코드가 없다**는 것을 직접 확인한다.
// ─────────────────────────────────────────────────────────────────────────────

describe("리밸런싱 저장 → cashflow 변화 없음", () => {
  const storeSrc = fs.readFileSync(path.join(import.meta.dirname, "store.ts"), "utf8");

  it("store 가 리밸런싱 기록용 cashflow 생성 함수를 더 이상 쓰지 않는다", () => {
    expect(storeSrc).not.toContain("recordRebalanceCashflow");
  });

  it("addHistory 구현 안에서 cashflows 를 수정하지 않는다", () => {
    const start = storeSrc.indexOf("const addHistory");
    expect(start).toBeGreaterThan(0);
    const end = storeSrc.indexOf("const removeHistory", start);
    expect(end).toBeGreaterThan(start);
    const body = storeSrc.slice(start, end);
    expect(body).not.toContain("cashflows:");
    expect(body).not.toContain("confirmContribution");
  });

  it("cashflow 를 만드는 경로는 정기납입 확인 / 수동 기록 / 1회 복원뿐이다", () => {
    // 장부에 쓰는 store 액션 이름들 — 리밸런싱 저장 경로는 여기에 없다
    expect(storeSrc).toContain("confirmContributionDeposit");
    expect(storeSrc).toContain("addCashflow");
    expect(storeSrc).toContain("buildMigratedCashflows");
  });
});

describe("createInitialSchedule (최초 1회 생성)", () => {
  const seed = { dayOfMonth: 25, timing: "after_close" as const, enabled: true };

  it("금액은 계좌에 저장된 월 납입액을 첫 버전으로 옮긴다 — 코드에 박지 않는다", () => {
    const s = createInitialSchedule("sched:retirement", seed, 688_074, "2026-10");
    expect(s).toEqual({
      id: "sched:retirement",
      enabled: true,
      dayOfMonth: 25,
      timing: "after_close",
      amountVersions: [{ effectiveFrom: "2026-10", amount: 688_074 }],
    });
  });

  it("적용 시작월이 생성 시점의 월이라 그 이전 달은 pending 으로 뜨지 않는다", () => {
    const s = createInitialSchedule("sched:retirement", seed, 688_074, "2026-10");
    expect(amountForPeriod(s, "2026-09")).toBeNull();
    expect(amountForPeriod(s, "2026-10")).toBe(688_074);
    expect(
      pendingContributions(s, [], { today: "2026-10-31" }).map((p) => p.period),
    ).toEqual(["2026-10"]);
  });

  it("금액이 없으면 버전 없이 비활성으로 만든다 (금액을 추정하지 않는다)", () => {
    expect(createInitialSchedule("sched:isa", seed, 0, "2026-10")).toMatchObject({
      enabled: false,
      amountVersions: [],
    });
    expect(createInitialSchedule("sched:isa", seed, undefined, "2026-10")).toMatchObject({
      enabled: false,
      amountVersions: [],
    });
  });

  it("seed 가 비활성이면 금액이 있어도 비활성이다 (ISA)", () => {
    const s = createInitialSchedule("sched:isa", { ...seed, enabled: false }, 300_000, "2026-10");
    expect(s.enabled).toBe(false);
    expect(s.amountVersions).toEqual([{ effectiveFrom: "2026-10", amount: 300_000 }]);
  });
});

describe("store: hydration 에서 만든 스케줄의 1회 영속", () => {
  const storeSrc = fs.readFileSync(path.join(import.meta.dirname, "store.ts"), "utf8");

  it("migrateState 는 생성 사실만 알리고 직접 저장하지 않는다", () => {
    const start = storeSrc.indexOf("function migrateState");
    const end = storeSrc.indexOf("// ── Module-level state", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = storeSrc.slice(start, end);
    expect(body).toContain("createInitialSchedule");
    expect(body).toContain("out.createdContributionSchedule = true");
    expect(body).not.toContain("dbSave(");
    expect(body).not.toContain("scheduleSave()");
  });

  it("적용 시작월은 UTC 가 아니라 KST 기준으로 넘긴다", () => {
    const start = storeSrc.indexOf("createInitialSchedule(");
    expect(start).toBeGreaterThan(0);
    const call = storeSrc.slice(start, storeSrc.indexOf(");", start));
    expect(call).toContain("kstMonthString()");
    // 매월 1일 오전(KST)에 이전 달로 생성되던 UTC 계산이 남아 있지 않다
    expect(call).not.toContain("toISOString");
  });

  it("영속은 프로필당 세션 1회만 시도한다 — 폴링마다 dbSave 를 반복하지 않는다", () => {
    const start = storeSrc.indexOf("function persistMigrationOnce");
    expect(start).toBeGreaterThan(0);
    const body = storeSrc.slice(start, storeSrc.indexOf("// ── 폴링", start));
    // 플래그를 즉시 내려서 같은 생성이 두 번 저장되지 않게 한다
    expect(body).toContain("hydrationMigration.createdContributionSchedule = false");
    expect(body).toContain("migrationPersistAttempted.has(key)");
    expect(body).toContain("migrationPersistAttempted.add(key)");
    expect(body).toContain("scheduleSave()");
    // setInterval/폴링을 새로 만들지 않는다
    expect(body).not.toContain("setInterval");
    expect(body).not.toContain("setTimeout");
  });

  it("DB 를 읽는 hydration 경로마다 생성 감지 → 영속이 걸려 있다", () => {
    // migrateState 호출은 모두 hydrationMigration 을 넘겨야 생성을 감지할 수 있다
    const calls = storeSrc.match(/migrateState\(/g) ?? [];
    const withOut = storeSrc.match(/hydrationMigration\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(withOut.length).toBe(calls.length - 1); // 정의 1건 제외
    // 각 hydration 경로(최초 로드 / 프로필 활성화 / 수동 동기화 / 폴링 / 가시성 복귀)에서 호출
    expect((storeSrc.match(/persistMigrationOnce\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});
