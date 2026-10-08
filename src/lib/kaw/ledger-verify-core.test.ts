// 적재 후 검증기의 회귀 테스트.
//
// 핵심은 **기대값이 데이터셋에서 파생되는가**다. 예전 검증기는 463/65/"batch 1개"를
// 상수로 박아 두었고, 증분 적재(v2)를 하자 데이터는 멀쩡한데 5건이 실패했다.
// 그래서 여기서는 같은 함수에 v1 과 v2 를 모두 먹여 **코드 수정 없이** 각각
// 463/65 와 469/66 을 기대하는지 고정하고, 실패해야 할 경로들을 실제로 돌려본다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVerifiedDataset, type VerifiedDataset } from "./verified-transactions";
import { verifiedPrincipalTotal } from "./verified-cashflows";
import { resolveEvents } from "./ledger";
import {
  datasetMetaOf, verifyLedgerAgainstDataset,
  type BatchRow, type LedgerRow, type VerifyCheck,
} from "./ledger-verify-core";

function load(file: string): { raw: unknown; dataset: VerifiedDataset } {
  const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), `data/${file}`), "utf-8"));
  return { raw, dataset: parseVerifiedDataset(raw) };
}

const V1 = load("verified-transactions.v1.json");
const V2 = load("verified-transactions.v2.json");

const FAMILY = "fam";
const PROFILE = "prof";

/** 데이터셋을 **그대로 적재한** 상태의 DB 행을 만든다 (정상 상태의 기준선). */
function rowsFrom(dataset: VerifiedDataset, batchOf: (i: number) => string): LedgerRow[] {
  return dataset.transactions.map((t, i) => ({
    id: t.id,
    account_type: t.accountId,
    ticker: t.ticker,
    etf_name: t.etfName,
    side: t.side,
    // PostgREST 가 numeric 을 문자열로 주는 경우를 섞어 둔다 — 변환도 같이 고정한다.
    quantity: i % 2 === 0 ? t.quantity : String(t.quantity),
    price: String(t.price),
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
    source_fingerprint: t.sourceFingerprint!,
    fingerprint_version: t.fingerprintVersion ?? 1,
    import_batch_id: batchOf(i),
  }));
}

