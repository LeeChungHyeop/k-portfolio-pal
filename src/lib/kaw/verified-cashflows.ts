// ─────────────────────────────────────────────────────────────────────────────
// 검증된 과거 cashflow (canonical historical seed)
//
// **실제 증권사 자료(미래에셋 공식 납입내역 / 거래내역)로 확정한 과거 외부 입출금**이다.
// 추정값이 아니라 원본 자료를 옮겨 적은 것이고, 이 파일이 그 자료의 코드상 보존본이다.
//
// ## 왜 이 파일이 필요한가
//
// 그 전까지 과거 장부는 `buildMigratedCashflows(history)` 가 만들었다. 즉
// `history[0].baseAmount` 를 시작 보유자산 1건으로, 이후 `history.deposit > 0` 을 입금으로
// 복원하는 방식이다. 그 복원은 **앱에 그것밖에 없을 때 손실 없이 재표현하는 것**이 목적이라
// 날짜·건수가 실제 입금과 다르다:
//
//   - 리밸런싱을 저장한 날이 입금일로 들어간다 (9/25 입금 → 10/1 리밸런싱 → 10월 기록).
//   - 리밸런싱을 건너뛴 달의 입금은 아예 빠지거나 다음 기록에 합쳐진다.
//   - `history[0].baseAmount` 는 **K-올웨더 전략 시작 시점의 평가액**이지 그 계좌의
//     납입원금 시작점이 아니다.
//
// 실제 증권사 자료를 확보한 지금, reset / fresh seed / 향후 migration 에서 그 잘못된 과거
// cashflow 가 **다시 만들어지지 않게** 하려고 검증된 기록을 canonical seed 로 둔다.
// production Supabase 의 장부는 이미 별도로 정상화돼 있고, 이 파일은 그것을 코드로 고정한다.
//
// ## 계좌 원금 시작일 ≠ 전략 시작일 (중요)
//
// 퇴직연금(DC)의 2025-09-10 `baseAmount` 65,177,647원을 opening principal 로 쓰면 안 된다.
//
//   - DC 계좌 **원금** 시작 = 2025-03-25 (DC 전환 일시전환 원금)
//   - K-올웨더 **전략 성과** 시작 = 2025-09-10
//
// 서로 다른 개념이다. 이 파일은 전자만 다루고 전략 시작일은 바꾸지 않는다.
//
// ## 범위
//
// 과거의 **확정된 사실**만 담는다. 앞으로의 정기납입(`contributionSchedule`)과는 완전히
// 별개다 — 여기에 기록이 있다고 스케줄의 금액 버전이 바뀌거나 과거 월 스케줄 기록이
// 생기지 않는다. `source` 를 `"verified"` 로 두는 이유도 그것이다: 정기납입 확정 판정은
// `source === "schedule"` 만 보므로(cashflow.ts findScheduledCashflow) 이 기록들은 그
// 판정에 끼어들지 않는다.
//
// history(HistoryEntry)는 **건드리지 않는다.** 레거시 UI·기록용으로 그대로 두고, 원금
// 계산의 source of truth 는 여전히 `AccountState.cashflows` 하나뿐이다.
// ─────────────────────────────────────────────────────────────────────────────

import { ACCOUNT_IDS, type AccountId } from "./constants";
import type { CashflowEntry, ContributionTiming } from "./cashflow";

/** 실제 증권사 자료로 확인한 기록. 추정·복원이 아니다. */
export const CASHFLOW_SOURCE_VERIFIED = "verified";

/** 이 파일의 표 한 줄 — 전체 CashflowEntry 를 매번 적지 않기 위한 축약형 */
interface VerifiedRow {
  /** YYYY-MM-DD — **실제 입금일** */
  date: string;
  amount: number;
  /** 기본 "deposit". DC 전환 일시전환 원금처럼 입금이 아닌 건만 지정한다. */
  type?: CashflowEntry["type"];
  note?: string;
}

function rows(
  accountId: AccountId,
  timing: ContributionTiming,
  list: readonly VerifiedRow[],
): CashflowEntry[] {
  return list.map((r) => ({
    // 날짜는 계좌 안에서 유일하다(테스트로 고정) — id 가 안정적이라 재seed 해도 바뀌지 않는다.
    id: `verified:${accountId}:${r.date}`,
    date: r.date,
    amount: r.amount,
    type: r.type ?? "deposit",
    source: CASHFLOW_SOURCE_VERIFIED,
    // period 는 **실제 입금일의 월**이다. 월 단위로 합치지 않는다 — 한 달에 두 건인 달이
    // 실제로 있다(2026-01 퇴직연금, 2026-03 ISA, 2026-04 IRP).
    period: r.date.slice(0, 7),
    timing,
    ...(r.note ? { note: r.note } : {}),
  }));
}

