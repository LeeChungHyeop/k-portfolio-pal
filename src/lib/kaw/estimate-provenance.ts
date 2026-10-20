// ─────────────────────────────────────────────────────────────────────────────
// 추정 거래 provenance — 수익 분석이 "확정값"으로 보이지 않아야 할 날짜를 찾는다 (순수 모듈)
//
// 원장 `source` 가 ledger 라는 사실만으로는 그 거래가 실제 체결이라는 뜻이 아니다.
// 계좌 이전 때 사용자가 승인한 **가격 대용 추정 매도**(`ESTIMATED_EXIT_SOURCES`)도 원장 행이다.
// 이 모듈은 그런 행을 식별해 (계좌, 날짜, 사유)로 내보낼 뿐이고, 숫자는 고치지 않는다.
//
// 하지 않는 것:
//   · 실제 체결(예: 한국투자 API 체결)을 추정으로 격하하지 않는다 — 출처가 목록에 없으면 해당 없음
//   · 추정가를 다른 값으로 보정하지 않는다
//   · 추정 매도 이후 날짜까지 번지게 하지 않는다 (그 날짜가 포함된 구간만 표시된다)
// ─────────────────────────────────────────────────────────────────────────────

import { ESTIMATED_EXIT_SOURCES } from "./account-transfer-record";
import { effectiveTransaction, type LedgerTransaction, type TransactionCorrection } from "./ledger";

export type EstimateReason =
  /** 체결가가 실제가 아니라 사용자가 승인한 가격 대용이다 */
  | "exit_price_proxy"
  /**
   * 증권사가 보고한 실제 매도 일자가 없다 — 표시된 날짜는 회계 기준일일 수 있다.
   * 그래서 **직전 확정 거래일 다음날 ~ 그 날짜** 사이에는 실제 보유 노출을 확정할 수 없다(`windowFrom`).
   */
  | "exit_date_unconfirmed";

export interface EstimatedDay {
  accountId: string;
  /** 원장 실효 거래일 (YYYY-MM-DD) */
  date: string;
  reasons: readonly EstimateReason[];
  /**
   * 실제 매도일이 (windowFrom, date] 안의 어느 날이든 될 수 있다 — windowFrom 은 그 계좌의 **추정이 아닌**
   * 직전 원장 거래일(배제). 없으면 null(시작을 알 수 없다). 매도일이 확인된 거래면 date 와 같은 날 하나뿐이다.
   */
  windowFrom: string | null;
}

export const ESTIMATE_REASON_LABEL: Record<EstimateReason, string> = {
  exit_price_proxy: "청산가가 실제 체결가가 아닌 추정(가격 대용)입니다",
  exit_date_unconfirmed: "실제 매도 일자가 확인되지 않았습니다 (직전 확정 거래일 이후 보유 노출이 불확실)",
};

/** 추정 청산 거래가 있는 (계좌, 날짜) 목록. 제외 처리된 거래는 보지 않는다. */
export function estimatedExitDays(
  transactions: readonly LedgerTransaction[],
  corrections: ReadonlyMap<string, TransactionCorrection> = new Map(),
): EstimatedDay[] {
  const byKey = new Map<string, { accountId: string; date: string; reasons: Set<EstimateReason> }>();
  for (const tx of transactions) {
    if (!ESTIMATED_EXIT_SOURCES.includes(tx.source)) continue;
    const e = effectiveTransaction(tx, corrections.get(tx.id));
    if (e.excluded) continue;
    const key = `${e.accountId}|${e.eventDate}`;
    const bucket = byKey.get(key) ?? { accountId: e.accountId, date: e.eventDate, reasons: new Set<EstimateReason>() };
    bucket.reasons.add("exit_price_proxy");
    if (!tx.tradeDate) bucket.reasons.add("exit_date_unconfirmed");
    byKey.set(key, bucket);
  }
  // 직전 확정 거래일: 추정이 아니고 제외되지 않은 같은 계좌의 원장 거래 중 그 날짜 이전 최댓값
  const confirmedDates = new Map<string, string[]>();
  for (const tx of transactions) {
    if (ESTIMATED_EXIT_SOURCES.includes(tx.source)) continue;
    const e = effectiveTransaction(tx, corrections.get(tx.id));
    if (e.excluded) continue;
    const list = confirmedDates.get(e.accountId) ?? [];
    list.push(e.eventDate);
    confirmedDates.set(e.accountId, list);
  }
  const prevConfirmed = (accountId: string, date: string): string | null => {
    let best: string | null = null;
    for (const d of confirmedDates.get(accountId) ?? []) if (d < date && (best === null || d > best)) best = d;
    return best;
  };

  return [...byKey.values()]
    .map((b) => ({
      accountId: b.accountId,
      date: b.date,
      reasons: [...b.reasons],
      windowFrom: b.reasons.has("exit_date_unconfirmed") ? prevConfirmed(b.accountId, b.date) : b.date,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId));
}
