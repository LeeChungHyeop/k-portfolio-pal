import { useMemo } from "react";
import { ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore, formatKRW } from "@/lib/kaw/store";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export function AccountTab({ accountId }: { accountId: AccountId }) {
  const { state, updateAccount, updateHolding } = usePortfolioStore();
  const account = state.accounts[accountId];
  const alloc = state.allocations[state.profile];

  const rows = useMemo(() => ASSET_ORDER.map((k) => {
    const h = account.holdings.find((x) => x.assetKey === k)!;
    const pct = alloc[k] || 0;
    const target = (account.baseAmount * pct) / 100;
    const diff = target - h.value;
    return { key: k, holding: h, pct, target, diff };
  }), [account, alloc]);

  const totalValue = rows.reduce((s, r) => s + r.holding.value, 0);
  const deposit_diff = account.baseAmount - totalValue;

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground mb-1">기준잔액</div>
          <Input
            type="number"
            value={account.baseAmount || ""}
            onChange={(e) => updateAccount(accountId, { baseAmount: parseFloat(e.target.value) || 0 })}
            placeholder="0"
            className="text-lg font-semibold h-11"
          />
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground mb-1">이번 달 불입액</div>
          <Input
            type="number"
            value={account.deposit || ""}
            onChange={(e) => updateAccount(accountId, { deposit: parseFloat(e.target.value) || 0 })}
            placeholder="0"
            className="text-lg font-semibold h-11"
          />
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground mb-1">평가금액 합계</div>
          <div className="text-lg font-semibold h-11 flex items-center">{formatKRW(totalValue)} 원</div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">자산군</TableHead>
              <TableHead>ETF 종목명</TableHead>
              <TableHead className="text-right w-16">비중</TableHead>
              <TableHead className="text-right">기준금액</TableHead>
              <TableHead className="text-right">평가금액</TableHead>
              <TableHead className="text-right">추가매수</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="w-2 h-2 rounded-full" style={{ background: GROUP_COLORS[ASSET_GROUPS[r.key].group] }} />
                    {ASSET_GROUPS[r.key].group}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{ASSET_GROUPS[r.key].label}</div>
                </TableCell>
                <TableCell>
                  <Input
                    value={r.holding.etfName}
                    onChange={(e) => updateHolding(accountId, r.key, { etfName: e.target.value })}
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{r.pct}%</TableCell>
                <TableCell className="text-right text-sm tabular-nums text-muted-foreground">{formatKRW(r.target)}</TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    value={r.holding.value || ""}
                    onChange={(e) => updateHolding(accountId, r.key, { value: parseFloat(e.target.value) || 0 })}
                    placeholder="0"
                    className="h-8 text-sm text-right tabular-nums"
                  />
                </TableCell>
                <TableCell className="text-right">
                  <RebalanceCell diff={r.diff} />
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-medium">
              <TableCell colSpan={3}>예수금 (기준 − 평가)</TableCell>
              <TableCell className="text-right tabular-nums" colSpan={3}>{formatKRW(deposit_diff)} 원</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function RebalanceCell({ diff }: { diff: number }) {
  if (Math.abs(diff) < 1) return <span className="text-muted-foreground inline-flex items-center gap-1 text-sm"><Minus className="w-3 h-3" />—</span>;
  if (diff > 0) return <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1 text-sm font-medium tabular-nums"><TrendingUp className="w-3.5 h-3.5" />+{formatKRW(diff)}</span>;
  return <span className="text-rose-600 dark:text-rose-400 inline-flex items-center gap-1 text-sm font-medium tabular-nums"><TrendingDown className="w-3.5 h-3.5" />{formatKRW(diff)}</span>;
}
