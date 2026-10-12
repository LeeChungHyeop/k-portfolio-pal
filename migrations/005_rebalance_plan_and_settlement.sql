-- ─────────────────────────────────────────────────────────────────────────────
-- 리밸런싱 계획(plan) + 결제 관측(settlement observation) — migration 005
--
-- 배경: 004 는 **실제 체결**(증권사가 보고한 사실)을 담았다. 그런데 리밸런싱 완료
--       시점에 우리가 아는 것은 체결이 아니라 **계획과 주장**이다 —
--       "무엇을 하려 했고(planned), 무엇을 했다고 말하는가(asserted)".
--       그 둘을 004 의 원장에 섞으면 **합성 체결(synthetic execution)** 이 되어
--       사실과 주장의 경계가 사라진다.
--
--       그래서 계획/주장은 별 테이블(`kaw_rebalance_plan`)에 durable 하게 남기고,
--       나중에 증권사 조회로 확인되는 계좌 상태는 또 다른 별 테이블
--       (`kaw_settlement_observation`)에 남긴다. 둘을 맞춰보는 것은 앱의 순수 모듈
--       `src/lib/kaw/reconcile.ts` 가 하고 테스트로 고정돼 있다.
--
-- ── 이 마이그레이션의 대원칙 ────────────────────────────────────────────────
--
--   1. **plan 은 체결이 아니다.** `planned_quantities` / `target_weights` 로
--      `kaw_transaction_ledger` 행을 만드는 경로를 **코드에도 두지 않는다**
--      (rebalance-plan.test.ts 의 D9 불변식이 파일 단위로 이것을 고정한다).
--      004 의 원장과 이 테이블 사이에는 FK 도 없다 — 참조 관계가 아니다.
--
--   2. **plan 은 저장 후 불변이다.** 완료 1회 = 1행이고, 재시도는 같은 행을 다시
--      쓰려는 시도이지 수정이 아니다. immutable 은 관례가 아니라 **권한으로** 강제한다
--      (004 와 같은 방식: revoke 먼저, 그 뒤 select/insert 만 grant).
--
--   3. **PRE 를 역산하지 않는다.** `pre_basis = 'unknown'` 이면 `pre_quantities` 와
--      `pre_cash` 는 **null 이어야 한다** — CHECK 로 막는다. 과거 모드/세션 없음에서
--      현재 보유수량이나 target delta 로 PRE 를 채우는 것이 가장 쉬운 실수이고,
--      한 번 들어가면 "그 때 실제로 그랬다"는 사실로 굳는다.
--
--   4. **관측은 append-only 다.** 잘못 들어온 관측을 고치지 않는다 —
--      올바른 값으로 **새 관측**을 넣고 틀린 쪽에 void 행을 단다(`replaced_by` 로 연결).
--      되돌리기는 void 행 삭제다. 필드 단위 correction overlay 를 만들지 않는다:
--      관측값의 일부를 고치면 그 숫자의 provenance 가 사라진다.
--
--   5. **파생값을 저장하지 않는다**(004 원칙 3 과 같다). reconcile 결과(체결 증거 등급,
--      settlementCheck, 불일치 금액)는 컬럼으로 두지 않는다 — 관측이 하나 더 들어오면
--      즉시 달라진다.
--
--   6. **추정 날짜를 관측 행에 넣지 않는다.** 세 날짜를 섞지 않는다:
--        observed_at        우리가 조회한 시각        (사실)
--        state_as_of        증권사가 말하는 기준일     (사실)
--        state_as_of_basis  그 기준일이 무엇인가       broker_reported_date | observation_date
--      결제 전이가 언제 일어났는지는 관측 **시퀀스**에서 나오는 결론이고(reconcile.ts),
--      행에 쓰면 추정이 사실로 굳는다. 실례: 한국투자 IRP 현재잔고를 2026-10-09 에
--      조회했다면 state_as_of 는 2026-10-09 다 — 결제일로 추정되는 2026-10-07 로
--      소급하지 않는다.
--
--   7. **계좌번호를 저장하지 않는다.** 비교의 identity 는 앱이 발급한 불투명
--      `account_instance_id` 뿐이고, `account_ref_fingerprint` 는 identity 가 아니라
--      drift 탐지기다(HMAC 파생. CANO 원문은 저장·전송·로그하지 않는다).
--      **계산은 Phase 3 이고 그 전까지 이 컬럼은 항상 null 이다** — 서버가 클라이언트가
--      보낸 값을 그대로 넣지 않는다(plan-server.ts 주석 참고).
--
-- ── id 와 멱등성 ────────────────────────────────────────────────────────────
--
--   plan        id = 'plan:' || completion_id        (completion-envelope.ts completionIds)
--   observation id = 'obs:' || capture_id || ':' || source_type   (settlement-observation.ts)
--
--   둘 다 **내용/identity 에서 결정적으로 나온다.** 그래서 같은 완료를 몇 번 재전송해도
--   PK 충돌로 1행이고, PK 충돌 자체가 "이미 있다"는 ACK 가 된다. id 의 모양은 CHECK 로
--   고정한다 — 앱이 만드는 규칙과 DB 가 믿는 규칙이 어긋나면 멱등성이 조용히 깨진다.
--
--   해시(`plan_payload_hash` / `capture_payload_hash`)는 **중복 탐지용**이고 신원이
--   아니다. 004 의 fingerprint 와 같은 모양으로 규칙 버전을 문자열 앞에 박고
--   (`p1|...` / `c1|...`), 컬럼의 버전과 어긋나지 않게 CHECK 를 건다.
--
-- ── 004 를 건드리지 않는다 ──────────────────────────────────────────────────
--
-- 기존 테이블·뷰·함수를 바꾸지 않는다. 단 하나의 예외가 `kaw_ledger_audit` 의
-- `target_type` CHECK 로, 새 대상 두 종류('plan','observation')를 **추가**한다
-- (기존 세 값은 그대로 허용). `action` 에는 CHECK 가 없으므로 새 action
-- ('plan_write' / 'observation_capture' / 'observation_void' / 'observation_unvoid')
-- 은 DDL 없이 쓸 수 있다.
--
-- 이 마이그레이션은 **멱등하다.** 몇 번 실행해도 최종 상태는 같다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. 리밸런싱 계획 — 완료 1회의 durable 증거 ──────────────────────────────
create table if not exists public.kaw_rebalance_plan (
  family_code             text        not null,
  profile                 text        not null,
  -- 'plan:<completionId>'. 완료 1회에서 결정적으로 나온다
  id                      text        not null,
  -- 완료 1회의 유일한 identity. legacy history 쪽 id('hist:<completionId>')의 형제다
  completion_id           text        not null,

  account_type            text        not null,
  -- 증권사 이름(비정규화). 레지스트리가 없어도 행이 자기 설명을 하게 한다
  broker                  text        not null,
  broker_product_code     text,
  -- 비교의 유일한 identity. 앱이 발급한 불투명 id (bai:<uuid8>)
  account_instance_id     text        not null,
  -- drift 탐지기. identity 가 아니다. Phase 3 까지 항상 null
  account_ref_fingerprint text,

  -- 사용자가 리밸런싱한 날로 주장하는 날짜
  plan_date               date        not null,
  -- 이 행이 기록된 시각. plan_date 와 다를 수 있다(과거 모드)
  recorded_at             timestamptz not null default now(),
  -- 'today' | 'past'. **'future' 는 저장하지 않는다**(아직 하지 않은 일이다)
  date_mode               text        not null,

  -- PRE 의 근거. 'session_snapshot' = 첫 변경 직전 캡처, 'unknown' = 근거 없음
  pre_basis               text        not null,
  pre_session_id          text,
  pre_session_started_at  timestamptz,
  pre_profile_key         text,
  -- rowId → 수량. **pre_basis='unknown' 이면 null 이어야 한다**(CHECK)
  pre_quantities          jsonb,
  -- 세션 시작 시점 예수금. null = 당시 미입력(0 과 다르다)
  pre_cash                numeric(18, 2),
  -- 완료 시점의 account.cashBalance. 세션 시작값과 다르면 그 사실을 드러낸다
  pre_cash_at_record      numeric(18, 2),
  -- PRE 를 쓰지 못한 이유. **null = 정상**(폐기할 일이 없었다)
  pre_discard_reason      text,

  -- 완료 시점 앱 상태. **PRE 가 아니다** — 포렌식 전용이며 비교에 쓰지 않는다
  app_state_quantities_at_record jsonb,
  app_state_cash_at_record       numeric(18, 2),

  -- 사용자가 "이렇게 하겠다/했다"고 확정한 수량. rowId → 수량
  planned_quantities      jsonb       not null,
  -- 사용자가 주장하는 완료 후 예수금 (normalizeAssertedCash 적용값)
  asserted_post_cash      numeric(18, 2) not null,
  -- 앱이 계산한 예상 예수금. 주장과 다르면 그 차이가 그대로 증거다
  projected_post_cash     numeric(18, 2),

  -- intention data. **ledger 생성 근거로 쓰지 않는다**(대원칙 1)
  target_weights          jsonb,
  frozen_invested         numeric(18, 2),
  frozen_invested_basis   text,
  base_amount             numeric(18, 2),

  -- rowId → { assetId, etfName, label, ticker, orphaned }. 비교는 ticker 공간에서 한다
  row_meta                jsonb       not null,
  price_mode              text        not null,
  -- rowId → { ticker, price, source, asOf }. 가격을 못 받았으면 price=null (0 이 아니다)
  price_evidence          jsonb       not null,

  -- 'p<version>|<digest>'. 경제적 값만 들어간 canonical payload 의 해시
  plan_payload_hash       text        not null,
  hash_version            integer     not null default 1,
  actor                   text        not null,
  created_at              timestamptz not null default now(),

  constraint kaw_rebalance_plan_pkey
    primary key (family_code, profile, id),
  -- completion 1회 = 1행. id 와 중복이지만, completionId 로 직접 조회·조인할 때 쓴다
  constraint kaw_rebalance_plan_completion_uq
    unique (family_code, profile, completion_id),
  constraint kaw_rebalance_plan_account_chk
    check (account_type in ('retirement', 'isa', 'pension', 'irp')),
  -- 'future' 가 없는 것이 의도다 — 아직 하지 않은 리밸런싱은 증거가 아니다
  constraint kaw_rebalance_plan_date_mode_chk
    check (date_mode in ('today', 'past')),
  constraint kaw_rebalance_plan_pre_basis_chk
    check (pre_basis in ('session_snapshot', 'unknown')),
  constraint kaw_rebalance_plan_price_mode_chk
    check (price_mode in ('live', 'history', 'manual')),
  -- 폐기 사유는 네 값뿐이다(PreDiscardReason). null 은 "폐기할 일이 없었다" 는 정상 상태라
  -- 허용한다 — plan 은 immutable 이라 오타 값이 한 번 들어가면 영구히 남는다.
  constraint kaw_rebalance_plan_pre_discard_chk
    check (pre_discard_reason is null
           or pre_discard_reason in ('no_session', 'past_date_mode',
                                     'date_mode_changed', 'instance_changed')),
  constraint kaw_rebalance_plan_frozen_basis_chk
    check (frozen_invested_basis is null
           or frozen_invested_basis in ('entry_freeze', 'remount_refreeze', 'manual', 'unknown')),
  -- 예수금 주장은 음수가 될 수 없다 (normalizeAssertedCash 와 같은 규칙)
  constraint kaw_rebalance_plan_asserted_cash_chk
    check (asserted_post_cash >= 0)
);

