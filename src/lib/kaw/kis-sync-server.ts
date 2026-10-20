// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kis/sync/preview · /api/kis/sync/apply — 계좌 상태 동기화 (Phase 4-D)
//
//   preview  { live?: boolean }                                  → 계획(변경 전/후, 날짜, 영향 범위). 아무것도 쓰지 않는다
//   apply    { planHash, approved: true, staleObservationApproved?: boolean }
//
// ## 순서가 곧 안전장치다
//   세션 → 요청 모양 + **명시적 승인** → 소유권 → 서버 플래그 → credential → 동시 요청 잠금 →
//   계좌 문서 · 원장 · 자산 라이브러리 · 스냅샷 날짜 읽기 → **KIS 잔고 읽기 1회(재시도 없음)** →
//   판정(evaluateBrokerSync) → 사용자가 승인한 계획 해시와 대조 → RPC 한 번(문서 + 승인 감사, 한 트랜잭션)
//   앞 단계가 막히면 뒤 단계는 실행하지 않는다.
//
// ## 쓰기는 정확히 한 곳이다
//   `rpc("kaw_broker_sync_apply")` 1회 (migration 013). 이 파일에는 insert / update / upsert / delete 가 없다.
//   문서 diff(허용 키 5개 외 불변) · 원장 재생 == 증권사 보유 · revision CAS · 중복 방지는 DB 가 같은 트랜잭션에서 다시 검증한다.
//
// ## 하지 않는 것
//   · 주문 · 취소 · 이체 — KIS 호출은 잔고 조회 1건뿐이다
//   · 거래원장 · cashflow · history · 스냅샷 · 원금(baseAmount 포함) 변경, 현금 보정/배당/이자 거래 생성
//   · 조회 실패 시 저장된 관측을 '현재'로 둔갑시키지 않는다 — 기준일을 보여 주고 별도 승인(staleObservationApproved)을 받는다
//   · 계좌번호 · 키 · 토큰 · 응답 원문의 저장/응답 포함
// ─────────────────────────────────────────────────────────────────────────────

import { json, type serviceClient } from "./data-server";
import {
  CANO_RE,
  readKisAccount,
  resolveKisAccountApp,
  type KisAccountEnv,
  type KisReadRequest,
  type KisReadResult,
} from "./kis-account-read";
import { getKisAccessToken, type KVLike } from "./kis-server";
import { redactKisSecrets, type KisAccountCredentials } from "./kis-account-server";
import { kisApiQueryGate } from "./broker-connection";
import { kstDateString } from "./snapshot";
import { EXEC_ACCOUNT_TYPE, EXEC_PRODUCT_CODE, readBundle } from "./kis-execution-server";
import { effectiveLedger } from "./kis-execution-compose";
import { guard } from "./kis-transfer-server";
import { latestObservation, withLock } from "./kis-request-support";
import { transferTargetOf } from "./kis-transfer-compose";
import { observationToPart } from "./kis-balance-observation";
import {
  BROKER_SYNC_AUDIT_ACTION,
  evaluateBrokerSync,
  finalizeSyncWrite,
  type LibraryEntry,
  type SyncBalance,
  type SyncEvaluation,
} from "./broker-sync";

type ServiceClient = NonNullable<ReturnType<typeof serviceClient>>;

/** 서버 플래그. 정확히 "on" 일 때만 켜진다. **기본 꺼짐** */
export function isBrokerSyncEnabled(env: { KIS_ACCOUNT_SYNC_ENABLED?: string }): boolean {
  return env.KIS_ACCOUNT_SYNC_ENABLED === "on";
}

export interface SyncDeps {
  /** 테스트 주입. 기본은 readKisAccount */
  readAccount?: (req: KisReadRequest) => Promise<KisReadResult>;
  getToken?: (env: KisAccountEnv, cred: Pick<KisAccountCredentials, "appKey" | "appSecret">) => Promise<string>;
  today?: () => string;
  now?: () => Date;
}

const defaultGetToken: NonNullable<SyncDeps["getToken"]> = (env, c) =>
  getKisAccessToken(c.appKey, c.appSecret, env.RATE_LIMIT as KVLike | undefined);

const rejected = (code: string, message: string, extra: Record<string, unknown> = {}, status = 409) =>
  json({ state: "rejected", code, message, ...extra }, status);

// ── 읽기 ────────────────────────────────────────────────────────────────────

interface SyncInputs {
  doc: Record<string, unknown>;
  revision: number;
  library: LibraryEntry[];
  snapshotDates: string[];
}

