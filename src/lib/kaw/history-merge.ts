// ─────────────────────────────────────────────────────────────────────────────
// HistoryEntry 병합의 **순수 규칙** — 경제값 해시 / 본문 검증 / 충돌 판정
//
// 의존성이 없어 node / 브라우저 / Workers 어디서나 같은 값이 나온다(서버 핸들러는
// `history-server.ts`, DB 쪽 원자성은 migration 006 의 `kaw_data_merge_history`).
//
// ── 왜 해시가 필요한가 ─────────────────────────────────────────────────────
//
// 완료 1회의 identity 는 `hist:<completionId>` 다(completion-envelope.ts). 같은 id 가
// 두 번 들어오는 경우는 두 가지이고, **둘을 섞으면 안 된다**:
//
//   재시도         같은 id + 같은 경제값   → 멱등 성공. 행이 이미 있다는 것이 저장의 증거다
//   서로 다른 기록  같은 id + 다른 경제값   → **409.** 조용히 ACK 하면 "저장된 것과 다른
//                                            기록"을 저장됐다고 믿게 된다
//
// ── 무엇이 "경제값" 인가 ───────────────────────────────────────────────────
//
// 들어가는 것(기록이 말하는 사실):
//   date / baseAmount / totalValue / deposit / cashBalance
//   holdings / rowQuantitiesSnap / rowHoldingsSnap / rowEtfSnap / rowAssetSnap
//
// 빠지는 것:
//   id              identity 다. 해시의 비교 대상이 아니라 비교의 **열쇠**다
//   returnPct       **파생이고 체인이다.** 앞 기록과의 관계에서 나오므로(store.ts
//                   recalcReturns) 과거 기록이 하나 끼어들면 값이 바뀐다. 포함시키면
//                   재계산된 재시도가 전부 409 가 된다
//   backtestGrowth  **파생이고 재계산된다.** schemaVersion / cashflowKey 가 달라지면
//                   클라이언트가 알아서 다시 계산한다(backtest.ts needsBacktestRecompute).
//                   덩치도 커서 identity 에 넣으면 비교가 그 모듈의 버전에 묶인다
//   rowLabelSnap    **표시용 자산명**이다. 성향에서 라벨만 바꿔도 409 가 되면 안 된다
//
// 두 저장값은 **버리지 않는다** — 해시에서만 빠진다. 서버는 받은 그대로 저장한다
// (hydration 은 returnPct 를 다시 계산하지 않으므로, 떼면 화면의 수익률이 빈다).
//
// ── 맵 정규화 ───────────────────────────────────────────────────────────────
//
// 수량·금액 맵에서 **0 과 "키가 없음"은 경제적으로 같다**(그 종목을 들고 있지 않다).
// 정규화하지 않으면 `{kr: 0}` 과 `{}` 가 다른 해시가 되어, 같은 완료의 재시도가
// 409 로 떨어진다. 반대로 `cashBalance` 는 **0 과 모름(null)을 구분한다** —
// 프로젝트 전체의 null 정책이다(모르는 것을 0 으로 채우지 않는다).
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalJson, stableDigest } from "./rebalance-plan";
import { ACCOUNT_IDS } from "./constants";

export const HISTORY_HASH_VERSION = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 004 의 fingerprint, 005 의 `p1|` / `c1|` 과 같은 모양이다. */
export function historyEntryHash(
  entry: HistoryEntryInput,
  version: number = HISTORY_HASH_VERSION,
): string {
  return `h${version}|${stableDigest(canonicalJson(canonicalHistoryPayload(entry)))}`;
}

/** 해시 문자열에서 규칙 버전을 읽는다. 모양이 아니면 null. */
export function historyHashVersionOf(hash: string | undefined): number | null {
  const m = /^h(\d+)\|/.exec(hash ?? "");
  return m ? Number(m[1]) : null;
}

// ── 검증 대상 모양 ──────────────────────────────────────────────────────────

/**
 * 병합 요청이 담을 수 있는 `HistoryEntry` 의 모양.
 *
 * store.ts 의 `HistoryEntry` 를 그대로 import 하지 않는다 — 그쪽은 클라이언트 번들의
 * 타입이고, 여기서 필요한 것은 **JSON 으로 건너온 값의 검증**이다. 필드 목록은
 * 아래 `ENTRY_KEYS` 가 유일한 근거이고, store.ts 와 어긋나면 테스트가 깨진다.
 */
export interface HistoryEntryInput {
  id: string;
  date: string;
  baseAmount: number;
  totalValue: number;
  deposit: number;
  cashBalance?: number | null;
  returnPct?: number | null;
  holdings?: Record<string, number>;
  rowHoldingsSnap?: Record<string, number>;
  rowQuantitiesSnap?: Record<string, number>;
  rowEtfSnap?: Record<string, string>;
  rowLabelSnap?: Record<string, string>;
  rowAssetSnap?: Record<string, string>;
  backtestGrowth?: Record<string, unknown>;
}

