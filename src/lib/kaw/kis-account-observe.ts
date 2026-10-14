// ─────────────────────────────────────────────────────────────────────────────
// 한국투자 연금계좌 실잔고 → **계좌 관측 + 매수 주문안 입력** 구조 (순수 모듈)
//
// `kis-account-server.ts`(조회 어댑터, PoC 이식)가 돌려주는 원시 결과를, 이미 있는
// 구조에 **연결**한다. 새 개념을 만들지 않는다:
//
//   source-registry.ts        source 별 capability (kis_inquire_balance 등) — 그대로 쓴다
//   settlement-observation.ts CapturePartInput / captureId — 같은 part 모양으로 만든다
//   broker-account.ts         BrokerAccountInstance — instance 분리의 근거
//
// ── 이 모듈이 지키는 것 ────────────────────────────────────────────────────
//
//   1. **미조회와 잔고 0을 구분한다.** 조회하지 않았거나 실패한 축은 `observed` 가
//      아니다 — holdings 는 null, cash 는 null 이다. 0 을 채우지 않는다.
//      계좌 이전이 진행 중(instance 가 아직 active 가 아님)이면 **조회 자체를 하지
//      않고** `not_queried` 로 남긴다: 이전 중 계좌가 돌려주는 빈 응답은 "잔고 0"의
//      증거가 아니다
//   2. **22(연금저축)와 29(IRP)를 다른 instance·다른 source 로 분리한다.** 같은
//      증권사 안에서도 상품코드가 다르면 다른 계좌다
//   3. **빈 응답 ≠ 확정 0.** 응답이 0주 종목을 생략한다는 증거가 있는 source(IRP 현재
//      잔고)에서만 "확인된 빈 계좌"로 읽는다. 연금저축(22)은 그 실증이 없어 빈 응답을
//      `empty_unverified` 로 둔다(source-registry 의 보수값을 그대로 따른다)
//   4. **이전을 거래로 만들지 않는다.** 이 모듈은 잔고 **관측**만 만든다 — 체결도 입금도
//      만들지 않고, 두 instance 의 잔고를 이어 붙이지도 않는다(lineage 증거 없이는
//      cross-instance 비교 금지, broker-account.ts)
//   6. **sentinel 은 조회의 근거가 아니다.** 레지스트리에 등록된 instance 만 조회 대상이고,
//      미등록은 `not_queried(instance_unregistered)` 다
//   5. **계좌번호(CANO)가 어디에도 나오지 않는다.** 입력으로 받지 않으므로 출력에도
//      없다. instance id 는 앱이 발급한 불투명 값이거나 상품코드만 담은 sentinel 이다
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountId } from "./constants";
import { isActiveOn, type BrokerAccountInstance } from "./broker-account";
import {
  captureId,
  type CapturePartInput,
} from "./settlement-observation";
import {
  capabilitiesOf,
  type HoldingsCompleteness,
} from "./source-registry";
import {
  IRP_PRODUCT_CODE,
  PENSION_SAVINGS_PRODUCT_CODE,
  type KisBalanceSnapshot,
  type KisDepositResult,
} from "./kis-account-server";

// ── 상품 정의 ───────────────────────────────────────────────────────────────

export type KisProductCode = typeof PENSION_SAVINGS_PRODUCT_CODE | typeof IRP_PRODUCT_CODE;

export interface KisProductDef {
  productCode: KisProductCode;
  /** 앱의 논리 계좌 */
  logicalAccountType: AccountId;
  label: string;
  /** 보유종목 / 예수금을 각각 어느 source 에서 읽는가 (source-registry 키) */
  holdingsSource: string;
  cashSource: string;
}

/**
 * 상품코드 → 정의. **두 상품은 서로 다른 source·논리계좌를 쓴다.**
 *   22 연금저축  한 번의 호출(TTTC8434R)이 보유종목과 예수금을 같이 준다
 *   29 IRP       보유종목(TTTC2202R)과 예수금(TTTC0506R)이 **다른 호출**이다
 */
