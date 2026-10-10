# 미래에셋 export 재수집 — 준비 문서

수익 분석(`docs/profit-analysis-design.md` rev2) 구현의 **선행 blocker**다.
원장을 오늘까지 최신화하고 2026 YTD 전체가 exact 하게 이어지는 것을 확인한 뒤에
profit-analysis 구현에 들어간다.

**이 문서 시점: 2026-10-08. 코드 구현 0건, production write 0건.**

---

## 1. 지금 원장 상태 (이미 적재된 것)

| 계좌 | source kind | 원본 파일 | 거래 수 | 거래일 수 | 원장 cutoff | 결제일 범위 |
|---|---|---|---|---|---|---|
| retirement | `miraeasset_retirement_web` | `DC매매내역.xlsx` | 227 | 27 | **2026-10-01** | 2025-05-16 ~ 2026-10-06 |
| irp | `miraeasset_retirement_web` | `IRP.xlsx` (+수동 10행) | 65 | 9 | **2026-08-28** | 2026-01-02 ~ 2026-09-01 |
| isa | `miraeasset_transaction_history` | `ISA.xlsx` | 85 | 16 | **2026-06-26** | 2026-01-09 ~ 2026-06-30 |
| pension | `miraeasset_transaction_history` | `연금저축.xlsx` | 86 | 13 | **2026-08-28** | 2025-11-12 ~ 2026-09-01 |

cutoff 부근 거래일(겹침 구간을 정하는 근거):

```
retirement  … 2026-06-26, 2026-07-31, 2026-08-28, 2026-10-01
isa         … 2026-06-11, 06-15, 06-16, 06-18, 2026-06-26
pension     … 2026-05-27, 05-28, 2026-06-26, 2026-07-31, 2026-08-28
irp         … 2026-05-26, 05-28, 2026-06-26, 2026-07-31, 2026-08-28
```

메울 공백(2026-10-02 checkpoint 대조로 확인된 것):

| 계좌 | 미적재 변화 |
|---|---|
| retirement | **없음** (2026-10-01 이후 변화 없음). 그래도 10-02~오늘 확인용으로 받는다 |
| isa | `360750` +2주 |
| pension | `0167A0` −160(전량), `0181B0` −290(전량), `360750` +157, **`367380` +81 (신규 종목)** |
| irp | `0167A0` −37(전량), `0181B0` −67(전량), `360750` +24, `438080` +10, **`367380` +29 (신규 종목)** |

> 이 수량 차이는 **무엇을 확인해야 하는지 알려주는 단서일 뿐**이다.
> 차이로 거래를 합성하지 않는다. export 의 실제 체결만 넣는다.

> **IRP 는 이 재수집 계획으로 메울 수 없게 됐다** — 계좌가 2026-10-09 에 한국투자로
> 실물이전되어 미래에셋 매매내역 조회가 사실상 닫혔다. 2026-08-28 이후 IRP 구간의
> 조사 결론은 **§9** 에 따로 기록돼 있다. 나머지 세 계좌는 위 계획 그대로다.

---

## 2. 받아야 할 파일 — 계좌별

**원칙: 기존에 받은 것과 "같은 메뉴·같은 형식"의 파일을 다시 받는 것이 1순위다.**
파일명은 달라도 되고, **아래 컬럼이 들어 있는지로 판별**한다(메뉴 이름은 사이트
개편으로 바뀔 수 있으므로 컬럼이 진짜 기준이다).

### 2-1. 퇴직연금(DC) — `DC매매내역.xlsx` 와 같은 자료

- **계좌**: 미래에셋 퇴직연금 DC
- **자료 종류**: 연금 전용 화면의 **매매내역**(주문일이 찍혀 나오는 그 화면).
  일반 "거래내역"이 아니다 — 구별법은 **주문일 컬럼의 유무**다.
- **조회 범위**: **1순위 전체 기간 (2025-05-01 ~ 2026-10-08)** / 2순위 `2026-08-01 ~ 2026-10-08`
- **필요 날짜**: **주문일**(필수) + **결제일**(필수)

### 2-2. IRP — `IRP.xlsx` 와 같은 자료

- **계좌**: 미래에셋 IRP
- **자료 종류**: DC 와 **같은** 연금 매매내역 화면 (source kind 가 동일하다)
- **조회 범위**: **1순위 전체 기간 (2025-12-01 ~ 2026-10-08)** / 2순위 `2026-07-01 ~ 2026-10-08`
- **필요 날짜**: **주문일** + **결제일**
- 주의: v1 때 이 파일에 **2025-12-29 최초 배분 10건이 빠져 있었다.** 이번 export 에도
  빠져 있을 수 있다 — 이미 수동으로 적재돼 있으므로 다시 넣지 않아도 되지만,
  **빠지는 패턴이 2026년 구간에도 있는지** 반드시 확인한다.

### 2-3. ISA — `ISA.xlsx` 와 같은 자료

- **계좌**: 미래에셋 ISA
- **자료 종류**: 일반 **거래내역**(수수료·세금·거래후잔고가 같이 나오는 화면).
  구별법은 **거래후잔고 컬럼의 유무**다.
- **조회 범위**: **1순위 전체 기간 (2026-01-01 ~ 2026-10-08)** / 2순위 `2026-06-01 ~ 2026-10-08`
- **필요 날짜**: **결제일**(필수). 주문일은 이 화면에 없을 것이고 **없어도 된다**
  (§5 의 T+2 추정 + 타계좌 결제일 매칭으로 복원한다). 혹시 주문일이 나온다면
  **그게 훨씬 좋다** — 추정 61건이 사실로 바뀐다.

