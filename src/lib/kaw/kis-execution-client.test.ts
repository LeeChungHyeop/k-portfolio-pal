// @vitest-environment jsdom
/**
 * 체결내역 미리보기 브라우저 호출 — 결과 종류 분류 · 재시도 없음 · 비밀값을 모른다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { KIS_EXEC_PREVIEW_PATH, requestKisExecutionPreview } from "./kis-execution-client";
import { SESSION_TOKEN_KEY } from "./auth";

const RANGE = { start: "2026-10-13", end: "2026-10-16" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { sessionStorage.clear(); sessionStorage.setItem(SESSION_TOKEN_KEY, "session-token-for-test"); });

describe("호출", () => {
  it("세션이 없으면 요청 없이 unauthorized", async () => {
    sessionStorage.clear();
    const f = vi.fn();
    expect(await requestKisExecutionPreview(RANGE, f as never)).toEqual({ kind: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
  });

  it("POST · 경로 · 본문은 기간뿐이다 (계좌·키·주문 정보를 모른다)", async () => {
    const f = vi.fn(async () => json(200, { state: "gate_blocked", reason: "mode_calc_only" }));
    const r = await requestKisExecutionPreview(RANGE, f as never);
    expect(r).toEqual({ kind: "response", data: { state: "gate_blocked", reason: "mode_calc_only" } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(KIS_EXEC_PREVIEW_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(RANGE);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer session-token-for-test");
  });
});

describe("결과 종류 — 자동 재시도 없음", () => {
  const cases: Array<[string, () => Promise<Response>, unknown]> = [
    ["401", async () => json(401, {}), { kind: "unauthorized" }],
    ["403", async () => json(403, { error: "x" }), { kind: "forbidden" }],
    ["503 not_configured", async () => json(503, { unavailable: true, state: "not_configured" }), { kind: "not_configured" }],
    ["400", async () => json(400, { error: "시작일이 종료일보다 늦습니다." }), { kind: "bad_request", message: "시작일이 종료일보다 늦습니다." }],
    ["500", async () => json(500, { error: "boom" }), { kind: "server_error", status: 500 }],
    ["본문 없는 200", async () => new Response("<html>", { status: 200 }), { kind: "server_error", status: 200 }],
    ["네트워크", async () => { throw new TypeError("failed"); }, { kind: "network_error" }],
  ];
  for (const [name, impl, expected] of cases) {
    it(`${name} → 한 번만 호출하고 분류한다`, async () => {
      const f = vi.fn(impl);
      expect(await requestKisExecutionPreview(RANGE, f as never)).toEqual(expected);
      expect(f).toHaveBeenCalledTimes(1);
    });
  }

  it("타임아웃은 timeout 으로 분류한다", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); });
    }));
    expect(await requestKisExecutionPreview(RANGE, f as never, 20)).toEqual({ kind: "timeout" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("소스 불변식", () => {
  const code = readFileSync(path.join(import.meta.dirname, "kis-execution-client.ts"), "utf8")
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("자동 호출 · 재시도 · 저장소 쓰기가 없다", () => {
    expect(code).not.toMatch(/setInterval|setTimeout\([^)]*request|retry|localStorage|sessionStorage\.setItem|useEffect/);
  });
});