export const KIS_PRODUCTS: Readonly<Record<KisProductCode, KisProductDef>> = Object.freeze({
  "22": {
    productCode: "22",
    logicalAccountType: "pension",
    label: "한국투자 연금저축",
    holdingsSource: "kis_inquire_balance",
    cashSource: "kis_inquire_balance",
  },
  "29": {
    productCode: "29",
    logicalAccountType: "irp",
    label: "한국투자 IRP",
    holdingsSource: "kis_pension_present_balance",
    cashSource: "kis_pension_deposit",
  },
});

export function isKisProductCode(v: unknown): v is KisProductCode {
  return v === "22" || v === "29";
}

export const KIS_BROKER = "kis";

/**
 * **계좌 식별에 대한 미검증 가정.**
 *
 * 서버는 종합계좌번호(CANO) 하나로 연금저축(22)과 IRP(29)를 모두 조회한다. 두 상품이
 * **같은 종합계좌번호 아래에 있다는 것은 검증되지 않은 가정**이다 — 조회가 성공했다는 것은
 * 그 CANO + 상품코드 조합이 응답했다는 뜻일 뿐, 두 계좌가 같은 사람·같은 계좌 묶음이라는
 * 증명이 아니다.
 *
 * 그래서 이 조회 결과를 **실제 주문 기능의 계좌 식별 근거로 쓰지 않는다.** 주문이
 * 생기면 계좌 식별은 별도의 검증(상품코드별 CANO 확인·fingerprint·사용자 확인)을 거쳐야
 * 한다. 지금의 읽기 전용 조회에서는 잔고 표시와 주문안 *입력* 계산에만 쓴다.
 */
export const KIS_ACCOUNT_IDENTITY = Object.freeze({
  sharedCanoAcrossProducts: "unverified",
  usableAsOrderAccountIdentity: false,
  note:
    "연금저축(22)과 IRP(29)가 같은 종합계좌번호라는 가정은 검증되지 않았다. " +
    "이 조회 결과를 주문 계좌의 식별 근거로 쓰지 않는다.",
} as const);

// ── instance 분리 ───────────────────────────────────────────────────────────

/**
 * 레지스트리에 KIS instance 가 없을 때 쓰는 sentinel. **상품코드까지 들어 있다** —
 * 논리계좌만 담는 기존 sentinel(`bai:unregistered:pension`)은 미래에셋 연금저축과
 * 한국투자 연금저축을 같은 것으로 만들어 버린다.
 *
 * 계좌에 대한 주장이 아니다. 레지스트리에 실제 `bai:` id 가 생기면 달라지므로 비교 쪽이
 * fail closed 한다(rebalance-session.ts UNREGISTERED_INSTANCE_PREFIX 와 같은 규칙).
 */
export function kisUnregisteredInstanceId(productCode: KisProductCode): string {
  return `bai:unregistered:${KIS_BROKER}:${productCode}`;
}

export type KisInstanceResolution =
  /** 레지스트리의 KIS instance 가 그 날짜에 active 다 → 조회한다 */
  | { kind: "registered"; accountInstanceId: string; instance: BrokerAccountInstance }
  /** 레지스트리에 KIS instance 가 없다 → sentinel 로 조회한다(주장하지 않는다) */
  | { kind: "unregistered"; accountInstanceId: string }
  /** 등록은 됐는데 **아직 active 가 아니다**(계좌 이전·개설 진행 중) → 조회하지 않는다 */
  | { kind: "not_yet_active"; accountInstanceId: string; activeFrom: string }
  /** 이미 active 기간이 끝났다 → 조회하지 않는다 */
  | { kind: "no_longer_active"; accountInstanceId: string; activeTo: string }
  /** 같은 날짜에 active 한 KIS instance 가 둘 이상 — **추측하지 않는다** */
  | { kind: "ambiguous"; candidates: string[] };

/**
 * 이 상품코드가 그 날짜에 어느 KIS instance 인가.
 *
 * 증권사(`kis`) + 상품코드 + 논리계좌가 **모두** 맞아야 한다. 미래에셋의 같은 논리계좌
 * instance 는 후보에 들어오지 않으므로, 이전이 진행되는 동안 두 증권사 계좌가 동시에
 * 존재해도 서로 섞이지 않는다.
 */