### 2-4. 연금저축 — `연금저축.xlsx` 와 같은 자료

- **계좌**: 미래에셋 연금저축펀드
- **자료 종류**: ISA 와 **같은** 일반 거래내역 화면
- **조회 범위**: **1순위 전체 기간 (2025-11-01 ~ 2026-10-08)** / 2순위 `2026-07-01 ~ 2026-10-08`
- **필요 날짜**: **결제일**(필수), 주문일 있으면 포함

### 2-5. (보조) 입출금·납입내역 — 4계좌

외부 입출금 장부(`verified-cashflows.ts`)가 오늘까지 최신인지 확인용이다.
현재 장부의 마지막 기록: retirement `2026-09-23`, pension·irp `2026-09-28`, isa `2026-06-26`.

- **조회 범위**: `2026-09-01 ~ 2026-10-08` (4계좌 전부)
- **자료**: 퇴직연금·IRP 는 **부담금 납입내역**, ISA·연금저축은 **입출금내역**
- 필요 컬럼: 입금일(실제 입금일) / 금액 / 구분(입금·출금·전환)
- 새 입금이 있으면 장부에 추가해야 한다(원장과 별도 경로). 없으면 그대로 둔다.

> 수익 분석의 L2(외부 입출금)는 이 장부가 유일한 source of truth 다. 원장만
> 최신화하고 장부가 뒤처지면 그 구간 수익률이 틀어진다.

---

## 3. 권장 조회 범위 — 왜 겹쳐 받는가

`source_fingerprint` UNIQUE 와 `on conflict do nothing` 때문에 **겹쳐 받아도 중복
적재되지 않는다**(2차 import 로 이미 실증: inserted 0 / skipped 463). 그래서 겹침은
비용이 없고, 얻는 것은 두 가지다.

1. **dedupe 가 실제로 동작하는지 확인** — 이미 아는 거래가 skipped 로 떨어져야 한다.
   하나라도 inserted 로 들어오면 그건 fingerprint 불안정 신호이고, **import 을 멈춰야
   하는 사건**이다.
2. **v1 에 빠진 거래 발견** — IRP 2025-12-29 선례가 있다. 겹침 구간에서 새 거래가
   나오면 그게 누락이었다는 뜻이다.

| 계좌 | **1순위: 전체 기간** | 2순위: 최소 겹침 | 사용자 제안 | 평가 |
|---|---|---|---|---|
| retirement | 2025-05-01 ~ 2026-10-08 | **2026-08-01** ~ 10-08 | 2026-09-01~ | 09-01 이면 겹치는 이벤트가 **10-01 하나뿐**이고, 그 날이 바로 경계일(§6 위험)이다. **08-01 로 한 달 앞당기면** 08-28 이벤트가 깨끗한 대조군이 된다 |
| isa | 2026-01-01 ~ 2026-10-08 | 2026-06-01 ~ 10-08 | 2026-06-01~ | **그대로 좋다.** 06-11·15·16·18·26 다섯 이벤트가 겹친다 |
| pension | 2025-11-01 ~ 2026-10-08 | **2026-07-01** ~ 10-08 | 2026-08-01~ | 08-01 이면 07-31 이벤트를 놓쳐 겹침이 08-28 하나뿐이다. **07-01 권장** |
| irp | 2025-12-01 ~ 2026-10-08 | **2026-07-01** ~ 10-08 | 2026-08-01~ | 위와 같음. **07-01 권장** |

**전체 기간을 권하는 이유**: 원본 행 번호(`sourceRow`)가 export 안에서 일관되게
매겨지고(§6), v1 전체를 fingerprint 로 재검증할 수 있고(463건이 전부 skipped 로
떨어지는지), 비용이 0 이다. **조회 기간 상한에 걸려 안 되면** 2순위 범위로 받는다.

조회 기준이 "주문일"인지 "결제일"인지 화면마다 다르다. **결제일 기준으로만 조회되는
화면이면 종료일을 넉넉히 둔다** — retirement 의 2026-10-01 주문은 결제일이 2026-10-06
이고, 10월 초 주문은 결제일이 오늘 이후일 수 있다. 종료일은 **조회 가능한 최대 미래
날짜**로 둔다.

---

## 4. 필요한 컬럼 — 체크리스트

### 4-1. 두 포맷 공통 (없으면 적재 불가)

| 컬럼 | 쓰이는 곳 | 비고 |
|---|---|---|
| **종목명** | `etf_name` (체결 당시 이름 보존) | |
| **종목코드** | `ticker` — **수익 분석이 직접 쓰는 키** | 6자리. 없으면 종목명으로 역추적해야 하는데 이름 매칭은 금지 경로다(§6 R8). **반드시 포함** |
| **매매구분** | `side` (매수/매도) | "매수"/"매도" 또는 "현금매수"/"현금매도" 등 원문 그대로 |
| **체결수량** | `quantity` | 주 |
| **체결단가** | `price` | 원 |
| **거래금액 / 체결금액** | `amount` — **증권사가 보고한 금액 그대로** | `수량×단가` 로 재계산하지 않는다. v1 에 반올림 차이 5건이 있다. **fingerprint 구성요소라 값이 바뀌면 중복이 생긴다** |
| **원본 행 순서** | `source_row` (일중 순서) | 파일의 위→아래 순서를 **그대로 보존**해서 넘긴다. 엑셀에서 정렬하지 말 것 |

