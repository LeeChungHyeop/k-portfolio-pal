import { useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, ASSET_ORDER, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore, getOrDefaultLibrary, BUILTIN_TICKERS, type HistoryEntry, type ProfileRowDef } from "@/lib/kaw/store";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
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
import { useEnsureGrowthBacktest, getCachedIndexBasePrices } from "@/lib/kaw/backtest";

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

const COLOR_ACTUAL = "oklch(0.62 0.18 250)";
const COLOR_GROWTH = "oklch(0.72 0.17 80)";
const COLOR_KOSPI = "oklch(0.62 0.20 20)";
const COLOR_SP500 = "oklch(0.55 0.16 300)";

// recharts 기본 Tooltip은 배경이 흰색 고정인데 글자색은 테마를 물려받아서
// 다크모드에서 흰 배경에 흰 글씨로 안 보이는 문제가 있어, 대시보드와 동일하게 커스텀 렌더링한다.
function AssetTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const date = payload[0]?.payload?.date;
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-40">
      <p className="font-semibold text-xs text-muted-foreground mb-1">{date}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-xs">{p.name}</span>
          </span>
          <span className="tabular-nums text-xs font-medium">
            {/* 성장형(케이올웨더) 예상치는 유닛 단가 계산 과정에서 소수점이 붙으므로 정수로 반올림해 표기 */}
            {(p.dataKey === "성장형자산" ? Math.round(Number(p.value)) : Number(p.value)).toLocaleString()}원
          </span>
        </div>
      ))}
    </div>
  );
}

