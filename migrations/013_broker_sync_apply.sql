-- ─────────────────────────────────────────────────────────────────────────────
-- 계좌 상태 동기화(broker_sync) 원자 적용 — migration 013 (Phase 4-D)
--
-- 상태: **작성만 했고 적용하지 않았다.** 004 · 006 · 007 · 011 이 먼저 적용돼 있어야 한다.
--       이 함수가 없는 동안 서버의 동기화 API 는 쓰지 않고 503 `apply_unavailable` 을 돌려준다.
--
-- 왜 필요한가: 동기화는 (1) 계좌 문서(kaw_data)의 현재 보유수량·예수금·동기화 기록을 바꾸고 (2) 누가 언제 무엇을
--       승인했는지 감사 행을 남긴다. 두 쓰기를 따로 하면 문서만 바뀌고 감사가 없는(또는 그 반대) 상태가 남을 수 있다.
--       이 함수가 **한 트랜잭션**으로 처리한다 — 문서 저장은 기존 `kaw_data_save_guarded`(migration 007: revision CAS ·
--       키 손실 거부 · 이력 축소 거부)를 그대로 호출한다. 어느 단계든 실패하면 둘 다 취소된다.
--
-- ── 이 함수가 한 트랜잭션에서 하는 일 ────────────────────────────────────────
--
--   0. 호출자 역할 확인(service_role) · (가족, 프로필) advisory lock 으로 동시 호출 직렬화
--   1. 입력 모양 검증
--   2. 계좌 문서 행을 잠그고 revision 이 기대와 같은지 확인
--   3. 멱등: 같은 동기화 기록(id)이 이미 문서에 있으면 **아무것도 쓰지 않고** already_synced
--   4. DB 기준 사전 조건 재확인(앱의 판단을 믿지 않는다):
--        · 사용자가 확정한 계좌 이전(audit transfer_confirm)이 있다
--        · 거래 정정(overlay)이 없다
--        · 원장 재생 보유(연금저축 전 출처) == 서버가 넘긴 증권사 보유(종목별, 양방향 완전 일치)
--   5. **문서 diff 검증**: 새 문서가 허용된 5개 키(liveQuantities · rowHoldings · cashBalance ·
--      cashBalanceObservation · brokerSyncs) 말고는 **한 글자도** 바뀌지 않았다 —
--      history · cashflows · baseAmount · deposit · 그 밖의 모든 키가 현재 문서와 같아야 한다.
--      brokerSyncs 는 기존 항목이 그대로이고 새 항목 1건만 뒤에 붙었다
--   5-b. **새 기록 내부 값 정합성**: quantities ↔ liveQuantities ↔ p_expect.live_quantities, holdingsByTicker ↔ p_expect.holdings_by_ticker,
--      cash.amount ↔ cashBalance ↔ p_expect.cash_amount, cash.stateAsOf ↔ cashBalanceObservation.stateAsOf, cashBalanceObservation.syncId ↔ 새 기록 id,
--      cash/cashBalanceObservation 의 effectiveFrom = null, approvedBy = 감사 actor, 감사 new_value.id = 기록 id (어긋나면 record_mismatch 로 전부 취소)
--   6. `kaw_data_save_guarded` 로 저장(revision CAS). 'saved' 가 아니면 예외 → 전부 취소
--   7. 승인 감사 1행을 INSERT 한다 (action = 'broker_sync_apply', target = 'sync:<기록 id>@r<반영 직전 revision>').
--      같은 기록을 같은 revision 에서 두 번 승인하는 것은 부분 유니크 인덱스가 막는다. 백업 복구로 revision 이 바뀐 뒤에는
--      같은 상태도 다시 승인할 수 있고, 감사 이력에는 '승인 → (복구) → 재승인'이 모두 남는다(감사는 지우지 않는다)
--
-- ── 하지 않는 것 ────────────────────────────────────────────────────────────
--
--   · 거래원장 · cashflow · 이력(history) · 일별 스냅샷을 쓰지 않는다. 원장/스냅샷 테이블을 건드리지 않는다
--   · 현금 보정 거래 · 신규 납입 · 배당/이자 수입을 만들지 않는다
--   · DELETE / TRUNCATE 가 없다. 감사 테이블 권한을 바꾸지 않는다
--
-- ── 보안 ────────────────────────────────────────────────────────────────────
--   · `security invoker` · `search_path = pg_catalog` · 테이블/함수는 `public.` 명시
--   · EXECUTE 는 PUBLIC · anon · authenticated 에서 회수하고 service_role 에만 부여
--   · 함수 안에서도 호출자가 service_role 멤버인지 확인한다(권한 설정이 어긋나도 막힌다)
--   · 함수 생성 · 회수 · 부여 · 인덱스 생성이 한 스크립트(암묵적 단일 트랜잭션)에 있다
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- 되돌리기: 013_broker_sync_apply_rollback.sql (함수와 인덱스만 지운다. 이미 반영된 문서·감사는 그대로다)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.kaw_data') is null or to_regclass('public.kaw_ledger_audit') is null
     or to_regclass('public.kaw_transaction_ledger') is null or to_regclass('public.kaw_transaction_correction') is null then
    raise exception 'kaw_data / 원장 / audit / correction 테이블이 없습니다. 013 을 적용하지 않았습니다.';
  end if;
  if to_regprocedure('public.kaw_data_save_guarded(text,text,jsonb,boolean,boolean)') is null then
    raise exception 'kaw_data_save_guarded(007)가 없습니다. 013 을 적용하지 않았습니다.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'kaw_ledger_audit'
                  and indexname = 'kaw_ledger_audit_transfer_confirm_uq') then
    raise exception '011(kaw_ledger_audit_transfer_confirm_uq)이 먼저 적용돼야 합니다. 013 을 적용하지 않았습니다.';
  end if;
  -- 같은 동기화 기록이 이미 둘 이상 있으면 멈춘다(유니크 인덱스를 만들 수 없다)
  if exists (
    select 1 from public.kaw_ledger_audit where action = 'broker_sync_apply'
     group by family_code, profile, target_id having count(*) > 1
  ) then
    raise exception 'broker_sync_apply 감사가 중복된 그룹이 있습니다. 013 을 적용하지 않았습니다(데이터는 그대로).';
  end if;