### 4-2. 퇴직연금 DC / IRP 전용 (`miraeasset_retirement_web`)

| 컬럼 | 쓰이는 곳 | 필수? |
|---|---|---|
| **주문일** | `trade_date` → 근거 `broker-order-date` | **필수.** 이 포맷의 가장 큰 가치다 |
| **결제일** | `settlement_date` (fingerprint 구성요소) | **필수** |
| 수수료 / 세금 | `fee` / `tax` | v1 에서 이 포맷은 **없었다**. 있으면 넣고, 없으면 **`null` 로 둔다 — 0 으로 채우지 않는다** |
| 거래후잔고 | `post_quantity` | v1 에서 **없었다**. 있으면 넣는다(검증이 훨씬 강해진다) |

### 4-3. ISA / 연금저축 전용 (`miraeasset_transaction_history`)

| 컬럼 | 쓰이는 곳 | 필수? |
|---|---|---|
| **결제일** | `settlement_date` (fingerprint 구성요소) | **필수** |
| **수수료** | `fee` | **필수** (v1 은 85/86건 전부 있었다) |
| **세금** | `tax` | **필수** (v1 전부 있었다. 값이 0 이어도 "0 이라고 보고된 것"이라 의미가 있다) |
| **거래후잔고** | `post_quantity` | **필수** (v1 전부 있었다). 일중 순서 검증의 핵심 — 171건 대조가 여기서 나온다 |
| 주문일 | `trade_date` | v1 에는 **없었다**(그래서 61건이 추정). 있으면 **반드시 포함** — 추정이 사실로 바뀐다 |

### 4-4. 있으면 좋은 것 (필수 아님)

- **주문번호 / 체결번호** — fingerprint v2 의 기반이 된다(handoff §4.8). 내용 조합 대신
  번호로 신원을 잡으면 금액 반올림·이름 변경에 흔들리지 않는다. **지금은 v1 을 유지**하고,
  번호가 있으면 컬럼만 보존해 둔다.
- **거래구분 상세** (입고/출고/대체 등) — ETF 매매가 아닌 행을 걸러내는 데 쓴다.
- **통화 / 환율** — 전 종목 KRW 라 지금은 불필요. 외화 종목이 섞이면 필요해진다.

### 4-5. 받지 말아야 할 것 / 쓰지 않을 것

- **평가금액·수익률·비중** 컬럼은 **쓰지 않는다.** 조회 시점 값이라 과거 사실이 아니다.
- **목표비중**은 어떤 형태로도 쓰지 않는다(handoff §4.2).
- 엑셀에서 **정렬·필터·행 삭제·수식 추가를 하지 않는다.** 행 순서가 데이터다.

---

## 5. 기존 parser 재사용 가능 여부 / 신규 parser 필요 여부

### 재사용 (수정 없음)

| 모듈 | 역할 |
|---|---|
| `src/lib/kaw/verified-transactions.ts` | 정규화 JSON → 앱 타입 + **적재 전 게이트 17개** |
| `src/lib/kaw/ledger.ts` | fingerprint v1, `INTRA_DAY_ROW_ORDER`, `compareIntraDayOrder`, `replayFinalHoldings`, `resolveEvents` |
| `src/lib/kaw/ledger-import-core.ts` | 쓰기 경로 (upsert + batch provenance) |
| `scripts/ledger-import.ts` | dry-run / `--apply` CLI |
| `scripts/ledger-verify.ts` | 적재 후 24항목 검증 (읽기 전용) |

**두 source kind 가 이미 등록돼 있다** — `miraeasset_retirement_web`(asc) /
`miraeasset_transaction_history`(desc). 같은 메뉴에서 받으면 **방향 규칙을 새로
실측할 필요가 없다.** 다른 메뉴 자료가 오면 새 source kind 를 만들고 방향을
실측해야 한다(handoff §5).

### 신규 필요 — **xlsx → 정규화 JSON 변환기**

**저장소에 broker xlsx 파서가 없다.** `data/verified-transactions.v1.json` 은 이전
세션에서 수작업으로 정규화한 결과물이고, `verified-transactions.ts` 는 그 **JSON 만**
읽는다. (`xlsx` 패키지는 들어 있지만 `SettingsPage.tsx` 의 포트폴리오 가져오기/내보내기
전용이다.)

→ 새로 만들 것: **`scripts/ledger-normalize-export.ts`** (읽기·파일 생성 전용, DB 접근 없음)

```
입력   미래에셋 xlsx 4개 (+ 포맷별 컬럼 매핑)
출력   data/verified-transactions.v2.json  (v1 과 같은 스키마)

해야 할 일
 1. 두 포맷의 컬럼 매핑 (주문일 유무로 포맷 판별)
 2. 금액·수량·단가의 숫자 파싱 (쉼표·원 단위 문자 제거). **amount 는 보고값 그대로**
 3. 매매구분 → side (매수/매도 외의 행은 **버리지 않고 분류 불가로 보고**)
 4. 파일 행 순서 → sourceRow (정렬 금지)
 5. ISA/연금의 tradeDate 추정: T+2 평일 역산 + **타계좌 결제일 매칭**
    (v1 의 `cross-account-settlement-match` 110건이 이 경로다)
 6. fee/tax/postQuantity: 없으면 **null**. 0 으로 채우지 않는다
 7. validation 블록 재계산 (건수 / finalHoldings / cashflow 체크섬)
 8. **v1 과의 diff 리포트** — 신규 / 동일 / "같은 체결인데 값이 다른 것" 세 분류
```

