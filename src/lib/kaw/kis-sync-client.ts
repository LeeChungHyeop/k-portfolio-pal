// ─────────────────────────────────────────────────────────────────────────────
// 계좌 상태 동기화 — 브라우저 쪽 호출 (Phase 4-D)
//
//   · 미리보기(preview)는 읽기 전용이다. live=true 일 때만 서버가 증권사 잔고를 **한 번** 읽는다
//   · 반영(apply)은 사용자가 승인 체크 후 버튼을 눌렀을 때만 호출된다 (자동 호출 · 폴링 · 재시도 없음)
//   · 반영 요청에는 항상 approved: true 와 사용자가 본 계획 해시(planHash)가 실린다
//   · 서버 응답이 `applied` 가 아니면 반영되지 않은 것이다 — 성공으로 다루지 않는다
//   · 계좌번호 · 키 · 토큰을 모른다(세션 토큰만 쓴다)
// ─────────────────────────────────────────────────────────────────────────────

import { getSessionToken } from "./auth";
import type { SyncBlocker, SyncPlanView } from "./broker-sync";

export const SYNC_PREVIEW_PATH = "/api/kis/sync/preview";
export const SYNC_APPLY_PATH = "/api/kis/sync/apply";
const TIMEOUT_MS = 60_000;

export interface SyncBalanceView {
  liveAttempted: boolean;
  failure: string | null;
  source: "kis_live_read" | "stored_observation" | null;
  stateAsOf: string | null;
  observedAt: string | null;
}

export interface SyncPreviewData {
  enabled: boolean;
  flagEnabled: boolean;
  eligible: boolean;
  alreadySynced: boolean;
  needsStaleApproval: boolean;
  blockers: SyncBlocker[];
  plan: SyncPlanView | null;
  balance: SyncBalanceView;
  today: string;
}

export type SyncPreviewOutcome =
  | { kind: "ok"; data: SyncPreviewData }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "server_error"; status: number }
  | { kind: "network_error" }
  | { kind: "timeout" };

export type SyncApplyOutcome =
  | { kind: "applied"; recordId: string; revision: number }
  /** 서버가 사유를 붙여 거절했다. 아무것도 기록되지 않았다 */
  | { kind: "rejected"; code: string; message: string; blockers?: SyncBlocker[]; plan?: SyncPlanView; balance?: SyncBalanceView }
  | { kind: "unavailable" }
  | { kind: "not_configured" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "server_error"; status: number }
  | { kind: "network_error" }
  | { kind: "timeout" };

async function send(path: string, body: unknown, fetchImpl: typeof fetch): Promise<
  { ok: true; status: number; json: Record<string, unknown> | null } | { ok: false; kind: "unauthorized" | "network_error" | "timeout" }
> {
  const token = getSessionToken();
  if (!token) return { ok: false, kind: "unauthorized" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, kind: "unauthorized" };
    return { ok: true, status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (e) {
    return { ok: false, kind: (e as Error)?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** live=true 이면 서버가 증권사 잔고를 한 번 읽는다. 실패해도 재시도하지 않는다 */
export async function requestSyncPreview(
  req: { live: boolean; staleObservationApproved?: boolean }, fetchImpl: typeof fetch = fetch,
): Promise<SyncPreviewOutcome> {
  const r = await send(SYNC_PREVIEW_PATH, { live: req.live, staleObservationApproved: req.staleObservationApproved === true }, fetchImpl);
  if (!r.ok) return { kind: r.kind };
  if (r.status === 403) return { kind: "forbidden" };
  if (r.status === 200 && r.json?.state === "preview") return { kind: "ok", data: r.json as unknown as SyncPreviewData };
  return { kind: "server_error", status: r.status };
}

export async function requestSyncApply(
  req: { planHash: string; staleObservationApproved?: boolean }, fetchImpl: typeof fetch = fetch,
): Promise<SyncApplyOutcome> {
  const r = await send(SYNC_APPLY_PATH, { planHash: req.planHash, approved: true, staleObservationApproved: req.staleObservationApproved === true }, fetchImpl);
  if (!r.ok) return { kind: r.kind };
  const b = r.json;
  if (r.status === 503 && b) {
    if (b.state === "apply_unavailable") return { kind: "unavailable" };
    if (b.state === "not_configured" || b.unavailable === true) return { kind: "not_configured" };
  }
  if (b && b.state === "rejected") {
    return {
      kind: "rejected", code: String(b.code ?? ""), message: String(b.message ?? "요청이 거절됐습니다."),
      ...(Array.isArray(b.blockers) ? { blockers: b.blockers as SyncBlocker[] } : {}),
      ...(b.plan && typeof b.plan === "object" ? { plan: b.plan as SyncPlanView } : {}),
      ...(b.balance && typeof b.balance === "object" ? { balance: b.balance as SyncBalanceView } : {}),
    };
  }
  if (r.status === 403) return { kind: "forbidden" };
  if (r.status === 200 && b?.state === "applied" && typeof b.recordId === "string") {
    return { kind: "applied", recordId: b.recordId, revision: Number(b.revision ?? 0) };
  }
  return { kind: "server_error", status: r.status };
}
