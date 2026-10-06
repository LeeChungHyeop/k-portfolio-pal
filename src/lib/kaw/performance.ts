// ─────────────────────────────────────────────────────────────────────────────
// 기간 성과 (일간 / 월간 / 연간)
//
// 입력이 **두 개**이고, 각자 하나의 사실만 담당한다 (source of truth 를 한 쪽으로 몰아둔다):
//
//   1) 일별 자산 스냅샷(kaw_daily_portfolio_snapshots) — 날짜별 **평가액**만
//        ETF 평가액 / 예수금 / 총자산. 그 날 15:40 시세로 고정된 과거 사실이다.
//   2) cashflow 장부(AccountState.cashflows) — 날짜별 **외부 입출금**
//        언제든 과거 날짜에 추가·수정·삭제될 수 있는, 지금 유효한 최신 사실이다.
//
// **스냅샷에 외부흐름을 같이 저장하지 않는다.** 저장해두면 그 값이 곧 stale 해진다:
// 15:40 에 스냅샷을 쓴 뒤 그 날 저녁에 입금을 기록하거나, 며칠 뒤 과거 입출금을 보정하면
// 스냅샷 안의 숫자는 틀린 값이 된다. 그래서 외부흐름은 **계산 시점에 현재 장부에서** 읽는다.
// 결과적으로 장부를 고치면 재스냅샷 없이 과거 기간 성과가 즉시 교정된다.
//
// **성과 계산 자체는 평가액 행(valuation row)만 본다.** 리밸런싱 history 를 기간 수익률로
// 환산하는 경로는 없다 — 그건 "리밸런싱을 저장한 날"의 기록일 뿐 일별 평가가 아니다.
//
// 다만 history 는 평가액 행을 **복원하는 upstream source** 로 쓰인다: 실제 스냅샷이 쌓이기
// 전 기간은 `historical-performance.ts` 가 history 의 보유수량(`rowQuantitiesSnap`)과
// **그 날의 실제 종가**로 평가액 행을 만들어 이 계산의 입력에 합친다. 이 파일은 그 행이
// 어디서 왔는지 구분하지 않는다 — 들어오는 것은 어느 쪽이든 "날짜별 평가액"이다.
// 저장된 금액(`rowHoldingsSnap`)을 끌고 오는 경로는 그쪽에도 없다.
// **cashflow 의 source of truth 는 변하지 않는다** — 여전히 `AccountState.cashflows` 이고,
// 복원된 평가액에 cashflow 금액을 더하지 않는다.
//
// ── 계산 정의 ───────────────────────────────────────────────────────────────
//
// 한 구간 [시작 스냅샷 S0, 끝 스냅샷 S1] 에 대해
//
//   기간 손익  profit = V1 - V0 - F
//      V0 = S0 의 총자산(ETF 평가액 + 실제 예수금)
//      V1 = S1 의 총자산
//      F  = 장부에서 읽은, 이 구간에 귀속되는 순외부흐름 합(입금 +, 출금 -).
//           same_day 는 `S0 < 날짜 <= S1`, **장마감 후 입금(after_close)은 `S0 <= 날짜 < S1`**
//           — 그 날 15:40 스냅샷보다 뒤에 들어온 돈이라 그 날로 끝나는 구간에는 넣지 않는다.
//           cashflow 의 `date` 는 실제 입금일 그대로 두고 귀속만 이렇게 조정한다.
//           스냅샷이 없는 날짜(휴장일·시세 미확보일)의 흐름도 포함된다 — 돈은 거래일이
//           아닌 날에도 들어오기 때문이다.
//
//   기간 수익률 = profit / (V0 + Σ wi·Fi) × 100        ← Modified Dietz
//      wi = (T - ti) / T,  T = S0~S1 일수, ti = S0~흐름일 일수
//      즉 "기간 중간에 들어온 돈은 남은 기간만큼만 분모에 반영한다".
//      T = 0 (같은 날)이면 분모는 V0.
//
// (V1 - V0) / V0 를 쓰지 않는 이유: 입금만 해도 수익률이 올라가고 출금만 해도 내려간다.
// IRR/XIRR 까지 가지 않고 Modified Dietz 를 쓰는 이유: 일별 스냅샷이 있으면 충분히 정확하고,
// 분모의 의미를 한 줄로 설명할 수 있기 때문이다.
//
// ── 구간을 어떻게 끊는가 ────────────────────────────────────────────────────
//
//   daily   : 연속한 두 스냅샷 (전 거래일 → 그 날)
//   monthly : 그 달 마지막 스냅샷을 V1, **전월 마지막 스냅샷**을 V0
//   yearly  : 그 해 마지막 스냅샷을 V1, **전년 마지막 스냅샷**을 V0
//
// 가장 처음 구간은 그 앞에 스냅샷이 없다. 없는 값을 추정하지 않기 위해
//   - 구간 안에 스냅샷이 2개 이상이면 그 구간의 첫 스냅샷을 V0 로 쓰고 `partial: true` 로 표시
//   - 1개뿐이면 그 구간은 **결과에서 제외**한다 (가짜 0% 를 만들지 않는다)
//
// ── 전체(네 계좌 합산) scope ────────────────────────────────────────────────
//
// **네 계좌 스냅샷이 모두 있는 날짜만** 합산 point 로 만든다(`requireAccountIds`).
// 한 계좌라도 빠진 날은 point 를 아예 만들지 않는다 — 만들면 그 계좌 금액만큼 전체 자산이
// 갑자기 급락한 것처럼 보이고, 다음 날 급등한 것처럼 보인다. 스냅샷은 시세를 못 구한 계좌를
// 건너뛰도록 돼 있어서 이런 누락일이 실제로 생긴다.
// 불완전한 날은 point 가 없으므로 **다음 구간의 기초점으로도 쓰이지 않는다.**
//
// 계좌별 scope 는 그 계좌 스냅샷만 있으면 계산한다(다른 계좌의 누락과 무관).
//
// 계좌 간 자금 이동 기능은 앱에 없고, 각 계좌의 입금은 모두 외부(급여·은행)에서 들어온다.
// 사용자가 수동으로 한 계좌에서 빼서 다른 계좌에 넣으면 한쪽은 출금(-), 다른 쪽은 입금(+)
// 으로 기록되므로 전체 scope 에서는 상쇄된다 — 전체 흐름은 스냅샷 유무와 무관하게 장부에서
// 읽기 때문에, 그 날이 완전한 날이면 합이 0 이 된다.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContributionTiming } from "./cashflow";

