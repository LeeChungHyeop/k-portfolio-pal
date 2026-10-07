// ─────────────────────────────────────────────────────────────────────────────
// 거래 원장 API — server-side only (Cloudflare Workers)
//
// 브라우저는 Supabase 에 직접 붙지 않는다. 기존 /api/data · /api/snapshots 와 **같은**
// 세션 토큰 경로만 쓴다(`requireSession`). service_role 키는 서버에만 있다.
//
// ── 무엇을 쓰고 무엇을 쓰지 않는가 ──────────────────────────────────────────
//
//   kaw_transaction_ledger          **읽기만 한다.** 원장은 immutable 이고 적재는
//                                   별도 import 경로(scripts/ledger-import.ts)로만 한다.
//   kaw_transaction_correction      거래정보 정정 (원본을 덮지 않는 overlay)
//   kaw_transaction_event_override  병합 / 분리 / 이동
//   kaw_rebalance_event             메모 / 태그 / 숨김 / 타입
//   kaw_ledger_audit                위 세 가지 변경을 **전부** 남긴다 (append-only)
//
// 파생값(거래건수·금액·전후 보유수량)은 내려보내지 않는다 — 브라우저가 `ledger.ts`
// `resolveEvents` 로 계산한다. 서버가 계산해 보내면 소속 거래가 바뀔 때 stale 해진다.
//
// ── audit ───────────────────────────────────────────────────────────────────
//
// 모든 쓰기는 변경 **전/후 값**을 kaw_ledger_audit 에 남긴다. UI 상의 분류 수정
// (event_merge / event_split / tx_move / memo_change / tag_change / event_hide /
// event_restore)과 실제 거래정보 정정(tx_correct)을 action 으로 구분한다.
// audit 기록 실패가 본 작업을 되돌리지는 않지만 로그로 드러낸다.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, serviceClient, requireSession, type DataEnv } from "./data-server";

/** 한 번에 내려보내는 원장 전체. 계좌 4개 × 수년치라 수천 행을 넘지 않는다. */
const LEDGER_ROW_LIMIT = 20_000;

type Session = { code: string; profile: string };

interface AuditInput {
  action: string;
  targetType: "transaction" | "event" | "import";
  targetId: string;
  previousValue?: unknown;
  newValue?: unknown;
  note?: string;
}

/**
 * 변경 이력 1건. **본 작업이 끝난 뒤** 부르고, 실패해도 본 작업을 되돌리지 않는다
 * (되돌리면 "기록은 남았는데 변경은 사라진" 더 나쁜 상태가 된다). 대신 로그로 남긴다.
 */
async function writeAudit(
  client: SupabaseClient, session: Session, a: AuditInput,
): Promise<void> {
  const { error } = await client.from("kaw_ledger_audit").insert({
    family_code: session.code,
    profile: session.profile,
    actor: session.profile,
    action: a.action,
    target_type: a.targetType,
    target_id: a.targetId,
    previous_value: a.previousValue ?? null,
    new_value: a.newValue ?? null,
    note: a.note ?? null,
  });
  // 계좌 데이터 원본을 로그에 찍지 않는다 — 무엇이 실패했는지만 남긴다.
  if (error) console.error(`[kaw] 원장 audit 기록 실패 (${a.action}): ${error.message}`);
}

async function auth(
  request: Request, env: DataEnv,
): Promise<{ client: SupabaseClient; session: Session } | Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  return { client, session: { code: session.code, profile: session.profile } };
}

const scoped = (client: SupabaseClient, table: string, s: Session) =>
  client.from(table).select("*").eq("family_code", s.code).eq("profile", s.profile);

// ── 읽기 ────────────────────────────────────────────────────────────────────

/**
 * GET /api/ledger — 원장 + overlay 전체를 한 번에.
 *
 * 네 테이블을 각각 왕복하지 않고 병렬로 한 번에 받아 브라우저가 조립한다.
 * 원장 테이블이 아직 없으면(migration 004 미적용) `unavailable: true` 로 알린다 —
 * "데이터가 없음"과 "저장소가 아직 없음"을 화면에서 구분해야 하기 때문이다.
 */
