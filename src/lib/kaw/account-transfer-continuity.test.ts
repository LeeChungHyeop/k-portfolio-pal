/**
 * 계좌 이전 연속성 회귀 (Phase 4-C-1)
 *
 * 실제 사례의 모양: 외부 납입 10건 합계 10,500,000 → 미래에셋 보유 297주 + 81주 → 추정 전량 매도(2026-10-13)
 * → 한국투자 실제 매수 2건(2026-10-14, 294주, 7,974,630원) + 0주 주문 1건.
 *
 * 지키는 것:
 *   1. 누적 납입원금 10,500,000 은 이전 확정 · KIS 매수 후보와 무관하게 변하지 않는다 (계좌 내부 이전 ≠ 신규 납입)
 *   2. 이전 기준일(2026-10-13)까지의 유도 예수금 · 보유 시계열(= 과거 수익률의 입력)은 그대로다
 *   3. 이전 확정은 '이전 방식 미확인' 차단만 해제한다 — 원장 반영(phase_not_enabled)은 계속 닫혀 있다
 *   4. 체결 0주 주문은 이전이 확정돼도 원장 반영 후보가 아니다
 *   5. 추정 매도가 없으면(이탈 근거 없음) 가짜 수입 위험이 그대로 막힌다
 *   6. 상태 조립: 체크리스트와 canConfirm 은 증거에 따라서만 열린다
 */
import { describe, it, expect } from "vitest";
import { composeExecutionPreview, type ComposeInput } from "./kis-execution-compose";
import { parseCcldResponse } from "./kis-ccld-history";
import { buildDerivedCash } from "./derived-cash";
import { composeTransferState } from "./kis-transfer-compose";
import { validateTransferConfirm, type TransferRecord } from "./account-transfer-record";
import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";
import { replayFinalHoldings } from "./ledger";
import type { BalanceObservationSummary } from "./kis-balance-observation";

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const MIRAE: BrokerAccountInstance = { id: "bai:mirae", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const FLOWS = [
  { date: "2025-11-10", amount: 6_000_000 }, { date: "2026-01-26", amount: 500_000 }, { date: "2026-02-25", amount: 500_000 },
  { date: "2026-03-25", amount: 500_000 }, { date: "2026-04-27", amount: 500_000 }, { date: "2026-05-26", amount: 500_000 },
  { date: "2026-06-25", amount: 500_000 }, { date: "2026-07-27", amount: 500_000 }, { date: "2026-08-25", amount: 500_000 },
  { date: "2026-09-28", amount: 500_000 },
];
const PRINCIPAL = 10_500_000;

const tx = (id: string, over: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, accountId: "pension", ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, postQuantity: null,
  source: "miraeasset_capture_qty_price_reconstructed", importBatchId: "imp:v2", ...(over as object),
});
const PROXY = {
  source: "user_attested_liquidation_price_proxy", importBatchId: "imp:user_approved_pension_liquidation_20261018",
  inferredTradeDate: null, settlementDate: null, eventDate: "2026-10-13", fee: null, tax: null, postQuantity: 0,
  tradeDateEvidence: "user-attested-full-liquidation; exact-sale-date-unknown",
} as unknown as Partial<LedgerTransaction>;

