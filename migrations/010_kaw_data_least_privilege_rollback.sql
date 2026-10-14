-- ─────────────────────────────────────────────────────────────────────────────
-- 010 복구 절차 — **보안을 다시 열지 않는다**
--
-- 앱은 kaw_data 를 service_role(서버)로만 쓴다. 010 적용 뒤 앱이 읽기/쓰기에 실패한다면
-- 원인은 service_role 의 권한 부족이지, anon/authenticated 정책이 없어서가 아니다.
-- 그래서 복구는 **service_role 쪽만 넓힌다.** anon/authenticated 권한이나
-- `authenticated_access` 정책(FOR ALL USING true)을 되살리는 단계는 두지 않는다 —
-- 그것은 Supabase Auth 로 로그인한 누구에게나 모든 가족의 데이터를 여는 원래의 취약점이다.
--
-- 순서: 증상 확인 → 1단계 → 앱 확인 → 필요하면 2단계. 전부 주석(실수 실행 방지).
-- ─────────────────────────────────────────────────────────────────────────────

-- 증상 확인(읽기 전용): service_role 권한 표 — 010_kaw_data_least_privilege_verify.sql 참고
--   select has_table_privilege('service_role','public.kaw_data','SELECT'),
--          has_table_privilege('service_role','public.kaw_data','INSERT'),
--          has_table_privilege('service_role','public.kaw_data','UPDATE'),
--          has_table_privilege('service_role','public.kaw_data','DELETE');

-- 1단계: kaw_data 의 service_role 권한 복원(010 이 회수한 범위 안에서)
-- grant select, insert, update, delete on public.kaw_data to service_role;

-- 2단계: kaw_* 함수의 service_role 실행 권한 복원
-- do $$ declare r record; begin
--   for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--             where n.nspname = 'public' and p.proname like 'kaw\_%'
--   loop execute format('grant execute on function %s to service_role', r.sig); end loop;
-- end $$;

-- 그래도 안 되면 DB 를 되돌리지 말고 서버 로그(Worker)의 오류 코드를 먼저 확인한다.
-- 42501(권한) 이 아니라면 010 과 무관한 문제다.
