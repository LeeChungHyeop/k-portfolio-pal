-- ─────────────────────────────────────────────────────────────────────────────
-- 주문 의도(order intent) 영속화 — migration 008
--
-- 상태: **작성만 했고 적용하지 않았다.** 운영 DB 에는 아직 이 테이블이 없다. 테이블이 없는
--       동안 주문 기능은 쓰기가 실패하며(42P01 → 503) 메모리로 대체되지 않는다.
--
-- 왜 필요한가: 실주문은 응답이 유실될 수 있다. 프로세스가 재시작돼도 "이 주문이 나갔을
--       수 있다"는 사실이 남아 있어야 같은 주문을 다시 보내지 않는다. 의도는 **보내기
--       전에** 저장되고(state='submitting'), 응답 유실 후에는 조회로만 해소한다.
--
-- ── 이 마이그레이션의 대원칙 ────────────────────────────────────────────────
--
--   1. **주문 내용은 생성 후 바꿀 수 없다.** 종목·수량·지정가·금액·계좌는 INSERT 만
--      가능하고, UPDATE 권한을 **컬럼 단위로** 상태 관련 컬럼에만 준다
--   2. **중복 주문 의도를 DB 가 막는다.** (family_code, profile, idempotency_key) 유일
--   3. **같은 주문번호가 두 의도에 붙을 수 없다.** (family_code, profile, order_no) 부분 유일
--   4. **삭제·TRUNCATE 불가.** 주문 의도는 감사 기록이다
--   5. **원장이 아니다.** 이 테이블의 어떤 행도 거래 원장(kaw_transaction_ledger)에
--      자동으로 기록되지 않는다. 체결 증거(evidence)가 있어도 원장 기록은 별도 결정이다
--   6. **승인 토큰 원문은 저장하지 않는다.** SHA-256 해시만 둔다
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.kaw_order_intent (
  family_code               text        not null,
  profile                   text        not null,
  id                        text        not null,
  idempotency_key           text        not null,
  attempt                   integer     not null,

  account_instance_id       text        not null,
  broker                    text        not null,
  product_code              text        not null,
  side                      text        not null,
  ticker                    text        not null,
  quantity                  integer     not null,
  limit_price               integer     not null,
  ord_dvsn                  text        not null,
  amount                    bigint      not null,
  buying_power_at_proposal  jsonb,

  state                     text        not null,
  -- 낙관적 잠금. 갱신은 `where state_version = <읽은 값>` 일 때만 성공해야 한다.
  state_version             integer     not null default 0,

  approval_token_hash       text        not null,
  approval_expires_at       timestamptz not null,
  approval_consumed_at      timestamptz,

  submit_started_at         timestamptz,
  order_no                  text,
  order_org_no              text,
  order_time                text,

  evidence                  jsonb,
  last_inquiry_at           timestamptz,
  ambiguous                 boolean     not null default false,
  last_error                text,

  policy_version            integer     not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint kaw_order_intent_pk primary key (family_code, profile, id),
  constraint kaw_order_intent_idem_uniq unique (family_code, profile, idempotency_key),

  constraint kaw_order_intent_state_chk check (state in (
    'proposed','submitting','accepted','rejected','unknown',
    'open','partially_filled','filled','cancelled','expired'
  )),
  constraint kaw_order_intent_side_chk   check (side = 'buy'),
  constraint kaw_order_intent_broker_chk check (broker = 'kis'),
  constraint kaw_order_intent_prdt_chk   check (product_code = '22'),
  constraint kaw_order_intent_dvsn_chk   check (ord_dvsn = '00'),
  constraint kaw_order_intent_ticker_chk check (ticker ~ '^[A-Z0-9]{6}$'),
  constraint kaw_order_intent_qty_chk    check (quantity > 0),
  constraint kaw_order_intent_price_chk  check (limit_price > 0),
  constraint kaw_order_intent_amount_chk check (amount = quantity::bigint * limit_price::bigint),
  constraint kaw_order_intent_attempt_chk check (attempt >= 1),
  constraint kaw_order_intent_version_chk check (state_version >= 0),
  -- 접수(accepted) 이후 상태는 주문번호를 가진다. 응답 유실에서 조회로 찾은 경우도 포함한다.
  constraint kaw_order_intent_orderno_chk check (
    state not in ('accepted','open','partially_filled','filled')
    or order_no is not null
  ),
  -- 체결 상태는 체결조회 증거가 있어야 한다. 접수만으로 체결을 말하지 않는다.
  constraint kaw_order_intent_evidence_chk check (
    state not in ('partially_filled','filled') or evidence is not null
  )
);

