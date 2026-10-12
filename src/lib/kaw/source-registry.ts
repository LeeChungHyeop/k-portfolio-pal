// ─────────────────────────────────────────────────────────────────────────────
// 결제 관측(settlement observation) source 레지스트리 — 순수 모듈
//
// **관측 사실은 DB 에, 우리의 해석은 여기에.** 이 분리가 이 파일의 존재 이유다.
//
// `kaw_settlement_observation` 행에는 `source_type` 과 실측값(holdings / cash /
// account_total …)만 들어간다. "그 source 를 얼마나 믿을 것인가"(증거 등급), "0주 종목을
// 생략하는가", "state_as_of 가 무엇을 뜻하는가" 같은 **판단**은 전부 여기서 파생한다.
//
// 왜 컬럼으로 저장하지 않는가: 등급·capability 는 우리가 더 알게 되면 바뀌는 값이고,
// 관측 테이블은 immutable(service_role 에 UPDATE 없음)이라 **한 번 박으면 교정 경로가
// 없다.** 반대로 source_type 은 관측 사실이라 immutable 에 적합하다.
// (004 의 "파생값을 저장하지 않는다" 와 같은 사고. 형식은 constants.ts 의
//  VERIFIED_RETIREMENT_RISK_CLASS 를 따른다 — 무엇을 언제 어떤 근거로 확정했는지
//  코드만 보고 추적할 수 있어야 한다.)
//
// ── 불변식 ──────────────────────────────────────────────────────────────────
//
//   **이 레지스트리에 A-exec(실제 체결 증거) 등급은 존재할 수 없다.**
//   체결 증거는 kaw_transaction_ledger 에만 들어간다. 계좌 상태 관측(P/H/B)을
//   체결 증거로 승격시키는 경로를 만들지 않는다
//   (docs/mirae-export-recollection.md §9-2 / §9-6).
//
// ── fail closed ─────────────────────────────────────────────────────────────
//
//   미지 source_type → 등급 unknown + autoReconcile false + capability 전부 보수값.
//   모르는 source 를 "아마 괜찮을 것"으로 취급하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 증거 등급. docs/mirae-export-recollection.md §9-2 의 분류를 그대로 쓴다.
 *
 *   P  broker-confirmed current position/account evidence — 증권사가 확인한 **현재 상태**
 *   H  broker historical-balance (transition) evidence    — 증권사가 날짜별로 보고한 상태
 *   B  app / user checkpoint evidence                      — 사용자가 화면에서 확인한 값
 *
 * A-exec(체결 증거)과 T(계좌이전 증거)는 **이 타입에 없다.**
 * A-exec 은 원장 전용이고, T 는 계좌 상태 관측이 아니라 계좌 생애주기 사건이라
 * 이 테이블의 범위 밖이다(holdings/cash 가 의미 없는 행이 생긴다).
 */
export type EvidenceGrade = "P" | "H" | "B" | "unknown";

/** state_as_of 가 무엇을 뜻하는가. 세 날짜를 섞지 않기 위한 축이다. */
export type StateAsOfSemantics =
  /** 증권사가 그 날짜를 직접 보고했다 (과거잔고 화면 등) */
  | "broker_reported_date"
  /** "현재" 잔고 — 기준일 = 조회일. **결제일로 소급하지 않는다** */
  | "observation_date";

/** 그 화면/응답이 결제기준인지 거래기준인지. 모르면 unknown — 추정하지 않는다. */
export type SettlementBasis = "settlement" | "trade" | "unknown";

/**
 * 응답이 0주 종목을 생략하는가.
 *
 *   non_zero_only  보유 중인 종목만 응답한다 → plan universe 안에서 **부재 = 0** 으로
 *                  normalize 해도 된다 (전량매도된 종목을 검증할 수 있다)
 *   unknown        의미 미확정 → **부재를 0 으로 추정하지 않는다.** 비교 불가로 둔다
 */
export type HoldingsOmission = "non_zero_only" | "unknown";

/**
 * 관측 행에 **사실로 저장하는** 완전성.
 *
 *   all_positions   0주 종목까지 포함해 전부 보고/입력했다
 *   non_zero_only   보유 중인 것만 (0주는 생략)
 *   partial         일부만 적었다 (사용자 입력에서 발생)
 *   unknown         모른다 — 기본값
 */
export type HoldingsCompleteness = "all_positions" | "non_zero_only" | "partial" | "unknown";

