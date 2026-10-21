// cashErrorCancels 의 두 충분조건이 실제 buildDerivedCash / buildCashSeries 동작에서 성립하는가.
//
// 방법: 시나리오마다 추정 청산대금(p1, p2)을 격자로 바꿔 **실제 현금 생성 경로를 매번 다시 돌리고**,
//   · cashErrorCancels 가 true 인 구간은 모든 격자점에서 구간 손익(knownProfit)이 정확히 같아야 한다 (soundness)
//   · false 인 구간은 손익이 우연히 같아도 확정으로 표시하지 않는다 (fail-closed)
// 를 확인한다. 손익 계산식·원장 금액은 건드리지 않는다.
import { describe, it, expect } from "vitest";
import type { AccountId } from "./constants";
import { ledgerHoldingsThrough } from "./holdings-timeline";
import { replayDailyHoldings, type LedgerTransaction } from "./ledger";
import type { AccountCoverage } from "./ledger-coverage";
import { buildAccountTimeline } from "./holdings-timeline";
import { buildDerivedCash, flowEffectiveDate, type CashFlowInput } from "./derived-cash";
import {
  buildCashSeries,
  computeProfitAnalysis,
  confirmedBarValue,
  valuateAccountDays,
  type PeriodId,
  type PeriodResult,
} from "./profit-analysis";
import { estimatedExitDays } from "./estimate-provenance";
import type { PriceBarsByTicker } from "./useHistoricalPrices";

const PROXY = "user_attested_liquidation_price_proxy";
const MIRAE = "miraeasset_capture_qty_price_reconstructed";
const KIS = "kis_api_daily_ccld";

const D = { d1: "2026-10-01", d2: "2026-10-02", e: "2026-10-05", n: "2026-10-06", n2: "2026-10-07", m1: "2026-11-02", m2: "2026-11-03" };
const DATES = [D.d1, D.d2, D.e, D.n, D.n2, D.m1, D.m2];
const LIB = ["A", "B", "C"].map((t) => ({ defaultEtf: `ETF-${t}`, ticker: t }));
const flat = (p: number) => Object.fromEntries(DATES.map((d) => [d, { open: p, close: p }]));
const bars: PriceBarsByTicker = { A: flat(100), B: flat(250), C: flat(100) };

interface TxSpec { id: string; ticker: string; side: "buy" | "sell"; qty: number; price: number; date: string; estimated?: boolean; source?: string }
const toTx = (s: TxSpec, accountId: AccountId): LedgerTransaction => ({
  id: s.id, accountId, ticker: s.ticker, etfName: `ETF-${s.ticker}`, side: s.side, quantity: s.qty, price: s.price,
  amount: Math.round(s.qty * s.price), tradeDate: s.estimated ? null : s.date, settlementDate: null, inferredTradeDate: null,
  eventDate: s.date, tradeDateEvidence: s.estimated ? "exact-sale-date-unknown" : "broker-order-date", fee: 0, tax: 0,
  postQuantity: null, source: s.estimated ? PROXY : (s.source ?? KIS),
});

interface Built {
  accountId: AccountId; coverage: AccountCoverage; derived: ReturnType<typeof buildDerivedCash>;
  valuations: ReturnType<typeof valuateAccountDays>; flows: { date: string; amount: number }[]; txs: LedgerTransaction[];
}

function build(accountId: AccountId, txs: LedgerTransaction[], rawFlows: CashFlowInput[]): Built {
  const cutoff = txs.map((t) => t.eventDate).sort().pop() ?? null;
  const ledgerDays = replayDailyHoldings(txs)[accountId] ?? [];
  // cutoff 이후 날짜는 anchor 구간 — cutoff 시점 보유를 그대로 anchor 로 둔다 (보유 변화가 없는 상태)
  const held = ledgerHoldingsThrough(ledgerDays, cutoff ?? "9999-12-31");
  const history = Object.keys(held).length && cutoff
    ? [{
        date: cutoff,
        rowQuantitiesSnap: Object.fromEntries(Object.entries(held).map(([t, q]) => [t, q])),
        rowEtfSnap: Object.fromEntries(Object.keys(held).map((t) => [t, `ETF-${t}`])),
      }]
    : [];
  const coverage: AccountCoverage = {
    accountId, inception: D.d1, strategyStart: D.d1, performanceStart: D.d1, strategyStartIsTransition: false,
    seam: null, ledgerCutoff: cutoff, anchorDates: history.map((h) => h.date),
  };
  const derived = buildDerivedCash({
    flows: rawFlows,
    trades: txs.map((t) => ({ date: t.eventDate, side: t.side, amount: t.amount, fee: t.fee, tax: t.tax })),
    tradingDates: DATES,
  });
  const days = buildAccountTimeline({ accountId, coverage, ledgerDays, history }, LIB, DATES);
  const cash = buildCashSeries({ accountId, coverage, derived, flows: rawFlows, tradingDates: DATES }, days, bars);
  const flows = rawFlows
    .map((f) => ({ date: flowEffectiveDate(DATES, f), amount: f.amount }))
    .filter((f): f is { date: string; amount: number } => !!f.date);
  return { accountId, coverage, derived, valuations: valuateAccountDays(days, cash, bars), flows, txs };
}

