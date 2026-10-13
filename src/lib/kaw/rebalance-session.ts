// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 세션 orchestration — Phase 0 순수 모듈들을 앱 저장 흐름에 잇는 층
//
// 흐름 전체:
//
//   첫 변경 직전 PRE capture        capturePre()
//     → dedicated journal 저장      (localStorage, StoreState 밖)
//     → AccountState mirror          (호출부가 setRebalanceSessionMirror 로 반영)
//   완료 시 completion envelope      beginCompletion()
//     → HistoryEntry 멱등 저장       id = hist:<completionId> (store 가 upsert)
//     → RebalancePlan 서버 영속화    **Phase 1B.** 지금은 payload 만 freeze 한다
//     → 양쪽 서버 ACK 확인           settleHistoryWrite / settlePlanWrite
//     → journal/outbox 정리          cleanupCompletion() — 양쪽 confirmed 일 때만
//
// ## 이 모듈이 하지 않는 것
//
//   · **네트워크 I/O 를 하지 않는다.** ACK 는 호출부가 받아서 outcome 으로 넘긴다.
//     "예외가 안 났으니 성공" 을 confirmed 로 바꾸는 경로를 여기에 두지 않는다.
//   · **리밸런싱 완료를 막지 않는다.** 추적할 수 없는 상황(flag OFF, instance 미확정)
//     이면 `not_tracked` 를 돌려주고 호출부는 기존 경로로 그대로 완료한다.
//   · **PRE 를 역산하지 않는다.** 캡처하지 못했으면 pre_basis 는 unknown 이다.
//
// ## flag OFF 보장
//
// 쓰기 진입점(capturePre / beginCompletion)이 **스스로** flag 를 확인하고 OFF 면
// localStorage 를 건드리지 않고 돌아간다. 호출부의 if 문 하나에 의존하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { isActiveOn, type BrokerAccountInstance } from "./broker-account";
import { isSessionTrackingEnabled } from "./rebalance-feature-flags";
import {
  JOURNAL_SCHEMA_VERSION,
  clearJournal,
  decideSessionHydration,
  readJournal,
  writeJournal,
  type DurablePlanKnown,
  type RebalanceJournalEntry,
  type RebalanceSessionMirror,
  type SessionHydration,
} from "./rebalance-journal";
import type { HistoryEntry } from "./store";
import {
  COMPLETION_SCHEMA_VERSION,
  canDeleteEnvelope,
  completionIds,
  confirmHistoryPersistence,
  confirmPlanPersistence,
  markHistoryFailed,
  markHistoryUnknown,
  markPlanFailed,
  pendingEnvelopes,
  putEnvelope,
  readOutbox,
  removeEnvelopeIfComplete,
  type CompletionEnvelope,
  type CompletionIds,
} from "./completion-envelope";
import {
  PLAN_HASH_VERSION,
  planPayloadHash,
  resolvePreBasis,
  type PlanDateMode,
  type PlanPriceEvidence,
  type PlanRowMeta,
  type RebalancePlan,
  type RebalanceSessionSnapshot,
} from "./rebalance-plan";

// ── 공통 ────────────────────────────────────────────────────────────────────

/** journal / outbox 키를 결정하는 좌표. */
export interface SessionContext {
  familyCode: string;
  /** store 의 currentUser (프로필 id). 투자성향 키가 아니다 */
  profile: string;
  accountType: AccountId;
}

/** 시각·id 생성을 주입한다 — 테스트가 결정적이어야 한다. */
export interface SessionDeps {
  now: () => string;
  newId: () => string;
}

export const defaultSessionDeps: SessionDeps = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

// ── account instance 확정 ───────────────────────────────────────────────────

/**
 * 레지스트리가 아직 없을 때 쓰는 **논리계좌 1개짜리 sentinel.**
 *
 * 이것은 "어느 증권사 계좌인가" 에 대한 주장이 **아니다.** 레지스트리가 생기는 순간
 * 실제 `bai:` id 와 달라지므로 `resolvePreBasis` 가 `instance_changed` 로 PRE 를
 * 버린다(fail closed). 서로 다른 증권사 계좌를 이 값으로 **연결하지 않는다** —
 * 비교·lineage 는 전부 실제 instance id 를 요구한다(broker-account.ts).
 */
export const UNREGISTERED_INSTANCE_PREFIX = "bai:unregistered:";

