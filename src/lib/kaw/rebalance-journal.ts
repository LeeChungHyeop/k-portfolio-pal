// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 세션 journal — PRE snapshot 의 crash/polling 복구 source of truth
//
// ## 왜 StoreState 밖에 두는가 (실측 경로)
//
// PRE 를 `AccountState.rebalanceSession` 에만 두면 **원격 폴링이 지울 수 있다.**
//
//   store.ts:567-581  scheduleSave → dbSave(...).finally(() => pendingLocalSave = false)
//                     dbSave 는 내부에서 catch 하고 **실패해도** 플래그를 내린다
//   store.ts:757-764  폴링: if (pendingLocalSave) return; dbLoad → memState 통째 교체
//
// 즉 dbSave 실패 직후 폴링이 돌면 세션이 없는 서버 상태로 memState 가 교체되고 PRE 가
// 사라진다. 그래서 journal 은 **StoreState 밖 전용 localStorage 키**에 두고, mirror
// (`AccountState.rebalanceSession`)는 기기 간 동기화·화면 상태용으로만 쓴다.
//
// ## ghost session 을 부활시키지 않는다
//
// 반대 방향의 사고도 있다: plan POST 성공 → journal 삭제 → mirror 삭제용 dbSave 실패
// → 서버에 stale mirror 가 남음 → 다음 접속에서 **이미 끝난 세션이 되살아난다.**
// 그래서 mirror 가 `completing` 이면 **durable plan 상태를 확인하기 전에 복원하지
// 않는다.** 판정은 `decideSessionHydration()` 이 순수 함수로 한다 — 서버 I/O 는
// Phase 1 에서 그 바깥에 붙인다.
//
// ## 삭제 조건
//
// journal 과 mirror 는 **plan + history 양쪽의 durable 확인 이후에만** 삭제한다.
// "plan 저장 실패인데 세션은 삭제됨" 상태가 생길 수 있는 코드 경로를 만들지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import type { RebalanceSessionSnapshot } from "./rebalance-plan";

export const JOURNAL_SCHEMA_VERSION = 1;

/** 계좌별 단일 슬롯. 동시 세션 2개를 만들지 않는다. */
export function journalKey(familyCode: string, profile: string, accountType: AccountId): string {
  return `kaw-rebalance-journal:${familyCode}:${profile}:${accountType}`;
}

export type SessionPhase = "capturing" | "completing";

/** journal 에 저장하는 1건. snapshot 은 첫 변경 직전에 고정되고 불변이다. */
export interface RebalanceJournalEntry {
  schemaVersion: number;
  phase: SessionPhase;
  snapshot: RebalanceSessionSnapshot;
  /** phase 가 completing 일 때의 완료 식별자. envelope 는 outbox 가 들고 있다 */
  completionId?: string;
}

/** `AccountState.rebalanceSession` 에 들어가는 mirror. 폴링에 지워질 수 있다. */
export interface RebalanceSessionMirror {
  schemaVersion: number;
  phase: SessionPhase;
  snapshot: RebalanceSessionSnapshot;
  completionId?: string;
}

// ── localStorage I/O (여기에만 격리한다) ───────────────────────────────────
//
// 사파리 프라이베이트 등에서 localStorage 접근 자체가 throw 할 수 있다. 어떤 경로도
// 예외를 호출부로 흘리지 않고 **degrade** 한다 — 그 경우 PRE 를 못 쓰게 되고
// pre_basis 가 unknown 이 되지만(fail closed), 리밸런싱 자체가 막히지는 않는다.

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 모양이 어긋난 journal 은 **고쳐서 통과시키지 않고 버린다**(null). */
export function parseJournalEntry(raw: unknown): RebalanceJournalEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<RebalanceJournalEntry>;
  if (e.schemaVersion !== JOURNAL_SCHEMA_VERSION) return null;
  if (e.phase !== "capturing" && e.phase !== "completing") return null;
  const s = e.snapshot;
  if (!s || typeof s !== "object") return null;
  if (typeof s.sessionId !== "string" || !s.sessionId) return null;
  if (typeof s.accountType !== "string" || !s.accountType) return null;
  if (typeof s.accountInstanceId !== "string" || !s.accountInstanceId) return null;
  if (!s.preQuantities || typeof s.preQuantities !== "object") return null;
  if (!s.preRowMeta || typeof s.preRowMeta !== "object") return null;
  if (s.preDateMode !== "today" && s.preDateMode !== "past" && s.preDateMode !== "future") {
    return null;
  }
  if (e.phase === "completing" && (typeof e.completionId !== "string" || !e.completionId)) {
    return null;
  }
  return e as RebalanceJournalEntry;
}

