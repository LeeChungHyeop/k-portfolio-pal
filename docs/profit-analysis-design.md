# 수익 분석 (구 "기간 성과") 전면 개편 — 설계안 (rev2)

**상태: 설계만. 구현 코드 변경 0건.** production DB write / migration / legacy 삭제는 범위 밖이다.

- 활성 프로젝트: `k-allweather`
- 선행 문서: `docs/ledger-handoff.md`
- rev2 변경: **cutoff-aligned 완전성 검증으로 Step 1 게이트를 교체**(§2), cutoff 이후
  미적재 거래 보충 전략 추가(§3), **cash/income 불확실성 3층 분리**(§6),
  period 독립 계산 명시(§5), exact/partial 경계 재정의(§9).

### rev1 에서 틀렸던 것

rev1 의 Step 1 게이트는 "원장 재생 최종 보유수량 == **현재** 보유수량" 이었다.
**이것은 잘못된 게이트다.** 원장에는 계좌별 cutoff 가 있고 그 이후 실제 거래가
아직 적재되지 않았다. 따라서 현재 수량과의 불일치는 "시작부 불완전"의 증거가 아니라
"cutoff 이후 미적재"의 증거다. 두 원인을 구분하지 못하는 게이트였다.

올바른 게이트는 **cutoff-aligned 비교**다 — 아래 §2 에서 실제로 돌렸고, **통과했다.**

---

## 1. 지금 2026-06-26 전후부터만 보이는 정확한 코드 원인

독립된 게이트 두 개가 겹쳐 있고, 둘 다 6월 즈음에 풀린다.

### 원인 A — legacy anchor 가 그때부터 존재한다

`historical-performance.ts:105` `validAnchors()` 는 `rowQuantitiesSnap` 이 있고 그 안에
양수가 하나라도 있는 history entry 만 anchor 로 인정한다. 이 필드는 `HistoryEntry` 의
**optional** 이고(`store.ts:37`), `addHistory` 가 저장할 때만 채워진다(`store.ts:866`).

**production 실측으로 확인됐다** — 계좌별 `rowQuantitiesSnap` 보유 entry:

| 계좌 | history 전체 | `rowQuantitiesSnap` 있는 entry |
|---|---|---|
| retirement | 2025-09-10 ~ 2026-10-01 (15건) | **2026-06-26** / 07-31 / 08-28 / 10-01 (4건) |
| isa | 2026-01-26 ~ 2026-10-02 (12건) | **2026-06-18** / 06-26 / 07-31 / 08-28 / 10-02 (5건) |
| pension | 2025-10-22 ~ 2026-10-02 (12건) | **2026-06-26** / 07-31 / 08-28 / 10-02 (4건) |
| irp | 2025-12-29 ~ 2026-10-02 (8건) | **2026-06-26** / 07-31 / 08-28 / 10-02 (4건) |

**2026-06-18 이전의 history 는 전부 수량 스냅샷이 없다.** 그래서
`anchors[0].date`(`:191`)가 복원 창의 좌측 끝이 되고(`:195`, `:247`), 그 앞은 가격조차
받아오지 않는다. retirement·pension·irp 는 anchor 가 정확히 **2026-06-26** 부터다.

> `rowHoldingsSnap`(금액)으로 메우는 경로는 **의도적으로 없다**(`historical-performance.ts:30`).
> 이 원칙은 개편 후에도 유지한다.

### 원인 B — 전체 scope 는 네 계좌가 **모두** 있는 날만 쓴다

`Dashboard.tsx:190` 이 전체 scope 에 `requireAccountIds: ACCOUNT_IDS` 를 주고,
`performance.ts:170` 이 한 계좌라도 빠진 날은 point 를 만들지 않는다. A 를 고쳐도 전체
탭은 네 계좌가 다 갖춰진 날부터만 보인다. 위 표에서 네 계좌가 모두 anchor 를 갖는 첫
날짜가 **2026-06-26** 이다 — 사용자가 본 날짜와 정확히 일치한다.

이 가드 자체는 틀리지 않았지만 **"아직 개설되지 않은 계좌"와 "있는데 빠진 계좌"를
구분하지 못한다.** 개편에서 이 구분을 넣는다(§8).

### 원인 C — 복원 구간 예수금이 0

`historical-performance.ts:280` `cashBalance: 0`. 2026년 구간에서는 무해했지만 범위를
2025년으로 넓히는 순간 치명적이 된다 — §6.

---

## 2. cutoff-aligned 완전성 검증 — **실행 결과: 전 계좌 통과**

production 을 **읽기 전용**으로 조회해 다음을 비교했다
(원장 463건 + 정정 overlay 0건 + `kaw_data` legacy history, 1회용 진단 스크립트로
실행 후 삭제. DB 에 아무것도 쓰지 않았다):

```
각 계좌: 원장을 cutoff(= 원장 마지막 실효 거래일)까지 재생한 보유수량
         vs  그 날짜의 독립 checkpoint (legacy history 의 rowQuantitiesSnap)
```

legacy history 는 **거래 추론에 쓰지 않았다.** 그 날짜의 state checkpoint 로만 썼다.

### 결과

| 계좌 | ledger cutoff | checkpoint | ticker 대조 | 결과 |
|---|---|---|---|---|
| retirement | 2026-10-01 | 2026-10-01 (당일) | 6종목 | **불일치 0 / 6** |
| isa | 2026-06-26 | 2026-06-26 (당일) | 3종목 | **불일치 0 / 3** |
| pension | 2026-08-28 | 2026-08-28 (당일) | 3종목 | **불일치 0 / 3** |
| irp | 2026-08-28 | 2026-08-28 (당일) | 4종목 | **불일치 0 / 4** |

종목별 실측값 (ledger replay == checkpoint, 전부 일치):

```
retirement 2026-10-01   0072R0 517 / 0162Z0 1143 / 0167A0 797 / 0181B0 1461 / 360750 715 / 438080 558
isa        2026-06-26   0167A0 803 / 0181B0 1605 / 360750 995
pension    2026-08-28   0167A0 160 / 0181B0 290 / 360750 140
irp        2026-08-28   0167A0  37 / 0181B0  67 / 360750  67 / 438080 93
```

