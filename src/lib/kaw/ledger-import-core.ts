// ─────────────────────────────────────────────────────────────────────────────
// 거래 원장 적재의 **쓰기 경로**. CLI(scripts/ledger-import.ts)가 이것을 호출한다.
//
// 검증·리포트·인자 파싱은 스크립트에 남기고, DB 에 실제로 쓰는 부분만 여기로 뺐다.
// 테스트가 가짜 Supabase 클라이언트로 이 흐름을 그대로 돌려본다
// (src/lib/kaw/ledger-import.test.ts).
//
// ── 쓰기 순서와 트랜잭션 경계 ───────────────────────────────────────────────
//
// 적재는 **두 번의 Supabase 요청**이다. PostgREST 는 요청 1건 = 트랜잭션 1건이라
//
//   (1) 원장 463행 upsert   — 이 안에서는 all-or-nothing (단일 INSERT 문)
//   (2) batch 1행 insert    — provenance. **완성된 행을 한 번만 넣는다**
//
// **두 요청 사이에는 트랜잭션이 없다.** 그래서 (1) 성공 + (2) 실패가 가능하고, 그러면
// 원장 행의 import_batch_id 가 존재하지 않는 batch 를 가리킨다. 원장은 immutable 이라
// 그 컬럼을 고칠 수 없으므로, 그냥 재실행하면 **새 batch id 가 생겨 끊긴 참조가 그대로
// 남는다.** 그래서 (2) 가 끝내 실패하면 조용히 끝내지 않고 **같은 id 로 넣을 INSERT 문을
// 출력하고 throw** 한다. 그 한 줄을 SQL Editor 에 붙여넣으면 복구된다.
//
// (2) 를 (1) 보다 먼저 넣지 않는 이유: inserted/skipped 는 (1) 의 결과라 미리 알 수 없고,
// 먼저 넣으려면 나중에 UPDATE 해야 하는데 kaw_ledger_import_batch 는 service_role 에
// select/insert 만 있다(migration 004). 지금 순서가 그 권한 모델과 맞는 유일한 순서다.
//
// import_batch_id 에는 **FK 가 없다**(004 확인). 그래서 원장을 먼저 넣어도 참조 위반이
// 나지 않는다 — provenance 참조일 뿐 무결성 제약이 아니다.
// ─────────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from "@supabase/supabase-js";
import { FINGERPRINT_VERSION } from "./ledger";
import { verifyDataset, type VerifiedDataset } from "./verified-transactions";

export const SOURCE_KIND = "verified_dataset_v1";
export const SOURCE_LABEL = "data/verified-transactions.v1.json";

/**
 * 적재한 **데이터셋 세대**를 batch 이력에 남긴다.
 *
 * v1 463건을 넣은 batch 와 v2 469건을 넣은 batch 가 이력에서 구분되지 않으면
 * "이 행은 어느 파일에서 왔는가"를 나중에 말할 수 없다. 기본값은 v1 그대로라
 * 기존 호출부·테스트의 동작은 바뀌지 않는다.
 */
export function datasetProvenance(label: string): { kind: string; label: string } {
  const m = /verified-transactions\.v(\d+)\.json$/.exec(label.split("\\").join("/"));
  return { kind: m ? `verified_dataset_v${m[1]}` : SOURCE_KIND, label };
}

/** 적재 대상 식별자. CLI 의 --family / --profile 에서 온다. */
export interface ImportTarget {
  familyCode: string;
  profile: string;
  /** 적재한 데이터셋 파일 경로. 없으면 v1 로 본다(기존 동작). */
  datasetLabel?: string;
}

/** SQL 문자열 리터럴. 사람이 SQL Editor 에 붙여넣을 복구문을 만들 때만 쓴다. */
function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "null";
  return `'${v.replaceAll('\'', '\'\'')}'`;
}

export interface BatchRow {
  id: string;
  family_code: string;
  profile: string;
  source_kind: string;
  source_label: string;
  source_checksum: string;
  inserted_count: number;
  skipped_count: number;
  verification: unknown;
  actor: string;
}

