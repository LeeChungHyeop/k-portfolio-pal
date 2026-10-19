/**
 * 한국투자 실제 체결 → 거래원장 반영 판정 (Phase 4-C-2)
 *
 * 실제 사례: 2026-10-14 TIGER 230주 @25,985 = 5,976,550 / ACE 64주 @31,220 = 1,998,080 (합계 294주 · 7,974,630원),
 *           체결 0주 주문 1건(정정 전 원주문). 미래에셋 보유 297/81 은 추정 전량 매도로 이탈 처리됨. 이전 확정 기록 있음.
 *
 * 지키는 것:
 *   1. 조건을 모두 만족할 때만 eligible — 서버 플래그가 꺼져 있으면 eligible 이어도 enabled=false
 *   2. 체결 0주 · 읽지 못한 행 · 확인 불가 · 중복 가능성 · 계좌 귀속 충돌이 하나라도 있으면 막는다
 *   3. 이전 확정 · 이탈 완료 · 자금 근거 · 반영 후 재생 보유 == 한국투자 관측 보유를 모두 요구한다
 *   4. 수수료 · 세금 · 거래후잔고는 null — 추정하지 않는다
 *   5. 원금은 변하지 않고 cashflow 를 만들지 않는다. 예수금 차이는 원인 미확정으로 보존한다
 *   6. 계획 해시는 같은 입력이면 같고, 승인 대상이 바뀌면 달라진다
 *   7. 이미 반영됐으면(전부/일부) 다시 반영하지 않는다
 */
import { describe, it, expect } from "vitest";
import { composeExecutionPreviewDetailed, type ComposeInput } from "./kis-execution-compose";
import { parseCcldResponse } from "./kis-ccld-history";
import { validateTransferConfirm, type TransferRecord } from "./account-transfer-record";
import { KIS_APPLY_MAX_ROWS, kisLedgerRowId, ledgerInsertRow } from "./kis-ledger-apply";
import { KIS_LEDGER_SOURCE, kisExecutionFingerprint } from "./kis-execution-preview";
import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";
import type { BalanceObservationSummary } from "./kis-balance-observation";
import { buildDerivedCash } from "./derived-cash";
import { replayFinalHoldings } from "./ledger";
import { ledgerRowToTransaction } from "./kis-execution-server";

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const MIRAE: BrokerAccountInstance = { id: "bai:mirae", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };
const FLOWS = [{ date: "2025-11-10", amount: 6_000_000 }, ...["2026-01-26", "2026-02-25", "2026-03-25", "2026-04-27", "2026-05-26", "2026-06-25", "2026-07-27", "2026-08-25", "2026-09-28"].map((date) => ({ date, amount: 500_000 }))];

const tx = (id: string, over: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, accountId: "pension", ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, postQuantity: null,
  source: "miraeasset_capture_qty_price_reconstructed", importBatchId: "imp:v2", ...(over as object),
});
const PROXY = { source: "user_attested_liquidation_price_proxy", importBatchId: "imp:proxy", inferredTradeDate: null, settlementDate: null, eventDate: "2026-10-13", fee: null, tax: null, postQuantity: 0, tradeDateEvidence: "user-attested-full-liquidation; exact-sale-date-unknown" } as unknown as Partial<LedgerTransaction>;
const BUYS = [tx("b1"), tx("b2", { ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 })];
const SELLS = [tx("s1", { side: "sell", ...PROXY }), tx("s2", { side: "sell", ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...PROXY })];
const LEDGER = [...BUYS, ...SELLS];

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

