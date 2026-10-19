/**
 * 계좌 이전 확정 기록 — 검증 규칙 (Phase 4-C-1)
 *
 * 지키는 것:
 *   1. 사용자의 명시적 승인(approved: true) 없이는 기록을 만들지 않는다
 *   2. 추정 매도는 추정으로 보존한다 — 실제 체결로 둔갑하지 않는다 (원장 행의 출처 · 날짜 근거 · 배치를 스냅샷)
 *   3. 이전은 원금도 cashflow 도 만들지 않는다
 *   4. 입고 일자를 모르면 null — 지어내지 않는다
 *   5. 이전 증권사 보유가 남아 있거나, 새 증권사 출처 행을 이탈 근거로 삼는 시도는 거부한다
 *   6. 잔고 관측 없이는 확정할 수 없다 · 같은 새 계좌를 두 번 확정할 수 없다
 */
import { describe, it, expect } from "vitest";
import {
  ESTIMATED_EXIT_SOURCES,
  NEW_BROKER_LEDGER_SOURCE,
  TRANSFER_AUDIT_ACTION,
  exitCandidatesOf,
  parseTransferRecords,
  validateTransferConfirm,
  type TransferConfirmInput,
  type TransferValidationContext,
} from "./account-transfer-record";
import { KIS_LEDGER_SOURCE } from "./kis-execution-preview";
import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const MIRAE: BrokerAccountInstance = { id: "bai:mirae", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const tx = (id: string, over: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, accountId: "pension", ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, postQuantity: null,
  source: "miraeasset_capture_qty_price_reconstructed", importBatchId: "imp:verified_dataset_v2", ...over,
});
const PROXY = {
  source: "user_attested_liquidation_price_proxy", importBatchId: "imp:user_approved_pension_liquidation_20261018",
  tradeDate: null, inferredTradeDate: null, settlementDate: null, eventDate: "2026-10-13", fee: null, tax: null, postQuantity: 0,
  tradeDateEvidence: "user-attested-full-liquidation; exact-sale-date-unknown; 2026-10-13=transfer-accounting-anchor; 2026-10-02-price-proxy",
} as unknown as Partial<LedgerTransaction>;

