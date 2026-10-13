// ─────────────────────────────────────────────────────────────────────────────
// kaw_data revision guard 의 **순수 규칙** (Phase 1B-2B)
//
// 서버(`data-server.ts handleDataPost`)와 클라이언트(`store.ts dbSave`)가 **같은**
// 모듈을 쓴다. 의존성이 없어 node / 브라우저 / Workers 어디서나 같은 판정이 나온다.
// DB 쪽 원자성은 migration 007 의 `kaw_data_save_guarded` 가 책임진다.
//
// ── 무엇을 가드하는가 ───────────────────────────────────────────────────────
//
//   `_meta` + 네 계좌(프로필 5행)   **CAS 로 가드한다.** 한 번의 저장이고, 하나라도
//                                   어긋나면 전부 쓰지 않는다
//   `_shared` / `_assetLib`         **가드하지 않는다.** 가족 공용 행이라 두 프로필이
//                                   서로의 revision 을 밀어낸다 → 상시 409 가 된다.
//                                   기존 upsert 경로를 그대로 쓴다(동작 보존)
//   `_system` / `_family`           이 경로로 오지 않는다. PIN·프로필 설정은
//                                   saveFamilyRaw 가 쓰고, 세션 토큰 없이도 들어온다
//
// **남아 있는 무가드 경로를 숨기지 않는다** — `UNGUARDED_WRITE_PATHS` 가 그 목록이고
// 테스트가 이 목록과 코드를 맞춰 본다. "가드 완료"는 이 목록이 빌 때의 이야기다.
//
// ── 충돌은 자동으로 풀지 않는다 ─────────────────────────────────────────────
//
// 409 는 "내가 읽은 뒤에 누군가 바꿨다"는 사실이고, 그 뒤 선택은 두 가지뿐이다:
//
//   서버 것을 받는다   내 입력을 버린다 → **사용자 확인 필요**
//   내 것을 밀어넣는다  서버 것을 버린다 → **사용자 확인 필요**
//
// 그래서 이 모듈에는 **자동 재시도도 자동 병합도 없다.** `resolveConflict` 같은 함수가
// 아니라 `conflictPrompt()` 가 있는 이유다 — 결정은 사람이 한다.
// ─────────────────────────────────────────────────────────────────────────────

import { ACCOUNT_IDS } from "./constants";

/** migration 007 `kaw_data_guardable_type` 의 화이트리스트와 **같아야 한다**. */
export const GUARDABLE_TYPES = ["_meta", ...ACCOUNT_IDS] as const;
export type GuardableType = (typeof GUARDABLE_TYPES)[number];

export function isGuardableType(t: unknown): t is GuardableType {
  return typeof t === "string" && (GUARDABLE_TYPES as readonly string[]).includes(t);
}

/** 가드가 **덮지 못하는** 쓰기 경로. 줄어들 때마다 여기서 지운다. */
export const UNGUARDED_WRITE_PATHS = [
  // **지금 production 이 쓰는 경로다.** flag 가 꺼져 있거나 구버전 클라이언트면
  // expectedRevisions 없이 오고, 서버는 기존 last-writer-wins upsert 로 저장한다.
  // 단계적 배포를 위해 일부러 남겨둔 것이고, 이것이 남아 있는 동안은 "가드 완료"가 아니다.
  "kaw_data(프로필 5행) — /api/data 의 무가드 upsert (flag OFF / 구버전 클라이언트)",
  // 가족 공용 행. 프로필마다 revision 을 밀어내므로 CAS 를 걸 수 없다(설계상 제외).
  "kaw_data(_shared/_assetLib) — /api/data 의 공용 종목 라이브러리 upsert",
  // PIN·프로필 설정. 세션 토큰 없이도(마스터코드·비밀질문) 들어오는 경로라 손대지 않는다.
  "kaw_data(_system/_family) — data-server.ts saveFamilyRaw",
  // 프로필 hard delete. 행 자체를 지우므로 revision 비교 대상이 없다.
  "kaw_data(profile 전체) — data-server.ts handleDeleteProfile(hard)",
  // 운영 보정 스크립트. 사람이 직접 돌리고 결과를 눈으로 확인한다.
  "kaw_data — scripts/*.ts 의 직접 REST PATCH",
] as const;

