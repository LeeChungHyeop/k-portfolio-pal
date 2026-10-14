/**
 * ETF 매수 주문안 계산을 고정한다 (미리보기 전용).
 *
 * 지키는 것:
 *   1. 기존 리밸런싱 식(기준금액 = 평가 + 예수금, 목표 = 기준×비중, 수량 = floor)과 같다
 *   2. 수량은 정수이고 **예산을 넘지 않으며** 현금 여유분이 남는다
 *   3. 연금저축은 현금 기반 신규 매수, IRP 는 보유 수량을 반영한다
 *   4. 모르는 값(예수금·시세)을 0 으로 채우지 않는다
 *   5. API 모드는 준비된 조회값만 쓰고, 매수가능금액 미확인은 예상으로 표시한다
 *   6. 출처·기준시각·경고가 결과에 담긴다
 *   7. 주문·원장을 만들지 않는다
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MIN_RESERVE,
  buildBuyOrderPlan,
  defaultStrategy,
  type BalanceInput,
  type PlanRow,
  type PriceQuote,
} from "./buy-order-plan";
import type { BuyPlanInputs } from "./kis-account-observe";

const NOW = "2026-10-12T06:00:00.000Z";

const row = (over: Partial<PlanRow> & { rowId: string }): PlanRow => ({
  label: over.rowId, etfName: `ETF-${over.rowId}`, ticker: `T${over.rowId}`,
  allocPct: 50, orphaned: false, ...over,
});
const q = (price: number | null, over: Partial<PriceQuote> = {}): PriceQuote => ({
  price, source: "kis", asOf: NOW, ...over,
});

const A = row({ rowId: "a", ticker: "069500", allocPct: 60 });
const B = row({ rowId: "b", ticker: "360750", allocPct: 40 });
const quotes: Record<string, PriceQuote> = { "069500": q(10_000), "360750": q(20_000) };

/** 기본은 a·b 모두 **0 주를 입력한 것**이다. 입력하지 않음(키 없음)은 `manualRaw` 로 만든다. */
const manual = (cash: number | null, quantities: Record<string, number> = {}): BalanceInput => ({
  kind: "manual", cash, quantities: { a: 0, b: 0, ...quantities },
});
const manualRaw = (cash: number | null, quantities: Record<string, number>): BalanceInput => ({
  kind: "manual", cash, quantities,
});

const apiPlan = (over: Partial<BuyPlanInputs> = {}): BuyPlanInputs => ({
  accountInstanceId: "bai:kis-irp", accountType: "irp", productCode: "29", broker: "kis",
  stateAsOf: "2026-10-12", holdings: {}, holdingsCompleteness: "non_zero_only", cash: 1_000_000,
  buyBudget: { kind: "cash_upper_bound", amount: 1_000_000 }, ready: true, blockers: [], warnings: [],
  captureParts: [], captureId: "cap:x", ...over,
});
const api = (over: Partial<BuyPlanInputs> = {}, extra: Partial<Extract<BalanceInput, { kind: "kis_api" }>> = {}): BalanceInput => ({
  kind: "kis_api", plan: apiPlan(over), observedAt: NOW, ...extra,
});

const build = (balance: BalanceInput, accountType: "pension" | "irp" | "isa" = "irp", rows = [A, B], qs = quotes, strategy?: "cash_new_buy" | "with_holdings") =>
  buildBuyOrderPlan(rows, qs, balance, { accountType, now: NOW, ...(strategy ? { strategy } : {}) });

describe("기존 리밸런싱 계산과 같은 식", () => {
  it("IRP 는 보유 평가 + 예수금을 기준금액으로 목표를 잡는다 (여유분 0 이면 기존 식과 정확히 같다)", () => {
    // a 보유 30주 = 300,000, 예수금 700,000 → 기준 1,000,000
    const p = buildBuyOrderPlan([A, B], quotes, manual(700_000, { a: 30 }), {
      accountType: "irp", now: NOW, reserveRate: 0, minReserve: 0,
    });
    expect(p.status).toBe("ready");
    expect(p.strategy).toBe("with_holdings");
    expect(p.totals!.planningBase).toBe(1_000_000);
    const a = p.lines.find((l) => l.rowId === "a")!;
    const b = p.lines.find((l) => l.rowId === "b")!;
    // a 목표 600,000 = 60주, 이미 30주 → 30주 더
    expect(a.targetQty).toBe(60);
    expect(a.currentQty).toBe(30);
    expect(a.buyQty).toBe(30);
    // b 목표 400,000 = 20주, 보유 0
    expect(b.targetQty).toBe(20);
    expect(b.buyQty).toBe(20);
    expect(p.totals!.remainingCash).toBe(0);
  });

  it("기본 현금 여유분이 있으면 한 주 덜 살 수 있다 (예산을 넘기지 않는다)", () => {
    const p = build(manual(700_000, { a: 30 }), "irp");
    // 목표 수량은 그대로지만 여유분 때문에 합계가 예산 안에 머문다
    expect(p.lines.find((l) => l.rowId === "a")!.targetQty).toBe(60);
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(700_000 - p.budget!.reserve);
    expect(p.totals!.remainingCash).toBeGreaterThanOrEqual(p.budget!.reserve);
  });

  it("수량은 floor 다 — 목표를 넘겨 사지 않는다", () => {
    const p = build(manual(1_000_000), "irp", [A, B], { "069500": q(7_777), "360750": q(13_333) });
    for (const l of p.lines) {
      const target = ((l.targetWeightPct / 100) * p.totals!.planningBase);
      expect(l.buyQty * l.price.price!).toBeLessThanOrEqual(target + 1e-6);
    }
  });

  it("비중을 넘은 종목은 팔지 않는다 (매수 0, 사유 표시)", () => {
    // a 가 이미 800,000 어치 → 목표 보다 큼
    const p = build(manual(200_000, { a: 80 }), "irp");
    const a = p.lines.find((l) => l.rowId === "a")!;
    expect(a.buyQty).toBe(0);
    expect(a.note).toBe("overweight_no_sell");
    expect(p.lines.every((l) => l.buyQty >= 0)).toBe(true);
  });
});

