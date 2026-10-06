// ─────────────────────────────────────────────────────────────────────────────
// 과거 구간 평가액 복원 (historical reconstruction) — 순수 모듈
//
// `kaw_daily_portfolio_snapshots` 는 도입 시점부터만 쌓인다. 그 **이전** 기간에는 일별
// 평가액 행이 아예 없다. 그렇다고 DB 에 가짜 스냅샷을 backfill 하지 않는다 — 한 번 넣으면
// 실제 스냅샷과 구별되지 않고, 장부나 가격 조회가 고쳐졌을 때 따라 갱신되지 않는다.
//
// 대신 **조회 시점에** 리밸런싱 history 에 남아 있는 실제 보유수량과 그 날의 실제 종가로
// 평가액 행을 만들어, 실제 스냅샷과 하나의 timeline 으로 합친다. 만들어진 행은 화면
// 계산에서만 존재하는 파생값이며 **어디에도 저장하지 않는다**(DB·store·localStorage 전부).
//
// ## performance.ts 주석과의 관계 (중요)
//
// `performance.ts` 는 "리밸런싱 history 는 쓰지 않는다"고 적고 있다. 그 의미는 지금
// 다음과 같이 읽어야 한다:
//
//   - **성과 계산 자체는 여전히 평가액 행(valuation row)만** 본다. history 를 기간
//     수익률로 환산하는 경로는 없다.
//   - history 는 그 평가액 행을 **복원하는 upstream source** 일 뿐이다. 즉 history 에서
//     읽는 것은 "그 날 몇 주 들고 있었나"뿐이고, 금액은 **그 날의 실제 종가**에서 나온다.
//   - cashflow(외부 입출금)의 source of truth 는 변하지 않는다 — 여전히
//     `AccountState.cashflows` 이고, 복원된 평가액에 cashflow 금액을 더하지 않는다.
//
// ## 평가액 정의
//
//   marketValue      = Σ(마지막으로 확정된 rowQuantitiesSnap[row] × 그 날 종가)
//   cashBalance      = 0
//   totalAssetValue  = marketValue
//
// **반드시 `rowQuantitiesSnap`(보유수량)을 쓴다.** `rowHoldingsSnap`(그 당시 원화 평가금액)을
// carry-forward 하면 안 된다 — 그건 리밸런싱을 저장한 날의 금액이라서, 다른 날짜로 끌고 가면
// 주가 변동이 전혀 반영되지 않은 숫자가 된다.
//
// 과거 구간의 예수금은 0원으로 둔다. 사용자의 실제 과거 예수금은 대부분 1만원 이하였고,
// 날짜별 예수금 기록 자체가 없기 때문에 복원 목적상 무시하기로 **결정한 것**이다.
// deposit / baseAmount / rowHoldingsSnap 을 평가액에 더하지 않는다.
//
// ## 보유수량 carry-forward 규칙
//
// 계좌별 history 를 날짜 오름차순으로 정렬하고, 어떤 거래일 D 에 대해
//   1. D 이하에서 가장 최근인 **유효 anchor**(양수 보유수량이 하나 이상 있는 entry)를 찾고
//   2. 그 보유수량을 D 까지 유지했다고 보고
//   3. **D 의 실제 종가**를 적용한다.
//   4. 다음 유효 anchor 날짜부터는 새 수량을 쓴다.
// 가상의 리밸런싱을 끼워 넣지 않는다 (benchmark-series.ts 의 월말 carry-forward 와 같은 원칙,
// 거기서는 달 단위였고 여기서는 거래일 단위다).
//
// ## fail closed
//
// 양수 보유종목 중 **하나라도** 그 날 종가가 없으면 그 계좌·그 날짜 행을 **만들지 않는다.**
// 일부 종목만 평가한 partial value 는 그 날 성과를 틀리게 만든다 (snapshot.ts 와 같은 규칙).
//
// ## 실제 스냅샷이 언제나 우선
//
// 계좌별 첫 실제 스냅샷 날짜를 A 라 하면 `date < A` 만 복원한다. `date >= A` 는 실제
// 스냅샷만 쓴다 — 실제 스냅샷 시대에 들어간 뒤 빠진 날짜를 history 로 억지로 메우지 않는다
// (스냅샷이 없는 날은 "시세를 못 구해 건너뛴 날"이고, 그건 그대로 두는 것이 옳다).
// 혹시 같은 날짜가 양쪽에 다 있으면 실제 스냅샷이 무조건 이긴다.
//
// ## 거래일
//
// 가격 데이터가 **실제로 존재하는 날짜만** 거래일로 본다. 주말·휴장일을 만들어내지 않는다.
// 그래서 복원 구간은 자연스럽게 "거래일별" point 가 된다.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveEtfTicker, type AssetLibraryEntry } from "./benchmark-series";
import type { DailySnapshotRow, ScopeSelector } from "./performance";
import type { SnapshotHistoryLike } from "./snapshot";

