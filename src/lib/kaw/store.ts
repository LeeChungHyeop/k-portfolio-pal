import { useEffect, useState, useCallback } from "react";
import { ASSET_ORDER, ASSET_GROUPS, PROFILE_PRESETS, ACCOUNT_IDS, BUILTIN_TICKERS, DEFAULT_MONTHLY_DEPOSIT, CONTRIBUTION_SCHEDULE_SEED, type AccountId, type AssetKey, type ProfileKey, type RetirementRiskClass } from "./constants";
import { loadFamilyData, SESSION_AUTH_KEY, SESSION_TOKEN_KEY, getSessionToken, clearSessionProfile } from "./auth";
import {
  buildMigratedCashflows, periodOf,
  type CashflowEntry,
} from "./cashflow";
import { verifiedCashflowsFor } from "./verified-cashflows";
import { kstDateString, kstMonthString } from "./snapshot";
import {
  confirmContribution, upsertAmountVersion, createInitialSchedule,
  type RecurringContributionSchedule, type ContributionAmountVersion,
} from "./contribution";
import type { RebalanceSessionMirror } from "./rebalance-journal";
import { createWriteQueue } from "./write-queue";
import { isRevisionGuardEnabled } from "./rebalance-feature-flags";
import {
  applySavedRevisions, canGuard, conflictPrompt, revisionsFromRows,
  type ConflictPrompt, type ExpectedRevisions, type GuardConflict,
} from "./revision-guard";

// 액세스 코드: 환경변수에 없으면 "soye" 고정
export const ACCESS_CODE: string = import.meta.env.VITE_ACCESS_CODE || "soye";

// Supabase에는 이제 서버(Cloudflare Worker)만 접속한다. 브라우저는 /api/* 만 호출.
export const hasSupabase = true;

// ── Types ──────────────────────────────────────────────────────────────────
export interface Holding { assetKey: AssetKey; etfName: string; value: number; }
export interface HistoryEntry {
  id: string;
  date: string;
  baseAmount: number;
  totalValue: number;
  deposit: number;
  // 리밸런싱 확정 당시의 실제 예수금(증권계좌 현금잔액). 이 필드가 생기기 전 기록에는 없다.
  // 과거 기록의 baseAmount - totalValue 를 예수금으로 역산하면 안 된다 — 그 값은 예전
  // 계산식(보유금액 + 불입액)에서 나온 가상값이다.
  cashBalance?: number;
  returnPct: number | null;
  holdings?: Partial<Record<AssetKey, number>>;
  // 리밸런싱 당시 종목별 스냅샷 (rowId 기반)
  rowHoldingsSnap?: Record<string, number>;   // rowId → KRW 평가금액
  rowQuantitiesSnap?: Record<string, number>; // rowId → 보유수량
  rowEtfSnap?: Record<string, string>;        // rowId → ETF명
  rowLabelSnap?: Record<string, string>;      // rowId → 자산명
  rowAssetSnap?: Record<string, string>;      // rowId → assetId (행 삭제 후 같은 자산 재추가 시 보유수량 복원용)
  // "성장형(케이올웨더)으로 쭉 운용했다면" 백테스트 스냅샷 — 리밸런싱 시점에 계산해 영구 저장
  // 코스피200/S&P500도 같은 방식(매 납입 시점에 그 지수를 샀다면)으로 계산 — kospiUnits/sp500Units는 실시간 "현재" 포인트 계산용 보유 유닛 스냅샷
  backtestGrowth?: {
    totalValue: number; returnPct: number | null; units: Partial<Record<AssetKey, number>>;
    kospi200Pct: number | null; sp500Pct: number | null;
    // 위 수익률과 같은 계산에서 나온 정확한 평가액(현금 포함). 금액 비교 차트는 이 값을 쓴다 —
    // 반올림된 Pct 에서 역산하지 않는다 (backtest.ts v6). v5 이전 저장값에는 없다.
    kospi200Value?: number | null; sp500Value?: number | null;
    kospiUnits: number; sp500Units: number;
    kospiSafeUnits: number; sp500SafeUnits: number;
    schemaVersion: number;
    // 계산에 쓴 cashflow 장부의 지문. 지금 장부와 다르면 같은 schemaVersion 이어도 재계산된다
    // (backtest.ts cashflowFingerprint / needsBacktestRecompute).
    cashflowKey?: string;
  };
}
export interface AssetRowDef {
  id: string;
  assetKey: AssetKey;
  etfName: string;
}
// Global asset library entry
export interface AssetDef {
  id: string;
  group: string;
  label: string;
  defaultEtf: string;
  isBuiltIn: boolean;
  ticker?: string; // KRX 6자리 종목코드 (KIS API용)
  // 퇴직연금·IRP 위험자산 한도(70%) 계산용 분류. 종목별 명시값이며 최우선 근거다.
  // 없으면 검증된 종목코드 분류표(VERIFIED_RETIREMENT_RISK_CLASS)를 보고, 거기에도 없으면
  // "미확인"으로 두고 계산에서만 보수적으로 위험자산으로 센다 — group 으로 추정하지 않는다.
  retirementRiskClass?: RetirementRiskClass;
}
// Per-profile, per-account row
export interface ProfileRowDef {
  id: string;
  assetId: string;
  etfName?: string;
}
export interface AccountState {
  // Per-account settings
  active: boolean;
  profile: ProfileKey;
  accountAllocations: Record<ProfileKey, Record<AssetKey, number>>;
  etfNames: Record<AssetKey, string>;
  enabledAssets: AssetKey[];
  // Legacy row-based (kept for backwards compat)
  assetRows?: AssetRowDef[];
  rowAllocations?: Record<ProfileKey, Record<string, number>>;
  // Per-profile rows (new)
  profileRows?: Record<ProfileKey, ProfileRowDef[]>;
  profileAllocations?: Record<ProfileKey, Record<string, number>>;
  // Data
  baseAmount: number;
  deposit: number;
  // 실제 예수금(증권계좌의 현금잔액). 사용자가 직접 입력하는 1급 영속 상태다.
  // ETF 평가액에서 역산하지 않는다 — 주가가 움직여도 이 값은 변하지 않아야 한다.
  // 외부 증권사 API 연동은 없으므로 자동으로 채워지는 경로도 없다.
  // 한 번도 입력하지 않은 계좌는 undefined 이며, 그 경우 0으로 취급한다(추정하지 않는다).
  cashBalance?: number;
  // 외부 입출금 장부. **누적 납입원금의 유일한 근거**다 (= amount 합).
  // cashBalance 를 여기에 더하지 않는다 — 예수금은 이미 납입된 돈의 현재 형태일 뿐이다.
  // 기존 데이터는 hydration 때 history 에서 무손실 복원된다(cashflow.ts buildMigratedCashflows).
  cashflows?: CashflowEntry[];
  // 정기납입 스케줄(예정값). 실제 입금은 사용자가 "입금 확인"을 눌러야 cashflows 에 들어간다.
  // 금액은 effectiveFrom + amount 버전으로 쌓아 과거 월의 계산이 변하지 않게 한다.
  contributionSchedule?: RecurringContributionSchedule;
  rebalanceDate: string;
  holdings: Holding[];
  rowHoldings?: Record<string, number>;  // row instance ID → current market value
  rowMemos?: Record<string, string>;     // key: `${profileKey}:${rowId}`
  liveQuantities?: Record<string, number>; // rowId → 보유수량 (실시간 계산용, 영속화)
  // 진행 중 리밸런싱 세션의 **mirror**. 정본은 StoreState 밖 dedicated journal 이다
  // (rebalance-journal.ts) — 이 필드는 기기 간 동기화·화면 상태용이고, 원격 폴링이
  // memState 를 통째로 교체할 때 지워질 수 있다. PRE 를 이 값만 믿고 쓰지 않는다.
  rebalanceSession?: RebalanceSessionMirror;
  history: HistoryEntry[];
}
export interface StoreState {
  // Global fallback (used for migration only)
  profile: ProfileKey;
  allocations: Record<ProfileKey, Record<AssetKey, number>>;
  accounts: Record<AccountId, AccountState>;
  assetLibrary?: AssetDef[];
}

// ── Built-in ticker codes (KRX 6자리) ─────────────────────────────────────
// 정의는 constants.ts로 옮겼다(서버 전용 모듈도 써야 해서). 기존 import 경로 호환용 재export.
export { BUILTIN_TICKERS } from "./constants";

// ── Global asset library helper ────────────────────────────────────────────
export function getOrDefaultLibrary(state: StoreState): AssetDef[] {
  if (state.assetLibrary?.length) {
    // 기존 라이브러리에 ticker가 없는 내장 종목은 BUILTIN_TICKERS로 자동 보완
    return state.assetLibrary.map((d) => {
      if (d.ticker) return d;
      const builtinTicker = BUILTIN_TICKERS[d.id as AssetKey];
      return builtinTicker ? { ...d, ticker: builtinTicker } : d;
    });
  }
  return ASSET_ORDER.map((k) => ({
    id: k,
    group: ASSET_GROUPS[k].group,
    label: ASSET_GROUPS[k].label,
    defaultEtf: ASSET_GROUPS[k].defaultEtf,
    ticker: BUILTIN_TICKERS[k],
    isBuiltIn: true,
  }));
}

// ── Per-account helpers (exported) ─────────────────────────────────────────
export function getAccountAlloc(state: StoreState, id: AccountId): Record<AssetKey, number> {
  const acc = state.accounts[id];
  const profile = acc.profile ?? state.profile;
  const allocs = acc.accountAllocations ?? state.allocations;
  return allocs[profile] ?? state.allocations[profile] ?? PROFILE_PRESETS[profile];
}
export function getAccountEnabledAssets(acc: AccountState): AssetKey[] {
  return acc.enabledAssets?.length ? acc.enabledAssets : [...ASSET_ORDER];
}
export function getAccountEtfName(acc: AccountState, key: AssetKey): string {
  return acc.etfNames?.[key] ?? ASSET_GROUPS[key].defaultEtf;
}

// ── Storage Keys ───────────────────────────────────────────────────────────
const AUTH_CODE_KEY = "kaw.family_code";
const AUTH_USER_KEY = "kaw.user_profile";
const LEGACY_STORE_KEY = "kaw.v2";
const storeKey = (code: string, u: string) => `kaw.v2.${code}.${u}`;