interface Scenario {
  name: string;
  /** 청산 전 이미 결손(incomeLB)이 있는 상태로 시작 */
  deficit?: boolean;
  /** 추정 청산이 두 번 (C: 10-02, A: 10-05) */
  two?: boolean;
  /** 10-06 의 이벤트 */
  next?: { txs?: Omit<TxSpec, "date">[]; flows?: number[] };
  /** 11-02 / 11-03 의 이벤트 (cutoff 를 뒤로 민다) */
  later?: { date: string; txs: Omit<TxSpec, "date">[] }[];
  /** 10-06 일간 구간에서 상쇄가 입증돼야 하는가 */
  cancelsNext: boolean;
}

function world(sc: Scenario, p1: number, p2: number): Built {
  const txs: TxSpec[] = [
    { id: "bA", ticker: "A", side: "buy", qty: 1, price: 100, date: D.d1, source: MIRAE },
    ...(sc.two ? [{ id: "bC", ticker: "C", side: "buy" as const, qty: 1, price: 100, date: D.d1, source: MIRAE }] : []),
    ...(sc.two ? [{ id: "sC", ticker: "C", side: "sell" as const, qty: 1, price: p2, date: D.d2, estimated: true }] : []),
    { id: "sA", ticker: "A", side: "sell", qty: 1, price: p1, date: D.e, estimated: true },
    ...(sc.next?.txs ?? []).map((t) => ({ ...t, date: D.n })),
    ...(sc.later ?? []).flatMap((l) => l.txs.map((t) => ({ ...t, date: l.date }))),
  ];
  const deposit = sc.deficit ? 50 : sc.two ? 300 : 200;
  const flows: CashFlowInput[] = [{ date: D.d1, amount: deposit }, ...(sc.next?.flows ?? []).map((a) => ({ date: D.n, amount: a }))];
  return build("pension", txs.map((t) => toTx(t, "pension")), flows);
}

const retirement = (): Built =>
  build("retirement", [toTx({ id: "rb", ticker: "A", side: "buy", qty: 2, price: 100, date: D.d1, source: MIRAE }, "retirement")], [{ date: D.d1, amount: 500 }]);

const GRID = [0, 50, 100, 150, 200, 300];

function analyze(worlds: Built[], scope: AccountId[], period: PeriodId): PeriodResult[] {
  const inScope = worlds.filter((w) => scope.includes(w.accountId));
  return computeProfitAnalysis({
    valuations: inScope.flatMap((w) => w.valuations),
    coverages: inScope.map((w) => w.coverage),
    scopeAccountIds: scope,
    period,
    flows: inScope.flatMap((w) => w.flows),
    incomeSources: inScope.map((w) => ({ accountId: w.accountId, derived: w.derived, cap: null })),
    estimatedDays: estimatedExitDays(worlds.flatMap((w) => w.txs)),
  });
}
const at = (rs: PeriodResult[], key: string) => rs.find((r) => r.key === key);

/** 시나리오의 모든 격자점에서 한 구간을 돌려 결과 목록을 돌려준다 */
function grid(sc: Scenario, scope: AccountId[], period: PeriodId, key: string): PeriodResult[] {
  const out: PeriodResult[] = [];
  for (const p1 of GRID) {
    for (const p2 of sc.two ? GRID : [100]) {
      const worlds = [world(sc, p1, p2), retirement()];
      const r = at(analyze(worlds, scope, period), key);
      if (!r) throw new Error(`구간 없음: ${sc.name} ${period} ${key}`);
      out.push(r);
    }
  }
  return out;
}
const profits = (rs: PeriodResult[]) => [...new Set(rs.map((r) => r.knownProfit))];

