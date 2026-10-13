// ─────────────────────────────────────────────────────────────────────────────
// 미완료 완료(completion)의 **수동 복구** — 표시 모델 + 재시도 오케스트레이션
//
// 대상은 outbox 에 남은 envelope 이다. 서버 저장이 끝났는지 확인되지 않은 완료를 사용자가
// 눈으로 보고, **직접** 다시 보낸다.
//
// ── 이 모듈이 하지 않는 것 ─────────────────────────────────────────────────
//
//   · **자동 재시도를 하지 않는다.** 타이머·폴링·마운트에서 호출되는 경로가 없다.
//     `retryCompletion` 은 사용자의 클릭에서만 불린다
//   · **envelope 을 자동으로 지우지 않는다.** 기간·건수·ACK 어느 것도 삭제 근거가 아니다.
//     삭제는 `dismissSettled` 하나뿐이고, 사용자 확인 + 양쪽 서버 수신 + **서버 revision
//     보호 검증**이 모두 있을 때만 된다. 보호가 검증되지 않았으면(기본값) 삭제하지 않는다
//   · **frozen payload 만 보낸다.** 지금 화면 값·시세로 payload 를 다시 만들지 않는다.
//     같은 completionId 에 다른 경제값이 올라가면 409/422 가 되어 멱등성이 깨진다
//   · **local 상태를 건드리지 않는다.** `finalizeRebalance` 를 다시 부르지 않으므로
//     HistoryEntry 가 로컬에 중복 생기지 않는다(서버 병합은 id 로 멱등이다)
//   · **journal / mirror 를 건드리지 않는다.** 이 모듈은 outbox 의 envelope 만 읽고 쓴다.
//     새 세션이 journal 슬롯을 가져갔어도 과거 복구가 그 PRE 를 지울 길이 없다
//   · **거래 원장(kaw_transaction_ledger)을 만들지 않는다.** plan/history 는 계획·주장이고
//     체결이 아니다(005 대원칙 1)
//
// ── "확인 못 함"은 "저장 안 됨"이 아니다 ───────────────────────────────────
//
// 503·네트워크·타임아웃은 서버가 받았는지 **모르는** 상태다. 요청이 서버에 닿은 뒤 응답만
// 잃었을 수 있다. 그래서 이 모듈은 쪽별 상태를 네 가지로 나눈다:
//
//   received   서버가 받았다(ACK). **최종 보존의 증명은 아니다** — 무가드 문서 교체가 남아
//              있어 나중에 도착한 오래된 저장이 history 를 덮을 수 있다
//   rejected   서버가 **명시적으로 거부**했다 → 같은 본문으로는 풀리지 않을 수 있다
//   unverified 서버가 받았는지 **모른다** → 다시 보내면 멱등이다(이미 있으면 ACK)
//   waiting    아직 시도 결과가 없다
// ─────────────────────────────────────────────────────────────────────────────

import { isSessionTrackingEnabled } from "./rebalance-feature-flags";
import {
  canDeleteEnvelope,
  completionDisplayState,
  putEnvelope,
  readOutbox,
  resetForManualRetry,
  MAX_AUTO_ATTEMPTS,
  type CompletionDisplayState,
  type CompletionEnvelope,
  type PersistenceState,
  type SideDetail,
} from "./completion-envelope";
import {
  cleanupCompletion,
  frozenHistoryPayload,
  frozenPlanPayload,
  settleHistoryMergeWrite,
  settlePlanWrite,
  type CleanupResult,
  type HistoryMergeOutcome,
  type PlanWriteOutcome,
  type SessionContext,
} from "./rebalance-session";
import { postHistoryMergeWrite, postPlanWrite } from "./completion-api";

// ── 표시 모델 (순수) ────────────────────────────────────────────────────────

export type SideStatus = "received" | "rejected" | "unverified" | "waiting";

export interface SideView {
  status: SideStatus;
  /** 한 줄 라벨 */
  label: string;
  /** 사유. received/waiting 은 보통 없다 */
  detail?: string;
}

