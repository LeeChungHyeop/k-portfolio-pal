// ─────────────────────────────────────────────────────────────────────────────
// 적재 후 검증 — **읽기 전용**. DB 에 아무것도 쓰지 않는다.
//
//   npm run ledger:verify -- --family=<CODE> --profile=<PROFILE>
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
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS } from "../src/lib/kaw/constants";
import { parseVerifiedDataset } from "../src/lib/kaw/verified-transactions";
import {
  findDuplicateFingerprints, replayFinalHoldings, resolveEvents,
  type LedgerTransaction,
} from "../src/lib/kaw/ledger";

const DATASET_PATH = resolve(process.cwd(), "data/verified-transactions.v1.json");

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

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

// ── 결과 수집 ───────────────────────────────────────────────────────────────

const results: { ok: boolean; label: string; detail: string }[] = [];
function check(label: string, ok: boolean, detail: string): void {
  results.push({ ok, label, detail });
}

interface LedgerRow {
  id: string;
  account_type: string;
  ticker: string;
  etf_name: string;
  side: string;
  quantity: string | number;
  price: string | number;
  amount: string | number;
  trade_date: string | null;
  settlement_date: string | null;
  inferred_trade_date: string | null;
  event_date: string;
  trade_date_evidence: string;
  fee: string | number | null;
  tax: string | number | null;
  post_quantity: string | number | null;
  source: string;
  source_file: string | null;
  source_row: number | null;
  source_fingerprint: string;
  fingerprint_version: number;
  import_batch_id: string | null;
}

/** numeric 컬럼은 PostgREST 가 문자열로 줄 수 있다. 정밀도 손실 없이 숫자로 되돌린다. */
const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