export interface SourceCapabilities {
  grade: EvidenceGrade;
  /** 증권사. 행의 broker 컬럼이 사실을 들고 있고, 여기 값은 그것과 대조할 기대값이다. */
  broker: string | null;
  /** KIS tr_id 등 조회 식별자 (있으면). 비밀값이 아니다. */
  trId?: string;
  stateAsOfSemantics: StateAsOfSemantics;
  settlementBasis: SettlementBasis;
  supportsHoldings: boolean;
  supportsCash: boolean;
  holdingsOmission: HoldingsOmission;
  /** 자동 reconciliation 에 쓸 수 있는가. false 면 저장은 하되 판정에 넣지 않는다. */
  autoReconcile: boolean;
  /** 이 판단의 근거. 바뀌면 verifiedAt 과 함께 갱신한다. */
  source: string;
  verifiedAt: string;
}

/**
 * 확정된 source 별 capability.
 *
 * 등급·capability 를 **올리는** 것은 실증이 생겼을 때만 한다. 내리는 쪽(보수화)은
 * 언제든 한다 — fail closed 가 기본이다.
 */
export const SOURCE_REGISTRY: Readonly<Record<string, SourceCapabilities>> = Object.freeze({
  // ── 한국투자 IRP (ACNT_PRDT_CD=29) ───────────────────────────────────────
  kis_pension_present_balance: {
    grade: "P",
    broker: "kis",
    trId: "TTTC2202R",
    stateAsOfSemantics: "observation_date",
    settlementBasis: "settlement",
    supportsHoldings: true,
    // output2 에 예수금 필드가 없다 — IRP 현금은 inquire-deposit 에서 따로 받는다.
    supportsCash: false,
    // **실증 근거가 있는 유일한 non_zero_only.** §9 R14: 전량매도된 2종목(0167A0 /
    // 0181B0)이 응답에서 생략되고, 잔존 3종목 집계가 pchs_amt · pchs_avg_pric×수량 ·
    // 요약 pchs_amt_smtl_amt · 한국투자 앱 화면 4경로와 일치했다 = sell-to-zero 실측.
    holdingsOmission: "non_zero_only",
    autoReconcile: true,
    source:
      "PoC 48edff8 실측(2026-10-09) + docs/mirae-export-recollection.md §9 R14 (sell-to-zero 생략 실측, 4경로 일치)",
    verifiedAt: "2026-10-09",
  },
  kis_pension_deposit: {
    grade: "P",
    broker: "kis",
    trId: "TTTC0506R",
    stateAsOfSemantics: "observation_date",
    settlementBasis: "settlement",
    supportsHoldings: false,
    supportsCash: true,
    holdingsOmission: "unknown",
    autoReconcile: true,
    source: "PoC 48edff8 실측(2026-10-09). IRP present-balance 에 예수금이 없어 별도 호출이 필요하다",
    verifiedAt: "2026-10-09",
  },

  // ── 한국투자 연금저축 (ACNT_PRDT_CD=22) ──────────────────────────────────
  kis_inquire_balance: {
    grade: "P",
    broker: "kis",
    trId: "TTTC8434R",
    stateAsOfSemantics: "observation_date",
    settlementBasis: "settlement",
    supportsHoldings: true,
    supportsCash: true,
    // **보수값.** PoC 당시 계좌가 비어 있어 0행을 받은 것은 "보유가 없으면 0행"을
    // 보였을 뿐이고, IRP(TTTC2202R)처럼 **실제 sell-to-zero 응답을 본 것이 아니다.**
    // 빈 계좌 응답과 "보유 종목 중 0주인 것을 생략한다"는 서로 다른 주장이다.
    // 실제 보유/전량매도 응답이나 공식 스펙을 확인하면 non_zero_only 로 승격한다.
    holdingsOmission: "unknown",
    autoReconcile: true,
    source:
      "PoC 48edff8 실측(2026-10-06, 당시 빈 계좌 0행). sell-to-zero 실증 없음 — holdingsOmission 은 보수값 유지",
    verifiedAt: "2026-10-06",
  },

  // ── 미래에셋 날짜별 과거잔고 ─────────────────────────────────────────────
  broker_historical_balance: {
    grade: "H",
    broker: "miraeasset",
    stateAsOfSemantics: "broker_reported_date",
    // **settlement 로 두지 않는다.** §9-3 의 V1 모델(자산총액 = 결제기준 holdings ×
    // 종가 + residual)은 known control event(2026-08-28 리밸런싱)로 강하게 검증됐지만,
    // §9-4 R1 이 명시한 대로 **미래에셋의 공식 "자산총액" 정의를 문서로 읽은 것이 아니다**
    // — 검증된 모델이지 확인된 필드 정의가 아니다. 사실처럼 저장하지 않는다.
    settlementBasis: "unknown",
    // 이 화면의 종목 상세표에는 ISA·연금저축 종목이 섞여 나온다(§9-1) → holdings source
    // 로 쓰지 않는다. residual 은 파생 계산값이므로 cash 로도 쓰지 않는다.
    supportsHoldings: false,
    supportsCash: false,
    holdingsOmission: "unknown",
    // D6: source 정의만 두고 자동 reconciliation 에는 쓰지 않는다.
    autoReconcile: false,
    source:
      "docs/mirae-export-recollection.md §9-3 historical-balance V1 모델이 known control event 로 검증됨(R2). 다만 미래에셋 공식 필드 정의는 미확인(R1) — settlementBasis 를 사실로 주장하지 않는다",
    verifiedAt: "2026-10-10",
  },

  // ── 사용자가 증권사 화면에서 확인해 직접 입력 ────────────────────────────
  user_broker_screen: {
    grade: "B",
    // 증권사는 행의 broker 컬럼이 들고 있다 — source_type 만으로는 알 수 없다.
    broker: null,
    stateAsOfSemantics: "broker_reported_date",
    settlementBasis: "unknown",
    supportsHoldings: true,
    supportsCash: true,
    // 사용자가 어디까지 적었는지 source 만으로 알 수 없다. 행의
    // holdings_completeness 가 우선한다(R8) — 그것이 이 source 의 유일한 근거다.
    holdingsOmission: "unknown",
    autoReconcile: true,
    source: "사용자가 증권사 화면에서 확인해 입력. 완전성은 행별 holdings_completeness 가 정한다",
    verifiedAt: "2026-10-10",
  },
});

