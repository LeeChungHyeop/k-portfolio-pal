/**
 * 회귀: 한국투자는 취소되지 않은 정상 행의 `cncl_yn` 을 "N" 이 아니라 **빈 문자열("")** 로 준다
 * (2026-10-19 실제 응답, 연금저축 22 · 2026-10-14 주문 3건 — 체결 완료 행도 "").
 *
 * 예전에는 `cancelled !== null` 을 필수조건으로 요구해서 3건이 전부 unreadable(확인 불가)이 되었고,
 * 화면이 "신규 체결 0건 · 체결 매수 0주 0원 · 체결 없는 주문 3건"으로 보였다. 실제로는
 * 주문 3건 중 체결 2건(TIGER 230주 + ACE 64주 = 294주, 7,974,630원)이다.
 *
 * 지키는 것:
 *   1. 취소 여부가 비어 있어도 체결수량·평균가·체결금액이 유효하면 체결로 인정한다
 *   2. 다른 필수 정보 누락·금액 불일치는 계속 차단한다 (취소 여부만 필수에서 빠졌다)
 *   3. 체결 0주 행은 "취소 아님"으로 추정하지 않고 매수 실적에서 제외한다
 *   4. 읽지 못한 행은 '체결 0주'가 아니라 별도로 센다
 */
import { describe, it, expect } from "vitest";
import { classifyCcldRow, parseCcldResponse, readCcldRow } from "./kis-ccld-history";
import { composeExecutionPreview, type ComposeInput } from "./kis-execution-compose";
import type { BrokerAccountInstance } from "./broker-account";

// 실제 응답 모양: cncl_yn 은 키가 있고 값은 "" 다. 주문번호는 가짜 값이다.
const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", ord_gno_brno: "00000", odno: "0000000001", orgn_odno: "", ord_dvsn_name: "지정가",
  sll_buy_dvsn_cd: "02", pdno: "360750", prdt_name: "TIGER 미국S&P500",
  ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985",
  cncl_yn: "", cncl_cfrm_qty: "0", tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const c = (over: Record<string, unknown>) => classifyCcldRow(readCcldRow(rowRaw(over)));

