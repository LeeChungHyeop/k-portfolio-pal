// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 완료(completion) envelope — 부분 실패 복구 단위
//
// ## 두 기록은 형제다 — 한쪽에서 다른 쪽을 추론하지 않는다
//
// 한 번의 완료는 **서로 다른 두 기록**을 만든다:
//   legacy `AccountState.history` 1건   (기존 소비처: 성과·백테스트·live view)
//   `kaw_rebalance_plan` 1행            (계획/주장의 durable 증거)
//
// 둘 중 하나만 영속될 수 있다(트랜잭션이 없다). 그래서 완료 시작 시점에 **양쪽 payload
// 를 한 envelope 에 고정**하고, 복구는 그 frozen payload 를 다시 적용하는 것으로만 한다.
//   · plan 에서 history 를 추론하지 않는다
//   · history 에서 plan 을 추론하지 않는다
//
// ## 멱등성
//
// `completionId` 가 완료 1회의 **유일한 identity** 이고 양쪽 id 가 거기서 파생된다.
//   historyEntryId = hist:<completionId>     → 같은 id 는 append 가 아니라 **replace**
//   planId         = plan:<completionId>     → PK 충돌이 곧 성공(이미 있음)
// 그래서 순서 무관하고 몇 번 반복해도 각각 1건이다.
//
// ## historyPersistence 를 fire-and-forget 으로 confirmed 로 올리지 않는다
//
// 현재 코드로는 history 영속을 **확인할 방법이 없다**:
//   store.ts:539-566  dbSave 는 내부에서 전부 catch 하고 **reject 하지 않는다**
//                     (실패는 모듈 변수 dbError 로만 남고 Sidebar 한 줄로 노출된다)
//   store.ts:895-897  finalizeRebalance 는 dbSave 를 **await 하지 않는다**
//
// 그래서 이 모듈은 `confirmed` 로 올리는 경로를 **명시적 서버 ACK 타입**으로만 열어둔다.
// `dbSave` 의 반환값(void)이나 예외 부재를 근거로 confirmed 를 만드는 함수는 없다.
// Phase 1 에서 "서버 ACK 를 반환하는 write 함수"를 만들고 그 ACK 로만 올린다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";

export const COMPLETION_SCHEMA_VERSION = 1;

/** 자동 재시도 상한. 넘으면 사용자가 명시적으로 눌러야 한다(R3). */
export const MAX_AUTO_ATTEMPTS = 3;

/** 완료 1회에서 파생되는 두 결정적 id. */
export interface CompletionIds {
  historyEntryId: string;
  planId: string;
}

export function completionIds(completionId: string): CompletionIds {
  return { historyEntryId: `hist:${completionId}`, planId: `plan:${completionId}` };
}

/** `hist:` / `plan:` id 에서 completionId 를 되읽는다. 모양이 아니면 null. */
export function completionIdOf(id: string): string | null {
  const m = /^(?:hist|plan):(.+)$/.exec(id);
  return m ? m[1] : null;
}

/**
 * 영속 상태. **`confirmed` 는 서버 ACK 로만 올라간다.**
 *
 *   pending    전송했거나 전송할 예정 — 결과를 모른다
 *   confirmed  서버 ACK 를 받았다 (plan: HTTP 200/409, history: Phase 1 의 ACK write)
 *   failed     명시적 실패 응답을 받았다
 *   unknown    확인할 수단이 없다 (현재 dbSave 경로가 여기 해당한다)
 */
export type PersistenceState = "pending" | "confirmed" | "failed" | "unknown";

/** 서버가 실제로 받았다는 증거. 이 타입 없이는 confirmed 로 올릴 수 없다. */
export interface ServerPersistenceAck {
  kind: "server_ack";
  /** plan: created = HTTP 200, already_exists = PK 충돌(409) — 둘 다 ACK 다 */
  outcome: "created" | "already_exists" | "written";
  at: string;
}

/**
 * 완료 1건의 frozen payload 묶음. `kaw-completion-outbox:<family>:<profile>` 에 산다.
 *
 * **StoreState 밖**이다 — 원격 폴링이 `memState` 를 통째로 교체해도 재시도 수단이
 * 살아 있어야 한다(`rebalance-journal.ts` 상단의 실측 경로 참고).
 */
export interface CompletionEnvelope {
  schemaVersion: number;
  completionId: string;
  sessionId: string;
  accountType: AccountId;
  accountInstanceId: string;
  createdAt: string;