export function unregisteredInstanceId(accountType: AccountId): string {
  return `${UNREGISTERED_INSTANCE_PREFIX}${accountType}`;
}

export type InstanceResolution =
  | { kind: "resolved"; accountInstanceId: string }
  /** 레지스트리가 없다 — sentinel 로 세션만 묶는다 */
  | { kind: "unregistered"; accountInstanceId: string }
  /** 레지스트리가 있는데 유일하게 특정되지 않는다 — **추측하지 않는다** */
  | { kind: "unresolved"; reason: "ambiguous" | "no_active_instance"; candidates: string[] };

/**
 * 이 논리계좌가 그 날짜에 어느 instance 인가.
 *
 * 레지스트리가 있는데 그 날짜에 active 가 0 개거나 2 개 이상이면 **unresolved** 다.
 * 다수결이나 최근값으로 고르지 않는다 — 실물이전 구간에서 틀린 계좌에 PRE 를
 * 붙이는 유일한 경로가 그것이다.
 */
export function resolveSessionAccountInstance(
  accountType: AccountId,
  date: string,
  brokerAccounts?: readonly BrokerAccountInstance[] | null,
): InstanceResolution {
  if (!brokerAccounts?.length) {
    return { kind: "unregistered", accountInstanceId: unregisteredInstanceId(accountType) };
  }
  const active = brokerAccounts.filter(
    (i) => i.logicalAccountType === accountType && isActiveOn(i, date),
  );
  if (!active.length) return { kind: "unresolved", reason: "no_active_instance", candidates: [] };
  if (active.length > 1) {
    return { kind: "unresolved", reason: "ambiguous", candidates: active.map((i) => i.id) };
  }
  return { kind: "resolved", accountInstanceId: active[0].id };
}

function instanceIdOf(r: InstanceResolution): string | null {
  return r.kind === "unresolved" ? null : r.accountInstanceId;
}

// ── mirror ──────────────────────────────────────────────────────────────────

export function mirrorOf(entry: RebalanceJournalEntry): RebalanceSessionMirror {
  return {
    schemaVersion: entry.schemaVersion,
    phase: entry.phase,
    snapshot: entry.snapshot,
    ...(entry.completionId ? { completionId: entry.completionId } : {}),
  };
}

/**
 * mirror 를 다시 써야 하는가. 폴링이 `memState` 를 통째로 교체해 mirror 가 사라지거나
 * 과거 phase 로 되돌아간 경우를 잡는다. **매 렌더마다 저장을 유발하지 않도록**
 * 의미 있는 차이(세션·phase·completionId)만 본다.
 */
export function mirrorNeedsSync(
  entry: RebalanceJournalEntry,
  mirror: RebalanceSessionMirror | null | undefined,
): boolean {
  if (!mirror) return true;
  return (
    mirror.schemaVersion !== entry.schemaVersion ||
    mirror.phase !== entry.phase ||
    mirror.snapshot.sessionId !== entry.snapshot.sessionId ||
    (mirror.completionId ?? null) !== (entry.completionId ?? null)
  );
}

// ── PRE capture ─────────────────────────────────────────────────────────────

export interface PreCaptureInput {
  trigger: RebalanceSessionSnapshot["trigger"];
  /** **첫 변경 직전** 화면의 날짜 모드 */
  dateMode: PlanDateMode;
  /** 변경 직전 수량. rowId → 수량 */
  quantities: Record<string, number>;
  /** 변경 직전 예수금. **undefined = 미입력**(0 과 다르다) */
  cash: number | undefined;
  rowMeta: Record<string, PlanRowMeta>;
  /** 투자성향 키 */
  profileKey: string;
  instance: InstanceResolution;
}

export type PreCaptureResult =
  | { kind: "disabled" }
  | {
      kind: "skipped";
      reason: "past_date_mode" | "future_date_mode" | "instance_unresolved";
    }
  /** 이미 이 세션의 PRE 가 있다. **덮어쓰지 않았다** */
  | { kind: "already_captured"; entry: RebalanceJournalEntry }
  /** 진행 중 세션의 계좌가 지금 계좌와 다르다 — 아무것도 쓰지 않았다(fail closed) */
  | { kind: "instance_mismatch"; sessionInstanceId: string; expectedInstanceId: string }
  | { kind: "captured"; entry: RebalanceJournalEntry; supersededCompletionId?: string }
  /** snapshot 은 만들었지만 **영속되지 않았다.** 성공으로 취급하면 안 된다 */
  | {
      kind: "journal_write_failed";
      entry: RebalanceJournalEntry;
      supersededCompletionId?: string;
    };