describe("정수 수량·예산 초과 방지·현금 여유분", () => {
  it("매수 합계가 쓸 수 있는 돈을 넘지 않는다", () => {
    const p = build(manual(1_000_000), "irp");
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(p.budget!.spendable);
    expect(p.totals!.remainingCash).toBeGreaterThanOrEqual(p.budget!.reserve);
  });

  it("현금 여유분이 남는다 (최소 여유금 이상)", () => {
    const p = build(manual(100_000), "irp");
    expect(p.budget!.reserve).toBeGreaterThanOrEqual(DEFAULT_MIN_RESERVE);
    expect(p.budget!.spendable).toBe(100_000 - p.budget!.reserve);
  });

  it("예수금이 여유금보다 작으면 살 수 있는 것이 없다", () => {
    const p = build(manual(500), "irp");
    expect(p.budget!.spendable).toBe(0);
    expect(p.lines.every((l) => l.buyQty === 0)).toBe(true);
    expect(p.totals!.remainingCash).toBe(500);
  });

  it("모든 수량은 0 이상의 정수다", () => {
    const p = build(manual(987_654, { a: 7 }), "irp", [A, B], { "069500": q(10_333), "360750": q(17_777) });
    for (const l of p.lines) {
      expect(Number.isInteger(l.buyQty)).toBe(true);
      expect(l.buyQty).toBeGreaterThanOrEqual(0);
      if (l.targetQty !== null) expect(Number.isInteger(l.targetQty)).toBe(true);
    }
  });

  it("예산이 모자라면 부족분이 큰 종목부터 산다 (budget_limited)", () => {
    // 보유가 많아 필요 합계가 예수금을 넘는 경우 — 여러 종목이 부족하다
    const rows = [row({ rowId: "a", ticker: "1", allocPct: 50 }), row({ rowId: "b", ticker: "2", allocPct: 50 })];
    const p = build(manual(30_000, { a: 0, b: 0 }), "irp", rows, { "1": q(10_000), "2": q(10_000) });
    // 기준 30,000 → 각 15,000 → 각 1주. 여유분 때문에 spendable 29,000 → 2주 가능
    expect(p.lines.map((l) => l.buyQty)).toEqual([1, 1]);
  });

  it("임의 입력에서 예산 불변식이 깨지지 않는다 (성질 검사)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i += 1) {
      const n = 2 + Math.floor(rnd() * 5);
      const w = Array.from({ length: n }, () => 1 + rnd() * 30);
      const sum = w.reduce((a, b) => a + b, 0);
      const rs = w.map((x, k) => row({ rowId: `r${k}`, ticker: `T${k}`, allocPct: (x / sum) * 100 }));
      const qs: Record<string, PriceQuote> = {};
      const held: Record<string, number> = {};
      rs.forEach((r, k) => {
        qs[`T${k}`] = q(1_000 + Math.floor(rnd() * 90_000));
        held[r.rowId] = Math.floor(rnd() * 20);
      });
      const cash = Math.floor(rnd() * 5_000_000);
      for (const strategy of ["with_holdings", "cash_new_buy"] as const) {
        const p = build(manual(cash, held), "irp", rs, qs, strategy);
        expect(p.status).toBe("ready");
        expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(p.budget!.spendable);
        expect(p.totals!.remainingCash).toBeGreaterThanOrEqual(0);
        for (const l of p.lines) {
          expect(Number.isInteger(l.buyQty)).toBe(true);
          expect(l.buyQty).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("연금저축 = 현금 기반 신규 매수 / IRP = 보유 반영", () => {
  it("기본 전략이 계좌 종류별로 다르다", () => {
    expect(defaultStrategy("pension")).toBe("cash_new_buy");
    expect(defaultStrategy("irp")).toBe("with_holdings");
    expect(defaultStrategy("isa")).toBe("with_holdings");
  });

  it("연금저축은 예수금(여유 제외)만 비중대로 나눈다 — 보유가 있어도 목표에 넣지 않는다", () => {
    const p = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "cash_new_buy");
    expect(p.strategy).toBe("cash_new_buy");
    expect(p.totals!.planningBase).toBe(p.budget!.spendable);
    const a = p.lines.find((l) => l.rowId === "a")!;
    // 보유 50주는 표시되지만 목표 수량 계산에는 들어가지 않는다
    expect(a.currentQty).toBe(50);
    expect(a.buyQty).toBeGreaterThan(0);
  });

  it("같은 입력이라도 IRP 는 보유를 반영해 덜 산다", () => {
    const pension = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "cash_new_buy");
    const irp = build(manual(1_000_000, { a: 50 }), "irp");
    const pa = pension.lines.find((l) => l.rowId === "a")!.buyQty;
    const ia = irp.lines.find((l) => l.rowId === "a")!.buyQty;
    expect(ia).toBeLessThan(pa);
  });

  it("연금저축도 전략을 명시하면 보유를 반영할 수 있다", () => {
    const p = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "with_holdings");
    expect(p.strategy).toBe("with_holdings");
    expect(p.totals!.planningBase).toBe(500_000 + 1_000_000);
  });
});

describe("모르는 값을 0 으로 채우지 않는다", () => {
  it("예수금을 입력하지 않았으면 계산하지 않는다", () => {
    const p = build(manual(null));
    expect(p.status).toBe("blocked");
    expect(p.blockers[0].code).toBe("cash_unknown");
    expect(p.lines).toEqual([]);
    expect(p.budget).toBeNull();
    expect(p.totals).toBeNull();
  });

  it("시세가 없는 종목은 사지 않고 경고한다", () => {
    const p = build(manual(1_000_000), "irp", [A, B], { "069500": q(10_000), "360750": q(null, { source: "unavailable", asOf: null }) });
    const b = p.lines.find((l) => l.rowId === "b")!;
    expect(b.buyQty).toBe(0);
    expect(b.estimatedAmount).toBe(0);
    expect(b.targetQty).toBeNull();
    expect(b.note).toBe("price_missing");
    const w = p.warnings.find((x) => x.code === "price_missing")!;
    expect(w.level).toBe("critical");
    expect(w.message).toContain("ETF-b");
  });

  it("시세가 0 이거나 음수여도 가격으로 쓰지 않는다", () => {
    const p = build(manual(1_000_000), "irp", [A, B], { "069500": q(0), "360750": q(-5) });
    expect(p.lines.every((l) => l.buyQty === 0)).toBe(true);
    expect(p.warnings.some((x) => x.code === "price_missing")).toBe(true);
  });

  it("보유 중인데 시세가 없으면 평가 불가를 경고한다", () => {
    const p = build(manual(1_000_000, { b: 5 }), "irp", [A, B], { "069500": q(10_000), "360750": q(null, { source: "unavailable", asOf: null }) });
    expect(p.warnings.some((x) => x.code === "holdings_valuation_incomplete")).toBe(true);
    expect(p.totals!.unpricedHoldings).toBe(1);
  });

  it("종목코드가 없는 행(현금성)은 사지 않는다", () => {
    const cashRow = row({ rowId: "cash", ticker: null, allocPct: 10, label: "현금" });
    const p = build(manual(1_000_000), "irp", [row({ rowId: "a", ticker: "069500", allocPct: 90 }), cashRow], quotes);
    const c = p.lines.find((l) => l.rowId === "cash")!;
    expect(c.buyQty).toBe(0);
    expect(c.note).toBe("non_tradable");
  });

  it("매수 가능한 행이 없으면 계산하지 않는다", () => {
    const p = build(manual(1_000_000), "irp", [row({ rowId: "x", ticker: null })]);
    expect(p.blockers[0].code).toBe("no_tradable_rows");
  });

  it("비중 합이 100% 를 넘으면 계산하지 않는다", () => {
    const p = build(manual(1_000_000), "irp", [row({ rowId: "a", ticker: "069500", allocPct: 70 }), row({ rowId: "b", ticker: "360750", allocPct: 50 })]);
    expect(p.blockers[0].code).toBe("weights_invalid");
  });

  it("비중 합이 100% 미만이면 남는 비중을 현금으로 둔다는 안내를 낸다", () => {
    const p = build(manual(1_000_000), "irp", [row({ rowId: "a", ticker: "069500", allocPct: 60 }), row({ rowId: "b", ticker: "360750", allocPct: 20 })]);
    expect(p.warnings.some((x) => x.code === "weights_not_100")).toBe(true);
  });
});

describe("API 모드 — 검증된 조회값만", () => {
  it("준비된 조회 결과로 계산한다 (티커로 보유수량을 대응시킨다)", () => {
    const p = build(api({ holdings: { "069500": 30 }, cash: 700_000 }), "irp");
    expect(p.status).toBe("ready");
    expect(p.mode).toBe("kis_api");
    expect(p.lines.find((l) => l.rowId === "a")!.currentQty).toBe(30);
    expect(p.totals!.planningBase).toBe(300_000 + 700_000);
  });

  it("**준비되지 않은 조회 결과는 계산하지 않는다**", () => {
    const p = build(api({
      ready: false, holdings: null, cash: null,
      blockers: [{ code: "instance_not_active", message: "이전 진행 중 — 잔고 0 이 아닙니다" }],
    }), "irp");
    expect(p.status).toBe("blocked");
    expect(p.blockers[0].code).toBe("api_not_ready");
    expect(p.blockers[0].message).toContain("잔고 0 이 아닙니다");
    expect(p.lines).toEqual([]);
  });

  it("조회 실패(보유 미관측)를 0 보유로 계산하지 않는다", () => {
    const p = build(api({ ready: false, holdings: null, blockers: [{ code: "holdings_not_observed", message: "실패" }] }));
    expect(p.status).toBe("blocked");
    expect(p.totals).toBeNull();
  });

  it("**매수가능금액이 없으면 예상 주문안이다** — 예수금을 상한으로 쓰고 경고한다", () => {
    const p = build(api({ cash: 500_000 }), "irp");
    expect(p.orderability).toBe("estimate_only");
    expect(p.budget!.basis).toBe("cash_upper_bound");
    expect(p.sources.buyingPower).toEqual({ source: null, asOf: null, verified: false });
    expect(p.warnings.find((x) => x.code === "estimate_only")!.message).toContain("예상 주문안");
  });

  /** 계획 단가(069500 @10,000 / 360750 @20,000)와 같은 단가로 조회된 항목 */
  const bpEntries = (amount: number, qtyA = 20, qtyB = 10) => ({
    asOf: NOW,
    entries: [
      { ticker: "069500", price: 10_000, amount, qty: qtyA },
      { ticker: "360750", price: 20_000, amount, qty: qtyB },
    ],
  });

  it("매수가능금액이 확인되면 예수금과 비교해 작은 쪽을 쓴다", () => {
    const p = build(api({ cash: 500_000 }, { buyingPower: bpEntries(200_000) }), "irp");
    expect(p.orderability).toBe("budget_verified");
    expect(p.budget!.basis).toBe("buying_power");
    expect(p.budget!.amount).toBe(200_000);
    expect(p.sources.buyingPower).toEqual({ source: "kis_api", asOf: NOW, verified: true });
    expect(p.warnings.some((x) => x.code === "estimate_only")).toBe(false);
  });

  it("매수가능금액이 예수금보다 커도 예수금을 넘지 않는다", () => {
    const p = build(api({ cash: 100_000 }, { buyingPower: bpEntries(900_000) }), "irp");
    expect(p.budget!.amount).toBe(100_000);
  });

  it("**확인된 매수가능금액에서는 우리 여유분을 다시 빼지 않는다** (중복 차감 없음)", () => {
    const p = build(api({ cash: 500_000 }, { buyingPower: bpEntries(300_000) }), "irp");
    expect(p.budget!.reserve).toBe(0);
    expect(p.budget!.reserveBasis).toBe("broker_verified_none");
    expect(p.budget!.spendable).toBe(300_000);
    // 증권사 값을 그대로 쓴다 — 어떤 비율도 계산에 들어가지 않는다
    expect(p.budget!.spendable).toBe(p.budget!.amount);
  });

  it("확인되지 않은 예산(예수금 상한 추정)에는 앱 여유분을 유지한다", () => {
    const p = build(api({ cash: 500_000 }), "irp");
    expect(p.budget!.reserveBasis).toBe("app_estimate");
    expect(p.budget!.reserve).toBeGreaterThan(0);
  });

  it("**종목별로 가장 작은 주문가능금액을 예산 상한으로 쓴다**", () => {
    const p = build(api({ cash: 900_000 }, {
      buyingPower: {
        asOf: NOW,
        entries: [
          { ticker: "069500", price: 10_000, amount: 700_000, qty: 70 },
          { ticker: "360750", price: 20_000, amount: 400_000, qty: 20 },
        ],
      },
    }), "irp");
    expect(p.budget!.amount).toBe(400_000);
  });

  it("증권사가 준 종목별 최대 수량을 넘지 않는다", () => {
    const p = build(api({ cash: 900_000 }, {
      buyingPower: {
        asOf: NOW,
        entries: [
          { ticker: "069500", price: 10_000, amount: 900_000, qty: 5 },
          { ticker: "360750", price: 20_000, amount: 900_000, qty: 3 },
        ],
      },
    }), "irp");
    expect(p.lines.find((l) => l.rowId === "a")!.buyQty).toBeLessThanOrEqual(5);
    expect(p.lines.find((l) => l.rowId === "b")!.buyQty).toBeLessThanOrEqual(3);
  });

  it("**조회 단가가 계획 단가와 다르면 인정하지 않는다** (다른 가격의 근거다)", () => {
    const stale = bpEntries(300_000);
    stale.entries[0] = { ...stale.entries[0], price: 9_900 };
    const p = build(api({ cash: 500_000 }, { buyingPower: stale }), "irp");
    expect(p.orderability).toBe("estimate_only");
    expect(p.budget!.basis).toBe("cash_upper_bound");
    expect(p.budget!.reserveBasis).toBe("app_estimate");
    const w = p.warnings.find((x) => x.code === "buying_power_unmatched")!;
    expect(w.message).toContain("ETF-a");
  });

  it("종목 일부만 조회됐으면 전체를 인정하지 않는다", () => {
    const partial = bpEntries(300_000);
    partial.entries.pop();
    const p = build(api({ cash: 500_000 }, { buyingPower: partial }), "irp");
    expect(p.orderability).toBe("estimate_only");
    expect(p.warnings.map((x) => x.code)).toContain("buying_power_unmatched");
  });

  it("조회 항목이 비어 있으면 조회하지 않은 것과 같다", () => {
    const p = build(api({ cash: 500_000 }, { buyingPower: { asOf: NOW, entries: [] } }), "irp");
    expect(p.orderability).toBe("estimate_only");
    expect(p.warnings.map((x) => x.code)).not.toContain("buying_power_unmatched");
  });

  it("**실측 시나리오**: 보유 230/64주 + 확인된 주문가능금액으로 추가 매수를 계산한다", () => {
    const rows = [
      row({ rowId: "us", ticker: "360750", allocPct: 50, etfName: "TIGER 미국S&P500" }),
      row({ rowId: "nas", ticker: "367380", allocPct: 50, etfName: "ACE 미국나스닥100" }),
    ];
    const qs = { "360750": q(25_985), "367380": q(31_215) };
    const p = buildBuyOrderPlan(
      rows, qs,
      {
        kind: "kis_api", observedAt: NOW,
        plan: apiPlan({ holdings: { "360750": 230, "367380": 64 }, cash: 2_318_826 }),
        buyingPower: {
          asOf: NOW,
          entries: [
            { ticker: "360750", price: 25_985, amount: 2_307_289, qty: 88 },
            { ticker: "367380", price: 31_215, amount: 2_307_289, qty: 73 },
          ],
        },
      },
      { accountType: "pension", now: NOW },
    );
    expect(p.status).toBe("ready");
    // 보유가 있는 연금저축 → 보유 반영 (별도 추가매수가 아니다)
    expect(p.strategy).toBe("with_holdings");
    expect(p.holdingsBasis).toBe("has_holdings");
    expect(p.budget!.spendable).toBe(2_307_289); // 증권사 값 그대로, 여유분 중복 차감 없음
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(2_307_289);
    expect(p.lines.find((l) => l.rowId === "us")!.currentQty).toBe(230);
    expect(p.lines.find((l) => l.rowId === "nas")!.currentQty).toBe(64);
    for (const l of p.lines) expect(Number.isInteger(l.buyQty)).toBe(true);
  });

  it("**계좌 식별 미검증 경고**가 항상 붙는다", () => {
    const p = build(api(), "irp");
    const w = p.warnings.find((x) => x.code === "account_identity_unverified")!;
    expect(w.level).toBe("caution");
    expect(w.message).toContain("주문에 사용할 수 없습니다");
  });

  it("계산만 제공 모드에는 계좌 식별 경고가 없다", () => {
    expect(build(manual(1_000_000)).warnings.some((x) => x.code === "account_identity_unverified")).toBe(false);
  });

  it("투자성향에 없는 보유 종목은 계산에서 제외하고 알린다", () => {
    const p = build(api({ holdings: { "069500": 1, "999999": 7 } }), "irp");
    expect(p.unmappedHoldings).toEqual({ "999999": 7 });
    expect(p.warnings.some((x) => x.code === "unmapped_holdings")).toBe(true);
  });
});

describe("출처·기준시각", () => {
  it("가격·예수금·보유수량의 출처와 기준시각을 담는다", () => {
    const p = build(api({ cash: 500_000 }), "irp");
    expect(p.sources.cash).toEqual({ source: "kis_api", asOf: NOW });
    expect(p.sources.holdings).toEqual({ source: "kis_api", asOf: NOW });
    expect(p.sources.prices).toEqual([
      { ticker: "069500", source: "kis", asOf: NOW },
      { ticker: "360750", source: "kis", asOf: NOW },
    ]);
  });

  it("수동 입력은 입력 출처로 표시한다", () => {
    const p = build(manual(500_000));
    expect(p.sources.cash.source).toBe("manual_input");
    expect(p.sources.holdings.source).toBe("manual_input");
  });

  it("오래된 시세를 경고한다", () => {
    const old = new Date(Date.parse(NOW) - 90 * 60_000).toISOString();
    const p = build(manual(1_000_000), "irp", [A, B], { "069500": q(10_000, { asOf: old }), "360750": q(20_000) });
    const w = p.warnings.find((x) => x.code === "price_stale")!;
    expect(w.message).toContain("ETF-a");
    expect(w.message).not.toContain("ETF-b");
  });

  it("실시간이 아닌 시세(naver·과거 종가)를 경고한다", () => {
    const p = build(manual(1_000_000), "irp", [A, B], {
      "069500": q(10_000, { source: "naver" }), "360750": q(20_000, { source: "history", asOf: "2026-10-09" }),
    });
    const w = p.warnings.find((x) => x.code === "price_not_live")!;
    expect(w.message).toContain("naver");
    expect(w.message).toContain("history");
  });
});

// ── 현금 기반 신규 매수의 적합성 ────────────────────────────────────────────

describe("cash_new_buy — 기존 보유를 전체 리밸런싱으로 오인하지 않는다", () => {
  const codes = (p: ReturnType<typeof build>) => p.warnings.map((w) => w.code);

  it("기존 보유가 0 으로 확인되면 신규 매수가 맞는 안이다 (경고 없음)", () => {
    const p = build(manual(1_000_000), "pension");
    expect(p.strategy).toBe("cash_new_buy");
    expect(p.scope).toBe("additional_purchase");
    expect(p.holdingsBasis).toBe("confirmed_zero");
    expect(p.recommendedStrategy).toBe("cash_new_buy");
    expect(codes(p)).not.toContain("new_buy_ignores_holdings");
    expect(codes(p)).not.toContain("new_buy_holdings_unconfirmed");
    expect(p.reliability).toBe("complete");
  });

  it("**기존 보유가 있으면 별도 추가매수임을 표시하고 보유 반영 전환을 권한다**", () => {
    const p = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "cash_new_buy");
    expect(p.scope).toBe("additional_purchase");
    expect(p.holdingsBasis).toBe("has_holdings");
    expect(p.recommendedStrategy).toBe("with_holdings");
    const w = p.warnings.find((x) => x.code === "new_buy_ignores_holdings")!;
    expect(w.message).toContain("별도 추가매수");
    expect(w.message).toContain("전체 리밸런싱이 아니라");
    expect(w.message).toContain("보유 수량 반영");
    expect(w.message).toContain("ETF-a 50주");
    // 보유를 목표에 넣지 않았으므로 계좌 전체 비중을 말할 수 없다 → 참고용
    expect(p.reliability).toBe("reference_only");
    expect(p.incompleteReasons.join(" ")).toContain("별도 추가매수");
  });

  it("**입력하지 않은 보유를 0 으로 가정하지 않는다**", () => {
    const p = build(manualRaw(1_000_000, {}), "pension");
    expect(p.holdingsBasis).toBe("not_confirmed");
    const w = p.warnings.find((x) => x.code === "new_buy_holdings_unconfirmed")!;
    expect(w.message).toContain("0 주라고 가정하지 않았습니다");
    expect(p.recommendedStrategy).toBe("with_holdings");
    expect(p.reliability).toBe("reference_only");
    // 현재 보유는 0 이 아니라 null 로 남는다
    expect(p.lines.every((l) => l.currentQty === null)).toBe(true);
  });

  it("일부만 입력해도 확인된 것이 아니다", () => {
    const p = build(manualRaw(1_000_000, { a: 0 }), "pension");
    expect(p.holdingsBasis).toBe("not_confirmed");
  });

  it("API 조회로 확인된 빈 계좌는 확인된 0 이다", () => {
    const p = build(api({ holdings: {}, holdingsCompleteness: "non_zero_only" }), "pension");
    expect(p.holdingsBasis).toBe("confirmed_zero");
    expect(p.warnings.map((w) => w.code)).not.toContain("new_buy_holdings_unconfirmed");
  });

  it("보유 반영 전략은 입력하지 않은 종목을 사지 않는다 (0 주로 가정하지 않는다)", () => {
    const p = build(manualRaw(1_000_000, { a: 10 }), "irp");
    expect(p.strategy).toBe("with_holdings");
    const b = p.lines.find((l) => l.rowId === "b")!;
    expect(b.currentQty).toBeNull();
    expect(b.buyQty).toBe(0);
    expect(b.note).toBe("holdings_not_entered");
    const w = p.warnings.find((x) => x.code === "holdings_not_entered")!;
    expect(w.level).toBe("critical");
    expect(w.message).toContain("ETF-b");
    expect(w.message).toContain("0 을 입력하세요");
    expect(p.reliability).toBe("reference_only");
  });

  it("0 을 입력했으면 0 주로 계산한다", () => {
    const p = build(manual(1_000_000), "irp");
    expect(p.lines.find((l) => l.rowId === "b")!.buyQty).toBeGreaterThan(0);
    expect(p.warnings.map((w) => w.code)).not.toContain("holdings_not_entered");
  });

  it("**전략을 명시하면 그대로 계산한다** — 권고는 권고일 뿐 자동 전환이 아니다", () => {
    const p1 = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "cash_new_buy");
    const p2 = build(manual(1_000_000, { a: 50 }), "pension", [A, B], quotes, "cash_new_buy");
    expect(p1.strategy).toBe("cash_new_buy");
    expect(p2.strategy).toBe("cash_new_buy");
    expect(p1.recommendedStrategy).toBe("with_holdings"); // 권고일 뿐이다
  });

  it("**전략을 명시하지 않으면 보유가 확인된 연금저축은 보유를 반영한다**", () => {
    const p = build(manual(1_000_000, { a: 50 }), "pension");
    expect(p.strategy).toBe("with_holdings");
    expect(p.scope).toBe("rebalance_buys");
    expect(p.holdingsBasis).toBe("has_holdings");
    expect(p.warnings.map((w) => w.code)).not.toContain("new_buy_ignores_holdings");
  });

  it("보유 0 으로 확인된 연금저축은 자동으로도 신규 매수다", () => {
    const p = build(manual(1_000_000), "pension");
    expect(p.strategy).toBe("cash_new_buy");
  });

  it("보유를 확인하지 못한 연금저축은 신규 매수(경고 포함)를 유지한다", () => {
    const p = build(manualRaw(1_000_000, {}), "pension");
    expect(p.strategy).toBe("cash_new_buy");
    expect(p.warnings.map((w) => w.code)).toContain("new_buy_holdings_unconfirmed");
  });
});