ISA 는 cutoff 이후 checkpoint 가 세 개 더 있는데 **2026-07-31 과 2026-08-28 도 완전히
일치**한다(그 사이 거래가 없었다는 뜻). 즉 ISA 의 실질 exact 구간은 cutoff 보다 뒤인
**2026-08-28** 까지다.

### 결론

**원장은 각 계좌의 개시일부터 cutoff 까지 완전하다.** 16개 ticker-position 전부
독립 checkpoint 와 일치했다. 따라서 §6 의 과거 보유수량·예수금 유도는
**cutoff 까지는 정당하다.** rev1 이 걱정했던 "시작부 불완전" 가능성은 배제됐다.

---

## 3. cutoff 이후 미적재 거래 — 실측 차이와 보충 전략

### 3.1 현재 보유수량과 ledger final 의 차이 (= 미적재 거래의 효과)

`liveQuantities` 는 네 계좌 모두 **최신 history 의 `rowQuantitiesSnap` 과 동일**함을
확인했다(`YES` ×4). 따라서 최신 checkpoint 가 곧 현재 상태다.

| 계좌 | 비교 | ticker | ledger final | 현재 | 차이 |
|---|---|---|---|---|---|
| retirement | 2026-10-01 | 전 6종목 | — | — | **차이 없음** |
| isa | 2026-10-02 | 360750 | 995 | **997** | **+2** |
| | | 0167A0 / 0181B0 | 803 / 1605 | 803 / 1605 | 없음 |
| pension | 2026-10-02 | 0167A0 | 160 | **0** | **−160 (전량 매도)** |
| | | 0181B0 | 290 | **0** | **−290 (전량 매도)** |
| | | 360750 | 140 | **297** | **+157** |
| | | **367380** | 0 | **81** | **+81 (신규 종목)** |
| irp | 2026-10-02 | 0167A0 | 37 | **0** | **−37 (전량 매도)** |
| | | 0181B0 | 67 | **0** | **−67 (전량 매도)** |
| | | 360750 | 67 | **91** | **+24** |
| | | 438080 | 93 | **103** | **+10** |
| | | **367380** | 0 | **29** | **+29 (신규 종목)** |

cutoff 이후 cashflow 도 있다: pension `2026-09-28 +500,000`, irp `2026-09-28 +250,000`.
retirement·isa 는 cutoff 이후 외부흐름 0건.

**새 발견: `367380`(ACE 미국나스닥100)은 원장에 한 번도 없는 17번째 종목이다.**
원장의 16종목 + 이것 = 가격 조회 대상 17종목 → `HISTORY_SERIES_MAX_TICKERS = 20` 과의
여유가 3개로 줄어든다(R4).

**미적재 구간의 거래일조차 특정할 수 없다.** pension·irp 는 2026-08-28 과 2026-10-02
사이에 checkpoint 가 없으므로, 전량매도·신규매수가 언제 일어났는지 데이터로 모른다.

### 3.2 보충 전략 — 조사 결과

원칙(유지): 목표비중이나 legacy history 차이로 **거래를 역산하지 않는다.** 수량 차이만
보고 가상의 매수/매도를 만들지 않는다. 실제 체결내역 또는 사용자가 확인한 실제 거래만
넣는다.

| 경로 | 가능? | 근거 |
|---|---|---|
| **KIS API 로 체결내역 조회** | **불가** | KIS credential 은 **한국투자증권** 계좌용이다. 2026-10-06 PoC 로 확인된 연금저축(22)·IRP(29)는 당시 **빈 계좌**인 신규 한국투자 계좌이고, 이 원장의 네 계좌는 전부 **미래에셋**이다. KIS 로는 미래에셋 체결내역을 읽을 수 없다. KIS 는 이 프로젝트에서 **시세 전용**이다 |
| **미래에셋 export 재수집** | **가능. 권장 주경로** | 원장 463건이 `DC매매내역.xlsx` / 일반 거래내역 export 에서 왔다. 같은 파일을 최신 시점으로 다시 받으면 cutoff 이후 체결이 그대로 들어온다. `source_fingerprint` UNIQUE 때문에 **재적재해도 중복이 생기지 않는다**(멱등성은 2차 import 로 이미 실증: inserted 0 / skipped 463) |
| **미래에셋 공개 API** | 없음 | 개인 고객용 공개 체결내역 API 가 없다. export 가 유일한 1차 자료 |
| **사용자 확인 수동 보충** | **가능. 이미 선례 있음** | 데이터셋 `sourceNotes` 에 "IRP.xlsx omitted the initial 2025-12-29 allocation; **10 user-supplied broker rows were added**" 가 있다. 즉 사용자가 증권사 화면에서 확인한 실제 체결을 넣는 경로가 이미 검증돼 있다 |

### 3.3 권고 — 보충 절차

```
1순위  미래에셋 export 재수집 (DC매매내역 + ISA/연금 거래내역, 2026-10-07 기준)
       → data/verified-transactions.v2.json 으로 정규화
       → npm run ledger:dry-run (게이트 17개) → ledger:verify → ledger:import --apply
       · fingerprint UNIQUE 로 멱등. 기존 463행은 건드리지 않는다
       · 적재 후 cutoff-aligned 검증을 **2026-10-02 checkpoint 기준으로 다시 돌린다**
         → 0 불일치면 "원장이 today 까지 완전"이 증명된다

2순위  export 에 없는 체결만 사용자 확인 수동행으로 보충
       · source = "user_supplied_broker_row" (기존 10행과 같은 경로)
       · 필수: 종목코드 / 매매구분 / 체결수량 / 체결단가 / 체결금액 / 거래일
       · 거래일을 모르면 **넣지 않는다.** 날짜 추정으로 채우지 않는다

금지   수량 차이(−160/−290/+157/+81 등)로 거래를 합성하는 것
```

데이터셋 갱신 시 `validation` 블록(건수·finalHoldings·checksum)도 함께 갱신해야 하고,
`verified-transactions.test.ts` 가 들고 있는 고정값(2026-08-28 퇴직연금 매수 5종목 등)도
같이 갱신한다.

### 3.4 보충 전까지의 표시 규칙

