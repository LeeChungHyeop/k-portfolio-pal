// 추정 거래 provenance — 식별, 불확실 창의 시작 근거, 그리고 완성된 valuation 위의 구간 판정/막대 값(0% vs null)
//
// 현금 생성 경로(buildDerivedCash → buildCashSeries → valuateAccountDays)를 직접 쓰는 회귀는
// estimate-cash-path.test.ts 에 있다.
import { describe, it, expect } from "vitest";
import type { AccountId } from "./constants";
import type { LedgerTransaction, TransactionCorrection } from "./ledger";
import { estimatedExitDays } from "./estimate-provenance";
import {
  computeProfitAnalysis,
  confirmedBarValue,
  type AccountDayValuation,
} from "./profit-analysis";
import type { AccountCoverage } from "./ledger-coverage";

const PROXY = "user_attested_liquidation_price_proxy";
const MIRAE = "miraeasset_capture_qty_price_reconstructed";
const KIS = "kis_api_daily_ccld";

function tx(over: Partial<LedgerTransaction>): LedgerTransaction {
  return {
    id: "t", accountId: "pension", ticker: "360750", etfName: "TIGER 미국S&P500", side: "sell",
    quantity: 1, price: 1000, amount: 1000, tradeDate: null, settlementDate: null, inferredTradeDate: null,
    eventDate: "2026-10-13", tradeDateEvidence: "exact-sale-date-unknown", fee: null, tax: null,
    postQuantity: null, source: PROXY, ...over,
  };
}
const buy = (over: Partial<LedgerTransaction>) =>
  tx({ side: "buy", source: MIRAE, tradeDate: over.eventDate ?? "2026-10-02", tradeDateEvidence: "broker-order-date", ...over });

describe("estimatedExitDays — 추정 청산 식별", () => {
  it("가격 대용 추정 매도만 식별하고, 날짜 미확인 사유를 함께 남긴다 (같은 날 두 종목은 한 날짜)", () => {
    const days = estimatedExitDays([tx({ id: "a", ticker: "360750" }), tx({ id: "b", ticker: "367380" })]);
    expect(days).toEqual([
      {
        accountId: "pension", date: "2026-10-13",
        reasons: ["exit_price_proxy", "exit_date_unconfirmed"], windowStart: null,
      },
    ]);
  });

  it("실제 체결(KIS 매수)·미래에셋 일반 체결은 추정으로 격하하지 않는다", () => {
    const days = estimatedExitDays([
      tx({ id: "k", side: "buy", source: KIS, tradeDate: "2026-10-14", eventDate: "2026-10-14" }),
      tx({ id: "m", source: MIRAE, eventDate: "2026-10-02" }),
    ]);
    expect(days).toEqual([]);
  });

  it("보고된 매도일이 있으면 날짜 미확인 사유를 붙이지 않는다 (가격 추정 사유만, 창은 그 날 하나)", () => {
    const days = estimatedExitDays([tx({ id: "a", tradeDate: "2026-10-13" })]);
    expect(days[0].reasons).toEqual(["exit_price_proxy"]);
    expect(days[0].windowStart).toBe("2026-10-13");
  });

  it("사용자가 제외한 거래는 보지 않고, 정정된 실효 거래일을 따른다", () => {
    const corr = new Map<string, TransactionCorrection>([
      ["x", { transactionId: "x", excluded: true } as TransactionCorrection],
      ["y", { transactionId: "y", correctedTradeDate: "2026-10-14" } as TransactionCorrection],
    ]);
    const days = estimatedExitDays([tx({ id: "x" }), tx({ id: "y", ticker: "367380" })], corr);
    expect(days.map((d) => d.date)).toEqual(["2026-10-14"]);
  });
});