/**
 * 미지 source 의 capability. **전부 보수값이다.**
 *
 * 등급 unknown / autoReconcile false / holdings·cash 미지원 / 생략의미 미확정.
 * 새 source 가 들어오면 조용히 동작하지 않고 "판정 불가"로 드러난다.
 */
export const UNKNOWN_SOURCE_CAPABILITIES: SourceCapabilities = Object.freeze({
  grade: "unknown",
  broker: null,
  stateAsOfSemantics: "observation_date",
  settlementBasis: "unknown",
  supportsHoldings: false,
  supportsCash: false,
  holdingsOmission: "unknown",
  autoReconcile: false,
  source: "레지스트리에 없는 source_type — 보수값으로 처리한다(fail closed)",
  verifiedAt: "",
});

/** source 별 capability. 모르는 source 는 보수값을 돌려준다(throw 하지 않는다). */
export function capabilitiesOf(sourceType: string): SourceCapabilities {
  return SOURCE_REGISTRY[sourceType] ?? UNKNOWN_SOURCE_CAPABILITIES;
}

/** 증거 등급만 필요할 때. 저장값이 아니라 **파생값**이다. */
export function evidenceGradeOf(sourceType: string): EvidenceGrade {
  return capabilitiesOf(sourceType).grade;
}

/** 자동 reconciliation 에 쓸 수 있는 source 인가. */
export function isAutoReconcilable(sourceType: string): boolean {
  return capabilitiesOf(sourceType).autoReconcile;
}

/**
 * 유효 holdings 생략 의미.
 *
 * **행 값이 우선이고, 없으면 레지스트리 기본값이다**(R8). user_broker_screen 처럼
 * 같은 source 여도 관측마다 완전성이 다른 경우가 있어서, 그 사실은 행에 저장한다.
 */
export function effectiveHoldingsOmission(
  sourceType: string,
  rowCompleteness?: HoldingsCompleteness | null,
): HoldingsOmission {
  if (rowCompleteness === "all_positions" || rowCompleteness === "non_zero_only") {
    return "non_zero_only";
  }
  // partial 은 일부만 적었다는 뜻이라 부재를 0 으로 볼 수 없다. unknown 도 같다.
  if (rowCompleteness === "partial" || rowCompleteness === "unknown") return "unknown";
  return capabilitiesOf(sourceType).holdingsOmission;
}