export function resolveKisInstance(
  productCode: KisProductCode,
  registry: readonly BrokerAccountInstance[],
  asOf: string,
): KisInstanceResolution {
  const def = KIS_PRODUCTS[productCode];
  const mine = registry.filter(
    (i) =>
      i.broker === KIS_BROKER &&
      i.productCode === productCode &&
      i.logicalAccountType === def.logicalAccountType,
  );
  if (!mine.length) {
    return { kind: "unregistered", accountInstanceId: kisUnregisteredInstanceId(productCode) };
  }

  const active = mine.filter((i) => isActiveOn(i, asOf));
  if (active.length > 1) return { kind: "ambiguous", candidates: active.map((i) => i.id).sort() };
  if (active.length === 1) {
    return { kind: "registered", accountInstanceId: active[0].id, instance: active[0] };
  }

  // active 가 0 개다. 미래에 시작하는 것이 있으면 "이전·개설 진행 중"이고, 아니면 종료됐다.
  const upcoming = mine
    .filter((i) => asOf < i.activeFrom)
    .sort((a, b) => a.activeFrom.localeCompare(b.activeFrom))[0];
  if (upcoming) {
    return { kind: "not_yet_active", accountInstanceId: upcoming.id, activeFrom: upcoming.activeFrom };
  }
  const last = [...mine].sort((a, b) => (b.activeTo ?? "").localeCompare(a.activeTo ?? ""))[0];
  return { kind: "no_longer_active", accountInstanceId: last.id, activeTo: last.activeTo ?? "" };
}

// ── 축 상태 ─────────────────────────────────────────────────────────────────

export type NotQueriedReason =
  /** 계좌 이전·개설이 진행 중이라 아직 active 가 아니다 */
  | "not_yet_active"
  | "no_longer_active"
  | "instance_ambiguous"
  | "credentials_missing"
  | "invalid_account_config"
  /** 레지스트리에 이 계좌가 없다 — sentinel 은 계좌 식별·조회 권한의 근거가 아니다 */
  | "instance_unregistered"
  /** 사용자가 이 계좌를 "계산만 제공"으로 설정했다 */
  | "mode_calc_only"
  /** 이 세션(가족·프로필)에는 이 증권사 계좌의 조회 권한이 확인되지 않는다 */
  | "not_authorized"
  /** 같은 호출 묶음의 다른 쪽이 실패해 이 축은 시도하지 않았다 */
  | "dependent_call_failed"
  /** 이 축을 읽는 API 를 이 단계에서 켜지 않았다 */
  | "api_not_enabled";

/**
 * 한 축(보유종목 / 예수금 / 매수가능금액)의 상태.
 *
 *   observed     증권사가 값을 보고했다 (0 포함)
 *   not_queried  **조회하지 않았다** — 값이 없다. 0 이 아니다
 *   failed       조회했으나 실패했다 — 값이 없다. 0 이 아니다
 */
export type Axis<T> =
  | { kind: "observed"; value: T }
  | { kind: "not_queried"; reason: NotQueriedReason }
  | { kind: "failed"; error: string };

export type EmptyMeaning =
  /** 보유가 있다 */
  | "has_positions"
  /** 0행이고 이 source 는 0주 종목을 생략한다고 실증됐다 → 보유 0 으로 읽어도 된다 */
  | "confirmed_zero"
  /** 0행이지만 빈 계좌인지 생략인지 **확정할 수 없다** */
  | "empty_unverified";

export interface HoldingsObservation {
  /** ticker → 수량. 이름이 없거나 수량을 못 읽은 행은 여기 들어오지 않는다 */
  positions: Record<string, number>;
  names: Record<string, string>;
  completeness: HoldingsCompleteness;
  emptyMeaning: EmptyMeaning;
  /** ticker 또는 수량을 읽지 못해 **제외한 행 수**. 0 이 아니면 completeness 가 내려간다 */
  skippedRows: number;
}

/** 매수가능금액. 이 단계에서는 조회하지 않는다(KIS_BUYING_POWER_SUPPORT 참고). */
export interface BuyingPowerObservation {
  amount: number;
  sourceType: string;
}

// ── 매수가능금액 API 지원 현황 ──────────────────────────────────────────────

