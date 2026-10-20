/**
 * migration 013(동기화 원자 적용 RPC) · 014(live view 보유 기준) — 파일 수준 보증
 *
 * 실제 Postgres 엔진(PGlite)에서 004 → 011 → 007 → 013 / 001 → 002 → 014 를 순서대로 적용하고 service_role 권한으로 실행한
 * 97건의 검증(013: 72건 — 복구·재승인 포함, 014: 25건 — 다른 계좌·부분 적용 포함)(정상 반영 · 멱등 · 사전 조건 · 문서 diff 위반 14종 · 입력 위반 · 감사 INSERT 실패 시 문서 롤백 · anon/authenticated 불가 · 백업→검사→복구 ·
 * 롤백 · view 의 보유 기준 선택 · 002 와 결과 동일)은 별도 스크립트로 수행했다.
 * 이 테스트는 저장소의 파일이 그 계약과 TypeScript 쪽 상수에서 어긋나지 않는지 고정한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BROKER_SYNC_AUDIT_ACTION, BROKER_SYNC_MUTABLE_KEYS } from "./broker-sync";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sql = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const UP13 = sql(read("../../../migrations/013_broker_sync_apply.sql"));
const DOWN13 = sql(read("../../../migrations/013_broker_sync_apply_rollback.sql"));
const UP14 = sql(read("../../../migrations/014_live_view_broker_sync.sql"));
const DOWN14 = sql(read("../../../migrations/014_live_view_broker_sync_rollback.sql"));

describe("013 함수 정의", () => {
  it("security invoker + search_path 를 pg_catalog 하나로 고정 + 인자 5개", () => {
    expect(UP13).toMatch(/create or replace function public\.kaw_broker_sync_apply\(\s*p_family_code text,\s*p_profile\s+text,\s*p_expect\s+jsonb,\s*p_new_data\s+jsonb,\s*p_audit\s+jsonb\s*\) returns jsonb/);
    expect(UP13).toContain("security invoker");
    expect(UP13).not.toMatch(/security definer/i);
    expect(UP13).toMatch(/set search_path = pg_catalog\r?\nas \$\$/);
    expect(UP13).not.toMatch(/set search_path[^\r\n]*public/);
  });

  it("함수 본문의 모든 테이블 · 함수 참조는 public. 으로 명시돼 있다 (스키마 섀도잉 불가)", () => {
    const body = UP13.slice(UP13.indexOf("as $$"), UP13.lastIndexOf("$$;"));
    let seen = 0;
    for (const t of ["kaw_data", "kaw_ledger_audit", "kaw_transaction_ledger", "kaw_transaction_correction", "kaw_data_save_guarded"]) {
      for (const m of body.matchAll(new RegExp(`\\b${t}\\b`, "g"))) {
        seen++;
        expect(body.slice(m.index! - 7, m.index!), `${t}@${m.index}`).toBe("public.");
      }
    }
    expect(seen).toBeGreaterThanOrEqual(6);
  });

  it("실행 권한은 service_role 만 — public/anon/authenticated 회수", () => {
    expect(UP13).toMatch(/revoke all on function public\.kaw_broker_sync_apply\(text, text, jsonb, jsonb, jsonb\)\s+from public, anon, authenticated;/);
    expect(UP13).toMatch(/grant execute on function public\.kaw_broker_sync_apply\(text, text, jsonb, jsonb, jsonb\)\s+to service_role;/);
  });

  it("호출자 역할 확인이 가장 먼저, 직렬화 락보다 앞에 실행된다. 승인자는 프로필과 같아야 한다", () => {
    const g = UP13.indexOf("pg_catalog.pg_has_role(current_user, 'service_role', 'member')");
    expect(g).toBeGreaterThan(-1);
    expect(g).toBeLessThan(UP13.indexOf("pg_advisory_xact_lock"));
    expect(UP13).toContain("errcode = '42501'");
    expect(UP13).toContain("v_actor is distinct from p_profile");
  });

  it("생성 · 회수 · 부여가 같은 스크립트에 있고 명시적 트랜잭션 제어를 쓰지 않는다 (암묵적 단일 트랜잭션)", () => {
    expect(UP13.indexOf("create or replace function")).toBeLessThan(UP13.indexOf("revoke all on function"));
    expect(UP13.indexOf("revoke all on function")).toBeLessThan(UP13.indexOf("grant execute on function"));
    expect(UP13).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
  });

  it("선행 조건: 004 테이블 · 007 함수 · 011 인덱스가 없으면 멈춘다", () => {
    for (const t of ["kaw_data", "kaw_ledger_audit", "kaw_transaction_ledger", "kaw_transaction_correction", "kaw_data_save_guarded", "kaw_ledger_audit_transfer_confirm_uq"]) expect(UP13).toContain(t);
    expect(UP13).toContain("013 을 적용하지 않았습니다");
  });
});

describe("013 원자성과 검증 순서", () => {
  const ix = (t: string) => UP13.indexOf(t);
  it("순서: 락 → 입력 검증 → 문서 잠금 → 멱등 → revision → DB 사전 조건 → 문서 diff → 저장 → 감사 INSERT", () => {
    const order = [
      "pg_advisory_xact_lock",
      "KAW_SYNC:invalid_input",
      "select d.revision, d.data into v_cur_rev, v_cur",
      "already_synced",
      "KAW_SYNC:revision_conflict",
      "KAW_SYNC:transfer_unconfirmed",
      "KAW_SYNC:corrections_present",
      "KAW_SYNC:holdings_mismatch",
      "KAW_SYNC:doc_changed_outside_allowed",
      "v_res := public.kaw_data_save_guarded(",
      "KAW_SYNC:save_conflict",
      "insert into public.kaw_ledger_audit",
    ].map(ix);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("문서 저장은 기존 revision CAS 함수(007)를 그대로 쓰고, 'saved' 가 아니면 예외로 전부 취소한다", () => {
    expect(UP13).toContain("public.kaw_data_save_guarded(");
    expect(UP13).toContain("v_res->>'outcome' is distinct from 'saved'");
    // 키 손실·이력 축소 허용 플래그를 켜지 않는다 (인자는 rows 하나뿐)
    expect(UP13).not.toMatch(/kaw_data_save_guarded\([^)]*true/i);
  });

  it("데이터 변경은 감사 INSERT 와 kaw_data_save_guarded 뿐이다 — UPDATE / DELETE / TRUNCATE 직접 사용 없음", () => {
    expect(UP13).not.toMatch(/\b(update\s+public|delete\s+from|truncate|alter\s+table)\b/i);
    expect(UP13).not.toMatch(/insert into public\.(kaw_transaction_ledger|kaw_ledger_import_batch|kaw_data\b|kaw_daily_portfolio_snapshots|kaw_settlement_observation)/);
    expect(UP13).not.toMatch(/kaw_daily_portfolio_snapshots|kaw_order_/);
  });

  it("허용 키가 TypeScript 상수와 같다 (5개), 기록 표식(notRebalance · createsCashflow · createsTrade)을 DB 가 확인한다", () => {
    for (const k of BROKER_SYNC_MUTABLE_KEYS) expect(UP13).toContain(`'${k}'`);
    expect(UP13).toMatch(/array\[('[A-Za-z]+',? ?){5}\]/);
    for (const f of ["'createsCashflow'", "'createsTrade'", "'notRebalance'", "'broker_sync'"]) expect(UP13).toContain(f);
  });

  it("감사 action · target 접두가 TypeScript 와 같고, 같은 대상은 부분 유니크 인덱스가 한 번만 허용한다", () => {
    expect(UP13).toContain(`'${BROKER_SYNC_AUDIT_ACTION}'`);
    expect(UP13).toMatch(/create unique index if not exists kaw_ledger_audit_broker_sync_uq\s+on public\.kaw_ledger_audit \(family_code, profile, target_id\)\s+where action = 'broker_sync_apply';/);
    expect(UP13).toContain("'sync:' || v_record || '@r' || v_cur_rev");
  });

  it("서버가 해석하는 오류 코드가 SQL 이 던지는 코드와 같다", () => {
    const server = read("./kis-sync-server.ts");
    for (const c of ["revision_conflict", "holdings_mismatch", "doc_changed_outside_allowed", "doc_mismatch", "transfer_unconfirmed", "corrections_present", "invalid_input", "doc_missing", "save_conflict", "forbidden"]) {
      expect(UP13, c).toContain(`KAW_SYNC:${c}`);
      expect(server, c).toContain(c);
    }
  });
});

describe("013 롤백", () => {
  it("함수와 감사 유니크 인덱스만 지운다 — 이미 반영된 문서 · 감사는 건드리지 않는다", () => {
    expect(DOWN13.trim().split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "drop function if exists public.kaw_broker_sync_apply(text, text, jsonb, jsonb, jsonb);",
      "drop index if exists public.kaw_ledger_audit_broker_sync_uq;",
    ]);
  });
});

describe("014 live view", () => {
  it("002 와 같은 보안: security_invoker, anon/authenticated 회수, service_role 만 SELECT", () => {
    expect(UP14).toContain("with (security_invoker = true)");
    expect(UP14).toMatch(/revoke all on public\.kaw_portfolio_live_view from anon, authenticated;/);
    expect(UP14).toMatch(/grant select on public\.kaw_portfolio_live_view to service_role;/);
  });
  it("기존 컬럼은 그대로이고 맨 뒤에 holdings_basis_kind · cash_state_as_of 두 개만 덧붙인다", () => {
    const tail = UP14.slice(UP14.indexOf("v.data_updated_at"));
    expect(tail).toMatch(/v\.data_updated_at,\s*v\.holdings_basis_kind,\s*v\.cash_state_as_of\s*from valued v/);
    for (const col of ["rebalance_date", "rebalance_id", "total_asset_value", "rebalance_base_amount", "target_value", "rebalance_diff", "in_target_profile"]) expect(UP14).toContain(col);
  });
  it("보유 기준 선택 규칙: 날짜 내림차순 → 같은 날짜면 동기화(kind_rank 1) 우선 → 배열 뒤쪽 우선", () => {
    expect(UP14).toContain("order by c.family_code, c.profile, c.account_type, c.basis_date desc nulls last, c.kind_rank desc, c.ord desc");
    expect(UP14).toContain("holdingsEffectiveFrom");
    expect(UP14).toContain("s.value ->> 'kind' = 'broker_sync'");
    expect(UP14).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  });
  it("선행 조건: 002 가 없으면 멈추고, 롤백은 view 만 지운다(002 재실행 안내)", () => {
    expect(UP14).toContain("002(cash_balance)가 먼저 적용돼야 합니다");
    expect(DOWN14.trim()).toBe("drop view if exists public.kaw_portfolio_live_view;");
    expect(read("../../../migrations/014_live_view_broker_sync_rollback.sql")).toContain("002_cash_balance.sql");
  });
  it("데이터를 쓰지 않는다 — view 정의뿐", () => {
    expect(UP14).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate)\b/i);
  });
});
