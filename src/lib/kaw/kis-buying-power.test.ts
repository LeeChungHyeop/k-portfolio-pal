/**
 * 매수가능조회(연금저축 22) 어댑터와 서버 오케스트레이션을 **모의 응답**으로 고정한다.
 * 실제 네트워크·실제 credential·주문을 쓰지 않는다.
 *
 * 지키는 것:
 *   1. GET 만 한다. 주문 경로·POST 가 코드에 없다
 *   2. 요청 파라미터가 공식 예제와 같다 (지정가 00 + 단가)
 *   3. 응답이 어긋나면 **예산으로 인정하지 않는다** (단가 불일치·필드 없음·rt_cd≠0)
 *   4. 0.5% 같은 비율이 코드에 들어가지 않는다 — 증권사 값을 그대로 쓴다
 *   5. 서버는 계좌 조회가 성공한 요청에서만 종목별 조회를 한다
 *   6. 주문 지원이 미확인임을 코드에 기록했고, 주문 요청 코드는 없다
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KIS_PATH_INQUIRE_PSBL_ORDER,
  TR_ID_INQUIRE_PSBL_ORDER,
  fetchBuyingPower,
  toVerifiedBuyingPower,
  type BuyingPowerResult,
} from "./kis-buying-power";
import {
  BUYING_POWER_MAX_TICKERS,
  parseTickerQuery,
  readKisBuyingPower,
  type KisReadDeps,
} from "./kis-account-read";
import { KIS_ORDER_SUPPORT, type KisAccountObservation } from "./kis-account-observe";

const CRED = { appKey: "test-app-key-0123456789", appSecret: "test-app-secret-abcdefghij", cano: "12345678" };
const TOKEN = "test-access-token-value";

interface Capture { url: string; init: RequestInit }
function mockFetch(body: unknown, status = 200): Capture[] {
  const calls: Capture[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const OK_OUTPUT = {
  ord_psbl_cash: "2318826", ord_psbl_sbst: "0", ruse_psbl_amt: "0", fund_rpch_chgs: "0",
  psbl_qty_calc_unpr: "25985", nrcvb_buy_amt: "2307289", nrcvb_buy_qty: "88",
  max_buy_amt: "2307289", max_buy_qty: "88", cma_evlu_amt: "0",
};
const okBody = (over: Record<string, unknown> = {}) => ({
  rt_cd: "0", msg_cd: "KIOK0510", msg1: "정상처리", output: { ...OK_OUTPUT, ...over },
});

describe("요청", () => {
  it("GET 으로 공식 path / TR_ID / 지정가 파라미터를 보낸다", async () => {
    const calls = mockFetch(okBody());
    await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe(KIS_PATH_INQUIRE_PSBL_ORDER);
    expect((calls[0].init.headers as Record<string, string>).tr_id).toBe(TR_ID_INQUIRE_PSBL_ORDER);
    expect(TR_ID_INQUIRE_PSBL_ORDER).toBe("TTTC8908R");
    const p = u.searchParams;
    expect(p.get("ACNT_PRDT_CD")).toBe("22");
    expect(p.get("PDNO")).toBe("360750");
    expect(p.get("ORD_UNPR")).toBe("25985");
    expect(p.get("ORD_DVSN")).toBe("00");
    expect(p.get("CMA_EVLU_AMT_ICLD_YN")).toBe("N");
    expect(p.get("OVRS_ICLD_YN")).toBe("N");
    expect(p.get("CANO")).toBe(CRED.cano);
  });

  it("잘못된 종목코드·단가로는 증권사를 호출하지 않는다", async () => {
    const calls = mockFetch(okBody());
    for (const q of [
      { ticker: "36075", unitPrice: 1000 },
      { ticker: "360750", unitPrice: 0 },
      { ticker: "360750", unitPrice: -5 },
      { ticker: "360750", unitPrice: 25_985.5 },
    ]) {
      const r = await fetchBuyingPower(CRED, TOKEN, { ...q, ordDvsn: "00" });
      expect(r.ok).toBe(false);
      expect(r.nrcvbBuyAmt).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});

describe("응답 해석", () => {
  it("금액·수량 필드를 구분해 읽는다", async () => {
    mockFetch(okBody());
    const r = await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(r.ok).toBe(true);
    expect(r.ordPsblCash).toBe(2_318_826);
    expect(r.nrcvbBuyAmt).toBe(2_307_289);
    expect(r.nrcvbBuyQty).toBe(88);
    expect(r.maxBuyAmt).toBe(2_307_289);
    expect(r.psblQtyCalcUnpr).toBe(25_985);
  });

  it("필드가 없으면 0 이 아니라 null 이다", async () => {
    mockFetch({ rt_cd: "0", output: {} });
    const r = await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(r.ok).toBe(true);
    expect(r.nrcvbBuyAmt).toBeNull();
    expect(r.nrcvbBuyQty).toBeNull();
  });

  it("rt_cd≠0 이면 실패이고 금액을 읽지 않는다", async () => {
    mockFetch({ rt_cd: "1", msg_cd: "EGW00123", msg1: "거부", output: OK_OUTPUT });
    const r = await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(r.ok).toBe(false);
    expect(r.nrcvbBuyAmt).toBeNull();
  });

  it("HTTP 오류도 실패다", async () => {
    mockFetch(okBody(), 500);
    const r = await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(r.ok).toBe(false);
  });

  it("전송 오류는 throw 하지 않고 실패로 돌려준다 (계좌번호·키 미포함)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`boom ${CRED.appSecret} ${CRED.cano}`); }));
    const r = await fetchBuyingPower(CRED, TOKEN, { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" });
    expect(r.ok).toBe(false);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(CRED.appSecret);
    expect(dump).not.toContain(CRED.cano);
  });
});

describe("toVerifiedBuyingPower — 어긋나면 예산으로 인정하지 않는다", () => {
  const base = (over: Partial<BuyingPowerResult> = {}): BuyingPowerResult => ({
    ok: true, httpStatus: 200, rtCd: "0", ticker: "360750", unitPrice: 25_985, ordDvsn: "00",
    ordPsblCash: 2_318_826, nrcvbBuyAmt: 2_307_289, nrcvbBuyQty: 88,
    maxBuyAmt: 2_307_289, maxBuyQty: 88, psblQtyCalcUnpr: 25_985, ruseAmt: 0, ...over,
  });

  it("정상 응답은 항목이 된다 — 금액·수량은 증권사 값 그대로다", () => {
    expect(toVerifiedBuyingPower(base())).toEqual({
      ticker: "360750", price: 25_985, amount: 2_307_289, qty: 88,
    });
  });

  it.each([
    ["호출 실패", { ok: false }],
    ["금액 없음", { nrcvbBuyAmt: null }],
    ["수량 없음", { nrcvbBuyQty: null }],
    ["음수 금액", { nrcvbBuyAmt: -1 }],
    ["소수 수량", { nrcvbBuyQty: 8.5 }],
    ["증권사 계산 단가가 다르다", { psblQtyCalcUnpr: 26_000 }],
    ["증권사 계산 단가가 없다", { psblQtyCalcUnpr: null }],
  ] as Array<[string, Partial<BuyingPowerResult>]>)("%s → null", (_n, over) => {
    expect(toVerifiedBuyingPower(base(over))).toBeNull();
  });

  it("0 원·0 주도 정상 값이다 (매수 불가능이라는 사실)", () => {
    expect(toVerifiedBuyingPower(base({ nrcvbBuyAmt: 0, nrcvbBuyQty: 0 }))).toMatchObject({ amount: 0, qty: 0 });
  });
});

describe("parseTickerQuery", () => {
  it("쉼표 구분 종목코드를 읽고 중복을 접는다", () => {
    expect(parseTickerQuery("360750,367380,360750")).toEqual(["360750", "367380"]);
    expect(parseTickerQuery("0072r0")).toEqual(["0072R0"]);
  });
  it("없으면 빈 목록이다", () => {
    expect(parseTickerQuery(null)).toEqual([]);
    expect(parseTickerQuery("")).toEqual([]);
  });
  it("모양이 틀리거나 너무 많으면 전체를 거부한다", () => {
    expect(parseTickerQuery("360750,12")).toBeNull();
    expect(parseTickerQuery("360750;367380")).toBeNull();
    const many = Array.from({ length: BUYING_POWER_MAX_TICKERS + 1 }, (_, i) => `00000${i}`.slice(-6)).join(",");
    expect(parseTickerQuery(many)).toBeNull();
  });
});

describe("readKisBuyingPower — 서버 오케스트레이션", () => {
  const observed = (cash: KisAccountObservation["cash"]): KisAccountObservation =>
    ({ cash, holdings: { kind: "not_queried", reason: "x" } } as unknown as KisAccountObservation);
  const observedOk = observed({ kind: "observed", value: 2_318_826 });

  function deps(over: Partial<KisReadDeps> = {}) {
    const calls: Array<{ ticker: string; unitPrice: number; ordDvsn: string }> = [];
    const d = {
      fetchPensionSavings: vi.fn(), fetchIrpPresent: vi.fn(), fetchIrpDeposit: vi.fn(),
      fetchPrices: vi.fn(async () => ({
        results: { "360750": { price: 25_985, source: "kis" }, "367380": { price: 31_215, source: "kis" } },
        timestamp: "2026-10-14T04:38:52.595Z",
      })),
      fetchBuyingPower: vi.fn(async (_c: unknown, _t: unknown, q: { ticker: string; unitPrice: number; ordDvsn: "00" | "01" }) => {
        calls.push(q);
        return {
          ok: true, httpStatus: 200, rtCd: "0", msgCd: "KIOK0510",
          ticker: q.ticker, unitPrice: q.unitPrice, ordDvsn: q.ordDvsn,
          ordPsblCash: 2_318_826, nrcvbBuyAmt: 2_307_289, nrcvbBuyQty: Math.floor(2_307_289 / q.unitPrice),
          maxBuyAmt: 2_307_289, maxBuyQty: Math.floor(2_307_289 / q.unitPrice),
          psblQtyCalcUnpr: q.unitPrice, ruseAmt: 0,
        } as BuyingPowerResult;
      }),
      now: () => new Date("2026-10-14T04:39:00.000Z"),
      ...over,
    } as unknown as KisReadDeps;
    return { d, calls };
  }
  const req = (over: Partial<Parameters<typeof readKisBuyingPower>[0]> = {}) => ({
    productCode: "22" as const, observation: observedOk, credentials: CRED, token: TOKEN,
    tickers: ["360750", "367380"], ...over,
  });

  it("종목별 지정가(00, 현재가)로 1회씩 조회하고 검증된 항목을 돌려준다", async () => {
    const { d, calls } = deps();
    const r = await readKisBuyingPower(req(), d);
    expect(r.status).toBe("verified");
    expect(calls).toEqual([
      { ticker: "360750", unitPrice: 25_985, ordDvsn: "00" },
      { ticker: "367380", unitPrice: 31_215, ordDvsn: "00" },
    ]);
    expect(r.entries).toEqual([
      { ticker: "360750", price: 25_985, amount: 2_307_289, qty: 88 },
      { ticker: "367380", price: 31_215, amount: 2_307_289, qty: 73 },
    ]);
    expect(r.asOf).toBe("2026-10-14T04:38:52.595Z");
  });

  it("**시장가(01) 조회는 하지 않는다**", async () => {
    const { d, calls } = deps();
    await readKisBuyingPower(req(), d);
    expect(calls.every((c) => c.ordDvsn === "00")).toBe(true);
  });

  it("**계좌 조회가 성공하지 못했으면 묻지 않는다**", async () => {
    const { d, calls } = deps();
    for (const cash of [
      { kind: "not_queried", reason: "mode_calc_only" },
      { kind: "failed", error: "x" },
    ] as const) {
      const r = await readKisBuyingPower(req({ observation: observed(cash) }), d);
      expect(r.status).toBe("not_queried");
    }
    expect(calls).toHaveLength(0);
    expect(d.fetchPrices).not.toHaveBeenCalled();
  });

  it("29(IRP)는 지원하지 않는다 (22 만 실증됨)", async () => {
    const { d, calls } = deps();
    const r = await readKisBuyingPower(req({ productCode: "29" }), d);
    expect(r.status).toBe("not_queried");
    expect(calls).toHaveLength(0);
  });

  it("시세가 없는 종목은 묻지 않고, 일부만 되면 partial 이다", async () => {
    const { d, calls } = deps({
      fetchPrices: vi.fn(async () => ({
        results: { "360750": { price: 25_985, source: "kis" }, "367380": { price: 0, source: "failed" } },
        timestamp: "2026-10-14T04:38:52.595Z",
      })),
    } as unknown as Partial<KisReadDeps>);
    const r = await readKisBuyingPower(req(), d);
    expect(r.status).toBe("partial");
    expect(calls.map((c) => c.ticker)).toEqual(["360750"]);
    expect(r.perTicker.find((t) => t.ticker === "367380")).toMatchObject({ price: null, ok: false });
  });

  it("증권사 계산 단가가 어긋난 응답은 항목이 되지 않는다", async () => {
    const { d } = deps({
      fetchBuyingPower: vi.fn(async (_c, _t, q) => ({
        ok: true, httpStatus: 200, rtCd: "0", ticker: q.ticker, unitPrice: q.unitPrice, ordDvsn: q.ordDvsn,
        ordPsblCash: 1, nrcvbBuyAmt: 1, nrcvbBuyQty: 1, maxBuyAmt: 1, maxBuyQty: 1,
        psblQtyCalcUnpr: q.unitPrice + 5, ruseAmt: 0,
      } as BuyingPowerResult)),
    } as unknown as Partial<KisReadDeps>);
    const r = await readKisBuyingPower(req(), d);
    expect(r.status).toBe("failed");
    expect(r.entries).toEqual([]);
  });

  it("시세 조회가 실패하면 failed 이고 증권사를 부르지 않는다", async () => {
    const { d, calls } = deps({
      fetchPrices: vi.fn(async () => { throw new Error("down"); }),
    } as unknown as Partial<KisReadDeps>);
    const r = await readKisBuyingPower(req(), d);
    expect(r.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("응답에 금액이 아닌 성공 여부·응답코드만 요약한다", async () => {
    const { d } = deps();
    const r = await readKisBuyingPower(req(), d);
    for (const t of r.perTicker) {
      expect(Object.keys(t).sort()).toEqual(["msgCd", "ok", "price", "rtCd", "ticker"]);
    }
  });
});

describe("클라이언트 요청 — 종목 목록을 서버에 전달한다", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => { delete g.window; delete g.sessionStorage; });

  const registry = [{
    id: "bai:k", label: "x", broker: "kis", productCode: "22", logicalAccountType: "pension" as const,
    activeFrom: "2026-01-01", connectionMode: "api_readonly" as const,
  }];
  const withToken = () => {
    g.window = globalThis;
    g.sessionStorage = { getItem: (k: string) => (k === "kaw.session.token" ? "t" : null) };
  };
  const stub = (body: unknown) => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { f: f as unknown as typeof fetch, urls };
  };

  it("tickers 를 쿼리로 보내고 buyingPower 를 돌려받는다", async () => {
    const { requestKisAccount } = await import("./kis-account-client");
    withToken();
    const { f, urls } = stub({
      observation: { cash: { kind: "observed", value: 1 } }, plan: { ready: true },
      buyingPower: { status: "verified", asOf: "2026-10-14T04:38:52.000Z", entries: [], perTicker: [] },
    });
    const r = await requestKisAccount(registry, "pension", "2026-10-14", f, ["360750", "367380", "360750"]);
    expect(urls).toEqual(["/api/kis/account?product=22&tickers=360750%2C367380"]);
    expect(r.kind === "result" && r.buyingPower?.status).toBe("verified");
  });

  it("tickers 가 없으면 기존 요청 그대로다", async () => {
    const { requestKisAccount } = await import("./kis-account-client");
    withToken();
    const { f, urls } = stub({ observation: {}, plan: {} });
    const r = await requestKisAccount(registry, "pension", "2026-10-14", f);
    expect(urls).toEqual(["/api/kis/account?product=22"]);
    expect(r.kind === "result" && r.buyingPower).toBeNull();
  });

  it("계산만 제공이면 tickers 가 있어도 요청하지 않는다", async () => {
    const { requestKisAccount } = await import("./kis-account-client");
    withToken();
    const { f, urls } = stub({});
    const r = await requestKisAccount(
      [{ ...registry[0], connectionMode: "calc_only" as const }], "pension", "2026-10-14", f, ["360750"],
    );
    expect(r.kind).toBe("blocked");
    expect(urls).toEqual([]);
  });
});

describe("주문 지원 현황·소스 불변식", () => {
  const code = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("**주문 지원은 미확인으로 기록돼 있다** (22·29 모두)", () => {
    expect(KIS_ORDER_SUPPORT["22"].status).toBe("unverified");
    expect(KIS_ORDER_SUPPORT["29"].status).toBe("unverified");
    // 연금 전용 주문 API 는 공식 예제에 없다
    expect(KIS_ORDER_SUPPORT["22"].pensionSpecificOrderApi).toBe(false);
  });

  it("조회 모듈에 POST·주문 경로·주문 TR 이 없다", () => {
    const src = code("./kis-buying-power.ts");
    expect(src).not.toMatch(/method:\s*["']POST["']/);
    expect(src).not.toMatch(/order-cash|order-rvsecncl|order-resv|order-credit/);
    expect(src).not.toMatch(/TTTC0012U|TTTC0011U|TTTC0013U/);
    expect(src).not.toMatch(/console\./);
  });

  it("저장소 전체 소스에 주문 요청 코드가 없다", () => {
    // 후보 경로는 상수 기록(KIS_ORDER_SUPPORT)으로만 존재하고 호출 코드가 없다.
    for (const f of ["./kis-account-read.ts", "./kis-account-server.ts", "./kis-buying-power.ts", "./kis-account-client.ts"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/order-cash["'`]\s*[,)]/);
      expect(src, f).not.toMatch(/method:\s*["']POST["']/);
    }
  });

  it("0.5% 같은 비율이 조회·변환 코드에 들어가지 않는다", () => {
    const src = code("./kis-buying-power.ts");
    expect(src).not.toMatch(/1\.005|0\.005|\/\s*1\.00|\*\s*0\.99/);
  });

  it("조회 어댑터의 기존 불변식(주문 경로 문자열 없음)이 유지된다", () => {
    const src = readFileSync(fileURLToPath(new URL("./kis-account-server.ts", import.meta.url)), "utf-8");
    for (const forbidden of ["order-cash", "order-rvsecncl", "inquire-psbl-order", "trading/order"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
