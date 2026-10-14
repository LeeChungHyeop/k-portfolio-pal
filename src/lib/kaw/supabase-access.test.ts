/**
 * Supabase 접근 경계 회귀 테스트.
 *
 *   1. 브라우저 코드는 Supabase 에 직접 붙지 않는다 — supabase-js 는 서버 모듈만 import 한다
 *   2. `import.meta.env` 를 객체째(또는 변수 키로) 읽지 않는다 — 그러면 Vite 가 .env 의 모든
 *      VITE_* 값(쓰지 않는 Supabase 키 포함)을 클라이언트 번들에 박는다
 *   3. migration 010 은 kaw_data 의 넓은 정책을 지우고 service_role 에만 필요한 권한을 남긴다
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f));
const rel = (f: string) => path.relative(SRC, f).replaceAll("\\", "/");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** supabase-js 를 써도 되는 서버 전용 모듈(Worker 에서만 import 된다) */
const SERVER_MODULES = new Set([
  "lib/kaw/data-server.ts", "lib/kaw/history-server.ts", "lib/kaw/ledger-import-core.ts",
  "lib/kaw/ledger-server.ts", "lib/kaw/order-store.ts", "lib/kaw/plan-server.ts",
]);

describe("Supabase 접근 경계", () => {
  it("supabase-js 는 서버 모듈만 import 한다", () => {
    const users = files.filter((f) => readFileSync(f, "utf8").includes("@supabase/supabase-js")).map(rel);
    expect(users.filter((f) => !SERVER_MODULES.has(f))).toEqual([]);
  });

  it("컴포넌트·라우트는 서버 모듈을 import 하지 않는다", () => {
    const ui = files.filter((f) => /\/(components|routes)\//.test(f.replaceAll("\\", "/")));
    for (const f of ui) {
      const s = readFileSync(f, "utf8");
      for (const m of SERVER_MODULES) {
        const base = path.basename(m, ".ts");
        expect(s, rel(f)).not.toMatch(new RegExp(`from ["'][^"']*${base}["']`));
      }
    }
  });

  it("**import.meta.env 를 객체째·변수 키로 읽지 않는다**(번들에 VITE_* 전체가 박힌다)", () => {
    const offenders = files.filter((f) => {
      const s = strip(readFileSync(f, "utf8"));
      return /import\.meta\.env\s*(as\b|\)|\[|;|,)/.test(s) || /\(import\.meta as [^)]*\)\.env/.test(s);
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  it("클라이언트 코드는 VITE_SUPABASE_* 를 읽지 않는다", () => {
    expect(files.filter((f) => strip(readFileSync(f, "utf8")).includes("VITE_SUPABASE")).map(rel)).toEqual([]);
  });
});

describe("010_kaw_data_least_privilege.sql", () => {
  const sql = readFileSync(fileURLToPath(new URL("../../../migrations/010_kaw_data_least_privilege.sql", import.meta.url)), "utf8");
  const live = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("넓은 정책을 지우고 RLS 는 유지한다", () => {
    expect(live).toMatch(/drop policy if exists authenticated_access on public\.kaw_data/);
    expect(live).toMatch(/alter table public\.kaw_data enable row level security/);
    expect(live).not.toMatch(/disable row level security|create policy/i);
  });

  it("전부 회수한 뒤 service_role 에만 select/insert/update/delete", () => {
    const revoke = live.indexOf("revoke all on public.kaw_data from public, anon, authenticated, service_role");
    const grant = live.indexOf("grant select, insert, update, delete on public.kaw_data to service_role");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(live).not.toMatch(/grant[^;]*\b(truncate|all)\b[^;]*kaw_data/i);
    expect(live).not.toMatch(/grant[^;]*(anon|authenticated)/);
  });

  it("함수: PUBLIC·anon·authenticated 회수 후 service_role 에 EXECUTE 를 명시적으로 준다", () => {
    const revokeFn = live.indexOf("revoke all on function %s from public, anon, authenticated");
    const grantFn = live.indexOf("grant execute on function %s to service_role");
    expect(revokeFn).toBeGreaterThan(-1);
    expect(grantFn).toBeGreaterThan(revokeFn);
  });

  it("**복구 절차는 보안을 다시 열지 않는다** — anon/authenticated 권한·넓은 정책 복원 단계가 없다(주석 포함)", () => {
    const rb = readFileSync(fileURLToPath(new URL("../../../migrations/010_kaw_data_least_privilege_rollback.sql", import.meta.url)), "utf8");
    expect(rb).not.toMatch(/grant[^\n;]*to[^\n;]*\b(anon|authenticated)\b/i);
    expect(rb).not.toMatch(/create policy/i);
    expect(rb).toMatch(/grant select, insert, update, delete on public\.kaw_data to service_role/);
  });

  it("적용 직후 검증 SQL 은 SELECT 전용이다", () => {
    const v = readFileSync(fileURLToPath(new URL("../../../migrations/010_kaw_data_least_privilege_verify.sql", import.meta.url)), "utf8");
    // 문자열 리터럴(권한 이름 'INSERT' 등)은 빼고 SQL 키워드만 본다
    const code = v.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/'[^']*'/g, "''");
    expect(code.trim()).toMatch(/^select /);
    expect(code).not.toMatch(/\b(insert|update|delete|grant|revoke|alter|drop|create|truncate)\b/i);
  });

  it("기본 권한 변경은 주석(선택)이고 롤백은 전부 주석이다", () => {
    expect(live).not.toMatch(/alter default privileges/);
    const rb = readFileSync(fileURLToPath(new URL("../../../migrations/010_kaw_data_least_privilege_rollback.sql", import.meta.url)), "utf8");
    expect(rb.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).toBe("");
  });
});