8번이 가장 중요하다. 세 번째 분류(같은 체결인데 금액·단가·결제일이 다른 것)는
**fingerprint 가 달라져 중복 적재되는 유일한 경로**이므로, 하나라도 나오면 import 하지
않고 먼저 원인을 본다.

---

## 6. 예상 dedupe 방식 — 안전한 이유와 유일한 위험

### fingerprint v1

```
v1 | source | 계좌 | 종목 | 매매구분 | 수량 | 단가 | 금액 | 거래일 | 결제일 | 동일건순번
```

2단 방어:

1. **적재 전** — 정규화 단계에서 fingerprint 를 계산해 DB 의 기존 값과 대조하고
   신규/중복을 리포트한다(dry-run).
2. **DB** — `UNIQUE (family_code, profile, source_fingerprint)` + `on conflict do nothing`.
   이미 있는 fingerprint 는 **DB 레벨에서 조용히 skip** 된다.

### 중요: 추정값은 fingerprint 에 들어가지 않는다 (확인함)

ISA/연금의 `trade_date` 는 **`null`** 이다(ISA 85건·연금 86건 전부). 추정 결과는
`inferred_trade_date` 에만 들어간다. fingerprint 는 `tradeDate ?? ""` 를 쓰므로
**T+2 추정이나 타계좌 매칭 결과가 바뀌어도 fingerprint 는 변하지 않는다.**

즉 fingerprint 구성요소는 **전부 증권사가 직접 보고한 사실**이다
(source / 계좌 / 종목코드 / 매매구분 / 수량 / 단가 / 금액 / 결제일 / 주문일(DC·IRP 만)).
→ **겹쳐 받아도 중복이 생기지 않는다.** 재수집 전략의 전제가 성립한다.

### fingerprint 가 흔들리는 조건 (= 중복이 생기는 유일한 경로)

| 조건 | 대응 |
|---|---|
| `amount` 가 v1 과 다르게 나온다 (반올림·수수료 포함 여부 변경) | 정규화 리포트 8번에서 잡는다. 보고값을 가공하지 않는다 |
| `종목코드` 표기 변경 | 같은 이유로 리포트에서 잡힌다 |
| **`source` 문자열을 새로 지었다** | 기존 두 문자열을 **그대로** 쓴다. 바꾸면 463건 전부 중복 |
| 계좌 매핑 오류 (irp↔retirement 등) | 계좌별 건수·finalHoldings 게이트가 잡는다 |
| 다른 메뉴에서 받아 포맷이 다르다 | 새 source kind 가 필요하고, 그러면 겹침분이 전부 신규로 들어온다. **같은 메뉴를 받는 것이 1순위인 이유** |

### 별개 위험 — `sourceRow` 세대 혼재 (경계일 한정)

`sortedEffective` 는 **eventDate 를 먼저** 비교하고, 같은 날 안에서만
`compareIntraDayOrder`(계좌 → source → 방향 적용 sourceRow → id)를 쓴다
(`ledger.ts:534`). 그래서 행 번호 체계가 달라도 **다른 날짜끼리는 영향이 없다.**

문제는 **한 날짜에 "이미 적재된 행"과 "새로 발견된 행"이 섞이는 경우**다. export 는
최신순이라 거래가 추가되면 번호가 전부 밀리고, 원장은 immutable 이라 기존 `source_row`
를 고칠 수 없다. 두 세대의 번호가 같은 날 안에서 비교되면 일중 순서가 틀어진다.

- 후보 경계일: retirement **2026-10-01**, isa **2026-06-26**, pension·irp **2026-08-28**
- 검출: ISA·연금은 **거래후잔고 대조**가 즉시 잡는다(전건 보유). DC·IRP 는
  거래후잔고가 없어 **음수 보유수량 검사 + 최종 보유수량 checkpoint 대조**가 유일한 방어다.
- 대응: `sourceRow` 는 **fingerprint 에 들어가지 않으므로 자유롭게 부여할 수 있다.**
  경계일이 실제로 쪼개지면, 정규화기가 그 날짜의 신규 행에 **기존 행들과 올바르게
  섞이는 번호**를 부여한다(새 export 안의 상대순서를 보존하면서). 추측이 필요하면
  넣지 않고 사용자에게 묻는다.
- 완화: **전체 기간 재조회**가 경계일 쪼개짐을 진단 가능하게 만든다(새 export 가 그 날의
  전체 행을 다 보여주므로 상대순서를 알 수 있다). 겹침 구간을 **한 이벤트 이상** 잡는
  §3 권고도 같은 이유다.

---

## 7. 데이터를 받은 뒤 실행할 정확한 단계

사용자 계획(A~J)을 그대로 따르고, 위 조사에서 나온 게이트를 끼워 넣었다.

