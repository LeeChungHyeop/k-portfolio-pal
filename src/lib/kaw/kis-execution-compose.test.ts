/**
 * 미리보기 응답 조립 — 계좌 이전 원칙 7가지와 승인 차단을 순수 함수 수준에서 고정한다.
 *
 *   1. 누적 납입원금을 바꾸지 않는다
 *   2. 이전 자금을 신규 외부 납입으로 만들지 않는다 (cashflow 없음)
 *   3. 이전 증권사의 가상 매도내역을 만들지 않는다
 *   4. 기존 평가금액을 매도대금으로 간주하지 않는다
 *   5. 한국투자 매수만 더해 기존 보유가 이중 계산되는 상황을 탐지·차단한다
 *   6. 자금 출처가 부족하면 미관측 수입으로 자동 보정하지 않고 경고한다
 *   7. 이전 거래 증거가 확인되기 전에는 반영을 허용하지 않는다 (이 단계에서는 항상 닫힘)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composeExecutionPreview, effectiveLedger, type ComposeInput } from "./kis-execution-compose";
import { parseCcldResponse } from "./kis-ccld-history";
import { priorBrokerResidual } from "./account-transfer-model";
import type { LedgerTransaction, TransactionCorrection } from "./ledger";
import type { BrokerAccountInstance } from "./broker-account";

const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", sll_buy_dvsn_cd: "02", pdno: "360750", prdt_name: "TIGER 미국S&P500",
  ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985", cncl_yn: "N",
  tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080" }),
  rowRaw({ odno: "0000006700" }),
];
const SUMMARY = { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.59", prsm_tlex_smtl: "0" };

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const MIRAE: BrokerAccountInstance = { id: "bai:m", label: "미래에셋", broker: "other", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const tx = (id: string, over: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, accountId: "pension", ticker: "360750", etfName: "TIGER", side: "buy", quantity: 297, price: 25000, amount: 7_425_000,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-weekday-inference", fee: 9, tax: 0, postQuantity: null, source: "miraeasset_transaction_history", ...over,
});
const LEDGER = [tx("m1"), tx("m2", { ticker: "367380", quantity: 81, price: 31660, amount: 2_564_460 })];
const FLOWS = [{ date: "2025-11-10", amount: 6_000_000 }, { date: "2026-01-26", amount: 4_500_000 }];

function input(over: Partial<ComposeInput> = {}, summary: Record<string, unknown> | null = SUMMARY, trCont = "E"): ComposeInput {
  const page = parseCcldResponse(200, { rt_cd: "0", output1: OUT1, output2: summary ?? undefined, ctx_area_fk100: "", ctx_area_nk100: "" }, trCont);
  return {
    rows: page.rows, summaries: [page.summary],
    query: { start: "2026-10-13", end: "2026-10-16", windows: 1, pagesRead: 1, complete: !page.hasMore, unreadPages: page.hasMore, listState: page.listState, duplicateOrderKeys: 0 },
    ledger: LEDGER, corrections: new Map(), registry: [MIRAE, KIS], flows: FLOWS,
    accountType: "pension", productCode: "22", today: "2026-10-16", ...over,
  };
}

describe("이전 원칙", () => {
  const r = composeExecutionPreview(input());

  it("1·2) 원금은 그대로이고 cashflow 를 만들지 않는다", () => {
    expect(r.impact.principal).toBe(10_500_000);
    expect(r.impact.funding!.principalBefore).toBe(10_500_000);
    expect(r.impact.funding!.principalAfter).toBe(10_500_000);
    expect(r.impact.funding!.createsCashflow).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/"(deposit|withdrawal|cashflow)/i);
  });

  it("3·4) 가상의 매도내역이 없고 평가금액을 매도대금으로 쓰지 않는다", () => {
    expect(r.entries.every((e) => e.row.side !== "sell")).toBe(true);
    expect(r.totals.executed.sellAmount).toBe(0);
    // 계산에 쓰인 후보는 한국투자 매수 두 건뿐이다 — 유도 예수금이 매수액만큼만 줄어든다
    const f = r.impact.funding!;
    expect(f.before.finalDerived - f.after.finalDerived).toBe(7_974_630);
  });

  it("5) 이전 증권사 원장 보유(297/81)가 남아 있음을 탐지하고 반영 후 재생 보유가 이중 계산됨을 보여준다", () => {
    expect(r.impact.priorBrokerResidual).toEqual({ "360750": 297, "367380": 81 });
    expect(r.impact.funding!.holdings!.replayAfter).toEqual({ "360750": 527, "367380": 145 });
    expect(r.approval.blockers.map((b) => b.code)).toContain("prior_broker_residual");
  });

  it("6) 자금 출처 부족은 가짜 미관측 수입 위험으로 경고한다 (자동 보정하지 않는다)", () => {
    const f = r.impact.funding!;
    expect(f.verdict).toBe("funding_evidence_missing");
    expect(f.phantomIncomeLB).toBeGreaterThan(7_000_000);
    expect(f.missingEvidence.join("\n")).toContain("이탈 근거");
    expect(r.approval.blockers.map((b) => b.code)).toContain("funding_evidence_missing");
  });

  it("7) 승인은 항상 닫혀 있고 이전 방식 미확인 사유가 있다", () => {
    expect(r.approval.enabled).toBe(false);
    expect(r.entries.every((e) => e.approvable === false)).toBe(true);
    const codes = r.approval.blockers.map((b) => b.code);
    expect(codes).toContain("phase_not_enabled");
    expect(codes).toContain("transfer_mode_unconfirmed");
  });
});

describe("합계 · 표시", () => {
  const r = composeExecutionPreview(input());
  it("체결 0주 주문은 합계에서 제외되고 별도 개수로 센다", () => {
    expect(r.totals.executed).toEqual({ rows: 2, buyQty: 294, buyAmount: 7_974_630, sellQty: 0, sellAmount: 0 });
    expect(r.totals.zeroFillRows).toBe(1);
    expect(r.totals.newBuyAmount).toBe(7_974_630);
  });
  it("조회 요약(output2)과 대조한다", () => {
    expect(r.apiCrossCheck).toEqual({ matches: true, apiTotalFilledAmount: 7_974_630, ourTotalFilledAmount: 7_974_630 });
    const bad = composeExecutionPreview(input({}, { ...SUMMARY, tot_ccld_amt: "9999999" }));
    expect(bad.apiCrossCheck!.matches).toBe(false);
  });
  it("끝까지 읽지 않았으면 대조하지 않고 불완전 사유를 낸다", () => {
    const p = composeExecutionPreview(input({}, SUMMARY, "M"));
    expect(p.apiCrossCheck).toBeNull();
    expect(p.query.complete).toBe(false);
    expect(p.approval.blockers.map((b) => b.code)).toContain("query_incomplete");
  });
  it("주문번호는 끝 4자리만 응답에 있다", () => {
    const s = JSON.stringify(r);
    for (const full of ["0000006700", "0000001700", "0000000700"]) expect(s).not.toContain(full);
    expect(r.entries.map((e) => e.row.orderNoTail).sort()).toEqual(["0700", "1700", "6700"]);
  });
  it("승인 후보가 될 수 있는 행은 신규 체결뿐이다", () => {
    expect(r.entries.filter((e) => e.futureCandidate).map((e) => e.status)).toEqual(["new", "new"]);
  });
});

describe("이전이 등록되지 않았으면 경고하지 않는다 (이전 전 보유는 정상이다)", () => {
  it("한국투자 계좌가 활성이 아니면 이탈 누락 · 이전 방식 사유가 없다", () => {
    const r = composeExecutionPreview(input({ registry: [{ ...KIS, activeFrom: "2026-12-01" }] }));
    expect(r.impact.newBrokerRegistered).toBe(false);
    expect(r.approval.blockers.map((b) => b.code)).not.toContain("prior_broker_residual");
    expect(r.approval.blockers.map((b) => b.code)).not.toContain("transfer_mode_unconfirmed");
  });
});

describe("원장 정정 overlay", () => {
  it("제외된 거래는 비교·재생에서 빠지고 원본은 변형되지 않는다", () => {
    const corr: TransactionCorrection = { transactionId: "m1", correctedQuantity: null, correctedPrice: null, correctedAmount: null, correctedTradeDate: null, correctedSide: null, correctedTicker: null, excluded: true, reason: null };
    const before = JSON.stringify(LEDGER);
    const eff = effectiveLedger(LEDGER, new Map([["m1", corr]]));
    expect(eff.map((t) => t.id)).toEqual(["m2"]);
    expect(JSON.stringify(LEDGER)).toBe(before);
    const r = composeExecutionPreview(input({ corrections: new Map([["m1", corr]]) }));
    expect(r.impact.priorBrokerResidual).toEqual({ "367380": 81 });
  });
  it("정정된 수량이 반영된다", () => {
    const corr: TransactionCorrection = { transactionId: "m1", correctedQuantity: 100, correctedPrice: null, correctedAmount: null, correctedTradeDate: null, correctedSide: null, correctedTicker: null, excluded: false, reason: null };
    expect(effectiveLedger(LEDGER, new Map([["m1", corr]]))[0].quantity).toBe(100);
  });
});

describe("후보가 없거나 데이터가 없을 때", () => {
  it("모두 일치하면 영향 계산을 하지 않고 '반영할 신규 체결 없음' 사유가 붙는다", () => {
    const matched = [
      ...LEDGER,
      tx("k1", { ticker: "367380", quantity: 64, amount: 1_998_080, eventDate: "2026-10-14", source: "kis_api_daily_ccld", sourceFingerprint: "v2|kis_api_daily_ccld|bai:kis|20261014|0000001700" }),
      tx("k2", { ticker: "360750", quantity: 230, amount: 5_976_550, eventDate: "2026-10-14", source: "kis_api_daily_ccld", sourceFingerprint: "v2|kis_api_daily_ccld|bai:kis|20261014|0000006700" }),
    ];
    const r = composeExecutionPreview(input({ ledger: matched }));
    expect(r.totals.byStatus.matches).toBe(2);
    expect(r.impact.funding).toBeNull();
    expect(r.approval.blockers.map((b) => b.code)).toContain("nothing_new");
  });
  it("장부(cashflow)가 없으면 원금은 '확인 불가'(null)이다 — 0 으로 채우지 않는다", () => {
    expect(composeExecutionPreview(input({ flows: [] })).impact.principal).toBeNull();
  });
});

describe("priorBrokerResidual", () => {
  it("새 증권사 출처 행을 빼고 재생하며 양수만 돌려준다", () => {
    const r = priorBrokerResidual([
      { ticker: "A", side: "buy", quantity: 10, source: "mirae" },
      { ticker: "A", side: "sell", quantity: 4, source: "mirae" },
      { ticker: "B", side: "buy", quantity: 5, source: "mirae" },
      { ticker: "B", side: "sell", quantity: 5, source: "mirae" },
      { ticker: "C", side: "sell", quantity: 3, source: "mirae" },
      { ticker: "A", side: "buy", quantity: 99, source: "kis_api_daily_ccld" },
    ], "kis_api_daily_ccld");
    expect(r).toEqual({ A: 6 });
  });
  it("이전 증권사 보유가 매도로 정리돼 있으면 비어 있다", () => {
    expect(priorBrokerResidual([
      { ticker: "A", side: "buy", quantity: 10, source: "mirae" }, { ticker: "A", side: "sell", quantity: 10, source: "mirae" },
    ], "kis_api_daily_ccld")).toEqual({});
  });
});

describe("소스 불변식", () => {
  const src = readFileSync(fileURLToPath(new URL("./kis-execution-compose.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("IO · 쓰기 · 합성 매도 생성이 없다", () => {
    expect(code).not.toMatch(/fetch\(|supabase|localStorage|console\.|\.insert\(|\.upsert\(/);
    expect(code).not.toMatch(/side:\s*"sell"\s*,\s*amount:\s*\d/);
  });
});