describe("estimatedExitDays — 불확실 창의 시작은 '매도 종목의 보유를 확인한 근거'다", () => {
  const sell = (over: Partial<LedgerTransaction> = {}) => tx({ id: "s", ticker: "AAA", quantity: 10, ...over });

  it("같은 종목의 직전 비추정 거래가 수량까지 확인하면 시작점이 된다. 같은 날 보유(종가)는 입증되지 않아 그 날 자체가 창에 든다", () => {
    const d = estimatedExitDays([buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02" }), sell()]);
    expect(d[0].windowStart).toBe("2026-10-02"); // postQuantity 없음 → 10-02 종가 보유는 미입증
  });

  it("증권사가 보고한 거래 후 보유수량(postQuantity)이 있으면 그 날 종가 보유까지 입증 — 창은 다음 날부터", () => {
    const d = estimatedExitDays([
      buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02", postQuantity: 10 }), sell(),
    ]);
    expect(d[0].windowStart).toBe("2026-10-03");
  });

  it("postQuantity 가 매도 수량보다 작으면 종가 보유를 입증하지 못한다", () => {
    const d = estimatedExitDays([
      buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02", postQuantity: 4 }), sell(),
    ]);
    expect(d[0].windowStart).toBe("2026-10-02");
  });

  it("★ 반례: 다른 종목의 거래는 매도 종목의 보유를 확인하지 못한다 — 창이 좁아지지 않는다", () => {
    const only = estimatedExitDays([buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02" }), sell()]);
    const withOther = estimatedExitDays([
      buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02" }),
      buy({ id: "o", ticker: "ZZZ", quantity: 5, eventDate: "2026-10-09", postQuantity: 5 }), // 다른 종목, 더 늦은 거래
      sell(),
    ]);
    expect(only[0].windowStart).toBe("2026-10-02");
    expect(withOther[0].windowStart).toBe("2026-10-02");
  });

  it("보유 수량이 매도 수량에 못 미치는 거래는 근거가 아니다 — 더 이른, 수량을 확인하는 거래를 찾는다", () => {
    const d = estimatedExitDays([
      buy({ id: "b1", ticker: "AAA", quantity: 10, eventDate: "2026-09-20" }),
      // 10-01 에 일부를 팔아 보유가 4주로 줄었다 → 10주 매도를 확인하지 못한다
      tx({ id: "p", ticker: "AAA", side: "sell", quantity: 6, source: MIRAE, tradeDate: "2026-10-01", eventDate: "2026-10-01", tradeDateEvidence: "broker-order-date" }),
      sell(),
    ]);
    // 10-01 시점 보유 4주 < 10 → 근거 아님. 9-20(보유 10주) 이 근거 (종가 미입증 → 그 날부터)
    expect(d[0].windowStart).toBe("2026-09-20");
  });

  it("매도 종목 중 하나라도 근거가 없으면 시작을 알 수 없다(null) — 창을 줄이지 않는다", () => {
    const d = estimatedExitDays([
      buy({ id: "b", ticker: "AAA", quantity: 10, eventDate: "2026-10-02" }),
      tx({ id: "s1", ticker: "AAA", quantity: 10 }),
      tx({ id: "s2", ticker: "BBB", quantity: 3 }), // BBB 의 비추정 거래가 없다
    ]);
    expect(d[0].windowStart).toBeNull();
  });

  it("여러 종목이면 가장 이른 근거가 시작점이다 (가장 불확실한 종목 기준)", () => {
    const d = estimatedExitDays([
      buy({ id: "a", ticker: "AAA", quantity: 10, eventDate: "2026-10-09" }),
      buy({ id: "b", ticker: "BBB", quantity: 3, eventDate: "2026-10-02" }),
      tx({ id: "s1", ticker: "AAA", quantity: 10 }),
      tx({ id: "s2", ticker: "BBB", quantity: 3 }),
    ]);
    expect(d[0].windowStart).toBe("2026-10-02");
  });

  it("추정 거래·제외된 거래·다른 계좌의 거래는 근거가 아니다", () => {
    const corr = new Map<string, TransactionCorrection>([
      ["ex", { transactionId: "ex", excluded: true } as TransactionCorrection],
    ]);
    const d = estimatedExitDays(
      [
        buy({ id: "ex", ticker: "AAA", quantity: 10, eventDate: "2026-10-09" }), // 제외됨
        buy({ id: "isa", accountId: "isa", ticker: "AAA", quantity: 10, eventDate: "2026-10-08" }), // 다른 계좌
        tx({ id: "est", ticker: "AAA", side: "buy", quantity: 10, eventDate: "2026-10-07" }), // 추정 거래
        sell(),
      ],
      corr,
    );
    expect(d.find((x) => x.date === "2026-10-13")!.windowStart).toBeNull();
  });
});

// ── 완성된 valuation 위의 구간 판정 ─────────────────────────────────────────
// (현금 경로 없이 valuation 을 직접 넘긴다 — derived 가 없으므로 '상쇄 입증'은 불가능하다)

const cov = (id: string): AccountCoverage => ({
  accountId: id as AccountId, inception: "2026-10-01", strategyStart: "2026-10-01",
  performanceStart: "2026-10-01", strategyStartIsTransition: false, seam: null, ledgerCutoff: null, anchorDates: [],
});
const val = (date: string, accountId: string, vOpen: number, vClose: number): AccountDayValuation => ({
  date, accountId, vOpen, vClose, term1: vClose - vOpen, term2: 0, costs: 0,
  holdingsSource: "ledger", cashQuality: "derived", usable: true, missing: [],
});
const DATES = [
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
  "2026-11-02", "2026-11-03",
];
const valuations: AccountDayValuation[] = DATES.flatMap((d) => [
  val(d, "pension", 10_000_000, 10_100_000),
  val(d, "retirement", 70_000_000, 70_700_000),
]);
const estimatedDays = estimatedExitDays([
  buy({ id: "m", ticker: "360750", quantity: 1, eventDate: "2026-10-02" }),
  tx({ id: "a" }), // 360750 1주 추정 매도 — 10-02 거래가 근거 (종가 미입증 → 창은 10-02 부터)
  tx({ id: "k", side: "buy", source: KIS, tradeDate: "2026-10-14", eventDate: "2026-10-14" }),
]);
const base = {
  coverages: [cov("pension"), cov("retirement")],
  flows: [] as { date: string; amount: number }[],
  incomeSources: [] as { accountId: string; derived: never; cap: number | null }[],
};
type Period = "daily" | "monthly" | "yearly";
const run = (scope: string[], period: Period, withEst = true, vals = valuations) =>
  computeProfitAnalysis({
    ...base, valuations: vals, scopeAccountIds: scope, period, estimatedDays: withEst ? estimatedDays : undefined,
  });
const byKey = (rs: ReturnType<typeof run>) => Object.fromEntries(rs.map((r) => [r.key, r]));

describe("computeProfitAnalysis — 추정 청산 provenance (valuation 직접 입력)", () => {
  it("추정 청산일 당일: 가격·날짜 사유가 모두 붙고 exact=false", () => {
    const r = byKey(run(["pension"], "daily"))["2026-10-13"];
    expect(r.estimated).toBe(true);
    expect(r.exact).toBe(false);
    expect(r.estimateReasons).toEqual(["exit_price_proxy", "exit_date_unconfirmed"]);
    expect(r.estimatedDates).toEqual(["2026-10-13"]);
  });

  it("실제 매도일이 불확실한 창 [10-02, 10-13] 의 일간 구간은 estimated(날짜 사유). 창 이전은 영향 없다", () => {
    const d = byKey(run(["pension"], "daily"));
    for (const k of ["2026-10-02", "2026-10-05", "2026-10-12"]) {
      expect(d[k].estimated).toBe(true);
      expect(d[k].estimateReasons).toEqual(["exit_date_unconfirmed"]);
    }
    expect(d["2026-10-01"].estimated).toBe(false);
    expect(d["2026-10-01"].exact).toBe(true);
  });

  it("★ 상쇄를 입증할 수 없으면(현금 경로 없음) 추정일 뒤 구간도 손익이 참고값이다 — '분모만 추정'으로 두지 않는다", () => {
    const r = byKey(run(["pension"], "daily"))["2026-10-14"];
    expect(r.estimated).toBe(true);
    expect(r.denominatorEstimated).toBe(false);
    expect(r.estimateReasons).toEqual(["cash_error_not_cancelled"]);
    expect(r.exact).toBe(false);
    expect(confirmedBarValue(r, "amount")).toBeNull();
    expect(confirmedBarValue(r, "pct")).toBeNull();
    expect(r.knownProfit).toBe(100_000); // 참고값 자체는 지우거나 보정하지 않는다
  });

  it("다른 계좌 scope 는 어떤 provenance 도 받지 않는다 (불변)", () => {
    for (const p of ["daily", "monthly", "yearly"] as const) {
      expect(
        run(["retirement"], p).every((r) => !r.estimated && !r.denominatorEstimated && r.exact),
      ).toBe(true);
    }
  });

  it("전체 scope 는 연금저축 단독과 같은 날짜 판정을 따른다", () => {
    const one = byKey(run(["pension"], "daily"));
    const all = byKey(run(["pension", "retirement"], "daily"));
    for (const k of Object.keys(one)) {
      expect(all[k].estimated).toBe(one[k].estimated);
      expect(all[k].estimateReasons).toEqual(one[k].estimateReasons);
    }
  });

  it("estimatedDays 를 주지 않으면 기존 계산과 숫자가 완전히 같다 (손익·수익률·분모 불변)", () => {
    const strip = (rs: ReturnType<typeof run>) =>
      rs.map(({ estimated, denominatorEstimated, estimateReasons, estimatedDates, exact, partial, ...n }) => n);
    for (const p of ["daily", "monthly", "yearly"] as const) {
      expect(strip(run(["pension", "retirement"], p, true))).toEqual(strip(run(["pension", "retirement"], p, false)));
      expect(run(["pension"], p, false).every((r) => r.exact && !r.estimated && !r.denominatorEstimated)).toBe(true);
    }
  });
});

describe("confirmedBarValue — 0% 와 null 의 구분", () => {
  const days = byKey(run(["pension"], "daily"));

  it("추정 포함 구간은 두 metric 모두 null (0 이 아니다) — 참고값은 지워지지 않는다", () => {
    expect(confirmedBarValue(days["2026-10-13"], "pct")).toBeNull();
    expect(confirmedBarValue(days["2026-10-13"], "amount")).toBeNull();
    expect(days["2026-10-13"].returnPctLow).not.toBeNull();
    expect(days["2026-10-13"].knownProfit).toBe(100_000);
  });

  it("확정 구간은 값을 그대로 낸다", () => {
    expect(confirmedBarValue(days["2026-10-01"], "pct")).toBeCloseTo(1, 6);
    expect(confirmedBarValue(days["2026-10-01"], "amount")).toBe(100_000);
  });

  it("실제 계산 결과 0% 는 0 으로 남는다", () => {
    const flat = computeProfitAnalysis({
      ...base,
      valuations: ["2026-10-01", "2026-10-02"].map((d) => val(d, "pension", 5_000_000, 5_000_000)),
      scopeAccountIds: ["pension"], period: "daily",
    });
    expect(confirmedBarValue(flat[0], "pct")).toBe(0);
    expect(confirmedBarValue(flat[0], "amount")).toBe(0);
  });

  it("계산 불가(분모 0 이하)는 null 이다 — 0% 로 바뀌지 않는다", () => {
    const empty = computeProfitAnalysis({
      ...base,
      valuations: ["2026-10-01", "2026-10-02"].map((d) => val(d, "pension", 0, 0)),
      scopeAccountIds: ["pension"], period: "daily",
    });
    expect(empty[0].returnPctLow).toBeNull();
    expect(confirmedBarValue(empty[0], "pct")).toBeNull();
  });

  it("막대로 쓰이는 값의 합에는 추정 포함 구간의 참고값이 들어가지 않는다", () => {
    const rs = run(["pension"], "daily");
    const bars = rs.map((r) => confirmedBarValue(r, "amount")).filter((v): v is number => v !== null);
    const confirmedSum = rs.filter((r) => !r.estimated).reduce((a, r) => a + r.knownProfit, 0);
    expect(bars.reduce((a, b) => a + b, 0)).toBe(confirmedSum);
    expect(bars.length).toBeLessThan(rs.length);
  });
});