**cutoff 이후 구간을 "ledger 기반 exact" 라고 표시하지 않는다.** §9 의 exact/partial
경계를 그대로 따르고, 미적재 구간은 아예 계산하지 않거나 `unledgered` 로 명시한다.
수량 차이를 메워 계산을 이어붙이지 않는다.

---

## 4. 과거 가격 구조 — open + close 보존

`kis-server.ts:260` 의 regex 는 이미 네 숫자를 캡처하고 시가(`m[2]`)를 **버리고 있다.**

```ts
const re = /\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g;
//            m[1] 날짜        m[2] 시가     m[3] 고가     m[4] 저가     m[5] 종가
out.push({ localTradedAt: ..., closePrice: m[5] });
```

→ `HistoryBarPoint { date, open, close }` 로 넓히면 **추가 네트워크 요청 0건.**
전일 종가를 시가로 대신 쓰는 경로는 만들지 않는다.

- `NaverPriceRow` 에 `openPrice?: string` 추가, `parseNaverSiseJson` 이 `m[2]` 를 담는다.
- `pickSeriesInRange` 는 **open·close 가 둘 다 유효할 때만** 행을 만든다(fail closed 확장).
  음수 표기 거르기도 open 에 같이 적용한다.
- 모바일 JSON 폴백의 `openPrice` 존재는 **Step 0 에서 실측**한다. 없으면 수익 분석은
  siseJson 전용으로 두고 그 종목은 fail closed — 전일 종가 대체는 하지 않는다.
- 서버 응답은 상위집합 `{ date, price, open }` — `price`(종가)를 그대로 둬서 기존
  소비자(`toPriceSeriesByTicker`)가 깨지지 않는다.

**fail closed 범위:** 그 날 보유한 양수 종목 중 하나라도 open 또는 close 가 없으면
그 계좌·그 날짜의 평가를 만들지 않는다. 구간 경계(월 첫/마지막 거래일)는 **평가가
성립한 거래일 중에서** 고른다 — 가격 결측일이 경계로 잡혀 그 달이 사라지지 않게.

---

## 5. daily / monthly / yearly — 각 period 를 **독립적으로** 계산한다

### 5.1 정의

| period | 구간 시작 O | 구간 끝 C |
|---|---|---|
| daily | 그 거래일 D (시가) | 같은 거래일 D (종가) |
| monthly | 그 달 **첫 거래일 시가** | 그 달 **마지막 거래일 종가** (진행 중이면 최신 거래일) |
| yearly | 그 해 **첫 거래일 시가** | 그 해 **마지막 거래일 종가** (진행 중이면 최신 거래일) |

거래일은 **가격 데이터에 실제로 존재하는 날짜**로만 정의한다. 달력·휴일표를 만들지
않는다. "1월 1일"은 쓰지 않고 라벨도 `2026년 (1/2~10/7)` 처럼 실제 거래일을 쓴다.

### 5.2 합성 금지 — 이것이 rev2 의 핵심 수정

**monthly/yearly 는 daily 수익률을 합성해서 만들지 않는다.** 각 period 를
**endpoint valuation + 그 기간 내부의 거래·cashflow** 로 독립 계산한다.

이유는 포함하는 갭이 다르기 때문이다:

| period | 기간 **내부** 오버나이트 갭 | 기간 **경계** 갭 |
|---|---|---|
| daily (D 시가→D 종가) | 없음 (하루 장중만) | 모든 오버나이트가 제외됨 |
| monthly (첫 시가→말 종가) | **전부 포함** | 전월 종가→당월 첫 시가만 제외 |
| yearly (첫 시가→말 종가) | **전부 포함** | 전년 종가→당년 첫 시가만 제외 |

따라서:

```
Π(1 + 일간수익률)  ≠  월간수익률        ← 일간은 월 내부 오버나이트를 전부 버린다
Σ 월간손익         ≠  연간손익          ← 월 경계 갭(11회)만 빠진다
```

미국지수 추종 ETF 는 수익 상당 부분이 밤에 생기므로 **일간 합과 월간·연간의 차이가
크다.** 이것은 버그가 아니라 정의의 결과다. 숨기지 않고 period 별로 "제외된 경계 갭"을
따로 보여줄 것을 제안한다(§13-2).

구현상 의미: 공통 함수 `segmentProfit(O, C)` 하나를 **period 별로 다른 (O, C) 에 대해
독립 호출**한다. daily 결과를 접어 올리는 코드 경로를 만들지 않는다.

### 5.3 자산 정의

```
V_open (D) = Σ_t H_open(t, D) ·P_open(t, D)  + C_open(D)      H_open:  eventDate <  D
V_close(D) = Σ_t H_close(t, D)·P_close(t, D) + C_close(D)     H_close: eventDate <= D
```

구간 [O, C] 에 대해 `V_open = V_open(O)`, `V_close = V_close(C)`.

### 5.4 외부흐름 귀속 — `유효일(effective date)` 로 통일

현재 코드의 두 부등식(`performance.ts` `isFlowInSegment`) 대신 흐름마다 유효일 하나를
계산해 한 규칙으로 처리한다.

```
e(flow) = same_day    → flow.date 이상인 첫 거래일
          after_close → flow.date 보다 큰 첫 거래일

flow ∈ [O, C]  ⟺  O ≤ e(flow) ≤ C
wi = clamp((T − dayDiff(O, e)) / T, 0, 1),   T = dayDiff(O, C)
```

기존 동작을 모두 포함하고 경계 케이스가 자동으로 맞는다: 주말·휴일 입금은 다음
거래일로, 12월 마지막 거래일 장마감 후 입금은 1월 첫 거래일(가중치 1)로, 월 첫
거래일 입금은 가중치 1, 월 마지막 거래일 입금은 가중치 0. **모든 흐름이 정확히 한
구간에만** 귀속된다. `cashflow.date` 는 실제 입금일 그대로 둔다 — 유효일은 파생값이다.

---

## 6. 손익·수익률의 3층 분해 — rev2 수정의 두 번째 핵심

### 6.1 rev1 이 뭉갰던 것

rev1 은 아래를 `profit` 이라고 불렀다.

```
① Σ H_open·(P_close − P_open)      기존 보유분 장중 평가손익
② Σ Δq   ·(P_close − p_exec)       당일 매매분 손익
③ − K                              보고된 수수료·세금
```

