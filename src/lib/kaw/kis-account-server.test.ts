import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  fetchPensionSavingsBalance,
  fetchIrpPresentBalance,
  fetchIrpDeposit,
  parseKisNumber,
  pickKisNumber,
  redactKisSecrets,
  PENSION_SAVINGS_PRODUCT_CODE,
  IRP_PRODUCT_CODE,
  KIS_PATH_INQUIRE_BALANCE,
  KIS_PATH_PENSION_PRESENT_BALANCE,
  KIS_PATH_PENSION_DEPOSIT,
  TR_ID_INQUIRE_BALANCE,
  TR_ID_PENSION_PRESENT_BALANCE,
  TR_ID_PENSION_DEPOSIT,
  type KisAccountCredentials,
} from "./kis-account-server";

const CRED: KisAccountCredentials = {
  appKey: "test-app-key-0123456789",
  appSecret: "test-app-secret-abcdefghijklmnop",
  cano: "12345678",
};
const TOKEN = "test-access-token-value";

interface Capture { url: string; init: RequestInit }

/** fetch 를 mock 하고 호출 내역을 모은다. 실제 네트워크는 절대 쓰지 않는다. */
function mockFetch(body: unknown, status = 200): Capture[] {
  const calls: Capture[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }));
  return calls;
}

const headersOf = (c: Capture) => c.init.headers as Record<string, string>;
const paramsOf = (c: Capture) => new URL(c.url).searchParams;

const EMPTY_BALANCE = { rt_cd: "0", msg_cd: "MCA00000", msg1: "정상처리 되었습니다.", output1: [], output2: [] };

afterEach(() => { vi.unstubAllGlobals(); });

describe("연금저축(22) 잔고 조회", () => {
  it("GET 으로 공식 path/TR_ID/상품코드를 보낸다", async () => {
    const calls = mockFetch(EMPTY_BALANCE);
    await fetchPensionSavingsBalance(CRED, TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe(KIS_PATH_INQUIRE_BALANCE);
    expect(headersOf(calls[0]).tr_id).toBe("TTTC8434R");
    expect(TR_ID_INQUIRE_BALANCE).toBe("TTTC8434R");
    expect(paramsOf(calls[0]).get("ACNT_PRDT_CD")).toBe("22");
    expect(PENSION_SAVINGS_PRODUCT_CODE).toBe("22");
    expect(paramsOf(calls[0]).get("CANO")).toBe(CRED.cano);
  });

  it("공식 샘플의 필수 파라미터를 모두 포함한다", async () => {
    const calls = mockFetch(EMPTY_BALANCE);
    await fetchPensionSavingsBalance(CRED, TOKEN);
    const p = paramsOf(calls[0]);
    for (const key of [
      "CANO", "ACNT_PRDT_CD", "AFHR_FLPR_YN", "OFL_YN", "INQR_DVSN", "UNPR_DVSN",
      "FUND_STTL_ICLD_YN", "FNCG_AMT_AUTO_RDPT_YN", "PRCS_DVSN", "CTX_AREA_FK100", "CTX_AREA_NK100",
    ]) {
      expect(p.has(key), `missing ${key}`).toBe(true);
    }
  });

  it("custtype=P 와 인증 header 를 보낸다", async () => {
    const calls = mockFetch(EMPTY_BALANCE);
    await fetchPensionSavingsBalance(CRED, TOKEN);
    const h = headersOf(calls[0]);
    expect(h.custtype).toBe("P");
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.appkey).toBe(CRED.appKey);
    expect(h.appsecret).toBe(CRED.appSecret);
    expect(h["content-type"]).toBe("application/json");
  });

  it("rt_cd=0 + output1=[] 이면 빈 계좌로 SUCCESS", async () => {
    mockFetch(EMPTY_BALANCE);
    const r = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(r.ok).toBe(true);
    expect(r.holdingsCount).toBe(0);
    expect(r.holdings).toEqual([]);
    expect(r.rtCd).toBe("0");
  });

  it("cash=0 을 실패로 보지 않고, 0 과 null 을 구분한다", async () => {
    mockFetch({ ...EMPTY_BALANCE, output2: [{ dnca_tot_amt: "0", tot_evlu_amt: "0" }] });
    const zero = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(zero.ok).toBe(true);
    expect(zero.cash).toBe(0);
    expect(zero.summary.tot_evlu_amt).toBe(0);

    vi.unstubAllGlobals();
    mockFetch({ ...EMPTY_BALANCE, output2: [{ some_other_field: "1" }] });
    const missing = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(missing.ok).toBe(true);
    expect(missing.cash).toBeNull();
  });

  it("보유종목이 있으면 normalized 형태로 센다", async () => {
    mockFetch({
      ...EMPTY_BALANCE,
      output1: [{ pdno: "069500", prdt_name: "KODEX 200", hldg_qty: "0000000000012" }],
      output2: [{ dnca_tot_amt: "3,621" }],
    });
    const r = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(r.holdingsCount).toBe(1);
    expect(r.holdings[0]).toEqual({ ticker: "069500", name: "KODEX 200", quantity: 12 });
    expect(r.cash).toBe(3621);
  });

  it("rt_cd != 0 이면 FAILED", async () => {
    mockFetch({ rt_cd: "1", msg_cd: "40910000", msg1: "계좌번호 오류입니다." });
    const r = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.rtCd).toBe("1");
    expect(r.msgCd).toBe("40910000");
    expect(r.msg1).toContain("계좌번호 오류");
  });

  it("HTTP 가 2xx 가 아니면 FAILED", async () => {
    mockFetch({ rt_cd: "0", output1: [], output2: [] }, 500);
    const r = await fetchPensionSavingsBalance(CRED, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
  });
});