export type PeriodId = "daily" | "monthly" | "yearly";
export type MetricId = "pct" | "amount";

/** 하루·한 계좌의 스냅샷. 서버(kaw_daily_portfolio_snapshots)에서 그대로 내려오는 모양. */
export interface DailySnapshotRow {
  /** YYYY-MM-DD */
  snapshotDate: string;
  accountId: string;
  marketValue: number;
  cashBalance: number;
  totalAssetValue: number;
}

/**
 * 성과 계산에 쓰는 외부흐름 1건. **현재 cashflow 장부에서 만들어 넘긴다** —
 * 스냅샷에 저장된 값을 쓰지 않는다(그 값은 장부가 바뀌면 stale 해진다).
 */
export interface PerformanceCashflow {
  accountId: string;
  /** **실제 입출금일** YYYY-MM-DD */
  date: string;
  /** 입금 +, 출금 - */
  amount: number;
  /**
   * 그 날 장마감 뒤에 들어온 돈인가. 기본은 `same_day`.
   * `after_close` 면 그 날짜로 **끝나는** 구간에는 들어가지 않고, 그 날짜에서 **시작하는**
   * 구간에 들어간다 — 날짜를 미루지 않고 귀속만 조정한다. 아래 isFlowInSegment 참고.
   */
  timing?: ContributionTiming;
}

export interface PeriodPerformance {
  /** 정렬·식별용 키 (daily: 끝 날짜, monthly: YYYY-MM, yearly: YYYY) */
  key: string;
  label: string;
  /** V0 로 쓴 스냅샷 날짜 */
  fromDate: string;
  /** V1 로 쓴 스냅샷 날짜 */
  toDate: string;
  beginningTotal: number;
  endingTotal: number;
  /** F — 기간 중 순외부흐름 (현재 장부 기준) */
  netCashflow: number;
  /** V1 - V0 - F */
  profit: number;
  /** Modified Dietz. 분모가 0 이하면 null */
  returnPct: number | null;
  /** 분모(평균투자원금) — 툴팁에서 수익률의 근거를 보여주기 위해 남긴다 */
  averageCapital: number;
  /** 구간 앞 스냅샷이 없어 구간 내부 첫 스냅샷을 V0 로 쓴 구간 */
  partial: boolean;
}