comment on table public.kaw_rebalance_plan is
  '리밸런싱 완료 1회의 durable 증거. 사용자가 무엇을 하려 했고(planned) 무엇을 했다고 주장하는가(asserted)만 담는다 — 실제 체결 증거는 kaw_transaction_ledger 에만 있고 이 행의 어떤 값으로도 거래를 합성하지 않는다. 저장 후 불변이며 immutable 은 권한으로 강제한다(service_role 에 SELECT/INSERT 만). 완료 1회 = 1행이고 id 는 completionId 에서 결정적으로 나오므로 재전송은 PK 충돌 = ACK 다.';
comment on column public.kaw_rebalance_plan.pre_quantities is
  'PRE 보유수량(rowId → 수량). pre_basis = ''unknown'' 이면 반드시 null 이다 — 현재 보유수량이나 target delta 로 역산해 채우지 않는다.';
comment on column public.kaw_rebalance_plan.app_state_quantities_at_record is
  '완료 시점의 앱 상태. **PRE 가 아니다** — 수량 편집 1초 뒤 디바운스가 planned 값으로 덮으므로 PRE 근거가 될 수 없다. 포렌식 전용.';
comment on column public.kaw_rebalance_plan.target_weights is
  '당시 목표비중. intention data 로만 보존한다 — 실제 매매가 그대로 이루어지지 않는 경우가 많아 ledger 행을 만드는 근거로 쓰지 않는다(004 대원칙 2 / rebalance-plan.test.ts D9).';
