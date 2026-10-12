/**
 * migration 005 의 **권한 모델과 불변식 제약이 조용히 되돌아가지 않도록** 지키는 테스트.
 *
 * 004 의 같은 테스트(ledger-migration.test.ts)가 있는 이유를 그대로 물려받는다:
 * Supabase 는 public 스키마 기본 권한으로 **새 테이블에 anon/authenticated/service_role
 * 전부 ALL 을 붙인다.** GRANT 는 가산이라 "필요한 것만 grant" 는 빼기가 되지 않아서,
 * revoke 를 빼먹으면 plan immutable 도 관측 append-only 도 성립하지 않는다.
 *
 * 그래서 검사하는 것은 "grant 가 맞는가" 가 아니라 **"grant 전에 revoke 가 있는가"** 다.
 * 더해 005 고유의 불변식(PRE 역산 금지 / id 모양 / 해시 버전)이 SQL 에 실제로 들어 있는지
 * 본다 — 주석으로만 적힌 규칙은 지켜지지 않는다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../migrations/005_rebalance_plan_and_settlement.sql", import.meta.url)),
  "utf-8",
);
const ROLLBACK = readFileSync(
  fileURLToPath(
    new URL("../../../migrations/005_rebalance_plan_and_settlement_rollback.sql", import.meta.url),
  ),
  "utf-8",
);

/** 주석(`--` 로 시작하는 줄)을 뺀 실행 SQL 만. 검증 쿼리 섹션이 섞여 들어오지 않게 한다. */
const EXEC = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const TABLES = [
  "kaw_rebalance_plan",
  "kaw_settlement_observation",
  "kaw_settlement_observation_void",
] as const;

/** plan 과 관측은 둘 다 "쓰고 나면 못 고친다". 권한 모양이 같다. */
const IMMUTABLE = ["kaw_rebalance_plan", "kaw_settlement_observation"] as const;

describe("migration 005 권한 모델", () => {
  it.each(TABLES)("%s 는 네 주체의 권한을 먼저 전부 회수한다", (table) => {
    expect(EXEC).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ),
    );
  });

  it.each(TABLES)("%s 는 revoke 가 grant 보다 앞선다", (table) => {
    const revokeIdx = EXEC.indexOf(`revoke all on public.${table}`);
    const grantIdx = EXEC.search(new RegExp(`grant[^;]*on\\s+public\\.${table}\\b`, "i"));
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });

  it.each(IMMUTABLE)("%s 는 service_role 에 select, insert 만 준다", (table) => {
    expect(EXEC).toMatch(
      new RegExp(`grant\\s+select,\\s*insert\\s+on\\s+public\\.${table}\\s+to\\s+service_role`, "i"),
    );
    // update / delete / truncate / all 이 붙은 grant 가 이 테이블에 있으면 안 된다.
    expect(EXEC).not.toMatch(
      new RegExp(`grant[^;]*\\b(update|delete|truncate|all)\\b[^;]*on\\s+public\\.${table}\\b`, "i"),
    );
  });

  it("void overlay 만 update/delete 를 받는다 (되돌리기가 행 삭제다)", () => {
    expect(EXEC).toMatch(
      /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+public\.kaw_settlement_observation_void\s+to\s+service_role/i,
    );
    expect(EXEC).not.toMatch(
      /grant[^;]*\b(truncate|references|trigger|all)\b[^;]*on\s+public\.kaw_settlement_observation_void\b/i,
    );
  });

  it("RLS 를 세 테이블 모두 켠다", () => {
    for (const table of TABLES) {
      expect(EXEC).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
    }
  });

  it("정책(policy)을 하나도 만들지 않는다 — anon/authenticated 는 전면 차단이다", () => {
    expect(EXEC).not.toMatch(/create\s+policy/i);
  });

  it("anon / authenticated / public 에 grant 하는 문장이 하나도 없다", () => {
    for (const table of TABLES) {
      expect(EXEC).not.toMatch(
        new RegExp(`grant[^;]*on\\s+public\\.${table}\\s+to\\s+[^;]*\\b(anon|authenticated|public)\\b`, "i"),
      );
    }
  });

  it("시퀀스에 grant 하지 않는다 (005 는 identity 컬럼을 쓰지 않는다)", () => {
    expect(EXEC).not.toMatch(/grant[^;]*on\s+sequence/i);
  });
});