/** 날짜별 평가액 point. 외부흐름은 여기 담지 않는다 — 장부에서 따로 읽는다. */
export interface DatePoint {
  date: string;
  total: number;
  /** 이 날짜에 스냅샷이 있는 계좌 수 */
  accountCount: number;
}

export interface ScopeSelector {
  /** 이 계좌들만 합산/집계한다. 생략하면 들어온 전부. */
  accountIds?: readonly string[];
  /** 이 계좌들의 스냅샷이 **모두** 있는 날짜만 point 로 인정한다. 전체 scope 에서 쓴다. */
  requireAccountIds?: readonly string[];
}

const DAY_MS = 86_400_000;

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/**
 * scope 안의 계좌 스냅샷을 날짜별로 합산한다.
 * `requireAccountIds` 를 주면 그 계좌들이 **모두** 있는 날짜만 남긴다(불완전한 날은 버린다).
 */
export function aggregateByDate(
  rows: readonly DailySnapshotRow[],
  scope: ScopeSelector = {},
): DatePoint[] {
  const include = scope.accountIds ? new Set(scope.accountIds) : null;
  const required = scope.requireAccountIds ? new Set(scope.requireAccountIds) : null;

  const byDate = new Map<string, { total: number; seen: Set<string> }>();
  for (const r of rows) {
    if (include && !include.has(r.accountId)) continue;
    const bucket = byDate.get(r.snapshotDate) ?? { total: 0, seen: new Set<string>() };
    // 같은 날짜·같은 계좌가 두 번 들어오면(이론상 PK 로 막히지만) 한 번만 센다.
    if (bucket.seen.has(r.accountId)) continue;
    bucket.total += r.totalAssetValue;
    bucket.seen.add(r.accountId);
    byDate.set(r.snapshotDate, bucket);
  }

  const out: DatePoint[] = [];
  for (const [date, bucket] of byDate) {
    if (required) {
      let complete = true;
      for (const id of required) if (!bucket.seen.has(id)) { complete = false; break; }
      if (!complete) continue; // 한 계좌라도 빠진 날은 point 를 만들지 않는다
    }
    out.push({ date, total: bucket.total, accountCount: bucket.seen.size });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 성과 계산에 쓰는 흐름 단위 — 같은 날짜라도 timing 이 다르면 귀속 구간이 달라서 따로 센다. */
export interface FlowPoint {
  date: string;
  timing: ContributionTiming;
  amount: number;
}

/**
 * scope 안의 외부흐름을 (날짜, timing) 별로 합산한다.
 * 스냅샷 유무와 무관하게 장부 전체를 본다 — 돈은 거래일이 아닌 날에도 들어온다.
 */
export function aggregateCashflows(
  cashflows: readonly PerformanceCashflow[],
  scope: ScopeSelector = {},
): FlowPoint[] {
  const include = scope.accountIds ? new Set(scope.accountIds) : null;
  const m = new Map<string, FlowPoint>();
  for (const c of cashflows) {
    if (include && !include.has(c.accountId)) continue;
    if (!Number.isFinite(c.amount)) continue;
    const timing: ContributionTiming = c.timing ?? "same_day";
    const key = `${c.date}|${timing}`;
    const prev = m.get(key);
    if (prev) prev.amount += c.amount;
    else m.set(key, { date: c.date, timing, amount: c.amount });
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function bucketKey(date: string, period: PeriodId): string {
  if (period === "daily") return date;
  if (period === "monthly") return date.slice(0, 7);
  return date.slice(0, 4);
}

function bucketLabel(key: string, period: PeriodId): string {
  if (period === "daily") return key.slice(5).replace("-", "/");
  if (period === "monthly") return key.replace("-", ".");
  return `${key}년`;
}

/**
 * 이 흐름이 [open, close] 구간에 귀속되는가.
 *
 *   same_day    : open 날짜의 스냅샷 **뒤**부터 close 날짜 스냅샷까지 → `open < date <= close`
 *   after_close : 그 날 스냅샷(15:40) **뒤**에 들어온 돈이다. 그래서
 *                 `date` 로 끝나는 구간에는 안 들어가고 `date` 에서 시작하는 구간에 들어간다
 *                 → `open <= date < close`
 *
 * 25일이 휴일이라 25일 스냅샷이 아예 없으면(예: 스냅샷 24일·28일) after_close 25일 입금은
 * `24 <= 25 < 28` 로 24~28 구간에 자연스럽게 포함된다 — 공휴일 달력이 필요 없다.
 */
function isFlowInSegment(flow: FlowPoint, openDate: string, closeDate: string): boolean {
  return flow.timing === "after_close"
    ? flow.date >= openDate && flow.date < closeDate
    : flow.date > openDate && flow.date <= closeDate;
}

/**
 * V0 ~ V1 한 구간의 손익·수익률. 분모는 Modified Dietz.
 * 외부흐름은 `flows`(현재 장부)에서 직접 더한다 — 스냅샷이 없는 날짜의 흐름도 빠뜨리지 않는다.
 */
function computeSegment(
  open: DatePoint,
  close: DatePoint,
  flows: readonly FlowPoint[],
): Pick<PeriodPerformance, "netCashflow" | "profit" | "returnPct" | "averageCapital"> {
  const T = dayDiff(open.date, close.date);
  let netCashflow = 0;
  let weighted = 0;
  for (const f of flows) {
    if (!f.amount) continue;
    if (!isFlowInSegment(f, open.date, close.date)) continue;
    netCashflow += f.amount;
    // 구간 시작 직후에 들어온 돈(ti=0)은 사실상 기간 전체를 투자된 것이므로 가중치 1 이다.
    const ti = dayDiff(open.date, f.date);
    const w = T > 0 ? Math.max(0, Math.min(1, (T - ti) / T)) : 0;
    weighted += f.amount * w;
  }
  const profit = close.total - open.total - netCashflow;
  const averageCapital = open.total + weighted;
  return {
    netCashflow,
    profit,
    returnPct: averageCapital > 0 ? (profit / averageCapital) * 100 : null,
    averageCapital,
  };
}

export function computePeriodPerformance(
  points: readonly DatePoint[],
  period: PeriodId,
  flows: readonly FlowPoint[] = [],
): PeriodPerformance[] {
  if (points.length < 2) return [];

  // 버킷별 인덱스 범위
  const buckets: { key: string; start: number; end: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const key = bucketKey(points[i].date, period);
    const last = buckets[buckets.length - 1];
    if (last && last.key === key) last.end = i;
    else buckets.push({ key, start: i, end: i });
  }

  const out: PeriodPerformance[] = [];
  for (let b = 0; b < buckets.length; b++) {
    const { key, start, end } = buckets[b];
    const close = points[end];

    // V0: 이 버킷 바로 앞의 **point**. 불완전해서 버려진 날짜는 point 가 아니므로
    // 기초점으로 쓰이지 않는다. 없으면(= 첫 버킷) 버킷 내부 첫 스냅샷.
    const hasPrior = start > 0;
    const openIdx = hasPrior ? start - 1 : start;
    const open = points[openIdx];
    if (openIdx === end) continue; // 스냅샷이 1개뿐인 첫 버킷 → 가짜 값 대신 제외

    const seg = computeSegment(open, close, flows);

    out.push({
      key,
      label: bucketLabel(key, period),
      fromDate: open.date,
      toDate: close.date,
      beginningTotal: open.total,
      endingTotal: close.total,
      partial: !hasPrior,
      ...seg,
    });
  }
  return out;
}

/**
 * 스냅샷(평가액) + 현재 cashflow 장부(외부흐름) → 기간 성과.
 *
 * 장부를 계산 시점에 결합하므로, 과거 날짜의 입출금을 나중에 추가·수정·삭제하면
 * **재스냅샷 없이** 그 기간의 손익·수익률이 즉시 교정된다.
 */
export function calculatePerformance(
  snapshots: readonly DailySnapshotRow[],
  cashflows: readonly PerformanceCashflow[],
  scope: ScopeSelector,
  period: PeriodId,
): PeriodPerformance[] {
  const points = aggregateByDate(snapshots, scope);
  const flows = aggregateCashflows(cashflows, scope);
  return computePeriodPerformance(points, period, flows);
}
