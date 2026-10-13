// ─────────────────────────────────────────────────────────────────────────────
// 완료(completion) 서버 호출 — envelope 의 **frozen payload** 를 두 API 에 보낸다
//
//   POST /api/rebalance/plan   계획/주장의 durable 증거 1행 (005)
//   POST /api/data/history     HistoryEntry 1건 원자적 병합   (006)
//   GET  /api/rebalance/plan   완료가 서버에 남았는가 → durablePlanKnown
//
// ── 이 모듈의 규칙 ─────────────────────────────────────────────────────────
//
//   1. **frozen payload 만 보낸다.** 지금 시세·보유수량·예수금을 다시 읽지 않는다.
//      payload 는 `beginCompletion()` 이 완료 시작 시점에 얼려둔 것이고(envelope),
//      복구도 같은 값을 다시 보낸다. 재계산하면 같은 completionId 에 다른 경제값이
//      올라가 **409(history) / 422(plan)** 가 된다 — 멱등성이 깨지는 지점이 정확히 여기다.
//
//   2. **id 를 만들지 않는다.** `completionId` 와 거기서 파생된 `hist:` / `plan:` id 는
//      payload 안에 이미 있다. 이 모듈은 재전송마다 **같은 본문**을 보낼 뿐이다.
//
//   3. **응답을 구분해서 번역한다.** 성공/실패를 뭉개지 않는다:
//
//        ack      서버가 받았다(created / already_exists). 재전송의 ACK 도 ACK 다
//        failed   **명시적 실패 응답**이다 (400 / 404 / 409 / 422 / 401)
//        unknown  이 경로로는 알 수 없다 (503 미적용, 네트워크 단절·타임아웃)
//
//      네트워크 실패를 `failed` 로 적지 않는다 — 서버가 받았는지 안 받았는지 모르는
//      상태이고, envelope 의 `failed` 는 "명시적 실패 응답을 받았다"는 뜻이다
//      (completion-envelope.ts PersistenceState).
//
//   4. **성공으로 보정하지 않는다.** 응답을 해석하지 못하면 unknown/failed 이고,
//      envelope 은 outbox 에 그대로 남는다. 삭제 판정은 양쪽 confirmed 뿐이다.
//
//   5. **History ACK 는 "서버가 받았다"까지만 증명한다.** 최종 영속을 보장하지 않는다 —
//      `/api/data` 의 무가드 문서 교체 경로가 아직 남아 있어서(1B-2B flag 기본 OFF)
//      나중에 도착한 오래된 문서가 그 기록을 덮을 수 있다. 그래서 이 모듈의 ACK 로
//      envelope/journal 을 **지우지 않는다**(정리는 복구 단계의 책임이다).
// ─────────────────────────────────────────────────────────────────────────────

import { getSessionToken } from "./auth";
import type { DurablePlanKnown } from "./rebalance-journal";
import type { HistoryMergeOutcome, PlanWriteOutcome } from "./rebalance-session";

/** 단건 write 와 같은 상한. fetch 는 자체 타임아웃이 없다. */
export const COMPLETION_API_TIMEOUT_MS = 15_000;