/** 이 평가액 행이 어디서 나왔는가. 사용자 라벨이 아니라 계산 출처 메타데이터다. */
export type TimelineSource = "reconstructed" | "snapshot";

/**
 * 성과 계산에 넣는 평가액 행 한 줄. `DailySnapshotRow` 를 그대로 확장하므로
 * 기존 `aggregateByDate` / `calculatePerformance` 가 수정 없이 받는다.
 */
export interface PerformanceTimelineRow extends DailySnapshotRow {
  source: TimelineSource;
  /**
   * anchor 이후 외부 입출금이 있었는데 그 뒤 리밸런싱 기록이 아직 없는 구간.
   * 그 돈으로 실제 ETF 를 매수했을 수 있어서 복원값이 실제보다 낮을 수 있다.
   * **그래도 수량을 추정해 메우지 않는다** — 메타데이터로만 남긴다.
   */
  approximate?: boolean;
}

/** 복원 입력 — 계좌 하나. store 의 `HistoryEntry[]` 를 그대로 넘길 수 있다. */
export interface ReconstructionAccountInput {
  accountId: string;
  history: readonly SnapshotHistoryLike[];
  /** 외부 입출금 날짜(YYYY-MM-DD) 목록. `approximate` 판정에만 쓴다 — 금액은 쓰지 않는다. */
  cashflowDates?: readonly string[];
}

/** ticker → (YYYY-MM-DD → 종가). 없는 날짜·종목은 **키가 없다**(0 으로 두지 않는다). */
export type PriceSeriesByTicker = Record<string, Record<string, number>>;