comment on column public.kaw_rebalance_plan.account_ref_fingerprint is
  '계좌 참조 지문(HMAC 파생). identity 가 아니라 credential drift 탐지기다. 계산은 Phase 3 이며 그 전까지 항상 null — 클라이언트가 보낸 값을 그대로 저장하지 않는다.';
comment on column public.kaw_rebalance_plan.plan_payload_hash is
  '경제적 값만 들어간 canonical payload 의 해시(p<version>|<digest>). 같은 completion 재시도는 같은 id + 같은 해시, 다른 completion 인데 경제값이 같으면 다른 id + 같은 해시(재기록 탐지)다. 서버가 요청 본문으로 재계산해 검증한다.';

-- id 모양 / PRE null 정책 / 해시 버전 prefix 는 CREATE TABLE 밖에서 건다.
-- `create table if not exists` 는 모양이 다른 동명 테이블이 이미 있으면 조용히 통과하므로,
-- 그 경우에도 제약이 붙게 하려면 별도 ALTER 가 필요하다. 아래는 멱등하다.
do $$
begin
  -- id 는 completion_id 에서 결정적으로 나온다. 앱의 규칙과 DB 가 믿는 규칙을 일치시킨다.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_rebalance_plan'::regclass
       and conname  = 'kaw_rebalance_plan_id_shape_chk'
  ) then
    alter table public.kaw_rebalance_plan
      add constraint kaw_rebalance_plan_id_shape_chk
      check (id = 'plan:' || completion_id);
  end if;

  -- **PRE 역산 금지의 DB 레벨 방어선.**
  --   unknown         → pre_quantities / pre_cash 둘 다 null
  --   session_snapshot → pre_quantities 는 not null (pre_cash 는 null 허용 = 당시 미입력)
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_rebalance_plan'::regclass
       and conname  = 'kaw_rebalance_plan_pre_null_chk'
  ) then
    alter table public.kaw_rebalance_plan
      add constraint kaw_rebalance_plan_pre_null_chk
      check (
        (pre_basis = 'unknown' and pre_quantities is null and pre_cash is null)
        or (pre_basis = 'session_snapshot' and pre_quantities is not null)
      );
  end if;

  -- 해시 문자열의 버전 prefix 와 hash_version 컬럼이 어긋나지 않게 한다(004 와 같은 규칙).
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_rebalance_plan'::regclass
       and conname  = 'kaw_rebalance_plan_hash_version_chk'
  ) then
    alter table public.kaw_rebalance_plan
      add constraint kaw_rebalance_plan_hash_version_chk
      check (plan_payload_hash like 'p' || hash_version::text || '|%');
  end if;