/**
 * 한국투자 매수가능조회 API 의 **확인된 사실**.
 *
 * 연금저축(22): 일반 주식 매수가능조회(TTTC8908R)가 **실증됐다**(2026-10-14, 사용자 승인 하에
 * 읽기 전용 1회 조회: HTTP 200 / rt_cd 0). `nrcvb_buy_amt`(미수없는매수금액)가 한투 앱의
 * 주문가능원화와 정확히 일치했다. 조회 구현은 `kis-buying-power.ts` 에 있다.
 *
 * IRP(29): 연금 전용 API(TTTC0503R)가 공식 예제에 있으나 **이 계좌로 실응답을 확인하지
 * 않았다.** 응답 필드도 5개(`ord_psbl_cash`, `ruse_psbl_amt`, `psbl_qty_calc_unpr`,
 * `max_buy_amt`, `max_buy_qty`)뿐이라 22 와 같은 방식으로 쓸 수 있는지 미확인이다.
 *
 * 공통: 둘 다 **종목(PDNO) + 주문단가(ORD_UNPR)를 요구**한다 — 계좌 단위 한도가 아니라
 * "그 종목을 그 가격에 사려 할 때"의 한도다. 그래서 계획의 단가와 **같은 단가로 조회한
 * 값만** 예산으로 인정한다(buy-order-plan.ts).
 *
 * **관측된 비율을 규칙으로 쓰지 않는다.** 응답 안에서 `nrcvb_buy_amt ≈ ord_psbl_cash/1.005`
 * 가 관측됐지만 이유(수수료·증거금·여유율)와 일반성은 공식 문서로 확인되지 않았다.
 */
export const KIS_BUYING_POWER_SUPPORT = Object.freeze({
  "29": {
    status: "documented_unverified",
    path: "/uapi/domestic-stock/v1/trading/pension/inquire-psbl-order",
    trId: "TTTC0503R",
    requires: ["PDNO", "ORD_UNPR", "ORD_DVSN", "ACCA_DVSN_CD", "CMA_EVLU_AMT_ICLD_YN"],
    note: "퇴직연금 전용 매수가능조회. 공식 예제에 있으나 이 계좌로 실응답을 확인하지 않았다.",
  },
  "22": {
    status: "verified_2026_10_14",
    path: "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
    trId: "TTTC8908R",
    requires: ["PDNO", "ORD_UNPR", "ORD_DVSN", "CMA_EVLU_AMT_ICLD_YN", "OVRS_ICLD_YN"],
    note: "연금저축(22)에서 실증됨. nrcvb_buy_amt 가 앱의 주문가능원화와 일치했다.",
  },
} as const);

/**
 * **주문 API 의 지원 여부 (연금저축 22).** 이 단계에서 주문 기능은 **구현하지 않았다.**
 *
 * 공식 예제 저장소(koreainvestment/open-trading-api, examples_llm/domestic_stock) 확인:
 *   · 연금 전용 API(`pension_*`)는 **조회 5종뿐**이다 — balance / daily_ccld / deposit /
 *     present_balance / psbl_order. 연금 전용 주문 API 는 없다
 *   · 일반 주식 주문(`order_cash`, TTTC0012U 매수 / TTTC0011U 매도)은 있으나, 예제의
 *     계좌 상품코드 설명은 "계좌상품코드(상품유형코드)"뿐이고 **연금저축(22)을 지원하는지
 *     명시하지 않는다**
 *
 * 그래서 22 에서 주문이 되는지는 **공식 문서로 확인되지 않았다.** 확인하려면 실제 주문이
 * 필요하고 그것은 별도의 명시적 승인이 있어야 한다. 확인 전에는 주문 요청 코드(POST)를
 * 이 저장소에 두지 않는다.
 */
export const KIS_ORDER_SUPPORT = Object.freeze({
  "22": {
    status: "unverified",
    candidate: { path: "/uapi/domestic-stock/v1/trading/order-cash", buyTrId: "TTTC0012U" },
    pensionSpecificOrderApi: false,
    note: "연금 전용 주문 API 는 없고, 일반 주문 API 의 22 지원은 공식 예제에 명시되지 않았다.",
  },
  "29": {
    status: "unverified",
    candidate: null,
    pensionSpecificOrderApi: false,
    note: "연금 전용 주문 API 가 없고 일반 주문 API 의 29 지원도 확인되지 않았다.",
  },
} as const);