comment on table public.kaw_order_intent is
  '승인형 주문 의도. 보내기 전에 저장되고(submitting) 응답 유실 후 조회로만 해소된다. 거래 원장이 아니다.';
comment on column public.kaw_order_intent.state_version is
  '낙관적 잠금. 갱신은 읽은 값과 같을 때만 성공한다 — 서버측 중복 주문 차단의 근거.';
comment on column public.kaw_order_intent.approval_token_hash is
  '승인 토큰의 SHA-256 해시. 원문은 저장하지 않는다. approval_consumed_at 이 채워지면 재사용 불가.';

-- 같은 증권사 주문번호가 두 의도에 붙을 수 없다 (주문번호가 있는 행에만).
create unique index if not exists kaw_order_intent_order_no_uniq
  on public.kaw_order_intent (family_code, profile, order_no)
  where order_no is not null;

create index if not exists kaw_order_intent_open_idx
  on public.kaw_order_intent (family_code, profile, state);

-- ── 보안 ────────────────────────────────────────────────────────────────────
--
-- 004/005/006/007 과 같은 방식이고 같은 함정이 있다: Supabase 는 새 테이블에
-- anon/authenticated/service_role 전부 ALL 을 붙인다. GRANT 는 가산이라 필요한 것만
-- 주는 것으로는 부족하다 — 먼저 전부 회수한다.
--
-- service_role 에게는
--   · select, insert  (전 컬럼)
--   · update          **상태 관련 컬럼에만**: 주문 내용(종목·수량·단가·금액·계좌·방향)은
--                     UPDATE 할 수 없다
--   · delete / truncate / references / trigger  **주지 않는다**
alter table public.kaw_order_intent enable row level security;

revoke all on public.kaw_order_intent from public, anon, authenticated, service_role;

grant select, insert on public.kaw_order_intent to service_role;

grant update (
  state, state_version,
  approval_token_hash, approval_expires_at, approval_consumed_at,
  submit_started_at, order_no, order_org_no, order_time,
  evidence, last_inquiry_at, ambiguous, last_error, updated_at
) on public.kaw_order_intent to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩 실행한다. 아래는 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 테이블·제약이 있는가
--   select conname from pg_constraint where conrelid = 'public.kaw_order_intent'::regclass order by 1;
--
-- (b) 권한 표. 기대: select t / insert t / update t(컬럼 단위) / delete f / truncate f
--   select has_table_privilege('service_role','public.kaw_order_intent','SELECT')   as sel,
--          has_table_privilege('service_role','public.kaw_order_intent','INSERT')   as ins,
--          has_table_privilege('service_role','public.kaw_order_intent','DELETE')   as del,
--          has_table_privilege('service_role','public.kaw_order_intent','TRUNCATE') as trunc;
--
-- (c) 주문 내용 컬럼은 UPDATE 불가인가 — 전부 f 여야 한다
--   select c, has_column_privilege('service_role','public.kaw_order_intent',c,'UPDATE')
--     from unnest(array['ticker','quantity','limit_price','amount','side','account_instance_id',
--                       'idempotency_key','family_code','profile']) c;
--
-- (d) 상태 컬럼은 UPDATE 가능한가 — 전부 t 여야 한다
--   select c, has_column_privilege('service_role','public.kaw_order_intent',c,'UPDATE')
--     from unnest(array['state','state_version','order_no','evidence','approval_consumed_at']) c;
--
-- (e) anon / authenticated 에 아무 권한이 없는가 — 전부 f
--   select r, has_table_privilege(r,'public.kaw_order_intent','SELECT')
--     from unnest(array['anon','authenticated']) r;