export async function handleLedgerGet(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const [tx, ev, corr, ovr] = await Promise.all([
    scoped(client, "kaw_transaction_ledger", session)
      .order("event_date", { ascending: true }).limit(LEDGER_ROW_LIMIT),
    scoped(client, "kaw_rebalance_event", session).limit(LEDGER_ROW_LIMIT),
    scoped(client, "kaw_transaction_correction", session).limit(LEDGER_ROW_LIMIT),
    scoped(client, "kaw_transaction_event_override", session).limit(LEDGER_ROW_LIMIT),
  ]);

  // 원장 테이블 자체가 없으면 나머지도 없다 — migration 미적용으로 본다.
  if (tx.error) {
    console.error("[kaw] 원장 조회 실패:", tx.error.message);
    return json({ unavailable: true, transactions: [], events: [], corrections: [], overrides: [] });
  }

  return json({
    unavailable: false,
    transactions: tx.data ?? [],
    events: ev.data ?? [],
    corrections: corr.data ?? [],
    overrides: ovr.data ?? [],
  });
}

// ── 쓰기: 이벤트 의미정보 (메모 / 태그 / 숨김 / 타입) ───────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/**
 * POST /api/ledger/event — 이벤트의 **사용자 의미정보만** 만들거나 고친다.
 *
 * 기본 grouping 이벤트는 DB 에 행이 없을 수 있으므로 upsert 다. 거래 자체는 건드리지
 * 않는다 — 소속 변경은 /api/ledger/assign 이다.
 */
export async function handleLedgerEventPost(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = str(body.id);
  const accountType = str(body.accountType);
  const eventDate = str(body.eventDate);
  if (!id || !accountType || !eventDate) {
    return json({ error: "id / accountType / eventDate 가 필요합니다" }, 400);
  }

  const { data: before } = await client.from("kaw_rebalance_event")
    .select("*").eq("family_code", session.code).eq("profile", session.profile)
    .eq("id", id).maybeSingle();

  const patch: Record<string, unknown> = {
    family_code: session.code,
    profile: session.profile,
    id,
    account_type: accountType,
    event_date: eventDate,
  };
  // 넘어온 필드만 바꾼다 — 안 보낸 필드를 기본값으로 덮지 않는다.
  const memo = str(body.memo);
  const tags = strArray(body.tags);
  const hidden = bool(body.hidden);
  const type = str(body.type);
  const strategyIncluded = bool(body.strategyIncluded);
  const isUserCreated = bool(body.isUserCreated);
  if (memo !== undefined) patch.memo = memo;
  if (tags !== undefined) patch.tags = tags;
  if (hidden !== undefined) patch.hidden = hidden;
  if (type !== undefined) patch.type = type;
  if (strategyIncluded !== undefined) patch.strategy_included = strategyIncluded;
  if (isUserCreated !== undefined) patch.is_user_created = isUserCreated;
  // 새로 만드는 행의 기본값은 기존 행이 없을 때만 채운다.
  if (!before) {
    patch.type ??= "rebalance";
    patch.strategy_included ??= true;
    patch.tags ??= [];
    patch.hidden ??= false;
    patch.is_user_created ??= false;
  }

  const { data, error } = await client.from("kaw_rebalance_event")
    .upsert({ ...before, ...patch }, { onConflict: "family_code,profile,id" })
    .select("*").single();
  if (error) return json({ error: error.message }, 500);

  // 무엇이 바뀌었는지에 따라 action 을 나눈다 — 나중에 "메모만 고친 이력"을 찾을 수 있게.
  const action = hidden !== undefined
    ? (hidden ? "event_hide" : "event_restore")
    : tags !== undefined && memo === undefined
      ? "tag_change"
      : "memo_change";
  await writeAudit(client, session, {
    action, targetType: "event", targetId: id,
    previousValue: before ?? null, newValue: data,
  });

  return json({ event: data });
}

// ── 쓰기: 소속 이벤트 재지정 (병합 / 분리 / 이동) ──────────────────────────

/**
 * POST /api/ledger/assign — 거래들의 소속 이벤트를 바꾼다.
 *
 *   { transactionIds: [...], eventId: "rev:..." }  → 그 이벤트로 옮긴다(병합/분리/이동)
 *   { transactionIds: [...], eventId: null }       → override 를 지워 기본 grouping 으로
 *
 * 원장은 건드리지 않는다. 되돌리기는 override 삭제 한 번이다.
 */