```
A.  새 export 파싱
    scripts/ledger-normalize-export.ts (신규) → data/verified-transactions.v2.json
    · 포맷 판별(주문일 유무) / 컬럼 매핑 / 행 순서 보존
    · 매매가 아닌 행(입고·출고·대체 등)은 버리지 않고 "분류 불가"로 리포트

B.  기존 463건과 dedupe
    fingerprint v1 계산 → DB 기존 fingerprint 와 대조
    · 기대: 겹침 구간의 기존 거래가 **전부 "동일"** 로 떨어진다

B2. ★ 추가 게이트 — "같은 체결인데 값이 다른 것" 0건 확인
    (계좌·종목·매매구분·수량·결제일)이 같은데 금액·단가가 다른 행을 찾는다
    · 1건이라도 있으면 **멈추고 원인을 본다** (중복 적재의 유일한 경로, §6)

C.  신규 거래만 식별
    · 계좌별 신규 건수·거래일을 §1 의 미적재 변화와 **방향이 맞는지** 눈으로 확인
      (isa +2주 / pension·irp 전량매도+신규매수 / retirement 0건 예상)
    · v1 누락이 겹침 구간에서 발견되면 별도로 표시한다 (IRP 2025-12-29 선례)

D.  신규 ticker 확인
    · **367380(ACE 미국나스닥100) 확인** — 원장 첫 등장. 총 17종목이 된다
    · _meta.assetLibrary 에 등록돼 있는지, 네이버 OHLC 조회가 되는지
    · HISTORY_SERIES_MAX_TICKERS = 20 여유 확인 (설계 R4: 32 로 상향 예정)

E.  source 별 intra-day ordering 재검증
    · INTRA_DAY_ROW_ORDER 를 **바꾸지 않고** 검증만 한다
      (retirement_web = asc / transaction_history = desc)
    · 음수 보유수량 0건 / 거래후잔고 대조 불일치 0건
    · ledger-order.test.ts 와 같은 방식으로 **여러 입력 순서**에서 같은 결과 확인
    · 경계일 세대 혼재(§6) 를 여기서 집중 확인

F.  final holdings 를 최신 checkpoint 와 대조
    · 2026-10-02 (isa·pension·irp) / 2026-10-01 (retirement) rowQuantitiesSnap
    · 그 뒤 리밸런싱이 있었으면 그 날짜 snapshot 과 liveQuantities 를 다시 확인
    · **전 ticker 불일치 0 이어야 통과.** 여기가 "원장이 오늘까지 완전"의 증명이다

G.  dry-run
    npm run ledger:dry-run -- --family=soye --profile=hyeobi
    · 게이트 17개 + validation 블록(건수·finalHoldings·체크섬) 일치

H.  ★ 사용자 승인 후에만 production import
    npm run ledger:import -- --apply --family=soye --profile=hyeobi
    · 기존 463행은 건드리지 않는다(append only, immutable)

I.  재import 검증
    · 같은 명령 재실행 → **inserted 0 / skipped (463+신규)**
    · npm run ledger:verify → 24항목 통과
    · scripts/verify-ledger-cutoff.ts 로 cutoff-aligned 재검증 0 불일치
    · isa/pension/irp 의 R(미설명 수입 상한)이 이제 계산 가능해진다 (설계 §6.5)

J.  그 다음에만 profit-analysis 구현 (설계 문서 Step 3~10)
```

**manual supplemental transaction 은 export 에 실제 거래가 빠진 경우에만 쓴다.**
보유수량 차이만 보고 거래를 합성하지 않는다. 수동행에 필요한 최소 정보는
종목코드 / 매매구분 / 체결수량 / 체결단가 / 거래금액 / **거래일**이고,
**거래일을 모르면 넣지 않는다.**

함께 갱신해야 하는 것(한 커밋에):
`data/verified-transactions.v2.json` 의 `validation` 블록,
`verified-transactions.test.ts` 의 고정값(2026-08-28 퇴직연금 매수 5종목 등),
`docs/ledger-handoff.md` §2·§3 의 건수·cutoff.

---

## 8. 사용자가 지금 할 일 — 요약

```
□ 퇴직연금 DC  매매내역(주문일 포함)   2025-05-01 ~ 2026-10-08   [안 되면 2026-08-01~]
□ IRP          매매내역(주문일 포함)   2025-12-01 ~ 2026-10-08   [안 되면 2026-07-01~]
□ ISA          거래내역(거래후잔고 포함) 2026-01-01 ~ 2026-10-08   [안 되면 2026-06-01~]
□ 연금저축     거래내역(거래후잔고 포함) 2025-11-01 ~ 2026-10-08   [안 되면 2026-07-01~]
□ (보조) 4계좌 납입/입출금내역          2026-09-01 ~ 2026-10-08

· 엑셀 그대로. 정렬·필터·행삭제·수식 금지 (행 순서가 데이터다)
· 종료일은 조회 가능한 최대 미래 날짜로 (결제일 기준 화면 때문)
· 종목코드 컬럼이 반드시 보이게
· 받은 파일은 저장소 바깥에 두고 경로만 알려주면 된다 — xlsx 를 git 에 넣지 않는다
```

---

## 9. IRP 2026-08-28 이후 — 조사 기록 (최종 개정 2026-10-10)

**상태: `checkpoint + broker-historical-balance confirmed holdings/settlement transition,
aggregate net settlement confirmed, individual execution unavailable`.
거래 원장(Transaction Ledger) 신규 actual execution 적재 0 건.**
조사는 전 과정 read-only 였고 production write / migration / import 는 없었다.

조사 경로: production Supabase(service_role read) / `data/verified-transactions.v2.json` /
KIS Open API 실계좌 read(ACNT_PRDT_CD=29) / 한국투자 앱 화면 / **미래에셋 웹 날짜별
과거잔고(IRP 계좌행 "자산총액")** / 네이버·KRX 일봉.

> **이 절은 ROBUST(§9-4)와 PROVISIONAL/CANDIDATE(§9-5)를 엄격히 나눈다.
> candidate 를 확정 사실로 쓰지 않는다.** 등급 명칭은 §9-2.

### 9-1. 왜 §2-2 의 재수집으로 메울 수 없는가

