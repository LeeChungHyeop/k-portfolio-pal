// ─────────────────────────────────────────────────────────────────────────────
// 수익 분석 (구 "기간 성과") — 대시보드 Section D
//
// 계산은 전부 `profit-analysis.ts` 순수 모듈이 한다. 여기서는 데이터를 모아 넘기고
// 결과를 그린다.
//
// ## 보유수량 source
//
//   전략시작 ~ 각 계좌 ledger cutoff → verified Transaction Ledger replay
//   cutoff ~ 오늘                     → 기존 앱의 rowQuantitiesSnap anchor carry-forward
//
// seam(첫 유효 anchor)은 source 전환점이 **아니다** — 두 데이터가 정확히 이어짐을
// 증명하는 reconciliation checkpoint 다(불일치 0 실측).
//
// ## 일간 차트는 가로 스크롤이다
//
// 260 거래일을 한 화면에 넣으면 막대가 1px 가 된다. 그래서 한 화면에 약 21 거래일
// (= 한 달치)만 두고 가로로 스크롤한다. 진입 시 **가장 최근 구간**이 보이게 오른쪽
// 끝으로 스크롤한다. Y축은 스크롤과 함께 움직이면 비교가 불가능하므로 왼쪽에 고정
// 영역으로 분리하고, 범위는 **전체 구간 기준**으로 고정한다.
// iOS 는 hover 가 없어서 선택된 막대 정보를 차트 **아래 고정 영역**에 띄운다.
// ─────────────────────────────────────────────────────────────────────────────

import { holdingsAnchorsOf } from "@/lib/kaw/broker-sync-basis";
import { ESTIMATE_REASON_LABEL, estimatedExitDays } from "@/lib/kaw/estimate-provenance";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Rectangle,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { BarChart3, Database, RefreshCw, Info } from "lucide-react";
import { ACCOUNT_IDS, ACCOUNT_LABELS_SHORT, type AccountId } from "@/lib/kaw/constants";
import { formatKRW, getOrDefaultLibrary, usePortfolioStore } from "@/lib/kaw/store";
import { Card } from "@/components/ui/card";
import { useLedger } from "@/lib/kaw/useLedger";
import { useHistoricalPriceBars } from "@/lib/kaw/useHistoricalPrices";
import { replayDailyHoldings } from "@/lib/kaw/ledger";
import {
  buildCoverageMap,
  resolvePerformanceStart,
  STRATEGY_START_DATES,
  type AccountCoverage,
  type CashQuality,
} from "@/lib/kaw/ledger-coverage";
import {
  buildAccountTimeline,
  ledgerHoldingsThrough,
  type AccountTimelineInput,
} from "@/lib/kaw/holdings-timeline";
import {
  buildDerivedCash,
  flowEffectiveDate,
  type DerivedCashSeries,
} from "@/lib/kaw/derived-cash";
import {
  tradingDatesOf,
  buildCashSeries,
  valuateAccountDays,
  computeProfitAnalysis,
  barYDomain,
  confirmedBarValue,
  type AccountDayValuation,
  type PeriodId,
  type PeriodResult,
} from "@/lib/kaw/profit-analysis";

type ScopeId = "all" | AccountId;
type MetricId = "pct" | "amount";

const UP_LIGHT = "#1baf7a",
  DOWN_LIGHT = "#e34948";
const UP_DARK = "#199e70",
  DOWN_DARK = "#e66767";

/** 한 화면에 보이는 일간 거래일 수 — 대략 한 달치 */
const DAILY_VISIBLE_DAYS = 21;
const DAILY_MIN_SLOT = 12;
const AXIS_WIDTH = 56;

const prevDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const fmtAxisAmount = (v: number) => {
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억`;
  if (a >= 10_000) return `${Math.round(v / 10_000)}만`;
  return String(Math.round(v));
};

const CASH_QUALITY_LABEL: Record<CashQuality, string> = {
  derived: "원장 기준",
  "anchor-implied": "리밸런싱 기록 기준",
  "cashflow-pending": "입금 반영 대기",
  unknown: "예수금 미확인",
};

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const o = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    o.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return isDark;
}

function Tabs<T extends string>({
  value,
  onChange,
  items,
  strong,
}: {
  value: T;
  onChange: (v: T) => void;
  items: readonly (readonly [T, string])[];
  strong?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
            value === id
              ? strong
                ? "bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-300/60 dark:border-violet-700/60 font-medium"
                : "bg-muted font-medium text-foreground border border-transparent"
              : "text-muted-foreground hover:bg-muted border border-transparent"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Badge({
  tone,
  title,
  children,
}: {
  tone: "amber" | "slate" | "violet";
  title?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === "amber"
      ? "border-amber-300/60 dark:border-amber-800/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : tone === "violet"
        ? "border-violet-300/60 dark:border-violet-700/60 bg-violet-500/10 text-violet-700 dark:text-violet-300"
        : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span title={title} className={`px-1.5 py-0.5 rounded-md text-[10px] border ${cls}`}>
      {children}
    </span>
  );
}

/**
 * 막대 모양. 값이 null(계산 불가·추정 포함)이면 **아무것도 그리지 않고**, 실제 0 이면 높이가 0 이어도
 * 얇은 선으로 그린다 — "0% 로 계산됨"과 "확정 수익률 없음"이 차트에서도 다르게 보인다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function BarShape(props: any) {
  const { x, y, width, height, fill, payload } = props;
  if (payload?.bar === null || payload?.bar === undefined) return <g />;
  if (!height) return <rect x={x} y={y - 1} width={width} height={2} fill={fill} />;
  return <Rectangle {...props} />;
}

/**
 * "손익이 원장 기준으로 확정"이라는 문구를 써도 되는가 — 조건을 한 곳에 못박는다.
 *
 * 추정(estimated)이 없고, 현금 품질이 `derived` 이며, 보유수량 출처가 전부 `ledger` 일 때만 true.
 * `denominatorEstimated` 는 추정 청산대금에 대한 판정일 뿐이라 이 조건을 대신하지 못한다 —
 * anchor-implied · cashflow-pending · unknown · anchor 보유수량이 하나라도 있으면 false 다.
 */
export function profitConfirmedStatement(r: PeriodResult): boolean {
  return !r.estimated && r.cashQuality === "derived" && r.holdingsSources.every((s) => s === "ledger");
}

/** 선택된 구간 상세 — 모바일에서 손가락이 툴팁을 가리는 문제를 피해 차트 아래 고정 표시 */
export function PeriodDetail({ r }: { r: PeriodResult | null }) {
  if (!r) {
    return (
      <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1">
        <Info className="w-3 h-3" /> 막대를 누르면 그 구간의 근거가 여기 표시됩니다
      </p>
    );
  }
  const rangeLow = r.returnPctLow;
  const rangeHigh = r.returnPctHigh;
  const hasRange = rangeHigh !== null && Math.abs((rangeHigh ?? 0) - (rangeLow ?? 0)) >= 0.005;
  return (
    <div className="rounded-xl border bg-muted/30 p-3 text-xs space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">{r.label}</span>
        <span className="text-[11px] text-muted-foreground">
          {r.openDate} 시가 → {r.closeDate} 종가
        </span>
        {/* 경고는 서로 독립이다 — 하나가 켜졌다고 다른 것을 가리지 않는다. 여러 개가 동시에 보일 수 있다. */}
        {r.exact && (
          <Badge tone="violet" title="원장 거래와 유도 예수금만으로 계산되고 추정이 없는 구간입니다">
            원장 기준
          </Badge>
        )}
        {r.estimated && (
          <Badge
            tone="amber"
            title="추정 청산 거래가 이 구간 손익에 영향을 줄 수 있습니다. 아래 수치는 확정값이 아니라 계산 참고값입니다."
          >
            추정 포함 · 미확정
          </Badge>
        )}
        {r.denominatorEstimated && (
          <Badge
            tone="amber"
            title="추정 청산대금의 오차는 이 구간 손익에서 상쇄된다고 입증됐지만, 수익률 분모(시작 총자산)에는 추정 대금이 섞여 있습니다."
          >
            분모 추정
          </Badge>
        )}
        {r.cashQuality !== "derived" && (
          <Badge tone="amber" title={`예수금 품질: ${CASH_QUALITY_LABEL[r.cashQuality]}`}>
            {CASH_QUALITY_LABEL[r.cashQuality]}
          </Badge>
        )}
        {r.holdingsSources.includes("anchor") && (
          <Badge
            tone="amber"
            title="이 구간 일부는 리밸런싱 기록의 보유수량을 씁니다. 체결가를 모르므로 당일 매매 손익을 0 으로 둡니다."
          >
            리밸런싱 기록 보유수량
          </Badge>
        )}
        {r.span === "account-inception" && (
          <Badge tone="slate" title="계좌·전략이 기간 중간에 시작했습니다">
            기간 일부
          </Badge>
        )}
        {r.span === "in-progress" && (
          <Badge tone="slate" title="아직 진행 중인 기간입니다">
            진행 중
          </Badge>
        )}
      </div>
      {r.estimated && (
        <div
          className="rounded-lg border border-amber-300/60 dark:border-amber-800/60 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200 space-y-0.5"
          data-testid="estimate-notice"
        >
          <p className="font-medium">
            추정 거래가 포함된 구간입니다 ({r.estimatedDates.join(", ")}) — 아래 손익·수익률은 확정값이 아닌 계산 참고값입니다.
          </p>
          <ul className="list-disc pl-4">
            {r.estimateReasons.map((reason) => (
              <li key={reason}>{ESTIMATE_REASON_LABEL[reason]}</li>
            ))}
          </ul>
        </div>
      )}
      {r.denominatorEstimated && (
        <div
          className="rounded-lg border border-amber-300/60 dark:border-amber-800/60 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200 space-y-0.5"
          data-testid="denominator-notice"
        >
          <p>
            추정 청산대금의 오차는 이 구간의 손익에서 상쇄되는 것으로 입증됐습니다(구간이 원장 이후이거나,
            청산 이후 새 현금 최저점이 없습니다). 다만 수익률 분모인 시작 총자산의 예수금에는 추정 대금이
            섞여 있어 수익률은 근사값입니다.
          </p>
          {profitConfirmedStatement(r) ? (
            <p data-testid="profit-confirmed">
              보유수량·예수금이 모두 원장 기준이라, 기간 손익은 추정 청산대금과 무관하게 원장으로 계산된
              값입니다.
            </p>
          ) : (
            <p data-testid="profit-not-fully-confirmed">
              그렇다고 기간 손익 전체가 확정인 것은 아닙니다 — 위에 표시된 예수금 품질·보유수량 출처의
              한계는 그대로 남아 있습니다.
            </p>
          )}
        </div>
      )}
      {(r.estimated || r.denominatorEstimated) && (
        <p className="text-[11px] text-muted-foreground" data-testid="income-separate-note">
          미관측 현금수입(이자·분배금)의 불확실성은 추정 청산대금과 <strong>별개</strong>이며, 아래
          &lsquo;미관측 현금수입&rsquo; 행에 따로 표시됩니다. 동기화 기록의 &lsquo;원장-관측 차이&rsquo;는
          둘을 합친 설명되지 않은 잔차이지 청산대금 오차의 상한이 아닙니다.
        </p>
      )}
      <div
        className={`space-y-0.5 tabular-nums border-t pt-1.5 ${r.estimated ? "text-muted-foreground" : ""}`}
        data-testid={r.estimated ? "reference-values" : undefined}
      >
        <Row label="기초 총자산 (장 시작)" value={formatKRW(r.beginningTotal)} />
        <Row label="기말 총자산 (장 마감)" value={formatKRW(r.endingTotal)} />
        <Row
          label="외부 입출금"
          value={`${r.netCashflow >= 0 ? "+" : "-"}${formatKRW(Math.abs(r.netCashflow))}`}
        />
        <Row
          label={r.estimated ? "기간 손익 (계산 참고값 · 미확정)" : "기간 손익"}
          value={`${r.knownProfit >= 0 ? "+" : "-"}${formatKRW(Math.abs(r.knownProfit))}`}
          strong={!r.estimated}
          muted={r.estimated}
          tone={r.estimated ? undefined : r.knownProfit >= 0 ? "up" : "down"}
        />
        {/* 아래 두 줄은 위 손익의 **내역**이다 — 더하는 값이 아니다.
            기간 손익에는 보수 모델이 인정한 미관측 수입이 이미 들어 있다. */}
        <Row
          label="└ 그중 미관측 현금수입 (이자·분배금)"
          value={`+${formatKRW(r.incomeLowerBound)}`}
          muted
        />
        <Row
          label="└ 더 있을 수 있는 미관측 수입"
          value={
            r.incomeHeadroom === null
              ? "미정 (원장 최신화 필요)"
              : `+${formatKRW(r.incomeHeadroom)}`
          }
          muted
        />
        <div className="border-t pt-1 flex justify-between gap-3 font-semibold">
          <span>
            {r.estimated
              ? "기간 수익률 (참고값 · 미확정)"
              : r.denominatorEstimated
                ? "기간 수익률 (분모 추정)"
                : "기간 수익률"}
          </span>
          <span
            className={
              rangeLow === null || r.estimated
                ? "text-muted-foreground"
                : rangeLow >= 0
                  ? "text-emerald-500"
                  : "text-rose-500"
            }
          >
            {rangeLow === null ? "계산 불가" : `${rangeLow >= 0 ? "+" : ""}${rangeLow.toFixed(2)}%`}
            {hasRange && ` ~ ${rangeHigh! >= 0 ? "+" : ""}${rangeHigh!.toFixed(2)}%`}
            {/* 숫자 뒤에 "이상"을 붙이지 않는다 — 정확도는 badge·tooltip·아래 설명으로만
                표현한다(상한 미정이면 "더 있을 수 있는 미관측 수입" 행이 그것을 말해준다). */}
          </span>
        </div>
        <Row
          label="평균투자원금 (분모 = 기초자산 + 기간가중 입출금)"
          value={formatKRW(r.averageCapital)}
          muted
        />
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  tone?: "up" | "down";
}) {
  return (
    <div
      className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""} ${muted ? "text-[11px] text-muted-foreground" : ""}`}
    >
      <span className={muted ? "" : "text-muted-foreground"}>{label}</span>
      <span className={tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-500" : ""}>
        {value}
      </span>
    </div>
  );
}

