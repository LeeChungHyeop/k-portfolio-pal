/**
 * 증권사 간 계좌 이전 자금 + 신규 체결 — 원금 이중 계산 · 가짜 미관측 수입 · 보유 이중 계산.
 *
 * 합성 데이터로 실제 사례의 구조를 재현한다:
 *   · 외부 입금(원금)이 쌓여 있고, 이전 전 증권사(A)가 ETF 를 보유하고 있다
 *   · 이전 후 새 증권사(B)에서 ETF 를 산다
 *
 * 지키는 것:
 *   1. 원금(Σ외부 입출금)은 후보를 반영해도 바뀌지 않는다
 *   2. 이전 전 증권사의 이탈 근거 없이 매수만 넣으면 → 가짜 미관측 수입 + 보유 이중 계산을 탐지한다
 *   3. 이탈 근거(전량 매도)가 있으면 → 가짜 수입 없음 · 원금 불변
 *   4. 같은 돈을 외부 입금으로 기록하면 원금이 이중 계산된다는 것을 보여주고 막는다(효과 모델)
 *   5. 이 모듈은 cashflow 를 만들거나 제안하지 않는다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assessFundingImpact,
  checkTransferEvidence,
  effectOfFundingSource,
  sumFlows,
  type TransferEvidence,
} from "./account-transfer-model";
import type { CashFlowInput, CashTradeInput } from "./derived-cash";

// 합성: 초기 5,000,000 + 월 400,000 × 8 = 8,200,000
const MONTH_DAYS = ["02-25", "03-25", "04-27", "05-25", "06-25", "07-27", "08-25", "09-25"];   // 모두 거래일
const FLOWS: CashFlowInput[] = [
  { date: "2026-01-05", amount: 5_000_000 },
  ...MONTH_DAYS.map((d) => ({ date: `2026-${d}`, amount: 400_000 })),
];
const PRINCIPAL = 8_200_000;

// 합성 원장(A 증권사): 입금으로 ETF 를 사 둔 상태. 예수금은 거의 0 이다.
const LEDGER: CashTradeInput[] = [
  { date: "2026-01-05", side: "buy", amount: 5_000_000, fee: 0, tax: 0 },
  ...MONTH_DAYS.map((d) => ({ date: `2026-${d}`, side: "buy" as const, amount: 400_000, fee: 0, tax: 0 })),
];
const REPLAY_BEFORE = { AAAAAA: 200, BBBBBB: 80 };      // 원장 재생 보유(이전 전 증권사)
const A_VALUE = 8_300_000;                                // 이전 시점 그 보유의 평가(가정)

// 이전 후 새 증권사(B)에서의 매수 (합성)
const B_BUYS: CashTradeInput[] = [
  { date: "2026-10-14", side: "buy", amount: 2_000_000, fee: null, tax: null },
  { date: "2026-10-14", side: "buy", amount: 6_000_000, fee: null, tax: null },
];
const B_DELTA = { AAAAAA: 150, BBBBBB: 60 };
const TD = ["2026-01-05", ...MONTH_DAYS.map((d) => `2026-${d}`), "2026-10-13", "2026-10-14"];

describe("기준선", () => {
  it("합성 원장은 입금만큼 사서 예수금이 거의 0 이다 (현재 원장 구조와 같다)", () => {
    const r = assessFundingImpact({ flows: FLOWS, ledgerTrades: LEDGER, candidates: [], tradingDates: TD });
    expect(r.before.totalIncomeLB).toBe(0);
    expect(r.verdict).toBe("ok");
    expect(sumFlows(FLOWS)).toBe(PRINCIPAL);
  });
});

describe("시나리오 A — 이전 전 증권사의 이탈 근거 없이 신규 매수만 반영", () => {
  const r = assessFundingImpact({
    flows: FLOWS, ledgerTrades: LEDGER, candidates: B_BUYS, tradingDates: TD,
    replayHoldingsBefore: REPLAY_BEFORE, candidateHoldingsDelta: B_DELTA,
    observedHoldings: { AAAAAA: 150, BBBBBB: 60 },   // 새 증권사가 보고한 보유 = 새로 산 것뿐
  });

  it("유도 예수금이 음수가 되고 가짜 미관측 수입이 매수액만큼 생긴다", () => {
    expect(r.after.finalDerived).toBe(-8_000_000);
    expect(r.phantomIncomeLB).toBe(8_000_000);
    expect(r.firstShortfallDate).toBe("2026-10-14");
    expect(r.verdict).toBe("funding_evidence_missing");
  });
  it("원금은 그대로다 — 문제는 원금이 아니라 가짜 수입이다", () => {
    expect(r.principalBefore).toBe(PRINCIPAL);
    expect(r.principalAfter).toBe(PRINCIPAL);
  });
  it("원장 재생 보유가 새 증권사 보고 보유의 두 배가 되어 이전 쪽 이탈 누락을 탐지한다", () => {
    expect(r.holdings!.replayAfter).toEqual({ AAAAAA: 350, BBBBBB: 140 });
    expect(r.holdings!.mismatches).toHaveLength(2);
    expect(r.holdings!.exitLegSuspected).toBe(true);
  });
  it("필요한 증거를 구체적으로 요구한다", () => {
    expect(r.missingEvidence.join("\n")).toContain("이탈 근거");
    expect(r.missingEvidence.join("\n")).toContain("입고");
    expect(r.missingEvidence.join("\n")).toContain("잔고 관측");
  });
  it("cashflow 를 만들거나 제안하지 않는다", () => {
    expect(r.createsCashflow).toBe(false);
    expect(r.principalEffect).toBe("none");
    expect(JSON.stringify(r)).not.toMatch(/"(deposit|withdrawal)"/);
  });
});

describe("시나리오 B — 이전 전 증권사 보유 전량 매도(내부 이동)를 원장에 먼저 반영", () => {
  const exitSale: CashTradeInput = { date: "2026-10-13", side: "sell", amount: A_VALUE, fee: null, tax: null };
  const r = assessFundingImpact({
    flows: FLOWS, ledgerTrades: [...LEDGER, exitSale], candidates: B_BUYS, tradingDates: TD,
    replayHoldingsBefore: { AAAAAA: 0, BBBBBB: 0 },   // 이탈 반영 후 재생 보유 = 0
    candidateHoldingsDelta: B_DELTA,
    observedHoldings: { AAAAAA: 150, BBBBBB: 60 },
  });

  it("가짜 수입이 생기지 않고 남은 현금은 매도대금 − 매수액이다", () => {
    expect(r.phantomIncomeLB).toBe(0);
    expect(r.after.totalIncomeLB).toBe(0);
    expect(r.after.finalDerived).toBe(A_VALUE - 8_000_000);
    expect(r.verdict).toBe("ok");
  });
  it("원금은 이전 · 매수와 무관하게 불변이다", () => {
    expect(r.principalAfter).toBe(PRINCIPAL);
  });
  it("재생 보유와 새 증권사 보고 보유가 일치한다", () => {
    expect(r.holdings!.mismatches).toEqual([]);
    expect(r.holdings!.exitLegSuspected).toBe(false);
  });
});

describe("시나리오 C — 이전 자금을 외부 입금으로 잘못 기록", () => {
  it("원금이 이전 금액만큼 이중 계산된다 (효과 모델이 이를 명시한다)", () => {
    const wrong = effectOfFundingSource("external_deposit", 8_000_000);
    expect(wrong.principalDelta).toBe(8_000_000);
    expect(sumFlows([...FLOWS, { date: "2026-10-14", amount: wrong.principalDelta }])).toBe(PRINCIPAL + 8_000_000);
  });
  it("내부 이동으로 분류하면 원금 효과가 0 이고 이탈 근거를 요구한다", () => {
    const e = effectOfFundingSource("internal_transfer", 8_000_000);
    expect(e.principalDelta).toBe(0);
    expect(e.requires).toContain("이탈 근거");
  });
  it("음수 금액 · 비정상 금액은 거부한다", () => {
    expect(() => effectOfFundingSource("internal_transfer", -1)).toThrow();
    expect(() => effectOfFundingSource("external_deposit", Number.NaN)).toThrow();
  });
});

describe("이전 증거 점검 — 임의로 채우지 않는다", () => {
  const full: TransferEvidence = {
    mode: "sold_then_cash_transfer", exitEvidenceInLedger: true,
    cashReceived: { date: "2026-10-14", amount: 8_300_000, basis: "broker_statement" }, postTransferObservation: true,
  };
  it("모든 증거가 있으면 충분하다", () => {
    expect(checkTransferEvidence(full)).toMatchObject({ sufficient: true, missing: [], createsCashflow: false, principalEffect: "none" });
  });
  it("현재 상황(이전 방식 미확정 · 이탈 근거 없음 · 입고 금액 없음)은 모두 요구한다", () => {
    const r = checkTransferEvidence({ mode: "unknown", exitEvidenceInLedger: false, cashReceived: null, postTransferObservation: false });
    expect(r.sufficient).toBe(false);
    expect(r.missing).toEqual([
      "이전 방식(매도 후 현금 이전 / 실물 이전)",
      "이전 전 증권사의 이탈 근거(매도 체결 또는 실물 이전 증거)",
      "이전 후 새 증권사 잔고 관측",
    ]);
  });
  it("현금 이전이면 입고 일자·금액이 필요하다, 실물 이전이면 필요 없다", () => {
    expect(checkTransferEvidence({ ...full, cashReceived: null }).missing).toContain("새 증권사 입고 일자·금액");
    expect(checkTransferEvidence({ ...full, mode: "in_kind_transfer", cashReceived: null }).sufficient).toBe(true);
  });
  it("입고 일자 형식이 틀리면 거부한다", () => {
    expect(checkTransferEvidence({ ...full, cashReceived: { date: "14/10/2026", amount: 1, basis: "user_confirmed" } }).missing)
      .toContain("입고 일자·금액 형식");
  });
});

describe("모듈 불변식 (소스)", () => {
  const src = readFileSync(fileURLToPath(new URL("./account-transfer-model.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("cashflow 장부 · 저장소 · 네트워크를 건드리지 않는다", () => {
    expect(code).not.toMatch(/addCashflow|CashflowEntry|from "\.\/cashflow"|supabase|fetch\(|localStorage/);
  });
});