describe("migration 005 불변식 제약", () => {
  it("**PRE 역산 금지**가 CHECK 로 들어 있다", () => {
    expect(EXEC).toMatch(/kaw_rebalance_plan_pre_null_chk/);
    // unknown 이면 pre_quantities 와 pre_cash 가 둘 다 null 이어야 한다.
    expect(EXEC).toMatch(
      /pre_basis\s*=\s*'unknown'\s+and\s+pre_quantities\s+is\s+null\s+and\s+pre_cash\s+is\s+null/i,
    );
    // session_snapshot 이면 pre_quantities 가 있어야 한다.
    expect(EXEC).toMatch(
      /pre_basis\s*=\s*'session_snapshot'\s+and\s+pre_quantities\s+is\s+not\s+null/i,
    );
  });

  it("id 모양이 CHECK 로 고정돼 있다 (앱의 id 규칙과 DB 가 같은 말을 한다)", () => {
    expect(EXEC).toMatch(/check\s*\(\s*id\s*=\s*'plan:'\s*\|\|\s*completion_id\s*\)/i);
    expect(EXEC).toMatch(
      /check\s*\(\s*id\s*=\s*'obs:'\s*\|\|\s*capture_id\s*\|\|\s*':'\s*\|\|\s*source_type\s*\)/i,
    );
  });

  it("해시 버전 prefix 가 컬럼과 어긋나지 않게 묶여 있다 (004 와 같은 규칙)", () => {
    expect(EXEC).toMatch(/plan_payload_hash\s+like\s+'p'\s*\|\|\s*hash_version::text\s*\|\|\s*'\|%'/i);
    expect(EXEC).toMatch(/capture_payload_hash\s+like\s+'c'\s*\|\|\s*hash_version::text\s*\|\|\s*'\|%'/i);
  });

  it("completion 1회 = 1행 (completion_id UNIQUE)", () => {
    expect(EXEC).toMatch(/unique\s*\(\s*family_code,\s*profile,\s*completion_id\s*\)/i);
  });

  it("pre_discard_reason 은 네 값 + null 만 허용한다", () => {
    expect(EXEC).toMatch(/kaw_rebalance_plan_pre_discard_chk/);
    // null = "폐기할 일이 없었다" 는 정상 상태다.
    expect(EXEC).toMatch(/pre_discard_reason\s+is\s+null/i);
    for (const v of ["no_session", "past_date_mode", "date_mode_changed", "instance_changed"]) {
      expect(EXEC).toMatch(new RegExp(`'${v}'`));
    }
    // 열거형 컬럼에 CHECK 가 빠진 것이 없는지 — plan 의 모든 열거형을 한 번에 본다.
    for (const chk of ["date_mode", "pre_basis", "price_mode", "frozen_basis", "pre_discard"]) {
      expect(EXEC).toMatch(new RegExp(`kaw_rebalance_plan_${chk}_chk`));
    }
  });

  it("date_mode 에 'future' 가 없다 — 아직 하지 않은 리밸런싱은 증거가 아니다", () => {
    expect(EXEC).toMatch(/check\s*\(date_mode\s+in\s*\('today',\s*'past'\)\)/i);
    expect(EXEC).not.toMatch(/date_mode\s+in\s*\([^)]*'future'/i);
  });

  it("관측의 source_type 에는 CHECK 를 걸지 않는다 (registry 는 늘어난다)", () => {
    expect(EXEC).not.toMatch(/check\s*\(\s*source_type\s+in/i);
  });

  it("세 날짜 축을 모두 컬럼으로 분리해 들고 있다", () => {
    for (const col of ["observed_at", "state_as_of", "state_as_of_basis"]) {
      expect(EXEC).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(EXEC).toMatch(/state_as_of_basis\s+in\s*\('broker_reported_date',\s*'observation_date'\)/i);
  });

  it("사유 없는 void 를 만들 수 없다", () => {
    expect(EXEC).toMatch(/length\s*\(\s*btrim\s*\(\s*reason\s*\)\s*\)\s*>\s*0/i);
  });

  it("holdings / pre_quantities 는 not null 이 아니다 (null 과 0 을 구분한다)", () => {
    expect(EXEC).not.toMatch(/holdings\s+jsonb\s+not\s+null/i);
    expect(EXEC).not.toMatch(/pre_quantities\s+jsonb\s+not\s+null/i);
  });
});

describe("migration 005 가 004 를 깨지 않는다", () => {
  it("audit 대상만 **추가**하고 기존 세 값을 그대로 허용한다", () => {
    expect(EXEC).toMatch(
      /target_type\s+in\s*\('transaction',\s*'event',\s*'import',\s*'plan',\s*'observation'\)/i,
    );
  });

  it("004 가 만든 테이블을 drop 하거나 바꾸지 않는다", () => {
    expect(EXEC).not.toMatch(/drop\s+table/i);
    for (const t of [
      "kaw_transaction_ledger",
      "kaw_transaction_correction",
      "kaw_transaction_event_override",
      "kaw_rebalance_event",
      "kaw_ledger_import_batch",
    ]) {
      expect(EXEC).not.toMatch(new RegExp(`alter\\s+table\\s+public\\.${t}\\b`, "i"));
    }
  });

  it("공용 트리거 함수를 **재사용**하고 다시 정의하지 않는다", () => {
    expect(EXEC).toMatch(/execute\s+function\s+public\.kaw_touch_updated_at\(\)/i);
    expect(EXEC).not.toMatch(/create\s+or\s+replace\s+function\s+public\.kaw_touch_updated_at/i);
  });

  it("kaw_data 를 건드리지 않는다 (revision guard 는 1B-2 다)", () => {
    expect(EXEC).not.toMatch(/kaw_data/i);
  });

  it("멱등하다 — 테이블·인덱스 생성이 전부 if not exists 다", () => {
    const creates = EXEC.match(/create\s+(table|index)[^\n]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const line of creates) expect(line).toMatch(/if\s+not\s+exists/i);
  });
});

describe("005 rollback", () => {
  it("실행문이 전부 주석 처리돼 있다 (실수로 통째 실행되지 않는다)", () => {
    const live = ROLLBACK.split("\n").filter(
      (l) => l.trim() !== "" && !l.trimStart().startsWith("--"),
    );
    expect(live).toEqual([]);
  });

  it("되살릴 수 없는 세 테이블의 백업을 먼저 요구한다", () => {
    for (const t of TABLES) {
      expect(ROLLBACK).toMatch(new RegExp(`json_agg\\(t\\)\\s+from\\s+public\\.${t}\\b`, "i"));
    }
  });

  it("공용 트리거 함수는 지우지 않는다고 못박는다", () => {
    expect(ROLLBACK).toMatch(/kaw_touch_updated_at[\s\S]{0,80}지우지\s*않는다/);
    expect(ROLLBACK).not.toMatch(/^\s*drop\s+function/im);
  });
});
