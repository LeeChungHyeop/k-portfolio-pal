import { describe, it, expect } from "vitest";
import {
  ORDER_POLICY, canTransition, checkPolicy, classifyPlaceResponse, constantTimeEqual,
  hashApprovalToken, idempotencyKeyOf, isTerminal, judgeExecution, newApprovalToken,
  type ExecutionRow, type OrderState,
} from "./order-intent";

const row = (o: Partial<ExecutionRow> = {}): ExecutionRow => ({
  orderNo: "0000000001", ticker: "360750", orderQty: 1, orderPrice: 25_985, orderTime: "090501",
  filledQty: 0, avgPrice: null, remainingQty: 1, cancelled: false, sideCode: "02", ...o,
});
const P = { ticker: "360750", quantity: 1, limitPrice: 25_985 };
const intent = { orderNo: null as string | null, ticker: "360750", quantity: 1, limitPrice: 25_985 };

describe("정책", () => {
  it("첫 실주문은 360750 · 1주 · 지정가 · 매수로 제한된다", () => {
    expect(ORDER_POLICY).toMatchObject({
      productCode: "22", ordDvsn: "00", allowedTickers: ["360750"], maxQuantity: 1,
    });
    expect(checkPolicy({ ticker: "360750", quantity: 1, limitPrice: 25_985 })).toEqual([]);
    expect(checkPolicy({ ticker: "367380", quantity: 1, limitPrice: 25_985 }).length).toBeGreaterThan(0);
    expect(checkPolicy({ ticker: "360750", quantity: 2, limitPrice: 25_985 }).length).toBeGreaterThan(0);
    expect(checkPolicy({ ticker: "360750", quantity: 1, limitPrice: 0 }).length).toBeGreaterThan(0);
  });
  it("정책 객체는 변경할 수 없다", () => {
    expect(Object.isFrozen(ORDER_POLICY)).toBe(true);
  });
});

describe("상태 전이", () => {
  it("종결 상태에서는 어디로도 가지 않는다", () => {
    const all: OrderState[] = ["proposed", "submitting", "accepted", "rejected", "unknown", "open",
      "partially_filled", "filled", "cancelled", "expired"];
    for (const s of all.filter(isTerminal)) {
      for (const t of all) expect(canTransition(s, t)).toBe(false);
    }
  });
  it("전송 전 의도는 곧바로 체결될 수 없다", () => {
    expect(canTransition("proposed", "filled")).toBe(false);
    expect(canTransition("proposed", "accepted")).toBe(false);
    expect(canTransition("proposed", "submitting")).toBe(true);
  });
  it("unknown 은 거부로 가지 않는다 (조회로만 해소)", () => {
    expect(canTransition("unknown", "rejected")).toBe(false);
    expect(canTransition("unknown", "open")).toBe(true);
  });
  it("접수 상태에서 다시 submitting 으로 돌아갈 수 없다", () => {
    expect(canTransition("accepted", "submitting")).toBe(false);
    expect(canTransition("unknown", "submitting")).toBe(false);
  });
});

