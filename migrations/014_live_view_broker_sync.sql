-- ─────────────────────────────────────────────────────────────────────────────
-- kaw_portfolio_live_view 에 계좌 동기화(broker_sync) 보유 기준 반영 — migration 014 (Phase 4-D)
--
-- 상태: **작성만 했고 적용하지 않았다.** 002 가 적용돼 있어야 한다. 013 과는 독립이다(순서 무관).
--
-- 왜 필요한가: 이 view 는 "마지막으로 확정된 리밸런싱(history)의 보유수량 × 캐시 시세 + 현재 cashBalance" 로
--       총자산을 낸다. 계좌 동기화(013/앱)는 history 를 건드리지 않고 `brokerSyncs[]` 에 기록만 남기므로,
--       view 가 이 기록을 모르면 예수금만 새 값(2,318,828원)이고 보유수량은 옛 값(297주/81주)인 **틀린 총자산**
--       (약 +2.2M 과대)이 나온다. 앱의 Dashboard · 일별 스냅샷(cron)과 같은 규칙으로 맞춘다.
--
-- 규칙 (앱의 holdingsBasisOf 와 같다):
--       보유 기준 = history 의 마지막 항목 vs brokerSyncs 의 마지막 항목 중 **날짜가 더 늦은 쪽**.
--       날짜가 같으면 동기화가 이긴다(동기화는 그 날짜 이후의 원장으로 검증된 값이다).
--       동기화의 날짜는 holdingsEffectiveFrom(보유수량 효력일)이다 — 예수금 관측일이 아니다.
--
-- 호환: 기존 컬럼은 이름 · 순서 · 의미가 그대로다. 맨 뒤에 `holdings_basis_kind`('rebalance' | 'broker_sync') 와
--       `cash_state_as_of`(예수금 관측 기준일, 없으면 NULL) 두 개만 덧붙인다. 동기화가 기준이면 rebalance_date 는 보유수량 효력일, rebalance_id 는 동기화 기록 id 이고,
--       시세가 없을 때 쓰는 snapshot_market_value 는 **원장 취득금액**이다(평가액이 아님 — price_source 가 'snapshot').
--       동기화 기록이 없는 계좌의 결과는 002 와 한 행도 다르지 않다.
--
-- 보안: 002 와 동일하다. security_invoker = true, anon/authenticated 회수, service_role 만 select.
--
-- 실행: 사용자가 별도로 승인한 뒤 SQL Editor 에서 이 파일 전체를 실행한다. 멱등하다.
-- 되돌리기: 014_live_view_broker_sync_rollback.sql (002 정의로 되돌린다)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.kaw_data') is null or to_regclass('public.kaw_live_prices') is null
     or to_regprocedure('public.kaw_price_stale_seconds()') is null then
    raise exception 'kaw_data / kaw_live_prices / kaw_price_stale_seconds 가 없습니다(001·002). 014 를 적용하지 않았습니다.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'kaw_portfolio_live_view' and column_name = 'cash_balance') then
    raise exception '002(cash_balance)가 먼저 적용돼야 합니다. 014 를 적용하지 않았습니다.';
  end if;
end $$;

drop view if exists public.kaw_portfolio_live_view;

