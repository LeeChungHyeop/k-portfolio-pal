// ─────────────────────────────────────────────────────────────────────────────
// 이전 자금 대사 (Phase 4-C-1) — 순수 모듈
//
// 이전 확인금액, 체결 매수금액, 증권사가 말한 예수금(관측), 원장이 유도한 예수금을 나란히 놓고
// **차이의 크기만** 보여 준다.
//
// ## 하지 않는 것 (원칙)
//   차이의 원인을 이자 · 분배금 · 매도 차익 · 수수료 · 신규 납입 등으로 **분류하지 않는다.**
//   근거 없는 분류는 보정 거래를 만드는 첫걸음이다. 이 모듈은 모든 비영(0이 아닌) 차이에
//   `status: "unconfirmed"`(원인 미확정)만 붙인다. 원인 필드 자체가 타입에 없다.
//   작은 차이(예: 335원)도 수수료로 확정하지 않는다 — 체결 API 는 수수료를 주지 않으므로
//   수수료일 수 있다는 것은 추정이다.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileInput {
  /** 사용자가 확인한 이전(입고) 금액 */
  transferAmount: number;
  /** 같은 기간 한국투자 실제 체결 매수 합계 (체결수량 > 0 인 행만) */
  kisBuyAmount: number;
  /** 위 매수 중 **이미 원장에 반영된** 금액. 지금은 0 이다(4-C-2 전) */
  kisBuyAmountAlreadyInLedger: number;
  /** 원장 유도 예수금(finalDerived) — 현재 원장 기준 */
  ledgerDerivedCash: number;
  /** 증권사가 말한 예수금 (관측) */
  observedCash: number;
  principalBefore: number;
  principalAfter: number;
}

export type DifferenceStatus = "matches" | "unconfirmed";

export interface ReconcileLine {
  id: "expected_vs_observed" | "ledger_vs_observed";
  label: string;
  /** 비교 기준값 */
  baseline: number;
  /** 관측값 */
  observed: number;
  /** 관측 − 기준 (양수면 관측이 더 크다) */
  difference: number;
  /** 0 이면 matches, 아니면 unconfirmed(원인 미확정). 다른 값은 없다 */
  status: DifferenceStatus;
  /** 항상 원인을 단정하지 않는다는 안내 */
  note: string;
}

export interface ReconcileResult {
  expectedCashAfterBuys: number;
  /** 매수가 원장에 반영됐다고 가정한 원장 유도 예수금 */
  ledgerCashAfterKisBuys: number;
  lines: ReconcileLine[];
  /** 항상 false. 원인을 분류하지 않는다 */
  causeClassified: false;
  /** 자동으로 분류하지 않는 원인 후보 — 화면에 '분류하지 않음'으로 보인다 */
  notClassifiedAs: readonly string[];
  principal: { before: number; after: number; unchanged: boolean };
}

export const NOT_CLASSIFIED_AS = ["이자", "분배금", "매도 차익", "수수료", "신규 납입"] as const;

const NOTE_UNCONFIRMED = "원인 미확정 — 이자·분배금·매도 차익·수수료·신규 납입 등으로 분류하지 않았고 보정 거래도 만들지 않습니다.";
const NOTE_MATCHES = "차이 없음.";

function line(id: ReconcileLine["id"], label: string, baseline: number, observed: number): ReconcileLine {
  const difference = observed - baseline;
  return { id, label, baseline, observed, difference, status: difference === 0 ? "matches" : "unconfirmed", note: difference === 0 ? NOTE_MATCHES : NOTE_UNCONFIRMED };
}

export function reconcileTransfer(input: ReconcileInput): ReconcileResult {
  const expectedCashAfterBuys = input.transferAmount - input.kisBuyAmount;
  // 아직 원장에 없는 체결 매수를 반영했을 때의 원장 유도 예수금
  const ledgerCashAfterKisBuys = input.ledgerDerivedCash - (input.kisBuyAmount - input.kisBuyAmountAlreadyInLedger);
  return {
    expectedCashAfterBuys,
    ledgerCashAfterKisBuys,
    lines: [
      line("expected_vs_observed", "이전 확인금액 − 체결 매수 대비 관측 예수금", expectedCashAfterBuys, input.observedCash),
      line("ledger_vs_observed", "원장 유도 예수금(체결 매수 반영 가정) 대비 관측 예수금", ledgerCashAfterKisBuys, input.observedCash),
    ],
    causeClassified: false,
    notClassifiedAs: NOT_CLASSIFIED_AS,
    principal: { before: input.principalBefore, after: input.principalAfter, unchanged: input.principalBefore === input.principalAfter },
  };
}
