import { useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct, getOrDefaultLibrary } from "@/lib/kaw/store";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
  PieChart, Pie, Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight, ChevronRight, Wifi, WifiOff, RefreshCw } from "lucide-react";
import type { Page } from "@/components/kaw/Sidebar";
import type { ProfileRowDef } from "@/lib/kaw/store";

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

const ACCOUNT_COLORS: Record<string, string> = {
  retirement: "oklch(0.62 0.18 250)",
  isa:        "oklch(0.65 0.18 140)",
  pension:    "oklch(0.70 0.18 30)",
  irp:        "oklch(0.60 0.18 320)",
};

const ACCOUNT_COLORS_SOFT: Record<string, string> = {
  retirement: "oklch(0.78 0.12 250)",
  isa:        "oklch(0.80 0.12 140)",
  pension:    "oklch(0.82 0.12 30)",
  irp:        "oklch(0.78 0.12 320)",
};

function DashboardTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
  const isSingle = payload.length === 1;
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-40">
      <p className="font-semibold text-xs text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-xs">{ACCOUNT_LABELS_SHORT[p.dataKey as keyof typeof ACCOUNT_LABELS_SHORT] ?? p.dataKey}</span>
          </span>
          <span className="tabular-nums text-xs font-medium">{formatKRW(p.value)}</span>
        </div>
      ))}
      {!isSingle && (
        <div className="border-t pt-1 mt-1 flex justify-between font-bold text-xs">
          <span>합계</span>
          <span className="tabular-nums">{formatKRW(total)} 원</span>
        </div>
      )}
    </div>
  );
}

function ReturnTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-40">
      <p className="font-semibold text-xs text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-xs">{ACCOUNT_LABELS_SHORT[p.dataKey as keyof typeof ACCOUNT_LABELS_SHORT] ?? p.dataKey}</span>
          </span>
          <span className={`tabular-nums text-xs font-medium ${p.value >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {p.value >= 0 ? "+" : ""}{p.value?.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function DepositTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-44">
      <p className="font-semibold text-xs text-muted-foreground mb-1">{label}</p>
      {payload.filter((p: any) => p.value > 0).map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill }} />
            <span className="text-xs">{ACCOUNT_LABELS_SHORT[p.dataKey as keyof typeof ACCOUNT_LABELS_SHORT] ?? p.dataKey}</span>
          </span>
          <span className="tabular-nums text-xs font-medium">{formatKRW(p.value)}</span>
        </div>
      ))}
      {total > 0 && (
        <div className="border-t pt-1 mt-1 flex justify-between font-bold text-xs">
          <span>합계</span>
          <span className="tabular-nums">{formatKRW(total)}</span>
        </div>
      )}
    </div>
  );
}

export function Dashboard({ onNavigate }: { onNavigate?: (p: Page) => void }) {
  const { state } = usePortfolioStore();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);
  const [liveMode, setLiveMode] = useState(true);

  const { prices: livePrices, configured, isLoading: priceLoading, successCount, totalCount } = useKisPriceContext();
  const isLiveActive = liveMode && configured && Object.keys(livePrices).length > 0;

  // 계좌별 실시간 총액 (보유수량 × 실시간주가)
  const accountLiveTotals = useMemo<Record<string, number>>(() => {
    if (!isLiveActive) return {};
    const result: Record<string, number> = {};
    for (const id of ACCOUNT_IDS) {
      const account = state.accounts[id];
      const profile = account.profile ?? "growth";
      const profileRows: ProfileRowDef[] = account.profileRows?.[profile] ?? [];
      if (!profileRows.length) { result[id] = 0; continue; }
      const total = profileRows.reduce((sum, row) => {
        const def = library.find((d) => d.id === row.assetId);
        const etfName = (row as any).etfName ?? def?.defaultEtf ?? row.assetId;
        const tickerByEtf = library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker;
        const ticker = tickerByEtf ?? def?.ticker ?? "";
        const qty = account.liveQuantities?.[row.id] ?? 0;
        const price = ticker ? (livePrices[ticker] ?? 0) : 0;
        return sum + qty * price;
      }, 0);
      result[id] = total;
    }
    return result;
  }, [isLiveActive, state.accounts, library, livePrices]);

  const accountSummaries = useMemo(() => ACCOUNT_IDS.map((id) => {
    const acc = state.accounts[id];
    const sorted = [...acc.history].sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const histTotal = last?.totalValue ?? 0;
    const latestReturnPct = last?.returnPct ?? null;
    const baseAmount = sorted.length > 0
      ? sorted[0].baseAmount + sorted.slice(1).reduce((s, h) => s + Math.max(0, h.deposit ?? 0), 0)
      : 0;
    // 실시간 총액이 있으면 사용, 없으면 최근 리밸런싱 값
    const rawLive = accountLiveTotals[id] ?? 0;
    const liveTotal = isLiveActive && rawLive > 0 ? rawLive : histTotal;
    const hasLive = isLiveActive && rawLive > 0;
    const gain = liveTotal - baseAmount;
    return { id, label: ACCOUNT_LABELS_SHORT[id], histTotal, liveTotal, hasLive, last, latestReturnPct, baseAmount, gain };
  }), [state, accountLiveTotals, isLiveActive]);

  const grandTotal = accountSummaries.reduce((s, a) => s + a.liveTotal, 0);
  const grandBase  = accountSummaries.reduce((s, a) => s + a.baseAmount, 0);
  const grandGain  = grandTotal - grandBase;
  const grandGainPct = grandBase > 0 ? (grandGain / grandBase) * 100 : null;
  const anyLive = accountSummaries.some((a) => a.hasLive);

  // 전체 자산 추이 차트 데이터
  const chartData = useMemo(() => {
    const monthMap = new Map<string, Record<string, number>>();
    ACCOUNT_IDS.forEach((id) => {
      const byMonth = new Map<string, string>();
      state.accounts[id].history.forEach((h) => {
        const month = h.date.slice(0, 7);
        const existing = byMonth.get(month);
        if (!existing || h.date > existing) byMonth.set(month, h.date);
      });
      state.accounts[id].history.forEach((h) => {
        const month = h.date.slice(0, 7);
        if (byMonth.get(month) !== h.date) return;
        if (!monthMap.has(month)) monthMap.set(month, {});
        monthMap.get(month)![id] = h.totalValue;
      });
    });
    return [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, vals]) => ({ month, label: month.replace("-", "."), ...vals }));
  }, [state]);

  // 실시간 "현재" 포인트 추가
  const chartDataWithLive = useMemo(() => {
    if (!anyLive) return chartData;
    const livePoint: Record<string, unknown> = { month: "현재", label: "현재" };
    let hasAny = false;
    for (const a of accountSummaries) {
      if (a.hasLive) { livePoint[a.id] = a.liveTotal; hasAny = true; }
    }
    return hasAny ? [...chartData, livePoint as any] : chartData;
  }, [chartData, accountSummaries, anyLive]);

  // 누적 수익률 데이터 — 정의: (현재가치 - 누적납입원금) / 누적납입원금 × 100
  const cumulativeReturnData = useMemo(() => {
    // 각 날짜 시점의 누적납입원금 = 첫 baseAmount + 이후 각 시점 deposit 합산
    const buildData = (keyFn: (date: string) => string, labelFn: (key: string) => string) => {
      const keyMap = new Map<string, Record<string, number>>();
      ACCOUNT_IDS.forEach((id) => {
        const history = [...state.accounts[id].history].sort((a, b) => a.date.localeCompare(b.date));
        let cumDeposit = 0;
        history.forEach((h, i) => {
          cumDeposit += i === 0 ? (h.baseAmount ?? 0) : Math.max(0, h.deposit ?? 0);
          if (cumDeposit <= 0) return;
          const ret = Math.round((h.totalValue - cumDeposit) / cumDeposit * 10000) / 100;
          const k = keyFn(h.date);
          if (!keyMap.has(k)) keyMap.set(k, {});
          keyMap.get(k)![id] = ret; // 같은 키면 나중(최신) 값으로 덮어쓰기
        });
      });
      return [...keyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, vals]) => ({ key: k, label: labelFn(k), ...vals }));
    };

    return {
      daily:   buildData((d) => d, (k) => k.slice(5)),
      monthly: buildData((d) => d.slice(0, 7), (k) => k.replace("-", ".")),
      yearly:  buildData((d) => d.slice(0, 4), (k) => k + "년"),
    };
  }, [state]);

  // "현재" 수익률 포인트 — 실시간 가치 기준 (현재가치 - 납입원금) / 납입원금
  const returnDataWithLive = useMemo(() => {
    const base = cumulativeReturnData.daily;
    if (!anyLive) return base;
    const livePoint: Record<string, unknown> = { key: "현재", label: "현재" };
    let hasAny = false;
    for (const a of accountSummaries) {
      if (!a.hasLive || a.baseAmount <= 0) continue;
      livePoint[a.id] = Math.round(a.gain / a.baseAmount * 10000) / 100;
      hasAny = true;
    }
    return hasAny ? [...base, livePoint as any] : base;
  }, [cumulativeReturnData, accountSummaries, anyLive]);

  // 월별 납입 현황 (리밸런싱 기준 그대로)
  const monthlyDepositData = useMemo(() => {
    const monthMap = new Map<string, Record<string, number>>();
    ACCOUNT_IDS.forEach((id) => {
      state.accounts[id].history.forEach((h) => {
        if (!h.deposit || h.deposit <= 0) return;
        const month = h.date.slice(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, {});
        monthMap.get(month)![id] = (monthMap.get(month)![id] ?? 0) + h.deposit;
      });
    });
    return [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, vals]) => ({ month, label: month.replace("-", "."), ...vals }));
  }, [state]);

  const hasReturnData = returnDataWithLive.length >= 2;
  const hasDepositData = monthlyDepositData.length >= 1;

  const principalChartData = useMemo(
    () => accountSummaries.filter((a) => a.baseAmount > 0).map((a) => ({ id: a.id, name: a.label, value: a.baseAmount })).sort((a, b) => b.value - a.value),
    [accountSummaries],
  );

  // 납입원금 vs 현재가치 막대 (현재가치에 실시간 반영)
  const barData = useMemo(
    () => accountSummaries.filter((a) => a.baseAmount > 0 || a.liveTotal > 0).map((a) => ({
      name: a.label, id: a.id, 납입원금: a.baseAmount, 현재가치: a.liveTotal,
    })),
    [accountSummaries],
  );

  // 현재가치 비중 도넛 (실시간 반영)
  const donutData = useMemo(
    () => accountSummaries.filter((a) => a.liveTotal > 0)
      .map((a) => ({ id: a.id, name: a.label, value: a.liveTotal }))
      .sort((a, b) => b.value - a.value),
    [accountSummaries],
  );

  // 계좌별 누적 수익률 — (현재가치 - 납입원금) / 납입원금, 실시간 반영
  const latestCumReturns = useMemo(() => {
    const result: Record<string, number | null> = {};
    for (const a of accountSummaries) {
      result[a.id] = a.baseAmount > 0 ? Math.round(a.gain / a.baseAmount * 10000) / 100 : null;
    }
    return result;
  }, [accountSummaries]);

  // accountSummaries.liveTotal이 이미 실시간 반영이므로 별도 계산 불필요
  const liveCumReturns = latestCumReturns;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      {/* 헤더 + 실시간 토글 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">대시보드</h2>
          <p className="text-sm text-muted-foreground mt-1">전체 포트폴리오 요약</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1 bg-muted/50 rounded-xl px-3 py-2 border">
          {priceLoading && liveMode ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-violet-400" />
          ) : isLiveActive ? (
            <Wifi className="w-3.5 h-3.5 text-emerald-500" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-muted-foreground" />
          )}
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {isLiveActive ? `실시간 ${successCount}/${totalCount}` : liveMode && !configured ? "KIS 미설정" : "실시간 주가"}
          </span>
          <Switch
            checked={liveMode}
            onCheckedChange={setLiveMode}
            className="scale-75 origin-right"
          />
        </div>
      </div>

      {/* 총자산 */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">총 포트폴리오 자산</p>
        </div>
        <p className="text-3xl font-bold tabular-nums mt-1">{formatKRW(grandTotal)} 원</p>
        {isLiveActive && anyLive && grandBase > 0 && (
          <p className={`text-sm mt-1 ${grandGain >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
            {grandGain >= 0 ? "+" : ""}{formatKRW(Math.abs(grandGain))}원 ({grandGainPct !== null ? `${grandGainPct >= 0 ? "+" : ""}${grandGainPct.toFixed(2)}%` : ""})
          </p>
        )}
      </Card>

      {/* 계좌별 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {accountSummaries.map((a) => {
          const cum = latestCumReturns[a.id];
          const isUp = (cum ?? 0) >= 0;
          const targetPage = a.id as Page;
          return (
            <Card
              key={a.id}
              onClick={() => onNavigate?.(targetPage)}
              className={`p-4 space-y-1 transition-all ${onNavigate ? "cursor-pointer hover:border-violet-400/60 hover:shadow-md hover:scale-[1.01]" : ""}`}
            >
              <div className="flex items-center justify-between gap-1">
                <p className="text-sm font-medium truncate">{a.label}</p>
                <div className="flex items-center gap-1 shrink-0">
                  {cum !== null && cum !== undefined && (
                    <span className={`flex items-center gap-0.5 text-xs font-medium ${isUp ? "text-emerald-600" : "text-rose-600"}`}>
                      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {cum >= 0 ? "+" : ""}{cum.toFixed(2)}%
                    </span>
                  )}
                  {onNavigate && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />}
                </div>
              </div>
              <p className="text-lg md:text-xl font-bold tabular-nums">{formatKRW(a.liveTotal)}</p>
              {a.hasLive ? (
                <p className="text-xs text-emerald-500 font-medium">현재 시점</p>
              ) : a.last ? (
                <p className="text-xs text-muted-foreground">{a.last.date} 기준</p>
              ) : null}
            </Card>
          );
        })}
      </div>

      {/* 납입원금과 현재가치 */}
      {grandBase > 0 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-violet-500" />
            납입원금과 현재가치
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <PiggyBank className="w-3.5 h-3.5" /> 총 납입원금
              </p>
              <p className="text-xl font-bold tabular-nums">{formatKRW(grandBase)}</p>
              <p className="text-xs text-muted-foreground">내가 넣은 돈</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5" /> 현재가치
              </p>
              <p className="text-xl font-bold tabular-nums">{formatKRW(grandTotal)}</p>
              <p className="text-xs text-muted-foreground">최근 리밸런싱 기준</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">순수익</p>
              <p className={`text-xl font-bold tabular-nums ${grandGain >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {grandGain >= 0 ? "+" : ""}{formatKRW(Math.abs(grandGain))}
              </p>
              <p className="text-xs text-muted-foreground">현재가치 - 납입원금</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">수익률</p>
              {grandGainPct !== null ? (
                <p className={`text-xl font-bold tabular-nums flex items-center gap-1 ${grandGainPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {grandGainPct >= 0
                    ? <ArrowUpRight className="w-4 h-4" />
                    : <ArrowDownRight className="w-4 h-4" />}
                  {grandGainPct >= 0 ? "+" : ""}{grandGainPct.toFixed(2)}%
                </p>
              ) : <p className="text-xl font-bold text-muted-foreground">—</p>}
              <p className="text-xs text-muted-foreground">납입 대비 총 수익</p>
            </div>
          </div>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            {/* 납입원금 비중 도넛 */}
            <div className="flex flex-col items-center lg:w-90 shrink-0">
              <p className="text-xs font-medium text-muted-foreground mb-3">납입원금 비중</p>
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-5 lg:flex-col lg:gap-3">
                <div className="shrink-0">
                  <PieChart width={200} height={200}>
                    <Pie data={principalChartData} cx="50%" cy="50%" innerRadius={62} outerRadius={88} dataKey="value" nameKey="name" strokeWidth={0} startAngle={90} endAngle={-270}>
                      {principalChartData.map((e) => <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const v = payload[0].value as number;
                      const pct = grandBase > 0 ? (v / grandBase * 100).toFixed(1) : "0";
                      return (
                        <div className="rounded-xl border bg-popover p-2 shadow-md text-xs">
                          <p className="font-semibold mb-0.5">{payload[0].name}</p>
                          <p className="tabular-nums">{formatKRW(v)}원</p>
                          <p className="text-muted-foreground">{pct}%</p>
                        </div>
                      );
                    }} />
                  </PieChart>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-1 sm:gap-x-0 lg:grid-cols-2">
                  {principalChartData.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 text-sm">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: ACCOUNT_COLORS[e.id] }} />
                      <span className="text-muted-foreground shrink-0">{e.name}</span>
                      <span className="tabular-nums font-semibold ml-1">{grandBase > 0 ? (e.value / grandBase * 100).toFixed(1) : "0"}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 계좌별 납입원금 vs 현재가치 막대그래프 */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-muted-foreground mb-3 text-center">
                계좌별 납입원금 vs 현재가치
              </p>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={barData} barCategoryGap="28%" barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 11 }} width={52} axisLine={false} tickLine={false} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="rounded-xl border bg-popover p-3 shadow-md text-xs space-y-1.5 min-w-44">
                          <p className="font-semibold text-xs text-muted-foreground mb-1">{label}</p>
                          {payload.map((p: any) => (
                            <div key={p.name} className="flex justify-between gap-4">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.fill }} />
                                <span>{p.name}</span>
                              </span>
                              <span className="tabular-nums font-medium">{formatKRW(p.value)}원</span>
                            </div>
                          ))}
                          {payload.length === 2 && (payload[1].value as number) > (payload[0].value as number) && (
                            <div className="border-t pt-1 mt-1 text-emerald-500 font-semibold flex justify-between">
                              <span>수익</span>
                              <span className="tabular-nums">+{formatKRW((payload[1].value as number) - (payload[0].value as number))}원</span>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="납입원금" radius={[4, 4, 0, 0]}>
                    {barData.map((e) => <Cell key={e.id} fill={ACCOUNT_COLORS_SOFT[e.id]} />)}
                  </Bar>
                  <Bar dataKey="현재가치" radius={[4, 4, 0, 0]}>
                    {barData.map((e) => <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center justify-center gap-6 mt-2">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-3 h-3 rounded-sm bg-muted-foreground/40" />납입원금 (연한색)
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-3 h-3 rounded-sm bg-violet-500" />현재가치 (진한색)
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* 전체 자산 추이 */}
      {chartDataWithLive.length >= 2 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4">전체 자산 추이</h3>
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={chartDataWithLive}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={50} />
                <Tooltip content={<DashboardTooltip />} />
                <Legend formatter={(name) => ACCOUNT_LABELS_SHORT[name as keyof typeof ACCOUNT_LABELS_SHORT] ?? name} />
                {ACCOUNT_IDS.map((id) => (
                  <Line key={id} type="monotone" dataKey={id} stroke={ACCOUNT_COLORS[id]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* 누적 수익률 */}
      {hasReturnData && (
        <Card className="p-5">
          <h3 className="font-semibold mb-1">누적 수익률</h3>
          <p className="text-xs text-muted-foreground mb-4">납입원금 대비 현재가치 수익률 (중간 불입액 포함)</p>

          {/* 계좌별 현재 누적 수익률 요약 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            {accountSummaries.map((a) => {
              const cum = anyLive ? liveCumReturns[a.id] : latestCumReturns[a.id];
              if (cum === null || cum === undefined) return null;
              return (
                <div key={a.id} className="rounded-lg px-3 py-2 text-center bg-muted/50">
                  <p className="text-xs text-muted-foreground">{a.label}</p>
                  <p className={`text-base font-bold tabular-nums mt-0.5 ${cum >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {cum >= 0 ? "+" : ""}{cum.toFixed(2)}%
                  </p>
                </div>
              );
            }).filter(Boolean)}
          </div>

          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={returnDataWithLive}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
                  width={58}
                />
                <Tooltip content={<ReturnTooltip />} />
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} strokeDasharray="4 2" />
                <Legend formatter={(name) => ACCOUNT_LABELS_SHORT[name as keyof typeof ACCOUNT_LABELS_SHORT] ?? name} />
                {ACCOUNT_IDS.map((id) => (
                  <Line
                    key={id} type="monotone" dataKey={id}
                    stroke={ACCOUNT_COLORS[id]} strokeWidth={2}
                    dot={{ r: 2 }} connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* 월별 납입 현황 (리밸런싱 기준 유지) */}
      {hasDepositData && (
        <Card className="p-5">
          <h3 className="font-semibold mb-1">월별 납입 현황</h3>
          <p className="text-xs text-muted-foreground mb-4">계좌별 입금액 · 쌓아온 기록 (최근 리밸런싱 기준)</p>
          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={monthlyDepositData} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={46} />
                <Tooltip content={<DepositTooltip />} />
                <Legend formatter={(name) => ACCOUNT_LABELS_SHORT[name as keyof typeof ACCOUNT_LABELS_SHORT] ?? name} />
                {ACCOUNT_IDS.map((id) => (
                  <Bar key={id} dataKey={id} stackId="a" fill={ACCOUNT_COLORS[id]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* 현재가치 비중 & 계좌별 수익 상세 */}
      {donutData.length > 0 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            현재가치 비중 &amp; 계좌별 수익 상세
          </h3>
          <div className="flex flex-col items-center gap-6 lg:flex-row lg:items-start">
            <div className="flex justify-center lg:w-1/2 shrink-0">
              <PieChart width={300} height={300}>
                <Pie
                  data={donutData} cx="50%" cy="50%"
                  innerRadius={92} outerRadius={135}
                  dataKey="value" nameKey="name"
                  strokeWidth={0} startAngle={90} endAngle={-270}
                >
                  {donutData.map((e) => <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />)}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const id = (payload[0].payload as any).id as string;
                    const v = payload[0].value as number;
                    const pct = grandTotal > 0 ? (v / grandTotal * 100).toFixed(1) : "0";
                    const cum = latestCumReturns[id];
                    return (
                      <div className="rounded-xl border bg-popover p-3 shadow-md text-xs space-y-1">
                        <p className="font-semibold mb-0.5">{payload[0].name}</p>
                        <p className="tabular-nums">{formatKRW(v)}원</p>
                        <p className="text-muted-foreground">비중 {pct}%</p>
                        {cum !== null && cum !== undefined && (
                          <p className={cum >= 0 ? "text-emerald-500" : "text-rose-500"}>
                            누적수익률 {cum >= 0 ? "+" : ""}{cum.toFixed(2)}%
                          </p>
                        )}
                      </div>
                    );
                  }}
                />
              </PieChart>
            </div>
            <div className="w-full lg:w-1/2 space-y-2">
              {accountSummaries.filter((a) => a.baseAmount > 0 || a.liveTotal > 0).map((a) => {
                const pct = grandTotal > 0 ? (a.liveTotal / grandTotal * 100).toFixed(1) : "0";
                const isUp = a.gain >= 0;
                const liveReturnPct = a.baseAmount > 0 ? a.gain / a.baseAmount * 100 : 0;
                return (
                  <div key={a.id} className="rounded-xl p-3 border bg-muted/30">
                    <div className="flex items-center gap-2.5 mb-1.5">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: ACCOUNT_COLORS[a.id] }} />
                      <span className="text-sm font-semibold flex-1">{a.label}</span>
                      <span className="text-sm font-bold tabular-nums text-muted-foreground">{pct}%</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs pl-5">
                      <div>
                        <p className="text-muted-foreground mb-0.5">납입원금</p>
                        <p className="tabular-nums font-medium">{formatKRW(a.baseAmount)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5">현재가치</p>
                        <p className="tabular-nums font-medium">{formatKRW(a.liveTotal)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5">수익 / 수익률</p>
                        <p className={`tabular-nums font-semibold ${isUp ? "text-emerald-500" : "text-rose-500"}`}>
                          {isUp ? "+" : ""}{formatKRW(a.gain)}
                        </p>
                        <p className={`tabular-nums text-[11px] ${isUp ? "text-emerald-500" : "text-rose-500"}`}>
                          {isUp ? "+" : ""}{liveReturnPct.toFixed(2)}%
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* 최근 수익률 현황 */}
      <Card className="p-5">
        <h3 className="font-semibold mb-3">최근 수익률 현황</h3>
        <div className="space-y-2">
          {accountSummaries.map((a) => {
            const history = state.accounts[a.id].history;
            if (history.length < 2) return null;
            const sorted = [...history].sort((x, y) => x.date.localeCompare(y.date));
            const last = sorted[sorted.length - 1];
            // 모바일에서는 최근 3개 + 실시간만 예쁘게 보이고, 화면이 넓어질수록(PC) 한 줄에 들어가는 만큼 더 과거 기록까지 노출
            const recent = sorted.slice(-16);
            const liveRet = a.hasLive && last?.totalValue
              ? (a.liveTotal - last.totalValue) / last.totalValue * 100
              : null;
            const visibilityClass = (rankFromEnd: number) => {
              if (rankFromEnd < 3) return "";
              if (rankFromEnd < 5) return "hidden sm:inline";
              if (rankFromEnd < 7) return "hidden md:inline";
              if (rankFromEnd < 10) return "hidden lg:inline";
              if (rankFromEnd < 13) return "hidden xl:inline";
              return "hidden 2xl:inline";
            };
            return (
              <div key={a.id}>
                <p className="text-sm font-medium mb-1">{a.label}</p>
                <div className="flex gap-2 flex-wrap">
                  {recent.map((h, i) => h.returnPct !== null && (
                    <span
                      key={h.id}
                      className={`text-xs px-2 py-0.5 rounded-full bg-muted tabular-nums ${visibilityClass(recent.length - 1 - i)}`}
                    >
                      {h.date}: <span className={h.returnPct >= 0 ? "text-emerald-600" : "text-rose-600"}>{formatPct(h.returnPct)}</span>
                    </span>
                  ))}
                  {liveRet !== null && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/60 dark:border-emerald-800/40 tabular-nums font-medium">
                      실시간(현재): <span className={liveRet >= 0 ? "text-emerald-600" : "text-rose-600"}>{liveRet >= 0 ? "+" : ""}{liveRet.toFixed(2)}%</span>
                    </span>
                  )}
                </div>
              </div>
            );
          }).filter(Boolean)}
        </div>
      </Card>
    </div>
  );
}