이 식은 **"알려진 시장·매매 손익"으로는 정확하지만 total return 이 아니다.**
미관측 현금수익(대기자금 이자, ETF 분배금)이 빠져 있다. 그리고 그 수익은 분모만이
아니라 **분자에도** 들어간다. rev2 는 이것을 분리해 표시한다.

### 6.2 3층 모델

```
L1  known market/trading P&L   = ① + ② − ③            ← 가격·체결 데이터로 정확
L2  known external cashflow    = F (cashflow 장부)      ← 장부가 source of truth, 정확
L3  unobserved cash income     = 이자 + 분배금 − 미보고 비용   ← 관측되지 않음, 범위로만

total return 분자 = L1 + L3(기간)
분모              = V_open + Σ wi·Fi      (V_open 안의 C_open 에도 L3 누적분이 들어있다)
```

### 6.3 L1 의 성질 (rev1 에서 유도한 것, 유효함)

`V_close − V_open − F` 를 전개하면 `F` 와 `C_open` 이 소거되고 `①+②−③` 이 남는다.
따라서 **L1 은 체결시각을 필요로 하지 않고**(①②③ 어디에도 없다),
**예수금 수준의 상수 오차에 완전히 불변**이며(ε 가 `C_open`/`C_close` 에서 소거),
**당일 외부흐름의 시각에도 불변**이다(`F` 소거).

내부 매매를 외부 cashflow 로 취급하지 않는 것도 여기서 보장된다 — `F` 는 오직 장부에서
오고, 원장 거래는 `H` 와 `C` 를 **동시에** 움직인다. 타입으로도 막는다(ledger 거래를
`PerformanceCashflow` 로 변환하는 함수를 만들지 않는다).

### 6.4 L3 의 범위 — 실측으로 양쪽을 조인다

유도 예수금:

```
derivedCash(a, D) = Σ[장부 입출금 ≤ D] − Σ[매수 ≤ D] + Σ[매도 ≤ D] − Σ[보고된 수수료·세금 ≤ D]
incomeLB (a, D)   = max(0, −min{ derivedCash(a, s) : 개시일 ≤ s ≤ D })
cash     (a, D)   = derivedCash(a, D) + incomeLB(a, D)
```

`incomeLB` 는 "**현금이 음수가 될 수 없다**"는 제약만으로 강제되는 **최소 누적 수입**이다.
추정 파라미터가 없고, 수입이 필요해진 순간보다 먼저 들어왔다고 가정하지 않는다.

따라서 임의 구간 P 에 대해

```
ΔincomeLB(P)  ≤  L3(P)  ≤  ΔincomeLB(P) + R(a)
R(a) = (cutoff 정렬된 독립 cash checkpoint) − cash(a, cutoff)       ← 남은 미설명 수입
```

**하한은 항상 계산된다.** 상한은 cutoff 정렬된 cash anchor 가 있을 때만 계산된다.

### 6.5 cash anchor 는 cutoff 정렬이어야 한다 — 실측 상태

| 계좌 | cutoff | derivedCash(cutoff) | incomeLB | 보수모델 cash | cutoff 이후 거래 | cutoff 이후 흐름 | anchor 사용 가능? |
|---|---|---|---|---|---|---|---|
| retirement | 2026-10-01 | −1,655,470 | 1,658,004 | **2,534** | **없음** | **없음** | **가능** |
| isa | 2026-06-26 | −185,230 | 187,723 | 2,493 | 있음(+2주) | 없음 | 불가 |
| pension | 2026-08-28 | −57,763 | 58,116 | 353 | 있음(대폭) | +500,000 | 불가 |
| irp | 2026-08-28 | −14,733 | 19,392 | 4,659 | 있음(대폭) | +250,000 | 불가 |

**`HistoryEntry.cashBalance` 는 네 계좌 모두 cutoff 날짜에 없다** — 가장 최신 entry
(isa/pension/irp 의 2026-10-02) 하나에만 있고 retirement 의 2026-10-01 entry 에는 아예
없다. 즉 **legacy history 는 cutoff 정렬 cash checkpoint 를 제공하지 못한다.**

유일하게 쓸 수 있는 anchor 는 retirement 다. cutoff 이후 거래도 흐름도 0건이고
`liveQuantities == 2026-10-01 snapshot` 이므로, 계좌의 현재 `cashBalance` 가 곧
cutoff 시점 cash 다.

```
retirement:  checkpoint 3,621  −  보수모델 2,534  =  R = 1,087원
             총 미관측 수입 = incomeLB 1,658,004 + R 1,087 = 1,659,091원
             (2025-03-25 ~ 2026-10-01, 19개월, 월평균 약 87,000원)
```

**보수모델이 실제 예수금과 1,087원 차이로 맞는다** — 약 75M 계좌에서 0.0015% 다.
결손의 톱니가 매달 0 을 때리기 때문에 `incomeLB` 증분이 거의 완전히 강제되고, 그래서
retirement 의 L3 경로가 ±1,087원 안으로 사실상 **확정된다.** 유도 모델 전체에 대한
강한 실증이다.

ISA·pension·IRP 는 **원장이 최신화될 때까지 R 을 계산하지 않는다**(현재 cash 에
미적재 매매의 현금효과와 cutoff 이후 입금이 섞여 있다). 그 계좌들은 `L3` 하한만
확정이고 상한은 "미정"으로 표시한다.

### 6.6 왜 0으로 둘 수 없는가 (예수금 유도의 필요성)

retirement 유도 경로 실측:

| 날짜 | 사건 | 금액 | EOD 예수금 |
|---|---|---|---|
| 2025-03-25 | 입금 | +60,923,460 | 60,923,460 |
| 2025-04-25 | 입금 | +580,423 | 61,503,883 |
| 2025-05-14 | 매수 | −2,097,430 | 59,406,453 |
| 2025-08-26 | 매수 | −10,738,600 | 43,169,495 |
| 2025-09-10 | 매수 | −41,529,790 | −593,795 ← 전액 투입 |

