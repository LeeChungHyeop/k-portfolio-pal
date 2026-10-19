-- ─────────────────────────────────────────────────────────────────────────────
-- 한국투자 실제 체결 → 거래원장 원자 반영 — migration 012 (Phase 4-C-2)
--
-- 상태: **작성만 했고 적용하지 않았다.** 004(원장·batch·audit)와 011이 먼저 적용돼 있어야 한다.
--       이 함수가 없는 동안 서버의 반영 API 는 쓰지 않고 503 `apply_unavailable` 을 돌려준다.
--
-- 왜 필요한가: 기존 적재(ledger-import-core)는 원장 행을 PostgREST 한 번(한 트랜잭션)으로 넣고
--       **그 다음에 별도 문장으로** batch 이력을 넣는다. 그 사이에 실패하면 원장은 들어갔는데
--       provenance(batch)와 승인 감사 기록이 없는 상태가 남는다(import_batch_id 는 FK 가 없고
--       원장은 immutable 이라 고칠 수 없다). 체결 반영은 사용자가 승인한 행위라 **원장 행 + batch +
--       승인 감사가 전부 들어가거나 전부 안 들어가야** 한다. 한 종목만 반영되는 상태도 허용하지 않는다.
--
-- ── 이 함수가 한 트랜잭션에서 하는 일 ────────────────────────────────────────
--
--   0. (가족, 프로필) 단위 advisory lock 으로 동시 호출을 직렬화한다
--   1. 입력 모양 검증 — 출처·fingerprint 규칙·매수·수량/가격/금액>0·수수료/세금/거래후잔고 NULL
--   2. 멱등: 같은 fingerprint 가 전부 이미 있으면 **아무것도 쓰지 않고** already_applied
--            일부만 있으면(부분 반영 상태) 예외 — 자동으로 이어 붙이지 않는다
--   3. DB 기준 사전 조건 재확인(앱의 판단을 믿지 않는다):
--        · 사용자가 확정한 계좌 이전(audit transfer_confirm)이 있다
--        · 이 가족·프로필에 거래 정정(overlay)이 없다
--        · 이전 증권사 출처 원장 보유가 계좌 전체에서 0 이다
--   4. batch 1행 + 원장 N행 + 승인 감사 1행을 INSERT 한다
--   5. **반영 후 원장 재생 보유 == 서버가 넘긴 한국투자 관측 보유**를 같은 트랜잭션 안에서 확인한다.
--      다르면 예외 → 위의 모든 INSERT 가 롤백된다
--
-- ── 하지 않는 것 ────────────────────────────────────────────────────────────
--
--   · UPDATE / DELETE 를 하지 않는다. 기존 원장·batch·audit 행을 건드리지 않는다
--   · cashflow(납입원금) · kaw_data · 보유수량/예수금 설정 · 스냅샷을 건드리지 않는다
--   · 수수료·세금을 만들지 않는다(NULL). 예수금 차이를 보정하는 거래를 만들지 않는다
--   · 매도 체결을 받지 않는다(이번 단계는 매수만 — 일중 순서 근거가 없다)
--
-- ── 보안 ────────────────────────────────────────────────────────────────────
--
--   · `security invoker` — 호출자의 권한으로만 동작한다. service_role 의 기존 권한(원장·batch·audit 에
--     SELECT/INSERT)을 쓸 뿐 새 권한을 주지 않는다. `security definer` 는 쓰지 않는다
--   · EXECUTE 는 PUBLIC · anon · authenticated 에서 **명시적으로 회수**하고 service_role 에만 부여한다.
--     (Supabase 는 public 스키마의 새 함수에 anon/authenticated/service_role EXECUTE 기본 권한을 붙이므로
--     create 뒤의 revoke 가 필수다.)
--   · **함수 자체도 호출자 역할을 확인한다**(`pg_has_role(current_user, 'service_role', 'member')`).
--     권한 설정이 어긋나거나 나중에 누가 grant 를 잘못 줘도 anon/authenticated 는 함수 안에서 거부된다
--   · `search_path` 는 `pg_catalog` 하나로 고정하고 모든 테이블은 `public.` 으로 명시한다 —
--     public 스키마에 같은 이름의 객체를 만들어도 이 함수의 해석이 바뀌지 않는다
--   · 함수 생성 · 권한 회수 · 권한 부여가 **한 번의 스크립트 실행(암묵적 단일 트랜잭션)** 안에 있다.
--     중간에 실패하면 함수 자체가 남지 않는다(권한이 덜 설정된 함수가 노출되는 순간이 없다)
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- 되돌리기: 012_kis_execution_apply_rollback.sql (함수만 지운다. 이미 반영된 행은 그대로다)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.kaw_transaction_ledger') is null
     or to_regclass('public.kaw_ledger_import_batch') is null
     or to_regclass('public.kaw_ledger_audit') is null
     or to_regclass('public.kaw_transaction_correction') is null then
    raise exception '004 의 원장/batch/audit/correction 테이블이 없습니다. 012 를 적용하지 않았습니다.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'kaw_ledger_audit'
                  and indexname = 'kaw_ledger_audit_transfer_confirm_uq') then
    raise exception '011(kaw_ledger_audit_transfer_confirm_uq) 이 먼저 적용돼야 합니다. 012 를 적용하지 않았습니다.';
  end if;
