import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { Database, Save, Trash2, TrendingUp, WalletCards } from "lucide-react";
import { toast } from "sonner";
import {
  formatKRW,
  getOrDefaultLibrary,
  usePortfolioStore,
  type AccountState,
  type AssetDef,
} from "@/lib/kaw/store";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import {
  buildRetirementDbSeries,
  calcRetirementDbWageBreakdown,
  removeRetirementDbPayRow,
  upsertRetirementDbPayRow,
  type RetirementDbPayRow,
} from "@/lib/kaw/retirement-db";

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

function NumberField({
  value,
  onChange,
  placeholder = "0",
}: {
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const display = raw !== null ? raw : value > 0 ? formatKRW(value) : "";
  return (
    <Input
      value={display}
      placeholder={placeholder}
      inputMode="numeric"
      onFocus={() => setRaw(value > 0 ? String(value) : "")}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, "");
        setRaw(digits);
        onChange(parseInt(digits, 10) || 0);
      }}
      onBlur={() => setRaw(null)}
    />
  );
}

function latestHistory(account: AccountState) {
  return [...(account.history ?? [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
}

function currentDcValue(
  account: AccountState,
  library: AssetDef[],
  prices: Record<string, number>,
): { value: number; live: boolean; sourceDate?: string } {
  const last = latestHistory(account);
  let etfValue = 0;
  let liveCount = 0;
  let positionCount = 0;

  // 가장 신뢰도 높은 경로: 마지막 확정 리밸런싱의 수량 스냅샷 × 현재가.
  if (last?.rowQuantitiesSnap) {
    for (const [rowId, qty] of Object.entries(last.rowQuantitiesSnap)) {
      if (!(qty > 0)) continue;
      positionCount += 1;
      const assetId = last.rowAssetSnap?.[rowId];
      const etfName = last.rowEtfSnap?.[rowId];
      const def =
        (assetId ? library.find((d) => d.id === assetId) : undefined) ??
        (etfName ? library.find((d) => d.defaultEtf === etfName) : undefined);
      const price = def?.ticker ? prices[def.ticker] ?? 0 : 0;
      if (price > 0) {
        etfValue += qty * price;
        liveCount += 1;
      } else {
        etfValue += last.rowHoldingsSnap?.[rowId] ?? 0;
      }
    }
  }

  // 구형 기록에는 수량 스냅샷이 없을 수 있다. 현재 row 수량을 두 번째 경로로 사용.
  if (positionCount === 0) {
    const profile = account.profile ?? "growth";
    const rows = account.profileRows?.[profile] ?? [];
    for (const row of rows) {
      const qty = account.liveQuantities?.[row.id] ?? 0;
      if (!(qty > 0)) continue;
      positionCount += 1;
      const def = library.find((d) => d.id === row.assetId);
      const price = def?.ticker ? prices[def.ticker] ?? 0 : 0;
      if (price > 0) {
        etfValue += qty * price;
        liveCount += 1;
      } else {
        etfValue += account.rowHoldings?.[row.id] ?? 0;
      }
    }
  }

  const cash = account.cashBalance ?? last?.cashBalance ?? 0;
  if (positionCount > 0) {
    return {
      value: etfValue + cash,
      live: liveCount > 0,
      sourceDate: last?.date,
    };
  }

  return {
    value: last?.totalValue ?? 0,
    live: false,
    sourceDate: last?.date,
  };
}

interface EditRow {
  month: string;
  regularPay: number;
  bonus: number;
  internalEval: number;
  managementEval: number;
  internalEvalEffectiveMonth: string;
  note: string;
}

function toEditRow(row: RetirementDbPayRow | undefined, month: string): EditRow {
  return {
    month,
    regularPay: row?.regularPay ?? 0,
    bonus: row?.bonus ?? 0,
    internalEval: row?.internalEval ?? 0,
    managementEval: row?.managementEval ?? 0,
    internalEvalEffectiveMonth: row?.internalEvalEffectiveMonth ?? "",
    note: row?.note ?? "",
  };
}

export function RetirementDbComparison() {
  const { state, updateAccount } = usePortfolioStore();
  const { prices } = useKisPriceContext();
  const account = state.accounts.retirement;
  const config = account.retirementDbBenchmark;
  const library = getOrDefaultLibrary(state);

  const todayMonth = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const [edit, setEdit] = useState<EditRow>(() => toEditRow(undefined, todayMonth));

  useEffect(() => {
    if (!config) return;
    const row = config.rows.find((r) => r.month === edit.month);
    setEdit((prev) => toEditRow(row, prev.month));
    // month 선택이 바뀔 때만 해당 월 데이터를 폼에 올린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.month, config?.rows]);

  const dbSeries = useMemo(
    () => (config ? buildRetirementDbSeries(config) : []),
    [config],
  );
  const latestDb = dbSeries.at(-1) ?? null;
  const latestBreakdown = useMemo(
    () => (config && latestDb ? calcRetirementDbWageBreakdown(config, latestDb.month) : null),
    [config, latestDb],
  );
  const dc = useMemo(
    () => currentDcValue(account, library, prices),
    [account, library, prices],
  );

  const chartData = useMemo(() => {
    if (!config) return [];
    const map = new Map<string, { date: string; db?: number; dc?: number }>();

    for (const p of dbSeries) {
      map.set(p.date, { ...(map.get(p.date) ?? { date: p.date }), db: Math.round(p.amount) });
    }

    // 전환 당일에는 실제 DC 이전액과 가상 DB가 같은 값에서 출발.
    map.set(config.anchorDate, {
      ...(map.get(config.anchorDate) ?? { date: config.anchorDate }),
      db: config.anchorAmount,
      dc: config.anchorAmount,
    });

    for (const h of account.history ?? []) {
      if (h.date < config.anchorDate) continue;
      map.set(h.date, {
        ...(map.get(h.date) ?? { date: h.date }),
        dc: h.totalValue,
      });
    }

    // 현재가는 차트의 마지막 실제 DC 포인트로 추가한다.
    if (dc.value > 0) {
      const today = new Date().toISOString().slice(0, 10);
      map.set(today, {
        ...(map.get(today) ?? { date: today }),
        dc: dc.value,
      });
    }

    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [config, dbSeries, account.history, dc.value]);

  if (!config) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        DB 비교 기준정보가 없습니다.
      </Card>
    );
  }

  const gap = latestDb && dc.value > 0 ? dc.value - latestDb.amount : null;
  const gapPct = latestDb && gap !== null && latestDb.amount > 0
    ? (gap / latestDb.amount) * 100
    : null;

  function chooseMonth(month: string) {
    if (!month) return;
    const row = config.rows.find((r) => r.month === month);
    setEdit(toEditRow(row, month));
  }

  function saveRow() {
    if (!edit.month) return;
    const next = upsertRetirementDbPayRow(config, {
      month: edit.month,
      regularPay: edit.regularPay || undefined,
      bonus: edit.bonus || undefined,
      internalEval: edit.internalEval || undefined,
      managementEval: edit.managementEval || undefined,
      internalEvalEffectiveMonth: edit.internalEvalEffectiveMonth || undefined,
      note: edit.note || undefined,
    });
    updateAccount("retirement", { retirementDbBenchmark: next });
    toast.success(`${edit.month.replace("-", ".")} 급여정보를 저장했습니다.`);
  }

  function deleteRow() {
    if (!config.rows.some((r) => r.month === edit.month)) return;
    const next = removeRetirementDbPayRow(config, edit.month);
    updateAccount("retirement", { retirementDbBenchmark: next });
    setEdit(toEditRow(undefined, edit.month));
    toast.success(`${edit.month.replace("-", ".")} 급여정보를 삭제했습니다.`);
  }

  const rowsDesc = [...config.rows].sort((a, b) => b.month.localeCompare(a.month));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <WalletCards className="w-4 h-4" /> 현재 DC 평가액
          </div>
          <p className="text-xl font-bold tabular-nums">
            {dc.value > 0 ? `${formatKRW(dc.value)}원` : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {dc.live ? "현재가 반영" : dc.sourceDate ? `최근 확정 ${dc.sourceDate}` : "평가정보 없음"}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Database className="w-4 h-4" /> 계속 DB였다면
          </div>
          <p className="text-xl font-bold tabular-nums">
            {latestDb ? `${formatKRW(latestDb.amount)}원` : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {latestDb ? `${latestDb.date} 기준` : "급여정보를 입력해주세요"}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <TrendingUp className="w-4 h-4" /> DC − 가상 DB
          </div>
          <p className={`text-xl font-bold tabular-nums ${gap === null ? "" : gap >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {gap === null ? "—" : `${gap >= 0 ? "+" : ""}${formatKRW(gap)}원`}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {gapPct === null ? "비교할 데이터가 없습니다" : `${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%`}
          </p>
        </Card>
      </div>

      {chartData.length >= 2 && (
        <Card className="p-5">
          <div className="mb-3">
            <p className="text-sm font-semibold">DC vs 가상 DB</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              2025-03-25 실제 DB 정산액 {formatKRW(config.anchorAmount)}원을 공통 출발점으로 사용합니다.
              실제 DC는 저장된 리밸런싱 기록과 현재가만 표시합니다.
            </p>
          </div>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={28} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={54} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `${formatKRW(value)}원`,
                    name === "dc" ? "실제 DC" : "가상 DB",
                  ]}
                  labelFormatter={(label) => String(label)}
                  contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
                />
                <Legend
                  formatter={(value) => value === "dc" ? "실제 DC" : "가상 DB"}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Line
                  type="monotone"
                  dataKey="dc"
                  stroke="oklch(0.62 0.18 250)"
                  strokeWidth={2.4}
                  dot={{ r: 2.5 }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="db"
                  stroke="oklch(0.62 0.16 145)"
                  strokeWidth={2.4}
                  strokeDasharray="5 3"
                  dot={{ r: 2.5 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {latestBreakdown && (
        <Card className="p-5">
          <p className="text-sm font-semibold mb-3">가상 DB 계산 근거 · {latestBreakdown.month.replace("-", ".")}</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">최근 3개월 보수</p>
              <p className="font-semibold tabular-nums mt-1">{formatKRW(latestBreakdown.regular3m)}원</p>
            </div>
            <div>
              <p className="text-muted-foreground">상여 12개월 월환산</p>
              <p className="font-semibold tabular-nums mt-1">{formatKRW(latestBreakdown.bonus12mMonthly)}원</p>
            </div>
            <div>
              <p className="text-muted-foreground">내부평가급 월환산</p>
              <p className="font-semibold tabular-nums mt-1">{formatKRW(latestBreakdown.internalEvalMonthly)}원</p>
              {latestBreakdown.internalEvalSource && (
                <p className="text-[10px] text-muted-foreground mt-0.5">{latestBreakdown.internalEvalSource}</p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">경영평가급 월환산</p>
              <p className="font-semibold tabular-nums mt-1">{formatKRW(latestBreakdown.managementEvalMonthly)}원</p>
              {latestBreakdown.managementEvalSource && (
                <p className="text-[10px] text-muted-foreground mt-0.5">{latestBreakdown.managementEvalSource}</p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">평균임금 지수</p>
              <p className="font-bold tabular-nums mt-1">{formatKRW(latestBreakdown.wageIndex)}원</p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">
            월별 가상 DB는 전환 당시 실제 정산액을 앵커로 두고,
            평균임금 지수 변화와 2016-07-01부터의 근속일수 증가율을 곱해 계산합니다.
            상여는 직전 12개월 합계÷12, 경영평가급은 직전 1년 내 최종 지급액÷12,
            내부평가급은 3·6월 합계÷6 또는 12월 지급액÷6을 적용합니다.
            특수 지급분은 입력한 귀속월을 기준으로 가장 최근 후보를 사용합니다.
          </p>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex flex-col md:flex-row md:items-end gap-3">
          <div className="w-full md:w-36">
            <label className="text-xs text-muted-foreground">월</label>
            <Input
              type="month"
              value={edit.month}
              onChange={(e) => chooseMonth(e.target.value)}
              className="mt-1"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">산정대상 월급</label>
            <NumberField value={edit.regularPay} onChange={(v) => setEdit((p) => ({ ...p, regularPay: v }))} />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">상여금</label>
            <NumberField value={edit.bonus} onChange={(v) => setEdit((p) => ({ ...p, bonus: v }))} />
          </div>
        </div>

        <div className="flex flex-col md:flex-row md:items-end gap-3 mt-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">내부평가급</label>
            <NumberField value={edit.internalEval} onChange={(v) => setEdit((p) => ({ ...p, internalEval: v }))} />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">내평가 귀속월 (특수지급만)</label>
            <Input
              type="month"
              value={edit.internalEvalEffectiveMonth}
              onChange={(e) => setEdit((p) => ({ ...p, internalEvalEffectiveMonth: e.target.value }))}
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">경영평가급</label>
            <NumberField value={edit.managementEval} onChange={(v) => setEdit((p) => ({ ...p, managementEval: v }))} />
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-3 mt-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">메모</label>
            <Input
              value={edit.note}
              onChange={(e) => setEdit((p) => ({ ...p, note: e.target.value }))}
              placeholder="예: 9월 지급예정분 조기지급"
              className="mt-1"
            />
          </div>
          <div className="flex gap-2 md:self-end">
            <Button onClick={saveRow}>
              <Save className="w-4 h-4 mr-1" /> 저장
            </Button>
            <Button
              variant="outline"
              onClick={deleteRow}
              disabled={!config.rows.some((r) => r.month === edit.month)}
            >
              <Trash2 className="w-4 h-4 mr-1" /> 삭제
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b">
          <p className="font-semibold">급여·평가급 원천데이터</p>
          <p className="text-xs text-muted-foreground mt-0.5">행을 누르면 위 입력폼에서 수정할 수 있습니다.</p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>월</TableHead>
                <TableHead className="text-right">월급</TableHead>
                <TableHead className="text-right">상여</TableHead>
                <TableHead className="text-right">내부평가</TableHead>
                <TableHead className="text-right">경영평가</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsDesc.map((row) => (
                <TableRow
                  key={row.month}
                  className="cursor-pointer"
                  onClick={() => chooseMonth(row.month)}
                >
                  <TableCell className="font-medium whitespace-nowrap">
                    {row.month.replace("-", ".")}
                    {row.internalEvalEffectiveMonth && (
                      <span className="block text-[10px] text-muted-foreground">
                        내평가→{row.internalEvalEffectiveMonth.replace("-", ".")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.regularPay ? formatKRW(row.regularPay) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.bonus ? formatKRW(row.bonus) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.internalEval ? formatKRW(row.internalEval) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.managementEval ? formatKRW(row.managementEval) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