describe("멱등 키 · 승인 토큰", () => {
  it("같은 주문은 같은 키, 단가가 다르면 다른 키", () => {
    const a = idempotencyKeyOf("bai:x", "2026-10-14", P, 1);
    expect(idempotencyKeyOf("bai:x", "2026-10-14", P, 1)).toBe(a);
    expect(idempotencyKeyOf("bai:x", "2026-10-14", { ...P, limitPrice: 26_000 }, 1)).not.toBe(a);
    expect(idempotencyKeyOf("bai:x", "2026-10-14", P, 2)).not.toBe(a);
  });
  it("토큰은 매번 다르고 해시는 원문과 다르며 결정적이다", async () => {
    const t1 = newApprovalToken();
    expect(t1).not.toBe(newApprovalToken());
    expect(t1.length).toBeGreaterThanOrEqual(32);
    const h = await hashApprovalToken(t1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t1);
    expect(await hashApprovalToken(t1)).toBe(h);
  });
  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("classifyPlaceResponse — 불명은 거부가 아니다", () => {
  it("정상 접수", () => {
    expect(classifyPlaceResponse({ httpStatus: 200, rtCd: "0", orderNo: "0000000001" }))
      .toMatchObject({ kind: "accepted", orderNo: "0000000001" });
  });
  it("rt_cd != 0 은 거부", () => {
    expect(classifyPlaceResponse({ httpStatus: 200, rtCd: "1", msgCd: "X", msg1: "no" }).kind).toBe("rejected");
  });
  it.each([
    ["타임아웃", { httpStatus: 0, transportError: "aborted", timedOut: true }],
    ["네트워크 오류", { httpStatus: 0, transportError: "ECONNRESET" }],
    ["HTTP 500", { httpStatus: 500 }],
    ["HTTP 502 + rt_cd 1", { httpStatus: 502, rtCd: "1" }],
    ["본문 해석 불가", { httpStatus: 200, unparseable: true }],
    ["rt_cd 없음", { httpStatus: 200 }],
    ["rt_cd 0 인데 주문번호 없음", { httpStatus: 200, rtCd: "0", orderNo: null }],
    ["rt_cd 0 인데 빈 주문번호", { httpStatus: 200, rtCd: "0", orderNo: "" }],
  ])("%s → unknown", (_n, r) => {
    expect(classifyPlaceResponse(r as never).kind).toBe("unknown");
  });
});

describe("judgeExecution", () => {
  it("주문번호로 대응하고 체결 수량으로 상태를 정한다", () => {
    const i = { ...intent, orderNo: "0000000001" };
    expect(judgeExecution(i, [row()])).toMatchObject({ kind: "matched", state: "open", matchedBy: "order_no" });
    expect(judgeExecution({ ...i, quantity: 10 }, [row({ orderQty: 10, filledQty: 4 })]))
      .toMatchObject({ state: "partially_filled", filledQty: 4 });
    expect(judgeExecution(i, [row({ filledQty: 1, avgPrice: 25_985 })]))
      .toMatchObject({ state: "filled", filledQty: 1 });
  });
  it("주문번호를 알면 다른 조건이 같은 다른 주문은 보지 않는다", () => {
    expect(judgeExecution({ ...intent, orderNo: "A" }, [row({ orderNo: "B", filledQty: 1 })]).kind).toBe("not_found");
  });
  it("번호를 모르면 조건이 같아도 후보일 뿐 체결·접수로 확정하지 않는다", () => {
    // 체결 수량이 있어도 마찬가지다 — 수동매매일 수 있다.
    expect(judgeExecution(intent, [row({ filledQty: 1 })])).toEqual({ kind: "candidate", count: 1 });
    expect(judgeExecution(intent, [row(), row({ orderNo: "2" })])).toEqual({ kind: "candidate", count: 2 });
  });
  it("주문시각은 후보 필터로만 쓴다 — 전송 이전 행은 후보가 아니고, 이후여도 확정하지 않는다", () => {
    // 전송 시작 KST 14:00:00 (UTC 05:00:00)
    const i = { ...intent, submitStartedAt: "2026-10-14T05:00:00.000Z" };
    expect(judgeExecution(i, [row({ orderTime: "090501" })])).toEqual({ kind: "not_found" });
    expect(judgeExecution(i, [row({ orderTime: "140010" })])).toEqual({ kind: "candidate", count: 1 });
    expect(judgeExecution(i, [row({ orderTime: null })])).toEqual({ kind: "candidate", count: 1 });
  });
  it("매도 행·다른 종목·다른 단가는 대응하지 않는다", () => {
    expect(judgeExecution(intent, [row({ sideCode: "01" })]).kind).toBe("not_found");
    expect(judgeExecution(intent, [row({ ticker: "367380" })]).kind).toBe("not_found");
    expect(judgeExecution(intent, [row({ orderPrice: 26_000 })]).kind).toBe("not_found");
  });
  it("0건은 not_found", () => {
    expect(judgeExecution(intent, [])).toEqual({ kind: "not_found" });
  });
  it("수량을 읽지 못하면 unreadable (체결 주장 금지)", () => {
    const i = { ...intent, orderNo: "0000000001" };
    expect(judgeExecution(i, [row({ filledQty: null })]).kind).toBe("unreadable");
    expect(judgeExecution(i, [row({ orderQty: null })]).kind).toBe("unreadable");
  });
  it("취소 플래그는 cancelled", () => {
    expect(judgeExecution({ ...intent, orderNo: "0000000001" }, [row({ cancelled: true })]))
      .toMatchObject({ state: "cancelled" });
  });
});