**2025-03-25 ~ 2025-09-10 의 5.5개월간 이 계좌 자산의 95% 이상이 현금이었다.**
`cashBalance: 0` 이면 2025년 6월 총자산이 61M 대신 약 2M 이 된다(30배 오차).
2025년 복원은 예수금 유도 없이 성립하지 않는다.

첫 결손 −593,795 가 전액투입일에 정확히 나타나는데, 60M 대기자금 5.5개월 이자
(60M × 5.5/12 × 약 2% ≈ 55만원)와 자릿수가 맞는다. 이후의 완만한 증가는 ETF 분배금
재투자로 설명된다. 둘 다 음수가 될 수 없으므로 L3 은 단조 비감소다 — §6.4 의 근거.

### 6.7 화면에 어떻게 보이는가

period 마다 세 줄로 나눈다. **합쳐서 하나의 수익률로 뭉개지 않는다.**

```
시장·매매 손익      +1,234,567원          (L1 — 가격·체결 기준 확정값)
외부 입출금           +688,074원          (L2 — 장부 기준 확정값)
미관측 현금수익      +87,000 ~ +88,087원  (L3 — 범위. 하한은 확정, 상한은 anchor 있을 때만)
───────────────────────────────────────
기간 수익률         +1.62% ~ +1.63%       (L3 범위가 그대로 전파된 범위)
```

- L3 상한이 없는 계좌(isa/pension/irp)는 `+87,000원 이상` 처럼 **하한만** 쓰고
  "원장 최신화 후 상한 확정" 배지를 붙인다.
- 수익률도 단일값이 아니라 **범위**로 쓴다. retirement 는 범위 폭이 거의 0 이라
  실질적으로 단일값으로 보인다.
- "추정"이라는 말은 L3 범위 **밖의 특정 값**을 쓸 때만 붙인다. 지금 설계에는 그런 값이
  없다 — 전부 하한·상한이다. 비례배분 같은 단일 추정값은 **만들지 않는다.**

---

## 7. 원장 커버리지와 계좌 개시일

| 계좌 | 개시일 (min(첫 cashflow, 첫 거래)) | 원장 cutoff | 거래 수 |
|---|---|---|---|
| retirement | **2025-03-25** (입금 60,923,460) | 2026-10-01 | 227 |
| pension | **2025-11-10** (입금 6,000,000) | 2026-08-28 | 86 |
| irp | **2025-12-29** (입금 3,000,000) | 2026-08-28 | 65 |
| isa | **2026-01-06** (입금 9,112,312) | 2026-06-26 (실질 2026-08-28) | 85 |

개시일 앞은 "데이터가 없다"가 아니라 **값이 0**이다. 이 구분이 §8 의 근거다.

cashflow 체크섬은 계좌별로 일치 확인됨: 72,691,626 / 10,500,000 / 63,663,392 / 5,000,000
(합 151,855,018).

---

## 8. 전체(4계좌 합산) scope 규칙 변경

```
현재:  네 계좌가 모두 평가된 날짜만 point      (requireAccountIds)
변경:  그 날짜에 **개시된** 계좌가 모두 평가된 날짜만 point
        · 개시 전 계좌  → 자산 0, 흐름 0 으로 합산 (사실이다)
        · 개시했는데 평가 실패(가격 결측) → 그 날짜는 point 를 만들지 않는다
        · 개시했는데 그 날짜가 그 계좌의 exact 구간 밖(cutoff 초과) → point 를 만들지 않는다
```

세 번째 줄이 rev2 추가분이다. "미개설 = 0" / "데이터 결측" / "원장 미적재"를 서로
다른 상태로 구분한다. 화면에서도 구분해 안내한다.

---

## 9. exact / partial 경계 — rev2 재정의

두 축이 서로 독립이다.

```
exact   : 그 구간 전체가 [계좌 개시일, 계좌 cutoff] 안에 있는가   (원장 완전성)
partial : 그 구간이 달력상 period 전체를 덮는가                  (기간 완결성)
```

### 계좌별 exact 구간 (§2 검증 통과분)

| 계좌 | exact 구간 | 오늘까지 연장 가능? |
|---|---|---|
| retirement | 2025-03-25 ~ **2026-10-01** | **가능** — cutoff 이후 거래·흐름 0건, `liveQuantities == 10-01 snapshot` |
| isa | 2026-01-06 ~ **2026-08-28** | 불가 — 08-28 ~ 10-02 사이 미적재 매수 +2주 |
| pension | 2025-11-10 ~ **2026-08-28** | 불가 — 미적재 대폭 재구성 + 09-28 입금 |
| irp | 2025-12-29 ~ **2026-08-28** | 불가 — 동일 |

### 전체 scope exact 구간

날짜 D 가 exact 이려면 D 까지 개시된 **모든** 계좌가 자기 exact 구간 안이어야 한다.

| 구간 | 개시된 계좌 | binding cutoff | exact? |
|---|---|---|---|
| 2025-03-25 ~ 2026-01-05 | retirement (+11/10 pension, +12/29 irp) | 2026-08-28 | **exact** |
| 2026-01-06 ~ 2026-08-28 | 네 계좌 전부 | 2026-08-28 (isa) | **exact** |
| 2026-08-29 ~ 오늘 | 네 계좌 전부 | — | **exact 아님** (세 계좌 미적재) |

→ **전체 scope exact = 2025-03-25 ~ 2026-08-28.**

### 연간 표시 판정

| scope | 2025 | 2026 |
|---|---|---|
| **전체** | **partial + exact** — 포트폴리오 개시가 2025-03-25. 라벨 `2025년 (3/25~12/30)`, 배지 `계좌 개시 이후` | **partial + exact 아님** — 1월 첫 거래일부터 가능하지만 2026-08-29 이후가 미적재. 원장 최신화 전에는 `2026년 (1/2~8/28) · 원장 최신화 필요` 로만 표시 |
| retirement | partial(3/25~) + exact | **full YTD + exact** — 1/2 시가 → 최신 거래일 종가. 요구사항대로 성립 |
| pension | partial(11/10~) + exact | partial(~8/28) + exact 아님 |
| irp | **표시 제외** — 2025 거래일 2~3일뿐 | partial(~8/28) + exact 아님 |
| isa | 구간 없음 | partial(~8/28) + exact 아님 |

