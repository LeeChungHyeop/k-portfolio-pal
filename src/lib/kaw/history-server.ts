// ─────────────────────────────────────────────────────────────────────────────
// HistoryEntry 병합 API — server-side only (Cloudflare Workers)
//
//   POST /api/data/history   리밸런싱 기록 1건을 계좌 문서에 **원자적으로 병합**한다
//
// 브라우저는 Supabase 에 직접 붙지 않는다. 기존 /api/data · /api/ledger ·
// /api/rebalance/plan 과 **같은** 세션 토큰 경로만 쓴다(`requireSession`).
// service_role 키는 서버에만 있고, `family_code` / `profile` 은 **세션에서만** 온다 —
// 본문에 무엇이 들어 있어도 쓰지 않는다. 즉 남의 가족코드/프로필 문서는 이 경로로
// 건드릴 수 없다.
//
// ── /api/data 와 무엇이 다른가 ──────────────────────────────────────────────
//
//   /api/data        계좌 JSON **문서 전체**를 upsert. last-writer-wins —
//                    그 기록이 없던 시점의 문서가 뒤에 도착하면 기록이 사라진다
//   여기             기록 **1건만** 보낸다. 서버(RPC)가 읽기-수정-쓰기를 한 트랜잭션
//                    안에서 하므로 동시 요청에서도 둘 다 남는다
//
// **기존 자동저장 경로는 그대로 둔다.** 이 endpoint 는 추가된 경로이고, 지금 단계에서
// 호출부를 바꾸지 않는다(1B-2A 의 범위는 서버 기반 구축이다). 그래서 문서 전체 교체와의
// 경합은 아직 남아 있다 — 그것은 revision guard(1B-2B)가 없앤다. migration 006 대원칙 6.
//
// ── 응답 ────────────────────────────────────────────────────────────────────
//
//   200 { outcome: 'created',        revision, historyCount, entryHash, staleReturnPctIds }
//   200 { outcome: 'already_exists', revision, historyCount, entryHash }   멱등 재시도
//   400 { error }                   본문/해시 문제. 재시도로 풀리지 않는다
//   404 { error: 'account_row_missing' }  계좌 문서가 아직 없다(여기서 만들지 않는다)
//   409 { error: 'history_hash_mismatch', storedHash, incomingHash }
//   503 { unavailable: true }       migration 006 미적용
//
// `already_exists` 도 **ACK 다** — 행이 있다는 사실이 저장의 증거다
// (plan-server.ts 와 같은 규칙).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, serviceClient, requireSession, type DataEnv } from "./data-server";
import {
  historyConflictOutcome,
  isInvalidParameter,
  isUndefinedFunction,
  readHistoryMergeResult,
  validateHistoryMergeBody,
  type HistoryMergeRequest,
} from "./history-merge";

type Session = { code: string; profile: string };

async function auth(
  request: Request,
  env: DataEnv,
): Promise<{ client: SupabaseClient; session: Session } | Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const session = await requireSession(request, env);
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  return { client, session: { code: session.code, profile: session.profile } };
}

/**
 * audit 1건. **본 작업이 끝난 뒤** 부르고, 실패해도 본 작업을 되돌리지 않는다
 * (plan-server.ts / ledger-server.ts 와 같다 — 되돌리면 "기록은 남았는데 저장은
 * 사라진" 더 나쁜 상태가 된다).
 *
 * 기록 본문을 넣지 않는다: 보유수량·금액이 로그성 테이블에 복제되면 "파생값/복본을
 * 만들지 않는다" 원칙이 무너진다. **무엇이 일어났는지만** 남긴다.
 */
async function writeHistoryAudit(
  client: SupabaseClient,
  session: Session,
  req: HistoryMergeRequest,
  outcome: "created" | "already_exists",
  revision: number | null,
): Promise<void> {
  const { error } = await client.from("kaw_ledger_audit").insert({
    family_code: session.code,
    profile: session.profile,
    actor: session.profile,
    action: "history_merge",
    target_type: "history",
    target_id: req.entry.id,
    previous_value: null,
    new_value: {
      outcome,
      accountType: req.accountType,
      date: req.entry.date,
      entryHash: req.entryHash,
      revision,
    },
    note: null,
  });
  if (error) console.error(`[kaw] history audit 기록 실패 (${outcome}): ${error.message}`);
}

