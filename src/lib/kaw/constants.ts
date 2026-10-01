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
  cash:  "429000",
};