/**
 * 받아들이는 키의 **전부**. 모르는 키는 400 으로 거부한다 —
 * `kaw_data.data` 는 지워지지 않는 문서라서, 오타 하나가 영구히 남고 다음 재시도의
 * 해시까지 바꿔 409 를 만든다. 필드를 늘릴 때는 여기와 해시 payload 양쪽을 고친다.
 */
export const ENTRY_KEYS = [
  "id", "date", "baseAmount", "totalValue", "deposit", "cashBalance", "returnPct",
  "holdings", "rowHoldingsSnap", "rowQuantitiesSnap",
  "rowEtfSnap", "rowLabelSnap", "rowAssetSnap", "backtestGrowth",
] as const;

/** 해시에서 빠지는 파생/표시 필드. 저장은 한다. */
export const DERIVED_KEYS = ["returnPct", "backtestGrowth", "rowLabelSnap"] as const;

const NUMBER_MAP_KEYS = ["holdings", "rowHoldingsSnap", "rowQuantitiesSnap"] as const;
const STRING_MAP_KEYS = ["rowEtfSnap", "rowLabelSnap", "rowAssetSnap"] as const;

// ── canonical payload ───────────────────────────────────────────────────────

export interface CanonicalHistoryPayload {
  date: string;
  baseAmount: number;
  totalValue: number;
  deposit: number;
  /** 미입력(absent/undefined)은 null 이다. 0 으로 채우지 않는다 */
  cashBalance: number | null;
  holdings: Record<string, number>;
  rowQuantitiesSnap: Record<string, number>;
  rowHoldingsSnap: Record<string, number>;
  rowEtfSnap: Record<string, string>;
  rowAssetSnap: Record<string, string>;
}

/** 0 과 "없음"을 같게. 키 정렬은 canonicalJson 이 한다. */
function normalizeNumberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw !== 0) out[k] = raw;
  }
  return out;
}

/** 빈 문자열은 "없음"과 같게. 종목명/assetId 가 빈 값인 것은 정보가 없다는 뜻이다. */
function normalizeStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw === "string" && raw !== "") out[k] = raw;
  }
  return out;
}

export function canonicalHistoryPayload(entry: HistoryEntryInput): CanonicalHistoryPayload {
  return {
    date: entry.date,
    baseAmount: entry.baseAmount,
    totalValue: entry.totalValue,
    deposit: entry.deposit,
    cashBalance: entry.cashBalance ?? null,
    holdings: normalizeNumberMap(entry.holdings),
    rowQuantitiesSnap: normalizeNumberMap(entry.rowQuantitiesSnap),
    rowHoldingsSnap: normalizeNumberMap(entry.rowHoldingsSnap),
    rowEtfSnap: normalizeStringMap(entry.rowEtfSnap),
    rowAssetSnap: normalizeStringMap(entry.rowAssetSnap),
  };
}

