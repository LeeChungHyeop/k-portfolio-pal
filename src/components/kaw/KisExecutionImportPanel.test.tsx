// @vitest-environment jsdom
// 한국투자 체결내역 가져오기 화면 — 실제 컴포넌트를 렌더링하고 클릭·입력으로 검증한다.
// 응답 데이터는 실증된 KIS 응답 구조(2026-10-16)를 parseCcldResponse → composeExecutionPreview 로 통과시킨 것이다.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KisExecutionImportPanel } from "./KisExecutionImportPanel";
import type { ExecRange, ExecRequestOutcome } from "@/lib/kaw/kis-execution-client";
import { composeExecutionPreview, type KisExecutionPreviewResponse } from "@/lib/kaw/kis-execution-compose";
import { parseCcldResponse } from "@/lib/kaw/kis-ccld-history";
import type { BrokerAccountInstance } from "@/lib/kaw/broker-account";
import type { LedgerTransaction } from "@/lib/kaw/ledger";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-16";
const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const CALC: BrokerAccountInstance = { ...KIS, connectionMode: "calc_only" };

const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", ord_dvsn_name: "지정가", sll_buy_dvsn_cd: "02", pdno: "360750",
  prdt_name: "TIGER 미국S&P500", ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985",
  cncl_yn: "N", tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", ord_tmd: "133510", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080", ord_tmd: "133615" }),
  rowRaw({ odno: "0000006700" }),
];
const bodyOf = (over: Record<string, unknown> = {}) => ({
  rt_cd: "0", msg_cd: "KIOK0510", msg1: "조회가 완료되었습니다", ctx_area_fk100: "", ctx_area_nk100: "", output1: OUT1,
  output2: { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.5918", prsm_tlex_smtl: "0" }, ...over,
});

const mirae = (id: string, ticker: string, qty: number, amount: number): LedgerTransaction => ({
  id, accountId: "pension", ticker, etfName: ticker, side: "buy", quantity: qty, price: Math.round(amount / qty), amount,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-weekday-inference", fee: 9, tax: 0, postQuantity: null, source: "miraeasset_transaction_history",
});

/** 실제 응답 구조 → 조립 → 화면용 응답 */
function okResponse(opts: { body?: Record<string, unknown>; trCont?: string; ledger?: LedgerTransaction[]; registry?: BrokerAccountInstance[] } = {}): KisExecutionPreviewResponse {
  const page = parseCcldResponse(200, bodyOf(opts.body), opts.trCont ?? "E");
  return composeExecutionPreview({
    rows: page.rows, summaries: [page.summary],
    query: {
      start: "2026-10-13", end: "2026-10-16", windows: 1, pagesRead: 1, complete: !page.hasMore, unreadPages: page.hasMore,
      listState: page.listState, duplicateOrderKeys: 0,
    },
    ledger: opts.ledger ?? [mirae("m1", "360750", 297, 7_425_000), mirae("m2", "367380", 81, 2_564_460)],
    corrections: new Map(), registry: opts.registry ?? [{ ...KIS }, { id: "bai:m", label: "미래에셋", broker: "other", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" }],
    flows: [{ date: "2025-11-10", amount: 6_000_000 }, { date: "2026-01-26", amount: 4_500_000 }],
    accountType: "pension", productCode: "22", today: TODAY,
  });
}
const resp = (data: KisExecutionPreviewResponse): ExecRequestOutcome => ({ kind: "response", data });

let root: Root; let host: HTMLDivElement;
async function mount(opts: { registry?: BrokerAccountInstance[]; request: (r: ExecRange) => Promise<ExecRequestOutcome> }) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(KisExecutionImportPanel, { registry: opts.registry ?? [KIS], today: TODAY, request: opts.request }));
  });
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
async function click(el: HTMLElement) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); }
async function typeInto(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const queryBtn = () => $("exec-query-button") as HTMLButtonElement;
const text = () => host.textContent ?? "";
async function runOk(request: (r: ExecRange) => Promise<ExecRequestOutcome>) { await mount({ request }); await click(queryBtn()); }

beforeEach(() => { document.body.innerHTML = ""; });

describe("초기 화면 — 자동 조회 없음", () => {
  it("마운트만으로는 요청하지 않고, 기간 기본값은 한국투자 시작일~오늘이다", async () => {
    const request = vi.fn(async () => resp(okResponse()));
    await mount({ request });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(request).not.toHaveBeenCalled();
    expect(($("exec-start") as HTMLInputElement).value).toBe("2026-10-14");
    expect(($("exec-end") as HTMLInputElement).value).toBe(TODAY);
    expect(queryBtn().disabled).toBe(false);
    expect($("exec-idle")).toBeTruthy();
  });

  it("실제 체결 실적이며 리밸런싱 완료 기록이 아니고 아무것도 저장하지 않는다고 밝힌다", async () => {
    await mount({ request: vi.fn() });
    const d = $("exec-disclaimer")!.textContent!;
    expect(d).toContain("실제 체결 실적");
    expect(d).toContain("리밸런싱 완료 기록과는 별개");
    expect(d).toContain("아무것도 저장하지 않습니다");
  });

  it("계산만 제공 설정이면 조회 버튼이 막히고 이유가 보이며, 눌러도 요청하지 않는다", async () => {
    const request = vi.fn();
    await mount({ registry: [CALC], request });
    expect(queryBtn().disabled).toBe(true);
    expect($("exec-gate-local")!.textContent).toContain("계산만 제공");
    await click(queryBtn());
    expect(request).not.toHaveBeenCalled();
  });

  it("레지스트리가 없으면 설정하라고 안내하고 요청하지 않는다", async () => {
    const request = vi.fn();
    await mount({ registry: [], request });
    expect(queryBtn().disabled).toBe(true);
    expect($("exec-gate-local")!.textContent).toContain("설정");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("실제 응답(cncl_yn 이 빈 문자열) — 확인 불가와 체결 없음을 분리해서 보여준다", () => {
  // 2026-10-19 실제 응답: 취소되지 않은 행의 cncl_yn 은 "N" 이 아니라 "" 다.
  const blank = OUT1.map((r) => ({ ...r, cncl_yn: "" }));

  it("주문 3건 → 체결 2건 · 294주 · 7,974,630원, 확인 불가 구역은 없다 (예전엔 3건 모두 '체결 없는 주문')", async () => {
    await runOk(async () => resp(okResponse({ body: { output1: blank } })));
    expect($$("exec-row")).toHaveLength(2);
    expect($("exec-buy-amount")!.textContent).toBe("7,974,630원");
    expect($("exec-totals")!.textContent).toContain("294주");
    expect($("exec-totals")!.textContent).toContain("증권사 요약 합계 7,974,630원 — 일치");
    expect($$("exec-zero-row")).toHaveLength(1);
    expect($("exec-unverifiable")).toBeNull();
    expect($("exec-status-counts")!.textContent).toContain("신규 체결");
    // 0주 행은 취소 여부 미보고를 '취소 아님'으로 단정하지 않는다
    expect($("exec-zero-fill")!.textContent).toContain("취소 여부를 알려주지 않았습니다");
  });

  it("필수 정보를 읽지 못한 행은 '확인 불가' 구역에 따로 나오고 체결 없음 구역·합계에 섞이지 않는다", async () => {
    const withBad = [...blank, rowRaw({ odno: "0000009900", cncl_yn: "", tot_ccld_qty: "" })];
    await runOk(async () => resp(okResponse({ body: { output1: withBad } })));
    expect($$("exec-unverifiable-row")).toHaveLength(1);
    expect($("exec-unverifiable")!.textContent).toContain("체결이 없다는 뜻이 아닙니다");
    expect($("exec-unverifiable")!.textContent).toContain("체결수량");           // 읽지 못한 필드 이름
    expect($$("exec-zero-row")).toHaveLength(1);                                // 확인된 0주 1건만
    expect($("exec-zero-fill")!.textContent).not.toContain("0000009900".slice(-4));
    expect($("exec-totals")!.textContent).toContain("체결 0주로 확인된 주문 1건");
    expect($("exec-totals")!.textContent).toContain("읽지 못한 주문 1건은 체결 여부를 알 수 없어");
    expect($("exec-buy-amount")!.textContent).toBe("7,974,630원");
  });
});

describe("조회 결과 — 실증된 응답 구조", () => {
  it("[조회] 한 번에 요청 1회, 선택한 기간을 그대로 보낸다", async () => {
    const request = vi.fn(async (_r: ExecRange) => resp(okResponse()));
    await runOk(request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ start: "2026-10-14", end: TODAY });
  });

  it("체결된 2건: 종목명·코드·구분·체결수량·평균 체결가·총체결금액이 표시된다", async () => {
    await runOk(async () => resp(okResponse()));
    const rows = $$("exec-row");
    expect(rows).toHaveLength(2);
    const t = rows.map((r) => r.textContent).join("\n");
    expect(t).toContain("TIGER 미국S&P500"); expect(t).toContain("360750");
    expect(t).toContain("ACE 미국나스닥100"); expect(t).toContain("367380");
    expect(t).toContain("매수");
    expect(t).toContain("230주"); expect(t).toContain("64주");
    expect(t).toContain("25,985원"); expect(t).toContain("31,220원");
    expect(t).toContain("5,976,550원"); expect(t).toContain("1,998,080원");
    expect(t).toContain("2026-10-14");
  });

  it("체결 0주 주문은 별도 구역에 있고 표·카드·합계에 들어가지 않는다", async () => {
    await runOk(async () => resp(okResponse()));
    expect($$("exec-zero-row")).toHaveLength(1);
    expect($("exec-zero-fill")!.textContent).toContain("매수 실적에 포함하지 않습니다");
    expect($("exec-zero-fill")!.textContent).toContain("정정");               // 정정 원주문 가능성 주의
    expect($$("exec-row")).toHaveLength(2);
    expect($$("exec-card")).toHaveLength(2);
    expect($("exec-buy-amount")!.textContent).toBe("7,974,630원");           // 0주 행이 더해지지 않는다
    expect($("exec-totals")!.textContent).toContain("체결 0주로 확인된 주문 1건은 합계에서 제외");
    expect($("exec-totals")!.textContent).toContain("증권사 요약 합계 7,974,630원 — 일치");
  });

  it("상태 요약: 신규 체결 2 · 체결 없는 주문 1", async () => {
    await runOk(async () => resp(okResponse()));
    const c = $("exec-status-counts")!.textContent!;
    expect(c).toMatch(/신규 체결\s*2/);
    expect(c).toMatch(/체결 없는 주문\s*1/);
    expect(c).toMatch(/기존 원장과 일치\s*0/);
  });

  it("조회를 완료했으면 불완전 안내가 없다", async () => {
    await runOk(async () => resp(okResponse()));
    expect($("exec-incomplete")).toBeNull();
  });

  it("다음 페이지가 있으면 불완전 안내가 보이고 합계가 일부임을 말한다", async () => {
    await runOk(async () => resp(okResponse({ trCont: "M", body: { ctx_area_fk100: "FK", ctx_area_nk100: "NK" } })));
    const w = $("exec-incomplete")!;
    expect(w.textContent).toContain("불완전");
    expect(w.textContent).toContain("읽지 않았습니다");
    expect(w.textContent).toContain("실제보다 적을 수 있습니다");
    expect($("exec-totals")!.textContent).not.toContain("증권사 요약 합계");     // 끝까지 읽지 않으면 대조하지 않는다
  });
});

describe("중복 · 충돌 판정 표시", () => {
  it("같은 출처의 같은 주문이 원장에 있으면 '기존 원장과 일치'로 표시한다", async () => {
    const dup: LedgerTransaction = { ...mirae("k1", "367380", 64, 1_998_080), source: "kis_api_daily_ccld", eventDate: "2026-10-14", sourceFingerprint: "v2|kis_api_daily_ccld|bai:kis|20261014|0000001700" };
    await runOk(async () => resp(okResponse({ ledger: [mirae("m1", "360750", 297, 7_425_000), dup] })));
    expect($("exec-status-counts")!.textContent).toMatch(/기존 원장과 일치\s*1/);
    expect($$("exec-row").map((r) => r.textContent).join()).toContain("기존 원장과 일치");
  });

  it("다른 출처에 같은 날 같은 거래가 있으면 '중복 가능성'과 비교한 원장 행을 보여준다", async () => {
    const other: LedgerTransaction = { ...mirae("o1", "360750", 230, 5_976_550), eventDate: "2026-10-14" };
    await runOk(async () => resp(okResponse({ ledger: [other] })));
    expect($("exec-status-counts")!.textContent).toMatch(/중복 가능성\s*1/);
    expect(text()).toContain("비교한 원장 행");
  });

  it("한국투자 시작일(10-14) 이전 체결은 '계좌 귀속 충돌'로 경고한다", async () => {
    const early = { ...bodyOf(), output1: [rowRaw({ odno: "0000009001", ord_dt: "20261013" })] };
    await runOk(async () => resp(okResponse({ body: early })));
    expect($("exec-status-counts")!.textContent).toMatch(/계좌 귀속 충돌\s*1/);
    expect($$("exec-blocker").map((b) => b.textContent).join()).toContain("계좌 귀속이 충돌");
  });
});

describe("계좌 이전 · 자금 · 보유 — 읽기 전용 영향", () => {
  it("누적 납입원금은 변동 없음으로 표시된다 (이전 자금을 신규 납입으로 만들지 않는다)", async () => {
    await runOk(async () => resp(okResponse()));
    expect($("exec-principal")!.textContent).toBe("10,500,000원");
    expect($("exec-impact")!.textContent).toContain("변동 없음");
    expect($("exec-impact")!.textContent).toContain("아무것도 반영되지 않았습니다");
  });

  it("이전 증권사 원장 보유(297주/81주)가 이탈 처리되지 않았음을 경고하고 가상 매도를 만들지 않는다고 밝힌다", async () => {
    await runOk(async () => resp(okResponse()));
    const r = $("exec-residual")!.textContent!;
    expect(r).toContain("360750 297주");
    expect(r).toContain("367380 81주");
    expect(r).toContain("이중 계산");
    expect(r).toContain("가상의 매도 내역을 만들지 않습니다");
  });

  it("자금 출처 부족을 가짜 '미관측 수입' 위험으로 명확히 경고한다", async () => {
    await runOk(async () => resp(okResponse()));
    const f = $("exec-funding")!.textContent!;
    expect(f).toContain("가짜 ‘미관측 수입’");
    expect(f).toContain("발생 위험");
    expect(f).toMatch(/원장 재생 보유\(반영 후\)/);
  });

  it("기존 평가금액을 매도대금으로 간주해 계산하지 않는다 (화면에 가정 매도 항목이 없다)", async () => {
    await runOk(async () => resp(okResponse()));
    expect(text()).not.toMatch(/10,255,680|가정 매도|예상 매도대금/);
  });
});

describe("원장 반영은 열리지 않는다", () => {
  it("반영 버튼은 비활성이고 막는 사유가 모두 나열된다", async () => {
    await runOk(async () => resp(okResponse()));
    const b = $("exec-approve-button") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toContain("사용할 수 없음");
    const reasons = $$("exec-blocker").map((x) => x.textContent).join("\n");
    expect(reasons).toContain("아직 열리지 않았습니다");
    expect(reasons).toContain("자금 출처 근거가 원장에 없습니다");
    expect(reasons).toContain("이중 계산됩니다");
    expect(reasons).toContain("이전 방식(매도 후 현금 이전 / 실물 이전)이 확인되지 않았습니다");
  });

  it("클릭해도 아무 요청도 일어나지 않는다", async () => {
    const request = vi.fn(async (_r: ExecRange) => resp(okResponse()));
    await runOk(request);
    await click($("exec-approve-button")!);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("조회 실패 · 실제 0건 · 응답 부재 · 설정 없음 — 구분과 재시도 없음", () => {
  it("실제 0건(빈 배열)은 '관측되지 않았다'이며 주문이 없었다는 증거가 아니다", async () => {
    await runOk(async () => resp(okResponse({ body: { output1: [], output2: undefined } })));
    expect($("exec-empty")!.textContent).toContain("관측되지 않았습니다");
    expect($("exec-empty")!.textContent).toContain("증거는 아닙니다");
    expect($("exec-failed")).toBeNull();
  });

  it("응답에 목록이 없으면 '0건이 아니다'라고 말한다", async () => {
    await runOk(async () => resp(okResponse({ body: { output1: undefined } })));
    expect($("exec-list-absent")!.textContent).toContain("0건이라는 뜻이 아닙니다");
  });

  it("조회 실패는 원인을 분류해 보여주고, 자동 재시도하지 않으며, '체결 0건'이 아니라고 밝힌다", async () => {
    const request = vi.fn(async (_r: ExecRange): Promise<ExecRequestOutcome> => resp({
      state: "query_failed", failure: { kind: "account", httpStatus: 200, rtCd: "2", msgCd: "OPSQ2000", msg1: "ERROR : INPUT INVALID_CHECK_ACNO" },
    }));
    await runOk(request);
    const f = $("exec-failed")!.textContent!;
    expect(f).toContain("계좌번호 또는 계좌상품코드");
    expect(f).toContain("자동으로 다시 시도하지 않았고");
    expect(f).toContain("‘체결 0건’이 아닙니다");
    expect($$("exec-row")).toHaveLength(0);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("서버에 조회 설정(credential)이 없으면 그렇게 안내하고 기존 기능에 영향이 없다고 말한다", async () => {
    await runOk(async () => ({ kind: "not_configured" }));
    expect($("exec-error")!.textContent).toContain("조회 설정이 없어");
    expect($("exec-error")!.textContent).toContain("기존 기능에는 영향이 없습니다");
    expect($$("exec-row")).toHaveLength(0);
  });

  it("권한 없음 · 세션 만료 · 네트워크 · 타임아웃 · 서버 오류도 각각 다른 문구이고 기록하지 않았다고 밝힌다", async () => {
    const msgs: string[] = [];
    for (const kind of ["forbidden", "unauthorized", "network_error", "timeout", "server_error"] as const) {
      document.body.innerHTML = "";
      await runOk(async () => (kind === "server_error" ? { kind, status: 500 } : { kind }) as ExecRequestOutcome);
      msgs.push($("exec-error")!.textContent!);
    }
    expect(new Set(msgs).size).toBe(5);
    expect(msgs[2]).toContain("아무것도 기록하지 않았습니다");
    expect(msgs[3]).toContain("아무것도 기록하지 않았습니다");
    expect(msgs[4]).toContain("아무것도 기록하지 않았습니다");
  });

  it("서버가 계좌 설정으로 차단했으면(gate_blocked) 그 사유를 보여준다", async () => {
    await runOk(async () => resp({ state: "gate_blocked", reason: "instance_not_active" }));
    expect($("exec-gate")!.textContent).toContain("시작일이 아직 되지 않았거나");
  });

  it("원장 저장소를 읽을 수 없으면 대조 없이 아무것도 표시하지 않는다", async () => {
    await runOk(async () => resp({ state: "ledger_unavailable" }));
    expect($("exec-ledger-unavailable")!.textContent).toContain("아무것도 표시하지 않았습니다");
    expect($$("exec-row")).toHaveLength(0);
  });
});

describe("입력 검증 · 중복 클릭", () => {
  it("종료일이 시작일보다 앞이면 조회할 수 없다", async () => {
    const request = vi.fn();
    await mount({ request });
    await typeInto($("exec-end") as HTMLInputElement, "2026-10-10");
    expect(queryBtn().disabled).toBe(true);
    expect($("exec-date-error")!.textContent).toContain("시작일 ≤ 종료일 ≤ 오늘");
    await click(queryBtn());
    expect(request).not.toHaveBeenCalled();
  });
  it("93일을 넘는 기간은 조회할 수 없다", async () => {
    const request = vi.fn();
    await mount({ request });
    await typeInto($("exec-start") as HTMLInputElement, "2026-01-01");
    expect(queryBtn().disabled).toBe(true);
    expect($("exec-date-error")!.textContent).toContain("93일");
  });
  it("미래 종료일은 조회할 수 없다", async () => {
    await mount({ request: vi.fn() });
    await typeInto($("exec-end") as HTMLInputElement, "2026-10-20");
    expect(queryBtn().disabled).toBe(true);
  });
  it("조회 중에 연속 클릭해도 요청은 1번이다", async () => {
    let release!: (o: ExecRequestOutcome) => void;
    const request = vi.fn((_r: ExecRange) => new Promise<ExecRequestOutcome>((res) => { release = res; }));
    await mount({ request });
    await click(queryBtn()); await click(queryBtn()); await click(queryBtn());
    expect(request).toHaveBeenCalledTimes(1);
    expect($("exec-loading")).toBeTruthy();
    expect(queryBtn().disabled).toBe(true);
    await act(async () => { release(resp(okResponse())); });
    expect($$("exec-row")).toHaveLength(2);
  });
});

describe("모바일 · 반응형", () => {
  it("같은 데이터를 데스크톱 표(md 이상)와 모바일 카드(md 미만)로 모두 제공한다", async () => {
    await runOk(async () => resp(okResponse()));
    expect($("exec-table")!.className).toContain("hidden");
    expect($("exec-table")!.className).toContain("md:block");
    expect($("exec-table")!.className).toContain("overflow-x-auto");
    expect($("exec-cards")!.className).toContain("md:hidden");
    expect($$("exec-card")).toHaveLength($$("exec-row").length);
  });
  it("모바일 카드에도 종목·구분·수량·평균가·금액·상태가 모두 있다", async () => {
    await runOk(async () => resp(okResponse()));
    const c = $$("exec-card")[1].textContent!;
    for (const s of ["TIGER 미국S&P500", "360750", "매수", "230주", "25,985원", "5,976,550원", "신규 체결"]) expect(c).toContain(s);
  });
  it("입력과 버튼이 모바일에서 전체 너비를 쓰고 긴 문구는 줄바꿈된다", async () => {
    await runOk(async () => resp(okResponse()));
    expect($("exec-start")!.className).toContain("w-full");
    expect(queryBtn().className).toContain("w-full");
    expect($$("exec-card")[0].querySelector(".break-words, .break-all")).toBeTruthy();
  });
});

describe("원장·장부·완료 기록을 건드리지 않는다 (소스)", () => {
  const dir = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
  const code = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("패널은 저장소 · 원장 · 완료 · 장부 쓰기 함수를 참조하지 않는다", () => {
    const src = code(dir("./KisExecutionImportPanel.tsx"));
    expect(src).not.toMatch(/usePortfolioStore|finalizeRebalance|addHistory|addCashflow|setBrokerConnection|saveAccountRow|localStorage|sessionStorage|fetch\(/);
  });
  it("카드는 연금저축에서만 패널을 그리고 조회 함수만 연결한다", () => {
    const src = dir("./KisExecutionImportCard.tsx");
    expect(src).toContain('accountId !== "pension"');
    expect(code(src)).not.toMatch(/finalizeRebalance|addHistory|addCashflow|setBrokerConnection/);
  });
  it("AccountPage 에 한 번만 연결돼 있다", () => {
    const src = dir("./AccountPage.tsx");
    expect((src.match(/<KisExecutionImportCard/g) ?? []).length).toBe(1);
  });
});
