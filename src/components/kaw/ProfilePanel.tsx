import { PROFILE_LABELS, ASSET_ORDER, ASSET_GROUPS, GROUP_COLORS, type ProfileKey } from "@/lib/kaw/constants";
import { usePortfolioStore } from "@/lib/kaw/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { RotateCcw } from "lucide-react";

export function ProfilePanel() {
  const { state, setProfile, setAllocation, resetAllocation } = usePortfolioStore();
  const profile = state.profile;
  const alloc = state.allocations[profile];
  const total = ASSET_ORDER.reduce((s, k) => s + (alloc[k] || 0), 0);

  const chartData = ASSET_ORDER
    .filter((k) => alloc[k] > 0)
    .map((k) => ({ name: ASSET_GROUPS[k].label, value: alloc[k], group: ASSET_GROUPS[k].group }));

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">투자 성향</h2>
          <p className="text-sm text-muted-foreground">자산 비중 프리셋 (수정 가능)</p>
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {(Object.keys(PROFILE_LABELS) as ProfileKey[]).map((p) => (
            <button
              key={p}
              onClick={() => setProfile(p)}
              className={`px-3 py-1.5 text-sm rounded-md transition ${
                profile === p ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {PROFILE_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-1.5">
          {ASSET_ORDER.map((k) => (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full" style={{ background: GROUP_COLORS[ASSET_GROUPS[k].group] }} />
              <span className="flex-1 truncate">{ASSET_GROUPS[k].label}</span>
              <Input
                type="number"
                step="0.5"
                value={alloc[k]}
                onChange={(e) => setAllocation(profile, k, parseFloat(e.target.value) || 0)}
                className="w-20 h-8 text-right"
              />
              <span className="text-muted-foreground w-4">%</span>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 border-t mt-2">
            <span className={`text-sm font-medium ${Math.abs(total - 100) > 0.01 ? "text-destructive" : ""}`}>
              합계: {total.toFixed(1)}%
            </span>
            <Button variant="ghost" size="sm" onClick={() => resetAllocation(profile)}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> 기본값
            </Button>
          </div>
        </div>

        <div className="h-64">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={GROUP_COLORS[d.group]} fillOpacity={0.65 + (i % 3) * 0.12} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => `${v}%`}
                contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