// ── 본문 검증 ───────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** `undefined`/`null` 은 null, 유한수는 그 값, 그 외는 `undefined`(= 모양 오류). */
function numOrNull(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface HistoryMergeRequest {
  accountType: (typeof ACCOUNT_IDS)[number];
  /** DB 에 그대로 들어가는 기록. 모르는 키는 이미 걸러져 있다 */
  entry: HistoryEntryInput;
  /** 서버가 **다시 계산한** 해시. 클라이언트가 보낸 값은 검증에만 쓴다 */
  entryHash: string;
  hashVersion: number;
}

export type HistoryMergeValidation =
  | { ok: true; request: HistoryMergeRequest }
  | { ok: false; error: string; status: 400 };

const bad = (error: string): HistoryMergeValidation => ({ ok: false, error, status: 400 });

/**
 * 본문 → 병합 요청.
 *
 * `family_code` / `profile` 은 **세션에서만** 온다(여기서는 아예 받지 않는다 —
 * `/api/data` handleDataPost 와 같은 규칙). 본문에 들어 있어도 쓰이지 않는다.
 *
 * 해시는 **서버가 다시 계산한다.** 클라이언트가 보낸 `entryHash` 는 있으면 비교만
 * 하고(불일치 → 400), 저장·판정에는 서버 계산값을 쓴다. 한 번 어긋난 해시를 그대로
 * 믿으면 그 뒤의 409 판정 전체가 무력해진다(plan-server.ts 와 같은 이유).
 */
export function validateHistoryMergeBody(body: unknown): HistoryMergeValidation {
  if (!isPlainObject(body)) return bad("본문이 객체가 아닙니다");

  const accountType = body.accountType;
  if (
    typeof accountType !== "string" ||
    !ACCOUNT_IDS.includes(accountType as (typeof ACCOUNT_IDS)[number])
  ) {
    return bad("accountType 이 올바르지 않습니다");
  }

  const raw = body.entry;
  if (!isPlainObject(raw)) return bad("entry 가 필요합니다");

  const unknownKeys = Object.keys(raw).filter(
    (k) => !(ENTRY_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length) {
    return bad(`entry 에 알 수 없는 필드가 있습니다: ${unknownKeys.sort().join(", ")}`);
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return bad("entry.id 가 필요합니다");

  const date = typeof raw.date === "string" ? raw.date : "";
  if (!DATE_RE.test(date)) return bad("entry.date 는 YYYY-MM-DD 입니다");

  const baseAmount = num(raw.baseAmount);
  const totalValue = num(raw.totalValue);
  const deposit = num(raw.deposit);
  if (baseAmount === null) return bad("entry.baseAmount 가 필요합니다");
  if (totalValue === null) return bad("entry.totalValue 가 필요합니다");
  if (deposit === null) return bad("entry.deposit 가 필요합니다");

  // 미입력(키 없음)과 0 을 구분한다. 역산해서 채우지 않는다 —
  // 과거 기록의 `baseAmount - totalValue` 를 예수금으로 보면 안 된다(store.ts 주석).
  const cashBalance = numOrNull(raw.cashBalance);
  if (cashBalance === undefined) return bad("entry.cashBalance 의 모양이 올바르지 않습니다");
  const returnPct = numOrNull(raw.returnPct);
  if (returnPct === undefined) return bad("entry.returnPct 의 모양이 올바르지 않습니다");

  const entry: HistoryEntryInput = {
    id, date, baseAmount, totalValue, deposit,
    // null 은 **보내지 않는다** — 없음은 키를 빼는 것으로 표현한다(기존 기록과 같은 모양).
    ...(cashBalance === null ? {} : { cashBalance }),
    returnPct,
  };

  for (const key of NUMBER_MAP_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (!isPlainObject(v)) return bad(`entry.${key} 의 모양이 올바르지 않습니다`);
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return bad(`entry.${key}.${k} 가 수가 아닙니다`);
      }
      out[k] = n;
    }
    entry[key] = out;
  }

  for (const key of STRING_MAP_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (!isPlainObject(v)) return bad(`entry.${key} 의 모양이 올바르지 않습니다`);
    const out: Record<string, string> = {};
    for (const [k, s] of Object.entries(v)) {
      if (typeof s !== "string") return bad(`entry.${key}.${k} 가 문자열이 아닙니다`);
      out[k] = s;
    }
    entry[key] = out;
  }

  // 백테스트 스냅샷은 **통째로 통과시킨다** — 해시에서 빠지는 파생값이고, 모양은
  // backtest.ts 가 schemaVersion 으로 스스로 판정한다. 여기서 필드를 검사하면
  // 그 모듈이 바뀔 때마다 저장 경로가 같이 깨진다. 객체인지만 본다.
  if (raw.backtestGrowth !== undefined && raw.backtestGrowth !== null) {
    if (!isPlainObject(raw.backtestGrowth)) return bad("entry.backtestGrowth 가 객체가 아닙니다");
    entry.backtestGrowth = raw.backtestGrowth;
  }

  const givenVersion = numOrNull(body.hashVersion);
  if (givenVersion === undefined) return bad("hashVersion 의 모양이 올바르지 않습니다");
  const hashVersion = givenVersion ?? HISTORY_HASH_VERSION;
  if (!Number.isInteger(hashVersion) || hashVersion < 1 || hashVersion > HISTORY_HASH_VERSION) {
    return bad(`hashVersion 을 해석할 수 없습니다 (서버 최신: ${HISTORY_HASH_VERSION})`);
  }

  const entryHash = historyEntryHash(entry, hashVersion);

  // 클라이언트가 해시를 같이 보냈으면 **일치해야 한다.** 믿어서 쓰는 게 아니라,
  // 어긋남 자체가 버그 신호라 조용히 넘기지 않는다.
  const given = body.entryHash;
  if (given !== undefined && given !== null) {
    if (typeof given !== "string") return bad("entryHash 의 모양이 올바르지 않습니다");
    if (historyHashVersionOf(given) !== hashVersion) {
      return bad("entryHash 의 버전 prefix 가 hashVersion 과 다릅니다");
    }
    if (given !== entryHash) return bad("entryHash 가 entry 와 일치하지 않습니다");
  }

  return {
    ok: true,
    request: {
      accountType: accountType as (typeof ACCOUNT_IDS)[number],
      entry,
      entryHash,
      hashVersion,
    },
  };
}

// ── 충돌 판정 ───────────────────────────────────────────────────────────────

/**
 * 같은 id 가 이미 있을 때의 판정. **경제값 해시가 같을 때만 ACK 다.**
 *
 * 저장된 기록을 읽지 못했으면(RPC 가 entry 를 안 돌려줬다) ACK 하지 않는다 —
 * 모르는 것을 성공으로 올리면 그게 바로 "저장 안 됐는데 세션이 삭제된" 상태를 만든다
 * (plan-server.ts planConflictOutcome 과 같은 규칙).
 */
export function historyConflictOutcome(
  stored: unknown,
  incomingHash: string,
  version: number = HISTORY_HASH_VERSION,
):
  | { kind: "already_exists"; storedHash: string }
  | { kind: "hash_mismatch"; storedHash: string }
  | { kind: "unverified" } {
  if (!isPlainObject(stored)) return { kind: "unverified" };
  const v = validateStoredEntry(stored);
  if (!v) return { kind: "unverified" };
  const storedHash = historyEntryHash(v, version);
  return storedHash === incomingHash
    ? { kind: "already_exists", storedHash }
    : { kind: "hash_mismatch", storedHash };
}

/**
 * **저장된** 기록에서 해시 계산에 필요한 만큼만 읽는다.
 *
 * `validateHistoryMergeBody` 를 쓰지 않는다 — 저장된 기록은 레거시 경로(`/api/data`
 * 문서 교체)로 들어온 것일 수 있어서 모르는 키나 빠진 필드가 있을 수 있고, 그것을
 * 400 으로 거부하면 **멱등 재시도가 영구히 409** 가 된다. 해시에 들어가는 값만 본다.
 */
function validateStoredEntry(stored: Record<string, unknown>): HistoryEntryInput | null {
  const date = typeof stored.date === "string" ? stored.date : "";
  if (!DATE_RE.test(date)) return null;
  const baseAmount = num(stored.baseAmount) ?? 0;
  const totalValue = num(stored.totalValue) ?? 0;
  const deposit = num(stored.deposit) ?? 0;
  const cashBalance = numOrNull(stored.cashBalance);
  return {
    id: typeof stored.id === "string" ? stored.id : "",
    date, baseAmount, totalValue, deposit,
    cashBalance: cashBalance === undefined ? null : cashBalance,
    holdings: normalizeNumberMap(stored.holdings),
    rowQuantitiesSnap: normalizeNumberMap(stored.rowQuantitiesSnap),
    rowHoldingsSnap: normalizeNumberMap(stored.rowHoldingsSnap),
    rowEtfSnap: normalizeStringMap(stored.rowEtfSnap),
    rowAssetSnap: normalizeStringMap(stored.rowAssetSnap),
  };
}

// ── RPC 결과 해석 ───────────────────────────────────────────────────────────

/** migration 006 `kaw_data_merge_history` 의 반환 모양. */
export interface HistoryMergeRpcResult {
  outcome?: unknown;
  revision?: unknown;
  history_count?: unknown;
  entry?: unknown;
  stale_return_pct_ids?: unknown;
}

export type HistoryMergeOutcome =
  | {
      kind: "created";
      revision: number | null;
      historyCount: number | null;
      staleReturnPctIds: string[];
    }
  | { kind: "exists"; revision: number | null; historyCount: number | null; entry: unknown }
  | { kind: "account_row_missing" }
  | { kind: "unexpected"; raw: unknown };

/**
 * RPC 반환 jsonb → 판정. **모르는 outcome 을 성공으로 읽지 않는다.**
 * (RPC 가 구버전이거나 반환 모양이 바뀌면 `unexpected` 로 떨어뜨려 500 을 받는다.)
 */
export function readHistoryMergeResult(raw: unknown): HistoryMergeOutcome {
  if (!isPlainObject(raw)) return { kind: "unexpected", raw };
  const r = raw as HistoryMergeRpcResult;
  const revision = num(r.revision);
  const historyCount = num(r.history_count);

  if (r.outcome === "account_row_missing") return { kind: "account_row_missing" };
  if (r.outcome === "already_exists") {
    return { kind: "exists", revision, historyCount, entry: r.entry };
  }
  if (r.outcome === "created") {
    const stale = Array.isArray(r.stale_return_pct_ids)
      ? r.stale_return_pct_ids.filter((v): v is string => typeof v === "string")
      : [];
    return { kind: "created", revision, historyCount, staleReturnPctIds: stale };
  }
  return { kind: "unexpected", raw };
}

/** Postgres 오류코드 판정. 006 미적용(42883)과 요청 오류(22023)를 구분한다. */
export const isUndefinedFunction = (code: string | undefined): boolean => code === "42883";
export const isInvalidParameter = (code: string | undefined): boolean => code === "22023";