// ── 퇴직연금(DC) — 미래에셋 공식 부담금 납입내역 ────────────────────────────
//
// timing 은 기존 앱 정책대로 `after_close` 다 — 부담금은 납입일 저녁에 들어와 그 날
// 장중에 쓸 수 없다(constants.ts CONTRIBUTION_SCHEDULE_SEED, performance.ts isFlowInSegment).
// 전환원금 1건만 `same_day` 로 둔다(장중에 전환된 원금이라 귀속을 미룰 이유가 없다).
const RETIREMENT: CashflowEntry[] = [
  ...rows("retirement", "same_day", [
    {
      date: "2025-03-25",
      amount: 60_923_460,
      type: "adjustment",
      note: "DC 전환 시 일시전환 원금 (미래에셋 공식 부담금 납입내역)",
    },
  ]),
  ...rows("retirement", "after_close", [
    { date: "2025-04-25", amount: 580_423 },
    { date: "2025-05-22", amount: 580_423 },
    { date: "2025-06-24", amount: 580_423 },
    { date: "2025-07-24", amount: 580_423 },
    { date: "2025-08-22", amount: 580_423 },
    { date: "2025-09-25", amount: 580_423 },
    { date: "2025-10-24", amount: 580_423 },
    { date: "2025-11-24", amount: 580_423 },
    { date: "2025-12-24", amount: 580_419 }, // 마지막 달만 4원 적다 (원본 그대로)
    { date: "2026-01-08", amount: 351_697 },
    { date: "2026-01-23", amount: 688_074 },
    { date: "2026-02-25", amount: 688_074 },
    { date: "2026-03-24", amount: 688_074 },
    { date: "2026-04-24", amount: 688_074 },
    { date: "2026-05-22", amount: 688_074 },
    { date: "2026-06-25", amount: 688_074 },
    { date: "2026-07-24", amount: 688_074 },
    { date: "2026-08-25", amount: 688_074 },
    { date: "2026-09-23", amount: 688_074 },
  ]),
];

// ── 연금저축 — 미래에셋 실제 거래내역 ──────────────────────────────────────
//
// 기존 migration 이 만들던 `2025-10-22 6,000,000` 은 리밸런싱 기록에서 역산된 날짜이고
// 실제 입금일이 아니다. 실제는 2025-11-10 이다.
const PENSION: CashflowEntry[] = rows("pension", "same_day", [
  { date: "2025-11-10", amount: 6_000_000 },
  { date: "2026-01-26", amount: 500_000 },
  { date: "2026-02-25", amount: 500_000 },
  { date: "2026-03-25", amount: 500_000 },
  { date: "2026-04-27", amount: 500_000 },
  { date: "2026-05-26", amount: 500_000 },
  { date: "2026-06-25", amount: 500_000 },
  { date: "2026-07-27", amount: 500_000 },
  { date: "2026-08-25", amount: 500_000 },
  { date: "2026-09-28", amount: 500_000 },
]);

// ── ISA — 미래에셋 실제 거래내역 ───────────────────────────────────────────
const ISA: CashflowEntry[] = rows("isa", "same_day", [
  { date: "2026-01-06", amount: 9_112_312 },
  { date: "2026-02-25", amount: 4_000_000 },
  { date: "2026-03-03", amount: 144_963 },
  { date: "2026-03-26", amount: 3_000_000 },
  { date: "2026-04-17", amount: 41_406_117 },
  { date: "2026-06-11", amount: 3_000_000 },
  { date: "2026-06-26", amount: 3_000_000 },
]);

// ── IRP — 미래에셋 공식 가입자부담금 납입내역 ──────────────────────────────
//
// 기존 migration 이 만들던 `2026-03-25 750,000` / `2026-05-31 150,000` 은 리밸런싱 기록에서
// 나온 값이라 실제 입금일·금액이 아니다. canonical seed 에서 제거한다.
const IRP: CashflowEntry[] = rows("irp", "same_day", [
  { date: "2025-12-29", amount: 3_000_000 },
  { date: "2026-04-23", amount: 500_000 },
  { date: "2026-04-27", amount: 250_000 },
  { date: "2026-05-26", amount: 250_000 },
  { date: "2026-06-25", amount: 250_000 },
  { date: "2026-07-27", amount: 250_000 },
  { date: "2026-08-25", amount: 250_000 },
  { date: "2026-09-28", amount: 250_000 },
]);

/**
 * 계좌별 검증된 과거 cashflow (날짜 오름차순).
 *
 * **읽기 전용 참조다.** 상태에 넣을 때는 `verifiedCashflowsFor()` 로 복사본을 받는다 —
 * 이 상수를 그대로 넣으면 한 계좌에서 장부를 수정했을 때 seed 자체가 오염된다.
 */
export const VERIFIED_HISTORICAL_CASHFLOWS: Readonly<Record<AccountId, readonly CashflowEntry[]>> =
  Object.freeze({
    retirement: Object.freeze(RETIREMENT),
    isa: Object.freeze(ISA),
    pension: Object.freeze(PENSION),
    irp: Object.freeze(IRP),
  });

/** 상태에 넣을 수 있는 **복사본**. 호출자가 수정해도 seed 가 변하지 않는다. */
export function verifiedCashflowsFor(accountId: AccountId): CashflowEntry[] {
  return (VERIFIED_HISTORICAL_CASHFLOWS[accountId] ?? []).map((c) => ({ ...c }));
}

/** 검증된 과거 납입원금 합계 — 계좌 하나 */
export function verifiedPrincipalOf(accountId: AccountId): number {
  return (VERIFIED_HISTORICAL_CASHFLOWS[accountId] ?? []).reduce((s, c) => s + c.amount, 0);
}

/** 검증된 과거 납입원금 합계 — 네 계좌 전체 */
export function verifiedPrincipalTotal(): number {
  return ACCOUNT_IDS.reduce((s, id) => s + verifiedPrincipalOf(id), 0);
}
