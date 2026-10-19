// ─────────────────────────────────────────────────────────────────────────────
// 계좌 이전 확정 · 잔고 관측 — 브라우저 쪽 호출 (Phase 4-C-1)
//
//   · 자동 호출은 상태 조회(GET, DB 만 읽음)뿐이다. KIS 조회·기록·확정은 **사용자가 버튼을 눌렀을 때만**
//   · 쓰기 요청은 항상 `approved: true` 를 싣는다 — 승인 UI(체크박스 + 버튼)를 거친 경우에만 호출된다
//   · 실패해도 재시도하지 않는다
//   · 계좌번호 · 키 · 토큰을 모른다(세션 토큰만 쓴다)
// ─────────────────────────────────────────────────────────────────────────────

import { getSessionToken } from "./auth";
import type { TransferStateResponse } from "./kis-transfer-compose";
import type { BalanceObservationSummary } from "./kis-balance-observation";
import type { TransferRecord } from "./account-transfer-record";

export const TRANSFER_STATE_PATH = "/api/kis/transfer/state";
export const TRANSFER_OBSERVE_PATH = "/api/kis/transfer/observe";
export const TRANSFER_CONFIRM_PATH = "/api/kis/transfer/confirm";
const TIMEOUT_MS = 60_000;

export type TransferOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "not_configured" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  /** 서버가 사유를 붙여 거절했다 (승인 없음 · 증거 부족 · 이미 확정 등). 아무것도 기록되지 않았다 */
  | { kind: "rejected"; code: string; message: string; detail?: unknown }
  | { kind: "server_error"; status: number }
  | { kind: "network_error" }
  | { kind: "timeout" };

export type ObserveResult =
  | { state: "recorded"; observation: BalanceObservationSummary }
  | { state: "already_recorded"; observation: BalanceObservationSummary }
  | { state: "not_recordable"; reason: string }
  | { state: "gate_blocked"; reason: string }
  | { state: "query_failed"; failure: string };

export interface ConfirmPayload {
  toInstanceId: string;
  fromInstanceId: string | null;
  fromBroker: string;
  fromLabel: string;
  anchorDate: string;
  cashReceived: { amount: number; date: string | null };
  exitTxIds: string[];
  note: string;
  approved: true;
}

async function call<T>(
  path: string, method: "GET" | "POST", body: unknown, okState: (b: Record<string, unknown>) => boolean,
  fetchImpl: typeof fetch,
): Promise<TransferOutcome<T>> {
  const token = getSessionToken();
  if (!token) return { kind: "unauthorized" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 403) return { kind: "forbidden" };
    const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 503 && b && (b.state === "not_configured" || b.unavailable === true)) return { kind: "not_configured" };
    if ((res.status === 400 || res.status === 409) && b && b.state === "rejected") {
      return { kind: "rejected", code: String(b.code ?? ""), message: String(b.message ?? "요청이 거절됐습니다."), ...(b.detail === undefined ? {} : { detail: b.detail }) };
    }
    if (!res.ok || !b || !okState(b)) return { kind: "server_error", status: res.status };
    return { kind: "ok", data: b as unknown as T };
  } catch (e) {
    return (e as Error)?.name === "AbortError" ? { kind: "timeout" } : { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export const requestTransferState = (fetchImpl: typeof fetch = fetch) =>
  call<TransferStateResponse>(TRANSFER_STATE_PATH, "GET", undefined, (b) => b.state === "ok" || b.state === "no_target", fetchImpl);

export const requestBalanceObserve = (fetchImpl: typeof fetch = fetch) =>
  call<ObserveResult>(TRANSFER_OBSERVE_PATH, "POST", { approved: true }, (b) => typeof b.state === "string", fetchImpl);

export const requestTransferConfirm = (payload: ConfirmPayload, fetchImpl: typeof fetch = fetch) =>
  call<{ state: "confirmed"; record: TransferRecord }>(TRANSFER_CONFIRM_PATH, "POST", payload, (b) => b.state === "confirmed", fetchImpl);