// ── Seed History ───────────────────────────────────────────────────────────
type SeedEntry = { date: string; totalValue: number; baseAmount: number; deposit: number; holdings: Partial<Record<AssetKey, number>> };

const SEED_HISTORY: Record<AccountId, SeedEntry[]> = {
  retirement: [
    {date:"2025-09-10",totalValue:65140328,baseAmount:65177647,deposit:0,holdings:{us:15660000,kr:5212730,cn:5208000,in:5209488,gold:12404340,ust10:4557660,ust30:4561605,ktb30:9146220,cash:3180285}},
    {date:"2025-09-26",totalValue:67914385,baseAmount:67783181,deposit:580423,holdings:{us:16377655,kr:5385600,cn:5425875,in:5427740,gold:12902310,ust10:4750515,ust30:4738380,ktb30:9502200,cash:3404110}},
    {date:"2025-10-22",totalValue:71722670,baseAmount:71963605,deposit:580423,holdings:{us:17351440,kr:5817955,cn:5766215,in:5692980,gold:13542795,ust10:5030280,ust30:5027050,ktb30:9972675,cash:3521280}},
    {date:"2025-11-27",totalValue:72627526,baseAmount:72528069,deposit:580423,holdings:{us:17455490,kr:5839680,cn:5829120,in:5794650,gold:13799460,ust10:5085630,ust30:5071010,ktb30:10135785,cash:3616701}},
    {date:"2025-12-29",totalValue:74090820,baseAmount:74239091,deposit:580423,holdings:{us:17815910,kr:5990320,cn:5936680,in:5925150,gold:14132475,ust10:5195520,ust30:4972305,ktb30:10387900,cash:3734560}},
    {date:"2026-01-26",totalValue:77657550,baseAmount:77940393,deposit:688074,holdings:{us:18691660,kr:6274950,cn:6237050,in:6234295,gold:14830830,ust10:5447680,ust30:5459040,ktb30:10630470,cash:3851575}},
    {date:"2026-01-30",totalValue:79225315,baseAmount:79562094,deposit:0,holdings:{us:19131750,kr:6362685,cn:6359340,in:6380040,gold:15146650,ust10:5567535,ust30:5566520,ktb30:10747555,cash:3963240}},
    {date:"2026-02-26",totalValue:79835793,baseAmount:79882422,deposit:688074,holdings:{us:19159000,kr:6549660,cn:6377140,in:6376720,gold:15232320,ust10:5602050,ust30:5587713,ktb30:10980750,cash:3970440}},
    {date:"2026-03-25",totalValue:78172300,baseAmount:77912821,deposit:688074,holdings:{us:18697770,kr:6299925,cn:6248840,in:6243845,gold:14886035,ust10:5460900,ust30:5460900,ktb30:11007040,cash:3867045}},
    {date:"2026-04-27",totalValue:81788815,baseAmount:81710711,deposit:688074,holdings:{us:19597545,kr:6583750,cn:6538430,in:6527800,gold:15529500,ust10:5700285,ust30:5744340,ktb30:11469970,cash:4097195}},
  ],
  isa: [
    {date:"2026-01-26",totalValue:9157893,baseAmount:9169961,deposit:0,holdings:{us:4550688,gold:910575,ust30:1826550}},
    {date:"2026-02-26",totalValue:13136980,baseAmount:13151371,deposit:4000000,holdings:{us:4608820,kr:4604840,gold:1286685,ust30:1317650}},
    {date:"2026-03-17",totalValue:13028473,baseAmount:13036656,deposit:0,holdings:{us:3189525,kr:1119600,cn:1041920,in:1004250,gold:2484300,ust10:915600,ust30:911768,ktb30:1809360,cash:552150}},
    {date:"2026-03-26",totalValue:15679710,baseAmount:15682299,deposit:3000000,holdings:{us:3769920,kr:1297080,cn:1256100,in:1243130,gold:2973950,ust10:1095000,ust30:1096830,ktb30:2174200,cash:773500}},
    {date:"2026-04-17",totalValue:57727397,baseAmount:57732973,deposit:41406117,holdings:{us:13856500,kr:4676090,cn:4611870,in:4563000,gold:10970015,ust10:4040625,ust30:4036200,ktb30:8095625,cash:2877472}},
    {date:"2026-05-12",totalValue:59165980,baseAmount:59164398,deposit:0,holdings:{us:14204680,kr:14243680,gold:11235000,ust10:4137030,ust30:4140900,ktb30:11204690}},
  ],
  pension: [
    {date:"2025-10-22",totalValue:5997172,baseAmount:6000000,deposit:0,holdings:{us:1486570,kr:445830,cn:476160,in:483480,gold:1138210,ust10:419055,ust30:416852,ktb30:800580,cash:330435}},
    {date:"2025-12-29",totalValue:6090987,baseAmount:6091233,deposit:0,holdings:{us:1531090,kr:471540,cn:490880,in:481270,gold:1172375,ust10:411333,ust30:417924,ktb30:785070,cash:329505}},
    {date:"2026-01-26",totalValue:6799475,baseAmount:6803836,deposit:500000,holdings:{us:1634160,kr:571860,cn:535670,in:538800,gold:1289925,ust10:478350,ust30:472495,ktb30:948080,cash:330135}},
    {date:"2026-01-30",totalValue:6940810,baseAmount:6933756,deposit:0,holdings:{us:1705680,kr:608130,cn:537030,in:539400,gold:1329620,ust10:471825,ust30:482900,ktb30:935970,cash:330255}},
    {date:"2026-02-26",totalValue:7435860,baseAmount:7444743,deposit:500000,holdings:{us:1838625,kr:609225,cn:600210,in:540200,gold:1412875,ust10:516950,ust30:523450,ktb30:1063440,cash:330885}},
    {date:"2026-03-25",totalValue:7723010,baseAmount:7725385,deposit:500000,holdings:{us:1867700,kr:664290,cn:618150,in:619850,gold:1472500,ust10:545000,ust30:540020,ktb30:1064030,cash:331470}},
    {date:"2026-04-27",totalValue:8515925,baseAmount:8521210,deposit:500000,holdings:{us:2048670,kr:783030,cn:682445,in:663000,gold:1624700,ust10:591800,ust30:540640,ktb30:1138680,cash:442960}},
  ],
  irp: [
    {date:"2025-12-29",totalValue:3104050,baseAmount:3000000,deposit:0,holdings:{us:792480,kr:284340,cn:236925,in:242370,gold:605340,ust10:212300,ust30:213960,ktb30:406290,cash:110045}},
    {date:"2026-02-26",totalValue:3172840,baseAmount:3177607,deposit:0,holdings:{us:784480,kr:365550,cn:236850,in:243270,gold:603630,ust10:211100,ust30:216600,ktb30:401070,cash:110290}},
    {date:"2026-03-25",totalValue:3953507,baseAmount:3951597,deposit:750000,holdings:{us:971990,kr:261310,cn:315875,in:318875,gold:753780,ust10:269125,ust30:270382,ktb30:570690,cash:221480}},
  ],
};

function calcReturn(entries: SeedEntry[], i: number) {
  const prev = i > 0 ? entries[i - 1] : null;
  if (!prev || prev.totalValue <= 0) return null;
  return ((entries[i].totalValue - entries[i].deposit) - prev.totalValue) / prev.totalValue * 100;
}
function makeHistory(entries: SeedEntry[]): HistoryEntry[] {
  return entries.map((e, i) => ({ ...e, id: `seed-${e.date}`, returnPct: calcReturn(entries, i) }));
}
function defaultEtfNames(): Record<AssetKey, string> {
  return Object.fromEntries(ASSET_ORDER.map((k) => [k, ASSET_GROUPS[k].defaultEtf])) as Record<AssetKey, string>;
}
function seedHoldings(): Holding[] {
  return ASSET_ORDER.map((k) => ({ assetKey: k, etfName: ASSET_GROUPS[k].defaultEtf, value: 0 }));
}
function baseAccountSettings() {
  return {
    active: true,
    profile: "growth" as ProfileKey,
    accountAllocations: structuredClone(PROFILE_PRESETS),
    etfNames: defaultEtfNames(),
    enabledAssets: [...ASSET_ORDER] as AssetKey[],
  };
}
function seedAccount(id: AccountId): AccountState {
  return {
    ...baseAccountSettings(),
    baseAmount: 0,
    deposit: DEFAULT_MONTHLY_DEPOSIT[id],
    rebalanceDate: kstDateString(),
    holdings: seedHoldings(),
    history: makeHistory(SEED_HISTORY[id] ?? []),
    // 실제 증권사 자료로 확정된 과거 장부(verified-cashflows.ts). seed 에 직접 넣어두는
    // 이유는 `resetAll()` 이 migrateState 를 거치지 않고 seedState() 를 그대로 저장하기
    // 때문이다 — 여기에 없으면 Reset All 뒤 history 에서 복원된 **잘못된 날짜의** 과거
    // cashflow 가 다시 생긴다.
    cashflows: verifiedCashflowsFor(id),
  };
}
/** hyeobi 초기 상태. `resetAll()` 이 그대로 저장하므로 검증된 과거 장부를 포함한다. (테스트용 export) */
export function seedState(): StoreState {
  return { profile: "growth", allocations: structuredClone(PROFILE_PRESETS), accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, seedAccount(id)])) as Record<AccountId, AccountState> };
}
function emptyState(): StoreState {
  return { profile: "growth", allocations: structuredClone(PROFILE_PRESETS), accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, { ...baseAccountSettings(), baseAmount: 0, deposit: DEFAULT_MONTHLY_DEPOSIT[id], rebalanceDate: kstDateString(), holdings: seedHoldings(), history: [] as HistoryEntry[] }])) as Record<AccountId, AccountState> };
}
function recalcReturns(history: HistoryEntry[]): HistoryEntry[] {
  return history.map((h, i) => {
    const prev = i > 0 ? history[i - 1] : null;
    const returnPct = prev && prev.totalValue > 0 ? ((h.totalValue - h.deposit) - prev.totalValue) / prev.totalValue * 100 : null;
    return { ...h, returnPct };
  });
}

