-- ─────────────────────────────────────────────────────────────────────────────
-- 주문 의도 수동 해소 + 감사 이력 — migration 009
--
-- 상태: **작성만 했고 적용하지 않았다.** 008 이 먼저 적용돼 있어야 한다.
--       **008 과 함께 적용해야 한다**: 서버는 접수 결과에 주문번호 출처(order_no_source)를
--       함께 쓴다. 008 만 있으면 접수 결과 저장이 실패해 submitting 으로 남는다(재전송은 없다).
--       이 함수가 없는 동안 수동 해소 API 는 쓰지 않고 503 을 돌려준다(두 번의 호출로
--       나눠 흉내내지 않는다).
--
-- 왜 필요한가: 응답이 유실된 주문(unknown)·전송 중 멈춘 주문(submitting)·"확인 필요" 주문은
--       체결조회만으로 풀리지 않을 수 있다. 그 사이 새 주문이 전부 막힌다. 사람이 풀되,
--       서버가 그 자리에서 증권사 체결조회를 다시 하고 근거가 맞을 때만 상태를 바꾼다
--       (order-service.ts resolveOrder). 이 마이그레이션은 그 결과를 **원자적으로** 남긴다.
--
-- ── 대원칙 ──────────────────────────────────────────────────────────────────
--
--   1. **의도 행은 지우지 않는다.** 상태 컬럼만 CAS 로 바꾼다(008 의 컬럼 단위 UPDATE 권한)
--   2. **감사 행은 추가만 된다.** 근거·처리시각·처리자·이전/이후 상태·이전 version. 수정·삭제 불가
--   3. **둘은 한 트랜잭션이다.** `kaw_order_resolve` 한 번 = 의도 갱신 + 감사 삽입. 한쪽만 남지 않는다
--   4. **해소 가능한 상태에서만.** unknown / submitting 이 아니면 아무 것도 쓰지 않는다
--   5. **새 상태 'dismissed'** — "장 마감 후 조회에서 조건이 같은 주문이 없음"으로 정리된 의도.
--      주문번호도 체결 증거도 갖지 않는다(CHECK 로 강제)
--   6. **원장이 아니다.** 어떤 행도 kaw_transaction_ledger 에 기록되지 않는다
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. 상태 'dismissed' 추가 ─────────────────────────────────────────────────

alter table public.kaw_order_intent drop constraint if exists kaw_order_intent_state_chk;
alter table public.kaw_order_intent add constraint kaw_order_intent_state_chk check (state in (
  'proposed','submitting','accepted','rejected','unknown',
  'open','partially_filled','filled','cancelled','expired','dismissed'
));

-- dismissed 는 주문번호·체결 증거가 없어야 한다(있으면 미접수가 아니다).
alter table public.kaw_order_intent drop constraint if exists kaw_order_intent_dismissed_chk;
alter table public.kaw_order_intent add constraint kaw_order_intent_dismissed_chk check (
  state <> 'dismissed' or (order_no is null and evidence is null)
);

-- ── 1-2. 주문번호 출처 ──────────────────────────────────────────────────────
--
-- broker_response  증권사 **주문 응답**이 준 번호 — 앱이 보낸 주문임이 확실하다
-- user_linked      사용자가 수동으로 연결한 번호 — 증권사 기록만으로는 앱 주문과 직접 매매를
--                  구별할 수 없다. 서버는 이 출처의 체결을 확정·원장 근거로 쓰지 않는다
alter table public.kaw_order_intent add column if not exists order_no_source text;
alter table public.kaw_order_intent drop constraint if exists kaw_order_intent_order_no_source_chk;
alter table public.kaw_order_intent add constraint kaw_order_intent_order_no_source_chk check (
  order_no_source is null
  or (order_no_source in ('broker_response','user_linked') and order_no is not null)
);
grant update (order_no_source) on public.kaw_order_intent to service_role;

-- ── 2. 감사 이력 ────────────────────────────────────────────────────────────

create table if not exists public.kaw_order_resolution (
  family_code   text        not null,
  profile       text        not null,
  id            text        not null,
  intent_id     text        not null,
  action        text        not null,
  actor         text        not null,
  note          text        not null,
  prev_state    text        not null,
  new_state     text        not null,
  prev_version  integer     not null,
  evidence      jsonb       not null,
  decided_at    timestamptz not null,
  created_at    timestamptz not null default now(),

  constraint kaw_order_resolution_pk primary key (family_code, profile, id),
  constraint kaw_order_resolution_intent_fk foreign key (family_code, profile, intent_id)
    references public.kaw_order_intent (family_code, profile, id) on delete restrict,
  constraint kaw_order_resolution_action_chk check (action in ('link_order_no','dismiss_not_found')),
  constraint kaw_order_resolution_prev_chk check (prev_state in ('unknown','submitting')),
  constraint kaw_order_resolution_new_chk check (new_state in (
    'accepted','open','partially_filled','filled','cancelled','dismissed'
  )),
  -- 행동과 결과가 맞아야 한다: 미접수 정리는 dismissed 로만, 번호 연결은 dismissed 가 될 수 없다.
  constraint kaw_order_resolution_pair_chk check (
    (action = 'dismiss_not_found' and new_state = 'dismissed')
    or (action = 'link_order_no' and new_state <> 'dismissed')
  ),
  constraint kaw_order_resolution_note_chk check (char_length(btrim(note)) between 5 and 500),
  constraint kaw_order_resolution_evidence_chk check (evidence ? 'source')
);

