import { useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
  PieChart, Pie, Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight } from "lucide-react";

const ACCOUNT_COLORS: Record<string, string> = {
  retirement: "oklch(0.62 0.18 250)",
  isa:        "oklch(0.65 0.18 140)",
  pension:    "oklch(0.70 0.18 30)",
  irp:        "oklch(0.60 0.18 320)",
};

type GranularityTab = "daily" | "monthly" | "yearly";

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

const ACCOUNT_ORDER: { id: string; label: string }[] = [
  { id: "retirement", label: "퇴직연금 자산 추이" },
  { id: "isa",        label: "ISA계좌 자산 추이" },
  { id: "pension",    label: "연금저축펀드 자산 추이" },
  { id: "irp",        label: "IRP계좌 자산 추이" },
];

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-1 text-xs rounded-lg font-medium transition-all",
        active ? "bg-violet-500 text-white shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Dashboard() {
  const { state } = usePortfolioStore();
  const [returnTab, setReturnTab] = useState<GranularityTab>("monthly");

  const accountSummaries = useMemo(() => ACCOUNT_IDS.map((id) => {
    const acc = state.accounts[id];
    const sorted = [...acc.history].sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const histTotal = last?.totalValue ?? 0;
    const latestReturnPct = last?.returnPct ?? null;
    // 첫 번째 히스토리의 baseAmount = 초기납입금, 이후 deposit 합산 = 추가납입금
    const baseAmount = sorted.length > 0
      ? sorted[0].baseAmount + sorted.slice(1).reduce((s, h) => s + Math.max(0, h.deposit ?? 0), 0)
      : 0;
    return { id, label: ACCOUNT_LABELS_SHORT[id], histTotal, last, latestReturnPct, baseAmount };
  }), [state]);

  const grandTotal = accountSummaries.reduce((s, a) => s + a.histTotal, 0);
  const grandBase = accountSummaries.reduce((s, a) => s + a.baseAmount, 0);
  const grandGain = grandTotal - grandBase;
  const grandGainPct = grandBase > 0 ? (grandGain / grandBase) * 100 : null;

  // Monthly chart data (existing)
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

  // Cumulative return data per granularity
  const cumulativeReturnData = useMemo(() => {
    // For each account, build sorted entries with cumulative return
    const accCumReturns = new Map<string, Map<string, number>>();
    ACCOUNT_IDS.forEach((id) => {
      const history = [...state.accounts[id].history].sort((a, b) => a.date.localeCompare(b.date));
      const cumMap = new Map<string, number>();
      let cum = 0; // cumulative return in %
      history.forEach((h, i) => {
        if (i === 0) { cumMap.set(h.date, 0); return; }
        if (h.returnPct != null) {
          cum = (1 + cum / 100) * (1 + h.returnPct / 100) * 100 - 100;
        }
        cumMap.set(h.date, cum);
      });
      accCumReturns.set(id, cumMap);
    });

    const buildData = (keyFn: (date: string) => string, labelFn: (key: string) => string) => {
      const keyMap = new Map<string, Record<string, number>>();
      ACCOUNT_IDS.forEach((id) => {
        const history = [...state.accounts[id].history].sort((a, b) => a.date.localeCompare(b.date));
        const byKey = new Map<string, string>();
        history.forEach((h) => {
          const k = keyFn(h.date);
          const ex = byKey.get(k);
          if (!ex || h.date > ex) byKey.set(k, h.date);
        });
        history.forEach((h) => {
          const k = keyFn(h.date);
          if (byKey.get(k) !== h.date) return;
          const cumVal = accCumReturns.get(id)?.get(h.date);
          if (cumVal === undefined) return;
          if (!keyMap.has(k)) keyMap.set(k, {});
          keyMap.get(k)![id] = Math.round(cumVal * 100) / 100;
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

  // Monthly deposit data
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

  const currentReturnData = cumulativeReturnData[returnTab];
  const hasReturnData = currentReturnData.length >= 2;
  const hasDepositData = monthlyDepositData.length >= 1;

  const principalChartData = useMemo(
    () => accountSummaries.filter((a) => a.baseAmount > 0).map((a) => ({ id: a.id, name: a.label, value: a.baseAmount })),
    [accountSummaries],
  );
  const gainChartData = useMemo(
    () => accountSummaries.filter((a) => a.baseAmount > 0 && (a.histTotal - a.baseAmount) > 0).map((a) => ({ id: a.id, name: a.label, value: a.histTotal - a.baseAmount })),
    [accountSummaries],
  );
  const totalGain = gainChartData.reduce((s, d) => s + d.value, 0);

  // Latest cumulative returns per account for summary display
  const latestCumReturns = useMemo(() => {
    const result: Record<string, number | null> = {};
    ACCOUNT_IDS.forEach((id) => {
      const last = cumulativeReturnData.monthly.filter((d) => d[id as keyof typeof d] !== undefined).slice(-1)[0];
      result[id] = last ? ((last[id as keyof typeof last] as unknown as number) ?? null) : null;
    });
    return result;
  }, [cumulativeReturnData]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold">대시보드</h2>
        <p className="text-sm text-muted-foreground mt-1">전체 포트폴리오 요약</p>
      </div>

      {/* 총자산 */}
      <Card className="p-5">
        <p className="text-sm text-muted-foreground">총 포트폴리오 자산</p>
        <p className="text-3xl font-bold tabular-nums mt-1">{formatKRW(grandTotal)} 원</p>
      </Card>

      {/* 계좌별 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {accountSummaries.map((a) => {
          const isUp = (a.latestReturnPct ?? 0) >= 0;
          return (
            <Card key={a.id} className="p-4 space-y-1">
              <div className="flex items-center justify-between gap-1">
                <p className="text-sm font-medium truncate">{a.label}</p>
                {a.latestReturnPct !== null && (
                  <span className={`flex items-center gap-0.5 text-xs font-medium shrink-0 ${isUp ? "text-emerald-600" : "text-rose-600"}`}>
                    {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {formatPct(a.latestReturnPct)}
                  </span>
                )}
              </div>
              <p className="text-lg md:text-xl font-bold tabular-nums">{formatKRW(a.histTotal)}</p>
              {a.last && (
                <p className="text-xs text-muted-foreground">{a.last.date} 기준</p>
              )}
            </Card>
          );
        })}
      </div>

      {/* 납입원금 vs 현재가치 */}
      {grandBase > 0 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-violet-500" />
            납입원금 vs 현재가치
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
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
              <p className="text-xs text-muted-foreground">지금 평가금액</p>
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
          <div className="grid grid-cols-2 gap-4">
            {/* 납입원금 비중 */}
            <div>
              <p className="text-xs font-medium text-center text-muted-foreground mb-2">납입원금 비중</p>
              <div className="h-36">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={principalChartData} cx="50%" cy="50%" innerRadius={46} outerRadius={64} dataKey="value" nameKey="name" strokeWidth={0}>
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
                </ResponsiveContainer>
              </div>
              <div className="space-y-1 mt-2">
                {principalChartData.map((e) => (
                  <div key={e.id} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ACCOUNT_COLORS[e.id] }} />
                    <span className="text-muted-foreground truncate">{e.name}</span>
                    <span className="ml-auto tabular-nums shrink-0 text-[11px]">{grandBase > 0 ? (e.value / grandBase * 100).toFixed(1) : "0"}%</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 계좌별 순수익 */}
            <div>
              <p className="text-xs font-medium text-center text-muted-foreground mb-2">계좌별 순수익</p>
              <div className="h-36">
                {gainChartData.length > 0 ? (
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={gainChartData} cx="50%" cy="50%" innerRadius={46} outerRadius={64} dataKey="value" nameKey="name" strokeWidth={0}>
                        {gainChartData.map((e) => <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />)}
                      </Pie>
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const v = payload[0].value as number;
                        const pct = totalGain > 0 ? (v / totalGain * 100).toFixed(1) : "0";
                        return (
                          <div className="rounded-xl border bg-popover p-2 shadow-md text-xs">
                            <p className="font-semibold mb-0.5">{payload[0].name}</p>
                            <p className="tabular-nums text-emerald-600">+{formatKRW(v)}원</p>
                            <p className="text-muted-foreground">{pct}%</p>
                          </div>
                        );
                      }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground">수익 데이터 없음</div>
                )}
              </div>
              <div className="space-y-1 mt-2">
                {accountSummaries.filter((a) => a.baseAmount > 0).map((a) => {
                  const gain = a.histTotal - a.baseAmount;
                  return (
                    <div key={a.id} className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ACCOUNT_COLORS[a.id] }} />
                      <span className="text-muted-foreground truncate">{a.label}</span>
                      <span className={`ml-auto tabular-nums shrink-0 font-medium text-[11px] ${gain >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {gain >= 0 ? "+" : ""}{formatKRW(Math.abs(gain))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* 누적 수익률 */}
      {hasReturnData && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold">누적 수익률</h3>
            <div className="flex gap-1 bg-muted p-0.5 rounded-lg">
              <TabButton active={returnTab === "daily"}   onClick={() => setReturnTab("daily")}>일간</TabButton>
              <TabButton active={returnTab === "monthly"} onClick={() => setReturnTab("monthly")}>월간</TabButton>
              <TabButton active={returnTab === "yearly"}  onClick={() => setReturnTab("yearly")}>연간</TabButton>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-4">납입금 제외 · 순수 투자 수익률 누적</p>

          {/* 계좌별 현재 누적 수익률 요약 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            {accountSummaries.map((a) => {
              const cum = latestCumReturns[a.id];
              if (cum === null || cum === undefined) return null;
              return (
                <div key={a.id} className="rounded-lg bg-muted/50 px-3 py-2 text-center">
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
              <LineChart data={currentReturnData}>
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

      {/* 월별 납입 현황 */}
      {hasDepositData && (
        <Card className="p-5">
          <h3 className="font-semibold mb-1">월별 납입 현황</h3>
          <p className="text-xs text-muted-foreground mb-4">계좌별 입금액 · 쌓아온 기록</p>
          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={monthlyDepositData} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} width={46} />
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

      {/* 전체 자산 추이 */}
      {chartData.length >= 2 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4">전체 자산 추이</h3>
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} width={50} />
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

      {/* 계좌별 자산 추이 */}
      {chartData.length >= 2 && (
        <div className="space-y-4">
          {ACCOUNT_ORDER.map(({ id, label }) => {
            const hasData = chartData.some((d) => d[id as keyof typeof d] !== undefined);
            if (!hasData) return null;
            return (
              <Card key={id} className="p-5">
                <h3 className="font-semibold mb-4">{label}</h3>
                <div className="h-48">
                  <ResponsiveContainer>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} width={50} />
                      <Tooltip content={<DashboardTooltip />} />
                      <Line type="monotone" dataKey={id} stroke={ACCOUNT_COLORS[id]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* 계좌별 최근 수익률 테이블 */}
      <Card className="p-5">
        <h3 className="font-semibold mb-3">최근 수익률 현황</h3>
        <div className="space-y-2">
          {accountSummaries.map((a) => {
            const history = state.accounts[a.id].history;
            if (history.length < 2) return null;
            const last3 = history.slice(-3);
            return (
              <div key={a.id}>
                <p className="text-sm font-medium mb-1">{a.label}</p>
                <div className="flex gap-2 flex-wrap">
                  {last3.map((h) => h.returnPct !== null && (
                    <span key={h.id} className="text-xs px-2 py-0.5 rounded-full bg-muted tabular-nums">
                      {h.date}: <span className={h.returnPct >= 0 ? "text-emerald-600" : "text-rose-600"}>{formatPct(h.returnPct)}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          }).filter(Boolean)}
        </div>
      </Card>
    </div>
  );
}
