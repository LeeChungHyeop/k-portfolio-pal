// ─────────────────────────────────────────────────────────────────────────────
// 적재 후 검증의 **순수 함수부**. DB 도 파일시스템도 보지 않는다.
//
// `scripts/ledger-verify.ts` 는 DB 에서 행을 읽어 오기만 하고, 판정은 전부 여기서
// 한다. 그래야 "존재하지 않는 batch 를 참조하면 실패하는가" 같은 **실패 경로**를
// 테스트가 실제로 돌려볼 수 있다 — production 을 망가뜨려 볼 수는 없으므로.
//
// ## 기대값을 코드에 박지 않는다 (이 모듈이 생긴 이유)
//
// 이전 검증기는 v1 463건 / 이벤트 65개 / "원장이 가리키는 batch 는 1개" 를 상수로
// 박아두고 있었다. v1 한 번만 적재한다는 전제였고, **증분 적재를 하는 순간 전부
// 거짓이 된다** — v2 를 넣자 데이터는 멀쩡한데 검증기가 5건 실패했다.
//
// 그래서 모든 기대값은 **선택된 데이터셋에서 파생**한다:
//
//   · 총 건수      = dataset.transactions.length
//   · 이벤트 수    = resolveEvents(dataset.transactions).length  ← DB 와 **같은 규칙**
//   · fingerprint  = dataset 의 id→fingerprint 매핑
//
// 파일명 문자열("v2" 라는 글자)로 기대값을 정하지 않는다. 파일 내용이 기준이다.
//
// ## batch 는 여러 개가 정상이다
//
// 증분 적재는 batch 를 하나 더 만든다. 그러니 "batch 1개"는 불변식이 아니다.
// 진짜 불변식은 이것들이다:
//
//   · 모든 원장 행이 batch 를 가리킨다 (import_batch_id not null)
//   · 가리키는 batch 가 **실제로 존재**하고 (orphan 0)
//   · 그 batch 가 **같은 family/profile 소유**이며
//   · 사용된 batch 들의 inserted_count 합 = 원장 행 수
//     (행은 삭제되지 않고 batch 당 inserted 는 그 batch 가 실제로 넣은 수다)
//
// 마지막 항목이 "같은 거래가 여러 batch 로 중복 적재되지 않았다"를 숫자로 잡는다.
// 중복이 생기면 행 수가 inserted 합을 넘는다. id/fingerprint 유일성 검사와 합쳐
// 세 방향에서 막는다.
//
// **batch 테이블의 전체 행 수와 원장이 쓰는 batch 수는 다를 수 있다** — 멱등성
// 확인용으로 돌린 inserted 0 batch 는 아무 행도 가리키지 않는다. 정상이다.
// ─────────────────────────────────────────────────────────────────────────────
import { ACCOUNT_IDS } from "./constants";
import {
  findDuplicateFingerprints, replayFinalHoldings, resolveEvents,
  type LedgerTransaction,
} from "./ledger";
import type { VerifiedDataset } from "./verified-transactions";

export interface VerifyCheck {
  ok: boolean;
  label: string;
  detail: string;
}

/** `kaw_transaction_ledger` 한 행 (PostgREST 가 주는 모양 그대로). */
export interface LedgerRow {
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

/** `kaw_ledger_import_batch` 한 행. */
export interface BatchRow {
  id: string;
  family_code: string;
  profile: string;
  source_kind: string | null;
  source_label: string | null;
  inserted_count: number;
  skipped_count: number;
  created_at: string;
}

export interface ImportTargetRef {
  family: string;
  profile: string;
}

/** 데이터셋 파일의 **식별 정보**. 파서가 버리는 필드라 raw JSON 에서 따로 읽는다. */
export interface DatasetMeta {
  path: string;
  /** 파일 **구조** 버전. 파서가 보는 값. */
  schemaVersion: number;
  /** **내용 세대**. v1 에는 없다(undefined = 1세대). */
  datasetVersion: number | null;
  /** 어느 세대를 기반으로 만들었는가. v1 에는 없다. */
  basedOn: string | null;
  transactionCount: number;
}

/** raw JSON 에서 식별 정보만 뽑는다. 없는 필드는 null 이다 — 추정하지 않는다. */
export function datasetMetaOf(path: string, raw: unknown, dataset: VerifiedDataset): DatasetMeta {
  const d = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    path,
    schemaVersion: dataset.schemaVersion,
    datasetVersion: n(d.datasetVersion),
    basedOn: typeof d.basedOn === "string" ? d.basedOn : null,
    transactionCount: dataset.transactions.length,
  };
}