end $$;

-- 같은 경제값의 재기록 탐지 — "다른 completionId 인데 같은 해시" 를 찾는 조회다.
create index if not exists kaw_rebalance_plan_hash_idx
  on public.kaw_rebalance_plan (family_code, profile, plan_payload_hash);
-- 계좌 instance × 날짜 조회 (reconcile / 이력 화면)
create index if not exists kaw_rebalance_plan_instance_idx
  on public.kaw_rebalance_plan (family_code, profile, account_instance_id, plan_date desc);
create index if not exists kaw_rebalance_plan_lookup_idx
  on public.kaw_rebalance_plan (family_code, profile, account_type, plan_date desc);

-- ── 2. 결제 관측 — 증권사가 말한 계좌 상태 (append-only) ────────────────────
-- 한 refresh 에서 나온 part 들이 같은 capture_id 를 공유한다. holdings 와 cash 가
-- 다른 API 호출인 계좌(IRP: TTTC2202R / TTTC0506R)에서 오전 holdings 와 오후 cash 가
-- 섞이는 것을 구조적으로 막는다 — capture 단위 해시가 그 역할을 한다.
create table if not exists public.kaw_settlement_observation (
  family_code             text        not null,
  profile                 text        not null,
  -- 'obs:<capture_id>:<source_type>'. 한 capture 안에서 source 는 유일하다
  id                      text        not null,
  -- 'cap:<instance>:<stateAsOf>:<hash12>'. 같은 refresh 를 두 번 조회하면 같은 값
  capture_id              text        not null,

  account_type            text        not null,
  broker                  text        not null,
  broker_product_code     text,
  account_instance_id     text        not null,
  account_ref_fingerprint text,

  -- 우리가 조회한 시각. **해시에 들어가지 않는다** — 넣으면 조회마다 행이 쌓여 폴링 로그가 된다
  observed_at             timestamptz not null,
  -- 증권사가 말하는 상태 기준일. **추정 날짜를 넣지 않는다**(대원칙 6)
  state_as_of             date        not null,
  state_as_of_basis       text        not null,
  settlement_basis        text        not null,
  -- 조회 경로. **CHECK 를 걸지 않는다** — source registry 는 앞으로 늘어난다
  -- (004 의 kaw_rebalance_event.type 과 같은 이유)
  source_type             text        not null,

  -- ticker → 수량. 보고하지 않으면 **null**. 0 으로 채우지 않고, 빈 객체와도 다르다
  holdings                jsonb,
  holdings_completeness   text        not null default 'unknown',
  cash                    numeric(18, 2),
  acquisition_cost        jsonb,
  account_total           numeric(18, 2),

  capture_payload_hash    text        not null,
  hash_version            integer     not null default 1,
  note                    text,
  actor                   text        not null,
  created_at              timestamptz not null default now(),

  constraint kaw_settlement_observation_pkey
    primary key (family_code, profile, id),
  constraint kaw_settlement_observation_account_chk
    check (account_type in ('retirement', 'isa', 'pension', 'irp')),
  constraint kaw_settlement_observation_state_basis_chk
    check (state_as_of_basis in ('broker_reported_date', 'observation_date')),
  constraint kaw_settlement_observation_settlement_basis_chk
    check (settlement_basis in ('settlement', 'trade', 'unknown')),
  constraint kaw_settlement_observation_completeness_chk
    check (holdings_completeness in ('all_positions', 'non_zero_only', 'partial', 'unknown'))
);

