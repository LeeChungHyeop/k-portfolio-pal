/**
 * `scripts/ledger-import.ts` 의 **쓰기 흐름**을 고정하는 테스트.
 *
 * 확인하는 것은 계산이 아니라 **DB 에 무엇을, 어떤 순서로, 몇 번 보내는가** 다.
 * migration 004 가 `kaw_transaction_ledger` 와 `kaw_ledger_import_batch` 에서
 * service_role 의 UPDATE/DELETE 를 회수했으므로, 적재 경로에 update/delete 가
 * 하나라도 섞이면 production 에서 permission denied 로 죽는다. 여기서 막는다.
 *
 * 또 하나: 두 쓰기는 **별개의 Supabase 요청**이라 사이에 트랜잭션이 없다. 원장만
 * 들어가고 batch 기록이 실패하면 provenance 가 끊기는데, 원장은 immutable 이라
 * 고칠 수 없다. 그래서 그 경우 **조용히 성공으로 끝나면 안 된다** — 그것도 테스트한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyImport, insertBatch, batchInsertSql, type BatchRow,
} from "./ledger-import-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVerifiedDataset, type VerifiedDataset } from "./verified-transactions";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── 가짜 Supabase 클라이언트 ────────────────────────────────────────────────

interface Call {
  table: string;
  op: "upsert" | "insert" | "update" | "delete" | "select";
  rowCount: number;
  payload?: unknown;
  options?: unknown;
}

interface FakeOpts {
  /** 원장 upsert 가 돌려줄 "실제로 삽입된" 행 수. 재import 를 흉내낼 때 0 을 준다. */
  ledgerInserted: number;
  ledgerError?: { message: string };
  /** batch insert 가 실패할 횟수. attempts 보다 크면 끝내 실패한다. */
  batchFailures?: number;
  batchErrorMessage?: string;
}

function fakeClient(opts: FakeOpts): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  let batchAttempts = 0;

  const client = {
    from(table: string) {
      const notAllowed = (op: Call["op"]) => () => {
        calls.push({ table, op, rowCount: 0 });
        throw new Error(`${op} 를 호출하면 안 된다 (${table})`);
      };
      return {
        upsert(rows: unknown[], options: unknown) {
          calls.push({ table, op: "upsert", rowCount: rows.length, options });
          return {
            select() {
              if (opts.ledgerError) return Promise.resolve({ data: null, error: opts.ledgerError });
              const data = Array.from({ length: opts.ledgerInserted }, (_, i) => ({ id: `vtx:${i}` }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
        insert(row: unknown) {
          batchAttempts += 1;
          calls.push({ table, op: "insert", rowCount: 1, payload: row });
          if (batchAttempts <= (opts.batchFailures ?? 0)) {
            return Promise.resolve({
              error: { message: opts.batchErrorMessage ?? "network timeout" },
            });
          }
          return Promise.resolve({ error: null });
        },
        update: notAllowed("update"),
        delete: notAllowed("delete"),
      };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

/**
 * **실제 production 데이터셋**을 쓴다. 손으로 만든 가짜로는 verifyDataset 게이트가
 * 통과하지 않고(이벤트·계좌별 건수까지 대조한다), 463 / 0 같은 숫자도 실물이어야
 * 의미가 있다. 파일은 읽기만 한다.
 */
const DATASET: VerifiedDataset = parseVerifiedDataset(
  JSON.parse(readFileSync(resolve(process.cwd(), "data/verified-transactions.v1.json"), "utf-8")),
);
const N = DATASET.transactions.length;

const ARGS = { apply: true, familyCode: "fam", profile: "prof" };
/** 재시도 대기를 없앤다 — 테스트는 간격이 아니라 횟수와 순서를 본다. */
const NO_WAIT = { attempts: 3, waitMs: 0 };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// ── 쓰기 흐름 ───────────────────────────────────────────────────────────────

describe("import 쓰기 흐름", () => {
  it("원장을 먼저 upsert 하고, 그 결과로 완성한 batch 행을 한 번 insert 한다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual([
      "kaw_transaction_ledger.upsert",
      "kaw_ledger_import_batch.insert",
    ]);
    expect(calls[0].rowCount).toBe(N);
    expect(N).toBe(463);   // 데이터셋이 바뀌면 여기서 드러난다
  });

  it("batch 행에 쓰이는 id 는 원장 행의 import_batch_id 와 같다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    const batchRow = calls[1].payload as BatchRow;
    expect(batchRow.id).toMatch(/^imp:verified_dataset_v1:/);
  });

  it("원장 upsert 는 fingerprint 를 arbiter 로 하는 ignoreDuplicates 다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    expect(calls[0].options).toEqual({
      onConflict: "family_code,profile,source_fingerprint",
      ignoreDuplicates: true,
    });
  });

  it("적재 경로에 update / delete 가 한 번도 없다 (004 권한 모델)", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    expect(calls.some((c) => c.op === "update" || c.op === "delete")).toBe(false);
  });
});

// ── 최초 import / 재import ──────────────────────────────────────────────────

