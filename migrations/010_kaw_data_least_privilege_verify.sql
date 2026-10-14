-- 010 적용 직후 검증 (SELECT 전용 · 아무것도 쓰지 않음) — 결과는 JSON 한 칸
-- 기대값: policies 0 · rls true · anon/authenticated 전부 false · service_role sel/ins/upd/del true, trunc false
--         kaw_grants_to_public_roles 0 · fn_exec 의 anon/authenticated false, service_role true
select jsonb_pretty(jsonb_build_object(
  'kaw_data_rls', (select relrowsecurity from pg_class where oid = 'public.kaw_data'::regclass),
  'kaw_data_policies', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'kaw_data'),
  'kaw_data_privileges', (select jsonb_object_agg(r, jsonb_build_object(
      'sel', has_table_privilege(r, 'public.kaw_data', 'SELECT'),
      'ins', has_table_privilege(r, 'public.kaw_data', 'INSERT'),
      'upd', has_table_privilege(r, 'public.kaw_data', 'UPDATE'),
      'del', has_table_privilege(r, 'public.kaw_data', 'DELETE'),
      'trunc', has_table_privilege(r, 'public.kaw_data', 'TRUNCATE')))
    from unnest(array['anon', 'authenticated', 'service_role']) r),
  'kaw_grants_to_public_roles', (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name like 'kaw\_%' and grantee in ('anon', 'authenticated', 'PUBLIC')),
  'fn_exec', (select coalesce(jsonb_object_agg(p.proname, jsonb_build_object(
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'))), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'kaw\_%')
)) as verify_010;
