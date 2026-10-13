/**
 * 완료 서버 호출의 **응답 번역**을 고정한다 (Phase 1B-3A).
 *
 * 여기서 지키는 것:
 *   1. ACK / 409·422 / 503 / 네트워크 실패를 **각각 다르게** 읽는다
 *   2. 네트워크 실패를 `failed` 로 적지 않는다 — 서버가 받았는지 모른다
 *   3. 2xx 인데 모양이 다르면 **성공으로 보정하지 않는다**
 *   4. 조회 실패를 `missing` 으로 읽지 않는다 (ghost session 차단)
 *   5. 재전송(`already_exists`)도 ACK 다 — 멱등성의 근거
 *   6. 본문은 **frozen payload 그대로** 나가고 id 를 새로 만들지 않는다
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMPLETION_API_TIMEOUT_MS,
  describeOutcome,
  durablePlanKnownFromResponse,
  historyMergeOutcomeFromResponse,
  planOutcomeFromResponse,
  type ApiResult,
} from "./completion-api";

const ok = (body: Record<string, unknown>): ApiResult => ({ status: 200, body });
const err = (status: number, body: Record<string, unknown> = {}): ApiResult => ({ status, body });
const offline = (): ApiResult => ({ status: 0, body: null, networkError: "Failed to fetch" });
const timedOut = (): ApiResult => ({
  status: 0, body: null, networkError: "요청이 중단됐습니다", timedOut: true,
});

describe("plan POST 응답", () => {
  it("created / already_exists 는 둘 다 ACK 다", () => {
    expect(planOutcomeFromResponse(ok({ outcome: "created" })))
      .toEqual({ kind: "ack", outcome: "created" });
    expect(planOutcomeFromResponse(ok({ outcome: "already_exists" })))
      .toEqual({ kind: "ack", outcome: "already_exists" });
  });

  it("422(해시 불일치)는 실패다 — 재시도로 풀리지 않는다", () => {
    const o = planOutcomeFromResponse(err(422, { error: "plan_hash_mismatch" }));
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") expect(o.error).toContain("plan_hash_mismatch");
  });

  it("503 unavailable(005 미적용)은 **unknown** 이다", () => {
    const o = planOutcomeFromResponse(err(503, { unavailable: true }));
    expect(o.kind).toBe("unknown");
    if (o.kind === "unknown") expect(o.reason).toContain("005");
  });

  it("401 은 실패다", () => {
    expect(planOutcomeFromResponse(err(401)).kind).toBe("failed");
  });

  it("400 은 본문의 사유를 그대로 전한다", () => {
    const o = planOutcomeFromResponse(err(400, { error: "planPayloadHash 가 본문과 일치하지 않습니다" }));
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") expect(o.error).toContain("planPayloadHash");
  });

  it("네트워크 실패는 unknown 이다 (failed 로 적지 않는다)", () => {
    expect(planOutcomeFromResponse(offline()).kind).toBe("unknown");
    const t = planOutcomeFromResponse(timedOut());
    expect(t.kind).toBe("unknown");
    if (t.kind === "unknown") expect(t.reason).toContain(String(COMPLETION_API_TIMEOUT_MS));
  });

  it("200 인데 모양이 다르면 성공으로 보정하지 않는다", () => {
    expect(planOutcomeFromResponse(ok({ outcome: "merged?" })).kind).toBe("unknown");
    expect(planOutcomeFromResponse({ status: 200, body: null }).kind).toBe("unknown");
  });
});

describe("history 병합 POST 응답", () => {
  it("created / already_exists 는 둘 다 ACK 다 (재전송 멱등)", () => {
    expect(historyMergeOutcomeFromResponse(ok({ outcome: "created" })))
      .toEqual({ kind: "ack", outcome: "created" });
    expect(historyMergeOutcomeFromResponse(ok({ outcome: "already_exists" })))
      .toEqual({ kind: "ack", outcome: "already_exists" });
  });

  it("ACK 는 병합 후 revision 을 같이 전한다 (가드 표 갱신용)", () => {
    expect(historyMergeOutcomeFromResponse(ok({ outcome: "created", revision: 9 })))
      .toEqual({ kind: "ack", outcome: "created", revision: 9 });
    // 서버가 안 주면 필드를 만들지 않는다(0 으로 채우지 않는다)
    expect(historyMergeOutcomeFromResponse(ok({ outcome: "created" })))
      .toEqual({ kind: "ack", outcome: "created" });
  });

  it("409(같은 id · 다른 경제값)는 실패다", () => {
    const o = historyMergeOutcomeFromResponse(err(409, { error: "history_hash_mismatch" }));
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") expect(o.error).toContain("history_hash_mismatch");
  });

  it("404(계좌 문서 없음)는 실패다 — 계좌 저장이 먼저다", () => {
    const o = historyMergeOutcomeFromResponse(err(404, { error: "account_row_missing" }));
    expect(o.kind).toBe("failed");
    if (o.kind === "failed") expect(o.error).toContain("계좌");
  });

  it("503 unavailable(006 미적용)은 unknown 이다", () => {
    const o = historyMergeOutcomeFromResponse(err(503, { unavailable: true }));
    expect(o.kind).toBe("unknown");
    if (o.kind === "unknown") expect(o.reason).toContain("006");
  });

  it("네트워크 실패·타임아웃은 unknown 이다", () => {
    expect(historyMergeOutcomeFromResponse(offline()).kind).toBe("unknown");
    expect(historyMergeOutcomeFromResponse(timedOut()).kind).toBe("unknown");
  });

  it("200 인데 모양이 다르면 unknown 이다", () => {
    expect(historyMergeOutcomeFromResponse(ok({ ok: true })).kind).toBe("unknown");
  });

  it("세 분기가 서로 구분된다 (뭉개지지 않는다)", () => {
    const kinds = [
      historyMergeOutcomeFromResponse(ok({ outcome: "created" })).kind,
      historyMergeOutcomeFromResponse(err(409)).kind,
      historyMergeOutcomeFromResponse(err(503, { unavailable: true })).kind,
    ];
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("GET plan → durablePlanKnown", () => {
  it("exists / missing 을 그대로 읽는다", () => {
    expect(durablePlanKnownFromResponse(ok({ exists: { "c-1": true } }), "c-1")).toBe("exists");
    expect(durablePlanKnownFromResponse(ok({ exists: { "c-1": false } }), "c-1")).toBe("missing");
  });

  it("**조회 실패를 missing 으로 읽지 않는다** (ghost session 차단)", () => {
    expect(durablePlanKnownFromResponse(offline(), "c-1")).toBe("unknown");
    expect(durablePlanKnownFromResponse(err(500), "c-1")).toBe("unknown");
    expect(durablePlanKnownFromResponse(err(503, { unavailable: true }), "c-1")).toBe("unknown");
    expect(durablePlanKnownFromResponse(err(401), "c-1")).toBe("unknown");
  });

  it("다른 completionId 의 결과를 쓰지 않는다", () => {
    expect(durablePlanKnownFromResponse(ok({ exists: { "c-2": true } }), "c-1")).toBe("unknown");
  });

  it("모양이 어긋난 응답은 unknown 이다", () => {
    expect(durablePlanKnownFromResponse(ok({ exists: true }), "c-1")).toBe("unknown");
    expect(durablePlanKnownFromResponse(ok({}), "c-1")).toBe("unknown");
  });
});

describe("describeOutcome", () => {
  it("세 종류를 모두 문구로 만든다", () => {
    expect(describeOutcome({ kind: "ack", outcome: "created" })).toContain("기록");
    expect(describeOutcome({ kind: "ack", outcome: "already_exists" })).toContain("이미");
    expect(describeOutcome({ kind: "failed", error: "409 다" })).toBe("409 다");
    expect(describeOutcome({ kind: "unknown", reason: "타임아웃" })).toBe("타임아웃");
    expect(describeOutcome({ kind: "unknown" })).toContain("확인하지 못했습니다");
  });
});

// ── fetch 래퍼: 본문·URL 고정 ───────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const g = globalThis as unknown as Record<string, unknown>;

/** node 환경이라 window/sessionStorage 가 없다 — 토큰 조회 경로만 흉내낸다. */
function withBrowserGlobals(token: string | null) {
  const map = new Map<string, string>();
  if (token !== null) map.set("kaw.session.token", token);
  g.window = globalThis;
  g.sessionStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: map.size,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete g.window;
  delete g.sessionStorage;
  vi.restoreAllMocks();
});