/**
 * migrateState 가 "없어서 새로 만든" 영속 대상. hydration 중에 만들어진 값은 아직 DB 에 없으므로
 * 호출자가 memState 를 확정한 뒤 `persistMigrationOnce()` 로 **1회만** 저장한다.
 */
interface MigrationResult {
  createdContributionSchedule: boolean;
}

/**
 * HistoryEntry 1건을 **id 기준 upsert** 한다 (append 가 아니다).
 *
 * 완료 1회의 identity 는 `hist:<completionId>` 이고(completion-envelope.ts), 부분
 * 실패 후 재시도나 완료 버튼 중복 클릭이 같은 id 로 다시 들어온다. append 하면 한
 * 번의 리밸런싱이 히스토리에 2건이 되어 수익률·백테스트 체인까지 어긋난다.
 * 기존 `crypto.randomUUID()` id 는 충돌하지 않으므로 그 경로의 동작은 그대로다.
 *
 * 정렬은 날짜 기준 안정 정렬이고, 교체는 **제자리**다 — 같은 날짜의 다른 기록들
 * 사이에서 순서가 바뀌면 "최신 기록" 판정이 흔들린다.
 */
export function upsertHistoryEntry(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const replaced = history.some((h) => h.id === entry.id);
  const merged = replaced
    ? history.map((h) => (h.id === entry.id ? entry : h))
    : [...history, entry];
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

/** 저장된 상태를 현재 스키마로 올린다. `injectSeed` 는 hyeobi profile 여부다. (테스트용 export) */
export function migrateState(parsed: StoreState, injectSeed = false, out?: MigrationResult): StoreState {
  const seed = seedState();
  // Migrate global MP → growth if leftover
  if ((parsed.profile as string) === "MP") parsed.profile = "growth";

  for (const id of ACCOUNT_IDS) {
    // 계좌가 통째로 없는 경우. hyeobi 가 아니면 seed 의 history 도 검증 장부도 빌려주지
    // 않는다 — 남의 계좌 기록이 섞이면 안 된다. 빈 배열은 "복원 완료(흐름 없음)"를 뜻한다.
    if (!parsed.accounts[id]) { parsed.accounts[id] = injectSeed ? seed.accounts[id] : { ...seed.accounts[id], history: [], cashflows: [] }; continue; }
    const acc = parsed.accounts[id];

    // Inject per-account settings defaults if missing
    if (acc.active === undefined) acc.active = true;
    if (!acc.profile || (acc.profile as string) === "MP") acc.profile = parsed.profile ?? "growth";
    if (!acc.accountAllocations) {
      acc.accountAllocations = structuredClone(PROFILE_PRESETS);
      // Merge legacy global allocations if available
      if (parsed.allocations) {
        for (const pk of Object.keys(parsed.allocations) as ProfileKey[]) {
          if (pk !== "MP" as string) acc.accountAllocations[pk] = { ...PROFILE_PRESETS[pk], ...parsed.allocations[pk] };
        }
      }
    }
    if (!acc.etfNames) acc.etfNames = defaultEtfNames();
    if (!acc.enabledAssets?.length) acc.enabledAssets = [...ASSET_ORDER];
    if (!Array.isArray(acc.holdings)) acc.holdings = [];

    const existing = new Map(acc.holdings.map((h) => [h.assetKey, h]));
    // Sync ETF names from holdings if etfNames not yet set from DB
    for (const [key, h] of existing) {
      if (h.etfName && h.etfName !== ASSET_GROUPS[key].defaultEtf) {
        acc.etfNames[key] = h.etfName;
      }
    }
    acc.holdings = ASSET_ORDER.map((k) => existing.get(k) ?? { assetKey: k, etfName: acc.etfNames[k], value: 0 });

    if (!acc.history?.length) {
      acc.history = injectSeed ? seed.accounts[id].history : [];
    } else if (injectSeed) {
      const seedMap = new Map(seed.accounts[id].history.map((h) => [h.id, h]));
      acc.history = acc.history.map((h) => {
        const s = seedMap.get(h.id);
        if (s && !h.holdings) return { ...s, returnPct: h.returnPct };
        return { ...h, baseAmount: (h as HistoryEntry & { baseAmount?: number }).baseAmount ?? 0 };
      });
    } else {
      acc.history = acc.history.map((h) => ({
        ...h, baseAmount: (h as HistoryEntry & { baseAmount?: number }).baseAmount ?? 0,
      }));
    }
    // 기본 리밸런싱 일자는 **한국시간 기준 오늘**이다. UTC 로 계산하면 KST 00:00~08:59 에
    // 전날 날짜가 들어간다.
    if (!acc.rebalanceDate) acc.rebalanceDate = kstDateString();

    // 월 불입액이 고정된 계좌(IRP 25만원 등)는 값이 없으면 기본값으로 채운다.
    if (!acc.deposit) acc.deposit = DEFAULT_MONTHLY_DEPOSIT[id];
    // IRP 월 불입액이 15만원으로 잘못 저장돼 있던 값 정정 (실제 납입액 25만원)
    if (id === "irp" && acc.deposit === 150000) acc.deposit = DEFAULT_MONTHLY_DEPOSIT.irp;

    // cashBalance(실제 예수금)는 기본값을 만들지 않는다. 기존 데이터에서 추정할 방법이 없으므로
    // 사용자가 처음 입력할 때까지 undefined 로 두고, 화면에서는 0으로만 표시한다.

    // IRP 첫 항목 baseAmount 오류 수정 (3120898 → 3000000)
    if (injectSeed && id === "irp" && acc.history.length > 0 && acc.history[0].id === "seed-2025-12-29" && acc.history[0].baseAmount === 3120898) {
      acc.history = [{ ...acc.history[0], baseAmount: 3000000 }, ...acc.history.slice(1)];
    }

    // 히스토리를 날짜 오름차순으로 정렬 (역순 저장 데이터 대응)
    acc.history = [...acc.history].sort((a, b) => a.date.localeCompare(b.date));

    // cashflow 장부 복원 (1회). 기존 계산식의 두 조각(첫 기록의 baseAmount + 이후 deposit)을
    // 날짜가 붙은 흐름으로 **무손실 재표현**하므로 누적 납입원금은 1원도 달라지지 않는다.
    // 추정은 하지 않는다 — cashBalance 나 baseAmount - totalValue 역산은 넣지 않는다.
    // 빈 배열([])도 "이미 복원됨"으로 보기 때문에 다시 migration 하지 않는다.
    // hyeobi 는 실제 증권사 자료로 확정된 장부(verified-cashflows.ts)를 쓴다. history 에서
    // 복원하면 리밸런싱을 저장한 날이 입금일로 들어가고 빠지는 달도 생긴다.
    // 다른 profile 은 기존 generic 복원을 그대로 유지한다 — 거기엔 검증 자료가 없다.
    if (!Array.isArray(acc.cashflows)) {
      acc.cashflows = injectSeed ? verifiedCashflowsFor(id) : buildMigratedCashflows(acc.history);
    }

    // 정기납입 스케줄 최초 생성 (1회). 금액은 코드에 박지 않고 **이 계좌에 이미 저장된
    // deposit**(사용자가 입력해둔 월 납입액)을 첫 금액 버전으로 옮긴다. 적용 시작월은
    // 생성 시점의 월이므로 그 이전 달은 pending 으로 뜨지 않는다 — 과거를 추정하지 않는다.
    // 만들고 나면 이 블록은 다시 돌지 않고, 이후로는 계좌에 저장된 설정만이 근거다.
    if (!acc.contributionSchedule) {
      acc.contributionSchedule = createInitialSchedule(
        `sched:${id}`,
        CONTRIBUTION_SCHEDULE_SEED[id],
        acc.deposit,
        // 적용 시작월은 **한국시간 기준**이다. UTC 로 계산하면 매월 1일 오전(KST)에 최초
        // hydration 된 계좌의 effectiveFrom 이 이전 달로 생겨, 그 달 정기납입이 pending 으로
        // 뜨고 금액 버전도 한 달 앞당겨 적용된다.
        kstMonthString(),
      );
      // 여기서 바로 저장하지 않는다. 호출자(hydration)가 memState 확정 후 1회만 영속한다.
      if (out) out.createdContributionSchedule = true;
    }

    // Migrate to row-based asset management (legacy)
    if (!acc.assetRows?.length) {
      acc.assetRows = acc.enabledAssets.map((k) => ({
        id: k,
        assetKey: k,
        etfName: acc.etfNames?.[k] ?? ASSET_GROUPS[k].defaultEtf,
      }));
    }
    if (!acc.rowAllocations) {
      const allocs = acc.accountAllocations ?? structuredClone(PROFILE_PRESETS);
      acc.rowAllocations = Object.fromEntries(
        (Object.keys(PROFILE_PRESETS) as ProfileKey[]).map((p) => [
          p,
          Object.fromEntries(acc.assetRows!.map((r) => [r.id, allocs[p]?.[r.assetKey] ?? 0])),
        ])
      ) as Record<ProfileKey, Record<string, number>>;
    }
    // Migrate to profile-specific rows (new)
    if (!acc.profileRows) {
      const baseRows: ProfileRowDef[] = acc.assetRows.map((r) => ({
        id: r.id,
        assetId: r.assetKey,
        etfName: r.etfName,
      }));
      acc.profileRows = {
        growth:  baseRows.map((r) => ({ ...r })),
        neutral: baseRows.map((r) => ({ ...r })),
        stable:  baseRows.map((r) => ({ ...r })),
        custom:  baseRows.map((r) => ({ ...r })),
      };
    }
    if (!acc.profileAllocations) {
      const rAllocs = acc.rowAllocations;
      acc.profileAllocations = {} as Record<ProfileKey, Record<string, number>>;
      for (const p of Object.keys(PROFILE_PRESETS) as ProfileKey[]) {
        acc.profileAllocations[p] = rAllocs?.[p] ? { ...rAllocs[p] } : {};
      }
    }
  }

  // Initialize global asset library
  if (!parsed.assetLibrary?.length) {
    parsed.assetLibrary = ASSET_ORDER.map((k) => ({
      id: k,
      group: ASSET_GROUPS[k].group,
      label: ASSET_GROUPS[k].label,
      defaultEtf: ASSET_GROUPS[k].defaultEtf,
      isBuiltIn: true,
    }));
  } else {
    // Migrate 국채 → 안전자산 in stored library
    for (const d of parsed.assetLibrary) {
      if (d.group === "국채") d.group = "안전자산";
    }
  }

  return parsed;
}

// ── Module-level state ─────────────────────────────────────────────────────
let familyCode: string | null = typeof window !== "undefined" ? localStorage.getItem(AUTH_CODE_KEY) : null;
// currentUser는 sessionStorage 인증 후에만 설정 — localStorage에서 직접 초기화하면 PIN 인증이 우회됨
let currentUser: string = "";
// 가족 코드가 있으면 initFromStorage가 끝날 때까지 로딩 상태로 시작
let dbLoading = typeof window !== "undefined" && !!localStorage.getItem(AUTH_CODE_KEY);
let dbError: string | null = null;
let initialized = false;

// ── 쓰기 revision 가드 상태 (Phase 1B-2B) ───────────────────────────────────
//
// `revisions` 는 **마지막으로 서버에서 읽은** 행별 revision 이다. 저장할 때 같이 보내고,
// 서버가 지금 값과 다르면 거부한다(migration 007). 조회에서 값을 못 받으면(구버전 서버)
// 표에서 그 키가 빠지고 `canGuard()` 가 false 가 되어 가드를 켜지 않는다.
let revisions: ExpectedRevisions | null = null;

/**
 * 해결되지 않은 저장 충돌. **있는 동안 자동저장과 폴링 반영을 모두 멈춘다.**
 *
 *   자동저장을 계속하면  → 같은 409 를 무한히 반복한다(자동 재시도 금지)
 *   폴링을 반영하면      → 아직 저장되지 않은 **사용자 입력을 덮어쓴다**
 *
 * 둘 중 어느 쪽을 버릴지는 사람이 고른다(`reloadFromServer` / `overwriteServerWithLocal`).
 */
export interface DataConflictState {
  conflicts: GuardConflict[];
  prompt: ConflictPrompt;
  at: string;
  /** 서버가 알려준 **현재** revision. 덮어쓰기를 고를 때만 쓴다 */
  serverRevisions: ExpectedRevisions | null;
}
let dbConflict: DataConflictState | null = null;

/**
 * **가드 보류(fail-closed).** 가드가 켜져 있는데 서버에서 읽은 revision 이 없으면
 * 저장을 **하지 않고 멈춘다.**
 *
 * 예전에는 이 경우 무가드 요청으로 강등했는데, 그러면 보호된다고 믿는 상태에서
 * 문서 전체가 last-writer-wins 로 저장된다(다른 기기의 최신 변경이 사라진다).
 * 보류 중에도 **로컬 입력은 그대로 남는다**(localStorage 저장은 계속된다). 복구는
 * 조회로만 — revision 을 다시 받으면 보류가 풀리고 그때 한 번 저장한다.
 */
export interface DataHoldState {
  reason: "revision_unavailable";
  message: string;
  at: string;
}
let dbHold: DataHoldState | null = null;

/**
 * 사용자가 **의도적으로** 기록을 지웠다. 그 다음 저장 1회에 한해 history 축소를 허용한다
 * (migration 007 은 기본적으로 축소를 충돌로 거부한다 — 버그로 비어 온 문서를 막기 위해서다).
 * 저장이 성공할 때까지 유지한다 — 중간에 내려가면 삭제가 영구히 저장되지 못한다.
 */
let allowHistoryShrinkOnce = false;

/**
 * 사용자가 **"지금 화면 내용으로 덮어쓰기"** 를 골랐다. 그 저장 1회에 한해 서버의 현재
 * revision 으로 CAS 를 다시 맞추고 파괴적 변경(키 유실 포함)까지 허용한다.
 * 자동으로 켜지는 경로는 없다 — `overwriteServerWithLocal()` 만 켠다.
 */
let forceOverwriteOnce = false;

/**
 * 사용자가 **초기화/가져오기** 처럼 문서를 통째로 갈아끼우는 행동을 했다. 그 저장 1회는
 * 최상위 키 유실까지 허용한다. 자동저장은 절대 이 값을 켜지 않는다.
 */
let allowKeyLossOnce = false;

let memState: StoreState | null = null;
const listeners = new Set<() => void>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 20_000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// 폴링으로 받아온 데이터를 memState에 반영하는 동안 dbSave가 그 반영 자체를 다시 저장하지 않도록 막는 플래그
let isApplyingRemote = false;

// ── 서버 write 직렬화 ──────────────────────────────────────────────────────
//
// 모든 서버 write(자동저장 dbSave + 완료 ACK write)가 **이 큐 하나**를 지난다.
// `/api/data` 는 계좌 JSON 문서를 통째로 교체하는 last-writer-wins upsert 라서,
// 두 요청이 겹치면 먼저 보낸 오래된 요청이 나중에 도착해 최신 기록을 지울 수 있다
// (재현 경로는 write-queue.ts 상단).
//
// 계좌별로 쪼개지 않는 이유: `dbSave` 는 _meta + _assetLib + **네 계좌 전부**를 한
// 요청으로 보내는 전체 문서 write 다. 계좌별 큐로 나누면 그 요청이 모든 큐에 걸쳐야
// 해서 직렬화가 성립하지 않는다. 대기 비용은 자동저장이 800ms 디바운스로 합쳐지기
// 때문에 실측상 요청 1~2건 수준이다.
const writes = createWriteQueue();

/**
 * 아직 서버에 올라가지 않은 로컬 변경이 있는가. 폴링·가시성 복귀가 이 값을 보고
 * **오래된 서버 상태로 memState 를 덮어쓰지 않는다.**
 *
 * boolean 플래그를 여러 비동기 요청이 각자 true/false 로 뒤집으면, 한 요청이 끝날 때
 * 다른 요청이 아직 비행 중인데도 플래그가 내려가 폴링이 끼어든다. 그래서 **공유
 * in-flight 카운터**(큐)와 대기 중 디바운스 타이머를 같이 본다.
 */
export function hasPendingLocalWrite(): boolean {
  return writes.inFlight() > 0 || saveTimer !== null;
}

function notify() { listeners.forEach((l) => l()); }

// ── Local storage helpers ──────────────────────────────────────────────────
const sharedLibKey = (code: string) => `kaw.v2.${code}._lib`;
function saveSharedLib(code: string, lib: AssetDef[] | undefined) {
  if (!lib || typeof window === "undefined") return;
  try { localStorage.setItem(sharedLibKey(code), JSON.stringify(lib)); } catch {}
}
function loadSharedLib(code: string): AssetDef[] | undefined {
  try {
    const raw = localStorage.getItem(sharedLibKey(code));
    return raw ? JSON.parse(raw) as AssetDef[] : undefined;
  } catch { return undefined; }
}

function saveLocal(state: StoreState) {
  if (typeof window === "undefined" || !currentUser) return;
  const key = familyCode ? storeKey(familyCode, currentUser) : LEGACY_STORE_KEY;
  try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  if (familyCode) saveSharedLib(familyCode, state.assetLibrary);
}

function loadLocal(): StoreState {
  if (typeof window === "undefined" || !currentUser) return emptyState();
  const isSeed = currentUser === "hyeobi";
  if (familyCode) {
    let st: StoreState | null = null;
    try {
      const raw = localStorage.getItem(storeKey(familyCode, currentUser));
      if (raw) st = migrateState(JSON.parse(raw) as StoreState, isSeed, hydrationMigration);
    } catch {}
    if (!st) st = isSeed ? seedState() : emptyState();
    const sharedLib = loadSharedLib(familyCode);
    if (sharedLib?.some(d => !d.isBuiltIn)) st = { ...st, assetLibrary: sharedLib };
    return st;
  }
  try {
    const raw = localStorage.getItem(LEGACY_STORE_KEY);
    if (raw) return migrateState(JSON.parse(raw) as StoreState, true, hydrationMigration);
  } catch {}
  return seedState();
}

// ── DB operations ──────────────────────────────────────────────────────────
interface DbRow { family_code: string; profile: string; account_type: string; data: unknown; updated_at?: string; revision?: number; }

async function dbLoad(code: string, user: string): Promise<StoreState | null> {
  const token = getSessionToken();
  if (!token) return null;
  try {
    const res = await fetch("/api/data", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { clearSessionProfile(); return null; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rows: data } = (await res.json()) as { rows?: DbRow[] };
    // **가드의 입력**이다. 행이 하나도 없어도(신규 프로필) 표는 만들어 둔다 — 그래야
    // "아직 없다고 믿는다"(null)로 CAS 가 성립한다.
    revisions = revisionsFromRows(data ?? [], user);
    if (!data?.length) return null;

    let profileKey: ProfileKey = "growth";
    let allocations = structuredClone(PROFILE_PRESETS);
    let assetLibrary: AssetDef[] | undefined;
    let sharedAssetLibrary: AssetDef[] | undefined;
    const accounts: Partial<Record<AccountId, AccountState>> = {};

    for (const row of data) {
      if ((row as { profile: string }).profile === "_shared" && row.account_type === "_assetLib") {
        sharedAssetLibrary = (row.data as { assetLibrary?: AssetDef[] }).assetLibrary;
      } else if ((row as { profile: string }).profile === user) {
        if (row.account_type === "_meta") {
          const m = row.data as { profile: ProfileKey; allocations: typeof allocations; assetLibrary?: AssetDef[] };
          profileKey = m.profile ?? "growth";
          allocations = m.allocations ?? allocations;
          assetLibrary = m.assetLibrary;
        } else if (ACCOUNT_IDS.includes(row.account_type as AccountId)) {
          accounts[row.account_type as AccountId] = row.data as AccountState;
        }
      }
    }

    const fallback = user === "hyeobi" ? seedState() : emptyState();
    return {
      profile: profileKey,
      allocations,
      assetLibrary: sharedAssetLibrary ?? assetLibrary,
      accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, accounts[id] ?? fallback.accounts[id]])) as Record<AccountId, AccountState>,
    };
  } catch (e) {
    console.error("[kaw] DB load error:", e);
    return null;
  }
}

