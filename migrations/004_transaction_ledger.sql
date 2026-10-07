-- ─────────────────────────────────────────────────────────────────────────────
-- 거래 원장 (Transaction Ledger) + 리밸런싱 이벤트 — migration 004
--
-- 배경: 지금까지 "리밸런싱 이력"은 `kaw_data.data -> 'history'` 안의 **상태 스냅샷**이었다.
--       한 항목이 "리밸런싱을 저장한 날의 보유수량/평가액"일 뿐이라, 매수·매도 구분도
--       체결가도 체결수량도 들어 있지 않다. 수량 변화는 연속한 두 항목을 빼야만 추정된다.
--
--       실제 증권사 체결내역(미래에셋 DC/IRP 매매내역, ISA/연금 거래내역)을 확보했으므로,
--       **리밸런싱 이력의 source of truth 를 실제 체결내역으로 바꾼다.**
--
-- ── 이 마이그레이션의 대원칙 ────────────────────────────────────────────────
--
--   1. **원본은 고치지 않는다.** 증권사에서 받은 체결 1건 = `kaw_transaction_ledger` 1행이고,
--      사용자의 정정·분류·메모는 전부 **별도 overlay 테이블**에 쌓인다. 원본 행은 import
--      이후 UPDATE 되지 않는다(정정도 overlay 다). 물리 삭제도 하지 않는다(제외는 플래그다).
--
--   2. **목표비중으로 과거를 역산하지 않는다.** 과거에 설정했던 목표비중은 당시 의사결정
--      참고자료일 뿐이고 실제 매매가 그대로 이루어지지 않은 경우가 많다. 이 스키마에는
--      목표비중 컬럼이 아예 없다 — 과거 이력은 **실제 체결된 매수/매도**만으로 재구성한다.
--
--   3. **파생값을 저장하지 않는다.** 이벤트의 거래건수·매수금액·매도금액·전후 보유수량은
--      전부 소속 거래에서 계산된다. 사용자가 거래를 다른 이벤트로 옮기면 즉시 달라지므로,
--      컬럼으로 굳히면 그 순간 stale 해진다(003 주석의 "스냅샷에 외부흐름을 같이 저장하지
--      않는다"와 같은 이유). 계산은 앱의 순수 모듈 `src/lib/kaw/ledger.ts` 가 하고
--      테스트로 고정돼 있다.
--
--   4. **legacy `kaw_data.history` 는 삭제하지 않는다.** migration 검증·과거 기록 비교·
--      audit·호환 목적으로 그대로 둔다. 이 마이그레이션은 기존 테이블/뷰를 건드리지 않으며,
--      `kaw_portfolio_live_view` 와 `kaw_daily_portfolio_snapshots` 는 당분간 계속
--      history 를 읽는다. 전환은 원장 재생 결과가 현재 보유수량과 일치하는 것을 확인한
--      뒤 별도 단계에서 한다.
--
-- ── 계층 ────────────────────────────────────────────────────────────────────
--
--   kaw_transaction_ledger        개별 실제 체결 (가장 하위 원본)
--     └ kaw_transaction_correction  사용자 정정 overlay (원본을 덮지 않는다)
--     └ kaw_transaction_event_override  소속 이벤트 재지정 (병합/분리/이동)
--   kaw_rebalance_event           사용자에게 보여주는 매매 이벤트 (메모·태그·숨김)
--   kaw_ledger_audit              append-only 변경 이력
--
--   기본 grouping 규칙: **동일 계좌 + 동일 실효 거래일** → 이벤트 1개.
--   그래서 기본 이벤트 id 는 `rev:<account_type>:<event_date>` 로 **계산 가능**하다.
--   사용자가 병합/분리/이동하면 그 거래에만 override 행이 생기고, 원장은 그대로다.
--
-- ── 날짜 ────────────────────────────────────────────────────────────────────
--
--   trade_date           증권사가 직접 보고한 주문일. 퇴직연금/IRP 는 있고 ISA/연금은 없다.
--   settlement_date      결제일. ISA/연금 export 는 이쪽이 직접적인 사실이다.
--   inferred_trade_date  T+2 역산 등으로 추정한 거래일.
--   event_date           실제로 이벤트를 묶는 데 쓰는 날짜 = trade_date ?? inferred_trade_date.
--   trade_date_evidence  그 날짜의 근거. UI 는 이것을 **신뢰도로 노출**해야 한다.
--                        ('broker-order-date' 는 직접 사실, 나머지는 추정)
--
--   추정 날짜를 직접 사실인 것처럼 보여주지 않는다. 대신 사용자가 정정할 수 있게 한다
--   (corrected_trade_date overlay) — 그래도 원본 세 컬럼은 남는다.
--
-- 보안: 001/002/003 과 같은 철학. RLS on + 정책 0개, anon/authenticated GRANT 회수,
--       service_role 만 접근. 브라우저는 직접 붙지 않고 Worker 의 인증된 /api/* 만 쓴다.
--
-- ── 출처 추적(provenance)과 중복 적재 방지 ──────────────────────────────────
--
-- 앞으로 같은 원장에 **여러 경로**로 거래가 들어온다: 미래에셋 Excel, KIS API, 수동 보정.
-- 그래서 특정 파일에 종속되지 않는 신원과 적재 이력을 함께 둔다.
--
--   source_fingerprint  그 체결의 **안정적 신원**. UNIQUE 라서 같은 거래를 두 번 넣을 수 없다.
--   import_batch_id     어느 적재 작업에서 들어왔는가 (kaw_ledger_import_batch 참조)
--   source / source_file / source_row   원본 위치. **신원이 아니라 참고용**이다.
--
-- **왜 source_row 를 신원으로 쓰지 않는가 (실측):**
-- 미래에셋 export 는 둘 다 최신순이다 — DC 매매내역은 row 4 가 2026-10-01, row 456 이
-- 2025-05-14 다. 즉 거래가 하나 추가되면 **기존 행 번호가 전부 밀린다.** 재export 하면
-- 같은 체결이 다른 번호를 받으므로 (file, row) 는 재적재 시 중복을 만든다.
-- 사용자가 직접 보완한 10 행은 source_row 가 아예 없다.
--
-- 그래서 fingerprint 는 **내용 기반**이다 (src/lib/kaw/ledger.ts transactionFingerprint):
--   source | 계좌 | 종목 | 매매구분 | 수량 | 단가 | 금액 | 거래일 | 결제일 | 동일건순번
-- 마지막 "동일건순번"이 필요한 이유도 실측이다 — IRP 에 내용이 완전히 같은 분할체결이
-- 있다(2026-03-25 0072R0 1주 2건, 2026-08-28 438080 1주 3건). 순번이 없으면 5건이
-- 2건으로 뭉개진다.
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run. idempotent 다.
--       001 → 002 → 003 → 004 순서. 되돌리려면 `004_transaction_ledger_rollback.sql`.
--
-- 개정: provenance(import_batch_id / source_fingerprint)와 적재 이력 테이블은 **최초
--       적용 전에** 이 파일에 추가됐다. 004 는 아직 production 에 적용된 적이 없으므로
--       별도 패치 마이그레이션을 만들지 않고 이 파일을 고쳤다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. 적재 배치 — "이 거래들이 언제 어디서 들어왔나" ──────────────────────
-- 미래에셋 Excel / KIS API / 수동 보정이 모두 같은 원장에 쌓이므로, 묶음 단위로
-- 출처와 검증 결과를 남긴다. 나중에 "이 batch 만 되돌리기"도 이 id 로 할 수 있다.
create table if not exists public.kaw_ledger_import_batch (
  id              text        not null,
  family_code     text        not null,
  profile         text        not null,

  -- 'verified_dataset_v1' | 'kis_api' | 'manual' | ...
  source_kind     text        not null,
  -- 데이터셋 파일명·버전이나 API 조회 범위 등 사람이 읽을 출처 설명
  source_label    text,
  -- 적재한 데이터의 지문(파일 해시 등). 같은 입력을 두 번 넣었는지 눈으로 확인할 때 쓴다.
  source_checksum text,

  inserted_count  integer     not null default 0,
  -- 이미 같은 fingerprint 가 있어 건너뛴 건수. 재적재하면 여기가 늘고 inserted 는 0 이다.
  skipped_count   integer     not null default 0,
  -- 적재 전 게이트 결과 전문 (verifyDataset 결과). 나중에 왜 통과시켰는지 추적한다.
  verification    jsonb,
  actor           text        not null,
  created_at      timestamptz not null default now(),

  constraint kaw_ledger_import_batch_pkey primary key (family_code, profile, id)
);

comment on table public.kaw_ledger_import_batch is
  '원장 적재 묶음. 미래에셋 Excel / KIS API / 수동 보정이 같은 원장에 들어오므로 출처와 검증 결과를 묶음 단위로 남긴다. verification 에는 적재 전 게이트 결과 전문이 들어간다.';

-- ── 1. 거래 원장 — 개별 실제 체결 ───────────────────────────────────────────
create table if not exists public.kaw_transaction_ledger (
  family_code         text        not null,
  profile             text        not null,
  -- 체결 내용으로 만든 안정적 id (`vtx:<hash>`). 같은 파일을 다시 import 해도 같은 id 라서
  -- upsert 로 중복이 생기지 않는다.
  id                  text        not null,

  account_type        text        not null,
  ticker              text        not null,
  -- 체결 당시의 종목명. 종목명이 바뀌어도 그 때 받은 이름을 그대로 보존한다.
  etf_name            text        not null,
  side                text        not null,
  quantity            numeric(18, 4) not null,
  price               numeric(18, 4) not null,
  -- 증권사가 보고한 거래대금. quantity * price 와 반올림 차이가 있을 수 있어 따로 둔다.
  amount              numeric(18, 2) not null,

  trade_date          date,
  settlement_date     date,
  inferred_trade_date date,
  event_date          date        not null,
  trade_date_evidence text        not null,

  fee                 numeric(18, 2),
  tax                 numeric(18, 2),
  -- 증권사가 보고한 "거래 후 보유수량". 보고하지 않는 계좌(퇴직연금/IRP)는 null 이다.
  -- null 을 0 으로 채우지 않는다 — 모르는 것과 0 은 다르다.
  post_quantity       numeric(18, 4),

  -- 어디서 온 데이터인가. 나중에 KIS API 적재가 들어와도 같은 테이블에 다른 source 로 쌓는다.
  source              text        not null,
  -- 원본 위치. **신원이 아니라 참고용**이다 (재export 하면 행 번호가 밀린다 — 헤더 주석 참고).
  source_file         text,
  source_row          integer,
  -- 이 체결의 **안정적 신원**. 같은 거래를 두 번 넣는 것을 DB 레벨에서 막는다.
  source_fingerprint  text        not null,
  -- 어느 적재 작업에서 들어왔는가
  import_batch_id     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint kaw_transaction_ledger_pkey
    primary key (family_code, profile, id),
  -- **중복 적재 방지의 핵심.** 같은 데이터셋을 두 번 import 해도 2회차는 전부 충돌한다.
  constraint kaw_transaction_ledger_fingerprint_uq
    unique (family_code, profile, source_fingerprint),
  constraint kaw_transaction_ledger_account_chk
    check (account_type in ('retirement', 'isa', 'pension', 'irp')),
  constraint kaw_transaction_ledger_side_chk
    check (side in ('buy', 'sell')),
  constraint kaw_transaction_ledger_qty_chk
    check (quantity > 0),
  constraint kaw_transaction_ledger_price_chk
    check (price > 0)
);

comment on table public.kaw_transaction_ledger is
  '실제 증권사 체결내역 1건 = 1행. 리밸런싱 이력의 source of truth 다. 원본은 import 이후 수정하지 않는다 — 사용자 정정은 kaw_transaction_correction overlay 로, 소속 이벤트 변경은 kaw_transaction_event_override 로 쌓인다. 물리 삭제하지 않는다. 목표비중은 이 테이블에 없다(과거 이력은 실제 체결만으로 재구성한다).';
comment on column public.kaw_transaction_ledger.event_date is
  '이벤트 grouping 에 쓰는 실효 거래일 = trade_date ?? inferred_trade_date. 근거는 trade_date_evidence 에 있고 UI 는 추정 날짜를 직접 사실처럼 보여주지 않는다.';
comment on column public.kaw_transaction_ledger.post_quantity is
  '증권사가 보고한 거래 후 보유수량. 보고하지 않는 계좌는 null 이며 0 으로 채우지 않는다.';

comment on column public.kaw_transaction_ledger.source_fingerprint is
  '체결의 안정적 신원 (source|계좌|종목|매매구분|수량|단가|금액|거래일|결제일|동일건순번). source_row 는 재export 때 밀리므로 신원으로 쓰지 않는다. UNIQUE 제약이 중복 적재를 막는다.';

create index if not exists kaw_transaction_ledger_batch_idx
  on public.kaw_transaction_ledger (family_code, profile, import_batch_id);
create index if not exists kaw_transaction_ledger_lookup_idx
  on public.kaw_transaction_ledger (family_code, profile, account_type, event_date desc);
create index if not exists kaw_transaction_ledger_ticker_idx
  on public.kaw_transaction_ledger (family_code, profile, ticker, event_date desc);

-- ── 2. 거래 정정 overlay ────────────────────────────────────────────────────
-- 원본 행을 덮어쓰지 않는다. 유효값 = corrected_* ?? 원본. 되돌리려면 이 행만 지우면 된다.
-- `excluded` 는 "이 체결을 계산에서 빼라"는 뜻이고, 원본 행은 그대로 남는다.
create table if not exists public.kaw_transaction_correction (
  family_code         text        not null,
  profile             text        not null,
  transaction_id      text        not null,

  corrected_quantity  numeric(18, 4),
  corrected_price     numeric(18, 4),
  corrected_amount    numeric(18, 2),
  corrected_trade_date date,
  corrected_side      text,
  corrected_ticker    text,
  -- 계산에서 제외(중복 적재·취소된 주문 등). 삭제가 아니라 플래그다.
  excluded            boolean     not null default false,
  reason              text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint kaw_transaction_correction_pkey
    primary key (family_code, profile, transaction_id),
  constraint kaw_transaction_correction_side_chk
    check (corrected_side is null or corrected_side in ('buy', 'sell')),
  constraint kaw_transaction_correction_qty_chk
    check (corrected_quantity is null or corrected_quantity > 0),
  constraint kaw_transaction_correction_price_chk
    check (corrected_price is null or corrected_price > 0),
  constraint kaw_transaction_correction_fk
    foreign key (family_code, profile, transaction_id)
    references public.kaw_transaction_ledger (family_code, profile, id)
    on delete cascade
);

comment on table public.kaw_transaction_correction is
  '사용자가 정정한 거래정보. 원본(kaw_transaction_ledger)을 덮어쓰지 않고 overlay 로 쌓는다 — 유효값 = corrected_* ?? 원본. 이 행이 있으면 해당 거래는 "사용자 정정 데이터"로 표시된다. excluded 는 계산 제외 플래그이며 삭제가 아니다.';

-- ── 3. 소속 이벤트 재지정 overlay (병합 / 분리 / 이동) ──────────────────────
-- 기본 소속은 `rev:<account_type>:<event_date>` 로 계산된다. 이 테이블에 행이 있는
-- 거래만 다른 이벤트에 속한다. 되돌리려면 행을 지운다.
create table if not exists public.kaw_transaction_event_override (
  family_code     text        not null,
  profile         text        not null,
  transaction_id  text        not null,
  event_id        text        not null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint kaw_transaction_event_override_pkey
    primary key (family_code, profile, transaction_id),
  constraint kaw_transaction_event_override_fk
    foreign key (family_code, profile, transaction_id)
    references public.kaw_transaction_ledger (family_code, profile, id)
    on delete cascade
);

comment on table public.kaw_transaction_event_override is
  '거래의 소속 이벤트 재지정. 기본 소속은 rev:<account_type>:<event_date> 로 계산되고, 병합/분리/이동한 거래만 여기에 행이 생긴다. 원장은 건드리지 않는다.';

create index if not exists kaw_transaction_event_override_event_idx
  on public.kaw_transaction_event_override (family_code, profile, event_id);

-- ── 4. 리밸런싱 이벤트 — 사용자가 보는 매매 이력 단위 ───────────────────────
-- 거래건수·매수/매도 금액·전후 보유수량 같은 **파생값은 컬럼으로 두지 않는다.**
-- 소속 거래가 바뀌면 즉시 달라지므로 앱이 계산한다(ledger.ts, 테스트로 고정).
-- 기본 grouping 으로 만들어지는 이벤트는 행이 없어도 되고, 사용자가 메모/태그/숨김을
-- 건드리거나 분리로 새 이벤트를 만들 때만 행이 생긴다.
create table if not exists public.kaw_rebalance_event (
  family_code       text        not null,
  profile           text        not null,
  id                text        not null,

  account_type      text        not null,
  event_date        date        not null,
  -- 'rebalance' | 'pre_strategy_trade' | 'strategy_start' | 'contribution_buy' | ...
  -- 값을 check 로 묶지 않는다 — 유형은 앞으로 늘어난다(요구사항: 확장 가능한 구조).
  type              text        not null default 'rebalance',
  -- K-올웨더 전략 성과 집계에 포함되는 이벤트인가. 전략 시작 이전 매매는 false 다.
  strategy_included boolean     not null default true,

  memo              text,
  tags              text[]      not null default '{}',
  -- 숨김은 삭제가 아니다. 언제든 복원할 수 있어야 한다.
  hidden            boolean     not null default false,
  -- 사용자가 분리(split)로 직접 만든 이벤트. 기본 grouping 으로 생기지 않는다.
  is_user_created   boolean     not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint kaw_rebalance_event_pkey
    primary key (family_code, profile, id),
  constraint kaw_rebalance_event_account_chk
    check (account_type in ('retirement', 'isa', 'pension', 'irp'))
);

comment on table public.kaw_rebalance_event is
  '사용자에게 보여주는 매매 이벤트. 기본 grouping(동일 계좌 + 동일 event_date)으로 만들어지는 이벤트는 행이 없어도 되고, 메모/태그/숨김/분리가 있을 때만 행이 생긴다. 거래건수·금액·전후 보유수량 같은 파생값은 저장하지 않는다 — 소속 거래가 바뀌면 stale 해지므로 앱이 계산한다.';
comment on column public.kaw_rebalance_event.hidden is
  '숨김 플래그. 물리 삭제가 아니며 언제든 복원할 수 있다.';

create index if not exists kaw_rebalance_event_lookup_idx
  on public.kaw_rebalance_event (family_code, profile, event_date desc);

-- ── 5. 변경 이력 (append-only) ──────────────────────────────────────────────
-- UI 상의 분류 수정(병합/분리/이동/메모/태그/숨김)과 실제 거래정보 정정(tx_correct)을
-- action 으로 명확히 구분한다. previous_value / new_value 로 되돌릴 근거를 남긴다.
create table if not exists public.kaw_ledger_audit (
  id             bigint      generated always as identity primary key,
  family_code    text        not null,
  profile        text        not null,
  at             timestamptz not null default now(),
  -- 변경을 일으킨 프로필. 세션에서 가져온다(사용자가 입력하는 값이 아니다).
  actor          text        not null,
  -- 'import' | 'event_merge' | 'event_split' | 'tx_move' | 'memo_change'
  -- | 'tag_change' | 'event_hide' | 'event_restore' | 'tx_correct' | 'tx_uncorrect'
  action         text        not null,
  target_type    text        not null,
  target_id      text        not null,
  previous_value jsonb,
  new_value      jsonb,
  note           text,

  constraint kaw_ledger_audit_target_chk
    check (target_type in ('transaction', 'event', 'import'))
);

comment on table public.kaw_ledger_audit is
  'append-only 변경 이력. UI 분류 수정(event_merge/event_split/tx_move/memo_change/tag_change/event_hide/event_restore)과 실제 거래정보 정정(tx_correct)을 action 으로 구분한다. 행을 수정하거나 삭제하지 않는다.';

create index if not exists kaw_ledger_audit_lookup_idx
  on public.kaw_ledger_audit (family_code, profile, at desc);
create index if not exists kaw_ledger_audit_target_idx
  on public.kaw_ledger_audit (family_code, profile, target_type, target_id, at desc);

-- ── 보안 (001/002/003 과 동일) ──────────────────────────────────────────────
-- RLS 를 켜고 정책을 하나도 만들지 않는다 → anon/authenticated 는 전부 차단된다.
-- service_role 은 RLS 를 우회하므로 Worker 만 읽고 쓸 수 있다.
alter table public.kaw_ledger_import_batch         enable row level security;
alter table public.kaw_transaction_ledger          enable row level security;
alter table public.kaw_transaction_correction      enable row level security;
alter table public.kaw_transaction_event_override  enable row level security;
alter table public.kaw_rebalance_event             enable row level security;
alter table public.kaw_ledger_audit                enable row level security;

revoke all on public.kaw_ledger_import_batch        from anon, authenticated;
revoke all on public.kaw_transaction_ledger         from anon, authenticated;
revoke all on public.kaw_transaction_correction     from anon, authenticated;
revoke all on public.kaw_transaction_event_override from anon, authenticated;
revoke all on public.kaw_rebalance_event            from anon, authenticated;
revoke all on public.kaw_ledger_audit               from anon, authenticated;

-- 원장은 import 로만 들어온다. 정정은 overlay 이므로 update 권한을 주지 않는다
-- (재import 시 충돌 해결을 위해 upsert 가 필요하면 그때 열어도 늦지 않다).
grant select, insert         on public.kaw_ledger_import_batch        to service_role;
grant select, insert         on public.kaw_transaction_ledger         to service_role;
grant select, insert, update, delete on public.kaw_transaction_correction     to service_role;
grant select, insert, update, delete on public.kaw_transaction_event_override to service_role;
grant select, insert, update, delete on public.kaw_rebalance_event            to service_role;
-- audit 는 append-only — update/delete 를 주지 않는다.
grant select, insert         on public.kaw_ledger_audit               to service_role;

-- updated_at 자동 갱신 (003 에서 만든 공용 트리거 함수를 재사용한다)
create or replace function public.kaw_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kaw_transaction_correction_touch on public.kaw_transaction_correction;
create trigger kaw_transaction_correction_touch
  before update on public.kaw_transaction_correction
  for each row execute function public.kaw_touch_updated_at();

drop trigger if exists kaw_transaction_event_override_touch on public.kaw_transaction_event_override;
create trigger kaw_transaction_event_override_touch
  before update on public.kaw_transaction_event_override
  for each row execute function public.kaw_touch_updated_at();

drop trigger if exists kaw_rebalance_event_touch on public.kaw_rebalance_event;
create trigger kaw_rebalance_event_touch
  before update on public.kaw_rebalance_event
  for each row execute function public.kaw_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 검증 쿼리 — 적용 직후, 그리고 import 뒤에 실행해서 눈으로 확인한다.
-- (주석을 풀고 family_code / profile 을 채워서 쓴다.)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- -- (a) 테이블 5개가 생겼는가
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'kaw_%ledger%'
--     or table_schema = 'public' and table_name in
--        ('kaw_transaction_correction','kaw_transaction_event_override','kaw_rebalance_event');
--
-- -- (b) anon/authenticated 에 권한이 남아 있지 않은가 (0행이어야 한다)
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated')
--    and table_name in ('kaw_transaction_ledger','kaw_transaction_correction',
--                       'kaw_transaction_event_override','kaw_rebalance_event','kaw_ledger_audit');
--
-- -- (c) import 후 계좌별 건수 — 기대값 retirement 227 / irp 65 / isa 85 / pension 86
-- select account_type, count(*) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>' group by 1 order by 1;
--
-- -- (d) import 후 원장 재생 최종 보유수량 — 데이터셋 validation.finalHoldings 와 대조한다.
-- --     (매수 +, 매도 - 로 누적. 음수가 나오면 적재가 잘못된 것이다.)
-- select account_type, ticker,
--        sum(case when side = 'buy' then quantity else -quantity end) as qty
--   from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>'
--  group by 1, 2 having sum(case when side = 'buy' then quantity else -quantity end) <> 0
--  order by 1, 2;
--
-- -- (e) 기본 grouping 기준 이벤트 수 — 기대값 합계 65
-- select account_type, count(distinct event_date) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>' group by 1 order by 1;
--
-- -- (f) 중복 적재가 없는가 — fingerprint 당 1행이어야 한다 (0행이 정상)
-- select source_fingerprint, count(*) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>'
--  group by 1 having count(*) > 1;
--
-- -- (g) 적재 배치 이력 — 재적재하면 inserted 0 / skipped 463 인 행이 하나 더 생긴다
-- select id, source_kind, source_label, inserted_count, skipped_count, created_at
--   from public.kaw_ledger_import_batch
--  where family_code = '<CODE>' and profile = '<PROFILE>' order by created_at desc;
--
-- -- (h) 추정 날짜 비율 (UI 신뢰도 표시의 근거)
-- select trade_date_evidence, count(*) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>' group by 1 order by 2 desc;
