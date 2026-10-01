-- ─────────────────────────────────────────────────────────────────────────────
-- K-올웨더 read-only 분석 경로 (ChatGPT 등 외부 분석 연결용)
--
-- 앱의 기존 동작(리밸런싱 저장 방식, 로그인, KIS 가격조회 응답)은 전혀 바꾸지 않는다.
-- 여기서 만드는 것은 둘뿐이다:
--   1) public.kaw_live_prices         — KRX ETF 현재가 캐시 (ticker당 최신 1행)
--   2) public.kaw_portfolio_live_view — 보유종목 단위 read-only 분석 view
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       (idempotent — 여러 번 실행해도 안전하다)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══ 1. 실시간 시세 캐시 ══════════════════════════════════════════════════
-- Worker의 /api/kis/price 가 KIS(1차) 또는 Naver(fallback)에서 성공적으로 받아온
-- 가격만 적재한다. 실패(source=failed)는 쓰지 않는다 — 마지막 성공값을 남겨두는 게
-- 분석에 더 쓸모 있고, 실패가 캐시를 지워버리는 일도 막는다.
-- 이력 테이블이 아니다: ticker가 primary key이므로 항상 최신 1행만 유지된다.

create table if not exists public.kaw_live_prices (
  ticker     text        primary key,
  price      numeric     not null check (price > 0),
  source     text        not null check (source in ('kis', 'naver')),
  fetched_at timestamptz not null default now()
);

comment on table public.kaw_live_prices is
  'KRX ETF 현재가 캐시(ticker당 최신 1행). /api/kis/price 응답 중 성공한 값만 적재. 이력은 남기지 않는다.';
comment on column public.kaw_live_prices.source is
  '가격 출처: kis = 한국투자증권 Open API(1차), naver = 네이버 증권(fallback).';
comment on column public.kaw_live_prices.fetched_at is
  '이 가격을 받아온 시각(UTC). 장 마감 후에는 당연히 오래된 값이며, 오류가 아니다.';

-- 정책을 하나도 만들지 않는다 → anon/authenticated 는 RLS 에 전부 막힌다.
-- 앱 Worker와 분석 연결은 service_role(BYPASSRLS)로만 접근한다.
alter table public.kaw_live_prices enable row level security;

revoke all on table public.kaw_live_prices from anon, authenticated;
grant select, insert, update on table public.kaw_live_prices to service_role;


-- ═══ 2. 시세 신선도 기준 (코드 상수) ══════════════════════════════════════
-- 시세를 오래된 값으로 볼 기준(초). 이 함수 하나만 바꾸면 view 전체에 반영된다.
-- 장 마감 후·주말에는 정상적으로 stale 이 되며, 그것은 오류가 아니다.

create or replace function public.kaw_price_stale_seconds()
  returns integer
  language sql
  immutable
  parallel safe
as $fn$ select 300 $fn$;

comment on function public.kaw_price_stale_seconds() is
  '시세를 stale 로 볼 기준(초). 기본 300초(5분). 장 마감 후 stale 은 정상이다.';


-- ═══ 3. 보유종목 단위 read-only 분석 view ════════════════════════════════
-- 앱 화면과 같은 알고리즘을 그대로 SQL 로 옮긴 것이다
-- (src/components/kaw/Dashboard.tsx 의 getAccountEtfValues +
--  src/components/kaw/AccountPage.tsx 의 기준금액/목표금액 계산):
--
--   1) 계좌의 history 중 날짜가 가장 늦은 기록(= 마지막으로 확정된 리밸런싱)을 고른다.
--      진행 중인 liveQuantities/rowHoldings 는 다음 회차 편집용이라 쓰지 않는다.
--   2) 그 기록의 rowQuantitiesSnap 을 실제 보유수량으로 본다(0 이하는 제외).
--   3) 종목명은 rowEtfSnap 에서 가져온다.
--   4) ticker 는 종목 라이브러리에서 ETF명(defaultEtf) 일치로 찾는다. assetId 로 찾으면 안 된다
--      (예: row_id 'kr' 의 실제 종목이 'SOL AI반도체TOP2플러스' 인 경우가 있다).
--   5) 평가금액 = 수량 x 캐시된 현재가. 캐시가 없으면 리밸런싱 당시 금액(rowHoldingsSnap)으로
--      폴백하고 price_source = 'snapshot' 으로 표시한다(앱 화면과 같은 폴백).
--   6) 계좌 평가금액 = 그 계좌 보유종목 평가금액의 합.
--   7) 리밸런싱 기준금액 = 계좌 평가금액 + 이번 회차 불입액(deposit).
--   8) 목표비중은 그 계좌의 현재 활성 투자성향(data->>'profile')의 profileAllocations 에서 가져온다.
--
-- 마지막 확정 기록에는 있는데 현재 투자성향에서는 지워진 종목도 빠뜨리지 않는다 —
-- 목표비중 0%(= 전량 매도)로 그대로 나오고, in_target_profile = false 로 구분된다.
--
-- kaw_data 는 (family_code, profile, account_type) 마다 여러 행이 남아 있을 수 있어
-- 반드시 updated_at 이 가장 최신인 1행만 쓴다(distinct on). family_code/profile 도 여러 개가
-- 공존하므로(과거 테스트 데이터 포함) 조회할 때 꼭 함께 필터링해야 한다.