**"2026 full YTD" 는 원장을 최신화하면 전체 scope 에서도 성립한다.** 지금 성립하는 것은
retirement 뿐이다. 이것이 §3.3 보충을 구현 전에 끝내야 하는 이유다.

플래그는 두 개로 분리한다:
`coverage: "exact" | "unledgered"` / `span: "full" | "account-inception" | "in-progress"`.

---

## 10. 필요한 파일 변경 목록

### 신규

| 파일 | 역할 |
|---|---|
| `src/lib/kaw/profit-analysis.ts` | **핵심 순수 모듈.** 일별 `H_open`/`H_close`, OHLC 평가, `segmentProfit(O,C)`, period 독립 집계(§5), L1/L2/L3 분해(§6) |
| `src/lib/kaw/profit-analysis.test.ts` | 위 테스트 |
| `src/lib/kaw/derived-cash.ts` | `derivedCash` / `incomeLB` / `R`(anchor 가능 여부 포함) |
| `src/lib/kaw/derived-cash.test.ts` | 위 테스트 |
| `src/lib/kaw/ledger-coverage.ts` | 계좌별 개시일·cutoff·exact 구간 판정(§9), 전체 scope 교집합 |
| `src/lib/kaw/ledger-coverage.test.ts` | 위 테스트 |
| `src/components/kaw/ProfitAnalysisSection.tsx` | Section D 대체 UI(§12) |
| `scripts/verify-ledger-cutoff.ts` | **Step 1 게이트의 영속 버전** — §2 비교를 재현 가능하게. 읽기 전용 |

> rev1 의 `scripts/verify-ledger-holdings.ts`(현재 보유수량 대조)는 **만들지 않는다.**
> 게이트 자체가 틀렸다(rev2 서두).

### 수정

| 파일 | 변경 |
|---|---|
| `src/lib/kaw/kis-server.ts` | `NaverPriceRow.openPrice`, `HistoryBarPoint`, `parseNaverSiseJson` m[2], 구간 조회 함수들이 bar 반환, `HISTORY_SERIES_MAX_TICKERS` 20 → 32 (R4) |
| `src/server.ts:229` | `/api/naver/history-series` 응답에 `open` 추가 (상위집합) |
| `src/lib/kaw/useHistoricalPrices.ts` | `open` 파싱, `PriceBarsByTicker` 추가. 기존 `toPriceSeriesByTicker` 는 그대로 남긴다 |
| `src/lib/kaw/ledger.ts` | `replayDailyHoldings()` 추가. 기존 함수 무수정 |
| `src/components/kaw/Dashboard.tsx` | Section D → `ProfitAnalysisSection`, 제목 "기간 성과" → **"수익 분석"**, `useLedger` 추가 |
| `data/verified-transactions.v1.json` → `v2` | §3.3 보충분 (별 작업. 원장 원본 463행은 불변, append only) |

### 손대지 않는 것

`kaw_transaction_ledger` 원본 / 모든 migration / 스냅샷 쓰기 경로 / legacy
`kaw_data.data->'history'` / `performance.ts` / `historical-performance.ts` /
`benchmark-series.ts` / `backtest.ts` / `snapshot.ts` / `AccountPage` 히스토리 탭 /
사용자 로컬 작업 스크립트(`verify-cashflow-principal.ts` 등).

---

## 11. 수정된 단계별 구현 계획

```
Step 0   사전 실측 (코드 변경 없음)
         · 모바일 JSON 폴백 응답에 openPrice 가 있는지
         · siseJson 이 2025-03-25~오늘(약 560일) 구간을 1회 요청으로 주는지
         · 17종목(원장 16 + 367380) 조회가 상한 안에서 되는지

Step 1   ✅ 완료 — cutoff-aligned 완전성 검증 (§2)
         전 계좌 통과(16 ticker-position 불일치 0). 1회용 스크립트는 삭제했고,
         scripts/verify-ledger-cutoff.ts 로 영속화하는 것은 Step 2 에 포함한다.

Step 2   원장 보충 — **구현의 실질적 blocker이며 사용자가 먼저 하기로 확정됨**
         → 준비 문서: **`docs/mirae-export-recollection.md`** (받을 파일·조회기간·
            필요 컬럼·dedupe 방식·A~J 실행 순서)
         미래에셋 export 재수집 → v2 데이터셋 → dry-run → 승인 → import(멱등)
         → 최신 checkpoint 기준 cutoff-aligned 재검증 0 불일치
         → 그때 isa/pension/irp 의 R 도 계산 가능해진다(§6.5)
         이 단계가 끝난 뒤에 Step 3 으로 간다 (UI 먼저 만들지 않는다).

Step 3   유도 예수금 모듈 + 테스트 (§6.4~6.6)
         실측 고정값: retirement 보수모델 2,534 / R 1,087 / 최대결손 −1,658,004 @2026-08-28

Step 4   ledger-coverage 모듈 (§9)
         개시일·cutoff·exact 구간·전체 교집합. 날짜가 전부 데이터에서 나오게 한다
         (하드코딩 금지 — Step 2 로 cutoff 가 움직인다)

Step 5   OHLC 가격 파이프라인 (§4)
         요청 구간을 계좌 개시일(min 2025-03-25)부터로 확장

Step 6   profit-analysis.ts (§5, §6) — 최대 단계
         segmentProfit(O,C) 를 period 별로 독립 호출. L1/L2/L3 분리.
         ①②③ 분해를 별도 함수로 구현해 V_close−V_open−F 와 교차검증

Step 7   스냅샷 대조 (검증 전용, UI 아님)
         유도 종가자산 vs 실제 daily snapshot. 차이가 L3 범위로 설명되는지

Step 8   UI (§12)

Step 9   아이폰 실기기 검증

Step 10  게이트: npx tsc --noEmit / npm run build / npm test → 배포 여부 질의
```

---

## 12. UI 설계

### 명칭 / 탭

섹션 제목 **"수익 분석"**. period(일간/월간/연간) · metric(수익률/수익금) · scope 탭 유지.

### 일간 — 가로 스크롤 차트

