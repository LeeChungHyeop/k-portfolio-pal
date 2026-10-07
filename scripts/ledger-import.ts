// ─────────────────────────────────────────────────────────────────────────────
// 거래 원장 적재 — dry-run / 실제 적재
//
//   npm run ledger:dry-run        검증만 한다. DB 에 **아무것도 쓰지 않는다.** (기본)
//   npm run ledger:import -- --apply   실제 적재. 승인을 받은 뒤에만 쓴다.
//
// dry-run 은 네트워크 없이도 데이터셋 자체 검증을 끝낸다. `.dev.vars` 에 Supabase
// 접속정보가 있으면 **읽기만 해서** 이미 들어간 건수와 중복 여부까지 같이 보여준다.
//
// ── 안전장치 ────────────────────────────────────────────────────────────────
//
//   - 기본이 dry-run 이다. 쓰려면 `--apply` 를 **명시**해야 한다.
//   - 적재 전 게이트(verifyDataset)가 하나라도 실패하면 `--apply` 여도 멈춘다.
//   - 적재는 fingerprint UNIQUE 제약에 기대는 **중복이면 건너뛰기**다. 같은 데이터셋을
//     두 번 넣어도 2회차는 inserted 0 / skipped 463 으로 끝나고 행이 늘지 않는다.
//   - 기존 행을 UPDATE 하지 않는다 — 원장은 immutable 이다. 정정은 overlay 로 한다.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS } from "../src/lib/kaw/constants";
import {
  parseVerifiedDataset, verifyDataset, formatChecks,
  type VerifiedDataset,
} from "../src/lib/kaw/verified-transactions";
import {
  FINGERPRINT_VERSION, findDuplicateFingerprints, replayFinalHoldings, resolveEvents,
} from "../src/lib/kaw/ledger";

const DATASET_PATH = resolve(process.cwd(), "data/verified-transactions.v1.json");
const SOURCE_KIND = "verified_dataset_v1";

interface Args {
  apply: boolean;
  familyCode: string;
  profile: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    // production 식별자를 코드에 박지 않는다 — 인자나 환경변수로 받는다.
    familyCode: get("family") ?? process.env.KAW_FAMILY_CODE ?? "",
    profile: get("profile") ?? process.env.KAW_PROFILE ?? "",
  };
}

/** 적재 입력의 지문 — 같은 파일을 두 번 넣었는지 batch 이력에서 눈으로 확인하기 위해. */
function checksumOf(text: string): string {
  // 암호학적 용도가 아니다(무결성 확인이 아니라 "같은 파일인가" 표시).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function supabaseFromDevVars(): SupabaseClient | null {
  // .dev.vars 는 gitignore 대상이다. 없으면 오프라인 dry-run 으로 계속한다.
  let url = process.env.SUPABASE_URL ?? "";
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    try {
      const text = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf-8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
        if (!m) continue;
        if (m[1] === "SUPABASE_URL") url ||= m[2];
        if (m[1] === "SUPABASE_SERVICE_ROLE_KEY") key ||= m[2];
      }
    } catch { /* 없으면 오프라인으로 */ }
  }
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── 리포트 ──────────────────────────────────────────────────────────────────

function reportDataset(d: VerifiedDataset): boolean {
  const events = resolveEvents({ transactions: d.transactions });
  const replayed = replayFinalHoldings(d.transactions);
  const dupFp = findDuplicateFingerprints(d.transactions);

  console.log("\n── 데이터셋 ────────────────────────────────────────────────");
  console.log(`  schemaVersion        ${d.schemaVersion}`);
  console.log(`  총 transaction       ${d.transactions.length}`);
  console.log(`  event (기본 grouping) ${events.length}`);

  console.log("\n  계좌별 건수");
  for (const id of ACCOUNT_IDS) {
    const tx = d.transactions.filter((t) => t.accountId === id).length;
    const ev = events.filter((e) => e.accountId === id).length;
    console.log(`    ${id.padEnd(12)} 거래 ${String(tx).padStart(4)}  이벤트 ${String(ev).padStart(3)}`);
  }

  console.log("\n  무결성");
  console.log(`    duplicate fingerprint   ${dupFp.length}`);
  const negatives = events.flatMap((e) => e.lines).filter((l) => l.afterQuantity < 0);
  console.log(`    negative holding        ${negatives.length}`);
  const comparable = events.flatMap((e) => e.lines).filter((l) => l.postQuantityMismatch !== null);
  const mismatch = comparable.filter((l) => l.postQuantityMismatch === true);
  console.log(`    postQuantity mismatch   ${mismatch.length} (대조 가능 ${comparable.length}건)`);

  let holdingsOk = true;
  for (const id of ACCOUNT_IDS) {
    const expected = d.validation.finalHoldings[id] ?? {};
    const actual = replayed[id] ?? {};
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) if ((expected[k] ?? 0) !== (actual[k] ?? 0)) holdingsOk = false;
  }
  console.log(`    finalHoldings           ${holdingsOk ? "완전 일치" : "불일치 — 적재 금지"}`);
  const total = d.validation.cashflowPrincipalChecksums.total;
  console.log(`    cashflow checksum       ${total.toLocaleString("en-US")}`
    + `${total === 151_855_018 ? " (일치)" : " (기대 151,855,018 과 다름)"}`);

  console.log("\n── 적재 전 게이트 ──────────────────────────────────────────");
  const checks = verifyDataset(d);
  console.log(formatChecks(checks));

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0 && holdingsOk && total === 151_855_018;
  console.log(`\n  => ${ok ? "통과" : `실패 ${failed.length}건 — 적재하지 않는다`}`);
  return ok;
}