/**
 * 409 응답을 충돌 상태로 올린다. **자동 재시도도 자동 병합도 하지 않는다**(요구 6).
 *
 * 서버가 알려준 현재 revision 을 `revisions` 에 **반영하지 않는다** — 반영하면 다음
 * 자동저장이 CAS 를 통과해 다른 기기의 최신 변경을 조용히 덮는다. 덮어쓰기는 사용자가
 * `overwriteServerWithLocal()` 로 고를 때만 일어난다.
 */
function markDataConflict(body: { conflicts?: unknown; revisions?: unknown }): void {
  const raw = Array.isArray(body.conflicts) ? (body.conflicts as GuardConflict[]) : [];
  const conflicts: GuardConflict[] = raw.filter(
    (c) => c && typeof c === "object" && typeof (c as GuardConflict).reason === "string",
  );
  dbConflict = {
    conflicts,
    prompt: conflictPrompt(conflicts),
    at: new Date().toISOString(),
    serverRevisions: (body.revisions ?? null) as ExpectedRevisions | null,
  };
  dbError = `저장 충돌: ${dbConflict.prompt.message}`;
  notify();
}

/**
 * 저장을 보류한다. **요청을 보내지 않는다** — 무가드 강등이 금지이기 때문이다.
 * 로컬 입력은 이미 localStorage 에 있고 memState 도 그대로다.
 */
