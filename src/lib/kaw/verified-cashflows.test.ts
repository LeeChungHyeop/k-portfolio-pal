// 실제 증권사 자료로 확정한 과거 cashflow 를 테스트로 고정한다.
//
// 금액·날짜는 원본 자료(미래에셋 공식 납입내역 / 거래내역)의 값이다. 여기서 깨지면
// **코드가 틀린 것**이지 테스트를 고칠 일이 아니다.
import { describe, it, expect } from "vitest";
import { ACCOUNT_IDS, type AccountId } from "./constants";
import {
  VERIFIED_HISTORICAL_CASHFLOWS,
  verifiedCashflowsFor,
  verifiedPrincipalOf,
  verifiedPrincipalTotal,
  CASHFLOW_SOURCE_VERIFIED,
} from "./verified-cashflows";
import {
  buildMigratedCashflows, cumulativePrincipal, findScheduledCashflow,
  CASHFLOW_SOURCE_SCHEDULE, type CashflowEntry,
} from "./cashflow";
import { seedState, migrateState, type StoreState, type AccountState } from "./store";

const of = (id: AccountId) => verifiedCashflowsFor(id);
const sumOf = (list: readonly CashflowEntry[]) => list.reduce((s, c) => s + c.amount, 0);
const inMonth = (id: AccountId, month: string) =>
  of(id).filter((c) => c.date.startsWith(month));

// ── 1~5: 퇴직연금(DC) ──────────────────────────────────────────────────────
describe("퇴직연금 — 미래에셋 공식 부담금 납입내역", () => {
  it("(1) 검증된 납입원금 합계 = 72,691,626", () => {
    expect(verifiedPrincipalOf("retirement")).toBe(72_691_626);
  });

  it("(2) 정기부담금(일시전환 제외)만의 합계 = 11,768,166", () => {
    const regular = of("retirement").filter((c) => c.type !== "adjustment");
    expect(sumOf(regular)).toBe(11_768_166);
    // 일시전환 원금은 adjustment 1건이다
    const lump = of("retirement").filter((c) => c.type === "adjustment");
    expect(lump).toHaveLength(1);
    expect(lump[0]).toMatchObject({ date: "2025-03-25", amount: 60_923_460 });
  });

  it("(3) 2025-12-24 는 580,419 다 (그 달만 4원 적다)", () => {
    const dec = of("retirement").filter((c) => c.date === "2025-12-24");
    expect(dec).toHaveLength(1);
    expect(dec[0].amount).toBe(580_419);
    // 그 앞 달들은 580,423
    expect(of("retirement").find((c) => c.date === "2025-11-24")!.amount).toBe(580_423);
  });

  it("(4) 2026-01 에 351,697 + 688,074 두 건이 있다", () => {
    const jan = inMonth("retirement", "2026-01");
    expect(jan).toHaveLength(2);
    expect(jan.map((c) => `${c.date}:${c.amount}`)).toEqual([
      "2026-01-08:351697",
      "2026-01-23:688074",
    ]);
  });

  it("(5) 2025-09-10 opening adjustment 가 없다 (전략 시작일 ≠ 계좌 원금 시작일)", () => {
    expect(of("retirement").some((c) => c.date === "2025-09-10")).toBe(false);
    // 잘못된 opening principal 금액도 어디에도 없다
    expect(of("retirement").some((c) => c.amount === 65_177_647)).toBe(false);
    // 가장 이른 흐름은 DC 전환일이다
    expect(of("retirement")[0].date).toBe("2025-03-25");
  });

  it("DC timing 은 after_close 정책을 유지한다 (전환원금만 same_day)", () => {
    for (const c of of("retirement")) {
      expect(c.timing).toBe(c.type === "adjustment" ? "same_day" : "after_close");
    }
  });
});

// ── 6~7: 연금저축 ──────────────────────────────────────────────────────────
describe("연금저축 — 미래에셋 실제 거래내역", () => {
  it("(6) 합계 = 10,500,000", () => {
    expect(verifiedPrincipalOf("pension")).toBe(10_500_000);
  });

  it("(7) 최초 cashflow 는 2025-11-10 / 6,000,000 이다", () => {
    expect(of("pension")[0]).toMatchObject({ date: "2025-11-10", amount: 6_000_000 });
  });

  it("migration 이 만들던 잘못된 2025-10-22 기록이 없다", () => {
    expect(of("pension").some((c) => c.date === "2025-10-22")).toBe(false);
  });

  it("2026 정기 입금은 9건 × 500,000 이다", () => {
    const y2026 = of("pension").filter((c) => c.date.startsWith("2026"));
    expect(y2026).toHaveLength(9);
    expect(y2026.every((c) => c.amount === 500_000)).toBe(true);
  });
});

