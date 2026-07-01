import { useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore, type HistoryEntry } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import { RefreshCw } from "lucide-react";
import { computeGrowthBacktest, useGrowthBacktestPrices } from "@/lib/kaw/backtest";

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

const COLOR_ACTUAL = "oklch(0.62 0.18 250)";
const COLOR_GROWTH = "oklch(0.72 0.17 80)";

interface ComparePoint {
  label: string;
  실제자산: number;
  성장형자산: number;
  실제수익률: number | null;
  성장형수익률: number | null;
}

// 기존 대시보드의 "전체자산추이"와 동일한 규칙: 월별 최신 리밸런싱 시점 하나만 채택
function buildComparePoints(
  history: HistoryEntry[],
  pricesByDate: Record<string, Partial<Record<string, number>>>,
): ComparePoint[] {
  if (!history.length) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  const latestDateByMonth = new Map<string, string>();
  sorted.forEach((h) => {
    const month = h.date.slice(0, 7);
    const existing = latestDateByMonth.get(month);
    if (!existing || h.date > existing) latestDateByMonth.set(month, h.date);
  });

  let cumDeposit = 0;
  const cumDepositByDate = new Map<string, number>();
  sorted.forEach((h, i) => {
    cumDeposit += i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
    cumDepositByDate.set(h.date, cumDeposit);
  });

  const backtest = Object.keys(pricesByDate).length
    ? computeGrowthBacktest(sorted, pricesByDate)
    : [];
  const backtestByDate = new Map(backtest.map((p) => [p.date, p]));

  return [...latestDateByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, date]) => {
      const h = sorted.find((x) => x.date === date)!;
      const cd = cumDepositByDate.get(date) ?? 0;
      const 실제수익률 = cd > 0 ? Math.round(((h.totalValue - cd) / cd) * 10000) / 100 : null;
      const bt = backtestByDate.get(date);
      return {
        label: month.replace("-", "."),
        실제자산: h.totalValue,
        성장형자산: bt?.totalValue ?? 0,
        실제수익률,
        성장형수익률: bt?.returnPct ?? null,
      };
    });
}

export function IndexComparison() {
  const { state } = usePortfolioStore();
  const [tab, setTab] = useState<AccountId>("retirement");

  const historiesByAccount = useMemo(() => {
    const m = {} as Record<AccountId, HistoryEntry[]>;
    ACCOUNT_IDS.forEach((id) => {
      m[id] = state.accounts[id].history;
    });
    return m;
  }, [state]);

  const { pricesByDate, loading, error } = useGrowthBacktestPrices(historiesByAccount);

  const dataByAccount = useMemo(() => {
    const out = {} as Record<AccountId, ComparePoint[]>;
    ACCOUNT_IDS.forEach((id) => {
      out[id] = buildComparePoints(historiesByAccount[id], pricesByDate);
    });
    return out;
  }, [historiesByAccount, pricesByDate]);

  const ready = !loading && dataByAccount[tab].length >= 1;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold">지수비교</h2>
        <p className="text-sm text-muted-foreground mt-1">
          내 계좌(커스텀 운용) vs 초기 납입 시점부터 쭉 케이올웨더 성장형으로 운용했을 경우 비교
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AccountId)}>
        <TabsList>
          {ACCOUNT_IDS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {ACCOUNT_LABELS_SHORT[id]}
            </TabsTrigger>
          ))}
        </TabsList>

        {ACCOUNT_IDS.map((id) => (
          <TabsContent key={id} value={id} className="space-y-6 mt-4">
            {loading && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 과거 시세 불러오는 중...
              </p>
            )}
            {error && (
              <p className="text-sm text-rose-500">
                과거 시세 조회 중 일부 실패했어. 값이 부정확할 수 있어.
              </p>
            )}
            {!loading && dataByAccount[id].length < 1 && (
              <p className="text-sm text-muted-foreground">리밸런싱 기록이 아직 없어.</p>
            )}

            {ready && dataByAccount[id].length >= 1 && (
              <>
                <Card className="p-5">
                  <h3 className="font-semibold mb-4">자산총액 비교</h3>
                  <div className="h-72">
                    <ResponsiveContainer>
                      <BarChart data={dataByAccount[id]}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={50} />
                        <Tooltip formatter={(v: number) => `${v.toLocaleString()}원`} />
                        <Legend />
                        <Bar
                          dataKey="실제자산"
                          name="실제(커스텀)"
                          fill={COLOR_ACTUAL}
                          radius={[4, 4, 0, 0]}
                        />
                        <Bar
                          dataKey="성장형자산"
                          name="케이올웨더 성장형"
                          fill={COLOR_GROWTH}
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                <Card className="p-5">
                  <h3 className="font-semibold mb-4">누적수익률 비교</h3>
                  <div className="h-64">
                    <ResponsiveContainer>
                      <LineChart data={dataByAccount[id]}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
                          width={58}
                        />
                        <Tooltip
                          formatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
                        />
                        <ReferenceLine
                          y={0}
                          stroke="var(--border)"
                          strokeWidth={1.5}
                          strokeDasharray="4 2"
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="실제수익률"
                          name="실제(커스텀)"
                          stroke={COLOR_ACTUAL}
                          strokeWidth={2}
                          dot={{ r: 2 }}
                          connectNulls
                        />
                        <Line
                          type="monotone"
                          dataKey="성장형수익률"
                          name="케이올웨더 성장형"
                          stroke={COLOR_GROWTH}
                          strokeWidth={2}
                          dot={{ r: 2 }}
                          connectNulls
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
