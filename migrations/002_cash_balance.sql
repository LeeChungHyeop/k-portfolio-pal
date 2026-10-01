-- ─────────────────────────────────────────────────────────────────────────────
-- 실제 예수금(cash_balance) 도입 — kaw_portfolio_live_view 재정의
--
-- 배경: 001 의 view 는 리밸런싱 기준금액을
--         portfolio_market_value + deposit   (ETF 평가액 + 이번 회차 불입액)
--       으로 계산했다. 앱 화면도 같은 식이었다. 그런데 이 값은 "실제 증권계좌의 현금"이
--       아니다 — ETF 가격이 움직이면 같이 움직이는 가상값이었고, 실제 미래에셋 예수금과
--       크게 어긋났다(예: 실제 3,621원 vs 표시 364,338원).
--
-- 변경: 앱이 계좌 상태(kaw_data.data)에 새로 저장하는 실제 예수금 `cashBalance` 를 읽어
--         total_asset_value = portfolio_market_value + cash_balance
--       를 계산하고, 목표금액/차액도 이 총자산 기준으로 낸다.
--       `deposit`(이번 회차 월 납입액)은 **컬럼을 그대로 유지**한다 — 외부 분석에서
--       월 납입 흐름을 보는 메타데이터이며, 더 이상 기준금액 계산에는 쓰지 않는다.
--
-- 호환: 기존 컬럼은 하나도 없어지지 않는다. `rebalance_base_amount` 는 이름을 유지하되
--       의미가 total_asset_value 와 같아진다(기존 소비처가 깨지지 않도록).
--       `cashBalance` 를 아직 한 번도 입력하지 않은 계좌는 0 으로 본다. 과거 데이터에서
--       baseAmount - totalValue 를 예수금으로 역산하지 않는다 — 그 값은 예전 계산식에서
--       나온 가상값이기 때문이다.
--
-- 보안: 001 과 동일하다. security_invoker = true, anon/authenticated GRANT 회수,
--       service_role 만 select.
--
-- 실행: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--       (idempotent — 여러 번 실행해도 안전하다)
--
-- 001 은 과거 기록으로 그대로 남겨둔다(이미 production 에 적용됨). 이 파일이 view 의
-- 최신 정의이며, 새 DB 에는 001 → 002 순서로 적용한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 컬럼 순서를 의미 단위로 다시 묶기 위해 create or replace 가 아니라 drop → create 한다.
-- (create or replace view 는 기존 컬럼의 순서/타입을 바꿀 수 없고 뒤에 덧붙이기만 된다.)
-- 이 view 에 의존하는 다른 객체는 없다 — 외부 분석 연결이 이름으로 SELECT 할 뿐이다.
drop view if exists public.kaw_portfolio_live_view;

create view public.kaw_portfolio_live_view
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
    -- 이번 회차 월 납입액(메타데이터). 기준금액 계산에는 쓰지 않는다.
    coalesce((r.data ->> 'deposit')::numeric, 0)                   as deposit,
    -- 실제 예수금(증권계좌 현금잔액). 앱에서 사용자가 직접 입력해 영속 저장한 값.
    -- 한 번도 입력하지 않은 계좌는 키가 없으므로 0 으로 본다(추정하지 않는다).
    coalesce((r.data ->> 'cashBalance')::numeric, 0)               as cash_balance,
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
  -- ── 금액 3종: ETF 평가액 / 실제 예수금 / 총자산 ───────────────────────────
  sum(v.market_value) over w                                                    as portfolio_market_value,
  v.cash_balance,
  sum(v.market_value) over w + v.cash_balance                                   as total_asset_value,
  -- 이번 회차 월 납입액 — 메타데이터로만 유지(기준금액에 더하지 않는다)
  v.deposit,
  -- 001 호환용 이름. 의미는 total_asset_value 와 같다(ETF 평가액 + 실제 예수금).
  sum(v.market_value) over w + v.cash_balance                                   as rebalance_base_amount,
  round(v.market_value / nullif(sum(v.market_value) over w, 0) * 100, 4)        as current_weight_pct,
  v.target_weight_pct,
  round((sum(v.market_value) over w + v.cash_balance) * v.target_weight_pct / 100) as target_value,
  round((sum(v.market_value) over w + v.cash_balance) * v.target_weight_pct / 100)
    - v.market_value                                                            as rebalance_diff,
  v.in_target_profile,
  v.data_updated_at
from valued v
window w as (partition by v.family_code, v.profile, v.account_type)
order by v.family_code, v.profile, v.account_type, v.market_value desc;

comment on view public.kaw_portfolio_live_view is
  '마지막으로 확정된 리밸런싱 보유내역 x 캐시된 현재가 = 보유종목 단위 read-only 포트폴리오 현황. 총자산 = ETF 평가액(portfolio_market_value) + 실제 예수금(cash_balance) = total_asset_value 이며 목표금액/차액도 이 기준이다. deposit 은 이번 회차 월 납입액 메타데이터일 뿐 기준금액에 포함되지 않는다. rebalance_base_amount 는 001 호환용 별칭(= total_asset_value). 조회 시 family_code/profile 필터 필수.';

revoke all on public.kaw_portfolio_live_view from anon, authenticated;
grant select on public.kaw_portfolio_live_view to service_role;