// ── 8~9: ISA ───────────────────────────────────────────────────────────────
describe("ISA — 미래에셋 실제 거래내역", () => {
  it("(8) 합계 = 63,663,392", () => {
    expect(verifiedPrincipalOf("isa")).toBe(63_663_392);
  });

  it("(9) 2026-03 에 144,963 + 3,000,000 두 건이 있다", () => {
    const mar = inMonth("isa", "2026-03");
    expect(mar).toHaveLength(2);
    expect(mar.map((c) => `${c.date}:${c.amount}`)).toEqual([
      "2026-03-03:144963",
      "2026-03-26:3000000",
    ]);
  });

  it("2026-04-17 대형 입금 41,406,117 이 보존된다", () => {
    expect(of("isa").find((c) => c.date === "2026-04-17")!.amount).toBe(41_406_117);
  });
});

// ── 10~12: IRP ─────────────────────────────────────────────────────────────
describe("IRP — 미래에셋 공식 가입자부담금 납입내역", () => {
  it("(10) 합계 = 5,000,000", () => {
    expect(verifiedPrincipalOf("irp")).toBe(5_000_000);
  });

  it("(11) 2026-04 에 500,000 + 250,000 두 건이 있다", () => {
    const apr = inMonth("irp", "2026-04");
    expect(apr).toHaveLength(2);
    expect(apr.map((c) => `${c.date}:${c.amount}`)).toEqual([
      "2026-04-23:500000",
      "2026-04-27:250000",
    ]);
  });

  it("(12) migration 이 만들던 2026-03-25 750,000 / 2026-05-31 150,000 이 없다", () => {
    expect(of("irp").some((c) => c.date === "2026-03-25")).toBe(false);
    expect(of("irp").some((c) => c.amount === 750_000)).toBe(false);
    expect(of("irp").some((c) => c.date === "2026-05-31")).toBe(false);
    expect(of("irp").some((c) => c.amount === 150_000)).toBe(false);
  });
});

// ── 자료 자체의 무결성 ─────────────────────────────────────────────────────
describe("검증 장부의 무결성", () => {
  it("모든 계좌에서 날짜가 오름차순이고 중복 id 가 없다", () => {
    for (const id of ACCOUNT_IDS) {
      const list = of(id);
      expect(list.length).toBeGreaterThan(0);
      const dates = list.map((c) => c.date);
      expect([...dates]).toEqual([...dates].sort());
      expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
      // 날짜가 계좌 안에서 유일하다는 전제 위에 id 를 만든다
      expect(new Set(dates).size).toBe(dates.length);
    }
  });

  it("모든 기록의 source 가 verified 이고 period 가 입금일의 월이다", () => {
    for (const id of ACCOUNT_IDS) {
      for (const c of of(id)) {
        expect(c.source).toBe(CASHFLOW_SOURCE_VERIFIED);
        expect(c.period).toBe(c.date.slice(0, 7));
        expect(Number.isFinite(c.amount) && c.amount > 0).toBe(true);
      }
    }
  });

  it("verifiedCashflowsFor 는 복사본을 주므로 상수가 오염되지 않는다", () => {
    const copy = verifiedCashflowsFor("irp");
    copy[0].amount = 1;
    copy.push({ id: "x", date: "2030-01-01", amount: 1, type: "deposit" });
    expect(verifiedPrincipalOf("irp")).toBe(5_000_000);
    expect(VERIFIED_HISTORICAL_CASHFLOWS.irp).toHaveLength(8);
  });
});

// ── 17: 합계 ───────────────────────────────────────────────────────────────
describe("(17) cumulativePrincipal 결과가 계좌별 합계와 일치한다", () => {
  it("계좌별", () => {
    expect(cumulativePrincipal(of("retirement"))).toBe(72_691_626);
    expect(cumulativePrincipal(of("pension"))).toBe(10_500_000);
    expect(cumulativePrincipal(of("isa"))).toBe(63_663_392);
    expect(cumulativePrincipal(of("irp"))).toBe(5_000_000);
  });

  it("네 계좌 전체 = 151,855,018", () => {
    expect(verifiedPrincipalTotal()).toBe(151_855_018);
    const all = ACCOUNT_IDS.flatMap((id) => of(id));
    expect(cumulativePrincipal(all)).toBe(151_855_018);
  });
});

// ── 13~16: seed / migration 규칙 ───────────────────────────────────────────
function legacyState(cashflows?: Record<string, CashflowEntry[]>): StoreState {
  // cashflows 가 아예 없는(= 옛 스키마) 상태를 만든다. history 는 seed 그대로 둔다.
  const base = seedState();
  for (const id of ACCOUNT_IDS) {
    const acc = base.accounts[id] as AccountState & { cashflows?: CashflowEntry[] };
    if (cashflows?.[id]) acc.cashflows = cashflows[id];
    else delete acc.cashflows;
  }
  return base;
}

