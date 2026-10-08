// ─────────────────────────────────────────────────────────────────────────────
// 보유수량 timeline — 수익 분석의 보유수량 source 를 구간별로 고른다.
//
// 거래일 D 에 대해 **두 값**이 필요하다:
//
//   openHoldings (D)  = D 의 매매를 반영하지 **않은** 수량 (장 시작)
//   closeHoldings(D)  = D 의 매매를 반영한 수량           (장 마감)
//
// ## source 정책 (2026-10-08 결정)
//
//   전략시작 ~ ledgerCutoff   → **원장 재생** (모든 거래일 수량을 정확히 안다)
//   ledgerCutoff ~ 오늘        → **legacy anchor carry-forward** (기존 앱 경로)
//
// seam(첫 유효 anchor)은 **source switch 지점이 아니다.** seam 과 그 이후 모든
// checkpoint 에서 두 경로가 전부 일치했으므로(불일치 0), 원장이 있는 동안은 더 정밀한
// 원장을 계속 쓴다. seam 은 "두 데이터가 정확히 이어짐을 증명하는 reconciliation
// checkpoint" 로만 남고, 그 검증은 `reconcileSeam()` 이 한다.
//
// ## anchor 구간의 한계 — 체결가를 모른다
//
// anchor 는 "그 날 리밸런싱이 끝난 뒤 수량"이다. 수량이 변한 것은 알지만 **어떤 가격에
// 체결됐는지는 모른다.** 그래서 anchor 구간의 매매일은 **종가 체결로 가정한다**:
//
//   Σ Δq × P_close = −ΔC   (현금 중립)
//
// 이 가정 아래 `V_close − V_open − F` 전개에서 Δq 항이 정확히 소거되고, 당일 매매분
// 손익(②항)이 **0** 이 된다. 즉 **없는 매매 손익을 만들어내지 않고**, 총자산이 리밸런싱을
// 가로질러 연속이다(인위적 valuation jump 없음). 대신 그 구간은 `anchor-implied` 로
// 표시하고 `exact` 라고 부르지 않는다.
//
// ## ticker 매핑 — 조용히 0 으로 떨어뜨리지 않는다
//
// 원장 구간은 `ticker` 를 **직접** 쓴다(이름 경유 없음). anchor 구간만 rowId → ETF명 →
// ticker 를 거치는데, `resolveEtfTicker` 는 `defaultEtf` **완전일치**라서 이름이 조금만
// 달라도 못 찾는다(실제로 `_meta` 는 "TIGER KRX **공백** 금현물"이다). 못 찾은 행을
// 조용히 버리면 보유수량이 소리 없이 줄어들므로, **`unresolved` 로 모아 올려보내고
// 그 날짜는 평가하지 않는다**(fail closed).
// ─────────────────────────────────────────────────────────────────────────────

import { resolveEtfTicker, type AssetLibraryEntry } from "./benchmark-series";
import { anchorAsOf, validAnchors } from "./historical-performance";
import type { DailyHoldingsDelta } from "./ledger";
import type { AccountCoverage, HoldingsSource } from "./ledger-coverage";
import type { SnapshotHistoryLike } from "./snapshot";

export type Holdings = Readonly<Record<string, number>>;

export interface HoldingsDay {
  date: string;
  accountId: string;
  openHoldings: Holdings;
  closeHoldings: Holdings;
  source: HoldingsSource;
  /** 그 날 수량이 변했는가 */
  traded: boolean;
  /**
   * 원장 구간에서 그 날 체결 가중평균 단가 (ticker → 단가).
   * anchor 구간은 **비어 있다** — 체결가를 모르므로 종가 체결로 가정한다.
   */
  execPrice: Holdings;
  /** 원장 구간의 그 날 순현금 이동 (매도 − 매수). anchor 구간은 null (유도해야 한다) */
  netCashDelta: number | null;
  /** 보고된 수수료·세금 */
  reportedCosts: number;
  /** ticker 로 해석하지 못한 anchor 행 — 있으면 그 날짜는 평가하지 않는다 */
  unresolved: readonly string[];
}