describe("평가금액 불완전 — 참고용이며 안전하다고 단정하지 않는다", () => {
  const find = (p: ReturnType<typeof build>, code: string) => p.warnings.find((w) => w.code === code);

  it("**미매핑 보유 종목**이 있으면 계좌 전체 목표 비중을 계산할 수 없다고 표시한다", () => {
    const p = build(api({ holdings: { "069500": 1, "999999": 7 } }), "irp");
    expect(p.reliability).toBe("reference_only");
    expect(p.incompleteReasons.join(" ")).toContain("투자성향에 없는 보유 종목");
    const w = find(p, "unmapped_holdings")!;
    expect(w.message).toContain("정확히 계산할 수 없습니다");
    const top = find(p, "valuation_incomplete")!;
    expect(top.level).toBe("critical");
    expect(top.message).toContain("참고용");
  });

  it("**시세가 없는 보유 종목**이 있으면 평가 불완전이다", () => {
    const p = build(manual(1_000_000, { b: 5 }), "irp", [A, B], {
      "069500": q(10_000), "360750": q(null, { source: "unavailable", asOf: null }),
    });
    expect(p.reliability).toBe("reference_only");
    expect(find(p, "holdings_valuation_incomplete")!.message).toContain("정확히 계산할 수 없습니다");
    expect(p.incompleteReasons.join(" ")).toContain("시세가 없어 평가하지 못한 보유 종목");
  });

  it("매수 대상 종목의 시세가 없어도 목표 비중을 채울 수 없으므로 참고용이다", () => {
    const p = build(manual(1_000_000), "irp", [A, B], {
      "069500": q(10_000), "360750": q(null, { source: "unavailable", asOf: null }),
    });
    expect(p.reliability).toBe("reference_only");
  });

  it("**'보수적이라 안전하다'고 쓰지 않는다**", () => {
    const p = build(api({ holdings: { "069500": 1, "999999": 7 } }), "irp");
    const text = p.warnings.map((w) => w.message).join(" ") + p.incompleteReasons.join(" ");
    expect(text).not.toMatch(/보수적|안전하다고|낮게 계산됩니다/);
    // 안전하다는 오해를 명시적으로 부정한다
    expect(find(p, "valuation_incomplete")!.message).toContain("뜻이 아니며");
  });

  it("완전한 입력은 완전한 안이다", () => {
    const p = build(manual(1_000_000, { a: 3, b: 2 }), "irp");
    expect(p.reliability).toBe("complete");
    expect(p.incompleteReasons).toEqual([]);
    expect(p.warnings.map((w) => w.code)).not.toContain("valuation_incomplete");
  });

  it("참고용이어도 계산 결과(수량)는 예산 불변식을 지킨다", () => {
    const p = build(api({ holdings: { "069500": 1, "999999": 7 } }), "irp");
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(p.budget!.spendable);
  });
});

