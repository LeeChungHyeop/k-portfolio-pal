import { describe, it, expect, vi } from "vitest";
import {
  KIS_PATH_INQUIRE_DAILY_CCLD, KIS_PATH_ORDER_CASH, TR_ID_INQUIRE_DAILY_CCLD, TR_ID_ORDER_CASH_BUY,
  inquireDailyCcld, placeCashBuyOrder, type FetchLike,
} from "./kis-order";

const CRED = { appKey: "test-app-key-0123456789", appSecret: "test-app-secret-abcdefghij", cano: "12345678" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const REQ = { ticker: "360750", quantity: 1, limitPrice: 25_985 };

describe("placeCashBuyOrder", () => {
  it("공식 예제 형식으로 POST 한다 (문자열 수량·단가, 22, 지정가)", async () => {
    const f = vi.fn<FetchLike>(async () =>
      reply({ rt_cd: "0", msg_cd: "APBK0013", msg1: "ok", output: { ODNO: "0000000009", KRX_FWDG_ORD_ORGNO: "91252", ORD_TMD: "090501" } }));
    const r = await placeCashBuyOrder(CRED, "tok", REQ, f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toContain(KIS_PATH_ORDER_CASH);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).tr_id).toBe(TR_ID_ORDER_CASH_BUY);
    expect(JSON.parse(init.body as string)).toEqual({
      CANO: "12345678", ACNT_PRDT_CD: "22", PDNO: "360750", ORD_DVSN: "00",
      ORD_QTY: "1", ORD_UNPR: "25985", EXCG_ID_DVSN_CD: "KRX",
    });
    expect(r).toMatchObject({ sent: true, httpStatus: 200, rtCd: "0", orderNo: "0000000009" });
  });

  it("입력이 이상하면 전송하지 않는다", async () => {
    const f = vi.fn<FetchLike>();
    for (const req of [
      { ticker: "36075", quantity: 1, limitPrice: 1 },
      { ticker: "360750", quantity: 0, limitPrice: 1 },
      { ticker: "360750", quantity: 1.5, limitPrice: 1 },
      { ticker: "360750", quantity: 1, limitPrice: -5 },
    ]) {
      expect((await placeCashBuyOrder(CRED, "tok", req, f)).sent).toBe(false);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("타임아웃도 재시도하지 않는다", async () => {
    const f = vi.fn<FetchLike>((_u, init) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    }));
    const r = await placeCashBuyOrder(CRED, "tok", REQ, f, 20);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: true, httpStatus: 0, timedOut: true });
  });

  it("오류 메시지에 계좌번호·키·토큰이 남지 않는다", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error(`fail ${CRED.cano} ${CRED.appKey} tok-secret-123`);
    });
    const r = await placeCashBuyOrder(CRED, "tok-secret-123", REQ, f);
    const s = JSON.stringify(r);
    expect(s).not.toContain(CRED.cano);
    expect(s).not.toContain(CRED.appKey);
    expect(s).not.toContain("tok-secret-123");
  });

  it("본문 해석 불가는 unparseable 로 전달된다", async () => {
    const f = vi.fn<FetchLike>(async () => new Response("<html>", { status: 200 }));
    expect((await placeCashBuyOrder(CRED, "tok", REQ, f)).unparseable).toBe(true);
  });
});