/**
 * POST /api/data/history — 기록 1건 병합.
 *
 * 멱등성의 열쇠는 `entry.id` 다(완료 1회 = `hist:<completionId>`). 같은 id 에
 * **다른 경제값**이 오면 409 이고, 그것은 재시도로 풀리지 않는다 — 조용히 ACK 하면
 * "저장된 것과 다른 기록"을 저장됐다고 믿게 된다(history-merge.ts 상단).
 */
export async function handleHistoryMergePost(request: Request, env: DataEnv): Promise<Response> {
  const a = await auth(request, env);
  if (a instanceof Response) return a;
  const { client, session } = a;

  const body = await request.json().catch(() => null);
  const v = validateHistoryMergeBody(body);
  if (!v.ok) return json({ error: v.error }, v.status);
  const req = v.request;

  // 병합은 **전부 RPC 안에서** 일어난다. 여기서 select → 병합 → upsert 를 하면
  // 동시 요청에서 한쪽 기록이 사라진다(migration 006 대원칙 3).
  const { data, error } = await client.rpc("kaw_data_merge_history", {
    p_family_code: session.code,
    p_profile: session.profile,
    p_account_type: req.accountType,
    p_entry: req.entry,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (isUndefinedFunction(code)) {
      // "데이터가 없음" 과 "저장소가 아직 없음" 을 구분해 돌려준다(원장/plan API 와 같은 규칙).
      console.error("[kaw] kaw_data_merge_history 가 없습니다 (migration 006 미적용)");
      return json({ unavailable: true, error: "기록 병합 경로가 아직 없습니다" }, 503);
    }
    if (isInvalidParameter(code)) {
      // RPC 의 모양 검증까지 내려갔다 = 앞단 검증이 놓친 것이다. 500 으로 흘리지 않는다.
      return json({ error: error.message }, 400);
    }
    console.error("[kaw] history 병합 실패:", error.message);
    return json({ error: error.message }, 500);
  }

  const result = readHistoryMergeResult(data);

  if (result.kind === "created") {
    await writeHistoryAudit(client, session, req, "created", result.revision);
    return json({
      outcome: "created",
      id: req.entry.id,
      accountType: req.accountType,
      revision: result.revision,
      historyCount: result.historyCount,
      entryHash: req.entryHash,
      // 과거 날짜를 끼워 넣어 **체인이 낡아진** 기록. 여기서 고치지 않는다 —
      // returnPct 의 정의는 store.ts recalcReturns 한 곳뿐이다(006 대원칙 5).
      staleReturnPctIds: result.staleReturnPctIds,
    });
  }

  if (result.kind === "exists") {
    const conflict = historyConflictOutcome(result.entry, req.entryHash, req.hashVersion);
    if (conflict.kind === "already_exists") {
      await writeHistoryAudit(client, session, req, "already_exists", result.revision);
      return json({
        outcome: "already_exists",
        id: req.entry.id,
        accountType: req.accountType,
        revision: result.revision,
        historyCount: result.historyCount,
        entryHash: req.entryHash,
      });
    }
    if (conflict.kind === "hash_mismatch") {
      return json(
        {
          error: "history_hash_mismatch",
          message: "같은 기록 id 로 이미 다른 내용이 저장돼 있습니다.",
          id: req.entry.id,
          storedHash: conflict.storedHash,
          incomingHash: req.entryHash,
        },
        409,
      );
    }
    // 저장된 기록을 해석하지 못했다 — ACK 하지 않고 재시도 가능한 실패로 돌려준다.
    return json({ error: "기존 기록을 확인할 수 없습니다. 잠시 후 다시 시도해주세요." }, 503);
  }

  if (result.kind === "account_row_missing") {
    // 계좌 문서를 만들어주지 않는다(006 대원칙 4). 기존 자동저장이 먼저 돌아야 한다.
    return json(
      {
        error: "account_row_missing",
        message: "계좌 데이터가 아직 저장되지 않았습니다. 계좌 저장 후 다시 시도해주세요.",
        accountType: req.accountType,
      },
      404,
    );
  }

  console.error("[kaw] history 병합: 알 수 없는 반환값", JSON.stringify(result.raw));
  return json({ error: "기록 병합 결과를 해석할 수 없습니다." }, 500);
}