/** 응답을 순수 판정에 넣기 위한 모양. 네트워크 실패도 같은 타입으로 들어온다. */
export interface ApiResult {
  /** 네트워크/중단이면 0 */
  status: number;
  body: Record<string, unknown> | null;
  /** fetch 자체가 실패했다(단절·CORS·중단). status 는 0 이다 */
  networkError?: string;
  timedOut?: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ── 순수 판정 ───────────────────────────────────────────────────────────────

/**
 * plan POST 응답 → outcome.
 *
 * plan 은 **"모른다"를 영속 상태로 쓰지 않는다** — POST 응답이 곧 ACK 라서, 모르면
 * 재전송해야 한다(settlePlanWrite 가 unknown 도 실패로 끌고 간다). 그래도 여기서는
 * 사유를 구분해 돌려준다 — 화면 문구와 로그가 "왜" 를 말해야 하기 때문이다.
 */
export function planOutcomeFromResponse(r: ApiResult): PlanWriteOutcome {
  if (r.networkError) {
    return {
      kind: "unknown",
      reason: r.timedOut
        ? `${COMPLETION_API_TIMEOUT_MS}ms 안에 응답이 없었습니다`
        : `네트워크 오류: ${r.networkError}`,
    };
  }
  const body = r.body ?? {};
  if (r.status === 200) {
    const outcome = body.outcome;
    if (outcome === "created" || outcome === "already_exists") return { kind: "ack", outcome };
    // 200 인데 모양이 다르다 — 성공으로 보정하지 않는다.
    return { kind: "unknown", reason: "plan 저장 응답을 해석할 수 없습니다" };
  }
  if (r.status === 401) return { kind: "failed", error: "세션이 만료됐어요. 다시 로그인해주세요." };
  if (r.status === 422) {
    return {
      kind: "failed",
      error: "같은 완료 id 로 다른 내용의 계획이 이미 저장돼 있습니다(plan_hash_mismatch).",
    };
  }
  if (r.status === 503) {
    // migration 005 미적용 또는 일시적 서버 설정 오류. 재전송으로 풀릴 수 있다.
    return {
      kind: "unknown",
      reason: body.unavailable === true
        ? "plan 저장소가 아직 없습니다 (migration 005 미적용)"
        : (str(body.error) ?? "서버가 일시적으로 응답하지 못했습니다"),
    };
  }
  return { kind: "failed", error: str(body.error) ?? `HTTP ${r.status}` };
}

/**
 * history 병합 POST 응답 → outcome.
 *
 *   200 created / already_exists   ack. **재전송도 ACK 다**(같은 경제값이면 멱등)
 *   409                            failed. 같은 id 에 **다른 경제값**이 있다 —
 *                                  재시도로 풀리지 않는다(사용자 확인 필요)
 *   404                            failed. 계좌 문서가 아직 없다 — 계좌 저장이 먼저다
 *   503 unavailable                unknown. migration 006 미적용
 *   네트워크/타임아웃                unknown. 서버가 받았는지 **알 수 없다**
 */
export function historyMergeOutcomeFromResponse(r: ApiResult): HistoryMergeOutcome {
  if (r.networkError) {
    return {
      kind: "unknown",
      reason: r.timedOut
        ? `${COMPLETION_API_TIMEOUT_MS}ms 안에 응답이 없었습니다`
        : `네트워크 오류: ${r.networkError}`,
    };
  }
  const body = r.body ?? {};
  if (r.status === 200) {
    const outcome = body.outcome;
    if (outcome === "created" || outcome === "already_exists") {
      // 병합은 revision 을 올린다 — 호출부가 가드 표를 갱신해야 다음 자동저장이
      // 자기 자신 때문에 409 가 되지 않는다(1B-2B).
      const revision = typeof body.revision === "number" ? body.revision : undefined;
      return { kind: "ack", outcome, ...(revision === undefined ? {} : { revision }) };
    }
    return { kind: "unknown", reason: "기록 병합 응답을 해석할 수 없습니다" };
  }
  if (r.status === 401) return { kind: "failed", error: "세션이 만료됐어요. 다시 로그인해주세요." };
  if (r.status === 409) {
    return {
      kind: "failed",
      error: "같은 기록 id 로 이미 다른 내용이 저장돼 있습니다(history_hash_mismatch).",
    };
  }
  if (r.status === 404) {
    return { kind: "failed", error: "계좌 데이터가 아직 서버에 없습니다. 계좌 저장 후 다시 시도해주세요." };
  }
  if (r.status === 503) {
    return {
      kind: "unknown",
      reason: body.unavailable === true
        ? "기록 병합 경로가 아직 없습니다 (migration 006 미적용)"
        : (str(body.error) ?? "서버가 일시적으로 응답하지 못했습니다"),
    };
  }
  return { kind: "failed", error: str(body.error) ?? `HTTP ${r.status}` };
}

/**
 * GET plan 응답 → `durablePlanKnown`.
 *
 * **실패를 `missing` 으로 읽지 않는다.** missing 은 "서버에 없다"는 사실이고 복원을
 * 진행시키는 근거다. 조회 실패를 missing 으로 적으면 이미 저장된 완료를 다시 복원해
 * ghost session 을 만든다(rebalance-journal.ts 의 판정 규칙).
 */
export function durablePlanKnownFromResponse(r: ApiResult, completionId: string): DurablePlanKnown {
  if (r.networkError || r.status !== 200 || !r.body) return "unknown";
  const exists = r.body.exists;
  if (!exists || typeof exists !== "object") return "unknown";
  const value = (exists as Record<string, unknown>)[completionId];
  if (value === true) return "exists";
  if (value === false) return "missing";
  return "unknown";
}

/** 화면 문구용 한 줄. outcome 을 그대로 읽어 사용자에게 보여줄 수 있게 한다. */
export function describeOutcome(o: PlanWriteOutcome | HistoryMergeOutcome): string {
  if (o.kind === "ack") return o.outcome === "created" ? "서버에 기록됨" : "이미 기록되어 있음";
  if (o.kind === "failed") return o.error;
  return o.reason ?? "서버 기록을 확인하지 못했습니다";
}

// ── fetch 래퍼 ──────────────────────────────────────────────────────────────

async function call(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ApiResult> {
  const token = getSessionToken();
  if (!token) return { status: 0, body: null, networkError: "세션 토큰이 없습니다" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      status: 0,
      body: null,
      networkError: aborted ? "요청이 중단됐습니다" : ((e as Error)?.message ?? "알 수 없는 오류"),
      ...(aborted ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * plan 1행 저장. **본문은 frozen planPayload 그대로**다 — 여기서 필드를 더하거나
 * 바꾸지 않는다(서버가 본문으로 해시를 다시 계산하므로 한 글자만 달라도 422 다).
 */
export async function postPlanWrite(
  planPayload: unknown,
  timeoutMs: number = COMPLETION_API_TIMEOUT_MS,
): Promise<PlanWriteOutcome> {
  const r = await call(
    "/api/rebalance/plan",
    { method: "POST", body: JSON.stringify(planPayload) },
    timeoutMs,
  );
  return planOutcomeFromResponse(r);
}

/**
 * HistoryEntry 1건 병합. **본문은 frozen historyEntryPayload 그대로**다.
 * `accountType` 은 envelope 의 값을 쓴다 — 지금 화면의 계좌가 아니다(복구 때 다를 수 있다).
 */
export async function postHistoryMergeWrite(
  accountType: string,
  entryPayload: unknown,
  timeoutMs: number = COMPLETION_API_TIMEOUT_MS,
): Promise<HistoryMergeOutcome> {
  const r = await call(
    "/api/data/history",
    { method: "POST", body: JSON.stringify({ accountType, entry: entryPayload }) },
    timeoutMs,
  );
  return historyMergeOutcomeFromResponse(r);
}

/**
 * 이 완료가 서버에 남았는가. 세션 복원(hydrateSession)의 `durablePlanKnown` 근거다.
 * 조회 실패는 `unknown` 이다 — missing 으로 읽으면 ghost session 이 생긴다.
 */
export async function fetchDurablePlanKnown(
  completionId: string,
  timeoutMs: number = COMPLETION_API_TIMEOUT_MS,
): Promise<DurablePlanKnown> {
  if (!completionId) return "unknown";
  const r = await call(
    `/api/rebalance/plan?completionId=${encodeURIComponent(completionId)}`,
    { method: "GET" },
    timeoutMs,
  );
  return durablePlanKnownFromResponse(r, completionId);
}