// ── 요청 본문 ───────────────────────────────────────────────────────────────

/** `/api/data` POST 가 받는 행. 기존 모양 그대로다. */
export interface DataRowInput {
  family_code?: unknown;
  profile?: unknown;
  account_type?: unknown;
  data?: unknown;
  updated_at?: unknown;
}

/** 클라이언트가 읽은 revision. 값이 `null` 이면 "그 행이 아직 없다고 믿는다". */
export type ExpectedRevisions = Record<string, number | null>;

export interface GuardedRpcRow {
  account_type: GuardableType;
  data: unknown;
  expected_revision: number | null;
}

export type GuardSplit =
  | {
      ok: true;
      /** RPC 로 보낼 프로필 행. 비어 있을 수 있다(공용 행만 저장하는 경우) */
      guarded: GuardedRpcRow[];
      /** 기존 upsert 로 보낼 공용 행 */
      shared: DataRowInput[];
    }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `expectedRevisions` 를 읽는다. 모양이 틀리면 **가드 없이 저장하지 않는다** —
 * 조용히 무가드로 되돌아가면 가드가 켜져 있다고 믿는 채로 보호가 사라진다.
 */
export function parseExpectedRevisions(v: unknown): ExpectedRevisions | { error: string } {
  if (!isPlainObject(v)) return { error: "expectedRevisions 가 객체가 아닙니다" };
  const out: ExpectedRevisions = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!isGuardableType(k)) return { error: `expectedRevisions 에 가드 대상이 아닌 키: ${k}` };
    if (raw === null) { out[k] = null; continue; }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { error: `expectedRevisions.${k} 는 0 이상의 정수 또는 null 입니다` };
    }
    out[k] = raw;
  }
  return out;
}

/**
 * 세션으로 걸러진 행들을 **가드 대상 / 공용** 으로 나눈다.
 *
 * 가드 대상 행에 `expectedRevisions` 가 **하나라도 없으면 400** 이다. 없는 행만
 * 무가드로 보내면 그게 바로 가드 구멍이고, 그 구멍은 조용하다.
 */
export function splitGuardRows(
  rows: DataRowInput[],
  expected: ExpectedRevisions,
): GuardSplit {
  const guarded: GuardedRpcRow[] = [];
  const shared: DataRowInput[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const type = row.account_type;
    if (row.profile === "_shared") { shared.push(row); continue; }
    if (!isGuardableType(type)) {
      return { ok: false, error: `가드 대상이 아닌 account_type: ${String(type)}` };
    }
    if (seen.has(type)) return { ok: false, error: `account_type 이 중복입니다: ${type}` };
    seen.add(type);
    if (!(type in expected)) {
      return { ok: false, error: `expectedRevisions 에 ${type} 이 없습니다` };
    }
    guarded.push({ account_type: type, data: row.data, expected_revision: expected[type] });
  }

  // RPC 는 account_type 오름차순으로 잠근다. 보내는 순서도 같게 맞춰 둔다
  // (교착은 DB 가 막지만, 재현 가능한 순서가 디버깅을 쉽게 한다).
  guarded.sort((a, b) => a.account_type.localeCompare(b.account_type));
  return { ok: true, guarded, shared };
}

// ── RPC 결과 ────────────────────────────────────────────────────────────────

export type ConflictReason =
  | "revision_mismatch"
  | "row_exists"
  | "row_missing"
  | "history_shrink"
  | "key_loss";

export interface GuardConflict {
  accountType: string;
  reason: ConflictReason;
  expectedRevision: number | null;
  currentRevision: number | null;
  lostKeys?: string[];
  missingHistoryIds?: string[];
}

export type GuardedSaveResult =
  | { kind: "saved"; revisions: Record<string, number>; accepted: number }
  | { kind: "conflict"; conflicts: GuardConflict[]; revisions: Record<string, number | null> }
  | { kind: "unexpected"; raw: unknown };