const isUsable = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** 양수 보유수량이 하나 이상 있는 history entry만, 날짜 오름차순으로. */
export function validAnchors(
  history: readonly SnapshotHistoryLike[],
): SnapshotHistoryLike[] {
  return history
    .filter((h) => {
      if (!h || typeof h.date !== "string" || !h.date) return false;
      const qty = h.rowQuantitiesSnap;
      if (!qty) return false;
      return Object.values(qty).some((q) => Number(q ?? 0) > 0);
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** `date` 이하에서 가장 최근인 anchor. 없으면 undefined. (anchor 날짜 당일도 포함한다) */
export function anchorAsOf(
  anchors: readonly SnapshotHistoryLike[],
  date: string,
): SnapshotHistoryLike | undefined {
  let found: SnapshotHistoryLike | undefined;
  for (const a of anchors) {
    if (a.date > date) break; // 오름차순 정렬 전제
    found = a;
  }
  return found;
}

/** 계좌별 **첫** 실제 스냅샷 날짜. 복원이 허용되는 상한(이 날짜 미만)을 정한다. */
export function firstActualSnapshotDates(
  rows: readonly DailySnapshotRow[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const prev = m.get(r.accountId);
    if (!prev || r.snapshotDate < prev) m.set(r.accountId, r.snapshotDate);
  }
  return m;
}

/**
 * 한 anchor 를 평가하려면 어떤 종목코드가 필요한가.
 * ETF명 → ticker 는 기존 자산 라이브러리(`resolveEtfTicker`)를 그대로 쓴다 —
 * 새 ticker 매핑 체계를 만들지 않는다.
 */
export function anchorTickers(
  anchor: SnapshotHistoryLike,
  library: readonly AssetLibraryEntry[],
): string[] {
  const out = new Set<string>();
  const qty = anchor.rowQuantitiesSnap ?? {};
  const etf = anchor.rowEtfSnap ?? {};
  for (const [rowId, rawQty] of Object.entries(qty)) {
    if (!(Number(rawQty ?? 0) > 0)) continue;
    const t = resolveEtfTicker(library, etf[rowId]);
    if (t) out.add(t);
  }
  return [...out];
}

/** 네트워크 요청 계획 — 어떤 종목의 어느 구간 종가가 필요한가. 순수 함수다. */
export interface ReconstructionPlan {
  tickers: string[];
  /** YYYY-MM-DD */
  fromDate: string;
  /** YYYY-MM-DD */
  toDate: string;
}

/**
 * 복원에 필요한 가격 구간/종목 계획.
 *
 *   fromDate = 계좌들의 가장 이른 유효 anchor 날짜 (그 앞은 복원할 근거가 없다)
 *   toDate   = 계좌별 "복원 상한"(첫 실제 스냅샷 날짜, 없으면 `today`)의 최댓값
 *
 * 필요한 것이 없으면 `null` — 호출자가 요청 자체를 하지 않는다.
 */
export function reconstructionPlan(
  accounts: readonly ReconstructionAccountInput[],
  library: readonly AssetLibraryEntry[],
  actualSnapshots: readonly DailySnapshotRow[],
  today: string,
): ReconstructionPlan | null {
  const firstActual = firstActualSnapshotDates(actualSnapshots);
  const tickers = new Set<string>();
  let fromDate = "";
  let toDate = "";

  for (const acc of accounts) {
    const anchors = validAnchors(acc.history);
    if (!anchors.length) continue;
    const start = anchors[0].date;
    // 복원 상한: 첫 실제 스냅샷 이전까지만. 실제 스냅샷이 없는 계좌는 오늘까지.
    const end = firstActual.get(acc.accountId) ?? today;
    if (start >= end) continue; // 복원할 거래일이 없다
    if (!fromDate || start < fromDate) fromDate = start;
    if (!toDate || end > toDate) toDate = end;
    for (const a of anchors) {
      if (a.date > end) continue;
      anchorTickers(a, library).forEach((t) => tickers.add(t));
    }
  }

  if (!fromDate || !toDate || !tickers.size) return null;
  return { tickers: [...tickers].sort(), fromDate, toDate };
}

/** 가격 series 에 등장하는 모든 날짜(= 거래일). 오름차순. 휴장일을 만들어내지 않는다. */
export function tradingDatesOf(priceSeries: PriceSeriesByTicker): string[] {
  const dates = new Set<string>();
  for (const byDate of Object.values(priceSeries ?? {})) {
    for (const [date, price] of Object.entries(byDate ?? {})) {
      if (isUsable(price)) dates.add(date);
    }
  }
  return [...dates].sort();
}

export interface BuildReconstructedOptions {
  accounts: readonly ReconstructionAccountInput[];
  library: readonly AssetLibraryEntry[];
  /** 실제 스냅샷 — 계좌별 복원 상한을 정하는 데만 쓴다 */
  actualSnapshots: readonly DailySnapshotRow[];
  priceSeries: PriceSeriesByTicker;
}

/**
 * 복원된 평가액 행들. 실제 스냅샷 시대(`date >= 첫 실제 스냅샷`)에는 한 행도 만들지 않는다.
 *
 * 양수 보유종목 중 하나라도 그 날 종가가 없으면 그 날짜 행 전체를 건너뛴다(partial 금지).
 */
export function buildReconstructedRows(
  o: BuildReconstructedOptions,
): PerformanceTimelineRow[] {
  const tradingDates = tradingDatesOf(o.priceSeries);
  if (!tradingDates.length) return [];
  const firstActual = firstActualSnapshotDates(o.actualSnapshots);

  const out: PerformanceTimelineRow[] = [];
  for (const acc of o.accounts) {
    const anchors = validAnchors(acc.history);
    if (!anchors.length) continue;
    const start = anchors[0].date;
    const limit = firstActual.get(acc.accountId); // 있으면 이 날짜 **미만**만 복원
    const flowDates = [...(acc.cashflowDates ?? [])].sort();

    for (const date of tradingDates) {
      if (date < start) continue;
      if (limit && date >= limit) continue;

      const anchor = anchorAsOf(anchors, date);
      if (!anchor) continue;

      const qty = anchor.rowQuantitiesSnap ?? {};
      const etf = anchor.rowEtfSnap ?? {};
      let marketValue = 0;
      let holdings = 0;
      let missing = false;

      for (const [rowId, rawQty] of Object.entries(qty)) {
        const q = Number(rawQty ?? 0);
        if (!(q > 0)) continue;
        const ticker = resolveEtfTicker(o.library, etf[rowId]);
        const price = ticker ? o.priceSeries[ticker]?.[date] : undefined;
        if (!isUsable(price)) { missing = true; break; }
        marketValue += q * price;
        holdings += 1;
      }
      if (missing || !holdings) continue;

      // anchor 이후~이 날짜까지 외부 입출금이 있었다면, 그 돈이 이미 ETF 로 바뀌었을 수 있다.
      // 수량을 추정해 메우지 않고 approximate 로만 표시한다.
      const approximate = flowDates.some((d) => d > anchor.date && d <= date);

      const market = Math.round(marketValue);
      out.push({
        snapshotDate: date,
        accountId: acc.accountId,
        marketValue: market,
        // 과거 구간 예수금은 0원으로 둔다 (파일 상단 주석 참고)
        cashBalance: 0,
        totalAssetValue: market,
        source: "reconstructed",
        ...(approximate ? { approximate: true } : {}),
      });
    }
  }
  return out;
}

/**
 * 실제 스냅샷 + 복원 행 → 하나의 timeline.
 *
 * 같은 (계좌, 날짜)가 양쪽에 있으면 **실제 스냅샷이 무조건 이긴다** — 복원값이 실제 평가액을
 * 덮는 경로를 만들지 않는다.
 */
export function mergeTimeline(
  actualSnapshots: readonly DailySnapshotRow[],
  reconstructed: readonly PerformanceTimelineRow[],
): PerformanceTimelineRow[] {
  const actualKeys = new Set(actualSnapshots.map((r) => `${r.accountId}|${r.snapshotDate}`));
  const rows: PerformanceTimelineRow[] = [
    ...actualSnapshots.map((r) => ({ ...r, source: "snapshot" as const })),
    ...reconstructed.filter((r) => !actualKeys.has(`${r.accountId}|${r.snapshotDate}`)),
  ];
  return rows.sort(
    (a, b) =>
      a.snapshotDate.localeCompare(b.snapshotDate) || a.accountId.localeCompare(b.accountId),
  );
}

/**
 * history + 과거 종가 → 복원 행 → 실제 스냅샷과 merge.
 *
 * 결과를 기존 `calculatePerformance(rows, cashflows, scope, period)` 에 그대로 넘기면
 * 기존 `aggregateByDate` → Modified Dietz 계산이 수정 없이 돈다.
 */
export function buildPerformanceTimeline(
  o: BuildReconstructedOptions,
): PerformanceTimelineRow[] {
  return mergeTimeline(o.actualSnapshots, buildReconstructedRows(o));
}

/**
 * 지금 화면에 보이는 성과 구간에 복원 행이 섞여 있는가 (안내 badge 표시 판정용).
 * 실제 스냅샷만으로 만들어진 구간이면 false 다.
 */
export function timelineHasReconstructed(
  rows: readonly PerformanceTimelineRow[],
  periods: readonly { fromDate: string; toDate: string }[],
  scope: ScopeSelector = {},
): boolean {
  if (!periods.length) return false;
  const include = scope.accountIds ? new Set(scope.accountIds) : null;
  const first = periods[0].fromDate;
  const last = periods[periods.length - 1].toDate;
  return rows.some(
    (r) =>
      r.source === "reconstructed"
      && (!include || include.has(r.accountId))
      && r.snapshotDate >= first
      && r.snapshotDate <= last,
  );
}
