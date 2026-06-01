import { useEffect, useState, useCallback } from "react";
import { ASSET_ORDER, ASSET_GROUPS, PROFILE_PRESETS, ACCOUNT_IDS, type AccountId, type AssetKey, type ProfileKey } from "./constants";
import { supabase, hasSupabase } from "./supabase";
import { defaultFamilyData, saveFamilyData, SESSION_AUTH_KEY } from "./auth";

// 액세스 코드: 환경변수에 없으면 "soye" 고정
export const ACCESS_CODE: string = import.meta.env.VITE_ACCESS_CODE || "soye";

export type { UserProfile } from "./supabase";

// ── Types ──────────────────────────────────────────────────────────────────
export interface Holding { assetKey: AssetKey; etfName: string; value: number; }
export interface HistoryEntry {
  id: string;
  date: string;
  baseAmount: number;
  totalValue: number;
  deposit: number;
  returnPct: number | null;
  holdings?: Partial<Record<AssetKey, number>>;
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
  rebalanceDate: string;
  holdings: Holding[];
  rowHoldings?: Record<string, number>;  // row instance ID → current market value
  history: HistoryEntry[];
}
export interface StoreState {
  // Global fallback (used for migration only)
  profile: ProfileKey;
  allocations: Record<ProfileKey, Record<AssetKey, number>>;
  accounts: Record<AccountId, AccountState>;
  assetLibrary?: AssetDef[];
}

// ── Global asset library helper ────────────────────────────────────────────
export function getOrDefaultLibrary(state: StoreState): AssetDef[] {
  if (state.assetLibrary?.length) return state.assetLibrary;
  return ASSET_ORDER.map((k) => ({
    id: k,
    group: ASSET_GROUPS[k].group,
    label: ASSET_GROUPS[k].label,
    defaultEtf: ASSET_GROUPS[k].defaultEtf,
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
    {date:"2025-12-29",totalValue:3104050,baseAmount:3120898,deposit:0,holdings:{us:792480,kr:284340,cn:236925,in:242370,gold:605340,ust10:212300,ust30:213960,ktb30:406290,cash:110045}},
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
  return { ...baseAccountSettings(), baseAmount: 0, deposit: 0, rebalanceDate: new Date().toISOString().slice(0, 10), holdings: seedHoldings(), history: makeHistory(SEED_HISTORY[id] ?? []) };
}
function seedState(): StoreState {
  return { profile: "growth", allocations: structuredClone(PROFILE_PRESETS), accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, seedAccount(id)])) as Record<AccountId, AccountState> };
}
function emptyState(): StoreState {
  return { profile: "growth", allocations: structuredClone(PROFILE_PRESETS), accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, { ...baseAccountSettings(), baseAmount: 0, deposit: 0, rebalanceDate: new Date().toISOString().slice(0, 10), holdings: seedHoldings(), history: [] as HistoryEntry[] }])) as Record<AccountId, AccountState> };
}
function recalcReturns(history: HistoryEntry[]): HistoryEntry[] {
  return history.map((h, i) => {
    const prev = i > 0 ? history[i - 1] : null;
    const returnPct = prev && prev.totalValue > 0 ? ((h.totalValue - h.deposit) - prev.totalValue) / prev.totalValue * 100 : null;
    return { ...h, returnPct };
  });
}