comment on table public.kaw_settlement_observation is
  '증권사가 보고한 계좌 상태 관측 1건(part). 같은 refresh 의 part 들이 capture_id 를 공유해 holdings 와 cash 가 다른 순간의 값으로 섞이는 것을 막는다. append-only — 잘못된 관측은 고치지 않고 올바른 값으로 새 관측을 넣은 뒤 kaw_settlement_observation_void 로 제외한다. 추정 날짜를 넣지 않는다: state_as_of 는 증권사가 말한 기준일이고 결제일로 소급하지 않는다. append-only 는 권한으로 강제한다(service_role 에 SELECT/INSERT 만).';
comment on column public.kaw_settlement_observation.holdings is
  'ticker → 수량. 보고하지 않으면 null 이며 0 으로 채우지 않는다. 빈 객체({})는 "전부 0주로 보고했다"이고 null 과 다르다.';
comment on column public.kaw_settlement_observation.source_type is
  '조회 경로 식별자(source registry 키). CHECK 를 걸지 않는다 — 경로는 앞으로 늘어나고, 모르는 source 는 registry 에서 unknown capability 로 떨어진다.';

do $$
begin
  -- id 모양 고정. capture 안에서 source_type 이 유일하다는 규칙을 DB 도 믿게 한다.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_settlement_observation'::regclass
       and conname  = 'kaw_settlement_observation_id_shape_chk'
  ) then
    alter table public.kaw_settlement_observation
      add constraint kaw_settlement_observation_id_shape_chk
      check (id = 'obs:' || capture_id || ':' || source_type);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_settlement_observation'::regclass
       and conname  = 'kaw_settlement_observation_hash_version_chk'
  ) then
    alter table public.kaw_settlement_observation
      add constraint kaw_settlement_observation_hash_version_chk
      check (capture_payload_hash like 'c' || hash_version::text || '|%');
  end if;
end $$;

create index if not exists kaw_settlement_observation_capture_idx
  on public.kaw_settlement_observation (family_code, profile, capture_id);
create index if not exists kaw_settlement_observation_instance_idx
  on public.kaw_settlement_observation (family_code, profile, account_instance_id, state_as_of desc);
create index if not exists kaw_settlement_observation_lookup_idx
  on public.kaw_settlement_observation (family_code, profile, account_type, state_as_of desc);

