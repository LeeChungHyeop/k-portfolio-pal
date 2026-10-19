// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kis/executions/apply — 한국투자 실제 체결 → 거래원장 반영 (Phase 4-C-2)
//
//   요청  { start, end, planHash, approved: true }
//   응답  { state: "applied" | "rejected" | "query_failed" | "apply_unavailable" | ... }
//
// ## 순서가 곧 안전장치다
//   세션 → 요청 모양 + **명시적 승인** → 소유권 → 서버 플래그 → credential → 동시 요청 잠금 →
//   원장·레지스트리·이전 기록 읽기 → 계좌 게이트 → **KIS 체결 재조회** → **최신 원장과 대조한 반영 판정** →
//   사용자가 승인한 계획 해시와 대조 → RPC 한 번(원장 행 + batch + 승인 감사, 한 트랜잭션)
//   앞 단계가 막히면 뒤 단계(KIS 호출 · 쓰기)는 실행하지 않는다.
//
// ## 쓰기는 정확히 한 곳이다
//   `rpc("kaw_kis_execution_apply")` 1회 (migration 012). 이 파일에는 insert / update / upsert / delete 가 없다.
//   중복 · 부분 반영 · 반영 후 보유 불일치는 DB 가 같은 트랜잭션 안에서 막는다.
//
// ## 하지 않는 것
//   · 주문 · 취소 · 이체 — KIS 호출은 체결 조회뿐이다
//   · cashflow · kaw_data · 보유수량/예수금 설정 · 스냅샷 변경
//   · 계획 해시가 다르면(그 사이 원장이나 체결이 바뀜) 반영하지 않고 새 계획을 돌려준다
//   · 계좌번호 · 키 · 토큰 · 응답 원문의 저장/응답 포함
// ─────────────────────────────────────────────────────────────────────────────

import { json } from "./data-server";
import { resolveKisAccountApp, type KisAccountEnv } from "./kis-account-read";
import type { KisAccountCredentials } from "./kis-account-server";
import { kisApiQueryGate } from "./broker-connection";
import { kstDateString } from "./snapshot";
import {
  EXEC_ACCOUNT_TYPE,
  EXEC_MAX_SPAN_DAYS,
  EXEC_PRODUCT_CODE,
  isLedgerApplyEnabled,
  queryKisExecutions,
  readBundle,
  type ExecDeps,
} from "./kis-execution-server";
import { composeExecutionPreviewDetailed } from "./kis-execution-compose";
import { guard } from "./kis-transfer-server";
import { latestObservation, withLock } from "./kis-request-support";
import { transferTargetOf } from "./kis-transfer-compose";
import { KIS_APPLY_AUDIT_ACTION } from "./kis-ledger-apply";

