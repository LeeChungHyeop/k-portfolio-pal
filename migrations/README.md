# Supabase 마이그레이션 / read-only 분석 경로

번호순으로 **Supabase 대시보드 → SQL Editor** 에 붙여넣고 Run 한다. 모두 idempotent 다.

| 파일 | 내용 |
|---|---|
| `001_live_prices_and_portfolio_view.sql` | 시세 캐시 테이블 `kaw_live_prices`, 신선도 상수 함수 `kaw_price_stale_seconds()`(900초, `search_path = pg_catalog` 고정), 분석 view `kaw_portfolio_live_view` |
| `002_cash_balance.sql` | **실제 예수금** 도입에 맞춰 `kaw_portfolio_live_view` 재정의 (`cash_balance` / `total_asset_value` 컬럼 추가, 기준금액을 `ETF 평가액 + 실제 예수금` 으로 변경) |
| `003_daily_snapshots.sql` | **일별 자산 스냅샷** 테이블 `kaw_daily_portfolio_snapshots` 신설 (기간 성과 계산용). 001/002 의 객체는 건드리지 않는다 |

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


## 003 — 일별 자산 스냅샷 `kaw_daily_portfolio_snapshots`

기간 성과(일간/월간/연간)를 계산하기 위한 시계열이다. **`kaw_data.history` 는 쓰지 않는다**
— 그건 "리밸런싱을 저장한 날"의 기록일 뿐 일별 평가가 아니라서, 일간 수익률로 환산하면
틀린 숫자가 나온다.

이 테이블은 **날짜별 평가액만** 담는다. 외부 입출금은 **담지 않는다** — source of truth 는
앱의 cashflow 장부(`AccountState.cashflows`)다. 장부는 과거 날짜에 나중에 추가·수정·삭제될
수 있어서(15:40 스냅샷 이후 그 날 저녁에 입금을 기록하거나, 며칠 뒤 과거 입출금을 보정하는
경우) 여기에 복사해두면 곧 stale 해진다. 기간 성과는 이 평가액과 **계산 시점의 현재 장부**를
결합해서 낸다.

| 컬럼 | 뜻 |
|---|---|
| `snapshot_date` | 한국시간 기준 날짜. (family_code, profile, account_type, snapshot_date) 가 PK |
| `market_value` | ETF 평가액 = 마지막 확정 리밸런싱의 `rowQuantitiesSnap` x 그 시점 시세 |
| `cash_balance` | 실제 예수금 |
| `total_asset_value` | 총자산 = `market_value` + `cash_balance`. **`deposit` 은 더하지 않는다** |
| `price_fetched_at` | 평가에 쓴 시세 중 가장 오래된 조회시각(적재 근거) |
| `holding_count` | 평가에 들어간 보유종목 수(사후 점검용) |

### 적재 경로

```
Cloudflare Cron (평일 UTC 06:40 = 한국시간 15:40, 그 날의 마지막 슬롯)
   └─ scheduled()  →  refreshLivePrices()        (기존 시세 갱신, 그대로)
                    →  writeDailySnapshots()      (추가)
                         └─ buildDailySnapshotRows()   ← 순수 함수, 단위 테스트로 고정
                         └─ upsert on (family_code, profile, account_type, snapshot_date)
```

- 15:40 슬롯에서만 쓴다. 다른 슬롯(09:00~15:30)에서는 시세만 갱신한다.
- **같은 날 여러 번 돌아도 PK + upsert 로 한 행만 유지된다.**
- **보유종목 중 신선한 시세(900초 이내)를 못 구한 종목이 하나라도 있으면 그 계좌의 그 날
  행을 아예 쓰지 않는다.** 일부만 최신인 평가액은 그 날 성과를 틀리게 만들기 때문이다.
  `rowHoldingsSnap`(저장된 평가금액) 폴백도 쓰지 않는다 — 화면 표시용 폴백이지 그 날의 시세가 아니다.
- **한국 공휴일은 판단하지 않는다.** 휴장일에 적재되는 값은 직전 거래일 종가 x 보유수량이고,
  그것은 그 날의 실제 평가액으로서 옳다(그 날 손익이 0이 될 뿐이다). 없는 거래를 만들지 않는다.
- **cashflow 를 적재하지 않는다.** 스냅샷 생성 시 장부를 읽지도 않는다.

### 읽기 경로

브라우저는 이 테이블에 직접 붙지 않는다. Worker 의 인증된 `GET /api/snapshots`
(세션 토큰 필요, `handleSnapshotsGet`)만 쓰며, 세션의 `family_code`/`profile` 로 필터된다.
돌아오는 것은 평가액뿐이고, 외부 입출금은 브라우저가 이미 가진 `account.cashflows` 를 쓴다.
`anon`/`authenticated` GRANT 는 회수돼 있고 RLS 정책이 0개라 `service_role` 만 접근 가능하다.

### 기간 성과 계산 (`src/lib/kaw/performance.ts`)

```
calculatePerformance(snapshots, cashflows, scope, period)

기간 손익  = 기말 총자산 - 기초 총자산 - 기간 중 외부 입출금
기간 수익률 = 기간 손익 / (기초 총자산 + Σ 외부흐름 x 남은기간비율)     ← Modified Dietz
```

입력이 둘이고 각자 하나의 사실만 담당한다: **스냅샷 = 평가액**, **장부 = 외부 입출금**.
장부를 고치면 재스냅샷 없이 과거 기간 성과가 즉시 교정된다. 기간 흐름은 장부에서 더하므로
**스냅샷이 없는 날(휴장일·누락일)의 흐름도 빠뜨리지 않는다.**

흐름의 귀속 구간은 `CashflowEntry.timing` 에 따라 다르다. cashflow 의 `date` 는 항상 실제
입출금일이고, 날짜를 옮기는 대신 귀속만 조정한다:

| timing | 포함 조건 | 뜻 |
|---|---|---|
| `same_day`(기본) | `기초일 < 날짜 <= 기말일` | 그 날 바로 쓸 수 있는 돈 |
| `after_close` | `기초일 <= 날짜 < 기말일` | 그 날 15:40 스냅샷 **뒤**에 들어온 돈(퇴직연금 25일 저녁 입금) |

`after_close` 는 그 날로 끝나는 구간에는 들어가지 않고 그 날에서 시작하는 구간에 들어간다.
25일이 휴일이라 25일 스냅샷이 없으면 전후 유효 스냅샷 사이 구간에 자연스럽게 포함된다 —
공휴일 달력을 만들지 않는다.

`(기말 - 기초) / 기초` 를 쓰지 않는다 — 입금만 해도 수익률이 올라가기 때문이다.
구간 앞 스냅샷이 없는 가장 이른 구간은 구간 내부 첫 스냅샷을 기초로 쓰고 `partial` 로
표시하며, 스냅샷이 1개뿐인 구간은 가짜 0% 대신 **결과에서 제외**한다.

**전체 scope 는 네 계좌 스냅샷이 모두 있는 날짜만 쓴다**(`requireAccountIds`). 한 계좌라도
빠진 날은 point 를 만들지 않는다 — 만들면 그 계좌 금액만큼 전체 자산이 급락한 것처럼
보이고, 그 날은 다음 구간의 기초점으로도 쓰이지 않는다. 계좌별 scope 는 그 계좌 스냅샷만
있으면 계산한다.

검증: `npx vite-node scripts/verify-cashflow-principal.ts` — production 데이터로
`totalAsset == ETF + cash`, `gain == totalAsset - principal`, 장부 복원 무손실,
예수금 이중계산 없음을 계좌별로 대조한다(SELECT 만 한다).