미래에셋 IRP → **한국투자 IRP 로 2026-10-09 실물이전 완료**(사용자 직접 확인, 매도·재매수
없음). 이전 후 미래에셋 매매내역 조회가 사실상 닫혀 §2-2 의 `IRP.xlsx` 재수집 경로가 막혔다.
**KIS 는 퇴직연금계좌 체결내역을 거부한다** — `inquire-daily-ccld`, TTTC8001R·TTTC0081R
모두 `rt_cd=7 / APBK1744 "퇴직연금계좌는 해당 서비스가 불가합니다"`. KIS 가 주는 것은
잔고와 취득원가뿐이다.

**다만 종료·이전된 계좌도 "날짜별 과거잔고"의 계좌 요약(자산총액)에는 남아 있다.**
이 경로가 §9-3 의 복원을 가능하게 했다. 화면에 "국내주식: KRX시세 기준, 과거일자는
KRX 정규장 종가 기준"이 명시돼 있다. 단 그 화면의 종목 상세표에는 ISA·연금저축 종목이
섞여 나오므로 **IRP holdings source 로 쓰지 않는다** — holdings 는 원장과 앱 checkpoint
에서만 가져왔다.

### 9-2. 근거 분류 — `A-exec` 와 account-state 증거를 섞지 않는다

| 코드 | 명칭 | 뜻 |
|---|---|---|
| **A-exec** | *actual broker execution evidence* | 체결 1 건 = 원장 1 행. 수량·단가·금액·거래일·결제일이 증권사 체결기록으로 확인된 것 |
| **P** | *broker-confirmed current position / account evidence* | 증권사가 확인해 준 **현재 상태**(보유수량·취득원가 집계·예수금). 체결 증거가 아니다 |
| **T** | *transfer evidence* | 계좌이전 방식·완료일 |
| **H** | *broker historical-balance (transition) evidence* | 증권사가 날짜별로 보고한 **계좌 상태와 그 전환**. 체결 증거가 아니다 |
| **AGG** | *aggregate-confirmed (derived)* | 위 + 기존 원장으로 산술적으로 닫히는 집계값. **체결 단위로 쪼갤 수 없다** |
| **B** | *app checkpoint evidence* | 앱이 기록한 수량 스냅샷·내부 타임스탬프 |

> **2026-08-28 이후 IRP 의 `A-exec` 는 0 건이다.** 원장의 IRP 65 건은 전부 8/28 까지다.
> `P`/`H`/`AGG` 를 `A-exec` 로 승격시키지 않는다 — 이 절의 존재 이유다.

### 9-3. historical-balance accounting model 과 control validation

모델 **V1**: 「자산총액 = 결제기준(settlement-basis) holdings × 당일 종가 + residual」.
holdings 는 원장 replay(PRE) 와 10-02 checkpoint·10-09 KIS(POST) 에서만 가져왔고,
가격은 네이버·KRX 일봉으로 직접 조회했다.

| 기준일 | 요일 | 적용 holdings | market value | 자산총액(실측) | residual | 전구간 대비 |
|---|---|---|---|---|---|---|
| 2026-08-28 | 금 | PRE-8/28 (39/98/52/92) | 4,090,340 | 4,351,157 | **260,817** | — |
| 2026-08-31 | 월 | PRE-8/28 | 4,090,840 | 4,351,678 | **260,838** | +21 |
| **2026-09-01** | 화 | **POST-8/28** (67/93/37/67) | 4,328,905 | 4,341,748 | **12,843** | **−247,995** ← 결제 |
| 2026-09-23 | 수 | POST-8/28 | 4,449,785 | 4,462,639 | 12,854 | +11 |
| 2026-09-28 | 월 | POST-8/28 | 4,392,080 | 4,654,955 | 262,875 | **+250,021** ← 입금 |
| 2026-10-01 | 목 | POST-8/28 | 4,453,990 | 4,716,927 | **262,937** | +62 |
| 2026-10-02 | 금 | POST-8/28 | 4,423,590 | 4,686,612 | 263,022 | +85 |
| 2026-10-06 | 화 | POST-8/28 | 4,429,675 | 4,692,718 | **263,043** | +21 |
| **2026-10-07** | 수 | **POST-10/02** (91/103/29) | 4,710,090 | 4,712,548 | **2,458** | **−260,585** ← 결제 |

2026-10-08 은 **조회 불가**(10/09 타사 이전으로 과거계좌 목록에서 소멸).

**CONTROL EVENT — 2026-08-28 리밸런싱.** 이미 `A-exec` 가 완전한 이벤트라
(tradeDate 2026-08-28 / settlementDate 2026-09-01 / 체결 8 건 전부 원장에 존재)
V1 을 **정답지로 채점**할 수 있다. 네 항목 모두 통과:

1. 8/28·8/31 이 **PRE** holdings 로 설명된다 (두 가설 간 mv 간격 230,255~246,275 원)
2. 9/01 이 **POST** holdings 로 설명된다
3. 전환 시점이 **known settlementDate 2026-09-01 과 정확히 일치**한다 (8/31 은 아직 PRE)
4. residual 변화가 known 현금이동과 **1 원 단위로 일치**한다 —
   `260,838 − 12,843 = 247,995 = 2,044,030(매수 gross) − 1,796,035(매도 gross)`

**이것이 이 조사에서 가장 강한 증거다.** 10/06→10/07 전환은 더 이상 단일 사건에 대한
귀납이 아니라, known broker event 에서 검증된 모델의 적용이다.

