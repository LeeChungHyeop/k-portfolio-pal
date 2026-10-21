// ─────────────────────────────────────────────────────────────────────────────
// 추정 거래 provenance — 수익 분석이 "확정값"으로 보이지 않아야 할 날짜를 찾는다 (순수 모듈)
//
// 원장 `source` 가 ledger 라는 사실만으로는 그 거래가 실제 체결이라는 뜻이 아니다.
// 계좌 이전 때 사용자가 승인한 **가격 대용 추정 매도**(`ESTIMATED_EXIT_SOURCES`)도 원장 행이다.
// 이 모듈은 그런 행을 식별해 (계좌, 날짜, 사유)로 내보낼 뿐이고, 숫자는 고치지 않는다.
//
// 하지 않는 것:
//   · 실제 체결(예: 한국투자 API 체결)을 추정으로 격하하지 않는다 — 출처가 목록에 없으면 해당 없음
//   · 추정가·추정 매도일을 실제 체결 사실로 승격하지 않는다
//   · 추정가를 다른 값으로 보정하지 않는다
//
// ## 이 모듈이 구분하는 불확실성 (서로 다른 것이다 — 하나로 뭉뚱그리지 않는다)
//
//   ① 추정 청산대금   — 체결가가 대용값이라 **대금 자체**가 틀릴 수 있다 (exit_price_proxy)
//   ② 실제 매도일     — 어느 날 팔렸는지 모른다 → 그 사이 보유 노출이 불확실하다 (exit_date_unconfirmed)
//   ③ 미관측 현금수입 — 이자·분배금. 이 모듈의 대상이 아니다 (derived-cash 의 incomeLB, L3)
//
//   ①의 오차가 이후 구간의 손익에 실제로 번지는지는 현금 모델(running-min incomeLB)에 달려 있다 —
//   그 판정은 profit-analysis.ts 의 `cashErrorCancels` 가 한다.
//   동기화 기록의 "원장-관측 차이"(예: 16,078원)는 ①②③을 모두 합친 **설명되지 않은 잔차**이지
//   ①의 상한이 아니다. 그 값을 청산대금 오차의 상한으로 읽지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { ESTIMATED_EXIT_SOURCES } from "./account-transfer-record";
import { effectiveTransaction, type LedgerTransaction, type TransactionCorrection } from "./ledger";

export type EstimateReason =
  /** ① 체결가가 실제가 아니라 사용자가 승인한 가격 대용이다 */
  | "exit_price_proxy"
  /**
   * ② 증권사가 보고한 실제 매도 일자가 없다 — 표시된 날짜는 회계 기준일일 수 있다.
   * 그래서 **매도 종목의 보유를 마지막으로 확인한 시점부터 그 날짜까지**(`windowStart`)는 실제 보유 노출을 확정할 수 없다.
   */
  | "exit_date_unconfirmed"
  /**
   * ① 의 오차가 이 구간의 시작·종료 현금에서 **동일하게 상쇄된다는 근거가 없다.**
   * 현금 모델의 미관측 수입 하한(incomeLB)은 running-min 이라, 청산대금 가정에 따라 구간 손익이 달라질 수 있다.
   */
  | "cash_error_not_cancelled";

export interface EstimatedDay {
  accountId: string;
  /** 원장 실효 거래일 (YYYY-MM-DD) */
  date: string;
  reasons: readonly EstimateReason[];
  /**
   * 실제 매도일이 [windowStart, date] 안의 어느 날이든 될 수 있다 (양 끝 포함).
   *
   * 시작점은 **매도 종목들의 보유를 확인한 가장 늦은 근거**다 — 같은 계좌의 아무 거래가 아니다:
   *   · 그 종목의 비추정 원장 거래이고, 그 거래 직후의 누적 보유가 매도 수량 이상이어야 한다
   *   · 그 날 증권사가 보고한 거래 후 보유수량(postQuantity)이 있어야 **그 날 종가 보유**까지 입증된다.
   *     없으면 같은 날 뒤늦게 팔렸을 수 있으므로 그 날 자체가 창에 들어간다
   *   · 매도 종목 중 하나라도 근거가 없으면 null (시작을 알 수 없다 — 창을 줄이지 않는다)
   * 매도일이 확인된 거래면 date 와 같은 날 하나뿐이다.
   */
  windowStart: string | null;
}

