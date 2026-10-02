// ─────────────────────────────────────────────────────────────────────────────
// Cashflow ledger — 외부 입출금 장부
//
// 누적 납입원금의 정의를 한 곳에 못박아두는 모듈이다.
//
//   누적 납입원금 = 외부 입금 누계 - 외부 출금 누계   (= 이 장부의 amount 합)
//   총자산        = ETF 평가액 + 실제 예수금(cashBalance)
//   누적 손익      = 총자산 - 누적 납입원금
//   누적 수익률    = 누적 손익 / 누적 납입원금
//
// **cashBalance 를 납입원금에 더하지 않는다.** 예수금은 "이미 납입된 돈이 지금 현금 형태로
// 남아 있는 것"이지 새로운 외부 입금이 아니다. 예: 688,074원을 납입해 ETF를 사고 3,621원이
// 남았다면 688,074원만 원금이고, 3,621원을 다시 더하면 이중계산이다.
// (총자산 쪽에는 당연히 포함된다 — 그 3,621원은 실제로 내 자산이다.)
//
// 반대로 "예수금이 월 납입액과 비슷하다"는 이유로 그것을 신규 납입으로 간주해서도 안 된다.
// 실제로 새 입금이 들어왔는지는 데이터만으로 알 수 없기 때문이다. 확인되지 않은 흐름은
// 장부에 넣지 않는다 — 추정하지 않는 것이 이 모듈의 핵심 규칙이다.
//
// ── 입금과 리밸런싱은 서로 독립된 이벤트다 ──────────────────────────────────
//
//   외부 입금 → 예수금 → (나중에, 아마 다음 달에) 리밸런싱/ETF 매수
//
// 그래서 **`history.deposit` / `addHistory()` 를 cashflow 의 source of truth 로 쓰지 않는다.**
// 리밸런싱을 깜빡해 돈이 한두 달 예수금으로 쌓여도 원금은 입금된 달부터 정확히 늘어나야 하고,
// ETF 매수는 예수금 → ETF 이동일 뿐 원금을 바꾸지 않는다.
// 앞으로의 정기납입은 `contribution.ts`(정기납입 스케줄 + 입금 확인)가 만든다.
// 기존 history 는 과거 호환·기록용으로 그대로 둔다.
// ─────────────────────────────────────────────────────────────────────────────

export type CashflowType = "deposit" | "withdrawal" | "adjustment";

/**
 * 입금이 그 날 바로 쓸 수 있는지, 장마감 뒤라 다음 거래일부터인지.
 * (정기납입 스케줄과 cashflow 양쪽에서 쓰므로 순환 import 를 피해 여기에 둔다.)
 */
export type ContributionTiming = "same_day" | "after_close";

export interface CashflowEntry {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** 입금 +, 출금 - (KRW) */
  amount: number;
  type: CashflowType;
  /**
   * 어디서 만들어진 기록인지.
   *   "schedule"  — 정기납입을 사용자가 **입금 확인**해서 만든 기록 (앞으로의 주 경로)
   *   "manual"    — 사용자가 직접 넣은 입출금 (중복 허용)
   *   "migration" — 기존 history 에서 1회 복원된 과거 기록
   *   "rebalance" — (레거시) 예전에 리밸런싱 저장으로 만들어졌던 기록. 새로 만들지 않는다.
   */
  source?: string;
  /**
   * 귀속 월 (YYYY-MM). 정기납입 기록의 식별자 중 하나다 — `(scheduleId, period)` 가
   * 정기납입의 유일한 identity 이며 같은 달에 두 번 확정되지 않는다.
   * 날짜가 장마감 이후 입금(`after_close`)으로 다음 날로 밀려도 period 는 **예정일의 월**이다.
   */
  period?: string;
  /** 이 기록을 만든 정기납입 스케줄 id (source: "schedule" 일 때) */
  scheduleId?: string;
  /**
   * 입금 시점. **`date` 는 항상 실제 입금일이다** — 장마감 후 입금이라고 날짜를 미루지 않는다.
   * 대신 이 값으로 **기간 성과의 귀속 구간만** 조정한다(performance.ts 참고):
   * `after_close` 인 25일 입금은 "…→25일" 구간에는 안 들어가고 "25일→다음 스냅샷" 구간에 들어간다.
   */
  timing?: ContributionTiming;
  note?: string;
}

/** 장부의 최소 history 모양 — store 의 HistoryEntry 중 이 모듈이 실제로 읽는 필드만. */
export interface CashflowHistoryLike {
  id: string;
  date: string;
  baseAmount: number;
  deposit?: number;
}

/** YYYY-MM-DD → YYYY-MM */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** (레거시) 예전에 리밸런싱 저장이 만들던 기록. 새로 만들지 않지만 기존 값은 읽는다. */
export const CASHFLOW_SOURCE_REBALANCE = "rebalance";
export const CASHFLOW_SOURCE_MIGRATION = "migration";
export const CASHFLOW_SOURCE_MANUAL = "manual";
/** 정기납입을 입금 확인해서 만든 기록 */
export const CASHFLOW_SOURCE_SCHEDULE = "schedule";

// ── 1. 누적 납입원금 ────────────────────────────────────────────────────────

/** 장부 전체의 순입금 합계 = 누적 납입원금. 이 함수 외의 경로로 원금을 계산하지 않는다. */
export function cumulativePrincipal(cashflows: readonly CashflowEntry[] | undefined): number {
  if (!cashflows?.length) return 0;
  return cashflows.reduce((s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0), 0);
}

export interface AccountTotals {
  etfValue: number;
  /** 실제 예수금. 미입력(undefined)은 0으로 계산하되 cashEntered 로 구분해 표시한다. */
  cashBalance: number;
  cashEntered: boolean;
  totalAsset: number;
  principal: number;
  gain: number;
  returnPct: number | null;
}

