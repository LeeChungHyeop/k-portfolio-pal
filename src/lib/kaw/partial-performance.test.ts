// 월간·연간 부분 성과 — 확인 가능한 연속 구간(run)만 따로 계산한다.
//
// 1부: computePartialPerformance 단위 테스트 (resultFor 를 가짜로 주입해 run 판정 규칙만 본다)
// 2부: 실제 현금 생성 경로(buildDerivedCash → buildCashSeries → valuateAccountDays → computeProfitAnalysis)로
//      2026-10 연금저축과 같은 구조의 fixture 를 돌린다. 숫자는 fixture 가격으로 손계산한 값이며 운영 데이터가 아니다.
import { describe, it, expect } from "vitest";
import type { AccountId } from "./constants";
import { ledgerHoldingsThrough, buildAccountTimeline } from "./holdings-timeline";
import { replayDailyHoldings, type LedgerTransaction } from "./ledger";
import type { AccountCoverage } from "./ledger-coverage";
import { buildDerivedCash, flowEffectiveDate, type CashFlowInput } from "./derived-cash";
import {
  buildCashSeries,
  chartBar,
  computePartialPerformance,
  computeProfitAnalysis,
  valuateAccountDays,
  type PartialPerformance,
  type PeriodId,
  type PeriodResult,
  type Segment,
} from "./profit-analysis";
import { estimatedExitDays, type EstimateReason } from "./estimate-provenance";
import type { PriceBarsByTicker } from "./useHistoricalPrices";

// ── 1부: 단위 ───────────────────────────────────────────────────────────────

function fakeResult(seg: Segment, over: Partial<PeriodResult> = {}): PeriodResult {
  return {
    key: seg.key, label: seg.label, openDate: seg.openDate, closeDate: seg.closeDate,
    beginningTotal: 1000, endingTotal: 1010, netCashflow: 0, knownProfit: 10,
    incomeLowerBound: 0, incomeUpperBound: 0, incomeHeadroom: 0, averageCapital: 1000,
    returnPctLow: 1, returnPctHigh: 1, holdingsSources: ["ledger"], cashQuality: "derived",
    span: "full", exact: true, estimated: false, denominatorEstimated: false,
    estimateReasons: [], estimatedDates: [], partial: null, ...over,
  };
}
const segOf = (dates: string[]): Segment => ({
  key: "2026-10", label: "2026.10", openDate: dates[0], closeDate: dates[dates.length - 1], dates,
});
/** bad: 하루 구간부터 추정인 날 / hiddenAt: 이 날짜를 범위 안에 포함하는 구간은 추정 (평가 불가일에 숨은 추정) */
function resultFn(opts: {
  bad?: string[]; hiddenAt?: string; pct?: (open: string) => number | null; denom?: string[];
  reasons?: Record<string, EstimateReason[]>;
}) {
  return (seg: Segment): PeriodResult => {
    const badInside = (opts.bad ?? []).filter((d) => d >= seg.openDate && d <= seg.closeDate);
    const hidden = opts.hiddenAt && seg.openDate <= opts.hiddenAt && opts.hiddenAt <= seg.closeDate;
    const estimated = badInside.length > 0 || !!hidden;
    const pct = opts.pct ? opts.pct(seg.openDate) : 1;
    return fakeResult(seg, {
      estimated, exact: !estimated,
      estimateReasons: estimated ? (opts.reasons?.[seg.openDate] ?? ["exit_date_unconfirmed"]) : [],
      denominatorEstimated: !estimated && (opts.denom ?? []).includes(seg.openDate),
      returnPctLow: pct, returnPctHigh: pct,
      knownProfit: 10 * seg.dates.length,
    });
  };
}
const D5 = ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"];

