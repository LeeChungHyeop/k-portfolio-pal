-- ─────────────────────────────────────────────────────────────────────────────
-- HistoryEntry 서버 병합 RPC + kaw_data.revision — migration 006 (Phase 1B-2A)
--
-- 배경: 리밸런싱 완료 1건(`HistoryEntry`)은 지금까지 `/api/data` 로 **계좌 JSON 문서를
--       통째로 교체**해서 저장했다. 그 경로는 last-writer-wins 라서, 다른 기기(또는
--       같은 기기의 오래된 큐)가 **그 기록이 없던 시점의 문서**를 뒤에 저장하면 기록이
--       조용히 사라진다(`write-queue.ts` 상단, `rebalance-session.ts`
--       HistoryWriteOutcome 주석: 그래서 `/api/data` 의 ACK 는 confirmed 가 아니다).
--
--       이 마이그레이션은 **문서 전체를 보내지 않고 기록 1건만 병합**하는 경로를 만든다.
--       서버가 읽기-수정-쓰기를 한 트랜잭션 안에서 하므로, 동시 요청에서도 기록이
--       유실되지 않는다.
--
-- ── 이 마이그레이션의 대원칙 ────────────────────────────────────────────────
--
--   1. **기존 데이터를 지우거나 덮어쓰지 않는다.** 병합은 `data -> 'history'` 배열에
--      **append 한 번**이다. 다른 HistoryEntry, `cashflows`, `cashBalance`,
--      `contributionSchedule`, `profileRows` … 어느 키도 건드리지 않는다.
--      `jsonb_set` 으로 history 키 하나만 바꾼다 — 문서를 재구성하지 않는다.
--
--   2. **같은 id 가 이미 있으면 아무것도 쓰지 않는다.** 함수는 저장된 기록을 **그대로
--      돌려주고 끝낸다**(`outcome = 'already_exists'`). "같은 기록인가"의 판정은
--      서버 TS(`history-merge.ts` 의 경제값 해시)가 한다 — 파생 필드(returnPct /
--      backtestGrowth)를 뺀 비교라서 SQL 에 두면 앱 로직이 두 곳으로 갈라진다.
--      **그래서 이 함수는 UPDATE 로 기록을 교체하는 경로를 아예 갖지 않는다.**
--
--   3. **원자성은 행 잠금으로 얻는다.** plpgsql 함수 1회 호출 = 1 트랜잭션(문장)이고,
--      `select ... for update` 로 잡은 잠금은 함수가 끝날 때까지 유지된다. 그래서
--      두 요청이 같은 계좌에 동시에 들어오면 **직렬화**되고, 뒤에 들어온 쪽은 앞의
--      결과가 반영된 배열을 읽는다(둘 다 남는다). 애플리케이션 레벨 read-modify-write
--      (`select` → TS 병합 → `upsert`)로는 이 보장을 얻을 수 없다.
--
--   4. **계좌 행을 만들어주지 않는다.** 행이 없으면 `account_row_missing` 을 돌려준다.
--      여기서 `insert` 로 만들면 history 1건만 있고 설정·장부가 비어 있는 계좌 문서가
--      생기고, 뒤이어 도착한 정상 저장이 그것을 덮어쓰는지 아닌지가 또 last-writer-wins
--      에 달린다. 계좌 문서의 생성은 기존 `/api/data` 경로의 책임으로 남긴다.
--
--   5. **파생값을 저장하지 않는다**(004 / 005 의 같은 원칙). 이 함수는 수익률을
--      재계산하지 않는다 — `returnPct` 는 **앞 기록과의 체인**에서 나오는 값이라
--      (store.ts `recalcReturns`) SQL 에서 다시 계산하면 정의가 둘로 갈라진다.
--      대신 과거 날짜를 끼워 넣어 **체인이 낡아진 기록의 id** 를 응답에 담아 돌려준다
--      (`stale_return_pct_ids`). 고치는 것은 클라이언트의 몫이고, 그 전환은 1B-2B 다.
--
--   6. **revision 은 증가만 한다.** 병합이 실제로 일어난 경우에만 +1 이다
--      (`already_exists` 는 쓰기가 없으므로 그대로). 이 컬럼은 **다음 단계(전체
--      revision guard)의 기반**이고, 지금은 아무 경로도 이 값을 조건으로 쓰지 않는다 —
--      `/api/data` 의 문서 전체 upsert 는 이 컬럼을 보내지 않으므로(ON CONFLICT DO
--      UPDATE 는 보낸 컬럼만 덮어쓴다) 기존 저장 동작은 1도 바뀌지 않는다.
--
--      ⚠ 그래서 **지금 단계에서는 `/api/data` 의 문서 교체가 여전히 병합된 기록을 덮어쓸
--      수 있다.** 006 이 없애는 것은 "동시 병합 간의 유실"이고, "문서 전체 교체와의
--      경합"은 revision guard 가 들어오는 1B-2B 에서 없어진다.
--
--   7. **권한은 service_role 의 EXECUTE 하나뿐이다.** Postgres 는 새 함수에 EXECUTE 를
--      **PUBLIC 에 기본 부여**하므로(004/005 테이블과 같은 함정) revoke 를 먼저 한다.
--      함수는 `security invoker` 다 — service_role 은 이미 `kaw_data` 를 읽고 쓸 수
--      있으므로 definer 로 권한을 승격할 이유가 없고, 승격하면 다른 역할에 EXECUTE 가
--      잘못 붙는 순간 RLS 우회 경로가 된다.
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       이 마이그레이션은 **멱등하다.** 몇 번 실행해도 최종 상태는 같다.
--
--       Worker 는 이 함수를 PostgREST RPC(`supabase.rpc(...)`)로 부른다. Supabase 는
--       DDL 뒤 스키마 캐시를 자동으로 다시 읽지만, 적용 직후 404(PGRST202)가 나면
--       `notify pgrst, 'reload schema';` 를 한 번 실행한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. revision 컬럼 ────────────────────────────────────────────────────────
-- 기존 행은 0 에서 시작한다. `not null default 0` 이라 기존 upsert 경로는 이 컬럼을
-- 몰라도 된다(보내지 않으면 insert 는 0, update 는 기존 값 유지).
alter table public.kaw_data
  add column if not exists revision integer not null default 0;

