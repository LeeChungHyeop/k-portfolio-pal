import { useMemo, useState } from "react";
import { type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Plus, Trash2, Camera } from "lucide-react";

export function HistorySection({ accountId }: { accountId: AccountId }) {
  const { state, addHistory, removeHistory } = usePortfolioStore();
  const account = state.accounts[accountId];

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [totalValue, setTotalValue] = useState("");
  const [deposit, setDeposit] = useState("");

  const history = useMemo(() => {
    return account.history.map((h, i) => {
      const prev = i > 0 ? account.history[i - 1] : null;
      const ret = prev && prev.totalValue > 0
        ? ((h.totalValue - h.deposit) - prev.totalValue) / prev.totalValue * 100
        : null;
      return { ...h, returnPct: ret };
    });
  }, [account.history]);

  const currentTotal = account.holdings.reduce((s, h) => s + h.value, 0);

  function snapshotNow() {
    addHistory(accountId, {
      id: crypto.randomUUID(),
      date: new Date().toISOString().slice(0, 10),
      totalValue: currentTotal,
      deposit: account.deposit,
      returnPct: null,
    });
  }

  function addManual() {
    if (!date || !totalValue) return;
    addHistory(accountId, {
      id: crypto.randomUUID(),
      date, totalValue: parseFloat(totalValue) || 0, deposit: parseFloat(deposit) || 0, returnPct: null,
    });
    setTotalValue(""); setDeposit("");
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold">히스토리</h3>
          <p className="text-sm text-muted-foreground">수익률 = ((현재 총자산 − 이번 달 불입액) − 지난달 총자산) / 지난달 총자산</p>
        </div>
        <Button onClick={snapshotNow} size="sm" disabled={currentTotal <= 0}>
          <Camera className="w-4 h-4 mr-1.5" /> 오늘 스냅샷 저장
        </Button>
      </div>

      {history.length >= 2 && (
        <div className="h-56">
          <ResponsiveContainer>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} />
              <Tooltip
                formatter={(v: number) => `${formatKRW(v)} 원`}
                contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
              />
              <Line type="monotone" dataKey="totalValue" stroke="oklch(0.62 0.18 250)" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid sm:grid-cols-4 gap-2 items-end p-3 bg-muted/40 rounded-lg">
        <div>
          <label className="text-xs text-muted-foreground">날짜</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">총자산</label>
          <Input type="number" value={totalValue} onChange={(e) => setTotalValue(e.target.value)} placeholder="0" className="h-9" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">불입액</label>
          <Input type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0" className="h-9" />
        </div>
        <Button onClick={addManual} variant="outline" size="sm" className="h-9">
          <Plus className="w-4 h-4 mr-1" /> 과거 데이터 추가
        </Button>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">아직 기록된 히스토리가 없습니다.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>날짜</TableHead>
              <TableHead className="text-right">총자산</TableHead>
              <TableHead className="text-right">불입액</TableHead>
              <TableHead className="text-right">수익률</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...history].reverse().map((h) => (
              <TableRow key={h.id}>
                <TableCell className="font-medium">{h.date}</TableCell>
                <TableCell className="text-right tabular-nums">{formatKRW(h.totalValue)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatKRW(h.deposit)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {h.returnPct === null ? <span className="text-muted-foreground">—</span> :
                    <span className={h.returnPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                      {h.returnPct >= 0 ? "+" : ""}{h.returnPct.toFixed(2)}%
                    </span>}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeHistory(accountId, h.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