describe("inquireDailyCcld", () => {
  it("GET 으로 매수·종목·주문번호를 좁혀 조회하고 행을 옮긴다", async () => {
    const f = vi.fn<FetchLike>(async () => reply({
      rt_cd: "0",
      output1: [{ odno: "0000000009", pdno: "360750", ord_qty: "1", ord_unpr: "25985", tot_ccld_qty: "1",
        avg_prvs: "25985", rmn_qty: "0", cncl_yn: "N", sll_buy_dvsn_cd: "02", ord_tmd: "090501" }],
    }));
    const r = await inquireDailyCcld(CRED, "tok", { ticker: "360750", date: "20261014", orderNo: "0000000009" }, f);
    const [url, init] = f.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(url).toContain(KIS_PATH_INQUIRE_DAILY_CCLD);
    expect((init.headers as Record<string, string>).tr_id).toBe(TR_ID_INQUIRE_DAILY_CCLD);
    const q = new URL(url).searchParams;
    expect(q.get("ACNT_PRDT_CD")).toBe("22");
    expect(q.get("SLL_BUY_DVSN_CD")).toBe("02");
    expect(q.get("ODNO")).toBe("0000000009");
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ orderNo: "0000000009", filledQty: 1, orderQty: 1, cancelled: false, sideCode: "02" });
  });
  it("읽지 못한 숫자 필드는 0 이 아니라 null", async () => {
    const f = vi.fn<FetchLike>(async () => reply({ rt_cd: "0", output1: [{ odno: "1", pdno: "360750" }] }));
    const r = await inquireDailyCcld(CRED, "tok", { ticker: "360750", date: "20261014" }, f);
    expect(r.rows[0].filledQty).toBeNull();
    expect(r.rows[0].orderQty).toBeNull();
  });
  it("rt_cd != 0 이면 ok=false 이고 행을 내지 않는다", async () => {
    const f = vi.fn<FetchLike>(async () => reply({ rt_cd: "1", msg1: "err", output1: [{ odno: "1" }] }));
    const r = await inquireDailyCcld(CRED, "tok", { ticker: "360750", date: "20261014" }, f);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
  });
  it("조회 조건 형식이 틀리면 호출하지 않는다", async () => {
    const f = vi.fn<FetchLike>();
    const r = await inquireDailyCcld(CRED, "tok", { ticker: "360750", date: "2026-10-14" }, f);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("inquireDailyCcld — '전부 봤다'의 조건", () => {
  const replyH = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers });
  const Q = { ticker: "360750", date: "20261014", endDate: "20261015" };

  it("기간 조회: 종료일을 따로 보낸다", async () => {
    const f = vi.fn<FetchLike>(async () => replyH({ rt_cd: "0", output1: [] }));
    const r = await inquireDailyCcld(CRED, "tok", Q, f);
    const q = new URL(f.mock.calls[0][0]).searchParams;
    expect([q.get("INQR_STRT_DT"), q.get("INQR_END_DT"), q.get("ODNO")]).toEqual(["20261014", "20261015", ""]);
    expect(r).toMatchObject({ ok: true, listPresent: true, hasMore: false, complete: true });
  });

  it("**응답 헤더 tr_cont=M/F 는 다음 페이지가 있다는 뜻이라 complete 가 아니다**", async () => {
    for (const h of ["M", "F"]) {
      const f = vi.fn<FetchLike>(async () => replyH({ rt_cd: "0", output1: [] }, { tr_cont: h }));
      const r = await inquireDailyCcld(CRED, "tok", Q, f);
      expect(r).toMatchObject({ hasMore: true, complete: false });
    }
  });

  it("**output1 이 없으면 0건이 아니라 '모름'이다**", async () => {
    const f = vi.fn<FetchLike>(async () => replyH({ rt_cd: "0", output: [] }));
    const r = await inquireDailyCcld(CRED, "tok", Q, f);
    expect(r).toMatchObject({ ok: true, listPresent: false, complete: false });
  });

  it("한 페이지 한도(100행)에 닿으면 complete 가 아니다", async () => {
    const rows = Array.from({ length: 100 }, (_, n) => ({ odno: String(n + 1), pdno: "360750" }));
    const f = vi.fn<FetchLike>(async () => replyH({ rt_cd: "0", output1: rows }));
    expect((await inquireDailyCcld(CRED, "tok", Q, f)).complete).toBe(false);
  });

  it("주문일(ord_dt)을 행에 옮긴다", async () => {
    const f = vi.fn<FetchLike>(async () => replyH({ rt_cd: "0", output1: [{ odno: "1", pdno: "360750", ord_dt: "20261014" }] }));
    expect((await inquireDailyCcld(CRED, "tok", Q, f)).rows[0].orderDate).toBe("20261014");
  });

  it("종료일이 시작일보다 앞서면 호출하지 않는다", async () => {
    const f = vi.fn<FetchLike>();
    const r = await inquireDailyCcld(CRED, "tok", { ...Q, endDate: "20261013" }, f);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