describe("computePartialPerformance — run 판정 (단위)", () => {
  it("전부 제외되면 부분 성과를 만들지 않는다 (null)", () => {
    expect(computePartialPerformance(segOf(D5), resultFn({ bad: D5 }))).toBeNull();
  });

  it("run 이 1개: 앞이 제외되고 뒤가 정상 — 포함·제외 날짜와 커버리지", () => {
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[0], D5[1]] }))!;
    expect(p.runs.map((r) => [r.openDate, r.closeDate, r.tradingDays])).toEqual([[D5[2], D5[4], 3]]);
    expect(p.includedDates).toEqual(D5.slice(2));
    expect(p.excludedDays.map((e) => e.date)).toEqual([D5[0], D5[1]]);
    expect([p.measuredDays, p.totalDays, p.unmeasuredBreaks]).toEqual([3, 5, 0]);
  });

  it("run 이 여러 개로 끊김: 수익률은 연결수익률, 손익은 합계, 제외 날짜 사이를 잇지 않는다", () => {
    const pct: Record<string, number> = { "2026-10-01": 2, "2026-10-07": -1 };
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[2]], pct: (o) => pct[o] ?? 1 }))!;
    expect(p.runs.map((r) => [r.openDate, r.closeDate])).toEqual([[D5[0], D5[1]], [D5[3], D5[4]]]);
    expect(p.returnPctLow).toBeCloseTo((1.02 * 0.99 - 1) * 100, 10); // 연결: (1+2%)(1−1%)−1
    expect(p.returnPctLow).not.toBeCloseTo(2 + -1, 3); // 단순 합산이 아니다
    expect(p.knownProfit).toBe(20 + 20); // run 손익의 합
    expect(p.unmeasuredBreaks).toBe(0); // 사이의 끊김은 제외 날짜(10-06)로 설명된다
  });

  it("하루만 확인된 구간도 run 1개(1일)다 — 커버리지 1/N", () => {
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[0], D5[2], D5[3], D5[4]] }))!;
    expect(p.runs).toHaveLength(1);
    expect([p.measuredDays, p.totalDays]).toEqual([1, 5]);
    expect(p.runs[0].tradingDays).toBe(1);
  });

  it("커버리지가 낮아도 임계값 없이 그대로 만든다 (1/200)", () => {
    const dates = Array.from({ length: 200 }, (_, i) => `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`);
    const p = computePartialPerformance(
      { key: "2026", label: "2026년", openDate: dates[0], closeDate: dates[199], dates },
      resultFn({ bad: dates.slice(1) }),
    )!;
    expect([p.measuredDays, p.totalDays]).toEqual([1, 200]);
  });

  it("★ 날짜가 이어져도 합친 구간이 검증에 실패하면 run 을 분리한다 (평가 불가일에 숨은 추정)", () => {
    // 10-03 은 거래일 목록에 없지만 그 날 추정이 있다 — 10-02 와 10-06 은 scope 상 연속이다
    const p = computePartialPerformance(segOf(D5), resultFn({ hiddenAt: "2026-10-03" }))!;
    expect(p.runs.map((r) => [r.openDate, r.closeDate])).toEqual([[D5[0], D5[1]], [D5[2], D5[4]]]);
    expect(p.excludedDays).toEqual([]); // 제외된 거래일은 없다
    expect(p.unmeasuredBreaks).toBe(1); // 그래도 미확인 끊김 1곳을 알린다
  });

  it("주말·휴일을 건너뛰는 정상 거래일은 한 run 이다 (10-08 → 10-12, 휴일 10-09·주말)", () => {
    const dates = ["2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14"];
    // 10-13 만 제외 → 10-08~10-12 가 이어지고 10-14 는 따로
    const p = computePartialPerformance(segOf(dates), resultFn({ bad: ["2026-10-13"] }))!;
    expect(p.runs.map((r) => [r.openDate, r.closeDate, r.tradingDays])).toEqual([
      ["2026-10-08", "2026-10-12", 2], ["2026-10-14", "2026-10-14", 1],
    ]);
  });

  it("run 하나의 수익률이 계산 불가(null)이면 부분 수익률도 null — 0% 를 대입하지 않고 손익 합계는 유지", () => {
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[2]], pct: (o) => (o === D5[3] ? null : 1) }))!;
    expect(p.returnPctLow).toBeNull();
    expect(p.returnPctHigh).toBeNull();
    expect(p.knownProfit).toBe(40);
    expect(chartBar(fakeResult(segOf(D5), { estimated: true, partial: p }), "pct")).toEqual({ value: null, kind: "none" });
    expect(chartBar(fakeResult(segOf(D5), { estimated: true, partial: p }), "amount")).toEqual({ value: 40, kind: "partial" });
  });

  it("실제 0% 는 0 이다 (null 과 구별) — 0% 부분 성과도 partial 막대로 남는다", () => {
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[2]], pct: () => 0 }))!;
    expect(p.returnPctLow).toBe(0);
    expect(chartBar(fakeResult(segOf(D5), { estimated: true, partial: p }), "pct")).toEqual({ value: 0, kind: "partial" });
  });

  it("분모 추정 run 이 하나라도 있으면 부분 성과도 분모 근사다", () => {
    const p = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[2]], denom: [D5[3]] }))!;
    expect(p.denominatorEstimated).toBe(true);
    const q = computePartialPerformance(segOf(D5), resultFn({ bad: [D5[2]] }))!;
    expect(q.denominatorEstimated).toBe(false);
  });

  it("제외 사유는 하루 구간의 판정 사유를 그대로 남긴다", () => {
    const p = computePartialPerformance(
      segOf(D5), resultFn({ bad: [D5[1]], reasons: { [D5[1]]: ["exit_price_proxy", "exit_date_unconfirmed"] } }),
    )!;
    expect(p.excludedDays).toEqual([{ date: D5[1], reasons: ["exit_price_proxy", "exit_date_unconfirmed"] }]);
  });
});

