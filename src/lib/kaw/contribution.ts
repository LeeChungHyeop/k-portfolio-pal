// ─────────────────────────────────────────────────────────────────────────────
// 정기납입 스케줄 — "언제 얼마가 들어올 예정인가"
//
// 입금과 리밸런싱은 서로 독립된 이벤트다:
//
//   외부 입금 → 예수금 → (나중에, 아마 다음 달에) 리밸런싱/ETF 매수
//
// 그래서 스케줄은 **예정/기대값**이고, `CashflowEntry` 는 **실제 발생한 외부 입출금**이다.
// 날짜가 됐다는 이유만으로 cashflow 를 자동 생성하지 않는다 — cashBalance 는 증권사에서
// 자동으로 가져오는 값이 아니라 사용자가 관리하는 값이라서, 자동이체 실패나 금액 변경 같은
// 예외에서 장부가 조용히 틀어지기 때문이다. 대신 "정기납입 감지 → 입금 확인 1회 클릭"으로 둔다.
//
// ── 금액은 덮어쓰지 않고 버전으로 쌓는다 ────────────────────────────────────
//
// 퇴직연금 월 납입액은 매년 바뀐다. 단일 고정값으로 저장하면 금액이 바뀔 때 과거 기록의
// 근거가 사라지므로, **적용 시작월(effectiveFrom) + 금액** 이력을 보존한다.
//
//   2026-10 → 688,074
//   2027-03 → 712,000
//
//   ⇒ 2026-10 ~ 2027-02 는 688,074, 2027-03 부터는 712,000
//
// 새 금액이 생기면 기존 버전을 고치지 않고 한 줄을 추가한다. 과거 월의 계산은 절대 변하지 않는다.
//
// ── 장마감 이후 입금(after_close) ──────────────────────────────────────────
//
// 퇴직연금은 25일 **저녁**에 입금되어 그 날 장중에는 쓸 수 없고, 25일 이후 첫 거래 가능일부터
// 매수할 수 있다.
//
// **그래도 `CashflowEntry.date` 는 실제 입금일(25일) 그대로 저장한다.** 날짜를 다음 스냅샷이나
// 26일로 바꾸면 장부가 "실제로 언제 돈이 들어왔는지"를 더 이상 말해주지 못한다.
// 대신 기록에 `timing: "after_close"` 를 남기고, **기간 성과 계산에서만 귀속 구간을 조정한다**
// (performance.ts):
//
//     …→ 25일 구간      : 미포함 (25일 15:40 스냅샷보다 뒤에 들어온 돈이다)
//     25일 → 다음 스냅샷 : 포함
//
// 25일이 휴일이라 25일 스냅샷이 아예 없으면 공휴일 달력을 만들지 않고, 존재하는 전후 유효
// 스냅샷 사이 구간에 자연스럽게 포함된다.
//
// `period` 는 **예정일의 월**이다.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CASHFLOW_SOURCE_SCHEDULE,
  findScheduledCashflow,
  periodOf,
  type CashflowEntry,
  type ContributionTiming,
} from "./cashflow";

export type { ContributionTiming };

export interface ContributionAmountVersion {
  /** 적용 시작월 YYYY-MM */
  effectiveFrom: string;
  amount: number;
}

export interface RecurringContributionSchedule {
  id: string;
  enabled: boolean;
  /** 매월 며칠 (1~31) */
  dayOfMonth: number;
  timing: ContributionTiming;
  /**
   * 금액 이력. **기존 항목을 덮어쓰지 않고 추가한다.**
   * 정렬 순서에 의존하지 않도록 조회 시 effectiveFrom 으로 정렬한다.
   */
  amountVersions: ContributionAmountVersion[];
}

const DAY_MS = 86_400_000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM + 일 → YYYY-MM-DD. 그 달에 없는 날(2월 31일 등)은 말일로 당긴다. */
export function scheduledDate(period: string, dayOfMonth: number): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Math.trunc(dayOfMonth)), lastDay);
  return `${period}-${pad2(day)}`;
}

