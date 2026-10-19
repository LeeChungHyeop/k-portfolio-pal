// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 체결 → 거래원장 반영 — 브라우저 쪽 호출 (Phase 4-C-2)
//
//   · 사용자가 승인 체크 후 버튼을 눌렀을 때만 호출된다 (자동 호출 · 폴링 · 재시도 없음)
//   · 요청에는 항상 approved: true 와 사용자가 본 계획 해시(planHash)가 실린다
//   · 서버 응답이 `applied` 가 아니면 반영되지 않은 것이다 — 성공으로 다루지 않는다
//   · 계좌번호 · 키 · 토큰을 모른다(세션 토큰만 쓴다)
// ─────────────────────────────────────────────────────────────────────────────

import { getSessionToken } from "./auth";
import type { ApplyBlocker, ApplyPlanView } from "./kis-ledger-apply";

export const KIS_LEDGER_APPLY_PATH = "/api/kis/executions/apply";
const TIMEOUT_MS = 60_000;

export interface ApplyRequest {
  /** 사용자가 본 체결 조회 기간 */
  start: string;
  end: string;
  /** 사용자가 본(승인한) 계획의 해시. 서버가 지금 다시 계산한 해시와 같아야 한다 */
  planHash: string;
}

export type ApplyOutcome =
  | { kind: "applied"; batchId: string; inserted: number; holdingsAfter: Record<string, number> }
  /** 서버가 사유를 붙여 거절했다. 아무것도 기록되지 않았다 */
  | { kind: "rejected"; code: string; message: string; blockers?: ApplyBlocker[]; plan?: ApplyPlanView }
  | { kind: "query_failed" }
  | { kind: "unavailable" }
  | { kind: "not_configured" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "server_error"; status: number }
  | { kind: "network_error" }
  | { kind: "timeout" };

export async function requestKisLedgerApply(req: ApplyRequest, fetchImpl: typeof fetch = fetch): Promise<ApplyOutcome> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthorized" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(KIS_LEDGER_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ start: req.start, end: req.end, planHash: req.planHash, approved: true }),
      signal: controller.signal,
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 403) {
      const b403 = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (b403?.state === "rejected") {
        return { kind: "rejected", code: String(b403.code ?? ""), message: String(b403.message ?? "요청이 거절됐습니다.") };
      }
      return { kind: "forbidden" };
    }
    const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 503 && b) {
      if (b.state === "apply_unavailable") return { kind: "unavailable" };
      if (b.state === "not_configured" || b.unavailable === true) return { kind: "not_configured" };
    }
    if (b && b.state === "rejected") {
      return {
        kind: "rejected", code: String(b.code ?? ""), message: String(b.message ?? "요청이 거절됐습니다."),
        ...(Array.isArray(b.blockers) ? { blockers: b.blockers as ApplyBlocker[] } : {}),
        ...(b.plan && typeof b.plan === "object" ? { plan: b.plan as ApplyPlanView } : {}),
      };
    }
    if (b && b.state === "query_failed") return { kind: "query_failed" };
    if (res.ok && b && b.state === "applied" && typeof b.batchId === "string") {
      return { kind: "applied", batchId: b.batchId, inserted: Number(b.inserted ?? 0), holdingsAfter: (b.holdingsAfter ?? {}) as Record<string, number> };
    }
    return { kind: "server_error", status: res.status };
  } catch (e) {
    return (e as Error)?.name === "AbortError" ? { kind: "timeout" } : { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
