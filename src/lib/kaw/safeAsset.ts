import {
  MIN_SAFE_ASSET_PCT, MAX_RISK_ASSET_PCT, VERIFIED_RETIREMENT_RISK_CLASS,
  RETIREMENT_RISK_CLASS_RECOMMENDATION_BY_GROUP,
  SAFE_ASSET_MIN_ACCOUNTS,
  type AccountId, type RetirementRiskClass, type VerifiedRiskClassEntry,
} from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// 퇴직연금·IRP 위험자산 한도(70%) / 비위험자산 최소비중(30%) 검증
//
// 설정 화면(목표비중, 저장 차단)과 리밸런싱 화면(실제 평가액, 경고만)이 같은 분류 기준을
// 쓰도록 여기에 한 번만 구현한다.
//
// 분류 판정 근거는 둘뿐이고, 추정하지 않는다:
//   1) AssetDef.retirementRiskClass — 종목별 명시값(설정 → 종목 설정에서 지정)
//   2) VERIFIED_RETIREMENT_RISK_CLASS — 검증된 종목코드별 분류표
//   그 외는 unknown. 계산에서는 보수적으로 위험자산으로 보고, 화면에는
//   "퇴직연금 분류 미확인"으로 드러낸다.
//
// 자산 group 은 판정에 쓰지 않는다. "미확인" 종목의 분류를 처음 지정할 때 어느 값부터
// 제안할지(recommendation)에만 쓴다 — 안전자산·현금성자산 그룹이라는 이유로 nonRisk 가
// 자동 확정되는 경로는 없다.
// ─────────────────────────────────────────────────────────────────────────────

export { MIN_SAFE_ASSET_PCT, MAX_RISK_ASSET_PCT } from "./constants";

export interface RiskClassLibEntry {
  id: string;
  group?: string;
  defaultEtf?: string;
  ticker?: string;
  retirementRiskClass?: RetirementRiskClass;
}

export interface ResolvedRiskClass {
  /** 계산에 쓰는 분류. unknown 일 때는 보수적으로 "risk". */
  riskClass: RetirementRiskClass;
  /** explicit = 종목에 지정됨, verified = 검증된 종목코드 분류표, unknown = 미확인 */
  source: "explicit" | "verified" | "unknown";
  /** 검증 분류표 항목(source/verifiedAt 포함) — 화면 tooltip 에서 근거와 확인일을 보여준다 */
  verified?: VerifiedRiskClassEntry;
  /** 미확인 종목의 분류를 처음 지정할 때 제안할 값(그룹 기본 추천값). 판정이 아니다. */
  recommendation: RetirementRiskClass | null;
}

export function resolveRetirementRiskClass(def: RiskClassLibEntry | undefined): ResolvedRiskClass {
  const recommendation = (def?.group
    ? RETIREMENT_RISK_CLASS_RECOMMENDATION_BY_GROUP[def.group]
    : undefined) ?? null;
  if (def?.retirementRiskClass) {
    return { riskClass: def.retirementRiskClass, source: "explicit", recommendation };
  }
  const verified = def?.ticker ? VERIFIED_RETIREMENT_RISK_CLASS[def.ticker.toUpperCase()] : undefined;
  if (verified) {
    return { riskClass: verified.riskClass, source: "verified", verified, recommendation };
  }
  return { riskClass: "risk", source: "unknown", recommendation };
}

// 행 → 라이브러리 항목. **ETF명이 먼저다.** 행의 assetId 와 실제 담고 있는 상품이 다를 수
// 있기 때문이다(예: 행 id `kr` 의 실제 종목이 "SOL AI반도체TOP2플러스"). 앱의 ticker 조회도
// 같은 규칙을 쓴다 — assetId 로 먼저 찾으면 엉뚱한 상품의 분류를 가져온다.
function makeLookup(library: readonly RiskClassLibEntry[]) {
  const byId = new Map(library.map((d) => [d.id, d]));
  const byEtf = new Map(library.filter((d) => d.defaultEtf).map((d) => [d.defaultEtf!, d]));
  return (assetId: string, etfName?: string) =>
    (etfName ? byEtf.get(etfName) : undefined) ?? byId.get(assetId);
}

export function requiresSafeAssetMinimum(accountId: AccountId): boolean {
  return SAFE_ASSET_MIN_ACCOUNTS.includes(accountId);
}

// ── 1. 목표비중 기준 (설정 화면 — 저장 차단) ────────────────────────────────

export interface SafeAssetRow { id: string; assetId: string; etfName?: string }

export interface SafeAssetCheck {
  /** 이 계좌에 30% 규칙이 적용되는가 (퇴직연금·IRP만 true) */
  required: boolean;
  /** 비위험자산 목표비중 합계(%) */
  safePct: number;
  /** 위험자산 목표비중 합계(%) */
  riskPct: number;
  /** 전체 목표비중 합계(%) */
  totalPct: number;
  /** 퇴직연금 분류 미확인이라 위험자산으로 계산한 행 수 */
  unclassifiedCount: number;
  /** 규칙 위반 여부 — required이고 목표비중이 입력돼 있는데 비위험자산이 30% 미만일 때 true */
  violated: boolean;
}