  /**
   * `finalizeRebalance` 에 넣은 **정확한 입력값**. 복구는 이것을 다시 적용한다.
   * `backtestGrowth` 는 넣지 않는다 — 비동기 계산이고 실패 시 저장하지 않는 기존
   * 동작(AccountPage.tsx:552-556)을 그대로 둔다.
   */
  historyEntryPayload: unknown;
  /** POST /api/rebalance/plan 본문 전체 */
  planPayload: unknown;

  historyPersistence: PersistenceState;
  planPersistence: PersistenceState;

  attempts: number;
  lastError?: string;
  /** 자동 재시도를 그만두고 사용자 조작을 기다리는 상태인가 */
  manualRetryRequired: boolean;
}

// ── 상태 전이 (전부 새 객체를 돌려준다 — 입력을 변형하지 않는다) ───────────

/**
 * history 영속 confirmed. **ACK 가 있어야만 호출된다.**
 * 현재 `dbSave` 는 ACK 를 만들 수 없으므로 Phase 1 의 ACK write 전까지는
 * `markHistoryUnknown()` 쪽만 쓰인다.
 */
export function confirmHistoryPersistence(
  env: CompletionEnvelope,
  ack: ServerPersistenceAck,
): CompletionEnvelope {
  if (ack.kind !== "server_ack") return env;
  return { ...env, historyPersistence: "confirmed" };
}

export function confirmPlanPersistence(
  env: CompletionEnvelope,
  ack: ServerPersistenceAck,
): CompletionEnvelope {
  if (ack.kind !== "server_ack") return env;
  return { ...env, planPersistence: "confirmed" };
}

/**
 * 확인 수단이 없음을 기록한다. **이것이 현재 history 경로의 정상 상태다.**
 * `pending` 과 구분하는 이유: pending 은 "곧 알게 된다"이고 unknown 은
 * "이 경로로는 영원히 알 수 없다"라서, UI 문구와 삭제 판정이 달라야 한다.
 */
export function markHistoryUnknown(env: CompletionEnvelope): CompletionEnvelope {
  return { ...env, historyPersistence: "unknown" };
}

export function markPlanFailed(env: CompletionEnvelope, error: string): CompletionEnvelope {
  const attempts = env.attempts + 1;
  return {
    ...env,
    planPersistence: "failed",
    attempts,
    lastError: error,
    manualRetryRequired: attempts >= MAX_AUTO_ATTEMPTS,
  };
}

export function markHistoryFailed(env: CompletionEnvelope, error: string): CompletionEnvelope {
  const attempts = env.attempts + 1;
  return {
    ...env,
    historyPersistence: "failed",
    attempts,
    lastError: error,
    manualRetryRequired: attempts >= MAX_AUTO_ATTEMPTS,
  };
}

/** 사용자가 [지금 재시도] 를 눌렀다 — 자동 재시도 카운터를 리셋한다. */
export function resetForManualRetry(env: CompletionEnvelope): CompletionEnvelope {
  return { ...env, attempts: 0, manualRetryRequired: false, lastError: undefined };
}

// ── 삭제 / 복구 판정 ───────────────────────────────────────────────────────

/**
 * envelope(과 journal / mirror)를 삭제해도 되는가.
 *
 * **plan 과 history 양쪽이 confirmed 일 때만 true 다.** `unknown` 은 삭제 근거가 되지
 * 않는다 — 그게 "plan 저장 실패인데 세션은 삭제됨" 상태를 만드는 유일한 경로다.
 */
export function canDeleteEnvelope(env: CompletionEnvelope): boolean {
  return env.historyPersistence === "confirmed" && env.planPersistence === "confirmed";
}

export type RecoveryAction =
  | "retry_history_write"
  | "retry_plan_post"
  | "delete_envelope"
  | "await_manual_retry";

/**
 * 이 envelope 에 지금 무엇을 해야 하는가. 순서가 의미를 갖지 않는다(둘 다 멱등).
 *
 * `manualRetryRequired` 면 자동 동작을 전부 멈추고 사용자 조작을 기다린다 —
 * 400 류는 재시도로 풀리지 않으므로 무한 재시도가 더 나쁘다.
 */