comment on column public.kaw_data.revision is
  'kaw_data_merge_history 가 이 문서를 병합할 때마다 +1. 전체 revision guard(1B-2B)의 기반이며, /api/data 의 문서 전체 upsert 는 이 값을 보내지 않는다.';

-- ── 2. 병합 함수 ────────────────────────────────────────────────────────────
--
-- 반환값(jsonb) — 호출부(`history-server.ts`)가 상태코드로 번역한다:
--
--   { outcome: 'created',             revision, history_count, stale_return_pct_ids }
--   { outcome: 'already_exists',      revision, history_count, entry }
--   { outcome: 'account_row_missing' }
--
-- 예외는 전부 "클라이언트가 고칠 수 있는 요청 오류"뿐이다(22023 invalid_parameter_value).
-- 모양 검증은 TS 가 먼저 하므로 여기 도달하면 버그이고, 그래서 조용히 통과시키지 않는다.
create or replace function public.kaw_data_merge_history(
  p_family_code  text,
  p_profile      text,
  p_account_type text,
  p_entry        jsonb
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id       text;
  v_date     text;
  v_rows     integer;
  v_data     jsonb;
  v_history  jsonb;
  v_existing jsonb;
  v_revision integer;
  v_stale    jsonb;
begin
  if p_family_code is null or p_profile is null or p_account_type is null then
    raise exception 'kaw_data_merge_history: 계좌 키가 필요합니다'
      using errcode = '22023';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'kaw_data_merge_history: entry 는 객체여야 합니다'
      using errcode = '22023';
  end if;

  v_id   := p_entry ->> 'id';
  v_date := p_entry ->> 'date';
  if v_id is null or v_id = '' then
    raise exception 'kaw_data_merge_history: entry.id 가 필요합니다'
      using errcode = '22023';
  end if;
  -- 날짜는 **정렬과 체인의 기준**이다(배열 순서가 아니라 date 로 최신을 판정한다 —
  -- kaw_portfolio_live_view 의 last_rebalance). 모양이 틀린 값이 들어가면 그 기록이
  -- 영구히 정렬 밖으로 밀려나므로 여기서 막는다.
  if v_date is null or v_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'kaw_data_merge_history: entry.date 는 YYYY-MM-DD 여야 합니다'
      using errcode = '22023';
  end if;

  -- (family_code, profile, account_type) 는 upsert 의 onConflict 키라 유일하다.
  -- 그래도 세어 본다 — 중복 행이 있으면 아래 UPDATE 가 **양쪽에 append** 해서
  -- 한 번의 완료가 두 기록이 된다. 조용히 그러기보다 거부한다.
  select count(*) into v_rows
    from public.kaw_data d
   where d.family_code = p_family_code
     and d.profile = p_profile
     and d.account_type = p_account_type;
  if v_rows > 1 then
    raise exception 'kaw_data_merge_history: 같은 계좌 키의 행이 % 개입니다', v_rows
      using errcode = '22023';
  end if;

  -- **행 잠금.** 여기서 함수가 끝날 때까지 다른 병합은 대기한다(대원칙 3).
  select d.data, d.revision
    into v_data, v_revision
    from public.kaw_data d
   where d.family_code = p_family_code
     and d.profile = p_profile
     and d.account_type = p_account_type
   for update;

  if not found then
    -- 계좌 문서를 만들어주지 않는다(대원칙 4).
    return jsonb_build_object('outcome', 'account_row_missing');
  end if;

  -- history 가 array 가 아니면 **쓰지 않는다.** 없음(absent/null)은 빈 배열로 보지만,
  -- object 같은 엉뚱한 값을 배열로 갈아끼우면 그 안에 있던 것이 사라진다.
  if v_data ? 'history' and jsonb_typeof(v_data -> 'history') not in ('array', 'null') then
    raise exception 'kaw_data_merge_history: data.history 가 배열이 아닙니다 (%)',
      jsonb_typeof(v_data -> 'history')
      using errcode = '22023';
  end if;
  v_history := case
    when jsonb_typeof(v_data -> 'history') = 'array' then v_data -> 'history'
    else '[]'::jsonb
  end;

  select e.value
    into v_existing
    from jsonb_array_elements(v_history) e
   where e.value ->> 'id' = v_id
   limit 1;

  if v_existing is not null then
    -- 멱등 경로. **쓰기도 revision 증가도 없다.** 같은 기록인지(경제값 해시 일치)는
    -- 호출부가 판정한다 — 다르면 409 다(대원칙 2).
    return jsonb_build_object(
      'outcome',       'already_exists',
      'revision',      v_revision,
      'history_count', jsonb_array_length(v_history),
      'entry',         v_existing
    );
  end if;

  -- 과거 날짜를 끼워 넣으면 **바로 뒤 기록**의 returnPct 가 낡는다(체인이 앞 기록을
  -- 쓴다). 그 id 만 돌려준다 — 다시 계산해 넣지 않는다(대원칙 5).
  select coalesce(jsonb_agg(s.id), '[]'::jsonb)
    into v_stale
    from (
      select e.value ->> 'id' as id
        from jsonb_array_elements(v_history) with ordinality e(value, ord)
       where (e.value ->> 'date') > v_date
       order by (e.value ->> 'date'), e.ord
       limit 1
    ) s;

  -- **append 한 번.** 배열 끝에 붙인다 — 같은 날짜가 이미 있으면 "나중에 저장된 쪽"이
  -- 최신이라는 앱/뷰의 규칙(store.ts 안정 정렬, live view 의 `ord desc`)과 같아진다.
  -- 다른 키는 손대지 않는다(대원칙 1).
  update public.kaw_data d
     set data = jsonb_set(
           coalesce(d.data, '{}'::jsonb),
           '{history}',
           v_history || jsonb_build_array(p_entry),
           true
         ),
         revision = d.revision + 1,
         updated_at = now()
   where d.family_code = p_family_code
     and d.profile = p_profile
     and d.account_type = p_account_type
   returning d.revision into v_revision;

  return jsonb_build_object(
    'outcome',              'created',
    'revision',             v_revision,
    'history_count',        jsonb_array_length(v_history) + 1,
    'stale_return_pct_ids', v_stale
  );
end $$;

comment on function public.kaw_data_merge_history(text, text, text, jsonb) is
  'HistoryEntry 1건을 kaw_data.data->history 에 원자적으로 append 한다. 같은 id 가 있으면 저장된 기록을 그대로 돌려주고 아무것도 쓰지 않는다. 계좌 문서를 만들지 않으며, 다른 키·기록을 건드리지 않는다.';

-- ── 3. audit 대상 확장 ──────────────────────────────────────────────────────
-- 004 의 kaw_ledger_audit 을 그대로 쓴다. target_type 에 'history' 한 값만 **추가**한다
-- (기존 다섯 값은 그대로 허용). action 에는 CHECK 가 없으므로 새 action
-- ('history_merge')은 DDL 없이 쓸 수 있다.
--
-- 004 가 아직 적용되지 않은 DB 에서도 006 이 실패하지 않도록 테이블 존재를 확인한다.
do $$
begin
  if exists (
    select 1 from pg_class
     where oid = 'public.kaw_ledger_audit'::regclass
  ) then
    alter table public.kaw_ledger_audit
      drop constraint if exists kaw_ledger_audit_target_chk;
    alter table public.kaw_ledger_audit
      add constraint kaw_ledger_audit_target_chk
      check (target_type in ('transaction', 'event', 'import', 'plan', 'observation', 'history'));
  end if;
exception
  when undefined_table then
    raise notice 'kaw_ledger_audit 이 없습니다 (004 미적용). audit 대상 확장을 건너뜁니다.';
end $$;

-- ── 보안 ────────────────────────────────────────────────────────────────────
--
-- **004 / 005 의 테이블과 같은 함정이 함수에도 있다.** Postgres 는 새로 만든 함수에
-- EXECUTE 를 **PUBLIC 에 기본 부여**한다. GRANT 는 가산이라 "service_role 에만 grant"
-- 는 빼기가 되지 않으므로, 먼저 전부 회수한다. 회수를 빼먹으면 anon 키로도 이 함수를
-- PostgREST RPC(`/rest/v1/rpc/kaw_data_merge_history`)로 부를 수 있다 —
-- security invoker 라 테이블 권한이 없어 실제 쓰기는 실패하지만, 함수 호출 자체를
-- 열어둘 이유가 없다(가족코드·프로필을 넣어보는 탐색 경로가 된다).
--
-- owner(postgres)는 건드리지 않는다. 이 블록은 멱등하다.
revoke all on function public.kaw_data_merge_history(text, text, text, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.kaw_data_merge_history(text, text, text, jsonb)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩 실행한다. 아래는 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) revision 컬럼이 생겼는가 — not null / default 0 이어야 한다
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'kaw_data'
--      and column_name = 'revision';
--
-- (b) 함수가 하나만 있는가 (오버로드가 쌓이면 PostgREST 가 모호해진다)
--   select p.oid::regprocedure as signature, p.prosecdef as security_definer,
--          p.provolatile, p.proconfig
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'kaw_data_merge_history';
--   -- 기대: 1행, security_definer = f, provolatile = v, proconfig 에 search_path
--
-- (c) **권한 표.** 기대: service_role 만 t
--   select r.role, has_function_privilege(
--            r.role,
--            'public.kaw_data_merge_history(text,text,text,jsonb)',
--            'EXECUTE') as exec
--     from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
--    order by r.role;
--
-- (d) audit 대상이 6값으로 확장됐는가 — 'history' 가 보여야 한다
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.kaw_ledger_audit'::regclass
--      and conname  = 'kaw_ledger_audit_target_chk';
--
-- (e) **없는 계좌에는 쓰지 않는가** — account_row_missing 이어야 한다
--   select public.kaw_data_merge_history(
--     '__smoke__', '__smoke__', 'isa',
--     '{"id":"hist:smoke","date":"2026-01-02","baseAmount":0,"totalValue":0,"deposit":0}'::jsonb);
--
-- (f) **병합·멱등·보존이 실제로 되는가** (롤백되는 트랜잭션으로 확인한다)
--   begin;
--     insert into public.kaw_data (family_code, profile, account_type, data)
--     values ('__smoke__', '__smoke__', 'isa',
--             '{"cashBalance": 3621,
--               "cashflows": [{"id":"cf-1","amount":100}],
--               "history": [{"id":"h-old","date":"2026-01-01","totalValue":10}]}'::jsonb);
--
--     -- 1회차: created, revision 1
--     select public.kaw_data_merge_history('__smoke__','__smoke__','isa',
--       '{"id":"h-new","date":"2026-02-01","totalValue":20}'::jsonb);
--     -- 2회차(같은 id): already_exists, revision 그대로 1, 저장된 entry 반환
--     select public.kaw_data_merge_history('__smoke__','__smoke__','isa',
--       '{"id":"h-new","date":"2026-02-01","totalValue":99}'::jsonb);
--     -- 과거 날짜: stale_return_pct_ids 에 'h-new' 가 담겨야 한다
--     select public.kaw_data_merge_history('__smoke__','__smoke__','isa',
--       '{"id":"h-mid","date":"2026-01-15","totalValue":15}'::jsonb);
--
--     -- 보존 확인: history 3건 + cashflows / cashBalance 그대로, revision = 2
--     select revision,
--            jsonb_array_length(data -> 'history')      as history_count,
--            data -> 'cashBalance'                      as cash_balance,
--            jsonb_array_length(data -> 'cashflows')    as cashflow_count,
--            (select jsonb_agg(e ->> 'id')
--               from jsonb_array_elements(data -> 'history') e) as ids
--       from public.kaw_data
--      where family_code = '__smoke__' and profile = '__smoke__' and account_type = 'isa';
--   rollback;
--
-- (g) **동시 요청에서 유실이 없는가** (세션 2개로 수동 확인)
--     세션 A: begin; select public.kaw_data_merge_history(... 'h-a' ...);   -- 커밋 전
--     세션 B: select public.kaw_data_merge_history(... 'h-b' ...);          -- 여기서 대기해야 한다
--     세션 A: commit;   → B 가 풀리고, history 에 h-a / h-b 가 **둘 다** 남아야 한다
--     (B 가 기다리지 않고 바로 끝나면 `for update` 가 빠진 것이다 — 그 상태로 쓰지 않는다)
