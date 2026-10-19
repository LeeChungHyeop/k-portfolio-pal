-- ─────────────────────────────────────────────────────────────────────────────
-- 계좌 이전 확정 중복 방지 — migration 011
--
-- 상태: **작성만 했고 적용하지 않았다.** 004(kaw_ledger_audit)가 먼저 적용돼 있어야 한다.
--
-- 왜 필요한가: Phase 4-C-1 의 '계좌 이전 확정'은 append-only `kaw_ledger_audit` 에 한 행
--       (action = 'transfer_confirm', target_id = 'transfer:<새 계좌 instance id>')으로 남는다.
--       audit 의 PK 는 identity `id` 하나뿐이라 **같은 계좌의 확정이 동시에 두 번 들어와도
--       DB 가 막지 못한다.** 서버는 메모리/KV 잠금과 쓰기 전 검증으로 막지만 원자적이지 않다
--       (다른 isolate 의 경합 요청). 이 인덱스가 DB 수준에서 마지막 방어선이다.
--
-- ── 하는 일은 이것 하나뿐이다 ───────────────────────────────────────────────
--
--   `action = 'transfer_confirm'` 인 행에 한해 (family_code, profile, target_id) 를 유일하게 만드는
--   **부분 유니크 인덱스**. 같은 가족·프로필의 같은 새 계좌에 대한 두 번째 확정 INSERT 는
--   SQLSTATE 23505 로 실패한다(서버가 '이미 확정됨'으로 처리한다).
--
-- ── 하지 않는 것 ────────────────────────────────────────────────────────────
--
--   · **기존 행을 지우거나 고치지 않는다.** 데이터 변경(UPDATE/DELETE/INSERT)이 한 줄도 없다
--   · 다른 action(event_hide / event_restore / tx_correct …)에는 영향이 없다 — 인덱스 조건이 아니다
--   · 테이블 구조·제약·권한을 바꾸지 않는다. service_role 은 여전히 SELECT/INSERT 만 가진다
--   · 중복이 이미 있으면 **아무것도 만들지 않고 멈춘다**(아래 사전 점검). 정리는 사람이 한다
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- 되돌리기: 011_transfer_confirm_unique_rollback.sql (인덱스만 지운다. 데이터는 그대로다)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_dup integer;
  v_def text;
begin
  if to_regclass('public.kaw_ledger_audit') is null then
    raise exception 'kaw_ledger_audit 이 없습니다 (004 미적용). 011 을 적용하지 않았습니다.';
  end if;

  -- 사전 점검 0: 키 컬럼이 NOT NULL 이어야 한다. 유니크 인덱스는 NULL 을 서로 다른 값으로 취급하므로
  --   키 컬럼이 NULL 을 허용하면 NULL 로 중복 방어를 우회할 수 있다(004 는 모두 NOT NULL 로 만들었다 —
  --   운영 DB 가 실제로 그런지 여기서 확인한다).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'kaw_ledger_audit'
       and column_name in ('family_code', 'profile', 'target_id', 'action')
       and is_nullable = 'YES'
  ) then
    raise exception 'kaw_ledger_audit 의 family_code / profile / target_id / action 중 NULL 을 허용하는 컬럼이 있습니다. NULL 로 유니크 인덱스를 우회할 수 있어 011 을 적용하지 않았습니다.';
  end if;

  -- 사전 점검 1: 같은 (가족, 프로필, target_id) 의 확정 이력이 이미 둘 이상이면 멈춘다.
  --   인덱스 생성이 어차피 실패하지만, 어느 행이 겹치는지 알려 주고 아무것도 바꾸지 않는다.
  select count(*) into v_dup from (
    select 1
      from public.kaw_ledger_audit
     where action = 'transfer_confirm'
     group by family_code, profile, target_id
    having count(*) > 1
  ) d;
  if v_dup > 0 then
    raise exception '같은 계좌의 transfer_confirm 이력이 중복된 그룹이 % 개 있습니다. 011 을 적용하지 않았습니다(데이터는 그대로). 중복 행을 확인한 뒤 사람이 정리 방침을 정하세요.', v_dup;
  end if;

  -- 사전 점검 2: 같은 이름의 인덱스가 이미 있는데 정의가 다르면 조용히 통과하지 않는다.
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public' and tablename = 'kaw_ledger_audit'
     and indexname = 'kaw_ledger_audit_transfer_confirm_uq';
  if v_def is not null
     and (v_def not like '%UNIQUE%' or v_def not like '%(family_code, profile, target_id)%' or v_def not like '%transfer_confirm%') then
    raise exception '이름이 같은 인덱스 kaw_ledger_audit_transfer_confirm_uq 가 있으나 정의가 다릅니다: %', v_def;
  end if;
end $$;

create unique index if not exists kaw_ledger_audit_transfer_confirm_uq
  on public.kaw_ledger_audit (family_code, profile, target_id)
  where action = 'transfer_confirm';

comment on index public.kaw_ledger_audit_transfer_confirm_uq is
  '계좌 이전 확정(action = transfer_confirm)은 같은 가족·프로필·새 계좌(target_id) 당 한 번만 기록된다. 부분 인덱스라 다른 action 의 audit 이력에는 영향이 없다. 두 번째 INSERT 는 23505 로 실패한다.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩. 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 인덱스가 부분 유니크로 있는가 — indisunique t / 조건에 transfer_confirm
--   select i.indexrelid::regclass as idx, ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid) as predicate
--     from pg_index ix join pg_class i on i.oid = ix.indexrelid
--    where ix.indrelid = 'public.kaw_ledger_audit'::regclass
--      and i.relname = 'kaw_ledger_audit_transfer_confirm_uq';
--
-- (b) 기존 audit 행이 하나도 바뀌지 않았다 — action 별 건수가 적용 전과 같다
--   select action, count(*) from public.kaw_ledger_audit group by action order by action;
--
-- (c) 권한은 그대로다 — sel t / ins t / upd f / del f / trunc f
--   select has_table_privilege('service_role','public.kaw_ledger_audit','SELECT') sel,
--          has_table_privilege('service_role','public.kaw_ledger_audit','INSERT') ins,
--          has_table_privilege('service_role','public.kaw_ledger_audit','UPDATE') upd,
--          has_table_privilege('service_role','public.kaw_ledger_audit','DELETE') del,
--          has_table_privilege('service_role','public.kaw_ledger_audit','TRUNCATE') trunc;