/**
 * 첫 변경 직전의 PRE 를 1회 고정한다. 두 번째 호출부터는 아무것도 하지 않는다.
 *
 * 과거/미래 날짜 모드에서는 **캡처 자체를 하지 않는다** — 지금 화면의 수량·예수금은
 * "오늘" 값이고, 그것을 과거 시점의 PRE 로 승격시키는 경로를 만들지 않는다
 * (rebalance-plan.ts "과거 날짜는 fail closed").
 *
 * 진행 중(`capturing`) 세션이 있으면 PRE 를 **절대 덮어쓰지 않는다.** 반대로
 * `completing` 세션은 이미 끝난 완료의 잔재이므로 새 세션이 그 자리를 가져간다 —
 * 그 완료의 복구 수단(frozen payload)은 journal 이 아니라 outbox envelope 에 있고,
 * 이 함수는 envelope 을 건드리지 않는다.
 */
export function capturePre(
  ctx: SessionContext,
  input: PreCaptureInput,
  deps: SessionDeps = defaultSessionDeps,
): PreCaptureResult {
  if (!isSessionTrackingEnabled()) return { kind: "disabled" };
  if (input.dateMode === "past") return { kind: "skipped", reason: "past_date_mode" };
  if (input.dateMode === "future") return { kind: "skipped", reason: "future_date_mode" };
  const expectedInstanceId = instanceIdOf(input.instance);
  if (expectedInstanceId === null) return { kind: "skipped", reason: "instance_unresolved" };

  const existing = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  let supersededCompletionId: string | undefined;
  if (existing) {
    if (existing.phase === "capturing") {
      if (existing.snapshot.accountInstanceId !== expectedInstanceId) {
        return {
          kind: "instance_mismatch",
          sessionInstanceId: existing.snapshot.accountInstanceId,
          expectedInstanceId,
        };
      }
      return { kind: "already_captured", entry: existing };
    }
    supersededCompletionId = existing.completionId;
  }

  const snapshot: RebalanceSessionSnapshot = {
    sessionId: `rbs:${deps.newId()}`,
    accountType: ctx.accountType,
    accountInstanceId: expectedInstanceId,
    startedAt: deps.now(),
    trigger: input.trigger,
    preDateMode: input.dateMode,
    preQuantities: { ...input.quantities },
    ...(input.cash === undefined ? {} : { preCash: input.cash }),
    preRowMeta: { ...input.rowMeta },
    preProfileKey: input.profileKey,
  };
  const entry: RebalanceJournalEntry = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    phase: "capturing",
    snapshot,
  };
  const written = writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, entry);
  const base = supersededCompletionId ? { supersededCompletionId } : {};
  return written
    ? { kind: "captured", entry, ...base }
    : { kind: "journal_write_failed", entry, ...base };
}

/**
 * instance 가 어긋난 **capturing** 세션을 버린다. 쓸 수 없는 PRE 라서 지워도 잃는
 * 것이 없다. `completing` 세션은 지우지 않는다 — 복구 대상이다.
 */
export function discardMismatchedSession(ctx: SessionContext): {
  discarded: boolean;
  reason?: "no_journal" | "completing_kept";
} {
  const existing = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  if (!existing) return { discarded: false, reason: "no_journal" };
  if (existing.phase !== "capturing") return { discarded: false, reason: "completing_kept" };
  clearJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  return { discarded: true };
}

// ── hydration (마운트 / 폴링 복귀) ──────────────────────────────────────────

export interface HydrateInput {
  mirror?: RebalanceSessionMirror | null;
  /** 서버 plan 조회 결과. plan API 가 없는 Phase 1A 에서는 항상 "unknown" 이다 */
  durablePlanKnown: DurablePlanKnown;
  expectedAccountInstanceId?: string;
}

export interface HydrateResult {
  decision: SessionHydration;
  /** mirror → journal 복원을 시도했고 그 결과 */
  journalRestored?: boolean;
}

/**
 * 어떤 세션을 쓸지 정하고, mirror 만 남은 경우 journal 로 복원한다.
 * **삭제는 하지 않는다** — 정리는 `cleanupCompletion` 의 책임이다.
 */