-- ── 3. 관측 void overlay — 삭제가 아닌 제외 ─────────────────────────────────
-- 관측 1건에 void 는 최대 1개다(PK). 되돌리기는 이 행의 삭제이므로 overlay 는
-- update/delete 권한을 받는다 — 004 의 correction / event_override 와 같은 성격이다.
create table if not exists public.kaw_settlement_observation_void (
  family_code    text        not null,
  profile        text        not null,
  observation_id text        not null,

  -- **사유 없는 void 를 만들지 않는다.** 빈 문자열도 막는다
  reason         text        not null,
  -- 이 관측을 대체하는 올바른 관측. 없으면 null (대체 없이 제외만 하는 경우)
  replaced_by    text,
  actor          text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint kaw_settlement_observation_void_pkey
    primary key (family_code, profile, observation_id),
  constraint kaw_settlement_observation_void_reason_chk
    check (length(btrim(reason)) > 0),
  -- 자기 자신을 대체본으로 가리키는 행은 만들 수 없다
  constraint kaw_settlement_observation_void_self_chk
    check (replaced_by is null or replaced_by <> observation_id)
);

comment on table public.kaw_settlement_observation_void is
  '잘못된 관측을 계산에서 제외하는 overlay. 물리 삭제가 아니며 이 행을 지우면 관측이 되살아난다. 관측 1건에 최대 1개. 필드 단위 correction 을 만들지 않는 이유는 관측값의 일부를 고치면 그 숫자의 provenance 가 사라지기 때문이다 — 올바른 값은 새 관측으로 넣고 replaced_by 로 연결한다.';

-- FK 를 만들지 않는다: 004 와 같은 이유로 service_role 에 REFERENCES 권한을 주지
-- 않으며, 관측이 아직 적재되지 않은 상태에서 void 를 먼저 넣는 복구 순서도 막지 않는다.
-- 고아 void 는 조회 시 자연히 무시된다(void 는 관측을 걸러내는 쪽에서만 쓰인다).

create index if not exists kaw_settlement_observation_void_replaced_idx
  on public.kaw_settlement_observation_void (family_code, profile, replaced_by);

-- ── 4. audit 대상 확장 ──────────────────────────────────────────────────────
-- 004 의 kaw_ledger_audit 을 그대로 쓴다. target_type 에 두 값만 **추가**한다.
-- action 에는 CHECK 가 없으므로 새 action 은 DDL 없이 쓸 수 있다
-- ('plan_write' / 'observation_capture' / 'observation_void' / 'observation_unvoid').
--
-- 004 가 아직 적용되지 않은 DB 에서도 005 가 실패하지 않도록 테이블 존재를 확인한다.
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
      check (target_type in ('transaction', 'event', 'import', 'plan', 'observation'));
  end if;
exception
  when undefined_table then
    raise notice 'kaw_ledger_audit 이 없습니다 (004 미적용). audit 대상 확장을 건너뜁니다.';
end $$;

-- ── 보안 ────────────────────────────────────────────────────────────────────
--
-- **004 의 보안 섹션과 같은 방식이고, 같은 함정이 있다.** 요약하면:
--
--   1) RLS 를 켜고 정책을 만들지 않는다 → anon/authenticated 는 전부 차단된다.
--      **service_role 은 BYPASSRLS** 라 RLS 로 걸러지지 않으므로 GRANT 가 유일한
--      방어선이다.
--
--   2) **필요한 것만 grant 하는 것으로는 부족하다 — 먼저 전부 회수해야 한다.**
--      Supabase 는 public 스키마 기본 권한으로 **새 테이블에 anon·authenticated·
--      service_role 전부 ALL 을 붙인 채로** 만든다. GRANT 는 가산이라 "select, insert
--      만 grant" 는 빼기가 되지 않는다. revoke 를 먼저 하지 않으면 plan immutable 도
--      관측 append-only 도 **전혀 성립하지 않는다.**
--
--      owner(postgres)는 건드리지 않는다 — 여기서 말하는 immutable 은 "Worker 가 쓰는
--      service_role 키로는 바꾸거나 지울 수 없다"는 뜻이다.
--
--   3) service_role 에 **필요한 것만** 다시 부여한다.
--
--        kaw_rebalance_plan                select, insert                  (immutable)
--        kaw_settlement_observation        select, insert                  (append-only)
--        kaw_settlement_observation_void   select, insert, update, delete  (overlay)
--
--      세 테이블 모두 TRUNCATE / REFERENCES / TRIGGER 는 주지 않는다.
--      void 에만 update/delete 가 필요한 이유는 사유 수정이 upsert 이고 "복원"이 행
--      삭제이기 때문이다. plan 과 관측에는 그런 경로가 **아예 없다** —
--      plan 재전송은 INSERT 시도이고 PK 충돌이 곧 성공 응답이다(upsert 를 쓰지 않는다).
--
-- 이 블록은 멱등하다.
alter table public.kaw_rebalance_plan              enable row level security;
alter table public.kaw_settlement_observation      enable row level security;
alter table public.kaw_settlement_observation_void enable row level security;