describe("IRP(29) 조회", () => {
  it("체결기준잔고 path/TR_ID/상품코드", async () => {
    const calls = mockFetch(EMPTY_BALANCE);
    const r = await fetchIrpPresentBalance(CRED, TOKEN);

    expect(calls[0].init.method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe(KIS_PATH_PENSION_PRESENT_BALANCE);
    expect(KIS_PATH_PENSION_PRESENT_BALANCE)
      .toBe("/uapi/domestic-stock/v1/trading/pension/inquire-present-balance");
    expect(headersOf(calls[0]).tr_id).toBe("TTTC2202R");
    expect(TR_ID_PENSION_PRESENT_BALANCE).toBe("TTTC2202R");
    expect(paramsOf(calls[0]).get("ACNT_PRDT_CD")).toBe("29");
    expect(IRP_PRODUCT_CODE).toBe("29");
    expect(paramsOf(calls[0]).get("USER_DVSN_CD")).toBe("00");
    expect(headersOf(calls[0]).custtype).toBe("P");
    expect(r.ok).toBe(true);
    expect(r.holdingsCount).toBe(0);
  });

  it("예수금 조회 path/TR_ID, cash=0 도 SUCCESS", async () => {
    const calls = mockFetch({ rt_cd: "0", msg_cd: "MCA00000", msg1: "정상", output: { dnca_tota: "0" } });
    const r = await fetchIrpDeposit(CRED, TOKEN);

    expect(calls[0].init.method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe(KIS_PATH_PENSION_DEPOSIT);
    expect(headersOf(calls[0]).tr_id).toBe("TTTC0506R");
    expect(TR_ID_PENSION_DEPOSIT).toBe("TTTC0506R");
    expect(paramsOf(calls[0]).get("ACNT_PRDT_CD")).toBe("29");
    expect(paramsOf(calls[0]).get("ACCA_DVSN_CD")).toBe("00");
    expect(r.ok).toBe(true);
    expect(r.cash).toBe(0);
  });

  it("예수금 필드가 없으면 cash=null (API 성공과 구분)", async () => {
    mockFetch({ rt_cd: "0", output: {} });
    const r = await fetchIrpDeposit(CRED, TOKEN);
    expect(r.ok).toBe(true);
    expect(r.cash).toBeNull();
  });
});

describe("숫자 파싱", () => {
  it("KIS string 형식을 안전하게 변환한다", () => {
    expect(parseKisNumber("1,234")).toBe(1234);
    expect(parseKisNumber("0")).toBe(0);
    expect(parseKisNumber("0000000001234")).toBe(1234);
    expect(parseKisNumber("-12.5")).toBe(-12.5);
    expect(parseKisNumber(42)).toBe(42);
  });

  it("파싱 불가/없음은 null 이다 (NaN 을 0 으로 숨기지 않는다)", () => {
    expect(parseKisNumber("")).toBeNull();
    expect(parseKisNumber("   ")).toBeNull();
    expect(parseKisNumber("abc")).toBeNull();
    expect(parseKisNumber(undefined)).toBeNull();
    expect(parseKisNumber(null)).toBeNull();
    expect(parseKisNumber(NaN)).toBeNull();
  });

  it("pickKisNumber 는 첫 유효 필드를 쓴다", () => {
    expect(pickKisNumber({ a: "x", b: "7" }, ["a", "b"])).toBe(7);
    expect(pickKisNumber({ a: "x" }, ["a", "b"])).toBeNull();
    expect(pickKisNumber(undefined, ["a"])).toBeNull();
  });
});

describe("redaction", () => {
  it("credential / 계좌번호를 가린다", () => {
    const out = redactKisSecrets(
      `key=${CRED.appKey} secret=${CRED.appSecret} cano=${CRED.cano} token=${TOKEN}`,
      [CRED.cano, CRED.appKey, CRED.appSecret, TOKEN],
    );
    expect(out).not.toContain(CRED.appKey);
    expect(out).not.toContain(CRED.appSecret);
    expect(out).not.toContain(CRED.cano);
    expect(out).not.toContain(TOKEN);
  });

  it("secrets 를 넘기지 않아도 긴 숫자 계좌 패턴을 가린다", () => {
    expect(redactKisSecrets("계좌 50012345678 조회 실패")).not.toContain("50012345678");
    expect(redactKisSecrets("계좌 500-12-345678 오류")).not.toContain("345678");
    // 짧은 숫자(종목코드 6자리 등)는 그대로 둔다
    expect(redactKisSecrets("종목 069500")).toContain("069500");
  });

  it("Error 객체도 문자열로 sanitize 한다", () => {
    const out = redactKisSecrets(new Error(`KIS token error 403: ${CRED.appSecret}`), [CRED.appSecret]);
    expect(out).not.toContain(CRED.appSecret);
    expect(out).toContain("403");
  });
});

describe("read-only 보장", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "kis-account-server.ts"), "utf8");

  it("주문 관련 endpoint 가 모듈에 존재하지 않는다", () => {
    for (const forbidden of ["order-cash", "order-rvsecncl", "inquire-psbl-order", "trading/order"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("POST 요청을 하지 않는다", () => {
    expect(source).not.toContain('method: "POST"');
    expect(source).not.toContain("method: 'POST'");
  });

  it("모든 호출이 GET 이다", async () => {
    const calls = mockFetch({ ...EMPTY_BALANCE, output: { dnca_tota: "0" } });
    await fetchPensionSavingsBalance(CRED, TOKEN);
    await fetchIrpPresentBalance(CRED, TOKEN);
    await fetchIrpDeposit(CRED, TOKEN);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  it("모듈에 console 호출이 없다 (URL/params 유출 방지)", () => {
    expect(source).not.toMatch(/console\.\w+\(/);
  });
});