// 미래에셋 보유 297/81 + 추정 전량 매도 2건 (실제 사례의 모양)
const LEDGER: LedgerTransaction[] = [
  tx("b1"),
  tx("b2", { ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
  tx("s1", { side: "sell", ...PROXY }),
  tx("s2", { side: "sell", ticker: "367380", etfName: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...PROXY }),
];

const OBS = { captureId: "cap:bai:kis:2026-10-19:abc", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" };
const ctx = (over: Partial<TransferValidationContext> = {}): TransferValidationContext => ({
  registry: [MIRAE, KIS], ledger: LEDGER, existing: [], observation: OBS, today: "2026-10-19", actor: "hyeobi", nowIso: "2026-10-19T06:10:00.000Z", ...over,
});
const input = (over: Partial<TransferConfirmInput> = {}): TransferConfirmInput => ({
  toInstanceId: "bai:kis", fromInstanceId: "bai:mirae", anchorDate: "2026-10-13",
  cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], note: "사용자 확인", approved: true, ...over,
});

describe("확정 성공 — 기록의 내용", () => {
  const v = validateTransferConfirm(input(), ctx());
  if (!v.ok) throw new Error(v.message);
  const r = v.record;

  it("이전 증권사와 새 증권사 instance 를 기준일과 함께 연결한다", () => {
    expect(r.toInstanceId).toBe("bai:kis");
    expect(r.toBroker).toBe("kis");
    expect(r.toProductCode).toBe("22");
    expect(r.fromInstanceId).toBe("bai:mirae");
    expect(r.fromBroker).toBe("miraeasset");
    expect(r.anchorDate).toBe("2026-10-13");
    expect(r.kind).toBe("sold_then_cash_transfer");
  });

  it("추정 매도는 추정으로 보존된다 — 출처 · 날짜 근거 · 배치 · 수량 · 금액 스냅샷", () => {
    expect(r.containsEstimates).toBe(true);
    expect(r.exitEvidence).toHaveLength(2);
    for (const e of r.exitEvidence) {
      expect(e.basis).toBe("user_attested_estimate");
      expect(e.source).toBe("user_attested_liquidation_price_proxy");
      expect(e.importBatchId).toBe("imp:user_approved_pension_liquidation_20261018");
      expect(e.tradeDateEvidence).toContain("exact-sale-date-unknown");
      expect(e.side).toBe("sell");
    }
    expect(r.exitEvidence.map((e) => [e.ticker, e.quantity, e.amount])).toEqual([["360750", 297, 7_695_270], ["367380", 81, 2_564_460]]);
  });

  it("원금도 cashflow 도 만들지 않는다 (신규 납입 아님)", () => {
    expect(r.principalEffect).toBe("none");
    expect(r.createsCashflow).toBe(false);
    expect(Object.keys(r)).not.toContain("cashflow");
  });

  it("입고 일자를 모르면 null 로 남기고 지어내지 않는다", () => {
    expect(r.cashReceived).toEqual({ amount: 10_293_793, date: null, basis: "user_confirmed" });
  });

  it("관측 참조와 승인 이력(누가 · 언제 · 메모)을 남긴다", () => {
    expect(r.observation).toEqual(OBS);
    expect(r.approval).toEqual({ actor: "hyeobi", at: "2026-10-19T06:10:00.000Z", note: "사용자 확인" });
  });

  it("입고 일자를 알면 그 값을 쓴다", () => {
    const x = validateTransferConfirm(input({ cashReceived: { amount: 10_293_793, date: "2026-10-14" } }), ctx());
    expect(x.ok && x.record.cashReceived.date).toBe("2026-10-14");
  });

  it("이전 증권사가 레지스트리에 없으면 증권사/이름만 적는다 (instance id 는 null)", () => {
    const x = validateTransferConfirm(input({ fromInstanceId: null, fromBroker: "miraeasset", fromLabel: "미래에셋 연금저축" }), ctx({ registry: [KIS] }));
    expect(x.ok).toBe(true);
    if (x.ok) { expect(x.record.fromInstanceId).toBeNull(); expect(x.record.fromLabel).toBe("미래에셋 연금저축"); }
  });
});

describe("거부 — 아무것도 기록하지 않는다", () => {
  const code = (v: ReturnType<typeof validateTransferConfirm>) => (v.ok ? "ok" : v.code);

  it("승인이 true 가 아니면 거부한다 (문자열 'true' · 1 도 안 된다)", () => {
    for (const approved of [false, undefined, "true", 1, null]) {
      expect(code(validateTransferConfirm(input({ approved }), ctx()))).toBe("approval_required");
    }
  });

  it("새 계좌가 한국투자 연금저축이 아니거나 없으면 거부한다", () => {
    expect(code(validateTransferConfirm(input({ toInstanceId: "bai:none" }), ctx()))).toBe("target_instance_invalid");
    expect(code(validateTransferConfirm(input({ toInstanceId: "bai:mirae" }), ctx()))).toBe("target_instance_invalid");
    const irp: BrokerAccountInstance = { ...KIS, id: "bai:irp", productCode: "29", logicalAccountType: "irp" };
    expect(code(validateTransferConfirm(input({ toInstanceId: "bai:irp" }), ctx({ registry: [MIRAE, KIS, irp] })))).toBe("target_instance_invalid");
  });

  it("이전 증권사가 새 계좌와 같거나 다른 논리 계좌면 거부한다", () => {
    expect(code(validateTransferConfirm(input({ fromInstanceId: "bai:kis" }), ctx()))).toBe("source_instance_invalid");
    const isa: BrokerAccountInstance = { id: "bai:isa", label: "ISA", broker: "other", logicalAccountType: "isa", activeFrom: "2026-01-01" };
    expect(code(validateTransferConfirm(input({ fromInstanceId: "bai:isa" }), ctx({ registry: [MIRAE, KIS, isa] })))).toBe("source_instance_invalid");
  });

  it("직접 입력한 이름에 계좌번호 같은 긴 숫자열이 있으면 거부한다", () => {
    expect(code(validateTransferConfirm(input({ fromInstanceId: null, fromBroker: "미래에셋", fromLabel: "계좌 12345678901" }), ctx()))).toBe("source_instance_invalid");
    expect(code(validateTransferConfirm(input({ fromInstanceId: null, fromBroker: "", fromLabel: "x" }), ctx()))).toBe("source_instance_invalid");
  });

  it("기준일이 미래이거나 새 계좌 시작일 이후이거나 날짜가 아니면 거부한다", () => {
    expect(code(validateTransferConfirm(input({ anchorDate: "2026-10-20" }), ctx()))).toBe("anchor_invalid");
    expect(code(validateTransferConfirm(input({ anchorDate: "2026-10-15" }), ctx()))).toBe("anchor_invalid");
    expect(code(validateTransferConfirm(input({ anchorDate: "2026-02-30" }), ctx()))).toBe("anchor_invalid");
    expect(code(validateTransferConfirm(input({ anchorDate: "13/10/2026" }), ctx()))).toBe("anchor_invalid");
  });

  it("이전 금액이 정수 > 0 이 아니면 거부하고, 입고 일자가 잘못돼도 거부한다", () => {
    for (const amount of [0, -1, 1.5, NaN, "10293793" as unknown as number]) {
      expect(code(validateTransferConfirm(input({ cashReceived: { amount } }), ctx()))).toBe("cash_invalid");
    }
    expect(code(validateTransferConfirm(input({ cashReceived: null }), ctx()))).toBe("cash_invalid");
    expect(code(validateTransferConfirm(input({ cashReceived: { amount: 1, date: "2026-13-01" } }), ctx()))).toBe("cash_invalid");
    expect(code(validateTransferConfirm(input({ cashReceived: { amount: 1, date: "2026-10-20" } }), ctx()))).toBe("cash_invalid");
  });

  it("이탈 근거가 비었거나 없는 id · 매수 행 · 중복이면 거부한다", () => {
    expect(code(validateTransferConfirm(input({ exitTxIds: [] }), ctx()))).toBe("exit_rows_invalid");
    expect(code(validateTransferConfirm(input({ exitTxIds: ["nope"] }), ctx()))).toBe("exit_rows_invalid");
    expect(code(validateTransferConfirm(input({ exitTxIds: ["b1"] }), ctx()))).toBe("exit_rows_invalid");
    expect(code(validateTransferConfirm(input({ exitTxIds: ["s1", "s1"] }), ctx()))).toBe("exit_rows_invalid");
    expect(code(validateTransferConfirm(input({ exitTxIds: "s1" }), ctx()))).toBe("exit_rows_invalid");
  });

  it("새 증권사(한국투자) 출처 매도 행을 이전 증권사 이탈 근거로 삼을 수 없다", () => {
    const kisSell = tx("k1", { side: "sell", source: KIS_LEDGER_SOURCE, eventDate: "2026-10-13", quantity: 10, amount: 259_100 });
    expect(NEW_BROKER_LEDGER_SOURCE).toBe(KIS_LEDGER_SOURCE);
    expect(code(validateTransferConfirm(input({ exitTxIds: ["s1", "k1"] }), ctx({ ledger: [...LEDGER, kisSell] })))).toBe("exit_rows_invalid");
  });

  it("기준일 이후의 매도 행은 이탈 근거가 될 수 없다", () => {
    expect(code(validateTransferConfirm(input({ anchorDate: "2026-10-12" }), ctx()))).toBe("exit_rows_invalid");
  });

  it("이전 증권사 보유가 남아 있으면(일부만 이탈) 거부하고 남은 수량을 알려준다", () => {
    const v = validateTransferConfirm(input({ exitTxIds: ["s1"] }), ctx({ ledger: LEDGER.filter((t) => t.id !== "s2") }));
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.code).toBe("residual_remains"); expect(v.detail).toEqual({ "367380": 81 }); }
  });

  it("같은 새 계좌의 이전은 두 번 확정할 수 없다", () => {
    const first = validateTransferConfirm(input(), ctx());
    expect(first.ok).toBe(true);
    if (first.ok) expect(code(validateTransferConfirm(input(), ctx({ existing: [first.record] })))).toBe("already_confirmed");
  });

  it("잔고 관측이 없으면 확정할 수 없다 (증거 부족)", () => {
    const v = validateTransferConfirm(input(), ctx({ observation: null }));
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.code).toBe("evidence_missing"); expect(v.detail).toContain("이전 후 새 증권사 잔고 관측"); }
  });
});

