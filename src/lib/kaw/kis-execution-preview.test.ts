/**
 * 한국투자 체결 → 원장 미리보기. 어떤 거래도 원장에 추가하지 않는다.
 *
 * 지키는 것:
 *   1. 신규 / 일치 / 중복 가능성 / 계좌 귀속 충돌 / 체결 없는 주문 / 확인 불가 가 구분된다
 *   2. 승인 가능한 상태는 `new` 뿐이다
 *   3. 체결수량 0 행(정정 원주문 등)은 어떤 경우에도 후보가 되지 않는다
 *   4. 레지스트리가 없거나 활성 기간 밖이면 귀속하지 않는다 (fail closed)
 *   5. 입력(원장 · 레지스트리)을 변형하지 않는다
 *   6. 후보는 수수료 · 세금을 0 으로 채우지 않는다(null)
 */
import { describe, it, expect } from "vitest";
import {
  KIS_LEDGER_SOURCE,
  PREVIEW_STATUS_LABEL,
  kisExecutionFingerprint,
  previewKisExecutions,
  resolveKisInstanceOn,
  totalsOfPreview,
  type PreviewEntry,
} from "./kis-execution-preview";
import { classifyCcldRow, readCcldRow } from "./kis-ccld-history";
import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";

const raw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", sll_buy_dvsn_cd: "02", pdno: "360750",
  prdt_name: "TIGER 미국S&P500", ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230",
  avg_prvs: "25985", cncl_yn: "N", tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const parsed = (over: Record<string, unknown>) => classifyCcldRow(readCcldRow(raw(over)));

const TIGER = parsed({ odno: "0000006700" });
const ACE = parsed({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", ord_unpr: "31220", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080", ord_tmd: "133615" });
const ZERO = parsed({ odno: "0000000700", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0", rmn_qty: "0", ord_tmd: "133510" });

const MIRAE: BrokerAccountInstance = {
  id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "other", logicalAccountType: "pension",
  activeFrom: "2025-01-01", activeTo: "2026-10-14", connectionMode: "calc_only",
};
const KIS: BrokerAccountInstance = {
  id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly",
};
const REGISTRY = [MIRAE, KIS];

const tx = (over: Partial<LedgerTransaction>): LedgerTransaction => ({
  id: "t1", accountId: "pension", ticker: "360750", etfName: "TIGER 미국S&P500", side: "buy", quantity: 10, price: 25000,
  amount: 250000, tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-weekday-inference", fee: 9, tax: 0, postQuantity: null, source: "miraeasset_transaction_history", ...over,
});

const base = { registry: REGISTRY, accountType: "pension" as const, productCode: "22" };

describe("신규 체결", () => {
  it("실증된 10-14 응답: 체결 2건은 신규, 체결 0 은 체결 없는 주문", () => {
    const e = previewKisExecutions({ ...base, rows: [ZERO, ACE, TIGER], ledger: [] });
    expect(e.map((x) => x.status)).toEqual(["no_execution", "new", "new"]);
    const t = totalsOfPreview(e);
    expect(t.byStatus).toEqual({ new: 2, matches: 0, possible_duplicate: 0, attribution_conflict: 0, no_execution: 1, unverifiable: 0 });
    expect(t.newBuyAmount).toBe(7_974_630);
    expect(t.newBuyQty).toBe(294);
  });

  it("후보는 주문 단위 집계이고 증거 등급이 broker-order-date 다. 수수료·세금은 null 이다", () => {
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger: [] });
    const c = e.candidate!;
    expect(c).toMatchObject({
      accountId: "pension", accountInstanceId: KIS.id, source: KIS_LEDGER_SOURCE, ticker: "360750", side: "buy",
      quantity: 230, price: 25985, amount: 5976550, tradeDate: "2026-10-14", eventDate: "2026-10-14",
      tradeDateEvidence: "broker-order-date", fee: null, tax: null, postQuantity: null,
      settlementDate: null, inferredTradeDate: null, granularity: "order", fingerprintVersion: 2,
    });
    expect(c.sourceFingerprint).toBe(kisExecutionFingerprint(KIS.id, "20261014", "0000006700"));
  });

  it("승인 가능한 상태는 new 뿐이다", () => {
    const e = previewKisExecutions({ ...base, rows: [ZERO, ACE, TIGER], ledger: [] });
    expect(e.filter((x) => x.approvable).every((x) => x.status === "new")).toBe(true);
    expect(e.find((x) => x.status === "no_execution")!.approvable).toBe(false);
    expect(e.find((x) => x.status === "no_execution")!.candidate).toBeUndefined();
  });

  it("한국어 라벨이 모든 상태에 있다", () => {
    expect(Object.keys(PREVIEW_STATUS_LABEL).sort()).toEqual(
      ["attribution_conflict", "matches", "new", "no_execution", "possible_duplicate", "unverifiable"],
    );
  });
});