/** numeric 컬럼은 PostgREST 가 문자열로 줄 수 있다. 정밀도 손실 없이 숫자로 되돌린다. */
const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

/** DB 행 → 앱의 순수 도메인 모델. 검증은 이 변환 결과로 한다. */
export function toTransaction(r: LedgerRow): LedgerTransaction {
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

export interface LedgerVerifyInput {
  dataset: VerifiedDataset;
  meta: DatasetMeta;
  /** 대상 family/profile 의 원장 행 **전부**. */
  rows: readonly LedgerRow[];
  /**
   * 원장이 **가리키는** batch 들. family/profile 로 거르지 않고 id 로 조회해야
   * "남의 계정 batch 를 가리킨다"를 잡을 수 있다.
   */
  referencedBatches: readonly BatchRow[];
  /** 대상 계정의 batch 이력 전체 (보고용. 사용되지 않는 batch 가 섞여 있어도 정상). */
  allBatches: readonly BatchRow[];
  target: ImportTargetRef;
  /**
   * cashflow 원금 합계의 독립 출처(`verifiedPrincipalTotal()`). 데이터셋이 주장하는
   * checksum 과 대조한다 — 상수를 코드에 박지 않기 위해 호출자가 넘긴다.
   */
  cashflowPrincipalTotal: number;
}

/**
 * DB 에 실제로 들어간 행을 선택된 데이터셋과 대조한다.
 * **기대값은 전부 입력에서 파생된다** — 이 함수에 숫자 상수는 없다.
 */
export function verifyLedgerAgainstDataset(input: LedgerVerifyInput): VerifyCheck[] {
  const { dataset, rows, referencedBatches, target, cashflowPrincipalTotal } = input;
  const out: VerifyCheck[] = [];
  const check = (label: string, ok: boolean, detail: string) => out.push({ ok, label, detail });

  const txs = rows.map(toTransaction);

  // ── 건수 ──────────────────────────────────────────────────────────────
  const expectedTx = dataset.transactions.length;
  check("transaction 총 건수", rows.length === expectedTx, `${rows.length} / 기대 ${expectedTx}`);

  for (const id of ACCOUNT_IDS) {
    const expected = dataset.validation.accountTransactionCounts[id];
    const actual = rows.filter((r) => r.account_type === id).length;
    check(`거래 건수 (${id})`, actual === expected, `${actual} / 기대 ${expected}`);
  }

  const idUnique = new Set(rows.map((r) => r.id)).size;
  check("거래 id 유일", idUnique === rows.length, `${idUnique} / ${rows.length}`);

  // ── 이벤트 수 ─────────────────────────────────────────────────────────
  //    DB 와 데이터셋에 **같은 grouping 규칙**(resolveEvents)을 적용해 비교한다.
  //    데이터셋의 events 배열을 세지 않는 이유: DB 쪽은 override 가 섞일 수 있어
  //    둘 다 같은 함수를 통과시켜야 같은 기준이 된다.
  const events = resolveEvents({ transactions: txs });
  const expectedEvents = resolveEvents({ transactions: dataset.transactions }).length;
  check("기본 event 수", events.length === expectedEvents,
    `${events.length} / 기대 ${expectedEvents}`);

  // ── fingerprint ───────────────────────────────────────────────────────
  const dup = findDuplicateFingerprints(txs);
  check("duplicate fingerprint", dup.length === 0,
    dup.length ? dup.slice(0, 3).map((d) => `${d.fingerprint} ×${d.ids.length}`).join(" | ") : "0건");

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
  const diffs: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const expected = dataset.validation.finalHoldings[id] ?? {};
    const actual = replayed[id] ?? {};
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if ((expected[k] ?? 0) !== (actual[k] ?? 0)) {
        diffs.push(`${id}/${k}: DB ${actual[k] ?? 0} vs 기대 ${expected[k] ?? 0}`);
      }
    }
  }
  check("finalHoldings (DB 재생 vs 데이터셋)", diffs.length === 0,
    diffs.length === 0 ? "전 계좌 일치" : diffs.join(" | "));

  // cashflow checksum 은 원장이 아니라 cashflow 장부(canonical seed)의 값이다.
  // 상수로 박지 않고 **독립 출처**(verified-cashflows.ts)와 대조한다 — 둘 중 하나만
  // 고치면 드러나야 하기 때문이다. 원장 적재로 변할 수 있는 값은 아니다.
  const checksum = dataset.validation.cashflowPrincipalChecksums.total;
  check("cashflow checksum (데이터셋 vs verified-cashflows)",
    checksum === cashflowPrincipalTotal,
    `${checksum?.toLocaleString("en-US")} / 장부 ${cashflowPrincipalTotal.toLocaleString("en-US")}`);

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
  // "fingerprint 집합이 같다"로는 부족하다 — 집합은 같은 채 **id 사이에서 서로
  // 바뀔 수** 있기 때문이다. 그래서 **id → source_fingerprint 매핑을 1:1 대조**한다.
  const regenerated = new Map(dataset.transactions.map((t) => [t.id, t.sourceFingerprint]));
  const dbFp = new Map(rows.map((r) => [r.id, r.source_fingerprint]));

  check("fingerprint 비교 대상 건수", dbFp.size === expectedTx,
    `${dbFp.size} / 데이터셋 ${expectedTx}`);

  const dbFpSet = new Set(rows.map((r) => r.source_fingerprint));
  const fpMissingInDb = dataset.transactions.filter((t) => !dbFpSet.has(t.sourceFingerprint!));
  check("데이터셋 fingerprint 전부 DB 에 존재", fpMissingInDb.length === 0,
    `${fpMissingInDb.length}건 누락${fpMissingInDb.length ? ` 예: ${fpMissingInDb[0].id}` : ""}`);

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
  //
  // **"batch 가 1개"는 검사하지 않는다** — 증분 적재마다 하나씩 늘어나는 것이 정상이다.
  const nullBatch = rows.filter((r) => r.import_batch_id === null);
  check("import_batch_id 누락", nullBatch.length === 0, `${nullBatch.length}건`);

  const usedIds = [...new Set(rows.map((r) => r.import_batch_id).filter((x): x is string => x !== null))];
  const byId = new Map(referencedBatches.map((b) => [b.id, b]));
  const orphans = usedIds.filter((id) => !byId.has(id));
  check("orphan import_batch reference", orphans.length === 0,
    orphans.length ? orphans.slice(0, 3).join(", ") : `0건 (사용 batch ${usedIds.length}개)`);

  const foreign = usedIds
    .map((id) => byId.get(id))
    .filter((b): b is BatchRow => Boolean(b))
    .filter((b) => b.family_code !== target.family || b.profile !== target.profile);
  check("batch 의 family/profile 일치", foreign.length === 0,
    foreign.length ? foreign.map((b) => `${b.id} → ${b.family_code}/${b.profile}`).join(" | ")
      : `${usedIds.length}개 전부 ${target.family}/${target.profile}`);

  // 같은 거래가 두 batch 로 중복 적재되면 행 수가 inserted 합을 넘는다.
  // (원장은 immutable 이라 행이 지워지지 않으므로 두 수는 정확히 같아야 한다.)
  const insertedSum = usedIds
    .map((id) => byId.get(id))
    .filter((b): b is BatchRow => Boolean(b))
    .reduce((s, b) => s + b.inserted_count, 0);
  check("Σ inserted_count(사용 batch) = 원장 행 수", insertedSum === rows.length,
    `${insertedSum} / ${rows.length}`);

  return out;
}

/** 사람이 읽을 줄로. */
export function formatVerifyChecks(checks: readonly VerifyCheck[]): string {
  return checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.label.padEnd(40)} ${c.detail}`).join("\n");
}
