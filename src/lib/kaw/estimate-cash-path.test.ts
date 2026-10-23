// 추정 청산대금의 오차가 이후 손익으로 번지는가 — 실제 현금 생성 경로로 검증한다.
//
//   buildDerivedCash → buildCashSeries → valuateAccountDays → computeProfitAnalysis
//
// 완성된 valuation 에 ε 를 더하는 방식은 쓰지 않는다. 그 방식은 파생 예수금의 running-min(incomeLB)을
// 거치지 않아서, 청산대금 오차가 미래 손익에 번지는 경로를 놓친다.
import { describe, it, expect } from "vitest";
import type { AccountId } from "./constants";
import { replayDailyHoldings, type LedgerTransaction } from "./ledger";
import type { AccountCoverage } from "./ledger-coverage";
import { buildAccountTimeline } from "./holdings-timeline";
import { buildDerivedCash, flowEffectiveDate, type CashFlowInput } from "./derived-cash";
import {
  buildCashSeries,
  cashErrorCancels,
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

const DATES = [
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06",
  "2026-11-02", "2026-11-03", "2027-01-04", "2027-01-05",
];
const LIB = [
  { defaultEtf: "ETF-A", ticker: "A" },
  { defaultEtf: "ETF-B", ticker: "B" },
];
// A: 항상 100. B: 10월 250, 이후 오른다 (시가 ≠ 종가라 미래 구간에 실제 손익이 생긴다)
const bars: PriceBarsByTicker = {
  A: Object.fromEntries(DATES.map((d) => [d, { open: 100, close: 100 }])),
  B: Object.fromEntries(
    DATES.map((d) => [
      d,
      d.startsWith("2026-10") ? { open: 250, close: 250 }
        : d === "2026-11-02" ? { open: 250, close: 260 }
        : d === "2026-11-03" ? { open: 260, close: 270 }
        : d === "2027-01-04" ? { open: 270, close: 280 }
        : { open: 280, close: 290 },
    ]),
  ),
};

type Tx = Partial<LedgerTransaction> & Pick<LedgerTransaction, "id" | "ticker" | "side" | "quantity" | "price" | "eventDate">;
const mk = (t: Tx, accountId: AccountId): LedgerTransaction => ({
  accountId, etfName: `ETF-${t.ticker}`, amount: Math.round(t.quantity * t.price), tradeDate: t.eventDate,
  settlementDate: null, inferredTradeDate: null, tradeDateEvidence: "broker-order-date", fee: 0, tax: 0,
  postQuantity: null, source: MIRAE, ...t,
});

interface Built {
  accountId: AccountId;
  coverage: AccountCoverage;
  derived: ReturnType<typeof buildDerivedCash>;
  valuations: ReturnType<typeof valuateAccountDays>;
  flows: { date: string; amount: number }[];
  txs: LedgerTransaction[];
}

/** 한 계좌의 거래·흐름으로 현금 경로부터 valuation 까지 실제 파이프라인을 돌린다 */
function build(
  accountId: AccountId,
  txs: LedgerTransaction[],
  rawFlows: CashFlowInput[],
  history: { date: string; rowQuantitiesSnap: Record<string, number>; rowEtfSnap: Record<string, string> }[] = [],
): Built {
  const cutoff = txs.map((t) => t.eventDate).sort().pop() ?? null;
  const coverage: AccountCoverage = {
    accountId, inception: "2026-10-01", strategyStart: "2026-10-01", performanceStart: "2026-10-01",
    strategyStartIsTransition: false, seam: null, ledgerCutoff: cutoff, anchorDates: history.map((h) => h.date),
  };
  const derived = buildDerivedCash({
    flows: rawFlows,
    trades: txs.map((t) => ({ date: t.eventDate, side: t.side, amount: t.amount, fee: t.fee, tax: t.tax })),
    tradingDates: DATES,
  });
  const days = buildAccountTimeline(
    { accountId, coverage, ledgerDays: replayDailyHoldings(txs)[accountId] ?? [], history },
    LIB, DATES,
  );
  const cash = buildCashSeries({ accountId, coverage, derived, flows: rawFlows, tradingDates: DATES }, days, bars);
  const flows = rawFlows
    .map((f) => ({ date: flowEffectiveDate(DATES, f), amount: f.amount }))
    .filter((f): f is { date: string; amount: number } => !!f.date);
  return { accountId, coverage, derived, valuations: valuateAccountDays(days, cash, bars), flows, txs };
}

/**
 * 연금저축형 시나리오 — 이전 현금 100 → 추정 청산 → 다음 날 사건.
 *   10-01 입금 200, A 1주 매수(100)            → 현금 100 (= "이전 현금 100")
 *   10-05 A 1주 추정 매도, 대금 = proceeds      → (100 또는 200)
 *   10-06 variant 'buy250': B 1주 250 매수 / 'deposit': 외부 입금 300
 * 가격변동·비용 0 (A 는 항상 100).
 */
function pensionWorld(proceeds: number, variant: "buy250" | "deposit"): Built {
  const txs = [
    mk({ id: "ba", ticker: "A", side: "buy", quantity: 1, price: 100, eventDate: "2026-10-01" }, "pension"),
    mk({
      id: "sa", ticker: "A", side: "sell", quantity: 1, price: proceeds, eventDate: "2026-10-05",
      source: PROXY, tradeDate: null, tradeDateEvidence: "exact-sale-date-unknown",
    }, "pension"),
    ...(variant === "buy250"
      ? [mk({ id: "bb", ticker: "B", side: "buy", quantity: 1, price: 250, eventDate: "2026-10-06", source: KIS }, "pension")]
      // 'deposit': 원장이 그 뒤(11-02)까지 이어지므로 10-06 은 cutoff 앞의 원장 구간이다 → 경우 (b) 를 탄다
      : [mk({ id: "bc", ticker: "A", side: "buy", quantity: 1, price: 100, eventDate: "2026-11-02", source: KIS }, "pension")]),
  ];
  const flows: CashFlowInput[] = [{ date: "2026-10-01", amount: 200 }];
  if (variant === "deposit") flows.push({ date: "2026-10-06", amount: 300 });
  const history = variant === "buy250"
    ? [{ date: "2026-10-06", rowQuantitiesSnap: { r: 1 }, rowEtfSnap: { r: "ETF-B" } }]
    : [];
  return build("pension", txs, flows, history);
}

/** 추정이 없는 다른 계좌 */
function retirementWorld(): Built {
  return build(
    "retirement",
    [mk({ id: "rb", ticker: "A", side: "buy", quantity: 2, price: 100, eventDate: "2026-10-01" }, "retirement")],
    [{ date: "2026-10-01", amount: 500 }],
    [{ date: "2026-10-01", rowQuantitiesSnap: { r: 2 }, rowEtfSnap: { r: "ETF-A" } }],
  );
}

function analyze(
  worlds: Built[], scope: AccountId[], period: PeriodId, withEstimates = true,
): PeriodResult[] {
  const inScope = worlds.filter((w) => scope.includes(w.accountId));
  return computeProfitAnalysis({
    valuations: inScope.flatMap((w) => w.valuations),
    coverages: inScope.map((w) => w.coverage),
    scopeAccountIds: scope,
    period,
    flows: inScope.flatMap((w) => w.flows),
    incomeSources: inScope.map((w) => ({ accountId: w.accountId, derived: w.derived, cap: null })),
    estimatedDays: withEstimates ? estimatedExitDays(worlds.flatMap((w) => w.txs)) : undefined,
  });
}
const at = (rs: PeriodResult[], key: string) => rs.find((r) => r.key === key)!;

describe("★ 반례: 청산대금 가정에 따라 다음 날 손익이 달라진다 → '분모만 추정·손익 확정'이면 안 된다", () => {
  const w100 = pensionWorld(100, "buy250");
  const w200 = pensionWorld(200, "buy250");

  it("실제 현금 경로에서 모델 손익은 대금 100 이면 +50, 200 이면 0 이다 (incomeLB 가 달라진다)", () => {
    expect(w100.derived.byDate.get("2026-10-06")).toMatchObject({ derived: -50, incomeLB: 50, cash: 0 });
    expect(w200.derived.byDate.get("2026-10-06")).toMatchObject({ derived: 50, incomeLB: 0, cash: 50 });
    const p100 = at(analyze([w100], ["pension"], "daily", false), "2026-10-06");
    const p200 = at(analyze([w200], ["pension"], "daily", false), "2026-10-06");
    expect(p100.knownProfit).toBe(50);
    expect(p200.knownProfit).toBe(0);
  });

  it("두 세계 모두 다음 날 구간을 '손익 참고값'으로 표시한다 (denominatorEstimated 아님, cash_error_not_cancelled)", () => {
    for (const w of [w100, w200]) {
      const r = at(analyze([w], ["pension"], "daily"), "2026-10-06");
      expect(r.estimated).toBe(true);
      expect(r.denominatorEstimated).toBe(false);
      expect(r.estimateReasons).toContain("cash_error_not_cancelled");
      expect(r.exact).toBe(false);
      expect(confirmedBarValue(r, "amount")).toBeNull();
      expect(confirmedBarValue(r, "pct")).toBeNull();
    }
  });

  it("cashErrorCancels 도 같은 이유로 false: 청산 뒤 파생 예수금이 새 최저점을 만든다", () => {
    expect(cashErrorCancels(w100.derived, w100.coverage.ledgerCutoff, "2026-10-05", "2026-10-06", "2026-10-06")).toBe(false);
    expect(cashErrorCancels(w200.derived, w200.coverage.ledgerCutoff, "2026-10-05", "2026-10-06", "2026-10-06")).toBe(false);
  });
});

describe("상수 오차가 실제로 유지되는 정상 사례 — 입증되면 손익은 대금 가정과 무관하고 분모만 다르다", () => {
  it("(b) 청산 다음 날이 외부 입금이면 새 최저점이 없다: 두 세계의 손익이 같고 분모는 다르다", () => {
    const w100 = pensionWorld(100, "deposit");
    const w200 = pensionWorld(200, "deposit");
    const a = at(analyze([w100], ["pension"], "daily"), "2026-10-06");
    const b = at(analyze([w200], ["pension"], "daily"), "2026-10-06");
    expect(cashErrorCancels(w100.derived, w100.coverage.ledgerCutoff, "2026-10-05", "2026-10-06", "2026-10-06")).toBe(true);
    expect(a.knownProfit).toBe(0);
    expect(b.knownProfit).toBe(a.knownProfit); // 손익 불변
    expect(b.averageCapital).not.toBe(a.averageCapital); // 분모만 다르다
    for (const r of [a, b]) {
      expect(r.estimated).toBe(false);
      expect(r.denominatorEstimated).toBe(true);
      expect(r.exact).toBe(false);
      expect(confirmedBarValue(r, "amount")).toBe(0); // 실제 0 은 0 이다
    }
  });

  it("(a) 원장 cutoff 뒤 구간(일간·월간·연간)은 대금 가정과 무관하다: 손익 같음, 분모 다름, denominatorEstimated", () => {
    const w100 = pensionWorld(100, "buy250");
    const w200 = pensionWorld(200, "buy250");
    const cases: [PeriodId, string][] = [["daily", "2026-11-03"], ["monthly", "2026-11"], ["yearly", "2027"]];
    for (const [period, key] of cases) {
      const a = at(analyze([w100], ["pension"], period), key);
      const b = at(analyze([w200], ["pension"], period), key);
      expect(a.estimated).toBe(false);
      expect(a.denominatorEstimated).toBe(true);
      expect(a.knownProfit).toBeGreaterThan(0);
      expect(b.knownProfit).toBe(a.knownProfit);
      expect(b.averageCapital).toBe(a.averageCapital + 50); // 시작 예수금 0 대 50 — 상수 오차가 유지된다
      expect(confirmedBarValue(a, "amount")).toBe(a.knownProfit);
    }
  });
});

describe("구간 경계와 scope", () => {
  const pension = pensionWorld(100, "buy250");
  const retirement = retirementWorld();

  it("월간·연간: 청산이 들어 있는 10월은 estimated, 그 뒤 11월·2027 은 입증되어 분모만 추정", () => {
    const m = analyze([pension], ["pension"], "monthly");
    expect(at(m, "2026-10").estimated).toBe(true);
    expect(at(m, "2026-11").denominatorEstimated).toBe(true);
    const y = analyze([pension], ["pension"], "yearly");
    expect(at(y, "2026").estimated).toBe(true);
    expect(at(y, "2027").denominatorEstimated).toBe(true);
    expect(at(y, "2027").estimated).toBe(false);
  });

  it("전체 scope 는 연금저축이 걸린 구간에서만 표시하고, 단독 scope 와 같은 판정이다", () => {
    for (const p of ["daily", "monthly", "yearly"] as const) {
      const one = analyze([pension, retirement], ["pension"], p);
      const all = analyze([pension, retirement], ["pension", "retirement"], p);
      for (const r of one) {
        const a = at(all, r.key);
        expect(a.estimated).toBe(r.estimated);
        expect(a.denominatorEstimated).toBe(r.denominatorEstimated);
        expect(a.estimateReasons).toEqual(r.estimateReasons);
      }
    }
  });

  it("추정이 없는 계좌의 단독 scope 는 추정 정보를 줘도 안 줘도 결과가 완전히 같다", () => {
    for (const p of ["daily", "monthly", "yearly"] as const) {
      const withEst = analyze([pension, retirement], ["retirement"], p, true);
      const without = analyze([retirement], ["retirement"], p, false);
      expect(withEst).toEqual(without);
      expect(withEst.every((r) => !r.estimated && !r.denominatorEstimated)).toBe(true);
    }
  });

  it("추정 정보를 빼면 숫자(손익·수익률·분모)는 그대로다 — 원본 금액을 보정하지 않는다", () => {
    const strip = (rs: PeriodResult[]) =>
      rs.map(({ estimated, denominatorEstimated, estimateReasons, estimatedDates, exact, partial, ...n }) => n);
    for (const p of ["daily", "monthly", "yearly"] as const) {
      expect(strip(analyze([pension], ["pension"], p, true))).toEqual(strip(analyze([pension], ["pension"], p, false)));
    }
  });
});

describe("cashErrorCancels — 입증하지 못하면 false", () => {
  const w = pensionWorld(100, "deposit");
  it("현금 경로가 없거나 추정일이 경로에 없으면 입증할 수 없다", () => {
    expect(cashErrorCancels(undefined, null, "2026-10-05", "2026-10-06", "2026-10-06")).toBe(false);
    expect(cashErrorCancels(w.derived, null, "2026-09-01", "2026-10-06", "2026-10-06")).toBe(false);
  });
  it("구간 안에 현금 이벤트가 없으면 현금이 그대로이므로 상쇄된다", () => {
    expect(cashErrorCancels(w.derived, null, "2026-10-05", "2026-10-07", "2026-10-09")).toBe(true);
  });
});
