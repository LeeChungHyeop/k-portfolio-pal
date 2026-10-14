/** migration 008 텍스트 불변식. DB 에 적용하지 않고 파일 내용만 검증한다. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sql = read("../../../migrations/008_order_intent.sql");
const active = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("008_order_intent.sql", () => {
  it("테이블·유일 제약·부분 유일 인덱스가 있다", () => {
    expect(active).toMatch(/create table if not exists public\.kaw_order_intent/);
    expect(active).toMatch(/primary key \(family_code, profile, id\)/);
    expect(active).toMatch(/unique \(family_code, profile, idempotency_key\)/);
    expect(active).toMatch(/\(family_code, profile, order_no\)\s+where order_no is not null/);
  });

  it("정책 CHECK: 매수·kis·22·지정가·금액 = 수량×단가", () => {
    expect(active).toMatch(/side = 'buy'/);
    expect(active).toMatch(/broker = 'kis'/);
    expect(active).toMatch(/product_code = '22'/);
    expect(active).toMatch(/ord_dvsn = '00'/);
    expect(active).toMatch(/amount = quantity::bigint \* limit_price::bigint/);
  });

  it("체결 상태는 증거를, 접수 이후 상태는 주문번호를 요구한다", () => {
    expect(active).toMatch(/partially_filled','filled'\) or evidence is not null/);
    expect(active).toMatch(/order_no is not null/);
  });

  it("revoke 가 grant 보다 먼저이고 delete/truncate 는 주지 않는다", () => {
    const revoke = active.indexOf("revoke all on public.kaw_order_intent");
    const grant = active.indexOf("grant select, insert");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(active).not.toMatch(/grant[^;]*\b(delete|truncate)\b/i);
    expect(active).toMatch(/enable row level security/);
  });

  it("UPDATE 는 컬럼 단위이고 주문 내용 컬럼은 포함하지 않는다", () => {
    const m = active.match(/grant update \(([\s\S]*?)\) on public\.kaw_order_intent/);
    expect(m).not.toBeNull();
    const cols = m![1];
    for (const c of ["ticker", "quantity", "limit_price", "amount", "side", "account_instance_id", "idempotency_key", "family_code", "profile"]) {
      expect(cols).not.toMatch(new RegExp(`\\b${c}\\b`));
    }
    for (const c of ["state", "state_version", "order_no", "evidence", "approval_consumed_at"]) {
      expect(cols).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });

  it("거래 원장을 건드리지 않는다", () => {
    expect(active).not.toMatch(/kaw_transaction_ledger/);
  });

  it("롤백 스크립트의 파괴적 문장은 전부 주석이다", () => {
    const rb = read("../../../migrations/008_order_intent_rollback.sql");
    const live = rb.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(live).toMatch(/^$/);
  });
});