/** 멱등성 검증 — 같은 입력을 두 번 처리해도 신원이 같은가 (DB 없이 확인). */
function reportIdempotency(rawText: string): boolean {
  const a = parseVerifiedDataset(JSON.parse(rawText));
  const b = parseVerifiedDataset(JSON.parse(rawText));
  const fpA = a.transactions.map((t) => t.sourceFingerprint);
  const fpB = new Map(b.transactions.map((t) => [t.id, t.sourceFingerprint]));
  const same = a.transactions.every((t, i) => fpB.get(t.id) === fpA[i]);
  const uniq = new Set(fpA).size;

  console.log("\n── import idempotency ──────────────────────────────────────");
  console.log(`  fingerprint 규칙 버전   v${FINGERPRINT_VERSION}`);
  console.log(`  fingerprint 유일 개수   ${uniq} / ${a.transactions.length}`);
  console.log(`  2회 파싱 결과 동일      ${same ? "예" : "아니오"}`);
  console.log(`  => 같은 데이터셋을 다시 import 하면 ${uniq}건 전부 skipped 로 끝난다`);
  console.log("     (DB 의 kaw_transaction_ledger_fingerprint_uq UNIQUE 제약이 최종 방어선)");
  return same && uniq === a.transactions.length;
}

async function reportExisting(
  client: SupabaseClient, familyCode: string, profile: string,
): Promise<number> {
  const { count, error } = await client
    .from("kaw_transaction_ledger")
    .select("id", { count: "exact", head: true })
    .eq("family_code", familyCode)
    .eq("profile", profile);
  if (error) {
    console.log(`\n  (DB 조회 실패: ${error.message})`);
    console.log("   migration 004 가 아직 적용되지 않았다면 정상이다.");
    return -1;
  }
  console.log(`\n  DB 기존 행      ${count ?? 0}건 (${familyCode}/${profile})`);
  return count ?? 0;
}

// ── 실제 적재 ───────────────────────────────────────────────────────────────

async function applyImport(
  client: SupabaseClient, d: VerifiedDataset, args: Args, checksum: string,
): Promise<void> {
  const batchId = `imp:${SOURCE_KIND}:${new Date().toISOString()}`;
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

  // 중복이면 건너뛴다 — 기존 행을 덮어쓰지 않는다(원장은 immutable).
  const { data, error } = await client
    .from("kaw_transaction_ledger")
    .upsert(rows, {
      onConflict: "family_code,profile,source_fingerprint",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(`적재 실패: ${error.message}`);

  const inserted = data?.length ?? 0;
  const skipped = rows.length - inserted;

  const { error: batchError } = await client.from("kaw_ledger_import_batch").insert({
    id: batchId,
    family_code: args.familyCode,
    profile: args.profile,
    source_kind: SOURCE_KIND,
    source_label: "data/verified-transactions.v1.json",
    source_checksum: checksum,
    inserted_count: inserted,
    skipped_count: skipped,
    verification: verifyDataset(d),
    actor: args.profile,
  });
  if (batchError) console.error(`  (batch 이력 기록 실패: ${batchError.message})`);

  console.log(`\n  적재 완료 — inserted ${inserted} / skipped(중복) ${skipped}`);
  console.log(`  batch id: ${batchId}`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawText = readFileSync(DATASET_PATH, "utf-8");
  const checksum = checksumOf(rawText);
  const dataset = parseVerifiedDataset(JSON.parse(rawText));

  console.log("═══ 거래 원장 적재 ═══════════════════════════════════════");
  console.log(`  모드      ${args.apply ? "APPLY (DB 에 씁니다)" : "DRY-RUN (아무것도 쓰지 않습니다)"}`);
  console.log(`  데이터셋  ${DATASET_PATH}`);
  console.log(`  checksum  ${checksum}`);

  const datasetOk = reportDataset(dataset);
  const idempotentOk = reportIdempotency(rawText);

  const client = supabaseFromDevVars();
  if (client && args.familyCode && args.profile) {
    await reportExisting(client, args.familyCode, args.profile);
  } else {
    console.log("\n  (DB 조회 생략 — .dev.vars 접속정보 또는 --family/--profile 이 없습니다)");
  }

  if (!args.apply) {
    console.log("\n═══ DRY-RUN 종료 — DB 에 아무것도 쓰지 않았습니다 ════════");
    console.log("  실제 적재: migration 004 적용 후");
    console.log("    npm run ledger:import -- --apply --family=<CODE> --profile=<PROFILE>");
    process.exit(datasetOk && idempotentOk ? 0 : 1);
  }

  // ── 여기부터는 실제 쓰기 ──
  if (!datasetOk || !idempotentOk) {
    console.error("\n게이트 실패 — 적재하지 않습니다.");
    process.exit(1);
  }
  if (!client) {
    console.error("\nSupabase 접속정보가 없습니다 (.dev.vars 의 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    process.exit(1);
  }
  if (!args.familyCode || !args.profile) {
    console.error("\n--family=<CODE> --profile=<PROFILE> 가 필요합니다.");
    process.exit(1);
  }
  await applyImport(client, dataset, args, checksum);
  console.log("\n═══ 적재 완료 ════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