export function computeAccountTotals(
  etfValue: number,
  cashBalance: number | undefined,
  cashflows: readonly CashflowEntry[] | undefined,
): AccountTotals {
  const cash = cashBalance ?? 0;
  const totalAsset = etfValue + cash;
  const principal = cumulativePrincipal(cashflows);
  const gain = totalAsset - principal;
  return {
    etfValue,
    cashBalance: cash,
    cashEntered: cashBalance !== undefined,
    totalAsset,
    principal,
    gain,
    returnPct: principal > 0 ? (gain / principal) * 100 : null,
  };
}

// ── 2. 기존 history → 장부 복원 (migration) ────────────────────────────────
//
// 복원 가능한 범위만 옮긴다. 기존 누적 납입원금 계산식은
//
//   principal = history[0].baseAmount + Σ max(0, history[1..].deposit)
//
// 이었다. 이 두 조각은 각각 날짜가 붙은 "확실한" 흐름이므로 장부로 **무손실 재표현**이 된다:
//
//   - history[0].baseAmount → 첫 기록 시점의 시작 보유자산(opening principal).
//     그 이전의 입금·손익 내역은 앱에 없으므로 한 건의 adjustment 로 고정한다.
//     이것이 §4 에서 말하는 "opening principal 기준점"이며, 장부 안에 날짜와 함께 들어가므로
//     별도 필드를 두지 않는다.
//   - history[1..].deposit > 0 → 그 날짜의 외부 입금.
//
// 옮기지 않는 것(= 추정하지 않는 것):
//   - history[0].deposit — 기존 계산식이 쓰지 않았다. 여기서 새로 더하면 원금이 바뀐다.
//   - cashBalance — 자산의 현재 형태일 뿐 입금 이력이 아니다.
//   - baseAmount - totalValue 같은 역산값 — 옛 계산식(ETF 평가액 + 불입액)에서 나온 가상값이다.
//   - 마지막 기록 이후에 실제로 들어왔을 수 있는 입금/출금 — 데이터로 확인할 수 없다.
//     사용자가 다음 리밸런싱을 저장하거나 직접 기록할 때 장부에 들어온다.
//
// 결과적으로 **이 migration 직후의 누적 납입원금은 기존 값과 1원도 다르지 않다.**
export function buildMigratedCashflows(
  history: readonly CashflowHistoryLike[] | undefined,
): CashflowEntry[] {
  if (!history?.length) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const out: CashflowEntry[] = [];

  const first = sorted[0];
  out.push({
    id: `mig:open:${first.id}`,
    date: first.date,
    amount: first.baseAmount ?? 0,
    type: "adjustment",
    source: CASHFLOW_SOURCE_MIGRATION,
    period: periodOf(first.date),
    note: "시작 보유자산 — 첫 리밸런싱 기록의 기준금액. 그 이전 입출금 내역은 앱에 없다.",
  });

  for (const h of sorted.slice(1)) {
    const amount = Math.max(0, h.deposit ?? 0);
    if (amount <= 0) continue;
    out.push({
      id: `mig:dep:${h.id}`,
      date: h.date,
      amount,
      type: "deposit",
      source: CASHFLOW_SOURCE_MIGRATION,
      // 실제 history 날짜의 월을 그대로 기록한다. **월 단위로 합치지 않는다** —
      // 한 달에 입금 기록이 둘인 달이 실제로 있어서(ISA 2026-06: 06-18, 06-26) 합치면
      // 복원이 손실되고 누적 납입원금이 바뀐다. 건수·금액을 그대로 유지한다.
      period: periodOf(h.date),
      note: "리밸런싱 기록의 불입액에서 복원",
    });
  }

  return out;
}

// ── 3. 정기납입 확정 여부 ──────────────────────────────────────────────────
//
// scheduled contribution 이 이미 확인됐는지는 **오직 그 스케줄이 만든 기록**으로만 판단한다:
//
//     source === "schedule"  AND  scheduleId 일치  AND  period 일치
//
// migration / manual / 레거시 rebalance 기록이 같은 달에 있어도 정기납입을 막지 않는다.
// 같은 달에 있다는 것이 "그 달 정기납입이 들어왔다"는 뜻이 아니기 때문이다. 실제 예:
//
//     9/25  퇴직연금 688,074원 실제 입금
//     10/1  리밸런싱 저장 → history.deposit = 688,074
//     ⇒ migration 은 이것을 **10월** 기록으로 복원하지만 실제로는 9월분 돈이다.
//
// 이때 10월 정기납입을 막아버리면 10월 입금이 영구히 누락된다.

const entryPeriod = (c: CashflowEntry): string => c.period ?? periodOf(c.date);

/** 그 스케줄의 그 달 기록이 이미 확정돼 있는가 — (source=schedule, scheduleId, period) 가 identity */
export function findScheduledCashflow(
  cashflows: readonly CashflowEntry[] | undefined,
  scheduleId: string,
  period: string,
): CashflowEntry | undefined {
  return (cashflows ?? []).find(
    (c) =>
      c.source === CASHFLOW_SOURCE_SCHEDULE &&
      c.scheduleId === scheduleId &&
      entryPeriod(c) === period,
  );
}

// ── 4. 기간 성과용 집계 ────────────────────────────────────────────────────

/** 날짜별 순외부흐름(입금 - 출금). 기간 수익률에서 cashflow 영향을 제거할 때 쓴다. */
export function netCashflowByDate(
  cashflows: readonly CashflowEntry[] | undefined,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cashflows ?? []) {
    if (!Number.isFinite(c.amount)) continue;
    m.set(c.date, (m.get(c.date) ?? 0) + c.amount);
  }
  return m;
}
