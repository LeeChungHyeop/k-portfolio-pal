# 거래 원장(Transaction Ledger) — 인수인계

새 세션에서 이 문서만 읽고 바로 이어받을 수 있도록 쓴 상태 기록이다.

**지금 production DB 에는 아무것도 적용/적재되지 않았다.**

migration 004 최종 리뷰는 **끝났다.** 리뷰에서 나온 차단 이슈(Supabase 기본 권한 때문에
`service_role` 이 원장·audit 에 UPDATE/DELETE/TRUNCATE 를 그대로 갖는 문제)와 CHECK 2종을
004 에 반영했다. 다음 작업은 §9 의 **B(사용자가 SQL Editor 에서 004 실행)** 부터다.

- 브랜치: `feat/historical-performance-reconstruction`
- 저장소 루트: `k-allweather/app/` (git 명령은 반드시 여기서)
- 이 문서를 만든 커밋: `e8bbc2c`

---

## 1. 완료된 Phase

| Phase | 내용 | 커밋 |
|---|---|---|
| 1 | migration 004 설계 (신규 테이블 6종 + 롤백 + 검증 쿼리) | `34a9cb6` |
| 2 | verified dataset 반입 / 순수 도메인 모델 / 적재 전 게이트 | `34a9cb6` |
| 3 | fingerprint · provenance / dry-run import / Worker API / 읽기 훅 | `0c10eaf` |
| 4 | 거래 이력 UI (목록·필터·상세·편집·정정·audit·반응형) | `ccea87b` |
| — | 이 인수인계 문서 | `e8bbc2c` |

Phase 1 과 2 는 한 커밋에 함께 들어갔다(스키마와 그 스키마를 쓰는 도메인 모델을
따로 커밋하면 중간 상태가 컴파일되지 않는다).

### 이 작업 직전의 선행 커밋 (참고)

| 커밋 | 내용 |
|---|---|
| `5d9e6ff` | 일별 스냅샷 이전 과거 구간 복원 (보유수량 × 당시 종가) |
| `66385de` | 실제 증권사 자료로 확정한 과거 cashflow 를 canonical seed 로 고정 |

`66385de` 의 cashflow 체크섬(151,855,018)과 이 원장의 체크섬이 일치하는 것이
테스트로 묶여 있다.

---

## 2. 현재 production 상태

- **migration 004 미적용.** `kaw_transaction_ledger` 등 신규 테이블이 production 에 없다.
- **verified transaction 463건 미적재.**
- legacy `kaw_data.data -> 'history'` 와 그것을 읽는 모듈은 **전부 그대로**다.
  이번 작업에서 한 줄도 바꾸지 않았다:
  `snapshot.ts`, `kaw_portfolio_live_view`, `historical-performance.ts`,
  `benchmark-series.ts`, `backtest.ts`, `AccountPage` 히스토리 탭, `Dashboard`,
  migrations 001–003.
- 신규 거래 이력 화면은 `/api/ledger/*` 만 쓴다. migration 미적용 상태에서는 그
  페이지 안에서만 "거래 원장 기능이 아직 활성화되지 않았습니다" 안내가 뜨고
  나머지 화면은 평소대로 동작한다.

### 손대지 않는 로컬 작업물

작업 트리에 사용자의 기존 작업이 남아 있다. **수정·stage·삭제하지 않는다.**

```
 M scripts/verify-cashflow-principal.ts
?? .claude/
?? scripts/fix-2026-09-25-cashflows.ts
?? scripts/verify-carry-forward.ts
?? scripts/verify-snapshots-table.mjs
```

---

## 3. 검증된 데이터 기준

`data/verified-transactions.v1.json` (미래에셋 공식 매매내역/거래내역 정규화본).
아래 값은 `npm run ledger:dry-run` 과 테스트가 매번 확인한다.

| 항목 | 값 |
|---|---|
| transaction | **463** |
| event (기본 grouping) | **65** |
| retirement | 거래 227 / 이벤트 27 |
| pension | 거래 86 / 이벤트 13 |
| ISA | 거래 85 / 이벤트 16 |
| IRP | 거래 65 / 이벤트 9 |
| duplicate fingerprint | **0** |
| negative holding | **0** |
| postQuantity mismatch | **0** (대조 가능 171건) |
| finalHoldings | **완전 일치** |
| cashflow checksum | **151,855,018** |

기간은 2025-05-14 ~ 2026-10-01. 거래일 근거 분포는
`broker-order-date` 292 / `cross-account-settlement-match` 110 /
`tplus2-weekday-inference` 61 이다.

---

## 4. 바꾸면 안 되는 데이터 규칙