function ReturnCompareTooltip({ active, payload, brk }: any) {
  if (!active || !payload?.length) return null;
  const date = payload[0]?.payload?.date;
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-40">
      <p className="font-semibold text-xs text-muted-foreground mb-1">{date}</p>
      {payload.map((p: any) => {
        const real = inverseAxisValue(p.value, brk);
        return (
          <div key={p.dataKey} className="flex justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
              <span className="text-xs">{p.name}</span>
            </span>
            <span
              className={`tabular-nums text-xs font-medium ${real >= 0 ? "text-emerald-600" : "text-rose-600"}`}
            >
              {real >= 0 ? "+" : ""}
              {real.toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface ComparePoint {
  label: string;
  date: string; // 해당 포인트의 실제 리밸런싱 일자 (YYYY-MM-DD) — 툴팁 표시용
  실제자산: number;
  성장형자산: number;
  실제수익률: number | null;
  성장형수익률: number | null;
  코스피200: number | null;
  "S&P500": number | null;
}

const RETURN_SERIES_KEYS = ["실제수익률", "성장형수익률", "코스피200", "S&P500"] as const;

// 1등(최고점)이 나머지보다 압도적으로 높을 때, "2등 바로 위 ~ 1등 바로 아래" 구간을
// y축에서 압축해서 생략 표시하기 위한 구간 정보
interface AxisBreak {
  breakLow: number; // 이 값까지는 원래 스케일 그대로
  breakHigh: number; // 이 값부터 다시 원래 스케일 (breakLow~breakHigh 사이가 압축됨)
  gap: number; // 압축 구간에 할당할 화면상 "값 공간" 크기
  dataMin: number;
  dataMax: number;
}

function computeAxisBreak(rows: ComparePoint[]): AxisBreak | null {
  const maxBySeries = RETURN_SERIES_KEYS.map((k) =>
    rows.reduce((m, r) => {
      const v = r[k];
      return v !== null && v > m ? v : m;
    }, -Infinity),
  ).filter((v) => Number.isFinite(v));
  if (maxBySeries.length < 2) return null;

  const [top1, top2] = [...maxBySeries].sort((a, b) => b - a);
  // 1등이 2등보다 압도적으로 클 때만 축 생략 적용 (그 외엔 평범하게 렌더링)
  if (top1 <= 0 || top1 - top2 < 20 || top1 < top2 * 1.6) return null;

  const allValues = rows.flatMap((r) =>
    RETURN_SERIES_KEYS.map((k) => r[k]).filter((v): v is number => v !== null),
  );
  const minAll = Math.min(0, ...allValues);
  const margin = Math.max(2, (top2 - minAll) * 0.1);
  const breakLow = top2 + margin;
  const breakHigh = top1 - margin;
  if (breakHigh <= breakLow + 1) return null;

  const gap = Math.max(4, (breakHigh - breakLow) * 0.06);
  return { breakLow, breakHigh, gap, dataMin: minAll, dataMax: top1 };
}

// 1,2,2.5,5,10... 형태의 "예쁜" 눈금 간격을 골라 min~max 사이 눈금을 생성
function buildNiceTicks(min: number, max: number, targetCount: number): number[] {
  if (max <= min) return [Math.round(min)];
  const rough = (max - min) / Math.max(1, targetCount);
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => s >= rough) ?? steps[steps.length - 1];
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks.length ? ticks : [Math.round(min), Math.round(max)];
}

function transformValue(v: number, brk: AxisBreak | null): number {
  if (!brk) return v;
  if (v <= brk.breakLow) return v;
  if (v >= brk.breakHigh) return brk.breakLow + brk.gap + (v - brk.breakHigh);
  const ratio = (v - brk.breakLow) / (brk.breakHigh - brk.breakLow);
  return brk.breakLow + brk.gap * ratio;
}

function inverseAxisValue(t: number, brk: AxisBreak | null): number {
  if (!brk) return t;
  if (t <= brk.breakLow) return t;
  if (t <= brk.breakLow + brk.gap) {
    const ratio = (t - brk.breakLow) / brk.gap;
    return brk.breakLow + ratio * (brk.breakHigh - brk.breakLow);
  }
  return brk.breakHigh + (t - brk.breakLow - brk.gap);
}

function applyAxisBreak(rows: ComparePoint[], brk: AxisBreak | null): ComparePoint[] {
  if (!brk) return rows;
  return rows.map((r) => ({
    ...r,
    실제수익률: r.실제수익률 === null ? null : transformValue(r.실제수익률, brk),
    성장형수익률: r.성장형수익률 === null ? null : transformValue(r.성장형수익률, brk),
    코스피200: r.코스피200 === null ? null : transformValue(r.코스피200, brk),
    "S&P500": r["S&P500"] === null ? null : transformValue(r["S&P500"], brk),
  }));
}

// 기존 대시보드의 "전체자산추이"와 동일한 규칙: 월별 최신 리밸런싱 시점 하나만 채택.
// 성장형 백테스트 값은 리밸런싱 시점에 미리 계산해 h.backtestGrowth로 저장돼 있으므로 그대로 읽기만 한다.
function buildComparePoints(history: HistoryEntry[]): ComparePoint[] {
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

  return [...latestDateByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, date]) => {
      const h = sorted.find((x) => x.date === date)!;
      const cd = cumDepositByDate.get(date) ?? 0;
      const 실제수익률 = cd > 0 ? Math.round(((h.totalValue - cd) / cd) * 10000) / 100 : null;
      const bt = h.backtestGrowth;
      return {
        label: month.replace("-", "."),
        date,
        실제자산: h.totalValue,
        성장형자산: bt?.totalValue ?? 0,
        실제수익률,
        성장형수익률: bt?.returnPct ?? null,
        코스피200: bt?.kospi200Pct ?? null,
        "S&P500": bt?.sp500Pct ?? null,
      };
    });
}

const pctSince = (base: number | undefined, cur: number | undefined) =>
  base && base > 0 && cur && cur > 0 ? Math.round(((cur - base) / base) * 10000) / 100 : null;

// 실시간 주가로 "현재" 시점 비교 포인트를 만든다.
// 실제(커스텀)는 보유수량 × 실시간가, 성장형은 마지막 리밸런싱 시점 보유 유닛 × 실시간가로 평가한다.
function buildLivePoint(
  history: HistoryEntry[],
  profileRows: ProfileRowDef[],
  liveQuantities: Record<string, number> | undefined,
  library: ReturnType<typeof getOrDefaultLibrary>,
  livePrices: Record<string, number>,
): ComparePoint | null {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  if (!last.backtestGrowth) return null;

  const 실제자산 = profileRows.reduce((sum, row) => {
    const def = library.find((d) => d.id === row.assetId);
    const etfName = row.etfName ?? def?.defaultEtf ?? row.assetId;
    const tickerByEtf = library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker;
    const ticker = tickerByEtf ?? def?.ticker ?? "";
    const qty = liveQuantities?.[row.id] ?? 0;
    const price = ticker ? (livePrices[ticker] ?? 0) : 0;
    return sum + qty * price;
  }, 0);

  const units = last.backtestGrowth.units;
  const 성장형자산 = ASSET_ORDER.reduce((sum, key) => {
    const ticker = BUILTIN_TICKERS[key];
    const price = ticker ? (livePrices[ticker] ?? 0) : 0;
    return sum + (units[key] ?? 0) * price;
  }, 0);

  if (실제자산 <= 0 || 성장형자산 <= 0) return null;

  let cumDeposit = 0;
  sorted.forEach((h, i) => {
    cumDeposit += i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
  });

  const base = getCachedIndexBasePrices(sorted[0].date);
  const krTicker = BUILTIN_TICKERS.kr;
  const usTicker = BUILTIN_TICKERS.us;

  return {
    label: "현재",
    date: "현재",
    실제자산,
    성장형자산,
    실제수익률: cumDeposit > 0 ? Math.round(((실제자산 - cumDeposit) / cumDeposit) * 10000) / 100 : null,
    성장형수익률: cumDeposit > 0 ? Math.round(((성장형자산 - cumDeposit) / cumDeposit) * 10000) / 100 : null,
    코스피200: pctSince(base.kr, krTicker ? livePrices[krTicker] : undefined),
    "S&P500": pctSince(base.us, usTicker ? livePrices[usTicker] : undefined),
  };
}

export function IndexComparison() {
  const { state, setHistoryBacktest } = usePortfolioStore();
  const [tab, setTab] = useState<AccountId>("retirement");
  const { prices: livePrices, configured } = useKisPriceContext();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);

  // 계좌별로 backtestGrowth가 없는 히스토리가 있으면 (신규 계좌 또는 최초 1회) 조용히 계산해서 저장
  const retirementSync = useEnsureGrowthBacktest(state.accounts.retirement.history, (r) =>
    setHistoryBacktest("retirement", r),
  );
  const isaSync = useEnsureGrowthBacktest(state.accounts.isa.history, (r) =>
    setHistoryBacktest("isa", r),
  );
  const pensionSync = useEnsureGrowthBacktest(state.accounts.pension.history, (r) =>
    setHistoryBacktest("pension", r),
  );
  const irpSync = useEnsureGrowthBacktest(state.accounts.irp.history, (r) =>
    setHistoryBacktest("irp", r),
  );
  const syncByAccount: Record<AccountId, { syncing: boolean; error: boolean }> = {
    retirement: retirementSync,
    isa: isaSync,
    pension: pensionSync,
    irp: irpSync,
  };

  const dataByAccount = useMemo(() => {
    const out = {} as Record<AccountId, ComparePoint[]>;
    ACCOUNT_IDS.forEach((id) => {
      const account = state.accounts[id];
      const points = buildComparePoints(account.history);
      const livePoint = configured
        ? buildLivePoint(
            account.history,
            account.profileRows?.[account.profile ?? "growth"] ?? [],
            account.liveQuantities,
            library,
            livePrices,
          )
        : null;
      out[id] = livePoint ? [...points, livePoint] : points;
    });
    return out;
  }, [state, library, livePrices, configured]);

  const activeSync = syncByAccount[tab];

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

        {ACCOUNT_IDS.map((id) => {
          const rows = dataByAccount[id];
          const brk = computeAxisBreak(rows);
          const chartRows = applyAxisBreak(rows, brk);
          const yTicks = brk
            ? [
                ...buildNiceTicks(brk.dataMin, brk.breakLow, 4),
                ...buildNiceTicks(brk.breakHigh, brk.dataMax, 2),
              ].map((v) => transformValue(v, brk))
            : undefined;
          const breakMarkY = brk ? brk.breakLow + brk.gap / 2 : null;

          return (
            <TabsContent key={id} value={id} className="space-y-6 mt-4">
              {syncByAccount[id].syncing && (
                <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 성장형 백테스트 처음 계산 중...
                  (한 번만 계산되고 저장돼)
                </p>
              )}
              {syncByAccount[id].error && (
                <p className="text-sm text-rose-500">
                  과거 시세 조회 중 일부 실패했어. 다시 이 메뉴에 들어오면 재시도돼.
                </p>
              )}
              {dataByAccount[id].length < 1 && (
                <p className="text-sm text-muted-foreground">리밸런싱 기록이 아직 없어.</p>
              )}

              {dataByAccount[id].length >= 1 && (
                <>
                  <Card className="p-5">
                    <h3 className="font-semibold mb-4">자산총액 비교 (vs K-All Weather)</h3>
                    <div className="h-72">
                      <ResponsiveContainer>
                        <BarChart data={dataByAccount[id]}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={50} />
                          <Tooltip content={<AssetTooltip />} />
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
                    {brk && (
                      <p className="text-xs text-muted-foreground mb-2">
                        ⌇ 표시 구간은 값 차이가 너무 커서 축을 압축/생략했어
                      </p>
                    )}
                    <div className="h-64">
                      <ResponsiveContainer>
                        <LineChart data={chartRows}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            ticks={yTicks}
                            domain={brk ? undefined : ["auto", "auto"]}
                            tickFormatter={(v) => {
                              const real = inverseAxisValue(v, brk);
                              return `${real >= 0 ? "+" : ""}${real.toFixed(1)}%`;
                            }}
                            width={58}
                          />
                          <Tooltip content={<ReturnCompareTooltip brk={brk} />} />
                          <ReferenceLine
                            y={transformValue(0, brk)}
                            stroke="var(--border)"
                            strokeWidth={1.5}
                            strokeDasharray="4 2"
                          />
                          {breakMarkY !== null && (
                            <ReferenceLine
                              y={breakMarkY}
                              stroke="oklch(0.6 0.02 260)"
                              strokeWidth={1.5}
                              strokeDasharray="2 3"
                              label={{
                                value: "⌇ 축 생략",
                                position: "insideTopLeft",
                                fontSize: 9,
                                fill: "oklch(0.6 0.02 260)",
                              }}
                            />
                          )}
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
                          <Line
                            type="monotone"
                            dataKey="코스피200"
                            name="코스피200"
                            stroke={COLOR_KOSPI}
                            strokeWidth={1.5}
                            strokeDasharray="5 3"
                            dot={{ r: 2 }}
                            connectNulls
                          />
                          <Line
                            type="monotone"
                            dataKey="S&P500"
                            name="S&P500"
                            stroke={COLOR_SP500}
                            strokeWidth={1.5}
                            strokeDasharray="5 3"
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
          );
        })}
      </Tabs>
    </div>
  );
}
