-- ─────────────────────────────────────────────────────────────────────────────
-- kaw_data 쓰기의 revision guard — migration 007 (Phase 1B-2B)
--
-- 배경: `/api/data` POST 는 계좌 JSON 문서를 **통째로 교체**하는 upsert 다. 서버에
--       순서·버전 보호가 없어서, 그 변경을 모르는 **오래된 문서**가 뒤에 도착하면
--       최신 기록이 조용히 사라진다(write-queue.ts 상단의 R0 사고, 다른 탭/기기 간).
--       006 이 없앤 것은 "동시 **병합** 간의 유실"이었고, 남은 것이 이 "문서 전체 교체와의
--       경합"이다.
--
--       007 은 그 교체를 **compare-and-swap** 으로 바꾼다. 클라이언트는 자기가 읽은
--       `revision` 을 같이 보내고, 서버는 지금 값과 다르면 **아무것도 쓰지 않고 거부**한다.
--
-- ── 이 마이그레이션의 대원칙 ────────────────────────────────────────────────
--
--   1. **전부 아니면 전무.** 한 번의 저장은 프로필의 다섯 행(`_meta` + 네 계좌)을 같이
--      바꾼다. 그 중 하나라도 revision 이 어긋나면 **다섯 행 모두 쓰지 않는다** —
--      일부만 반영되면 `_meta`(투자성향·목표비중)와 계좌 상태가 서로 다른 세대가 되어,
--      어느 쪽이 맞는지 알 수 없는 상태가 영속된다. plpgsql 함수 1회 = 1 트랜잭션이라
--      "검사 전부 → 쓰기 전부" 순서만 지키면 원자성이 공짜로 따라온다.
--
--   2. **`_shared` 는 이 경로로 들어오지 않는다.** 종목 라이브러리
--      (`profile='_shared'`, `account_type='_assetLib'`)는 **가족 공용 행**이라 두 프로필이
--      각자 저장할 때마다 서로의 revision 을 밀어낸다. 거기에 CAS 를 걸면 평소 저장이
--      상시 409 가 된다. 공용 행은 기존 upsert 경로(무가드)에 그대로 남기고, 이 함수는
--      `_shared` / 예약 프로필(`_` 로 시작)을 **거부**한다 — 섞여 들어오는 것을 막는 것이
--      "별도 처리"의 실제 내용이다.
--
--   3. **PIN/프로필 설정 행(`_system`/`_family`)도 거부한다.** 그 경로(saveFamilyRaw)는
--      PIN 변경·프로필 추가/복구/삭제가 쓰는 곳이고, 세션 토큰 없이도 마스터코드·비밀질문으로
--      들어온다. 여기에 revision 을 요구하면 PIN 설정 자체가 막힐 수 있어 **건드리지 않는다.**
--      대신 이 함수로는 절대 닿지 못하게 막는다(권한 경계가 아니라 사고 방지다).
--
--   4. **구버전 클라이언트를 깨지 않는다.** 이 함수는 **추가**이고, 기존 upsert 경로는
--      그대로 남는다. 서버는 요청에 revision 이 실려 있을 때만 이 경로를 쓴다
--      (data-server.ts handleDataPost). 그래서 서버를 먼저 배포하고, 클라이언트 가드는
--      feature flag 로 나중에 켤 수 있다 — **단계적 배포**가 성립한다.
--
--   5. **파괴적 변경은 revision 이 맞아도 그냥 받지 않는다.** CAS 는 "내가 읽은 뒤로 아무도
--      안 바꿨다"만 증명한다. 그런데 실제 사고의 절반은 경합이 아니라 **보낸 문서 자체가
--      빈약한 경우**다(구버전 코드가 모르는 키를 떨어뜨림, 버그로 history 가 비어 옴).
--      그래서 두 가지를 더 본다:
--
--        history 축소   저장된 history 의 id 가 들어온 문서에 **없다**
--        키 유실        저장된 data 의 최상위 키가 들어온 문서에 **없다**
--
--      둘 다 **충돌로 거부**하고, 사용자가 확인한 경우에만 `p_allow_*` 로 통과시킨다
--      (기록 삭제는 정당한 사용자 행동이므로 경로 자체는 남겨둔다). 자동 재시도로
--      풀 수 있는 종류가 아니다 — 조용히 덮으면 그게 바로 영구 데이터 유실이다.
--
--   6. **006 과 충돌하지 않는다.** `kaw_data_merge_history` 는 history 1건을 append 하고
--      revision 을 +1 한다. 그 뒤에 도착한 (merge 를 모르는) 저장은 revision 이 어긋나
--      거부된다 — 즉 두 경로는 **같은 카운터로 서로를 보호한다.** 007 은 merge 함수를
--      수정하지 않는다.
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       이 마이그레이션은 **멱등하다.** 몇 번 실행해도 최종 상태는 같다.
--       `revision` 컬럼은 006 이 만든다 — 006 → 007 순서로 적용한다.
--
--       적용 직후 404(PGRST202)가 나면 `notify pgrst, 'reload schema';` 를 한 번 실행한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 006 을 건너뛰고 007 만 적용하는 사고를 막는다. 컬럼이 없으면 아래 함수는 런타임에
-- 터지는데, 그때는 이미 "가드가 켜졌다"고 믿은 뒤다.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'kaw_data' and column_name = 'revision'
  ) then
    raise exception 'kaw_data.revision 이 없습니다 — migration 006 을 먼저 적용하세요';
  end if;