1. **실제 체결내역이 historical transaction 의 source of truth 다.**
2. **과거 목표비중으로 거래를 추론하지 않는다.** 스키마에도 도메인 모델에도
   목표비중 필드가 없다. "당시 목표가 40%였으므로 이렇게 리밸런싱했을 것"이라는
   계산 경로를 만들지 않는다.
3. **`kaw_transaction_ledger` 는 immutable.** service_role 에서 UPDATE/DELETE/TRUNCATE 를
   **회수**한다(단순히 grant 하지 않는 것으로는 부족하다 — 아래 "권한 모델" 참고).
   적재는 `scripts/ledger-import.ts` 로만 한다.
4. **거래 정정은 overlay** (`kaw_transaction_correction`). 유효값 = `corrected_* ?? 원본`.
   제외도 삭제가 아니라 `excluded` 플래그다.
5. **소속 이벤트 변경도 overlay** (`kaw_transaction_event_override`). 병합/분리/이동이
   전부 이것 하나로 표현되고, 행을 지우면 기본 grouping 으로 되돌아간다.
6. **audit 는 append-only.** service_role 에서 UPDATE/DELETE/TRUNCATE 를 회수한다.
7. **파생값을 DB 에 중복 저장하지 않는다.** 거래건수·매수/매도 금액·전후 보유수량은
   소속 거래가 바뀌면 즉시 달라지므로 `ledger.ts resolveEvents` 가 계산한다.
8. **fingerprint version 은 v1.** 문자열 맨 앞에도 들어간다(`v1|...`).
   KIS API 등 다른 source 는 **별도 버전(v2 …)으로 확장**한다 — KIS 는 주문번호/
   체결번호를 주므로 내용 조합 대신 그 번호로 신원을 잡는 편이 정확하다.
   규칙을 바꿀 때는 ① 새 버전 함수 추가 + `FINGERPRINT_VERSION` 상향,
   ② 기존 행 재계산 마이그레이션, ③ 한 profile 안에 두 버전을 섞지 않기.

### fingerprint 가 내용 기반인 이유 (실측)

`source_row` 를 신원으로 쓸 수 없다. 미래에셋 export 는 둘 다 **최신순**이라
(DC 매매내역 `row 4` = 2026-10-01, `row 456` = 2025-05-14) 거래가 하나 추가되면
기존 행 번호가 전부 밀린다. 재export 하면 같은 체결이 다른 번호를 받는다.
사용자가 보완한 10행은 `source_row` 가 아예 없다.

그래서 v1 규칙은
`v1 | source | 계좌 | 종목 | 매매구분 | 수량 | 단가 | 금액 | 거래일 | 결제일 | 동일건순번`
이다. **동일건순번**이 필요한 이유도 실측이다 — IRP 에 내용이 완전히 같은 분할체결이
있다(2026-03-25 `0072R0` 1주 2건, 2026-08-28 `438080` 1주 3건). 순번이 없으면
5건이 2건으로 뭉개진다.

---

## 5. source 별 일중(日中) 거래 순서 규칙 — **절대 바꾸지 말 것**

`src/lib/kaw/ledger.ts` 의 `INTRA_DAY_ROW_ORDER`.

| source | 방향 | 근거 |
|---|---|---|
| `miraeasset_transaction_history` (ISA·연금) | `sourceRow` **내림차순** | 거래후잔고 171건 전부 일치. 오름차순이면 51건 불일치 |
| `miraeasset_retirement_web` (퇴직연금·IRP) | `sourceRow` **오름차순** | 거래후잔고가 없어 "음수 보유수량 불가"로 판별 |

증권사는 체결 시각을 주지 않아 원본 엑셀 행 번호가 유일한 단서인데, **두 export 의
하루 안 방향이 반대**다. 네 조합을 전수 비교해 음수 0건 + 불일치 0/171 인 조합만
채택했다.

**이 규칙을 바꾸면 `postQuantity` 대조와 holdings replay 가 깨진다.** 구체적으로,
retirement 를 내림차순으로 돌리면 `484790` 이 2026-05-26 에 **-723주**가 된다
(그 날 매수 689+34 와 매도 1381 의 순서가 뒤집히기 때문). 오름차순이면
658 → 692 → 1381 → 0 으로 이어진다.

새 source 를 추가할 때는 반드시 같은 방식으로 방향을 실측한다. 기본값 `"asc"` 는
검증된 값이 아니라 "파일을 위에서 아래로 읽는 자연스러운 순서"일 뿐이다.
`verifyDataset` 이 두 검사(거래후잔고 대조 / 음수 보유수량)를 모두 한다.

