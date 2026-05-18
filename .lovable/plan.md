# K-All-Weather Rebalancing & Portfolio Tracker

엑셀(포트폴리오.xlsx)과 책의 표39(위험감내도별 K-올웨더 포트폴리오)를 기반으로, 계좌별 리밸런싱과 월간 수익률을 관리하는 단일 페이지 대시보드를 만듭니다. 서버 없이 브라우저 localStorage에만 저장됩니다.

## 데이터 모델 (localStorage)

```text
kaw.v1 = {
  profile: "성장형" | "중립형" | "안정형" | "MP" | "custom",
  allocations: {
    [profile]: { 미국:24, 한국:8, 중국:8, 인도:8, 금:19,
                 미국채10:7, 미국채30:7, 국고채30:14, 현금:5 }   // % (수정 가능)
  },
  accounts: {
    [accountId]: {
      name: "퇴직연금" | "ISA" | "연금저축" | "IRP" | "기타",
      baseAmount: number,           // 기준잔액
      holdings: [
        { assetKey:"미국", etfName:"KODEX 미국S&P500TR", value:0 }
      ],
      deposit: number,              // 이번 달 불입액
      history: [
        { date:"2026-04-27", totalValue, deposit, returnPct, snapshot:{...} }
      ]
    }
  }
}
```

기본 비중은 책의 표39(MP/성장/중립/안정)를 프리셋으로 내장하고, 사용자가 % 칸을 직접 수정해 저장할 수 있습니다 (사용자 요구의 "성장형 60/25/10/5"도 커스텀 프리셋으로 추가).

## 화면 구성 (단일 라우트 `/`)

1. **상단 헤더** — 앱 제목 + 현재 선택된 투자성향 배지, 데이터 내보내기/가져오기 (JSON) 버튼.
2. **투자 성향 선택 패널** — 성장형/중립형/안정형/MP 토글. 선택 시 우측에 Recharts PieChart로 해당 비중을 즉시 미리보기. 각 자산 행의 % 입력은 인라인 수정 가능, "기본값으로 복원" 버튼 제공.
3. **계좌 탭** — `[퇴직연금][ISA][연금저축][IRP][기타]` 탭. 각 탭은 독립 상태:
   - 기준잔액 입력 (대형 숫자 입력)
   - 월 불입액 입력
   - 종목 테이블: `자산군 | ETF명(편집) | 비중% | 기준금액(자동) | 평가금액(입력) | 추가매수(±)` — 엑셀의 행 구조와 동일
   - 합계 행: 자산합계 / 추가매수 합계 / 예수금
   - 자산군 비중 도넛(목표 vs 실제 비교)
4. **리밸런싱 결과 카드** — 매수해야 할 금액(+), 매도/축소(–)를 자산군별로 색으로 구분해 명확히 표시.
5. **히스토리 섹션** — 계좌별 월별 스냅샷 테이블 + Recharts LineChart (총자산/수익률). "현재 상태를 스냅샷으로 저장" 버튼이 오늘 날짜로 저장. 과거 데이터는 날짜+총자산+불입액을 수동 입력해서 추가 가능. 수익률 = `((현재총자산 - 이번달불입액) - 지난달총자산) / 지난달총자산 * 100`.
6. **데이터 관리** — Reset, JSON Export/Import (백업용).

## 리밸런싱 로직

- `자산군 기준금액 = 계좌.baseAmount * 비중%`
- `추가매수 = 기준금액 - 평가금액` (양수=매수, 음수=매도)
- 예수금 = `baseAmount - Σ평가금액`
- 모두 useMemo로 파생 계산, 입력 시 즉시 반영.

## 기본 시드 데이터

첫 로드 시 엑셀의 자산군/ETF 라인업(미국 S&P500, KOSEF 200TR, 차이나CSI300, 인도Nifty50, KRX 금현물, 미국채10년, 미국채30년(H), 국고채30년 Enhanced, KOFR)으로 5개 계좌를 초기화. 평가금액은 0, baseAmount도 0 (사용자가 입력).

## 기술적 디테일

- TanStack Start 단일 라우트 `src/routes/index.tsx` 교체 + 분할 컴포넌트는 `src/components/kaw/` 아래.
- 상태: 단일 `usePortfolioStore` 훅이 localStorage와 동기화 (직접 구현, zustand 미사용).
- shadcn `Tabs`, `Card`, `Input`, `Button`, `Table` 활용.
- Recharts: PieChart (목표 비중), LineChart (히스토리).
- 디자인 토큰은 `src/styles.css`의 oklch 시맨틱 컬러 사용. 금융 대시보드답게 차분한 다크/뉴트럴 + 매수(+)는 emerald, 매도(–)는 rose 액센트.
- 한국어 UI, 통화 포맷 `Intl.NumberFormat('ko-KR')`.

## 빌드 순서

1. localStorage 스토어 훅 + 시드/프리셋 상수
2. 성향 선택 + 비중 편집 패널 (PieChart 포함)
3. 계좌 탭 + 종목 테이블 + 리밸런싱 계산
4. 히스토리 섹션 (스냅샷 저장 + LineChart + 수동 입력)
5. Export/Import + 스타일링 마감
