export type AssetKey =
  | "us" | "kr" | "cn" | "in" | "gold" | "ust10" | "ust30" | "ktb30" | "cash";

export const ASSET_GROUPS: Record<AssetKey, { group: string; label: string; defaultEtf: string }> = {
  us:    { group: "주식",       label: "미국 주식(UH)",   defaultEtf: "TIGER 미국S&P500" },
  kr:    { group: "주식",       label: "한국 주식",        defaultEtf: "KIWOOM 200TR" },
  cn:    { group: "주식",       label: "중국 주식(UH)",   defaultEtf: "KODEX 차이나CSI300" },
  in:    { group: "주식",       label: "인도(UH)",         defaultEtf: "KODEX 인도Nifty50" },
  gold:  { group: "대체투자",   label: "금(UH)",           defaultEtf: "TIGER KRX 금현물" },
  ust10: { group: "안전자산",   label: "미국채 10년(UH)",  defaultEtf: "ACE 미국10년국채액티브" },
  ust30: { group: "안전자산",   label: "미국채 30년(H)",   defaultEtf: "KODEX 미국30년국채액티브(H)" },
  ktb30: { group: "안전자산",   label: "국고채 30년",      defaultEtf: "RISE KIS국고채30년Enhanced" },
  cash:  { group: "현금성자산", label: "현금성자산",       defaultEtf: "TIGER KOFR금리액티브(합성)" },
};

export const ASSET_ORDER: AssetKey[] = ["us","kr","cn","in","gold","ust10","ust30","ktb30","cash"];

// MP 제거, custom 추가
export type ProfileKey = "growth" | "neutral" | "stable" | "custom";

export const PROFILE_LABELS: Record<ProfileKey, string> = {
  growth: "성장형", neutral: "중립형", stable: "안정형", custom: "커스텀",
};

export const PROFILE_PRESETS: Record<ProfileKey, Record<AssetKey, number>> = {
  growth:  { us:24,   kr:8,   cn:8,   in:8,   gold:19,  ust10:7,   ust30:7,   ktb30:14, cash:5  },
  neutral: { us:20,   kr:6,   cn:7,   in:7,   gold:16,  ust10:6,   ust30:6,   ktb30:12, cash:20 },
  stable:  { us:15,   kr:5,   cn:5,   in:5,   gold:12,  ust10:4.5, ust30:4.5, ktb30:9,  cash:40 },
  custom:  { us:0,    kr:0,   cn:0,   in:0,   gold:0,   ust10:0,   ust30:0,   ktb30:0,  cash:0  },
};

export const ACCOUNT_IDS = ["retirement","isa","pension","irp"] as const;
export type AccountId = typeof ACCOUNT_IDS[number];
export const ACCOUNT_LABELS: Record<AccountId,string> = {
  retirement: "퇴직연금", isa: "ISA계좌", pension: "연금저축펀드", irp: "IRP계좌",
};
export const ACCOUNT_LABELS_SHORT: Record<AccountId,string> = {
  retirement: "퇴직연금", isa: "ISA", pension: "연금저축", irp: "IRP",
};

// 계좌별 월 불입액(이번 달 불입액) 기본값. 매달 금액이 고정된 계좌는 여기에 적어두면
// 새 계좌·빈 값일 때 자동으로 채워진다. 0은 "매달 금액이 들쭉날쭉하니 직접 입력" 의미.
export const DEFAULT_MONTHLY_DEPOSIT: Record<AccountId, number> = {
  retirement: 0, isa: 0, pension: 0, irp: 250000,
};

// ── 정기납입 스케줄 **최초 생성용 seed** ────────────────────────────────────
// 런타임 폴백이 아니다. 계좌에 스케줄이 아직 없을 때 **한 번** 만들 때만 쓰고, 그 뒤로는
// 계좌 데이터(`AccountState.contributionSchedule`)에 저장된 사용자 설정이 유일한 근거다.
// **금액은 여기에 적지 않는다** — 최초 생성 시 그 계좌의 기존 `deposit`(사용자가 입력해둔
// 월 납입액)을 첫 금액 버전으로 옮긴다. 금액을 코드에 박아두면 매년 바뀌는 퇴직연금
// 납입액을 코드 수정 없이 관리할 수 없다.
//
// timing: 퇴직연금만 "after_close" — 25일 **저녁**에 입금되어 그 날 장중에는 쓸 수 없고,
// 25일 이후 첫 거래 가능일부터 매수할 수 있다. 나머지는 25일 자동이체("same_day").
// ISA 는 정기납입이 없어 비활성으로 만든다(사용자가 설정에서 켤 수 있다).
export const CONTRIBUTION_SCHEDULE_SEED: Record<
  AccountId,
  { dayOfMonth: number; timing: "same_day" | "after_close"; enabled: boolean }
> = {
  retirement: { dayOfMonth: 25, timing: "after_close", enabled: true },
  isa:        { dayOfMonth: 25, timing: "same_day",    enabled: false },
  pension:    { dayOfMonth: 25, timing: "same_day",    enabled: true },
  irp:        { dayOfMonth: 25, timing: "same_day",    enabled: true },
};

export const GROUP_COLORS: Record<string,string> = {
  "주식":       "oklch(0.62 0.18 250)",
  "대체투자":   "oklch(0.75 0.16 75)",
  "안전자산":   "oklch(0.55 0.14 160)",
  "현금성자산": "oklch(0.65 0.05 250)",
};