const BUYS = [
  tx("b1"),
  tx("b2", { ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
];
const PROXY_SELLS = [
  tx("s1", { side: "sell", ...PROXY }),
  tx("s2", { side: "sell", ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...PROXY }),
];
const LEDGER_WITH_PROXY = [...BUYS, ...PROXY_SELLS];

// 실제 응답 모양: cncl_yn 은 빈 문자열
const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", sll_buy_dvsn_cd: "02", pdno: "360750", prdt_name: "TIGER 미국S&P500",
  ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985", cncl_yn: "",
  tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080" }),
  rowRaw({ odno: "0000006700", orgn_odno: "0000000700" }),
];
const SUMMARY = { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.59", prsm_tlex_smtl: "0" };

function preview(over: Partial<ComposeInput> = {}) {
  const page = parseCcldResponse(200, { rt_cd: "0", output1: OUT1, output2: SUMMARY, ctx_area_fk100: "", ctx_area_nk100: "" }, "E");
  return composeExecutionPreview({
    rows: page.rows, summaries: [page.summary],
    query: { start: "2026-10-14", end: "2026-10-19", windows: 1, pagesRead: 1, complete: true, unreadPages: false, listState: page.listState, duplicateOrderKeys: 0 },
    ledger: LEDGER_WITH_PROXY, corrections: new Map(), registry: [MIRAE, KIS], flows: FLOWS,
    accountType: "pension", productCode: "22", today: "2026-10-19", ...over,
  });
}
const blockerCodes = (p: ReturnType<typeof preview>) => p.approval.blockers.map((b) => b.code);

describe("원금 불변 — 계좌 내부 이전은 신규 납입이 아니다", () => {
  it("이전 확정 여부와 상관없이 원금은 10,500,000 이고 funding 계산도 같다", () => {
    const a = preview();
    const b = preview({ confirmedTransferInstanceIds: ["bai:kis"] });
    expect(a.impact.principal).toBe(PRINCIPAL);
    expect(b.impact.principal).toBe(PRINCIPAL);
    expect(a.impact.funding!.principalBefore).toBe(PRINCIPAL);
    expect(a.impact.funding!.principalAfter).toBe(PRINCIPAL);
    expect(b.impact.funding).toEqual(a.impact.funding);
  });

  it("이전 기록의 효과는 원금 변화 없음 · cashflow 없음으로 고정돼 있다", () => {
    const v = validateTransferConfirm(
      { toInstanceId: "bai:kis", fromInstanceId: "bai:mirae", anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], approved: true },
      { registry: [MIRAE, KIS], ledger: LEDGER_WITH_PROXY, existing: [], observation: { captureId: "c", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" }, today: "2026-10-19", actor: "hyeobi", nowIso: "2026-10-19T06:10:00.000Z" },
    );
    expect(v.ok && v.record.principalEffect).toBe("none");
    expect(v.ok && v.record.createsCashflow).toBe(false);
    // 기록은 계산 입력이 아니다: 원금은 오직 cashflow 장부의 합이다
    expect(FLOWS.reduce((s, f) => s + f.amount, 0)).toBe(PRINCIPAL);
  });
});

describe("과거 연속성 — 이전 기준일까지의 시계열은 그대로", () => {
  const td: string[] = [];
  for (let t = Date.parse("2025-11-03T00:00:00Z"); t <= Date.parse("2026-10-19T00:00:00Z"); t += 86_400_000) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) td.push(new Date(t).toISOString().slice(0, 10));
  }
  const trade = (t: LedgerTransaction) => ({ date: String(t.eventDate).slice(0, 10), side: t.side, amount: t.amount, fee: t.fee, tax: t.tax });
  const kisBuys = [{ date: "2026-10-14", side: "buy" as const, amount: 5_976_550, fee: null, tax: null }, { date: "2026-10-14", side: "buy" as const, amount: 1_998_080, fee: null, tax: null }];

  const before = buildDerivedCash({ flows: FLOWS, trades: LEDGER_WITH_PROXY.map(trade), tradingDates: td });
  const after = buildDerivedCash({ flows: FLOWS, trades: [...LEDGER_WITH_PROXY.map(trade), ...kisBuys], tradingDates: td });

  it("2026-10-13 이하의 일별 유도 예수금 · 미관측 수입 하한이 KIS 매수 추가 전후로 같다", () => {
    const upto = (s: typeof before) => s.dates.filter((d) => d <= "2026-10-13").map((d) => [d, s.byDate.get(d)]);
    expect(upto(after)).toEqual(upto(before));
  });

  it("이전 기준일에 보유는 0 이고 현금은 원금과 같다 (전량 매도 후 현금)", () => {
    expect(replayFinalHoldings(BUYS).pension).toEqual({ "360750": 297, "367380": 81 }); // 추정 매도 전
    expect(replayFinalHoldings(LEDGER_WITH_PROXY).pension ?? {}).toEqual({}); // 추정 매도 후: 0주는 생략된다
    expect(before.byDate.get("2026-10-13")!.derived).toBe(PRINCIPAL);
  });

  it("KIS 매수 반영 후 현금은 원금 − 매수 합계이고, 가짜 미관측 수입이 생기지 않는다", () => {
    expect(after.finalDerived).toBe(PRINCIPAL - 7_974_630);
    expect(after.totalIncomeLB).toBe(before.totalIncomeLB);
  });
});

describe("차단 사유 — 이전 확정은 '이전 방식 미확인'만 푼다", () => {
  it("확정 전: 이전 방식 미확인 + 원장 반영 미개방", () => {
    const codes = blockerCodes(preview());
    expect(codes).toContain("transfer_mode_unconfirmed");
    expect(codes).toContain("phase_not_enabled");
  });

  it("확정 후: transfer_mode_unconfirmed 만 사라지고 phase_not_enabled 는 남는다 (승인은 계속 닫혀 있다)", () => {
    const p = preview({ confirmedTransferInstanceIds: ["bai:kis"] });
    const codes = blockerCodes(p);
    expect(codes).not.toContain("transfer_mode_unconfirmed");
    expect(codes).toContain("phase_not_enabled");
    expect(p.approval.enabled).toBe(false);
    expect(p.entries.every((e) => e.approvable === false)).toBe(true);
  });

  it("다른 계좌 instance 의 확정은 효과가 없다", () => {
    expect(blockerCodes(preview({ confirmedTransferInstanceIds: ["bai:other"] }))).toContain("transfer_mode_unconfirmed");
  });
});

describe("체결 0주 · 확인 불가 — 이전이 확정돼도 반영 후보가 아니다", () => {
  const p = preview({ confirmedTransferInstanceIds: ["bai:kis"] });

  it("신규 체결 후보는 실제 체결 2건(294주)뿐이고 0주 주문은 제외된다", () => {
    expect(p.totals.byStatus.new).toBe(2);
    expect(p.totals.newBuyQty).toBe(294);
    expect(p.totals.newBuyAmount).toBe(7_974_630);
    const zero = p.entries.find((e) => !e.row.hasExecution)!;
    expect(zero.status).toBe("no_execution");
    expect(zero.futureCandidate).toBe(false);
    expect(p.totals.zeroFillRows).toBe(1);
    expect(p.totals.unreadableRows).toBe(0);
  });

  it("읽지 못한 행도 후보가 아니다", () => {
    const page = parseCcldResponse(200, { rt_cd: "0", output1: [...OUT1, rowRaw({ odno: "0000009900", tot_ccld_qty: "" })], output2: SUMMARY }, "E");
    const q = composeExecutionPreview({
      rows: page.rows, summaries: [page.summary],
      query: { start: "2026-10-14", end: "2026-10-19", windows: 1, pagesRead: 1, complete: true, unreadPages: false, listState: page.listState, duplicateOrderKeys: 0 },
      ledger: LEDGER_WITH_PROXY, corrections: new Map(), registry: [MIRAE, KIS], flows: FLOWS,
      confirmedTransferInstanceIds: ["bai:kis"], accountType: "pension", productCode: "22", today: "2026-10-19",
    });
    expect(q.totals.byStatus.new).toBe(2);
    expect(q.totals.unreadableRows).toBe(1);
    expect(q.entries.filter((e) => e.futureCandidate).length).toBe(2);
  });
});

describe("이탈 근거가 없으면 막힌다 (추정 매도 등록 전의 상태 재현)", () => {
  it("추정 매도가 없으면 이전 증권사 잔여 보유 + 자금 출처 근거 부족이 차단 사유로 남는다", () => {
    const p = preview({ ledger: BUYS, confirmedTransferInstanceIds: ["bai:kis"] });
    const codes = blockerCodes(p);
    expect(codes).toContain("prior_broker_residual");
    expect(codes).toContain("funding_evidence_missing");
    expect(p.impact.priorBrokerResidual).toEqual({ "360750": 297, "367380": 81 });
  });

  it("추정 매도가 있으면 둘 다 해소된다", () => {
    const codes = blockerCodes(preview({ confirmedTransferInstanceIds: ["bai:kis"] }));
    expect(codes).not.toContain("prior_broker_residual");
    expect(codes).not.toContain("funding_evidence_missing");
  });
});

describe("상태 조립", () => {
  const OBS: BalanceObservationSummary = {
    captureId: "cap:bai:kis:2026-10-19:abc", accountInstanceId: "bai:kis", broker: "kis", sourceType: "kis_inquire_balance",
    observedAt: "2026-10-19T06:00:00.000Z", stateAsOf: "2026-10-19", stateAsOfBasis: "observation_date",
    holdings: { "360750": 230, "367380": 64 }, holdingsCompleteness: "unknown", cash: 2_318_828, actor: "hyeobi",
  };
  const input = (over: Partial<Parameters<typeof composeTransferState>[0]> = {}) => ({
    registry: [MIRAE, KIS], ledger: LEDGER_WITH_PROXY, flows: FLOWS, records: [] as TransferRecord[], observation: OBS, today: "2026-10-19", ...over,
  });

  it("증거가 다 있으면 확정할 수 있다 · 원금과 유도 예수금을 돌려준다", () => {
    const s = composeTransferState(input());
    if (s.state !== "ok") throw new Error("no_target");
    expect(s.canConfirm).toBe(true);
    expect(s.ledger.principal).toBe(PRINCIPAL);
    expect(s.ledger.derivedCash).toBe(PRINCIPAL);
    expect(s.ledger.kisBuyAmountInLedger).toBe(0);
    expect(s.ledger.priorBrokerResidual).toEqual({});
    expect(s.exitCandidates.filter((e) => e.defaultSelected).map((e) => e.txId).sort()).toEqual(["s1", "s2"]);
  });

  it("관측이 없거나 이탈이 끝나지 않았으면 확정할 수 없다", () => {
    const a = composeTransferState(input({ observation: null }));
    const b = composeTransferState(input({ ledger: BUYS }));
    if (a.state !== "ok" || b.state !== "ok") throw new Error("no_target");
    expect(a.canConfirm).toBe(false);
    expect(b.canConfirm).toBe(false);
    expect(b.ledger.priorBrokerResidual).toEqual({ "360750": 297, "367380": 81 });
    expect(b.checklist.find((c) => c.id === "prior_exit_in_ledger")!.ok).toBe(false);
  });

  it("다른 계좌의 관측은 이 계좌의 관측으로 보지 않는다", () => {
    const s = composeTransferState(input({ observation: { ...OBS, accountInstanceId: "bai:other" } }));
    expect(s.state === "ok" && s.observation).toBeNull();
  });

  it("이미 확정돼 있으면 다시 확정할 수 없다", () => {
    const v = validateTransferConfirm(
      { toInstanceId: "bai:kis", fromInstanceId: "bai:mirae", anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], approved: true },
      { registry: [MIRAE, KIS], ledger: LEDGER_WITH_PROXY, existing: [], observation: { captureId: OBS.captureId, stateAsOf: OBS.stateAsOf, observedAt: OBS.observedAt }, today: "2026-10-19", actor: "hyeobi", nowIso: "x" },
    );
    if (!v.ok) throw new Error(v.message);
    const s = composeTransferState(input({ records: [v.record] }));
    expect(s.state === "ok" && s.canConfirm).toBe(false);
    expect(s.state === "ok" && s.checklist.find((c) => c.id === "transfer_confirmed")!.ok).toBe(true);
  });

  it("한국투자 계좌가 없으면 no_target", () => {
    expect(composeTransferState(input({ registry: [MIRAE] }))).toEqual({ state: "no_target" });
  });
});
