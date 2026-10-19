/**
 * 계좌 이전 클라이언트 호출 (Phase 4-C-1)
 *   · 세션 토큰이 없으면 요청하지 않는다
 *   · 쓰기 요청(POST)은 approved: true 와 함께 나가고, 상태 조회(GET)는 본문이 없다
 *   · 서버의 거절(400/409 + state:rejected)은 사유와 함께 돌려주고, 성공처럼 다루지 않는다
 *   · 재시도하지 않는다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./auth", () => ({ getSessionToken: vi.fn(() => "sess-token") }));
import { getSessionToken } from "./auth";
import { TRANSFER_CONFIRM_PATH, TRANSFER_OBSERVE_PATH, TRANSFER_STATE_PATH, requestBalanceObserve, requestTransferConfirm, requestTransferState, type ConfirmPayload } from "./kis-transfer-client";

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const payload: ConfirmPayload = {
  toInstanceId: "bai:kis", fromInstanceId: null, fromBroker: "miraeasset", fromLabel: "미래에셋", anchorDate: "2026-10-13",
  cashReceived: { amount: 10_293_793, date: null }, exitTxIds: ["s1"], note: "", approved: true,
};
beforeEach(() => { vi.mocked(getSessionToken).mockReturnValue("sess-token"); });

describe("요청 형태", () => {
  it("상태 조회는 GET 이고 본문이 없다", async () => {
    const f = vi.fn(async () => res(200, { state: "ok" }));
    const o = await requestTransferState(f as never);
    expect(o.kind).toBe("ok");
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(TRANSFER_STATE_PATH);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sess-token");
  });

  it("관측 요청은 POST + approved:true", async () => {
    const f = vi.fn(async () => res(200, { state: "recorded" }));
    await requestBalanceObserve(f as never);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(TRANSFER_OBSERVE_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ approved: true });
  });

  it("확정 요청은 입력값을 그대로 싣는다", async () => {
    const f = vi.fn(async () => res(200, { state: "confirmed", record: {} }));
    await requestTransferConfirm(payload, f as never);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(TRANSFER_CONFIRM_PATH);
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });
});

describe("결과 분류", () => {
  it("세션이 없으면 요청하지 않는다", async () => {
    vi.mocked(getSessionToken).mockReturnValue(null as never);
    const f = vi.fn();
    expect(await requestBalanceObserve(f as never)).toEqual({ kind: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
  });

  it("401 · 403 · 503 not_configured 를 구분한다", async () => {
    expect((await requestTransferState((async () => res(401, {})) as never)).kind).toBe("unauthorized");
    expect((await requestTransferState((async () => res(403, {})) as never)).kind).toBe("forbidden");
    expect((await requestTransferState((async () => res(503, { unavailable: true, state: "not_configured" })) as never)).kind).toBe("not_configured");
  });

  it("서버의 거절(409 rejected)은 사유와 함께 돌려주고 성공으로 보지 않는다", async () => {
    const o = await requestTransferConfirm(payload, (async () => res(409, { state: "rejected", code: "evidence_missing", message: "이전 증거가 부족합니다.", detail: ["x"] })) as never);
    expect(o).toEqual({ kind: "rejected", code: "evidence_missing", message: "이전 증거가 부족합니다.", detail: ["x"] });
  });

  it("확정 성공 응답이 아니면(state 가 confirmed 가 아님) 성공으로 보지 않는다", async () => {
    expect((await requestTransferConfirm(payload, (async () => res(200, { state: "weird" })) as never)).kind).toBe("server_error");
  });

  it("네트워크 오류는 재시도하지 않고 한 번만 호출한다", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline"); });
    expect((await requestTransferConfirm(payload, f as never)).kind).toBe("network_error");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