/** 계좌 문서 · 자산 라이브러리 · 기존 스냅샷 날짜 (모두 읽기 전용) */
async function readSyncInputs(client: ServiceClient, code: string, profile: string): Promise<SyncInputs | null> {
  const [acct, libs, snaps] = await Promise.all([
    client.from("kaw_data").select("data, revision")
      .eq("family_code", code).eq("profile", profile).eq("account_type", EXEC_ACCOUNT_TYPE).maybeSingle(),
    client.from("kaw_data").select("data").eq("family_code", code).in("account_type", ["_assetLib", "_meta"]),
    client.from("kaw_daily_portfolio_snapshots").select("snapshot_date")
      .eq("family_code", code).eq("profile", profile).eq("account_type", EXEC_ACCOUNT_TYPE)
      .order("snapshot_date", { ascending: true }).limit(2000),
  ]);
  const row = acct.data as { data?: unknown; revision?: unknown } | null;
  if (acct.error || !row || !row.data || typeof row.data !== "object" || Array.isArray(row.data) || typeof row.revision !== "number") return null;
  const library: LibraryEntry[] = [];
  for (const r of (libs.data ?? []) as Array<{ data?: { assetLibrary?: unknown } | null }>) {
    const lib = r.data?.assetLibrary;
    if (!Array.isArray(lib)) continue;
    for (const d of lib as Array<{ defaultEtf?: unknown; ticker?: unknown }>) {
      if (typeof d?.defaultEtf === "string") library.push({ defaultEtf: d.defaultEtf, ...(typeof d.ticker === "string" ? { ticker: d.ticker } : {}) });
    }
  }
  const snapshotDates = ((snaps.data ?? []) as Array<{ snapshot_date?: unknown }>)
    .map((s) => String(s.snapshot_date ?? "").slice(0, 10)).filter(Boolean);
  return { doc: row.data as Record<string, unknown>, revision: row.revision, library, snapshotDates };
}

interface BalanceRead { balance: SyncBalance | null; failure: string | null; liveAttempted: boolean }

/**
 * 증권사 잔고를 얻는다. live 이면 KIS 를 **정확히 한 번** 읽는다(재시도 없음).
 * 실패하면 저장된 관측으로 내려가되, 그 관측은 source = "stored_observation" 이고 기준일이 그대로 따라간다 —
 * 평가기가 '오늘이 아니면' 오래된 관측으로 취급해 별도 승인을 요구한다.
 */
async function obtainBalance(
  env: KisAccountEnv, deps: SyncDeps, client: ServiceClient, session: { code: string; profile: string },
  registry: Parameters<typeof transferTargetOf>[0], live: boolean, today: string,
): Promise<BalanceRead> {
  let failure: string | null = null;
  if (live) {
    const app = resolveKisAccountApp(env);
    const cano = env.KIS_ACCOUNT_CANO;
    if (!app || !cano || !CANO_RE.test(cano)) {
      failure = "not_configured";
    } else if (!kisApiQueryGate(registry, EXEC_ACCOUNT_TYPE, today, EXEC_PRODUCT_CODE).allowed) {
      failure = "gate_blocked";
    } else {
      const cred: KisAccountCredentials = { appKey: app.appKey, appSecret: app.appSecret, cano };
      try {
        const token = await (deps.getToken ?? defaultGetToken)(env, cred);
        const read = deps.readAccount ?? ((req: KisReadRequest) => readKisAccount(req));
        const result = await read({ productCode: "22", registry, credentials: cred, token });
        const part = observationToPart(result.observation, session.profile);
        if (part.ok && part.part.holdings && part.part.cash !== null && part.part.cash !== undefined) {
          return {
            liveAttempted: true, failure: null,
            balance: {
              holdings: part.part.holdings, cash: part.part.cash, stateAsOf: part.part.stateAsOf,
              observedAt: part.part.observedAt, source: "kis_live_read", captureId: part.part.captureId,
            },
          };
        }
        failure = part.ok ? "balance_incomplete" : part.reason;
      } catch (e) {
        void redactKisSecrets(e, [app.appKey, app.appSecret, cano]);
        failure = "auth_or_transport";
      }
    }
  }

  // 저장된 관측(마지막 기록) — 현재가 아닐 수 있다. 기준일은 그대로 노출한다.
  const target = transferTargetOf(registry);
  const obs = target ? await latestObservation(client, session.code, session.profile, target.id) : null;
  if (obs && obs.holdings && obs.cash !== null) {
    return {
      liveAttempted: live, failure,
      balance: { holdings: obs.holdings, cash: obs.cash, stateAsOf: obs.stateAsOf, observedAt: obs.observedAt, source: "stored_observation", captureId: obs.captureId },
    };
  }
  return { liveAttempted: live, failure: failure ?? "no_observation", balance: null };
}