create or replace view public.kaw_portfolio_live_view
with (security_invoker = true) as
with accounts as (
  -- 같은 (가족코드, 프로필, 계좌)에 여러 행이 있으면 가장 최근에 갱신된 1행만
  select distinct on (d.family_code, d.profile, d.account_type)
         d.family_code, d.profile, d.account_type, d.data, d.updated_at
  from public.kaw_data d
  where d.account_type in ('retirement', 'isa', 'pension', 'irp')
    and left(d.profile, 1) <> '_'   -- _system / _shared 같은 예약 프로필 제외
  order by d.family_code, d.profile, d.account_type, d.updated_at desc nulls last
),
asset_library_shared as (
  -- 종목 라이브러리는 가족 공용(_shared/_assetLib)이 우선
  select distinct on (d.family_code) d.family_code, d.data -> 'assetLibrary' as lib
  from public.kaw_data d
  where d.profile = '_shared' and d.account_type = '_assetLib'
    and jsonb_typeof(d.data -> 'assetLibrary') = 'array'
  order by d.family_code, d.updated_at desc nulls last
),
asset_library_meta as (
  -- 공용이 없으면 프로필별 _meta 의 사본
  select distinct on (d.family_code, d.profile) d.family_code, d.profile, d.data -> 'assetLibrary' as lib
  from public.kaw_data d
  where d.account_type = '_meta'
    and jsonb_typeof(d.data -> 'assetLibrary') = 'array'
  order by d.family_code, d.profile, d.updated_at desc nulls last
),
last_rebalance as (
  -- 날짜가 가장 늦은 history 항목 1개. 같은 날짜가 둘이면 배열에서 나중에 저장된 쪽(앱과 동일)
  select a.family_code, a.profile, a.account_type, a.data, a.updated_at, e.entry
  from accounts a
  cross join lateral (
    select v.value as entry
    from jsonb_array_elements(
           case when jsonb_typeof(a.data -> 'history') = 'array' then a.data -> 'history' else '[]'::jsonb end
         ) with ordinality v(value, ord)
    order by (v.value ->> 'date') desc nulls last, v.ord desc
    limit 1
  ) e
),
holdings as (
  select
    r.family_code,
    r.profile,
    r.account_type,
    coalesce(r.data ->> 'profile', 'growth')                       as risk_profile,
    (r.entry ->> 'date')::date                                     as rebalance_date,
    r.entry ->> 'id'                                               as rebalance_id,
    coalesce((r.data ->> 'deposit')::numeric, 0)                   as deposit,
    q.key                                                          as row_id,
    q.value::numeric                                               as quantity,
    coalesce(r.entry -> 'rowEtfSnap' ->> q.key, q.key)             as etf_name,
    coalesce(r.entry -> 'rowLabelSnap' ->> q.key,
             r.entry -> 'rowEtfSnap' ->> q.key, q.key)             as asset_label,
    coalesce((r.entry -> 'rowHoldingsSnap' ->> q.key)::numeric, 0) as snapshot_market_value,
    coalesce((r.data -> 'profileAllocations'
                     -> coalesce(r.data ->> 'profile', 'growth')
                     ->> q.key)::numeric, 0)                       as target_weight_pct,
    exists (
      select 1
      from jsonb_array_elements(
             case when jsonb_typeof(r.data -> 'profileRows' -> coalesce(r.data ->> 'profile', 'growth')) = 'array'
                  then r.data -> 'profileRows' -> coalesce(r.data ->> 'profile', 'growth')
                  else '[]'::jsonb end
           ) pr
      where pr.value ->> 'id' = q.key
    )                                                              as in_target_profile,
    r.updated_at                                                   as data_updated_at
  from last_rebalance r
  cross join lateral jsonb_each_text(
    case when jsonb_typeof(r.entry -> 'rowQuantitiesSnap') = 'object'
         then r.entry -> 'rowQuantitiesSnap' else '{}'::jsonb end
  ) q
  where q.value::numeric > 0
),
priced as (
  select
    h.*,
    tk.ticker,
    lp.price      as cached_price,
    lp.source     as cached_source,
    lp.fetched_at as cached_fetched_at
  from holdings h
  left join asset_library_shared als on als.family_code = h.family_code
  left join asset_library_meta   alm on alm.family_code = h.family_code and alm.profile = h.profile
  left join lateral (
    -- ETF명 일치로 ticker 를 찾는다(앱과 동일). 라이브러리는 공용 → _meta 순으로 폴백.
    select e.value ->> 'ticker' as ticker
    from jsonb_array_elements(coalesce(als.lib, alm.lib, '[]'::jsonb)) e
    where e.value ->> 'defaultEtf' = h.etf_name
      and nullif(e.value ->> 'ticker', '') is not null
    limit 1
  ) tk on true
  -- 캐시는 ticker를 대문자로 정규화해 적재한다(data-server.ts upsertLivePrices)
  left join public.kaw_live_prices lp on lp.ticker = upper(tk.ticker)
),
valued as (
  select
    p.*,
    case when p.cached_price > 0 then round(p.quantity * p.cached_price)
         else p.snapshot_market_value end                          as market_value,
    case when p.cached_price > 0 then p.cached_source
         else 'snapshot' end                                       as price_source
  from priced p
)
select
  v.family_code,
  v.profile,
  v.account_type,
  v.risk_profile,
  v.rebalance_date,
  v.rebalance_id,
  v.row_id,
  v.asset_label,
  v.etf_name,
  v.ticker,
  v.quantity,
  case when v.price_source = 'snapshot' then null else v.cached_price end       as price,
  v.price_source,
  case when v.price_source = 'snapshot' then null else v.cached_fetched_at end  as price_fetched_at,
  case when v.price_source = 'snapshot' then null
       else floor(extract(epoch from (now() - v.cached_fetched_at)))::bigint
  end                                                                           as price_age_seconds,
  case when v.price_source = 'snapshot' then true
       else (now() - v.cached_fetched_at)
            > make_interval(secs => public.kaw_price_stale_seconds())
  end                                                                           as price_is_stale,
  v.market_value,
  v.snapshot_market_value,
  sum(v.market_value) over w                                                    as portfolio_market_value,
  v.deposit,
  sum(v.market_value) over w + v.deposit                                        as rebalance_base_amount,
  round(v.market_value / nullif(sum(v.market_value) over w, 0) * 100, 4)        as current_weight_pct,
  v.target_weight_pct,
  round((sum(v.market_value) over w + v.deposit) * v.target_weight_pct / 100)    as target_value,
  round((sum(v.market_value) over w + v.deposit) * v.target_weight_pct / 100)
    - v.market_value                                                            as rebalance_diff,
  v.in_target_profile,
  v.data_updated_at
from valued v
window w as (partition by v.family_code, v.profile, v.account_type)
order by v.family_code, v.profile, v.account_type, v.market_value desc;

comment on view public.kaw_portfolio_live_view is
  '마지막으로 확정된 리밸런싱 보유내역 x 캐시된 현재가 = 보유종목 단위 read-only 포트폴리오 현황. 앱 화면과 같은 계산식. 조회 시 family_code/profile 필터 필수.';

revoke all on public.kaw_portfolio_live_view from anon, authenticated;
grant select on public.kaw_portfolio_live_view to service_role;