describe("두 ETF 가 같은 주문가능예산을 공유한다", () => {
  const RA = row({ rowId: "us", ticker: "360750", allocPct: 50, etfName: "TIGER 미국S&P500" });
  const RB = row({ rowId: "nas", ticker: "367380", allocPct: 50, etfName: "ACE 미국나스닥100" });
  const QS = { "360750": q(25_985), "367380": q(31_215) };
  const SHARED = 2_307_289; // 실측: 두 종목 모두 같은 미수없는매수금액

  const plan = (cash: number, held: Record<string, number>, amountA = SHARED, amountB = SHARED, qtyA = 88, qtyB = 73, rows = [RA, RB]) =>
    buildBuyOrderPlan(
      rows, QS,
      {
        kind: "kis_api", observedAt: NOW,
        plan: apiPlan({ holdings: held, cash }),
        buyingPower: {
          asOf: NOW,
          entries: [
            { ticker: "360750", price: 25_985, amount: amountA, qty: qtyA },
            { ticker: "367380", price: 31_215, amount: amountB, qty: qtyB },
          ],
        },
      },
      { accountType: "pension", now: NOW, strategy: "with_holdings" },
    );

  it("**두 종목을 각각 최대 수량까지 사면 예산을 넘는 상황에서도 합계가 예산 이하다**", () => {
    // 현금이 많고 목표가 커서 각 종목이 자기 최대 수량(88 / 73)을 원한다.
    // 88×25,985 + 73×31,215 = 4,565,375 > 2,307,289 — 따로 계산하면 예산을 넘는다.
    const p = plan(5_000_000, {});
    const a = p.lines.find((l) => l.rowId === "us")!;
    const b = p.lines.find((l) => l.rowId === "nas")!;
    expect(88 * 25_985 + 73 * 31_215).toBeGreaterThan(SHARED);
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(SHARED);
    expect(a.buyQty).toBeLessThanOrEqual(88);
    expect(b.buyQty).toBeLessThanOrEqual(73);
    // 예산 안에서 실제로 샀다 (아무것도 안 사서 통과한 것이 아니다)
    expect(a.buyQty + b.buyQty).toBeGreaterThan(0);
    expect(p.totals!.totalBuyAmount).toBeGreaterThan(SHARED - 31_215);
  });

  it("각 종목 매수 수량은 증권사 최대 수량 이하다 (예산이 충분해도)", () => {
    const p = plan(50_000_000, {}, 50_000_000, 50_000_000, 10, 7);
    expect(p.lines.find((l) => l.rowId === "us")!.buyQty).toBeLessThanOrEqual(10);
    expect(p.lines.find((l) => l.rowId === "nas")!.buyQty).toBeLessThanOrEqual(7);
  });

  it("종목별 주문가능금액이 다르면 가장 작은 쪽이 공통 예산이다", () => {
    const p = plan(5_000_000, {}, 2_000_000, 1_500_000);
    expect(p.budget!.amount).toBe(1_500_000);
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(1_500_000);
  });

  it("예수금이 주문가능금액보다 작으면 예수금이 상한이다", () => {
    const p = plan(1_000_000, {});
    expect(p.budget!.amount).toBe(1_000_000);
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(1_000_000);
    expect(p.totals!.remainingCash).toBeGreaterThanOrEqual(0);
  });

  it("**같은 종목코드가 두 행이어도 종목 단위 최대 수량을 합쳐서 지킨다**", () => {
    const dup = row({ rowId: "us2", ticker: "360750", allocPct: 30, etfName: "TIGER 미국S&P500(중복 행)" });
    const rows = [
      row({ rowId: "us", ticker: "360750", allocPct: 30, etfName: "TIGER 미국S&P500" }),
      dup,
      row({ rowId: "nas", ticker: "367380", allocPct: 40, etfName: "ACE 미국나스닥100" }),
    ];
    const p = plan(5_000_000, {}, SHARED, SHARED, 20, 73, rows);
    const tigerTotal = p.lines.filter((l) => l.ticker === "360750").reduce((s, l) => s + l.buyQty, 0);
    expect(tigerTotal).toBeLessThanOrEqual(20);
    expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(SHARED);
  });

  it("**같은 종목코드의 보유수량은 첫 행에만 배정한다** (이중 계산 방지)", () => {
    const dup = row({ rowId: "us2", ticker: "360750", allocPct: 0, etfName: "TIGER(중복)" });
    const p = plan(2_318_826, { "360750": 230, "367380": 64 }, SHARED, SHARED, 88, 73, [RA, dup, RB]);
    const qtys = p.lines.filter((l) => l.ticker === "360750").map((l) => l.currentQty);
    expect(qtys).toEqual([230, 0]);
  });

  it("임의 입력에서 합계 ≤ 공통 예산, 종목 수량 ≤ 증권사 최대 수량이 깨지지 않는다 (성질 검사)", () => {
    let seed = 987654;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i += 1) {
      const cash = 100_000 + Math.floor(rnd() * 6_000_000);
      const budgetA = Math.floor(rnd() * 3_000_000);
      const budgetB = Math.floor(rnd() * 3_000_000);
      const qtyA = Math.floor(rnd() * 120);
      const qtyB = Math.floor(rnd() * 120);
      const held = { "360750": Math.floor(rnd() * 300), "367380": Math.floor(rnd() * 300) };
      const p = plan(cash, held, budgetA, budgetB, qtyA, qtyB);
      expect(p.status).toBe("ready");
      const cap = Math.min(cash, budgetA, budgetB);
      expect(p.totals!.totalBuyAmount).toBeLessThanOrEqual(cap);
      expect(p.lines.find((l) => l.rowId === "us")!.buyQty).toBeLessThanOrEqual(qtyA);
      expect(p.lines.find((l) => l.rowId === "nas")!.buyQty).toBeLessThanOrEqual(qtyB);
    }
  });
});

describe("주문·원장을 만들지 않는다 (소스 단위)", () => {
  const src = readFileSync(fileURLToPath(new URL("./buy-order-plan.ts", import.meta.url)), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("네트워크·저장·원장 호출이 없다", () => {
    expect(src).not.toMatch(/fetch\(|localStorage|\.rpc\(|\.from\(/);
    expect(src).not.toMatch(/ledger|transaction|order-cash|inquire-psbl|POST/);
    expect(src).not.toMatch(/console\./);
  });

  it("출력 구조에 주문 식별자·체결 필드가 없다", () => {
    const p = build(manual(1_000_000));
    const keys = JSON.stringify(p);
    expect(keys).not.toMatch(/"orderId"|"ODNO"|"executed"|"fill"/);
  });
});