export interface ApplyDeps extends ExecDeps {
  now?: () => Date;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isRealIso(d: unknown): d is string {
  if (typeof d !== "string" || !ISO.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
const spanDays = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 + 1;

const rejected = (code: string, message: string, extra: Record<string, unknown> = {}, status = 409) =>
  json({ state: "rejected", code, message, ...extra }, status);

export async function handleKisLedgerApply(request: Request, env: KisAccountEnv, deps: ApplyDeps = {}): Promise<Response> {
  const g = await guard(request, env);
  if (!g.ok) return g.res;
  const { session, client } = g;

  // 1) 요청 모양 + 명시적 승인. 승인이 없으면 읽지도 KIS 를 부르지도 쓰지도 않는다.
  const body = (await request.json().catch(() => null)) as { start?: unknown; end?: unknown; planHash?: unknown; approved?: unknown } | null;
  const today = (deps.today ?? kstDateString)();
  if (!body || body.approved !== true) {
    return rejected("approval_required", "사용자의 명시적 승인이 없어 반영하지 않았습니다.", {}, 400);
  }
  if (!isRealIso(body.start) || !isRealIso(body.end) || typeof body.planHash !== "string" || !/^k1\|[0-9a-f]+$/.test(body.planHash)) {
    return rejected("bad_request", "start / end / planHash 형식이 올바르지 않습니다.", {}, 400);
  }
  const { start, end, planHash } = body;
  if (start > end || end > today || spanDays(start, end) > EXEC_MAX_SPAN_DAYS) {
    return rejected("bad_request", "조회 기간이 올바르지 않습니다.", {}, 400);
  }

  // 2) 서버 플래그 — 기본 꺼짐. 켜지 않았으면 KIS 도 DB 도 건드리지 않는다.
  if (!isLedgerApplyEnabled(env)) {
    return rejected("apply_disabled", "원장 반영 기능이 서버에서 켜져 있지 않습니다.", {}, 403);
  }

  // 3) credential
  const app = resolveKisAccountApp(env);
  const cano = env.KIS_ACCOUNT_CANO;
  if (!app || !cano) {
    return json({ unavailable: true, state: "not_configured", error: "한국투자 계좌 조회 설정이 서버에 없습니다." }, 503);
  }

  // 4) 같은 계정의 동시 반영 요청은 한 번에 하나만
  return withLock(env, "kis-ledger-apply", session, async () => {
    const bundle = await readBundle(client, session.code, session.profile);
    if (!bundle.ok) return json({ state: "ledger_unavailable" }, 503);
    const gate = kisApiQueryGate(bundle.registry, EXEC_ACCOUNT_TYPE, today, EXEC_PRODUCT_CODE);
    if (!gate.allowed) return json({ state: "gate_blocked", reason: gate.reason });

    // 5) KIS 체결을 **지금** 다시 조회한다 — 사용자가 본 미리보기를 믿지 않는다. 재시도 없음.
    const cred: KisAccountCredentials = { appKey: app.appKey, appSecret: app.appSecret, cano };
    const q = await queryKisExecutions(env, deps, cred, start, end, today);
    if (!q.ok) return json(q.response, q.status);

    // 6) 최신 원장 · 이전 기록 · 최근 관측으로 반영 판정
    const target = transferTargetOf(bundle.registry);
    const observation = target ? await latestObservation(client, session.code, session.profile, target.id) : null;
    const { apply } = composeExecutionPreviewDetailed({
      rows: q.rows, summaries: q.summaries, query: q.query,
      ledger: bundle.ledger, corrections: bundle.corrections, registry: bundle.registry, flows: bundle.flows,
      confirmedTransferInstanceIds: bundle.transfers.map((t) => t.toInstanceId),
      apply: { flagEnabled: true, observation, transfers: bundle.transfers, correctionsPresent: bundle.corrections.size > 0 },
      accountType: EXEC_ACCOUNT_TYPE, productCode: EXEC_PRODUCT_CODE, today,
    });
    if (!apply || !apply.eligible || !apply.write || !apply.plan) {
      return rejected("not_eligible", "반영 조건을 만족하지 않습니다.", { blockers: apply?.blockers ?? [], alreadyApplied: apply?.alreadyApplied ?? false });
    }

    // 7) 사용자가 승인한 계획과 지금 계산한 계획이 같아야 한다 (그 사이 원장 · 체결 · 관측이 바뀌면 거부)
    if (apply.plan.planHash !== planHash) {
      return rejected("plan_changed", "승인한 뒤 원장·체결·관측이 바뀌어 반영하지 않았습니다. 새 계획을 확인한 뒤 다시 승인하세요.", { plan: apply.plan });
    }

    // 8) 한 번의 RPC — 원장 행 + batch + 승인 감사가 같은 트랜잭션. 반영 후 보유가 관측과 다르면 DB 가 전부 롤백한다.
    const w = apply.write;
    const { data, error } = await client.rpc("kaw_kis_execution_apply", {
      p_family_code: session.code,
      p_profile: session.profile,
      p_batch: w.batch,
      p_rows: w.rows,
      p_audit: {
        actor: session.profile,
        note: `사용자 승인 하에 한국투자 실제 체결 ${w.rows.length}건을 거래원장에 반영 (계획 ${planHash})`,
        previous_value: w.auditPreviousValue,
        new_value: w.auditNewValue,
      },
      p_expect: w.expect,
    });

    if (error) return mapRpcError(error as { code?: string; message?: string });
    const res = data as { status?: string; inserted?: number; batch_id?: string; holdings_after?: Record<string, number> } | null;
    if (res?.status === "applied") {
      return json({ state: "applied", batchId: res.batch_id, inserted: res.inserted, holdingsAfter: res.holdings_after, auditAction: KIS_APPLY_AUDIT_ACTION });
    }
    if (res?.status === "already_applied") {
      return rejected("already_applied", "이미 같은 주문이 원장에 반영돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.");
    }
    return json({ state: "write_failed" }, 500);
  });
}

const RPC_MESSAGE: Record<string, string> = {
  transfer_unconfirmed: "DB 에 확정된 계좌 이전 기록이 없어 반영하지 않았습니다.",
  prior_residual: "이전 증권사 출처의 원장 보유가 남아 있어 반영하지 않았습니다.",
  corrections_present: "거래 정정(overlay)이 있어 자동 반영하지 않았습니다.",
  holdings_mismatch: "반영 후 원장 재생 보유가 한국투자 관측 보유와 달라 전부 취소했습니다(아무것도 기록하지 않았습니다).",
  partial_conflict: "일부 체결만 이미 원장에 있어 반영하지 않았습니다.",
  invalid_row: "반영 대상 행이 계약을 만족하지 않아 반영하지 않았습니다.",
  invalid_input: "요청 형식이 올바르지 않아 반영하지 않았습니다.",
};

function mapRpcError(err: { code?: string; message?: string }): Response {
  const msg = err.message ?? "";
  // 함수가 아직 없다(migration 012 미적용) — 쓰지 않고 알린다. 다른 방법으로 우회하지 않는다.
  if (err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(msg)) {
    return json({ state: "apply_unavailable", message: "DB 반영 함수(migration 012)가 아직 적용되지 않아 반영할 수 없습니다." }, 503);
  }
  const m = /^KAW_KIS_APPLY:([a-z_]+)/.exec(msg);
  if (m) return rejected(m[1], RPC_MESSAGE[m[1]] ?? "DB 가 반영을 거부했습니다.", {});
  // 같은 batch id 가 이미 있다(경합 중 다른 요청이 먼저 반영) — 성공이 아니다.
  if (err.code === "23505") return rejected("already_applied", "이미 같은 주문이 원장에 반영돼 있습니다. 이번 요청은 아무것도 기록하지 않았습니다.");
  return json({ state: "write_failed" }, 500);
}