const CONFLICT_REASONS: readonly ConflictReason[] = [
  "revision_mismatch", "row_exists", "row_missing", "history_shrink", "key_loss",
];

function readRevisionMap(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null) out[k] = null;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[k] = raw;
  }
  return out;
}

/** 모르는 반환값을 **성공으로 읽지 않는다**(006 readHistoryMergeResult 와 같은 규칙). */
export function readGuardedSaveResult(raw: unknown): GuardedSaveResult {
  if (!isPlainObject(raw)) return { kind: "unexpected", raw };

  if (raw.outcome === "saved") {
    const revisions: Record<string, number> = {};
    for (const [k, v] of Object.entries(readRevisionMap(raw.revisions))) {
      if (typeof v === "number") revisions[k] = v;
    }
    const accepted = typeof raw.accepted === "number" ? raw.accepted : Object.keys(revisions).length;
    return { kind: "saved", revisions, accepted };
  }

  if (raw.outcome === "conflict") {
    if (!Array.isArray(raw.conflicts)) return { kind: "unexpected", raw };
    const conflicts: GuardConflict[] = [];
    for (const c of raw.conflicts) {
      if (!isPlainObject(c)) return { kind: "unexpected", raw };
      const reason = c.reason;
      if (typeof reason !== "string" || !CONFLICT_REASONS.includes(reason as ConflictReason)) {
        return { kind: "unexpected", raw };
      }
      conflicts.push({
        accountType: String(c.account_type ?? ""),
        reason: reason as ConflictReason,
        expectedRevision: typeof c.expected_revision === "number" ? c.expected_revision : null,
        currentRevision: typeof c.current_revision === "number" ? c.current_revision : null,
        ...(Array.isArray(c.lost_keys)
          ? { lostKeys: c.lost_keys.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(Array.isArray(c.missing_history_ids)
          ? {
              missingHistoryIds: c.missing_history_ids.filter(
                (x): x is string => typeof x === "string",
              ),
            }
          : {}),
      });
    }
    // conflict 인데 목록이 비어 있으면 모양이 깨진 것이다 — 성공도 충돌도 아니다.
    if (!conflicts.length) return { kind: "unexpected", raw };
    return { kind: "conflict", conflicts, revisions: readRevisionMap(raw.revisions) };
  }

  return { kind: "unexpected", raw };
}

/** Postgres 오류코드. 007 미적용(42883) / 검사 후 경합(40001) / 요청 오류(22023). */
export const isUndefinedFunction = (code: string | undefined): boolean => code === "42883";
export const isSerializationFailure = (code: string | undefined): boolean => code === "40001";
export const isInvalidParameter = (code: string | undefined): boolean => code === "22023";

// ── 클라이언트 쪽 판정 ──────────────────────────────────────────────────────

/** GET `/api/data` 응답 행에서 revision 표를 만든다. 없는 행은 `null` 이다. */
export function revisionsFromRows(
  // 호출부는 `/api/data` 응답 행을 그대로 넘긴다(`data` 등 다른 필드가 함께 온다).
  rows: ReadonlyArray<{ profile?: unknown; account_type?: unknown; revision?: unknown }>,
  profile: string,
): ExpectedRevisions {
  const out: ExpectedRevisions = {};
  for (const t of GUARDABLE_TYPES) out[t] = null;
  for (const row of rows) {
    if (row.profile !== undefined && row.profile !== profile) continue;
    const t = row.account_type;
    if (!isGuardableType(t)) continue;
    // **구버전 서버**는 revision 을 돌려주지 않는다. 그때 0 으로 가정하면 CAS 가
    // 엉뚱한 값으로 성공해버리므로 null(= 행이 없다고 믿음)도 쓰지 않고 건너뛴다 —
    // 표에 키가 없으면 `canGuard()` 가 false 가 되어 가드를 켜지 않는다.
    if (typeof row.revision !== "number" || !Number.isInteger(row.revision)) {
      delete out[t];
      continue;
    }
    out[t] = row.revision;
  }
  return out;
}

/**
 * 지금 가드를 켤 수 있는가. **읽은 revision 이 가드 대상 전부에 대해 있어야 한다.**
 *
 * 하나라도 모르면 무가드로 보내는 대신 가드를 끄고(= 기존 경로) 다음 조회에서 다시
 * 판단한다. 반쪽 가드는 보호가 아니라 착각이다.
 */
export function canGuard(expected: ExpectedRevisions | null): boolean {
  if (!expected) return false;
  return GUARDABLE_TYPES.every((t) => t in expected);
}

/** 저장 성공 응답으로 revision 표를 갱신한다. 응답에 없는 키는 그대로 둔다. */
export function applySavedRevisions(
  expected: ExpectedRevisions | null,
  saved: Record<string, number> | undefined,
): ExpectedRevisions | null {
  if (!saved || !Object.keys(saved).length) return expected;
  const next: ExpectedRevisions = { ...(expected ?? {}) };
  for (const [k, v] of Object.entries(saved)) {
    if (isGuardableType(k) && typeof v === "number") next[k] = v;
  }
  return next;
}

export interface ConflictPrompt {
  /** 사용자에게 보일 한 줄. **무엇이 사라질 수 있는지까지** 말한다 */
  message: string;
  /** 자동으로 풀 수 있는가 — **항상 false 다.** 두 선택 모두 무언가를 버린다 */
  autoResolvable: false;
  /** "서버 내용 불러오기"를 고르면 사라지는 것 — 화면에 **보이는 글자로** 띄운다 */
  reloadWarning: string;
  /** "이 화면으로 덮어쓰기"를 고르면 사라지는 것 */
  overwriteWarning: string;
  reasons: ConflictReason[];
  accountTypes: string[];
}

/** 두 선택의 경고 문구. 툴팁이 아니라 **본문**으로 쓰기 위해 상수로 둔다. */
export const RELOAD_WARNING =
  "서버에 저장된 내용을 불러옵니다. 아직 저장되지 않은 지금 화면의 수정은 모두 사라집니다.";
export const OVERWRITE_WARNING =
  "지금 화면 내용으로 서버를 덮어씁니다. 다른 기기/탭에서 저장한 더 새로운 수정은 모두 사라집니다.";

const REASON_TEXT: Record<ConflictReason, string> = {
  revision_mismatch: "다른 기기/탭에서 먼저 저장된 변경이 있습니다",
  row_exists: "다른 기기에서 이미 만든 데이터가 있습니다",
  row_missing: "서버에서 해당 데이터가 삭제됐습니다",
  history_shrink: "저장하려는 내용에서 기존 리밸런싱 기록이 빠져 있습니다",
  key_loss: "저장하려는 내용에서 기존 항목이 빠져 있습니다",
};

/**
 * 충돌을 사용자 문구로. **여기서 고르지 않는다** — 선택지를 보여주기 위한 재료다.
 * 어느 쪽을 택해도 한쪽 입력이 사라지므로 자동 결정은 하지 않는다.
 */
export function conflictPrompt(conflicts: GuardConflict[]): ConflictPrompt {
  const reasons = [...new Set(conflicts.map((c) => c.reason))];
  const accountTypes = [...new Set(conflicts.map((c) => c.accountType))].sort();
  const head = reasons.map((r) => REASON_TEXT[r]).join(" / ");
  return {
    // **데이터 유실 가능성을 본문에 적는다.** 어느 쪽을 골라도 한쪽 수정이 사라진다.
    message:
      `${head}. 어느 쪽을 선택해도 한쪽의 수정 내용이 사라집니다 — ` +
      `서버 내용을 불러오거나, 지금 화면 내용으로 덮어쓸지 선택해주세요.`,
    autoResolvable: false,
    reloadWarning: RELOAD_WARNING,
    overwriteWarning: OVERWRITE_WARNING,
    reasons,
    accountTypes,
  };
}