**대안 holdings 가설은 궤적을 만들지 못한다**: 10/06 에 POST 를 넣으면 residual 이
**−12,822**(음수·불가능)가 되고, 10/07 에 PRE 를 넣으면 338,368 이 되어 10/09 이전수량
(POST)과 모순된다.

**9/01 의 정합이 증명하는 것의 범위(중요).**
`감소 = (gross매수 − gross매도) + F − c` 이고 gross 차가 247,995 이므로 나오는 결론은
**`F = c` (reported gross 를 넘는 net settlement adjustment = 0)** 하나뿐이다.
수수료·세금 `F` 와 당일 미관측 cash credit `c` 가 **각각 얼마인지는 미확정**이며,
둘이 동시에 존재해 상계됐을 가능성을 과거잔고 snapshot 만으로 배제할 수 없다.
**다른 날짜에서 관측된 credit 최대값(85 원)은 9/01 당일 `c` 의 상한이 아니다 —
따라서 `F` 의 upper bound 는 이 증거로 얻을 수 없다.**

### 9-4. ROBUST

| # | 항목 | 내용 |
|---|---|---|
| R1 | **historical-balance settlement-basis model control validation** | V1 이 known broker execution event 로 검증됨. 9 개 기준일이 하나의 규칙으로 닫히고 대안 가설은 궤적을 만들지 못한다. 미래에셋의 공식 "자산총액" 정의를 문서로 읽은 것은 아니다 — **검증된 모델이지 확인된 정의는 아니다** |
| R2 | **8/28 → 9/01 known-event validation** | 8/28·8/31 = PRE, 9/01 = POST. 전환이 known settlementDate 와 정확히 일치. residual 변화 −247,995 가 보고 gross 차와 1 원 단위 일치 |
| R3 | **10/06 PRE → 10/07 POST transition** | 10/06 = PRE + 263,043, 10/07 = POST + 2,458. 10/07 residual 2,458 은 10/09 한국투자 KIS·앱화면(2 채널)과 원 단위 일치 |
| R4 | **holdings delta (구간 `(2026-08-28, 2026-10-02]`)** | 360750 **+24** / 438080 **+10** / 367380 **+29**(신규) / 0167A0 **−37**(전량) / 0181B0 **−67**(전량) |
| R5 | **tradeDate = 2026-10-02 (high-confidence reconstructed)** | ① 결제 10/07 + 증권사 보고 T+2 앵커(retirement 2026-10-01 → 결제 2026-10-06, 주문일 직접 보고) ⟹ 10/02 유일 ② 10/02 residual 이 아직 PRE ⟹ 거래일에 미결제, 정합 ③ 앱 자산·행 생성 2026-10-02 11:19:20 / 11:20:23 KST ④ 같은 날 연금저축의 broker-backed 10/02 이벤트. **A-exec 아님** |
| R6 | **settlementDate = 2026-10-07 (high-confidence)** | R3. 전환 메커니즘이 R2 에서 캘리브레이션됐다. **A-exec 아님** |
| R7 | **net settlement cash outflow = 260,585** | 독립 2 경로 일치: (a) `263,043 − 2,458` (10/06→10/07 결제기준 residual) (b) `262,937 − 2,352` (10/01 residual − 10/02 app checkpoint cashBalance). **net 값이며 buy / sell / fee / tax 로 분해되지 않는다** |
| R8 | **9/28 external deposit control** | `residual(09-28) − residual(09-23) = +250,021` = verified 납입내역 **250,000** + 소액 credit 21. 외부입금이 residual 에 원 단위로 반영된다 |
| R9 | **+106 은 settlement amount 변경으로 설명되지 않는다** | R7 의 두 경로가 **완전히 같다**. settlement adjustment 였다면 정확히 106 만큼 달랐어야 한다 |
| R10 | **settlement-independent recurring small cash-like credit pattern** | residual 이 결제 없는 구간에서 반복적으로 소폭 증가: +21(8/28→8/31) · +11(9/01→9/23) · +21(9/23→9/28, 입금과 별개) · +62(9/28→10/01) · +85(10/01→10/02) · +21(10/02→10/06). **10/01~10/06 합계 +106.** 단순 일별 이자 적립과 맞지 않는다(22 일·잔고 12.8 천 = +11 vs 1 일·잔고 263 천 = +85). **정체는 이자 / 분배금 / 기타 cash credit 중 미확정.** 측정량은 엄밀히 residual 변화다 |
| R11 | **settled cash-like balance (residual) 실측값** | 2026-08-28 **260,817** · 2026-08-31 **260,838** · 2026-09-01 settlement 후 **12,843** · 2026-10-06 **263,043** · 2026-10-07 **2,458** |
| R12 | **10/02 app checkpoint cashBalance 2,352 의 수치 정합** | 10/01 settled cash-like residual(262,937)에서 10/02 리밸런싱의 confirmed net settlement cash(260,585)를 차감한 **projected / post-trade cash state 와 원 단위로 일치**한다. 이 값이 미래에셋의 특정 broker field(주문가능금액·D+2 예수금 등)를 직접 의미하는지는 **provenance 가 없어 미확정** |
| R13 | **observed rebalance event = 2026-10-02 1 개** | 관측된 5 종목 net holdings transition 이 2026-10-07 의 단일 settlement transition 으로 반영됐다. **관측에 흔적을 남기지 않는 중간 round-trip 거래가 없었다는 증명은 아니다.** 앱의 event grouping 기준으로 observed rebalance event date 는 하나다 |
| R14 | **현재 포지션 / 승계 취득원가 / 예수금 (P)** | 보유수량 360750 **91** / 438080 **103** / 367380 **29**. 취득원가 집계 **2,382,946 / 1,444,850 / 918,285** (합 4,746,081). 예수금 **2,458**. KIS `pchs_amt` · `pchs_avg_pric`×수량 · 요약 `pchs_amt_smtl_amt` · 한국투자 앱 화면(평가금액−평가손익) **4 경로 일치** |
| R15 | **계좌이전 전후 관측된 cash balance 변화 = 0 원 (T)** | 2026-10-07 미래에셋 historical residual **2,458**, 2026-10-09 한국투자 KIS/current cash **2,458**. **개별 이전 처리 과정에 어떤 내부 transaction 이 있었는지는 증명하지 않았다** |
| R16 | **individual executions unavailable** | 개별 execution 개수 / 각 fill 수량 / 각 fill 체결단가 / broker execution timestamp 미복원. 앱 타임스탬프 11:19:20 · 11:20:23 은 **app configuration / rebalance timestamp 이며 broker execution timestamp 가 아니다** |
| R17 | **Transaction Ledger 신규 actual execution = 0 건** | §9-6 |
| R18 | **S_gross 의 robust 제약** | `S_gross ∈ [1,412,275, 1,432,315]` (37 주·67 주, 호가 5 원, 10/02 일중범위만으로). 그리고 `S_gross = B_gross − 260,585 + (F − c)` — **B_gross 가 확정되면 즉시 따라 나온다** |

