# Supabase 마이그레이션 / read-only 분석 경로

번호순으로 **Supabase 대시보드 → SQL Editor** 에 붙여넣고 Run 한다. 모두 idempotent 다.

| 파일 | 내용 |
|---|---|
| `001_live_prices_and_portfolio_view.sql` | 시세 캐시 테이블 `kaw_live_prices`, 신선도 상수 함수 `kaw_price_stale_seconds()`(900초, `search_path = pg_catalog` 고정), 분석 view `kaw_portfolio_live_view` |
| `002_cash_balance.sql` | **실제 예수금** 도입에 맞춰 `kaw_portfolio_live_view` 재정의 (`cash_balance` / `total_asset_value` 컬럼 추가, 기준금액을 `ETF 평가액 + 실제 예수금` 으로 변경) |

001 은 이미 production 에 적용돼 있어 그대로 두고, view 의 최신 정의는 **002** 다.
`002` 는 view 를 `drop` → `create` 한다(컬럼 순서를 의미 단위로 묶기 위해). 기존 컬럼은
하나도 없어지지 않으므로 이름으로 SELECT 하던 외부 분석은 그대로 동작한다.

## 금액 컬럼 4종 (002 이후)

| 컬럼 | 뜻 |
|---|---|
| `portfolio_market_value` | ETF 평가액 합계 (수량 x 캐시 시세) |
| `cash_balance` | **실제 예수금** — 앱에서 사용자가 직접 입력해 저장한 증권계좌 현금잔액 |
| `total_asset_value` | 총자산 = ETF 평가액 + 실제 예수금. **목표금액·차액의 기준** |
| `deposit` | 이번 회차 월 납입액. 메타데이터일 뿐 기준금액에 더하지 않는다 |

`rebalance_base_amount` 는 001 호환용 별칭으로 남아 있고 값은 `total_asset_value` 와 같다.

예수금을 한 번도 입력하지 않은 계좌는 `cash_balance = 0` 이다. 과거 기록의
`baseAmount - totalValue` 를 예수금으로 역산하지 않는다 — 그 값은 예전 계산식
(`ETF 평가액 + 불입액`)에서 나온 가상값이라 실제 현금과 무관하다.

검증: `node scripts/verify-live-view.mjs` — 원본 JSONB 로 다시 계산한 값과 view 를
1원 단위로 대조한다. 002 적용 전에는 `cash_balance` 컬럼이 없다고 알려준다.

## 데이터 흐름

```
브라우저 ──POST /api/kis/price──┐
                                ├─► Worker ──► KIS Open API (1차)
Cloudflare Cron ──scheduled()──┘          └─► 네이버 증권 (fallback)
                                   │
          (응답은 그대로 반환)       └─ waitUntil ─► kaw_live_prices  upsert(ticker)
                                                         ▲
리밸런싱 확정 ──POST /api/data──► kaw_data(JSONB)         │
                                     │                   │
                                     └──► kaw_portfolio_live_view ◄┘
                                                │
                                        service_role 연결만 SELECT
                                                │
                                              ChatGPT
```

### 예정된 갱신 (Cloudflare Cron)

`wrangler.jsonc` 의 `triggers.crons` (UTC):

| cron | 한국시간 |
|---|---|
| `*/10 0-5 * * 1-5` | 평일 09:00 ~ 14:50, 10분 간격 |
| `0,10,20,30,40 6 * * 1-5` | 평일 15:00 ~ 15:40, 10분 간격 |

15:40(UTC 06:40) 조회값이 **장 마감 이후 최종 종가 캐시** 역할도 한다. 한국 공휴일은
판단하지 않는다 — 월~금이면 휴장일에도 돌지만, 전 거래일 종가가 그대로 다시 적재될 뿐이다.

`scheduled()` 는 `assetLibrary` 에 등록된 **unique ticker 만** 조회한다(중복 호출 없음,
상한 50개). KIS 토큰 KV 캐시 · Naver fallback · `upsertLivePrices()` 는 브라우저 경로와
같은 함수를 그대로 쓴다.

- `/api/kis/price` 는 무인증 공개 endpoint다. 그래서 **적재 대상 ticker 를 화이트리스트로
  좁혔다** — `kaw_data` 의 `assetLibrary`(`_assetLib`/`_meta`)에 등록된 ticker + 내장 자산
  기본 ticker(`BUILTIN_TICKERS`)만 `kaw_live_prices` 에 들어간다(5분 메모리 캐시).
  화이트리스트 밖의 종목도 **가격조회 응답은 종전과 동일하게** 돌려준다 — 적재만 하지 않는다.
  화이트리스트를 확인할 수 없으면(DB 조회 실패) 그 번에는 적재를 건너뛴다.