// ── 스냅샷 ──────────────────────────────────────────────────────────────────

export interface KisAccountObservation {
  productCode: KisProductCode;
  accountType: AccountId;
  broker: typeof KIS_BROKER;
  label: string;
  accountInstanceId: string;
  /** 레지스트리에서 왔는가, sentinel 인가 */
  instanceBasis: "registry" | "sentinel" | "unresolved";
  /** 증권사가 말하는 기준일. "현재 잔고"라 조회일이다(결제일로 소급하지 않는다) */
  stateAsOf: string;
  observedAt: string;
  holdings: Axis<HoldingsObservation>;
  cash: Axis<number>;
  buyingPower: Axis<BuyingPowerObservation>;
}

export interface PlanBlocker {
  code:
    | "instance_not_active"
    | "instance_ambiguous"
    /** 계산만 제공 / 미등록 / 권한 미확인 / credential 문제로 API 를 쓸 수 없다 */
    | "api_not_available"
    | "holdings_not_observed"
    | "holdings_unverified_empty"
    | "holdings_incomplete"
    | "cash_not_observed";
  message: string;
}

export interface PlanWarning {
  code: "instance_unregistered" | "buying_power_unavailable";
  message: string;
}

/** 매수 주문안이 쓸 수 있는 돈의 **상한과 그 근거**. 근거를 숨기지 않는다. */
export type BuyBudget =
  | { kind: "buying_power"; amount: number }
  /** 매수가능금액이 확인되지 않아 예수금을 상한으로 쓴다. 실제 한도는 이보다 작을 수 있다 */
  | { kind: "cash_upper_bound"; amount: number }
  | { kind: "unknown" };

/** 실제 잔고 기반 매수 주문안의 입력. **주문이 아니다** — 계산에 쓸 사실만 담는다. */
export interface BuyPlanInputs {
  accountInstanceId: string;
  accountType: AccountId;
  productCode: KisProductCode;
  broker: typeof KIS_BROKER;
  stateAsOf: string;
  /** ticker → 수량. 관측되지 않았으면 **null** (빈 객체가 아니다) */
  holdings: Record<string, number> | null;
  holdingsCompleteness: HoldingsCompleteness;
  cash: number | null;
  buyBudget: BuyBudget;
  ready: boolean;
  blockers: PlanBlocker[];
  warnings: PlanWarning[];
  /** settlement-observation 의 capture 에 그대로 쓸 수 있는 part 들 (저장하지 않는다) */
  captureParts: CapturePartInput[];
  /** 같은 part 들에서 결정적으로 나오는 id */
  captureId: string;
}

// ── 변환 ────────────────────────────────────────────────────────────────────

function holdingsAxisFromSnapshot(
  snap: KisBalanceSnapshot,
  sourceType: string,
): Axis<HoldingsObservation> {
  if (!snap.ok) return { kind: "failed", error: describeFailure(snap) };

  const positions: Record<string, number> = {};
  const names: Record<string, string> = {};
  let skipped = 0;
  for (const h of snap.holdings) {
    if (!h.ticker || h.quantity === null) {
      skipped += 1;
      continue;
    }
    positions[h.ticker] = (positions[h.ticker] ?? 0) + h.quantity;
    if (h.name) names[h.ticker] = h.name;
  }
  // 0주로 보고된 행은 보유가 아니다. 키를 남기지 않는다(생략과 같은 의미로 정규화).
  for (const [t, q] of Object.entries(positions)) if (q === 0) delete positions[t];

  const omission = capabilitiesOf(sourceType).holdingsOmission;
  const positionCount = Object.keys(positions).length;

  // 읽지 못한 행이 있으면 목록이 불완전하다 — 어떤 source 든 completeness 를 올리지 않는다.
  let completeness: HoldingsCompleteness =
    skipped > 0 ? "partial" : omission === "non_zero_only" ? "non_zero_only" : "unknown";

  let emptyMeaning: EmptyMeaning;
  if (positionCount > 0) emptyMeaning = "has_positions";
  else if (skipped === 0 && omission === "non_zero_only") emptyMeaning = "confirmed_zero";
  else emptyMeaning = "empty_unverified";

  if (emptyMeaning === "confirmed_zero") completeness = "non_zero_only";

  return {
    kind: "observed",
    value: { positions, names, completeness, emptyMeaning, skippedRows: skipped },
  };
}