export function readJournal(
  familyCode: string,
  profile: string,
  accountType: AccountId,
): RebalanceJournalEntry | null {
  const st = storage();
  if (!st) return null;
  try {
    const raw = st.getItem(journalKey(familyCode, profile, accountType));
    return raw ? parseJournalEntry(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** 성공 여부를 돌려준다 — 호출부가 "기록된 줄 알았는데 아니다"를 구분할 수 있게. */
export function writeJournal(
  familyCode: string,
  profile: string,
  accountType: AccountId,
  entry: RebalanceJournalEntry,
): boolean {
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(journalKey(familyCode, profile, accountType), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * journal 삭제. **plan + history durable 확인 이후에만 부른다.**
 * 이 함수 자체는 조건을 모르므로, 호출부가 그 조건을 지키는지는 테스트로 고정한다.
 */
export function clearJournal(
  familyCode: string,
  profile: string,
  accountType: AccountId,
): boolean {
  const st = storage();
  if (!st) return false;
  try {
    st.removeItem(journalKey(familyCode, profile, accountType));
    return true;
  } catch {
    return false;
  }
}

// ── hydration 판정 (순수) ──────────────────────────────────────────────────

/** 서버의 plan 존재 여부. Phase 1 에서 조회해 넣는다. */
export type DurablePlanKnown = "exists" | "missing" | "unknown";

export type SessionHydration =
  /** journal 을 정본으로 쓴다 */
  | { kind: "use_journal"; entry: RebalanceJournalEntry }
  /** journal 이 없어 mirror 에서 복원한다 (폴링 clobber 복구 포함) */
  | { kind: "restore_from_mirror"; entry: RebalanceJournalEntry }
  /** 이미 끝난 completion 의 잔재다. **복원하지 않고** 정리 대상으로 넘긴다 */
  | { kind: "stale_mirror_cleanup"; completionId: string }
  /** completing 인데 durable 상태를 모른다 — **자동 복원하지 않는다** */
  | { kind: "recovery_pending"; completionId: string }
  /** 계좌 instance 가 달라졌다 — 세션을 쓰지 않는다 */
  | { kind: "discard_instance_mismatch"; sessionInstanceId: string; expectedInstanceId: string }
  | { kind: "none" };

export interface HydrationInput {
  journal: RebalanceJournalEntry | null;
  mirror: RebalanceSessionMirror | null;
  durablePlanKnown: DurablePlanKnown;
  /** 지금 화면의 계좌 instance. 주면 불일치를 검사한다 */
  expectedAccountInstanceId?: string;
}

/**
 * 마운트 시 어떤 세션을 쓸지 정한다. **서버 I/O 없음 — 순수 판정이다.**
 *
 * 규칙 (위에서부터 우선):
 *   1. instance 불일치               → discard (PRE 를 쓰지 않는다)
 *   2. completing + plan exists      → stale_mirror_cleanup. **복원 금지**
 *                                      journal 쪽에도 같이 적용한다 — journal 삭제가
 *                                      실패해 남은 잔재도 같은 ghost 종류다
 *   3. journal 있음                  → use_journal
 *                                      (completing + unknown 이어도 재시도는 멱등하므로
 *                                       진행한다. envelope 가 이 기기에 있다)
 *   4. mirror capturing              → restore_from_mirror
 *   5. mirror completing + missing   → restore_from_mirror (재시도 필요)
 *   6. mirror completing + unknown   → recovery_pending. **자동 복원하지 않는다**
 *                                      (envelope 가 없을 수 있어 blind 복원은 ghost 위험)
 *   7. 그 외                          → none
 */
export function decideSessionHydration(input: HydrationInput): SessionHydration {
  const { journal, mirror, durablePlanKnown, expectedAccountInstanceId } = input;
  const present = journal ?? mirror;
  if (!present) return { kind: "none" };

  if (expectedAccountInstanceId !== undefined) {
    const sessionInstanceId = present.snapshot.accountInstanceId;
    if (sessionInstanceId !== expectedAccountInstanceId) {
      return { kind: "discard_instance_mismatch", sessionInstanceId, expectedInstanceId: expectedAccountInstanceId };
    }
  }

  const completionId = present.completionId;
  if (present.phase === "completing" && completionId && durablePlanKnown === "exists") {
    return { kind: "stale_mirror_cleanup", completionId };
  }

  if (journal) return { kind: "use_journal", entry: journal };

  // 여기부터 journal 은 없고 mirror 만 있다.
  const m = mirror!;
  const entry: RebalanceJournalEntry = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    phase: m.phase,
    snapshot: m.snapshot,
    ...(m.completionId ? { completionId: m.completionId } : {}),
  };
  if (m.phase === "capturing") return { kind: "restore_from_mirror", entry };
  if (durablePlanKnown === "missing") return { kind: "restore_from_mirror", entry };
  return { kind: "recovery_pending", completionId: m.completionId ?? "" };
}