describe("최초 import", () => {
  it("inserted 463 / skipped 0 으로 기록한다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    const batch = calls[1].payload as BatchRow;
    expect(batch.inserted_count).toBe(463);
    expect(batch.skipped_count).toBe(0);
  });
});

describe("동일 dataset 재import", () => {
  it("inserted 0 / skipped 463 으로 기록한다 (UPDATE 없이 새 batch 행 1개)", async () => {
    // 재import 에서는 463행 전부 fingerprint 충돌 → RETURNING 이 0행이다.
    const { client, calls } = fakeClient({ ledgerInserted: 0 });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    const batch = calls[1].payload as BatchRow;
    expect(batch.inserted_count).toBe(0);
    expect(batch.skipped_count).toBe(463);
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(1);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
});

// ── partial failure / retry ─────────────────────────────────────────────────

describe("partial failure", () => {
  it("원장 적재가 실패하면 batch 를 쓰지 않고 throw 한다", async () => {
    const { client, calls } = fakeClient({
      ledgerInserted: 0, ledgerError: { message: "timeout" },
    });
    await expect(applyImport(client, DATASET, ARGS, "chk", NO_WAIT)).rejects.toThrow("적재 실패");
    expect(calls.some((c) => c.table === "kaw_ledger_import_batch")).toBe(false);
  });

  it("batch insert 가 일시적으로 실패하면 재시도해서 성공한다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N, batchFailures: 2 });
    await applyImport(client, DATASET, ARGS, "chk", NO_WAIT);

    expect(calls.filter((c) => c.table === "kaw_ledger_import_batch")).toHaveLength(3);
  });

  it("batch insert 가 끝내 실패하면 **조용히 끝나지 않고** throw 한다", async () => {
    // 원장만 들어가고 batch 가 없으면 provenance 가 끊긴다. 원장은 immutable 이라
    // 재실행으로는 고칠 수 없으므로 반드시 사용자에게 드러나야 한다.
    const { client } = fakeClient({ ledgerInserted: N, batchFailures: 99 });
    await expect(applyImport(client, DATASET, ARGS, "chk", NO_WAIT))
      .rejects.toThrow("batch 이력 기록 실패");
  });

  it("끝내 실패하면 같은 id 로 복구할 INSERT 문을 출력한다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: N, batchFailures: 99 });
    await expect(applyImport(client, DATASET, ARGS, "chk", NO_WAIT)).rejects.toThrow();

    const batchId = (calls[1].payload as BatchRow).id;
    const printed = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(printed).toContain("insert into public.kaw_ledger_import_batch");
    expect(printed).toContain(batchId);
    // 사용자가 그냥 재실행하지 않도록 안내가 같이 나와야 한다.
    expect(printed).toContain("재실행");
  });
});

describe("insertBatch", () => {
  const row: BatchRow = {
    id: "imp:x", family_code: "fam", profile: "prof",
    source_kind: "verified_dataset_v1", source_label: "f.json", source_checksum: "chk",
    inserted_count: 1, skipped_count: 0, verification: [], actor: "prof",
  };

  it("성공하면 null 을 돌려준다", async () => {
    const { client } = fakeClient({ ledgerInserted: 0 });
    expect(await insertBatch(client, row, 3, 0)).toBeNull();
  });

  it("attempts 만큼만 시도하고 마지막 오류를 돌려준다", async () => {
    const { client, calls } = fakeClient({
      ledgerInserted: 0, batchFailures: 99, batchErrorMessage: "boom",
    });
    const err = await insertBatch(client, row, 3, 0);
    expect(err?.message).toBe("boom");
    expect(calls).toHaveLength(3);
  });

  it("insert 만 쓴다 — upsert 나 update 로 바뀌면 권한 모델과 충돌한다", async () => {
    const { client, calls } = fakeClient({ ledgerInserted: 0 });
    await insertBatch(client, row, 3, 0);
    expect(calls.every((c) => c.op === "insert")).toBe(true);
  });
});

describe("batchInsertSql", () => {
  const row: BatchRow = {
    id: "imp:verified_dataset_v1:2026-10-07T00:00:00.000Z",
    family_code: "fam", profile: "prof",
    source_kind: "verified_dataset_v1",
    source_label: "data/verified-transactions.v1.json",
    source_checksum: "abc123",
    inserted_count: 463, skipped_count: 0,
    verification: [{ name: "t", ok: true }],
    actor: "prof",
  };

  it("INSERT 문 하나다 — update 가 섞이지 않는다", () => {
    const sql = batchInsertSql(row);
    expect(sql.startsWith("insert into public.kaw_ledger_import_batch")).toBe(true);
    expect(sql.toLowerCase()).not.toContain("update");
    expect(sql.trimEnd().endsWith(";")).toBe(true);
  });

  it("값과 건수를 그대로 담는다", () => {
    const sql = batchInsertSql(row);
    expect(sql).toContain(`'${row.id}'`);
    expect(sql).toContain("463, 0,");
    expect(sql).toContain("::jsonb");
  });

  it("작은따옴표를 이스케이프한다", () => {
    const sql = batchInsertSql({ ...row, source_label: "it's a file" });
    expect(sql).toContain("'it''s a file'");
  });
});