function describeFailure(r: {
  httpStatus: number;
  rtCd?: string;
  msgCd?: string;
  msg1?: string;
  transportError?: string;
}): string {
  // msg1/transportError 는 어댑터가 이미 redact 했다. 여기서 원문을 다시 만들지 않는다.
  if (r.transportError) return `네트워크 오류: ${r.transportError}`;
  const code = [r.rtCd !== undefined ? `rt_cd=${r.rtCd}` : null, r.msgCd ? `msg_cd=${r.msgCd}` : null]
    .filter(Boolean)
    .join(" ");
  return `HTTP ${r.httpStatus}${code ? ` · ${code}` : ""}${r.msg1 ? ` · ${r.msg1}` : ""}`;
}

export interface BuildObservationInput {
  productCode: KisProductCode;
  resolution: KisInstanceResolution;
  stateAsOf: string;
  observedAt: string;
  /** 조회 결과. 조회하지 않았으면 생략한다 */
  balance?: KisBalanceSnapshot;
  /** IRP 예수금(별도 호출). 연금저축은 balance 안에 있다 */
  deposit?: KisDepositResult;
  /** 조회를 건너뛴 이유 (credential 없음 등). resolution 과 별개다 */
  skipped?: NotQueriedReason;
}

/**
 * 조회 결과(또는 조회하지 않은 사실)를 관측 구조로 만든다. **0 을 만들어 채우지 않는다.**
 */
export function buildKisObservation(input: BuildObservationInput): KisAccountObservation {
  const def = KIS_PRODUCTS[input.productCode];
  const { resolution } = input;

  const base = {
    productCode: input.productCode,
    accountType: def.logicalAccountType,
    broker: KIS_BROKER,
    label: def.label,
    stateAsOf: input.stateAsOf,
    observedAt: input.observedAt,
  } as const;

  const notQueried = (reason: NotQueriedReason): KisAccountObservation => ({
    ...base,
    accountInstanceId:
      resolution.kind === "ambiguous"
        ? kisUnregisteredInstanceId(input.productCode)
        : resolution.accountInstanceId,
    instanceBasis:
      resolution.kind === "registered" || resolution.kind === "not_yet_active" ||
      resolution.kind === "no_longer_active"
        ? "registry"
        : resolution.kind === "ambiguous"
          ? "unresolved"
          : "sentinel",
    holdings: { kind: "not_queried", reason },
    cash: { kind: "not_queried", reason },
    buyingPower: { kind: "not_queried", reason: "api_not_enabled" },
  });

  // 조회 자체를 하지 않는 경우. 이 경우 값은 **없다**(0 이 아니다).
  if (resolution.kind === "not_yet_active") return notQueried("not_yet_active");
  if (resolution.kind === "no_longer_active") return notQueried("no_longer_active");
  if (resolution.kind === "ambiguous") return notQueried("instance_ambiguous");
  // **sentinel 로는 조회하지 않는다.** 미등록 계좌에 대한 주장이 없으므로 그것이 어느
  // 사람의 어느 계좌인지 알 수 없다(권한 확인의 근거가 될 수 없다).
  if (resolution.kind === "unregistered") return notQueried("instance_unregistered");
  if (input.skipped) return notQueried(input.skipped);

  const instanceBasis = "registry" as const;
  const accountInstanceId = resolution.accountInstanceId;

  if (input.productCode === "22") {
    // 한 번의 호출이 보유종목과 예수금을 같이 준다.
    const bal = input.balance;
    if (!bal) return notQueried("dependent_call_failed");
    const holdings = holdingsAxisFromSnapshot(bal, def.holdingsSource);
    const cash: Axis<number> = !bal.ok
      ? { kind: "failed", error: describeFailure(bal) }
      : bal.cash === null
        ? // 호출은 성공했지만 응답에 예수금 필드가 없다 — 0 이 아니라 **모른다**
          { kind: "failed", error: "응답에 예수금 필드가 없습니다" }
        : { kind: "observed", value: bal.cash };
    return {
      ...base, accountInstanceId, instanceBasis,
      holdings, cash,
      buyingPower: { kind: "not_queried", reason: "api_not_enabled" },
    };
  }

  // IRP(29): 보유종목과 예수금이 **다른 호출**이다 — 한쪽이 실패해도 다른 쪽은 남긴다.
  const bal = input.balance;
  const dep = input.deposit;
  const holdings: Axis<HoldingsObservation> = bal
    ? holdingsAxisFromSnapshot(bal, def.holdingsSource)
    : { kind: "not_queried", reason: "dependent_call_failed" };
  const cash: Axis<number> = !dep
    ? { kind: "not_queried", reason: "dependent_call_failed" }
    : !dep.ok
      ? { kind: "failed", error: describeFailure(dep) }
      : dep.cash === null
        ? { kind: "failed", error: "응답에 예수금 필드가 없습니다" }
        : { kind: "observed", value: dep.cash };
  return {
    ...base, accountInstanceId, instanceBasis,
    holdings, cash,
    buyingPower: { kind: "not_queried", reason: "api_not_enabled" },
  };
}

