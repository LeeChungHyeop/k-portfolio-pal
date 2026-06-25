import { useMemo, useState, useEffect } from "react";
import { ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS, ACCOUNT_LABELS, type AccountId, type AssetKey } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct, getOrDefaultLibrary, type HistoryEntry } from "@/lib/kaw/store";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { Camera, Plus, Trash2, ChevronDown, ChevronRight, Save, Pencil, RefreshCw, Wifi, WifiOff, Zap } from "lucide-react";
import { toast } from "sonner";
import { useKisPrices } from "@/lib/kaw/useKisPrices";

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

// 콤마 포맷 숫자 입력 — null=비포커스(콤마표시), string=포커스(raw 숫자)
function NumberInput({ value, onChange, className, placeholder }: {
  value: number; onChange: (v: number) => void; className?: string; placeholder?: string;
}) {
  const [rawText, setRawText] = useState<string | null>(null);
  const display = rawText !== null ? rawText : (value > 0 ? formatKRW(value) : "");
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={display}
      placeholder={placeholder}
      className={className}
      onFocus={() => setRawText(value > 0 ? String(value) : "")}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, "");
        setRawText(digits);
        onChange(parseInt(digits, 10) || 0);
      }}
      onBlur={() => setRawText(null)}
    />
  );
}

type Tab = "rebalance" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "rebalance", label: "리밸런싱" },
  { id: "history",   label: "히스토리" },
];

