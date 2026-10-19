/**
 * migration 011 — 계좌 이전 확정 중복 방지 (파일 수준 보증)
 *
 * 실제 Postgres 엔진(PGlite)에서의 동작 검증(24건: 적용 · 멱등 · 23505 · 병렬 INSERT · 다른 action 무영향 ·
 * 사전 점검 중단 · 롤백)은 별도 스크립트로 수행했고, 이 테스트는 저장소의 파일이 그 계약을 유지하는지 고정한다.
 *
 *   1. 인덱스는 action='transfer_confirm' 행에만 걸리는 부분 유니크이고 키는 (family_code, profile, target_id)
 *   2. 데이터 변경문이 없다 — UPDATE / DELETE / INSERT / TRUNCATE 없음, 다른 action 을 언급하지 않는다
 *   3. 이미 중복이 있으면 아무것도 만들지 않고 멈춘다 · 동명 다른 정의 인덱스는 조용히 통과하지 않는다
 *   4. 롤백은 인덱스만 지운다
 *   5. 서버가 쓰는 action / target_id 모양과 인덱스 조건이 어긋나지 않는다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSFER_AUDIT_ACTION } from "./account-transfer-record";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const UP = read("../../../migrations/011_transfer_confirm_unique.sql");
const DOWN = read("../../../migrations/011_transfer_confirm_unique_rollback.sql");
const sql = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe("011 — 부분 유니크 인덱스", () => {
  it("action = 'transfer_confirm' 에만 걸리고 키는 (family_code, profile, target_id) 다", () => {
    const code = sql(UP);
    expect(code).toMatch(/create unique index if not exists kaw_ledger_audit_transfer_confirm_uq\s+on public\.kaw_ledger_audit \(family_code, profile, target_id\)\s+where action = 'transfer_confirm';/);
  });

  it("인덱스 조건의 action 은 서버가 쓰는 action 과 같다", () => {
    expect(TRANSFER_AUDIT_ACTION).toBe("transfer_confirm");
    expect(sql(UP)).toContain(`where action = '${TRANSFER_AUDIT_ACTION}'`);
    // 서버가 쓰는 target_id 모양 (transfer:<instanceId>)이 인덱스 키 컬럼에 들어간다
    expect(read("./kis-transfer-server.ts")).toContain("target_id: `transfer:${verdict.record.toInstanceId}`");
  });

  it("다른 action 의 audit 이력에는 영향이 없다 — 인덱스 조건 밖의 action 을 언급하지 않는다", () => {
    const code = sql(UP);
    for (const other of ["event_hide", "event_restore", "tx_correct", "tx_move", "import"]) expect(code).not.toContain(other);
  });
});

describe("011 — 기존 데이터를 건드리지 않는다", () => {
  it("실행 SQL 에 데이터 변경문이 없다", () => {
    const code = sql(UP);
    expect(code).not.toMatch(/\b(update\s+public|delete\s+from|truncate|insert\s+into|drop\s+(table|index|constraint)|alter\s+table)\b/i);
  });

  it("테이블 구조 · 제약 · 권한을 바꾸지 않는다 (grant / revoke / alter 없음)", () => {
    expect(sql(UP)).not.toMatch(/\b(grant|revoke|alter)\b/i);
  });

  it("이미 중복이 있으면 아무것도 만들지 않고 멈춘다 (사전 점검이 인덱스 생성보다 앞선다)", () => {
    const code = sql(UP);
    const check = code.indexOf("having count(*) > 1");
    const raise = code.indexOf("raise exception '같은 계좌의 transfer_confirm 이력이 중복된 그룹이");
    const create = code.indexOf("create unique index");
    expect(check).toBeGreaterThan(-1);
    expect(raise).toBeGreaterThan(check);
    expect(create).toBeGreaterThan(raise);
  });

  it("키 컬럼이 NULL 을 허용하면(NULL 로 유니크 우회 가능) 인덱스보다 먼저 멈춘다", () => {
    const code = sql(UP);
    const nn = code.indexOf("is_nullable = 'YES'");
    expect(nn).toBeGreaterThan(-1);
    expect(code.slice(nn - 400, nn + 600)).toMatch(/family_code.*profile.*target_id.*action/s);
    expect(code.indexOf("NULL 로 유니크 인덱스를 우회할 수 있어")).toBeGreaterThan(nn);
    expect(code.indexOf("create unique index")).toBeGreaterThan(code.indexOf("NULL 로 유니크 인덱스를 우회할 수 있어"));
  });

  it("004 미적용(테이블 없음)과 동명 다른 정의 인덱스는 조용히 통과하지 않는다", () => {
    const code = sql(UP);
    expect(code).toContain("004 미적용");
    expect(code).toContain("정의가 다릅니다");
  });

  it("멱등하다 — create unique index if not exists", () => {
    expect(sql(UP)).toContain("create unique index if not exists");
  });
});

describe("011 롤백", () => {
  it("인덱스만 지우고 데이터는 건드리지 않는다", () => {
    const code = sql(DOWN).trim();
    expect(code).toBe("drop index if exists public.kaw_ledger_audit_transfer_confirm_uq;");
  });
});
