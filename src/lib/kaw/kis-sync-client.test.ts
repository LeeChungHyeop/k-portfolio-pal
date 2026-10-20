/**
 * 계좌 동기화 클라이언트 호출 (Phase 4-D)
 *   · 세션 토큰이 없으면 요청하지 않는다
 *   · 반영 요청은 approved: true 와 planHash 가 실리고, 재시도하지 않는다
 *   · 서버 거절(state: rejected)은 사유와 함께 돌려주고 성공처럼 다루지 않는다 (403 sync_disabled 포함)
 *   · applied 가 아니면 성공이 아니다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./auth", () => ({ getSessionToken: vi.fn(() => "sess-token") }));
import { getSessionToken } from "./auth";
import { SYNC_APPLY_PATH, SYNC_PREVIEW_PATH, requestSyncApply, requestSyncPreview } from "./kis-sync-client";

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => { vi.mocked(getSessionToken).mockReturnValue("sess-token"); });

describe("요청 형태", () => {
  it("미리보기는 POST /api/kis/sync/preview, 본문에 live 와 staleObservationApproved 만 싣는다", async () => {
    const f = vi.fn(async () => res(200, { state: "preview", plan: null, blockers: [], balance: {}, today: "2026-10-20" }));
    const o = await requestSyncPreview({ live: true }, f as never);
    expect(o.kind).toBe("ok");
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(SYNC_PREVIEW_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ live: true, staleObservationApproved: false });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sess-token");
  });

  it("반영은 approved:true + planHash + 오래된 관측 승인 여부를 싣는다", async () => {
    const f = vi.fn(async () => res(200, { state: "applied", recordId: "bsync:x", revision: 6 }));
    const o = await requestSyncApply({ planHash: "s1|ab12", staleObservationApproved: true }, f as never);
    expect(o).toEqual({ kind: "applied", recordId: "bsync:x", revision: 6 });
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(SYNC_APPLY_PATH);
    expect(JSON.parse(String(init.body))).toEqual({ planHash: "s1|ab12", approved: true, staleObservationApproved: true });
  });

  it("오래된 관측 승인은 명시하지 않으면 false", async () => {
    const f = vi.fn(async () => res(200, { state: "applied", recordId: "r", revision: 1 }));
    await requestSyncApply({ planHash: "s1|ab" }, f as never);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).staleObservationApproved).toBe(false);
  });
});

describe("토큰 · 재시도", () => {
  it("세션 토큰이 없으면 요청하지 않는다", async () => {
    vi.mocked(getSessionToken).mockReturnValue(null as never);
    const f = vi.fn();
    expect(await requestSyncPreview({ live: false }, f as never)).toEqual({ kind: "unauthorized" });
    expect(await requestSyncApply({ planHash: "s1|ab" }, f as never)).toEqual({ kind: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
  });
  it("네트워크 오류도 재시도하지 않는다", async () => {
    const f = vi.fn(async () => { throw new TypeError("net"); });
    expect(await requestSyncApply({ planHash: "s1|ab" }, f as never)).toEqual({ kind: "network_error" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("401 은 unauthorized", async () => {
    expect(await requestSyncApply({ planHash: "s1|ab" }, (async () => res(401, {})) as never)).toEqual({ kind: "unauthorized" });
  });
});

describe("응답 해석 — applied 가 아니면 성공이 아니다", () => {
  const apply = (status: number, body: unknown) => requestSyncApply({ planHash: "s1|ab" }, (async () => res(status, body)) as never);
  it("거절은 사유 · 차단 · 새 계획과 함께 돌려준다", async () => {
    const o = await apply(409, { state: "rejected", code: "plan_changed", message: "m", plan: { planHash: "s1|new" }, blockers: [{ code: "x", message: "y" }], balance: { source: "kis_live_read" } });
    expect(o).toMatchObject({ kind: "rejected", code: "plan_changed", plan: { planHash: "s1|new" }, blockers: [{ code: "x" }], balance: { source: "kis_live_read" } });
  });
  it("403 + rejected(sync_disabled) 는 forbidden 이 아니라 사유 있는 거절", async () => {
    expect(await apply(403, { state: "rejected", code: "sync_disabled", message: "꺼짐" })).toMatchObject({ kind: "rejected", code: "sync_disabled" });
  });
  it("403 단독은 forbidden, 503 은 함수 없음/설정 없음으로 구분", async () => {
    expect(await apply(403, { error: "권한 없음" })).toEqual({ kind: "forbidden" });
    expect(await apply(503, { state: "apply_unavailable" })).toEqual({ kind: "unavailable" });
    expect(await apply(503, { unavailable: true, state: "not_configured" })).toEqual({ kind: "not_configured" });
  });
  it("200 이어도 applied 모양이 아니면 server_error", async () => {
    expect(await apply(200, { state: "weird" })).toEqual({ kind: "server_error", status: 200 });
    expect(await apply(500, { state: "write_failed" })).toEqual({ kind: "server_error", status: 500 });
  });
});
