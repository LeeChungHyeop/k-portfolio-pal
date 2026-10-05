import { useMemo, useState } from "react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, ASSET_ORDER, type AccountId } from "@/lib/kaw/constants";
import { usePortfolioStore, getOrDefaultLibrary, BUILTIN_TICKERS, type HistoryEntry } from "@/lib/kaw/store";
import { useKisPriceContext } from "@/lib/kaw/KisPriceContext";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { RefreshCw } from "lucide-react";
import {
  useEnsureGrowthBacktest, SAFE_MIX_SP500_TICKER, SAFE_MIX_ACCOUNTS, SAFE_MIX_WEIGHT,
  accountUsesSafeAssetMix, cashflowFingerprint, currentBacktestOf, hasStaleBacktest,
} from "@/lib/kaw/backtest";
import {
  cumulativePrincipal, investedPrincipalAsOf, principalAsOf, type CashflowEntry,
} from "@/lib/kaw/cashflow";
import {
  RETIREMENT_DB_BENCHMARK, dbBenchmarkLabel, dbBenchmarkSortDate,
} from "@/lib/kaw/retirement-db-benchmark";

// 안전자산 30% 혼합 대상 계좌와 비중은 backtest.ts 가 유일한 정의다 — 저장된 스냅샷과 화면이
// 어긋나지 않도록 여기서 따로 정의하지 않고 그대로 가져다 쓴다.

const fmtAxis = (v: number) =>
  v >= 100_000_000 ? `${(v / 100_000_000).toFixed(1)}억` : `${Math.round(v / 10_000)}만`;

const COLOR_ACTUAL = "oklch(0.62 0.18 250)";
const COLOR_GROWTH = "oklch(0.72 0.17 80)";
const COLOR_KOSPI = "oklch(0.62 0.20 20)";
const COLOR_SP500 = "oklch(0.55 0.16 300)";
// DB 유지 가정 — 투자 비교선이 아니라 "안 바꿨다면" 기준선이라 중립적인 회색 계열로 둔다.
const COLOR_DB = "oklch(0.58 0.03 260)";

/** 금액 비교 차트의 한 시점. 같은 시점에 없는 series 는 null 이고, **보간하지 않는다.** */
export interface BenchmarkPoint {
  label: string; // x축 표시 (YYYY.MM 또는 "현재")
  date: string; // 그 포인트의 실제 일자 (YYYY-MM-DD) 또는 "현재"
  sortDate: string; // 정렬 전용
  actualValue: number | null;
  actualPct: number | null;
  growthValue: number | null;
  growthPct: number | null;
  kospiValue: number | null;
  kospiPct: number | null;
  sp500Value: number | null;
  sp500Pct: number | null;
  /** 퇴직연금 전용 — DB 유지 가정 예상 퇴직급여 (투자 수익률 개념이 없어 % 가 없다) */
  dbValue: number | null;
}

const SERIES = [
  { valueKey: "actualValue", pctKey: "actualPct", name: "실제(커스텀)", color: COLOR_ACTUAL },
  { valueKey: "growthValue", pctKey: "growthPct", name: "케이올웨더 성장형", color: COLOR_GROWTH },
  { valueKey: "kospiValue", pctKey: "kospiPct", name: "KOSPI200 비교", color: COLOR_KOSPI },
  { valueKey: "sp500Value", pctKey: "sp500Pct", name: "S&P500 비교", color: COLOR_SP500 },
] as const;

const DB_SERIES_NAME = "DB 유지 가정";