const SCENARIOS: Scenario[] = [
  { name: "다음 날 외부 입금 (cutoff 가 청산일 — 다음 날은 cutoff 뒤)", next: { flows: [300] }, cancelsNext: true },
  { name: "다음 날 입금 + 같은 날 소액 매수 (cutoff 당일, 순증가)", next: { flows: [300], txs: [{ id: "n1", ticker: "A", side: "buy", qty: 1, price: 100 }] }, cancelsNext: true },
  { name: "다음 날 매수 250 (cutoff 당일, 새 최저점)", next: { txs: [{ id: "n1", ticker: "B", side: "buy", qty: 1, price: 250 }] }, cancelsNext: false },
  { name: "다음 날 소액 매수 30 (cutoff 당일, 새 최저점 — 안전해 보여도 입증 불가)", next: { txs: [{ id: "n1", ticker: "A", side: "buy", qty: 1, price: 30 }] }, cancelsNext: false },
  { name: "다음 날 외부 출금 + 같은 날 소액 매수 (cutoff 당일, 새 최저점)", next: { flows: [-300], txs: [{ id: "n1", ticker: "A", side: "buy", qty: 1, price: 100 }] }, cancelsNext: false },
  { name: "같은 날 매수·매도 순현금 0 (cutoff 당일, 최저점 유지)", next: { txs: [
    { id: "n1", ticker: "A", side: "buy", qty: 1, price: 100 }, { id: "n2", ticker: "A", side: "sell", qty: 1, price: 100 }] }, cancelsNext: true },
  { name: "결손이 먼저 있던 계좌 + 다음 날 입금", deficit: true, next: { flows: [300] }, cancelsNext: true },
  { name: "결손이 먼저 있던 계좌 + 다음 날 입금·소액 매수 (cutoff 당일)", deficit: true, next: { flows: [300], txs: [{ id: "n1", ticker: "A", side: "buy", qty: 1, price: 100 }] }, cancelsNext: true },
  { name: "추정 두 번 + 다음 날 입금", two: true, next: { flows: [300] }, cancelsNext: true },
  { name: "추정 두 번 + 다음 날 입금·소액 매수 (cutoff 당일)", two: true, next: { flows: [300], txs: [{ id: "n1", ticker: "A", side: "buy", qty: 1, price: 100 }] }, cancelsNext: true },
  { name: "추정 두 번 + 다음 날 매수 250", two: true, next: { txs: [{ id: "n1", ticker: "B", side: "buy", qty: 1, price: 250 }] }, cancelsNext: false },
  { name: "추정 두 번 + 같은 날 매도 C·매수 B (순 −150)", two: true, next: { txs: [
    { id: "n1", ticker: "B", side: "buy", qty: 1, price: 250 }, { id: "n2", ticker: "A", side: "buy", qty: 1, price: 100 }] }, cancelsNext: false },
];

describe("구간 [10-06] — 청산(10-05) 바로 다음 날 (cutoff 다음 날 / cutoff 당일)", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      for (const scope of [["pension"], ["pension", "retirement"]] as AccountId[][]) {
        const rs = grid(sc, scope, "daily", D.n);
        if (sc.cancelsNext) {
          // soundness: 입증됐다면 어떤 청산대금 가정에서도 손익이 같다
          expect(profits(rs)).toHaveLength(1);
          for (const r of rs) {
            expect(r.estimated).toBe(false);
            expect(r.denominatorEstimated).toBe(true);
            expect(r.exact).toBe(false);
            expect(confirmedBarValue(r, "amount")).toBe(r.knownProfit);
          }
        } else {
          // fail-closed: 입증하지 못하면 손익이 우연히 같더라도 참고값이다
          for (const r of rs) {
            expect(r.estimated).toBe(true);
            expect(r.denominatorEstimated).toBe(false);
            expect(r.estimateReasons).toContain("cash_error_not_cancelled");
            expect(confirmedBarValue(r, "amount")).toBeNull();
            expect(confirmedBarValue(r, "pct")).toBeNull();
          }
        }
      }
    });
  }

  it("입증 불가 구간 중 일부는 실제로 청산대금에 따라 손익이 달라진다 (매수 250 → incomeLB, fail-closed 가 필요한 이유)", () => {
    const sc = SCENARIOS.find((s) => s.name.startsWith("다음 날 매수 250"))!;
    expect(profits(grid(sc, ["pension"], "daily", D.n)).length).toBeGreaterThan(1);
  });

  it("cutoff 뒤 구간은 시나리오와 무관하게 입증되고 손익이 청산대금과 무관하다 (일간 10-07·11-02, 월간 11월)", () => {
    for (const sc of SCENARIOS.filter((s) => !s.later)) {
      for (const [period, key] of [["daily", D.n2], ["daily", D.m1], ["monthly", "2026-11"]] as [PeriodId, string][]) {
        for (const scope of [["pension"], ["pension", "retirement"]] as AccountId[][]) {
          const rs = grid(sc, scope, period, key);
          expect(profits(rs)).toHaveLength(1);
          expect(rs.every((r) => !r.estimated && r.denominatorEstimated)).toBe(true);
        }
      }
    }
  });
});