### 9-5. PROVISIONAL / CANDIDATE — 확정 사실로 쓰지 않는다

| # | 항목 | 값 | 필요한 미확인 전제 |
|---|---|---|---|
| C1 | fee / tax = 0 | — | 9/01 의 `F = c` 를 `F = c = 0` 으로 특정 |
| C2 | fee / tax upper bound | **없음** | — |
| C3 | KIS `pchs_amt` = pure execution gross | — | acquisition fee 의 capitalize 여부 / 이전 시 원가 반올림 방식 |
| C4 | 360750 buy gross | **621,485** | C1 + C3 |
| C5 | aggregate sell gross | **≈ 1,417,385** | C1 + C3 |
| C6 | 개별 매도가 | 0167A0 @19,430 / 0181B0 @10,425 | C1 + C3 + **종목별 단일가 가정** |
| C7 | fill structure (개수 · 수량 · 가격) | — | 복원 경로 없음 |
| C8 | 360750 호가단위 불일치의 원인 | 수수료 capitalize / 승계·이동평균 원가 반올림 / 복수 fill **세 가지가 분리되지 않음** | — |

**C6 의 민감도**: `F ∈ [0, 100]` 만 허용해도 종목별 단일가 해가 **10 개**로 늘고
(그중 하나는 0167A0 @19,440 = 같은 날 연금저축 실체결가), 복수 fill 을 허용하면
**연속 무한**이다. → **C6 은 유일해가 아니다.** 어떤 candidate 도 원장에 넣지 않는다.

**aggregate acquisition-cost increment(AGG)를 settlement buy gross 와 동일시하지 않는다.**
AGG ≈ 1,677,969 가 R18 의 robust 구간과 정합한다는 것은 **모순이 없다는 뜻이지
determination 이 아니다.**

### 9-6. 왜 "거의 확실한" 것조차 원장에 넣지 않는가

원장의 단위는 **체결 1 건**이고 `source_fingerprint` 가
(source · 계좌 · 종목 · 구분 · **수량 · 단가 · 금액 · 거래일 · 결제일**)로 구성된다(§6).
집계값이나 candidate 로 1 행을 만들면 나중에 실제 체결기록이 들어올 때
**같은 체결이 두 번 적재되는 유일한 경로**가 열린다.

매수 3 종목은 수량 · 거래일 · 결제일 · 총액 네 칸이 찼지만 **체결 단위가 비어 있다.**
매도 2 종목은 **종목별 총액조차 분리되지 않는다**(제약식이 두 종목 합계에만 걸린다).
→ **synthetic execution 을 만들지 않는다. 신규 actual execution 적재 0 건.**

### 9-7. 미복원 — 현재 확보된 evidence 만으로 복원 불가

- 개별 execution 개수
- 각 fill 수량
- 각 fill 체결단가
- broker execution timestamp
- `buy gross / sell gross / fee / tax` 의 개별 분해
- 0167A0 · 0181B0 **종목별** 매도대금 (제약식이 두 종목 합계에만 걸린다)

### 9-8. reopening 조건

**미래에셋 IRP 의 execution-level broker evidence(예: 원본 매매·체결내역, 공식 거래확인
자료 등)를 확보하는 경우** 이 구간을 다시 연다. 확보되면:

1. **R4 holdings delta 와 대조**
2. **tradeDate / settlementDate 검증** (R5 · R6)
3. **fill count / fill quantity / fill price 확인**
4. **기존 candidate(§9-5)와 분리** — candidate 를 근거로 삼지 않고 폐기 또는 확인만 한다
5. **실제 execution 만 Transaction Ledger 에 보충** (source kind · fingerprint 가 기존과
   같아 겹쳐 받아도 중복 적재되지 않는다 — §6)

**자료를 기다리느라 개발을 멈추지 않는다.** 수익 분석은 이 구간을 **§9-4(ROBUST)로만**
처리하고 **§9-5(PROVISIONAL/CANDIDATE)는 쓰지 않는다.** R10 의 소액 credit 은
정체가 미확정이므로 **external cashflow 로 넣지 않는다.**