export const ESTIMATE_REASON_LABEL: Record<EstimateReason, string> = {
  exit_price_proxy: "청산가가 실제 체결가가 아닌 추정(가격 대용)입니다",
  exit_date_unconfirmed: "실제 매도 일자가 확인되지 않아 이 기간의 보유 노출이 불확실합니다",
  cash_error_not_cancelled:
    "추정 청산대금의 오차가 이 구간의 손익에서 상쇄된다는 근거가 없습니다 (현금 모델의 미관측 수입 하한이 대금 가정에 따라 달라질 수 있음)",
};

const dayAfter = (d: string): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** 추정 청산 거래가 있는 (계좌, 날짜) 목록. 제외 처리된 거래는 보지 않는다. */
export function estimatedExitDays(
  transactions: readonly LedgerTransaction[],
  corrections: ReadonlyMap<string, TransactionCorrection> = new Map(),
): EstimatedDay[] {
  type Bucket = {
    accountId: string;
    date: string;
    reasons: Set<EstimateReason>;
    /** 종목별 추정 매도 수량 */
    sold: Map<string, number>;
  };
  const byKey = new Map<string, Bucket>();
  for (const tx of transactions) {
    if (!ESTIMATED_EXIT_SOURCES.includes(tx.source)) continue;
    const e = effectiveTransaction(tx, corrections.get(tx.id));
    if (e.excluded) continue;
    const key = `${e.accountId}|${e.eventDate}`;
    const bucket = byKey.get(key) ?? {
      accountId: e.accountId, date: e.eventDate, reasons: new Set<EstimateReason>(), sold: new Map(),
    };
    bucket.reasons.add("exit_price_proxy");
    if (!tx.tradeDate) bucket.reasons.add("exit_date_unconfirmed");
    if (e.side === "sell") bucket.sold.set(e.ticker, (bucket.sold.get(e.ticker) ?? 0) + e.quantity);
    byKey.set(key, bucket);
  }

  // 계좌·종목별 유효 거래 (제외 반영, 정정 반영)
  type Eff = { date: string; signed: number; estimated: boolean; postQuantity: number | null };
  const byAccountTicker = new Map<string, Eff[]>();
  for (const tx of transactions) {
    const e = effectiveTransaction(tx, corrections.get(tx.id));
    if (e.excluded) continue;
    const key = `${e.accountId}|${e.ticker}`;
    const list = byAccountTicker.get(key) ?? [];
    list.push({
      date: e.eventDate,
      signed: e.side === "sell" ? -e.quantity : e.quantity,
      estimated: ESTIMATED_EXIT_SOURCES.includes(tx.source),
      postQuantity: typeof tx.postQuantity === "number" ? tx.postQuantity : null,
    });
    byAccountTicker.set(key, list);
  }

  /** 이 종목의 보유를 (수량까지) 확인한 가장 늦은 시점. 근거가 없으면 null. */
  const confirmedStart = (accountId: string, ticker: string, before: string, qty: number): string | null => {
    const list = byAccountTicker.get(`${accountId}|${ticker}`) ?? [];
    const dates = [...new Set(list.filter((x) => !x.estimated && x.date < before).map((x) => x.date))].sort().reverse();
    for (const d of dates) {
      const holding = list.filter((x) => x.date <= d).reduce((a, x) => a + x.signed, 0);
      if (!(holding >= qty)) continue; // 수량까지 확인하지 못한다 — 더 이른 근거를 찾는다
      const closeProven = list.some(
        (x) => !x.estimated && x.date === d && x.postQuantity !== null && x.postQuantity >= qty,
      );
      return closeProven ? dayAfter(d) : d;
    }
    return null;
  };

  return [...byKey.values()]
    .map((b) => {
      let windowStart: string | null = b.date;
      if (b.reasons.has("exit_date_unconfirmed")) {
        const starts = [...b.sold].map(([t, q]) => confirmedStart(b.accountId, t, b.date, q));
        windowStart = starts.length === 0 || starts.some((s) => s === null)
          ? null
          : (starts as string[]).sort()[0];
      }
      return { accountId: b.accountId, date: b.date, reasons: [...b.reasons], windowStart };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId));
}