const fmtWon = (v: number) => `${Math.round(v).toLocaleString()}원`;
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtSignedWon = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(Math.round(v)).toLocaleString()}원`;

// recharts 기본 Tooltip은 배경이 흰색 고정인데 글자색은 테마를 물려받아서 다크모드에서
// 흰 배경에 흰 글씨가 된다. 또 payload 순서/null 처리를 직접 제어해야 해서(해당 시점에
// 존재하는 series 만 보여준다) payload[0].payload 의 행을 직접 읽어 렌더한다.
function BenchmarkTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as BenchmarkPoint | undefined;
  if (!row) return null;

  const rows = SERIES.map((s) => ({
    name: s.name,
    color: s.color,
    value: row[s.valueKey] as number | null,
    pct: row[s.pctKey] as number | null,
  })).filter((r) => r.value !== null);

  // "DC 대비" 는 DB 유지 가정 항목 아래에 붙는 줄이다 — 기준은 DB 쪽이다.
  // (+) DB 유지가 실제 DC 보다 크다 / (−) DB 유지가 더 작다.
  const dbDiff = row.dbValue !== null && row.actualValue !== null ? row.dbValue - row.actualValue : null;

  if (!rows.length && row.dbValue === null) return null;

  return (
    <div className="rounded-xl border bg-popover p-3 shadow-md text-sm space-y-1.5 min-w-48">
      <p className="font-semibold text-xs text-muted-foreground">{row.label}</p>
      {rows.map((r) => (
        <div key={r.name} className="space-y-0.5">
          <div className="flex justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.color }} />
              <span className="text-xs">{r.name}</span>
            </span>
            <span className="tabular-nums text-xs font-medium">{fmtWon(r.value!)}</span>
          </div>
          {r.pct !== null && (
            <div className="flex justify-between gap-4 pl-3.5">
              <span className="text-[11px] text-muted-foreground">누적수익률</span>
              <span
                className={`tabular-nums text-[11px] font-medium ${r.pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}
              >
                {fmtPct(r.pct)}
              </span>
            </div>
          )}
        </div>
      ))}
      {row.dbValue !== null && (
        <div className="space-y-0.5 pt-1 border-t">
          <div className="flex justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLOR_DB }} />
              <span className="text-xs">{DB_SERIES_NAME}</span>
            </span>
            <span className="tabular-nums text-xs font-medium">{fmtWon(row.dbValue)}</span>
          </div>
          <p className="pl-3.5 text-[11px] text-muted-foreground">DB 예상 퇴직급여 (추정)</p>
          {dbDiff !== null && (
            <div className="flex justify-between gap-4 pl-3.5">
              <span className="text-[11px] text-muted-foreground">DC 대비</span>
              <span
                className={`tabular-nums text-[11px] font-medium ${dbDiff >= 0 ? "text-emerald-600" : "text-rose-600"}`}
              >
                {fmtSignedWon(dbDiff)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function emptyPoint(label: string, date: string, sortDate: string): BenchmarkPoint {
  return {
    label, date, sortDate,
    actualValue: null, actualPct: null,
    growthValue: null, growthPct: null,
    kospiValue: null, kospiPct: null,
    sp500Value: null, sp500Pct: null,
    dbValue: null,
  };
}

// 기존 대시보드의 "전체자산추이"와 동일한 규칙: 월별 최신 리밸런싱 시점 하나만 채택.
// 성장형/지수 금액은 리밸런싱 시점에 미리 계산해 h.backtestGrowth로 저장돼 있으므로 그대로 읽기만 한다.
export function buildBenchmarkPoints(
  history: HistoryEntry[],
  cashflows: readonly CashflowEntry[] | undefined,
  cashflowKey: string,
): BenchmarkPoint[] {
  if (!history.length) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  const latestDateByMonth = new Map<string, string>();
  sorted.forEach((h) => {
    const month = h.date.slice(0, 7);
    const existing = latestDateByMonth.get(month);
    if (!existing || h.date > existing) latestDateByMonth.set(month, h.date);
  });

  // 누적 납입원금은 cashflow 장부가 유일한 근거다 (history.deposit 은 리밸런싱 기록의 메모일 뿐
  // 리밸런싱 사이의 입출금을 담지 못한다). 장부가 아직 없는 데이터만 기존 조각으로 폴백한다.
  const cumDepositByDate = new Map<string, number>();
  if (cashflows?.length) {
    sorted.forEach((h) => cumDepositByDate.set(h.date, principalAsOf(cashflows, h.date)));
  } else {
    let cumDeposit = 0;
    sorted.forEach((h, i) => {
      cumDeposit += i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0);
      cumDepositByDate.set(h.date, cumDeposit);
    });
  }

  return [...latestDateByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, date]) => {
      const h = sorted.find((x) => x.date === date)!;
      const cd = cumDepositByDate.get(date) ?? 0;
      // 실제 총자산 = 그 시점 ETF 평가액 + 그 시점 예수금. 예수금을 빼면 리밸런싱 후 남은 현금이
      // 사라져 실제 수익률이 원금 대비 과소 표시된다(예수금이 없던 옛 기록은 0으로 계산).
      const actualValue = h.totalValue + (h.cashBalance ?? 0);
      const actualPct = cd > 0 ? Math.round(((actualValue - cd) / cd) * 10000) / 100 : null;
      // **stale(옛 schemaVersion / 옛 장부 지문) 저장값은 쓰지 않는다** — 오염된 옛 값이
      // 차트에 그려지면 실제와 전혀 다른 수치가 사실처럼 보인다. 재계산되면 채워진다.
      const bt = currentBacktestOf(h.backtestGrowth, cashflowKey);
      return {
        ...emptyPoint(month.replace("-", "."), date, date),
        actualValue,
        actualPct,
        growthValue: bt ? bt.totalValue : null,
        growthPct: bt?.returnPct ?? null,
        // 지수 비교선 금액은 v6 에서 저장되기 시작한 **정확한 값**만 쓴다.
        // 반올림된 kospi200Pct 에서 금액을 역산하지 않는다.
        kospiValue: bt?.kospi200Value ?? null,
        kospiPct: bt?.kospi200Pct ?? null,
        sp500Value: bt?.sp500Value ?? null,
        sp500Pct: bt?.sp500Pct ?? null,
      };
    });
}

// 실시간 주가로 "현재" 시점 비교 포인트를 만든다.
// 실제(커스텀)는 "마지막으로 저장된 리밸런싱 기록(실제 확정된 보유내역)" × 실시간가로 평가한다 — profileRows/liveQuantities(다음
// 리밸런싱을 위해 자유롭게 편집 중인 계획)를 쓰면, 다음 리밸런싱 준비 중 종목을 지우기만 해도 아직 안 판 것까지 사라져 보이는 문제가 있었음.
// 성장형·코스피200·S&P500은 각각 마지막 리밸런싱 시점 보유 유닛 × 실시간가로 평가한다.
export function buildLivePoint(
  history: HistoryEntry[],
  library: ReturnType<typeof getOrDefaultLibrary>,
  livePrices: Record<string, number>,
  safeAssetMix: boolean,
  cashBalance: number | undefined,
  cashflows: readonly CashflowEntry[] | undefined,
  cashflowKey: string,
): BenchmarkPoint | null {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  // stale 저장값으로는 "현재" 포인트도 만들지 않는다 (보유 유닛이 오염돼 있다).
  const lastBt = currentBacktestOf(last.backtestGrowth, cashflowKey);
  if (!lastBt) return null;

  const qtySnap = last.rowQuantitiesSnap;
  const etfSnap = last.rowEtfSnap;
  const etf실제 = qtySnap && etfSnap
    ? Object.entries(qtySnap).reduce((sum, [rowId, qty]) => {
        const etfName = etfSnap[rowId];
        const ticker = etfName ? (library.find((d) => d.defaultEtf === etfName && d.ticker)?.ticker ?? "") : "";
        const price = ticker ? (livePrices[ticker] ?? 0) : 0;
        return sum + qty * price;
      }, 0)
    : 0;
  // 실제 총자산 = 실시간 ETF 평가액 + 실제 예수금 (CLAUDE.md 도메인 규칙). 예수금을 빼면
  // 아직 매수하지 않은 돈이 손실로 보인다.
  const 실제자산 = etf실제 + (cashBalance ?? 0);

  const units = lastBt.units;
  const 성장형자산 = ASSET_ORDER.reduce((sum, key) => {
    const ticker = BUILTIN_TICKERS[key];
    const price = ticker ? (livePrices[ticker] ?? 0) : 0;
    return sum + (units[key] ?? 0) * price;
  }, 0);

  const krTicker = BUILTIN_TICKERS.kr;
  const usTicker = BUILTIN_TICKERS.us;
  const ktb30Ticker = BUILTIN_TICKERS.ktb30;
  let 코스피자산 = (lastBt.kospiUnits ?? 0) * (krTicker ? (livePrices[krTicker] ?? 0) : 0);
  let 에스피자산 = (lastBt.sp500Units ?? 0) * (usTicker ? (livePrices[usTicker] ?? 0) : 0);
  // 퇴직연금/IRP — 안전자산 30% 다리(국고채30년 / ACE 미국S&P500미국채혼합50액티브)도 실시간가로 더한다
  if (safeAssetMix) {
    코스피자산 += (lastBt.kospiSafeUnits ?? 0) * (ktb30Ticker ? (livePrices[ktb30Ticker] ?? 0) : 0);
    에스피자산 += (lastBt.sp500SafeUnits ?? 0) * (livePrices[SAFE_MIX_SP500_TICKER] ?? 0);
  }

  if (etf실제 <= 0 || 성장형자산 <= 0) return null;

  // 누적 납입원금 = 장부 전체 순입금. 장부가 없는 옛 데이터만 기존 조각으로 폴백한다.
  let cumDeposit: number;
  let 미투자 = 0; // 마지막 리밸런싱 이후 들어와 아직 투자되지 않은 돈
  if (cashflows?.length) {
    cumDeposit = cumulativePrincipal(cashflows);
    // 비교선(성장형/지수)은 **마지막 리밸런싱 시점에 투자 가능했던 돈까지만** 투자해 둔 상태다.
    // 그 뒤에 들어온 입금과, 같은 날짜의 장마감 후 입금(after_close — 그 날 장중에 못 산다)은
    // 원금에는 들어가므로 비교선에도 "아직 예수금으로 들고 있는 돈"으로 더해, 실제 쪽
    // (예수금 포함)과 같은 기준으로 비교한다.
    미투자 = cumDeposit - investedPrincipalAsOf(cashflows, last.date);
  } else {
    cumDeposit = sorted.reduce((sum, h, i) => sum + (i === 0 ? h.baseAmount : Math.max(0, h.deposit ?? 0)), 0);
  }
  const pctVs = (value: number) =>
    cumDeposit > 0 && value > 0 ? Math.round(((value - cumDeposit) / cumDeposit) * 10000) / 100 : null;

  return {
    ...emptyPoint("현재", "현재", "9999-12-31"),
    actualValue: 실제자산,
    actualPct: pctVs(실제자산),
    growthValue: 성장형자산 + 미투자,
    growthPct: pctVs(성장형자산 + 미투자),
    kospiValue: 코스피자산 + 미투자,
    kospiPct: pctVs(코스피자산 + 미투자),
    sp500Value: 에스피자산 + 미투자,
    sp500Pct: pctVs(에스피자산 + 미투자),
  };
}

/**
 * DB 유지 가정선을 퇴직연금 행에 합친다.
 *
 * DB 추정치는 2025-03 부터 시작하고 투자 기록은 그보다 늦게 시작할 수 있어, **두 쪽의 월을
 * 합집합**으로 둔다. DB 만 있는 달에는 투자 쪽 값을 만들어 넣지 않는다(보간 금지) —
 * 그 달 행은 dbValue 만 있는 행이고, Line 의 connectNulls 가 각 series 자신의 실제 point 만 잇는다.
 */
export function withDbBenchmark(rows: BenchmarkPoint[]): BenchmarkPoint[] {
  const byLabel = new Map<string, BenchmarkPoint>();
  rows.forEach((r) => byLabel.set(r.label, { ...r }));

  RETIREMENT_DB_BENCHMARK.forEach((p) => {
    const label = dbBenchmarkLabel(p.month);
    const sortDate = dbBenchmarkSortDate(p);
    const existing = byLabel.get(label);
    if (existing) existing.dbValue = p.value;
    else byLabel.set(label, { ...emptyPoint(label, sortDate, sortDate), dbValue: p.value });
  });

  return [...byLabel.values()].sort((a, b) => a.sortDate.localeCompare(b.sortDate));
}

export type BenchmarkPresentation = "compact" | "full";

/**
 * "내 포트폴리오 vs 시장" 금액 비교 차트. 대시보드 섹션(compact)과 지수비교 전체화면(full)이
 * **같은 계산·같은 hook** 을 쓰도록 이 컴포넌트 하나만 둔다 — 중복 계산을 만들지 않는다.
 */
export function PortfolioBenchmarkChart({
  presentation = "full",
}: { presentation?: BenchmarkPresentation } = {}) {
  const { state, setHistoryBacktest } = usePortfolioStore();
  const [tab, setTab] = useState<AccountId>("retirement");
  const { prices: livePrices, configured } = useKisPriceContext();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);
  const compact = presentation === "compact";

  // 계좌별로 backtestGrowth가 없는 히스토리가 있으면 (신규 계좌 또는 최초 1회) 조용히 계산해서 저장.
  // 퇴직연금/IRP는 safeAssetMix=true로 코스피200/S&P500 비교선에 안전자산 30%를 섞어 계산한다.
  // **보고 있는 탭만 계산한다.** hook 은 React 규칙대로 4개 모두 항상 호출하되, enabled 로
  // 네트워크 요청을 막는다 — mount 하자마자 4계좌 × history 날짜 전부를 동시에 조회하면
  // 네이버 과거 종가 호출이 폭주해 실패하고(그 결과가 fail-closed 로 전부 버려진다) 느리다.
  const retirementSync = useEnsureGrowthBacktest(
    state.accounts.retirement.history, (r) => setHistoryBacktest("retirement", r),
    {
      cashflows: state.accounts.retirement.cashflows,
      safeAssetMix: accountUsesSafeAssetMix("retirement"),
      label: ACCOUNT_LABELS_SHORT.retirement,
      enabled: tab === "retirement",
    },
  );
  const isaSync = useEnsureGrowthBacktest(
    state.accounts.isa.history, (r) => setHistoryBacktest("isa", r),
    {
      cashflows: state.accounts.isa.cashflows,
      safeAssetMix: accountUsesSafeAssetMix("isa"),
      label: ACCOUNT_LABELS_SHORT.isa,
      enabled: tab === "isa",
    },
  );
  const pensionSync = useEnsureGrowthBacktest(
    state.accounts.pension.history, (r) => setHistoryBacktest("pension", r),
    {
      cashflows: state.accounts.pension.cashflows,
      safeAssetMix: accountUsesSafeAssetMix("pension"),
      label: ACCOUNT_LABELS_SHORT.pension,
      enabled: tab === "pension",
    },
  );
  const irpSync = useEnsureGrowthBacktest(
    state.accounts.irp.history, (r) => setHistoryBacktest("irp", r),
    {
      cashflows: state.accounts.irp.cashflows,
      safeAssetMix: accountUsesSafeAssetMix("irp"),
      label: ACCOUNT_LABELS_SHORT.irp,
      enabled: tab === "irp",
    },
  );
  const syncByAccount: Record<AccountId, { syncing: boolean; error: boolean }> = {
    retirement: retirementSync,
    isa: isaSync,
    pension: pensionSync,
    irp: irpSync,
  };

  // 계좌별 "지금 그려도 되는 데이터인가" — syncing 같은 비동기 상태가 아니라 저장값 자체를
  // 동기적으로 판정하므로, 첫 render 에서도 오염된 옛 값이 한 프레임 보이지 않는다.
  const staleByAccount = useMemo(() => {
    const out = {} as Record<AccountId, boolean>;
    ACCOUNT_IDS.forEach((id) => {
      const acc = state.accounts[id];
      out[id] = acc.history.length > 0
        && hasStaleBacktest(acc.history, cashflowFingerprint(acc.cashflows));
    });
    return out;
  }, [state]);

  const dataByAccount = useMemo(() => {
    const out = {} as Record<AccountId, BenchmarkPoint[]>;
    ACCOUNT_IDS.forEach((id) => {
      const account = state.accounts[id];
      const cashflowKey = cashflowFingerprint(account.cashflows);
      const points = buildBenchmarkPoints(account.history, account.cashflows, cashflowKey);
      const livePoint = configured
        ? buildLivePoint(
            account.history, library, livePrices, accountUsesSafeAssetMix(id),
            account.cashBalance, account.cashflows, cashflowKey,
          )
        : null;
      const merged = livePoint ? [...points, livePoint] : points;
      // DB 유지 가정선은 퇴직연금에만 붙인다 (DB→DC 전환이 있었던 계좌).
      out[id] = id === "retirement" ? withDbBenchmark(merged) : merged;
    });
    return out;
  }, [state, library, livePrices, configured]);

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as AccountId)}>
      <TabsList>
        {ACCOUNT_IDS.map((id) => (
          <TabsTrigger key={id} value={id}>
            {ACCOUNT_LABELS_SHORT[id]}
          </TabsTrigger>
        ))}
      </TabsList>
      {SAFE_MIX_ACCOUNTS.includes(tab) && (
        <p className="text-[11px] md:text-xs text-muted-foreground mt-1.5">
          * {ACCOUNT_LABELS_SHORT[tab]}은 법상 안전자산 {SAFE_MIX_WEIGHT * 100}% 이상 편입 의무가 있어,
          KOSPI200/S&P500 비교선은 지수 {100 - SAFE_MIX_WEIGHT * 100}% + 안전자산 {SAFE_MIX_WEIGHT * 100}%
          (각각 국고채30년 / ACE 미국S&P500미국채혼합50액티브) 기준으로 계산돼.
        </p>
      )}
      {tab === "retirement" && (
        <p className="text-[11px] md:text-xs text-muted-foreground mt-1">
          * DB 유지 가정선은 2025.03.25 DB→DC 전환 시점 산정액 이후를 급여 기준으로 추정한
          값이야(투자 성과가 아니라 수익률을 붙이지 않아).
        </p>
      )}

      {ACCOUNT_IDS.map((id) => {
        const rows = dataByAccount[id];
        // 저장값이 stale 이면 차트를 아예 그리지 않는다 — 계산 중이면 spinner, 실패면 에러 문구.
        const stale = staleByAccount[id];
        const showCharts = !stale && dataByAccount[id].length >= 1;

        return (
          <TabsContent key={id} value={id} className={compact ? "space-y-3 mt-3" : "space-y-6 mt-4"}>
            {stale && !syncByAccount[id].error && (
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

            {showCharts && (
              <div className={compact ? "h-64" : "h-80"}>
                <ResponsiveContainer>
                  <LineChart data={rows} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={48} domain={["auto", "auto"]} />
                    {/* 모바일 touch/drag 툴팁은 recharts 기본 interaction 을 그대로 쓴다 */}
                    <Tooltip content={<BenchmarkTooltip />} />
                    <Legend wrapperStyle={{ fontSize: compact ? 10 : 12 }} />
                    {SERIES.map((s) => (
                      <Line
                        key={s.valueKey}
                        type="monotone"
                        dataKey={s.valueKey}
                        name={s.name}
                        stroke={s.color}
                        strokeWidth={s.valueKey === "actualValue" ? 2.2 : 1.8}
                        dot={false}
                        activeDot={{ r: 4 }}
                        connectNulls
                      />
                    ))}
                    {/* DB 유지 가정은 퇴직연금에만 */}
                    {id === "retirement" && (
                      <Line
                        type="monotone"
                        dataKey="dbValue"
                        name={DB_SERIES_NAME}
                        stroke={COLOR_DB}
                        strokeWidth={1.8}
                        strokeDasharray="5 3"
                        dot={false}
                        activeDot={{ r: 4 }}
                        connectNulls
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

/** 대시보드 섹션 래퍼 — 제목과 한 줄 설명만 붙인 compact 표현. */
export function PortfolioBenchmarkSection() {
  return (
    <Card className="p-4 md:p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">내 포트폴리오 vs 시장</h3>
        <p className="text-xs text-muted-foreground mt-0.5">리밸런싱 기록 기준 비교</p>
      </div>
      <PortfolioBenchmarkChart presentation="compact" />
    </Card>
  );
}
