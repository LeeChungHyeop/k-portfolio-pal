-- ─────────────────────────────────────────────────────────────────────────────
-- 일별 자산 스냅샷 — kaw_daily_portfolio_snapshots
--
-- 배경: 기간 성과(일간/월간/연간)를 보여주려면 "그 날의 총자산"이 날짜별로 남아 있어야 한다.
--       기존 kaw_data.history 는 **리밸런싱을 저장한 날**의 기록일 뿐이라(한 달에 한 번쯤)
--       일별 평가가 아니다. 이를 일간 수익률로 환산하면 틀린 숫자가 나오므로, 성과 계산용
--       시계열을 별도 테이블에 쌓는다.
--
-- 적재: Cloudflare Cron 의 마지막 실행 슬롯(한국시간 평일 15:40)에 Worker 가 계좌별로 1행씩
--       upsert 한다. 시세 갱신 cron 은 그대로 두고 그 뒤에 이어 붙였다.
--       (src/server.ts scheduled() → data-server.ts writeDailySnapshots())
--
-- 금액 정의(앱·live view 와 동일):
--       total_asset_value = market_value(ETF 평가액) + cash_balance(실제 예수금)
--       deposit(월 납입액)은 총자산에 **더하지 않는다.**
--
--       이 테이블은 **날짜별 평가액만** 담는다. 외부 입출금(cashflow)은 **담지 않는다** —
--       source of truth 는 항상 앱의 cashflow 장부(AccountState.cashflows)다.
--       장부는 과거 날짜에 나중에 추가·수정·삭제될 수 있어서(15:40 스냅샷 이후 그 날 저녁에
--       입금을 기록하거나, 며칠 뒤 과거 입출금을 보정하는 경우) 여기에 복사해두면 곧 stale
--       해진다. 기간 수익률은 이 평가액과 **계산 시점의 현재 장부**를 결합해서 낸다
--       (src/lib/kaw/performance.ts calculatePerformance).
--
-- 정확성 규칙:
--       - 같은 (family_code, profile, account_type, snapshot_date) 는 PK 로 1행만 유지한다.
--         같은 날 cron 이 여러 번 돌아도 upsert 로 덮어쓸 뿐 행이 늘지 않는다.
--       - 보유종목 중 **신선한 시세를 못 구한 종목이 하나라도 있으면 그 계좌의 그 날 행을
--         아예 쓰지 않는다.** 일부만 최신인 평가액을 남기면 그 날 성과가 틀리기 때문이다.
--         (Worker 쪽에서 판단하며, 남긴 행에는 price_fetched_at 을 같이 적어 근거를 남긴다.)
--       - 한국 공휴일(휴장일)은 판단하지 않는다. 휴장일에 적재되는 값은 직전 거래일 종가 x
--         보유수량이고, 그것은 그 날의 실제 평가액으로서 **옳다**(그 날 손익이 0이 될 뿐이다).
--         없는 거래를 만들어내는 것이 아니므로 추정이 아니다.
--
-- 보안: kaw_live_prices / kaw_portfolio_live_view 와 같은 철학.
--       RLS on + 정책 0개, anon/authenticated GRANT 회수, service_role 만 접근.
--       브라우저는 이 테이블에 직접 붙지 않고 Worker 의 인증된 GET /api/snapshots 만 쓴다.
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run. (idempotent)
--       001 → 002 → 003 순서. 001/002 의 객체는 건드리지 않는다.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.kaw_daily_portfolio_snapshots (
  family_code       text        not null,
  profile           text        not null,
  account_type      text        not null,
  snapshot_date     date        not null,

  -- ETF 평가액 (확정 보유수량 x 그 시점 시세)
  market_value      numeric(18, 2) not null default 0,
  -- 실제 예수금 (사용자가 입력한 증권계좌 현금잔액)
  cash_balance      numeric(18, 2) not null default 0,
  -- 총자산 = market_value + cash_balance
  total_asset_value numeric(18, 2) not null default 0,
  -- 적재 근거: 평가에 쓴 시세 중 가장 오래된 것의 조회시각
  price_fetched_at  timestamptz,
  -- 보유종목 수 (평가에 들어간 행 수) — 사후 점검용
  holding_count     integer     not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint kaw_daily_portfolio_snapshots_pkey
    primary key (family_code, profile, account_type, snapshot_date),
  constraint kaw_daily_portfolio_snapshots_account_chk
    check (account_type in ('retirement', 'isa', 'pension', 'irp'))
);

comment on table public.kaw_daily_portfolio_snapshots is
  '일별 자산 스냅샷(평가액 전용). total_asset_value = market_value(ETF 평가액) + cash_balance(실제 예수금)이며 deposit 은 더하지 않는다. 외부 입출금은 담지 않는다 — source of truth 는 앱의 cashflow 장부이고, 기간 수익률은 이 평가액과 계산 시점의 현재 장부를 결합해 낸다. (family_code, profile, account_type, snapshot_date) 1행만 유지(upsert). 신선한 시세를 못 구한 계좌의 그 날 행은 적재하지 않는다.';

-- 날짜 범위 조회(최근 N일, 특정 기간)용
create index if not exists kaw_daily_portfolio_snapshots_lookup_idx
  on public.kaw_daily_portfolio_snapshots (family_code, profile, snapshot_date desc);

-- ── 보안 ────────────────────────────────────────────────────────────────────
-- RLS 를 켜고 정책을 하나도 만들지 않는다 → anon/authenticated 는 전부 차단된다.
-- service_role 은 RLS 를 우회하므로 Worker 만 읽고 쓸 수 있다.
alter table public.kaw_daily_portfolio_snapshots enable row level security;

revoke all on public.kaw_daily_portfolio_snapshots from anon, authenticated;
grant select, insert, update on public.kaw_daily_portfolio_snapshots to service_role;

-- updated_at 자동 갱신 (upsert 로 덮어쓸 때 마지막 적재 시각을 남긴다)
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

drop trigger if exists kaw_daily_portfolio_snapshots_touch
  on public.kaw_daily_portfolio_snapshots;
create trigger kaw_daily_portfolio_snapshots_touch
  before update on public.kaw_daily_portfolio_snapshots
  for each row execute function public.kaw_touch_updated_at();
