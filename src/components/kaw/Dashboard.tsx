import { useEffect, useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, MAX_RISK_ASSET_PCT, type AccountId } from "@/lib/kaw/constants";
import {
  usePortfolioStore, formatKRW, getOrDefaultLibrary,
  type AccountState, type AssetDef, type HistoryEntry,
} from "@/lib/kaw/store";
import { computeAccountTotals, cumulativePrincipal } from "@/lib/kaw/cashflow";
import {
  aggregateByDate,
  calculatePerformance,
  type PeriodId, type MetricId, type PeriodPerformance,
  type PerformanceCashflow, type ScopeSelector,
} from "@/lib/kaw/performance";
import { useDailySnapshots } from "@/lib/kaw/useDailySnapshots";
import {
  buildPerformanceTimeline, reconstructionPlan, timelineHasReconstructed,
  type ReconstructionAccountInput,
} from "@/lib/kaw/historical-performance";
import { useHistoricalPriceSeries } from "@/lib/kaw/useHistoricalPrices";
import { kstDateString } from "@/lib/kaw/snapshot";
import { checkSafeAssetValueLimit, requiresSafeAssetMinimum } from "@/lib/kaw/safeAsset";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import { Card } from "@/components/ui/card";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from "recharts";
import {
  ChevronRight, Wifi, WifiOff, RefreshCw,
  AlertTriangle, CheckCircle2, Wallet, CalendarClock, BarChart3, Database,
} from "lucide-react";
import type { Page } from "@/components/kaw/Sidebar";
import { PortfolioBenchmarkSection } from "@/components/kaw/PortfolioBenchmarkChart";
import { ProfitAnalysisSection } from "@/components/kaw/ProfitAnalysisSection";

// ── 종목별 비중 도넛 색상 ─────────────────────────────────────────────────
// 대시보드(구)와 같은 팔레트/배정 원칙을 쓴다: 전체 합산 기준 상위 8개 종목에 색을 고정
// 배정하고, 그 밖은 "기타"로 묶는다 → 계좌 필터를 바꿔도 같은 종목은 항상 같은 색.
const HOLDING_PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const HOLDING_PALETTE_DARK  = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const HOLDING_OTHER_COLOR = "#898781";

// 기간 성과 막대 색 (양수/음수)
const PERF_UP_LIGHT = "#1baf7a", PERF_DOWN_LIGHT = "#e34948";
const PERF_UP_DARK  = "#199e70", PERF_DOWN_DARK  = "#e66767";

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function lastConfirmed(account: AccountState): HistoryEntry | null {
  const sorted = [...account.history].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

interface EtfPosition {
  etfName: string;
  assetId: string;
  value: number;
  /** 실시간 가격으로 평가됐는가 (false = 저장된 스냅샷 평가금액 폴백) */
  live: boolean;
}

// 확정 보유내역 = 마지막 확정 history 의 rowQuantitiesSnap × 현재 KIS 가격.
// 아직 매매하지 않은 liveQuantities / 편집 중인 profileRows 는 쓰지 않는다 (대시보드(구)와 같은 원칙).
// 가격이 없으면 그 행의 저장된 평가금액(rowHoldingsSnap)으로 폴백한다.
function getEtfPositions(
  account: AccountState,
  library: AssetDef[],
  livePrices: Record<string, number>,
): EtfPosition[] {
  const last = lastConfirmed(account);
  if (!last?.rowQuantitiesSnap) return [];
  const byEtf = new Map<string, EtfPosition>();
  for (const [rowId, qty] of Object.entries(last.rowQuantitiesSnap)) {
    if (qty <= 0) continue;
    const etfName = last.rowEtfSnap?.[rowId] ?? rowId;
    const assetId = last.rowAssetSnap?.[rowId] ?? rowId;
    const ticker = library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker ?? "";
    const price = ticker ? (livePrices[ticker] ?? 0) : 0;
    const live = price > 0;
    const value = live ? qty * price : (last.rowHoldingsSnap?.[rowId] ?? 0);
    if (value <= 0) continue;
    const prev = byEtf.get(etfName);
    if (prev) { prev.value += value; prev.live = prev.live && live; }
    else byEtf.set(etfName, { etfName, assetId, value, live });
  }
  return [...byEtf.values()].sort((a, b) => b.value - a.value);
}

interface DonutRow { name: string; value: number; pct: number; fill: string; }

function toDonutData(values: Map<string, number>, colorMap: Map<string, string>): DonutRow[] {
  const total = [...values.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  const rows: { name: string; value: number; fill: string }[] = [];
  let otherSum = 0;
  for (const [name, value] of values) {
    const color = colorMap.get(name);
    if (color) rows.push({ name, value, fill: color });
    else otherSum += value;
  }
  rows.sort((a, b) => b.value - a.value);
  if (otherSum > 0) rows.push({ name: "기타", value: otherSum, fill: HOLDING_OTHER_COLOR });
  return rows.map((r) => ({ ...r, pct: (r.value / total) * 100 }));
}

function DonutTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1 min-w-40">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.payload.fill }} />
        <span className="text-xs font-semibold">{p.payload.name}</span>
      </div>
      <div className="flex justify-between gap-4 text-xs tabular-nums">
        <span className="text-muted-foreground">{formatKRW(p.payload.value)}원</span>
        <span className="font-semibold">{p.payload.pct.toFixed(1)}%</span>
      </div>
    </div>
  );
}