interface Evaluated { ev: SyncEvaluation; read: BalanceRead; revision: number }

export async function evaluateNow(
  env: KisAccountEnv, deps: SyncDeps, client: ServiceClient, session: { code: string; profile: string },
  live: boolean, staleApproved: boolean, today: string,
): Promise<Evaluated | { error: Response }> {
  const bundle = await readBundle(client, session.code, session.profile);
  if (!bundle.ok) return { error: json({ state: "ledger_unavailable" }, 503) };
  const inputs = await readSyncInputs(client, session.code, session.profile);
  if (!inputs) return { error: json({ state: "account_unavailable" }, 503) };

  const read = await obtainBalance(env, deps, client, session, bundle.registry, live, today);
  const ev = evaluateBrokerSync({
    flagEnabled: isBrokerSyncEnabled(env),
    doc: inputs.doc, revision: inputs.revision, library: inputs.library,
    ledger: effectiveLedger(bundle.ledger, bundle.corrections),
    correctionsPresent: bundle.corrections.size > 0,
    transfers: bundle.transfers,
    balance: read.balance, balanceFailure: read.failure,
    flows: bundle.flows, snapshotDates: inputs.snapshotDates, today, staleObservationApproved: staleApproved,
  });
  return { ev, read, revision: inputs.revision };
}

const readView = (r: BalanceRead) => ({
  liveAttempted: r.liveAttempted,
  failure: r.failure,
  source: r.balance?.source ?? null,
  stateAsOf: r.balance?.stateAsOf ?? null,
  observedAt: r.balance?.observedAt ?? null,
});

// ── preview ─────────────────────────────────────────────────────────────────

export async function handleSyncPreview(request: Request, env: KisAccountEnv, deps: SyncDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;
  const body = (await request.json().catch(() => null)) as { live?: unknown; staleObservationApproved?: unknown } | null;
  const today = (deps.today ?? kstDateString)();
  const r = await evaluateNow(env, deps, client, session, body?.live === true, body?.staleObservationApproved === true, today);
  if ("error" in r) return r.error;
  const { ev, read } = r;
  return json({
    state: "preview",
    enabled: ev.enabled, flagEnabled: ev.flagEnabled, eligible: ev.eligible,
    alreadySynced: ev.alreadySynced, needsStaleApproval: ev.needsStaleApproval,
    blockers: ev.blockers, plan: ev.plan, balance: readView(read), today,
  });
}

// ── apply ───────────────────────────────────────────────────────────────────