describe("요청 본문은 frozen payload 그대로다", () => {
  async function capture(run: () => Promise<unknown>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ outcome: "created", exists: { "c-1": true } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    // 세션 토큰이 있어야 호출된다 — auth 의 저장 키를 그대로 쓴다.
    const { SESSION_TOKEN_KEY } = await import("./auth");
    expect(SESSION_TOKEN_KEY).toBe("kaw.session.token");
    withBrowserGlobals("t");
    await run();
    return calls;
  }

  it("plan POST 는 payload 를 가공하지 않는다", async () => {
    const { postPlanWrite } = await import("./completion-api");
    const payload = { completionId: "c-1", id: "plan:c-1", planPayloadHash: "p1|abc", accountType: "isa" };
    const calls = await capture(() => postPlanWrite(payload));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/rebalance/plan");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(payload);
  });

  it("history 병합 POST 는 entry 를 그대로 싣고 accountType 을 envelope 값으로 보낸다", async () => {
    const { postHistoryMergeWrite } = await import("./completion-api");
    const entry = { id: "hist:c-1", date: "2026-10-13", baseAmount: 1, totalValue: 2, deposit: 0 };
    const calls = await capture(() => postHistoryMergeWrite("irp", entry));
    expect(calls[0].url).toBe("/api/data/history");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ accountType: "irp", entry });
  });

  it("GET plan 은 completionId 를 그대로 묻는다", async () => {
    const { fetchDurablePlanKnown } = await import("./completion-api");
    const calls = await capture(() => fetchDurablePlanKnown("c-1"));
    expect(calls[0].url).toBe("/api/rebalance/plan?completionId=c-1");
    expect(calls[0].init.method).toBe("GET");
  });

  it("세션 토큰이 없으면 요청하지 않고 unknown 이다", async () => {
    const { postPlanWrite } = await import("./completion-api");
    withBrowserGlobals(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const o = await postPlanWrite({ completionId: "c-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(o.kind).toBe("unknown");
  });

  it("빈 completionId 로는 조회하지 않는다", async () => {
    const { fetchDurablePlanKnown } = await import("./completion-api");
    withBrowserGlobals("t");
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await fetchDurablePlanKnown("")).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 호출부 불변식 (소스 단위) ───────────────────────────────────────────────

describe("호출부는 frozen payload 만 보낸다", () => {
  const apiSrc = readFileSync(fileURLToPath(new URL("./completion-api.ts", import.meta.url)), "utf-8");
  const pageSrc = readFileSync(
    fileURLToPath(new URL("../../components/kaw/AccountPage.tsx", import.meta.url)),
    "utf-8",
  );
  const runCompletion = pageSrc.slice(
    pageSrc.indexOf("async function runCompletion"),
    pageSrc.indexOf("const colCount"),
  );

  it("API 모듈은 id·해시를 만들지 않는다 (payload 안의 값을 쓴다)", () => {
    expect(apiSrc).not.toContain("randomUUID");
    expect(apiSrc).not.toContain("planPayloadHash(");
    expect(apiSrc).not.toContain("historyEntryHash(");
    expect(apiSrc).not.toContain("completionIds(");
  });

  it("API 모듈은 시세·store 를 읽지 않는다", () => {
    expect(apiSrc).not.toMatch(/from "\.\/store"/);
    expect(apiSrc).not.toMatch(/useKisPrices|livePrice/);
  });

  it("완료 흐름이 envelope 의 frozen payload 를 보낸다", () => {
    expect(runCompletion).toContain("postHistoryMergeWrite(env.accountType, frozenHistoryOf(env))");
    expect(runCompletion).toContain("postPlanWrite(frozenPlanOf(env))");
  });

  it("완료 흐름에서 **정리(삭제)를 호출하지 않는다** — ACK 는 최종 영속 보장이 아니다", () => {
    expect(pageSrc).not.toContain("cleanupCompletion");
  });

  it("실패·미확인에서 성공 문구를 띄우지 않는다", () => {
    // 성공 toast 는 all_confirmed 에서만
    expect(runCompletion).toMatch(/completionDisplayState\(settled\) === "all_confirmed"/);
    const successAt = runCompletion.indexOf('toast.success("서버가 계획·기록을 수신했습니다');
    expect(successAt).toBeGreaterThan(-1);
    const guardAt = runCompletion.indexOf('completionDisplayState(settled) === "all_confirmed"');
    expect(guardAt).toBeLessThan(successAt);
  });

  it("병합이 올린 revision 을 가드 표에 반영한다 (자기 자신 때문에 409 가 되지 않게)", () => {
    expect(runCompletion).toContain("noteServerRevision(env.accountType, mergeOutcome.revision)");
    // ACK 가 아닐 때는 반영하지 않는다
    expect(runCompletion).toMatch(/mergeOutcome\.kind === "ack"\) noteServerRevision/);
  });

  it("성공 문구는 수신 확인까지만 말한다 (최종 영속 보장 표현 금지)", () => {
    const m = /toast\.success\("(서버가 계획[^"]*)"\)/.exec(runCompletion);
    expect(m).not.toBeNull();
    const text = m![1];
    expect(text).toContain("수신");
    expect(text).toContain("최종 보존을 보장하지는 않습니다");
    // 확정·완료·보존됨을 단정하는 표현이 없다 (부정문 안의 '보존'은 위에서 따로 허용)
    expect(text.replace("최종 보존을 보장하지는 않습니다", "")).not.toMatch(/저장 완료|확정|보존|영구|안전/);
    // 진행 중 문구도 같은 선을 지킨다
    expect(runCompletion).toContain("서버 수신 확인 중…");
    expect(runCompletion).not.toContain("서버 기록 확인");
  });

  it("두 결과를 각각 settle 한다 (한쪽 결과로 다른 쪽을 추론하지 않는다)", () => {
    expect(runCompletion).toContain("settleHistoryMergeWrite(sessionCtx, begun.completionId, mergeOutcome)");
    expect(runCompletion).toContain("settlePlanWrite(sessionCtx, begun.completionId, planOutcome)");
  });
});