describe("구간 시작일·종료일의 포함 관계, cutoff 를 가로지르는 구간", () => {
  // 입금(10-06) 후 11-02 에 원장 이벤트가 있어 cutoff 가 11-02 가 된다.
  const dep = { flows: [300] };
  const ok: Scenario = { name: "straddle-ok", next: dep, later: [{ date: D.m1, txs: [{ id: "l1", ticker: "A", side: "buy", qty: 1, price: 100 }] }], cancelsNext: true };
  const bad: Scenario = { name: "straddle-bad", next: dep, later: [{ date: D.m1, txs: [{ id: "l1", ticker: "B", side: "buy", qty: 1, price: 450 }] }], cancelsNext: false };
  const closeDayBad: Scenario = { name: "close-day-bad", next: dep, later: [{ date: D.m2, txs: [{ id: "l1", ticker: "B", side: "buy", qty: 1, price: 450 }] }], cancelsNext: false };

  it("시작일(11-02)에 새 최저점이 없으면(월간 11월은 cutoff 11-02 를 가로지른다) 입증되고 손익이 같다", () => {
    const rs = grid(ok, ["pension"], "monthly", "2026-11");
    expect(profits(rs)).toHaveLength(1);
    expect(rs.every((r) => !r.estimated && r.denominatorEstimated)).toBe(true);
  });

  it("시작일(11-02)에 새 최저점이 있으면 (포함 관계: 시작일 이벤트도 구간에 든다) 입증 불가", () => {
    for (const r of grid(bad, ["pension"], "monthly", "2026-11")) {
      expect(r.estimated).toBe(true);
      expect(r.estimateReasons).toContain("cash_error_not_cancelled");
    }
  });

  it("종료일(11-03)의 새 최저점도 구간에 포함된다 → 월간 11월은 입증 불가", () => {
    for (const r of grid(closeDayBad, ["pension"], "monthly", "2026-11")) {
      expect(r.estimated).toBe(true);
      expect(r.estimateReasons).toContain("cash_error_not_cancelled");
    }
  });

  it("종료일 뒤(11-03)의 이벤트는 11-02 하루 구간에 들지 않는다 → 입증되고 손익이 같다", () => {
    const rs = grid(closeDayBad, ["pension"], "daily", D.m1);
    expect(profits(rs)).toHaveLength(1);
    expect(rs.every((r) => !r.estimated && r.denominatorEstimated)).toBe(true);
  });

  it("연간 2026 은 청산을 포함하므로 어떤 시나리오에서도 estimated 이다", () => {
    for (const r of grid(ok, ["pension"], "yearly", "2026")) expect(r.estimated).toBe(true);
  });
});

describe("다른 계좌·scope 불변", () => {
  it("추정이 없는 계좌의 단독 scope 는 연금저축 시나리오와 무관하게 결과가 같다", () => {
    const sc = SCENARIOS[2];
    const a = analyze([world(sc, 100, 100), retirement()], ["retirement"], "daily");
    const b = analyze([world(sc, 0, 100), retirement()], ["retirement"], "daily");
    expect(a).toEqual(b);
    expect(a.every((r) => !r.estimated && !r.denominatorEstimated)).toBe(true);
  });
});