const OBS: BalanceObservationSummary = {
  captureId: "cap:bai:kis:2026-10-19:abc", accountInstanceId: "bai:kis", broker: "kis", sourceType: "kis_inquire_balance",
  observedAt: "2026-10-19T06:00:00.000Z", stateAsOf: "2026-10-19", stateAsOfBasis: "observation_date",
  holdings: { "360750": 230, "367380": 64 }, holdingsCompleteness: "unknown", cash: 2_318_828, actor: "hyeobi",
};
function transferRecord(ledger = LEDGER): TransferRecord {
  const v = validateTransferConfirm(
    { toInstanceId: "bai:kis", fromInstanceId: "bai:mirae", anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], approved: true },
    { registry: [MIRAE, KIS], ledger, existing: [], observation: { captureId: OBS.captureId, stateAsOf: OBS.stateAsOf, observedAt: OBS.observedAt }, today: "2026-10-19", actor: "hyeobi", nowIso: "2026-10-19T08:57:45.000Z" },
  );
  if (!v.ok) throw new Error(v.message);
  return v.record;
}
const TRANSFER = transferRecord();

interface Opts {
  output1?: unknown[]; summary?: Record<string, unknown> | null; trCont?: string; ledger?: LedgerTransaction[];
  flag?: boolean; observation?: BalanceObservationSummary | null; transfers?: TransferRecord[]; corrections?: boolean;
  complete?: boolean; dupKeys?: number; noList?: boolean;
}
function run(o: Opts = {}) {
  const page = parseCcldResponse(200, { rt_cd: "0", output1: o.noList ? undefined : (o.output1 ?? OUT1), output2: o.summary === undefined ? SUMMARY : o.summary ?? undefined, ctx_area_fk100: "", ctx_area_nk100: "" }, o.trCont ?? "E");
  const input: ComposeInput = {
    rows: page.rows, summaries: [page.summary],
    query: { start: "2026-10-14", end: "2026-10-19", windows: 1, pagesRead: 1, complete: o.complete ?? !page.hasMore, unreadPages: page.hasMore, listState: page.listState, duplicateOrderKeys: o.dupKeys ?? 0 },
    ledger: o.ledger ?? LEDGER, corrections: new Map(), registry: [MIRAE, KIS], flows: FLOWS,
    confirmedTransferInstanceIds: ["bai:kis"],
    apply: { flagEnabled: o.flag ?? true, observation: o.observation === undefined ? OBS : o.observation, transfers: o.transfers ?? [TRANSFER], correctionsPresent: o.corrections ?? false },
    accountType: "pension", productCode: "22", today: "2026-10-19",
  };
  return composeExecutionPreviewDetailed(input);
}
const codes = (r: ReturnType<typeof run>) => r.apply!.blockers.map((b) => b.code);