// 기간 성과 막대 툴팁 — 수익률의 근거(기초자산·외부흐름·분모)를 그대로 보여준다.
function PerfTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: PeriodPerformance = payload[0].payload;
  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-xs space-y-1 min-w-56">
      <p className="font-semibold">{p.label}{p.partial ? " (기간 일부)" : ""}</p>
      <p className="text-[11px] text-muted-foreground">{p.fromDate} → {p.toDate}</p>
      <div className="border-t pt-1 space-y-0.5 tabular-nums">
        <div className="flex justify-between gap-3"><span className="text-muted-foreground">기초 총자산</span><span>{formatKRW(p.beginningTotal)}</span></div>
        <div className="flex justify-between gap-3"><span className="text-muted-foreground">기말 총자산</span><span>{formatKRW(p.endingTotal)}</span></div>
        <div className="flex justify-between gap-3"><span className="text-muted-foreground">외부 입출금</span><span>{p.netCashflow >= 0 ? "+" : "-"}{formatKRW(Math.abs(p.netCashflow))}</span></div>
        <div className="flex justify-between gap-3 font-semibold">
          <span>기간 손익</span>
          <span className={p.profit >= 0 ? "text-emerald-500" : "text-rose-500"}>
            {p.profit >= 0 ? "+" : "-"}{formatKRW(Math.abs(p.profit))}
          </span>
        </div>
        <div className="flex justify-between gap-3 font-semibold">
          <span>기간 수익률</span>
          <span className={(p.returnPct ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}>
            {p.returnPct === null ? "—" : `${p.returnPct >= 0 ? "+" : ""}${p.returnPct.toFixed(2)}%`}
          </span>
        </div>
        <div className="flex justify-between gap-3 text-[11px] text-muted-foreground border-t pt-1">
          <span>평균투자원금(분모)</span><span>{formatKRW(p.averageCapital)}</span>
        </div>
      </div>
    </div>
  );
}

function signClass(n: number): string {
  return n >= 0 ? "text-emerald-500" : "text-rose-500";
}
function signed(n: number): string {
  return `${n >= 0 ? "+" : "-"}${formatKRW(Math.abs(n))}`;
}