export function hydrateSession(ctx: SessionContext, input: HydrateInput): HydrateResult {
  if (!isSessionTrackingEnabled()) return { decision: { kind: "none" } };
  const journal = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  const decision = decideSessionHydration({
    journal,
    mirror: input.mirror ?? null,
    durablePlanKnown: input.durablePlanKnown,
    ...(input.expectedAccountInstanceId !== undefined
      ? { expectedAccountInstanceId: input.expectedAccountInstanceId }
      : {}),
  });
  if (decision.kind === "restore_from_mirror") {
    const ok = writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, decision.entry);
    return { decision, journalRestored: ok };
  }
  return { decision };
}

/** 지금 유효한 세션 snapshot (없으면 null). PRE 판정의 유일한 입력이다. */
export function activeSessionSnapshot(ctx: SessionContext): RebalanceSessionSnapshot | null {
  if (!isSessionTrackingEnabled()) return null;
  return readJournal(ctx.familyCode, ctx.profile, ctx.accountType)?.snapshot ?? null;
}

// ── 완료 (completion) ───────────────────────────────────────────────────────

export interface CompletionInput {
  /** 완료 시점의 날짜 모드 */
  dateMode: PlanDateMode;
  instance: InstanceResolution;
  planDate: string;
  profileKey: string;

  plannedQuantities: Record<string, number>;
  assertedPostCash: number;
  projectedPostCash?: number | null;

  /** 완료 시점 앱 상태. **PRE 가 아니다** — 포렌식용 */
  appStateQuantities: Record<string, number>;
  appStateCash?: number;

  rowMeta: Record<string, PlanRowMeta>;
  priceMode: RebalancePlan["priceMode"];
  priceEvidence: Record<string, PlanPriceEvidence>;
  targetWeights?: Record<string, number> | null;
  frozenInvested?: number | null;
  frozenInvestedBasis?: RebalancePlan["frozenInvestedBasis"];
  baseAmount?: number | null;

  broker: string;
  brokerProductCode?: string | null;
  actor: string;

  /**
   * 확정된 HistoryEntry payload 를 만든다. **id 를 밖에서 짜지 않게** 하려고
   * 함수로 받는다 — 멱등성의 근거가 `hist:<completionId>` 하나여야 한다.
   */
  buildHistoryPayload: (historyEntryId: string) => unknown;
}

export type BeginCompletionResult =
  /** 추적하지 않는다. 호출부는 **기존 경로로 그대로 완료한다** */
  | { kind: "not_tracked"; reason: "disabled" | "instance_unresolved" | "future_date_mode" }
  | {
      kind: "ready";
      completionId: string;
      ids: CompletionIds;
      envelope: CompletionEnvelope;
      plan: RebalancePlan;
      /** 같은 경제값의 재시도라서 기존 completionId 를 그대로 썼다 */
      reused: boolean;
      journal: "written" | "write_failed" | "no_session";
      outboxWritten: boolean;
    };

/**
 * completion identity 를 고정하고 양쪽 frozen payload 를 한 envelope 에 담는다.
 *
 * `completionId` 재사용 조건은 **경제값이 같을 때뿐이다**: 직전 `completing` 세션의
 * envelope 이 아직 남아 있고 그 `planPayloadHash` 가 지금 만들 plan 의 해시와 같으면
 * 같은 완료의 재시도로 보고 id 를 물려받는다. 해시가 다르면 **새 id** 다 — 아니면
 * 몇 주 전 미완료 completion 의 HistoryEntry 를 이번 기록이 덮어쓴다.
 */