create view public.kaw_portfolio_live_view
with (security_invoker = true) as
with accounts as (
  select distinct on (d.family_code, d.profile, d.account_type)
         d.family_code, d.profile, d.account_type, d.data, d.updated_at
  from public.kaw_data d
  where d.account_type in ('retirement', 'isa', 'pension', 'irp')
    and left(d.profile, 1) <> '_'
  order by d.family_code, d.profile, d.account_type, d.updated_at desc nulls last
),
asset_library_shared as (
  select distinct on (d.family_code) d.family_code, d.data -> 'assetLibrary' as lib
  from public.kaw_data d
  where d.profile = '_shared' and d.account_type = '_assetLib'
    and jsonb_typeof(d.data -> 'assetLibrary') = 'array'
  order by d.family_code, d.updated_at desc nulls last
),
asset_library_meta as (
  select distinct on (d.family_code, d.profile) d.family_code, d.profile, d.data -> 'assetLibrary' as lib
  from public.kaw_data d
  where d.account_type = '_meta'
    and jsonb_typeof(d.data -> 'assetLibrary') = 'array'
  order by d.family_code, d.profile, d.updated_at desc nulls last
),
basis_candidates as (
  -- 리밸런싱 history 항목
  select a.family_code, a.profile, a.account_type,
         'rebalance'::text as kind,
         (v.value ->> 'date') as basis_date,
         0 as kind_rank,                       -- 같은 날짜면 동기화(1)가 이긴다
         v.ord::bigint as ord,
         v.value as entry
  from accounts a
  cross join lateral jsonb_array_elements(
         case when jsonb_typeof(a.data -> 'history') = 'array' then a.data -> 'history' else '[]'::jsonb end
       ) with ordinality v(value, ord)
  union all
  -- 계좌 동기화 기록 — history 와 같은 모양의 항목으로 바꿔 같은 아래 로직을 쓴다
  select a.family_code, a.profile, a.account_type,
         'broker_sync'::text,
         (s.value ->> 'holdingsEffectiveFrom'),
         1,
         s.ord::bigint,
         jsonb_build_object(
           'date', s.value ->> 'holdingsEffectiveFrom',
           'id', s.value ->> 'id',
           'rowQuantitiesSnap', s.value -> 'quantities',
           'rowEtfSnap', s.value -> 'rowEtfSnap',
           'rowLabelSnap', s.value -> 'rowLabelSnap',
           'rowHoldingsSnap', s.value -> 'rowHoldingsSnap'
         )
  from accounts a
  cross join lateral jsonb_array_elements(
         case when jsonb_typeof(a.data -> 'brokerSyncs') = 'array' then a.data -> 'brokerSyncs' else '[]'::jsonb end
       ) with ordinality s(value, ord)
  where s.value ->> 'kind' = 'broker_sync'
    and (s.value ->> 'holdingsEffectiveFrom') ~ '^\d{4}-\d{2}-\d{2}$'
    and jsonb_typeof(s.value -> 'quantities') = 'object'
),
last_rebalance as (
  -- 보유 기준: 날짜가 가장 늦은 항목 1개. 같은 날짜면 동기화, 그다음 배열에서 나중에 저장된 쪽
  select distinct on (c.family_code, c.profile, c.account_type)
         c.family_code, c.profile, c.account_type, a.data, a.updated_at, c.entry, c.kind
  from basis_candidates c
  join accounts a on a.family_code = c.family_code and a.profile = c.profile and a.account_type = c.account_type
  order by c.family_code, c.profile, c.account_type, c.basis_date desc nulls last, c.kind_rank desc, c.ord desc
),
holdings as (
  select
    r.family_code,
    r.profile,
    r.account_type,
    coalesce(r.data ->> 'profile', 'growth')                       as risk_profile,
    (r.entry ->> 'date')::date                                     as rebalance_date,
    r.entry ->> 'id'                                               as rebalance_id,
    r.kind                                                         as holdings_basis_kind,
    -- 예수금 관측 기준일(동기화가 기록한 값). 보유수량 효력일과 다른 시점일 수 있다 — 같은 날로 읽지 않도록 따로 노출한다
    case when (r.data -> 'cashBalanceObservation' ->> 'stateAsOf') ~ '^\d{4}-\d{2}-\d{2}$'
         then (r.data -> 'cashBalanceObservation' ->> 'stateAsOf')::date end as cash_state_as_of,
    coalesce((r.data ->> 'deposit')::numeric, 0)                   as deposit,
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
    select e.value ->> 'ticker' as ticker
    from jsonb_array_elements(coalesce(als.lib, alm.lib, '[]'::jsonb)) e
    where e.value ->> 'defaultEtf' = h.etf_name
      and nullif(e.value ->> 'ticker', '') is not null
    limit 1
  ) tk on true
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
  v.cash_balance,
  sum(v.market_value) over w + v.cash_balance                                   as total_asset_value,
  v.deposit,
  sum(v.market_value) over w + v.cash_balance                                   as rebalance_base_amount,
  round(v.market_value / nullif(sum(v.market_value) over w, 0) * 100, 4)        as current_weight_pct,
  v.target_weight_pct,
  round((sum(v.market_value) over w + v.cash_balance) * v.target_weight_pct / 100) as target_value,
  round((sum(v.market_value) over w + v.cash_balance) * v.target_weight_pct / 100)
    - v.market_value                                                            as rebalance_diff,
  v.in_target_profile,
  v.data_updated_at,
  v.holdings_basis_kind,
  v.cash_state_as_of
from valued v
window w as (partition by v.family_code, v.profile, v.account_type)
order by v.family_code, v.profile, v.account_type, v.market_value desc;

comment on view public.kaw_portfolio_live_view is
  '보유 기준(마지막 확정 리밸런싱 또는 더 늦은 계좌 동기화 broker_sync) x 캐시된 현재가 = 보유종목 단위 read-only 포트폴리오 현황. holdings_basis_kind 가 broker_sync 이면 rebalance_date 는 보유수량 효력일이고 snapshot_market_value 는 원장 취득금액이다. 총자산 = ETF 평가액(portfolio_market_value) + 실제 예수금(cash_balance) = total_asset_value. deposit 은 월 납입액 메타데이터일 뿐 기준금액에 포함되지 않는다. rebalance_base_amount 는 001 호환용 별칭. 조회 시 family_code/profile 필터 필수.';

revoke all on public.kaw_portfolio_live_view from anon, authenticated;
grant select on public.kaw_portfolio_live_view to service_role;
