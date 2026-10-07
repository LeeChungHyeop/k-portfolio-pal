/**
 * migration 004 의 **권한 모델이 조용히 되돌아가지 않도록** 지키는 테스트.
 *
 * 이 파일이 있는 이유는 실제로 한 번 틀렸기 때문이다. 004 의 주석과 핸드오프 문서는
 * "service_role 에 UPDATE 권한조차 주지 않았다"고 적혀 있었지만, Supabase 는 public
 * 스키마 기본 권한으로 **새 테이블에 anon/authenticated/service_role 전부 ALL 을 붙인다.**
 * GRANT 는 가산이라 "필요한 것만 grant" 는 빼기가 되지 않아서, 적용했다면 원장 immutable 도
 * audit append-only 도 성립하지 않은 채로 넘어갔을 것이다.
 *
 * 그래서 검사하는 것은 "grant 가 맞는가"가 아니라 **"grant 전에 revoke 가 있는가"** 다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../migrations/004_transaction_ledger.sql", import.meta.url)),
  "utf-8",
);

/** 주석(`--` 로 시작하는 줄)을 뺀 실행 SQL 만. 검증 쿼리 섹션이 섞여 들어오지 않게 한다. */
const EXEC = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const TABLES = [
  "kaw_ledger_import_batch",
  "kaw_transaction_ledger",
  "kaw_transaction_correction",
  "kaw_transaction_event_override",
  "kaw_rebalance_event",
  "kaw_ledger_audit",
] as const;

const IMMUTABLE = [
  "kaw_transaction_ledger",
  "kaw_ledger_audit",
  "kaw_ledger_import_batch",
] as const;

const OVERLAY = [
  "kaw_transaction_correction",
  "kaw_transaction_event_override",
  "kaw_rebalance_event",
] as const;

describe("migration 004 권한 모델", () => {
  it.each(TABLES)("%s 는 네 주체의 권한을 먼저 전부 회수한다", (table) => {
    const re = new RegExp(
      `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
      "i",
    );
    expect(EXEC).toMatch(re);
  });

  it.each(TABLES)("%s 는 revoke 가 grant 보다 앞선다", (table) => {
    const revokeIdx = EXEC.indexOf(`revoke all on public.${table}`);
    const grantIdx = EXEC.search(new RegExp(`grant[^;]*on\\s+public\\.${table}\\b`, "i"));
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });

  it.each(IMMUTABLE)("%s 는 service_role 에 select, insert 만 준다", (table) => {
    const re = new RegExp(`grant\\s+select,\\s*insert\\s+on\\s+public\\.${table}\\s+to\\s+service_role`, "i");
    expect(EXEC).toMatch(re);
    // update / delete 가 붙은 grant 가 이 테이블에 있으면 안 된다.
    expect(EXEC).not.toMatch(
      new RegExp(`grant[^;]*\\b(update|delete|truncate|all)\\b[^;]*on\\s+public\\.${table}\\b`, "i"),
    );
  });

  it.each(OVERLAY)("%s 는 service_role 에 select, insert, update, delete 를 준다", (table) => {
    expect(EXEC).toMatch(
      new RegExp(`grant\\s+select,\\s*insert,\\s*update,\\s*delete\\s+on\\s+public\\.${table}\\s+to\\s+service_role`, "i"),
    );
    // truncate / references / trigger / all 은 어디에도 없다.
    expect(EXEC).not.toMatch(
      new RegExp(`grant[^;]*\\b(truncate|references|trigger|all)\\b[^;]*on\\s+public\\.${table}\\b`, "i"),
    );
  });

  it("anon / authenticated / public 에 grant 하는 문장이 하나도 없다", () => {
    for (const table of TABLES) {
      expect(EXEC).not.toMatch(
        new RegExp(`grant[^;]*on\\s+public\\.${table}\\s+to\\s+[^;]*\\b(anon|authenticated|public)\\b`, "i"),
      );
    }
  });

  it("identity 시퀀스에 grant 하지 않는다 (identity 는 시퀀스 권한을 요구하지 않는다)", () => {
    expect(EXEC).not.toMatch(/grant[^;]*on\s+sequence/i);
  });
});

describe("migration 004 CHECK 제약", () => {
  it("fingerprint 문자열의 버전 prefix 와 fingerprint_version 이 맞도록 강제한다", () => {
    expect(EXEC).toContain("kaw_transaction_ledger_fp_version_chk");
    expect(EXEC).toMatch(
      /check\s*\(\s*source_fingerprint\s+like\s+'v'\s*\|\|\s*fingerprint_version::text\s*\|\|\s*'\|%'\s*\)/i,
    );
  });

  it("아무것도 정정하지 않는 correction 행을 막는다", () => {
    expect(EXEC).toContain("kaw_transaction_correction_nonempty_chk");
    for (const col of [
      "corrected_quantity",
      "corrected_price",
      "corrected_amount",
      "corrected_trade_date",
      "corrected_side",
      "corrected_ticker",
    ]) {
      expect(EXEC).toMatch(new RegExp(`${col}\\s+is\\s+not\\s+null`, "i"));
    }
  });

  it("두 CHECK 는 멱등하게 추가된다 (pg_constraint 확인 후 alter)", () => {
    for (const name of [
      "kaw_transaction_ledger_fp_version_chk",
      "kaw_transaction_correction_nonempty_chk",
    ]) {
      const i = EXEC.indexOf(`conname  = '${name}'`);
      expect(i, `${name} 의 존재 확인이 없다`).toBeGreaterThan(-1);
      expect(EXEC.slice(i).indexOf(`add constraint ${name}`)).toBeGreaterThan(-1);
    }
  });
});

describe("migration 004 는 기존 객체를 건드리지 않는다", () => {
  it("DML 이 하나도 없다", () => {
    expect(EXEC).not.toMatch(/^\s*(insert|update|delete|truncate)\s/im);
  });

  it("001~003 의 테이블/뷰를 alter 하지 않는다", () => {
    for (const legacy of [
      "kaw_data",
      "kaw_live_prices",
      "kaw_portfolio_live_view",
      "kaw_daily_portfolio_snapshots",
    ]) {
      expect(EXEC).not.toMatch(new RegExp(`alter\\s+(table|view)\\s+[\\w.]*${legacy}\\b`, "i"));
      expect(EXEC).not.toMatch(new RegExp(`drop\\s+(table|view)[^;]*${legacy}\\b`, "i"));
    }
  });

  it("003 과 공유하는 kaw_touch_updated_at() 를 drop 하지 않는다", () => {
    expect(EXEC).not.toMatch(/drop\s+function[^;]*kaw_touch_updated_at/i);
  });

  it("테이블·인덱스 생성은 전부 if not exists 다 (두 번 실행해도 안전)", () => {
    const creates = EXEC.match(/create\s+(table|index)\s[^\n(]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c.toLowerCase()).toContain("if not exists");
  });
});