end $$;

create or replace function public.kaw_kis_execution_apply(
  p_family_code text,
  p_profile     text,
  p_batch       jsonb,
  p_rows        jsonb,
  p_audit       jsonb,
  p_expect      jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  c_source constant text := 'kis_api_daily_ccld';
  c_max_rows constant integer := 20;
  v_batch_id text := p_batch->>'id';
  v_instance text := p_expect->>'instance_id';
  v_actor    text := p_audit->>'actor';
  v_n        integer;
  v_existing integer;
  v_fps      text[];
  v_row      jsonb;
  v_after    jsonb;
begin
  -- 0-a. 호출자 역할 확인 — EXECUTE 권한과 별개의 두 번째 방어선. service_role(또는 그 멤버/소유자)만 통과한다.
  if not pg_catalog.pg_has_role(current_user, 'service_role', 'member') then
    raise exception 'KAW_KIS_APPLY:forbidden' using errcode = '42501', detail = 'only service_role may call this function';
  end if;

  -- 0-b. 직렬화 — 같은 (가족, 프로필)의 반영은 한 번에 하나만
  perform pg_advisory_xact_lock(hashtextextended('kaw_kis_execution_apply|' || coalesce(p_family_code, '') || '|' || coalesce(p_profile, ''), 0));

  -- 1. 입력 모양
  if coalesce(p_family_code, '') = '' or coalesce(p_profile, '') = '' or coalesce(v_batch_id, '') = ''
     or coalesce(v_instance, '') = '' or coalesce(v_actor, '') = '' or v_actor is distinct from p_profile then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'family/profile/batch id/instance/actor required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'rows must be an array';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n < 1 or v_n > c_max_rows then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'row count out of range';
  end if;
  if p_expect->'holdings_after' is null or jsonb_typeof(p_expect->'holdings_after') <> 'object' then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'expected holdings required';
  end if;
  if jsonb_typeof(p_audit->'new_value') <> 'object' then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'audit new_value required';
  end if;
  if coalesce(p_batch->>'source_kind', '') = '' then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'batch source_kind required';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row->>'source' is distinct from c_source
       or v_row->>'account_type' is distinct from 'pension'
       or v_row->>'side' is distinct from 'buy'
       or v_row->>'fingerprint_version' is distinct from '2'
       or coalesce(v_row->>'source_fingerprint', '') not like 'v2|' || c_source || '|' || v_instance || '|%'
       or coalesce(v_row->>'id', '') not like 'kisx:%'
       or v_row->>'import_batch_id' is distinct from v_batch_id
       or v_row->>'trade_date_evidence' is distinct from 'broker-order-date'
       or v_row->>'trade_date' is null
       or v_row->>'event_date' is distinct from v_row->>'trade_date'
       or v_row->>'settlement_date' is not null
       or v_row->>'inferred_trade_date' is not null
       or v_row->>'fee' is not null
       or v_row->>'tax' is not null
       or v_row->>'post_quantity' is not null
       or coalesce((v_row->>'quantity')::numeric, 0) <= 0
       or coalesce((v_row->>'price')::numeric, 0) <= 0
       or coalesce((v_row->>'amount')::numeric, 0) <= 0 then
      raise exception 'KAW_KIS_APPLY:invalid_row' using errcode = 'P0001', detail = 'row violates the KIS buy-execution contract';
    end if;
  end loop;

  select array_agg(r->>'source_fingerprint') into v_fps from jsonb_array_elements(p_rows) r;
  if (select count(distinct f) from unnest(v_fps) f) <> v_n then
    raise exception 'KAW_KIS_APPLY:invalid_input' using errcode = 'P0001', detail = 'duplicate fingerprints in request';
  end if;

  -- 2. 멱등 · 부분 반영 상태
  select count(*) into v_existing
    from public.kaw_transaction_ledger
   where family_code = p_family_code and profile = p_profile and source_fingerprint = any (v_fps);
  if v_existing = v_n then
    return jsonb_build_object('status', 'already_applied', 'inserted', 0, 'batch_id', v_batch_id);
  elsif v_existing > 0 then
    raise exception 'KAW_KIS_APPLY:partial_conflict' using errcode = 'P0001', detail = 'some of these executions are already in the ledger';
  end if;

  -- 3. DB 기준 사전 조건 (앱의 판단을 믿지 않는다)
  if not exists (
    select 1 from public.kaw_ledger_audit
     where family_code = p_family_code and profile = p_profile
       and action = 'transfer_confirm' and target_id = 'transfer:' || v_instance
  ) then
    raise exception 'KAW_KIS_APPLY:transfer_unconfirmed' using errcode = 'P0001', detail = 'no confirmed account transfer for this instance';
  end if;

  if exists (select 1 from public.kaw_transaction_correction where family_code = p_family_code and profile = p_profile) then
    raise exception 'KAW_KIS_APPLY:corrections_present' using errcode = 'P0001', detail = 'transaction corrections exist';
  end if;

  if exists (
    select 1 from (
      select ticker, sum(case when side = 'buy' then quantity else -quantity end) as q
        from public.kaw_transaction_ledger
       where family_code = p_family_code and profile = p_profile and account_type = 'pension' and source <> c_source
       group by ticker
    ) t where t.q <> 0
  ) then
    raise exception 'KAW_KIS_APPLY:prior_residual' using errcode = 'P0001', detail = 'prior broker holdings are not fully exited in the ledger';
  end if;

  -- 4. 쓰기 — batch 1행 + 원장 N행 + 승인 감사 1행
  insert into public.kaw_ledger_import_batch
    (id, family_code, profile, source_kind, source_label, source_checksum, inserted_count, skipped_count, verification, actor)
  values
    (v_batch_id, p_family_code, p_profile, p_batch->>'source_kind', p_batch->>'source_label', p_batch->>'source_checksum',
     v_n, 0, p_batch->'verification', v_actor);

  insert into public.kaw_transaction_ledger
    (family_code, profile, id, account_type, ticker, etf_name, side, quantity, price, amount,
     trade_date, settlement_date, inferred_trade_date, event_date, trade_date_evidence,
     fee, tax, post_quantity, source, source_file, source_row, source_fingerprint, fingerprint_version, import_batch_id)
  select p_family_code, p_profile, r.id, r.account_type, r.ticker, r.etf_name, r.side, r.quantity, r.price, r.amount,
         r.trade_date, r.settlement_date, r.inferred_trade_date, r.event_date, r.trade_date_evidence,
         r.fee, r.tax, r.post_quantity, r.source, r.source_file, r.source_row, r.source_fingerprint, r.fingerprint_version, r.import_batch_id
    from jsonb_to_recordset(p_rows) as r(
      id text, account_type text, ticker text, etf_name text, side text, quantity numeric, price numeric, amount numeric,
      trade_date date, settlement_date date, inferred_trade_date date, event_date date, trade_date_evidence text,
      fee numeric, tax numeric, post_quantity numeric, source text, source_file text, source_row integer,
      source_fingerprint text, fingerprint_version integer, import_batch_id text);

  insert into public.kaw_ledger_audit
    (family_code, profile, actor, action, target_type, target_id, previous_value, new_value, note)
  values
    (p_family_code, p_profile, v_actor, 'kis_execution_apply', 'import', v_batch_id,
     p_audit->'previous_value', p_audit->'new_value', p_audit->>'note');

  -- 5. 반영 후 원장 재생 보유 == 기대(한국투자 관측) 보유. 다르면 위의 모든 INSERT 가 롤백된다.
  select coalesce(jsonb_object_agg(t.ticker, t.q), '{}'::jsonb) into v_after from (
    select ticker, sum(case when side = 'buy' then quantity else -quantity end) as q
      from public.kaw_transaction_ledger
     where family_code = p_family_code and profile = p_profile and account_type = 'pension'
     group by ticker
    having sum(case when side = 'buy' then quantity else -quantity end) <> 0
  ) t;
  if v_after is distinct from (p_expect->'holdings_after') then
    raise exception 'KAW_KIS_APPLY:holdings_mismatch' using errcode = 'P0001', detail = 'ledger replay after apply: ' || v_after::text;
  end if;

  return jsonb_build_object('status', 'applied', 'inserted', v_n, 'batch_id', v_batch_id, 'holdings_after', v_after);
end;
$$;

revoke all on function public.kaw_kis_execution_apply(text, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.kaw_kis_execution_apply(text, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;

comment on function public.kaw_kis_execution_apply(text, text, jsonb, jsonb, jsonb, jsonb) is
  '한국투자 실제 체결(매수)을 거래원장에 원자적으로 반영한다. batch + 원장 N행 + 승인 감사를 한 트랜잭션으로 쓰고, 반영 후 원장 재생 보유가 기대(관측) 보유와 다르면 전부 롤백한다. 같은 fingerprint 가 이미 있으면 아무것도 쓰지 않는다(멱등). security invoker — service_role 의 기존 SELECT/INSERT 권한만 쓴다.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩. 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 함수 존재 · security invoker(prosecdef=f) · search_path 고정
--   select proname, prosecdef, proconfig from pg_proc
--    where proname = 'kaw_kis_execution_apply' and pronamespace = 'public'::regnamespace;
--
-- (b) 역할별 EXECUTE — service_role = t, anon = f, authenticated = f
--   select r, has_function_privilege(r, 'public.kaw_kis_execution_apply(text,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') as can_execute
--     from unnest(array['service_role','anon','authenticated']) r;
--
-- (b2) 권한 부여 대상 전체 — PUBLIC(grantee = 0)이 **없어야** 한다. 소유자 외에는 service_role 만 보여야 한다
--   select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
--     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
--    where p.proname = 'kaw_kis_execution_apply' and p.pronamespace = 'public'::regnamespace
--    order by 1;
--
-- (b3) 기존 RLS 와 테이블 권한이 그대로다 — relrowsecurity = t 이고 service_role 은 원장에 SELECT/INSERT 만
--   select relname, relrowsecurity from pg_class
--    where oid in ('public.kaw_transaction_ledger'::regclass, 'public.kaw_ledger_import_batch'::regclass, 'public.kaw_ledger_audit'::regclass);
--   select has_table_privilege('service_role','public.kaw_transaction_ledger','UPDATE') upd,
--          has_table_privilege('service_role','public.kaw_transaction_ledger','DELETE') del,
--          has_table_privilege('service_role','public.kaw_transaction_ledger','INSERT') ins;
--
-- (c) 기존 행이 바뀌지 않았다 — 적용 전후 건수가 같다
--   select (select count(*) from public.kaw_transaction_ledger) ledger,
--          (select count(*) from public.kaw_ledger_import_batch) batches,
--          (select count(*) from public.kaw_ledger_audit) audits;
