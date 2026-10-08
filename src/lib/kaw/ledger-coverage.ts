// ─────────────────────────────────────────────────────────────────────────────
// 계좌별 구간 판정 — 수익 분석이 "어디부터 어디까지, 어떤 정확도로" 계산할지 정한다.
//
// ## 날짜를 하드코딩하지 않는다
//
// `seam`(첫 유효 anchor)과 `ledgerCutoff`(원장 마지막 실효 거래일)은 **데이터에서
// 계산한다.** 원장이 보충되면 cutoff 가 저절로 뒤로 움직여야 하고, 리밸런싱을 한 번 더
// 저장하면 anchor 가 늘어나야 한다. 테스트의 고정값은 "지금 데이터에서 그 값이 나온다"는
// 확인이지 정책이 아니다.
//
// 유일한 상수는 **전략 시작일**이다 — 이건 데이터가 아니라 사용자가 정한 성과 경계다
// (`data/verified-transactions.v1.json` 의 `strategyStartDates` 와 같은 값).
//
// ## 세 축을 분리한다
//
//   holdingsSource : ledger    — 원장 재생. 모든 거래일의 수량을 정확히 안다
//                    anchor    — legacy rowQuantitiesSnap carry-forward. 리밸런싱 사이는 고정
//   cashQuality    : derived          — 원장+장부로 유도 (보수 모델)
//                    anchor-implied   — anchor 수량 변화를 종가 체결로 가정해 유도
//                    cashflow-pending — 입금은 장부에 있는데 그 돈을 쓴 거래가 아직 없다
//                    unknown          — 위 어느 것도 성립하지 않음
//   span           : full | account-inception | in-progress
//
// **`full-span`(기간 전체를 덮음)과 `exact`(정확도)는 다른 말이다.** 2026년은 첫 거래일부터
// 현재까지 full span 으로 보여주지만, cutoff 이후 구간이 섞여 있으면 결과를 exact 라고
// 표시하지 않는다.
//
// ## holdings source 정책 (2026-10-08 결정)
//
// seam 은 **source switch 지점이 아니다.** seam 과 그 이후 모든 checkpoint 에서 ledger
// replay 와 legacy anchor 가 전부 일치했으므로(불일치 0), **원장이 있는 동안은 더 정밀한
// 원장을 계속 쓴다.**
//
//   전략시작 ~ ledgerCutoff   → ledger replay
//   ledgerCutoff ~ 오늘        → legacy anchor carry-forward
//
// seam 은 "두 데이터가 정확히 이어짐을 증명하는 reconciliation checkpoint" 로만 남는다.
// ─────────────────────────────────────────────────────────────────────────────

import { ACCOUNT_IDS, type AccountId } from "./constants";
import type { SnapshotHistoryLike } from "./snapshot";
import { validAnchors } from "./historical-performance";

/**
 * K-올웨더 **전략** 시작일. 계좌 개시일(첫 입금)과 다르다 — 그 앞의 거래는 원장에
 * 있지만 전략 성과 구간에는 넣지 않는다.
 * 출처: `data/verified-transactions.v1.json` 의 `strategyStartDates`.
 */
export const STRATEGY_START_DATES: Readonly<Record<AccountId, string>> = Object.freeze({
  retirement: "2025-09-10",
  pension: "2025-11-10",
  irp: "2025-12-29",
  isa: "2026-01-07",
} as Record<AccountId, string>);

export type HoldingsSource = "ledger" | "anchor";
export type CashQuality = "derived" | "anchor-implied" | "cashflow-pending" | "unknown";
export type SpanKind = "full" | "account-inception" | "in-progress";

export interface CoverageInput {
  accountId: AccountId;
  /** 원장 거래의 실효 거래일 목록 (순서 무관) */
  ledgerDates: readonly string[];
  /** 외부 입출금 날짜 목록 (순서 무관) */
  cashflowDates: readonly string[];
  /** legacy history (anchor 판정용) */
  history: readonly SnapshotHistoryLike[];
}

export interface AccountCoverage {
  accountId: AccountId;
  /** min(첫 외부 입출금, 첫 원장 거래). 그 앞에는 포트폴리오가 **존재하지 않았다** */
  inception: string | null;
  /** 전략 시작일 (상수) */
  strategyStart: string;
  /**
   * 성과 구간의 첫 날.
   *
   * 전략 시작일 **직전에 보유가 있었으면** 그 날은 "전략 전환일"이다 — 그 날 `V_open` 이
   * pre-strategy 보유이고 당일 손익에 그 청산 손익이 섞인다. 그래서 **다음 거래일**부터
   * 시작한다. 보유가 없었으면(계좌가 비어 있었으면) 전략 시작일 당일부터 시작한다.
   * 이 판정은 `resolvePerformanceStart` 가 실제 보유수량으로 한다.
   */
  performanceStart: string | null;
  /** 전략 시작 직전에 보유가 있었는가 (= 전략 시작일이 전환일인가) */
  strategyStartIsTransition: boolean;
  /** 첫 유효 `rowQuantitiesSnap` 날짜 — reconciliation checkpoint */
  seam: string | null;
  /** 원장 마지막 실효 거래일. 이 날짜까지는 원장이 보유수량 source 다 */
  ledgerCutoff: string | null;
  /** 유효 anchor 날짜 전체 (오름차순) */
  anchorDates: readonly string[];
}