describe("체결 없는 주문", () => {
  it("체결 0 · 잔여 0 은 정정 원주문 가능성 주의를 붙인다 (확정하지 않는다)", () => {
    const [e] = previewKisExecutions({ ...base, rows: [ZERO], ledger: [] });
    expect(e.status).toBe("no_execution");
    expect(e.reason).toBe("zero_fill_closed_possible_modification");
    expect(e.notes.join(" ")).toContain("확정 아님");
  });
  it("미체결 · 취소 · 거부도 후보가 아니다", () => {
    const open = parsed({ odno: "9", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0", rmn_qty: "230" });
    const cancel = parsed({ odno: "8", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0", cncl_yn: "Y" });
    const reject = parsed({ odno: "7", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0", rjct_qty: "230" });
    const e = previewKisExecutions({ ...base, rows: [open, cancel, reject], ledger: [] });
    expect(e.map((x) => x.reason)).toEqual(["zero_fill_open", "cancelled_without_fill", "rejected"]);
    expect(e.every((x) => x.status === "no_execution" && !x.candidate)).toBe(true);
  });
  it("체결수량 0 이면 금액 필드에 값이 있어도 신규가 아니다", () => {
    const weird = parsed({ odno: "6", tot_ccld_qty: "0", avg_prvs: "25985", tot_ccld_amt: "5976550", rmn_qty: "0" });
    const [e] = previewKisExecutions({ ...base, rows: [weird], ledger: [] });
    expect(e.status).toBe("no_execution");
  });
});

describe("부분체결", () => {
  it("체결된 수량만 후보이고 주의가 붙는다", () => {
    const part = parsed({ odno: "5", ord_qty: "100", tot_ccld_qty: "40", rmn_qty: "60", avg_prvs: "1000", tot_ccld_amt: "40000", ord_unpr: "1000" });
    const [e] = previewKisExecutions({ ...base, rows: [part], ledger: [] });
    expect(e.status).toBe("new");
    expect(e.candidate!.quantity).toBe(40);
    expect(e.candidate!.amount).toBe(40000);
    expect(e.notes.join(" ")).toContain("체결된 수량만");
  });
});

describe("계좌 귀속 충돌", () => {
  it("한국투자 시작일(10-14) 이전 날짜의 체결은 충돌이다", () => {
    const early = parsed({ odno: "4", ord_dt: "20261013" });
    const [e] = previewKisExecutions({ ...base, rows: [early], ledger: [] });
    expect(e.status).toBe("attribution_conflict");
    expect(e.reason).toBe("active_instance_not_kis");   // 그 날은 미래에셋이 활성이다
    expect(e.approvable).toBe(false);
  });
  it("레지스트리가 비어 있으면 귀속하지 않는다", () => {
    const [e] = previewKisExecutions({ ...base, registry: [], rows: [TIGER], ledger: [] });
    expect(e.status).toBe("attribution_conflict");
    expect(e.reason).toBe("no_registry");
  });
  it("활성 계좌가 없는 날짜는 충돌이다", () => {
    const closed = { ...KIS, activeTo: "2026-10-15" };
    const late = parsed({ odno: "3", ord_dt: "20261016" });
    const [e] = previewKisExecutions({ ...base, registry: [MIRAE, closed], rows: [late], ledger: [] });
    expect(e.reason).toBe("no_active_kis_instance_on_date");
  });
  it("같은 날 활성 계좌가 둘이면 추측하지 않는다", () => {
    const dup = { ...MIRAE, activeTo: undefined } as BrokerAccountInstance;
    const [e] = previewKisExecutions({ ...base, registry: [dup, KIS], rows: [TIGER], ledger: [] });
    expect(e.reason).toBe("ambiguous_instance");
  });
  it("상품코드가 다른 한국투자 계좌(IRP 29)는 연금저축에 귀속되지 않는다", () => {
    const irp: BrokerAccountInstance = { ...KIS, id: "bai:kis-irp", logicalAccountType: "irp", productCode: "29" };
    expect(resolveKisInstanceOn([MIRAE, irp], "pension", "22", "2026-10-14").kind).toBe("none");
  });
  it("시작일을 정정해 10-13 로 당기면 귀속이 풀린다 (등록 기간이 근거다)", () => {
    const early = parsed({ odno: "4", ord_dt: "20261013" });
    const reg = [{ ...MIRAE, activeTo: "2026-10-13" }, { ...KIS, activeFrom: "2026-10-13" }];
    const [e] = previewKisExecutions({ ...base, registry: reg, rows: [early], ledger: [] });
    expect(e.status).toBe("new");
  });
});

describe("기존 원장과 대조", () => {
  it("같은 출처 · 같은 주문번호 · 같은 값 = 일치", () => {
    const fp = kisExecutionFingerprint(KIS.id, "20261014", "0000006700");
    const ledger = [tx({ id: "k1", source: KIS_LEDGER_SOURCE, sourceFingerprint: fp, ticker: "360750", side: "buy", quantity: 230, amount: 5976550, eventDate: "2026-10-14" })];
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger });
    expect(e.status).toBe("matches");
    expect(e.ledgerRef).toBe("k1");
    expect(e.approvable).toBe(false);
    expect(e.candidate).toBeUndefined();
  });
  it("같은 주문번호인데 값이 다르면 중복 가능성(주문이 더 체결됐거나 정정됐을 수 있다)", () => {
    const fp = kisExecutionFingerprint(KIS.id, "20261014", "0000006700");
    const ledger = [tx({ id: "k1", source: KIS_LEDGER_SOURCE, sourceFingerprint: fp, ticker: "360750", quantity: 200, amount: 5197000, eventDate: "2026-10-14" })];
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger });
    expect(e.status).toBe("possible_duplicate");
    expect(e.reason).toBe("same_order_different_values");
  });
  it("다른 출처(미래에셋)에 같은 날 같은 종목·방향·수량이 있으면 중복 가능성", () => {
    const ledger = [tx({ id: "m1", ticker: "360750", side: "buy", quantity: 230, amount: 5976550, eventDate: "2026-10-14" })];
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger });
    expect(e.status).toBe("possible_duplicate");
    expect(e.reason).toBe("other_source_same_trade");
    expect(e.ledgerRef).toBe("m1");
  });
  it("날짜가 다르면 중복으로 보지 않는다 (기본 허용 오차 0일)", () => {
    const ledger = [tx({ id: "m1", ticker: "360750", side: "buy", quantity: 230, eventDate: "2026-10-02" })];
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger });
    expect(e.status).toBe("new");
  });
  it("다른 논리계좌의 원장은 비교 대상이 아니다", () => {
    const ledger = [tx({ id: "x", accountId: "irp", ticker: "360750", side: "buy", quantity: 230, eventDate: "2026-10-14" })];
    const [e] = previewKisExecutions({ ...base, rows: [TIGER], ledger });
    expect(e.status).toBe("new");
  });
  it("같은 주문을 두 번 미리보기해도 결과가 같다 (멱등)", () => {
    const a = previewKisExecutions({ ...base, rows: [ZERO, ACE, TIGER], ledger: [] });
    const b = previewKisExecutions({ ...base, rows: [ZERO, ACE, TIGER], ledger: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("확인 불가", () => {
  it("필드를 읽지 못한 행", () => {
    const bad = parsed({ odno: "" });
    const [e] = previewKisExecutions({ ...base, rows: [bad], ledger: [] });
    expect(e.status).toBe("unverifiable");
    expect(e.reason).toBe("unreadable_fields");
  });
  it("응답 안에서 주문일+주문번호가 겹치면 둘 다 확인 불가", () => {
    const a = parsed({ odno: "11" });
    const b = parsed({ odno: "11", tot_ccld_qty: "100", ord_qty: "100", tot_ccld_amt: "2598500" });
    const e = previewKisExecutions({ ...base, rows: [a, b], ledger: [] });
    expect(e.every((x) => x.status === "unverifiable" && x.reason === "duplicate_order_number_in_response")).toBe(true);
  });
  it("같은 주문번호라도 주문일이 다르면 서로 다른 주문이다", () => {
    const a = parsed({ odno: "12", ord_dt: "20261014" });
    const b = parsed({ odno: "12", ord_dt: "20261015" });
    const e = previewKisExecutions({ ...base, rows: [a, b], ledger: [] });
    expect(e.every((x) => x.reason !== "duplicate_order_number_in_response")).toBe(true);
  });
  it("수량 × 평균가 와 체결금액이 크게 어긋나면 값을 믿지 않는다", () => {
    const bad = parsed({ odno: "13", tot_ccld_amt: "5000000" });
    const [e] = previewKisExecutions({ ...base, rows: [bad], ledger: [] });
    expect(e.status).toBe("unverifiable");
    expect(e.reason).toBe("amount_mismatch");
  });
});

describe("원장에 쓰지 않는다", () => {
  it("입력을 얼려 두어도 throw 하지 않는다 (변형 시도 없음)", () => {
    const deepFreeze = <T,>(o: T): T => {
      if (o && typeof o === "object") { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
      return o;
    };
    const ledger = deepFreeze([tx({ id: "m1", eventDate: "2026-10-02" })]);
    const registry = deepFreeze([{ ...MIRAE }, { ...KIS }]);
    const rows = deepFreeze([ZERO, ACE, TIGER].map((r) => structuredClone(r)));
    expect(() => previewKisExecutions({ ...base, registry, ledger, rows })).not.toThrow();
  });
  it("미리보기 결과 어디에도 cashflow 가 없다", () => {
    const e: PreviewEntry[] = previewKisExecutions({ ...base, rows: [ZERO, ACE, TIGER], ledger: [] });
    expect(JSON.stringify(e)).not.toMatch(/cashflow|deposit|withdrawal/i);
  });
});
