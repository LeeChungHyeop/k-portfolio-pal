/**
 * migration 006 의 **원자성·보존·권한 모델이 조용히 되돌아가지 않도록** 지키는 테스트.
 *
 * 004/005 의 같은 테스트(ledger-migration / plan-migration)와 이유가 같다. 거기서는
 * "GRANT 전에 REVOKE 가 있는가"가 핵심이었고, 006 에는 하나 더 있다 — **행 잠금**이다.
 * `select ... for update` 가 빠지면 함수는 그대로 돌아가고 테스트도 통과하는데
 * (단일 연결에서는 아무 차이가 없다) **동시 요청에서 기록이 사라진다.** SQL 을 읽어서
 * 확인할 수밖에 없는 종류의 불변식이라 여기서 고정한다.
 *
 * 주석으로만 적힌 규칙은 지켜지지 않으므로, 검사 대상은 **실행 SQL** 뿐이다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../migrations/006_history_merge_rpc.sql", import.meta.url)),
  "utf-8",
);
const ROLLBACK = readFileSync(
  fileURLToPath(new URL("../../../migrations/006_history_merge_rpc_rollback.sql", import.meta.url)),
  "utf-8",
);

/** 주석(`--` 로 시작하는 줄)을 뺀 실행 SQL 만. 검증 쿼리 섹션이 섞여 들어오지 않게 한다. */
const EXEC = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const FN = "kaw_data_merge_history";
const SIGNATURE = `public.${FN}(text, text, text, jsonb)`;

describe("migration 006 — 원자성", () => {
  it("행을 **잠그고** 읽는다 (`for update`)", () => {
    expect(EXEC).toMatch(/for\s+update/i);
  });

  it("잠금이 읽기-수정-쓰기보다 **앞선다**", () => {
    const lock = EXEC.search(/for\s+update/i);
    const update = EXEC.search(/update\s+public\.kaw_data/i);
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(update);
  });

  it("plpgsql 함수 하나다 (여러 문장을 클라이언트가 이어 붙이지 않는다)", () => {
    expect(EXEC).toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}`, "i"));
    expect(EXEC).toMatch(/language\s+plpgsql/i);
  });

  it("kaw_data 를 쓰는 문장이 **UPDATE 하나뿐**이다", () => {
    const writes = EXEC.match(/(insert\s+into|update|delete\s+from)\s+public\.kaw_data\b/gi) ?? [];
    expect(writes.map((w) => w.toLowerCase().split(/\s+/)[0])).toEqual(["update"]);
  });

  it("revision 을 **증가**시킨다 (클라이언트가 보낸 값으로 덮지 않는다)", () => {
    expect(EXEC).toMatch(/revision\s*=\s*d\.revision\s*\+\s*1/i);
  });
});

describe("migration 006 — 기존 데이터 보존", () => {
  it("history 키 **하나만** 바꾼다 (문서를 재구성하지 않는다)", () => {
    expect(EXEC).toMatch(/jsonb_set\(/i);
    expect(EXEC).toMatch(/'\{history\}'/);
    // 문서 전체를 바꿔치우는 모양이 없어야 한다: `set data = p_...` / `set data = jsonb_build_object`
    expect(EXEC).not.toMatch(/set\s+data\s*=\s*p_/i);
    expect(EXEC).not.toMatch(/set\s+data\s*=\s*jsonb_build_object/i);
  });

  it("**append** 다 — 배열을 교체하거나 원소를 지우지 않는다", () => {
    expect(EXEC).toMatch(/v_history\s*\|\|\s*jsonb_build_array\(p_entry\)/i);
    expect(EXEC).not.toMatch(/\bjsonb_set_lax\b|#-/);
  });

  it("history 가 배열이 아니면 **쓰지 않고 거부한다**", () => {
    expect(EXEC).toMatch(/jsonb_typeof\(v_data\s*->\s*'history'\)\s*not\s+in\s*\('array',\s*'null'\)/i);
  });

  it("같은 id 가 있으면 **쓰기 없이** 돌려준다 (교체 경로가 없다)", () => {
    expect(EXEC).toMatch(/'already_exists'/);
    // 저장된 기록을 UPDATE 로 바꾸는 경로가 생기면 멱등이 아니라 '덮어쓰기'가 된다.
    const existsIdx = EXEC.indexOf("'already_exists'");
    const updateIdx = EXEC.search(/update\s+public\.kaw_data/i);
    expect(existsIdx).toBeLessThan(updateIdx);
    expect(EXEC).toMatch(/return\s+jsonb_build_object\([\s\S]{0,200}'already_exists'/i);
  });

  it("계좌 문서를 **만들지 않는다**", () => {
    expect(EXEC).toMatch(/'account_row_missing'/);
    expect(EXEC).not.toMatch(/insert\s+into\s+public\.kaw_data/i);
  });

  it("004/005 의 테이블을 drop 하거나 바꾸지 않는다 (audit CHECK 확장만 예외)", () => {
    expect(EXEC).not.toMatch(/drop\s+table/i);
    for (const t of [
      "kaw_transaction_ledger", "kaw_transaction_correction",
      "kaw_transaction_event_override", "kaw_rebalance_event",
      "kaw_ledger_import_batch", "kaw_rebalance_plan",
      "kaw_settlement_observation", "kaw_daily_portfolio_snapshots",
    ]) {
      expect(EXEC).not.toMatch(new RegExp(`alter\\s+table\\s+public\\.${t}\\b`, "i"));
    }
  });

  it("audit 대상을 **추가**만 하고 기존 다섯 값을 그대로 허용한다", () => {
    expect(EXEC).toMatch(
      /target_type\s+in\s*\('transaction',\s*'event',\s*'import',\s*'plan',\s*'observation',\s*'history'\)/i,
    );
  });

  it("파생값을 다시 계산하지 않는다 — returnPct 는 id 만 돌려준다", () => {
    expect(EXEC).toMatch(/stale_return_pct_ids/);
    // 수익률 계산식이 SQL 로 복제되면 정의가 둘로 갈라진다(store.ts recalcReturns).
    expect(EXEC).not.toMatch(/returnPct['"]?\s*,\s*to_jsonb/i);
    expect(EXEC).not.toMatch(/set\s+returnPct/i);
  });
});

describe("migration 006 — 권한", () => {
  it("함수 권한을 네 주체에서 **먼저 전부 회수한다**", () => {
    expect(EXEC).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}\\([^)]*\\)\\s*from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ),
    );
  });

  it("revoke 가 grant 보다 앞선다", () => {
    const revokeIdx = EXEC.search(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}`, "i"));
    const grantIdx = EXEC.search(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}`, "i"));
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });

  it("service_role 에만 execute 를 준다", () => {
    expect(EXEC).toMatch(
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\([^)]*\\)\\s*to\\s+service_role`, "i"),
    );
    expect(EXEC).not.toMatch(/grant[^;]*to\s+(anon|authenticated|public)\b/i);
  });

  it("**security definer 가 아니다** (권한 승격 경로를 만들지 않는다)", () => {
    expect(EXEC).toMatch(/security\s+invoker/i);
    expect(EXEC).not.toMatch(/security\s+definer/i);
  });

  it("search_path 를 고정한다 (definer 가 아니어도 함수 안의 이름 해석을 흔들지 않는다)", () => {
    expect(EXEC).toMatch(/set\s+search_path\s*=\s*public,\s*pg_temp/i);
  });

  it("kaw_data 자체의 권한은 건드리지 않는다 (기존 경로가 그대로 돌아야 한다)", () => {
    expect(EXEC).not.toMatch(/(revoke|grant)[^;]*on\s+(table\s+)?public\.kaw_data\b/i);
  });
});