export interface CompletionView {
  completionId: string;
  accountType: string;
  createdAt: string;
  history: SideView;
  plan: SideView;
  display: CompletionDisplayState;
  attempts: number;
  /** 3회 실패 등으로 자동 동작이 멈추고 사용자 확인을 기다린다 */
  manualRetryRequired: boolean;
  /** 이 envelope 에서 **다시 보낼 쪽**. 양쪽이 수신 확인이면 비어 있다 */
  retrySides: Array<"history" | "plan">;
  /** 사용자가 읽을 안내 한 줄 */
  note: string;
  /** 양쪽 수신 확인됨 — 정리(dismiss) 대상이 될 수 있다 */
  settled: boolean;
}

const RECEIVED_PLAN = "서버가 수신함";
const RECEIVED_HISTORY = "서버가 수신함 (최종 보존 보장은 아님)";

function sideView(
  persistence: PersistenceState,
  detail: SideDetail | undefined,
  receivedLabel: string,
): SideView {
  if (persistence === "confirmed") return { status: "received", label: receivedLabel };

  // 쪽별 사유가 있으면 그것을 따른다. 없는 구버전 envelope 은 상태만으로 판단한다.
  if (detail?.kind === "failed") {
    return { status: "rejected", label: "서버가 거부함", detail: detail.message };
  }
  if (detail?.kind === "unknown" || persistence === "unknown") {
    return {
      status: "unverified",
      label: "서버 확인 못 함 (저장 실패가 아닙니다)",
      detail: detail?.message ?? "서버가 받았는지 확인하지 못했습니다",
    };
  }
  if (persistence === "failed") {
    // 사유 없는 failed — 거부인지 미확인인지 **모른다**. 미저장으로 단정하지 않는다.
    return { status: "unverified", label: "저장 결과 확인 못 함" };
  }
  return { status: "waiting", label: "전송 대기" };
}

export function describeCompletion(env: CompletionEnvelope): CompletionView {
  const history = sideView(env.historyPersistence, env.historyDetail, RECEIVED_HISTORY);
  const plan = sideView(env.planPersistence, env.planDetail, RECEIVED_PLAN);
  const retrySides: Array<"history" | "plan"> = [];
  if (env.historyPersistence !== "confirmed") retrySides.push("history");
  if (env.planPersistence !== "confirmed") retrySides.push("plan");

  const settled = canDeleteEnvelope(env);
  const rejected = history.status === "rejected" || plan.status === "rejected";

  let note: string;
  if (settled) {
    note =
      "계획과 기록을 서버가 수신했습니다. 수신 확인이며 최종 보존을 보장하지는 않습니다 — " +
      "정리하면 이 기기의 재전송 수단이 사라집니다.";
  } else if (env.manualRetryRequired) {
    note =
      `${MAX_AUTO_ATTEMPTS}회 이상 실패해 자동 동작을 멈췄습니다. ` +
      "아래 사유를 확인한 뒤 직접 다시 보내세요.";
  } else if (rejected) {
    note = "서버가 거부한 항목이 있습니다. 같은 내용으로는 계속 거부될 수 있으니 사유를 확인하세요.";
  } else {
    note =
      "서버 저장 여부를 확인하지 못했습니다. 이 기기에 보관된 내용 그대로 다시 보내면 " +
      "이미 저장돼 있어도 중복되지 않습니다.";
  }

  return {
    completionId: env.completionId,
    accountType: env.accountType,
    createdAt: env.createdAt,
    history,
    plan,
    display: completionDisplayState(env),
    attempts: env.attempts,
    manualRetryRequired: env.manualRetryRequired,
    retrySides,
    note,
    settled,
  };
}

/** outbox 를 **복구 대상 / 수신 확인됨**으로 나눈다. 둘 다 생성순이다. */
export function listCompletions(
  ctx: SessionContext,
): { pending: CompletionView[]; settled: CompletionView[] } {
  if (!isSessionTrackingEnabled()) return { pending: [], settled: [] };
  const all = Object.values(readOutbox(ctx.familyCode, ctx.profile))
    // 이 계좌의 완료만 — 다른 계좌의 envelope 을 이 화면에서 건드리지 않는다.
    .filter((e) => e.accountType === ctx.accountType)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.completionId.localeCompare(b.completionId));
  const views = all.map(describeCompletion);
  return {
    pending: views.filter((v) => !v.settled),
    settled: views.filter((v) => v.settled),
  };
}

// ── outbox 변경 알림 ────────────────────────────────────────────────────────
//
// 화면이 outbox(localStorage)를 **다시 읽을 때**를 알리는 신호다. 타이머 폴링을 두지 않는다
// (폴링이 재시도로 번지는 것을 구조적으로 막는다) — 쓰는 쪽이 끝났을 때만 알린다.

