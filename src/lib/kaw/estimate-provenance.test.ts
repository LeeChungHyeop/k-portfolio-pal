// 추정 거래 provenance — 수익 분석의 exact / estimated / denominatorEstimated 판정과 막대 값(0% vs null)
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

describe("estimatedExitDays — 추정 청산 식별", () => {
  it("가격 대용 추정 매도만 식별하고, 날짜 미확인 사유를 함께 남긴다 (같은 날 두 종목은 한 날짜)", () => {
    const days = estimatedExitDays([tx({ id: "a", ticker: "360750" }), tx({ id: "b", ticker: "367380" })]);
    expect(days).toEqual([
      {
        accountId: "pension", date: "2026-10-13",
        reasons: ["exit_price_proxy", "exit_date_unconfirmed"], windowFrom: null,
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

  it("보고된 매도일이 있으면 날짜 미확인 사유를 붙이지 않는다 (가격 추정 사유만, 불확실 창 없음)", () => {
    const days = estimatedExitDays([tx({ id: "a", tradeDate: "2026-10-13" })]);
    expect(days[0].reasons).toEqual(["exit_price_proxy"]);
    expect(days[0].windowFrom).toBe("2026-10-13");
  });

  it("불확실 창의 시작은 같은 계좌의 '추정이 아닌' 직전 원장 거래일이다 (다른 계좌·추정·이후 거래는 무관)", () => {
    const days = estimatedExitDays([
      tx({ id: "m1", source: MIRAE, eventDate: "2026-10-02", side: "buy" }),
      tx({ id: "m0", source: MIRAE, eventDate: "2026-09-25", side: "buy" }),
      tx({ id: "other", accountId: "isa", source: MIRAE, eventDate: "2026-10-09", side: "buy" }),
      tx({ id: "p" }),
      tx({ id: "k", side: "buy", source: KIS, tradeDate: "2026-10-14", eventDate: "2026-10-14" }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].windowFrom).toBe("2026-10-02");
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

// ── 구간 판정 ───────────────────────────────────────────────────────────────

const cov = (id: string): AccountCoverage => ({
  accountId: id as AccountId, inception: "2026-10-01", strategyStart: "2026-10-01",
  performanceStart: "2026-10-01", strategyStartIsTransition: false, seam: null, ledgerCutoff: null, anchorDates: [],
});
const val = (date: string, accountId: string, vOpen: number, vClose: number): AccountDayValuation => ({
  date, accountId, vOpen, vClose, term1: vClose - vOpen, term2: 0, costs: 0,
  holdingsSource: "ledger", cashQuality: "derived", usable: true, missing: [],
});
// 10-02: 마지막 확정 거래(미래에셋) / 10-13: 추정 청산 / 10-14: KIS 확정 매수
const DATES = [
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
  "2026-11-02", "2026-11-03",
];
const valuations: AccountDayValuation[] = DATES.flatMap((d) => [
  val(d, "pension", 10_000_000, 10_100_000),
  val(d, "retirement", 70_000_000, 70_700_000),
]);
const estimatedDays = estimatedExitDays([
  tx({ id: "m", side: "buy", source: MIRAE, eventDate: "2026-10-02" }),
  tx({ id: "a" }),
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

describe("computeProfitAnalysis — 손익 provenance 와 수익률(분모) provenance", () => {
  it("추정 청산일 당일: 가격·날짜 사유가 모두 붙고 exact=false", () => {
    const r = byKey(run(["pension"], "daily"))["2026-10-13"];
    expect(r.estimated).toBe(true);
    expect(r.exact).toBe(false);
    expect(r.estimateReasons).toEqual(["exit_price_proxy", "exit_date_unconfirmed"]);
    expect(r.estimatedDates).toEqual(["2026-10-13"]);
  });

  it("실제 매도일이 불확실한 창 (10-02, 10-13] 의 일간 구간은 보유 노출이 불확실해 estimated — 날짜 사유만", () => {
    const d = byKey(run(["pension"], "daily"));
    for (const k of ["2026-10-05", "2026-10-12"]) {
      expect(d[k].estimated).toBe(true);
      expect(d[k].exact).toBe(false);
      expect(d[k].estimateReasons).toEqual(["exit_date_unconfirmed"]);
    }
    // 창이 시작되기 전(마지막 확정 거래일까지)은 영향 없음 — 무조건 번지지 않는다
    for (const k of ["2026-10-01", "2026-10-02"]) {
      expect(d[k].estimated).toBe(false);
      expect(d[k].denominatorEstimated).toBe(false);
      expect(d[k].exact).toBe(true);
    }
  });

  it("2026-10-14: KIS 확정 매수일 — 손익은 확정(estimated=false), 분모만 추정, exact=false", () => {
    const r = byKey(run(["pension"], "daily"))["2026-10-14"];
    expect(r.estimated).toBe(false);
    expect(r.denominatorEstimated).toBe(true);
    expect(r.exact).toBe(false); // 원장이 정확하다는 이유로 exact 가 되지 않는다
    expect(r.estimateReasons).toEqual([]);
    expect(confirmedBarValue(r, "amount")).toBe(100_000); // 손익 막대는 그대로 그린다
    expect(confirmedBarValue(r, "pct")).not.toBeNull();
  });

  it("예수금의 상수 오차는 손익에서 상쇄되고 분모에만 들어간다 (손익 불변, 분모·수익률만 변함)", () => {
    const eps = 16_078; // 운영 실측: KIS 관측 예수금 − 원장 유도 예수금
    const shifted = valuations.map((v) =>
      v.accountId === "pension" ? { ...v, vOpen: v.vOpen + eps, vClose: v.vClose + eps } : v);
    const a = byKey(run(["pension"], "daily", true, valuations))["2026-10-14"];
    const b = byKey(run(["pension"], "daily", true, shifted))["2026-10-14"];
    expect(b.knownProfit).toBe(a.knownProfit);
    expect(b.averageCapital).toBe(a.averageCapital + eps);
    expect(b.returnPctLow).not.toBe(a.returnPctLow);
    // 수익률의 상대 오차 ≈ ε / V_open (여기서는 약 0.16%) — 수익률 자신의 크기에 비례해 작다
    expect(Math.abs(b.returnPctLow! - a.returnPctLow!) / a.returnPctLow!).toBeCloseTo(eps / 10_000_000, 4);
    expect(a.denominatorEstimated && b.denominatorEstimated).toBe(true);
  });

  it("추정 청산 이후의 월간도 분모 추정이다 (예수금은 관측으로 재정렬되지 않는다). 손익 막대는 유지", () => {
    const m = byKey(run(["pension"], "monthly"));
    expect(m["2026-10"].estimated).toBe(true); // 창·추정일이 구간 안
    expect(m["2026-11"].estimated).toBe(false);
    expect(m["2026-11"].denominatorEstimated).toBe(true);
    expect(m["2026-11"].exact).toBe(false);
    expect(confirmedBarValue(m["2026-11"], "amount")).not.toBeNull();
    const y = run(["pension"], "yearly");
    expect(y).toHaveLength(1);
    expect(y[0].estimated).toBe(true);
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
      expect(all[k].denominatorEstimated).toBe(one[k].denominatorEstimated);
    }
  });

  it("estimatedDays 를 주지 않으면 기존 계산과 숫자가 완전히 같다 (손익·수익률·분모 불변)", () => {
    const strip = (rs: ReturnType<typeof run>) =>
      rs.map(({ estimated, denominatorEstimated, estimateReasons, estimatedDates, exact, ...n }) => n);
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
    expect(confirmedBarValue(days["2026-10-02"], "pct")).toBeCloseTo(1, 6);
    expect(confirmedBarValue(days["2026-10-02"], "amount")).toBe(100_000);
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