-- 2) 기존 권한을 **전부** 회수한다 (PUBLIC / anon / authenticated / service_role).
revoke all on public.kaw_rebalance_plan
  from public, anon, authenticated, service_role;
revoke all on public.kaw_settlement_observation
  from public, anon, authenticated, service_role;
revoke all on public.kaw_settlement_observation_void
  from public, anon, authenticated, service_role;

-- 3) service_role 에 필요한 것만 부여한다.
--    PUBLIC / anon / authenticated 에는 **아무것도 주지 않는다**.
grant select, insert                 on public.kaw_rebalance_plan              to service_role;
grant select, insert                 on public.kaw_settlement_observation      to service_role;
grant select, insert, update, delete on public.kaw_settlement_observation_void to service_role;

-- updated_at 자동 갱신 (003 이 만든 공용 트리거 함수를 재사용한다 — 새로 만들지 않는다)
drop trigger if exists kaw_settlement_observation_void_touch
  on public.kaw_settlement_observation_void;
create trigger kaw_settlement_observation_void_touch
  before update on public.kaw_settlement_observation_void
  for each row execute function public.kaw_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 후 검증 (SQL Editor 에서 하나씩 실행한다. 아래는 전부 주석이다)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- (a) 테이블 3개가 생겼는가 — 3행이어야 한다
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('kaw_rebalance_plan','kaw_settlement_observation',
--                         'kaw_settlement_observation_void')
--    order by table_name;
--
-- (b) RLS 가 켜져 있고 정책이 0개인가 — rls_enabled 가 전부 t, policies 가 전부 0
--   select c.relname, c.relrowsecurity as rls_enabled,
--          (select count(*) from pg_policies p
--            where p.schemaname = 'public' and p.tablename = c.relname) as policies
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public'
--      and c.relname in ('kaw_rebalance_plan','kaw_settlement_observation',
--                        'kaw_settlement_observation_void')
--    order by c.relname;
--
-- (c) **권한 표.** 기대값:
--       kaw_rebalance_plan               t  t  f  f   (select insert update delete)
--       kaw_settlement_observation       t  t  f  f
--       kaw_settlement_observation_void  t  t  t  t
--     update 가 t 로 보이면 revoke 가 빠진 것이다 — **그 상태로 쓰기를 시작하지 않는다.**
--   select t.name,
--          has_table_privilege('service_role', 'public.' || t.name, 'SELECT')   as sel,
--          has_table_privilege('service_role', 'public.' || t.name, 'INSERT')   as ins,
--          has_table_privilege('service_role', 'public.' || t.name, 'UPDATE')   as upd,
--          has_table_privilege('service_role', 'public.' || t.name, 'DELETE')   as del,
--          has_table_privilege('service_role', 'public.' || t.name, 'TRUNCATE') as trunc,
--          has_table_privilege('service_role', 'public.' || t.name, 'REFERENCES') as refs,
--          has_table_privilege('service_role', 'public.' || t.name, 'TRIGGER')  as trig
--     from (values ('kaw_rebalance_plan'), ('kaw_settlement_observation'),
--                  ('kaw_settlement_observation_void')) as t(name)
--    order by t.name;
--
-- (d) anon / authenticated 에 아무 권한도 없는가 — 전부 f 여야 한다
--   select t.name, r.role,
--          has_table_privilege(r.role, 'public.' || t.name, 'SELECT') as sel,
--          has_table_privilege(r.role, 'public.' || t.name, 'INSERT') as ins
--     from (values ('kaw_rebalance_plan'), ('kaw_settlement_observation'),
--                  ('kaw_settlement_observation_void')) as t(name),
--          (values ('anon'), ('authenticated')) as r(role)
--    order by t.name, r.role;
--
-- (e) CHECK 제약이 다 붙었는가 — 아래 이름들이 전부 보여야 한다
--   select conrelid::regclass as tbl, conname
--     from pg_constraint
--    where conrelid in ('public.kaw_rebalance_plan'::regclass,
--                       'public.kaw_settlement_observation'::regclass,
--                       'public.kaw_settlement_observation_void'::regclass)
--      and contype = 'c'
--    order by 1, 2;
--   -- 기대: plan 에 account/date_mode/pre_basis/price_mode/pre_discard/frozen_basis/asserted_cash
--   --       + id_shape / pre_null / hash_version
--   --       observation 에 account/state_basis/settlement_basis/completeness
--   --       + id_shape / hash_version
--   --       void 에 reason / self
--
-- (f) audit 대상이 5값으로 확장됐는가 — 'plan' 과 'observation' 이 보여야 한다
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.kaw_ledger_audit'::regclass
--      and conname  = 'kaw_ledger_audit_target_chk';
--
-- (g) **PRE 역산 금지 제약이 실제로 막는가** (롤백되는 트랜잭션으로 확인한다)
--     expect: new row ... violates check constraint "kaw_rebalance_plan_pre_null_chk"
--   begin;
--     insert into public.kaw_rebalance_plan
--       (family_code, profile, id, completion_id, account_type, broker,
--        account_instance_id, plan_date, date_mode, pre_basis, pre_quantities,
--        planned_quantities, asserted_post_cash, row_meta, price_mode, price_evidence,
--        plan_payload_hash, hash_version, actor)
--     values ('__smoke__','__smoke__','plan:c1','c1','isa','__smoke__',
--             'bai:smoke','2026-10-12','today','unknown','{"kr": 1}'::jsonb,
--             '{}'::jsonb, 0, '{}'::jsonb, 'live', '{}'::jsonb, 'p1|deadbeef', 1, '__smoke__');
--   rollback;
--
-- (h) **id 모양 제약이 실제로 막는가**
--     expect: violates check constraint "kaw_rebalance_plan_id_shape_chk"
--   begin;
--     insert into public.kaw_rebalance_plan
--       (family_code, profile, id, completion_id, account_type, broker,
--        account_instance_id, plan_date, date_mode, pre_basis,
--        planned_quantities, asserted_post_cash, row_meta, price_mode, price_evidence,
--        plan_payload_hash, hash_version, actor)
--     values ('__smoke__','__smoke__','plan:WRONG','c1','isa','__smoke__',
--             'bai:smoke','2026-10-12','today','unknown',
--             '{}'::jsonb, 0, '{}'::jsonb, 'live', '{}'::jsonb, 'p1|deadbeef', 1, '__smoke__');
--   rollback;
--
-- (i) **해시 버전 prefix 제약** expect: violates ..._hash_version_chk
--   begin;
--     insert into public.kaw_rebalance_plan
--       (family_code, profile, id, completion_id, account_type, broker,
--        account_instance_id, plan_date, date_mode, pre_basis,
--        planned_quantities, asserted_post_cash, row_meta, price_mode, price_evidence,
--        plan_payload_hash, hash_version, actor)
--     values ('__smoke__','__smoke__','plan:c1','c1','isa','__smoke__',
--             'bai:smoke','2026-10-12','today','unknown',
--             '{}'::jsonb, 0, '{}'::jsonb, 'live', '{}'::jsonb, 'p2|deadbeef', 1, '__smoke__');
--   rollback;
--
-- (j) **plan 이 정말 immutable 인가** — service_role 로 접속한 세션에서 실행한다.
--     SQL Editor 는 owner 권한이라 통과해버린다(004 의 (k) 와 같은 주의).
--     expect: permission denied for table kaw_rebalance_plan
--   update public.kaw_rebalance_plan set actor = 'X' where false;
--   delete from public.kaw_rebalance_plan where false;
--   update public.kaw_settlement_observation set note = 'X' where false;
--   delete from public.kaw_settlement_observation where false;
--
-- (k) smoke 행 정리 — (g)~(i) 는 rollback 하므로 남지 않지만 확인해 둔다. 0행이어야 한다
--   select count(*) from public.kaw_rebalance_plan         where family_code = '__smoke__';
--   select count(*) from public.kaw_settlement_observation where family_code = '__smoke__';
