import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  PROFILE_LABELS, ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS,
  ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, PROFILE_PRESETS,
  type ProfileKey, type AccountId, type AssetKey,
} from "@/lib/kaw/constants";
import {
  usePortfolioStore, formatKRW, getAccountAlloc, getOrDefaultLibrary,
  type HistoryEntry, type AccountState, type AssetDef, type ProfileRowDef,
} from "@/lib/kaw/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  RotateCcw, Download, Upload, FileSpreadsheet, Trash2,
  KeyRound, Shield, CheckCircle2, AlertCircle, RefreshCw,
  Plus, X, Save, Settings, MessageSquare, Users, ChevronUp, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  type FamilyData, type ProfileConfig,
  verifyPin, updatePin, verifyMasterCode, updateMasterCode, updateMasterCodeViaSecretQuestion,
  softDeleteProfile, hardDeleteProfile,
} from "@/lib/kaw/auth";
import {
  SECRET_QUESTIONS, pickRandomSQIndex, verifySQAnswer, type SQIndex,
} from "@/lib/kaw/secretQuestions";

// ── Main tab types ─────────────────────────────────────────────────────────
type MainTab = "investment" | "data" | "security" | "users";

// ── Props ──────────────────────────────────────────────────────────────────
interface SettingsProps {
  familyData: FamilyData;
  onFamilyUpdate: (fd: FamilyData) => void;
}