export function beginCompletion(
  ctx: SessionContext,
  input: CompletionInput,
  deps: SessionDeps = defaultSessionDeps,
): BeginCompletionResult {
  if (!isSessionTrackingEnabled()) return { kind: "not_tracked", reason: "disabled" };
  if (input.dateMode === "future") return { kind: "not_tracked", reason: "future_date_mode" };
  const accountInstanceId = instanceIdOf(input.instance);
  if (accountInstanceId === null) {
    return { kind: "not_tracked", reason: "instance_unresolved" };
  }

  const journal = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  const session = journal?.snapshot ?? null;
  const pre = resolvePreBasis(session, input.dateMode, accountInstanceId);

  // 해시는 identity 와 무관한 경제값만 쓴다(rebalance-plan.ts canonicalPlanPayload).
  // 그래서 id 를 정하기 **전에** 계산할 수 있다.
  const planCore = {
    accountInstanceId,
    planDate: input.planDate,
    preBasis: pre.preBasis,
    preQuantities: pre.preQuantities,
    preCash: pre.preCash,
    plannedQuantities: { ...input.plannedQuantities },
    assertedPostCash: input.assertedPostCash,
    targetWeights: input.targetWeights ?? null,
    rowMeta: { ...input.rowMeta },
    priceEvidence: { ...input.priceEvidence },
  };
  const hash = planPayloadHash(planCore);

  const outbox = readOutbox(ctx.familyCode, ctx.profile);
  const priorId = journal?.phase === "completing" ? journal.completionId : undefined;
  const prior = priorId ? outbox[priorId] : undefined;
  const priorHash = prior && (prior.planPayload as RebalancePlan | undefined)?.planPayloadHash;
  const reused = !!priorId && priorHash === hash;
  const completionId = reused ? priorId! : deps.newId();
  const ids = completionIds(completionId);

  const plan: RebalancePlan = {
    id: ids.planId,
    completionId,
    accountType: ctx.accountType,
    broker: input.broker,
    brokerProductCode: input.brokerProductCode ?? null,
    accountInstanceId,
    accountRefFingerprint: null,
    planDate: input.planDate,
    recordedAt: deps.now(),
    // dateMode 는 past / today 만 저장한다. future 는 위에서 걸렀다
    dateMode: input.dateMode === "past" ? "past" : "today",
    preBasis: pre.preBasis,
    preSessionId: session?.sessionId ?? null,
    preSessionStartedAt: session?.startedAt ?? null,
    preProfileKey: session?.preProfileKey ?? input.profileKey,
    preQuantities: pre.preQuantities,
    preCash: pre.preCash,
    preCashAtRecord: input.appStateCash ?? null,
    preDiscardReason: pre.preDiscardReason,
    appStateQuantitiesAtRecord: { ...input.appStateQuantities },
    appStateCashAtRecord: input.appStateCash ?? null,
    plannedQuantities: planCore.plannedQuantities,
    assertedPostCash: input.assertedPostCash,
    projectedPostCash: input.projectedPostCash ?? null,
    targetWeights: planCore.targetWeights,
    frozenInvested: input.frozenInvested ?? null,
    frozenInvestedBasis: input.frozenInvestedBasis ?? null,
    baseAmount: input.baseAmount ?? null,
    rowMeta: planCore.rowMeta,
    priceMode: input.priceMode,
    priceEvidence: planCore.priceEvidence,
    planPayloadHash: hash,
    hashVersion: PLAN_HASH_VERSION,
    actor: input.actor,
  };

  const existing = outbox[completionId];
  const envelope: CompletionEnvelope = existing
    ? // 재시도: 상태·시도횟수를 유지하고 frozen payload 를 **다시 만들지 않는다**
      existing
    : {
        schemaVersion: COMPLETION_SCHEMA_VERSION,
        completionId,
        sessionId: session?.sessionId ?? "",
        accountType: ctx.accountType,
        accountInstanceId,
        createdAt: deps.now(),
        historyEntryPayload: input.buildHistoryPayload(ids.historyEntryId),
        planPayload: plan,
        historyPersistence: "pending",
        planPersistence: "pending",
        attempts: 0,
        manualRetryRequired: false,
      };
  const outboxWritten = putEnvelope(ctx.familyCode, ctx.profile, envelope);

  let journalState: "written" | "write_failed" | "no_session" = "no_session";
  if (journal) {
    const next: RebalanceJournalEntry = { ...journal, phase: "completing", completionId };
    journalState = writeJournal(ctx.familyCode, ctx.profile, ctx.accountType, next)
      ? "written"
      : "write_failed";
  }

  return {
    kind: "ready",
    completionId,
    ids,
    envelope,
    plan,
    reused,
    journal: journalState,
    outboxWritten,
  };
}

// ── ACK 반영 ────────────────────────────────────────────────────────────────

