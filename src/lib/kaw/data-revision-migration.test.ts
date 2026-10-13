/**
 * migration 007 의 **원자성·보존·권한 모델**을 고정한다.
 *
 * 006 의 같은 테스트와 이유가 같다: `for update` 가 빠지면 함수는 그대로 돌아가고
 * 단일 연결 테스트도 통과하는데 **동시 저장에서 한쪽 변경이 사라진다.** 여기에 007
 * 고유의 불변식이 더해진다 —
 *
 *   · 검사가 **전부 끝난 뒤에** 쓰기가 시작된다(부분 반영 금지)
 *   · `_assetLib` / `_family` 는 가드 화이트리스트에 **없다**
 *   · 예약 프로필(`_` 로 시작)을 거부한다
 *   · 파괴적 저장(history 축소 / 키 유실)의 기본값이 **거부**다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GUARDABLE_TYPES } from "./revision-guard";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../migrations/007_data_revision_guard.sql", import.meta.url)),
  "utf-8",
);
const ROLLBACK = readFileSync(
  fileURLToPath(new URL("../../../migrations/007_data_revision_guard_rollback.sql", import.meta.url)),
  "utf-8",
);

const EXEC = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const FN = "kaw_data_save_guarded";
const SIG = `public.${FN}(text, text, jsonb, boolean, boolean)`;

describe("migration 007 — 원자성", () => {
  it("대상 행을 **잠근다** (`for update`)", () => {
    expect(EXEC).toMatch(/for\s+update/i);
  });

  it("잠금이 검사·쓰기보다 앞선다", () => {
    const lock = EXEC.search(/for\s+update/i);
    const write = EXEC.search(/update\s+public\.kaw_data\b/i);
    expect(lock).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(write);
  });

  it("잠금 순서를 **account_type 으로 고정**한다 (교착 방지)", () => {
    const lockIdx = EXEC.search(/for\s+update/i);
    const before = EXEC.slice(Math.max(0, lockIdx - 400), lockIdx);
    expect(before).toMatch(/order\s+by\s+d\.account_type/i);
  });

  it("**충돌이면 쓰기 전에 돌아간다** (부분 반영 금지)", () => {
    const conflictReturn = EXEC.search(/'outcome',\s*'conflict'/i);
    const write = EXEC.search(/update\s+public\.kaw_data\b/i);
    expect(conflictReturn).toBeGreaterThan(-1);
    expect(conflictReturn).toBeLessThan(write);
  });

  it("쓰기 UPDATE 에 **CAS 조건이 다시** 들어 있다", () => {
    expect(EXEC).toMatch(/d\.revision\s*=\s*v_expected/i);
  });

  it("revision 을 증가시킨다 (클라이언트 값으로 덮지 않는다)", () => {
    expect(EXEC).toMatch(/revision\s*=\s*d\.revision\s*\+\s*1/i);
  });

  it("쓰기 블록이 예외에서 **되돌아간다** (일부만 반영된 저장을 남기지 않는다)", () => {
    // 검사 시점에 없던 행이 그 사이 생기는 경우. 블록 전체가 되돌아가야 한다.
    expect(EXEC).toMatch(/exception\s+when\s+unique_violation/i);
    const write = EXEC.search(/update\s+public\.kaw_data\b/i);
    const handler = EXEC.search(/when\s+unique_violation/i);
    expect(handler).toBeGreaterThan(write);
  });

  it("plpgsql 함수 하나로 처리한다 (여러 문장을 클라이언트가 이어 붙이지 않는다)", () => {
    expect(EXEC).toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}`, "i"));
    expect(EXEC).toMatch(/language\s+plpgsql/i);
  });
});

describe("migration 007 — 가드 범위", () => {
  it("화이트리스트가 `_meta` + 네 계좌다 (TS 상수와 같다)", () => {
    const m = /p_account_type\s+in\s*\(([^)]*)\)/i.exec(EXEC);
    expect(m).not.toBeNull();
    const types = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(types).toEqual([...GUARDABLE_TYPES]);
  });

  it("**가족 공용 / PIN 설정 행은 화이트리스트에 없다**", () => {
    const m = /p_account_type\s+in\s*\(([^)]*)\)/i.exec(EXEC)!;
    expect(m[1]).not.toMatch(/_assetLib|_family/);
  });

  it("예약 프로필(`_` 로 시작)을 거부한다", () => {
    expect(EXEC).toMatch(/left\(p_profile,\s*1\)\s*=\s*'_'/i);
  });

  it("행 개수 상한이 5다 (_meta + 네 계좌)", () => {
    expect(EXEC).toMatch(/jsonb_array_length\(p_rows\)\s*>\s*5/i);
  });

  it("006 이 먼저 적용됐는지 확인한다 (revision 컬럼 없으면 즉시 실패)", () => {
    expect(EXEC).toMatch(/column_name\s*=\s*'revision'/i);
    expect(EXEC).toMatch(/raise\s+exception\s+'kaw_data\.revision 이 없습니다/);
  });

  it("006 의 merge 함수를 수정하지 않는다", () => {
    expect(EXEC).not.toMatch(/kaw_data_merge_history/i);
  });

  it("kaw_data 를 drop/alter 하지 않는다 (컬럼 추가도 006 의 몫이다)", () => {
    expect(EXEC).not.toMatch(/drop\s+table/i);
    expect(EXEC).not.toMatch(/alter\s+table\s+public\.kaw_data\b/i);
    expect(EXEC).not.toMatch(/delete\s+from\s+public\.kaw_data\b/i);
  });
});

describe("migration 007 — 파괴적 저장 방어", () => {
  it("기본값이 **거부**다 (allow 플래그가 둘 다 false)", () => {
    expect(EXEC).toMatch(/p_allow_history_shrink\s+boolean\s+default\s+false/i);
    expect(EXEC).toMatch(/p_allow_key_loss\s+boolean\s+default\s+false/i);
  });

  it("history 축소를 id 기준으로 찾는다", () => {
    expect(EXEC).toMatch(/'history_shrink'/);
    expect(EXEC).toMatch(/missing_history_ids/);
  });

  it("최상위 키 유실을 찾는다", () => {
    expect(EXEC).toMatch(/'key_loss'/);
    expect(EXEC).toMatch(/jsonb_object_keys\(v_cur_data\)/i);
  });

  it("축소·유실도 **충돌로** 돌려준다 (조용히 덮지 않는다)", () => {
    for (const reason of ["history_shrink", "key_loss"]) {
      const idx = EXEC.indexOf(`'${reason}'`);
      expect(EXEC.slice(Math.max(0, idx - 300), idx)).toMatch(/v_conflicts\s*:=\s*v_conflicts\s*\|\|/);
    }
  });
});

describe("migration 007 — 권한", () => {
  it("함수 권한을 네 주체에서 먼저 전부 회수한다", () => {
    expect(EXEC).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}\\([^)]*\\)\\s*from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ),
    );
  });

  it("revoke 가 grant 보다 앞선다", () => {
    const revoke = EXEC.search(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}`, "i"));
    const grant = EXEC.search(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}`, "i"));
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(-1);
    expect(revoke).toBeLessThan(grant);
  });

  it("service_role 에만 execute 를 준다", () => {
    expect(EXEC).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}[\\s\\S]{0,120}to\\s+service_role`, "i"));
    expect(EXEC).not.toMatch(/grant[^;]*to\s+(anon|authenticated|public)\b/i);
  });

  it("security definer 가 아니다", () => {
    expect(EXEC).toMatch(/security\s+invoker/i);
    expect(EXEC).not.toMatch(/security\s+definer/i);
  });

  it("search_path 를 고정한다", () => {
    expect(EXEC).toMatch(/set\s+search_path\s*=/i);
  });

  it("kaw_data 테이블 권한은 건드리지 않는다", () => {
    expect(EXEC).not.toMatch(/(revoke|grant)[^;]*on\s+(table\s+)?public\.kaw_data\b/i);
  });
});

describe("migration 007 — 멱등", () => {
  it("함수가 create or replace 다", () => {
    expect(EXEC).not.toMatch(new RegExp(`create\\s+function\\s+public\\.${FN}`, "i"));
  });

  it("서명이 문서·검증 쿼리와 일치한다", () => {
    expect(EXEC).toContain(SIG);
    expect(SQL).toMatch(/kaw_data_save_guarded\(text,text,jsonb,boolean,boolean\)/);
  });
});

describe("007 rollback", () => {
  it("실행문이 전부 주석 처리돼 있다", () => {
    const live = ROLLBACK.split("\n").filter(
      (l) => l.trim() !== "" && !l.trimStart().startsWith("--"),
    );
    expect(live).toEqual([]);
  });

  it("**클라이언트 가드를 먼저 끄라고** 못박는다 (순서가 거꾸로면 저장이 503 이 된다)", () => {
    expect(ROLLBACK).toMatch(/VITE_KAW_DATA_REVISION_GUARD|feature flag/);
  });

  it("006 의 merge 함수와 revision 컬럼은 지우지 않는다", () => {
    expect(ROLLBACK).toMatch(/kaw_data_merge_history[\s\S]{0,120}지우지\s*않는다/);
    expect(ROLLBACK).not.toMatch(/^\s*alter\s+table\s+public\.kaw_data\s+drop/im);
  });

  it("계좌 데이터는 롤백으로 사라지지 않는다고 적어 둔다", () => {
    expect(ROLLBACK).toMatch(/kaw_data[\s\S]{0,200}그대로/);
  });
});