// 내장 자산의 KRX 6자리 종목코드. 서버(Worker) 전용 모듈에서도 써야 해서 store.ts가 아니라
// 여기(React 의존성 없는 공용 모듈)에 둔다. store.ts는 호환을 위해 그대로 재export한다.
export const BUILTIN_TICKERS: Partial<Record<AssetKey, string>> = {
  us:    "360750",
  kr:    "294400",
  cn:    "283580",
  in:    "453810",
  gold:  "0072R0",
  ust10: "0085P0",
  ust30: "484790",
  ktb30: "385560",
  cash:  "449170",   // TIGER KOFR금리액티브(합성). 예전에 429000으로 잘못 적혀 있었다(상장코드는 449170).
};

// ── 연금계좌 위험자산 한도 규칙 ─────────────────────────────────────────────
// 퇴직연금(DC)·IRP는 위험자산 투자한도 70%(= 비위험자산 최소 30%) 규제를 받는다.
// ISA·연금저축펀드에는 이 규칙이 없다.
export const MIN_SAFE_ASSET_PCT = 30;
export const MAX_RISK_ASSET_PCT = 100 - MIN_SAFE_ASSET_PCT;
export const SAFE_ASSET_MIN_ACCOUNTS: readonly AccountId[] = ["retirement", "irp"];

// 퇴직연금 위험자산 분류. 판정 근거는 아래 두 가지뿐이다:
//   1) AssetDef.retirementRiskClass — 종목별 명시값(설정 → 종목 설정에서 지정)
//   2) VERIFIED_RETIREMENT_RISK_CLASS — 검증된 종목코드별 분류표
// 둘 다 없으면 unknown 이다. unknown 은 계산에서만 보수적으로 위험자산으로 보고,
// 화면에는 "퇴직연금 분류 미확인"으로 드러낸다.
//
// 자산 group 은 UI 분류와 "새 종목 추가 시 기본 추천값" 용도로만 쓴다.
// 안전자산·현금성자산 그룹이라는 이유만으로 nonRisk 로 자동 확정하지 않는다.
export type RetirementRiskClass = "risk" | "nonRisk";

// ── 검증된 종목코드별 분류표 ────────────────────────────────────────────────
// 현재 4개 계좌에서 실제 보유·목표비중에 쓰이는 종목만 등록한다. 여기 없는 종목은
// unknown(= 퇴직연금 분류 미확인)이며, 쓰기 시작할 때 설정 → 종목 설정에서 지정하면 된다.
//
// 규정이나 상품 분류가 바뀔 수 있으므로 **언제 어떤 근거로 확정했는지**를 값에 같이 남긴다
// (`source` / `verifiedAt`). 추정으로 채우지 않는다 — 근거를 한 줄로 쓸 수 없으면 넣지 않는다.
// 분류가 바뀌면 그 종목의 source/verifiedAt을 갱신한다.
// 키는 KRX 종목코드(대문자).
export interface VerifiedRiskClassEntry {
  riskClass: RetirementRiskClass;
  /** 확정 당시의 ETF명 — 종목코드가 가리키는 상품이 맞는지 나중에 대조하기 위해 남긴다 */
  etfName: string;
  /** 이 분류를 확정한 근거 (한 줄) */
  source: string;
  /** 확정일 YYYY-MM-DD */
  verifiedAt: string;
}

export const VERIFIED_RETIREMENT_RISK_CLASS: Record<string, VerifiedRiskClassEntry> = {
  // ── 비위험자산 (퇴직연금 100% 투자 가능으로 확인) ──
  "0162Z0": {
    riskClass: "nonRisk", etfName: "RISE 삼성전자SK하이닉스채권혼합",
    source: "채권혼합형. 운용 중인 퇴직연금 계좌에서 안전자산 30% 충족분으로 보유 중임을 사용자가 확인",
    verifiedAt: "2026-10-01",
  },
  "438080": {
    riskClass: "nonRisk", etfName: "ACE 미국S&P500미국채혼합50액티브",
    source: "채권혼합형. 운용 중인 퇴직연금·IRP 계좌에서 안전자산 30% 충족분으로 보유 중임을 사용자가 확인",
    verifiedAt: "2026-10-01",
  },
  // ── 위험자산 (주식형·상품) ──
  "360750": {
    riskClass: "risk", etfName: "TIGER 미국S&P500",
    source: "주식형(미국 S&P500 지수).", verifiedAt: "2026-10-01",
  },
  "0167A0": {
    riskClass: "risk", etfName: "SOL AI반도체TOP2플러스",
    source: "주식형(국내 반도체 종목).", verifiedAt: "2026-10-01",
  },
  "0181B0": {
    riskClass: "risk", etfName: "HANARO 미국AI메모리반도체 TOP4+",
    source: "주식형(미국 반도체 종목).", verifiedAt: "2026-10-01",
  },
  "0072R0": {
    riskClass: "risk", etfName: "TIGER KRX 금현물",
    source: "상품(금 현물). 안전자산으로 보지 않는다.", verifiedAt: "2026-10-01",
  },
};

// ── 그룹별 기본 추천값 (판정 아님) ──────────────────────────────────────────
// "미확인" 상태에서 사용자가 분류 버튼을 처음 눌렀을 때 어느 값부터 제안할지에만 쓴다.
// 이 값으로 자동 확정되는 경로는 없다.
export const RETIREMENT_RISK_CLASS_RECOMMENDATION_BY_GROUP: Record<string, RetirementRiskClass> = {
  "주식":       "risk",
  "대체투자":   "risk",
  "안전자산":   "nonRisk",
  "현금성자산": "nonRisk",
};
