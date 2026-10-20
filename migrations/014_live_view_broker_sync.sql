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
-- 객체 보존: DROP 이 아니라 CREATE OR REPLACE VIEW 를 쓴다. 기존 컬럼의 이름 · 타입 · 순서가 그대로이고 새 컬럼만 맨 뒤에 붙으므로
--       Postgres 가 허용한다(어긋나면 이 스크립트가 통째로 실패하고 아무것도 바뀌지 않는다). view 의 소유자/의존 객체가 유지된다.
--       권한은 **명시적으로 최소화**한다(아래). 운영 view 에 service_role 의 UPDATE/DELETE 등이 남아 있어도 SELECT 만 남는다.
--
-- 미평가 처리: 동기화의 rowHoldingsSnap 은 평가금액이 아니라 원장 **취득금액**이다. 시세가 없는 동기화 종목은 그 금액으로
--       평가하지 않는다 — 행은 market_value = NULL · price_source = 'unpriced', 그 계좌의 portfolio_market_value ·
--       total_asset_value · rebalance_base_amount · current_weight_pct · target_value · rebalance_diff 는 전부 NULL(평가 보류),
--       valuation_complete = false. NULL 을 0원으로 보거나 일부 종목만 합산해 전체 평가액으로 내지 않는다.
--       일반 리밸런싱 기준 계좌의 폴백(저장된 평가금액, price_source = 'snapshot')은 002 와 똑같다.
--
-- 호환: 기존 컬럼은 이름 · 순서 · 타입이 그대로다. 맨 뒤에 `holdings_basis_kind`('rebalance' | 'broker_sync') ·
--       `cash_state_as_of`(예수금 관측 기준일, 없으면 NULL) ·
--       `valuation_complete`(평가 가능 여부) 세 개(`holdings_basis_kind` · `cash_state_as_of` · `valuation_complete`)만 덧붙인다. 동기화가 기준이면 rebalance_date 는 보유수량 효력일, rebalance_id 는 동기화 기록 id 이고,
--       동기화 기준 행의 snapshot_market_value 는 NULL 이다(취득금액을 평가금액처럼 노출하지 않는다).
--       동기화 기록이 없는 계좌의 결과는 002 와 한 행도 다르지 않다.
--
-- 보안: security_invoker = true. PUBLIC · anon · authenticated · service_role 의 모든 권한을 회수한 뒤 service_role 에 SELECT 만 부여한다.
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

create or replace view public.kaw_portfolio_live_view
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
    case when r.kind = 'broker_sync' then null   -- 동기화의 rowHoldingsSnap 은 취득금액이다 — 평가금액처럼 노출하지 않는다
         else coalesce((r.entry -> 'rowHoldingsSnap' ->> q.key)::numeric, 0) end as snapshot_market_value,
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
    -- 동기화 기준인데 시세가 없다 → 미평가 (취득금액으로 대신 평가하지 않는다)
    (p.holdings_basis_kind = 'broker_sync' and not coalesce(p.cached_price > 0, false)) as is_unpriced,
    case when p.cached_price > 0 then round(p.quantity * p.cached_price)
         when p.holdings_basis_kind = 'broker_sync' then null
         else p.snapshot_market_value end                          as market_value,
    case when p.cached_price > 0 then p.cached_source
         when p.holdings_basis_kind = 'broker_sync' then 'unpriced'
         else 'snapshot' end                                       as price_source
  from priced p
),
totals as (
  -- 계좌 단위 합계. 미평가 종목이 하나라도 있으면 합계를 만들지 않는다(NULL) — 일부만 합산한 값을 전체로 내지 않는다.
  select
    v.*,
    bool_or(v.is_unpriced) over w as acct_unpriced,
    sum(v.market_value) over w    as acct_market_value
  from valued v
  window w as (partition by v.family_code, v.profile, v.account_type)
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
  case when v.price_source in ('snapshot', 'unpriced') then null else v.cached_price end       as price,
  v.price_source,
  case when v.price_source in ('snapshot', 'unpriced') then null else v.cached_fetched_at end  as price_fetched_at,
  case when v.price_source in ('snapshot', 'unpriced') then null
       else floor(extract(epoch from (now() - v.cached_fetched_at)))::bigint
  end                                                                           as price_age_seconds,
  case when v.price_source in ('snapshot', 'unpriced') then true
       else (now() - v.cached_fetched_at)
            > make_interval(secs => public.kaw_price_stale_seconds())
  end                                                                           as price_is_stale,
  v.market_value,
  v.snapshot_market_value,
  case when v.acct_unpriced then null else v.acct_market_value end              as portfolio_market_value,
  v.cash_balance,
  case when v.acct_unpriced then null else v.acct_market_value + v.cash_balance end as total_asset_value,
  v.deposit,
  case when v.acct_unpriced then null else v.acct_market_value + v.cash_balance end as rebalance_base_amount,
  case when v.acct_unpriced then null
       else round(v.market_value / nullif(v.acct_market_value, 0) * 100, 4) end as current_weight_pct,
  v.target_weight_pct,
  case when v.acct_unpriced then null
       else round((v.acct_market_value + v.cash_balance) * v.target_weight_pct / 100) end as target_value,
  case when v.acct_unpriced then null
       else round((v.acct_market_value + v.cash_balance) * v.target_weight_pct / 100) - v.market_value end as rebalance_diff,
  v.in_target_profile,
  v.data_updated_at,
  v.holdings_basis_kind,
  v.cash_state_as_of,
  not v.acct_unpriced                                                           as valuation_complete
from totals v
order by v.family_code, v.profile, v.account_type, v.market_value desc nulls last;

comment on view public.kaw_portfolio_live_view is
  '보유 기준(마지막 확정 리밸런싱 또는 더 늦은 계좌 동기화 broker_sync) x 캐시된 현재가 = 보유종목 단위 read-only 포트폴리오 현황. holdings_basis_kind 가 broker_sync 이면 rebalance_date 는 보유수량 효력일이고 snapshot_market_value 는 NULL(취득금액을 평가금액으로 쓰지 않는다)이며 시세가 없으면 price_source = unpriced 로 계좌 합계를 NULL(평가 보류, valuation_complete = false)로 둔다. 총자산 = ETF 평가액(portfolio_market_value) + 실제 예수금(cash_balance) = total_asset_value. deposit 은 월 납입액 메타데이터일 뿐 기준금액에 포함되지 않는다. rebalance_base_amount 는 001 호환용 별칭. 조회 시 family_code/profile 필터 필수.';

-- 최소 권한: 기존 grant(운영에서 service_role 에 UPDATE/DELETE 등이 남아 있음이 확인됨)를 모두 회수하고 SELECT 만 다시 부여한다.
-- 이 view 는 읽기 전용 분석 경로다 — 앱 코드는 읽지 않고, 점검 스크립트와 외부 분석(ChatGPT)이 PostgREST GET(SELECT)으로만 읽는다.
revoke all on public.kaw_portfolio_live_view from public, anon, authenticated, service_role;
grant select on public.kaw_portfolio_live_view to service_role;