// ── Excel helpers (unchanged) ──────────────────────────────────────────────
const ASSET_NAME_MAP: Record<string, AssetKey> = {
  "미국 (UH)": "us", "미국(UH)": "us", "한국": "kr",
  "중국 (UH)": "cn", "중국(UH)": "cn", "인도 (UH)": "in", "인도(UH)": "in",
  "금 (UH)": "gold", "금(UH)": "gold",
  "미국채 10년 (UH)": "ust10", "미국채 30년 (H)": "ust30",
  "국고채 30년": "ktb30", "현금성자산": "cash",
};
const SHEET_TO_ACCOUNT: Record<string, AccountId> = {
  "퇴직연금": "retirement", "ISA": "isa", "연금저축": "pension", "IRP": "irp",
};
function parseNum(v: unknown): number {
  return parseFloat(String(v ?? "").replace(/[\s,₩]/g, "")) || 0;
}
function excelDateToISO(serial: number): string {
  return new Date((serial - 25569) * 86400 * 1000).toISOString().slice(0, 10);
}
function parseExcelWorkbook(wb: XLSX.WorkBook): Record<AccountId, AccountState> {
  const result: Partial<Record<AccountId, AccountState>> = {};
  for (const sheetName of wb.SheetNames) {
    const accountId = SHEET_TO_ACCOUNT[sheetName];
    if (!accountId) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
    const dateRow = rows[0] as unknown[];
    const dateCols: { col: number; date: string }[] = [];
    for (let c = 4; c < dateRow.length; c += 2) {
      const v = dateRow[c];
      if (v && typeof v === "number") dateCols.push({ col: c, date: excelDateToISO(v) });
    }
    if (dateCols.length === 0) continue;
    const perDate: Record<string, { baseAmount: number; totalValue: number; deposit: number; holdings: Partial<Record<AssetKey, number>>; etfNames: Partial<Record<AssetKey, string>> }> = {};
    dateCols.forEach(({ date }) => { perDate[date] = { baseAmount: 0, totalValue: 0, deposit: 0, holdings: {}, etfNames: {} }; });
    for (const row of rows) {
      const r = row as unknown[];
      const assetLabel = String(r[1] ?? "").trim();
      const assetKey = ASSET_NAME_MAP[assetLabel];
      if (assetKey) {
        const etfRaw = String(r[2] ?? "").split("\n")[0].trim();
        dateCols.forEach(({ col, date }) => {
          const v = parseNum(r[col]);
          if (v > 0) { perDate[date].holdings[assetKey] = v; if (etfRaw) perDate[date].etfNames[assetKey] = etfRaw; }
        });
        continue;
      }
      if (String(r[0]).includes("자산합계")) {
        dateCols.forEach(({ col, date }) => {
          let tv = parseNum(r[col]);
          const ba = parseNum(r[col + 1]);
          if (tv === 0) tv = Object.values(perDate[date].holdings).reduce((s, v) => s + (v ?? 0), 0);
          if (tv > 0) perDate[date].totalValue = Math.round(tv);
          if (ba > 0) perDate[date].baseAmount = Math.round(ba);
        });
        continue;
      }
      if (String(r[1]).includes("불입액")) {
        dateCols.forEach(({ col, date }) => {
          const dep = parseNum(r[col + 1]) || parseNum(r[col]);
          if (dep > 0) perDate[date].deposit = dep;
        });
      }
    }
    const seen: Record<string, typeof perDate[string]> = {};
    dateCols.forEach(({ date }) => { seen[date] = perDate[date]; });
    const entries = Object.entries(seen).sort(([a], [b]) => a.localeCompare(b));
    const history: HistoryEntry[] = entries.map(([date, d], i) => {
      const prev = i > 0 ? entries[i - 1][1] : null;
      const returnPct = prev && prev.totalValue > 0 ? ((d.totalValue - d.deposit) - prev.totalValue) / prev.totalValue * 100 : null;
      return { id: `seed-${date}`, date, baseAmount: d.baseAmount, totalValue: d.totalValue, deposit: d.deposit, holdings: d.holdings, returnPct };
    });
    const latest = entries[entries.length - 1];
    const latestHoldings = latest?.[1].holdings ?? {};
    const latestEtfNames = latest?.[1].etfNames ?? {};
    const etfNames = Object.fromEntries(ASSET_ORDER.map((k) => [k, latestEtfNames[k] ?? ASSET_GROUPS[k].defaultEtf])) as Record<AssetKey, string>;
    result[accountId] = {
      active: true, profile: "growth",
      accountAllocations: structuredClone(PROFILE_PRESETS),
      etfNames,
      enabledAssets: [...ASSET_ORDER],
      baseAmount: latest?.[1].baseAmount ?? 0,
      deposit: 0,
      rebalanceDate: new Date().toISOString().slice(0, 10),
      holdings: ASSET_ORDER.map((k) => ({ assetKey: k, etfName: etfNames[k], value: latestHoldings[k] ?? 0 })),
      history,
    };
  }
  return result as Record<AccountId, AccountState>;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════
export function SettingsPage({ familyData, onFamilyUpdate }: SettingsProps) {
  const { currentUser } = usePortfolioStore();
  const isMaster = currentUser === "hyeobi";

  const MAIN_TABS: { id: MainTab; label: string }[] = [
    { id: "investment", label: "투자성향" },
    { id: "data",       label: "데이터 관리" },
    { id: "security",   label: "보안" },
    ...(isMaster ? [{ id: "users" as MainTab, label: "사용자 관리" }] : []),
  ];

  const [mainTab, setMainTab] = useState<MainTab>("investment");
  const [unsavedWarning, setUnsavedWarning] = useState<AccountId[]>([]);
  const investTabRef = useRef<{ getUnsavedAccounts: () => AccountId[] }>(null);

  function handleTabChange(newTab: MainTab) {
    if (mainTab === "investment" && newTab !== "investment") {
      const unsaved = investTabRef.current?.getUnsavedAccounts() ?? [];
      if (unsaved.length > 0) {
        setUnsavedWarning(unsaved);
        setTimeout(() => setUnsavedWarning([]), 5000);
      }
    }
    setMainTab(newTab);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 상단 탭 바 */}
      <div className="shrink-0 px-4 md:px-6 pt-4 md:pt-6">
        <h2 className="text-xl md:text-2xl font-bold mb-4">설정</h2>
        <div className="flex items-end">
          <div className="flex-1 border-b border-border" />
          <div className="flex items-end">
            {MAIN_TABS.map(({ id, label }) => {
              const isActive = mainTab === id;
              return (
                <button
                  key={id}
                  onClick={() => handleTabChange(id)}
                  className={[
                    "px-5 py-2.5 text-sm font-semibold rounded-t-lg border-x border-t transition-all select-none",
                    isActive
                      ? "bg-background text-foreground border-border relative -mb-px pb-3.5 shadow-sm z-10"
                      : "bg-muted/50 text-muted-foreground border-border/50 hover:bg-muted hover:text-foreground ml-0.5",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex-1 border-b border-border" />
        </div>
      </div>

      {/* 미저장 경고 배너 */}
      {unsavedWarning.length > 0 && (
        <div className="mx-4 md:mx-6 mt-2 px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl shrink-0">
          {unsavedWarning.map((id) => (
            <p key={id} className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {ACCOUNT_LABELS_SHORT[id]}계좌에서의 변동사항이 저장되지 않았습니다.
            </p>
          ))}
        </div>
      )}

      {/* 탭 콘텐츠 */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {mainTab === "investment" && <InvestmentTab ref={investTabRef} />}
          {mainTab === "data"       && <DataTab />}
          {mainTab === "security"   && <SecurityTab familyData={familyData} onFamilyUpdate={onFamilyUpdate} />}
          {mainTab === "users" && isMaster && <UserManagementTab familyData={familyData} onFamilyUpdate={onFamilyUpdate} />}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Draft types for InvestmentTab
// ══════════════════════════════════════════════════════════════════════════════
interface DraftRow {
  id: string;
  assetId: string;
  etfName: string;
}

interface DraftProfileData {
  rows: DraftRow[];
  allocations: Record<string, number>;
}

interface DraftAccountState {
  active: boolean;
  profile: ProfileKey;
  profileData: Record<ProfileKey, DraftProfileData>;
}

const MAX_ROWS = 10;
const MAX_PER_KEY = 3;
const ORDERED_GROUPS = ["주식", "대체투자", "안전자산", "현금성자산"] as const;

function makeDraft(acc: AccountState, library: AssetDef[]): DraftAccountState {
  const validIds = new Set(library.map((d) => d.id));
  const profileData = {} as Record<ProfileKey, DraftProfileData>;

  for (const p of Object.keys(PROFILE_LABELS) as ProfileKey[]) {
    let rows: DraftRow[];

    if (acc.profileRows?.[p]?.length) {
      rows = acc.profileRows[p]
        .filter((r) => validIds.has(r.assetId))
        .map((r) => {
          const def = library.find((d) => d.id === r.assetId)!;
          return { id: r.id, assetId: r.assetId, etfName: r.etfName ?? def?.defaultEtf ?? "" };
        });
    } else if (acc.assetRows?.length) {
      rows = acc.assetRows
        .filter((r) => validIds.has(r.assetKey))
        .map((r) => ({ id: r.id, assetId: r.assetKey, etfName: r.etfName }));
    } else {
      const srcKeys = acc.enabledAssets?.length ? acc.enabledAssets : [...ASSET_ORDER];
      rows = srcKeys
        .filter((k) => validIds.has(k))
        .map((k) => ({
          id: k, assetId: k,
          etfName: acc.etfNames?.[k] ?? ASSET_GROUPS[k as AssetKey]?.defaultEtf ?? k,
        }));
    }

    const baseAlloc = acc.profileAllocations?.[p] ?? acc.rowAllocations?.[p] ?? {};
    const allocations: Record<string, number> = {};
    for (const r of rows) {
      allocations[r.id] =
        baseAlloc[r.id]
        ?? acc.accountAllocations?.[p]?.[r.assetId as AssetKey]
        ?? PROFILE_PRESETS[p]?.[r.assetId as AssetKey]
        ?? 0;
    }

    profileData[p] = { rows, allocations };
  }

  return { active: acc.active !== false, profile: acc.profile ?? "growth", profileData };
}

// ══════════════════════════════════════════════════════════════════════════════
// 종목 설정 모달
// ══════════════════════════════════════════════════════════════════════════════
interface AssetLibraryModalProps {
  open: boolean;
  library: AssetDef[];
  onSave: (lib: AssetDef[]) => void;
  onClose: () => void;
}

function AssetLibraryModal({ open, library, onSave, onClose }: AssetLibraryModalProps) {
  const [draftLib, setDraftLib] = useState<AssetDef[]>([]);
  const [activeGroup, setActiveGroup] = useState<string>("주식");
  const [showAddFor, setShowAddFor] = useState<string | null>(null);
  const [addLabel, setAddLabel] = useState("");
  const [addEtf, setAddEtf] = useState("");
  const [addTicker, setAddTicker] = useState("");

  useEffect(() => {
    if (open) {
      setDraftLib([...library]);
      setActiveGroup("주식");
      setShowAddFor(null); setAddLabel(""); setAddEtf(""); setAddTicker("");
    }
  }, [open, library]);

  function handleEtfChange(id: string, v: string) {
    setDraftLib((prev) => prev.map((d) => d.id === id ? { ...d, defaultEtf: v } : d));
  }
  function handleTickerChange(id: string, v: string) {
    const code = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    setDraftLib((prev) => prev.map((d) => d.id === id ? { ...d, ticker: code } : d));
  }
  function handleDelete(id: string) {
    setDraftLib((prev) => prev.filter((d) => d.id !== id));
  }
  function handleAdd() {
    if (!addLabel.trim() || !addEtf.trim() || !addTicker.trim() || !showAddFor) return;
    const newDef: AssetDef = {
      id: `custom_${Date.now()}`,
      group: showAddFor,
      label: addLabel.trim(),
      defaultEtf: addEtf.trim(),
      ticker: addTicker.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6),
      isBuiltIn: false,
    };
    setDraftLib((prev) => [...prev, newDef]);
    setAddLabel(""); setAddEtf(""); setAddTicker(""); setShowAddFor(null);
  }

  function moveLabel(label: string, direction: -1 | 1) {
    setDraftLib((prev) => {
      // separate into before-this-group, this-group, after-this-group
      const firstGroupIdx = prev.findIndex((d) => d.group === activeGroup);
      const lastGroupIdx = prev.reduce((acc, d, i) => d.group === activeGroup ? i : acc, -1);
      if (firstGroupIdx < 0) return prev;
      const before = prev.slice(0, firstGroupIdx);
      const groupItems = prev.slice(firstGroupIdx, lastGroupIdx + 1);
      const after = prev.slice(lastGroupIdx + 1);
      // build ordered label list
      const labels = Array.from(new Map(groupItems.map((d) => [d.label, true])).keys());
      const idx = labels.indexOf(label);
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= labels.length) return prev;
      [labels[idx], labels[newIdx]] = [labels[newIdx], labels[idx]];
      const reordered = labels.flatMap((l) => groupItems.filter((d) => d.label === l));
      return [...before, ...reordered, ...after];
    });
  }

  // Group draftLib entries by label within activeGroup
  const labelGroups = (() => {
    const seen = new Map<string, AssetDef[]>();
    for (const def of draftLib.filter((d) => d.group === activeGroup)) {
      const arr = seen.get(def.label) ?? [];
      arr.push(def);
      seen.set(def.label, arr);
    }
    return Array.from(seen.entries()).map(([label, defs]) => ({ label, defs }));
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>종목 설정</DialogTitle>
        </DialogHeader>

        {/* 카테고리 탭 */}
        <div className="flex gap-1 bg-muted p-1 rounded-xl shrink-0">
          {ORDERED_GROUPS.map((g) => (
            <button
              key={g}
              onClick={() => { setActiveGroup(g); setShowAddFor(null); setAddLabel(""); setAddEtf(""); }}
              className={[
                "flex-1 py-1.5 text-xs rounded-lg font-medium transition-all",
                activeGroup === g
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {g}
            </button>
          ))}
        </div>

        {/* 자산 목록 (자산명 기준 그룹핑) */}
        <ScrollArea className="flex-1 min-h-0 -mx-1 px-1">
          <div className="space-y-3 pb-2">
            {labelGroups.map(({ label, defs }, groupIdx) => (
              <div key={label} className="space-y-1">
                {/* 자산명 헤더 */}
                <div className="flex items-center gap-2 px-1 py-0.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: GROUP_COLORS[activeGroup] }}
                  />
                  <span className="text-sm font-semibold flex-1">
                    {label}
                    {defs.length > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground font-normal">
                        ({defs.length})
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => moveLabel(label, -1)}
                    disabled={groupIdx === 0}
                    className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-violet-500 hover:bg-violet-500/10 transition-all disabled:opacity-25 shrink-0"
                    title="위로"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => moveLabel(label, 1)}
                    disabled={groupIdx === labelGroups.length - 1}
                    className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-violet-500 hover:bg-violet-500/10 transition-all disabled:opacity-25 shrink-0"
                    title="아래로"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setShowAddFor(activeGroup); setAddLabel(label); setAddEtf(""); }}
                    className="text-muted-foreground hover:text-violet-500 transition-colors p-0.5 rounded"
                    title="이 자산에 ETF 추가"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                {/* ETF 행 */}
                {defs.map((def) => (
                  <div key={def.id} className="flex items-center gap-2 ml-4">
                    <Input
                      value={def.defaultEtf}
                      onChange={(e) => handleEtfChange(def.id, e.target.value)}
                      className="h-8 text-sm flex-1"
                      placeholder="ETF 종목명"
                    />
                    <div className="relative shrink-0">
                      <Input
                        value={def.ticker ?? ""}
                        onChange={(e) => handleTickerChange(def.id, e.target.value)}
                        className={`h-8 text-sm w-24 text-center tabular-nums pr-2 ${def.ticker?.length === 6 ? "border-emerald-400/60 focus-visible:ring-emerald-500" : ""}`}
                        placeholder="종목코드"
                        maxLength={6}
                      />
                      {def.ticker && def.ticker.length > 0 && def.ticker.length < 6 && (
                        <span className="absolute -bottom-3.5 left-0 text-[9px] text-amber-500 whitespace-nowrap">{def.ticker.length}/6자리</span>
                      )}
                    </div>
                    {def.isBuiltIn ? (
                      <div className="w-7 shrink-0" />
                    ) : (
                      <button
                        onClick={() => handleDelete(def.id)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 transition-all shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {/* 추가 폼 */}
            {showAddFor === activeGroup ? (
              <div className="space-y-2 pt-2 border-t mt-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder="자산명 입력"
                    className="h-8 text-sm flex-1"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") { setShowAddFor(null); setAddLabel(""); setAddEtf(""); setAddTicker(""); } }}
                  />
                  <Input
                    value={addEtf}
                    onChange={(e) => setAddEtf(e.target.value)}
                    placeholder="ETF 종목명"
                    className="h-8 text-sm w-40"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                  />
                  <div className="relative shrink-0">
                    <Input
                      value={addTicker}
                      onChange={(e) => setAddTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                      placeholder="종목코드*"
                      className={`h-8 text-sm w-24 text-center tabular-nums ${addTicker.length === 6 ? "border-emerald-400/60" : addTicker.length > 0 ? "border-amber-400/60" : "border-rose-400/40"}`}
                      maxLength={6}
                      onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                    />
                    <span className="absolute -bottom-3.5 left-0 text-[9px] text-muted-foreground whitespace-nowrap">6자리 필수</span>
                  </div>
                  <Button size="sm" className="h-8 px-3 shrink-0" onClick={handleAdd}
                    disabled={!addLabel.trim() || !addEtf.trim() || addTicker.length !== 6}>
                    추가
                  </Button>
                  <button
                    onClick={() => { setShowAddFor(null); setAddLabel(""); setAddEtf(""); setAddTicker(""); }}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground transition-all shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setShowAddFor(activeGroup); setAddLabel(""); setAddEtf(""); }}
                className="w-full mt-2 py-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-violet-500 border border-dashed rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> {activeGroup} 자산 추가
              </button>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" onClick={onClose}>취소</Button>
          <Button onClick={() => onSave(draftLib)}>
            <Save className="w-3.5 h-3.5 mr-1" /> 저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 투자성향 탭
// ══════════════════════════════════════════════════════════════════════════════
interface InvestmentTabHandle {
  getUnsavedAccounts: () => AccountId[];
}

const InvestmentTab = forwardRef<InvestmentTabHandle>(function InvestmentTab(_, ref) {
  const { state, updateAccount, updateAssetLibrary, updateRowMemo } = usePortfolioStore();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);

  const [selectedAccount, setSelectedAccount] = useState<AccountId>("retirement");
  const [draft, setDraft] = useState<DraftAccountState>(() =>
    makeDraft(state.accounts.retirement, library)
  );
  const [perAccountDrafts, setPerAccountDrafts] = useState<Partial<Record<AccountId, DraftAccountState>>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [addGroup, setAddGroup] = useState<string>("");
  const [addLabel, setAddLabel] = useState<string>("");
  const [addAsset, setAddAsset] = useState<string>("");
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [memoRowId, setMemoRowId] = useState<string | null>(null);
  const [memoText, setMemoText] = useState("");

  // ── Expose unsaved accounts to parent ──────────────────────────────────
  useImperativeHandle(ref, () => ({
    getUnsavedAccounts: () => {
      const result: AccountId[] = [];
      for (const id of ACCOUNT_IDS) {
        const d = id === selectedAccount ? draft : perAccountDrafts[id];
        if (!d) continue;
        const baseline = JSON.stringify(makeDraft(state.accounts[id], library));
        if (JSON.stringify(d) !== baseline) result.push(id);
      }
      return result;
    },
  }), [draft, perAccountDrafts, state.accounts, selectedAccount, library]);

  // ── Derived state ───────────────────────────────────────────────────────
  const storeAccount = state.accounts[selectedAccount];
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(makeDraft(storeAccount, library));
  const currentProfile = draft.profile;
  const currentPD = draft.profileData[currentProfile];
  const currentAlloc = currentPD.allocations;
  const total = currentPD.rows.reduce((s, r) => s + (currentAlloc[r.id] ?? 0), 0);
  const atLimit = currentPD.rows.length >= MAX_ROWS;

  // ── Account switching ───────────────────────────────────────────────────
  function selectAccount(id: AccountId) {
    setPerAccountDrafts((prev) => ({ ...prev, [selectedAccount]: draft }));
    const next = perAccountDrafts[id] ?? makeDraft(state.accounts[id], library);
    setDraft(next);
    setSelectedAccount(id);
    setShowAddForm(false);
    setAddGroup(""); setAddLabel(""); setAddAsset("");
  }

  // ── Save ────────────────────────────────────────────────────────────────
  function handleSave() {
    const profileRows: Record<ProfileKey, ProfileRowDef[]> = {} as Record<ProfileKey, ProfileRowDef[]>;
    const profileAllocations: Record<ProfileKey, Record<string, number>> = {} as Record<ProfileKey, Record<string, number>>;

    for (const p of Object.keys(PROFILE_LABELS) as ProfileKey[]) {
      const pd = draft.profileData[p];
      profileRows[p] = pd.rows.map((r) => ({ id: r.id, assetId: r.assetId, etfName: r.etfName }));
      profileAllocations[p] = { ...pd.allocations };
    }

    // Backwards-compat: reconstruct legacy fields from current profile's rows
    const refPd = draft.profileData[draft.profile];
    const enabledAssets = [...new Set(
      refPd.rows.map((r) => r.assetId).filter((id) => ASSET_ORDER.includes(id as AssetKey))
    )] as AssetKey[];
    const etfNames = Object.fromEntries(
      ASSET_ORDER.map((k) => {
        const row = refPd.rows.find((r) => r.assetId === k);
        return [k, row?.etfName ?? ASSET_GROUPS[k].defaultEtf];
      })
    ) as Record<AssetKey, string>;
    const accountAllocations = Object.fromEntries(
      (Object.keys(PROFILE_LABELS) as ProfileKey[]).map((p) => [
        p,
        Object.fromEntries(
          ASSET_ORDER.map((k) => [
            k,
            draft.profileData[p].rows
              .filter((r) => r.assetId === k)
              .reduce((s, r) => s + (draft.profileData[p].allocations[r.id] ?? 0), 0),
          ])
        ),
      ])
    ) as Record<ProfileKey, Record<AssetKey, number>>;

    updateAccount(selectedAccount, {
      active: draft.active,
      profile: draft.profile,
      profileRows,
      profileAllocations,
      enabledAssets,
      etfNames,
      accountAllocations,
      assetRows: profileRows[draft.profile].map((r) => ({
        id: r.id, assetKey: r.assetId as AssetKey, etfName: r.etfName ?? "",
      })),
      rowAllocations: profileAllocations,
    });

    // Remove from temp saves once saved
    setPerAccountDrafts((prev) => {
      const next = { ...prev };
      delete next[selectedAccount];
      return next;
    });
  }

  // ── Allocation change ───────────────────────────────────────────────────
  function handleAllocChange(rowId: string, v: string) {
    const p = currentProfile;
    setDraft((d) => ({
      ...d,
      profileData: {
        ...d.profileData,
        [p]: {
          ...d.profileData[p],
          allocations: { ...d.profileData[p].allocations, [rowId]: parseFloat(v) || 0 },
        },
      },
    }));
  }

  // ── Reset to preset ─────────────────────────────────────────────────────
  function handleResetAlloc() {
    const p = currentProfile;
    if (p === "custom") return;
    const preset = PROFILE_PRESETS[p];
    // Reset rows back to all built-in assets + reset allocations
    const defaultRows: DraftRow[] = library
      .filter((d) => d.isBuiltIn && ASSET_ORDER.includes(d.id as AssetKey))
      .sort((a, b) => ASSET_ORDER.indexOf(a.id as AssetKey) - ASSET_ORDER.indexOf(b.id as AssetKey))
      .map((d) => ({
        id: d.id,
        assetId: d.id,
        etfName: storeAccount.etfNames?.[d.id as AssetKey] ?? d.defaultEtf,
      }));
    const newAlloc: Record<string, number> = {};
    for (const r of defaultRows) {
      newAlloc[r.id] = preset[r.assetId as AssetKey] ?? 0;
    }
    setDraft((d) => ({
      ...d,
      profileData: { ...d.profileData, [p]: { rows: defaultRows, allocations: newAlloc } },
    }));
  }

  // ── Remove row ──────────────────────────────────────────────────────────
  function handleRemoveRow(id: string) {
    const p = currentProfile;
    setDraft((d) => ({
      ...d,
      profileData: {
        ...d.profileData,
        [p]: {
          rows: d.profileData[p].rows.filter((r) => r.id !== id),
          allocations: Object.fromEntries(
            Object.entries(d.profileData[p].allocations).filter(([k]) => k !== id)
          ),
        },
      },
    }));
  }

  // ── Count for asset ID in current profile ───────────────────────────────
  function countForAsset(assetId: string): number {
    return currentPD.rows.filter((r) => r.assetId === assetId).length;
  }

  // ── Add asset handlers ──────────────────────────────────────────────────
  function handleGroupChange(g: string) {
    setAddGroup(g);
    setAddLabel("");
    setAddAsset("");
  }

  function handleLabelChange(label: string) {
    setAddLabel(label);
    const defsForLabel = library.filter((d) => d.group === addGroup && d.label === label);
    const available = defsForLabel.find((d) => countForAsset(d.id) < MAX_PER_KEY);
    setAddAsset(defsForLabel.length === 1 && available ? defsForLabel[0].id : "");
  }

  function handleAssetSelect(defId: string) {
    setAddAsset(defId);
  }

  function handleAddRow() {
    if (!addAsset || atLimit || countForAsset(addAsset) >= MAX_PER_KEY) return;
    const def = library.find((d) => d.id === addAsset);
    if (!def) return;
    const newId = `${addAsset}_${Date.now()}`;
    const newRow: DraftRow = { id: newId, assetId: addAsset, etfName: def.defaultEtf };
    const p = currentProfile;
    setDraft((d) => {
      const newAlloc = { ...d.profileData[p].allocations, [newId]: 0 };
      return {
        ...d,
        profileData: {
          ...d.profileData,
          [p]: { rows: [...d.profileData[p].rows, newRow], allocations: newAlloc },
        },
      };
    });
    setShowAddForm(false);
    setAddGroup(""); setAddLabel(""); setAddAsset("");
  }

  // ── Memo handlers ───────────────────────────────────────────────────────
  function handleRowEtfChange(rowId: string, newEtfName: string) {
    setDraft((d) => {
      const nextProfileData = { ...d.profileData };
      for (const p of Object.keys(nextProfileData) as ProfileKey[]) {
        nextProfileData[p] = {
          ...nextProfileData[p],
          rows: nextProfileData[p].rows.map((r) =>
            r.id === rowId ? { ...r, etfName: newEtfName } : r,
          ),
        };
      }
      return { ...d, profileData: nextProfileData };
    });
  }

  function handleMemoOpen(rowId: string) {
    setMemoText(storeAccount.rowMemos?.[`${currentProfile}:${rowId}`] ?? "");
    setMemoRowId(rowId);
  }

  function handleMemoSave() {
    if (!memoRowId) return;
    updateRowMemo(selectedAccount, `${currentProfile}:${memoRowId}`, memoText);
    setMemoRowId(null);
  }

  // ── Duplicate row display numbers ───────────────────────────────────────
  const keyCounts: Record<string, number> = {};
  for (const r of currentPD.rows) keyCounts[r.assetId] = (keyCounts[r.assetId] ?? 0) + 1;
  const keyProgress: Record<string, number> = {};
  const rowDisplayNum: Record<string, number | null> = {};
  for (const r of currentPD.rows) {
    keyProgress[r.assetId] = (keyProgress[r.assetId] ?? 0) + 1;
    rowDisplayNum[r.id] = keyCounts[r.assetId] > 1 ? keyProgress[r.assetId] : null;
  }

  const canAddRow = !!addAsset && !atLimit && countForAsset(addAsset) < MAX_PER_KEY;
  const labelsInGroup = (() => {
    const seen = new Map<string, AssetDef[]>();
    for (const def of library.filter((d) => d.group === addGroup)) {
      const arr = seen.get(def.label) ?? [];
      arr.push(def);
      seen.set(def.label, arr);
    }
    return Array.from(seen.entries()).map(([label, defs]) => ({ label, defs }));
  })();
  const defsForLabel = addLabel ? library.filter((d) => d.group === addGroup && d.label === addLabel) : [];

  return (
    <div className="space-y-5">
      {/* 종목 설정 모달 */}
      <AssetLibraryModal
        open={showLibraryModal}
        library={library}
        onSave={(lib) => { updateAssetLibrary(lib); setShowLibraryModal(false); }}
        onClose={() => setShowLibraryModal(false)}
      />

      {/* 계좌 선택 */}
      <Card className="p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">계좌 선택</h3>
        <div className="flex gap-2 flex-wrap">
          {ACCOUNT_IDS.map((id) => {
            const acc = state.accounts[id];
            const isActive = acc.active !== false;
            const isSelected = selectedAccount === id;
            const hasTempChanges = perAccountDrafts[id] !== undefined &&
              JSON.stringify(perAccountDrafts[id]) !== JSON.stringify(makeDraft(state.accounts[id], library));
            return (
              <button
                key={id}
                onClick={() => selectAccount(id)}
                className={[
                  "px-4 py-2 rounded-xl text-sm font-semibold border transition-all",
                  isSelected
                    ? "bg-gradient-to-r from-violet-500 to-blue-500 text-white border-transparent shadow-md"
                    : isActive
                      ? "bg-card border-border hover:bg-muted text-foreground"
                      : "bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted",
                ].join(" ")}
              >
                {ACCOUNT_LABELS_SHORT[id]}
                {!isActive && <span className="ml-1.5 text-[10px] opacity-60">미사용</span>}
                {hasTempChanges && <span className="ml-1.5 text-[10px] text-amber-400">●</span>}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer group w-fit">
          <div
            onClick={() => setDraft((d) => ({ ...d, active: !d.active }))}
            className={[
              "w-5 h-5 rounded border-2 flex items-center justify-center transition-all cursor-pointer",
              draft.active
                ? "bg-violet-500 border-violet-500"
                : "border-muted-foreground/40 hover:border-violet-400",
            ].join(" ")}
          >
            {draft.active && <CheckCircle2 className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
          </div>
          <span className="text-sm font-medium select-none">이 계좌를 사용합니다</span>
        </label>
      </Card>

      {draft.active && (
        <>
          {/* 투자성향 프리셋 */}
          <Card className="p-5 space-y-3">
            <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">투자성향</h3>
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex gap-1.5 bg-muted p-1 rounded-xl w-fit">
                {(Object.keys(PROFILE_LABELS) as ProfileKey[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setDraft((d) => ({ ...d, profile: p }))}
                    className={[
                      "px-4 py-1.5 text-sm rounded-lg transition-all font-medium",
                      currentProfile === p
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    {PROFILE_LABELS[p]}
                  </button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowLibraryModal(true)}>
                <Settings className="w-3.5 h-3.5 mr-1" /> 종목 설정
              </Button>
            </div>
          </Card>

          {/* 자산별 설정 테이블 */}
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between gap-3 flex-wrap">
              <div className="shrink-0">
                <h3 className="font-semibold">자산별 ETF 및 비중 설정</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <span className={atLimit ? "text-amber-500 font-semibold" : ""}>
                    {currentPD.rows.length}/10
                  </span>
                  {" · "}합계{" "}
                  <span className={Math.abs(total - 100) > 0.1 ? "text-rose-500 font-bold" : "text-emerald-500 font-bold"}>
                    {total.toFixed(1)}%
                  </span>
                </p>
              </div>
              <div className="flex gap-2 items-center flex-wrap justify-end">
                {currentProfile !== "custom" && (
                  <Button variant="outline" size="sm" onClick={handleResetAlloc}>
                    <RotateCcw className="w-3.5 h-3.5 mr-1" /> 기본값
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={atLimit}
                  title={atLimit ? "최대 10개까지 추가할 수 있습니다" : undefined}
                  onClick={() => {
                    if (showAddForm) {
                      setShowAddForm(false);
                      setAddGroup(""); setAddLabel(""); setAddAsset("");
                    } else {
                      setShowAddForm(true);
                    }
                  }}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  {atLimit ? "최대 10개" : "자산 추가"}
                </Button>
                <Button size="sm" disabled={!hasChanges} onClick={handleSave} className="min-w-[64px]">
                  <Save className="w-3.5 h-3.5 mr-1" /> 저장
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground w-36">자산</th>
                    <th className="hidden sm:table-cell text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground">ETF 종목명</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground w-24">비중 (%)</th>
                    <th className="w-10 px-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {currentPD.rows.map((row) => {
                    const def = library.find((d) => d.id === row.assetId);
                    const group = def?.group ?? "";
                    const label = def?.label ?? row.assetId;
                    const num = rowDisplayNum[row.id];
                    return (
                      <tr key={row.id} className="hover:bg-muted/20 transition-colors group">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ background: GROUP_COLORS[group] ?? "#888" }}
                            />
                            <div className="min-w-0">
                              <div className="text-[11px] text-muted-foreground">{group}</div>
                              <div className="font-medium text-xs">
                                {label}
                                {num !== null && (
                                  <span className="ml-1 text-[10px] text-muted-foreground font-normal">({num})</span>
                                )}
                              </div>
                              {/* 모바일에서 ETF명 + 메모 버튼 */}
                              <div className="sm:hidden flex items-center gap-1 mt-0.5">
                                <span className="text-[11px] text-muted-foreground/70 truncate max-w-[130px]">{row.etfName}</span>
                                <button
                                  onClick={() => handleMemoOpen(row.id)}
                                  title="메모"
                                  className={[
                                    "w-5 h-5 rounded flex items-center justify-center transition-all shrink-0",
                                    storeAccount.rowMemos?.[`${currentProfile}:${row.id}`]
                                      ? "text-amber-500"
                                      : "text-muted-foreground/50",
                                  ].join(" ")}
                                >
                                  <MessageSquare className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="hidden sm:table-cell px-4 py-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {(() => {
                              const alternatives = library.filter(
                                (d) => def && d.label === def.label && d.defaultEtf && d.ticker,
                              );
                              if (alternatives.length <= 1) {
                                return <span className="text-sm truncate max-w-[210px]">{row.etfName}</span>;
                              }
                              return (
                                <Select value={row.etfName} onValueChange={(v) => handleRowEtfChange(row.id, v)}>
                                  <SelectTrigger className="h-8 w-[200px] text-sm">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {alternatives.map((d) => (
                                      <SelectItem key={d.id} value={d.defaultEtf}>
                                        {d.defaultEtf}
                                        <span className="ml-1 text-xs opacity-50">({d.ticker})</span>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              );
                            })()}
                            <button
                              onClick={() => handleMemoOpen(row.id)}
                              title="메모"
                              className={[
                                "w-6 h-6 rounded flex items-center justify-center transition-all shrink-0",
                                storeAccount.rowMemos?.[`${currentProfile}:${row.id}`]
                                  ? "text-amber-500 hover:text-amber-600"
                                  : "text-muted-foreground hover:text-violet-500 opacity-0 group-hover:opacity-100",
                              ].join(" ")}
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Input
                            type="number"
                            step="0.5"
                            value={currentAlloc[row.id] ?? 0}
                            onChange={(e) => handleAllocChange(row.id, e.target.value)}
                            className="h-8 text-right w-20 ml-auto"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <button
                            onClick={() => handleRemoveRow(row.id)}
                            title="이 행 삭제"
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 자산 추가 폼 */}
            {showAddForm && (
              <div className="px-5 py-4 border-t bg-muted/20 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  자산 추가
                  <span className="ml-2 normal-case font-normal text-muted-foreground/70">
                    · 종목 설정에서 자산을 먼저 등록해두세요
                  </span>
                </p>
                <div className="flex gap-2 items-end flex-wrap">
                  {/* 카테고리 */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">카테고리</label>
                    <Select value={addGroup} onValueChange={handleGroupChange}>
                      <SelectTrigger className="h-8 w-32 text-sm">
                        <SelectValue placeholder="선택" />
                      </SelectTrigger>
                      <SelectContent>
                        {ORDERED_GROUPS.map((g) => (
                          <SelectItem key={g} value={g}>{g}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* 자산 (label 기준 드롭다운) */}
                  {addGroup && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">자산</label>
                      <Select value={addLabel} onValueChange={handleLabelChange}>
                        <SelectTrigger className="h-8 w-52 text-sm">
                          <SelectValue placeholder="선택" />
                        </SelectTrigger>
                        <SelectContent>
                          {labelsInGroup.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                              등록된 자산이 없습니다.<br />종목 설정에서 추가하세요.
                            </div>
                          ) : (
                            labelsInGroup.map(({ label, defs }) => {
                              const allAtMax = defs.every((d) => countForAsset(d.id) >= MAX_PER_KEY);
                              return (
                                <SelectItem key={label} value={label} disabled={allAtMax}>
                                  <span className="flex items-center gap-1.5">
                                    {label}
                                    {defs.length > 1 && (
                                      <span className={`text-[10px] ${allAtMax ? "text-rose-400" : "text-muted-foreground"}`}>
                                        {allAtMax ? "(최대)" : `(${defs.length})`}
                                      </span>
                                    )}
                                    {defs.length === 1 && allAtMax && (
                                      <span className="text-[10px] text-rose-400">(최대)</span>
                                    )}
                                  </span>
                                </SelectItem>
                              );
                            })
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* ETF 종목명 — 1개면 읽기전용 표시, 여럿이면 드롭다운 */}
                  {addLabel && defsForLabel.length > 0 && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">ETF 종목명</label>
                      {defsForLabel.length === 1 ? (
                        <div className="h-8 px-3 flex items-center rounded-lg border bg-muted/50 text-sm text-foreground w-52 truncate">
                          {defsForLabel[0].defaultEtf}
                        </div>
                      ) : (
                        <Select value={addAsset} onValueChange={handleAssetSelect}>
                          <SelectTrigger className="h-8 w-52 text-sm">
                            <SelectValue placeholder="선택" />
                          </SelectTrigger>
                          <SelectContent>
                            {defsForLabel.map((def) => {
                              const atMax = countForAsset(def.id) >= MAX_PER_KEY;
                              return (
                                <SelectItem key={def.id} value={def.id} disabled={atMax}>
                                  {def.defaultEtf}{atMax ? " (최대)" : ""}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}

                  <div className="flex gap-1.5 pb-0.5">
                    <Button
                      size="sm"
                      onClick={handleAddRow}
                      disabled={!canAddRow}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" /> 추가
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setShowAddForm(false);
                        setAddGroup(""); setAddLabel(""); setAddAsset("");
                      }}
                    >
                      취소
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {!draft.active && (
        <Card className="p-8 text-center text-muted-foreground">
          <p className="text-sm">이 계좌를 사용하려면 위에서 체크박스를 선택하세요.</p>
        </Card>
      )}

      {/* 메모 팝업 */}
      {memoRowId && (() => {
        const memoRow = currentPD.rows.find((r) => r.id === memoRowId);
        const memoDef = memoRow ? library.find((d) => d.id === memoRow.assetId) : null;
        return (
          <Dialog open onOpenChange={(v) => !v && setMemoRowId(null)}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-sm font-semibold">
                  {memoDef?.label ?? "메모"} · {memoRow?.etfName}
                </DialogTitle>
              </DialogHeader>
              <Textarea
                value={memoText}
                onChange={(e) => setMemoText(e.target.value)}
                placeholder="이 종목에 대한 메모를 입력하세요..."
                className="min-h-[120px] text-sm resize-none"
                autoFocus
              />
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setMemoRowId(null)}>취소</Button>
                <Button size="sm" onClick={handleMemoSave}>
                  <Save className="w-3.5 h-3.5 mr-1" /> 저장
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}
    </div>
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 데이터 관리 탭
// ══════════════════════════════════════════════════════════════════════════════
function DataTab() {
  const { state, resetAll, importJson } = usePortfolioStore();
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const xlsxFileRef = useRef<HTMLInputElement>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kaw-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function onImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    f.text().then((t) => {
      try { importJson(JSON.parse(t)); toast.success("JSON 가져오기 완료"); }
      catch { toast.error("잘못된 JSON 파일입니다."); }
    });
    e.target.value = "";
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const NUM_FMT = '#,##0';
    const PCT_FMT = '0.0%';

    ACCOUNT_IDS.forEach((id) => {
      const acc = state.accounts[id];
      const alloc = getAccountAlloc(state, id);
      const history = acc.history;
      if (history.length === 0) return;
      const nDates = history.length;
      const ROW = { dateHeader: 0, subHeader: 1, assetStart: 2, assetEnd: 2 + ASSET_ORDER.length - 1, deposit: 2 + ASSET_ORDER.length, total: 2 + ASSET_ORDER.length + 1, returnRow: 2 + ASSET_ORDER.length + 2, note: 2 + ASSET_ORDER.length + 3 };
      const COL = { group: 0, asset: 1, etf: 2, weight: 3, dataStart: 4, rebalance: 4 + nDates * 2 + 1 };
      const ws: XLSX.WorkSheet = {};
      const a = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
      const col = (c: number) => XLSX.utils.encode_col(c);
      const str = (r: number, c: number, v: string) => { if (v !== '') ws[a(r, c)] = { t: 's', v }; };
      const num = (r: number, c: number, v: number, z?: string) => { ws[a(r, c)] = z ? { t: 'n', v, z } : { t: 'n', v }; };
      const fml = (r: number, c: number, f: string, z?: string) => { ws[a(r, c)] = z ? { t: 'n', f, z } : { t: 'n', f }; };
      str(ROW.dateHeader, COL.group, '구분'); str(ROW.dateHeader, COL.asset, '투자 대상'); str(ROW.dateHeader, COL.etf, 'ETF'); str(ROW.dateHeader, COL.weight, '배분'); str(ROW.dateHeader, COL.rebalance, '추가매수');
      history.forEach((h, i) => str(ROW.dateHeader, COL.dataStart + i * 2, h.date));
      history.forEach((_, i) => { str(ROW.subHeader, COL.dataStart + i * 2, '평가 금액'); str(ROW.subHeader, COL.dataStart + i * 2 + 1, '기준 금액'); });
      ASSET_ORDER.forEach((k, ai) => {
        const r = ROW.assetStart + ai; const exR = r + 1; const pct = alloc[k] || 0; const ag = ASSET_GROUPS[k]; const hold = (acc.holdings ?? []).find(h => h.assetKey === k);
        str(r, COL.group, ag.group); str(r, COL.asset, ag.label); str(r, COL.etf, hold?.etfName ?? ag.defaultEtf); str(r, COL.weight, `${pct}%`);
        history.forEach((h, i) => {
          const evalCol = COL.dataStart + i * 2; const baseCol = COL.dataStart + i * 2 + 1;
          const evalVal = h.holdings?.[k];
          if (evalVal != null && evalVal > 0) num(r, evalCol, evalVal, NUM_FMT);
          fml(r, baseCol, `${col(evalCol)}${exR}/${pct / 100}*${pct / 100}`, NUM_FMT);
          const baseVal = evalVal != null ? Math.round((h.baseAmount * pct) / 100) : 0;
          if (baseVal > 0) num(r, baseCol, baseVal, NUM_FMT);
        });
        const lastEvalCol = COL.dataStart + (nDates - 1) * 2; const lastBaseCol = COL.dataStart + (nDates - 1) * 2 + 1;
        fml(r, COL.rebalance, `${col(lastBaseCol)}${exR}-${col(lastEvalCol)}${exR}`, NUM_FMT);
      });
      str(ROW.deposit, COL.group, '기타'); str(ROW.deposit, COL.asset, '월 불입액');
      history.forEach((h, i) => { if (h.deposit > 0) num(ROW.deposit, COL.dataStart + i * 2 + 1, h.deposit, NUM_FMT); });
      str(ROW.total, COL.group, '자산합계'); str(ROW.total, COL.weight, '100%');
      const r1 = ROW.assetStart + 1; const r2 = ROW.assetEnd + 1;
      history.forEach((_, i) => {
        const ec = col(COL.dataStart + i * 2); const bc = col(COL.dataStart + i * 2 + 1);
        fml(ROW.total, COL.dataStart + i * 2, `SUM(${ec}${r1}:${ec}${r2})`, NUM_FMT);
        fml(ROW.total, COL.dataStart + i * 2 + 1, `SUM(${bc}${r1}:${bc}${r2})`, NUM_FMT);
      });
      str(ROW.returnRow, COL.group, '상승');
      const totR = ROW.total + 1; const depR = ROW.deposit + 1;
      history.forEach((_, i) => {
        if (i === 0) return;
        const curEvalC = col(COL.dataStart + i * 2); const curDepC = col(COL.dataStart + i * 2 + 1); const prevEvalC = col(COL.dataStart + (i - 1) * 2);
        fml(ROW.returnRow, COL.dataStart + i * 2, `(${curEvalC}${totR}-${curDepC}${depR}-${prevEvalC}${totR})/${prevEvalC}${totR}`, PCT_FMT);
      });
      str(ROW.note, COL.group, 'UH : 환노출형  H : 환헤지형');
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: ROW.note, c: COL.rebalance } });
      ws['!cols'] = [{ wch: 10 }, { wch: 16 }, { wch: 28 }, { wch: 6 }, ...Array.from({ length: nDates * 2 }, () => ({ wch: 14 })), { wch: 4 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, ACCOUNT_LABELS_SHORT[id]);
    });
    XLSX.writeFile(wb, `kaw-portfolio-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function onImportExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const parsed = parseExcelWorkbook(wb);
        const importedAccounts = Object.keys(parsed);
        if (importedAccounts.length === 0) { toast.error("인식된 계좌 시트가 없습니다. 시트명을 확인해주세요."); return; }
        importJson({ ...state, accounts: { ...state.accounts, ...parsed } });
        toast.success(`가져오기 완료 — ${importedAccounts.map(id => ACCOUNT_LABELS_SHORT[id as AccountId]).join(", ")}`);
      } catch { toast.error("엑셀 파일을 읽을 수 없습니다."); }
    };
    reader.readAsArrayBuffer(f);
    e.target.value = "";
  }

  return (
    <div className="space-y-6">
      {/* 계좌별 요약 */}
      <Card className="p-6 space-y-4">
        <h3 className="font-semibold">계좌별 데이터 현황</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ACCOUNT_IDS.map((id) => {
            const acc = state.accounts[id];
            const last = acc.history.length > 0 ? acc.history[acc.history.length - 1] : null;
            return (
              <div key={id} className="p-3 rounded-lg bg-muted/40 text-sm">
                <p className="font-medium">{ACCOUNT_LABELS_SHORT[id]}</p>
                <p className="text-muted-foreground text-xs mt-0.5">{last ? `${last.date} 기준` : "데이터 없음"}</p>
                <p className="font-semibold tabular-nums mt-1">{formatKRW(last?.totalValue ?? 0)} 원</p>
                <p className="text-xs text-muted-foreground">
                  히스토리 {acc.history.length}건 ·
                  종목데이터 {acc.history.filter(h => h.holdings && Object.keys(h.holdings).length > 0).length}건
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      {/* JSON */}
      <Card className="p-6 space-y-4">
        <h3 className="font-semibold">JSON (전체 데이터 백업/복원)</h3>
        <div className="flex gap-2 flex-wrap">
          <input ref={jsonFileRef} type="file" accept="application/json" hidden onChange={onImportJson} />
          <Button variant="outline" size="sm" onClick={() => jsonFileRef.current?.click()}>
            <Upload className="w-4 h-4 mr-1.5" /> JSON 가져오기
          </Button>
          <Button variant="outline" size="sm" onClick={exportJson}>
            <Download className="w-4 h-4 mr-1.5" /> JSON 내보내기
          </Button>
        </div>
      </Card>

      {/* Excel */}
      <Card className="p-6 space-y-4">
        <h3 className="font-semibold">엑셀 (계좌별 시트 형식)</h3>
        <p className="text-xs text-muted-foreground">가져오기: 퇴직연금·ISA·연금저축·IRP 시트명이 있는 파일만 가능</p>
        <div className="flex gap-2 flex-wrap">
          <input ref={xlsxFileRef} type="file" accept=".xlsx,.xls" hidden onChange={onImportExcel} />
          <Button variant="outline" size="sm" onClick={() => xlsxFileRef.current?.click()}>
            <FileSpreadsheet className="w-4 h-4 mr-1.5" /> 엑셀 가져오기
          </Button>
          <Button variant="outline" size="sm" onClick={exportExcel}>
            <FileSpreadsheet className="w-4 h-4 mr-1.5" /> 엑셀 내보내기
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">UH: 환노출 · H: 환헤지</p>
      </Card>

      {/* 초기화 */}
      <Card className="p-6">
        <h3 className="font-semibold mb-3">데이터 초기화</h3>
        <Button variant="destructive" size="sm" onClick={() => setShowResetConfirm(true)}>
          <Trash2 className="w-4 h-4 mr-1.5" /> 전체 초기화
        </Button>
      </Card>

      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>데이터 초기화</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">모든 데이터를 초기화할까요? 엑셀 원본 히스토리 데이터는 자동 복원됩니다.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowResetConfirm(false)}>취소</Button>
            <Button variant="destructive" size="sm" onClick={() => { resetAll(); setShowResetConfirm(false); }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> 초기화
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 보안 탭
// ══════════════════════════════════════════════════════════════════════════════
interface SecurityTabProps {
  familyData: FamilyData;
  onFamilyUpdate: (fd: FamilyData) => void;
}

function SecurityTab({ familyData, onFamilyUpdate }: SecurityTabProps) {
  const { currentUser, familyCode } = usePortfolioStore();
  const canChangeMasterCode = currentUser === "hyeobi";

  // PIN change
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinNew, setPinNew] = useState("");
  const [pinNewConfirm, setPinNewConfirm] = useState("");
  const [pinMsg, setPinMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  // Master code change
  const [mcCurrent, setMcCurrent] = useState("");
  const [mcNew, setMcNew] = useState("");
  const [mcNewConfirm, setMcNewConfirm] = useState("");
  const [mcMsg, setMcMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [mcLoading, setMcLoading] = useState(false);

  // Master code reset via secret question
  type ResetStep = "idle" | "question" | "new_code";
  const [resetStep, setResetStep] = useState<ResetStep>("idle");
  const [resetQIdx, setResetQIdx] = useState<SQIndex>(0);
  const [resetAnswer, setResetAnswer] = useState("");
  const [resetAnswerErr, setResetAnswerErr] = useState<string | null>(null);
  const [resetNewCode, setResetNewCode] = useState("");
  const [resetNewCodeConfirm, setResetNewCodeConfirm] = useState("");
  const [resetMsg, setResetMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  function startReset() {
    setResetQIdx(pickRandomSQIndex());
    setResetAnswer(""); setResetAnswerErr(null);
    setResetNewCode(""); setResetNewCodeConfirm(""); setResetMsg(null);
    setResetStep("question");
  }

  async function handleResetAnswerVerify(e: React.FormEvent) {
    e.preventDefault();
    setResetLoading(true);
    const ok = await verifySQAnswer(resetQIdx, resetAnswer);
    setResetLoading(false);
    if (!ok) {
      setResetAnswerErr("정답이 맞지 않습니다. 다시 시도해주세요.");
      setResetAnswer("");
      return;
    }
    setResetStep("new_code");
  }

  async function handleResetMasterCode(e: React.FormEvent) {
    e.preventDefault();
    if (!familyCode) return;
    if (!resetNewCode.trim()) { setResetMsg({ type: "err", text: "새 마스터 코드를 입력해주세요." }); return; }
    if (resetNewCode !== resetNewCodeConfirm) { setResetMsg({ type: "err", text: "새 마스터 코드가 일치하지 않습니다." }); return; }
    setResetLoading(true);
    try {
      const updated = await updateMasterCodeViaSecretQuestion(resetNewCode, familyCode, resetQIdx, resetAnswer);
      onFamilyUpdate(updated);
      setResetMsg({ type: "ok", text: "마스터 코드가 재설정되었습니다." });
      setResetNewCode(""); setResetNewCodeConfirm("");
      setTimeout(() => { setResetStep("idle"); setResetMsg(null); }, 2000);
    } catch { setResetMsg({ type: "err", text: "저장 중 오류가 발생했습니다." }); }
    setResetLoading(false);
  }

  async function handlePinChange(e: React.FormEvent) {
    e.preventDefault();
    if (!familyCode || !currentUser) return;
    if (pinNew.length !== 4 || !/^\d{4}$/.test(pinNew)) { setPinMsg({ type: "err", text: "새 비밀번호는 숫자 4자리여야 합니다." }); return; }
    if (pinNew !== pinNewConfirm) { setPinMsg({ type: "err", text: "새 비밀번호가 일치하지 않습니다." }); return; }
    setPinLoading(true);
    const ok = await verifyPin(familyCode, currentUser, pinCurrent, familyData);
    if (!ok) { setPinMsg({ type: "err", text: "현재 비밀번호가 틀렸습니다." }); setPinLoading(false); return; }
    try {
      const updated = await updatePin(familyCode, currentUser, pinNew, familyData);
      onFamilyUpdate(updated);
      setPinMsg({ type: "ok", text: "비밀번호가 변경되었습니다." });
      setPinCurrent(""); setPinNew(""); setPinNewConfirm("");
    } catch { setPinMsg({ type: "err", text: "저장 중 오류가 발생했습니다." }); }
    setPinLoading(false);
  }

  async function handleMcChange(e: React.FormEvent) {
    e.preventDefault();
    if (!familyCode) return;
    if (!mcNew.trim()) { setMcMsg({ type: "err", text: "새 마스터 코드를 입력해주세요." }); return; }
    if (mcNew !== mcNewConfirm) { setMcMsg({ type: "err", text: "새 마스터 코드가 일치하지 않습니다." }); return; }
    setMcLoading(true);
    const ok = await verifyMasterCode(mcCurrent, familyData, familyCode);
    if (!ok) { setMcMsg({ type: "err", text: "현재 마스터 코드가 틀렸습니다." }); setMcLoading(false); return; }
    try {
      const updated = await updateMasterCode(mcNew, familyData, familyCode);
      onFamilyUpdate(updated);
      setMcMsg({ type: "ok", text: "마스터 코드가 변경되었습니다." });
      setMcCurrent(""); setMcNew(""); setMcNewConfirm("");
    } catch { setMcMsg({ type: "err", text: "저장 중 오류가 발생했습니다." }); }
    setMcLoading(false);
  }

  return (
    <div className="space-y-6">
      {/* 비밀번호 변경 */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-violet-500" />
          <h3 className="font-semibold">프로필 비밀번호 변경</h3>
        </div>
        <form onSubmit={handlePinChange} className="space-y-3 max-w-sm">
          {[
            { label: "현재 비밀번호", value: pinCurrent, set: setPinCurrent },
            { label: "새 비밀번호 (숫자 4자리)", value: pinNew, set: setPinNew },
            { label: "새 비밀번호 확인", value: pinNewConfirm, set: setPinNewConfirm },
          ].map(({ label, value, set }) => (
            <div key={label} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{label}</label>
              <input type="password" inputMode="numeric" maxLength={4} value={value}
                onChange={(e) => { set(e.target.value.replace(/\D/g, "")); setPinMsg(null); }}
                placeholder="••••"
                className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all tracking-[0.4em]" />
            </div>
          ))}
          {pinMsg && (
            <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${pinMsg.type === "ok" ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"}`}>
              {pinMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
              {pinMsg.text}
            </div>
          )}
          <Button type="submit" size="sm" disabled={pinLoading || pinCurrent.length !== 4 || pinNew.length !== 4 || pinNewConfirm.length !== 4}>
            {pinLoading ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <KeyRound className="w-3.5 h-3.5 mr-1" />}
            비밀번호 변경
          </Button>
        </form>
      </Card>

      {/* 마스터 코드 변경 (혀비 전용) */}
      {canChangeMasterCode && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-amber-500" />
            <div>
              <h3 className="font-semibold">액세스 코드(마스터) 변경</h3>
              <p className="text-xs text-muted-foreground">혀비 프로필 전용 · 기본값은 앱 액세스 코드와 동일</p>
            </div>
          </div>
          <form onSubmit={handleMcChange} className="space-y-3 max-w-sm">
            {[
              { label: "현재 마스터 코드", value: mcCurrent, set: setMcCurrent },
              { label: "새 마스터 코드", value: mcNew, set: setMcNew },
              { label: "새 마스터 코드 확인", value: mcNewConfirm, set: setMcNewConfirm },
            ].map(({ label, value, set }) => (
              <div key={label} className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{label}</label>
                <input type="password" value={value}
                  onChange={(e) => { set(e.target.value); setMcMsg(null); }}
                  placeholder="마스터 코드"
                  className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all" />
              </div>
            ))}
            {mcMsg && (
              <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${mcMsg.type === "ok" ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"}`}>
                {mcMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                {mcMsg.text}
              </div>
            )}
            <Button type="submit" size="sm" variant="outline" disabled={mcLoading || !mcCurrent || !mcNew}>
              {mcLoading ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Shield className="w-3.5 h-3.5 mr-1" />}
              마스터 코드 변경
            </Button>
          </form>

          {/* 마스터 코드 초기화 (비밀 질문) */}
          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">마스터 코드를 잊으셨나요?</p>
              {resetStep === "idle" && (
                <button
                  onClick={startReset}
                  className="text-xs text-violet-500 hover:text-violet-600 font-medium transition-colors"
                >
                  비밀 질문으로 초기화 →
                </button>
              )}
              {resetStep !== "idle" && (
                <button
                  onClick={() => { setResetStep("idle"); setResetAnswer(""); setResetAnswerErr(null); setResetMsg(null); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  취소
                </button>
              )}
            </div>

            {resetStep === "question" && (
              <form onSubmit={handleResetAnswerVerify} className="space-y-3 max-w-sm">
                <div className="bg-muted/50 border rounded-xl px-4 py-3">
                  <p className="text-sm font-medium">{SECRET_QUESTIONS[resetQIdx].question}</p>
                </div>
                <input
                  type="text"
                  value={resetAnswer}
                  onChange={(e) => { setResetAnswer(e.target.value); setResetAnswerErr(null); }}
                  placeholder="정답을 입력하세요"
                  autoFocus
                  autoComplete="off"
                  className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition-all"
                />
                {resetAnswerErr && (
                  <div className="flex items-center gap-2 text-xs text-rose-500 bg-rose-500/10 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />{resetAnswerErr}
                  </div>
                )}
                <Button type="submit" size="sm" disabled={!resetAnswer.trim()}>
                  확인
                </Button>
              </form>
            )}

            {resetStep === "new_code" && (
              <form onSubmit={handleResetMasterCode} className="space-y-3 max-w-sm">
                <div className="flex items-center gap-2 text-xs text-emerald-500 bg-emerald-500/10 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> 인증 완료! 새 마스터 코드를 설정하세요.
                </div>
                {[
                  { label: "새 마스터 코드", value: resetNewCode, set: setResetNewCode },
                  { label: "새 마스터 코드 확인", value: resetNewCodeConfirm, set: setResetNewCodeConfirm },
                ].map(({ label, value, set }) => (
                  <div key={label} className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{label}</label>
                    <input
                      type="password"
                      value={value}
                      onChange={(e) => { set(e.target.value); setResetMsg(null); }}
                      placeholder="마스터 코드"
                      className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all"
                    />
                  </div>
                ))}
                {resetMsg && (
                  <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${resetMsg.type === "ok" ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"}`}>
                    {resetMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                    {resetMsg.text}
                  </div>
                )}
                <Button type="submit" size="sm" variant="outline" disabled={resetLoading || !resetNewCode || !resetNewCodeConfirm}>
                  {resetLoading ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Shield className="w-3.5 h-3.5 mr-1" />}
                  마스터 코드 재설정
                </Button>
              </form>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 사용자 관리 탭 (혀비 전용)
// ══════════════════════════════════════════════════════════════════════════════
interface UserManagementTabProps {
  familyData: FamilyData;
  onFamilyUpdate: (fd: FamilyData) => void;
}

type DeleteStep = "choose" | "verify";
type DeleteMode = "soft" | "hard";

function UserManagementTab({ familyData, onFamilyUpdate }: UserManagementTabProps) {
  const { familyCode } = usePortfolioStore();
  const [deleteTarget, setDeleteTarget] = useState<ProfileConfig | null>(null);
  const [deleteMode, setDeleteMode] = useState<DeleteMode | null>(null);
  const [deleteStep, setDeleteStep] = useState<DeleteStep>("choose");
  const [masterInput, setMasterInput] = useState("");
  const [masterError, setMasterError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const nonMasterProfiles = familyData.profiles.filter((p) => p.id !== "hyeobi");

  const AVATAR_COLORS = [
    "from-emerald-500 to-teal-500",
    "from-amber-500 to-orange-500",
    "from-rose-500 to-pink-500",
    "from-sky-500 to-cyan-500",
    "from-purple-500 to-indigo-500",
  ];

  function openDelete(profile: ProfileConfig) {
    setDeleteTarget(profile);
    setDeleteMode(null);
    setDeleteStep("choose");
    setMasterInput("");
    setMasterError(null);
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteMode(null);
    setDeleteStep("choose");
    setMasterInput("");
    setMasterError(null);
  }

  async function handleDeleteConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!deleteTarget || !deleteMode || !familyCode) return;
    const ok = await verifyMasterCode(masterInput, familyData, familyCode);
    if (!ok) {
      setMasterError("마스터 코드가 일치하지 않습니다.");
      setMasterInput("");
      return;
    }
    setLoading(true);
    try {
      let updated: FamilyData;
      if (deleteMode === "soft") {
        updated = await softDeleteProfile(familyCode, deleteTarget.id, familyData);
        setDoneMsg(`${deleteTarget.label} 프로필이 삭제됐습니다. 데이터는 보존됩니다.`);
      } else {
        updated = await hardDeleteProfile(familyCode, deleteTarget.id, familyData);
        setDoneMsg(`${deleteTarget.label}의 모든 데이터가 삭제됐습니다.`);
      }
      onFamilyUpdate(updated);
      closeDelete();
      setTimeout(() => setDoneMsg(null), 4000);
    } catch (err: unknown) {
      setMasterError((err as { message?: string })?.message ?? "삭제 중 오류가 발생했습니다.");
    }
    setLoading(false);
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-violet-500" />
          <div>
            <h3 className="font-semibold">사용자 관리</h3>
            <p className="text-xs text-muted-foreground">혀비 계정을 제외한 프로필을 관리합니다.</p>
          </div>
        </div>

        {doneMsg && (
          <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-xl px-3 py-2.5">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{doneMsg}
          </div>
        )}

        {nonMasterProfiles.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">관리할 프로필이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {nonMasterProfiles.map((p, i) => (
              <div key={p.id} className="flex items-center justify-between p-3 rounded-xl border bg-muted/20">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center shrink-0`}>
                    <span className="text-sm font-bold text-white">{p.label.charAt(0)}</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.id}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openDelete(p)}
                  className="text-rose-500 hover:text-rose-600 hover:bg-rose-500/10 hover:border-rose-300 dark:hover:border-rose-800"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> 삭제
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 삭제 다이얼로그 */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && closeDelete()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-rose-500" />
              프로필 삭제
            </DialogTitle>
          </DialogHeader>

          {deleteStep === "choose" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{deleteTarget?.label}</span> 프로필을 어떻게 삭제할까요?
              </p>
              <div className="space-y-2">
                <button
                  onClick={() => { setDeleteMode("soft"); setDeleteStep("verify"); }}
                  className="w-full p-4 text-left rounded-xl border hover:border-violet-400 hover:bg-violet-500/5 transition-all"
                >
                  <p className="text-sm font-semibold">프로필만 삭제</p>
                  <p className="text-xs text-muted-foreground mt-1">계좌 데이터는 보존됩니다. 나중에 같은 이름으로 다시 만들면 데이터를 복원할 수 있습니다.</p>
                </button>
                <button
                  onClick={() => { setDeleteMode("hard"); setDeleteStep("verify"); }}
                  className="w-full p-4 text-left rounded-xl border border-rose-200/40 dark:border-rose-900/40 hover:border-rose-400 hover:bg-rose-500/5 transition-all"
                >
                  <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">데이터 모두 삭제</p>
                  <p className="text-xs text-muted-foreground mt-1">프로필과 모든 계좌 히스토리가 영구 삭제됩니다. 복원 불가.</p>
                </button>
              </div>
            </div>
          )}

          {deleteStep === "verify" && (
            <form onSubmit={handleDeleteConfirm} className="space-y-3">
              <div className={`p-3 rounded-xl text-xs ${deleteMode === "hard" ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-300/30" : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-300/30"}`}>
                {deleteMode === "hard"
                  ? `⚠️ ${deleteTarget?.label}의 모든 데이터가 영구 삭제됩니다. 되돌릴 수 없습니다.`
                  : `${deleteTarget?.label} 프로필을 삭제합니다. 계좌 데이터는 보존됩니다.`}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">마스터 코드를 입력하여 확인</label>
                <input
                  type="password"
                  value={masterInput}
                  onChange={(e) => { setMasterInput(e.target.value); setMasterError(null); }}
                  placeholder="마스터 코드"
                  autoFocus
                  autoComplete="off"
                  className="w-full h-10 px-3 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 transition-all"
                />
              </div>
              {masterError && (
                <div className="flex items-center gap-2 text-xs text-rose-500 bg-rose-500/10 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />{masterError}
                </div>
              )}
              <DialogFooter className="gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => setDeleteStep("choose")}>
                  이전
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant={deleteMode === "hard" ? "destructive" : "default"}
                  disabled={loading || !masterInput}
                >
                  {loading
                    ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5 mr-1" />}
                  삭제 확인
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