```
ResponsiveContainer 대신 고정폭 BarChart 를 overflow-x 컨테이너에 넣는다.

  <div ref={scrollRef} className="overflow-x-auto overscroll-x-contain
                                  [-webkit-overflow-scrolling:touch]">
    <BarChart width={barSlot * days.length + axisW} height={208} ...>

· barSlot = max(14, 컨테이너폭 / 21)   → 한 화면에 약 21 거래일
· Recharts 에 sticky axis 가 없다 → 좌측 고정 Y축 영역 + 우측 스크롤 영역 2분할
· 진입 시 useEffect 에서 scrollLeft = scrollWidth (최신이 오른쪽)
· touch-action: pan-x pan-y 명시, overscroll-x-contain 으로 사파리 back-swipe 충돌 방지
· iOS 는 hover 가 없다 → Tooltip 탭 + 선택 막대 정보를 차트 **아래 고정 영역**에 표시
· Y축 범위는 보이는 구간이 아니라 전체 구간으로 고정 (스크롤 때마다 축이 바뀌면 비교 불가)
```

### 월간 / 연간

데이터 수가 적다. 기존 `ResponsiveContainer` 유지. 연간은 막대 2개가 빈약하므로
**카드 2장**(2025 partial / 2026) 제안(§14-5).

### 한계를 드러내는 UI 요소

| 요소 | 조건 | 내용 |
|---|---|---|
| **원장 미적재** 배지 | 구간이 계좌 cutoff 를 넘김 | "2026-08-28 이후 실제 거래가 아직 원장에 없습니다 — 이 구간은 계산하지 않습니다" + 보충 안내 |
| L3 범위 | 항상 | 세 줄 분해(§6.7). 상한 없는 계좌는 "하한만" 명시 |
| 예수금 유도 | 복원 구간 | "과거 예수금은 원장+장부에서 유도한 하한입니다" + 계좌별 R |
| 거래일 추정 | 구간에 `broker-order-date` 아닌 거래 포함(61건) | "ISA·연금저축 일부 거래일은 결제일 기준 추정입니다" |
| 당일 흐름 과다 | 당일 외부흐름 > `V_open` × 1% | "이 날 입금이 커서 일간 수익률 해석에 주의" |
| 계좌 개시 partial | 연중 개시 | "2025년은 계좌 개시일(3/25)부터입니다" |
| 경계 갭 제외 | period 툴팁 | "전월 종가 → 당월 첫 시가 구간은 포함되지 않습니다" (§5.2) |
| 가격 결측 | 평가 실패 거래일 존재 | "가격을 확보하지 못한 N 거래일은 제외했습니다" |

---

## 13. 테스트 계획

### cutoff / coverage (`ledger-coverage.test.ts`)

1. 계좌별 cutoff 가 원장 최대 `eventDate` 로 계산됨 (하드코딩 아님)
2. 개시일 = min(첫 cashflow, 첫 거래) — retirement 2025-03-25 (첫 거래보다 이르다)
3. 전체 scope exact 교집합 = 2025-03-25 ~ 2026-08-28 (실측 고정값)
4. 미개설 계좌는 0 으로 합산, cutoff 초과 날짜는 point 를 만들지 않음(§8 세 상태 구분)
5. 원장에 거래를 하나 추가하면 cutoff 와 exact 구간이 **따라 움직임**

### 유도 예수금 (`derived-cash.test.ts`)

6. 실측 고정값 4계좌: 최대 결손 −1,658,004 / −187,723 / −58,116 / −19,392 과 발생일
7. retirement 2025-03-25 ~ 2025-09-10 경로 (60,923,460 → −593,795)
8. **retirement 보수모델 cash(2026-10-01) = 2,534, R = 1,087** (checkpoint 3,621)
9. `incomeLB` 성질: 모든 D 에서 `cash(D) >= 0` / 결손 없는 구간에서 `cash == derivedCash` / 단조 비감소
10. anchor 가능 여부 판정: retirement 만 `true`, 나머지 셋은 cutoff 이후 거래·흐름 때문에 `false`
11. `fee`/`tax` 가 null 인 거래가 0 으로 취급되지 않음
12. cashflow 1건을 지우면 그 이후 전 구간 예수금이 그만큼 내려감 (장부가 source of truth)

### 보유수량 재생

13. `H_open(D)` 는 `eventDate < D`, `H_close(D)` 는 `<= D`
14. 매매 없는 날 `H_open == H_close`
15. **cutoff 재생값 == §2 의 16개 실측 checkpoint 값** (고정값 테스트)
16. 입력 순서를 섞어도 결과 동일 (`ledger-order.test.ts` 와 같은 함정 방지)
17. `excluded` / `corrected` overlay 반영

### 수식 (`profit-analysis.test.ts`)

18. **교차검증**: `V_close − V_open − F` == `①+②−③` (실데이터 전 거래일)
19. **예수금 불변성**: 모든 예수금에 +ε → `L1` 불변
20. **흐름 시각 불변성**: 당일 흐름 timing 변경 → `L1` 불변
21. **내부 매매 ≠ 외부흐름**: 거래만 있고 cashflow 없는 날의 `netCashflow == 0`
22. 매도만 한 날: 종가보다 비싸게 팔면 ② 가 양수
23. **합성 금지**: monthly 결과가 daily 들의 합·곱과 **다름**을 명시적으로 고정
    (월 내부 오버나이트 갭이 monthly 에만 포함된다 — §5.2)
24. monthly/yearly 경계가 실제 거래일로 잡힘 (휴일·주말이 경계가 되지 않음)
25. 진행 중인 연·월은 최신 거래일 종가로 끝남
26. 유효일 규칙: 12월 마지막 거래일 after_close 입금 → 1월 구간 가중치 1
27. 주말 same_day 입금 → 다음 거래일 귀속
28. 모든 흐름이 정확히 한 구간에만 귀속 (전 구간 합 == 장부 총합)
29. daily 분모 == `V_open` (T=0 분기)
30. L3 범위: `ΔincomeLB(P) <= L3(P) <= ΔincomeLB(P) + R`, 전 구간 Σ L3 == 총 미관측 수입
31. anchor 없는 계좌는 L3 상한이 `null` 이고 UI 가 "하한만" 분기를 탐
32. fail closed: 한 종목 open 결측 → 그 날짜 제외, 그 날이 월 첫 거래일이면 **다음 유효
    거래일**이 경계가 됨 (그 달이 사라지지 않음)