---

## 6. 신규 DB 구조 (migration 004 — 미적용)

| 테이블 | 역할 |
|---|---|
| `kaw_ledger_import_batch` | 적재 묶음. 출처(`source_kind`/`source_label`/`checksum`), inserted/skipped 건수, 적재 전 게이트 결과 전문, actor. Excel·KIS API·수동 보정이 같은 원장에 들어오므로 묶음 단위로 추적한다 |
| `kaw_transaction_ledger` | **개별 실제 체결 (원본).** immutable. `source_fingerprint` 에 `UNIQUE (family_code, profile, source_fingerprint)` 가 걸려 중복 적재를 DB 레벨에서 막는다 |
| `kaw_transaction_correction` | 사용자 거래정보 정정 overlay. 원본을 덮지 않는다. `excluded` 는 계산 제외 플래그(삭제 아님) |
| `kaw_transaction_event_override` | 소속 이벤트 재지정. 병합·분리·이동이 전부 이것으로 표현된다. 행을 지우면 기본 grouping 복귀 |
| `kaw_rebalance_event` | 사용자 의미정보만 — 메모·태그·숨김·유형·`strategy_included`·`is_user_created`. 기본 grouping 이벤트는 행이 없어도 된다 |
| `kaw_ledger_audit` | append-only 변경 이력. UI 분류 수정(`event_merge`/`event_split`/`tx_move`/`memo_change`/`tag_change`/`event_hide`/`event_restore`)과 거래정보 정정(`tx_correct`/`tx_uncorrect`)을 `action` 으로 구분 |

### 권한 모델 (001~003 과 다른 부분)

RLS on + 정책 0개, 브라우저는 Worker 의 `/api/*` 만 쓴다 — 여기까지는 001/002/003 과 같다.
**다른 것은 GRANT 를 거는 방식이다.**

Supabase 는 `public` 스키마에 기본 권한이 걸려 있어서
(`alter default privileges in schema public grant all on tables to postgres, anon,
authenticated, service_role`) **새 테이블은 생성되는 순간 `service_role` 에도 `ALL` 이
붙는다.** GRANT 는 가산이라 "필요한 것만 grant" 는 빼기가 되지 않는다. 001~003 처럼
`anon`/`authenticated` 만 회수하면 `service_role` 은 UPDATE/DELETE/TRUNCATE 를 그대로
갖고, 그러면 **원장 immutable 도 audit append-only 도 전혀 성립하지 않는다.**

그래서 004 는 신규 6개 테이블에 대해 **PUBLIC / anon / authenticated / service_role 의
권한을 먼저 전부 회수한 뒤 `service_role` 에 필요한 것만 다시 부여한다.**

