// ─────────────────────────────────────────────────────────────────────────────
// 계좌 이전 확정 · 잔고 관측 기록 (Phase 4-C-1)
//
//   GET  /api/kis/transfer/state     DB 만 읽는다(KIS 호출 없음). 이전 기록 · 최근 관측 · 체크리스트
//   POST /api/kis/transfer/observe   사용자 승인 하에 KIS 잔고를 **읽기 전용 1회** 조회해 관측으로 기록
//   POST /api/kis/transfer/confirm   사용자 승인 하에 '매도 후 현금 이전'을 확정해 이력으로 기록
//
// ## 쓰기는 정확히 두 곳이다 (이 파일에서만)
//   · `kaw_settlement_observation` INSERT 1행   (migration 005 의 기존 append-only 테이블)
//   · `kaw_ledger_audit`           INSERT 1행   (migration 004 의 기존 append-only 테이블)
// 두 테이블 모두 service_role 에 SELECT/INSERT 만 있어서 고치거나 지울 수 없다.
//
// ## 하지 않는 것
//   · 거래원장 · cashflow · 보유수량 · 예수금 설정 · 레지스트리 · kaw_data 를 쓰지 않는다
//   · 주문 · 취소 · 이체를 하지 않는다. KIS 호출은 잔고 조회 1건뿐이다
//   · 승인(approved: true)이 없으면 어떤 쓰기도, KIS 호출도 하지 않는다
//   · 계좌번호 · 키 · 토큰 · 응답 원문을 저장하거나 돌려주지 않는다
//   · 관측값과 원장 유도값의 차이를 분류하지 않는다 (transfer-reconciliation.ts)
// ─────────────────────────────────────────────────────────────────────────────

import { json, requireSession, serviceClient } from "./data-server";
import {
  authorizeKisAccess,
  readKisAccount,
  resolveKisAccountApp,
  CANO_RE,
  type KisAccountEnv,
  type KisReadRequest,
  type KisReadResult,
} from "./kis-account-read";
import { getKisAccessToken, kisAppFingerprint, type KVLike } from "./kis-server";
import { redactKisSecrets, type KisAccountCredentials } from "./kis-account-server";
import { kisApiQueryGate } from "./broker-connection";
import { kstDateString } from "./snapshot";
import { effectiveLedger } from "./kis-execution-compose";
import { readBundle } from "./kis-execution-server";
import {
  TRANSFER_AUDIT_ACTION,
  TRANSFER_AUDIT_TARGET_TYPE,
  countTransferRowsFor,
  validateTransferConfirm,
  type TransferConfirmInput,
} from "./account-transfer-record";
import {
  dbRowToPart,
  observationToPart,
  partToDbRow,
  summarizeObservation,
  type BalanceObservationSummary,
} from "./kis-balance-observation";
import { composeTransferState, transferTargetOf } from "./kis-transfer-compose";

type ServiceClient = NonNullable<ReturnType<typeof serviceClient>>;
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;

export interface TransferDeps {
  /** 테스트 주입. 기본은 readKisAccount */
  readAccount?: (req: KisReadRequest) => Promise<KisReadResult>;
  getToken?: (env: KisAccountEnv, cred: Pick<KisAccountCredentials, "appKey" | "appSecret">) => Promise<string>;
  today?: () => string;
  now?: () => Date;
}

const defaultGetToken: NonNullable<TransferDeps["getToken"]> = (env, c) =>
  getKisAccessToken(c.appKey, c.appSecret, env.RATE_LIMIT as KVLike | undefined);

type Guarded = { ok: false; res: Response } | { ok: true; session: Session; client: ServiceClient };

/** 세션 + 소유권. 통과하지 못하면 응답(401/403)을 돌려준다 */
async function guard(request: Request, env: KisAccountEnv): Promise<Guarded> {
  const session = await requireSession(request, env);
  if (!session) return { ok: false, res: json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401) };
  if (!authorizeKisAccess(session, env).ok) {
    return { ok: false, res: json({ error: "이 프로필에는 한국투자 계좌 권한이 없습니다." }, 403) };
  }
  const client = serviceClient(env);
  if (!client) return { ok: false, res: json({ error: "서버 설정 오류" }, 503) };
  return { ok: true, session, client };
}

// ── 동시 요청 잠금 ──────────────────────────────────────────────────────────
// 중복 클릭 · 재시도 · 두 기기에서 동시에 누르는 경우에 같은 기록이 두 번 쓰이지 않게 한다.
//   · 같은 isolate: 메모리 Set — 확실하다
//   · 다른 isolate: KV(`RATE_LIMIT`) 짧은 잠금 — 최선(원자적이지 않다)이라, 쓰기 뒤 중복 확인과
//     읽는 쪽 해석(parseTransferRecords: 가장 먼저 승인된 하나)이 마지막 방어선이다.
// DB 유니크 제약은 migration 이 필요해 이번 단계에서 추가하지 않는다(4-C-2 후보로 보고).
const heldLocks = new Set<string>();
const LOCK_TTL_SEC = 60;
type LockKv = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete?(k: string): Promise<void> };