export function AccountPage({ accountId }: { accountId: AccountId }) {
  const [tab, setTab] = useState<Tab>("rebalance");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 헤더 + 엑셀 시트탭 */}
      <div className="shrink-0 px-4 md:px-6 pt-4 md:pt-6">
        <h2 className="text-xl md:text-2xl font-bold mb-4 md:mb-5">{ACCOUNT_LABELS[accountId]}</h2>

        <div className="flex items-end">
          <div className="flex-1 border-b border-border" />
          <div className="flex items-end">
            {TABS.map(({ id, label }) => {
              const isActive = tab === id;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={[
                    "px-8 py-2.5 text-sm font-semibold rounded-t-lg border-x border-t transition-all select-none",
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
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6 border-t-0">
        <div className="max-w-5xl mx-auto">
          {tab === "rebalance"
            ? <RebalanceTab key={accountId} accountId={accountId} />
            : <HistoryTab   key={accountId} accountId={accountId} />
          }
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   리밸런싱 탭
───────────────────────────────────────────── */
function RebalanceTab({ accountId }: { accountId: AccountId }) {
  const { state, updateAccount, updateRowHolding, addHistory } = usePortfolioStore();
  const account = state.accounts[accountId];
  const library = getOrDefaultLibrary(state);

  const profile = account.profile ?? "growth";
  const profileRows = account.profileRows?.[profile] ?? [];
  const profileAlloc = account.profileAllocations?.[profile] ?? {};

  const lastHistory: HistoryEntry | null =
    account.history.length > 0 ? account.history[account.history.length - 1] : null;

  // ── 실시간 모드 상태 ───────────────────────────────────────────────────
  const [liveMode, setLiveMode] = useState(false);

  // 보유수량 — rowId 키, 로컬 state (세션 내 유지)
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // ── 기본 rows (rowHoldings 기반) ──────────────────────────────────────
  const rows = useMemo(() => {
    if (!profileRows.length) return [];
    return profileRows.map((row) => {
      const def = library.find((d) => d.id === row.assetId);
      const etfName = row.etfName ?? def?.defaultEtf ?? row.assetId;
      const group = def?.group ?? "";
      const label = def?.label ?? row.assetId;
      const alloc = profileAlloc[row.id] ?? 0;
      const legacyValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? (account.holdings.find((h) => h.assetKey === row.assetId)?.value ?? 0) : 0;
      const value = account.rowHoldings?.[row.id] ?? legacyValue;
      const prevValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? (lastHistory?.holdings?.[row.assetId as AssetKey] ?? null) : null;
      // ETF명으로 먼저 찾고, 없으면 assetId로 fallback
      const tickerByEtf = library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker;
      const ticker = tickerByEtf ?? def?.ticker ?? "";
      return { rowId: row.id, assetId: row.assetId, etfName, group, label, alloc, value, prevValue, ticker };
    });
  }, [account, profileRows, profileAlloc, library, lastHistory]);

  const manualTotal = rows.reduce((s, r) => s + r.value, 0);

  // ── TanStack Query: 실시간 주가 ───────────────────────────────────────
  const activeTickers = liveMode
    ? [...new Set(rows.map((r) => r.ticker).filter((t): t is string => t.length === 6))]
    : [];
  const { data: priceData, isLoading: priceLoading, isError: priceError, refetch: refetchPrices } = useKisPrices(activeTickers, liveMode);

  // Show toast when live mode has an issue
  useEffect(() => {
    if (!liveMode) return;
    if (priceError) toast.error("주가를 불러오지 못했습니다. 수동 입력 모드로 폴백됩니다.");
    else if (priceData && !priceData.configured) toast.error("KIS API 인증 정보가 설정되지 않았습니다. 수동 입력 모드로 유지됩니다.");
  }, [priceError, priceData?.configured, liveMode]);

  const isLiveActive = liveMode && !priceError && !!priceData?.configured;
  const livePrices = priceData?.prices ?? {};

  // ── 실시간 계산 ────────────────────────────────────────────────────────
  const liveValueByRow = useMemo((): Record<string, number> => {
    if (!isLiveActive) return {};
    return Object.fromEntries(
      rows.map((r) => {
        const price = r.ticker && livePrices[r.ticker] ? livePrices[r.ticker] : 0;
        return [r.rowId, (quantities[r.rowId] ?? 0) * price];
      }),
    );
  }, [isLiveActive, livePrices, quantities, rows]);

  const liveTotal = isLiveActive
    ? Object.values(liveValueByRow).reduce((s, v) => s + v, 0)
    : manualTotal;

  // effectiveBase: 실시간 모드 = (현재 평가금액 + 불입액), 수동 = baseAmount
  const effectiveBase = isLiveActive ? liveTotal + account.deposit : account.baseAmount;

  // 최종 effective rows (target/diff 재계산 포함)
  const effectiveRows = rows.map((r) => {
    const value = isLiveActive ? (liveValueByRow[r.rowId] ?? 0) : r.value;
    const target = (effectiveBase * r.alloc) / 100;
    const diff = target - value;
    const livePrice = isLiveActive && r.ticker ? (livePrices[r.ticker] ?? 0) : 0;
    return { ...r, value, target, diff, livePrice };
  });
  const effectiveTotal = effectiveRows.reduce((s, r) => s + r.value, 0);

  // ── 스냅샷 ─────────────────────────────────────────────────────────────
  function snapshotNow() {
    if (isLiveActive) {
      // 라이브 평가금액을 store에 반영 후 저장
      effectiveRows.forEach((r) => {
        if (r.value > 0) updateRowHolding(accountId, r.rowId, r.value);
      });
    }
    const holdingsSnap: Partial<Record<AssetKey, number>> = {};
    effectiveRows.forEach((r) => {
      if (r.value > 0 && ASSET_ORDER.includes(r.assetId as AssetKey)) {
        const k = r.assetId as AssetKey;
        holdingsSnap[k] = (holdingsSnap[k] ?? 0) + r.value;
      }
    });
    addHistory(accountId, {
      id: crypto.randomUUID(),
      date: account.rebalanceDate,
      baseAmount: effectiveBase,
      totalValue: effectiveTotal,
      deposit: account.deposit,
      holdings: holdingsSnap,
    });
    toast.success("리밸런싱이 저장됐습니다");
  }

  const colCount = 7 + (isLiveActive ? 1 : 0);

  return (
    <div className="space-y-5">
      {/* 이전 리밸런싱 요약 */}
      {lastHistory && (
        <Card className="p-4 bg-muted/30 border-dashed">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">이전 리밸런싱</p>
          <div className="grid grid-cols-3 gap-4">
            <div><p className="text-xs text-muted-foreground">일자</p><p className="font-semibold text-sm">{lastHistory.date}</p></div>
            <div><p className="text-xs text-muted-foreground">기준금액</p><p className="font-semibold text-sm tabular-nums">{formatKRW(lastHistory.baseAmount)}원</p></div>
            <div><p className="text-xs text-muted-foreground">평가금액</p><p className="font-semibold text-sm tabular-nums">{formatKRW(lastHistory.totalValue)}원</p></div>
          </div>
          {lastHistory.returnPct !== null && (
            <div className="mt-2 pt-2 border-t flex items-center gap-2">
              <span className="text-xs text-muted-foreground">전월 대비</span>
              <span className={`text-sm font-bold ${lastHistory.returnPct >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                {formatPct(lastHistory.returnPct)}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* 이번 리밸런싱 */}
      <Card className="p-5 space-y-4">
        {/* 헤더: 타이틀 + 실시간 모드 토글 */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">이번 리밸런싱</p>
          <div className="flex items-center gap-2">
            {liveMode && (
              <button
                onClick={() => refetchPrices()}
                disabled={priceLoading}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-violet-500 transition-colors"
                title="주가 수동 갱신"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${priceLoading ? "animate-spin" : ""}`} />
              </button>
            )}
            {liveMode && (
              <span className={`flex items-center gap-1 text-[10px] font-medium ${isLiveActive ? "text-emerald-500" : "text-amber-500"}`}>
                {isLiveActive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {isLiveActive ? "실시간 연결" : "연결 안 됨"}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              <Zap className={`w-3.5 h-3.5 ${liveMode ? "text-violet-500" : "text-muted-foreground"}`} />
              <span className="text-xs font-medium text-muted-foreground">실시간 주가 계산</span>
              <Switch
                checked={liveMode}
                onCheckedChange={(v) => {
                  setLiveMode(v);
                  if (v) toast.success("실시간 모드 활성화 — 보유수량을 입력해 주세요");
                }}
              />
            </div>
          </div>
        </div>

        {/* 입력 폼 */}
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">리밸런싱 일자</label>
            <Input type="date" value={account.rebalanceDate}
              onChange={(e) => updateAccount(accountId, { rebalanceDate: e.target.value })} className="mt-1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {isLiveActive ? "기준금액 (자동계산)" : "기준금액 (원)"}
            </label>
            {isLiveActive ? (
              <div className="mt-1 h-9 px-3 flex items-center rounded-md border bg-muted/50 text-sm font-semibold tabular-nums text-violet-600 dark:text-violet-400">
                {formatKRW(effectiveBase)}
              </div>
            ) : (
              <NumberInput value={account.baseAmount}
                onChange={(v) => updateAccount(accountId, { baseAmount: v })}
                placeholder="0" className="mt-1 font-semibold" />
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">이번 달 불입액 (원)</label>
            <NumberInput value={account.deposit}
              onChange={(v) => updateAccount(accountId, { deposit: v })}
              placeholder="0" className="mt-1" />
          </div>
        </div>

        {/* 실시간 기준금액 계산 근거 */}
        {isLiveActive && (
          <div className="rounded-lg bg-violet-500/8 border border-violet-500/20 px-4 py-2.5 flex flex-wrap gap-3 items-center text-xs">
            <span className="text-muted-foreground">💡 기준금액 자동계산:</span>
            <span className="tabular-nums font-medium text-emerald-600">현재가치 {formatKRW(liveTotal)}</span>
            <span className="text-muted-foreground">+</span>
            <span className="tabular-nums font-medium">불입액 {formatKRW(account.deposit)}</span>
            <span className="text-muted-foreground">=</span>
            <span className="tabular-nums font-bold text-violet-600">{formatKRW(effectiveBase)}</span>
          </div>
        )}

        {/* 자산 테이블 */}
        <div className="rounded-lg border overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="py-2 px-1 sm:px-3 text-xs w-[72px] sm:w-auto">자산</TableHead>
                <TableHead className="hidden md:table-cell">ETF 종목명{isLiveActive && " / 종목코드"}</TableHead>
                <TableHead className="hidden md:table-cell text-right w-12">비중</TableHead>
                <TableHead className="hidden lg:table-cell text-right">기준금액</TableHead>
                <TableHead className="hidden lg:table-cell text-right">이전 평가</TableHead>
                {isLiveActive && (
                  <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">보유수량(주)</TableHead>
                )}
                <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">현재평가</TableHead>
                <TableHead className="text-right py-2 px-1 sm:px-3 text-xs whitespace-nowrap">추가매수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {effectiveRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="text-center text-sm text-muted-foreground py-8">
                    설정 → 투자성향에서 자산을 추가하고 저장하세요.
                  </TableCell>
                </TableRow>
              ) : (
                effectiveRows.map((r) => (
                  <TableRow key={r.rowId} className="hover:bg-muted/30">
                    {/* 자산 */}
                    <TableCell className="py-2 px-1 sm:px-3">
                      <div className="flex items-center gap-1 text-[10px] sm:text-xs">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: GROUP_COLORS[r.group] ?? "#888" }} />
                        <span className="truncate max-w-[52px] sm:max-w-none">{r.group}</span>
                      </div>
                      <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 leading-tight truncate max-w-[68px] sm:max-w-none">{r.label}</div>
                      {/* 모바일: 종목코드 표시 */}
                      {liveMode && r.ticker && (
                        <span className="md:hidden mt-1 text-[10px] text-violet-500 tabular-nums font-mono">{r.ticker}</span>
                      )}
                      {liveMode && !r.ticker && (
                        <span className="md:hidden mt-1 text-[10px] text-amber-500">코드 미설정</span>
                      )}
                    </TableCell>
                    {/* ETF 종목명 + 종목코드 */}
                    <TableCell className="hidden md:table-cell">
                      <span className="text-sm text-muted-foreground leading-tight block truncate max-w-[180px]" title={r.etfName}>
                        {r.etfName}
                      </span>
                      {liveMode && (
                        <div className="flex items-center gap-2 mt-1">
                          {r.ticker ? (
                            <>
                              <span className="text-[10px] text-violet-500 tabular-nums font-mono bg-violet-500/10 rounded px-1.5 py-0.5">{r.ticker}</span>
                              {r.livePrice > 0 && (
                                <span className="text-[10px] text-emerald-500 tabular-nums">₩{formatKRW(r.livePrice)}</span>
                              )}
                              {r.livePrice === 0 && isLiveActive && (
                                <span className="text-[10px] text-amber-500">조회 실패</span>
                              )}
                            </>
                          ) : (
                            <span className="text-[10px] text-amber-500">설정 → 종목설정에서 코드 입력</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right text-sm tabular-nums">{r.alloc}%</TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm tabular-nums text-muted-foreground">{formatKRW(r.target)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-sm tabular-nums text-muted-foreground">
                      {r.prevValue != null ? formatKRW(r.prevValue) : "—"}
                    </TableCell>
                    {/* 보유수량 입력 (실시간 모드) */}
                    {isLiveActive && (
                      <TableCell className="text-right py-2 px-1 sm:px-3">
                        <input
                          type="number"
                          min={0}
                          value={quantities[r.rowId] ?? ""}
                          onChange={(e) => {
                            const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
                            setQuantities((prev) => ({ ...prev, [r.rowId]: qty }));
                          }}
                          placeholder="0"
                          className="h-7 w-16 text-xs text-right tabular-nums rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-violet-500"
                        />
                      </TableCell>
                    )}
                    {/* 현재 평가금액 */}
                    <TableCell className="text-right py-2 px-1 sm:px-3">
                      {isLiveActive ? (
                        <div className="text-right">
                          <p className="text-xs tabular-nums font-medium text-violet-600 dark:text-violet-400">
                            {formatKRW(r.value)}
                          </p>
                          {r.livePrice > 0 && (
                            <p className="text-[10px] text-muted-foreground tabular-nums">
                              @{formatKRW(r.livePrice)}
                            </p>
                          )}
                        </div>
                      ) : (
                        <NumberInput
                          value={r.value}
                          onChange={(v) => updateRowHolding(accountId, r.rowId, v)}
                          placeholder="0"
                          className="h-7 text-xs text-right tabular-nums w-[5.5rem] sm:w-28"
                        />
                      )}
                    </TableCell>
                    {/* 추가매수 */}
                    <TableCell className="text-right py-2 px-1 sm:px-3">
                      {isLiveActive
                        ? <LiveRebalanceCell diff={r.diff} livePrice={r.livePrice} />
                        : <RebalanceCell diff={r.diff} />
                      }
                    </TableCell>
                  </TableRow>
                ))
              )}
              {/* 합계 행 */}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell className="text-xs sm:text-sm py-2 px-2 sm:px-4">합계</TableCell>
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden md:table-cell" />
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm">{formatKRW(effectiveBase)}</TableCell>
                <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm text-muted-foreground">
                  {lastHistory ? formatKRW(lastHistory.totalValue) : "—"}
                </TableCell>
                {isLiveActive && <TableCell className="text-right tabular-nums text-xs sm:text-sm py-2 px-1 sm:px-4 text-violet-600">
                  {Object.values(quantities).reduce((s, q) => s + q, 0)}주
                </TableCell>}
                <TableCell className={`text-right tabular-nums text-xs sm:text-sm py-2 px-1 sm:px-4 ${isLiveActive ? "text-violet-600 font-bold" : ""}`}>
                  {formatKRW(effectiveTotal)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button onClick={snapshotNow} disabled={effectiveTotal <= 0}>
            <Camera className="w-4 h-4 mr-1.5" /> 리밸런싱 저장
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────
   히스토리 탭
───────────────────────────────────────────── */
function HistoryTab({ accountId }: { accountId: AccountId }) {
  const { state, addHistory, removeHistory, updateHistory } = usePortfolioStore();
  const account = state.accounts[accountId];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<HistoryEntry | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualTotal, setManualTotal] = useState("");
  const [manualDeposit, setManualDeposit] = useState("");
  const [chartMode, setChartMode] = useState<"value" | "return">("value");

  function addManual() {
    if (!manualDate || !manualTotal) return;
    addHistory(accountId, {
      id: crypto.randomUUID(), date: manualDate,
      baseAmount: parseFloat(manualTotal) || 0,
      totalValue: parseFloat(manualTotal) || 0,
      deposit: parseFloat(manualDeposit) || 0,
    });
    setManualTotal(""); setManualDeposit("");
  }

  const reversed = [...account.history].reverse();
  const returnData = account.history.filter(h => h.returnPct !== null);

  return (
    <div className="space-y-5">
      {/* 차트 */}
      {account.history.length >= 2 && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">자산 추이</p>
            <div className="flex gap-0.5 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => setChartMode("value")}
                className={`px-3 py-1 text-xs rounded-md transition-all ${chartMode === "value" ? "bg-background shadow text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              >평가금액</button>
              <button
                onClick={() => setChartMode("return")}
                className={`px-3 py-1 text-xs rounded-md transition-all ${chartMode === "return" ? "bg-background shadow text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
              >수익률</button>
            </div>
          </div>
          <div className="h-52">
            {chartMode === "value" ? (
              <ResponsiveContainer>
                <LineChart data={account.history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={52} />
                  <Tooltip
                    formatter={(v: number) => [`${formatKRW(v)} 원`, "평가금액"]}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
                  />
                  <Line type="monotone" dataKey="totalValue" name="평가금액"
                    stroke="oklch(0.62 0.18 250)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer>
                <BarChart data={returnData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(1)}%`} width={50} />
                  <Tooltip
                    formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, "수익률"]}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
                  />
                  <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} />
                  <Bar dataKey="returnPct" name="수익률" radius={[3, 3, 0, 0]}>
                    {returnData.map((entry, i) => (
                      <Cell key={i} fill={(entry.returnPct ?? 0) >= 0 ? "oklch(0.65 0.18 140)" : "oklch(0.60 0.18 20)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      )}

      {/* 전체 기록 테이블 */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b">
          <p className="font-semibold">전체 리밸런싱 기록</p>
          <p className="text-xs text-muted-foreground mt-0.5">클릭: 종목별 상세 보기</p>
        </div>

        {reversed.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">기록된 히스토리가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-8" />
                  <TableHead>날짜</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">기준금액</TableHead>
                  <TableHead className="text-right">평가금액</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">불입액</TableHead>
                  <TableHead className="text-right">수익률</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {reversed.map((h) => {
                  const isExpanded = expandedId === h.id;
                  const hasHoldings = h.holdings && Object.keys(h.holdings).length > 0;
                  return (
                    <>
                      <TableRow
                        key={h.id}
                        className={`cursor-pointer transition-colors ${
                          isExpanded ? "bg-violet-50/60 dark:bg-violet-900/20" : "hover:bg-muted/30"
                        }`}
                        onClick={() => setExpandedId(isExpanded ? null : h.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {hasHoldings
                            ? isExpanded
                              ? <ChevronDown className="w-4 h-4" />
                              : <ChevronRight className="w-4 h-4" />
                            : <span className="w-4 h-4 block" />
                          }
                        </TableCell>
                        <TableCell className="font-semibold text-sm">{h.date}</TableCell>
                        <TableCell className="hidden sm:table-cell text-right tabular-nums text-sm text-muted-foreground">{formatKRW(h.baseAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm font-medium">{formatKRW(h.totalValue)}</TableCell>
                        <TableCell className="hidden sm:table-cell text-right tabular-nums text-sm text-muted-foreground">{h.deposit ? formatKRW(h.deposit) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {h.returnPct === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className={h.returnPct >= 0 ? "text-emerald-500 font-bold" : "text-rose-500 font-bold"}>
                                {formatPct(h.returnPct)}
                              </span>
                          }
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-0.5">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-violet-500"
                              onClick={() => setEditingEntry({ ...h })}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
                              onClick={() => setPendingDeleteId(h.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {isExpanded && hasHoldings && (
                        <TableRow key={`${h.id}-detail`} className="bg-violet-50/40 dark:bg-violet-900/10">
                          <TableCell colSpan={7} className="p-0">
                            <div className="px-8 py-3">
                              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                                {h.date} 종목별 평가금액
                              </p>
                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                                {ASSET_ORDER.map((k) => {
                                  const val = h.holdings?.[k];
                                  if (val == null) return null;
                                  return (
                                    <div key={k} className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border text-sm">
                                      <span className="w-2 h-2 rounded-full shrink-0"
                                        style={{ background: GROUP_COLORS[ASSET_GROUPS[k].group] }} />
                                      <div className="min-w-0">
                                        <p className="text-xs text-muted-foreground truncate">{ASSET_GROUPS[k].label}</p>
                                        <p className="font-semibold tabular-nums">{formatKRW(val)}</p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* 과거 데이터 수동 추가 */}
        <div className="px-5 py-4 border-t bg-muted/20">
          <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">과거 데이터 직접 추가</p>
          <div className="grid sm:grid-cols-4 gap-2 items-end">
            <div>
              <label className="text-xs text-muted-foreground">날짜</label>
              <Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} className="h-9 mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">총자산</label>
              <Input type="number" value={manualTotal} onChange={(e) => setManualTotal(e.target.value)} placeholder="0" className="h-9 mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">불입액</label>
              <Input type="number" value={manualDeposit} onChange={(e) => setManualDeposit(e.target.value)} placeholder="0" className="h-9 mt-1" />
            </div>
            <Button onClick={addManual} variant="outline" size="sm" className="h-9">
              <Plus className="w-4 h-4 mr-1" /> 추가
            </Button>
          </div>
        </div>
      </Card>

      {/* 히스토리 수정 다이얼로그 */}
      {editingEntry && (
        <Dialog open onOpenChange={(v) => !v && setEditingEntry(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>히스토리 수정</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">날짜</label>
                <Input type="date" value={editingEntry.date}
                  onChange={(e) => setEditingEntry({ ...editingEntry, date: e.target.value })}
                  className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">기준금액 (원)</label>
                <NumberInput value={editingEntry.baseAmount}
                  onChange={(v) => setEditingEntry({ ...editingEntry, baseAmount: v })}
                  className="mt-1" placeholder="0" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">평가금액 (원)</label>
                <NumberInput value={editingEntry.totalValue}
                  onChange={(v) => setEditingEntry({ ...editingEntry, totalValue: v })}
                  className="mt-1" placeholder="0" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">불입액 (원)</label>
                <NumberInput value={editingEntry.deposit}
                  onChange={(v) => setEditingEntry({ ...editingEntry, deposit: v })}
                  className="mt-1" placeholder="0" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setEditingEntry(null)}>취소</Button>
              <Button size="sm" onClick={() => { updateHistory(accountId, editingEntry); setEditingEntry(null); toast.success("수정됐습니다"); }}>
                <Save className="w-3.5 h-3.5 mr-1" /> 저장
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 히스토리 삭제 confirm */}
      <Dialog open={!!pendingDeleteId} onOpenChange={(v) => !v && setPendingDeleteId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>히스토리 삭제</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">이 항목을 삭제할까요? 되돌릴 수 없습니다.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>취소</Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (pendingDeleteId) removeHistory(accountId, pendingDeleteId);
              setPendingDeleteId(null);
              toast.success("삭제됐습니다");
            }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> 삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RebalanceCell({ diff }: { diff: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground text-xs">—</span>;
  if (diff > 0) return <span className="text-emerald-500 text-xs font-semibold tabular-nums">+{formatKRW(diff)}</span>;
  return <span className="text-rose-500 text-xs font-semibold tabular-nums">{formatKRW(diff)}</span>;
}

function LiveRebalanceCell({ diff, livePrice }: { diff: number; livePrice: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground text-xs">—</span>;

  if (diff > 0) {
    const shares = livePrice > 0 ? Math.floor(diff / livePrice) : 0;
    const actualAmount = shares * livePrice;
    const remainder = diff - actualAmount;
    return (
      <div className="text-right space-y-0.5">
        <p className="text-emerald-500 text-xs font-semibold tabular-nums">+{formatKRW(diff)}</p>
        {livePrice > 0 && shares > 0 && (
          <p className="text-emerald-400 text-[10px] tabular-nums font-medium">
            ≈ {shares}주 · {formatKRW(actualAmount)}원
          </p>
        )}
        {livePrice > 0 && remainder > 0 && (
          <p className="text-muted-foreground text-[10px] tabular-nums">잔액 {formatKRW(remainder)}</p>
        )}
        {livePrice > 0 && shares === 0 && (
          <p className="text-amber-500 text-[10px]">1주 미만</p>
        )}
      </div>
    );
  }

  return <span className="text-rose-500 text-xs font-semibold tabular-nums">{formatKRW(diff)}</span>;
}
