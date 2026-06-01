import { useMemo, useState } from "react";
import { ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS, ACCOUNT_LABELS, type AccountId, type AssetKey } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct, getOrDefaultLibrary, type HistoryEntry } from "@/lib/kaw/store";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { TrendingUp, TrendingDown, Minus, Camera, Plus, Trash2, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";

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
  const [saved, setSaved] = useState(false);

  const profile = account.profile ?? "growth";
  const profileRows = account.profileRows?.[profile] ?? [];
  const profileAlloc = account.profileAllocations?.[profile] ?? {};

  const lastHistory: HistoryEntry | null =
    account.history.length > 0 ? account.history[account.history.length - 1] : null;

  const rows = useMemo(() => {
    if (!profileRows.length) return [];
    return profileRows.map((row) => {
      const def = library.find((d) => d.id === row.assetId);
      const etfName = row.etfName ?? def?.defaultEtf ?? row.assetId;
      const group = def?.group ?? "";
      const label = def?.label ?? row.assetId;
      const alloc = profileAlloc[row.id] ?? 0;

      // rowHoldings is source of truth; fall back to legacy holdings for standard assets
      const legacyValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? (account.holdings.find((h) => h.assetKey === row.assetId)?.value ?? 0)
        : 0;
      const value = account.rowHoldings?.[row.id] ?? legacyValue;

      const target = (account.baseAmount * alloc) / 100;
      const diff = target - value;
      const prevValue = ASSET_ORDER.includes(row.assetId as AssetKey)
        ? (lastHistory?.holdings?.[row.assetId as AssetKey] ?? null)
        : null;

      return { rowId: row.id, assetId: row.assetId, etfName, group, label, alloc, value, target, diff, prevValue };
    });
  }, [account, profileRows, profileAlloc, library, lastHistory]);

  const totalValue = rows.reduce((s, r) => s + r.value, 0);

  function snapshotNow() {
    // Aggregate values by assetId for history (standard assets only, for backwards compat)
    const holdingsSnap: Partial<Record<AssetKey, number>> = {};
    rows.forEach((r) => {
      if (r.value > 0 && ASSET_ORDER.includes(r.assetId as AssetKey)) {
        const k = r.assetId as AssetKey;
        holdingsSnap[k] = (holdingsSnap[k] ?? 0) + r.value;
      }
    });
    addHistory(accountId, {
      id: crypto.randomUUID(),
      date: account.rebalanceDate,
      baseAmount: account.baseAmount,
      totalValue,
      deposit: account.deposit,
      holdings: holdingsSnap,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

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
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">이번 리밸런싱</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">리밸런싱 일자</label>
            <Input type="date" value={account.rebalanceDate}
              onChange={(e) => updateAccount(accountId, { rebalanceDate: e.target.value })} className="mt-1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">기준금액 (원)</label>
            <Input type="number" value={account.baseAmount || ""}
              onChange={(e) => updateAccount(accountId, { baseAmount: parseFloat(e.target.value) || 0 })}
              placeholder="0" className="mt-1 font-semibold" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">이번 달 불입액 (원)</label>
            <Input type="number" value={account.deposit || ""}
              onChange={(e) => updateAccount(accountId, { deposit: parseFloat(e.target.value) || 0 })}
              placeholder="0" className="mt-1" />
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-28">자산</TableHead>
                <TableHead>ETF 종목명</TableHead>
                <TableHead className="text-right w-12">비중</TableHead>
                <TableHead className="text-right">기준금액</TableHead>
                <TableHead className="text-right">이전 평가</TableHead>
                <TableHead className="text-right">현재 평가</TableHead>
                <TableHead className="text-right">추가매수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                    설정 → 투자성향에서 자산을 추가하고 저장하세요.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.rowId} className="hover:bg-muted/30">
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: GROUP_COLORS[r.group] ?? "#888" }} />
                        {r.group}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{r.label}</div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground leading-tight block truncate max-w-[180px]" title={r.etfName}>
                        {r.etfName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{r.alloc}%</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">{formatKRW(r.target)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {r.prevValue != null ? formatKRW(r.prevValue) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        value={r.value || ""}
                        onChange={(e) => updateRowHolding(accountId, r.rowId, parseFloat(e.target.value) || 0)}
                        placeholder="0"
                        className="h-8 text-sm text-right tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="text-right"><RebalanceCell diff={r.diff} /></TableCell>
                  </TableRow>
                ))
              )}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={3} className="text-sm">합계</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{formatKRW(account.baseAmount)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {lastHistory ? formatKRW(lastHistory.totalValue) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{formatKRW(totalValue)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-end gap-3">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-500 font-medium animate-in fade-in slide-in-from-right-2 duration-200">
              <CheckCircle2 className="w-4 h-4" /> 저장됐습니다
            </span>
          )}
          <Button onClick={snapshotNow} disabled={totalValue <= 0}>
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
  const { state, addHistory, removeHistory } = usePortfolioStore();
  const account = state.accounts[accountId];
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} width={50} />
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
          <p className="text-xs text-muted-foreground mt-0.5">행을 클릭하면 종목별 평가금액을 확인할 수 있습니다.</p>
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
                  <TableHead className="text-right">기준금액</TableHead>
                  <TableHead className="text-right">평가금액</TableHead>
                  <TableHead className="text-right">불입액</TableHead>
                  <TableHead className="text-right">수익률</TableHead>
                  <TableHead className="w-10" />
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
                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{formatKRW(h.baseAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm font-medium">{formatKRW(h.totalValue)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{h.deposit ? formatKRW(h.deposit) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {h.returnPct === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className={h.returnPct >= 0 ? "text-emerald-500 font-bold" : "text-rose-500 font-bold"}>
                                {formatPct(h.returnPct)}
                              </span>
                          }
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-7 w-7"
                            onClick={() => removeHistory(accountId, h.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
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
    </div>
  );
}

function RebalanceCell({ diff }: { diff: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground inline-flex items-center gap-1 text-sm"><Minus className="w-3 h-3" />—</span>;
  if (diff > 0) return <span className="text-emerald-500 inline-flex items-center gap-1 text-sm font-semibold tabular-nums"><TrendingUp className="w-3.5 h-3.5" />+{formatKRW(diff)}</span>;
  return <span className="text-rose-500 inline-flex items-center gap-1 text-sm font-semibold tabular-nums"><TrendingDown className="w-3.5 h-3.5" />{formatKRW(diff)}</span>;
}
