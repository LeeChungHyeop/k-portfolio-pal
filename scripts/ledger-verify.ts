// ─────────────────────────────────────────────────────────────────────────────
// 적재 후 검증 — **읽기 전용**. DB 에 아무것도 쓰지 않는다.
//
//   npm run ledger:verify -- --family=<CODE> --profile=<PROFILE>
//   npm run ledger:verify -- --dataset=data/verified-transactions.v2.json --family=… --profile=…
//
// migration 004 하단 주석의 검증 쿼리 (c)~(h) 를 스크립트로 옮긴 것이고, SQL 로는
// 하기 어려운 두 가지를 더 한다:
//
//   · **일중 순서에 의존하는 검사** — 음수 보유수량 / 증권사 보고 거래후수량 대조는
//     INTRA_DAY_ROW_ORDER 를 따라 재생해야 한다. SQL 의 group by 로는 안 된다.
//     그래서 DB 행을 읽어 **앱과 같은 순수 함수**(ledger.ts)에 그대로 먹인다.
//   · **데이터셋과의 대조** — finalHoldings / 계좌별 건수를 파일의 validation 과 맞춘다.
//
// 즉 검증 대상은 파일이 아니라 **DB 에 실제로 들어간 행**이다. dry-run 이 파일을
// 검증한다면 이쪽은 적재 결과를 검증한다.
//
// 이 파일은 **읽어 오기만** 한다. 판정은 전부 `src/lib/kaw/ledger-verify-core.ts` 의
// 순수 함수에 있고, 거기에는 기대값 상수가 없다 — 전부 선택된 데이터셋에서
// 파생된다(ledger-verify-core.test.ts 가 v1/v2 양쪽과 실패 경로를 고정한다).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseVerifiedDataset } from "../src/lib/kaw/verified-transactions";
import { verifiedPrincipalTotal } from "../src/lib/kaw/verified-cashflows";
import {
  datasetMetaOf, formatVerifyChecks, verifyLedgerAgainstDataset,
  type BatchRow, type LedgerRow,
} from "../src/lib/kaw/ledger-verify-core";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

// 기본 v1 — `--dataset=data/verified-transactions.v2.json` 으로 세대를 바꾼다.
// **파일명 문자열로 기대값을 정하지 않는다.** 경로는 어느 파일을 읽을지만 고른다.
const DATASET_REL = arg("dataset") || "data/verified-transactions.v1.json";
const DATASET_PATH = resolve(process.cwd(), DATASET_REL);