/**
 * legacy history write(`/api/data`)의 결과.
 *
 * **`accepted` 는 confirmed 가 아니다.** `/api/data` 는 계좌 JSON 문서를 통째로
 * 교체하는 last-writer-wins upsert 라서, 단건 ACK 는 "이 요청이 반영됐다"까지만
 * 증명하고 "그 값이 최종 상태로 남는다"는 증명하지 않는다 — 다른 기기의 더 오래된
 * 문서 저장이 뒤에 도착하면 그대로 지워진다(write-queue.ts 상단).
 *
 * 그래서 이 타입에는 **confirmed 로 가는 변종이 없다.** durable 증거는 Phase 1B 의
 * `kaw_rebalance_plan` 행(PK 단위라 blob 저장에 지워지지 않는다)과, 그 뒤의 서버
 * revision guard 가 들어온 다음에 만든다.
 */
export type HistoryWriteOutcome =
  /** 서버가 이 요청을 upsert 했다. **텔레메트리일 뿐**이고 상태는 unknown 으로 둔다 */
  { kind: "accepted" } | { kind: "unknown" } | { kind: "failed"; error: string };

/** plan write(`POST /api/rebalance/plan`, Phase 1B)의 결과. 여기엔 ACK 가 있다. */
export type PlanWriteOutcome =
  /** created = 200, already_exists = 같은 completionId 재전송. 둘 다 행이 있다는 증거다 */
  | { kind: "ack"; outcome: "created" | "already_exists" }
  /** 응답을 받지 못했거나 해석하지 못했다. `reason` 은 화면·로그 문구용이다 */
  | { kind: "unknown"; reason?: string }
  | { kind: "failed"; error: string };

/**
 * **history 병합 write(`POST /api/data/history`, 006)의 결과. 여기엔 ACK 가 있다.**
 *
 * legacy `/api/data` 문서 교체(`HistoryWriteOutcome`)와 **다른 타입**인 이유는 ACK 의
 * 유무다. 병합 RPC 는 기록 1건 단위로 응답하므로 "서버가 이 기록을 받았다"를 증명한다.
 *
 * 다만 그것이 **최종 영속의 보장은 아니다** — 무가드 문서 교체 경로가 아직 남아 있어서
 * (1B-2B flag 기본 OFF) 나중에 도착한 오래된 문서가 그 기록을 덮을 수 있다. 그래서
 * 이 ACK 로 journal/outbox 를 지우는 경로는 이 단계에서 **연결하지 않는다.**
 */
export type HistoryMergeOutcome =
  /**
   * `revision` 은 병합 후 그 계좌 문서의 버전이다. 병합 RPC 가 **revision 을 올리므로**
   * (006), 이 값을 쓰기 가드의 표에 반영하지 않으면 바로 다음 자동저장이 자기 자신이
   * 만든 변경 때문에 409 가 된다(1B-2B). 영속 판정에는 쓰이지 않는다.
   */
  | { kind: "ack"; outcome: "created" | "already_exists"; revision?: number }
  | { kind: "unknown"; reason?: string }
  | { kind: "failed"; error: string };

/** `/api/data` 단건 write 응답의 구조적 모양 (store.ts DataWriteAck 과 호환). */
export type AccountWriteAck =
  | { ok: true; accepted: number | null }
  | { ok: false; error: string; timedOut?: boolean };

/**
 * 응답 → history outcome 매핑. **어느 분기에서도 confirmed 가 나오지 않는다.**
 *
 *   수용됨(accepted>=1)      → accepted  (상태는 unknown 으로 기록된다)
 *   수용 0건 / 미보고        → unknown   (거른 것을 저장한 것으로 읽지 않는다)
 *   실패 / timeout / 네트워크 → failed
 */
export function historyOutcomeOfAck(ack: AccountWriteAck): HistoryWriteOutcome {
  if (!ack.ok)
    return { kind: "failed", error: ack.timedOut ? `시간 초과: ${ack.error}` : ack.error };
  if (ack.accepted !== null && ack.accepted >= 1) return { kind: "accepted" };
  return { kind: "unknown" };
}

/**
 * 확정 예수금 정규화. **완료 저장과 frozen payload 가 같은 값을 쓰게 하는 단일 정의**다
 * (store.ts finalizeRebalance 가 저장할 때 적용하는 식과 같다). 둘이 다르면 복구가
 * 최초 저장과 다른 예수금을 쓴다.
 */
