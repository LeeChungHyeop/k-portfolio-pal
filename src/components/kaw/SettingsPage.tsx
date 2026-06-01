import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  PROFILE_LABELS, ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS,
  ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, PROFILE_PRESETS,
  type ProfileKey, type AccountId, type AssetKey,
} from "@/lib/kaw/constants";
import {
  usePortfolioStore, formatKRW, getAccountAlloc,
  type HistoryEntry, type AccountState,
} from "@/lib/kaw/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  RotateCcw, Download, Upload, FileSpreadsheet, Trash2,
  KeyRound, Shield, CheckCircle2, AlertCircle, RefreshCw,
  Plus, X, Save,
} from "lucide-react";
import {
  type FamilyData,
  verifyPin, updatePin, verifyMasterCode, updateMasterCode,
} from "@/lib/kaw/auth";
import {
  SECRET_QUESTIONS, pickRandomSQIndex, verifySQAnswer, type SQIndex,
} from "@/lib/kaw/secretQuestions";

// ── Main tab types ─────────────────────────────────────────────────────────
type MainTab = "investment" | "data" | "security";

const MAIN_TABS: { id: MainTab; label: string }[] = [
  { id: "investment", label: "투자성향" },
  { id: "data",       label: "데이터 관리" },
  { id: "security",   label: "보안" },
];

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
  const [mainTab, setMainTab] = useState<MainTab>("investment");

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
                  onClick={() => setMainTab(id)}
                  className={[
                    "px-6 py-2.5 text-sm font-semibold rounded-t-lg border-x border-t transition-all select-none",
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

      {/* 탭 콘텐츠 */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {mainTab === "investment" && <InvestmentTab />}
          {mainTab === "data"       && <DataTab />}
          {mainTab === "security"   && <SecurityTab familyData={familyData} onFamilyUpdate={onFamilyUpdate} />}
        </div>
      </div>
    </div>
  );
}

// ── Draft type & helpers ───────────────────────────────────────────────────
interface DraftSettings {
  active: boolean;
  profile: ProfileKey;
  accountAllocations: Record<ProfileKey, Record<AssetKey, number>>;
  etfNames: Record<AssetKey, string>;
  enabledAssets: AssetKey[];
}

function makeDraft(acc: AccountState): DraftSettings {
  return {
    active: acc.active !== false,
    profile: acc.profile ?? "growth",
    accountAllocations: structuredClone(acc.accountAllocations ?? PROFILE_PRESETS),
    etfNames: { ...(acc.etfNames ?? (Object.fromEntries(ASSET_ORDER.map((k) => [k, ASSET_GROUPS[k].defaultEtf])) as Record<AssetKey, string>)) },
    enabledAssets: [...(acc.enabledAssets?.length ? acc.enabledAssets : [...ASSET_ORDER])],
  };
}

const ORDERED_GROUPS = ["주식", "국채", "대체투자", "현금성자산"] as const;

// ══════════════════════════════════════════════════════════════════════════════
// 투자성향 탭
// ══════════════════════════════════════════════════════════════════════════════
function InvestmentTab() {
  const { state, updateAccount } = usePortfolioStore();

  const [selectedAccount, setSelectedAccount] = useState<AccountId>("retirement");
  const [draft, setDraft] = useState<DraftSettings>(() => makeDraft(state.accounts["retirement"]));
  const [showAddForm, setShowAddForm] = useState(false);
  const [addGroup, setAddGroup] = useState("");
  const [addAsset, setAddAsset] = useState<AssetKey | "">("");
  const [addEtfName, setAddEtfName] = useState("");

  const storeAccount = state.accounts[selectedAccount];
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(makeDraft(storeAccount));
  const currentAlloc = draft.accountAllocations[draft.profile] ?? PROFILE_PRESETS[draft.profile];
  const total = draft.enabledAssets.reduce((s, k) => s + (currentAlloc[k] || 0), 0);
  const hasAnyDisabled = ASSET_ORDER.some((k) => !draft.enabledAssets.includes(k));

  function selectAccount(id: AccountId) {
    setSelectedAccount(id);
    setDraft(makeDraft(state.accounts[id]));
    setShowAddForm(false);
    setAddGroup(""); setAddAsset(""); setAddEtfName("");
  }

  function handleSave() {
    updateAccount(selectedAccount, {
      active: draft.active,
      profile: draft.profile,
      accountAllocations: draft.accountAllocations,
      etfNames: draft.etfNames,
      enabledAssets: draft.enabledAssets,
    });
  }

  function handleAllocChange(k: AssetKey, v: string) {
    const p = draft.profile;
    setDraft((d) => ({
      ...d,
      accountAllocations: { ...d.accountAllocations, [p]: { ...d.accountAllocations[p], [k]: parseFloat(v) || 0 } },
    }));
  }

  function handleResetAlloc() {
    const p = draft.profile;
    setDraft((d) => ({
      ...d,
      accountAllocations: {
        ...d.accountAllocations,
        [p]: p === "custom" ? ({} as Record<AssetKey, number>) : { ...PROFILE_PRESETS[p] },
      },
    }));
  }

  function handleToggleAsset(k: AssetKey, enabled: boolean) {
    setDraft((d) => {
      const current = d.enabledAssets;
      const enabledAssets = enabled
        ? [...new Set([...current, k])].sort((a, b) => ASSET_ORDER.indexOf(a) - ASSET_ORDER.indexOf(b))
        : current.filter((a) => a !== k);
      return { ...d, enabledAssets };
    });
  }

  function getDisabledInGroup(group: string): AssetKey[] {
    return ASSET_ORDER.filter((k) => ASSET_GROUPS[k].group === group && !draft.enabledAssets.includes(k));
  }

  function handleGroupChange(g: string) {
    setAddGroup(g);
    const opts = getDisabledInGroup(g);
    const first = (opts[0] ?? "") as AssetKey | "";
    setAddAsset(first);
    setAddEtfName(first ? (draft.etfNames[first] || ASSET_GROUPS[first].defaultEtf) : "");
  }

  function handleAddAssetSelect(k: AssetKey) {
    setAddAsset(k);
    setAddEtfName(draft.etfNames[k] || ASSET_GROUPS[k].defaultEtf);
  }

  function handleAddAsset() {
    if (!addAsset) return;
    const k = addAsset as AssetKey;
    setDraft((d) => ({
      ...d,
      enabledAssets: [...new Set([...d.enabledAssets, k])].sort((a, b) => ASSET_ORDER.indexOf(a) - ASSET_ORDER.indexOf(b)),
      etfNames: { ...d.etfNames, [k]: addEtfName || ASSET_GROUPS[k].defaultEtf },
    }));
    setShowAddForm(false);
    setAddGroup(""); setAddAsset(""); setAddEtfName("");
  }

  return (
    <div className="space-y-5">
      {/* 계좌 선택 */}
      <Card className="p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">계좌 선택</h3>
        <div className="flex gap-2 flex-wrap">
          {ACCOUNT_IDS.map((id) => {
            const acc = state.accounts[id];
            const isActive = acc.active !== false;
            const isSelected = selectedAccount === id;
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
              </button>
            );
          })}
        </div>

        {/* 이 계좌 사용 체크박스 */}
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

      {/* 투자성향 설정 (활성 계좌만) */}
      {draft.active && (
        <>
          {/* 성향 프리셋 선택 */}
          <Card className="p-5 space-y-3">
            <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">투자성향</h3>
            <div className="flex gap-1.5 bg-muted p-1 rounded-xl w-fit">
              {(Object.keys(PROFILE_LABELS) as ProfileKey[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setDraft((d) => ({ ...d, profile: p }))}
                  className={[
                    "px-4 py-1.5 text-sm rounded-lg transition-all font-medium",
                    draft.profile === p
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  {PROFILE_LABELS[p]}
                </button>
              ))}
            </div>
          </Card>

          {/* 자산별 설정 테이블 */}
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between gap-3">
              <div className="shrink-0">
                <h3 className="font-semibold">자산별 ETF 및 비중 설정</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  합계{" "}
                  <span className={Math.abs(total - 100) > 0.1 ? "text-rose-500 font-bold" : "text-emerald-500 font-bold"}>
                    {total.toFixed(1)}%
                  </span>
                </p>
              </div>
              <div className="flex gap-2 items-center flex-wrap justify-end">
                {draft.profile !== "custom" && (
                  <Button variant="outline" size="sm" onClick={handleResetAlloc}>
                    <RotateCcw className="w-3.5 h-3.5 mr-1" /> 기본값
                  </Button>
                )}
                {hasAnyDisabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (showAddForm) {
                        setShowAddForm(false);
                        setAddGroup(""); setAddAsset(""); setAddEtfName("");
                      } else {
                        setShowAddForm(true);
                      }
                    }}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" /> 자산 추가
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!hasChanges}
                  onClick={handleSave}
                  className="min-w-[64px]"
                >
                  <Save className="w-3.5 h-3.5 mr-1" />
                  저장
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground w-32">자산군</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground">ETF 종목명</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground w-24">비중 (%)</th>
                    <th className="w-10 px-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {draft.enabledAssets.map((k) => (
                    <tr key={k} className="hover:bg-muted/20 transition-colors group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: GROUP_COLORS[ASSET_GROUPS[k].group] }} />
                          <div>
                            <div className="text-[11px] text-muted-foreground">{ASSET_GROUPS[k].group}</div>
                            <div className="font-medium text-xs">{ASSET_GROUPS[k].label}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          value={draft.etfNames[k] ?? ASSET_GROUPS[k].defaultEtf}
                          onChange={(e) => setDraft((d) => ({ ...d, etfNames: { ...d.etfNames, [k]: e.target.value } }))}
                          className="h-8 text-sm max-w-[260px]"
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Input
                          type="number"
                          step="0.5"
                          value={currentAlloc[k] ?? 0}
                          onChange={(e) => handleAllocChange(k, e.target.value)}
                          className="h-8 text-right w-20 ml-auto"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <button
                          onClick={() => handleToggleAsset(k, false)}
                          title="이 자산 비활성화"
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 자산 추가 폼 */}
            {showAddForm && (
              <div className="px-5 py-4 border-t bg-muted/20 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">자산 추가</p>
                <div className="flex gap-2 items-end flex-wrap">
                  {/* 큰 카테고리 */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">카테고리</label>
                    <Select value={addGroup} onValueChange={handleGroupChange}>
                      <SelectTrigger className="h-8 w-32 text-sm">
                        <SelectValue placeholder="선택" />
                      </SelectTrigger>
                      <SelectContent>
                        {ORDERED_GROUPS.map((g) => (
                          <SelectItem key={g} value={g} disabled={getDisabledInGroup(g).length === 0}>
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* 작은 카테고리 */}
                  {addGroup && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">자산</label>
                      <Select value={addAsset} onValueChange={(v) => handleAddAssetSelect(v as AssetKey)}>
                        <SelectTrigger className="h-8 w-44 text-sm">
                          <SelectValue placeholder="선택" />
                        </SelectTrigger>
                        <SelectContent>
                          {getDisabledInGroup(addGroup).map((k) => (
                            <SelectItem key={k} value={k}>
                              {ASSET_GROUPS[k].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* ETF 종목명 직접 입력 */}
                  {addAsset && (
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">ETF 종목명</label>
                      <Input
                        value={addEtfName}
                        onChange={(e) => setAddEtfName(e.target.value)}
                        placeholder="ETF 종목명 입력"
                        className="h-8 text-sm w-52"
                      />
                    </div>
                  )}

                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={handleAddAsset}
                      disabled={!addAsset || !addEtfName.trim()}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" /> 추가
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setShowAddForm(false);
                        setAddGroup(""); setAddAsset(""); setAddEtfName("");
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
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 데이터 관리 탭
// ══════════════════════════════════════════════════════════════════════════════
function DataTab() {
  const { state, resetAll, importJson } = usePortfolioStore();
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const xlsxFileRef = useRef<HTMLInputElement>(null);

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kaw-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function onImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    f.text().then((t) => { try { importJson(JSON.parse(t)); } catch { alert("잘못된 JSON 파일입니다."); } });
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
        const r = ROW.assetStart + ai; const exR = r + 1; const pct = alloc[k] || 0; const ag = ASSET_GROUPS[k]; const hold = acc.holdings.find(h => h.assetKey === k);
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
        if (importedAccounts.length === 0) { alert("인식된 계좌 시트가 없습니다.\n시트명이 퇴직연금 / ISA / 연금저축 / IRP 인지 확인해주세요."); return; }
        importJson({ ...state, accounts: { ...state.accounts, ...parsed } });
        alert(`가져오기 완료!\n적용된 계좌: ${importedAccounts.map(id => ACCOUNT_LABELS_SHORT[id as AccountId]).join(", ")}`);
      } catch (err) { alert(`엑셀 파일 읽기 실패: ${err}`); }
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
        <Button variant="destructive" size="sm"
          onClick={() => { if (confirm("모든 데이터를 초기화할까요?\n엑셀 원본 히스토리 데이터는 자동 복원됩니다.")) resetAll(); }}>
          <Trash2 className="w-4 h-4 mr-1.5" /> 전체 초기화
        </Button>
      </Card>
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
  const isAdmin = familyData.profiles.find((p) => p.id === currentUser)?.is_admin ?? false;

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

  function handleResetAnswerVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifySQAnswer(resetQIdx, resetAnswer)) {
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
      const updated = await updateMasterCode(resetNewCode, familyData, familyCode);
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

      {/* 마스터 코드 변경 (관리자 전용) */}
      {isAdmin && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-amber-500" />
            <div>
              <h3 className="font-semibold">액세스 코드(마스터) 변경</h3>
              <p className="text-xs text-muted-foreground">관리자 프로필 전용 · 기본값은 앱 액세스 코드와 동일</p>
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

            {/* 비밀 질문 입력 */}
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

            {/* 새 마스터 코드 설정 */}
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