/** DB 행 → 앱의 순수 도메인 모델. 검증은 이 변환 결과로 한다. */
function toTransaction(r: LedgerRow): LedgerTransaction {
  return {
    id: r.id,
    accountId: r.account_type,
    ticker: r.ticker,
    etfName: r.etf_name,
    side: r.side,
    quantity: num(r.quantity) ?? 0,
    price: num(r.price) ?? 0,
    amount: num(r.amount) ?? 0,
    tradeDate: r.trade_date,
    settlementDate: r.settlement_date,
    inferredTradeDate: r.inferred_trade_date,
    eventDate: r.event_date,
    tradeDateEvidence: r.trade_date_evidence,
    fee: num(r.fee),
    tax: num(r.tax),
    postQuantity: num(r.post_quantity),
    source: r.source,
    sourceFile: r.source_file,
    sourceRow: r.source_row,
    sourceFingerprint: r.source_fingerprint,
    fingerprintVersion: r.fingerprint_version,
  } as unknown as LedgerTransaction;
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

  console.log("═══ 적재 후 검증 (읽기 전용) ═════════════════════════════");
  console.log(`  대상  ${family} / ${profile}\n`);

  const dataset = parseVerifiedDataset(JSON.parse(readFileSync(DATASET_PATH, "utf-8")));
  const rows = await fetchAll(client, family, profile);
  const txs = rows.map(toTransaction);

  // ── 건수 ──────────────────────────────────────────────────────────────
  check("transaction 총 건수", rows.length === 463, `${rows.length} / 기대 463`);

  for (const id of ACCOUNT_IDS) {
    const expected = dataset.validation.accountTransactionCounts[id];
    const actual = rows.filter((r) => r.account_type === id).length;
    check(`거래 건수 (${id})`, actual === expected, `${actual} / 기대 ${expected}`);
  }

  // ── 기본 grouping 이벤트 수 (계좌 + event_date) ───────────────────────
  const events = resolveEvents({ transactions: txs });
  check("기본 event 수", events.length === 65, `${events.length} / 기대 65`);

  // ── fingerprint ───────────────────────────────────────────────────────
  const dup = findDuplicateFingerprints(txs);
  check("duplicate fingerprint", dup.length === 0, `${dup.length}건`);

  const fpUnique = new Set(rows.map((r) => r.source_fingerprint)).size;
  check("fingerprint 유일", fpUnique === rows.length, `${fpUnique} / ${rows.length}`);

  const versions = [...new Set(rows.map((r) => r.fingerprint_version))].sort();
  check("fingerprint_version 단일(=1)",
    versions.length === 1 && versions[0] === 1, `[${versions.join(", ")}]`);

  const badPrefix = rows.filter((r) => !r.source_fingerprint.startsWith(`v${r.fingerprint_version}|`));
  check("fingerprint prefix 와 version 정합", badPrefix.length === 0, `${badPrefix.length}건 불일치`);

  // ── 재생 (일중 순서 의존) ─────────────────────────────────────────────
  const lines = events.flatMap((e) => e.lines);
  const negatives = lines.filter((l) => l.afterQuantity < 0);
  check("negative holding", negatives.length === 0, `${negatives.length}건`);

  const comparable = lines.filter((l) => l.postQuantityMismatch !== null);
  const mismatch = comparable.filter((l) => l.postQuantityMismatch === true);
  check("postQuantity mismatch", mismatch.length === 0,
    `${mismatch.length}건 (대조 가능 ${comparable.length}건)`);

  const replayed = replayFinalHoldings(txs);
  let holdingsOk = true;
  const diffs: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const expected = dataset.validation.finalHoldings[id] ?? {};
    const actual = replayed[id] ?? {};
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if ((expected[k] ?? 0) !== (actual[k] ?? 0)) {
        holdingsOk = false;
        diffs.push(`${id}/${k}: DB ${actual[k] ?? 0} vs 기대 ${expected[k] ?? 0}`);
      }
    }
  }
  check("finalHoldings (DB 재생 vs 데이터셋)", holdingsOk,
    holdingsOk ? "전 계좌 일치" : diffs.join(" | "));

  // cashflow checksum 은 원장이 아니라 cashflow 장부(canonical seed)의 값이다.
  // 여기서는 데이터셋 쪽 값만 확인한다 — 원장 적재로 변할 수 있는 값이 아니다.
  const checksum = dataset.validation.cashflowPrincipalChecksums.total;
  check("cashflow checksum (데이터셋)", checksum === 151_855_018,
    checksum.toLocaleString("en-US"));

  // ── **id 별 fingerprint 안정성** ──────────────────────────────
  //
  // parseVerifiedDataset 은 fingerprint 를 **파일에서 읽는 게 아니라 계산한다**
  // (verified-transactions.ts 의 assignFingerprints). 그리고 assignFingerprints 는
  // compareIntraDayOrder 로 내용이 같은 체결들의 **순번(occurrence)** 을 매긴다.
  //
  // 즉 비교자를 고치면 이론상 같은 거래가 다른 순번을 받아 **다른 fingerprint** 를
  // 가질 수 있다. 그러면 재적재 시 upsert arbiter(fingerprint UNIQUE)가 기존 행을 못
  // 찾아 중복을 만들거나 PK 충돌로 죽는다.
  //
  // "fingerprint 집합이 같다"로는 부족하다 — 집합은 같은채 **id 사이에서 서로
  // 바뀜 수** 있기 때문이다. 그래서 **id → source_fingerprint 매핑을 1:1 대조**한다.
  const regenerated = new Map(dataset.transactions.map((t) => [t.id, t.sourceFingerprint]));
  const dbFp = new Map(rows.map((r) => [r.id, r.source_fingerprint]));

  check("fingerprint 비교 대상 건수", dbFp.size === 463, `${dbFp.size} / 기대 463`);

  const missingInDataset = [...dbFp.keys()].filter((id) => !regenerated.has(id));
  check("id 누락 (DB→데이터셋)", missingInDataset.length === 0,
    `${missingInDataset.length}건${missingInDataset.length ? ` 예: ${missingInDataset[0]}` : ""}`);

  const missingInDb = [...regenerated.keys()].filter((id) => !dbFp.has(id));
  check("id 누락 (데이터셋→DB)", missingInDb.length === 0,
    `${missingInDb.length}건${missingInDb.length ? ` 예: ${missingInDb[0]}` : ""}`);

  const noFp = [...dbFp.entries()].filter(([, fp]) => !fp);
  check("fingerprint 누락", noFp.length === 0, `${noFp.length}건`);

  const changed = [...dbFp.entries()].filter(([id, fp]) => regenerated.get(id) !== fp);
  check("id 별 source_fingerprint 변경", changed.length === 0,
    changed.length === 0 ? "0건 (production 매핑과 완전 동일)"
      : changed.slice(0, 3).map(([id, fp]) =>
          `${id}: DB=${fp} vs 재생성=${regenerated.get(id)}`).join(" | ")
        + (changed.length > 3 ? ` … 총 ${changed.length}건` : ""));

  // ── batch / provenance ────────────────────────────────────────────────
  const { data: batchData, error: batchErr } = await client
    .from("kaw_ledger_import_batch")
    .select("*")
    .eq("family_code", family).eq("profile", profile)
    .order("created_at", { ascending: true });
  if (batchErr) throw new Error(`batch 조회 실패: ${batchErr.message}`);
  const batches = (batchData ?? []) as {
    id: string; inserted_count: number; skipped_count: number;
    source_checksum: string | null; created_at: string;
  }[];

  console.log("── import batch 이력 ───────────────────────────────────────");
  for (const b of batches) {
    console.log(`  ${b.created_at}  inserted ${String(b.inserted_count).padStart(3)}`
      + ` / skipped ${String(b.skipped_count).padStart(3)}  ${b.id}`);
  }
  console.log("");

  const first = batches[0];
  check("최초 batch inserted/skipped", Boolean(first) && first.inserted_count === 463 && first.skipped_count === 0,
    first ? `inserted ${first.inserted_count} / skipped ${first.skipped_count}` : "batch 행 없음");

  const batchIds = new Set(batches.map((b) => b.id));
  const orphans = rows.filter((r) => r.import_batch_id !== null && !batchIds.has(r.import_batch_id));
  check("orphan import_batch_id", orphans.length === 0, `${orphans.length}건`);

  const nullBatch = rows.filter((r) => r.import_batch_id === null);
  check("import_batch_id 누락", nullBatch.length === 0, `${nullBatch.length}건`);

  const usedBatches = [...new Set(rows.map((r) => r.import_batch_id))];
  check("원장이 가리키는 batch 가 1개", usedBatches.length === 1,
    `[${usedBatches.join(", ")}]`);
  if (first) {
    check("원장의 batch id = 최초 batch id", usedBatches.length === 1 && usedBatches[0] === first.id,
      `${usedBatches[0]} vs ${first.id}`);
  }

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

  // rebalance_event 는 건수만으로는 부족하다 — 메모/태그/숨김이 바뀜 것도 봐야 한다.
  const { data: evRows } = await client.from("kaw_rebalance_event")
    .select("id, memo, tags, hidden, type, strategy_included, is_user_created")
    .eq("family_code", family).eq("profile", profile).order("id");
  if ((evRows ?? []).length > 0) {
    console.log("  ─ kaw_rebalance_event 내용");
    for (const e of evRows ?? []) {
      console.log(`    ${JSON.stringify(e)}`);
    }
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
    console.log(`  ${k.padEnd(32)} ${v}`);
  }
  console.log("");

  // ── 결과 ──────────────────────────────────────────────────────────────
  console.log("── 검증 결과 ───────────────────────────────────────────────");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(36)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  => ${failed.length === 0 ? "전부 통과" : `실패 ${failed.length}건`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