function markRevisionHold(): void {
  if (dbHold) return; // 같은 사유로 메시지를 반복 갱신하지 않는다
  dbHold = {
    reason: "revision_unavailable",
    message:
      "서버의 저장 버전(revision)을 확인하지 못해 저장을 보류했습니다. " +
      "입력한 내용은 이 기기에 남아 있습니다 — 연결이 돌아오면 자동으로 저장합니다.",
    at: new Date().toISOString(),
  };
  dbError = `저장 보류: ${dbHold.message}`;
  notify();
}

/**
 * 보류 복구. **조회만** 한다 — 받아온 계좌 데이터는 쓰지 않는다(아직 저장되지 않은 로컬
 * 입력을 서버 상태로 덮으면 안 된다). revision 을 다시 받으면 보류를 풀고 **그때** 저장을
 * 한 번 예약한다. 복구되기 전에는 자동저장을 재시도하지 않는다.
 */
async function recoverRevisionHold(): Promise<boolean> {
  if (!dbHold || !familyCode || !currentUser) return false;
  await dbLoad(familyCode, currentUser); // revisions 만 갱신된다 (memState 는 건드리지 않는다)
  if (!canGuard(revisions)) return false;
  dbHold = null;
  if (dbError?.startsWith("저장 보류")) dbError = null;
  notify();
  void enqueueFullSave(); // 보류됐던 저장 1회
  return true;
}

/** 가드를 켠 요청에 실어 보낼 필드. 가드가 꺼져 있으면 `{}` 다(= 기존 무가드 요청). */
function guardFields(): Record<string, unknown> {
  if (!isRevisionGuardEnabled() || !canGuard(revisions)) return {};
  return {
    expectedRevisions: revisions,
    // 파괴적 저장은 **사용자가 확인한 경우에만** 허용한다.
    allowHistoryShrink: allowHistoryShrinkOnce || allowKeyLossOnce || forceOverwriteOnce,
    allowKeyLoss: allowKeyLossOnce || forceOverwriteOnce,
  };
}

async function dbSave(code: string, user: string, state: StoreState) {
  const token = getSessionToken();
  if (!token || isApplyingRemote || !user) return;
  // 미해결 충돌·보류가 있는 동안은 **시도하지 않는다** — 같은 실패를 반복하는 자동
  // 재시도가 된다. 보류는 조회로 revision 을 되찾을 때만 풀린다(recoverRevisionHold).
  if (dbConflict || dbHold) return;
  // **fail-closed.** 가드가 켜졌는데 revision 을 모르면 저장을 보류한다 —
  // 무가드 요청으로 강등하지 않는다(그게 바로 가드를 켠 채 덮어쓰는 경로다).
  if (isRevisionGuardEnabled() && !canGuard(revisions)) { markRevisionHold(); return; }
  const now = new Date().toISOString();
  const rows: DbRow[] = [
    { family_code: code, profile: user, account_type: "_meta", data: { profile: state.profile, allocations: state.allocations, assetLibrary: state.assetLibrary }, updated_at: now },
    { family_code: code, profile: "_shared", account_type: "_assetLib", data: { assetLibrary: state.assetLibrary }, updated_at: now },
    ...ACCOUNT_IDS.map((id) => ({ family_code: code, profile: user, account_type: id, data: state.accounts[id], updated_at: now })),
  ];
  const guarded = forceOverwriteOnce;
  try {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rows, ...guardFields() }),
    });
    if (res.status === 401) { clearSessionProfile(); throw new Error("세션이 만료됐어요. 다시 로그인해주세요."); }
    if (res.status === 409) {
      markDataConflict((await res.json().catch(() => ({}))) as { conflicts?: unknown });
      return;
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `HTTP ${res.status}`);
    }
    const ok = (await res.json().catch(() => ({}))) as { revisions?: Record<string, number> };
    revisions = applySavedRevisions(revisions, ok.revisions);
    // 저장이 **성공했을 때만** 1회성 허용을 내린다 — 실패 후에도 유지돼야 재시도가 같은
    // 의도(기록 삭제)를 들고 간다.
    allowHistoryShrinkOnce = false;
    allowKeyLossOnce = false;
    if (guarded) forceOverwriteOnce = false;
    if (dbError?.startsWith("동기화 실패") || dbError?.startsWith("저장 충돌")) { dbError = null; notify(); }
  } catch (e) {
    console.error("[kaw] DB save error:", e);
    dbError = `동기화 실패: ${(e as Error).message}`;
    notify();
  }
}

// ── 전체 상태 저장을 큐에 넣는다 ───────────────────────────────────────────
//
// **payload 시점: 읽기-최신(read-latest).** 큐가 이 작업을 실행하는 순간의 `memState`
// 를 보낸다. 예약 시점 스냅샷을 굳혀 들고 있으면, 그 사이에 확정된 리밸런싱을
// 모르는 오래된 문서가 나중에 서버를 덮는다(write-queue.ts 상단의 R0 사고).
function enqueueFullSave(): Promise<void> {
  if (!familyCode || !currentUser) return Promise.resolve();
  return writes
    .enqueue(async () => {
      if (familyCode && currentUser && memState) {
        await dbSave(familyCode, currentUser, memState);
      }
    })
    .catch((e) => { console.error("[kaw] 저장 큐 실패:", e); });
}

// ── 서버 응답을 돌려주는 단건 write 경로 ───────────────────────────────────
//
// `dbSave` 는 모든 실패를 안에서 삼키고 `void` 를 돌려주며 호출부도 await 하지 않는다
// (finalizeRebalance / addHistory). 그래서 **그 경로로는 결과를 알 수 없다** —
// 예외 부재는 ACK 가 아니다(completion-envelope.ts 상단).
//
// 여기서는 기존 자동저장 로직을 그대로 두고, 계좌 1행만 보내 **서버 응답을 그대로**
// 돌려주는 경로를 따로 둔다. `accepted` 는 서버가 upsert 에 넣은 행 수다 —
// `/api/data` 는 요청 행이 세션과 안 맞아 전부 걸러져도 `ok:true` 를 주므로
// `ok` 만 보면 "거른 것"을 "저장한 것"으로 읽는다.
//
// **다만 이 응답은 durable final-state 확인이 아니다.** 문서 전체 교체 upsert 라서
// 다른 기기의 더 오래된 저장이 뒤에 도착하면 그대로 지워진다. 그래서 호출부는 이것을
// `historyPersistence='confirmed'` 로 승격하지 않는다(rebalance-session.ts
// historyOutcomeOfAck). write accepted 텔레메트리로만 쓴다.
export const ACK_WRITE_TIMEOUT_MS = 15_000;

export type DataWriteAck =
  /** accepted 가 null 이면 **서버가 보고하지 않았다**(구버전 서버) */
  | { ok: true; accepted: number | null }
  | { ok: false; error: string; status?: number; timedOut?: boolean };

