import { useEffect, useState, useCallback } from "react";
import { ASSET_ORDER, ASSET_GROUPS, PROFILE_PRESETS, ACCOUNT_IDS, type AccountId, type AssetKey, type ProfileKey } from "./constants";

export interface Holding { assetKey: AssetKey; etfName: string; value: number; }
export interface HistoryEntry { id: string; date: string; totalValue: number; deposit: number; returnPct: number | null; }
export interface AccountState {
  baseAmount: number;
  deposit: number;
  holdings: Holding[];
  history: HistoryEntry[];
}
export interface StoreState {
  profile: ProfileKey;
  allocations: Record<ProfileKey, Record<AssetKey, number>>;
  accounts: Record<AccountId, AccountState>;
}

const KEY = "kaw.v1";

function seedHoldings(): Holding[] {
  return ASSET_ORDER.map((k) => ({ assetKey: k, etfName: ASSET_GROUPS[k].defaultEtf, value: 0 }));
}

function seedAccount(): AccountState {
  return { baseAmount: 0, deposit: 0, holdings: seedHoldings(), history: [] };
}

function seedState(): StoreState {
  return {
    profile: "growth",
    allocations: structuredClone(PROFILE_PRESETS),
    accounts: Object.fromEntries(ACCOUNT_IDS.map((id) => [id, seedAccount()])) as Record<AccountId, AccountState>,
  };
}

function load(): StoreState {
  if (typeof window === "undefined") return seedState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as StoreState;
    // Migration: ensure all accounts/holdings exist
    const seed = seedState();
    for (const id of ACCOUNT_IDS) {
      if (!parsed.accounts[id]) parsed.accounts[id] = seed.accounts[id];
      const existing = new Map(parsed.accounts[id].holdings.map((h) => [h.assetKey, h]));
      parsed.accounts[id].holdings = ASSET_ORDER.map(
        (k) => existing.get(k) ?? { assetKey: k, etfName: ASSET_GROUPS[k].defaultEtf, value: 0 }
      );
    }
    return parsed;
  } catch {
    return seedState();
  }
}

let memState: StoreState | null = null;
const listeners = new Set<() => void>();

function getState(): StoreState {
  if (!memState) memState = load();
  return memState;
}

function setState(updater: (s: StoreState) => StoreState) {
  memState = updater(getState());
  if (typeof window !== "undefined") {
    try { localStorage.setItem(KEY, JSON.stringify(memState)); } catch {}
  }
  listeners.forEach((l) => l());
}

export function usePortfolioStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    // On mount, ensure hydration from localStorage (SSR safe)
    if (typeof window !== "undefined" && memState === null) {
      memState = load();
      force((n) => n + 1);
    }
    return () => { listeners.delete(l); };
  }, []);

  const state = getState();

  const setProfile = useCallback((p: ProfileKey) => setState((s) => ({ ...s, profile: p })), []);
  const setAllocation = useCallback((p: ProfileKey, k: AssetKey, pct: number) =>
    setState((s) => ({ ...s, allocations: { ...s.allocations, [p]: { ...s.allocations[p], [k]: pct } } })), []);
  const resetAllocation = useCallback((p: ProfileKey) =>
    setState((s) => ({ ...s, allocations: { ...s.allocations, [p]: { ...PROFILE_PRESETS[p] } } })), []);

  const updateAccount = useCallback((id: AccountId, patch: Partial<AccountState>) =>
    setState((s) => ({ ...s, accounts: { ...s.accounts, [id]: { ...s.accounts[id], ...patch } } })), []);

  const updateHolding = useCallback((id: AccountId, key: AssetKey, patch: Partial<Holding>) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: {
        ...acc, holdings: acc.holdings.map((h) => h.assetKey === key ? { ...h, ...patch } : h)
      }}};
    }), []);

  const addHistory = useCallback((id: AccountId, entry: HistoryEntry) =>
    setState((s) => {
      const acc = s.accounts[id];
      const history = [...acc.history, entry].sort((a, b) => a.date.localeCompare(b.date));
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history } } };
    }), []);

  const removeHistory = useCallback((id: AccountId, hid: string) =>
    setState((s) => {
      const acc = s.accounts[id];
      return { ...s, accounts: { ...s.accounts, [id]: { ...acc, history: acc.history.filter((h) => h.id !== hid) } } };
    }), []);

  const resetAll = useCallback(() => setState(() => seedState()), []);

  const importJson = useCallback((data: StoreState) => setState(() => data), []);

  return {
    state,
    setProfile, setAllocation, resetAllocation,
    updateAccount, updateHolding,
    addHistory, removeHistory,
    resetAll, importJson,
  };
}

export const formatKRW = (n: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Math.round(n || 0));