const minOf = (xs: readonly string[]): string | null => {
  let out: string | null = null;
  for (const x of xs) if (x && (out === null || x < out)) out = x;
  return out;
};
const maxOf = (xs: readonly string[]): string | null => {
  let out: string | null = null;
  for (const x of xs) if (x && (out === null || x > out)) out = x;
  return out;
};

/** 계좌 하나의 구간 판정. `performanceStart` 는 보유수량이 필요하므로 뒤에서 채운다. */
export function accountCoverage(input: CoverageInput): AccountCoverage {
  const anchors = validAnchors(input.history);
  const anchorDates = anchors.map((a) => a.date);
  return {
    accountId: input.accountId,
    inception: minOf([...input.cashflowDates, ...input.ledgerDates]),
    strategyStart: STRATEGY_START_DATES[input.accountId],
    performanceStart: null,
    strategyStartIsTransition: false,
    seam: anchorDates.length ? anchorDates[0] : null,
    ledgerCutoff: maxOf(input.ledgerDates),
    anchorDates,
  };
}

/**
 * 전략 시작일 직전 보유수량으로 `performanceStart` 를 확정한다.
 *
 * `holdingsBefore` = 전략 시작일 **전날까지** 재생한 보유수량. 양수가 하나라도 있으면
 * 전환일이므로 다음 거래일부터, 없으면 전략 시작일 당일부터다.
 *
 * retirement 가 유일한 전환 케이스다 — 2025-09-10 에 pre-strategy 보유
 * (133690 / 232080 / 360750)가 전량 매도되고 9자산 배분이 매수됐다. 그래서
 * `performanceStart` 가 **2025-09-11** 이 된다.
 */
export function resolvePerformanceStart(
  coverage: AccountCoverage,
  holdingsBefore: Readonly<Record<string, number>>,
  tradingDates: readonly string[],
): AccountCoverage {
  const hadPositions = Object.values(holdingsBefore ?? {}).some((q) => Number(q ?? 0) > 0);
  const start = coverage.strategyStart;
  let performanceStart: string | null = null;
  for (const d of tradingDates) {
    if (hadPositions ? d > start : d >= start) {
      performanceStart = d;
      break;
    }
  }
  return { ...coverage, strategyStartIsTransition: hadPositions, performanceStart };
}

export type CoverageMap = Readonly<Record<AccountId, AccountCoverage>>;

export function buildCoverageMap(inputs: readonly CoverageInput[]): CoverageMap {
  const out = {} as Record<AccountId, AccountCoverage>;
  for (const id of ACCOUNT_IDS) {
    const hit = inputs.find((i) => i.accountId === id);
    out[id] = hit
      ? accountCoverage(hit)
      : accountCoverage({ accountId: id, ledgerDates: [], cashflowDates: [], history: [] });
  }
  return Object.freeze(out);
}

/** 그 날짜의 보유수량을 어디서 가져오는가. cutoff 까지는 원장, 그 뒤는 anchor. */
export function holdingsSourceFor(coverage: AccountCoverage, date: string): HoldingsSource {
  if (coverage.ledgerCutoff && date <= coverage.ledgerCutoff) return "ledger";
  return "anchor";
}

/** 그 날짜가 이 계좌의 성과 구간 안인가. */
export function isWithinPerformanceWindow(coverage: AccountCoverage, date: string): boolean {
  return !!coverage.performanceStart && date >= coverage.performanceStart;
}

/**
 * 그 날짜에 이 계좌가 **존재했는가.** 존재하지 않은 계좌는 자산 0 이고 그것은 **사실이다**
 * — "데이터가 빠진 계좌"와 반드시 구분한다(전체 scope 합산 규칙).
 */
export function hasStarted(coverage: AccountCoverage, date: string): boolean {
  return !!coverage.inception && date >= coverage.inception;
}

/** period 가 달력상 기간 전체를 덮는가. */
export function spanOf(
  periodFirstTradingDate: string,
  periodLastTradingDate: string,
  segmentOpen: string,
  segmentClose: string,
): SpanKind {
  if (segmentOpen > periodFirstTradingDate) return "account-inception";
  if (segmentClose < periodLastTradingDate) return "in-progress";
  return "full";
}

/**
 * 구간의 종합 품질. **가장 약한 고리**를 따른다 — 하루라도 anchor 기반이거나 현금을
 * 모르면 그 구간 전체를 `exact` 라고 부르지 않는다.
 */
export function worstCashQuality(qualities: readonly CashQuality[]): CashQuality {
  const order: CashQuality[] = ["derived", "anchor-implied", "cashflow-pending", "unknown"];
  let worst: CashQuality = "derived";
  for (const q of qualities) {
    if (order.indexOf(q) > order.indexOf(worst)) worst = q;
  }
  return worst;
}

/** 구간을 `exact-ledger` 라고 표시할 수 있는가. */
export function isExactSegment(
  holdingsSources: readonly HoldingsSource[],
  cashQuality: CashQuality,
): boolean {
  return holdingsSources.every((s) => s === "ledger") && cashQuality === "derived";
}