export async function handleSyncApply(request: Request, env: KisAccountEnv, deps: SyncDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;

  // 1) 요청 모양 + 명시적 승인. 승인이 없으면 읽지도 KIS 를 부르지도 쓰지도 않는다.
  const body = (await request.json().catch(() => null)) as { planHash?: unknown; approved?: unknown; staleObservationApproved?: unknown } | null;
  if (!body || body.approved !== true) {
    return rejected("approval_required", "사용자의 명시적 승인이 없어 동기화하지 않았습니다.", {}, 400);
  }
  if (typeof body.planHash !== "string" || !/^s1\|[0-9a-f]+$/.test(body.planHash)) {
    return rejected("bad_request", "planHash 형식이 올바르지 않습니다.", {}, 400);
  }
  const planHash = body.planHash;
  const staleApproved = body.staleObservationApproved === true;

  // 2) 서버 플래그 — 기본 꺼짐. 켜지 않았으면 KIS 도 DB 도 건드리지 않는다.
  if (!isBrokerSyncEnabled(env)) {
    return rejected("sync_disabled", "계좌 동기화 기능이 서버에서 켜져 있지 않습니다.", {}, 403);
  }
  // 3) credential — 최신 잔고를 반드시 읽어야 하므로 없으면 진행하지 않는다
  const app = resolveKisAccountApp(env);
  const cano = env.KIS_ACCOUNT_CANO;
  if (!app || !cano || !CANO_RE.test(cano)) {
    return json({ unavailable: true, state: "not_configured", error: "한국투자 계좌 조회 설정이 서버에 없습니다." }, 503);
  }
  const today = (deps.today ?? kstDateString)();
  const now = (deps.now ?? (() => new Date()))();

  // 4) 같은 계정의 동시 요청은 한 번에 하나만
  return withLock(env, "kis-sync-apply", session, async () => {
    // 5) 지금 다시 읽고 판정한다 — 사용자가 본 미리보기를 믿지 않는다. KIS 읽기는 1회(재시도 없음).
    const r = await evaluateNow(env, deps, client, session, true, staleApproved, today);
    if ("error" in r) return r.error;
    const { ev, read } = r;
    if (ev.alreadySynced) {
      return rejected("already_synced", "같은 상태의 동기화가 이미 기록돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.");
    }
    if (!ev.eligible || !ev.plan || !ev.write) {
      return rejected("not_eligible", "동기화 조건을 만족하지 않습니다.", { blockers: ev.blockers, balance: readView(read) });
    }
    // 6) 승인한 계획과 지금 계산한 계획이 같아야 한다 (그 사이 원장 · 잔고 · 수량이 바뀌면 거부)
    if (ev.plan.planHash !== planHash) {
      return rejected("plan_changed", "승인한 뒤 잔고·원장·수량이 바뀌어 동기화하지 않았습니다. 새 계획을 확인한 뒤 다시 승인하세요.", { plan: ev.plan, balance: readView(read) });
    }

    // 7) 한 번의 RPC — 계좌 문서(revision CAS) + 승인 감사가 같은 트랜잭션.
    const w = finalizeSyncWrite(ev.write, now.toISOString(), session.profile);
    const { data, error } = await client.rpc("kaw_broker_sync_apply", {
      p_family_code: session.code,
      p_profile: session.profile,
      p_expect: w.expect,
      p_new_data: w.newData,
      p_audit: {
        actor: session.profile,
        note: `사용자 승인 하에 연금저축 보유수량·예수금을 증권사 확인값으로 동기화 (계획 ${planHash})`,
        previous_value: {
          liveQuantities: ev.plan.rows.map((x) => ({ rowId: x.rowId, quantity: x.quantityBefore })),
          cashBalance: ev.plan.cash.before,
          expectedRevision: r.revision,
        },
        new_value: { ...w.record },
      },
    });

    if (error) return mapRpcError(error as { code?: string; message?: string });
    const res = data as { status?: string; record_id?: string; revision?: number } | null;
    if (res?.status === "applied") {
      return json({ state: "applied", recordId: res.record_id, revision: res.revision, auditAction: BROKER_SYNC_AUDIT_ACTION, plan: ev.plan });
    }
    if (res?.status === "already_synced") {
      return rejected("already_synced", "같은 상태의 동기화가 이미 기록돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.");
    }
    return json({ state: "write_failed" }, 500);
  });
}

const RPC_MESSAGE: Record<string, string> = {
  transfer_unconfirmed: "DB 에 확정된 계좌 이전 기록이 없어 동기화하지 않았습니다.",
  corrections_present: "거래 정정(overlay)이 있어 자동 동기화하지 않았습니다.",
  holdings_mismatch: "원장 재생 보유가 증권사 보유와 달라 전부 취소했습니다(아무것도 기록하지 않았습니다).",
  revision_conflict: "그 사이 계좌 데이터가 다른 기기에서 바뀌어 동기화하지 않았습니다. 새로 고친 뒤 다시 확인하세요.",
  save_conflict: "계좌 문서 저장이 충돌해 전부 취소했습니다(아무것도 기록하지 않았습니다).",
  doc_changed_outside_allowed: "허용되지 않은 항목이 바뀌는 문서여서 전부 취소했습니다.",
  doc_mismatch: "검증된 계획과 다른 문서여서 전부 취소했습니다.",
  record_mismatch: "동기화 기록이 검증된 계획·현재값·승인자와 달라 전부 취소했습니다.",
  doc_missing: "계좌 문서를 찾지 못했습니다.",
  invalid_input: "요청 형식이 올바르지 않아 동기화하지 않았습니다.",
  forbidden: "DB 권한이 없어 동기화하지 않았습니다.",
};

function mapRpcError(err: { code?: string; message?: string }): Response {
  const msg = err.message ?? "";
  // 함수가 아직 없다(migration 013 미적용) — 쓰지 않고 알린다. 다른 방법으로 우회하지 않는다.
  if (err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(msg)) {
    return json({ state: "apply_unavailable", message: "DB 반영 함수(migration 013)가 아직 적용되지 않아 동기화할 수 없습니다." }, 503);
  }
  const m = /^KAW_SYNC:([a-z_]+)/.exec(msg);
  if (m) return rejected(m[1], RPC_MESSAGE[m[1]] ?? "DB 가 동기화를 거부했습니다.", {});
  // 같은 승인 감사가 이미 있다(경합 중 다른 요청이 먼저 반영) — 성공이 아니다.
  if (err.code === "23505") return rejected("already_synced", "같은 상태의 동기화가 이미 기록돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.");
  return json({ state: "write_failed" }, 500);
}
