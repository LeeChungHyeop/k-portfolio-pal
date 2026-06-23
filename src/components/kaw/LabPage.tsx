import { useMemo } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW, formatPct } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
  PieChart, Pie,
} from "recharts";
import { Trophy, TrendingUp, TrendingDown, FlaskConical, Coins } from "lucide-react";

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

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-foreground/70 uppercase tracking-wider mb-3 flex items-center gap-2">
      {children}
    </h3>
  );
}

export function LabPage() {
  const { state } = usePortfolioStore();

  const summaries = useMemo(() => ACCOUNT_IDS.map((id) => {
    const acc = state.accounts[id];
    const sorted = [...acc.history].sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const histTotal = last?.totalValue ?? 0;
    const latestReturnPct = last?.returnPct ?? null;
    const baseAmount = sorted.length > 0
      ? sorted[0].baseAmount + sorted.slice(1).reduce((s, h) => s + Math.max(0, h.deposit ?? 0), 0)
      : 0;
    const gain = histTotal - baseAmount;
    return { id, label: ACCOUNT_LABELS_SHORT[id], histTotal, baseAmount, latestReturnPct, gain, last };
  }), [state]);

  const activeSummaries = summaries.filter((a) => a.baseAmount > 0 || a.histTotal > 0);
  const grandTotal = summaries.reduce((s, a) => s + a.histTotal, 0);

  // MVP 위젯 계산
  const topReturnAccount = [...activeSummaries]
    .filter((a) => a.latestReturnPct !== null)
    .sort((a, b) => (b.latestReturnPct ?? -Infinity) - (a.latestReturnPct ?? -Infinity))[0] ?? null;

  const topGainAccount = [...activeSummaries]
    .filter((a) => a.gain > 0)
    .sort((a, b) => b.gain - a.gain)[0] ?? null;

  // 콤보 바 차트 데이터
  const barData = activeSummaries.map((a) => ({
    name: a.label,
    id: a.id,
    납입원금: a.baseAmount,
    현재가치: a.histTotal,
  }));

  // 도넛 데이터 (현재가치 비중)
  const donutData = activeSummaries
    .filter((a) => a.histTotal > 0)
    .map((a) => ({ id: a.id, name: a.label, value: a.histTotal }));

  const noData = activeSummaries.length === 0;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      {/* 헤더 */}
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-violet-500" />
          성과 분석 실험실
        </h2>
        <p className="text-sm text-muted-foreground mt-1">기존 대시보드와 별개로 운영되는 성과 분석 뷰</p>
      </div>

      {noData ? (
        <Card className="p-10 text-center text-muted-foreground text-sm">
          히스토리 데이터가 없습니다. 각 계좌에서 리밸런싱을 기록하면 분석이 시작됩니다.
        </Card>
      ) : (
        <>
          {/* ① MVP 위젯 카드 */}
          <div>
            <SectionTitle><Trophy className="w-4 h-4 text-amber-500" /> 성과 MVP</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* 수익률 1위 */}
              <Card className="p-5 relative overflow-hidden border-l-4" style={{ borderLeftColor: topReturnAccount ? ACCOUNT_COLORS[topReturnAccount.id] : undefined }}>
                <div className="absolute right-4 top-4 opacity-10">
                  <TrendingUp className="w-14 h-14" />
                </div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">📈 수익률 1위 효자 계좌</p>
                {topReturnAccount ? (
                  <>
                    <p className="text-xl font-bold">{topReturnAccount.label}</p>
                    <p className={`text-2xl font-black tabular-nums mt-1 ${(topReturnAccount.latestReturnPct ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {(topReturnAccount.latestReturnPct ?? 0) >= 0 ? "+" : ""}{topReturnAccount.latestReturnPct?.toFixed(2)}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{topReturnAccount.last?.date} 기준 수익률</p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm mt-2">데이터 없음</p>
                )}
              </Card>

              {/* 순수익 기여 1위 */}
              <Card className="p-5 relative overflow-hidden border-l-4" style={{ borderLeftColor: topGainAccount ? ACCOUNT_COLORS[topGainAccount.id] : undefined }}>
                <div className="absolute right-4 top-4 opacity-10">
                  <Coins className="w-14 h-14" />
                </div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">💰 최대 순수익 기여 계좌</p>
                {topGainAccount ? (
                  <>
                    <p className="text-xl font-bold">{topGainAccount.label}</p>
                    <p className="text-2xl font-black tabular-nums mt-1 text-emerald-500">
                      +{formatKRW(topGainAccount.gain)}원
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      납입 {formatKRW(topGainAccount.baseAmount)} → 현재 {formatKRW(topGainAccount.histTotal)}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm mt-2">수익 발생 계좌 없음</p>
                )}
              </Card>
            </div>
          </div>

          {/* ② 납입원금 vs 현재가치 콤보 바 차트 */}
          <div>
            <SectionTitle><TrendingUp className="w-4 h-4 text-violet-500" /> 계좌별 납입원금 vs 현재가치</SectionTitle>
            <Card className="p-5">
              <ResponsiveContainer width="100%" height={260}>
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
                    {barData.map((e) => (
                      <Cell key={e.id} fill={ACCOUNT_COLORS_SOFT[e.id]} />
                    ))}
                  </Bar>
                  <Bar dataKey="현재가치" radius={[4, 4, 0, 0]}>
                    {barData.map((e) => (
                      <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* 범례 */}
              <div className="flex items-center justify-center gap-6 mt-3">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-3 h-3 rounded-sm bg-muted-foreground/40" />
                  납입원금 (연한색)
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-3 h-3 rounded-sm bg-violet-500" />
                  현재가치 (진한색)
                </span>
              </div>
            </Card>
          </div>

          {/* ③ 도넛 + 개별 수익률 범례 */}
          <div>
            <SectionTitle><TrendingUp className="w-4 h-4 text-blue-500" /> 현재가치 비중 &amp; 계좌별 수익 상세</SectionTitle>
            <Card className="p-5">
              <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
                {/* 도넛 */}
                <div className="shrink-0">
                  <PieChart width={210} height={210}>
                    <Pie
                      data={donutData}
                      cx="50%" cy="50%"
                      innerRadius={65} outerRadius={90}
                      dataKey="value" nameKey="name"
                      strokeWidth={0}
                    >
                      {donutData.map((e) => (
                        <Cell key={e.id} fill={ACCOUNT_COLORS[e.id]} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const id = (payload[0].payload as any).id as string;
                        const v = payload[0].value as number;
                        const pct = grandTotal > 0 ? (v / grandTotal * 100).toFixed(1) : "0";
                        const s = summaries.find((a) => a.id === id);
                        return (
                          <div className="rounded-xl border bg-popover p-3 shadow-md text-xs space-y-1">
                            <p className="font-semibold mb-0.5">{payload[0].name}</p>
                            <p className="tabular-nums">{formatKRW(v)}원</p>
                            <p className="text-muted-foreground">비중 {pct}%</p>
                            {s?.latestReturnPct !== null && s?.latestReturnPct !== undefined && (
                              <p className={s.latestReturnPct >= 0 ? "text-emerald-500" : "text-rose-500"}>
                                수익률 {s.latestReturnPct >= 0 ? "+" : ""}{s.latestReturnPct.toFixed(2)}%
                              </p>
                            )}
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </div>

                {/* 상세 범례 */}
                <div className="w-full space-y-2">
                  {summaries.filter((a) => a.baseAmount > 0 || a.histTotal > 0).map((a) => {
                    const pct = grandTotal > 0 ? (a.histTotal / grandTotal * 100).toFixed(1) : "0";
                    const isUp = (a.latestReturnPct ?? 0) >= 0;
                    const hasData = a.baseAmount > 0 || a.histTotal > 0;
                    return (
                      <div key={a.id} className={`rounded-xl p-3 border transition-colors ${hasData ? "bg-muted/30" : "opacity-40"}`}>
                        <div className="flex items-center gap-2.5 mb-1.5">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: ACCOUNT_COLORS[a.id] }} />
                          <span className="text-sm font-semibold flex-1">{a.label}</span>
                          <span className="text-sm font-bold tabular-nums text-muted-foreground">{pct}%</span>
                        </div>
                        <div className="ml-5.5 grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground mb-0.5">납입원금</p>
                            <p className="tabular-nums font-medium">{formatKRW(a.baseAmount)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground mb-0.5">현재가치</p>
                            <p className="tabular-nums font-medium">{formatKRW(a.histTotal)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground mb-0.5">수익 / 수익률</p>
                            <p className={`tabular-nums font-semibold ${a.gain >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                              {a.gain >= 0 ? "+" : ""}{formatKRW(a.gain)}
                            </p>
                            {a.latestReturnPct !== null && (
                              <p className={`tabular-nums text-[11px] ${isUp ? "text-emerald-500" : "text-rose-500"}`}>
                                {isUp ? "+" : ""}{a.latestReturnPct?.toFixed(2)}%
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