function batch(id: string, inserted: number, extra: Partial<BatchRow> = {}): BatchRow {
  return {
    id,
    family_code: FAMILY,
    profile: PROFILE,
    source_kind: "verified_dataset",
    source_label: "data/x.json",
    inserted_count: inserted,
    skipped_count: 0,
    created_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

interface Scenario {
  dataset: VerifiedDataset;
  raw: unknown;
  rows: LedgerRow[];
  referencedBatches: BatchRow[];
  allBatches: BatchRow[];
}

function run(s: Scenario): VerifyCheck[] {
  return verifyLedgerAgainstDataset({
    dataset: s.dataset,
    meta: datasetMetaOf("data/x.json", s.raw, s.dataset),
    rows: s.rows,
    referencedBatches: s.referencedBatches,
    allBatches: s.allBatches,
    target: { family: FAMILY, profile: PROFILE },
    cashflowPrincipalTotal: verifiedPrincipalTotal(),
  });
}

const failed = (checks: readonly VerifyCheck[]) => checks.filter((c) => !c.ok).map((c) => c.label);
const find = (checks: readonly VerifyCheck[], label: string) => {
  const hit = checks.find((c) => c.label === label);
  if (!hit) throw new Error(`검사 항목 없음: ${label}`);
  return hit;
};

/** v1 을 한 batch 로 전부 적재한 정상 상태. */
function v1Scenario(): Scenario {
  const b = batch("imp:v1", V1.dataset.transactions.length);
  return {
    ...V1,
    rows: rowsFrom(V1.dataset, () => b.id),
    referencedBatches: [b],
    allBatches: [b],
  };
}

/**
 * v2 를 **증분 2 batch** 로 적재한 정상 상태 — v1 463건은 최초 batch 가, 뒤의 6건은
 * 증분 batch 가 넣었다. production 과 같은 모양이다. 멱등성 확인용 inserted 0 batch
 * 도 이력에 섞어 둔다(아무 행도 가리키지 않는다).
 */
function v2Scenario(): Scenario {
  const v1Ids = new Set(V1.dataset.transactions.map((t) => t.id));
  const first = batch("imp:v1", V1.dataset.transactions.length);
  const incr = batch("imp:v2", V2.dataset.transactions.length - V1.dataset.transactions.length, {
    created_at: "2026-10-08T00:00:00.000Z",
  });
  const idem = batch("imp:v1-rerun", 0, {
    skipped_count: V1.dataset.transactions.length,
    created_at: "2026-10-07T00:00:00.000Z",
  });
  const rows = rowsFrom(V2.dataset, () => "")
    .map((r) => ({ ...r, import_batch_id: v1Ids.has(r.id) ? first.id : incr.id }));
  return {
    ...V2,
    rows,
    referencedBatches: [first, incr],
    allBatches: [first, idem, incr],
  };
}

describe("기대값은 선택된 데이터셋에서 파생된다 (하드코딩 제거 회귀)", () => {
  it("v1: 거래 463 / 이벤트 65 를 기대하고 전부 통과한다", () => {
    const s = v1Scenario();
    expect(s.dataset.transactions.length).toBe(463);
    expect(resolveEvents({ transactions: s.dataset.transactions }).length).toBe(65);

    const checks = run(s);
    expect(find(checks, "transaction 총 건수").detail).toBe("463 / 기대 463");
    expect(find(checks, "기본 event 수").detail).toBe("65 / 기대 65");
    expect(find(checks, "fingerprint 비교 대상 건수").detail).toBe("463 / 데이터셋 463");
    expect(failed(checks)).toEqual([]);
  });

  it("v2: 같은 코드로 거래 469 / 이벤트 66 을 기대하고 전부 통과한다", () => {
    const s = v2Scenario();
    expect(s.dataset.transactions.length).toBe(469);
    expect(resolveEvents({ transactions: s.dataset.transactions }).length).toBe(66);

    const checks = run(s);
    expect(find(checks, "transaction 총 건수").detail).toBe("469 / 기대 469");
    expect(find(checks, "기본 event 수").detail).toBe("66 / 기대 66");
    expect(find(checks, "fingerprint 비교 대상 건수").detail).toBe("469 / 데이터셋 469");
    expect(failed(checks)).toEqual([]);
  });

  it("v1 DB 에 v2 데이터셋을 들이대면 건수·fingerprint 누락으로 실패한다", () => {
    // 기대값이 정말 데이터셋에서 나오는지의 반대 방향 확인 — 어느 쪽이든 상수였다면
    // 둘 중 한 조합이 조용히 통과한다.
    const checks = run({ ...v1Scenario(), dataset: V2.dataset, raw: V2.raw });
    expect(failed(checks)).toContain("transaction 총 건수");
    expect(failed(checks)).toContain("데이터셋 fingerprint 전부 DB 에 존재");
    expect(failed(checks)).toContain("id 누락 (데이터셋→DB)");
  });

  it("datasetMeta 는 파일명이 아니라 파일 내용에서 나온다", () => {
    const m1 = datasetMetaOf("data/x.json", V1.raw, V1.dataset);
    expect(m1).toMatchObject({ schemaVersion: 1, datasetVersion: null, basedOn: null, transactionCount: 463 });
    const m2 = datasetMetaOf("data/x.json", V2.raw, V2.dataset);
    expect(m2).toMatchObject({
      schemaVersion: 1,
      datasetVersion: 2,
      basedOn: "verified-transactions.v1.json",
      transactionCount: 469,
    });
  });
});

describe("batch 검증 — 증분 적재 구조", () => {
  it("원장이 2개 이상의 batch 를 가리켜도 통과한다", () => {
    const s = v2Scenario();
    const used = new Set(s.rows.map((r) => r.import_batch_id));
    expect(used.size).toBe(2);
    expect(failed(run(s))).toEqual([]);
  });

  it("아무 행도 가리키지 않는 inserted 0 batch 가 이력에 있어도 통과한다", () => {
    const s = v2Scenario();
    expect(s.allBatches.length).toBe(3); // 이력 3개
    expect(s.referencedBatches.length).toBe(2); // 사용 2개
    expect(failed(run(s))).toEqual([]);
  });

  it("존재하지 않는 batch 를 참조하면 실패한다", () => {
    const s = v2Scenario();
    s.rows[0] = { ...s.rows[0], import_batch_id: "imp:does-not-exist" };
    const checks = run(s);
    expect(find(checks, "orphan import_batch reference").ok).toBe(false);
    expect(find(checks, "orphan import_batch reference").detail).toContain("imp:does-not-exist");
  });

  it("import_batch_id 가 null 인 행이 있으면 실패한다", () => {
    const s = v2Scenario();
    s.rows[5] = { ...s.rows[5], import_batch_id: null };
    expect(find(run(s), "import_batch_id 누락").ok).toBe(false);
  });

  it("남의 family/profile 의 batch 를 가리키면 실패한다", () => {
    const s = v2Scenario();
    s.referencedBatches = s.referencedBatches.map((b) =>
      b.id === "imp:v2" ? { ...b, family_code: "other" } : b);
    const checks = run(s);
    expect(find(checks, "batch 의 family/profile 일치").ok).toBe(false);
    expect(find(checks, "batch 의 family/profile 일치").detail).toContain("other");
  });

  it("같은 거래가 두 batch 로 중복 적재되면 inserted 합과 행 수가 어긋난다", () => {
    const s = v2Scenario();
    // 증분 batch 가 같은 거래를 한 번 더 넣은 상황을 흉내낸다.
    const dupRow = { ...s.rows[0], import_batch_id: "imp:v2" };
    s.rows = [...s.rows, dupRow];
    const checks = run(s);
    expect(find(checks, "Σ inserted_count(사용 batch) = 원장 행 수").ok).toBe(false);
    expect(find(checks, "거래 id 유일").ok).toBe(false);
  });
});

describe("기존 데이터 검증은 그대로 유지된다", () => {
  it("duplicate fingerprint 는 실패한다", () => {
    const s = v2Scenario();
    s.rows = [...s.rows];
    s.rows[1] = { ...s.rows[1], id: "vtx:clone", source_fingerprint: s.rows[0].source_fingerprint };
    const checks = run(s);
    expect(find(checks, "duplicate fingerprint").ok).toBe(false);
    expect(find(checks, "fingerprint 유일").ok).toBe(false);
  });

  it("id → fingerprint 매핑이 서로 바뀌면 집합이 같아도 실패한다", () => {
    const s = v2Scenario();
    const [a, b] = [s.rows[0], s.rows[1]];
    s.rows = [...s.rows];
    s.rows[0] = { ...a, source_fingerprint: b.source_fingerprint };
    s.rows[1] = { ...b, source_fingerprint: a.source_fingerprint };
    const checks = run(s);
    // 집합은 그대로다 — 그래서 "전부 존재" 는 통과한다.
    expect(find(checks, "데이터셋 fingerprint 전부 DB 에 존재").ok).toBe(true);
    expect(find(checks, "id 별 source_fingerprint 변경").ok).toBe(false);
  });

  it("계좌별 건수가 어긋나면 실패한다", () => {
    const s = v2Scenario();
    s.rows = s.rows.slice(0, -1);
    expect(failed(run(s))).toContain("거래 건수 (pension)");
  });

  it("finalHoldings 가 어긋나면 실패한다 (수량 변조)", () => {
    const s = v2Scenario();
    s.rows = [...s.rows];
    s.rows[0] = { ...s.rows[0], quantity: Number(s.rows[0].quantity) + 7 };
    expect(failed(run(s))).toContain("finalHoldings (DB 재생 vs 데이터셋)");
  });

  it("매도가 보유를 넘으면 negative holding 으로 잡힌다", () => {
    const s = v2Scenario();
    const i = s.rows.findIndex((r) => r.side === "sell");
    s.rows = [...s.rows];
    s.rows[i] = { ...s.rows[i], quantity: 1_000_000 };
    expect(failed(run(s))).toContain("negative holding");
  });

  it("증권사 보고 거래후수량과 어긋나면 postQuantity mismatch 로 잡힌다", () => {
    const s = v2Scenario();
    const i = s.rows.findIndex((r) => r.post_quantity !== null);
    s.rows = [...s.rows];
    s.rows[i] = { ...s.rows[i], post_quantity: Number(s.rows[i].post_quantity) + 1 };
    expect(find(run(s), "postQuantity mismatch").ok).toBe(false);
  });

  it("fingerprint_version 과 prefix 가 어긋나면 실패한다", () => {
    const s = v2Scenario();
    s.rows = [...s.rows];
    s.rows[0] = { ...s.rows[0], fingerprint_version: 2 };
    const checks = run(s);
    expect(find(checks, "fingerprint_version 단일(=1)").ok).toBe(false);
    expect(find(checks, "fingerprint prefix 와 version 정합").ok).toBe(false);
  });

  it("cashflow checksum 은 상수가 아니라 verified-cashflows 와 대조한다", () => {
    const s = v2Scenario();
    expect(find(run(s), "cashflow checksum (데이터셋 vs verified-cashflows)").ok).toBe(true);

    const tampered: VerifiedDataset = {
      ...s.dataset,
      validation: {
        ...s.dataset.validation,
        cashflowPrincipalChecksums: { ...s.dataset.validation.cashflowPrincipalChecksums, total: 1 },
      },
    };
    const checks = run({ ...s, dataset: tampered });
    expect(find(checks, "cashflow checksum (데이터셋 vs verified-cashflows)").ok).toBe(false);
  });
});
