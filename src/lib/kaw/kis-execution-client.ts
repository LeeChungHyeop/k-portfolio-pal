// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 체결내역 미리보기 — 브라우저 쪽 호출 (사용자가 누를 때만, Phase 4-B)
//
//   · 자동 호출이 없다. 마운트·폴링·타이머에서 부르지 않는다
//   · 실패해도 **재시도하지 않는다.** 결과 종류만 돌려주고, 다시 조회하는 것은 사용자의 몫이다
//   · 계좌번호·키·토큰을 모른다(세션 토큰만 쓴다)
//   · 서버 응답을 원장·장부·저장소에 쓰지 않는다
// ─────────────────────────────────────────────────────────────────────────────

import { getSessionToken } from "./auth";
import type { KisExecutionPreviewResponse } from "./kis-execution-compose";

export const KIS_EXEC_PREVIEW_PATH = "/api/kis/executions/preview";
export const KIS_EXEC_TIMEOUT_MS = 60_000;

export interface ExecRange {
  /** YYYY-MM-DD */
  start: string;
  end: string;
}

export type ExecRequestOutcome =
  /** 서버가 처리했다. 조회 실패·게이트 차단도 여기에 담긴다(`data.state`) */
  | { kind: "response"; data: KisExecutionPreviewResponse }
  /** 서버에 한국투자 조회 설정(credential)이 없다 — 조회하지 않았다 */
  | { kind: "not_configured" }
  /** 이 프로필에는 조회 권한이 없다 */
  | { kind: "forbidden" }
  /** 세션이 없거나 만료됐다 */
  | { kind: "unauthorized" }
  /** 요청 값이 거부됐다 */
  | { kind: "bad_request"; message: string }
  | { kind: "server_error"; status: number }
  | { kind: "network_error" }
  | { kind: "timeout" };

export async function requestKisExecutionPreview(
  range: ExecRange,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = KIS_EXEC_TIMEOUT_MS,
): Promise<ExecRequestOutcome> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthorized" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(KIS_EXEC_PREVIEW_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ start: range.start, end: range.end }),
      signal: controller.signal,
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 403) return { kind: "forbidden" };
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 503 && body && (body.state === "not_configured" || body.unavailable === true)) {
      return { kind: "not_configured" };
    }
    if (res.status === 400) {
      return { kind: "bad_request", message: typeof body?.error === "string" ? body.error : "요청이 거부됐습니다." };
    }
    if (!res.ok || !body || typeof body.state !== "string") return { kind: "server_error", status: res.status };
    return { kind: "response", data: body as unknown as KisExecutionPreviewResponse };
  } catch (e) {
    return (e as Error)?.name === "AbortError" ? { kind: "timeout" } : { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