export function normalizeAssertedCash(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function patchEnvelope(
  ctx: SessionContext,
  completionId: string,
  patch: (env: CompletionEnvelope) => CompletionEnvelope,
): CompletionEnvelope | null {
  const outbox = readOutbox(ctx.familyCode, ctx.profile);
  const env = outbox[completionId];
  if (!env) return null;
  const next = patch(env);
  putEnvelope(ctx.familyCode, ctx.profile, next);
  return next;
}

/**
 * history write 결과를 envelope 에 반영한다.
 *
 * **`accepted` 도 `unknown` 으로 기록한다** — 둘을 상태로 구분하지 않는 이유는
 * 삭제 판정이 같아야 하기 때문이다(어느 쪽도 durable 확인이 아니다). "요청은
 * 수용됐다"는 사실은 호출부가 로그/문구로 쓰고 영속 상태로 승격시키지 않는다.
 */
export function settleHistoryWrite(
  ctx: SessionContext,
  completionId: string,
  outcome: HistoryWriteOutcome,
): CompletionEnvelope | null {
  return patchEnvelope(ctx, completionId, (env) => {
    if (outcome.kind === "failed") return markHistoryFailed(env, outcome.error);
    return markHistoryUnknown(env);
  });
}

/**
 * **병합 write 결과를 envelope 에 반영한다. ACK 면 confirmed 로 올린다.**
 *
 * `settleHistoryWrite`(legacy `/api/data`)와 달리 여기에는 ack 분기가 있다 —
 * 병합 RPC 응답이 기록 1건에 대한 서버의 답이기 때문이다. unknown(503·네트워크)은
 * 실패로 적지 않는다: outbox 에 그대로 남아 다음 시도의 대상이 된다.
 */
export function settleHistoryMergeWrite(
  ctx: SessionContext,
  completionId: string,
  outcome: HistoryMergeOutcome,
  deps: SessionDeps = defaultSessionDeps,
): CompletionEnvelope | null {
  return patchEnvelope(ctx, completionId, (env) => {
    if (outcome.kind === "ack") {
      return confirmHistoryPersistence(env, {
        kind: "server_ack",
        outcome: outcome.outcome,
        at: deps.now(),
      });
    }
    if (outcome.kind === "failed") return markHistoryFailed(env, outcome.error);
    return markHistoryUnknown(env);
  });
}

export function settlePlanWrite(
  ctx: SessionContext,
  completionId: string,
  outcome: PlanWriteOutcome,
  deps: SessionDeps = defaultSessionDeps,
): CompletionEnvelope | null {
  return patchEnvelope(ctx, completionId, (env) => {
    if (outcome.kind === "ack") {
      return confirmPlanPersistence(env, {
        kind: "server_ack",
        outcome: outcome.outcome,
        at: deps.now(),
      });
    }
    if (outcome.kind === "failed") return markPlanFailed(env, outcome.error);
    // plan 은 "모른다" 를 쓰지 않는다 — POST 응답이 곧 ACK 라서, 모르면 실패다
    return markPlanFailed(env, "plan 저장 결과를 확인하지 못했습니다");
  });
}

// ── 정리 / 복구 ─────────────────────────────────────────────────────────────

export type CleanupResult =
  | { kind: "cleaned"; journalCleared: boolean }
  | { kind: "kept"; reason: "not_found" | "not_fully_confirmed" | "write_failed" };

/**
 * envelope + journal + mirror 정리. **양쪽 durable 확인 전에는 아무것도 지우지
 * 않는다.** journal 은 그 completionId 를 들고 있을 때만 지운다 — 이미 다음 세션이
 * 슬롯을 가져갔으면 그 PRE 를 날려선 안 된다.
 *
 * mirror 삭제는 StoreState 변경이라 호출부가 한다. `cleaned` 일 때만 지워야 한다.
 */
export function cleanupCompletion(ctx: SessionContext, completionId: string): CleanupResult {
  const removal = removeEnvelopeIfComplete(ctx.familyCode, ctx.profile, completionId);
  if (!removal.removed) {
    const reason =
      removal.reason === "not_fully_confirmed" || removal.reason === "write_failed"
        ? removal.reason
        : "not_found";
    return { kind: "kept", reason };
  }
  const journal = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  const journalCleared =
    journal?.completionId === completionId
      ? clearJournal(ctx.familyCode, ctx.profile, ctx.accountType)
      : false;
  return { kind: "cleaned", journalCleared };
}

/**
 * 지금 이 계좌 세션이 들고 있는 completionId. **GET plan 조회의 대상**이다.
 *
 * journal 이 정본이고 mirror 는 사본이다(rebalance-journal.ts) — 그래서 journal 을
 * 먼저 본다. 폴링이 mirror 를 지워도 journal 이 남아 있으면 조회 대상은 그대로다.
 * 완료 단계가 아니면 null 이고, 그때는 조회할 것도 없다.
 */
export function sessionCompletionId(
  ctx: SessionContext,
  mirror: RebalanceSessionMirror | null,
): string | null {
  if (!isSessionTrackingEnabled()) return null;
  const journal = readJournal(ctx.familyCode, ctx.profile, ctx.accountType);
  return journal?.completionId ?? mirror?.completionId ?? null;
}

/** 지금 복구가 필요한 완료들 (생성순). 화면이 재시도 UI 를 띄울 근거다. */
export function pendingCompletions(ctx: SessionContext): CompletionEnvelope[] {
  if (!isSessionTrackingEnabled()) return [];
  return pendingEnvelopes(readOutbox(ctx.familyCode, ctx.profile));
}

/**
 * 복구 시 다시 적용할 **frozen** history payload. 지금 화면 값으로 재구성하지 않는다
 * (그 사이 수량·예수금이 바뀌었을 수 있다).
 */
export function frozenHistoryPayload(env: CompletionEnvelope): unknown {
  return env.historyEntryPayload;
}

export function frozenPlanPayload(env: CompletionEnvelope): unknown {
  return env.planPayload;
}

/** 복구가 만들/고칠 HistoryEntry id. completionId 가 같으면 항상 같은 1건이다. */
export function recoveryHistoryEntryId(env: CompletionEnvelope): string {
  return completionIds(env.completionId).historyEntryId;
}

export function canDeleteCompletion(env: CompletionEnvelope): boolean {
  return canDeleteEnvelope(env);
}

// ── frozen payload → finalizeRebalance 인자 역조립 (순수) ───────────────────

/**
 * `finalizeRebalance(id, args)` 의 args 모양. envelope 에는 **병합된 HistoryEntry
 * 한 덩어리**가 들어 있고 store 는 4분할 인자를 받으므로 역조립이 필요하다.
 */
export interface FinalizeRebalanceArgs {
  cashBalance: number;
  quantities: Record<string, number>;
  rowHoldings: Record<string, number>;
  entry: Omit<HistoryEntry, "returnPct" | "cashBalance" | "rowQuantitiesSnap" | "rowHoldingsSnap">;
}

function numberMap(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    out[k] = raw;
  }
  return out;
}