const fmtAxisAmount = (v: number) => {
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억`;
  if (a >= 10_000) return `${Math.round(v / 10_000)}만`;
  return String(Math.round(v));
};

type ScopeId = "all" | AccountId;
const SCOPES: { id: ScopeId; label: string }[] = [
  { id: "all", label: "전체" },
  ...ACCOUNT_IDS.map((id) => ({ id: id as ScopeId, label: ACCOUNT_LABELS_SHORT[id] })),
];

// 전체 scope 는 **네 계좌 스냅샷이 모두 있는 날짜만** 쓴다(requireAccountIds).
// 한 계좌라도 빠진 날에 point 를 만들면 그 금액만큼 전체 자산이 급락한 것처럼 보인다.
// 계좌별 scope 는 그 계좌 스냅샷만 있으면 계산한다.
function scopeSelector(scope: ScopeId): ScopeSelector {
  return scope === "all"
    ? { requireAccountIds: ACCOUNT_IDS }
    : { accountIds: [scope] };
}

function ScopeTabs({ value, onChange, strong }: { value: ScopeId; onChange: (v: ScopeId) => void; strong?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {SCOPES.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
            value === s.id
              ? strong
                ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-300/60 dark:border-violet-700/60 font-medium"
                : "bg-muted font-medium text-foreground border border-transparent"
              : "text-muted-foreground hover:bg-muted border border-transparent"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function Dashboard({ onNavigate }: { onNavigate?: (p: Page) => void }) {
  const { state, currentUser } = usePortfolioStore();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);
  const { prices: livePrices, meta, configured, isLoading: priceLoading, successCount, totalCount } = useKisPriceContext();
  const isDark = useIsDarkMode();
  const palette = isDark ? HOLDING_PALETTE_DARK : HOLDING_PALETTE_LIGHT;

  const [kpiScope, setKpiScope] = useState<ScopeId>("all");
  const [scope, setScope] = useState<ScopeId>("all");
  const [period, setPeriod] = useState<PeriodId>("monthly");
  const [perfScope, setPerfScope] = useState<ScopeId>("all");
  const [metric, setMetric] = useState<MetricId>("pct");

  const snapshots = useDailySnapshots(!!currentUser);

  // ── 계좌별 집계 ─────────────────────────────────────────────────────────
  // ETF 평가액 = 확정수량 × 현재가, 총자산 = ETF 평가액 + 실제 예수금(cashBalance).
  // 누적 납입원금 = cashflow 장부의 순입금 합계 (cashflow.ts). **예수금을 더하지 않는다** —
  // 예수금은 이미 납입된 돈의 현재 형태일 뿐이라 더하면 이중계산이다.
  // deposit(이번 달 불입액)도 총자산에 더하지 않는다. 장부에 1회 기록될 때만 원금에 반영된다.
  const accounts = useMemo(() => ACCOUNT_IDS.map((id) => {
    const acc = state.accounts[id];
    const positions = getEtfPositions(acc, library, livePrices);
    const etfValue = positions.reduce((s, p) => s + p.value, 0);
    const totals = computeAccountTotals(etfValue, acc.cashBalance, acc.cashflows);
    return {
      id, label: ACCOUNT_LABELS_SHORT[id], account: acc, positions,
      ...totals,
      last: lastConfirmed(acc),
      staleValue: positions.some((p) => !p.live),
    };
  }), [state.accounts, library, livePrices]);

  // scope 에 따른 KPI 값. 전체는 네 계좌 합계 — 원금도 장부 합계를 그대로 더한다.
  const kpi = useMemo(() => {
    const list = kpiScope === "all" ? accounts : accounts.filter((a) => a.id === kpiScope);
    const etfValue = list.reduce((s, a) => s + a.etfValue, 0);
    const cash = list.reduce((s, a) => s + a.cashBalance, 0);
    const cashEntered = list.some((a) => a.cashEntered);
    const totalAsset = etfValue + cash;
    const principal = list.reduce((s, a) => s + cumulativePrincipal(a.account.cashflows), 0);
    const gain = totalAsset - principal;
    return {
      label: kpiScope === "all" ? "전체" : ACCOUNT_LABELS_SHORT[kpiScope],
      etfValue, cash, cashEntered, totalAsset, principal, gain,
      returnPct: principal > 0 ? (gain / principal) * 100 : null,
    };
  }, [kpiScope, accounts]);

  // ── Section C: 자산 구성 (계좌 필터) ────────────────────────────────────
  const combinedEtfValues = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts) for (const p of a.positions) m.set(p.etfName, (m.get(p.etfName) ?? 0) + p.value);
    return m;
  }, [accounts]);

  const etfColorMap = useMemo(() => {
    const ranked = [...combinedEtfValues.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const map = new Map<string, string>();
    ranked.slice(0, palette.length).forEach((name, i) => map.set(name, palette[i]));
    return map;
  }, [combinedEtfValues, palette]);

  const scopedEtfValues = useMemo(() => {
    if (scope === "all") return combinedEtfValues;
    const m = new Map<string, number>();
    const a = accounts.find((x) => x.id === scope);
    for (const p of a?.positions ?? []) m.set(p.etfName, (m.get(p.etfName) ?? 0) + p.value);
    return m;
  }, [scope, accounts, combinedEtfValues]);

  const donutData = useMemo(() => toDonutData(scopedEtfValues, etfColorMap), [scopedEtfValues, etfColorMap]);
  const donutTotal = donutData.reduce((s, r) => s + r.value, 0);
  const scopedCash = scope === "all"
    ? accounts.reduce((s, a) => s + a.cashBalance, 0)
    : (accounts.find((a) => a.id === scope)?.cashBalance ?? 0);
  const scopedCashEntered = scope === "all"
    ? accounts.some((a) => a.cashEntered)
    : (accounts.find((a) => a.id === scope)?.cashEntered ?? false);

  // Section D(수익 분석)의 계산은 ProfitAnalysisSection 안에서 한다 —
  // 원장 replay + OHLC + 유도 예수금을 쓰므로 입력이 이 화면의 나머지와 다르다.
  // 기존 `performance.ts` / `historical-performance.ts` 경로는 지우지 않았고
  // 계좌 화면·지수비교가 계속 쓴다.

  // ── Section E: 포트폴리오 상태 ──────────────────────────────────────────
  // 새 판정 기준을 만들지 않는다 — 기존 checkSafeAssetValueLimit / 예수금 입력여부 /
  // KIS 가격 메타데이터만 읽어서 "확인이 필요한 항목"으로 모아 보여준다.
  const issues = useMemo(() => {
    const out: { key: string; tone: "warn" | "info"; title: string; detail: string; page?: Page }[] = [];

    for (const a of accounts) {
      if (!requiresSafeAssetMinimum(a.id)) continue;
      if (a.positions.length === 0) continue;
      const check = checkSafeAssetValueLimit(
        a.id,
        a.positions.map((p) => ({ assetId: p.assetId, etfName: p.etfName, value: p.value })),
        a.account.cashBalance,
        library,
      );
      if (check.exceeded) {
        out.push({
          key: `risk-${a.id}`, tone: "warn",
          title: `${a.label} 위험자산 ${check.riskPct.toFixed(1)}% (한도 ${MAX_RISK_ASSET_PCT}%)`,
          detail: check.estimated
            ? "예수금 미입력 상태의 임시 계산입니다. 예수금을 입력하면 비중이 달라질 수 있습니다."
            : `비위험자산 ${check.safePct.toFixed(1)}%. 추가 매수가 제한될 수 있습니다.`,
          page: a.id as Page,
        });
      }
    }

    for (const a of accounts) {
      if (a.cashEntered) continue;
      if (a.positions.length === 0) continue;
      out.push({
        key: `cash-${a.id}`, tone: "info",
        title: `${a.label} 예수금 미입력`,
        detail: "총자산에 예수금이 0원으로 계산됩니다. 계좌 화면에서 실제 현금잔액을 입력하세요.",
        page: a.id as Page,
      });
    }

    if (!configured) {
      out.push({
        key: "kis-unconfigured", tone: "warn",
        title: "KIS API 미설정",
        detail: "실시간 주가를 조회할 수 없어 저장된 평가금액으로 표시합니다.",
      });
    } else {
      const failed = Object.entries(meta).filter(([, m]) => m.source === "failed").map(([t]) => t);
      const naver  = Object.entries(meta).filter(([, m]) => m.source === "naver").map(([t]) => t);
      if (failed.length > 0) {
        out.push({
          key: "kis-failed", tone: "warn",
          title: `실시간 주가 조회 실패 ${failed.length}건`,
          detail: `${failed.join(", ")} — 해당 종목은 저장된 평가금액으로 표시합니다.`,
        });
      }
      if (naver.length > 0) {
        out.push({
          key: "kis-naver", tone: "info",
          title: `네이버 시세로 대체 ${naver.length}건`,
          detail: `${naver.join(", ")} — KIS 조회가 실패해 네이버 종가를 사용했습니다.`,
        });
      }
    }

    const stale = accounts.filter((a) => a.staleValue);
    if (stale.length > 0) {
      out.push({
        key: "stale-value", tone: "info",
        title: "일부 종목은 저장된 평가금액 기준",
        detail: `${stale.map((a) => a.label).join(", ")} — 종목코드가 없거나 가격 조회가 안 된 종목이 있습니다.`,
      });
    }

    return out;
  }, [accounts, library, meta, configured]);

  const isLiveActive = configured && Object.keys(livePrices).length > 0;
  const perfUp = isDark ? PERF_UP_DARK : PERF_UP_LIGHT;
  const perfDown = isDark ? PERF_DOWN_DARK : PERF_DOWN_LIGHT;

  return (
    <div className="p-4 md:p-6 space-y-5 md:space-y-6 max-w-5xl mx-auto">

      {/* ── 헤더 + 실시간 가격 status ─────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">대시보드</h2>
          <p className="text-sm text-muted-foreground mt-1">전체 포트폴리오 현황</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 mt-1.5 text-xs text-muted-foreground">
          {priceLoading && successCount === 0 ? (
            <><RefreshCw className="w-3.5 h-3.5 animate-spin text-violet-400" /><span>주가 로딩 중…</span></>
          ) : !configured ? (
            <><WifiOff className="w-3.5 h-3.5 text-rose-500" /><span className="text-rose-500">KIS 미설정</span></>
          ) : (
            <><Wifi className={`w-3.5 h-3.5 ${successCount === totalCount ? "text-emerald-500" : "text-amber-500"}`} />
              <span className={successCount === totalCount ? "" : "text-amber-500"}>실시간 {successCount}/{totalCount}</span></>
          )}
        </div>
      </div>

      {/* ── Section A: scope 탭 + KPI 4개 ─────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ScopeTabs value={kpiScope} onChange={setKpiScope} strong />
          {kpiScope !== "all" && onNavigate && (
            <button
              onClick={() => onNavigate(kpiScope as Page)}
              className="flex items-center gap-0.5 text-xs text-violet-600 dark:text-violet-300 hover:underline shrink-0"
            >
              <span className="whitespace-nowrap">리밸런싱</span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card
            className={`p-4 space-y-1 ${kpiScope !== "all" && onNavigate ? "cursor-pointer transition-all hover:border-violet-400/60 hover:shadow-md" : ""}`}
            onClick={kpiScope !== "all" && onNavigate ? () => onNavigate(kpiScope as Page) : undefined}
          >
            <p className="text-xs text-muted-foreground">총자산</p>
            <p className="text-xl md:text-2xl font-bold tabular-nums leading-tight">{formatKRW(kpi.totalAsset)}</p>
            {/* 모바일에서 금액만 다음 줄로 밀리지 않도록 항목별로 한 줄씩 둔다 */}
            <div className="pt-1.5 border-t space-y-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">ETF</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{formatKRW(kpi.etfValue)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">예수금</span>
                <span className={`text-[11px] tabular-nums ${kpi.cashEntered ? "text-blue-600 dark:text-blue-400" : "text-amber-500"}`}>
                  {kpi.cashEntered ? formatKRW(kpi.cash) : "미입력"}
                </span>
              </div>
            </div>
          </Card>

          <Card className="p-4 space-y-1">
            <p className="text-xs text-muted-foreground">누적 납입원금</p>
            <p className="text-xl md:text-2xl font-bold tabular-nums leading-tight">{formatKRW(kpi.principal)}</p>
            <p className="text-[11px] text-muted-foreground">외부 입금 − 출금 누계</p>
          </Card>

          <Card className="p-4 space-y-1">
            <p className="text-xs text-muted-foreground">누적 손익</p>
            <p className={`text-xl md:text-2xl font-bold tabular-nums leading-tight ${kpi.principal > 0 ? signClass(kpi.gain) : ""}`}>
              {kpi.principal > 0 ? signed(kpi.gain) : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">총자산 − 납입원금</p>
          </Card>

          <Card className="p-4 space-y-1">
            <p className="text-xs text-muted-foreground">누적 수익률</p>
            <p className={`text-xl md:text-2xl font-bold tabular-nums leading-tight ${kpi.returnPct !== null ? signClass(kpi.returnPct) : ""}`}>
              {kpi.returnPct !== null
                ? `${kpi.returnPct >= 0 ? "+" : ""}${kpi.returnPct.toFixed(2)}%`
                : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {isLiveActive ? "현재 시점" : "저장된 평가금액 기준"}
            </p>
          </Card>
        </div>
      </div>

      {/* ── Section B: 내 포트폴리오 vs 시장 ──────────────────────────── */}
      {/* 지수비교 전체화면과 같은 공용 컴포넌트를 compact 표현으로 쓴다 */}
      <PortfolioBenchmarkSection />

      {/* ── Section C: 자산 구성 ──────────────────────────────────────── */}
      <Card className="p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">자산 구성</h3>
          <ScopeTabs value={scope} onChange={setScope} strong />
        </div>

        {donutData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            확정된 보유내역이 없습니다. 계좌 화면에서 리밸런싱을 저장하면 여기에 표시됩니다.
          </p>
        ) : (
          <div className="grid md:grid-cols-[200px_1fr] gap-4 items-center">
            <div className="h-44 relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="92%" strokeWidth={0}>
                    {donutData.map((r) => <Cell key={r.name} fill={r.fill} />)}
                  </Pie>
                  <Tooltip content={<DonutTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 grid place-items-center pointer-events-none">
                <div className="text-center">
                  <p className="text-[10px] text-muted-foreground">ETF 평가액</p>
                  <p className="text-xs font-bold tabular-nums">{formatKRW(donutTotal)}</p>
                </div>
              </div>
            </div>
            <div className="space-y-1">
              {donutData.map((r) => (
                <div key={r.name} className="flex items-center gap-2 text-xs">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.fill }} />
                  <span className="truncate flex-1 min-w-0">{r.name}</span>
                  <span className="tabular-nums text-muted-foreground shrink-0">{formatKRW(r.value)}</span>
                  <span className="tabular-nums font-semibold w-12 text-right shrink-0">{r.pct.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-3 border-t flex items-center gap-1.5 text-xs">
          <Wallet className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          <span className="text-muted-foreground">예수금</span>
          <span className={`tabular-nums font-medium ml-auto ${scopedCashEntered ? "text-blue-600 dark:text-blue-400" : "text-amber-500"}`}>
            {scopedCashEntered ? `${formatKRW(scopedCash)}원` : "미입력"}
          </span>
        </div>
      </Card>

      {/* ── Section D: 수익 분석 (구 "기간 성과") ───────────────────────
          보유수량 source: 전략시작~각 계좌 ledger cutoff = Transaction Ledger replay,
          cutoff~오늘 = 기존 rowQuantitiesSnap anchor. 평가는 전 구간 동일 OHLC 엔진.
          계산은 profit-analysis.ts 순수 모듈이 한다. */}
      <ProfitAnalysisSection />

      {/* ── Section E: 포트폴리오 상태 ────────────────────────────────── */}
      <Card className="p-4 md:p-5 space-y-3">
        <h3 className="text-sm font-semibold">포트폴리오 상태</h3>
        {issues.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            현재 확인이 필요한 항목이 없습니다
          </div>
        ) : (
          <div className="space-y-2">
            {issues.map((it) => (
              <div
                key={it.key}
                onClick={it.page && onNavigate ? () => onNavigate(it.page!) : undefined}
                className={`rounded-xl border px-3 py-2.5 flex items-start gap-2 ${
                  it.tone === "warn"
                    ? "border-amber-300/60 dark:border-amber-800/60 bg-amber-500/5"
                    : "border-border bg-muted/30"
                } ${it.page && onNavigate ? "cursor-pointer hover:border-violet-400/60" : ""}`}
              >
                <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${it.tone === "warn" ? "text-amber-500" : "text-muted-foreground"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold">{it.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{it.detail}</p>
                </div>
                {it.page && onNavigate && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0 mt-0.5" />}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
