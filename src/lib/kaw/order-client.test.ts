/**
 * 승인형 주문 UI 의 판단 로직 — 가짜 fetch 로 고정한다. 실제 네트워크·주문을 쓰지 않는다.
 * (테스트 런타임이 node 라 React 를 렌더링하지 않는다. 화면 구조는 order-approval-ui.test.ts)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrokerAccountInstance } from "./broker-account";

vi.mock("./auth", () => ({ getSessionToken: () => "session-token" }));

const {
  INITIAL_FLOW, ORDER_TARGET, describeOrder, flowReducer, isOrderUiEnabled, orderUiGate,
  requestPrepare, requestStatus, requestSubmit, secondsLeft, verifyPrepared,
} = await import("./order-client");
import type { ConfirmView, FlowState, IntentView } from "./order-client";

const INSTANCE: BrokerAccountInstance = {
  id: "bai:kis-pension", label: "한국투자 연금저축", broker: "kis", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-01-01", connectionMode: "api_readonly",
};
const TODAY = "2026-10-14";

const intent = (o: Partial<IntentView> = {}): IntentView => ({
  id: "i1", state: "proposed", ticker: "360750", quantity: 1, limitPrice: 25_985, amount: 25_985,
  side: "buy", ordDvsn: "00", accountInstanceId: INSTANCE.id, attempt: 1, orderNo: null, orderTime: null,
  approvalExpiresAt: "2026-10-14T05:02:00.000Z", evidence: null, lastInquiryAt: null, ambiguous: false,
  lastError: null, executionConfirmed: false, ledgerEligible: false, ...o,
});
const confirmOf = (i: IntentView): ConfirmView => ({
  ticker: i.ticker, quantity: i.quantity, limitPrice: i.limitPrice, amount: i.amount,
  accountInstanceId: i.accountInstanceId,
});
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ── 노출 조건 ───────────────────────────────────────────────────────────────

describe("노출 조건 — 기본 OFF", () => {
  it("빌드 flag 가 정확히 on 일 때만 켜진다", () => {
    for (const v of [undefined, "", "off", "true", "1", "ON", false]) expect(isOrderUiEnabled(v)).toBe(false);
    expect(isOrderUiEnabled("on")).toBe(true);
  });
  it("flag 가 꺼져 있으면 계좌가 완벽해도 숨긴다", () => {
    expect(orderUiGate([INSTANCE], TODAY, undefined)).toEqual({ visible: false, reason: "ui_disabled" });
  });
  it("연금저축 api 모드 + flag on 이면 보인다", () => {
    expect(orderUiGate([INSTANCE], TODAY, "on")).toMatchObject({ visible: true });
  });
  it.each([
    ["계산만 제공", [{ ...INSTANCE, connectionMode: "calc_only" as const }], "mode_calc_only"],
    ["미등록", [], "instance_unregistered"],
    ["타 증권사", [{ ...INSTANCE, broker: "other" as never }], "broker_not_kis"],
    ["시작 전", [{ ...INSTANCE, activeFrom: "2026-12-01" }], "instance_not_active"],
    ["상품코드 불일치", [{ ...INSTANCE, productCode: "29" }], "product_mismatch"],
  ])("%s 이면 숨긴다", (_n, reg, reason) => {
    expect(orderUiGate(reg as BrokerAccountInstance[], TODAY, "on")).toEqual({ visible: false, reason });
  });
  it("IRP(29) 계좌만 있으면 숨긴다", () => {
    const irp = { ...INSTANCE, id: "bai:irp", logicalAccountType: "irp" as const, productCode: "29" };
    expect(orderUiGate([irp], TODAY, "on").visible).toBe(false);
  });
  it("대상은 360750 1주 하나로 고정돼 있다", () => {
    expect(ORDER_TARGET).toMatchObject({ accountType: "pension", productCode: "22", ticker: "360750", quantity: 1 });
    expect(Object.isFrozen(ORDER_TARGET)).toBe(true);
  });
});

// ── 상태기계 ────────────────────────────────────────────────────────────────

function toFinal(): FlowState {
  let s = flowReducer(INITIAL_FLOW, { type: "start_prepare" });
  const i = intent();
  s = flowReducer(s, { type: "prepared", intent: i, token: "tok", confirm: confirmOf(i) });
  return flowReducer(s, { type: "acknowledge" });
}

describe("3단계 상태기계 — 최종 승인 전에는 전송 관문이 열리지 않는다", () => {
  it("준비 → 확인 → 최종 승인 순서로만 진행한다", () => {
    let s = flowReducer(INITIAL_FLOW, { type: "start_prepare" });
    expect(s.phase).toBe("preparing");
    const i = intent();
    s = flowReducer(s, { type: "prepared", intent: i, token: "tok", confirm: confirmOf(i) });
    expect(s.phase).toBe("review");
    s = flowReducer(s, { type: "acknowledge" });
    expect(s.phase).toBe("final");
  });

  it("**준비·확인 단계에서 begin_submit 은 통과하지 못한다** (같은 객체 = 전송 금지)", () => {
    const idle = INITIAL_FLOW;
    expect(flowReducer(idle, { type: "begin_submit" })).toBe(idle);
    const preparing = flowReducer(idle, { type: "start_prepare" });
    expect(flowReducer(preparing, { type: "begin_submit" })).toBe(preparing);
    const i = intent();
    const review = flowReducer(preparing, { type: "prepared", intent: i, token: "t", confirm: confirmOf(i) });
    expect(flowReducer(review, { type: "begin_submit" })).toBe(review);
  });

  it("**확인 단계를 건너뛰어 최종 승인으로 갈 수 없다**", () => {
    const preparing = flowReducer(INITIAL_FLOW, { type: "start_prepare" });
    expect(flowReducer(preparing, { type: "acknowledge" })).toBe(preparing);
    expect(flowReducer(INITIAL_FLOW, { type: "acknowledge" })).toBe(INITIAL_FLOW);
  });

  it("**더블클릭: 두 번째 begin_submit 은 통과하지 못한다**", () => {
    const final = toFinal();
    const sending = flowReducer(final, { type: "begin_submit" });
    expect(sending.phase).toBe("sending");
    expect(flowReducer(sending, { type: "begin_submit" })).toBe(sending);
  });

  it("전송 후 결과를 받기 전에는 준비/재주문 이벤트가 먹히지 않는다", () => {
    const sending = flowReducer(toFinal(), { type: "begin_submit" });
    expect(flowReducer(sending, { type: "start_prepare" })).toBe(sending);
    expect(flowReducer(sending, { type: "reset" })).toBe(sending);
  });

  it("토큰이 없으면(새로고침 직후) 최종 승인으로 전송할 수 없다", () => {
    const final = { ...toFinal(), token: null };
    expect(flowReducer(final, { type: "begin_submit" })).toBe(final);
  });

  it("뒤로 가면 토큰을 버린다", () => {
    const s = flowReducer(toFinal(), { type: "back" });
    expect(s).toEqual(INITIAL_FLOW);
    expect(s.token).toBeNull();
  });

  it("승인 기한이 지나면 처음으로 돌아가고 토큰이 없다", () => {
    const s = flowReducer(toFinal(), { type: "expired" });
    expect(s.phase).toBe("idle");
    expect(s.token).toBeNull();
    expect(s.message).toContain("전송되지 않았습니다");
  });

  it("**응답 유실(submit_lost)은 불명으로 남고 새 주문 준비가 열리지 않는다**", () => {
    const sending = flowReducer(toFinal(), { type: "begin_submit" });
    const lost = flowReducer(sending, { type: "submit_lost", intent: null });
    expect(lost.phase).toBe("done");
    expect(lost.lost).toBe(true);
    expect(lost.token).toBeNull();
    expect(flowReducer(lost, { type: "reset" })).toBe(lost);
    expect(flowReducer(lost, { type: "start_prepare" })).toBe(lost);
  });

  it("거부·만료된 주문만 새 준비로 돌아갈 수 있다", () => {
    const rejected = flowReducer(flowReducer(INITIAL_FLOW, { type: "start_prepare" }), {
      type: "existing", intent: intent({ state: "rejected" }),
    });
    expect(flowReducer(rejected, { type: "reset" }).phase).toBe("idle");
    for (const st of ["accepted", "open", "partially_filled", "unknown", "submitting", "filled"] as const) {
      const d = flowReducer(flowReducer(INITIAL_FLOW, { type: "start_prepare" }), {
        type: "existing", intent: intent({ state: st }),
      });
      expect(flowReducer(d, { type: "reset" })).toBe(d);
    }
  });

  it("새로고침 뒤 저장된 id 로 상태를 이어 보면 done 으로 간다", () => {
    const s = flowReducer(INITIAL_FLOW, { type: "resumed", intent: intent({ state: "accepted", orderNo: "1" }) });
    expect(s.phase).toBe("done");
    expect(s.token).toBeNull();
  });
});

// ── 상태 표시 구분 ──────────────────────────────────────────────────────────

describe("describeOrder — 접수/미체결/부분체결/체결/불명 구분", () => {
  const ev = { filledQty: 1, avgPrice: 25_985, matchedBy: "order_no" };
  it("접수는 체결이 아니다", () => {
    const d = describeOrder(intent({ state: "accepted", orderNo: "1" }));
    expect(d.label).toBe("접수");
    expect(d.executionConfirmed).toBe(false);
    expect(d.headline).toContain("체결된 것은 아닙니다");
    expect(d.canPrepareAgain).toBe(false);
  });
  it("미체결 / 부분체결 / 체결이 서로 다르다", () => {
    const open = describeOrder(intent({ state: "open", orderNo: "1" }));
    const part = describeOrder(intent({
      state: "partially_filled", orderNo: "1", quantity: 10, evidence: { ...ev, filledQty: 4 }, executionConfirmed: true,
    }));
    const full = describeOrder(intent({ state: "filled", orderNo: "1", evidence: ev, executionConfirmed: true }));
    expect([open.label, part.label, full.label]).toEqual(["미체결", "부분체결", "체결"]);
    expect(part.headline).toContain("4주");
    expect(open.executionConfirmed).toBe(false);
    expect(full.executionConfirmed).toBe(true);
  });
  it("체결 증거가 없으면 서버가 filled 라고 해도 체결 확인으로 표시하지 않는다", () => {
    const d = describeOrder(intent({ state: "filled", orderNo: "1", evidence: null, executionConfirmed: true }));
    expect(d.executionConfirmed).toBe(false);
  });
  it("불명은 재주문을 열지 않고 조회를 권한다", () => {
    const d = describeOrder(intent({ state: "unknown" }));
    expect(d.label).toBe("불명");
    expect(d.canPrepareAgain).toBe(false);
    expect(d.canInquire).toBe(true);
    expect(d.detail).toContain("다시 주문하지");
  });
  it("**주문번호 없는 후보만 있으면 '확인 필요' 이고 체결로 표시하지 않는다**", () => {
    const d = describeOrder(intent({
      state: "unknown", ambiguous: true, orderNo: null, needsUserConfirmation: true,
    }));
    expect(d.label).toBe("확인 필요");
    expect(d.executionConfirmed).toBe(false);
    expect(d.detail).toContain("직접 매매일 수 있어");
    expect(d.canPrepareAgain).toBe(false);
  });
});

// ── 사전 재확인 ─────────────────────────────────────────────────────────────

describe("verifyPrepared — 실제 계좌·종목·수량·가격·금액 재확인", () => {
  const i = intent();
  it("모두 맞으면 통과", () => {
    expect(verifyPrepared(i, confirmOf(i), INSTANCE.id)).toEqual({ ok: true });
  });
  it.each([
    ["종목", { ticker: "367380" }],
    ["수량", { quantity: 2, amount: 51_970 }],
    ["방향", { side: "sell" }],
    ["계좌", { accountInstanceId: "bai:other" }],
    ["금액", { amount: 1 }],
    ["지정가", { limitPrice: 0, amount: 0 }],
  ])("서버 의도의 %s 가 다르면 검토 단계로 가지 않는다", (_n, patch) => {
    const bad = intent(patch as Partial<IntentView>);
    expect(verifyPrepared(bad, confirmOf(bad), INSTANCE.id).ok).toBe(false);
  });
  it("서버의 확인 echo 가 의도와 다르면 막는다", () => {
    expect(verifyPrepared(i, { ...confirmOf(i), limitPrice: 26_000 }, INSTANCE.id).ok).toBe(false);
  });
  it("화면의 계좌와 서버의 계좌가 다르면 막는다", () => {
    expect(verifyPrepared(i, confirmOf(i), "bai:something-else").ok).toBe(false);
  });
});

// ── 요청 ────────────────────────────────────────────────────────────────────

describe("요청 — 준비는 주문하지 않고, 제출은 한 번만 보낸다", () => {
  let f: ReturnType<typeof vi.fn>;
  beforeEach(() => { f = vi.fn(); });

  it("prepare 는 order/prepare 만 호출하고 submit 을 부르지 않는다", async () => {
    const i = intent();
    f.mockResolvedValue(res({ intent: i, approvalToken: "tok", confirm: confirmOf(i) }));
    const r = await requestPrepare(f as unknown as typeof fetch);
    expect(r.kind).toBe("prepared");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/kis/order/prepare");
    expect(JSON.parse(init.body)).toEqual({ ticker: "360750", quantity: 1 });
    expect(init.headers.Authorization).toBe("Bearer session-token");
  });

  it("서버 flag OFF(403 order_disabled)는 disabled", async () => {
    f.mockResolvedValue(res({ error: "order_disabled" }, 403));
    expect((await requestPrepare(f as unknown as typeof fetch)).kind).toBe("disabled");
  });

  it("이미 같은 주문이 있으면 새로 만들지 않고 그 의도를 보여준다", async () => {
    f.mockResolvedValue(res({ error: "duplicate", intent: intent({ state: "accepted", orderNo: "1" }) }, 409));
    const r = await requestPrepare(f as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: "existing" });
  });

  it("submit: 접수 응답은 accepted 이고 체결이 아니다", async () => {
    const i = intent({ state: "accepted", orderNo: "9" });
    f.mockResolvedValue(res({ outcome: "accepted", executionConfirmed: false, intent: i }));
    const r = await requestSubmit("i1", "tok", confirmOf(i), f as unknown as typeof fetch);
    expect(r.kind).toBe("accepted");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("/api/kis/order/submit");
  });

  it("**submit: 네트워크 오류는 '전송 안 됨'이 아니라 불명이고 재시도하지 않는다**", async () => {
    f.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await requestSubmit("i1", "tok", confirmOf(intent()), f as unknown as typeof fetch);
    expect(r).toEqual({ kind: "unknown", intent: null, transport: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("submit: 202(응답 불명)은 unknown", async () => {
    f.mockResolvedValue(res({ outcome: "unknown", intent: intent({ state: "unknown" }) }, 202));
    const r = await requestSubmit("i1", "tok", confirmOf(intent()), f as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: "unknown", transport: false });
  });

  it("submit: 해석할 수 없는 5xx 도 불명이다(전송 안 됨으로 단정하지 않는다)", async () => {
    f.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    const r = await requestSubmit("i1", "tok", confirmOf(intent()), f as unknown as typeof fetch);
    expect(r.kind).toBe("unknown");
  });

  it("submit: 서버가 검증으로 거절하면 not_sent", async () => {
    f.mockResolvedValue(res({ error: "price_drift" }, 409));
    const r = await requestSubmit("i1", "tok", confirmOf(intent()), f as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: "not_sent", code: "price_drift" });
  });

  it("submit: 이미 처리된 의도는 already_processed (다시 보내지 않는다)", async () => {
    f.mockResolvedValue(res({ error: "already_processed", intent: intent({ state: "accepted", orderNo: "1" }) }, 409));
    const r = await requestSubmit("i1", "tok", confirmOf(intent()), f as unknown as typeof fetch);
    expect(r.kind).toBe("already_processed");
  });

  it("status 는 GET 이고 주문 경로를 부르지 않는다", async () => {
    f.mockResolvedValue(res({ intent: intent({ state: "open", orderNo: "1" }) }));
    const r = await requestStatus("i 1", f as unknown as typeof fetch);
    expect(r.kind).toBe("status");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/kis/order/status?intentId=i%201");
    expect(init.method).toBe("GET");
  });
});

describe("secondsLeft", () => {
  it("남은 초를 올림하고 지나면 0", () => {
    const exp = "2026-10-14T05:02:00.000Z";
    expect(secondsLeft(exp, Date.parse("2026-10-14T05:01:30.200Z"))).toBe(30);
    expect(secondsLeft(exp, Date.parse("2026-10-14T05:03:00.000Z"))).toBe(0);
    expect(secondsLeft("bad", 0)).toBe(0);
  });
});
