export type AssetKey =
  | "us" | "kr" | "cn" | "in" | "gold" | "ust10" | "ust30" | "ktb30" | "cash";

export const ASSET_GROUPS: Record<AssetKey, { group: string; label: string; defaultEtf: string }> = {
  us:    { group: "주식",     label: "미국 주식(UH)",   defaultEtf: "KODEX 미국S&P500TR" },
  kr:    { group: "주식",     label: "한국 주식",        defaultEtf: "KOSEF 200TR" },
  cn:    { group: "주식",     label: "중국 주식(UH)",   defaultEtf: "KODEX 차이나CSI300" },
  in:    { group: "주식",     label: "인도(UH)",         defaultEtf: "KODEX 인도Nifty50" },
  gold:  { group: "대체투자", label: "금(UH)",           defaultEtf: "ACE KRX 금현물" },
  ust10: { group: "국채",     label: "미국채 10년(UH)",  defaultEtf: "KODEX 미국채 10년선물" },
  ust30: { group: "국채",     label: "미국채 30년(H)",   defaultEtf: "ACE 미국30년국채액티브(H)" },
  ktb30: { group: "국채",     label: "국고채 30년",      defaultEtf: "KBSTAR KIS국고채30년 Enhanced" },
  cash:  { group: "현금성자산", label: "현금성자산",     defaultEtf: "TIGER KOFR금리액티브(합성)" },
};

export const ASSET_ORDER: AssetKey[] = ["us","kr","cn","in","gold","ust10","ust30","ktb30","cash"];

export type ProfileKey = "MP" | "growth" | "neutral" | "stable";

export const PROFILE_LABELS: Record<ProfileKey, string> = {
  MP: "MP", growth: "성장형", neutral: "중립형", stable: "안정형",
};

export const PROFILE_PRESETS: Record<ProfileKey, Record<AssetKey, number>> = {
  MP:      { us:25,   kr:8, cn:8.5, in:8.5, gold:20, ust10:7.5, ust30:7.5, ktb30:15, cash:0 },
  growth:  { us:24,   kr:8, cn:8,   in:8,   gold:19, ust10:7,   ust30:7,   ktb30:14, cash:5 },
  neutral: { us:20,   kr:6, cn:7,   in:7,   gold:16, ust10:6,   ust30:6,   ktb30:12, cash:20 },
  stable:  { us:15,   kr:5, cn:5,   in:5,   gold:12, ust10:4.5, ust30:4.5, ktb30:9,  cash:40 },
};

export const ACCOUNT_IDS = ["retirement","isa","pension","irp","etc"] as const;
export type AccountId = typeof ACCOUNT_IDS[number];
export const ACCOUNT_LABELS: Record<AccountId,string> = {
  retirement: "퇴직연금", isa: "ISA", pension: "연금저축", irp: "IRP", etc: "기타",
};

export const GROUP_COLORS: Record<string,string> = {
  "주식": "oklch(0.62 0.18 250)",
  "대체투자": "oklch(0.75 0.16 75)",
  "국채": "oklch(0.55 0.14 160)",
  "현금성자산": "oklch(0.65 0.05 250)",
};