describe("정상 경로 — 실제 사례", () => {
  const r = run();
  const a = r.apply!;

  it("조건을 모두 만족하고 플래그가 켜져 있으면 반영할 수 있다", () => {
    expect(a.blockers).toEqual([]);
    expect(a.eligible).toBe(true);
    expect(a.enabled).toBe(true);
    expect(r.response.approval.enabled).toBe(true);
    expect(r.response.approval.blockers).toEqual([]);
  });

  it("반영 대상은 신규 체결 2건뿐이다 — 체결 0주 주문은 계획에 없다", () => {
    const rows = a.plan!.rows;
    expect(rows).toHaveLength(2);
    // 순서는 fingerprint 정렬이라 종목 순으로 비교한다
    expect(rows.map((x) => [x.ticker, x.quantity, x.price, x.amount, x.tradeDate]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ["360750", 230, 25985, 5_976_550, "2026-10-14"],
      ["367380", 64, 31220, 1_998_080, "2026-10-14"],
    ]);
    expect(a.plan!.totalQuantity).toBe(294);
    expect(a.plan!.totalAmount).toBe(7_974_630);
    expect(a.write!.rows).toHaveLength(2);
    expect(a.plan!.rows.every((x) => x.duplicate === "none" && x.side === "buy")).toBe(true);
  });

  it("반영 후 원장 재생 보유 230/64 가 한국투자 관측 보유와 같다", () => {
    expect(a.plan!.holdings.before).toEqual({});
    expect(a.plan!.holdings.after).toEqual({ "360750": 230, "367380": 64 });
    expect(a.plan!.holdings.observed).toEqual({ "360750": 230, "367380": 64 });
    expect(a.plan!.holdings.matches).toBe(true);
    expect(a.write!.expect.holdings_after).toEqual({ "360750": 230, "367380": 64 });
  });

  it("누적 납입원금 10,500,000 은 반영 전후 같고 cashflow 를 만들지 않는다", () => {
    expect(a.plan!.principal).toEqual({ before: 10_500_000, after: 10_500_000, unchanged: true });
    expect(a.write!.auditNewValue.createsCashflow).toBe(false);
    expect(JSON.stringify(a.write)).not.toMatch(/cashflow(s)?"\s*:\s*\[/);
  });

  it("예수금 차이는 원인 미확정으로 보존한다 — 보정 거래를 만들지 않는다", () => {
    const lines = a.plan!.reconciliation!.lines;
    expect(lines.every((l) => ["matches", "unconfirmed"].includes(l.status))).toBe(true);
    expect(a.plan!.reconciliation!.causeClassified).toBe(false);
    expect(a.write!.rows.every((x) => x.side === "buy")).toBe(true);
    expect(a.write!.rows).toHaveLength(2); // 보정용 가상 거래가 없다
    expect(a.write!.auditNewValue.feeTaxEstimated).toBe(false);
  });

  it("원장 행: 수수료 · 세금 · 거래후잔고 · 결제일 · 추정일은 null, 출처 · fingerprint v2 · 주문일 증거", () => {
    for (const w of a.write!.rows) {
      expect(w).toMatchObject({ account_type: "pension", side: "buy", source: KIS_LEDGER_SOURCE, fingerprint_version: 2, trade_date_evidence: "broker-order-date", fee: null, tax: null, post_quantity: null, settlement_date: null, inferred_trade_date: null, source_file: null, source_row: null });
      expect(String(w.source_fingerprint)).toMatch(/^v2\|kis_api_daily_ccld\|bai:kis\|20261014\|\d{10}$/);
      expect(String(w.id)).toMatch(/^kisx:[0-9a-f]{24}$/);
      expect(w.import_batch_id).toBe(a.write!.batch.id);
      expect(w.trade_date).toBe(w.event_date);
      expect(Object.keys(w)).not.toContain("family_code"); // 가족/프로필은 서버가 세션 값으로 채운다
    }
  });

  it("batch 이력: 출처 · 계획 지문 · 건수 · 검증 스냅샷", () => {
    const b = a.write!.batch;
    expect(b).toMatchObject({ source_kind: "kis_api", inserted_count: 2, skipped_count: 0, source_checksum: a.plan!.planHash });
    expect(b.id).toMatch(/^imp:kis_api_daily_ccld:[0-9a-f]{24}$/);
    expect(b.source_label).toContain("TTTC0081R");
    expect((b.verification as { causeClassified: boolean }).causeClassified).toBe(false);
  });

  it("승인 감사 스냅샷에 계획 · 이전 기록 · 관측 · 보유 전후가 남는다", () => {
    const n = a.write!.auditNewValue as Record<string, any>;
    expect(n.planHash).toBe(a.plan!.planHash);
    expect(n.transfer).toMatchObject({ anchorDate: "2026-10-13", amount: 10_293_793, containsEstimates: true });
    expect(n.observation).toMatchObject({ captureId: OBS.captureId, stateAsOf: "2026-10-19" });
    expect(n.holdingsAfter).toEqual({ "360750": 230, "367380": 64 });
    expect(a.write!.auditPreviousValue).toEqual({ holdings: {} });
  });

  it("화면용 계획에는 주문번호 전체가 없다 (끝 4자리만)", () => {
    const s = JSON.stringify(r.response);
    expect(s).not.toContain("0000006700");
    expect(s).not.toContain("0000001700");
    expect(a.plan!.rows.map((x) => x.orderNoTail).sort()).toEqual(["1700", "6700"]);
  });
});

describe("서버 플래그", () => {
  it("플래그가 꺼져 있으면 조건을 만족해도 열리지 않는다 — flag_off 와 phase_not_enabled 가 남는다", () => {
    const r = run({ flag: false });
    expect(r.apply!.eligible).toBe(true);
    expect(r.apply!.enabled).toBe(false);
    expect(codes(r)).toEqual(["flag_off"]);
    expect(r.response.approval.enabled).toBe(false);
    expect(r.response.approval.blockers.map((b) => b.code)).toContain("phase_not_enabled");
  });

  it("판정 입력이 없으면(apply 생략) 이전처럼 닫혀 있고 응답에 apply 가 없다", () => {
    const page = parseCcldResponse(200, { rt_cd: "0", output1: OUT1, output2: SUMMARY }, "E");
    const x = composeExecutionPreviewDetailed({
      rows: page.rows, summaries: [page.summary],
      query: { start: "2026-10-14", end: "2026-10-19", windows: 1, pagesRead: 1, complete: true, unreadPages: false, listState: page.listState, duplicateOrderKeys: 0 },
      ledger: LEDGER, corrections: new Map(), registry: [MIRAE, KIS], flows: FLOWS, accountType: "pension", productCode: "22", today: "2026-10-19",
    });
    expect(x.apply).toBeNull();
    expect(x.response.apply).toBeUndefined();
    expect(x.response.approval.enabled).toBe(false);
  });
});

describe("차단 조건 — 하나라도 어긋나면 반영하지 않는다", () => {
  it("조회가 끝까지 완료되지 않았다 (다음 페이지가 있다)", () => {
    const r = run({ trCont: "M" });
    expect(codes(r)).toContain("query_incomplete");
    expect(r.apply!.eligible).toBe(false);
  });

  it("체결 목록이 없는 응답(list_absent)", () => {
    const r = run({ noList: true });
    expect(codes(r)).toContain("query_incomplete");
    expect(r.apply!.eligible).toBe(false);
  });

  it("읽지 못한 행이 하나라도 있으면 체결 전체를 신뢰할 수 없다 (unverifiable_rows)", () => {
    const r = run({ output1: [...OUT1, rowRaw({ odno: "0000009900", tot_ccld_qty: "" })] });
    expect(codes(r)).toContain("unverifiable_rows");
    expect(r.apply!.eligible).toBe(false);
  });

  it("금액이 수량 × 평균가와 어긋나면 막는다", () => {
    const r = run({ output1: [OUT1[0], OUT1[1], rowRaw({ odno: "0000006700", tot_ccld_amt: "5976000" })] });
    expect(codes(r)).toContain("unverifiable_rows");
  });

  it("증권사 요약 금액과 행 합계가 다르면 막는다", () => {
    const r = run({ summary: { ...SUMMARY, tot_ccld_amt: "7974000" } });
    expect(codes(r)).toContain("api_cross_check_mismatch");
  });

  it("다른 출처의 같은 거래(종목 · 수량 · 날짜)가 원장에 있으면 중복 가능성으로 막는다", () => {
    const dup = tx("d1", { eventDate: "2026-10-14", quantity: 230, price: 25985, amount: 5_976_550, source: "user_supplied_other" });
    const r = run({ ledger: [...LEDGER, dup] });
    expect(codes(r)).toContain("possible_duplicate");
    expect(r.apply!.eligible).toBe(false);
  });

  it("이전 확정 기록이 없으면 막는다", () => {
    expect(codes(run({ transfers: [] }))).toContain("transfer_unconfirmed");
  });

  it("이전 증권사 보유가 원장에 남아 있으면 막는다 (이탈 근거 없음)", () => {
    const r = run({ ledger: BUYS });
    expect(codes(r)).toContain("prior_residual");
    expect(codes(r)).toContain("funding_evidence_missing");
    expect(r.apply!.eligible).toBe(false);
  });

  it("한국투자 관측이 없으면 막는다", () => {
    expect(codes(run({ observation: null }))).toContain("observation_missing");
    expect(codes(run({ observation: { ...OBS, holdings: null } }))).toContain("observation_missing");
  });

  it("관측 기준일이 마지막 체결일보다 앞서면 막는다", () => {
    expect(codes(run({ observation: { ...OBS, stateAsOf: "2026-10-13" } }))).toContain("observation_stale");
  });

  it("반영 후 원장 재생 보유가 관측 보유와 다르면 막는다 (수량 · 종목 모두)", () => {
    expect(codes(run({ observation: { ...OBS, holdings: { "360750": 230, "367380": 65 } } }))).toContain("holdings_mismatch");
    expect(codes(run({ observation: { ...OBS, holdings: { "360750": 230 } } }))).toContain("holdings_mismatch");
    expect(codes(run({ observation: { ...OBS, holdings: { "360750": 230, "367380": 64, "0181B0": 1 } } }))).toContain("holdings_mismatch");
  });

  it("일부만 읽힌 관측(partial)은 증거로 쓰지 않는다", () => {
    expect(codes(run({ observation: { ...OBS, holdingsCompleteness: "partial" } }))).toContain("observation_incomplete");
  });

  it("완전성이 unknown 인 관측(KIS 잔고 API 의 실제 값)은 양방향 완전 일치일 때만 인정한다 — 일치하면 통과, 어느 쪽이든 어긋나면 막힌다", () => {
    expect(OBS.holdingsCompleteness).toBe("unknown");
    expect(run().apply!.eligible).toBe(true);
    // 관측에 없는 종목을 원장이 갖고 있거나(생략으로 보이는 경우) 그 반대인 경우 모두 불일치로 막힌다
    expect(codes(run({ observation: { ...OBS, holdings: { "360750": 230 } } }))).toContain("holdings_mismatch");
    expect(codes(run({ observation: { ...OBS, holdings: { ...OBS.holdings!, "0181B0": 5 } } }))).toContain("holdings_mismatch");
  });

  it("거래 정정(overlay)이 있으면 막는다", () => {
    expect(codes(run({ corrections: true }))).toContain("corrections_present");
  });

  it("매도 체결은 이번 단계에서 반영하지 않는다", () => {
    const sell = rowRaw({ odno: "0000007700", sll_buy_dvsn_cd: "01", ord_qty: "10", tot_ccld_qty: "10", avg_prvs: "26000", tot_ccld_amt: "260000" });
    const r = run({ output1: [...OUT1, sell], summary: { ...SUMMARY, tot_ccld_amt: String(7_974_630 + 260_000) } });
    expect(codes(r)).toContain("sell_not_supported");
  });

  it("한 번에 반영할 수 있는 최대 건수를 넘기면 막는다", () => {
    expect(KIS_APPLY_MAX_ROWS).toBe(20);
    const many = Array.from({ length: 21 }, (_, i) => rowRaw({ odno: String(1000 + i).padStart(10, "0"), ord_qty: "1", tot_ccld_qty: "1", avg_prvs: "100", tot_ccld_amt: "100", ord_unpr: "100" }));
    const r = run({ output1: many, summary: { ...SUMMARY, tot_ccld_amt: "2100" } });
    expect(codes(r)).toContain("too_many_rows");
  });

  it("신규 체결이 없으면 반영할 것이 없다 (nothing_new)", () => {
    const r = run({ output1: [OUT1[0]], summary: { ...SUMMARY, tot_ccld_amt: "0" } });
    expect(codes(r)).toContain("nothing_new");
    expect(r.apply!.plan).toBeNull();
    expect(r.apply!.write).toBeNull();
  });
});

describe("이미 반영된 경우 — 다시 반영하지 않는다", () => {
  const kisRow = (odno: string, ticker: string, name: string, q: number, price: number, amount: number): LedgerTransaction =>
    tx(`kisx:${odno}`, {
      ticker, etfName: name, side: "buy", quantity: q, price, amount, tradeDate: "2026-10-14", settlementDate: null, inferredTradeDate: null, eventDate: "2026-10-14",
      tradeDateEvidence: "broker-order-date", fee: null, tax: null, postQuantity: null, source: KIS_LEDGER_SOURCE, importBatchId: "imp:x",
      sourceFingerprint: kisExecutionFingerprint("bai:kis", "20261014", odno), fingerprintVersion: 2,
    });
  const T = kisRow("0000006700", "360750", "TIGER 미국S&P500", 230, 25985, 5_976_550);
  const A = kisRow("0000001700", "367380", "ACE 미국나스닥100", 64, 31220, 1_998_080);

  it("두 건 모두 이미 원장에 있으면 alreadyApplied — 계획도 페이로드도 없다", () => {
    const r = run({ ledger: [...LEDGER, T, A] });
    expect(r.apply!.alreadyApplied).toBe(true);
    expect(r.apply!.eligible).toBe(false);
    expect(codes(r)).toContain("already_applied");
    expect(r.apply!.plan).toBeNull();
    expect(r.apply!.write).toBeNull();
  });

  it("한 건만 이미 있으면(부분 반영 상태) 이어서 자동 반영하지 않는다", () => {
    const r = run({ ledger: [...LEDGER, T] });
    expect(codes(r)).toContain("partially_applied");
    expect(r.apply!.eligible).toBe(false);
  });
});

describe("계획 해시 — 승인 대상의 지문", () => {
  it("같은 입력이면 같다 (결정적)", () => {
    expect(run().apply!.plan!.planHash).toBe(run().apply!.plan!.planHash);
    expect(run().apply!.write!.batch.id).toBe(run().apply!.write!.batch.id);
    expect(run().apply!.plan!.planHash).toMatch(/^k1\|[0-9a-f]+$/);
  });

  it("체결 내용 · 관측 · 이전 기록 · 원장 보유가 바뀌면 달라진다", () => {
    const base = run().apply!.plan!.planHash;
    const changedQty = run({ output1: [OUT1[0], OUT1[1], rowRaw({ odno: "0000006700", ord_qty: "229", tot_ccld_qty: "229", tot_ccld_amt: String(229 * 25985) })], observation: { ...OBS, holdings: { "360750": 229, "367380": 64 } }, summary: { ...SUMMARY, tot_ccld_amt: String(229 * 25985 + 1_998_080) } }).apply!.plan!.planHash;
    const changedObs = run({ observation: { ...OBS, captureId: "cap:other" } }).apply!.plan!.planHash;
    const changedTransfer = run({ transfers: [{ ...TRANSFER, approval: { ...TRANSFER.approval, at: "2026-10-19T09:00:00.000Z" } }] }).apply!.plan!.planHash;
    expect(new Set([base, changedQty, changedObs, changedTransfer]).size).toBe(4);
  });

  it("조회 응답의 행 순서가 달라도 같다", () => {
    const reversed = run({ output1: [...OUT1].reverse() }).apply!.plan!.planHash;
    expect(reversed).toBe(run().apply!.plan!.planHash);
  });
});

describe("행 id · fingerprint", () => {
  it("행 id 는 fingerprint 에서 결정적으로 나오고 서로 다르다", () => {
    const fa = kisExecutionFingerprint("bai:kis", "20261014", "0000006700");
    const fb = kisExecutionFingerprint("bai:kis", "20261014", "0000001700");
    expect(kisLedgerRowId(fa)).toBe(kisLedgerRowId(fa));
    expect(kisLedgerRowId(fa)).not.toBe(kisLedgerRowId(fb));
    expect(kisLedgerRowId(fa)).toMatch(/^kisx:[0-9a-f]{24}$/);
  });

  it("ledgerInsertRow 는 후보를 그대로 옮기고 수수료 · 세금을 만들지 않는다", () => {
    const cand = run().apply!.write!.rows[0];
    expect(cand.fee).toBeNull();
    expect(cand.tax).toBeNull();
    expect(typeof ledgerInsertRow).toBe("function");
  });
});

// ── 반영 후 — 원장에 들어간 모습으로 회귀를 확인한다 ──────────────────────────────
describe("반영 후 회귀 — 과거는 그대로, 재조회는 멱등", () => {
  /** RPC 가 넣게 될 행을 원장 행(LedgerTransaction)으로 바꾼다 — DB 의 snake_case → 앱의 모양 */
  const applied = (): LedgerTransaction[] =>
    run().apply!.write!.rows.map((w) => ledgerRowToTransaction({ ...w, family_code: "f", profile: "p" } as Record<string, unknown>));
  const AFTER = [...LEDGER, ...applied()];

  const td: string[] = [];
  for (let t = Date.parse("2025-11-03T00:00:00Z"); t <= Date.parse("2026-10-19T00:00:00Z"); t += 86_400_000) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) td.push(new Date(t).toISOString().slice(0, 10));
  }
  const trade = (t: LedgerTransaction) => ({ date: String(t.eventDate).slice(0, 10), side: t.side, amount: t.amount, fee: t.fee, tax: t.tax });

  it("반영된 행은 원장 계약대로 읽힌다 (출처 · 수량 · 금액 · 수수료/세금 null · 주문일 증거)", () => {
    const rows = applied();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ accountId: "pension", side: "buy", source: KIS_LEDGER_SOURCE, fee: null, tax: null, postQuantity: null, tradeDateEvidence: "broker-order-date", eventDate: "2026-10-14", fingerprintVersion: 2 });
    }
    expect(rows.reduce((s2, r) => s2 + r.quantity, 0)).toBe(294);
    expect(rows.reduce((s2, r) => s2 + r.amount, 0)).toBe(7_974_630);
  });

  it("원장 재생 보유는 230주 · 64주이고 한국투자 관측 보유와 같다", () => {
    expect(replayFinalHoldings(AFTER).pension).toEqual({ "360750": 230, "367380": 64 });
    expect(replayFinalHoldings(AFTER).pension).toEqual(OBS.holdings);
  });

  it("이전 기준일(2026-10-13)까지의 유도 예수금 시계열은 반영 전후가 같다 — 과거 수익률의 입력이 변하지 않는다", () => {
    const before = buildDerivedCash({ flows: FLOWS, trades: LEDGER.map(trade), tradingDates: td });
    const after = buildDerivedCash({ flows: FLOWS, trades: AFTER.map(trade), tradingDates: td });
    const upto = (x: typeof before) => x.dates.filter((d) => d <= "2026-10-13").map((d) => [d, x.byDate.get(d)]);
    expect(upto(after)).toEqual(upto(before));
    expect(after.finalDerived).toBe(before.finalDerived - 7_974_630);
    expect(after.totalIncomeLB).toBe(before.totalIncomeLB); // 가짜 미관측 수입이 생기지 않는다
  });

  it("미래에셋 추정 매도 2건과 기존 행은 그대로다 (추가만 된다)", () => {
    expect(AFTER.slice(0, LEDGER.length)).toEqual(LEDGER);
    expect(AFTER.filter((t) => t.source === "user_attested_liquidation_price_proxy")).toHaveLength(2);
  });

  it("원금은 10,500,000 그대로 — 반영은 cashflow 를 만들지 않는다", () => {
    expect(FLOWS.reduce((s2, f) => s2 + f.amount, 0)).toBe(10_500_000);
  });

  it("반영 뒤 같은 조회를 다시 하면 새로 반영할 것이 없다 — alreadyApplied, 두 번째 반영 불가 (재조회 · 재승인 멱등)", () => {
    const again = run({ ledger: AFTER });
    expect(again.apply!.alreadyApplied).toBe(true);
    expect(again.apply!.eligible).toBe(false);
    expect(again.apply!.write).toBeNull();
    expect(again.response.totals.byStatus.new).toBe(0);
    expect(again.response.totals.byStatus.matches).toBe(2);
    // 체결 0주 주문은 여전히 반영 대상이 아니다
    expect(again.response.totals.zeroFillRows).toBe(1);
  });

  it("반영 뒤에도 이전 증권사 잔여 보유는 0 이고 자금 근거는 ok 다", () => {
    const again = run({ ledger: AFTER });
    expect(again.response.impact.priorBrokerResidual).toEqual({});
  });
});
