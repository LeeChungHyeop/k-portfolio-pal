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
-- 보안: RLS on + 정책 0개, service_role 만 접근, 브라우저는 Worker 의 인증된 /api/* 만.
--       철학은 001/002/003 과 같지만 **권한 설정 방식이 다르다** — Supabase 는 public
--       스키마 기본 권한으로 새 테이블에 anon/authenticated/service_role 전부 ALL 을
--       붙이므로, 001~003 처럼 anon/authenticated 만 회수하면 service_role 은 UPDATE/
--       DELETE/TRUNCATE 를 그대로 갖는다. 그러면 원장 immutable 도 audit append-only 도
--       성립하지 않는다. 그래서 004 는 **네 주체(PUBLIC/anon/authenticated/service_role)
--       의 권한을 먼저 전부 회수하고 service_role 에 필요한 것만 다시 준다.**
--       자세한 내용과 최종 권한표는 아래 "보안" 섹션에 있다.
--
-- ── 출처 추적(provenance)과 중복 적재 방지 ──────────────────────────────────
--
-- 앞으로 같은 원장에 **여러 경로**로 거래가 들어온다: 미래에셋 Excel, KIS API, 수동 보정.
-- 그래서 특정 파일에 종속되지 않는 신원과 적재 이력을 함께 둔다.
--
--   source_fingerprint  그 체결의 **안정적 신원**. UNIQUE 라서 같은 거래를 두 번 넣을 수 없다.
--   fingerprint_version 그 신원을 만든 규칙의 버전. KIS API 등 다른 source 가 들어오면
--                       중복 판정 규칙이 달라질 수 있어서 둔다(문자열 맨 앞에도 들어간다).
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
-- 개정: 아래 항목들은 **최초 적용 전에** 이 파일에 직접 반영됐다. 004 는 production 에
--       적용된 적이 없으므로 별도 패치 마이그레이션을 만들지 않았다.
--        · provenance(import_batch_id / source_fingerprint)와 적재 이력 테이블 추가
--        · 권한을 "전부 회수 후 재부여" 방식으로 교체 (위 보안 항목)
--        · kaw_transaction_ledger_fp_version_chk / kaw_transaction_correction_nonempty_chk 추가
--        · 검증 섹션에 실효 권한(has_table_privilege) 확인과 smoke test (j)(k) 추가
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
  '원장 적재 묶음. 미래에셋 Excel / KIS API / 수동 보정이 같은 원장에 들어오므로 출처와 검증 결과를 묶음 단위로 남긴다. verification 에는 적재 전 게이트 결과 전문이 들어간다. 기록 후 불변 — service_role 에 SELECT/INSERT 만 있다(owner 는 예외).';

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
  -- 그 신원을 만든 **규칙의 버전**. KIS API 처럼 다른 source 가 들어오면 중복 판정에 쓸
  -- 필드가 달라지므로(주문번호/체결번호 등) 규칙을 바꿀 수 있어야 한다. 버전은
  -- fingerprint 문자열 맨 앞("v1|...")에도 들어가서 서로 다른 규칙의 신원이 우연히
  -- 같아지지 않는다. 규칙을 바꾸면 기존 행을 재계산하는 마이그레이션을 같이 쓴다.
  fingerprint_version integer     not null default 1,
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
  '실제 증권사 체결내역 1건 = 1행. 리밸런싱 이력의 source of truth 다. 원본은 import 이후 수정하지 않는다 — 사용자 정정은 kaw_transaction_correction overlay 로, 소속 이벤트 변경은 kaw_transaction_event_override 로 쌓인다. 물리 삭제하지 않는다. immutable 은 관례가 아니라 권한으로 강제한다: service_role 에 SELECT/INSERT 만 있고 UPDATE/DELETE/TRUNCATE 는 회수돼 있다(owner 는 예외). 목표비중은 이 테이블에 없다(과거 이력은 실제 체결만으로 재구성한다).';
comment on column public.kaw_transaction_ledger.event_date is
  '이벤트 grouping 에 쓰는 실효 거래일 = trade_date ?? inferred_trade_date. 근거는 trade_date_evidence 에 있고 UI 는 추정 날짜를 직접 사실처럼 보여주지 않는다.';
comment on column public.kaw_transaction_ledger.post_quantity is
  '증권사가 보고한 거래 후 보유수량. 보고하지 않는 계좌는 null 이며 0 으로 채우지 않는다.';

comment on column public.kaw_transaction_ledger.source_fingerprint is
  '체결의 안정적 신원 (v1: v1|source|계좌|종목|매매구분|수량|단가|금액|거래일|결제일|동일건순번). source_row 는 재export 때 밀리므로 신원으로 쓰지 않는다. UNIQUE 제약이 중복 적재를 막는다.';
comment on column public.kaw_transaction_ledger.fingerprint_version is
  'source_fingerprint 를 만든 규칙의 버전. 규칙이 바뀌면(예: KIS API 의 체결번호 기반 v2) 올리고 기존 행을 재계산한다. 한 profile 안에 두 버전이 섞이면 같은 거래가 다른 신원으로 두 번 들어갈 수 있으므로 섞어두지 않는다.';

create index if not exists kaw_transaction_ledger_batch_idx
  on public.kaw_transaction_ledger (family_code, profile, import_batch_id);
create index if not exists kaw_transaction_ledger_lookup_idx
  on public.kaw_transaction_ledger (family_code, profile, account_type, event_date desc);
create index if not exists kaw_transaction_ledger_ticker_idx
  on public.kaw_transaction_ledger (family_code, profile, ticker, event_date desc);

-- fingerprint 문자열의 버전 prefix 와 fingerprint_version 컬럼이 어긋나지 않게 한다.
-- 둘이 따로 놀면 "한 profile 안에 두 버전을 섞지 않는다"는 규칙을 (f-2) 쿼리로도
-- 탐지하지 못한다 — 컬럼은 1인데 문자열은 v2 인 행을 세면 버전이 하나로 보이기 때문이다.
--
-- CREATE TABLE 안이 아니라 밖에 두는 이유: `create table if not exists` 는 모양이 다른
-- 동명 테이블이 이미 있으면 조용히 통과하므로, 그 경우에도 제약이 붙게 하려면 별도
-- ALTER 가 필요하다. 아래 블록은 멱등하다(이미 있으면 아무것도 하지 않는다).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_transaction_ledger'::regclass
       and conname  = 'kaw_transaction_ledger_fp_version_chk'
  ) then
    alter table public.kaw_transaction_ledger
      add constraint kaw_transaction_ledger_fp_version_chk
      check (source_fingerprint like 'v' || fingerprint_version::text || '|%');
  end if;
end $$;

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

-- 아무것도 정정하지 않는 행을 막는다.
--
-- 이 overlay 의 유효값 규칙은 `corrected_* ?? 원본` 이다(ledger.ts effectiveTransaction).
-- 즉 **null 은 "이 필드는 정정하지 않았다"는 뜻이고, "null 로 정정했다"를 표현할 방법이
-- 애초에 없다.** 정정 대상 6 필드가 전부 null 이고 excluded 도 false 인 행은 어떤 값도
-- 바꾸지 않으면서, 테이블 주석대로 그 거래를 "사용자 정정 데이터"로 잘못 배지하기만 한다
-- (reason 만 적힌 행이 그렇다). 원본으로 되돌리는 방법은 이 행을 **지우는 것**이다
-- (ledger-server.ts 의 clear: true 경로).
--
-- UI 는 이미 변경이 없으면 저장 버튼이 비활성이라 이런 행을 만들지 않는다. 이 CHECK 는
-- API 를 직접 호출하는 경로에 대한 방어선이고, handleLedgerCorrectPost 가 같은 조건을
-- 먼저 검사해 400 으로 돌려주므로 여기까지 오는 일은 정상 경로에서 없다.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.kaw_transaction_correction'::regclass
       and conname  = 'kaw_transaction_correction_nonempty_chk'
  ) then
    alter table public.kaw_transaction_correction
      add constraint kaw_transaction_correction_nonempty_chk
      check (
        excluded
        or corrected_quantity   is not null
        or corrected_price      is not null
        or corrected_amount     is not null
        or corrected_trade_date is not null
        or corrected_side       is not null
        or corrected_ticker     is not null
      );
  end if;
end $$;

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
  'append-only 변경 이력. UI 분류 수정(event_merge/event_split/tx_move/memo_change/tag_change/event_hide/event_restore)과 실제 거래정보 정정(tx_correct)을 action 으로 구분한다. append-only 는 권한으로 강제한다: service_role 에 SELECT/INSERT 만 있고 UPDATE/DELETE/TRUNCATE 는 회수돼 있다(owner 는 예외). id 는 identity 이며 시퀀스에 별도 GRANT 를 주지 않는다 — identity 시퀀스의 nextval 은 권한 검사를 거치지 않는다.';

create index if not exists kaw_ledger_audit_lookup_idx
  on public.kaw_ledger_audit (family_code, profile, at desc);
create index if not exists kaw_ledger_audit_target_idx
  on public.kaw_ledger_audit (family_code, profile, target_type, target_id, at desc);

-- ── 보안 ────────────────────────────────────────────────────────────────────
--
-- 철학은 001/002/003 과 같지만, **권한 설정 방식이 다르다.** 001~003 은 anon/authenticated
-- 만 회수했는데, 그것만으로는 아래 2) 의 이유로 service_role 에 대한 제약이 성립하지 않는다.
--
-- 1) RLS 를 켜고 정책을 하나도 만들지 않는다 → anon/authenticated 는 전부 차단된다.
--    **service_role 은 BYPASSRLS 라 RLS 로 걸러지지 않는다.** 그래서 service_role 에
--    대해서는 GRANT 가 유일한 방어선이고, 2)·3) 이 그 방어선을 만든다.
--
-- 2) **필요한 것만 grant 하는 것으로는 부족하다 — 먼저 전부 회수해야 한다.**
--    Supabase 프로젝트는 public 스키마에 기본 권한이 걸려 있다:
--
--      alter default privileges in schema public
--        grant all on tables to postgres, anon, authenticated, service_role;
--
--    그래서 새 테이블은 **생성되는 순간 anon·authenticated·service_role 에 ALL 이 이미
--    붙은 채로** 만들어진다. GRANT 는 가산이라 "select, insert 만 grant" 는 빼기가 되지
--    않는다. revoke 를 먼저 하지 않으면 원장 immutable 도 audit append-only 도 **전혀
--    성립하지 않는다**(service_role 이 UPDATE/DELETE/TRUNCATE 를 그대로 갖는다).
--    그래서 PUBLIC(의사 롤) 까지 포함해 네 주체를 전부 0 으로 되돌린 뒤 3) 에서 다시 준다.
--
--    owner(postgres)는 건드리지 않는다. **여기서 말하는 immutable / append-only 는
--    "Worker 가 쓰는 service_role 키로는 원장과 audit 을 바꾸거나 지울 수 없다"는 뜻**이고,
--    SQL Editor 의 소유자 권한까지 막으려는 것이 아니다(소유자는 어차피 막을 수 없다).
--
-- 3) service_role 에 **필요한 것만** 다시 부여한다.
--
--      kaw_transaction_ledger          select, insert                  (immutable)
--      kaw_ledger_audit                select, insert                  (append-only)
--      kaw_ledger_import_batch         select, insert                  (기록 후 불변)
--      kaw_transaction_correction      select, insert, update, delete
--      kaw_transaction_event_override  select, insert, update, delete
--      kaw_rebalance_event             select, insert, update, delete
--
--    여섯 테이블 모두 TRUNCATE / REFERENCES / TRIGGER 는 주지 않는다.
--    overlay 3종에만 update/delete 가 필요한 이유는 정정·재지정이 upsert 이고 "원본 복귀"가
--    행 삭제이기 때문이다(ledger-server.ts 의 clear / eventId:null 경로). 원장과 audit 에는
--    그런 경로가 아예 없다.
--
--    **identity 시퀀스(kaw_ledger_audit.id)에는 권한을 주지 않는다.** identity 컬럼의
--    시퀀스는 컬럼에 internal dependency 로 묶여 있어 nextval 이 권한 검사 없이 호출된다.
--    (serial 과 다른 점이다 — serial 은 DEFAULT 안의 nextval 이 호출자 권한으로 평가되므로
--     시퀀스 USAGE 가 필요하다.) 아래 검증 섹션의 smoke test (j) 가 시퀀스 권한을 전부
--     회수한 상태에서 실제로 INSERT 해 이것을 확인한다. 거기서 실패하면 그때만 USAGE 를
--     추가한다.
--
-- 이 블록은 멱등하다. 004 를 몇 번 실행해도 최종 상태는 항상 아래 표와 같다.
alter table public.kaw_ledger_import_batch         enable row level security;
alter table public.kaw_transaction_ledger          enable row level security;
alter table public.kaw_transaction_correction      enable row level security;
alter table public.kaw_transaction_event_override  enable row level security;
alter table public.kaw_rebalance_event             enable row level security;
alter table public.kaw_ledger_audit                enable row level security;

-- 2) 기존 권한을 **전부** 회수한다 (PUBLIC / anon / authenticated / service_role).
--    Supabase 기본 권한으로 이미 붙어 있는 ALL 을 여기서 떼어낸다. owner 는 제외다.
revoke all on public.kaw_transaction_ledger
  from public, anon, authenticated, service_role;
revoke all on public.kaw_ledger_audit
  from public, anon, authenticated, service_role;
revoke all on public.kaw_ledger_import_batch
  from public, anon, authenticated, service_role;
revoke all on public.kaw_transaction_correction
  from public, anon, authenticated, service_role;
revoke all on public.kaw_transaction_event_override
  from public, anon, authenticated, service_role;
revoke all on public.kaw_rebalance_event
  from public, anon, authenticated, service_role;

-- 3) service_role 에 필요한 것만 부여한다.
--    PUBLIC / anon / authenticated 에는 **아무것도 주지 않는다** (2 에서 회수한 상태 유지).

-- immutable 3종 — update/delete/truncate/references/trigger 없음.
grant select, insert                 on public.kaw_transaction_ledger          to service_role;
grant select, insert                 on public.kaw_ledger_audit                to service_role;
grant select, insert                 on public.kaw_ledger_import_batch         to service_role;

-- overlay 3종 — 쓰기·되돌리기가 있어야 하므로 update/delete 까지.
--               truncate/references/trigger 는 여전히 없음.
grant select, insert, update, delete on public.kaw_transaction_correction      to service_role;
grant select, insert, update, delete on public.kaw_transaction_event_override  to service_role;
grant select, insert, update, delete on public.kaw_rebalance_event             to service_role;

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
-- -- (a) 테이블 6개가 생겼는가 (6행이어야 한다)
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('kaw_ledger_import_batch','kaw_transaction_ledger',
--                       'kaw_transaction_correction','kaw_transaction_event_override',
--                       'kaw_rebalance_event','kaw_ledger_audit')
--  order by 1;
--
-- -- (a-2) 컬럼 수 대조. `create table if not exists` 는 **모양이 다른 동명 테이블이 이미
-- --       있으면 조용히 통과**하므로 (a) 만으로는 구버전이 적용돼 있던 경우를 못 잡는다.
-- --       기대값: kaw_ledger_audit 11 / kaw_ledger_import_batch 11 /
-- --               kaw_rebalance_event 13 / kaw_transaction_correction 13 /
-- --               kaw_transaction_event_override 6 / kaw_transaction_ledger 26  (합 80)
-- select table_name, count(*) as cols from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('kaw_ledger_import_batch','kaw_transaction_ledger',
--                       'kaw_transaction_correction','kaw_transaction_event_override',
--                       'kaw_rebalance_event','kaw_ledger_audit')
--  group by 1 order by 1;
--
-- -- (a-3) RLS 가 켜져 있고 정책이 0개인가 (relrowsecurity = t, policies = 0)
-- select c.relname, c.relrowsecurity,
--        (select count(*) from pg_policies pp
--          where pp.schemaname = 'public' and pp.tablename = c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public'
--    and c.relname in ('kaw_ledger_import_batch','kaw_transaction_ledger',
--                      'kaw_transaction_correction','kaw_transaction_event_override',
--                      'kaw_rebalance_event','kaw_ledger_audit')
--  order by 1;
--
-- -- (a-4) 이번에 추가한 CHECK 2개가 붙었는가 (2행)
-- select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conname in ('kaw_transaction_ledger_fp_version_chk',
--                    'kaw_transaction_correction_nonempty_chk')
--  order by 1;
--
-- -- (b) **선언된** GRANT. PUBLIC/anon/authenticated 행이 하나도 없어야 하고,
-- --     service_role 은 아래와 정확히 같아야 한다.
-- --       kaw_transaction_ledger / kaw_ledger_audit / kaw_ledger_import_batch
-- --          → INSERT,SELECT
-- --       kaw_transaction_correction / kaw_transaction_event_override / kaw_rebalance_event
-- --          → DELETE,INSERT,SELECT,UPDATE
-- select table_name, grantee,
--        string_agg(privilege_type, ',' order by privilege_type) as privs
--   from information_schema.role_table_grants
--  where table_schema = 'public'
--    and grantee in ('PUBLIC','anon','authenticated','service_role')
--    and table_name in ('kaw_ledger_import_batch','kaw_transaction_ledger',
--                       'kaw_transaction_correction','kaw_transaction_event_override',
--                       'kaw_rebalance_event','kaw_ledger_audit')
--  group by 1, 2 order by 1, 2;
--
-- -- (b-2) **실효(effective) 권한.** (b) 는 ACL 에 적힌 것만 보여주므로, service_role 이
-- --       다른 롤의 멤버라서 상속받는 권한은 드러나지 않는다. 실제로 할 수 있는지는
-- --       has_table_privilege 가 답한다. 이쪽이 최종 판정이다.
-- select t.name,
--        has_table_privilege('service_role', 'public.'||t.name, 'SELECT')     as sel,
--        has_table_privilege('service_role', 'public.'||t.name, 'INSERT')     as ins,
--        has_table_privilege('service_role', 'public.'||t.name, 'UPDATE')     as upd,
--        has_table_privilege('service_role', 'public.'||t.name, 'DELETE')     as del,
--        has_table_privilege('service_role', 'public.'||t.name, 'TRUNCATE')   as trunc,
--        has_table_privilege('service_role', 'public.'||t.name, 'REFERENCES') as refs,
--        has_table_privilege('service_role', 'public.'||t.name, 'TRIGGER')    as trg
--   from (values ('kaw_transaction_ledger'), ('kaw_ledger_audit'),
--                ('kaw_ledger_import_batch'), ('kaw_transaction_correction'),
--                ('kaw_transaction_event_override'), ('kaw_rebalance_event')) as t(name)
--  order by 1;
--
-- --   기대값                            sel ins upd del trunc refs trg
-- --   kaw_ledger_audit                   t   t   f   f    f     f    f
-- --   kaw_ledger_import_batch            t   t   f   f    f     f    f
-- --   kaw_transaction_ledger             t   t   f   f    f     f    f
-- --   kaw_rebalance_event                t   t   t   t    f     f    f
-- --   kaw_transaction_correction         t   t   t   t    f     f    f
-- --   kaw_transaction_event_override     t   t   t   t    f     f    f
--
-- -- (b-3) immutable 3종 한 줄 판정 — **0행이면 통과**다. 한 행이라도 나오면
-- --       그 테이블의 그 권한이 service_role 에 살아 있다는 뜻이고, 원장 immutable /
-- --       audit append-only 가 성립하지 않는다. import 를 진행하지 않는다.
-- select t.name as table_name, p.priv
--   from (values ('kaw_transaction_ledger'), ('kaw_ledger_audit'),
--                ('kaw_ledger_import_batch')) as t(name),
--        (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
--  where has_table_privilege('service_role', 'public.'||t.name, p.priv);
--
-- -- (b-4) anon/authenticated/PUBLIC 실효 판정 — 이것도 **0행이면 통과**다.
-- select r.role, t.name as table_name, p.priv
--   from (values ('anon'), ('authenticated')) as r(role),
--        (values ('kaw_ledger_import_batch'), ('kaw_transaction_ledger'),
--                ('kaw_transaction_correction'), ('kaw_transaction_event_override'),
--                ('kaw_rebalance_event'), ('kaw_ledger_audit')) as t(name),
--        (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
--                ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
--  where has_table_privilege(r.role, 'public.'||t.name, p.priv);
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
-- -- (f-2) fingerprint 규칙 버전이 섞여 있지 않은가 (1행이어야 한다)
-- select fingerprint_version, count(*) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>' group by 1;
--
-- -- (g) 적재 배치 이력 — 재적재하면 inserted 0 / skipped 463 인 행이 하나 더 생긴다
-- select id, source_kind, source_label, inserted_count, skipped_count, created_at
--   from public.kaw_ledger_import_batch
--  where family_code = '<CODE>' and profile = '<PROFILE>' order by created_at desc;
--
-- -- (h) 추정 날짜 비율 (UI 신뢰도 표시의 근거)
-- select trade_date_evidence, count(*) from public.kaw_transaction_ledger
--  where family_code = '<CODE>' and profile = '<PROFILE>' group by 1 order by 2 desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- (j) service_role smoke test — **production 데이터를 남기지 않는다**
--
-- (b-2)/(b-3) 은 권한 카탈로그를 읽을 뿐이다. 실제로 Worker 와 같은 롤로 INSERT 가
-- 되는지는 해봐야 안다. 특히 확인하는 것:
--
--   · kaw_ledger_audit.id 는 identity 다. **시퀀스 권한 없이도 INSERT 되는가?**
--     j-0 에서 그 시퀀스의 권한을 이 트랜잭션 안에서만 전부 회수한 뒤 j-1 을 넣으므로,
--     j-1 이 id 를 채워 돌려주면 "identity 시퀀스에는 별도 GRANT 가 필요 없다"가
--     결정적으로 증명된다(serial 이었다면 여기서 permission denied 가 난다).
--     j-1 이 실패할 때만 아래를 004 에 추가한다 — 성공하면 추가하지 않는다:
--         grant usage on sequence public.kaw_ledger_audit_id_seq to service_role;
--   · 새로 추가한 CHECK 2 개가 **정상 데이터를 막지는 않는가** (j-3, j-4).
--   · 3) 의 GRANT 가 정상 쓰기 경로를 과하게 막지는 않는가.
--
-- 블록 **전체를 한 번에** SQL Editor 에 붙여넣고 Run 한다. 마지막 rollback 으로
-- j-0 의 권한 변경과 j-1~j-4 의 4 행이 전부 사라진다. family_code 는 실제로 쓰지 않는
-- '__smoke__' 라서 만약 rollback 이 누락돼도 실데이터와 섞이지 않는다.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- begin;
--
-- -- j-0. identity 시퀀스 권한을 이 트랜잭션 안에서만 전부 회수한다(소유자 자격으로).
-- --      이렇게 해야 j-1 의 성공이 "권한이 있어서"가 아니라 "권한이 필요 없어서"임이 증명된다.
-- revoke all on sequence public.kaw_ledger_audit_id_seq
--   from public, anon, authenticated, service_role;
--
-- set local role service_role;
--
-- -- j-1. audit (identity). id 가 채워져 나오면 통과.
-- insert into public.kaw_ledger_audit
--   (family_code, profile, actor, action, target_type, target_id, note)
-- values ('__smoke__', '__smoke__', '__smoke__', 'import', 'import', '__smoke__',
--         '004 smoke test — rollback 됨')
-- returning id;
--
-- -- j-2. 적재 배치
-- insert into public.kaw_ledger_import_batch
--   (id, family_code, profile, source_kind, source_label, actor)
-- values ('__smoke__', '__smoke__', '__smoke__', 'manual', '004 smoke test', '__smoke__')
-- returning id;
--
-- -- j-3. 원장 1 행. source_fingerprint 'v1|…' 와 fingerprint_version 1 이 맞으므로
-- --      kaw_transaction_ledger_fp_version_chk 를 통과해야 한다.
-- insert into public.kaw_transaction_ledger
--   (family_code, profile, id, account_type, ticker, etf_name, side,
--    quantity, price, amount, event_date, trade_date_evidence,
--    source, source_fingerprint, fingerprint_version)
-- values ('__smoke__', '__smoke__', 'vtx:__smoke__', 'isa', '000000', 'SMOKE', 'buy',
--         1, 1, 1, date '2026-01-01', 'broker-order-date',
--         'smoke', 'v1|smoke', 1)
-- returning id;
--
-- -- j-4. 정정 overlay. corrected_quantity 가 있으므로
-- --      kaw_transaction_correction_nonempty_chk 를 통과해야 한다.
-- insert into public.kaw_transaction_correction
--   (family_code, profile, transaction_id, corrected_quantity, reason)
-- values ('__smoke__', '__smoke__', 'vtx:__smoke__', 2, '004 smoke test')
-- returning transaction_id;
--
-- rollback;   -- ← 반드시 실행된다. j-0 의 revoke 와 j-1~j-4 의 4 행이 전부 사라진다.
--
-- -- j-5. 정말 아무것도 남지 않았는지 (네 쿼리 모두 0행)
-- select count(*) from public.kaw_ledger_audit            where family_code = '__smoke__';
-- select count(*) from public.kaw_ledger_import_batch     where family_code = '__smoke__';
-- select count(*) from public.kaw_transaction_ledger      where family_code = '__smoke__';
-- select count(*) from public.kaw_transaction_correction  where family_code = '__smoke__';
--
-- -- j-6. j-0 의 시퀀스 권한 회수가 rollback 으로 원복됐는지 (migration 직후 상태와 동일)
-- select has_sequence_privilege('service_role',
--          'public.kaw_ledger_audit_id_seq', 'USAGE') as service_role_seq_usage;
-- --   값이 t 든 f 든 **상관없다.** Supabase 기본 권한 때문에 t 로 나오는 것이 보통이고,
-- --   "권한이 필요 없다"의 증명은 j-0 + j-1 쪽이다. 이 줄은 migration 전후 상태가
-- --   같은지 확인하는 용도다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- (k) **실패해야 정상**인 probe — 설계가 깨졌는지 직접 때려서 확인한다
--
-- (j) 와 반대로, 아래는 전부 에러가 나야 통과다. 성공해 버리면 그 줄의 보장이 없는 것이다.
-- 실패한 문장은 트랜잭션을 끊으므로 **블록을 하나씩 따로** 실행한다.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- -- k-1. 원장 UPDATE 거부   expect: permission denied for table kaw_transaction_ledger
-- --      (권한 검사는 실행 계획 시작 시점이라 대상 행이 0 건이어도 에러가 난다)
-- begin; set local role service_role;
--   update public.kaw_transaction_ledger set etf_name = 'X' where false;
-- rollback;
--
-- -- k-2. 원장 DELETE 거부   expect: permission denied for table kaw_transaction_ledger
-- begin; set local role service_role;
--   delete from public.kaw_transaction_ledger where false;
-- rollback;
--
-- -- k-3. audit UPDATE 거부  expect: permission denied for table kaw_ledger_audit
-- begin; set local role service_role;
--   update public.kaw_ledger_audit set note = 'X' where false;
-- rollback;
--
-- -- k-4. audit DELETE 거부  expect: permission denied for table kaw_ledger_audit
-- begin; set local role service_role;
--   delete from public.kaw_ledger_audit where false;
-- rollback;
--
-- -- k-5. 배치 UPDATE 거부   expect: permission denied for table kaw_ledger_import_batch
-- begin; set local role service_role;
--   update public.kaw_ledger_import_batch set actor = 'X' where false;
-- rollback;
--
-- -- k-6. fingerprint prefix 불일치 거부
-- --      expect: violates check constraint "kaw_transaction_ledger_fp_version_chk"
-- --      (문자열은 v1| 인데 컬럼은 2 다)
-- begin; set local role service_role;
--   insert into public.kaw_transaction_ledger
--     (family_code, profile, id, account_type, ticker, etf_name, side,
--      quantity, price, amount, event_date, trade_date_evidence,
--      source, source_fingerprint, fingerprint_version)
--   values ('__smoke__', '__smoke__', 'vtx:__bad__', 'isa', '000000', 'SMOKE', 'buy',
--           1, 1, 1, date '2026-01-01', 'broker-order-date',
--           'smoke', 'v1|mismatch', 2);
-- rollback;
--
-- -- k-7. 아무것도 정정하지 않는 correction 거부
-- --      expect: violates check constraint "kaw_transaction_correction_nonempty_chk"
-- --      (CHECK 는 FK 트리거보다 먼저 평가되므로 부모 행이 없어도 CHECK 에서 걸린다)
-- begin; set local role service_role;
--   insert into public.kaw_transaction_correction
--     (family_code, profile, transaction_id, reason)
--   values ('__smoke__', '__smoke__', 'vtx:__smoke__', '사유만 있는 행');
-- rollback;