describe("chartBar — 확정 / 부분 / 없음", () => {
  const seg = segOf(D5);
  const partial = (v: number | null): PartialPerformance => ({
    runs: [], includedDates: [], excludedDays: [], measuredDays: 1, totalDays: 5, unmeasuredBreaks: 0, unpricedDays: [],
    knownProfit: 5, returnPctLow: v, returnPctHigh: v, denominatorEstimated: false, basis: "linked-modified-dietz",
  });
  it("확정 구간은 confirmed, 추정 구간은 partial 이 있을 때만 partial, 없으면 none", () => {
    expect(chartBar(fakeResult(seg), "pct")).toEqual({ value: 1, kind: "confirmed" });
    expect(chartBar(fakeResult(seg, { estimated: true, partial: partial(2) }), "pct")).toEqual({ value: 2, kind: "partial" });
    expect(chartBar(fakeResult(seg, { estimated: true, partial: null }), "pct")).toEqual({ value: null, kind: "none" });
    expect(chartBar(fakeResult(seg, { estimated: true, partial: partial(null) }), "pct").kind).toBe("none");
  });
  it("분모만 추정인 구간은 확정 막대와 같이 그린다 (손익은 상쇄 입증)", () => {
    expect(chartBar(fakeResult(seg, { denominatorEstimated: true, exact: false }), "amount")).toEqual({ value: 10, kind: "confirmed" });
  });
});

// ── 2부: 실제 현금 생성 경로 ────────────────────────────────────────────────

const PROXY = "user_attested_liquidation_price_proxy";
const MIRAE = "miraeasset_capture_qty_price_reconstructed";
const KIS = "kis_api_daily_ccld";

const DATES = [
  "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-12", "2026-10-13",
  "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-11-02", "2026-11-03",
];
const LIB = [
  { defaultEtf: "ETF-A", ticker: "A" },
  { defaultEtf: "ETF-B", ticker: "B" },
];
type Bar = { open: number; close: number };
const A_BARS: Record<string, Bar> = { "2026-09-30": { open: 100, close: 100 }, "2026-10-01": { open: 100, close: 102 }, "2026-10-02": { open: 102, close: 103 } };
const B_BARS: Record<string, Bar> = {
  "2026-10-15": { open: 250, close: 255 }, "2026-10-16": { open: 255, close: 260 }, "2026-10-19": { open: 260, close: 258 },
  "2026-10-20": { open: 258, close: 262 }, "2026-11-02": { open: 262, close: 265 }, "2026-11-03": { open: 265, close: 270 },
};
const barsFor = (dates: string[]): PriceBarsByTicker => ({
  A: Object.fromEntries(dates.map((d) => [d, A_BARS[d] ?? { open: 103, close: 103 }])),
  B: Object.fromEntries(dates.map((d) => [d, B_BARS[d] ?? { open: 250, close: 250 }])),
});

interface TxSpec {
  id: string; ticker: string; side: "buy" | "sell"; qty: number; price: number; date: string;
  amount?: number; estimated?: boolean; sourceTradeDate?: boolean; source?: string;
}
const toTx = (s: TxSpec, accountId: AccountId): LedgerTransaction => ({
  id: s.id, accountId, ticker: s.ticker, etfName: `ETF-${s.ticker}`, side: s.side, quantity: s.qty, price: s.price,
  amount: s.amount ?? Math.round(s.qty * s.price),
  tradeDate: s.estimated && !s.sourceTradeDate ? null : s.date, settlementDate: null, inferredTradeDate: null, eventDate: s.date,
  tradeDateEvidence: s.estimated && !s.sourceTradeDate ? "exact-sale-date-unknown" : "broker-order-date",
  fee: 0, tax: 0, postQuantity: null, source: s.estimated ? PROXY : (s.source ?? MIRAE),
});