function migrateState(parsed: StoreState): StoreState {
  const seed = seedState();
  // Migrate global MP → growth if leftover
  if ((parsed.profile as string) === "MP") parsed.profile = "growth";

  for (const id of ACCOUNT_IDS) {
    if (!parsed.accounts[id]) { parsed.accounts[id] = seed.accounts[id]; continue; }
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

    const existing = new Map(acc.holdings.map((h) => [h.assetKey, h]));
    // Sync ETF names from holdings if etfNames not yet set from DB
    for (const [key, h] of existing) {
      if (h.etfName && h.etfName !== ASSET_GROUPS[key].defaultEtf) {
        acc.etfNames[key] = h.etfName;
      }
    }
    acc.holdings = ASSET_ORDER.map((k) => existing.get(k) ?? { assetKey: k, etfName: acc.etfNames[k], value: 0 });

    if (!acc.history?.length) {
      acc.history = seed.accounts[id].history;
    } else {
      const seedMap = new Map(seed.accounts[id].history.map((h) => [h.id, h]));
      acc.history = acc.history.map((h) => {
        const s = seedMap.get(h.id);
        if (s && !h.holdings) return { ...s, returnPct: h.returnPct };
        return { ...h, baseAmount: (h as HistoryEntry & { baseAmount?: number }).baseAmount ?? 0 };
      });
    }
    if (!acc.rebalanceDate) acc.rebalanceDate = new Date().toISOString().slice(0, 10);

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

let memState: StoreState | null = null;
const listeners = new Set<() => void>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realtimeChannel: any = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isReceivingRealtime = false;

function notify() { listeners.forEach((l) => l()); }

// ── Local storage helpers ──────────────────────────────────────────────────
function saveLocal(state: StoreState) {
  if (typeof window === "undefined" || !currentUser) return;
  const key = familyCode ? storeKey(familyCode, currentUser) : LEGACY_STORE_KEY;
  try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
}

function loadLocal(): StoreState {
  if (typeof window === "undefined" || !currentUser) return emptyState();
  if (familyCode) {
    try {
      const raw = localStorage.getItem(storeKey(familyCode, currentUser));
      if (raw) return migrateState(JSON.parse(raw) as StoreState);
    } catch {}
    return currentUser === "hyeobi" ? seedState() : emptyState();
  }
  try {
    const raw = localStorage.getItem(LEGACY_STORE_KEY);
    if (raw) return migrateState(JSON.parse(raw) as StoreState);
  } catch {}
  return seedState();
}

// ── DB operations ──────────────────────────────────────────────────────────
interface DbRow { family_code: string; profile: string; account_type: string; data: unknown; updated_at?: string; }

async function dbLoad(code: string, user: string): Promise<StoreState | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("kaw_data")
      .select("account_type, data")
      .eq("family_code", code)
      .eq("profile", user);
    if (error) throw error;
    if (!data?.length) return null;

    let profileKey: ProfileKey = "growth";
    let allocations = structuredClone(PROFILE_PRESETS);
    let assetLibrary: AssetDef[] | undefined;
    const accounts: Partial<Record<AccountId, AccountState>> = {};

    for (const row of data) {
      if (row.account_type === "_meta") {
        const m = row.data as { profile: ProfileKey; allocations: typeof allocations; assetLibrary?: AssetDef[] };
        profileKey = m.profile ?? "growth";
        allocations = m.allocations ?? allocations;
        assetLibrary = m.assetLibrary;
      } else if (ACCOUNT_IDS.includes(row.account_type as AccountId)) {
        accounts[row.account_type as AccountId] = row.data as AccountState;
      }
    }

    const fallback = user === "hyeobi" ? seedState() : emptyState();
    return {
      profile: profileKey,
      allocations,
      assetLibrary,
      accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, accounts[id] ?? fallback.accounts[id]])) as Record<AccountId, AccountState>,
    };
  } catch (e) {
    console.error("[kaw] DB load error:", e);
    return null;
  }
}

async function dbSave(code: string, user: string, state: StoreState) {
  if (!supabase || isReceivingRealtime || !user) return;
  const now = new Date().toISOString();
  const rows: DbRow[] = [
    { family_code: code, profile: user, account_type: "_meta", data: { profile: state.profile, allocations: state.allocations, assetLibrary: state.assetLibrary }, updated_at: now },
    ...ACCOUNT_IDS.map((id) => ({ family_code: code, profile: user, account_type: id, data: state.accounts[id], updated_at: now })),
  ];
  const { error } = await supabase.from("kaw_data").upsert(rows, { onConflict: "family_code,profile,account_type" });
  if (error) console.error("[kaw] DB save error:", error);
}

function scheduleSave() {
  if (!familyCode || !currentUser) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (familyCode && memState && currentUser) dbSave(familyCode, currentUser, memState).catch(console.error);
  }, 800);
}

// ── Realtime ───────────────────────────────────────────────────────────────
function subscribeRealtime(code: string) {
  if (!supabase) return;
  unsubscribeRealtime();
  realtimeChannel = supabase
    .channel(`kaw-room-${code}`)
    .on("postgres_changes" as "system", {
      event: "UPDATE",
      schema: "public",
      table: "kaw_data",
      filter: `family_code=eq.${code}`,
    }, (payload: { new: DbRow }) => {
      const row = payload.new;
      if (!memState || row.profile !== currentUser) return;
      isReceivingRealtime = true;
      if (row.account_type === "_meta") {
        const m = row.data as { profile: ProfileKey; allocations: typeof PROFILE_PRESETS };
        memState = { ...memState, profile: m.profile, allocations: m.allocations };
      } else if (ACCOUNT_IDS.includes(row.account_type as AccountId)) {
        memState = { ...memState, accounts: { ...memState.accounts, [row.account_type]: row.data as AccountState } };
      }
      saveLocal(memState);
      isReceivingRealtime = false;
      notify();
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (realtimeChannel && supabase) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
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
    let isNew = false;

    if (supabase) {
      const { data, error } = await supabase
        .from("kaw_data")
        .select("id")
        .eq("family_code", code)
        .limit(1);
      if (error) throw error;
      isNew = !data?.length;
    } else {
      isNew = !localStorage.getItem(storeKey(code, "hyeobi")) && !localStorage.getItem(LEGACY_STORE_KEY + ".auth." + code);
    }

    familyCode = code;
    localStorage.setItem(AUTH_CODE_KEY, code);

    if (isNew) {
      // Migrate legacy data if exists
      let state: StoreState | null = null;
      try {
        const legacyRaw = localStorage.getItem(LEGACY_STORE_KEY);
        if (legacyRaw) state = migrateState(JSON.parse(legacyRaw) as StoreState);
      } catch {}
      if (!state) state = seedState();

      if (supabase) {
        await saveFamilyData(code, defaultFamilyData());
        await dbSave(code, "hyeobi", state);
      } else {
        localStorage.setItem(LEGACY_STORE_KEY + ".auth." + code, "1");
        localStorage.setItem(storeKey(code, "hyeobi"), JSON.stringify(state));
      }
    }

    dbLoading = false;
    notify();
    return isNew ? "new" : "existing";
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
      await dbSave(familyCode, currentUser, memState).catch(() => {});
    }

    const loaded = await dbLoad(familyCode, profileId);
    const newState = loaded ?? (profileId === "hyeobi" ? seedState() : emptyState());

    currentUser = profileId;
    memState = newState;
    saveLocal(memState);
    localStorage.setItem(AUTH_USER_KEY, profileId);

    subscribeRealtime(familyCode);
  } catch {}

  dbLoading = false;
  notify();
}