end $$;

-- ── 병합·저장 대상 화이트리스트 ─────────────────────────────────────────────
-- `_meta` + 네 계좌. `_assetLib`(공용) / `_family`(PIN 설정)는 **없다**(대원칙 2·3).
create or replace function public.kaw_data_guardable_type(p_account_type text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_account_type in ('_meta', 'retirement', 'isa', 'pension', 'irp');
$$;

comment on function public.kaw_data_guardable_type(text) is
  'revision guard 가 쓸 수 있는 account_type 인가. _assetLib(가족 공용) / _family(PIN 설정)는 제외된다.';

-- ── 가드 저장 ───────────────────────────────────────────────────────────────
--
-- p_rows: [{"account_type": "...", "data": {...}, "expected_revision": 3 | null}, ...]
--         expected_revision = null 은 "그 행이 아직 없다고 믿는다"는 뜻이다.
--
-- 반환값(jsonb) — 호출부(`data-server.ts`)가 상태코드로 번역한다:
--
--   { outcome: 'saved',    revisions: {account_type: new_revision, ...}, accepted: n }
--   { outcome: 'conflict', conflicts: [{account_type, reason, expected_revision,
--                                       current_revision, lost_keys, missing_history_ids}],
--                          revisions: {account_type: current_revision | null, ...} }
--
--   reason: 'revision_mismatch' | 'row_exists' | 'row_missing'
--         | 'history_shrink'    | 'key_loss'
--
-- 예외는 "클라이언트가 고칠 수 있는 요청 오류"뿐이다(22023). 모양 검증은 TS 가 먼저
-- 하므로 여기 도달하면 버그이고, 그래서 조용히 통과시키지 않는다.
create or replace function public.kaw_data_save_guarded(
  p_family_code          text,
  p_profile              text,
  p_rows                 jsonb,
  p_allow_history_shrink boolean default false,
  p_allow_key_loss       boolean default false
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row        jsonb;
  v_type       text;
  v_data       jsonb;
  v_expected   integer;
  v_has_exp    boolean;
  v_cur_rev    integer;
  v_cur_data   jsonb;
  v_found      boolean;
  v_types      text[] := '{}';
  v_conflicts  jsonb := '[]'::jsonb;
  v_revisions  jsonb := '{}'::jsonb;
  v_lost       jsonb;
  v_missing    jsonb;
  v_new_rev    integer;
  v_accepted   integer := 0;
begin
  if p_family_code is null or p_family_code = '' or p_profile is null or p_profile = '' then
    raise exception 'kaw_data_save_guarded: 계좌 키가 필요합니다' using errcode = '22023';
  end if;
  -- 예약 프로필(`_system` / `_shared` …)은 이 경로로 쓰지 않는다(대원칙 2·3).
  if left(p_profile, 1) = '_' then
    raise exception 'kaw_data_save_guarded: 예약 프로필(%)은 가드 경로로 저장하지 않습니다', p_profile
      using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'kaw_data_save_guarded: rows 는 배열이어야 합니다' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'kaw_data_save_guarded: rows 가 비어 있습니다' using errcode = '22023';
  end if;
  -- `_meta` + 네 계좌 = 5. 그보다 많으면 중복이거나 모르는 대상이다.
  if jsonb_array_length(p_rows) > 5 then
    raise exception 'kaw_data_save_guarded: rows 가 너무 많습니다 (%)', jsonb_array_length(p_rows)
      using errcode = '22023';
  end if;

  -- ── 1) 모양 검증 ──────────────────────────────────────────────────────────
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'kaw_data_save_guarded: rows 원소가 객체가 아닙니다' using errcode = '22023';
    end if;
    v_type := v_row ->> 'account_type';
    if v_type is null or not public.kaw_data_guardable_type(v_type) then
      raise exception 'kaw_data_save_guarded: account_type(%)은 가드 대상이 아닙니다', coalesce(v_type, 'null')
        using errcode = '22023';
    end if;
    if v_type = any (v_types) then
      raise exception 'kaw_data_save_guarded: account_type(%)이 중복입니다', v_type using errcode = '22023';
    end if;
    v_types := v_types || v_type;
    if jsonb_typeof(v_row -> 'data') <> 'object' then
      raise exception 'kaw_data_save_guarded: data(%)가 객체가 아닙니다', v_type using errcode = '22023';
    end if;
    if not (v_row ? 'expected_revision') then
      raise exception 'kaw_data_save_guarded: expected_revision(%)이 없습니다', v_type using errcode = '22023';
    end if;
    if jsonb_typeof(v_row -> 'expected_revision') not in ('number', 'null') then
      raise exception 'kaw_data_save_guarded: expected_revision(%)의 모양이 틀렸습니다', v_type
        using errcode = '22023';
    end if;
  end loop;

  -- ── 2) 대상 행 잠금 ───────────────────────────────────────────────────────
  -- account_type 오름차순으로 잠근다 — 두 요청이 같은 집합을 **같은 순서**로 잡아야
  -- 교착이 생기지 않는다. 없는 행은 잠글 것이 없다(아래에서 insert 가 unique 로 막는다).
  perform 1
    from public.kaw_data d
   where d.family_code = p_family_code
     and d.profile = p_profile
     and d.account_type = any (v_types)
   order by d.account_type
     for update;

  -- ── 3) 검사 (쓰기 전에 전부) ──────────────────────────────────────────────
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_type     := v_row ->> 'account_type';
    v_data     := v_row -> 'data';
    v_has_exp  := jsonb_typeof(v_row -> 'expected_revision') = 'number';
    v_expected := case when v_has_exp then (v_row ->> 'expected_revision')::integer else null end;

    select d.revision, d.data into v_cur_rev, v_cur_data
      from public.kaw_data d
     where d.family_code = p_family_code
       and d.profile = p_profile
       and d.account_type = v_type;
    v_found := found;

    v_revisions := v_revisions || jsonb_build_object(
      v_type, case when v_found then to_jsonb(v_cur_rev) else 'null'::jsonb end
    );

    if not v_found then
      -- 행이 없다. "있다고 믿고 보낸" 요청은 거부한다 — 그 사이 누군가 지웠다는 뜻이고
      -- (프로필 hard delete), 다시 만들면 지운 행위를 되돌리는 것이 된다.
      if v_has_exp then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'account_type', v_type, 'reason', 'row_missing',
          'expected_revision', v_expected, 'current_revision', null
        ));
      end if;
      continue;
    end if;

    if not v_has_exp then
      -- 없다고 믿었는데 있다. 다른 기기가 먼저 만든 것이므로 덮지 않는다.
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'account_type', v_type, 'reason', 'row_exists',
        'expected_revision', null, 'current_revision', v_cur_rev
      ));
      continue;
    end if;

    if v_cur_rev <> v_expected then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'account_type', v_type, 'reason', 'revision_mismatch',
        'expected_revision', v_expected, 'current_revision', v_cur_rev
      ));
      continue;
    end if;

    -- revision 이 맞아도 **파괴적 문서**는 받지 않는다(대원칙 5).
    if not p_allow_key_loss and jsonb_typeof(v_cur_data) = 'object' then
      select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_lost
        from jsonb_object_keys(v_cur_data) k
       where not (v_data ? k);
      if jsonb_array_length(v_lost) > 0 then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'account_type', v_type, 'reason', 'key_loss',
          'expected_revision', v_expected, 'current_revision', v_cur_rev,
          'lost_keys', v_lost
        ));
        continue;
      end if;
    end if;

    if not p_allow_history_shrink and jsonb_typeof(v_cur_data -> 'history') = 'array' then
      select coalesce(jsonb_agg(s.id order by s.id), '[]'::jsonb) into v_missing
        from (
          select e.value ->> 'id' as id
            from jsonb_array_elements(v_cur_data -> 'history') e
           where e.value ->> 'id' is not null
        ) s
       where not exists (
         select 1
           from jsonb_array_elements(
                  case when jsonb_typeof(v_data -> 'history') = 'array'
                       then v_data -> 'history' else '[]'::jsonb end
                ) i
          where i.value ->> 'id' = s.id
       );
      if jsonb_array_length(v_missing) > 0 then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'account_type', v_type, 'reason', 'history_shrink',
          'expected_revision', v_expected, 'current_revision', v_cur_rev,
          'missing_history_ids', v_missing
        ));
        continue;
      end if;
    end if;
  end loop;

  -- **하나라도 어긋나면 전무.** 여기서 돌아가므로 아직 아무것도 쓰지 않았다(대원칙 1).
  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object(
      'outcome', 'conflict', 'conflicts', v_conflicts, 'revisions', v_revisions
    );
  end if;

  -- ── 4) 쓰기 (여기부터는 전부 성공한다) ────────────────────────────────────
  -- 검사와 쓰기 사이에 끼어들 수 있는 것은 "없던 행이 새로 생기는" 경우뿐이다
  -- (존재하는 행은 2)에서 잠갔다). 그건 insert 의 unique 위반으로 잡아서 **블록 전체를
  -- 되돌린다** — 일부만 반영된 저장을 남기지 않는다.
  begin
    v_revisions := '{}'::jsonb;
    for v_row in select value from jsonb_array_elements(p_rows) loop
      v_type     := v_row ->> 'account_type';
      v_data     := v_row -> 'data';
      v_has_exp  := jsonb_typeof(v_row -> 'expected_revision') = 'number';
      v_expected := case when v_has_exp then (v_row ->> 'expected_revision')::integer else null end;

      if v_has_exp then
        update public.kaw_data d
           set data = v_data,
               revision = d.revision + 1,
               updated_at = now()
         where d.family_code = p_family_code
           and d.profile = p_profile
           and d.account_type = v_type
           -- **CAS 를 UPDATE 문에도 다시 쓴다.** 3)의 검사는 잠금 안에서 했으므로
           -- 여기서 어긋날 수 없지만, 어긋났다면 0행이 되어 아래에서 터진다.
           and d.revision = v_expected
        returning d.revision into v_new_rev;
        if not found then
          raise exception 'kaw_data_save_guarded: %의 revision 이 검사 후 바뀌었습니다', v_type
            using errcode = '40001';
        end if;
      else
        insert into public.kaw_data (family_code, profile, account_type, data, revision, updated_at)
        values (p_family_code, p_profile, v_type, v_data, 1, now())
        returning revision into v_new_rev;
      end if;

      v_accepted := v_accepted + 1;
      v_revisions := v_revisions || jsonb_build_object(v_type, to_jsonb(v_new_rev));
    end loop;
  exception
    when unique_violation then
      -- 검사 시점에 없던 행이 그 사이 생겼다. 이 블록의 쓰기는 전부 되돌아간다.
      return jsonb_build_object(
        'outcome', 'conflict',
        'conflicts', jsonb_build_array(jsonb_build_object(
          'account_type', v_type, 'reason', 'row_exists',
          'expected_revision', null, 'current_revision', null
        )),
        'revisions', '{}'::jsonb
      );
  end;

  return jsonb_build_object('outcome', 'saved', 'revisions', v_revisions, 'accepted', v_accepted);