async function postAccountRow(
  row: DbRow,
  token: string,
  timeoutMs: number,
): Promise<DataWriteAck> {
  // fetch 는 자체 타임아웃이 없다. 걸어두지 않으면 응답이 안 오는 회선에서 완료
  // 버튼이 무기한 비활성 상태로 남고, 큐 뒤의 저장도 전부 막힌다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      // 단건 write 도 **같은 가드**를 지난다 — 여기만 무가드로 남으면 완료 저장이
      // 가드 바깥으로 빠져나가고, 그게 정확히 보호하려던 기록이다.
      body: JSON.stringify({ rows: [row], ...guardFields() }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      clearSessionProfile();
      return { ok: false, error: "세션이 만료됐어요. 다시 로그인해주세요.", status: 401 };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string; accepted?: unknown; revisions?: Record<string, number>;
      conflicts?: unknown;
    };
    if (res.status === 409) {
      // **ACK 를 주지 않는다.** 호출부는 failed 로 받아 수동 재시도로 간다
      // (rebalance-session.ts historyOutcomeOfAck). 자동 재시도하지 않는다.
      markDataConflict(body);
      return { ok: false, error: "다른 기기에서 먼저 저장된 변경이 있습니다.", status: 409 };
    }
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}`, status: res.status };
    revisions = applySavedRevisions(revisions, body.revisions);
    return { ok: true, accepted: typeof body.accepted === "number" ? body.accepted : null };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `${timeoutMs}ms 안에 응답이 없었습니다` : (e as Error).message,
      ...(aborted ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 계좌 1행을 보내고 서버 응답을 돌려준다.
 *
 * **payload 시점: 예약-고정(frozen).** 지금 이 순간의 계좌 행을 굳혀 큐에 넣는다 —
 * "이 완료의 상태가 서버에 올라갔는가"를 물어야 하므로 실행 시점의 최신값을 읽으면
 * 질문이 달라진다. 큐가 FIFO 라서 이보다 먼저 예약된 자동저장은 먼저 실행되며 그때의
 * 최신 상태(= 이 완료 포함)를 보내고, 뒤에 예약된 자동저장은 이 요청 다음에 실행된다.
 */
export function saveAccountRowWithAck(
  id: AccountId,
  timeoutMs: number = ACK_WRITE_TIMEOUT_MS,
): Promise<DataWriteAck> {
  if (!familyCode || !currentUser || !memState) {
    return Promise.resolve({ ok: false, error: "세션이 없습니다." });
  }
  const token = getSessionToken();
  if (!token) return Promise.resolve({ ok: false, error: "세션 토큰이 없습니다." });
  const row: DbRow = {
    family_code: familyCode, profile: currentUser, account_type: id,
    data: memState.accounts[id], updated_at: new Date().toISOString(),
  };
  return writes
    .enqueue(() => postAccountRow(row, token, timeoutMs))
    .catch((e) => ({ ok: false as const, error: (e as Error).message }));
}

function scheduleSave() {
  if (!familyCode || !currentUser) return;
  if (saveTimer) clearTimeout(saveTimer);
  // 타이머가 살아 있는 동안은 `hasPendingLocalWrite()` 가 true 다 — 플래그를 따로
  // 세우지 않는다(여러 요청이 각자 뒤집으면 폴링이 끼어든다).
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // saveTimer 를 비운 직후 **동기적으로** 큐에 넣는다. enqueue 가 카운터를 바로
    // 올리므로 둘 사이에서 `hasPendingLocalWrite()` 가 false 로 내려가지 않는다.
    void enqueueFullSave();
  }, 800);
}

// ── 저장 충돌 해결 — **사용자 확인 전용** ───────────────────────────────────
//
// 409 는 자동으로 풀 수 없다. 두 선택 모두 무언가를 버리기 때문이다:
//
//   reloadFromServer()         서버 것을 받는다  → **로컬 미저장 입력을 버린다**
//   overwriteServerWithLocal() 내 것을 밀어넣는다 → **서버의 더 새로운 변경을 버린다**
//
// 그래서 둘 다 사용자가 누를 때만 실행된다. 자동 재시도·자동 병합 경로는 없다.

/** 사용자가 기록을 지웠다. 다음 저장 1회만 history 축소를 허용한다. */
export function markIntentionalHistoryShrink(): void {
  allowHistoryShrinkOnce = true;
}

/** 사용자가 초기화/가져오기를 했다. 다음 저장 1회만 키 유실까지 허용한다. */
export function markIntentionalDocumentReplace(): void {
  allowHistoryShrinkOnce = true;
  allowKeyLossOnce = true;
}

/** 지금 미해결 저장 충돌. 있는 동안 자동저장·폴링 반영이 멈춘다. */
export function getDataConflict(): DataConflictState | null {
  return dbConflict;
}

/** 지금 저장 보류(fail-closed). 있는 동안 자동저장이 멈추고 로컬 입력은 유지된다. */
export function getDataHold(): DataHoldState | null {
  return dbHold;
}

/** 보류 복구를 지금 한 번 시도한다(화면의 "다시 시도"). 복구되면 보류됐던 저장이 나간다. */
export function retryHeldSave(): Promise<boolean> {
  return recoverRevisionHold();
}

/**
 * 서버 내용을 받아들인다. **로컬의 미저장 입력은 사라진다** — 사용자가 고른 경우에만.
 */
export async function reloadFromServer(): Promise<boolean> {
  if (!familyCode || !currentUser) return false;
  const state = await dbLoad(familyCode, currentUser);
  if (!state) return false;
  isApplyingRemote = true;
  memState = migrateState(state, currentUser === "hyeobi", hydrationMigration);
  saveLocal(memState);
  isApplyingRemote = false;
  // 서버 것을 받았으므로 로컬이 들고 있던 "의도"(기록 삭제 등)도 함께 버린다.
  allowHistoryShrinkOnce = false;
  allowKeyLossOnce = false;
  forceOverwriteOnce = false;
  dbConflict = null;
  // 서버 조회가 성공했으므로 revision 도 다시 받았다 — 보류도 함께 풀린다.
  if (canGuard(revisions)) dbHold = null;
  if (dbError?.startsWith("저장 충돌") || dbError?.startsWith("저장 보류")) dbError = null;
  notify();
  persistMigrationOnce();
  return true;
}

/**
 * 지금 화면 내용으로 서버를 덮는다. **서버의 더 새로운 변경은 사라진다** —
 * 사용자가 고른 경우에만.
 *
 * 서버의 현재 revision 을 다시 읽어 CAS 를 맞춘다. 가져온 **데이터는 버린다**(덮어쓰기를
 * 고른 것이므로 화면 내용이 정본이다). 그 사이 또 바뀌면 다시 409 가 되고, 그때도
 * 자동으로 반복하지 않는다.
 */
export async function overwriteServerWithLocal(): Promise<boolean> {
  if (!familyCode || !currentUser || !memState) return false;
  const local = memState;
  await dbLoad(familyCode, currentUser); // revisions 갱신 — memState 는 건드리지 않는다
  memState = local;
  forceOverwriteOnce = true;
  dbConflict = null;
  notify();
  await enqueueFullSave();
  if (dbConflict) return false;
  forceOverwriteOnce = false;
  return true;
}

// ── hydration 중 생성된 값의 1회 영속 ──────────────────────────────────────
// migrateState 가 DB 에 없던 값(contributionSchedule)을 처음 만들면, 그대로 두면 다음 접속에서
// 또 만들어지므로 한 번은 저장해야 한다. 단 **프로필당 세션 1회만** 시도한다 —
// 저장이 실패하거나 서버가 값을 돌려주지 않아도 폴링마다 dbSave 를 반복하지 않기 위해서다.
const hydrationMigration: MigrationResult = { createdContributionSchedule: false };
const migrationPersistAttempted = new Set<string>();

function persistMigrationOnce() {
  const created = hydrationMigration.createdContributionSchedule;
  hydrationMigration.createdContributionSchedule = false;
  if (!created || !familyCode || !currentUser) return;
  const key = `${familyCode}:${currentUser}`;
  if (migrationPersistAttempted.has(key)) return;
  migrationPersistAttempted.add(key);
  scheduleSave();
}

// ── 폴링 동기화 (Realtime 웹소켓 대신) ──────────────────────────────────────
// 다른 기기/탭에서 저장한 변경사항을 주기적으로 확인해 반영한다.
function startPolling(code: string) {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!familyCode || !currentUser || familyCode !== code) return;
    if (hasPendingLocalWrite()) return; // 아직 서버에 안 올라간 로컬 변경이 있으면 이번 폴링 결과로 덮어쓰지 않음
    // 미해결 저장 충돌이 있으면 **반영하지 않는다** — 아직 저장되지 않은 사용자 입력을
    // 서버 상태로 덮는 것이 되고, 그 선택은 사용자가 해야 한다(요구 6).
    if (dbConflict) return;
    // 보류 중이면 **복구만** 시도한다. 받아온 데이터를 반영하지 않는다 —
    // 아직 저장되지 않은 로컬 입력을 서버 상태로 덮는 것이 되기 때문이다.
    if (dbHold) { await recoverRevisionHold().catch(() => false); return; }
    try {
      const state = await dbLoad(code, currentUser);
      if (!state) return;
      if (hasPendingLocalWrite()) return; // 조회하는 동안 새로 로컬 변경이 생겼으면 이 (더 오래된) 결과는 버림
      if (dbConflict) return;            // 조회 중에 충돌이 생겼으면 반영하지 않는다
      if (dbHold) return;                // 조회 중에 보류가 생겼으면 반영하지 않는다
      isApplyingRemote = true;
      memState = migrateState(state, currentUser === "hyeobi", hydrationMigration);
      saveLocal(memState);
      isApplyingRemote = false;
      notify();
      persistMigrationOnce();
    } catch { /* 다음 폴링에서 재시도 */ }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Auth actions ───────────────────────────────────────────────────────────
export async function loginWithCode(code: string): Promise<"new" | "existing"> {
  if (typeof window === "undefined") throw new Error("Client only");
  code = code.trim();

  // 액세스 코드 검증
  if (code !== ACCESS_CODE) {
    throw new Error("액세스 코드가 올바르지 않습니다.");
  }

  dbLoading = true;
  dbError = null;
  notify();

  try {
    // 서버가 family_code 존재 여부를 확인하고, 신규면 기본 프로필 메타데이터를 만들어둔다.
    // 계좌 데이터 자체(seedState 등)는 PIN 최초 설정 이후 세션 토큰이 생기면 자연스럽게 저장됨.
    const fd = await loadFamilyData(code);

    familyCode = code;
    localStorage.setItem(AUTH_CODE_KEY, code);

    dbLoading = false;
    notify();
    return fd.isNew ? "new" : "existing";
  } catch (e: unknown) {
    dbError = (e as { message?: string })?.message ?? "오류가 발생했습니다.";
    dbLoading = false;
    notify();
    throw e;
  }
}

export async function activateProfile(profileId: string): Promise<void> {
  if (!familyCode) return;

  dbLoading = true;
  notify();

  try {
    if (memState && currentUser && currentUser !== profileId) {
      await enqueueFullSave();
    }

    // currentUser를 먼저 설정해야 loadLocal()이 올바른 키로 읽음
    currentUser = profileId;
    localStorage.setItem(AUTH_USER_KEY, profileId);

    const loaded = await dbLoad(familyCode, profileId);
    if (loaded) {
      // DB 데이터는 반드시 migrateState를 거쳐 새 필드(profileRows 등)를 초기화
      memState = migrateState(loaded, profileId === "hyeobi", hydrationMigration);
    } else {
      // DB 실패 시 로컬 캐시 우선 사용 (로컬 캐시도 내부에서 migrateState 적용)
      memState = loadLocal();
    }
    saveLocal(memState);
    persistMigrationOnce();
    startPolling(familyCode);
  } catch {}

  dbLoading = false;
  notify();
}

export async function syncNow(): Promise<void> {
  if (!familyCode || !currentUser || !hasSupabase) return;
  dbLoading = true;
  notify();
  try {
    const state = await dbLoad(familyCode, currentUser);
    if (state) {
      memState = migrateState(state, currentUser === "hyeobi", hydrationMigration);
      saveLocal(memState);
      persistMigrationOnce();
    }
    startPolling(familyCode);
  } catch (e) {
    console.error("[kaw] syncNow error:", e);
  } finally {
    dbLoading = false;
    notify();
  }
}

export function deactivateProfile(): void {
  stopPolling();
  localStorage.removeItem(AUTH_USER_KEY);
  clearSessionProfile();
  currentUser = "";
  memState = null;
  notify();
}

export function logoutCode() {
  if (typeof window === "undefined") return;
  stopPolling();
  localStorage.removeItem(AUTH_CODE_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  clearSessionProfile();
  familyCode = null;
  currentUser = "";
  memState = null;
  dbError = null;
  migrationPersistAttempted.clear();
  notify();
}

// ── State management ───────────────────────────────────────────────────────
function getState(): StoreState {
  if (!memState) memState = currentUser ? loadLocal() : emptyState();
  return memState;
}

function setState(updater: (s: StoreState) => StoreState) {
  memState = updater(getState());
  saveLocal(memState);
  scheduleSave();
  notify();
}

// ── Visibility-based refresh (iOS Safari 백그라운드 복귀 시 재동기화) ──────
let visibilityListenerAdded = false;
function setupVisibilityRefresh() {
  if (visibilityListenerAdded || typeof document === "undefined") return;
  visibilityListenerAdded = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !familyCode || !currentUser) return;
    // 백그라운드에 있는 동안 폴링이 멈춰있었을 수 있으므로 재시작
    startPolling(familyCode);
    // 최신 데이터 강제 로드 (단, 아직 서버에 안 올라간 로컬 변경은 덮어쓰지 않음)
    if (hasPendingLocalWrite()) return;
    if (dbConflict) return; // 충돌 미해결 — 사용자 입력을 서버 상태로 덮지 않는다
    // 보류 중이면 복구만 시도한다(받아온 데이터는 반영하지 않는다).
    if (dbHold) { void recoverRevisionHold().catch(() => false); return; }
    dbLoad(familyCode, currentUser).then((state) => {
      if (!state || hasPendingLocalWrite()) return;
      if (dbConflict) return; // 조회 중에 충돌이 생겼으면 반영하지 않는다
      if (dbHold) return;     // 조회 중에 보류가 생겼으면 반영하지 않는다
      memState = migrateState(state, false, hydrationMigration);
      saveLocal(memState);
      notify();
      persistMigrationOnce();
    }).catch(() => {});
  });
}

// ── Async init ─────────────────────────────────────────────────────────────
async function initFromStorage() {
  if (typeof window === "undefined") return;
  const code = localStorage.getItem(AUTH_CODE_KEY);
  if (!code) { dbLoading = false; notify(); return; }

  familyCode = code;
  setupVisibilityRefresh();

  // sessionStorage에 프로필 인증 기록 + 유효한 세션 토큰이 있으면 세션 복원 (같은 탭 새로고침)
  const sessionProfile = sessionStorage.getItem(SESSION_AUTH_KEY);
  const savedUser      = localStorage.getItem(AUTH_USER_KEY);
  const token           = getSessionToken();
  if (sessionProfile && savedUser === sessionProfile && token) {
    // currentUser를 먼저 설정해야 loadLocal()이 올바른 키로 읽음
    currentUser = sessionProfile;
    memState    = loadLocal();
    notify();

    try {
      const dbState = await dbLoad(code, sessionProfile);
      if (dbState) {
        memState = migrateState(dbState, sessionProfile === "hyeobi", hydrationMigration);
        saveLocal(memState);
        notify();
      }
    } catch { /* 로컬 캐시로 계속 진행 */ }
    persistMigrationOnce();
    startPolling(code);
  }

  dbLoading = false;
  notify();
}

// ── React Hook ─────────────────────────────────────────────────────────────
export function usePortfolioStore() {
  const [, force] = useState(0);

  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    if (typeof window !== "undefined" && !initialized) {
      initialized = true;
      initFromStorage();
    }
    return () => { listeners.delete(l); };
  }, []);

  const state = getState();

  const setProfile      = useCallback((p: ProfileKey) => setState((s) => ({ ...s, profile: p })), []);
  const setAllocation   = useCallback((p: ProfileKey, k: AssetKey, pct: number) =>
    setState((s) => ({ ...s, allocations: { ...s.allocations, [p]: { ...s.allocations[p], [k]: pct } } })), []);
  const resetAllocation = useCallback((p: ProfileKey) =>
    setState((s) => ({ ...s, allocations: { ...s.allocations, [p]: { ...PROFILE_PRESETS[p] } } })), []);
  const updateAccount   = useCallback((id: AccountId, patch: Partial<AccountState>) =>
    setState((s) => ({ ...s, accounts: { ...s.accounts, [id]: { ...s.accounts[id], ...patch } } })), []);
  const updateHolding   = useCallback((id: AccountId, key: AssetKey, patch: Partial<Holding>) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, holdings: acc.holdings.map((h) => h.assetKey === key ? { ...h, ...patch } : h) } } };
    }), []);
  const addHistory      = useCallback((id: AccountId, entry: Omit<HistoryEntry, "returnPct">) => {
    setState((s) => {
      const acc = s.accounts[id];
      const sorted = [...acc.history, { ...entry, returnPct: null }].sort((a, b) => a.date.localeCompare(b.date));
      // 리밸런싱 저장은 cashflow 를 만들거나 수정하지 않는다. 입금과 리밸런싱은 독립된
      // 이벤트이고(입금 → 예수금 → 나중에 매수), 외부 입금은 정기납입 "입금 확인" 또는
      // 수동 기록으로만 장부에 들어온다. history.deposit 은 과거 호환·기록용으로만 남는다.
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: recalcReturns(sorted) } } };
    });
    // 리밸런싱 저장은 즉시 DB에 반영 (디바운스 누락 방지)
    if (familyCode && currentUser && memState) {
      void enqueueFullSave();
    }
  }, []);

  // ── 리밸런싱 완료 저장 ────────────────────────────────────────────────────
  // 보유수량/평가액/예수금/history 를 한 번의 state update 로 확정한다.
  // 예수금은 매매 전 값을 그대로 들고 가면 안 된다 — 실제 주문이 끝난 뒤 증권사 잔액을
  // 사용자가 확인해서 넘기며, 그 값을 현재 계좌 상태와 history 양쪽에 같은 값으로 저장한다.
  // 외부 입출금(cashflow)은 건드리지 않는다. 리밸런싱은 계좌 내부 자산형태 변화일 뿐이다.
  const finalizeRebalance = useCallback((
    id: AccountId,
    args: {
      cashBalance: number;
      quantities: Record<string, number>;
      rowHoldings: Record<string, number>;
      entry: Omit<HistoryEntry, "returnPct" | "cashBalance" | "rowQuantitiesSnap" | "rowHoldingsSnap">;
    },
  ) => {
    const finalCash = Math.max(0, Math.round(args.cashBalance));
    setState((s) => {
      const acc = s.accounts[id];
      const nextEntry: HistoryEntry = {
        ...args.entry,
        cashBalance: finalCash,
        rowQuantitiesSnap: { ...args.quantities },
        rowHoldingsSnap: { ...args.rowHoldings },
        returnPct: null,
      };
      // 같은 id 는 append 가 아니라 replace 다 (upsertHistoryEntry 주석).
      const sorted = upsertHistoryEntry(acc.history, nextEntry);
      // 과거 날짜로 소급 기록하는 경우(dateMode === "past")에는 계좌의 **현재** 상태를
      // 건드리지 않는다. cashBalance / liveQuantities / rowHoldings 는 "지금" 값이므로,
      // 몇 달 전 리밸런싱을 채워 넣었다고 오늘의 실제 예수금을 과거 값으로 덮어쓰면
      // 총자산이 틀어진다(cashBalance 는 1급 영속 상태다).
      // 같은 날짜가 이미 있으면 새 기록이 뒤에 오므로(안정 정렬) 최신으로 본다.
      const isLatest = sorted[sorted.length - 1].id === nextEntry.id;
      return {
        ...s,
        accounts: {
          ...s.accounts,
          [id]: {
            ...acc,
            ...(isLatest ? {
              cashBalance: finalCash,
              liveQuantities: { ...(acc.liveQuantities ?? {}), ...args.quantities },
              rowHoldings: { ...(acc.rowHoldings ?? {}), ...args.rowHoldings },
            } : {}),
            history: recalcReturns(sorted),
          },
        },
      };
    });
    // setState 는 memState 를 동기적으로 갱신한다. 완료 버튼 직후 바로 서버에도 반영해
    // 다른 기기/대시보드가 오래된 예수금을 보는 시간을 최소화한다.
    if (familyCode && currentUser && memState) {
      void enqueueFullSave();
    }
  }, []);
  const removeHistory   = useCallback((id: AccountId, hid: string) => {
    // **사용자가 의도적으로 지웠다.** 서버는 history 축소를 기본적으로 충돌로 거부하므로
    // (버그로 비어 온 문서를 막기 위해서다 — migration 007 대원칙 5), 이 1회만 허용한다.
    markIntentionalHistoryShrink();
    setState((s) => {
      const acc = s.accounts[id];
      // 히스토리가 바뀌면 이후 시점들의 백테스트 유닛 체인이 무효화되므로 전부 초기화 (다음 조회 시 재계산)
      const filtered = acc.history.filter((h) => h.id !== hid).map((h) => ({ ...h, backtestGrowth: undefined }));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: recalcReturns(filtered) } } };
    });
  }, []);
  const updateHistory   = useCallback((id: AccountId, entry: HistoryEntry) =>
    setState((s) => {
      const acc = s.accounts[id];
      const updated = acc.history.map((h) => (h.id === entry.id ? { ...entry, backtestGrowth: undefined } : { ...h, backtestGrowth: undefined }));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: recalcReturns(updated) } } };
    }), []);
  const setHistoryBacktest = useCallback((id: AccountId, updates: Record<string, NonNullable<HistoryEntry["backtestGrowth"]>>) => {
    setState((s) => {
      const acc = s.accounts[id];
      const patched = acc.history.map((h) => (updates[h.id] ? { ...h, backtestGrowth: updates[h.id] } : h));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: patched } } };
    });
    if (familyCode && currentUser && memState) {
      void enqueueFullSave();
    }
  }, []);
  const resetAll        = useCallback(() => {
    // 문서를 통째로 갈아끼우는 사용자 행동이다 — 기록 축소·키 유실을 이 저장에서만 허용한다.
    markIntentionalDocumentReplace();
    memState = null;
    setState(() => currentUser === "hyeobi" ? seedState() : emptyState());
  }, []);
  const importJson           = useCallback((data: StoreState) => {
    markIntentionalDocumentReplace();
    setState(() => data);
  }, []);
  const updateAssetLibrary   = useCallback((lib: AssetDef[]) =>
    setState((s) => ({ ...s, assetLibrary: lib })), []);
  const updateRowHolding     = useCallback((id: AccountId, rowId: string, value: number) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, rowHoldings: { ...(acc.rowHoldings ?? {}), [rowId]: value },
      }}};
    }), []);
  // 리밸런싱 세션 mirror. **정본이 아니다** — journal(localStorage 전용 키)이 정본이고
  // 이 값은 기기 간 동기화·화면 상태용이다. null 을 넘기면 필드를 지운다.
  const setRebalanceSessionMirror = useCallback((id: AccountId, mirror: RebalanceSessionMirror | null) =>
    setState((s) => {
      const acc = s.accounts[id];
      const next = { ...acc } as AccountState;
      if (mirror) next.rebalanceSession = mirror;
      else delete next.rebalanceSession;
      return { ...s, accounts: { ...s.accounts, [id]: next } };
    }), []);
  // 기존 값과 병합 저장(통째로 덮어쓰지 않음) — 리밸런싱 탭이 재마운트되는 순간(히스토리 탭 이동 후 복귀 등)
  // quantities state가 account.liveQuantities보다 먼저/불완전하게 초기화돼 있으면, 통째로 덮어쓸 경우
  // 기존에 저장돼 있던 보유수량 전체가 빈 값으로 유실될 수 있었음.
  const saveAccountQuantities = useCallback((id: AccountId, quantities: Record<string, number>) =>
    setState((s) => ({
      ...s, accounts: { ...s.accounts, [id]: { ...s.accounts[id], liveQuantities: { ...s.accounts[id].liveQuantities, ...quantities } } },
    })), []);
  // ── Cashflow 장부 ────────────────────────────────────────────────────────
  // 리밸런싱 저장으로 자동 기록되지 않는 흐름(ISA 자금 출금, 누락된 입금 정정 등)을 직접 넣는다.
  // 금액 부호가 의미를 갖는다: 입금 +, 출금 -.
  const addCashflow = useCallback((id: AccountId, entry: Omit<CashflowEntry, "id"> & { id?: string }) =>
    setState((s) => {
      const acc = s.accounts[id];
      const next: CashflowEntry = {
        id: entry.id ?? `cf:${crypto.randomUUID()}`,
        date: entry.date,
        amount: Math.round(entry.amount),
        type: entry.type,
        source: entry.source ?? "manual",
        // 수동 기록도 귀속 월을 채워두지만 식별에는 쓰지 않는다 — 같은 달·같은 금액이
        // 여러 건이어도 그대로 유지한다(월 1건 규칙은 자동 기록에만 적용된다).
        period: entry.period ?? periodOf(entry.date),
        ...(entry.note ? { note: entry.note } : {}),
      };
      const cashflows = [...(acc.cashflows ?? []), next]
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, cashflows } } };
    }), []);

  // ── 정기납입 ──────────────────────────────────────────────────────────────
  // 입금 확인: (scheduleId, period) 가 identity 라 같은 달에 다시 눌러도 1건만 유지된다.
  // 실제 입금액이 예정 금액과 다르면 amount 로 넘기고, applyGoingForward 를 켜면 그 달을
  // effectiveFrom 으로 하는 **새 금액 버전**을 추가한다(기존 버전은 덮어쓰지 않는다).
  const confirmContributionDeposit = useCallback((
    id: AccountId,
    args: { period: string; amount: number; applyGoingForward?: boolean },
  ) =>
    setState((s) => {
      const acc = s.accounts[id];
      const schedule = acc.contributionSchedule;
      if (!schedule) return s;
      const cashflows = confirmContribution(acc.cashflows, {
        schedule, period: args.period, amount: args.amount,
      });
      const nextSchedule = args.applyGoingForward
        ? { ...schedule, amountVersions: upsertAmountVersion(schedule.amountVersions, args.period, Math.round(args.amount)) }
        : schedule;
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, cashflows, contributionSchedule: nextSchedule,
      } } };
    }), []);

  const updateContributionSchedule = useCallback((
    id: AccountId, patch: Partial<Omit<RecurringContributionSchedule, "id" | "amountVersions">>,
  ) =>
    setState((s) => {
      const acc = s.accounts[id];
      if (!acc.contributionSchedule) return s;
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, contributionSchedule: { ...acc.contributionSchedule, ...patch },
      } } };
    }), []);

  /** 금액 버전 추가/수정. 기존 버전을 덮어쓰지 않는다(같은 effectiveFrom 만 교체). */
  const setContributionAmount = useCallback((id: AccountId, effectiveFrom: string, amount: number) =>
    setState((s) => {
      const acc = s.accounts[id];
      if (!acc.contributionSchedule) return s;
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, contributionSchedule: {
        ...acc.contributionSchedule,
        amountVersions: upsertAmountVersion(acc.contributionSchedule.amountVersions, effectiveFrom, Math.round(amount)),
      } } } };
    }), []);

  const removeContributionAmountVersion = useCallback((id: AccountId, effectiveFrom: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      if (!acc.contributionSchedule) return s;
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, contributionSchedule: {
        ...acc.contributionSchedule,
        amountVersions: acc.contributionSchedule.amountVersions.filter((v) => v.effectiveFrom !== effectiveFrom),
      } } } };
    }), []);

  const removeCashflow = useCallback((id: AccountId, cashflowId: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, cashflows: (acc.cashflows ?? []).filter((c) => c.id !== cashflowId),
      } } };
    }), []);

  const updateRowMemo        = useCallback((id: AccountId, memoKey: string, text: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      const memos = { ...(acc.rowMemos ?? {}), [memoKey]: text };
      if (!text) delete memos[memoKey];
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, rowMemos: memos } } };
    }), []);

  // ── Per-account settings actions ──────────────────────────────────────────
  const setAccountActive = useCallback((id: AccountId, v: boolean) =>
    setState((s) => ({ ...s, accounts: { ...s.accounts, [id]: { ...s.accounts[id], active: v } } })), []);

  const setAccountProfile = useCallback((id: AccountId, p: ProfileKey) =>
    setState((s) => ({ ...s, accounts: { ...s.accounts, [id]: { ...s.accounts[id], profile: p } } })), []);

  const setAccountAllocation = useCallback((id: AccountId, p: ProfileKey, k: AssetKey, pct: number) =>
    setState((s) => {
      const acc = s.accounts[id];
      const allocs = acc.accountAllocations ?? structuredClone(PROFILE_PRESETS);
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, accountAllocations: { ...allocs, [p]: { ...allocs[p], [k]: pct } } } } };
    }), []);

  const resetAccountAllocations = useCallback((id: AccountId, p: ProfileKey) =>
    setState((s) => {
      const acc = s.accounts[id];
      const allocs = acc.accountAllocations ?? structuredClone(PROFILE_PRESETS);
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, accountAllocations: { ...allocs, [p]: p === "custom" ? {} as Record<AssetKey,number> : { ...PROFILE_PRESETS[p] } } } } };
    }), []);

  const setAccountEtfName = useCallback((id: AccountId, key: AssetKey, name: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      const etfNames = { ...acc.etfNames, [key]: name };
      const holdings = acc.holdings.map((h) => h.assetKey === key ? { ...h, etfName: name } : h);
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, etfNames, holdings } } };
    }), []);

  const toggleAccountAsset = useCallback((id: AccountId, key: AssetKey, enabled: boolean) =>
    setState((s) => {
      const acc = s.accounts[id];
      const current = acc.enabledAssets ?? [...ASSET_ORDER];
      const enabledAssets = enabled
        ? [...new Set([...current, key])].sort((a, b) => ASSET_ORDER.indexOf(a) - ASSET_ORDER.indexOf(b))
        : current.filter((k) => k !== key);
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, enabledAssets } } };
    }), []);

  return {
    state,
    familyCode,
    currentUser,
    dbLoading,
    dbError,
    // 미해결 저장 충돌. 있으면 자동저장·폴링 반영이 멈춘 상태이고, 아래 두 액션 중
    // 하나를 사용자가 골라야 풀린다(자동 해결 경로는 없다).
    dbConflict,
    // 저장 보류(revision 미확보). 무가드 저장으로 강등하지 않고 멈춘 상태다.
    dbHold,
    reloadFromServer: useCallback(() => reloadFromServer(), []),
    overwriteServerWithLocal: useCallback(() => overwriteServerWithLocal(), []),
    retryHeldSave: useCallback(() => retryHeldSave(), []),
    hasSupabase,
    setProfile, setAllocation, resetAllocation,
    updateAccount, updateHolding,
    addHistory, finalizeRebalance, removeHistory, updateHistory, setHistoryBacktest,
    resetAll, importJson,
    setAccountActive, setAccountProfile,
    setAccountAllocation, resetAccountAllocations,
    setAccountEtfName, toggleAccountAsset,
    updateAssetLibrary,
    updateRowHolding,
    updateRowMemo,
    saveAccountQuantities,
    setRebalanceSessionMirror,
    addCashflow, removeCashflow,
    confirmContributionDeposit, updateContributionSchedule,
    setContributionAmount, removeContributionAmountVersion,
    activateProfile: useCallback((id: string) => activateProfile(id), []),
    deactivateProfile: useCallback(() => deactivateProfile(), []),
    logoutCode:    useCallback(() => logoutCode(), []),
  };
}

export const formatKRW = (n: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Math.round(n || 0));
export const formatPct = (n: number | null) =>
  n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