async function withLock(
  env: KisAccountEnv, scope: string, session: { code: string; profile: string }, fn: () => Promise<Response>,
): Promise<Response> {
  const busy = () => json({ state: "rejected", code: "busy", message: "같은 요청이 처리 중입니다. 잠시 후 상태를 새로고침해 확인하세요." }, 409);
  // 메모리 잠금은 **동기적으로** 잡는다(await 사이에 다른 요청이 끼어들 수 없다). 이 키는 isolate 밖으로 나가지 않는다.
  const memKey = `${scope}:${session.code}|${session.profile}`;
  if (heldLocks.has(memKey)) return busy();
  heldLocks.add(memKey);
  const kv = env.RATE_LIMIT as LockKv | undefined;
  let kvKey: string | null = null;
  try {
    if (kv) {
      // KV 키에는 가족 코드 원문을 넣지 않는다(지문만).
      kvKey = `kis:lock:${scope}:${await kisAppFingerprint(`${session.code}|${session.profile}`)}`;
      if (await kv.get(kvKey).catch(() => null)) { kvKey = null; return busy(); }
      await kv.put(kvKey, "1", { expirationTtl: LOCK_TTL_SEC }).catch(() => {});
    }
    return await fn();
  } finally {
    heldLocks.delete(memKey);
    // 내가 잡은 KV 잠금만 푼다. 못 풀어도 TTL 로 사라진다.
    if (kv && kvKey && kv.delete) await kv.delete(kvKey).catch(() => {});
  }
}

/** 새 증권사 instance 의 가장 최근 관측 part (voided 제외) */
async function latestObservation(client: ServiceClient, code: string, profile: string, instanceId: string): Promise<BalanceObservationSummary | null> {
  const { data } = await client.from("kaw_settlement_observation").select("*")
    .eq("family_code", code).eq("profile", profile).eq("account_instance_id", instanceId)
    .order("observed_at", { ascending: false }).limit(5);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.length) return null;
  const ids = rows.map((r) => String(r.id));
  const { data: voids } = await client.from("kaw_settlement_observation_void").select("observation_id")
    .eq("family_code", code).eq("profile", profile).in("observation_id", ids);
  const voided = new Set(((voids ?? []) as Array<{ observation_id: string }>).map((v) => v.observation_id));
  const first = rows.find((r) => !voided.has(String(r.id)));
  return first ? summarizeObservation(dbRowToPart(first)) : null;
}

export async function handleTransferState(request: Request, env: KisAccountEnv, deps: TransferDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;
  const today = (deps.today ?? kstDateString)();

  const bundle = await readBundle(client, session.code, session.profile);
  if (!bundle.ok) return json({ error: "원장을 읽지 못했습니다." }, 503);
  const target = transferTargetOf(bundle.registry);
  const observation = target ? await latestObservation(client, session.code, session.profile, target.id) : null;

  return json(composeTransferState({
    registry: bundle.registry,
    ledger: effectiveLedger(bundle.ledger, bundle.corrections),
    flows: bundle.flows,
    records: bundle.transfers,
    observation,
    today,
  }));
}

export async function handleBalanceObserve(request: Request, env: KisAccountEnv, deps: TransferDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;

  const body = (await request.json().catch(() => null)) as { approved?: unknown } | null;
  // 승인이 없으면 KIS 도 DB 도 건드리지 않는다.
  if (!body || body.approved !== true) {
    return json({ state: "rejected", code: "approval_required", message: "사용자의 명시적 승인이 없어 조회·기록하지 않았습니다." }, 400);
  }
  return withLock(env, "transfer-observe", session, () => observeLocked(env, deps, session, client));
}