interface Built {
  accountId: AccountId; coverage: AccountCoverage; derived: ReturnType<typeof buildDerivedCash>;
  valuations: ReturnType<typeof valuateAccountDays>; flows: { date: string; amount: number }[]; txs: LedgerTransaction[];
}
function build(
  accountId: AccountId, txs: LedgerTransaction[], rawFlows: CashFlowInput[], dates: string[], bars: PriceBarsByTicker, start = dates[0],
): Built {
  const cutoff = txs.map((t) => t.eventDate).sort().pop() ?? null;
  const ledgerDays = replayDailyHoldings(txs)[accountId] ?? [];
  const held = ledgerHoldingsThrough(ledgerDays, cutoff ?? "9999-12-31");
  const history = Object.keys(held).length && cutoff
    ? [{
        date: cutoff,
        rowQuantitiesSnap: { ...held },
        rowEtfSnap: Object.fromEntries(Object.keys(held).map((t) => [t, `ETF-${t}`])),
      }]
    : [];
  const coverage: AccountCoverage = {
    accountId, inception: dates[0], strategyStart: dates[0], performanceStart: start, strategyStartIsTransition: false,
    seam: null, ledgerCutoff: cutoff, anchorDates: history.map((h) => h.date),
  };
  const derived = buildDerivedCash({
    flows: rawFlows,
    trades: txs.map((t) => ({ date: t.eventDate, side: t.side, amount: t.amount, fee: t.fee, tax: t.tax })),
    tradingDates: dates,
  });
  const days = buildAccountTimeline({ accountId, coverage, ledgerDays, history }, LIB, dates);
  const cash = buildCashSeries({ accountId, coverage, derived, flows: rawFlows, tradingDates: dates }, days, bars);
  const flows = rawFlows
    .map((f) => ({ date: flowEffectiveDate(dates, f), amount: f.amount }))
    .filter((f): f is { date: string; amount: number } => !!f.date);
  return { accountId, coverage, derived, valuations: valuateAccountDays(days, cash, bars), flows, txs };
}

/** 2026-10 연금저축과 같은 구조: 확인 거래 → 추정 청산(10-13, 매도일 불확실) → 한국투자 확정 매수(10-14) */
function pension(dates = DATES, start = dates[0], bars: PriceBarsByTicker = barsFor(dates)): Built {
  const txs = ([
    { id: "t1", ticker: "A", side: "buy", qty: 10, price: 100, date: "2026-09-30" },
    { id: "t2", ticker: "A", side: "buy", qty: 1, price: 103, date: "2026-10-02" },
    { id: "t3", ticker: "A", side: "sell", qty: 11, price: 105, amount: 1150, date: "2026-10-13", estimated: true },
    { id: "t4", ticker: "B", side: "buy", qty: 8, price: 250, date: "2026-10-14", source: KIS },
  ] as TxSpec[]).filter((t) => t.date <= dates[dates.length - 1]);
  return build("pension", txs.map((t) => toTx(t, "pension")), [{ date: "2026-09-30", amount: 2000 }], dates, bars, start);
}
function retirement(dates = DATES): Built {
  return build(
    "retirement",
    [toTx({ id: "r1", ticker: "A", side: "buy", qty: 2, price: 100, date: "2026-09-30" }, "retirement")],
    [{ date: "2026-09-30", amount: 500 }], dates, barsFor(dates),
  );
}

function analyze(worlds: Built[], scope: AccountId[], period: PeriodId, withEstimates = true): PeriodResult[] {
  const inScope = worlds.filter((w) => scope.includes(w.accountId));
  return computeProfitAnalysis({
    valuations: inScope.flatMap((w) => w.valuations), coverages: inScope.map((w) => w.coverage), scopeAccountIds: scope, period,
    flows: inScope.flatMap((w) => w.flows),
    incomeSources: inScope.map((w) => ({ accountId: w.accountId, derived: w.derived, cap: null })),
    estimatedDays: withEstimates ? estimatedExitDays(worlds.flatMap((w) => w.txs)) : undefined,
  });
}
const at = (rs: PeriodResult[], key: string) => rs.find((r) => r.key === key)!;
const link = (...pcts: number[]) => (pcts.reduce((a, p) => a * (1 + p / 100), 1) - 1) * 100;

