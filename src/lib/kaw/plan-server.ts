// ─────────────────────────────────────────────────────────────────────────────
// 리밸런싱 계획(plan) API — server-side only (Cloudflare Workers)
//
// 브라우저는 Supabase 에 직접 붙지 않는다. 기존 /api/data · /api/ledger 와 **같은**
// 세션 토큰 경로만 쓴다(`requireSession`). service_role 키는 서버에만 있다.
//
// ── 이 경로가 하는 일 ───────────────────────────────────────────────────────
//
//   POST /api/rebalance/plan    완료 1건의 durable 증거를 **1행 insert** 한다
//   GET  /api/rebalance/plan    completionId 들의 **존재 여부**를 돌려준다
//
// `kaw_rebalance_plan` 은 immutable 이다. 그래서 여기에는 **upsert 가 없다** —
// `.insert()` 만 쓰고, PK 충돌(23505)은 실패가 아니라 "이미 있다"는 ACK 로 번역한다
// (migration 005 가 service_role 의 UPDATE/DELETE 권한을 회수하므로, upsert 를 쓰면
//  애초에 권한 오류가 난다. 코드와 권한이 같은 말을 하게 둔다).
//
// ── 멱등성: completionId 가 유일한 identity 다 ──────────────────────────────
//
//   id = 'plan:' || completionId        (completion-envelope.ts completionIds)
//
// **클라이언트가 보낸 `id` 를 믿지 않고 completionId 에서 다시 만든다.** 둘이 어긋난
// 본문이 들어오면 멱등성의 근거가 둘로 갈라지기 때문이다. 같은 완료를 몇 번 재전송해도
// 행은 1개이고, 순서도 상관없다.
//
// ── 해시를 서버가 다시 계산한다 ─────────────────────────────────────────────
//
// `plan_payload_hash` 는 **"다른 completionId 인데 경제값이 같다"(재기록)를 찾는**
// 유일한 수단이다. 클라이언트가 계산해 보낸 값을 그대로 저장하면, 버그든 변조든 한 번
// 어긋난 해시가 그 탐지를 영구히 무력화한다(저장 후 고칠 수도 없다 — immutable 이다).
// 그래서 서버가 본문으로 `planPayloadHash()` 를 다시 계산해 **일치하지 않으면 400** 이다.
// `rebalance-plan.ts` 는 의존성이 없는 순수 모듈이라 Worker 에서 그대로 돌아간다.
//
// ── 같은 completionId 에 다른 경제값이 오면 ACK 하지 않는다 ─────────────────
//
// PK 충돌 시 저장된 행의 해시와 요청의 해시를 비교한다.
//
//   같다  → 200 { outcome: 'already_exists' }   재시도다. envelope 를 confirmed 로
//   다르다 → 422 { error: 'plan_hash_mismatch' } **버그다.** 조용히 ACK 하면
//            "저장된 것과 다른 계획"을 저장됐다고 믿게 된다. 재시도로 풀리지 않으므로
//            `settlePlanWrite` 가 failed → manualRetryRequired 로 끌고 간다.
//
// ── 저장하지 않는 것 ───────────────────────────────────────────────────────
//
//   family_code / profile / actor   **세션에서만** 온다. 본문 값은 버린다
//                                   (/api/data handleDataPost 의 필터와 같은 규칙).
//   account_ref_fingerprint         항상 null. 계산은 Phase 3 이고, CANO 에서 파생되는
//                                   값이라 클라이언트가 보낸 것을 그대로 믿을 수 없다.
//   파생값(reconcile 결과 등)        아예 컬럼이 없다(005 대원칙 5).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, serviceClient, requireSession, type DataEnv } from "./data-server";
import { ACCOUNT_IDS } from "./constants";
import {
  PLAN_HASH_VERSION,
  planHashVersionOf,
  planPayloadHash,
  type PlanPriceEvidence,
  type PlanRowMeta,
  type RebalancePlan,
} from "./rebalance-plan";

type Session = { code: string; profile: string };

/** GET 한 번에 물어볼 수 있는 completionId 수 상한. outbox 가 이보다 커지는 일은 없다. */
export const PLAN_QUERY_MAX_IDS = 100;