const outboxListeners = new Set<() => void>();

export function subscribeOutbox(fn: () => void): () => void {
  outboxListeners.add(fn);
  return () => void outboxListeners.delete(fn);
}

export function notifyOutboxChanged(): void {
  for (const fn of [...outboxListeners]) {
    try { fn(); } catch { /* 한 구독자의 오류가 나머지를 막지 않는다 */ }
  }
}

// ── 중복 실행 차단 ──────────────────────────────────────────────────────────

/**
 * 진행 중인 completionId. **모듈 전역**이라 화면이 다시 그려지거나 컴포넌트가 둘이어도
 * 같은 완료를 동시에 두 번 보내지 않는다(React state 는 같은 tick 의 두 번째 클릭을
 * 막지 못한다). 완료 흐름(`runCompletion`)도 같은 잠금을 쓴다.
 */
const inFlight = new Set<string>();

function lockKey(ctx: SessionContext, completionId: string): string {
  return `${ctx.familyCode}:${ctx.profile}:${completionId}`;
}

/** 잠금을 잡는다. 이미 진행 중이면 null — 호출부는 아무것도 하지 않는다. */
export function acquireCompletionLock(
  ctx: SessionContext,
  completionId: string,
): (() => void) | null {
  const key = lockKey(ctx, completionId);
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  return () => void inFlight.delete(key);
}

export function isCompletionBusy(ctx: SessionContext, completionId: string): boolean {
  return inFlight.has(lockKey(ctx, completionId));
}

// ── 수동 재시도 ─────────────────────────────────────────────────────────────

export interface RecoveryDeps {
  postHistory: (accountType: string, payload: unknown) => Promise<HistoryMergeOutcome>;
  postPlan: (payload: unknown) => Promise<PlanWriteOutcome>;
  /** 병합이 올린 revision 을 가드 표에 반영한다(store.noteServerRevision) */
  onHistoryRevision?: (accountType: string, revision: number | undefined) => void;
}

export const defaultRecoveryDeps: RecoveryDeps = {
  postHistory: (accountType, payload) => postHistoryMergeWrite(accountType, payload),
  postPlan: (payload) => postPlanWrite(payload),
};

export type RetryResult =
  /** 추적이 꺼져 있다 — 아무것도 하지 않았다 */
  | { kind: "disabled" }
  | { kind: "not_found" }
  /** 이미 진행 중이다(중복 클릭) — 아무것도 하지 않았다 */
  | { kind: "busy" }
  /** 양쪽이 이미 수신 확인이다 — 보낼 것이 없다 */
  | { kind: "nothing_to_do" }
  | {
      kind: "done";
      sent: Array<"history" | "plan">;
      history?: HistoryMergeOutcome;
      plan?: PlanWriteOutcome;
      view: CompletionView;
    };

/**
 * **사용자가 누른** 재시도 1회. 수신 확인되지 않은 쪽만, envelope 의 frozen payload 로,
 * 같은 completionId 에 보낸다.
 *
 *   · 이미 confirmed 인 쪽은 다시 보내지 않는다(불필요한 호출·감사 기록을 만들지 않는다)
 *   · 3회 실패로 멈춘 envelope 도 **사용자가 누른 것**이므로 카운터를 리셋하고 진행한다
 *     (`resetForManualRetry`). 눌러야만 움직인다는 점이 "수동 처리"의 의미다
 *   · 결과가 실패·미확인이어도 envelope 은 그대로 남는다
 *
 * 응답 번역과 settle 은 완료 흐름과 **같은 함수**를 쓴다 — 경로별로 판정이 갈라지지 않는다.
 */