| 테이블 | service_role | 금지 |
|---|---|---|
| `kaw_transaction_ledger` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_ledger_audit` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_ledger_import_batch` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_transaction_correction` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |
| `kaw_transaction_event_override` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |
| `kaw_rebalance_event` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |

PUBLIC / `anon` / `authenticated` 에는 아무 권한도 주지 않는다.
**owner(`postgres`)는 건드리지 않는다** — 여기서 말하는 immutable / append-only 는
"Worker 가 쓰는 `service_role` 키로는 원장과 audit 을 바꾸거나 지울 수 없다"는 뜻이고,
SQL Editor 의 소유자 권한까지 막으려는 것이 아니다(소유자는 어차피 막을 수 없다).

`kaw_ledger_audit.id` 는 identity 다. **identity 시퀀스에는 별도 GRANT 를 주지 않는다** —
identity 컬럼의 시퀀스는 컬럼에 internal dependency 로 묶여 있어 `nextval` 이 권한 검사를
거치지 않는다(`serial` 과 다르다). 004 의 smoke test (j) 가 시퀀스 권한을 전부 회수한
트랜잭션 안에서 실제 INSERT 로 이것을 확인하고, 실패할 때만 `usage` 를 추가한다.

### DB 레벨 CHECK 2종

- `kaw_transaction_ledger_fp_version_chk` — `source_fingerprint` 가 자기
  `fingerprint_version` 과 맞는 prefix(`v<n>|…`)를 갖도록 강제한다. 둘이 어긋나면
  "한 profile 에 두 버전을 섞지 않는다"는 규칙을 검증 쿼리 (f-2) 로도 못 잡는다.
- `kaw_transaction_correction_nonempty_chk` — 정정 6필드가 전부 null 이고 `excluded` 도
  false 인 행을 막는다. 유효값 규칙이 `corrected_* ?? 원본` 이라 **"null 로 정정"을
  표현할 방법이 애초에 없으므로** 그런 행은 아무 값도 안 바꾸면서 그 거래를 "사용자 정정
  데이터"로 잘못 배지하기만 한다. 원본 복귀는 행 삭제(`clear: true`)다.
  `handleLedgerCorrectPost` 가 같은 조건을 먼저 검사해 400 으로 돌려준다.

기본 grouping: **동일 계좌 + 동일 실효 거래일** → `rev:<account>:<date>` (계산 가능).

롤백: `migrations/004_transaction_ledger_rollback.sql` (백업 쿼리를 먼저 실행하도록
안내가 들어 있고, 003 이 쓰는 `kaw_touch_updated_at()` 는 지우지 않는다).

---

## 7. 신규 거래 이력 UI

Sidebar 전역 메뉴 **"거래 이력"** (`Page = "ledger"`). 기본 단위는 개별 체결이 아니라
Rebalance Event. **계좌 화면의 legacy 히스토리 탭은 그대로 두었다.**

- **목록** — 거래일 / 계좌 / 유형 / 매수·매도 종목 수 / 매수·매도 금액 / 주요 종목 /
  메모 / 태그 / 숨김·수정·정정·날짜추정 배지
- **검색·필터** — 기간, 계좌, 매수/매도, 유형, 태그, 검색(종목명·종목코드·메모·태그),
  숨김 포함. 겹쳐 쓸 수 있고 선택지는 실제 데이터에 있는 값만
- **상세** — 체결마다 **이전 보유수량 → 매매수량 → 이후 보유수량**, 그리고 종목명·
  코드·매매구분·체결수량·단가·거래금액·수수료·세금·거래일·결제일·source·거래후잔고.
  **증권사가 주지 않은 값은 `—` 이고 0 으로 채우지 않는다.** 거래일에 확정/추정 라벨
- **편집** — 메모 / 태그 / 유형 / 숨김·복원 / 병합 / 분리 / 이동 / 자동 분류로 되돌리기.
  사용자는 DB 구조를 몰라도 된다 (목록에서 여러 이벤트 체크 → 병합, 상세에서 거래
  체크 → 분리·이동)
- **정정** — 원본과 나란히 보여주고 "원본 복귀" 가능. 수량·단가만 고치면 금액 재계산
- **audit** — 상세의 "변경 이력"
- **상태 구분** — loading / error / unavailable(migration 미적용) / empty(적재 전) /
  결과 없음(필터)
- **반응형** — 데스크톱 표, 모바일(375px) 카드. 가로 스크롤 없음

관련 파일:
`src/components/kaw/LedgerPage.tsx`, `LedgerEventDetail.tsx`,
`src/lib/kaw/ledger.ts`(도메인), `ledger-ui.ts`(표시 규칙),
`useLedger.ts`(훅), `ledger-server.ts`(Worker API),
`verified-transactions.ts`(파서·게이트), `scripts/ledger-import.ts`.

### API

| 엔드포인트 | 역할 |
|---|---|
| `GET /api/ledger` | 원장 + overlay 전체 (4테이블 병렬) |
| `GET /api/ledger/audit` | 변경 이력 (`?targetId=`) |
| `POST /api/ledger/event` | 메모·태그·숨김·유형 |
| `POST /api/ledger/assign` | 병합·분리·이동 (`eventId: null` → 기본 복귀) |
| `POST /api/ledger/correct` | 정정 (`clear: true` → 원본 복귀) |

전부 기존 `/api/data`·`/api/snapshots` 와 같은 세션 토큰 인증(`requireSession`).
원장 테이블에는 `select` 만 있다.

---

## 8. 의도적으로 남긴 항목

production import 의 blocker 가 아니므로 **지금 구현하지 않는다.**

1. **Transaction 단위 audit UI** — API(`?targetId=`)는 있고 이벤트 단위 조회만 UI 에
   붙어 있다. 거래 정정 이력도 그 이벤트 audit 에 함께 보인다.
2. **과거 시점 평가금액 UI 연결** — `ledger.ts valuateHoldings()` 는 구현·테스트가
   끝났지만 화면에 붙이지 않았다(과거 종가 조회 연결이 필요). 보유수량 변화는 표시된다.
3. **실제 production write 동작 검증** — dev 서버에 Cloudflare `env` 가 전달되지 않아
   (`handleAuthFamily` 에서 `SUPABASE_URL` undefined — 기존 dev 한계, 이번 작업과 무관)
   로그인·API 가 동작하지 않는다. UI 는 임시 미리보기 라우트 + fixture 로 검증한 뒤
   그 라우트를 삭제했다. **저장·병합·정정의 실제 동작은 migration 적용 후 육안 검증이
   필요하다.**

---

## 9. 다음 세션에서 진행할 정확한 순서

```
A. migration 004 최종 리뷰  ✅ 완료
   차단 이슈 1건을 찾아 004 에 반영했다 — Supabase 가 public 스키마 기본 권한으로 새
   테이블에 ALL 을 붙이기 때문에, "필요한 것만 grant" 로는 service_role 의 UPDATE/DELETE/
   TRUNCATE 가 그대로 남아 원장 immutable 과 audit append-only 가 성립하지 않았다.
   권한을 "네 주체 전부 회수 → service_role 에 필요한 것만 재부여"로 바꾸고,
   CHECK 2종(fp_version / correction_nonempty)과 실효 권한 검증·smoke test 를 추가했다.
   재발 방지로 src/lib/kaw/ledger-migration.test.ts 가 004 의 권한 패턴을 고정한다.