/** 행 전체를 돌려주는 모드의 상한. */
export const PLAN_ROW_LIMIT = 500;

// ── 순수 검증 (테스트가 서버 없이 그대로 쓴다) ──────────────────────────────

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** `undefined`/`null` 은 null, 유한수는 그 값, 그 외는 `undefined`(= 모양 오류). */
function numOrNull(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * `Record<string, number>` 인가. **빈 객체와 null 을 구분한다** — 004/005 의 null
 * 정책(모르는 것과 0 은 다르다)이 여기서 뭉개지면 DB CHECK 까지 가지 못한다.
 */
function numberMap(v: unknown): Record<string, number> | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    out[k] = raw;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** DB 에 그대로 들어가는 행. 컬럼명은 snake_case 다. */
export interface PlanInsertRow {
  family_code: string;
  profile: string;
  id: string;
  completion_id: string;
  account_type: string;
  broker: string;
  broker_product_code: string | null;
  account_instance_id: string;
  account_ref_fingerprint: null;
  plan_date: string;
  recorded_at: string;
  date_mode: "today" | "past";
  pre_basis: "session_snapshot" | "unknown";
  pre_session_id: string | null;
  pre_session_started_at: string | null;
  pre_profile_key: string | null;
  pre_quantities: Record<string, number> | null;
  pre_cash: number | null;
  pre_cash_at_record: number | null;
  pre_discard_reason: string | null;
  app_state_quantities_at_record: Record<string, number> | null;
  app_state_cash_at_record: number | null;
  planned_quantities: Record<string, number>;
  asserted_post_cash: number;
  projected_post_cash: number | null;
  target_weights: Record<string, number> | null;
  frozen_invested: number | null;
  frozen_invested_basis: string | null;
  base_amount: number | null;
  row_meta: Record<string, PlanRowMeta>;
  price_mode: "live" | "history" | "manual";
  price_evidence: Record<string, PlanPriceEvidence>;
  plan_payload_hash: string;
  hash_version: number;
  actor: string;
}

export type PlanValidation =
  | { ok: true; row: PlanInsertRow }
  | { ok: false; error: string; status: 400 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FROZEN_BASES = ["entry_freeze", "remount_refreeze", "manual", "unknown"] as const;
/**
 * `PreDiscardReason` 네 값. **null 은 정상**(폐기할 일이 없었다)이라 따로 허용한다.
 * plan 은 immutable 이라 오타 값이 들어가면 영구히 남으므로 005 의 CHECK 와 같은
 * 화이트리스트를 앞단에서 한 번 더 본다 — 제약 위반을 500 으로 흘리지 않기 위해서다.
 */
const PRE_DISCARD_REASONS = [
  "no_session", "past_date_mode", "date_mode_changed", "instance_changed",
] as const;
const PRICE_MODES = ["live", "history", "manual"] as const;

const bad = (error: string): PlanValidation => ({ ok: false, error, status: 400 });

/**
 * 본문 → DB 행. **005 의 CHECK 제약을 그대로 앞단에서 한 번 더 본다.**
 *
 * DB 가 막아주는데도 여기서 검사하는 이유는 응답 때문이다 — 제약 위반은 500 으로
 * 올라와 "서버 오류"로 보이고, 어느 필드가 왜 거부됐는지 클라이언트가 알 수 없다.
 * 특히 **PRE null 정책**(pre_basis='unknown' → pre_quantities/pre_cash 는 null)은
 * 역산 버그의 신호라서 400 으로 또렷하게 돌려줘야 한다.
 */
export function validatePlanBody(body: unknown, session: Session): PlanValidation {
  if (!isPlainObject(body)) return bad("본문이 객체가 아닙니다");
  // envelope 의 planPayload 는 "본문 전체" 가 plan 이다. { plan } 래퍼도 받아준다.
  const p = (isPlainObject(body.plan) ? body.plan : body) as Partial<RebalancePlan> &
    Record<string, unknown>;

  const completionId = str(p.completionId);
  if (!completionId) return bad("completionId 가 필요합니다");
  if (completionId.includes(":")) return bad("completionId 에 ':' 를 쓸 수 없습니다");

  const accountType = str(p.accountType);
  if (!accountType || !ACCOUNT_IDS.includes(accountType as (typeof ACCOUNT_IDS)[number])) {
    return bad("accountType 이 올바르지 않습니다");
  }

  const broker = str(p.broker);
  if (!broker) return bad("broker 가 필요합니다");

  const accountInstanceId = str(p.accountInstanceId);
  if (!accountInstanceId) return bad("accountInstanceId 가 필요합니다");

  const planDate = str(p.planDate);
  if (!planDate || !DATE_RE.test(planDate)) return bad("planDate 는 YYYY-MM-DD 입니다");

  // 'future' 는 아직 하지 않은 일이라 증거가 아니다 — 005 의 date_mode CHECK 와 같다.
  const dateMode = p.dateMode;
  if (dateMode !== "today" && dateMode !== "past") {
    return bad("dateMode 는 today 또는 past 입니다 (future 는 저장하지 않습니다)");
  }

  const preBasis = p.preBasis;
  if (preBasis !== "session_snapshot" && preBasis !== "unknown") {
    return bad("preBasis 는 session_snapshot 또는 unknown 입니다");
  }

  const priceMode = p.priceMode;
  if (!PRICE_MODES.includes(priceMode as (typeof PRICE_MODES)[number])) {
    return bad("priceMode 는 live / history / manual 입니다");
  }

  const preQuantities = numberMap(p.preQuantities);
  if (preQuantities === undefined) return bad("preQuantities 의 모양이 올바르지 않습니다");
  const preCash = numOrNull(p.preCash);
  if (preCash === undefined) return bad("preCash 의 모양이 올바르지 않습니다");

  // **PRE 역산 금지.** 005 의 kaw_rebalance_plan_pre_null_chk 와 같은 판정이다.
  if (preBasis === "unknown" && (preQuantities !== null || preCash !== null)) {
    return bad("preBasis=unknown 이면 preQuantities/preCash 는 null 이어야 합니다");
  }
  if (preBasis === "session_snapshot" && preQuantities === null) {
    return bad("preBasis=session_snapshot 이면 preQuantities 가 필요합니다");
  }

  const plannedQuantities = numberMap(p.plannedQuantities);
  if (plannedQuantities === undefined || plannedQuantities === null) {
    return bad("plannedQuantities 가 필요합니다");
  }

  const assertedPostCash = num(p.assertedPostCash);
  if (assertedPostCash === null) return bad("assertedPostCash 가 필요합니다");
  // `normalizeAssertedCash` 의 **결과 조건**을 검사한다 (정규화를 여기서 다시 구현하지
  // 않는다 — 서버가 값을 바꾸면 클라이언트가 계산한 해시와 어긋난다).
  if (!Number.isInteger(assertedPostCash) || assertedPostCash < 0) {
    return bad("assertedPostCash 는 0 이상의 정수여야 합니다");
  }

  if (!isPlainObject(p.rowMeta)) return bad("rowMeta 가 필요합니다");
  if (!isPlainObject(p.priceEvidence)) return bad("priceEvidence 가 필요합니다");

  const targetWeights = numberMap(p.targetWeights);
  if (targetWeights === undefined) return bad("targetWeights 의 모양이 올바르지 않습니다");

  const appStateQuantities = numberMap(p.appStateQuantitiesAtRecord);
  if (appStateQuantities === undefined) {
    return bad("appStateQuantitiesAtRecord 의 모양이 올바르지 않습니다");
  }

  const projectedPostCash = numOrNull(p.projectedPostCash);
  const frozenInvested = numOrNull(p.frozenInvested);
  const baseAmount = numOrNull(p.baseAmount);
  const preCashAtRecord = numOrNull(p.preCashAtRecord);
  const appStateCash = numOrNull(p.appStateCashAtRecord);
  if (
    projectedPostCash === undefined || frozenInvested === undefined ||
    baseAmount === undefined || preCashAtRecord === undefined || appStateCash === undefined
  ) {
    return bad("금액 필드의 모양이 올바르지 않습니다");
  }

  // `str()` 로 걸러 null 로 만들지 않는다 — 모양이 틀린 값을 조용히 "폐기 없음" 으로
  // 바꾸면 PRE 를 못 쓴 사실 자체가 사라진다. 없음(undefined/null)만 null 이다.
  const rawDiscard = p.preDiscardReason;
  let preDiscardReason: string | null = null;
  if (rawDiscard !== undefined && rawDiscard !== null) {
    if (
      typeof rawDiscard !== "string" ||
      !PRE_DISCARD_REASONS.includes(rawDiscard as (typeof PRE_DISCARD_REASONS)[number])
    ) {
      return bad("preDiscardReason 이 올바르지 않습니다");
    }
    preDiscardReason = rawDiscard;
  }

  const frozenBasis = p.frozenInvestedBasis ?? null;
  if (frozenBasis !== null && !FROZEN_BASES.includes(frozenBasis as (typeof FROZEN_BASES)[number])) {
    return bad("frozenInvestedBasis 가 올바르지 않습니다");
  }

  const hashVersion = num(p.hashVersion) ?? PLAN_HASH_VERSION;
  if (!Number.isInteger(hashVersion) || hashVersion < 1 || hashVersion > PLAN_HASH_VERSION) {
    return bad(`hashVersion 을 해석할 수 없습니다 (서버 최신: ${PLAN_HASH_VERSION})`);
  }

  // **해시 재계산.** 클라이언트가 보낸 값을 믿지 않는다 (모듈 상단 주석 참고).
  const expected = planPayloadHash(
    {
      accountInstanceId,
      planDate,
      preBasis,
      preQuantities,
      preCash,
      plannedQuantities,
      assertedPostCash,
      targetWeights,
      rowMeta: p.rowMeta as Record<string, PlanRowMeta>,
      priceEvidence: p.priceEvidence as Record<string, PlanPriceEvidence>,
    },
    hashVersion,
  );
  const given = str(p.planPayloadHash);
  if (!given) return bad("planPayloadHash 가 필요합니다");
  if (planHashVersionOf(given) !== hashVersion) {
    return bad("planPayloadHash 의 버전 prefix 가 hashVersion 과 다릅니다");
  }
  if (given !== expected) return bad("planPayloadHash 가 본문과 일치하지 않습니다");

  return {
    ok: true,
    row: {
      family_code: session.code,
      profile: session.profile,
      // 클라이언트의 id 를 쓰지 않는다 — completionId 에서 다시 만든다.
      id: `plan:${completionId}`,
      completion_id: completionId,
      account_type: accountType,
      broker,
      broker_product_code: str(p.brokerProductCode),
      account_instance_id: accountInstanceId,
      // Phase 3 까지 항상 null. 본문 값은 버린다.
      account_ref_fingerprint: null,
      plan_date: planDate,
      recorded_at: str(p.recordedAt) ?? new Date().toISOString(),
      date_mode: dateMode,
      pre_basis: preBasis,
      pre_session_id: str(p.preSessionId),
      pre_session_started_at: str(p.preSessionStartedAt),
      pre_profile_key: str(p.preProfileKey),
      pre_quantities: preQuantities,
      pre_cash: preCash,
      pre_cash_at_record: preCashAtRecord,
      pre_discard_reason: preDiscardReason,
      app_state_quantities_at_record: appStateQuantities,
      app_state_cash_at_record: appStateCash,
      planned_quantities: plannedQuantities,
      asserted_post_cash: assertedPostCash,
      projected_post_cash: projectedPostCash,
      target_weights: targetWeights,
      frozen_invested: frozenInvested,
      frozen_invested_basis: frozenBasis as string | null,
      base_amount: baseAmount,
      row_meta: p.rowMeta as Record<string, PlanRowMeta>,
      price_mode: priceMode as "live" | "history" | "manual",
      price_evidence: p.priceEvidence as Record<string, PlanPriceEvidence>,
      plan_payload_hash: given,
      hash_version: hashVersion,
      // 본문의 actor 를 쓰지 않는다 — 세션이 유일한 근거다.
      actor: session.profile,
    },
  };
}

/**
 * GET 의 `completionId` 파라미터 파싱. `?completionId=a&completionId=b` 와
 * `?completionId=a,b` 를 모두 받는다. 중복은 1개로 접는다.
 */
export function parseCompletionIds(url: URL): string[] | { error: string } {
  const raw = url.searchParams.getAll("completionId");
  const ids = [...new Set(raw.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
  if (!ids.length) return { error: "completionId 가 필요합니다" };
  if (ids.length > PLAN_QUERY_MAX_IDS) {
    return { error: `completionId 는 한 번에 ${PLAN_QUERY_MAX_IDS} 개까지입니다` };
  }
  return ids;
}

/**
 * PK 충돌을 어떻게 번역하는가. **같은 해시만 ACK 다.**
 * 저장된 해시를 읽지 못했으면(조회 실패) ACK 하지 않는다 — 모르는 것을 성공으로
 * 올리면 그게 바로 "저장 안 됐는데 세션이 삭제된" 상태를 만든다.
 */
export function planConflictOutcome(
  storedHash: string | null | undefined,
  incomingHash: string,
): { kind: "already_exists" } | { kind: "hash_mismatch" } | { kind: "unverified" } {
  if (storedHash === null || storedHash === undefined) return { kind: "unverified" };
  return storedHash === incomingHash ? { kind: "already_exists" } : { kind: "hash_mismatch" };
}

/** Postgres 오류코드 판정. 005 미적용(42P01)과 중복(23505)을 구분한다. */
export const isUniqueViolation = (code: string | undefined): boolean => code === "23505";
export const isUndefinedTable = (code: string | undefined): boolean => code === "42P01";

// ── 핸들러 ──────────────────────────────────────────────────────────────────

async function auth(
  request: Request, env: DataEnv,
): Promise<{ client: SupabaseClient; session: Session } | Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  return { client, session: { code: session.code, profile: session.profile } };
}

/**
 * audit 1건. **본 작업이 끝난 뒤** 부르고, 실패해도 본 작업을 되돌리지 않는다
 * (되돌리면 "기록은 남았는데 저장은 사라진" 더 나쁜 상태가 된다 — ledger-server.ts 와 같다).
 * plan 본문 전체를 넣지 않는다: 보유수량·금액이 로그성 테이블에 복제되면 005 의
 * "파생값/복본을 만들지 않는다" 원칙이 무너진다. **무엇이 일어났는지만** 남긴다.
 */
async function writePlanAudit(
  client: SupabaseClient,
  session: Session,
  row: PlanInsertRow,
  outcome: "created" | "already_exists",
): Promise<void> {
  const { error } = await client.from("kaw_ledger_audit").insert({
    family_code: session.code,
    profile: session.profile,
    actor: session.profile,
    action: "plan_write",
    target_type: "plan",
    target_id: row.id,
    previous_value: null,
    new_value: {
      outcome,
      accountType: row.account_type,
      accountInstanceId: row.account_instance_id,
      planDate: row.plan_date,
      planPayloadHash: row.plan_payload_hash,
    },
    note: null,
  });
  if (error) console.error(`[kaw] plan audit 기록 실패 (${outcome}): ${error.message}`);
}

/**
 * POST /api/rebalance/plan — 완료 1건의 durable 증거를 저장한다.
 *
 *   200 { outcome: 'created' | 'already_exists', id, completionId }
 *   400 { error }                      본문/해시 문제. 재시도로 풀리지 않는다
 *   422 { error: 'plan_hash_mismatch' } 같은 completionId 에 다른 경제값
 *   503 { unavailable: true }          migration 005 미적용
 *
 * `already_exists` 도 **ACK 다** — 행이 있다는 사실이 저장의 증거이기 때문이다
 * (completion-envelope.ts `ServerPersistenceAck.outcome`).
 */
export async function handleRebalancePlanPost(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const body = await request.json().catch(() => null);
  const v = validatePlanBody(body, session);
  if (!v.ok) return json({ error: v.error }, v.status);
  const row = v.row;

  // **upsert 를 쓰지 않는다.** 005 가 UPDATE 권한을 회수했고, 덮어쓰기는 immutable 위반이다.
  const { error } = await client.from("kaw_rebalance_plan").insert(row);

  if (!error) {
    await writePlanAudit(client, session, row, "created");
    return json({ outcome: "created", id: row.id, completionId: row.completion_id });
  }

  const code = (error as { code?: string }).code;

  if (isUndefinedTable(code)) {
    // "데이터가 없음" 과 "저장소가 아직 없음" 을 구분해 돌려준다(원장 API 와 같은 규칙).
    console.error("[kaw] kaw_rebalance_plan 이 없습니다 (migration 005 미적용)");
    return json({ unavailable: true, error: "plan 저장소가 아직 없습니다" }, 503);
  }

  if (isUniqueViolation(code)) {
    // 재시도인가, 같은 id 에 다른 계획인가. **해시로만 판정한다.**
    const { data } = await client
      .from("kaw_rebalance_plan")
      .select("plan_payload_hash")
      .eq("family_code", session.code).eq("profile", session.profile)
      .eq("id", row.id)
      .maybeSingle();

    const outcome = planConflictOutcome(
      (data as { plan_payload_hash?: string } | null)?.plan_payload_hash ?? null,
      row.plan_payload_hash,
    );
    if (outcome.kind === "already_exists") {
      await writePlanAudit(client, session, row, "already_exists");
      return json({ outcome: "already_exists", id: row.id, completionId: row.completion_id });
    }
    if (outcome.kind === "hash_mismatch") {
      return json(
        {
          error: "plan_hash_mismatch",
          message: "같은 completionId 로 이미 다른 내용의 계획이 저장돼 있습니다.",
          id: row.id,
        },
        422,
      );
    }
    // 저장된 해시를 못 읽었다 — ACK 하지 않고 재시도 가능한 실패로 돌려준다.
    return json({ error: "기존 계획을 확인할 수 없습니다. 잠시 후 다시 시도해주세요." }, 503);
  }

  console.error("[kaw] plan 저장 실패:", error.message);
  return json({ error: error.message }, 500);
}

/**
 * GET /api/rebalance/plan?completionId=a,b — 존재 여부.
 *
 *   200 { exists: { a: true, b: false } }
 *   200 { exists: {...}, plans: [...] }   `rows=1` 일 때 행 전체도 같이
 *   503 { unavailable: true }             migration 005 미적용
 *
 * `durablePlanKnown`('exists' | 'missing' | 'unknown')의 근거다 —
 * **네트워크/서버 실패는 false 가 아니라 unknown 으로 남겨야** 하므로, 실패 시에는
 * 부분 결과를 섞지 않고 통째로 에러를 돌려준다(rebalance-journal.ts 의 판정 규칙).
 */
export async function handleRebalancePlanGet(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const url = new URL(request.url);
  const parsed = parseCompletionIds(url);
  if (!Array.isArray(parsed)) return json({ error: parsed.error }, 400);
  const wantRows = url.searchParams.get("rows") === "1";

  // select 문자열을 변수로 넘기지 않는다 — supabase-js 의 타입은 리터럴에서 행 모양을
  // 추론하므로, 변수로 주면 ParserError 로 떨어진다. 분기마다 리터럴로 쓴다.
  const { data, error } = wantRows
    ? await client.from("kaw_rebalance_plan").select("*")
        .eq("family_code", session.code).eq("profile", session.profile)
        .in("completion_id", parsed).limit(PLAN_ROW_LIMIT)
    : await client.from("kaw_rebalance_plan").select("completion_id, id, plan_payload_hash")
        .eq("family_code", session.code).eq("profile", session.profile)
        .in("completion_id", parsed).limit(PLAN_ROW_LIMIT);

  if (error) {
    const code = (error as { code?: string }).code;
    if (isUndefinedTable(code)) {
      return json({ unavailable: true, error: "plan 저장소가 아직 없습니다" }, 503);
    }
    console.error("[kaw] plan 조회 실패:", error.message);
    return json({ error: error.message }, 500);
  }

  const rows = (data ?? []) as Array<{ completion_id: string }>;
  const found = new Set(rows.map((r) => r.completion_id));
  const exists = Object.fromEntries(parsed.map((id) => [id, found.has(id)]));

  return json(wantRows ? { exists, plans: rows } : { exists });
}
