import { useMemo } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { TrendingUp, TrendingDown } from "lucide-react";

const ACCOUNT_COLORS: Record<string, string> = {
  retirement: "oklch(0.62 0.18 250)",
  isa:        "oklch(0.65 0.18 140)",
  pension:    "oklch(0.70 0.18 30)",
  irp:        "oklch(0.60 0.18 320)",
};

function DashboardTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
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
      <div className="border-t pt-1 mt-1 flex justify-between font-bold text-xs">
        <span>합계</span>
        <span className="tabular-nums">{formatKRW(total)} 원</span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { state } = usePortfolioStore();

  const accountSummaries = useMemo(() => ACCOUNT_IDS.map((id) => {
    const acc = state.accounts[id];
    const totalValue = acc.holdings.reduce((s, h) => s + h.value, 0);
    const last = acc.history.length > 0 ? acc.history[acc.history.length - 1] : null;
    const latestReturnPct = last?.returnPct ?? null;
    const histTotal = last?.totalValue ?? 0;
    return { id, label: ACCOUNT_LABELS_SHORT[id], totalValue, histTotal, last, latestReturnPct };
  }), [state]);

  const grandTotal = accountSummaries.reduce((s, a) => s + (a.totalValue > 0 ? a.totalValue : a.histTotal), 0);

  // Group by YYYY-MM, pick last entry per month per account
  const chartData = useMemo(() => {
    const monthMap = new Map<string, Record<string, number>>();
    ACCOUNT_IDS.forEach((id) => {
      const byMonth = new Map<string, string>(); // month -> last date
      state.accounts[id].history.forEach((h) => {
        const month = h.date.slice(0, 7);
        const existing = byMonth.get(month);
        if (!existing || h.date > existing) byMonth.set(month, h.date);
      });
      state.accounts[id].history.forEach((h) => {
        const month = h.date.slice(0, 7);
        if (byMonth.get(month) !== h.date) return; // not the last entry of the month
        if (!monthMap.has(month)) monthMap.set(month, {});
        monthMap.get(month)![id] = h.totalValue;
      });
    });
    return [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, vals]) => ({ month, label: month.replace("-", "."), ...vals }));
  }, [state]);

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
          const displayVal = a.totalValue > 0 ? a.totalValue : a.histTotal;
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
              <p className="text-lg md:text-xl font-bold tabular-nums">{formatKRW(displayVal)}</p>
              {a.last && (
                <p className="text-xs text-muted-foreground">{a.last.date} 기준</p>
              )}
            </Card>
          );
        })}
      </div>

      {/* 히스토리 차트 */}
      {chartData.length >= 2 && (
        <Card className="p-5">
          <h3 className="font-semibold mb-4">계좌별 자산 추이</h3>
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