B. 사용자에게 적용 안내
   Supabase 대시보드 → SQL Editor 에 004 전체를 붙여넣고 Run.
   (001 → 002 → 003 → 004 순서. idempotent. 기존 객체는 건드리지 않는다.)
   **이 단계는 사용자가 직접 한다.**

C. migration 적용 후 실제 DB 대상 dry-run
   npm run ledger:dry-run -- --family=<CODE> --profile=<PROFILE>
   .dev.vars 의 접속정보로 **읽기만** 해서 기존 행 수와 중복 여부를 같이 본다.

D. DB schema / constraint / 권한 검증
   004 파일 하단 주석의 검증 쿼리를 실행한다.
   적용 직후: (a) 테이블 6개 / (a-2) 컬럼 수 80 / (a-3) RLS on·정책 0 /
             (a-4) CHECK 2종 / (b) 선언된 GRANT / (b-2) 실효 권한 /
             (b-3) immutable 3종 0행 / (b-4) anon·authenticated 0행 /
             (j) service_role INSERT smoke test (rollback) / (k) 실패해야 정상인 probe
   import 후:  (c)~(h) 계좌별 건수 / 보유수량 재생 / 이벤트 수 / fingerprint 중복 0 /
             fingerprint_version 단일 / 배치 이력 / 날짜 근거 분포.

   **(b-3) 이 0행이 아니면 import 를 진행하지 않는다.**

E. reconciliation 재실행
   npm test (ledger / verified-transactions 테스트 포함)
   dry-run 리포트의 finalHoldings·checksum 재확인.

F. 모든 gate 통과 확인
   npx tsc --noEmit / npm run build / npm test

G. 사용자 승인 후 463건 production import
   npm run ledger:import -- --apply --family=<CODE> --profile=<PROFILE>
   **승인 없이 실행하지 않는다.**

H. import 후 재검증
   transaction 463 / event 65 / 계좌별 건수 / holdings 재생 결과 /
   kaw_ledger_import_batch 의 inserted·skipped.
   한 번 더 import 해서 inserted 0 / skipped 463 인지(멱등성) 확인.

I. 신규 거래 이력 UI 에서 실제 데이터 육안 검증
   목록·필터·상세·메모/태그 저장·병합/분리/이동·정정·원본 복귀·audit 가
   실제로 저장되는지 확인(Phase 4 에서 못 한 write 경로 검증).

J. 문제가 없으면 legacy consumer 전환 계획 수립
   snapshot.ts / kaw_portfolio_live_view / historical-performance.ts /
   benchmark-series.ts / backtest.ts 의 보유수량 소스를 원장으로 옮기는 계획.
   **각 소비처마다 전환 전후 수치를 대조한 뒤 하나씩** 옮긴다.
   원장 재생 최종 보유수량 vs 현재 계좌 보유수량 대조가 그 전환의 게이트다.
```

**production DB 에 지금 아무 작업도 실행하지 않는다.**

---

## 10. 명령어 요약

```bash
cd k-allweather/app

npm run dev                 # http://localhost:8080 (API 는 dev 에서 동작하지 않는다)
npm test                    # vitest — 547건
npx tsc --noEmit
npm run build

npm run ledger:dry-run      # 검증만. DB 에 쓰지 않는다 (기본)
npm run ledger:dry-run -- --family=<CODE> --profile=<PROFILE>   # DB 읽기 포함
npm run ledger:import -- --apply --family=<CODE> --profile=<PROFILE>  # 승인 후에만

npx vitest run src/lib/kaw/ledger-migration.test.ts   # 004 권한 모델 고정 테스트
```

게이트 현황: `tsc` 통과 / `build` 통과 / `test` **547건 통과 (15 파일)**.