- 시세 캐시는 브라우저의 `/api/kis/price` 호출과 Cloudflare Cron 두 경로로 갱신된다.
  갱신이 멈춘 동안에는 마지막 성공값이 그대로 남아 있고, 900초(`kaw_price_stale_seconds()`)를
  넘기면 `price_is_stale = true` 로 표시된다. 장 마감 후 stale 은 정상이며 오류가 아니다.
- 캐시에 아예 가격이 없는 종목은 `price_source = 'snapshot'` 으로, 마지막 리밸런싱
  당시 평가금액(`rowHoldingsSnap`)으로 폴백한다. 앱 화면과 같은 폴백이다.

## view 조회 시 반드시 필터할 것

`kaw_data` 에는 과거 테스트용 `family_code`(`khnp`, `asdf`, `adf32`, `thedrunken`,
`soyf`, `soye2024` …)와 프로필(`test`, `dayoung`)이 함께 남아 있다.
실제 데이터는 `family_code = 'soye'`, `profile = 'hyeobi'` 다.

```sql
-- ① 계좌별 요약: 최근 확정 리밸런싱일 / 평가액 / 기준금액
select account_type,
       max(rebalance_date)            as 최근확정일,
       max(portfolio_market_value)    as 현재평가액,
       max(cash_balance)              as 실제예수금,
       max(total_asset_value)         as 총자산,
       max(deposit)                   as 이번회차불입액,
       bool_or(price_is_stale)        as 시세오래됨
from public.kaw_portfolio_live_view
where family_code = 'soye' and profile = 'hyeobi'
group by account_type
order by 현재평가액 desc;
```

```sql
-- ② 퇴직연금 보유종목 상세 (요청한 전체 항목)
select rebalance_date      as 최근확정일,
       etf_name            as "ETF명",
       ticker,
       quantity            as 보유수량,
       price               as 현재가,
       price_source        as 가격출처,
       price_fetched_at    as 시세시각,
       price_age_seconds   as 시세경과초,
       price_is_stale      as 시세오래됨,
       market_value        as 현재평가금액,
       current_weight_pct  as 현재평가비중,
       target_weight_pct   as 목표비중,
       target_value        as 목표금액,
       rebalance_diff      as 목표대비차액,
       in_target_profile   as 성향내종목,
       deposit             as 이번회차불입액,
       portfolio_market_value as "ETF평가금액합계",
       cash_balance           as 실제예수금,
       total_asset_value      as 총자산
from public.kaw_portfolio_live_view
where family_code = 'soye' and profile = 'hyeobi'
  and account_type = 'retirement'
order by market_value desc;
```

```sql
-- ③ 전 계좌 합산 + 종목별 통합 비중
with v as (
  select * from public.kaw_portfolio_live_view
  where family_code = 'soye' and profile = 'hyeobi'
)
select etf_name,
       sum(quantity)     as 총수량,
       sum(market_value) as 평가금액,
       round(sum(market_value) / (select sum(market_value) from v) * 100, 2) as 전체비중
from v
group by etf_name
order by 평가금액 desc;
```

```sql
-- ④ 리밸런싱 액션만 (±1만원 이상 차이나는 종목)
select account_type, etf_name, ticker,
       case when rebalance_diff > 0 then '매수' else '매도' end as 방향,
       abs(rebalance_diff)                 as 금액,
       floor(abs(rebalance_diff) / price)  as 예상수량
from public.kaw_portfolio_live_view
where family_code = 'soye' and profile = 'hyeobi'
  and price is not null
  and abs(rebalance_diff) >= 10000
order by abs(rebalance_diff) desc;
```

```sql
-- ⑤ 성향에서 지워졌지만 아직 보유 중인 종목 (전량 매도 대상)
select account_type, etf_name, quantity, market_value, target_weight_pct
from public.kaw_portfolio_live_view
where family_code = 'soye' and profile = 'hyeobi'
  and not in_target_profile;
```

## 권한

- `kaw_live_prices`: RLS on, **정책 0개** → `anon`/`authenticated` 는 전부 차단.
  `anon`/`authenticated` 에서 GRANT 도 회수. `service_role` 만 select/insert/update.
- `kaw_portfolio_live_view`: `security_invoker = true` 로 만들었으므로 조회자의 권한으로
  `kaw_data` 를 읽는다. 즉 view 를 통한 권한 우회가 불가능하다. `anon`/`authenticated`
  GRANT 회수, `service_role` 만 select.
- ChatGPT 는 `service_role`(또는 Supabase MCP 의 관리 연결)로 **SELECT 만** 하면 된다.
  공개 API URL 에 키를 붙이는 경로는 만들지 않았다.
- `kaw_price_stale_seconds()` 는 정의에 `set search_path = pg_catalog` 가 들어 있다.
  고정하지 않으면 Supabase security advisor 가 `function_search_path_mutable` 경고를 띄운다.
  production DB 에는 이미 `ALTER FUNCTION ... SET search_path = pg_catalog` 로 적용돼 있고,
  001 을 새 DB 에 처음 적용할 때도 같은 상태가 되도록 정의에 포함했다.
