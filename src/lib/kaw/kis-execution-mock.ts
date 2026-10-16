// ─────────────────────────────────────────────────────────────────────────────
// 체결내역 미리보기 UI mock 전용 가짜 응답 — **운영 코드가 import 하지 않는다**(테스트로 고정).
//
// 실제 네트워크·Supabase·증권사를 쓰지 않는다. 종목·수량·금액·주문번호는 실증된 응답 **구조**를
// 흉내 낸 값이다(주문번호는 가상). mock 화면(mock/kis-exec-ui)과 테스트만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecRange, ExecRequestOutcome } from "./kis-execution-client";
import { composeExecutionPreview, type KisExecutionPreviewResponse } from "./kis-execution-compose";
import { parseCcldResponse } from "./kis-ccld-history";
import type { BrokerAccountInstance } from "./broker-account";
import type { LedgerTransaction } from "./ledger";

export type ExecMockScenario =
  | "ok_with_residual"
  | "ok_incomplete"
  | "ok_matches"
  | "empty"
  | "list_absent"
  | "failed_account"
  | "not_configured"
  | "network_error";

export const EXEC_MOCK_SCENARIO_TEXT: Record<ExecMockScenario, string> = {
  ok_with_residual: "정상: 신규 체결 2건 + 체결 없는 주문 1건 + 이전 증권사 보유 잔존 경고",
  ok_incomplete: "다음 페이지 미조회(불완전)",
  ok_matches: "이미 원장에 있는 체결(일치) + 중복 가능성",
  empty: "실제 0건(빈 배열)",
  list_absent: "응답에 목록 없음(0건 아님)",
  failed_account: "조회 실패: 계좌·상품코드",
  not_configured: "서버에 조회 설정(credential) 없음 — 현재 운영 상태",
  network_error: "네트워크 오류",
};

export const MOCK_TODAY = "2026-10-16";
export const MOCK_KIS: BrokerAccountInstance = {
  id: "bai:mock-kis", label: "모의 한국투자 연금저축(가상)", broker: "kis", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly",
};
const MOCK_PRIOR: BrokerAccountInstance = {
  id: "bai:mock-prior", label: "모의 이전 증권사", broker: "other", logicalAccountType: "pension",
  activeFrom: "2025-01-01", activeTo: "2026-10-14",
};

const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", ord_dvsn_name: "지정가", sll_buy_dvsn_cd: "02", pdno: "360750",
  prdt_name: "TIGER 미국S&P500", ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985",
  cncl_yn: "N", tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", ord_tmd: "133510", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", ord_unpr: "31220", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080", ord_tmd: "133615" }),
  rowRaw({ odno: "0000006700" }),
];
const SUMMARY = { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.5918", prsm_tlex_smtl: "0" };

const priorTx = (id: string, ticker: string, qty: number, amount: number): LedgerTransaction => ({
  id, accountId: "pension", ticker, etfName: ticker, side: "buy", quantity: qty, price: Math.round(amount / qty), amount,
  tradeDate: null, settlementDate: "2026-10-07", inferredTradeDate: "2026-10-02", eventDate: "2026-10-02",
  tradeDateEvidence: "tplus2-weekday-inference", fee: 9, tax: 0, postQuantity: null, source: "mock_prior_broker_history",
});

function compose(over: { output1?: unknown; trCont?: string; ledger?: LedgerTransaction[] } = {}): KisExecutionPreviewResponse {
  const page = parseCcldResponse(200, {
    rt_cd: "0", msg_cd: "KIOK0510", ctx_area_fk100: "", ctx_area_nk100: "",
    output1: over.output1 === undefined ? OUT1 : over.output1, output2: SUMMARY,
  }, over.trCont ?? "E");
  return composeExecutionPreview({
    rows: page.rows, summaries: [page.summary],
    query: { start: "2026-10-13", end: MOCK_TODAY, windows: 1, pagesRead: 1, complete: !page.hasMore, unreadPages: page.hasMore, listState: page.listState, duplicateOrderKeys: 0 },
    ledger: over.ledger ?? [priorTx("p1", "360750", 297, 7_425_000), priorTx("p2", "367380", 81, 2_564_460)],
    corrections: new Map(), registry: [MOCK_PRIOR, MOCK_KIS],
    flows: [{ date: "2025-11-10", amount: 6_000_000 }, { date: "2026-01-26", amount: 4_500_000 }],
    accountType: "pension", productCode: "22", today: MOCK_TODAY,
  });
}

/** 시나리오별 가짜 조회 함수. 호출 기록은 `calls` 로 확인한다 */
export function createMockExecRequest(scenario: ExecMockScenario, delayMs = 400) {
  const calls: ExecRange[] = [];
  const request = async (range: ExecRange): Promise<ExecRequestOutcome> => {
    calls.push(range);
    await new Promise((r) => setTimeout(r, delayMs));
    switch (scenario) {
      case "ok_with_residual": return { kind: "response", data: compose() };
      case "ok_incomplete": return { kind: "response", data: compose({ trCont: "M" }) };
      case "ok_matches":
        return {
          kind: "response",
          data: compose({
            ledger: [
              { ...priorTx("p1", "360750", 230, 5_976_550), eventDate: "2026-10-14" },
              { ...priorTx("k1", "367380", 64, 1_998_080), source: "kis_api_daily_ccld", eventDate: "2026-10-14", sourceFingerprint: "v2|kis_api_daily_ccld|bai:mock-kis|20261014|0000001700" },
            ],
          }),
        };
      case "empty": return { kind: "response", data: compose({ output1: [] }) };
      case "list_absent": return { kind: "response", data: compose({ output1: null }) };
      case "failed_account":
        return { kind: "response", data: { state: "query_failed", failure: { kind: "account", httpStatus: 200, rtCd: "2", msgCd: "OPSQ2000", msg1: "ERROR : INPUT INVALID_CHECK_ACNO" } } };
      case "not_configured": return { kind: "not_configured" };
      case "network_error": return { kind: "network_error" };
    }
  };
  return { request, calls };
}