export function deactivateProfile(): void {
  unsubscribeRealtime();
  localStorage.removeItem(AUTH_USER_KEY);
  if (typeof window !== "undefined") sessionStorage.removeItem(SESSION_AUTH_KEY);
  currentUser = "";
  memState = null;
  notify();
}

export function logoutCode() {
  if (typeof window === "undefined") return;
  unsubscribeRealtime();
  localStorage.removeItem(AUTH_CODE_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  sessionStorage.removeItem(SESSION_AUTH_KEY);
  familyCode = null;
  currentUser = "";
  memState = null;
  dbError = null;
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

// ── Async init ─────────────────────────────────────────────────────────────
async function initFromStorage() {
  if (typeof window === "undefined") return;
  const code = localStorage.getItem(AUTH_CODE_KEY);
  if (!code) { dbLoading = false; notify(); return; }

  familyCode = code;

  // sessionStorage에 프로필 인증 기록이 있으면 세션 복원 (같은 탭 새로고침)
  const sessionProfile = sessionStorage.getItem(SESSION_AUTH_KEY);
  const savedUser      = localStorage.getItem(AUTH_USER_KEY);
  if (sessionProfile && savedUser === sessionProfile) {
    // currentUser를 먼저 설정해야 loadLocal()이 올바른 키로 읽음
    currentUser = sessionProfile;
    memState    = loadLocal();
    notify();

    if (hasSupabase) {
      try {
        const dbState = await dbLoad(code, sessionProfile);
        if (dbState) { memState = dbState; saveLocal(memState); }
      } catch {}
    }
    subscribeRealtime(code);
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
  const addHistory      = useCallback((id: AccountId, entry: Omit<HistoryEntry, "returnPct">) =>
    setState((s) => {
      const acc = s.accounts[id];
      const sorted = [...acc.history, { ...entry, returnPct: null }].sort((a, b) => a.date.localeCompare(b.date));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: recalcReturns(sorted) } } };
    }), []);
  const removeHistory   = useCallback((id: AccountId, hid: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      const filtered = acc.history.filter((h) => h.id !== hid);
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: recalcReturns(filtered) } } };
    }), []);
  const resetAll        = useCallback(() => {
    memState = null;
    setState(() => currentUser === "hyeobi" ? seedState() : emptyState());
  }, []);
  const importJson           = useCallback((data: StoreState) => setState(() => data), []);
  const updateAssetLibrary   = useCallback((lib: AssetDef[]) =>
    setState((s) => ({ ...s, assetLibrary: lib })), []);
  const updateRowHolding     = useCallback((id: AccountId, rowId: string, value: number) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, rowHoldings: { ...(acc.rowHoldings ?? {}), [rowId]: value },
      }}};
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
    hasSupabase,
    setProfile, setAllocation, resetAllocation,
    updateAccount, updateHolding,
    addHistory, removeHistory,
    resetAll, importJson,
    setAccountActive, setAccountProfile,
    setAccountAllocation, resetAccountAllocations,
    setAccountEtfName, toggleAccountAsset,
    updateAssetLibrary,
    updateRowHolding,
    activateProfile: useCallback((id: string) => activateProfile(id), []),
    deactivateProfile: useCallback(() => deactivateProfile(), []),
    logoutCode:    useCallback(() => logoutCode(), []),
  };
}

export const formatKRW = (n: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Math.round(n || 0));
export const formatPct = (n: number | null) =>
  n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