/** 실제 사례: 0주(정정 전 원주문) 1건 + ACE 64주 + TIGER 230주(원주문번호를 가리킴) */
const OUT1 = [
  rowRaw({ odno: "0000000700", ord_tmd: "133510", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", ord_unpr: "31220", ord_tmd: "133615", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080" }),
  rowRaw({ odno: "0000006700", orgn_odno: "0000000700" }),
];
const SUMMARY = { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.59", prsm_tlex_smtl: "0" };

describe("취소 여부(cncl_yn)가 빈 문자열인 실제 응답", () => {
  it("체결 완료 행은 filled 이고 취소 여부는 미보고(null)다 — 취소 아님으로 단정하지 않는다", () => {
    const r = c({});
    expect(r.row.cancelled).toBeNull();
    expect(r.kind).toBe("filled");
    expect(r.hasExecution).toBe(true);
    expect(r.amountMismatch).toBe(0);
  });

  it("'Y' 는 취소, 'N' 은 취소 아님으로 그대로 읽는다", () => {
    expect(readCcldRow(rowRaw({ cncl_yn: "Y" })).cancelled).toBe(true);
    expect(readCcldRow(rowRaw({ cncl_yn: "N" })).cancelled).toBe(false);
    expect(readCcldRow(rowRaw({ cncl_yn: "?" })).cancelled).toBeNull();
    const { cncl_yn: _drop, ...noKey } = rowRaw({});
    expect(readCcldRow(noKey).cancelled).toBeNull(); // 키 자체가 없어도 같다
  });

  it("실제 사례: 주문 3건 → 체결 2건 + 0주 1건, 합계 294주 · 7,974,630원", () => {
    const page = parseCcldResponse(200, { rt_cd: "0", output1: OUT1, output2: SUMMARY, ctx_area_fk100: "", ctx_area_nk100: "" }, "E");
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((p) => p.kind)).toEqual(["no_fill_closed", "filled", "filled"]);
    expect(page.rows.some((p) => p.kind === "unreadable")).toBe(false);
    const executed = page.rows.filter((p) => p.hasExecution);
    expect(executed).toHaveLength(2);
    expect(executed.reduce((s, p) => s + (p.row.filledQty as number), 0)).toBe(294);
    expect(executed.reduce((s, p) => s + (p.row.filledAmount as number), 0)).toBe(7_974_630);
  });

  it("체결 0주 행은 취소 여부가 비어 있어도 체결이 아니며, 취소 아님으로 추정하지 않는다", () => {
    const r = c({ tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" });
    expect(r.hasExecution).toBe(false);
    expect(r.kind).toBe("no_fill_closed");
    expect(r.row.cancelled).toBeNull();
  });

  it("잔여가 남은 부분체결은 취소 미보고여도 체결분만 인정하고, 주문이 닫혔다고 단정하지 않는다", () => {
    const r = c({ ord_qty: "300", tot_ccld_qty: "230", rmn_qty: "70" });
    expect(r.hasExecution).toBe(true);
    expect(r.kind).toBe("partially_filled_open");
    expect(c({ ord_qty: "300", tot_ccld_qty: "230", rmn_qty: "70", cncl_yn: "Y" }).kind).toBe("partially_filled_closed");
  });
});

describe("취소 여부만 필수에서 빠졌다 — 다른 필수 정보 누락은 계속 차단", () => {
  it.each([
    ["주문번호", { odno: "" }],
    ["종목코드", { pdno: "12" }],
    ["주문일", { ord_dt: "2026-10-14" }],
    ["매수/매도 구분", { sll_buy_dvsn_cd: "99" }],
    ["주문수량", { ord_qty: "" }],
    ["체결수량", { tot_ccld_qty: "" }],
    ["잔여수량", { rmn_qty: "" }],
  ])("%s 를 못 읽으면 unreadable", (_name, over) => {
    const r = c(over as Record<string, unknown>);
    expect(r.kind).toBe("unreadable");
    expect(r.hasExecution).toBe(false);
  });

  it("체결이 있는데 평균가 또는 체결금액을 못 읽으면 unreadable — 값을 추정하지 않는다", () => {
    expect(c({ avg_prvs: "" }).kind).toBe("unreadable");
    expect(c({ tot_ccld_amt: "" }).kind).toBe("unreadable");
    expect(c({ avg_prvs: "0" }).kind).toBe("unreadable");
  });

  it("수량 × 평균가 와 체결금액이 어긋나면 차이를 알리고 미리보기에서 확인 불가로 막는다", () => {
    const r = c({ tot_ccld_amt: "5976000" });
    expect(r.amountMismatch).toBe(550);
    const out = composeExecutionPreview(input([rowRaw({ tot_ccld_amt: "5976000" })]));
    expect(out.entries[0].status).toBe("unverifiable");
    expect(out.entries[0].reason).toBe("amount_mismatch");
  });
});

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const MIRAE: BrokerAccountInstance = { id: "bai:m", label: "미래에셋", broker: "other", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };
function input(output1: unknown[], summary: Record<string, unknown> | null = SUMMARY): ComposeInput {
  const page = parseCcldResponse(200, { rt_cd: "0", output1, output2: summary ?? undefined, ctx_area_fk100: "", ctx_area_nk100: "" }, "E");
  return {
    rows: page.rows, summaries: [page.summary],
    query: { start: "2026-10-13", end: "2026-10-16", windows: 1, pagesRead: 1, complete: true, unreadPages: false, listState: page.listState, duplicateOrderKeys: 0 },
    ledger: [], corrections: new Map(), registry: [MIRAE, KIS], flows: [{ date: "2025-11-10", amount: 10_500_000 }],
    accountType: "pension", productCode: "22", today: "2026-10-16",
  };
}

describe("미리보기 조립 — 실제 사례 재현", () => {
  const out = composeExecutionPreview(input(OUT1));

  it("체결 매수 294주 · 7,974,630원, 증권사 요약과 일치", () => {
    expect(out.totals.executed.rows).toBe(2);
    expect(out.totals.executed.buyQty).toBe(294);
    expect(out.totals.executed.buyAmount).toBe(7_974_630);
    expect(out.apiCrossCheck).toMatchObject({ matches: true, apiTotalFilledAmount: 7_974_630 });
  });

  it("신규 체결 2건 · 체결 없음 1건 · 확인 불가 0건", () => {
    expect(out.totals.byStatus).toMatchObject({ new: 2, no_execution: 1, unverifiable: 0 });
    expect(out.totals.zeroFillRows).toBe(1);
    expect(out.totals.unreadableRows).toBe(0);
  });

  it("0주 행은 취소 여부 미보고를 '취소 아님'으로 단정하지 않는 안내를 붙인다", () => {
    const zero = out.entries.find((e) => !e.row.hasExecution)!;
    expect(zero.reason).toBe("zero_fill_closed_possible_modification");
    expect(zero.notes.join(" ")).toContain("취소 여부를 알려주지 않았습니다");
    expect(zero.notes.join(" ")).not.toContain("취소 아님");
  });
});

describe("읽지 못한 행은 '체결 0주'가 아니라 확인 불가로 따로 센다", () => {
  const bad = [...OUT1, rowRaw({ odno: "0000009900", tot_ccld_qty: "" })];
  const out = composeExecutionPreview(input(bad));

  it("zeroFillRows 에는 안 들어가고 unreadableRows 로 센다", () => {
    expect(out.totals.zeroFillRows).toBe(1);
    expect(out.totals.unreadableRows).toBe(1);
    expect(out.totals.byStatus.unverifiable).toBe(1);
  });

  it("읽지 못한 필드 이름을 알려준다 (값은 싣지 않는다)", () => {
    const e = out.entries.find((x) => x.status === "unverifiable")!;
    expect(e.reason).toBe("unreadable_fields");
    expect(e.notes.join(" ")).toContain("체결수량");
  });

  it("합계는 읽지 못한 행을 더하지 않는다", () => {
    expect(out.totals.executed.buyAmount).toBe(7_974_630);
  });
});