comment on table public.kaw_order_resolution is
  '주문 의도 수동 해소 감사 이력. 추가만 가능하다. 근거는 서버가 그 자리에서 한 체결조회 요약이다. 원장이 아니다.';

create index if not exists kaw_order_resolution_intent_idx
  on public.kaw_order_resolution (family_code, profile, intent_id);

alter table public.kaw_order_resolution enable row level security;
revoke all on public.kaw_order_resolution from public, anon, authenticated, service_role;
grant select, insert on public.kaw_order_resolution to service_role;

-- ── 3. 원자적 해소 함수 ─────────────────────────────────────────────────────
--
-- security invoker: service_role 의 권한(008 의 컬럼 단위 UPDATE, 위의 INSERT)으로만 동작한다.
-- 주문 내용 컬럼(종목·수량·지정가·금액·계좌)은 여기서도 바꿀 수 없다.

create or replace function public.kaw_order_resolve(
  p_family_code      text,
  p_profile          text,
  p_intent_id        text,
  p_expected_version integer,
  p_patch            jsonb,
  p_resolution       jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row public.kaw_order_intent;
  v_new_state text := p_patch->>'state';
begin
  if v_new_state is null or v_new_state not in ('accepted','open','partially_filled','filled','cancelled','dismissed') then
    raise exception 'invalid target state %', v_new_state using errcode = '22023';
  end if;
  -- 수동 해소로 붙는 번호는 언제나 user_linked 다(응답 번호로 위장할 수 없다).
  if v_new_state <> 'dismissed' and (p_patch->>'order_no_source') is distinct from 'user_linked' then
    raise exception 'manual link must be user_linked' using errcode = '22023';
  end if;
  if v_new_state = 'dismissed' and (p_patch ? 'order_no' or p_patch ? 'order_no_source') then
    raise exception 'dismissed must not carry an order number' using errcode = '22023';
  end if;
  if (p_resolution->>'new_state') is distinct from v_new_state then
    raise exception 'resolution/patch state mismatch' using errcode = '22023';
  end if;

  update public.kaw_order_intent set
    state           = v_new_state,
    order_no        = case when p_patch ? 'order_no' then p_patch->>'order_no' else order_no end,
    order_no_source = case when p_patch ? 'order_no_source' then p_patch->>'order_no_source' else order_no_source end,
    order_time      = case when p_patch ? 'order_time' then p_patch->>'order_time' else order_time end,
    evidence        = case when p_patch ? 'evidence' then p_patch->'evidence' else evidence end,
    ambiguous       = coalesce((p_patch->>'ambiguous')::boolean, ambiguous),
    last_error      = case when p_patch ? 'last_error' then p_patch->>'last_error' else last_error end,
    last_inquiry_at = coalesce((p_patch->>'last_inquiry_at')::timestamptz, last_inquiry_at),
    state_version   = state_version + 1,
    updated_at      = now()
  where family_code = p_family_code and profile = p_profile and id = p_intent_id
    and state_version = p_expected_version
    and state in ('unknown','submitting')
    and order_no is null
  returning * into v_row;

  if not found then
    if exists (select 1 from public.kaw_order_intent
                where family_code = p_family_code and profile = p_profile and id = p_intent_id) then
      return jsonb_build_object('status', 'stale');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.kaw_order_resolution (
    family_code, profile, id, intent_id, action, actor, note,
    prev_state, new_state, prev_version, evidence, decided_at
  ) values (
    p_family_code, p_profile, p_resolution->>'id', p_intent_id,
    p_resolution->>'action', p_resolution->>'actor', p_resolution->>'note',
    p_resolution->>'prev_state', v_new_state, (p_resolution->>'prev_version')::integer,
    p_resolution->'evidence', (p_resolution->>'decided_at')::timestamptz
  );

  return jsonb_build_object('status', 'ok', 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.kaw_order_resolve(text, text, text, integer, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.kaw_order_resolve(text, text, text, integer, jsonb, jsonb)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩. 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 제약: dismissed 가 상태 목록에 있고 dismissed_chk 가 있는가
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.kaw_order_intent'::regclass
--      and (conname like '%state%' or conname like '%dismissed%');
--
-- 되돌릴 때는 009 롤백을 008 롤백보다 **먼저** 한다(감사 행 FK 가 의도 테이블 삭제를 막는다).
--
-- (b) 감사 테이블 권한 — sel t / ins t / upd f / del f / trunc f
--   select has_table_privilege('service_role','public.kaw_order_resolution','SELECT') sel,
--          has_table_privilege('service_role','public.kaw_order_resolution','INSERT') ins,
--          has_table_privilege('service_role','public.kaw_order_resolution','UPDATE') upd,
--          has_table_privilege('service_role','public.kaw_order_resolution','DELETE') del,
--          has_table_privilege('service_role','public.kaw_order_resolution','TRUNCATE') trunc;
--
-- (c) 함수 실행 권한 — service_role 만 t
--   select r, has_function_privilege(r, 'public.kaw_order_resolve(text,text,text,integer,jsonb,jsonb)', 'EXECUTE')
--     from unnest(array['service_role','anon','authenticated']) r;