// ── 주문안 입력 ─────────────────────────────────────────────────────────────

/** 관측을 settlement-observation 의 part 입력으로. **관측된 축만** 값을 갖고 나머지는 null. */
export function capturePartsOf(obs: KisAccountObservation): CapturePartInput[] {
  const def = KIS_PRODUCTS[obs.productCode];
  const holdingsObs = obs.holdings.kind === "observed" ? obs.holdings.value : null;
  const cashObs = obs.cash.kind === "observed" ? obs.cash.value : null;

  const part = (sourceType: string, holdings: Axis<HoldingsObservation>, cash: number | null): CapturePartInput => {
    const caps = capabilitiesOf(sourceType);
    const h = holdings.kind === "observed" ? holdings.value : null;
    return {
      sourceType,
      stateAsOfBasis: caps.stateAsOfSemantics,
      settlementBasis: caps.settlementBasis,
      holdings: h ? { ...h.positions } : null,
      holdingsCompleteness: h ? h.completeness : "unknown",
      cash,
    };
  };

  if (def.holdingsSource === def.cashSource) {
    // 연금저축: 한 part. 둘 중 관측된 축만 값을 갖는다.
    if (holdingsObs === null && cashObs === null) return [];
    return [part(def.holdingsSource, obs.holdings, cashObs)];
  }

  // IRP: 호출이 둘이므로 part 도 둘이다. 한쪽만 성공해도 그 part 만 만든다(partial capture).
  const parts: CapturePartInput[] = [];
  if (holdingsObs !== null) parts.push(part(def.holdingsSource, obs.holdings, null));
  if (cashObs !== null) {
    parts.push({
      ...part(def.cashSource, { kind: "not_queried", reason: "api_not_enabled" }, cashObs),
      holdings: null,
      holdingsCompleteness: "unknown",
    });
  }
  return parts;
}

/**
 * 매수 주문안의 예산. **매수가능금액이 확인되기 전에는 예수금을 상한으로만 쓴다.**
 * 예수금이 관측되지 않았으면 unknown 이다 — 0 으로 만들지 않는다.
 */
export function buyBudgetOf(obs: KisAccountObservation): BuyBudget {
  if (obs.buyingPower.kind === "observed") {
    return { kind: "buying_power", amount: obs.buyingPower.value.amount };
  }
  if (obs.cash.kind === "observed") return { kind: "cash_upper_bound", amount: obs.cash.value };
  return { kind: "unknown" };
}

/**
 * 실제 잔고 기반 매수 주문안의 입력. 준비가 안 된 이유를 **blocker 로 열거**한다.
 *
 * ready 의 조건: 계좌가 active + 보유종목·예수금이 둘 다 관측됨 + 보유 목록이 신뢰할 수
 * 있음(빈 응답이 확정 0 이거나 보유가 있음, 읽지 못한 행 없음).
 */