describe("migration 006 — 멱등", () => {
  it("컬럼 추가가 if not exists 다", () => {
    expect(EXEC).toMatch(/alter\s+table\s+public\.kaw_data\s+add\s+column\s+if\s+not\s+exists\s+revision/i);
  });

  it("revision 은 not null default 0 이다 (기존 upsert 가 이 컬럼을 몰라도 된다)", () => {
    expect(EXEC).toMatch(/revision\s+integer\s+not\s+null\s+default\s+0/i);
  });

  it("함수는 create or replace 다", () => {
    expect(EXEC).not.toMatch(new RegExp(`create\\s+function\\s+public\\.${FN}`, "i"));
  });

  it("테이블·인덱스를 만든다면 전부 if not exists 다", () => {
    for (const line of EXEC.match(/create\s+(table|index)[^\n]*/gi) ?? []) {
      expect(line).toMatch(/if\s+not\s+exists/i);
    }
  });

  it("서명이 문서·검증 쿼리와 일치한다 (오버로드가 쌓이면 PostgREST 가 모호해진다)", () => {
    expect(EXEC).toContain(SIGNATURE);
    expect(SQL).toMatch(/kaw_data_merge_history\(text,text,text,jsonb\)/);
  });
});

describe("006 rollback", () => {
  it("실행문이 전부 주석 처리돼 있다 (실수로 통째 실행되지 않는다)", () => {
    const live = ROLLBACK.split("\n").filter(
      (l) => l.trim() !== "" && !l.trimStart().startsWith("--"),
    );
    expect(live).toEqual([]);
  });

  it("함수를 지우기 전에 **호출부를 먼저 끄라고** 못박는다", () => {
    expect(ROLLBACK).toMatch(/\/api\/data\/history/);
  });

  it("병합된 기록(계좌 문서)은 롤백으로 사라지지 않는다고 적어 둔다", () => {
    expect(ROLLBACK).toMatch(/data\s*->\s*'history'/);
  });

  it("revision 을 지우면 복원할 수 없으니 백업을 먼저 요구한다", () => {
    expect(ROLLBACK).toMatch(/select\s+json_agg\(t\)\s+from\s*\([\s\S]{0,200}revision/i);
  });
});