describe("이탈 근거 후보 · 기록 파싱", () => {
  it("후보에서 추정 매도는 추정으로, 실제 체결은 증권사 체결로 구분한다", () => {
    const real = tx("r1", { side: "sell", eventDate: "2026-10-02", quantity: 5, amount: 129_550 });
    const c = exitCandidatesOf([...LEDGER, real], "2026-10-14");
    expect(c.find((e) => e.txId === "s1")?.basis).toBe("user_attested_estimate");
    expect(c.find((e) => e.txId === "r1")?.basis).toBe("broker_execution");
    expect(c.some((e) => e.txId === "b1")).toBe(false); // 매수는 후보가 아니다
    expect(ESTIMATED_EXIT_SOURCES).toContain("user_attested_liquidation_price_proxy");
  });

  it("너무 오래된 매도는 후보가 아니다", () => {
    const old = tx("o1", { side: "sell", eventDate: "2026-06-01" });
    expect(exitCandidatesOf([old], "2026-10-14").length).toBe(0);
  });

  it("audit 행에서 기록을 읽고, 모양이 어긋난 행은 버린다", () => {
    const v = validateTransferConfirm(input(), ctx());
    if (!v.ok) throw new Error("setup");
    const rows = [{ new_value: v.record }, { new_value: { version: 1 } }, { new_value: null }, {}, { new_value: { ...v.record, version: 99 } }];
    const parsed = parseTransferRecords(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].toInstanceId).toBe("bai:kis");
    expect(TRANSFER_AUDIT_ACTION).toBe("transfer_confirm");
  });
});