describe("2026-10 구조 fixture — 연금저축 월간 부분 성과 (실제 현금 경로)", () => {
  const pen = pension();
  const oct = at(analyze([pen], ["pension"], "monthly"), "2026-10");

  it("10월 전체는 미확정이고(estimated), 전체 수익률은 확정값으로 덮이지 않는다", () => {
    expect(oct.estimated).toBe(true);
    expect(chartBar(oct, "pct").kind).toBe("partial");
    expect(oct.partial).not.toBeNull();
  });

  it("포함 날짜와 제외 날짜(사유), 커버리지가 날짜별로 명시된다", () => {
    const p = oct.partial!;
    expect(p.includedDates).toEqual(["2026-10-01", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
    expect(Object.fromEntries(p.excludedDays.map((e) => [e.date, e.reasons]))).toEqual({
      "2026-10-02": ["exit_date_unconfirmed"], "2026-10-06": ["exit_date_unconfirmed"], "2026-10-07": ["exit_date_unconfirmed"],
      "2026-10-08": ["exit_date_unconfirmed"], "2026-10-12": ["exit_date_unconfirmed"],
      "2026-10-13": ["exit_price_proxy", "exit_date_unconfirmed"], // 추정 청산 당일
      "2026-10-14": ["cash_error_not_cancelled"], // KIS 확정 매수일이지만 청산 뒤 현금 상쇄를 입증하지 못한다
    });
    expect([p.measuredDays, p.totalDays, p.unmeasuredBreaks]).toEqual([5, 12, 0]);
  });

  it("run 은 10-01(1일)과 10-15~10-20 두 개이고, 제외 기간의 평가액을 직접 잇지 않는다", () => {
    const [r1, r2] = oct.partial!.runs;
    expect([r1.openDate, r1.closeDate, r1.tradingDays]).toEqual(["2026-10-01", "2026-10-01", 1]);
    expect([r2.openDate, r2.closeDate, r2.tradingDays]).toEqual(["2026-10-15", "2026-10-20", 4]);
    // run1: A 10주 시가 100 → 종가 102, 현금 1000 고정 → 손익 20, 분모 2000
    expect([r1.beginningTotal, r1.endingTotal, r1.knownProfit, r1.averageCapital]).toEqual([2000, 2020, 20, 2000]);
    // run2: B 8주 시가 250 → 10-20 종가 262 (주말·오버나이트 포함), 현금 47 고정 → 손익 96, 분모 2047
    expect([r2.beginningTotal, r2.endingTotal, r2.knownProfit, r2.averageCapital]).toEqual([2047, 2143, 96, 2047]);
  });

  it("산식: 수익률은 run 수익률의 연결, 손익은 합계", () => {
    const p = oct.partial!;
    expect(p.runs[0].returnPctLow).toBeCloseTo(1, 10);
    expect(p.runs[1].returnPctLow).toBeCloseTo((96 / 2047) * 100, 10);
    expect(p.returnPctLow).toBeCloseTo(link(1, (96 / 2047) * 100), 10);
    expect(p.knownProfit).toBe(116);
    // 일간 시가→종가 수익률의 단순 합이 아니다
    expect(p.returnPctLow!).not.toBeCloseTo(1 + (96 / 2047) * 100, 3);
  });

  it("분모 추정이 전파된다 — run2 는 cutoff 뒤라 손익 상쇄는 입증, 분모만 근사 (확정이라 부르지 않는다)", () => {
    const p = oct.partial!;
    expect(p.runs[0].denominatorEstimated).toBe(false);
    expect(p.runs[1].denominatorEstimated).toBe(true);
    expect(p.denominatorEstimated).toBe(true);
  });

  it("11월은 정상 구간이다: 부분 성과가 없고 기존 막대(분모 추정 표시만)", () => {
    const nov = at(analyze([pen], ["pension"], "monthly"), "2026-11");
    expect(nov.estimated).toBe(false);
    expect(nov.partial).toBeNull();
    expect(nov.denominatorEstimated).toBe(true);
    expect(chartBar(nov, "pct").kind).toBe("confirmed");
  });

  it("전체 구간을 확정값으로 바꾸지 않는다 — 부분 성과가 있어도 구간 전체 수치는 참고값 그대로", () => {
    const without = at(analyze([pen], ["pension"], "monthly", false), "2026-10");
    // 구간 전체의 숫자는 추정 정보 유무와 무관하게 같다 (부분 성과는 별도 필드)
    expect(oct.returnPctLow).toBe(without.returnPctLow);
    expect(oct.knownProfit).toBe(without.knownProfit);
    expect(oct.partial!.knownProfit).not.toBe(oct.knownProfit);
  });
});

describe("연간 — 월간과 같은 계산 원칙", () => {
  const pen = pension();
  const yr = at(analyze([pen], ["pension"], "yearly"), "2026");

  it("연간 2026 은 미확정이고 부분 성과는 두 run (09-30~10-01, 10-15~11-03: 주말·휴일·월 경계를 넘어 이어짐)", () => {
    expect(yr.estimated).toBe(true);
    const p = yr.partial!;
    expect(p.runs.map((r) => [r.openDate, r.closeDate, r.tradingDays])).toEqual([
      ["2026-09-30", "2026-10-01", 2], ["2026-10-15", "2026-11-03", 6],
    ]);
    expect([p.measuredDays, p.totalDays]).toEqual([8, 15]);
  });

  it("제외 날짜는 월간 10월과 같다 (같은 판정)", () => {
    const octEx = at(analyze([pen], ["pension"], "monthly"), "2026-10").partial!.excludedDays;
    expect(yr.partial!.excludedDays).toEqual(octEx);
  });

  it("산식은 월간과 같다: run1 은 입금일(09-30) 가중, run2 는 10-15 시가 → 11-03 종가", () => {
    const [r1, r2] = yr.partial!.runs;
    // run1: V_open 0 + 입금 2000 (같은 날 시작이라 가중 1) → 분모 2000, 손익 20
    expect([r1.beginningTotal, r1.endingTotal, r1.netCashflow, r1.knownProfit, r1.averageCapital]).toEqual([0, 2020, 2000, 20, 2000]);
    expect([r2.beginningTotal, r2.endingTotal, r2.knownProfit]).toEqual([2047, 2207, 160]);
    expect(yr.partial!.returnPctLow).toBeCloseTo(link(1, (160 / 2047) * 100), 10);
    expect(yr.partial!.knownProfit).toBe(180);
  });
});

describe("scope — 다른 계좌 불변, 전체에서도 추정 구간 제외", () => {
  const pen = pension();
  const ret = retirement();

  it("퇴직연금 단독 scope 는 월간·연간 모두 부분 성과가 없고 추정 정보 유무와 무관하게 결과가 같다", () => {
    for (const p of ["monthly", "yearly", "daily"] as const) {
      const a = analyze([pen, ret], ["retirement"], p, true);
      const b = analyze([ret], ["retirement"], p, false);
      expect(a).toEqual(b);
      expect(a.every((r) => r.partial === null && !r.estimated && !r.denominatorEstimated)).toBe(true);
    }
  });

  it("전체 scope: 연금저축이 걸린 날만 제외되고, run·제외 날짜가 연금저축 단독과 같다", () => {
    const one = at(analyze([pen, ret], ["pension"], "monthly"), "2026-10").partial!;
    const all = at(analyze([pen, ret], ["pension", "retirement"], "monthly"), "2026-10").partial!;
    expect(all.runs.map((r) => [r.openDate, r.closeDate])).toEqual(one.runs.map((r) => [r.openDate, r.closeDate]));
    expect(all.excludedDays).toEqual(one.excludedDays);
    expect([all.measuredDays, all.totalDays]).toEqual([5, 12]);
  });

  it("전체 scope 산식: run 손익은 두 계좌 손익의 합, 분모는 두 계좌 시작 총자산의 합", () => {
    const all = at(analyze([pen, ret], ["pension", "retirement"], "monthly"), "2026-10").partial!;
    // 퇴직연금: A 2주, 시가 100 → 종가 102 (run1) → 손익 4, 이후 103 고정 → 0. 현금 300 고정, 분모 500 / 506
    expect(all.runs[0].knownProfit).toBe(20 + 4);
    expect(all.runs[1].knownProfit).toBe(96 + 0);
    expect(all.runs[0].averageCapital).toBe(2000 + 500);
    expect(all.runs[1].averageCapital).toBe(2047 + 506);
    expect(all.returnPctLow).toBeCloseTo(link((24 / 2500) * 100, (96 / 2553) * 100), 10);
  });

  it("거래일이 하루뿐인 달(앞부분만 있는 10월)도 하루짜리 부분 성과를 만든다", () => {
    const early = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-06"]; // 모두 불확실 창 — 10-01 만 확인
    const w = pension([...early, "2026-10-13", "2026-10-14"]);
    const oc = at(analyze([w], ["pension"], "monthly"), "2026-10");
    expect(oc.estimated).toBe(true);
    expect(oc.partial!.runs.map((r) => r.tradingDays)).toEqual([1]);
    expect([oc.partial!.measuredDays, oc.partial!.totalDays]).toEqual([1, 5]);
  });

  it("모든 거래일이 불확실하면 부분 성과도 막대도 없다", () => {
    const dates = ["2026-10-02", "2026-10-06", "2026-10-07", "2026-10-13"];
    const w = pension(["2026-09-30", ...dates], "2026-10-02");
    const oc = at(analyze([w], ["pension"], "monthly"), "2026-10");
    expect(oc.estimated).toBe(true);
    expect(oc.partial).toBeNull();
    expect(chartBar(oc, "pct")).toEqual({ value: null, kind: "none" });
    expect(chartBar(oc, "amount")).toEqual({ value: null, kind: "none" });
  });
});

describe("평가 불가일에 추정이 숨은 경우 — 날짜가 이어져도 run 을 분리한다 (실제 현금 경로)", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"];
  const barsNoBAtE = (): PriceBarsByTicker => {
    const b = barsFor(dates);
    delete b.B["2026-10-05"]; // 10-05 에 B 시세가 없어 그 날 평가 불가
    return b;
  };
  const world = (): Built =>
    build(
      "pension",
      ([
        { id: "h1", ticker: "A", side: "buy", qty: 1, price: 100, date: "2026-10-01" },
        { id: "h2", ticker: "B", side: "buy", qty: 1, price: 250, date: "2026-10-01" },
        // 매도일은 보고됐다(창 없음) — 추정은 그 날 하루뿐이고, 그 날은 평가 불가라 거래일 목록에서 빠진다
        { id: "h3", ticker: "A", side: "sell", qty: 1, price: 100, date: "2026-10-05", estimated: true, sourceTradeDate: true },
      ] as TxSpec[]).map((t) => toTx(t, "pension")),
      [{ date: "2026-10-01", amount: 1000 }], dates, barsNoBAtE(),
    );

  it("10-05 는 scope 거래일에서 빠지고, 그 앞뒤 거래일은 연속이지만 합치면 추정이 걸려 두 run 으로 갈린다", () => {
    const w = world();
    const m = at(analyze([w], ["pension"], "monthly"), "2026-10");
    expect(m.estimated).toBe(true);
    const p = m.partial!;
    expect(p.includedDates).toEqual(["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07"]); // 10-05 는 목록에 없다
    expect(p.runs.map((r) => [r.openDate, r.closeDate])).toEqual([["2026-10-01", "2026-10-02"], ["2026-10-06", "2026-10-07"]]);
    expect(p.excludedDays).toEqual([]);
    expect(p.unmeasuredBreaks).toBe(1);
    expect([p.measuredDays, p.totalDays]).toEqual([4, 4]);
  });
});

describe("커버리지 분모 — 가격 확인일 기준이고, 가격 누락일은 분모에서 빠진다 (반례)", () => {
  const base = at(analyze([pension()], ["pension"], "monthly"), "2026-10").partial!;
  const barsMissing = (): PriceBarsByTicker => {
    const b = barsFor(DATES);
    delete b.B["2026-10-16"]; // 10-16 에 B 시세가 없어 그 날 평가 불가 (cutoff 뒤라 B 8주를 들고 있다)
    return b;
  };
  const withGap = at(analyze([pension(DATES, DATES[0], barsMissing())], ["pension"], "monthly"), "2026-10").partial!;

  it("가격 누락일은 거래일 목록과 분모에서 사라진다 (5/12 → 4/11) — 되살리면 원래 5/12 와 같다", () => {
    expect([base.measuredDays, base.totalDays]).toEqual([5, 12]);
    expect([withGap.measuredDays, withGap.totalDays]).toEqual([4, 11]);
    expect(withGap.includedDates).not.toContain("2026-10-16");
    expect([withGap.measuredDays + withGap.unpricedDays.length, withGap.totalDays + withGap.unpricedDays.length]).toEqual([5, 12]);
  });

  it("★ 누락일이 제외 대상 날이면 분모만 줄어 커버리지가 과대 표시된다 (5/12=42% → 5/11=45%) — 그래서 unpricedDays 로 따로 알린다", () => {
    const b = barsFor(DATES);
    delete b.A["2026-10-07"]; // 불확실 창 안의 날 — 이 날은 어차피 제외 대상이지만 가격 누락으로 분모에서도 사라진다
    const gap = at(analyze([pension(DATES, DATES[0], b)], ["pension"], "monthly"), "2026-10").partial!;
    expect([gap.measuredDays, gap.totalDays]).toEqual([5, 11]);
    expect(gap.measuredDays / gap.totalDays).toBeGreaterThan(base.measuredDays / base.totalDays); // 과대 표시
    expect(gap.unpricedDays).toEqual(["2026-10-07"]); // 분모에 없다는 사실이 기록된다
    expect(gap.measuredDays / (gap.totalDays + gap.unpricedDays.length)).toBeCloseTo(base.measuredDays / base.totalDays, 10);
  });

  it("평가 불가일(unpricedDays)이 따로 기록된다. 정상 날짜의 가격 누락이 아닌 경우(전부 있음)는 비어 있다", () => {
    expect(withGap.unpricedDays).toEqual(["2026-10-16"]);
    expect(base.unpricedDays).toEqual([]);
  });

  it("가격 누락이 있어도 run 판정과 손익·수익률 계산은 그대로다 (경로 독립 — run2 손익 96, 분모 2047)", () => {
    expect(withGap.runs.map((r) => [r.openDate, r.closeDate, r.tradingDays])).toEqual([
      ["2026-10-01", "2026-10-01", 1], ["2026-10-15", "2026-10-20", 3],
    ]);
    expect(withGap.runs[1].knownProfit).toBe(96);
    expect(withGap.runs[1].averageCapital).toBe(2047);
    expect(withGap.returnPctLow).toBeCloseTo(base.returnPctLow!, 10);
    expect(withGap.excludedDays).toEqual(base.excludedDays);
  });

  it("미확인 끊김(숨은 추정)이 있으면 unmeasuredBreaks 가 별도로 센다 — 가격 누락만으로는 끊기지 않는다", () => {
    expect(withGap.unmeasuredBreaks).toBe(0);
  });

  it("연간에서도 같다: 누락일은 unpricedDays 로 남는다", () => {
    const yr = at(analyze([pension(DATES, DATES[0], barsMissing())], ["pension"], "yearly"), "2026").partial!;
    expect(yr.unpricedDays).toEqual(["2026-10-16"]);
    expect(yr.totalDays).toBe(14);
  });

  it("어떤 종목도 가격이 없는 날은 평가 행조차 없어 알 수 없다 — 분모에도 unpricedDays 에도 없다 (한계)", () => {
    const dates = DATES.filter((d) => d !== "2026-10-16");
    const gone = at(analyze([pension(dates)], ["pension"], "monthly"), "2026-10").partial!;
    expect(gone.unpricedDays).toEqual([]);
    expect(gone.totalDays).toBe(11);
  });
});

describe("기존 정상 결과 불변 (숫자·플래그)", () => {
  it("추정이 없는 계좌·기간은 partial=null 이고 추정 정보를 줘도 안 줘도 같다", () => {
    const ret = retirement();
    for (const p of ["daily", "monthly", "yearly"] as const) {
      const a = analyze([ret], ["retirement"], p, true);
      const b = analyze([ret], ["retirement"], p, false);
      expect(a).toEqual(b);
      expect(a.every((r) => r.partial === null)).toBe(true);
    }
  });

  it("일간에는 부분 성과가 없다 (하루가 곧 구간)", () => {
    const rs = analyze([pension()], ["pension"], "daily");
    expect(rs.every((r) => r.partial === null)).toBe(true);
  });

  it("구간 전체 숫자는 부분 성과 도입 전과 같다 (추정 정보 제외 비교)", () => {
    const strip = (rs: PeriodResult[]) =>
      rs.map(({ estimated, denominatorEstimated, estimateReasons, estimatedDates, exact, partial, ...n }) => n);
    const pen = pension();
    for (const p of ["daily", "monthly", "yearly"] as const) {
      expect(strip(analyze([pen], ["pension"], p, true))).toEqual(strip(analyze([pen], ["pension"], p, false)));
    }
  });
});