end $$;

comment on function public.kaw_data_save_guarded(text, text, jsonb, boolean, boolean) is
  '프로필의 _meta + 계좌 행을 revision compare-and-swap 으로 저장한다. 하나라도 어긋나면 전부 쓰지 않는다. _shared/_family 와 예약 프로필은 거부하고, history 축소·최상위 키 유실은 사용자 확인(p_allow_*) 없이는 충돌로 거부한다.';

-- ── 보안 ────────────────────────────────────────────────────────────────────
--
-- 006 과 같다. Postgres 는 새 함수에 EXECUTE 를 **PUBLIC 에 기본 부여**하므로 먼저
-- 전부 회수한다. 회수를 빼먹으면 anon 키로도 PostgREST RPC 로 이 함수를 부를 수 있다 —
-- security invoker 라 테이블 권한이 없어 실제 쓰기는 실패하지만, 가족코드·프로필을
-- 넣어보는 탐색 경로를 열어둘 이유가 없다.
--
-- owner(postgres)는 건드리지 않는다. 이 블록은 멱등하다.
revoke all on function public.kaw_data_save_guarded(text, text, jsonb, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.kaw_data_guardable_type(text)
  from public, anon, authenticated, service_role;

grant execute on function public.kaw_data_save_guarded(text, text, jsonb, boolean, boolean)
  to service_role;
grant execute on function public.kaw_data_guardable_type(text)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩 실행한다. 아래는 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 함수가 둘 다 있고 definer 가 아닌가
--   select p.oid::regprocedure as signature, p.prosecdef as security_definer, p.provolatile
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('kaw_data_save_guarded', 'kaw_data_guardable_type');
--   -- 기대: 2행, security_definer = f
--
-- (b) **권한 표.** 기대: service_role 만 t
--   select r.role,
--          has_function_privilege(r.role,
--            'public.kaw_data_save_guarded(text,text,jsonb,boolean,boolean)', 'EXECUTE') as save_exec,
--          has_function_privilege(r.role,
--            'public.kaw_data_guardable_type(text)', 'EXECUTE') as type_exec
--     from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
--    order by r.role;
--
-- (c) 가드 대상 화이트리스트 — 앞의 다섯만 t 여야 한다
--   select t, public.kaw_data_guardable_type(t)
--     from unnest(array['_meta','retirement','isa','pension','irp',
--                       '_assetLib','_family','_system']) t;
--
-- (d) **예약 프로필을 거부하는가** — 둘 다 22023 으로 터져야 한다
--   select public.kaw_data_save_guarded('__smoke__','_system',
--     '[{"account_type":"_meta","data":{},"expected_revision":null}]'::jsonb);
--   select public.kaw_data_save_guarded('__smoke__','__smoke__',
--     '[{"account_type":"_assetLib","data":{},"expected_revision":null}]'::jsonb);
--
-- (e) **정상 저장 / 충돌 / 전체 rollback** (롤백되는 트랜잭션으로 확인한다)
--   begin;
--     insert into public.kaw_data (family_code, profile, account_type, data, revision)
--     values ('__smoke__','__smoke__','_meta', '{"profile":"growth"}'::jsonb, 4),
--            ('__smoke__','__smoke__','isa',
--             '{"cashBalance":1,"history":[{"id":"h1","date":"2026-01-01"}]}'::jsonb, 7);
--
--     -- 1) 정상: revision 4/7 → 5/8
--     select public.kaw_data_save_guarded('__smoke__','__smoke__', jsonb_build_array(
--       jsonb_build_object('account_type','_meta','data','{"profile":"stable"}'::jsonb,
--                          'expected_revision',4),
--       jsonb_build_object('account_type','isa',
--         'data','{"cashBalance":2,"history":[{"id":"h1","date":"2026-01-01"}]}'::jsonb,
--         'expected_revision',7)));
--
--     -- 2) 충돌: _meta 는 맞고 isa 는 틀리다 → **둘 다 쓰이지 않아야 한다**
--     select public.kaw_data_save_guarded('__smoke__','__smoke__', jsonb_build_array(
--       jsonb_build_object('account_type','_meta','data','{"profile":"aggressive"}'::jsonb,
--                          'expected_revision',5),
--       jsonb_build_object('account_type','isa',
--         'data','{"cashBalance":3,"history":[{"id":"h1","date":"2026-01-01"}]}'::jsonb,
--         'expected_revision',99)));
--     select account_type, revision, data from public.kaw_data
--      where family_code='__smoke__' order by account_type;
--     -- 기대: _meta revision 5 / profile=stable (2)의 aggressive 가 **반영되지 않아야 한다**
--
--     -- 3) history 축소 → conflict(history_shrink), 쓰이지 않는다
--     select public.kaw_data_save_guarded('__smoke__','__smoke__', jsonb_build_array(
--       jsonb_build_object('account_type','isa','data','{"cashBalance":2,"history":[]}'::jsonb,
--                          'expected_revision',8)));
--     -- 4) 사용자가 확인하면(p_allow_history_shrink) 통과한다
--     select public.kaw_data_save_guarded('__smoke__','__smoke__', jsonb_build_array(
--       jsonb_build_object('account_type','isa','data','{"cashBalance":2,"history":[]}'::jsonb,
--                          'expected_revision',8)), true, false);
--
--     -- 5) 키 유실 → conflict(key_loss)
--     select public.kaw_data_save_guarded('__smoke__','__smoke__', jsonb_build_array(
--       jsonb_build_object('account_type','isa','data','{"history":[]}'::jsonb,
--                          'expected_revision',9)), true, false);
--   rollback;
--
-- (f) **동시 저장에서 한쪽만 이기는가** (세션 2개로 수동 확인)
--     세션 A: begin; select public.kaw_data_save_guarded(... expected 5 ...);  -- 커밋 전
--     세션 B: select public.kaw_data_save_guarded(... expected 5 ...);         -- 대기해야 한다
--     세션 A: commit;  → B 는 conflict(revision_mismatch, current 6)로 떨어져야 한다
--     (B 가 기다리지 않고 둘 다 saved 가 되면 2)의 `for update` 가 빠진 것이다)
--
-- (g) 006 과의 상호작용 — merge 뒤의 오래된 저장은 거부돼야 한다
--     select public.kaw_data_merge_history('__smoke__','__smoke__','isa', ... );  -- revision +1
--     select public.kaw_data_save_guarded(... expected = merge 이전 값 ...);       -- conflict