export interface AccountTimelineInput {
  accountId: string;
  coverage: AccountCoverage;
  /** `replayDailyHoldings()` 결과의 그 계좌분 (날짜 오름차순) */
  ledgerDays: readonly DailyHoldingsDelta[];
  /** legacy history (anchor 구간용) */
  history: readonly SnapshotHistoryLike[];
}

export interface BuildTimelineOptions {
  accounts: readonly AccountTimelineInput[];
  library: readonly AssetLibraryEntry[];
  /** 가격이 존재하는 거래일 (오름차순) */
  tradingDates: readonly string[];
}

const compact = (h: Record<string, number>): Holdings => {
  const out: Record<string, number> = {};
  for (const [t, q] of Object.entries(h)) if (q !== 0) out[t] = q;
  return out;
};

const sameHoldings = (a: Holdings, b: Holdings): boolean => {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

/**
 * anchor 한 줄 → ticker 기반 보유수량. 해석 못한 행은 `unresolved` 로 올린다
 * (버리지 않는다 — 조용히 0 이 되는 것이 가장 나쁘다).
 */
export function anchorHoldings(
  anchor: SnapshotHistoryLike | undefined,
  library: readonly AssetLibraryEntry[],
): { holdings: Holdings; unresolved: string[] } {
  if (!anchor) return { holdings: {}, unresolved: [] };
  const qty = anchor.rowQuantitiesSnap ?? {};
  const etf = anchor.rowEtfSnap ?? {};
  const out: Record<string, number> = {};
  const unresolved: string[] = [];
  for (const [rowId, raw] of Object.entries(qty)) {
    const q = Number(raw ?? 0);
    if (!(q > 0)) continue;
    const name = etf[rowId];
    const ticker = resolveEtfTicker(library, name);
    if (!ticker) {
      unresolved.push(`${rowId}=${name ?? "?"}`);
      continue;
    }
    out[ticker] = (out[ticker] ?? 0) + q;
  }
  return { holdings: compact(out), unresolved };
}

/** 원장 누적 — `date` **이전**(exclusive) 까지의 보유수량. */
function ledgerHoldingsBefore(days: readonly DailyHoldingsDelta[], date: string): Holdings {
  const h: Record<string, number> = {};
  for (const d of days) {
    if (d.date >= date) break;
    for (const [t, q] of Object.entries(d.deltas)) h[t] = (h[t] ?? 0) + q;
  }
  return compact(h);
}

/** 원장 누적 — `date` **까지**(inclusive) 의 보유수량. */
export function ledgerHoldingsThrough(days: readonly DailyHoldingsDelta[], date: string): Holdings {
  const h: Record<string, number> = {};
  for (const d of days) {
    if (d.date > date) break;
    for (const [t, q] of Object.entries(d.deltas)) h[t] = (h[t] ?? 0) + q;
  }
  return compact(h);
}

/**
 * 계좌 하나의 거래일별 보유수량.
 *
 * 성과 구간(`performanceStart`) 이전 날짜는 만들지 않는다. 단 `performanceStart` 당일의
 * `openHoldings` 는 **그 전날까지의 재생값**이므로, 전략 시작 전 거래가 여기에 반영된다
 * — pre-strategy 거래를 "성과 구간에서 제외"하는 것은 **표시 경계**이지 데이터 삭제가
 * 아니기 때문이다.
 */
export function buildAccountTimeline(
  input: AccountTimelineInput,
  library: readonly AssetLibraryEntry[],
  tradingDates: readonly string[],
): HoldingsDay[] {
  const { coverage, ledgerDays } = input;
  if (!coverage.performanceStart) return [];
  const anchors = validAnchors(input.history);
  const byDate = new Map(ledgerDays.map((d) => [d.date, d]));
  const out: HoldingsDay[] = [];

  let prevClose: Holdings | null = null;
  for (const date of tradingDates) {
    if (date < coverage.performanceStart) continue;
    const source: HoldingsSource =
      coverage.ledgerCutoff && date <= coverage.ledgerCutoff ? "ledger" : "anchor";

    if (source === "ledger") {
      const openHoldings: Holdings = prevClose ?? ledgerHoldingsBefore(ledgerDays, date);
      const day = byDate.get(date);
      const closeHoldings: Holdings = day
        ? compact(applyDeltas(openHoldings, day.deltas))
        : openHoldings;
      out.push({
        date,
        accountId: input.accountId,
        openHoldings,
        closeHoldings,
        source,
        traded: !!day,
        execPrice: day?.execPrice ?? {},
        netCashDelta: day?.netCashDelta ?? 0,
        reportedCosts: day?.reportedCosts ?? 0,
        unresolved: [],
      });
      prevClose = closeHoldings;
      continue;
    }

    // anchor 구간 — 그 날짜 이하 가장 최근 anchor 가 그 날 **종료** 상태다.
    const closeRes = anchorHoldings(anchorAsOf(anchors, date), library);
    const openHoldings = prevClose ?? closeRes.holdings;
    out.push({
      date,
      accountId: input.accountId,
      openHoldings,
      closeHoldings: closeRes.holdings,
      source,
      traded: !sameHoldings(openHoldings, closeRes.holdings),
      execPrice: {}, // 체결가를 모른다 → 종가 체결 가정
      netCashDelta: null, // 유도해야 한다
      reportedCosts: 0,
      unresolved: closeRes.unresolved,
    });
    prevClose = closeRes.holdings;
  }
  return out;
}

function applyDeltas(
  base: Holdings,
  deltas: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [t, q] of Object.entries(deltas)) out[t] = (out[t] ?? 0) + q;
  return out;
}