/** 차트에 올리는 한 줄 — `bar` 는 확정 값(null = 막대 없음) */
export type ChartRow = PeriodResult & { bar: number | null };

/**
 * Recharts 클릭/터치 이벤트에서 **선택할 구간 key** 를 찾는다.
 *
 * 값이 null 인 슬롯은 막대가 없으므로 `activePayload` 에 기대지 않는다 — 우선순위:
 *   1. activePayload[0].payload.key
 *   2. activeTooltipIndex (슬롯 순번 — 값과 무관하다)
 *   3. activeLabel
 */
export function selectionKeyFromChartEvent(
  e: unknown,
  rows: readonly { key: string; label: string }[],
): string | null {
  const ev = e as {
    activePayload?: { payload?: { key?: string } }[];
    activeTooltipIndex?: number | string | null;
    activeLabel?: string | number | null;
  } | null;
  const k = ev?.activePayload?.[0]?.payload?.key;
  if (k) return k;
  const raw = ev?.activeTooltipIndex;
  const idx = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isInteger(idx) && idx >= 0 && idx < rows.length) return rows[idx].key;
  if (ev?.activeLabel !== undefined && ev?.activeLabel !== null) {
    const hit = rows.find((r) => r.label === String(ev.activeLabel));
    if (hit) return hit.key;
  }
  return null;
}