export function checkSafeAssetMinimum(
  accountId: AccountId,
  rows: readonly SafeAssetRow[],
  allocations: Record<string, number>,
  library: readonly RiskClassLibEntry[],
): SafeAssetCheck {
  const lookup = makeLookup(library);
  let safePct = 0;
  let totalPct = 0;
  let unclassifiedCount = 0;
  for (const r of rows) {
    const pct = allocations[r.id] ?? 0;
    if (!pct) continue;
    totalPct += pct;
    const { riskClass, source } = resolveRetirementRiskClass(lookup(r.assetId, r.etfName));
    if (riskClass === "nonRisk") safePct += pct;
    if (source === "unknown") unclassifiedCount++;
  }
  // 부동소수점 누적 오차로 29.999...%가 되는 것을 막는다 (소수 첫째자리까지만 의미 있는 값)
  safePct = Math.round(safePct * 1000) / 1000;
  totalPct = Math.round(totalPct * 1000) / 1000;
  return {
    required: requiresSafeAssetMinimum(accountId),
    safePct,
    riskPct: Math.round((totalPct - safePct) * 1000) / 1000,
    totalPct,
    unclassifiedCount,
    // 목표비중이 아예 비어 있는 상태(합계 0)는 "아직 설정 안 함"이라 위반으로 보지 않는다.
    violated: requiresSafeAssetMinimum(accountId) && totalPct > 0
      && safePct + 1e-9 < MIN_SAFE_ASSET_PCT,
  };
}

// ── 2. 실제 평가액 기준 (리밸런싱 화면 — 경고만, 저장은 항상 허용) ──────────
//
// 목표비중이 비위험 30%여도 정수 주 단위로만 살 수 있어 실제 결과는 미달할 수 있고,
// 매수 이후 시장가격 변동만으로도 위험자산 비중이 70%를 넘을 수 있다. 그 경우 즉시
// 매도 의무가 있는 것은 아니고 기존 보유는 유지할 수 있다(추가 매수만 제한된다).
// 그래서 이 검사는 저장을 막지 않고 현황만 알려준다.
//
// 예수금은 위험자산이 아니지만 총자산에는 포함한다.

export interface SafeAssetValueRow {
  assetId: string;
  /** 행에 지정된 ETF명. assetId 로 라이브러리를 못 찾을 때(미배정 보유 등) 폴백 키로 쓴다. */
  etfName?: string;
  /** 현재 평가금액(KRW) */
  value: number;
}

export interface SafeAssetValueCheck {
  required: boolean;
  /** 비위험자산 평가액(예수금 제외) */
  safeValue: number;
  riskValue: number;
  /** 계산에 쓴 예수금. 미입력이면 0 (보수적 가정) */
  cashBalance: number;
  /** 사용자가 실제 예수금을 입력했는가 */
  cashEntered: boolean;
  /**
   * 예수금 미입력 상태의 "임시 계산"인가. true 면 비중·한도 판정을 확정으로 표시하면 안 된다
   * — 예수금이 얼마냐에 따라 총자산이 커져 비중이 내려갈 수 있기 때문이다.
   */
  estimated: boolean;
  totalAssetValue: number;
  safePct: number;
  riskPct: number;
  /** 위험자산을 매도해 비위험자산/예수금으로 옮길 때 필요한 금액(총자산 불변) */
  reduceRiskBy: number;
  /** 위험자산을 그대로 두고 비위험자산·예수금을 새로 넣어 맞출 때 필요한 금액(총자산 증가) */
  addNonRiskBy: number;
  /** 퇴직연금 분류 미확인이라 위험자산으로 계산한 평가액 */
  unclassifiedValue: number;
  /** 한도 초과 여부 (저장을 막지는 않는다) */
  exceeded: boolean;
}

export function checkSafeAssetValueLimit(
  accountId: AccountId,
  rows: readonly SafeAssetValueRow[],
  /** 실제 예수금. undefined = 아직 한 번도 입력하지 않음 → 0으로 보되 결과를 "추정"으로 표시한다 */
  cashBalance: number | undefined,
  library: readonly RiskClassLibEntry[],
): SafeAssetValueCheck {
  const lookup = makeLookup(library);
  let safeValue = 0;
  let riskValue = 0;
  let unclassifiedValue = 0;
  for (const r of rows) {
    const value = r.value || 0;
    if (value <= 0) continue;
    const { riskClass, source } = resolveRetirementRiskClass(lookup(r.assetId, r.etfName));
    if (riskClass === "nonRisk") safeValue += value;
    else riskValue += value;
    if (source === "unknown") unclassifiedValue += value;
  }
  const cashEntered = cashBalance !== undefined;
  const cash = Math.max(0, cashBalance || 0);
  const totalAssetValue = safeValue + riskValue + cash;
  const riskPct = totalAssetValue > 0 ? riskValue / totalAssetValue * 100 : 0;
  const limit = MAX_RISK_ASSET_PCT / 100;
  const required = requiresSafeAssetMinimum(accountId);
  return {
    required,
    safeValue, riskValue, cashBalance: cash, cashEntered,
    estimated: required && !cashEntered && totalAssetValue > 0,
    totalAssetValue,
    safePct: Math.round((100 - riskPct) * 1000) / 1000,
    riskPct: Math.round(riskPct * 1000) / 1000,
    reduceRiskBy: Math.max(0, Math.ceil(riskValue - totalAssetValue * limit)),
    addNonRiskBy: Math.max(0, Math.ceil(riskValue / limit - totalAssetValue)),
    unclassifiedValue,
    exceeded: required && totalAssetValue > 0
      && riskValue > totalAssetValue * limit + 1e-6,
  };
}