export function buildHoldingsTimeline(o: BuildTimelineOptions): HoldingsDay[] {
  const out: HoldingsDay[] = [];
  for (const acc of o.accounts) {
    out.push(...buildAccountTimeline(acc, o.library, o.tradingDates));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId));
}

// ── seam reconciliation ─────────────────────────────────────────────────────

export interface SeamCheck {
  accountId: string;
  seam: string | null;
  /** ticker → { ledger, anchor } — 값이 다른 것만 */
  mismatches: { ticker: string; ledger: number; anchor: number }[];
  /** 비교한 ticker 수 */
  compared: number;
  unresolved: readonly string[];
  ok: boolean;
}

/**
 * **게이트**: 원장을 seam 날짜(당일 포함)까지 재생한 보유수량 == 그 anchor 의 수량.
 *
 * 이것이 맞으면 "원장이 끝나는 지점과 기존 앱 데이터가 정확히 이어진다"가 증명된다.
 * source 를 cutoff 에서 바꾸더라도, seam 에서 두 경로가 같다는 사실이 timeline 전체의
 * 연속성을 보장한다. production 실측 결과는 전 계좌 불일치 **0** 이다.
 */
export function reconcileSeam(
  input: AccountTimelineInput,
  library: readonly AssetLibraryEntry[],
): SeamCheck {
  const seam = input.coverage.seam;
  if (!seam) {
    return {
      accountId: input.accountId,
      seam: null,
      mismatches: [],
      compared: 0,
      unresolved: [],
      ok: true,
    };
  }
  const anchors = validAnchors(input.history);
  const anchorAt = anchors.find((a) => a.date === seam);
  const { holdings: anchorQty, unresolved } = anchorHoldings(anchorAt, library);
  const ledgerQty = ledgerHoldingsThrough(input.ledgerDays, seam);

  const tickers = [...new Set([...Object.keys(ledgerQty), ...Object.keys(anchorQty)])].sort();
  const mismatches = tickers
    .map((ticker) => ({ ticker, ledger: ledgerQty[ticker] ?? 0, anchor: anchorQty[ticker] ?? 0 }))
    .filter((m) => m.ledger !== m.anchor);

  return {
    accountId: input.accountId,
    seam,
    mismatches,
    compared: tickers.length,
    unresolved,
    ok: mismatches.length === 0 && unresolved.length === 0,
  };
}