/** 구간 선택 select 의 옵션 문구 — 막대가 없는 구간도 고를 수 있고, 왜 막대가 없는지 보인다 */
export function periodOptionLabel(r: PeriodResult, metric: MetricId): string {
  const bar = confirmedBarValue(r, metric);
  const tag = r.estimated
    ? " · 추정 포함(막대 없음)"
    : bar === null
      ? " · 계산 불가(막대 없음)"
      : r.denominatorEstimated
        ? " · 분모 추정"
        : "";
  return `${r.label}${tag}`;
}

/**
 * 막대 차트 + 구간 선택 + 상세 카드.
 *
 * 선택은 두 경로다: 차트 클릭/터치(위 `selectionKeyFromChartEvent`)와, 차트의 hit-testing 에 기대지 않는
 * **구간 선택 select**(키보드·스크린리더·터치 모두 가능). null 슬롯은 어느 쪽으로도 선택된다.
 */
export function ProfitResultsPanel({
  period,
  metric,
  results,
  up,
  down,
  selectedKey,
  onSelect,
}: {
  period: PeriodId;
  metric: MetricId;
  results: readonly PeriodResult[];
  up: string;
  down: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  // 막대 값: 계산 불가(null)·추정 포함 구간은 0 이 아니라 null 이다 — 막대를 그리지 않는다.
  // 진짜 0 은 0 으로 남고, BarShape 가 높이 0 이어도 얇은 선으로 그려 null(생략)과 구별한다.
  const chartData = useMemo<ChartRow[]>(
    () => results.map((r) => ({ ...r, bar: confirmedBarValue(r, metric) })),
    [results, metric],
  );
  const onChartClick = (e: unknown) => {
    const k = selectionKeyFromChartEvent(e, chartData);
    if (k) onSelect(k);
  };
  const selected = useMemo(
    () => results.find((r) => r.key === selectedKey) ?? results[results.length - 1] ?? null,
    [results, selectedKey],
  );
  const yDomain = useMemo(() => barYDomain(chartData.map((d) => d.bar)), [chartData]);

  // ── 일간 가로 스크롤 ────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  // **스크롤 컨테이너 자체**를 관측한다. 바깥 wrapper 를 재면 레이아웃이 잡히기 전에 0 이
  // 나와 slot 이 최소값으로 굳는다(375px 실측에서 18개만 보였다). 0 은 무시하고 직전 값을
  // 유지하고, 폭이 정해진 뒤 slot 을 다시 계산한다.
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewWidth((prev) => (el.clientWidth > 0 ? el.clientWidth : prev));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [period]);
  const slot =
    viewWidth > 0
      ? Math.max(DAILY_MIN_SLOT, Math.floor(viewWidth / DAILY_VISIBLE_DAYS))
      : DAILY_MIN_SLOT;
  const dailyWidth = Math.max(viewWidth, Math.max(1, chartData.length) * slot);

  // 진입 시 **가장 최근 구간**이 보이게 오른쪽 끝으로
  useEffect(() => {
    if (period !== "daily") return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [period, chartData.length, slot, viewWidth]);

  const cells = chartData.map((d) => (
    <Cell
      key={d.key}
      fill={d.bar !== null && d.bar < 0 ? down : up}
      opacity={selectedKey && selectedKey !== d.key ? 0.45 : 1}
    />
  ));
  const yTick = (v: number) => (metric === "pct" ? `${v.toFixed(1)}%` : fmtAxisAmount(v));

  return (
    <>
      {period === "daily" ? (
        <div className="flex" style={{ touchAction: "pan-x pan-y" }}>
          {/* 고정 Y축 — 스크롤과 함께 움직이면 막대 크기를 비교할 수 없다 */}
          <div style={{ width: AXIS_WIDTH }} className="shrink-0 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 0, left: 0, bottom: 18 }}>
                <YAxis domain={yDomain} tick={{ fontSize: 11 }} width={AXIS_WIDTH} tickFormatter={yTick} />
                <Bar dataKey="bar" fill="transparent" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div
            ref={scrollRef}
            data-testid="daily-scroll"
            className="overflow-x-auto overscroll-x-contain flex-1 [-webkit-overflow-scrolling:touch]"
          >
            <div style={{ width: dailyWidth }} className="h-52">
              <BarChart
                width={dailyWidth}
                height={208}
                data={chartData}
                margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
                onClick={onChartClick}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis domain={yDomain} hide />
                <ReferenceLine y={0} stroke="currentColor" opacity={0.35} />
                <Tooltip content={() => null} cursor={{ fillOpacity: 0.08 }} />
                <Bar dataKey="bar" radius={[2, 2, 0, 0]} shape={BarShape} isAnimationActive={false}>
                  {cells}
                </Bar>
              </BarChart>
            </div>
          </div>
        </div>
      ) : (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={onChartClick}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 11 }}
                width={metric === "pct" ? 44 : 56}
                tickFormatter={yTick}
              />
              <ReferenceLine y={0} stroke="currentColor" opacity={0.35} />
              <Tooltip content={() => null} cursor={{ fillOpacity: 0.08 }} />
              <Bar dataKey="bar" radius={[3, 3, 0, 0]} shape={BarShape} isAnimationActive={false}>
                {cells}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">구간 선택</span>
        <select
          aria-label="구간 선택"
          data-testid="period-picker"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs text-foreground"
          value={selected?.key ?? ""}
          onChange={(e) => onSelect(e.target.value)}
        >
          {results.map((r) => (
            <option key={r.key} value={r.key}>
              {periodOptionLabel(r, metric)}
            </option>
          ))}
        </select>
      </label>

      <PeriodDetail r={selected} />
    </>
  );
}

export function ProfitAnalysisSection() {
  const { state, currentUser } = usePortfolioStore();
  const library = useMemo(() => getOrDefaultLibrary(state), [state.assetLibrary]);
  const isDark = useIsDarkMode();
  const up = isDark ? UP_DARK : UP_LIGHT;
  const down = isDark ? DOWN_DARK : DOWN_LIGHT;

  const [period, setPeriod] = useState<PeriodId>("monthly");
  const [scope, setScope] = useState<ScopeId>("all");
  const [metric, setMetric] = useState<MetricId>("pct");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const ledger = useLedger(!!currentUser);

  // ── 가격 요청 계획: 원장 ticker + anchor ticker, 계좌 개시일부터 ────────────
  const plan = useMemo(() => {
    const txs = ledger.data?.transactions ?? [];
    if (!txs.length) return null;
    const tickers = new Set<string>(txs.map((t) => t.ticker));
    for (const id of ACCOUNT_IDS) {
      for (const h of holdingsAnchorsOf(state.accounts[id])) {
        for (const name of Object.values(h.rowEtfSnap ?? {})) {
          const hit = library.find((a) => a.defaultEtf === name && a.ticker);
          if (hit?.ticker) tickers.add(hit.ticker);
        }
      }
    }
    // 유도 예수금이 전 구간을 봐야 하므로 **계좌 개시일**부터 받는다
    let from = "";
    for (const id of ACCOUNT_IDS) {
      for (const f of state.accounts[id].cashflows ?? []) if (!from || f.date < from) from = f.date;
      for (const t of txs)
        if (t.accountId === id && (!from || t.eventDate < from)) from = t.eventDate;
    }
    if (!from || !tickers.size) return null;
    const to = new Date().toISOString().slice(0, 10);
    return { tickers: [...tickers].sort(), fromDate: from, toDate: to };
  }, [ledger.data, state, library]);

  const prices = useHistoricalPriceBars(plan, !!currentUser && !!plan);

  // ── 계산 ────────────────────────────────────────────────────────────────────
  const model = useMemo(() => {
    const bars = prices.data ?? {};
    const txs = ledger.data?.transactions ?? [];
    const tradingDates = tradingDatesOf(bars);
    if (!txs.length || !tradingDates.length) {
      return {
        valuations: [] as AccountDayValuation[],
        coverages: [] as AccountCoverage[],
        flows: [] as { accountId: string; date: string; amount: number }[],
        incomeSources: [] as {
          accountId: string;
          derived: DerivedCashSeries;
          cap: number | null;
        }[],
      };
    }
    const corrections = new Map((ledger.data?.corrections ?? []).map((c) => [c.transactionId, c]));
    const dailyByAccount = replayDailyHoldings(txs, corrections);

    const coverage0 = buildCoverageMap(
      ACCOUNT_IDS.map((id) => ({
        accountId: id,
        ledgerDates: txs.filter((t) => t.accountId === id).map((t) => t.eventDate),
        cashflowDates: (state.accounts[id].cashflows ?? []).map((f) => f.date),
        // 보유수량 anchor = 리밸런싱 이력 + 계좌 동기화(broker_sync). 동기화는 수익률·매매 이벤트가 아니다.
        history: holdingsAnchorsOf(state.accounts[id]),
      })),
    );

    const coverages: AccountCoverage[] = ACCOUNT_IDS.map((id) =>
      resolvePerformanceStart(
        coverage0[id],
        ledgerHoldingsThrough(dailyByAccount[id] ?? [], prevDay(STRATEGY_START_DATES[id])),
        tradingDates,
      ),
    );

    const valuations: AccountDayValuation[] = [];
    const flows: { accountId: string; date: string; amount: number }[] = [];
    const incomeSources: { accountId: string; derived: DerivedCashSeries; cap: number | null }[] =
      [];

    for (const cv of coverages) {
      const acc = state.accounts[cv.accountId];
      const accFlows = (acc.cashflows ?? []).map((f) => ({
        date: f.date,
        amount: f.amount,
        timing: f.timing,
      }));
      const accTrades = txs
        .filter((t) => t.accountId === cv.accountId)
        .map((t) => ({
          date: t.eventDate,
          side: t.side,
          amount: t.amount,
          fee: t.fee,
          tax: t.tax,
        }));
      const derived = buildDerivedCash({ flows: accFlows, trades: accTrades, tradingDates });

      const timeline: AccountTimelineInput = {
        accountId: cv.accountId,
        coverage: cv,
        ledgerDays: dailyByAccount[cv.accountId] ?? [],
        history: holdingsAnchorsOf(acc),
      };
      const days = buildAccountTimeline(timeline, library, tradingDates);
      const cash = buildCashSeries(
        { accountId: cv.accountId, coverage: cv, derived, flows: accFlows, tradingDates },
        days,
        bars,
      );
      valuations.push(...valuateAccountDays(days, cash, bars));

      // 미관측 수입 상한 R — **cutoff 정렬 checkpoint 가 있을 때만**.
      // cutoff 이후 거래나 입금이 있으면 현재 예수금에 그 효과가 섞여 R 이 의미를 잃는다.
      const latestAnchor = cv.anchorDates.length ? cv.anchorDates[cv.anchorDates.length - 1] : null;
      const hasFlowAfterCutoff = accFlows.some((f) => f.date > (cv.ledgerCutoff ?? ""));
      const capValid =
        !!cv.ledgerCutoff &&
        latestAnchor !== null &&
        cv.ledgerCutoff >= latestAnchor &&
        !hasFlowAfterCutoff &&
        acc.cashBalance !== undefined;
      let cap: number | null = null;
      if (capValid) {
        let model = 0;
        for (const d of derived.dates) {
          if (d > cv.ledgerCutoff!) break;
          model = derived.byDate.get(d)?.cash ?? model;
        }
        cap = Math.max(0, (acc.cashBalance ?? 0) - model);
      }
      incomeSources.push({ accountId: cv.accountId, derived, cap });

      for (const f of accFlows) {
        const e = flowEffectiveDate(tradingDates, f);
        if (e && cv.performanceStart && e >= cv.performanceStart) {
          flows.push({ accountId: cv.accountId, date: e, amount: f.amount });
        }
      }
    }
    return { valuations, coverages, flows, incomeSources };
  }, [prices.data, ledger.data, state.accounts, library]);

  const scopeIds = useMemo(
    () => (scope === "all" ? ([...ACCOUNT_IDS] as string[]) : [scope]),
    [scope],
  );

  // 추정 거래(가격 대용 청산)가 있는 날짜 — 숫자는 고치지 않고 구간의 확정 여부에만 쓴다.
  const estimatedDays = useMemo(
    () =>
      estimatedExitDays(
        ledger.data?.transactions ?? [],
        new Map((ledger.data?.corrections ?? []).map((c) => [c.transactionId, c])),
      ),
    [ledger.data],
  );

  const results = useMemo(
    () =>
      computeProfitAnalysis({
        valuations: model.valuations,
        coverages: model.coverages,
        scopeAccountIds: scopeIds,
        period,
        flows: model.flows
          .filter((f) => scopeIds.includes(f.accountId))
          .map((f) => ({ date: f.date, amount: f.amount })),
        incomeSources: model.incomeSources,
        estimatedDays,
      }),
    [model, scopeIds, period, estimatedDays],
  );

  // 품질 요약 배지
  const summary = useMemo(() => {
    const nonExact = results.filter((r) => !r.exact).length;
    const estimated = results.filter((r) => r.estimated).length;
    const denominatorEstimated = results.filter((r) => r.denominatorEstimated).length;
    const anchorUsed = results.some((r) => r.holdingsSources.includes("anchor"));
    const pending = results.some((r) => r.cashQuality === "cashflow-pending");
    const unknown = results.some((r) => r.cashQuality === "unknown");
    return { nonExact, estimated, denominatorEstimated, anchorUsed, pending, unknown, total: results.length };
  }, [results]);

  const isLoading = ledger.isLoading || prices.isLoading;
  const unavailable = ledger.data?.unavailable;

  return (
    <Card className="p-4 md:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">수익 분석</h3>
          {summary.total > 0 && summary.anchorUsed && (
            <Badge
              tone="amber"
              title="원장이 끝난 뒤 구간은 리밸런싱 기록의 보유수량을 씁니다. 그 구간은 체결가를 모르므로 당일 매매 손익을 0 으로 둡니다."
            >
              리밸런싱 기록 구간 포함
            </Badge>
          )}
          {summary.estimated > 0 && (
            <Badge
              tone="amber"
              title="계좌 이전 때 사용자가 승인한 추정 청산가가 들어 있는 구간입니다. 확정 수익률로 표시하지 않고 막대를 생략합니다. 구간을 누르면 계산 참고값과 사유를 볼 수 있습니다."
            >
              추정 포함 {summary.estimated}개 구간 · 막대 생략
            </Badge>
          )}
          {summary.denominatorEstimated > 0 && (
            <Badge
              tone="slate"
              title="추정 청산대금의 오차가 손익에서 상쇄된다고 입증된 구간입니다(막대는 그립니다). 수익률 분모의 예수금에는 추정 대금이 섞여 있어 수익률은 근사값입니다. 현금 품질·보유수량 출처는 별도로 표시됩니다."
            >
              분모 추정 {summary.denominatorEstimated}개 구간
            </Badge>
          )}
          {summary.pending && (
            <Badge
              tone="amber"
              title="입금은 장부에 있는데 그 돈으로 한 매수가 아직 원장에 없습니다."
            >
              입금 반영 대기
            </Badge>
          )}
          {summary.unknown && (
            <Badge tone="amber" title="그 구간 예수금을 원장·장부로 설명할 수 없습니다.">
              예수금 미확인 구간
            </Badge>
          )}
        </div>
        <Tabs
          value={period}
          onChange={(v) => {
            setPeriod(v);
            setSelectedKey(null);
          }}
          items={
            [
              ["daily", "일간"],
              ["monthly", "월간"],
              ["yearly", "연간"],
            ] as const
          }
          strong
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={scope}
          onChange={(v) => {
            setScope(v);
            setSelectedKey(null);
          }}
          items={
            [
              ["all", "전체"],
              ...ACCOUNT_IDS.map((id) => [id, ACCOUNT_LABELS_SHORT[id]] as const),
            ] as readonly (readonly [ScopeId, string])[]
          }
        />
        <div className="md:ml-auto">
          <Tabs
            value={metric}
            onChange={setMetric}
            items={
              [
                ["pct", "수익률(%)"],
                ["amount", "수익금(원)"],
              ] as const
            }
          />
        </div>
      </div>

      {isLoading ? (
        <div className="h-52 grid place-items-center text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> 거래 원장과 과거 시세를 불러오는 중…
          </span>
        </div>
      ) : unavailable ? (
        <div className="h-52 rounded-xl border border-dashed grid place-items-center text-center px-4">
          <div className="space-y-1">
            <Database className="w-6 h-6 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">
              거래 원장 저장소가 아직 준비되지 않았습니다
            </p>
          </div>
        </div>
      ) : results.length === 0 ? (
        <div className="h-52 rounded-xl border border-dashed grid place-items-center text-center px-4">
          <div className="space-y-1">
            <BarChart3 className="w-6 h-6 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">
              {period === "daily"
                ? "표시할 거래일이 없습니다"
                : "구간을 만들려면 거래일이 2일 이상 필요합니다"}
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              가격을 확보하지 못한 거래일은 0 으로 채우지 않고 제외합니다
            </p>
          </div>
        </div>
      ) : (
        <>
          <ProfitResultsPanel
            period={period}
            metric={metric}
            results={results}
            up={up}
            down={down}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />

          <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
            <strong>일간</strong>은 그 거래일 시가 → 종가, <strong>월간</strong>은 그 달 첫 거래일
            시가 → 마지막 거래일 종가, <strong>연간</strong>은 그 해 첫 거래일 시가 → 마지막(또는
            최신) 거래일 종가입니다. 월간·연간은 일간을 합해서 만들지 않습니다 — 일간은 밤 사이 가격
            변동을 포함하지 않지만 월간·연간은 기간 안의 밤 사이 변동을 모두 포함하기 때문에, 일간을
            더한 값과 다릅니다.
            {summary.nonExact > 0 &&
              ` 전체 ${summary.total}개 구간 중 ${summary.nonExact}개는 예수금이나 보유수량을 원장만으로 확정하지 못했거나 추정 거래를 포함해 '원장 기준'이 아닙니다.`}
            {summary.estimated > 0 &&
              ` 추정 거래가 포함된 ${summary.estimated}개 구간은 확정 수익률이 아니어서 막대를 그리지 않습니다(0% 가 아닙니다).`}
          </p>
        </>
      )}
    </Card>
  );
}
