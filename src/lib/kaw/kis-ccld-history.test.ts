/**
 * 한국투자 과거 체결 조회 모듈 — 실계좌 호출 없이, 실증된 응답 구조(2026-10-16)로 고정한다.
 *
 * 지키는 것:
 *   1. 조회 구간이 TR_ID(3개월 이내/이전)에 맞게 나뉜다 · 3개월 이전은 31일 단위
 *   2. 체결수량 0 행은 어떤 경우에도 체결이 아니다 (정정 원주문 · 취소 · 거부 · 미체결)
 *   3. "응답 부재(list_absent)"와 "실제 0건(empty)"을 구분한다
 *   4. 부분체결 · 중복 주문번호 · 필드 누락을 안전하게 처리한다 (0 으로 채우지 않는다)
 *   5. 재시도하지 않는다 · 연속 페이지는 상한까지만 읽고 미조회 페이지를 알린다
 *   6. 계좌번호 · 키 · 토큰이 반환값에 남지 않는다
 *   7. 읽기 전용 — 주문 경로가 없다
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CCLD_BEFORE_MAX_SPAN_DAYS,
  TR_ID_CCLD_BEFORE,
  TR_ID_CCLD_INNER,
  buildCcldParams,
  classifyCcldFailure,
  classifyCcldRow,
  fetchCcldWindow,
  parseCcldResponse,
  planCcldWindows,
  readCcldRow,
  threeMonthsAgo,
  type CcldQuery,
} from "./kis-ccld-history";

// ── 실증된 응답 구조 (2026-10-16, 연금저축 22). 주문번호는 가짜 값이다. ────────────
const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", ord_gno_brno: "00000", odno: "0000000001", orgn_odno: "", ord_dvsn_name: "지정가",
  sll_buy_dvsn_cd: "02", sll_buy_dvsn_cd_name: "현금매수", pdno: "360750", prdt_name: "TIGER 미국S&P500",
  ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985",
  cncl_yn: "N", tot_ccld_amt: "5976550", loan_dt: "", rmn_qty: "0", rjct_qty: "0", ...over,
});
const SAMPLE_OUTPUT1 = [
  rowRaw({ odno: "0000000700", ord_tmd: "133510", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0", rmn_qty: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", ord_unpr: "31220", ord_tmd: "133615", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080" }),
  rowRaw({ odno: "0000006700", ord_tmd: "133636" }),
];
const SAMPLE_OUTPUT2 = {
  tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.5918", prsm_tlex_smtl: "0",
};
const okBody = (over: Record<string, unknown> = {}) => ({
  rt_cd: "0", msg_cd: "KIOK0510", msg1: "조회가 완료되었습니다", ctx_area_fk100: "", ctx_area_nk100: "",
  output1: SAMPLE_OUTPUT1, output2: SAMPLE_OUTPUT2, ...over,
});

const CRED = { appKey: "APPKEY-1234567890-SECRET-VALUE-XYZ", appSecret: "APPSECRET-1234567890-SECRET-VALUE-XYZ", cano: "12345678" };
const TOKEN = "TOKEN-1234567890-SECRET-VALUE-XYZ-ABCDEFGHIJKLMNOP";
const Q: CcldQuery = { productCode: "22", window: { start: "20261013", end: "20261016", trId: TR_ID_CCLD_INNER } };

const resp = (body: unknown, status = 200, trCont = "E") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", tr_cont: trCont } });

describe("조회 구간 · TR_ID", () => {
  it("3개월 전 날짜 계산 (말일 보정)", () => {
    expect(threeMonthsAgo("20261016")).toBe("20260716");
    expect(threeMonthsAgo("20260531")).toBe("20260228");
    expect(threeMonthsAgo("20240531")).toBe("20240229");
    expect(threeMonthsAgo("20261316")).toBeNull();
  });

  it("최근 구간은 TTTC0081R 한 구간이다 (사용자 시나리오: 10-13~10-16)", () => {
    const p = planCcldWindows("20261013", "20261016", "20261016");
    expect(p).toEqual({ ok: true, windows: [{ start: "20261013", end: "20261016", trId: TR_ID_CCLD_INNER }] });
  });

  it("3개월 경계를 가로지르면 둘로 나뉘고 TR_ID 가 다르다", () => {
    const p = planCcldWindows("20260701", "20261016", "20261016");
    if (!p.ok) throw new Error("plan");
    const inner = p.windows.filter((w) => w.trId === TR_ID_CCLD_INNER);
    const before = p.windows.filter((w) => w.trId === TR_ID_CCLD_BEFORE);
    expect(inner).toEqual([{ start: "20260716", end: "20261016", trId: TR_ID_CCLD_INNER }]);
    expect(before).toEqual([{ start: "20260701", end: "20260715", trId: TR_ID_CCLD_BEFORE }]);
  });

  it("3개월 이전 긴 구간은 31일 단위로 쪼개고 빈틈·겹침이 없다", () => {
    const p = planCcldWindows("20260101", "20260630", "20261016");
    if (!p.ok) throw new Error("plan");
    expect(p.windows.every((w) => w.trId === TR_ID_CCLD_BEFORE)).toBe(true);
    let prevEnd = "";
    for (const w of p.windows) {
      const days = (Date.parse(`${w.end.slice(0, 4)}-${w.end.slice(4, 6)}-${w.end.slice(6)}`) - Date.parse(`${w.start.slice(0, 4)}-${w.start.slice(4, 6)}-${w.start.slice(6)}`)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(CCLD_BEFORE_MAX_SPAN_DAYS);
      if (prevEnd) {
        const next = new Date(Date.UTC(+prevEnd.slice(0, 4), +prevEnd.slice(4, 6) - 1, +prevEnd.slice(6)) + 86_400_000);
        const nextStr = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
        expect(w.start).toBe(nextStr);
      }
      prevEnd = w.end;
    }
    expect(p.windows[0].start).toBe("20260101");
    expect(p.windows.at(-1)!.end).toBe("20260630");
  });

  it("잘못된 입력은 거부한다", () => {
    expect(planCcldWindows("20261016", "20261013", "20261016")).toEqual({ ok: false, reason: "range_reversed" });
    expect(planCcldWindows("20261013", "20261020", "20261016")).toEqual({ ok: false, reason: "future_end" });
    expect(planCcldWindows("2026-10-13", "20261016", "20261016")).toEqual({ ok: false, reason: "invalid_date" });
    expect(planCcldWindows("20260230", "20261016", "20261016")).toEqual({ ok: false, reason: "invalid_date" });
  });
});

describe("요청 파라미터", () => {
  it("연금저축 22 · 정순 · 전체 · KRX 이고, 계좌번호를 모른다", () => {
    const p = buildCcldParams(Q);
    expect(p).toMatchObject({
      ACNT_PRDT_CD: "22", INQR_STRT_DT: "20261013", INQR_END_DT: "20261016",
      SLL_BUY_DVSN_CD: "00", CCLD_DVSN: "00", INQR_DVSN: "01", INQR_DVSN_3: "00",
      EXCG_ID_DVSN_CD: "KRX", CTX_AREA_FK100: "", CTX_AREA_NK100: "", PDNO: "", ODNO: "",
    });
    expect("CANO" in p).toBe(false);
    expect(JSON.stringify(p)).not.toContain(CRED.cano);
  });
  it("연속조회 키를 그대로 넘긴다", () => {
    const p = buildCcldParams(Q, { fk100: "FK", nk100: "NK" });
    expect(p.CTX_AREA_FK100).toBe("FK");
    expect(p.CTX_AREA_NK100).toBe("NK");
  });
});

describe("응답 해석 — 실증된 구조", () => {
  const page = parseCcldResponse(200, okBody(), "E");

  it("성공 · 3행 · 마지막 페이지", () => {
    expect(page.ok).toBe(true);
    expect(page.listState).toBe("rows");
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
  });

  it("체결 0 · 잔여 0 · 취소 아님 행은 체결이 아니다 (정정 원주문 가능성)", () => {
    const zero = page.rows[0];
    expect(zero.kind).toBe("no_fill_closed");
    expect(zero.hasExecution).toBe(false);
  });

  it("체결 행은 수량 × 평균가 = 체결금액이 맞다", () => {
    const exec = page.rows.filter((r) => r.hasExecution);
    expect(exec).toHaveLength(2);
    expect(exec.every((r) => r.kind === "filled" && r.amountMismatch === 0)).toBe(true);
    expect(exec.reduce((s, r) => s + (r.row.filledAmount ?? 0), 0)).toBe(7_974_630);
  });

  it("output2 요약은 영문 필드명으로 읽는다 (공식 예제의 한글 라벨은 밀려 있다)", () => {
    expect(page.summary).toEqual({
      totalOrderQty: 294, totalFilledQty: 294, totalFilledAmount: 7_974_630, avgPurchasePrice: 27124.5918, estimatedCosts: 0,
    });
    const sumQty = page.rows.reduce((s, r) => s + (r.row.filledQty ?? 0), 0);
    expect(sumQty).toBe(page.summary!.totalFilledQty);
  });

  it("주문 단위 집계다 — 행에 개별 분할체결 필드가 없다", () => {
    expect(Object.keys(page.rows[2].row)).not.toContain("fills");
  });
});

describe("응답 부재 ≠ 실제 0건", () => {
  it("output1 이 배열이 아니면 list_absent (모름)", () => {
    for (const b of [okBody({ output1: undefined }), okBody({ output1: null }), okBody({ output1: "x" })]) {
      expect(parseCcldResponse(200, b, "E").listState).toBe("list_absent");
    }
  });
  it("빈 배열은 empty — 그 조건에서 관측된 0건이지 '주문이 없었다'는 증거가 아니다", () => {
    const p = parseCcldResponse(200, okBody({ output1: [] }), "E");
    expect(p.ok).toBe(true);
    expect(p.listState).toBe("empty");
    expect(p.rows).toEqual([]);
  });
  it("rt_cd 가 0 이 아니면 목록을 읽지 않는다", () => {
    const p = parseCcldResponse(200, { rt_cd: "1", msg_cd: "X", msg1: "오류", output1: SAMPLE_OUTPUT1 }, "E");
    expect(p.ok).toBe(false);
    expect(p.rows).toEqual([]);
    expect(p.listState).toBe("list_absent");
  });
  it("본문을 해석하지 못해도 throw 하지 않는다", () => {
    const p = parseCcldResponse(502, null, null);
    expect(p.ok).toBe(false);
    expect(p.listState).toBe("list_absent");
  });
});

describe("행 분류 — 부분체결 · 취소 · 거부 · 필드 누락", () => {
  const c = (over: Record<string, unknown>) => classifyCcldRow(readCcldRow(rowRaw(over)));

  it("전량 체결", () => expect(c({}).kind).toBe("filled"));
  it("일부 체결 + 잔여 있음 + 취소 아님 = 살아 있는 부분체결", () => {
    const r = c({ ord_qty: "100", tot_ccld_qty: "40", rmn_qty: "60", avg_prvs: "1000", tot_ccld_amt: "40000" });
    expect(r.kind).toBe("partially_filled_open");
    expect(r.hasExecution).toBe(true);
  });
  it("일부 체결 후 취소 = 체결된 만큼은 실제 체결", () => {
    const r = c({ ord_qty: "100", tot_ccld_qty: "40", rmn_qty: "0", cncl_yn: "Y", avg_prvs: "1000", tot_ccld_amt: "40000" });
    expect(r.kind).toBe("partially_filled_closed");
    expect(r.hasExecution).toBe(true);
  });
  it("체결 0 + 잔여 있음 = 미체결 주문", () => {
    const r = c({ tot_ccld_qty: "0", rmn_qty: "230", avg_prvs: "0", tot_ccld_amt: "0" });
    expect(r.kind).toBe("no_fill_open");
    expect(r.hasExecution).toBe(false);
  });
  it("체결 0 + 취소 = 취소", () => {
    const r = c({ tot_ccld_qty: "0", cncl_yn: "Y", avg_prvs: "0", tot_ccld_amt: "0" });
    expect(r.kind).toBe("cancelled");
    expect(r.hasExecution).toBe(false);
  });
  it("거부수량 > 0 = 거부", () => {
    const r = c({ tot_ccld_qty: "0", rjct_qty: "230", avg_prvs: "0", tot_ccld_amt: "0" });
    expect(r.kind).toBe("rejected");
    expect(r.hasExecution).toBe(false);
  });
  it("체결수량 0 행은 금액 필드가 무엇이든 체결이 아니다", () => {
    const r = c({ tot_ccld_qty: "0", avg_prvs: "25985", tot_ccld_amt: "5976550" });
    expect(r.hasExecution).toBe(false);
  });
  it("필수 필드를 못 읽으면 unreadable — 0 으로 채우지 않는다", () => {
    for (const over of [{ odno: "" }, { pdno: "12" }, { ord_dt: "2026-10-14" }, { sll_buy_dvsn_cd: "99" }, { tot_ccld_qty: "" }]) {
      const r = c(over);
      expect(r.kind).toBe("unreadable");
      expect(r.hasExecution).toBe(false);
    }
  });
  it("취소 여부(cncl_yn)가 'Y'/'N' 이 아니어도 unreadable 이 아니다 — 필수 필드에서 빠졌다 (kis-ccld-blank-cancel-flag.test.ts)", () => {
    for (const v of ["", "?", " "]) expect(c({ cncl_yn: v }).kind).toBe("filled");
  });
  it("체결이 있는데 평균가 · 체결금액을 못 읽으면 unreadable", () => {
    expect(c({ avg_prvs: "", tot_ccld_amt: "" }).kind).toBe("unreadable");
    expect(c({ tot_ccld_amt: "" }).kind).toBe("unreadable");
  });
  it("수량 × 평균가 와 체결금액이 어긋나면 그 차이를 알린다", () => {
    expect(c({ tot_ccld_amt: "5976000" }).amountMismatch).toBe(550);
  });
});

describe("오류 분류 — 인증 · 계좌 · 요청값 · 미지원 · 빈도", () => {
  const f = (msgCd: string | null, msg1: string | null, http = 200) => classifyCcldFailure({ rtCd: "1", msgCd, msg1 }, http);
  it("인증", () => {
    expect(f("EGW00123", "기간이 만료된 token 입니다.")).toBe("auth");
    expect(f(null, null, 401)).toBe("auth");
  });
  it("계좌 · 상품코드", () => expect(f("OPSQ2000", "ERROR : INPUT INVALID_CHECK_ACNO")).toBe("account"));
  it("호출 빈도", () => expect(f("EGW00201", "초당 거래건수를 초과하였습니다.")).toBe("rate_limit"));
  it("미지원 가능성은 확정이 아니다", () => expect(f("OPSQ0002", "해당 업무는 서비스 불가")).toBe("possibly_unsupported"));
  it("모르는 오류는 미분류 — 미지원으로 단정하지 않는다", () => expect(f("ZZZ", "알 수 없음")).toBe("unclassified"));
});

describe("전송 — 재시도 없음 · 페이지 상한 · 비밀값 보호", () => {
  it("첫 요청: GET · 올바른 경로와 TR_ID · tr_cont 헤더 없음", async () => {
    const fetchImpl = vi.fn(async () => resp(okBody()));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/uapi/domestic-stock/v1/trading/inquire-daily-ccld?");
    expect(url).toContain("ACNT_PRDT_CD=22");
    expect(init.method).toBe("GET");
    const h = init.headers as Record<string, string>;
    expect(h.tr_id).toBe("TTTC0081R");
    expect("tr_cont" in h).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(3);
  });

  it("다음 페이지가 있어도 상한(기본 1페이지)이면 더 부르지 않고 미조회 페이지를 알린다", async () => {
    const fetchImpl = vi.fn(async () => resp(okBody({ ctx_area_fk100: "FKX", ctx_area_nk100: "NKX" }), 200, "M"));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.unreadPages).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.failure).toBeNull();
  });

  it("페이지 상한을 올리면 연속조회 키와 tr_cont:N 으로 이어 읽고, 마지막에서 멈춘다", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resp(okBody({ ctx_area_fk100: "FK1", ctx_area_nk100: "NK1" }), 200, "M"))
      .mockResolvedValueOnce(resp(okBody({ output1: [rowRaw({ odno: "0000009900", ord_dt: "20261015" })] }), 200, "E"));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN, maxPages: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url2, init2] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url2).toContain("CTX_AREA_FK100=FK1");
    expect(url2).toContain("CTX_AREA_NK100=NK1");
    expect((init2.headers as Record<string, string>).tr_cont).toBe("N");
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(4);
  });

  it("실패하면 한 번에 멈춘다 — 자동 재시도 없음", async () => {
    const fetchImpl = vi.fn(async () => resp({ rt_cd: "1", msg_cd: "EGW00123", msg1: "기간이 만료된 token 입니다." }, 200));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.complete).toBe(false);
    expect(r.failure?.kind).toBe("auth");
  });

  it("네트워크 오류도 재시도하지 않고 분류한다", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed " + CRED.cano); });
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.failure?.kind).toBe("network");
    expect(JSON.stringify(r)).not.toContain(CRED.cano);
  });

  it("타임아웃은 timeout 으로 분류한다", async () => {
    const fetchImpl = vi.fn(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(r.failure?.kind).toBe("timeout");
  });

  it("본문을 해석하지 못하면 unparseable", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 502 }));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(r.failure?.kind).toBe("unparseable");
  });

  it("오류 메시지에 계좌번호 · 키 · 토큰이 섞여 와도 결과에 남지 않는다", async () => {
    const fetchImpl = vi.fn(async () => resp({
      rt_cd: "2", msg_cd: "OPSQ2000",
      msg1: `ERROR ${CRED.cano} ${CRED.appKey} ${TOKEN} INVALID_CHECK_ACNO`,
    }));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    const s = JSON.stringify(r);
    for (const secret of [CRED.cano, CRED.appKey, CRED.appSecret, TOKEN]) expect(s).not.toContain(secret);
    expect(r.failure?.kind).toBe("account");
  });

  it("같은 주문일+주문번호가 겹치면 duplicateOrderKeys 로 알린다", async () => {
    const dup = [rowRaw({ odno: "0000000001" }), rowRaw({ odno: "0000000001" }), rowRaw({ odno: "0000000002" })];
    const fetchImpl = vi.fn(async () => resp(okBody({ output1: dup })));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(r.duplicateOrderKeys).toEqual(["20261014:0000000001"]);
  });

  it("응답 안의 계좌번호는 반환 구조에 들어오지 않는다 (행 모양에 CANO 필드가 없다)", async () => {
    const withAcct = rowRaw({ cano: CRED.cano, acnt_no: CRED.cano });
    const fetchImpl = vi.fn(async () => resp(okBody({ output1: [withAcct] })));
    const r = await fetchCcldWindow(CRED, Q, fetchImpl, { token: TOKEN });
    expect(JSON.stringify(r)).not.toContain(CRED.cano);
  });
});

describe("읽기 전용 불변식 (소스)", () => {
  const src = readFileSync(fileURLToPath(new URL("./kis-ccld-history.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("주문 · 취소 · 쓰기 경로가 없다", () => {
    expect(code).not.toMatch(/order-cash|order-rvsecncl|method:\s*"POST"|method:\s*"PUT"|method:\s*"DELETE"/);
    expect(code).not.toMatch(/TTTC0012U|TTTC0011U|TTTC0013U/);
  });
  it("콘솔 · 저장소에 아무것도 쓰지 않는다", () => {
    expect(code).not.toMatch(/console\.|localStorage|sessionStorage|supabase|\.from\(/);
  });
  it("재시도 루프가 없다 (while/재귀로 같은 요청을 반복하지 않는다)", () => {
    expect(code).not.toMatch(/retry|while\s*\(true\)/i);
  });
});