async function observeLocked(env: KisAccountEnv, deps: TransferDeps, session: Session, client: ServiceClient): Promise<Response> {

  const app = resolveKisAccountApp(env);
  const cano = env.KIS_ACCOUNT_CANO;
  if (!app || !cano || !CANO_RE.test(cano)) {
    return json({ unavailable: true, state: "not_configured", error: "한국투자 계좌 조회 설정이 서버에 없습니다." }, 503);
  }
  const today = (deps.today ?? kstDateString)();

  const bundle = await readBundle(client, session.code, session.profile);
  const target = transferTargetOf(bundle.registry);
  if (!target) return json({ state: "rejected", code: "target_instance_invalid", message: "등록된 한국투자 연금저축 계좌가 없습니다." }, 409);
  const gate = kisApiQueryGate(bundle.registry, "pension", today, "22");
  if (!gate.allowed) return json({ state: "gate_blocked", reason: gate.reason });

  const cred: KisAccountCredentials = { appKey: app.appKey, appSecret: app.appSecret, cano };
  let token: string;
  try {
    token = await (deps.getToken ?? defaultGetToken)(env, cred);
  } catch (e) {
    void redactKisSecrets(e, [app.appKey, app.appSecret, cano]);
    return json({ state: "query_failed", failure: "auth" });
  }

  const read = deps.readAccount ?? ((req: KisReadRequest) => readKisAccount(req));
  const result = await read({ productCode: "22", registry: bundle.registry, credentials: cred, token });
  const part = observationToPart(
    result.observation, session.profile,
    "사용자 승인 하에 기록한 한국투자 읽기 전용 잔고 조회(TTTC8434R). 원장·보유수량·예수금 설정은 바꾸지 않음",
  );
  if (!part.ok) return json({ state: "not_recordable", reason: part.reason });

  const { error } = await client.from("kaw_settlement_observation").insert(partToDbRow(part.part, session.code, session.profile));
  const summary = summarizeObservation(part.part);
  if (error) {
    // 같은 내용(같은 capture)이 이미 있다 — 기존 기록을 그대로 두고 알린다.
    if ((error as { code?: string }).code === "23505") return json({ state: "already_recorded", observation: summary });
    return json({ state: "write_failed" }, 500);
  }
  return json({ state: "recorded", observation: summary });
}

export async function handleTransferConfirm(request: Request, env: KisAccountEnv, deps: TransferDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;

  const body = (await request.json().catch(() => null)) as TransferConfirmInput | null;
  if (!body || typeof body !== "object") return json({ state: "rejected", code: "bad_request", message: "요청 형식이 올바르지 않습니다." }, 400);
  // 승인이 없으면 읽지도 쓰지도 않는다.
  if (body.approved !== true) {
    return json({ state: "rejected", code: "approval_required", message: "사용자의 명시적 승인이 없어 기록하지 않았습니다." }, 400);
  }
  return withLock(env, "transfer-confirm", session, () => confirmLocked(env, deps, session, client, body));
}

async function confirmLocked(env: KisAccountEnv, deps: TransferDeps, session: Session, client: ServiceClient, body: TransferConfirmInput): Promise<Response> {
  void env;
  const today = (deps.today ?? kstDateString)();
  const now = (deps.now ?? (() => new Date()))();
  const bundle = await readBundle(client, session.code, session.profile);
  if (!bundle.ok) return json({ error: "원장을 읽지 못했습니다." }, 503);
  const target = transferTargetOf(bundle.registry);
  const observation = target ? await latestObservation(client, session.code, session.profile, target.id) : null;

  const verdict = validateTransferConfirm(body, {
    registry: bundle.registry,
    ledger: effectiveLedger(bundle.ledger, bundle.corrections),
    existing: bundle.transfers,
    observation: observation ? { captureId: observation.captureId, stateAsOf: observation.stateAsOf, observedAt: observation.observedAt } : null,
    today,
    actor: session.profile,
    nowIso: now.toISOString(),
  });
  if (!verdict.ok) {
    return json({ state: "rejected", code: verdict.code, message: verdict.message, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) }, 409);
  }

  const { error } = await client.from("kaw_ledger_audit").insert({
    family_code: session.code,
    profile: session.profile,
    actor: session.profile,
    action: TRANSFER_AUDIT_ACTION,
    target_type: TRANSFER_AUDIT_TARGET_TYPE,
    target_id: `transfer:${verdict.record.toInstanceId}`,
    previous_value: null,
    new_value: verdict.record,
    note: verdict.record.approval.note,
  });
  if (error) {
    // DB 의 부분 유니크 인덱스(migration 011)가 같은 계좌의 두 번째 확정을 막았다 — 성공이 아니다.
    // 다른 요청이 먼저 기록했으므로 아무것도 새로 쓰지 않았고, 화면은 상태를 다시 읽어 그 기록을 보여 준다.
    if ((error as { code?: string }).code === "23505") {
      return json({ state: "rejected", code: "already_confirmed", message: "이 새 계좌의 이전은 이미 확정되어 있습니다(다른 요청이 먼저 기록했습니다). 기록은 고치지 않습니다." }, 409);
    }
    return json({ state: "write_failed" }, 500);
  }

  // 쓰기 뒤 확인: 다른 인스턴스의 경합 요청이 같은 계좌의 이력을 또 썼는지 본다. 이력은 지우지 않는다 —
  // 읽는 쪽이 가장 먼저 승인된 하나만 유효로 해석하고, 응답으로 사용자에게 알린다.
  const { data: after } = await client.from("kaw_ledger_audit").select("new_value")
    .eq("family_code", session.code).eq("profile", session.profile).eq("action", TRANSFER_AUDIT_ACTION).limit(50);
  const rows = countTransferRowsFor((after ?? []) as Array<{ new_value?: unknown }>, verdict.record.toInstanceId);
  return json({ state: "confirmed", record: verdict.record, ...(rows > 1 ? { duplicateRecords: rows } : {}) });
}