describe("seed / migration 규칙", () => {
  it("(16) reset seed(seedState)가 검증된 cashflow 를 포함한다", () => {
    const seed = seedState();
    for (const id of ACCOUNT_IDS) {
      expect(cumulativePrincipal(seed.accounts[id].cashflows)).toBe(verifiedPrincipalOf(id));
    }
    const total = ACCOUNT_IDS.reduce(
      (s, id) => s + cumulativePrincipal(seed.accounts[id].cashflows), 0,
    );
    expect(total).toBe(151_855_018);
  });

  it("seedState 가 매번 새 배열을 주므로 한 상태의 수정이 다음 seed 에 새지 않는다", () => {
    const a = seedState();
    a.accounts.irp.cashflows!.push({
      id: "x", date: "2030-01-01", amount: 999, type: "deposit",
    });
    expect(cumulativePrincipal(seedState().accounts.irp.cashflows)).toBe(5_000_000);
  });

  it("(14) cashflows 가 없는 legacy hyeobi 상태는 검증된 cashflow 로 채워진다", () => {
    const migrated = migrateState(legacyState(), true);
    for (const id of ACCOUNT_IDS) {
      expect(cumulativePrincipal(migrated.accounts[id].cashflows)).toBe(verifiedPrincipalOf(id));
      expect(migrated.accounts[id].cashflows!.every((c) => c.source === CASHFLOW_SOURCE_VERIFIED))
        .toBe(true);
    }
    // history 에서 복원했다면 나왔을 잘못된 기록이 없다
    expect(migrated.accounts.irp.cashflows!.some((c) => c.amount === 750_000)).toBe(false);
    expect(migrated.accounts.retirement.cashflows!.some((c) => c.date === "2025-09-10")).toBe(false);
  });

  it("(13) 이미 cashflows 가 있는 상태는 migrateState 가 덮어쓰지 않는다", () => {
    const mine: CashflowEntry[] = [
      { id: "db:1", date: "2026-02-02", amount: 123_456, type: "deposit", source: "manual" },
    ];
    const migrated = migrateState(
      legacyState({ retirement: mine, isa: [], pension: [], irp: [] }),
      true,
    );
    expect(migrated.accounts.retirement.cashflows).toEqual(mine);
    // 빈 배열도 "이미 복원됨"이다 — 검증 장부로 다시 채우지 않는다
    expect(migrated.accounts.isa.cashflows).toEqual([]);
    expect(migrated.accounts.irp.cashflows).toEqual([]);
  });

  it("(15) non-hyeobi profile 은 기존 generic buildMigratedCashflows 동작을 유지한다", () => {
    const migrated = migrateState(legacyState(), false);
    for (const id of ACCOUNT_IDS) {
      const expected = buildMigratedCashflows(migrated.accounts[id].history);
      expect(migrated.accounts[id].cashflows).toEqual(expected);
      expect(migrated.accounts[id].cashflows!.some((c) => c.source === CASHFLOW_SOURCE_VERIFIED))
        .toBe(false);
    }
    // 검증 장부가 다른 profile 로 새지 않는다
    expect(cumulativePrincipal(migrated.accounts.irp.cashflows)).not.toBe(5_000_000);
  });

  it("non-hyeobi 는 계좌가 통째로 없어도 seed history/검증장부를 빌려가지 않는다", () => {
    const bare = { profile: "growth", allocations: {}, accounts: {} } as unknown as StoreState;
    const migrated = migrateState(bare, false);
    for (const id of ACCOUNT_IDS) {
      expect(migrated.accounts[id].history).toEqual([]);
      expect(migrated.accounts[id].cashflows).toEqual([]);
    }
  });
});

// ── 정기납입 스케줄에 영향 없음 ────────────────────────────────────────────
describe("future contribution schedule 과 분리돼 있다", () => {
  it("검증 기록은 정기납입 확정 판정에 끼어들지 않는다 (source=schedule 만 본다)", () => {
    for (const id of ACCOUNT_IDS) {
      for (const c of of(id)) {
        // 같은 달·같은 스케줄 id 로 찾아도 검증 기록은 잡히지 않는다
        expect(findScheduledCashflow(of(id), `sched:${id}`, c.period!)).toBeUndefined();
      }
    }
  });

  it("검증 기록에는 scheduleId 가 없고 source 가 schedule 이 아니다", () => {
    for (const id of ACCOUNT_IDS) {
      for (const c of of(id)) {
        expect(c.scheduleId).toBeUndefined();
        expect(c.source).not.toBe(CASHFLOW_SOURCE_SCHEDULE);
      }
    }
  });

  it("seed 상태의 정기납입 스케줄은 검증 장부 때문에 바뀌지 않는다", () => {
    const migrated = migrateState(legacyState(), true);
    // 금액 버전은 계좌의 deposit 에서 오고, 적용 시작월은 생성 시점의 월이다 —
    // 과거 월 스케줄 기록을 새로 만들지 않는다.
    const irpSchedule = migrated.accounts.irp.contributionSchedule!;
    expect(irpSchedule.amountVersions).toHaveLength(1);
    expect(irpSchedule.amountVersions[0].amount).toBe(250_000);
    expect(irpSchedule.enabled).toBe(true);
    expect(migrated.accounts.isa.contributionSchedule!.enabled).toBe(false);
    expect(migrated.accounts.retirement.contributionSchedule!.timing).toBe("after_close");
  });
});