/** batch 행 한 건을 그대로 넣는 INSERT 문 — batch 기록이 실패했을 때의 복구 수단. */
export function batchInsertSql(row: BatchRow): string {
  return [
    "insert into public.kaw_ledger_import_batch",
    "  (id, family_code, profile, source_kind, source_label, source_checksum,",
    "   inserted_count, skipped_count, verification, actor)",
    "values",
    `  (${sqlStr(row.id)}, ${sqlStr(row.family_code)}, ${sqlStr(row.profile)},`,
    `   ${sqlStr(row.source_kind)}, ${sqlStr(row.source_label)}, ${sqlStr(row.source_checksum)},`,
    `   ${row.inserted_count}, ${row.skipped_count},`,
    `   ${sqlStr(JSON.stringify(row.verification))}::jsonb, ${sqlStr(row.actor)});`,
  ].join("\n");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * batch 행을 **한 번의 INSERT 로** 넣는다. UPDATE 하지 않는다 —
 * kaw_ledger_import_batch 는 service_role 에 select/insert 만 있다(migration 004).
 *
 * 일시적 네트워크 오류를 몇 번 흡수한다. 같은 id 로 다시 넣는 것이라, 앞선 시도가
 * 실제로는 커밋됐다면 2회차가 PK 충돌로 끝나므로 행이 늘지 않는다.
 */
export async function insertBatch(
  client: SupabaseClient, row: BatchRow, attempts = 3, waitMs = 400,
): Promise<{ message: string } | null> {
  let last: { message: string } | null = null;
  for (let i = 1; i <= attempts; i += 1) {
    const { error } = await client.from("kaw_ledger_import_batch").insert(row);
    if (!error) return null;
    last = error;
    if (i < attempts) {
      console.warn(`  batch 이력 기록 실패 (${i}/${attempts}) — 재시도: ${error.message}`);
      await sleep(waitMs * i);
    }
  }
  return last;
}

export async function applyImport(
  client: SupabaseClient, d: VerifiedDataset, args: ImportTarget, checksum: string,
  // batch 기록 재시도. 테스트가 대기 없이 돌 수 있도록 열어뒀다.
  retry: { attempts: number; waitMs: number } = { attempts: 3, waitMs: 400 },
): Promise<void> {
  const prov = datasetProvenance(args.datasetLabel ?? SOURCE_LABEL);
  const batchId = `imp:${prov.kind}:${new Date().toISOString()}`;
  const rows = d.transactions.map((t) => ({
    family_code: args.familyCode,
    profile: args.profile,
    id: t.id,
    account_type: t.accountId,
    ticker: t.ticker,
    etf_name: t.etfName,
    side: t.side,
    quantity: t.quantity,
    price: t.price,
    amount: t.amount,
    trade_date: t.tradeDate,
    settlement_date: t.settlementDate,
    inferred_trade_date: t.inferredTradeDate,
    event_date: t.eventDate,
    trade_date_evidence: t.tradeDateEvidence,
    fee: t.fee,
    tax: t.tax,
    post_quantity: t.postQuantity,
    source: t.source,
    source_file: t.sourceFile ?? null,
    source_row: t.sourceRow ?? null,
    source_fingerprint: t.sourceFingerprint,
    fingerprint_version: t.fingerprintVersion ?? FINGERPRINT_VERSION,
    import_batch_id: batchId,
  }));

  // ── (1) 원장. 중복이면 건너뛴다 — 기존 행을 덮어쓰지 않는다(원장은 immutable).
  //     PostgREST 요청 1건 = 트랜잭션 1건이라 이 463행은 전부 들어가거나 전부 안 들어간다.
  //     RETURNING 은 **실제로 삽입된 행만** 돌려주므로 data.length 가 곧 inserted 다.
  const { data, error } = await client
    .from("kaw_transaction_ledger")
    .upsert(rows, {
      onConflict: "family_code,profile,source_fingerprint",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) {
    console.error(`\n  원장 적재 실패: ${error.message}`);
    console.error("  타임아웃이라면 **서버는 이미 커밋했을 수도 있다.** 재실행 전에");
    console.error("  dry-run 으로 DB 기존 행 수를 먼저 확인한다:");
    console.error(`    npm run ledger:dry-run -- --family=${args.familyCode} --profile=${args.profile}`);
    console.error("  fingerprint UNIQUE 가 있으므로 재실행해도 중복 행은 생기지 않는다.");
    throw new Error(`적재 실패: ${error.message}`);
  }

  const inserted = data?.length ?? 0;
  const skipped = rows.length - inserted;

  // ── (2) provenance. **완성된 행을 한 번 INSERT 한다.** 사후 UPDATE 는 없다.
  const batchRow: BatchRow = {
    id: batchId,
    family_code: args.familyCode,
    profile: args.profile,
    source_kind: prov.kind,
    source_label: prov.label,
    source_checksum: checksum,
    inserted_count: inserted,
    skipped_count: skipped,
    verification: verifyDataset(d),
    actor: args.profile,
  };

  const batchError = await insertBatch(client, batchRow, retry.attempts, retry.waitMs);
  if (batchError) {
    // 조용히 넘어가지 않는다. 원장은 이미 들어갔고 import_batch_id 는 immutable 이라,
    // 그냥 재실행하면 새 batch id 가 생겨 끊긴 참조가 **영구히** 남는다.
    console.error("\n  ── batch 이력 기록 실패 ─────────────────────────────────");
    console.error(`  ${batchError.message}`);
    console.error("");
    console.error(`  원장 ${inserted}건은 이미 적재됐고, 그 행들의 import_batch_id 는`);
    console.error(`  ${batchId}`);
    console.error("  를 가리키는데 해당 batch 행이 없다 — provenance 가 끊긴 상태다.");
    console.error("  원장은 immutable 이라 import_batch_id 를 고칠 수 없으므로,");
    console.error("  **같은 id 로** 아래 INSERT 를 Supabase SQL Editor 에 붙여넣어 복구한다.");
    console.error("  (스크립트를 그냥 재실행하면 새 batch id 가 생겨 끊긴 참조가 남는다.)");
    console.error("");
    console.error(batchInsertSql(batchRow));
    console.error("");
    throw new Error(`batch 이력 기록 실패: ${batchError.message}`);
  }

  console.log(`\n  적재 완료 — inserted ${inserted} / skipped(중복) ${skipped}`);
  console.log(`  batch id: ${batchId}`);
}