end $$;

-- 같은 (가족, 프로필, 동기화 기록)의 승인 감사는 한 번만 — DB 수준 마지막 방어선
create unique index if not exists kaw_ledger_audit_broker_sync_uq
  on public.kaw_ledger_audit (family_code, profile, target_id)
  where action = 'broker_sync_apply';

comment on index public.kaw_ledger_audit_broker_sync_uq is
  '계좌 동기화(broker_sync_apply) 승인 감사는 같은 가족·프로필·동기화 기록(target_id) 당 한 번만. 부분 인덱스라 다른 action 의 audit 에는 영향이 없다.';

create or replace function public.kaw_broker_sync_apply(
  p_family_code text,
  p_profile     text,
  p_expect      jsonb,
  p_new_data    jsonb,
  p_audit       jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  c_allowed constant text[] := array['liveQuantities', 'rowHoldings', 'cashBalance', 'cashBalanceObservation', 'brokerSyncs'];
  v_instance text := p_expect->>'instance_id';
  v_record   text := p_expect->>'record_id';
  v_actor    text := p_audit->>'actor';
  v_expected integer;
  v_cur_rev  integer;
  v_cur      jsonb;
  v_old_syncs jsonb;
  v_new_syncs jsonb;
  v_n_old    integer;
  v_replay   jsonb;
  v_key      text;
  v_res      jsonb;
  v_rec      jsonb;
begin
  -- 0-a. 호출자 역할 확인
  if not pg_catalog.pg_has_role(current_user, 'service_role', 'member') then
    raise exception 'KAW_SYNC:forbidden' using errcode = '42501', detail = 'only service_role may call this function';
  end if;
  -- 0-b. 직렬화
  perform pg_advisory_xact_lock(hashtextextended('kaw_broker_sync_apply|' || coalesce(p_family_code, '') || '|' || coalesce(p_profile, ''), 0));

  -- 1. 입력 모양
  if coalesce(p_family_code, '') = '' or coalesce(p_profile, '') = '' or coalesce(v_instance, '') = '' or coalesce(v_record, '') = ''
     or coalesce(v_actor, '') = '' or v_actor is distinct from p_profile
     or p_expect->>'account_type' is distinct from 'pension'
     or jsonb_typeof(p_expect->'expected_revision') is distinct from 'number'
     or jsonb_typeof(p_expect->'holdings_by_ticker') is distinct from 'object'
     or jsonb_typeof(p_expect->'live_quantities') is distinct from 'object'
     or jsonb_typeof(p_expect->'cash_amount') is distinct from 'number'
     or jsonb_typeof(p_new_data) is distinct from 'object'
     or jsonb_typeof(p_audit->'new_value') is distinct from 'object' then
    raise exception 'KAW_SYNC:invalid_input' using errcode = 'P0001', detail = 'malformed arguments';
  end if;
  v_expected := (p_expect->>'expected_revision')::integer;
  if (p_expect->>'cash_amount')::numeric < 0 or (p_expect->>'cash_amount')::numeric <> trunc((p_expect->>'cash_amount')::numeric) then
    raise exception 'KAW_SYNC:invalid_input' using errcode = 'P0001', detail = 'cash must be a non-negative integer';
  end if;

  -- 2. 계좌 문서를 잠그고 revision 확인
  select d.revision, d.data into v_cur_rev, v_cur
    from public.kaw_data d
   where d.family_code = p_family_code and d.profile = p_profile and d.account_type = 'pension'
   for update;
  if not found or jsonb_typeof(v_cur) is distinct from 'object' then
    raise exception 'KAW_SYNC:doc_missing' using errcode = 'P0001', detail = 'pension document not found';
  end if;

  -- 3. 멱등 — 같은 기록이 이미 있으면 아무것도 쓰지 않는다(revision 검사보다 먼저: 재시도는 revision 이 올라가 있다)
  v_old_syncs := case when jsonb_typeof(v_cur->'brokerSyncs') = 'array' then v_cur->'brokerSyncs' else '[]'::jsonb end;
  if exists (select 1 from jsonb_array_elements(v_old_syncs) e where e->>'id' = v_record) then
    return jsonb_build_object('status', 'already_synced', 'record_id', v_record, 'revision', v_cur_rev);
  end if;
  if v_cur_rev is distinct from v_expected then
    raise exception 'KAW_SYNC:revision_conflict' using errcode = 'P0001', detail = format('expected %s, current %s', v_expected, v_cur_rev);
  end if;

  -- 4. DB 기준 사전 조건
  if not exists (
    select 1 from public.kaw_ledger_audit
     where family_code = p_family_code and profile = p_profile and action = 'transfer_confirm' and target_id = 'transfer:' || v_instance
  ) then
    raise exception 'KAW_SYNC:transfer_unconfirmed' using errcode = 'P0001', detail = 'no confirmed account transfer for this instance';
  end if;
  if exists (select 1 from public.kaw_transaction_correction where family_code = p_family_code and profile = p_profile) then
    raise exception 'KAW_SYNC:corrections_present' using errcode = 'P0001', detail = 'transaction corrections exist';
  end if;
  select coalesce(jsonb_object_agg(t.ticker, t.q), '{}'::jsonb) into v_replay from (
    select upper(ticker) as ticker, sum(case when side = 'buy' then quantity else -quantity end) as q
      from public.kaw_transaction_ledger
     where family_code = p_family_code and profile = p_profile and account_type = 'pension'
     group by upper(ticker)
    having sum(case when side = 'buy' then quantity else -quantity end) <> 0
  ) t;
  if v_replay is distinct from (p_expect->'holdings_by_ticker') then
    raise exception 'KAW_SYNC:holdings_mismatch' using errcode = 'P0001', detail = 'ledger replay: ' || v_replay::text;
  end if;

  -- 5. 문서 diff — 허용된 키 말고는 한 글자도 바뀌지 않았다
  for v_key in
    select k from (select jsonb_object_keys(v_cur) as k union select jsonb_object_keys(p_new_data)) u
  loop
    if v_key <> all (c_allowed) and (v_cur->v_key) is distinct from (p_new_data->v_key) then
      raise exception 'KAW_SYNC:doc_changed_outside_allowed' using errcode = 'P0001', detail = 'key ' || v_key;
    end if;
  end loop;
  if (p_new_data->'liveQuantities') is distinct from (p_expect->'live_quantities')
     or (p_new_data->'cashBalance') is distinct from (p_expect->'cash_amount') then
    raise exception 'KAW_SYNC:doc_mismatch' using errcode = 'P0001', detail = 'new quantities or cash differ from the verified plan';
  end if;
  v_new_syncs := p_new_data->'brokerSyncs';
  v_n_old := jsonb_array_length(v_old_syncs);
  if jsonb_typeof(v_new_syncs) is distinct from 'array' or jsonb_array_length(v_new_syncs) <> v_n_old + 1
     or (select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb) from jsonb_array_elements(v_new_syncs) with ordinality e(value, ord) where e.ord <= v_n_old)
        is distinct from v_old_syncs
     or (v_new_syncs->(v_n_old))->>'id' is distinct from v_record
     or (v_new_syncs->(v_n_old))->>'kind' is distinct from 'broker_sync'
     or (v_new_syncs->(v_n_old))->'createsCashflow' is distinct from 'false'::jsonb
     or (v_new_syncs->(v_n_old))->'createsTrade' is distinct from 'false'::jsonb
     or (v_new_syncs->(v_n_old))->'notRebalance' is distinct from 'true'::jsonb then
    raise exception 'KAW_SYNC:doc_mismatch' using errcode = 'P0001', detail = 'brokerSyncs must keep existing entries and append exactly one broker_sync record';
  end if;

  -- 5-b. **새 기록 내부의 값이 검증된 계획 · 저장할 현재값과 일치**하는지 (기록이 다른 곳과 어긋난 채 저장되지 않게)
  v_rec := v_new_syncs -> v_n_old;
  if v_rec -> 'quantities' is distinct from (p_expect -> 'live_quantities')
     or v_rec -> 'quantities' is distinct from (p_new_data -> 'liveQuantities')
     or v_rec -> 'holdingsByTicker' is distinct from (p_expect -> 'holdings_by_ticker')
     or v_rec -> 'accountType' is distinct from '"pension"'::jsonb
     or v_rec #> '{cash,amount}' is distinct from (p_expect -> 'cash_amount')
     or v_rec #> '{cash,amount}' is distinct from (p_new_data -> 'cashBalance')
     or jsonb_typeof(v_rec #> '{cash,stateAsOf}') is distinct from 'string'
     or v_rec #> '{cash,stateAsOf}' is distinct from (p_new_data #> '{cashBalanceObservation,stateAsOf}')
     or v_rec #> '{cash,effectiveFrom}' is distinct from 'null'::jsonb
     or (p_new_data #> '{cashBalanceObservation,syncId}') is distinct from to_jsonb(v_record)
     or (p_new_data #> '{cashBalanceObservation,effectiveFrom}') is distinct from 'null'::jsonb
     or (v_rec ->> 'holdingsEffectiveFrom') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(v_rec ->> 'approvedBy', '') is distinct from v_actor
     or coalesce(v_rec ->> 'approvedAt', '') = ''
     or (p_audit -> 'new_value' ->> 'id') is distinct from v_record then
    raise exception 'KAW_SYNC:record_mismatch' using errcode = 'P0001',
      detail = 'broker_sync record must match the verified plan, the stored current values and the approver';
  end if;

  -- 6. 문서 저장 — 기존 revision CAS 저장을 그대로 쓴다
  v_res := public.kaw_data_save_guarded(
    p_family_code, p_profile,
    jsonb_build_array(jsonb_build_object('account_type', 'pension', 'data', p_new_data, 'expected_revision', v_cur_rev))
  );
  if v_res->>'outcome' is distinct from 'saved' then
    raise exception 'KAW_SYNC:save_conflict' using errcode = 'P0001', detail = left(v_res::text, 500);
  end if;

  -- 7. 승인 감사
  insert into public.kaw_ledger_audit
    (family_code, profile, actor, action, target_type, target_id, previous_value, new_value, note)
  values
    (p_family_code, p_profile, v_actor, 'broker_sync_apply', 'import', 'sync:' || v_record || '@r' || v_cur_rev,
     p_audit->'previous_value', p_audit->'new_value', p_audit->>'note');

  return jsonb_build_object('status', 'applied', 'record_id', v_record, 'revision', (v_res->'revisions'->>'pension')::integer);
end;
$$;

revoke all on function public.kaw_broker_sync_apply(text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.kaw_broker_sync_apply(text, text, jsonb, jsonb, jsonb)
  to service_role;

comment on function public.kaw_broker_sync_apply(text, text, jsonb, jsonb, jsonb) is
  '계좌 상태 동기화를 원자적으로 적용한다: 계좌 문서(kaw_data_save_guarded, revision CAS)와 승인 감사를 한 트랜잭션으로 쓴다. 문서는 허용된 5개 키만 바뀌고 history/cashflows/baseAmount 등은 한 글자도 바뀌지 않아야 한다. 원장 재생 보유와 증권사 보유가 다르면 전부 취소. security invoker.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩. 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 함수: security invoker(prosecdef = f) · search_path 고정
--   select proname, prosecdef, proconfig from pg_proc
--    where proname = 'kaw_broker_sync_apply' and pronamespace = 'public'::regnamespace;
--
-- (b) 역할별 EXECUTE — service_role = t, anon = f, authenticated = f
--   select r, has_function_privilege(r, 'public.kaw_broker_sync_apply(text,text,jsonb,jsonb,jsonb)', 'EXECUTE') as can_execute
--     from unnest(array['service_role','anon','authenticated']) r;
--
-- (b2) 권한 부여 대상 전체 — PUBLIC(grantee = 0)이 없어야 한다
--   select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
--     from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
--    where p.proname = 'kaw_broker_sync_apply' and p.pronamespace = 'public'::regnamespace order by 1;
--
-- (c) 감사 유니크 인덱스 — indisunique = t, 조건 action = 'broker_sync_apply'
--   select i.relname, ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid) as predicate
--     from pg_index ix join pg_class i on i.oid = ix.indexrelid
--    where ix.indrelid = 'public.kaw_ledger_audit'::regclass and i.relname = 'kaw_ledger_audit_broker_sync_uq';
--
-- (d) 기존 행이 바뀌지 않았다 — action 별 건수가 적용 전과 같다
--   select action, count(*) from public.kaw_ledger_audit group by action order by action;