/** YYYY-MM-DD + n일 */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM 의 다음 달 */
export function nextPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${pad2(month + 1)}`;
}

// ── 최초 생성 ───────────────────────────────────────────────────────────────

export interface ContributionScheduleSeed {
  dayOfMonth: number;
  timing: ContributionTiming;
  enabled: boolean;
}

/**
 * 계좌에 스케줄이 아직 없을 때 **한 번** 만드는 초기 스케줄.
 *
 * - 금액은 코드에 박지 않고 그 계좌에 이미 저장된 월 납입액(`deposit`)을 첫 버전으로 옮긴다.
 * - 적용 시작월은 `thisMonth`(생성 시점의 월)이므로 그 이전 달은 pending 으로 뜨지 않는다 —
 *   과거 입금을 추정하지 않기 위해서다.
 * - 금액이 0이면 버전 없이 비활성으로 만든다(사용자가 설정에서 금액을 넣으면 켜진다).
 *
 * 순수 함수다. 만들어진 값은 호출자가 계좌에 넣고 **DB 에 1회 영속**해야 한다
 * (store.ts 의 migrateState / persistMigrationOnce 참고).
 */
export function createInitialSchedule(
  scheduleId: string,
  seed: ContributionScheduleSeed,
  deposit: number | undefined,
  thisMonth: string,
): RecurringContributionSchedule {
  const amount = Math.max(0, Math.round(deposit ?? 0));
  return {
    id: scheduleId,
    enabled: seed.enabled && amount > 0,
    dayOfMonth: seed.dayOfMonth,
    timing: seed.timing,
    amountVersions: amount > 0 ? [{ effectiveFrom: thisMonth, amount }] : [],
  };
}

// ── 금액 버전 조회 ──────────────────────────────────────────────────────────

/**
 * 그 달에 적용되는 금액. `effectiveFrom <= period` 인 버전 중 **가장 늦은** 것을 쓴다.
 * 해당하는 버전이 없으면(스케줄 시작 이전의 달) null — 금액을 추정하지 않는다.
 */
export function amountForPeriod(
  schedule: Pick<RecurringContributionSchedule, "amountVersions">,
  period: string,
): number | null {
  let best: ContributionAmountVersion | null = null;
  for (const v of schedule.amountVersions ?? []) {
    if (v.effectiveFrom > period) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best ? best.amount : null;
}

/** 지금 적용 중인 금액 버전(가장 늦은 effectiveFrom <= 기준월) */
export function currentAmountVersion(
  schedule: Pick<RecurringContributionSchedule, "amountVersions">,
  period: string,
): ContributionAmountVersion | null {
  let best: ContributionAmountVersion | null = null;
  for (const v of schedule.amountVersions ?? []) {
    if (v.effectiveFrom > period) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best;
}

/**
 * 금액 버전을 **추가**한다. 기존 버전은 고치지 않는다.
 * 같은 effectiveFrom 이 이미 있으면 그 달의 금액만 바꾼다(버전이 둘로 늘지 않게).
 */
export function upsertAmountVersion(
  versions: readonly ContributionAmountVersion[] | undefined,
  effectiveFrom: string,
  amount: number,
): ContributionAmountVersion[] {
  const out = [...(versions ?? [])];
  const idx = out.findIndex((v) => v.effectiveFrom === effectiveFrom);
  if (idx >= 0) out[idx] = { effectiveFrom, amount };
  else out.push({ effectiveFrom, amount });
  return out.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

// ── 입금 확인 대기(pending) 계산 ────────────────────────────────────────────

export interface PendingContribution {
  scheduleId: string;
  /** 귀속 월 YYYY-MM */
  period: string;
  /** 예정일 YYYY-MM-DD */
  scheduledOn: string;
  /** 스케줄에 설정된 예정 금액 */
  expectedAmount: number;
  timing: ContributionTiming;
}

export interface PendingContext {
  /** 오늘 (YYYY-MM-DD, 한국시간 기준으로 호출자가 넘긴다) */
  today: string;
  /** 이미 쌓인 daily snapshot 날짜들 — after_close 날짜 해석에 쓴다 */
  snapshotDates?: readonly string[];
  /** 거슬러 올라가 확인할 최대 개월 수 (기본 3) */
  lookbackMonths?: number;
}

/**
 * 아직 장부에 없고 **예정일이 지난** 정기납입을 찾는다.
 *
 * 제외하는 경우:
 *   - 스케줄이 꺼져 있음
 *   - 그 달에 적용되는 금액 버전이 없음 (스케줄 시작 이전의 달 — 추정하지 않는다)
 *   - **예정일이 아직 오지 않음** (10/02 에 25일 납입은 절대 뜨지 않는다)
 *   - 그 (source=schedule, scheduleId, period) 가 이미 확정돼 있음
 *
 * migration / manual / 레거시 rebalance 기록은 **판정에 쓰지 않는다** — 같은 달에 있다고
 * 그 달 정기납입이 들어온 것은 아니다(10/1 리밸런싱으로 복원된 기록이 실제로는 9월분 돈인
 * 경우가 있다). cashflow.ts findScheduledCashflow 주석 참고.
 */
export function pendingContributions(
  schedule: RecurringContributionSchedule | undefined,
  cashflows: readonly CashflowEntry[] | undefined,
  ctx: PendingContext,
): PendingContribution[] {
  if (!schedule?.enabled) return [];
  const lookback = ctx.lookbackMonths ?? 3;
  const todayPeriod = periodOf(ctx.today);

  // 오늘 기준 과거 lookback 개월(오늘 달 포함)을 본다
  const periods: string[] = [];
  let p = todayPeriod;
  for (let i = 0; i < lookback; i++) {
    periods.unshift(p);
    const year = Number(p.slice(0, 4));
    const month = Number(p.slice(5, 7));
    p = month === 1 ? `${year - 1}-12` : `${year}-${pad2(month - 1)}`;
  }

  const out: PendingContribution[] = [];
  for (const period of periods) {
    const expectedAmount = amountForPeriod(schedule, period);
    if (expectedAmount === null || !(expectedAmount > 0)) continue;
    const scheduledOn = scheduledDate(period, schedule.dayOfMonth);
    if (scheduledOn > ctx.today) continue; // 아직 예정일 전
    if (findScheduledCashflow(cashflows, schedule.id, period)) continue; // 이미 확정
    out.push({ scheduleId: schedule.id, period, scheduledOn, expectedAmount, timing: schedule.timing });
  }
  return out;
}

// ── 입금 확인 → cashflow 1건 ────────────────────────────────────────────────

export interface ConfirmContributionArgs {
  schedule: RecurringContributionSchedule;
  period: string;
  /** 실제 입금액. 예정 금액과 다를 수 있다. */
  amount: number;
}

/**
 * 정기납입 1건을 확정해 장부에 넣은 새 배열을 돌려준다.
 * **(scheduleId, period) 가 유일한 identity** 이므로 같은 달에 다시 확정하면
 * 건수를 늘리지 않고 그 1건의 금액·날짜만 갱신한다.
 * 금액이 0 이하면 아무것도 하지 않는다.
 */
export function confirmContribution(
  cashflows: readonly CashflowEntry[] | undefined,
  args: ConfirmContributionArgs,
): CashflowEntry[] {
  const current = cashflows ? [...cashflows] : [];
  const amount = Math.round(args.amount);
  if (!(amount > 0)) return current;

  // date 는 **실제 입금일** 그대로다. after_close 라고 날짜를 미루지 않는다 —
  // 귀속 구간 조정은 timing 을 보고 performance 쪽에서만 한다.
  const date = scheduledDate(args.period, args.schedule.dayOfMonth);
  const timing = args.schedule.timing;
  const note = timing === "after_close"
    ? `정기납입 ${date} 장마감 후 입금 (다음 거래일부터 매수 가능)`
    : `정기납입 ${date}`;

  const sort = (arr: CashflowEntry[]) =>
    arr.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const existing = findScheduledCashflow(current, args.schedule.id, args.period);
  if (existing) {
    if (existing.amount === amount && existing.date === date && existing.timing === timing) return current;
    const idx = current.indexOf(existing);
    current[idx] = { ...existing, date, amount, timing, note };
    return sort(current);
  }

  current.push({
    id: `sch:${args.schedule.id}:${args.period}`,
    date,
    amount,
    type: "deposit",
    source: CASHFLOW_SOURCE_SCHEDULE,
    period: args.period,
    scheduleId: args.schedule.id,
    timing,
    note,
  });
  return sort(current);
}