export async function handleLedgerAssignPost(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const ids = strArray(body.transactionIds) ?? [];
  const eventId = body.eventId === null ? null : str(body.eventId);
  if (!ids.length) return json({ error: "transactionIds 가 필요합니다" }, 400);
  if (eventId === undefined) return json({ error: "eventId 가 필요합니다 (해제는 null)" }, 400);
  const action = str(body.action) ?? "tx_move"; // event_merge | event_split | tx_move

  const { data: before } = await client.from("kaw_transaction_event_override")
    .select("*").eq("family_code", session.code).eq("profile", session.profile)
    .in("transaction_id", ids);

  if (eventId === null) {
    const { error } = await client.from("kaw_transaction_event_override")
      .delete().eq("family_code", session.code).eq("profile", session.profile)
      .in("transaction_id", ids);
    if (error) return json({ error: error.message }, 500);
  } else {
    const { error } = await client.from("kaw_transaction_event_override")
      .upsert(
        ids.map((transaction_id) => ({
          family_code: session.code, profile: session.profile, transaction_id, event_id: eventId,
        })),
        { onConflict: "family_code,profile,transaction_id" },
      );
    // 원장에 없는 거래 id 면 FK 위반으로 막힌다 — 유효성 검사를 따로 두지 않는 이유다.
    if (error) return json({ error: error.message }, 500);
  }

  await writeAudit(client, session, {
    action, targetType: "event", targetId: eventId ?? "(기본 grouping 복귀)",
    previousValue: before ?? [], newValue: { transactionIds: ids, eventId },
  });

  return json({ ok: true, moved: ids.length });
}

// ── 쓰기: 거래정보 정정 ────────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * POST /api/ledger/correct — 거래정보 정정 overlay 를 만들거나 지운다.
 *
 *   { transactionId, correctedQuantity?, correctedPrice?, ..., excluded?, reason }
 *   { transactionId, clear: true }  → 정정을 지워 원본으로 되돌린다
 *
 * **원본 행(kaw_transaction_ledger)은 어떤 경우에도 UPDATE 하지 않는다.**
 * 서비스 롤에 원장 update 권한 자체를 주지 않았으므로 실수로도 덮어쓸 수 없다.
 */
export async function handleLedgerCorrectPost(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const transactionId = str(body.transactionId);
  if (!transactionId) return json({ error: "transactionId 가 필요합니다" }, 400);

  const { data: before } = await client.from("kaw_transaction_correction")
    .select("*").eq("family_code", session.code).eq("profile", session.profile)
    .eq("transaction_id", transactionId).maybeSingle();

  if (body.clear === true) {
    const { error } = await client.from("kaw_transaction_correction")
      .delete().eq("family_code", session.code).eq("profile", session.profile)
      .eq("transaction_id", transactionId);
    if (error) return json({ error: error.message }, 500);
    await writeAudit(client, session, {
      action: "tx_uncorrect", targetType: "transaction", targetId: transactionId,
      previousValue: before ?? null, newValue: null,
    });
    return json({ correction: null });
  }

  const side = str(body.correctedSide);
  const row = {
    family_code: session.code,
    profile: session.profile,
    transaction_id: transactionId,
    corrected_quantity: numOrNull(body.correctedQuantity),
    corrected_price: numOrNull(body.correctedPrice),
    corrected_amount: numOrNull(body.correctedAmount),
    corrected_trade_date: str(body.correctedTradeDate) ?? null,
    corrected_side: side === "buy" || side === "sell" ? side : null,
    corrected_ticker: str(body.correctedTicker) ?? null,
    excluded: bool(body.excluded) ?? false,
    reason: str(body.reason) ?? null,
  };

  const { data, error } = await client.from("kaw_transaction_correction")
    .upsert(row, { onConflict: "family_code,profile,transaction_id" })
    .select("*").single();
  if (error) return json({ error: error.message }, 500);

  await writeAudit(client, session, {
    action: "tx_correct", targetType: "transaction", targetId: transactionId,
    previousValue: before ?? null, newValue: data,
    note: row.reason ?? undefined,
  });

  return json({ correction: data });
}

// ── 읽기: 변경 이력 ────────────────────────────────────────────────────────

/** GET /api/ledger/audit — 최근 변경 이력 (최신 먼저). 상세 화면의 "수정 이력" 탭용. */
export async function handleLedgerAuditGet(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const url = new URL(request.url);
  const targetId = url.searchParams.get("targetId");
  let q = client.from("kaw_ledger_audit")
    .select("*").eq("family_code", session.code).eq("profile", session.profile)
    .order("at", { ascending: false }).limit(200);
  if (targetId) q = q.eq("target_id", targetId);

  const { data, error } = await q;
  if (error) return json({ unavailable: true, entries: [] });
  return json({ unavailable: false, entries: data ?? [] });
}