export function nextRecoveryActions(env: CompletionEnvelope): RecoveryAction[] {
  if (canDeleteEnvelope(env)) return ["delete_envelope"];
  if (env.manualRetryRequired) return ["await_manual_retry"];
  const actions: RecoveryAction[] = [];
  if (env.planPersistence !== "confirmed") actions.push("retry_plan_post");
  if (env.historyPersistence !== "confirmed") actions.push("retry_history_write");
  return actions;
}

/** UI 문구 판정용. 성공 toast 는 `all_confirmed` 에서만 띄운다(R5). */
export type CompletionDisplayState =
  | "all_confirmed"
  | "in_flight"
  | "plan_failed"
  | "history_unconfirmed"
  | "manual_retry_required";

export function completionDisplayState(env: CompletionEnvelope): CompletionDisplayState {
  if (canDeleteEnvelope(env)) return "all_confirmed";
  if (env.manualRetryRequired) return "manual_retry_required";
  if (env.planPersistence === "failed") return "plan_failed";
  if (env.planPersistence === "confirmed" && env.historyPersistence !== "confirmed") {
    return "history_unconfirmed";
  }
  return "in_flight";
}

// ── outbox I/O (localStorage. StoreState 밖) ───────────────────────────────

export function outboxKey(familyCode: string, profile: string): string {
  return `kaw-completion-outbox:${familyCode}:${profile}`;
}

export type Outbox = Record<string, CompletionEnvelope>;

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 모양이 어긋난 envelope 은 버린다(조용히 보정하지 않는다). */
export function parseEnvelope(raw: unknown): CompletionEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<CompletionEnvelope>;
  if (e.schemaVersion !== COMPLETION_SCHEMA_VERSION) return null;
  if (typeof e.completionId !== "string" || !e.completionId) return null;
  if (typeof e.sessionId !== "string") return null;
  if (typeof e.accountType !== "string" || !e.accountType) return null;
  if (typeof e.accountInstanceId !== "string" || !e.accountInstanceId) return null;
  if (e.historyEntryPayload === undefined || e.planPayload === undefined) return null;
  const states: PersistenceState[] = ["pending", "confirmed", "failed", "unknown"];
  if (!states.includes(e.historyPersistence as PersistenceState)) return null;
  if (!states.includes(e.planPersistence as PersistenceState)) return null;
  if (typeof e.attempts !== "number" || !Number.isFinite(e.attempts)) return null;
  if (typeof e.manualRetryRequired !== "boolean") return null;
  return e as CompletionEnvelope;
}

export function readOutbox(familyCode: string, profile: string): Outbox {
  const st = storage();
  if (!st) return {};
  try {
    const raw = st.getItem(outboxKey(familyCode, profile));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Outbox = {};
    for (const [id, value] of Object.entries(parsed ?? {})) {
      const env = parseEnvelope(value);
      if (env && env.completionId === id) out[id] = env;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeOutbox(familyCode: string, profile: string, outbox: Outbox): boolean {
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(outboxKey(familyCode, profile), JSON.stringify(outbox));
    return true;
  } catch {
    return false;
  }
}

/** envelope 1건 upsert. 같은 completionId 를 다시 넣어도 1건이다. */
export function putEnvelope(
  familyCode: string,
  profile: string,
  env: CompletionEnvelope,
): boolean {
  const outbox = readOutbox(familyCode, profile);
  outbox[env.completionId] = env;
  return writeOutbox(familyCode, profile, outbox);
}

/**
 * envelope 삭제. **`canDeleteEnvelope` 가 true 가 아니면 삭제하지 않는다.**
 * 조건 판정을 호출부에 맡기지 않는다 — 여기서 막는 것이 가장 싼 방어선이다.
 */
export function removeEnvelopeIfComplete(
  familyCode: string,
  profile: string,
  completionId: string,
): { removed: boolean; reason?: string } {
  const outbox = readOutbox(familyCode, profile);
  const env = outbox[completionId];
  if (!env) return { removed: false, reason: "not_found" };
  if (!canDeleteEnvelope(env)) return { removed: false, reason: "not_fully_confirmed" };
  delete outbox[completionId];
  const ok = writeOutbox(familyCode, profile, outbox);
  return ok ? { removed: true } : { removed: false, reason: "write_failed" };
}

/** 지금 복구가 필요한 envelope 목록 (생성순). */
export function pendingEnvelopes(outbox: Outbox): CompletionEnvelope[] {
  return Object.values(outbox)
    .filter((e) => !canDeleteEnvelope(e))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.completionId.localeCompare(b.completionId));
}
