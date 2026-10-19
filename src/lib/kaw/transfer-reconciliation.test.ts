/**
 * 이전 자금 대사 — 실제 수치 (2026-10-19 운영 원장 읽기 + 한국투자 잔고 조회)
 *
 *   이전 확인금액           10,293,793
 *   한국투자 체결 매수        7,974,630   (TIGER 230주 5,976,550 + ACE 64주 1,998,080)
 *   관측 예수금               2,318,828
 *   원장 유도 예수금(매수 전)  10,219,264   → 매수 반영 시 2,244,634
 *   누적 납입원금             10,500,000
 *
 * 지키는 것: 차이의 크기만 보여 준다. 원인(이자·분배금·매도 차익·수수료·신규 납입)을 분류하지 않는다.
 */
import { describe, it, expect } from "vitest";
import { NOT_CLASSIFIED_AS, reconcileTransfer, type ReconcileInput } from "./transfer-reconciliation";

const REAL: ReconcileInput = {
  transferAmount: 10_293_793,
  kisBuyAmount: 7_974_630,
  kisBuyAmountAlreadyInLedger: 0,
  ledgerDerivedCash: 10_219_264,
  observedCash: 2_318_828,
  principalBefore: 10_500_000,
  principalAfter: 10_500_000,
};

describe("실제 수치 대사", () => {
  const r = reconcileTransfer(REAL);

  it("기대 예수금 2,319,163 · 매수 반영 원장 유도 예수금 2,244,634", () => {
    expect(r.expectedCashAfterBuys).toBe(2_319_163);
    expect(r.ledgerCashAfterKisBuys).toBe(2_244_634);
  });

  it("335원 차이는 수수료로 확정하지 않고 '원인 미확정'으로만 표시한다", () => {
    const l = r.lines.find((x) => x.id === "expected_vs_observed")!;
    expect(l.baseline).toBe(2_319_163);
    expect(l.observed).toBe(2_318_828);
    expect(l.difference).toBe(-335);
    expect(l.status).toBe("unconfirmed");
    expect(l.note).toContain("원인 미확정");
    expect(l.note).toContain("보정 거래도 만들지 않습니다");
  });

  it("74,194원 차이도 원인 미확정이다 (이자·분배금·매도 차익·수수료·신규 납입으로 분류하지 않는다)", () => {
    const l = r.lines.find((x) => x.id === "ledger_vs_observed")!;
    expect(l.difference).toBe(74_194);
    expect(l.status).toBe("unconfirmed");
    expect(JSON.stringify(l)).not.toMatch(/"(interest|dividend|fee|gain|deposit|cause|reason)"/i);
  });

  it("원인 분류는 하지 않으며 분류하지 않는 항목을 명시한다", () => {
    expect(r.causeClassified).toBe(false);
    expect([...r.notClassifiedAs]).toEqual([...NOT_CLASSIFIED_AS]);
    expect(r.notClassifiedAs).toEqual(["이자", "분배금", "매도 차익", "수수료", "신규 납입"]);
  });

  it("상태 값은 matches / unconfirmed 둘뿐이다", () => {
    for (const l of r.lines) expect(["matches", "unconfirmed"]).toContain(l.status);
  });

  it("누적 납입원금 10,500,000 은 변하지 않는다 (이전은 신규 납입이 아니다)", () => {
    expect(r.principal).toEqual({ before: 10_500_000, after: 10_500_000, unchanged: true });
  });
});

describe("경계", () => {
  it("차이가 0 이면 일치로 표시한다", () => {
    const r = reconcileTransfer({ ...REAL, observedCash: 2_319_163, ledgerDerivedCash: 10_293_793 });
    expect(r.lines.every((l) => l.status === "matches" && l.difference === 0)).toBe(true);
  });

  it("체결 매수가 이미 원장에 반영돼 있으면 이중으로 빼지 않는다", () => {
    // 매수가 이미 원장에 있으면 유도 예수금(finalDerived)에 이미 빠져 있다
    const r = reconcileTransfer({ ...REAL, ledgerDerivedCash: 2_244_634, kisBuyAmountAlreadyInLedger: 7_974_630 });
    expect(r.ledgerCashAfterKisBuys).toBe(2_244_634);
    expect(r.lines.find((l) => l.id === "ledger_vs_observed")!.difference).toBe(74_194);
  });

  it("원금이 달라지면 변동으로 표시한다 (검증 실패 신호)", () => {
    expect(reconcileTransfer({ ...REAL, principalAfter: 18_474_630 }).principal.unchanged).toBe(false);
  });

  it("관측이 기대보다 작거나 커도 부호만 다를 뿐 같은 방식으로 다룬다", () => {
    expect(reconcileTransfer({ ...REAL, observedCash: 2_400_000 }).lines[0].difference).toBe(80_837);
    expect(reconcileTransfer({ ...REAL, observedCash: 2_000_000 }).lines[0].difference).toBe(-319_163);
  });
});
