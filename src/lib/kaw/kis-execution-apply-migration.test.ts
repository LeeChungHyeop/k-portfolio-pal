/**
 * migration 012 — 한국투자 체결 원장 원자 반영 RPC (파일 수준 보증)
 *
 * 실제 Postgres 엔진(PGlite)에서 004 → 011 → 012 를 순서대로 적용하고 service_role(SELECT/INSERT 만) 권한으로
 * 실행한 38건의 검증(정상 반영 · 멱등 · 부분 반영 거부 · 사전 조건 · 반영 후 보유 불일치 전체 롤백 · 행 계약 위반 ·
 * 동시 5회 호출 시 1회 반영 · UPDATE/DELETE 불가 유지)은 별도 스크립트로 수행했다.
 * 이 테스트는 저장소의 파일이 그 계약과 TypeScript 쪽 상수에서 어긋나지 않는지 고정한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KIS_APPLY_AUDIT_ACTION, KIS_APPLY_MAX_ROWS, KIS_APPLY_SOURCE_KIND, ledgerInsertRow } from "./kis-ledger-apply";
import { KIS_FINGERPRINT_VERSION, KIS_LEDGER_SOURCE, kisExecutionFingerprint, type LedgerCandidate } from "./kis-execution-preview";
import { TRANSFER_AUDIT_ACTION } from "./account-transfer-record";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const UP = read("../../../migrations/012_kis_execution_apply.sql");
const DOWN = read("../../../migrations/012_kis_execution_apply_rollback.sql");
const sql = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const CODE = sql(UP);

describe("함수 정의", () => {
  it("security invoker + search_path 고정 + 인자 6개", () => {
    expect(CODE).toMatch(/create or replace function public\.kaw_kis_execution_apply\(\s*p_family_code text,\s*p_profile\s+text,\s*p_batch\s+jsonb,\s*p_rows\s+jsonb,\s*p_audit\s+jsonb,\s*p_expect\s+jsonb\s*\) returns jsonb/);
    expect(CODE).toContain("security invoker");
    expect(CODE).not.toMatch(/security definer/i);
    expect(CODE).toMatch(/set search_path = pg_catalog\r?\nas \$\$/);
  });

  it("실행 권한은 service_role 만 — public/anon/authenticated 회수", () => {
    expect(CODE).toMatch(/revoke all on function public\.kaw_kis_execution_apply\(text, text, jsonb, jsonb, jsonb, jsonb\)\s+from public, anon, authenticated;/);
    expect(CODE).toMatch(/grant execute on function public\.kaw_kis_execution_apply\(text, text, jsonb, jsonb, jsonb, jsonb\)\s+to service_role;/);
  });

  it("search_path 는 pg_catalog 하나로 고정하고 모든 테이블을 public. 으로 명시한다 (public 스키마 섀도잉 불가)", () => {
    expect(CODE).toMatch(/set search_path = pg_catalog\r?\nas \$\$/);
    expect(CODE).not.toMatch(/set search_path[^\r\n]*public/);
    // 함수 본문의 모든 테이블 참조는 스키마가 명시돼 있다
    const body = CODE.slice(CODE.indexOf("as $$"), CODE.lastIndexOf("$$;"));
    const tables = ["kaw_transaction_ledger", "kaw_ledger_import_batch", "kaw_ledger_audit", "kaw_transaction_correction"];
    let seen = 0;
    for (const t of tables) {
      for (const m of body.matchAll(new RegExp(t, "g"))) {
        seen++;
        expect(body.slice(m.index! - 7, m.index!), `${t}@${m.index}`).toBe("public.");
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it("함수 안에서 호출자 역할(service_role 멤버)을 확인하고, 그것이 가장 먼저 실행된다", () => {
    const g = CODE.indexOf("pg_catalog.pg_has_role(current_user, 'service_role', 'member')");
    expect(g).toBeGreaterThan(-1);
    expect(CODE.indexOf("KAW_KIS_APPLY:forbidden")).toBeGreaterThan(g);
    expect(g).toBeLessThan(CODE.indexOf("pg_advisory_xact_lock"));
    expect(CODE).toContain("errcode = '42501'");
  });

  it("승인자(actor)는 프로필과 같아야 한다", () => {
    expect(CODE).toContain("v_actor is distinct from p_profile");
  });

  it("생성 · 회수 · 부여가 같은 스크립트에 있고 명시적 트랜잭션 제어(begin/commit)를 쓰지 않는다 (SQL Editor · 마이그레이션 도구의 암묵적 단일 트랜잭션에 맡긴다)", () => {
    expect(CODE.indexOf("create or replace function")).toBeLessThan(CODE.indexOf("revoke all on function"));
    expect(CODE.indexOf("revoke all on function")).toBeLessThan(CODE.indexOf("grant execute on function"));
    expect(CODE).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
  });

  it("적용 후 검증 쿼리: 역할별 has_function_privilege · aclexplode 로 PUBLIC 부재 확인 · RLS/권한 불변", () => {
    expect(UP).toContain("has_function_privilege(r, 'public.kaw_kis_execution_apply(text,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')");
    expect(UP).toContain("aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))");
    expect(UP).toContain("PUBLIC(grantee = 0)이 **없어야**");
    expect(UP).toContain("relrowsecurity");
  });

  it("선행 조건: 004 테이블 4개와 011 인덱스가 없으면 적용을 멈춘다", () => {
    for (const t of ["kaw_transaction_ledger", "kaw_ledger_import_batch", "kaw_ledger_audit", "kaw_transaction_correction", "kaw_ledger_audit_transfer_confirm_uq"]) expect(CODE).toContain(t);
    expect(CODE).toContain("012 를 적용하지 않았습니다");
  });
});

describe("원자성 — 한 함수 안에서 검증 → 쓰기 → 반영 후 검증", () => {
  const ix = (t: string) => CODE.indexOf(t);
  it("순서: 직렬화 락 → 입력 검증 → 멱등 → DB 사전 조건 → INSERT 3종 → 반영 후 보유 검증", () => {
    const order = [
      "pg_advisory_xact_lock",
      "KAW_KIS_APPLY:invalid_row",
      "KAW_KIS_APPLY:partial_conflict",
      "KAW_KIS_APPLY:transfer_unconfirmed",
      "KAW_KIS_APPLY:corrections_present",
      "KAW_KIS_APPLY:prior_residual",
      "insert into public.kaw_ledger_import_batch",
      "insert into public.kaw_transaction_ledger",
      "insert into public.kaw_ledger_audit",
      "KAW_KIS_APPLY:holdings_mismatch",
    ].map(ix);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("데이터 변경은 INSERT 뿐이다 — UPDATE / DELETE / TRUNCATE / DROP 없음", () => {
    expect(CODE).not.toMatch(/\b(update\s+public|delete\s+from|truncate|drop\s+(table|index|constraint)|alter\s+table)\b/i);
  });

  it("cashflow · kaw_data · 스냅샷 · 주문 테이블을 건드리지 않는다", () => {
    expect(CODE).not.toMatch(/kaw_data|kaw_daily_portfolio_snapshots|kaw_order_/);
  });

  it("수수료 · 세금 · 거래후잔고 · 결제일 · 추정일이 NULL 이어야 하고 매수만 받는다", () => {
    for (const f of ["'fee'", "'tax'", "'post_quantity'", "'settlement_date'", "'inferred_trade_date'"]) expect(CODE).toContain(`v_row->>${f} is not null`);
    expect(CODE).toContain("v_row->>'side' is distinct from 'buy'");
  });
});

describe("TypeScript 쪽 계약과 같다", () => {
  const cand: LedgerCandidate = {
    accountId: "pension", accountInstanceId: "bai:kis", source: KIS_LEDGER_SOURCE,
    sourceFingerprint: kisExecutionFingerprint("bai:kis", "20261014", "0000006700"), fingerprintVersion: KIS_FINGERPRINT_VERSION,
    ticker: "360750", etfName: "TIGER", side: "buy", quantity: 230, price: 25985, amount: 5_976_550, tradeDate: "2026-10-14",
    settlementDate: null, inferredTradeDate: null, eventDate: "2026-10-14", tradeDateEvidence: "broker-order-date",
    fee: null, tax: null, postQuantity: null, granularity: "order", orderNo: "0000006700", origOrderNo: null,
  } as unknown as LedgerCandidate;

  it("출처 · fingerprint 버전 · 상한 · action 상수가 SQL 과 일치한다", () => {
    expect(CODE).toContain(`c_source constant text := '${KIS_LEDGER_SOURCE}'`);
    expect(CODE).toContain(`c_max_rows constant integer := ${KIS_APPLY_MAX_ROWS}`);
    expect(CODE).toContain(`'${KIS_APPLY_AUDIT_ACTION}'`);
    expect(CODE).toContain(`'${TRANSFER_AUDIT_ACTION}'`);
    expect(CODE).toContain(`like 'v${KIS_FINGERPRINT_VERSION}|'`);
    expect(CODE).toContain(`is distinct from '${KIS_FINGERPRINT_VERSION}'`);
    expect(KIS_APPLY_SOURCE_KIND).toBe("kis_api");
  });

  it("TS 가 만드는 행의 모든 키가 SQL INSERT 컬럼 목록에 있다 (누락 · 오타 방지)", () => {
    const cols = /insert into public\.kaw_transaction_ledger\s*\(([\s\S]*?)\)\s*select/.exec(CODE)![1].split(",").map((s) => s.trim());
    const row = ledgerInsertRow(cand, "imp:x");
    for (const k of Object.keys(row)) expect(cols, k).toContain(k);
    // 가족/프로필은 SQL 이 파라미터로 채우므로 TS 행에는 없다
    expect(cols.slice(0, 2)).toEqual(["family_code", "profile"]);
    expect(Object.keys(row)).not.toContain("family_code");
  });

  it("TS 행이 SQL 행 계약 검사를 그대로 통과하는 모양이다", () => {
    const r = ledgerInsertRow(cand, "imp:x") as Record<string, unknown>;
    expect(r).toMatchObject({ source: "kis_api_daily_ccld", account_type: "pension", side: "buy", fingerprint_version: 2, trade_date_evidence: "broker-order-date", fee: null, tax: null, post_quantity: null, settlement_date: null, inferred_trade_date: null });
    expect(String(r.source_fingerprint)).toMatch(/^v2\|kis_api_daily_ccld\|bai:kis\|/);
    expect(String(r.id)).toMatch(/^kisx:/);
    expect(r.trade_date).toBe(r.event_date);
  });

  it("서버가 부르는 RPC 이름과 인자가 SQL 과 같다", () => {
    const server = read("./kis-ledger-apply-server.ts");
    expect(server).toContain('client.rpc("kaw_kis_execution_apply"');
    for (const p of ["p_family_code", "p_profile", "p_batch", "p_rows", "p_audit", "p_expect"]) {
      expect(server).toContain(`${p}:`);
      expect(CODE).toContain(p);
    }
    // 서버가 해석하는 오류 코드가 SQL 이 던지는 코드와 같다
    for (const c of ["transfer_unconfirmed", "prior_residual", "corrections_present", "holdings_mismatch", "partial_conflict", "invalid_row", "invalid_input"]) {
      expect(CODE, c).toContain(`KAW_KIS_APPLY:${c}`);
      expect(server, c).toContain(c);
    }
  });
});

describe("012 롤백", () => {
  it("함수만 지운다 — 이미 반영된 행은 건드리지 않는다", () => {
    expect(sql(DOWN).trim()).toBe("drop function if exists public.kaw_kis_execution_apply(text, text, jsonb, jsonb, jsonb, jsonb);");
  });
});