export async function retryCompletion(
  ctx: SessionContext,
  completionId: string,
  deps: RecoveryDeps = defaultRecoveryDeps,
): Promise<RetryResult> {
  if (!isSessionTrackingEnabled()) return { kind: "disabled" };

  const release = acquireCompletionLock(ctx, completionId);
  if (!release) return { kind: "busy" };

  try {
    const env = readOutbox(ctx.familyCode, ctx.profile)[completionId];
    if (!env) return { kind: "not_found" };
    if (canDeleteEnvelope(env)) return { kind: "nothing_to_do" };

    // 사용자가 눌렀으므로 멈춘 상태를 풀고 진행한다. 저장 실패하면 시도하지 않는다 —
    // 카운터를 못 바꾼 채 보내면 settle 이 낡은 envelope 을 기준으로 갱신된다.
    if (env.manualRetryRequired) {
      const reset = resetForManualRetry(env);
      if (!putEnvelope(ctx.familyCode, ctx.profile, reset)) {
        return { kind: "not_found" };
      }
    }

    const current = readOutbox(ctx.familyCode, ctx.profile)[completionId];
    if (!current) return { kind: "not_found" };

    const sendHistory = current.historyPersistence !== "confirmed";
    const sendPlan = current.planPersistence !== "confirmed";
    const sent: Array<"history" | "plan"> = [];

    // 둘 다 멱등이라 병렬로 보낸다(순서 의존이 없다). 단 계좌 문서가 서버에 없으면 history
    // 병합이 404 를 받는데, 그것은 실패 사유로 그대로 남는다 — 여기서 보정하지 않는다.
    const [history, plan] = await Promise.all([
      sendHistory
        ? (sent.push("history"),
          deps.postHistory(current.accountType, frozenHistoryPayload(current)))
        : Promise.resolve(undefined),
      sendPlan
        ? (sent.push("plan"), deps.postPlan(frozenPlanPayload(current)))
        : Promise.resolve(undefined),
    ]);

    if (history) {
      settleHistoryMergeWrite(ctx, completionId, history);
      if (history.kind === "ack") deps.onHistoryRevision?.(current.accountType, history.revision);
    }
    if (plan) settlePlanWrite(ctx, completionId, plan);

    const after = readOutbox(ctx.familyCode, ctx.profile)[completionId];
    return {
      kind: "done",
      sent,
      ...(history ? { history } : {}),
      ...(plan ? { plan } : {}),
      view: describeCompletion(after ?? current),
    };
  } finally {
    release();
    notifyOutboxChanged();
  }
}

// ── 정리(사용자 확인 후) ────────────────────────────────────────────────────

/**
 * 정리 허용 여부. **호출부가 판정해서 넘긴다** — 이 모듈은 store 를 읽지 않는다.
 * 기본값(인자를 안 넘긴 경우)은 **거부**다: 게이트를 깜빡한 호출부가 삭제를 열어두지
 * 않게 하려는 것이다(fail-closed).
 */
export interface DismissGate {
  allowed: boolean;
  /** 거부 사유. 화면이 그대로 보여준다 */
  reason: string;
}

export const DISMISS_DENIED_BY_DEFAULT: DismissGate = {
  allowed: false,
  reason: "서버 기록의 보존이 확인되지 않아 정리할 수 없습니다.",
};

export type DismissResult =
  | CleanupResult
  | { kind: "busy" }
  /** 게이트가 거부했다 — **아무것도 지우지 않았다** */
  | { kind: "blocked"; reason: string };

/**
 * 양쪽 **수신 확인**된 envelope 을 사용자가 정리한다.
 *
 * 삭제에는 **세 겹의 조건**이 모두 필요하다:
 *   1. `gate.allowed` — 서버 revision 보호가 검증됐다(store.getRevisionProtectionStatus).
 *      ACK 만으로는 부족하다: 무가드 문서 교체가 남아 있어 그 기록이 나중에 덮일 수
 *      있고, envelope 은 그때 다시 보낼 유일한 수단이다
 *   2. 양쪽 confirmed — `cleanupCompletion` → `removeEnvelopeIfComplete` 가 다시 본다
 *   3. 사용자의 확인 — 호출부(패널)가 확인 단계를 거친 뒤에만 부른다
 *
 * `cleanupCompletion` 은 journal 을 **그 completionId 를 들고 있을 때만** 지운다.
 * 새 세션이 슬롯을 가져갔으면 그 PRE 는 그대로 둔다. 진행 중인 재시도가 있으면 하지 않는다.
 */
export function dismissSettled(
  ctx: SessionContext,
  completionId: string,
  gate: DismissGate = DISMISS_DENIED_BY_DEFAULT,
): DismissResult {
  if (!gate.allowed) return { kind: "blocked", reason: gate.reason };
  if (isCompletionBusy(ctx, completionId)) return { kind: "busy" };
  const result = cleanupCompletion(ctx, completionId);
  notifyOutboxChanged();
  return result;
}
