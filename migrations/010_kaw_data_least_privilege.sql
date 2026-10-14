-- ─────────────────────────────────────────────────────────────────────────────
-- kaw_data 최소 권한 — migration 010 (초안)
--
-- 상태: **작성만 했고 적용하지 않았다.**
--
-- 배경(운영 읽기 전용 점검 결과):
--   · kaw_data 는 대시보드에서 만든 테이블이라 마이그레이션이 권한을 정리한 적이 없다
--   · RLS 는 켜져 있지만 정책 `authenticated_access` 가 FOR ALL TO authenticated
--     USING (true) WITH CHECK (true) — Supabase Auth 로 로그인한 **누구든** 모든 가족의
--     문서를 읽고 고칠 수 있는 정책이다
--   · anon / authenticated 에 테이블 권한이 넓게 남아 있다
--
-- 앱은 kaw_data 에 **브라우저에서 직접 접근하지 않는다.** 모든 접근은 Worker 의 /api/* 가
-- service_role(신규 sb_secret 키)로 한다(현재 배포본 3660938 포함 — supabase-js 를 import 하는
-- 파일은 서버 모듈뿐). 그래서 anon/authenticated 권한과 위 정책은 **앱에 필요 없다.**
--
-- service_role 에 남기는 권한:
--   select / insert / update  — /api/data upsert, 006 병합 RPC, 007 가드 저장(security invoker)
--   delete                    — 프로필 삭제(관리자 동작, data-server.ts)
--   truncate / references / trigger 는 주지 않는다
--
-- RLS 는 **켠 채로 둔다**(정책 0개 = anon/authenticated 는 행이 하나도 안 보인다).
-- service_role 은 BYPASSRLS 라 영향이 없다.
--
-- 실행: 사용자 승인 후 SQL Editor 에서 전체 실행. 멱등하다. 005~009 와 순서 무관(독립)이다.
--       **4절은 실행 시점에 있는 kaw_* 객체만 정리한다.** 010 을 005~009 보다 먼저 적용했다면
--       각 migration 이 스스로 회수하지만, 마지막 migration 뒤에 010 을 한 번 더 실행하거나
--       010_kaw_data_least_privilege_verify.sql 로 anon/authenticated 권한 0 을 확인한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. 넓은 정책 제거 (이름이 다르면 아래 점검 쿼리 (a) 로 확인하고 같은 방식으로 지운다)
drop policy if exists authenticated_access on public.kaw_data;

-- 2. RLS 유지
alter table public.kaw_data enable row level security;

-- 3. 권한: 전부 회수 후 service_role 에만 필요한 것
revoke all on public.kaw_data from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.kaw_data to service_role;

-- 4. 같은 스키마의 다른 kaw_* 객체도 anon/authenticated 접근을 회수한다(방어적 정리).
--    001~009 가 각자 회수했지만, 대시보드에서 만든 객체나 기본 권한으로 생긴 것까지 정리한다.
do $$
declare r record;
begin
  for r in
    select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname like 'kaw\_%' and c.relkind in ('r','v','m','S','p')
  loop
    execute format('revoke all on %s public.%I from anon, authenticated',
      case when r.relkind = 'S' then 'sequence' else 'table' end, r.relname);
  end loop;
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'kaw\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    -- PUBLIC 을 회수하면 service_role 도 PUBLIC 경유 EXECUTE 를 잃는다. 앱이 쓰는 함수
    -- (001 kaw_price_stale_seconds — live view 가 호출, 006·007·009 RPC)는 service_role 이
    -- 계속 실행할 수 있어야 하므로 **명시적으로** 준다(Supabase 기본 권한에 기대지 않는다).
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- 5. (선택 · 주석) 앞으로 만들 객체의 기본 권한. 이 Supabase 프로젝트를 다른 앱이 함께 쓰면
--    영향이 생기므로 확인 후에만 푼다.
-- alter default privileges in schema public revoke all on tables    from anon, authenticated;
-- alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 점검 (적용 전후 SQL Editor 에서 하나씩. 전부 주석)
-- ─────────────────────────────────────────────────────────────────────────────
-- (a) kaw_data 정책 — 적용 후 0 행
--   select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='kaw_data';
-- (b) 권한 — anon/authenticated 전부 f, service_role 은 sel/ins/upd/del t · trunc f
--   select r, has_table_privilege(r,'public.kaw_data','SELECT') sel, has_table_privilege(r,'public.kaw_data','INSERT') ins,
--          has_table_privilege(r,'public.kaw_data','UPDATE') upd, has_table_privilege(r,'public.kaw_data','DELETE') del,
--          has_table_privilege(r,'public.kaw_data','TRUNCATE') trunc
--     from unnest(array['anon','authenticated','service_role']) r;
-- (c) 다른 kaw_* 객체에 anon/authenticated 권한이 남았는가 — 0 행
--   select table_name, grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name like 'kaw\_%' and grantee in ('anon','authenticated');
-- (d) 앱 동작: 로그인 → 계좌 화면 로드(GET /api/data) → 값 하나 저장 → 새로고침 후 유지