function supabase(): SupabaseClient | null {
  let url = process.env.SUPABASE_URL ?? "";
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    try {
      for (const line of readFileSync(resolve(process.cwd(), ".dev.vars"), "utf-8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
        if (!m) continue;
        if (m[1] === "SUPABASE_URL") url ||= m[2];
        if (m[1] === "SUPABASE_SERVICE_ROLE_KEY") key ||= m[2];
      }
    } catch { /* 없으면 아래에서 멈춘다 */ }
  }
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** PostgREST 기본 상한(1000행)에 걸리지 않도록 페이지로 끊어 전부 읽는다. */
async function fetchAll(
  client: SupabaseClient, family: string, profile: string,
): Promise<LedgerRow[]> {
  const out: LedgerRow[] = [];
  const page = 500;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from("kaw_transaction_ledger")
      .select("*")
      .eq("family_code", family).eq("profile", profile)
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`원장 조회 실패: ${error.message}`);
    const rows = (data ?? []) as LedgerRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

async function main(): Promise<void> {
  const family = arg("family");
  const profile = arg("profile");
  if (!family || !profile) {
    console.error("--family=<CODE> --profile=<PROFILE> 가 필요합니다.");
    process.exitCode = 1;
    return;
  }
  const client = supabase();
  if (!client) {
    console.error("Supabase 접속정보가 없습니다 (.dev.vars).");
    process.exitCode = 1;
    return;
  }

  const raw: unknown = JSON.parse(readFileSync(DATASET_PATH, "utf-8"));
  const dataset = parseVerifiedDataset(raw);
  const meta = datasetMetaOf(DATASET_REL, raw, dataset);

  console.log("═══ 적재 후 검증 (읽기 전용) ═════════════════════════════");
  console.log(`  대상            ${family} / ${profile}`);
  console.log(`  dataset         ${meta.path}`);
  console.log(`  schemaVersion   ${meta.schemaVersion}  (파일 구조)`);
  console.log(`  datasetVersion  ${meta.datasetVersion ?? "—(필드 없음 = 1세대)"}  (내용 세대)`);
  console.log(`  basedOn         ${meta.basedOn ?? "—"}`);
  console.log(`  transactions    ${meta.transactionCount}건  ← 기대값의 출처\n`);

  const rows = await fetchAll(client, family, profile);

  // ── batch ─────────────────────────────────────────────────────────────
  //
  // 두 번 조회한다. 목적이 다르다:
  //   · allBatches  — 대상 계정의 이력 **출력용**. 아무 행도 가리키지 않는 멱등성
  //                   확인용 batch 가 섞여 있는 것이 정상이다.
  //   · referenced  — 원장이 **실제로 가리키는** id 만 조회한다. family/profile 로
  //                   거르지 **않아야** "남의 계정 batch 를 가리킨다"가 드러난다.
  const { data: allData, error: batchErr } = await client
    .from("kaw_ledger_import_batch")
    .select("*")
    .eq("family_code", family).eq("profile", profile)
    .order("created_at", { ascending: true });
  if (batchErr) throw new Error(`batch 조회 실패: ${batchErr.message}`);
  const allBatches = (allData ?? []) as BatchRow[];

  const usedIds = [...new Set(
    rows.map((r) => r.import_batch_id).filter((x): x is string => x !== null),
  )];
  let referencedBatches: BatchRow[] = [];
  if (usedIds.length > 0) {
    const { data: refData, error: refErr } = await client
      .from("kaw_ledger_import_batch").select("*").in("id", usedIds);
    if (refErr) throw new Error(`참조 batch 조회 실패: ${refErr.message}`);
    referencedBatches = (refData ?? []) as BatchRow[];
  }

  console.log("── import batch 이력 ───────────────────────────────────────");
  for (const b of allBatches) {
    console.log(`  ${b.created_at}  inserted ${String(b.inserted_count).padStart(3)}`
      + ` / skipped ${String(b.skipped_count).padStart(3)}`
      + `  ${usedIds.includes(b.id) ? "[사용]  " : "[미사용]"}  ${b.id}`);
  }
  console.log(`  → 이력 ${allBatches.length}개 / 원장이 가리키는 batch ${usedIds.length}개`);
  console.log("    (멱등성 확인용 inserted 0 batch 는 아무 행도 가리키지 않는다 — 정상)\n");

  const checks = verifyLedgerAgainstDataset({
    dataset,
    meta,
    rows,
    referencedBatches,
    allBatches,
    target: { family, profile },
    cashflowPrincipalTotal: verifiedPrincipalTotal(),
  });

  // ── overlay 상태 ────────────────────────────────────────────
  //
  // UI 쓰기 테스트 전후를 대조하기 위해 찍는다. 원장과 달리 overlay 는 사용자가
  // 만드는 것이므로 "기대값"이 고정되지 않는다 — 검사항목이 아니라 보고만 한다.
  const overlayCounts: [string, number][] = [];
  for (const table of [
    "kaw_transaction_correction", "kaw_transaction_event_override",
    "kaw_rebalance_event", "kaw_ledger_audit",
  ]) {
    const { count, error: e } = await client.from(table)
      .select("*", { count: "exact", head: true })
      .eq("family_code", family).eq("profile", profile);
    if (e) throw new Error(`${table} 조회 실패: ${e.message}`);
    overlayCounts.push([table, count ?? 0]);
  }
  console.log("── overlay 상태 (검사항목 아님 — 쓰기 테스트 전후 대조용) ──────────");
  for (const [t, n] of overlayCounts) console.log(`  ${t.padEnd(32)} ${n}`);

  // rebalance_event 는 건수만으로는 부족하다 — 메모/태그/숨김이 바뀐 것도 봐야 한다.
  const { data: evRows } = await client.from("kaw_rebalance_event")
    .select("id, memo, tags, hidden, type, strategy_included, is_user_created")
    .eq("family_code", family).eq("profile", profile).order("id");
  if ((evRows ?? []).length > 0) {
    console.log("  ─ kaw_rebalance_event 내용");
    for (const e of evRows ?? []) console.log(`    ${JSON.stringify(e)}`);
  }
  const { data: corrRows } = await client.from("kaw_transaction_correction")
    .select("transaction_id, excluded, reason")
    .eq("family_code", family).eq("profile", profile).order("transaction_id");
  for (const r of corrRows ?? []) console.log(`    correction ${JSON.stringify(r)}`);
  const { data: ovrRows } = await client.from("kaw_transaction_event_override")
    .select("transaction_id, event_id")
    .eq("family_code", family).eq("profile", profile).order("transaction_id");
  for (const r of ovrRows ?? []) console.log(`    override ${JSON.stringify(r)}`);
  console.log("");

  // ── 날짜 근거 분포 (참고 출력) ────────────────────────────────────────
  const evidence = new Map<string, number>();
  for (const r of rows) evidence.set(r.trade_date_evidence, (evidence.get(r.trade_date_evidence) ?? 0) + 1);
  console.log("── 거래일 근거 분포 ────────────────────────────────────────");
  for (const [k, v] of [...evidence].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(44)} ${v}`);
  }
  console.log("");

  // ── 결과 ──────────────────────────────────────────────────────────────
  console.log("── 검증 결과 ───────────────────────────────────────────────");
  console.log(formatVerifyChecks(checks));
  const failed = checks.filter((r) => !r.ok);
  console.log(`\n  => ${failed.length === 0 ? `전부 통과 (${checks.length}건)` : `실패 ${failed.length}건`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