/**
 * frozen history payload 에서 최초 저장과 **동일한** finalizeRebalance 인자를 만든다.
 *
 * - **현재 시세나 live account 상태를 다시 읽지 않는다.** 인자는 payload 하나뿐이다.
 * - `returnPct` 는 떼어낸다 — `recalcReturns` 가 **배열 위치에서 파생**하는 값이라
 *   얼려둘 대상이 아니다(이웃 기록이 바뀌면 정당하게 달라진다).
 * - `cashBalance` / `rowQuantitiesSnap` / `rowHoldingsSnap` 은 store 가 별도 인자로
 *   받아 스스로 다시 넣으므로 entry 에서 뺀다. 남기면 같은 값이 두 경로로 들어간다.
 * - 모양이 어긋나면 **고쳐서 통과시키지 않고 null** 이다. 복구가 half-formed 기록을
 *   만드는 것보다 복구를 못 하는 것이 낫다.
 */
export function finalizeArgsFromFrozenPayload(payload: unknown): FinalizeRebalanceArgs | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.date !== "string" || !p.date) return null;
  if (typeof p.cashBalance !== "number" || !Number.isFinite(p.cashBalance)) return null;
  if (typeof p.baseAmount !== "number" || !Number.isFinite(p.baseAmount)) return null;
  if (typeof p.totalValue !== "number" || !Number.isFinite(p.totalValue)) return null;
  if (typeof p.deposit !== "number" || !Number.isFinite(p.deposit)) return null;
  const quantities = numberMap(p.rowQuantitiesSnap);
  const rowHoldings = numberMap(p.rowHoldingsSnap);
  if (!quantities || !rowHoldings) return null;

  const {
    returnPct: _returnPct,
    cashBalance,
    rowQuantitiesSnap: _q,
    rowHoldingsSnap: _h,
    ...entry
  } = p as Record<string, unknown> & { cashBalance: number };

  return {
    cashBalance,
    quantities,
    rowHoldings,
    entry: entry as unknown as FinalizeRebalanceArgs["entry"],
  };
}