export function buildBuyPlanInputs(obs: KisAccountObservation): BuyPlanInputs {
  const blockers: PlanBlocker[] = [];
  const warnings: PlanWarning[] = [];

  // 조회하지 않은 이유가 계좌 상태에 있으면 그것이 가장 먼저 말해야 할 사실이다.
  const instanceReason =
    obs.holdings.kind === "not_queried" ? obs.holdings.reason : null;
  if (instanceReason === "not_yet_active" || instanceReason === "no_longer_active") {
    blockers.push({
      code: "instance_not_active",
      message:
        instanceReason === "not_yet_active"
          ? "계좌 이전·개설이 아직 완료되지 않아 조회하지 않았습니다. 잔고 0 이 아닙니다."
          : "이 계좌는 더 이상 사용 기간이 아니라 조회하지 않았습니다.",
    });
  } else if (instanceReason === "instance_ambiguous") {
    blockers.push({
      code: "instance_ambiguous",
      message: "같은 날짜에 사용 중인 한국투자 계좌가 둘 이상이라 조회하지 않았습니다.",
    });
  } else if (
    instanceReason === "mode_calc_only" ||
    instanceReason === "instance_unregistered" ||
    instanceReason === "not_authorized" ||
    instanceReason === "credentials_missing" ||
    instanceReason === "invalid_account_config"
  ) {
    const text: Record<string, string> = {
      mode_calc_only: "이 계좌는 '계산만 제공'으로 설정돼 있어 증권사 조회를 하지 않았습니다.",
      instance_unregistered: "등록된 계좌가 없어 조회하지 않았습니다. 잔고 0 이 아닙니다.",
      not_authorized: "이 프로필에는 해당 증권사 계좌의 조회 권한이 확인되지 않아 조회하지 않았습니다.",
      credentials_missing: "서버에 증권사 연동 설정이 없어 조회하지 않았습니다.",
      invalid_account_config: "서버의 계좌 설정이 올바르지 않아 조회하지 않았습니다.",
    };
    blockers.push({ code: "api_not_available", message: text[instanceReason] });
  }

  if (obs.instanceBasis === "sentinel") {
    warnings.push({
      code: "instance_unregistered",
      message: "계좌가 레지스트리에 등록되지 않아 상품코드로만 구분합니다.",
    });
  }

  if (!blockers.length) {
    if (obs.holdings.kind !== "observed") {
      blockers.push({
        code: "holdings_not_observed",
        message:
          obs.holdings.kind === "failed"
            ? `보유종목 조회에 실패했습니다: ${obs.holdings.error}`
            : "보유종목을 조회하지 않았습니다.",
      });
    } else {
      const h = obs.holdings.value;
      if (h.skippedRows > 0 || h.completeness === "partial") {
        blockers.push({
          code: "holdings_incomplete",
          message: `종목코드 또는 수량을 읽지 못한 행이 ${h.skippedRows}건 있어 보유 목록이 불완전합니다.`,
        });
      } else if (h.emptyMeaning === "empty_unverified") {
        blockers.push({
          code: "holdings_unverified_empty",
          message:
            "보유종목 응답이 비어 있지만 빈 계좌인지 확인할 수 없습니다. 보유 0 으로 간주하지 않습니다.",
        });
      }
    }
    if (obs.cash.kind !== "observed") {
      blockers.push({
        code: "cash_not_observed",
        message:
          obs.cash.kind === "failed"
            ? `예수금 조회에 실패했습니다: ${obs.cash.error}`
            : "예수금을 조회하지 않았습니다.",
      });
    }
  }

  if (obs.buyingPower.kind !== "observed") {
    warnings.push({
      code: "buying_power_unavailable",
      message: "매수가능금액을 조회하지 않아 예수금을 상한으로만 사용합니다.",
    });
  }

  const parts = capturePartsOf(obs);
  const holdings = obs.holdings.kind === "observed" ? { ...obs.holdings.value.positions } : null;

  return {
    accountInstanceId: obs.accountInstanceId,
    accountType: obs.accountType,
    productCode: obs.productCode,
    broker: obs.broker,
    stateAsOf: obs.stateAsOf,
    holdings,
    holdingsCompleteness:
      obs.holdings.kind === "observed" ? obs.holdings.value.completeness : "unknown",
    cash: obs.cash.kind === "observed" ? obs.cash.value : null,
    buyBudget: buyBudgetOf(obs),
    ready: blockers.length === 0,
    blockers,
    warnings,
    captureParts: parts,
    captureId: captureId(obs.accountInstanceId, obs.stateAsOf, parts),
  };
}