33. 거래일 1일 이하 구간은 만들지 않음 (irp 2025)

### 가격 파싱 (`kis-server.test.ts`)

34. `parseNaverSiseJson` 이 시가를 `m[2]` 에서 읽음 (헤더 기준 고정 샘플)
35. open 또는 close 중 하나만 유효한 행은 버려짐
36. 음수 표기 행은 open 에서도 버려짐
37. 기존 종가 전용 테스트 전부 통과 (회귀)

### 통합·수동

38. `scripts/verify-ledger-cutoff.ts` — §2 재현 (읽기 전용)
39. Step 2 후: 2026-10-02 checkpoint 기준 cutoff-aligned 재검증 0 불일치
40. 스냅샷 대조 리포트 — 차이가 L3 범위로 설명되는지
41. 아이폰 Safari 실기기 — 스와이프 / 초기 위치 / 툴팁 탭 / 세로 스크롤 방해 없음
42. 게이트: `npx tsc --noEmit` / `npm run build` / `npm test` (676건 유지 + 신규)

---

## 14. 위험요소

| # | 위험 | 영향 | 대응 |
|---|---|---|---|
| R1 | ~~원장 시작부 불완전~~ | — | **해소됨.** §2 cutoff-aligned 검증 전 계좌 통과(16/16) |
| R1b | **cutoff 이후 미적재 거래** | 전체 scope 가 2026-08-28 에서 멈춘다. 2026 full YTD 불가 | §3.3 보충(Step 2). 그 전에는 `unledgered` 로 명시하고 **계산하지 않는다** |
| R2 | pension·irp 미적재 구간의 **거래일을 특정할 수 없다** | export 재수집으로도 날짜 근거가 `tplus2-inference` 가 될 수 있다 | 거래일 근거를 거래마다 보존하고 배지로 노출(기존 규칙). 모르면 넣지 않는다 |
| R3 | isa/pension/irp 의 L3 **상한 미정** | 수익률이 "하한 이상"으로만 표시 | Step 2 후 해소. 그때까지 UI 가 하한만 분기 |
| R4 | `HISTORY_SERIES_MAX_TICKERS = 20`, **필요 17종목**(원장 16 + 367380) | 3종목 여유. 초과 시 조회 통째 거절 | 상한 32 로 올리고 초과 시 배치 분할(fail closed 유지) |
| R5 | 모바일 JSON 폴백에 `openPrice` 가 없을 수 있다 | 폴백 시 fail closed | Step 0 실측. 없으면 siseJson 전용, 전일 종가 대체는 하지 않는다 |
| R6 | siseJson 이 560일 구간을 한 번에 안 줄 수 있다 | 2025년 가격 결측 | Step 0 실측. 안 되면 연 단위 분할(종목당 2회) |
| R7 | **합성 금지 위반 위험** — 일간을 접어 월간을 만드는 구현 | 월 내부 오버나이트 갭이 사라져 월간이 틀린다 | §5.2. `segmentProfit(O,C)` 를 period 별로 독립 호출, 테스트 23 으로 고정 |
| R8 | ETF명 문자열 일치로 ticker 를 찾는다(`resolveEtfTicker` 는 `defaultEtf` 완전일치) | 이름이 바뀌면 보유수량이 조용히 0 이 된다. 실제로 `_meta` 는 "TIGER KRX **공백** 금현물", 데이터셋 tickerMap 은 공백 없음 | **수익 분석은 원장의 `ticker` 를 직접 쓴다**(이름 경유 없음). 이름 매핑은 legacy checkpoint 대조에만 쓰고, 미해결 ticker 를 **조용히 버리지 않고 에러로 보고**한다 (진단 중 실제로 이 함정에 빠졌다) |
| R9 | 모바일 가로 스크롤이 세로 스크롤·back swipe 와 충돌 | 아이폰에서 안 움직임 | `touch-action` + `overscroll-x-contain`, 실기기 검증 |
| R10 | retirement 2025-09-10 이전 pre-strategy 거래 포함 여부 | 2025 수익률의 의미 | **실제 계좌 수익이므로 포함.** 전략 비교(backtest)와 다른 질문 (§15-6) |
| R11 | 가격 요청 구간 6개월 → 19개월 | 첫 로딩 지연 | 종목당 1요청(17회) 유지, `staleTime 12h` |
| R12 | legacy 경로와 신규 경로가 다른 숫자를 보여준다 | 혼란 | Step 7 대조로 차이를 먼저 설명. legacy 모듈은 지우지 않는다 |
| R13 | 데이터셋 v2 갱신 시 `validation` 체크섬·테스트 고정값이 함께 바뀜 | 테스트 대량 실패 | Step 2 에서 체크섬·고정값을 한 커밋에 같이 갱신 |

---

## 15. 구현 전 확인받고 싶은 결정 사항

1. **§6 3층 분리** — L1(확정) / L2(확정) / L3(범위)로 나눠 보여주고, 수익률도 단일값이
   아니라 **범위**로 표시. 비례배분 같은 단일 추정값은 만들지 않는다.
2. **§5.2 경계 갭** — period 툴팁에 "제외된 경계 갭"을 한 줄 넣을까.
3. **daily 분모** = `V_open`, 당일 외부흐름 가중치 0 (오차 상한 0.011%p).
4. **irp 2025** — 거래일 2~3일뿐인 구간은 연간에서 제외.
5. **연간 UI** — 막대 2개 차트 대신 카드 2장.
6. **R10** — retirement 의 2025-09-10 이전 pre-strategy 거래를 수익 분석에 포함.
7. **§13-1 승인분 반영** — ledger+OHLC 단일 엔진을 source of truth 로, daily snapshot 은
   검증/checkpoint 전용. **단 exact 구간 안에서만** 그 엔진을 돌린다(§9).
8. **Step 2 의 순서** — 원장 보충(미래에셋 export 재수집)을 구현 **전**에 할지, 아니면
   UI 를 먼저 만들고 전체 scope 를 2026-08-28 까지만 보여주다가 나중에 보충할지.
   보충은 사용자가 직접 export 를 받아야 하므로 **사용자 결정 사항**이다.
