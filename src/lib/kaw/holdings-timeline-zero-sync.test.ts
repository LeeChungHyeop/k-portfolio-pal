// 실사용 수익 분석(holdings-timeline)의 전량 0주 broker_sync 경계.
//
// 0주 동기화는 "이 날짜부터 보유가 없다"는 확정 경계다. `validAnchors` 는 양수 보유가 없는 기록을 버리므로,
// 그대로 쓰면 ledger cutoff 이후 날짜가 오래된 history 의 수량으로 되돌아간다.
// 일반 history 의 0주 기록 정책, 원장 구간, 현재 연금저축 230주/64주(양수 동기화) 동작은 그대로여야 한다.
import { describe, it, expect } from "vitest";
import type { AccountId } from "./constants";
import { replayDailyHoldings, type LedgerTransaction } from "./ledger";
import { accountCoverage, type AccountCoverage } from "./ledger-coverage";
import { buildAccountTimeline } from "./holdings-timeline";
import { holdingsAnchorsOf } from "./broker-sync-basis";
import { buildCashSeries } from "./profit-analysis";
import { buildDerivedCash } from "./derived-cash";
import type { PriceBarsByTicker } from "./useHistoricalPrices";

const LIB = [
  { defaultEtf: "ETF-A", ticker: "AAA" },
  { defaultEtf: "ETF-B", ticker: "BBB" },
];
const DATES = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
const bars: PriceBarsByTicker = {
  AAA: Object.fromEntries(DATES.map((d) => [d, { open: 100, close: 100 }])),
  BBB: Object.fromEntries(DATES.map((d) => [d, { open: 50, close: 50 }])),
};

const tx = (id: string, ticker: string, quantity: number, price: number, eventDate: string): LedgerTransaction => ({
  id, accountId: "pension", ticker, etfName: `ETF-${ticker}`, side: "buy", quantity, price,
  amount: quantity * price, tradeDate: eventDate, settlementDate: null, inferredTradeDate: null, eventDate,
  tradeDateEvidence: "broker-order-date", fee: 0, tax: 0, postQuantity: null, source: "miraeasset_capture_qty_price_reconstructed",
});
// 원장: 10-01 에 AAA 5주, BBB 3주를 샀다. cutoff = 10-01.
const LEDGER = [tx("a", "AAA", 5, 100, "2026-10-01"), tx("b", "BBB", 3, 50, "2026-10-01")];

/** 계좌 상태의 history + brokerSyncs 로 anchor 목록을 만든다 (ProfitAnalysisSection 과 같은 경로) */
const rebalance = (date: string, qty: Record<string, number>) => ({
  id: `h:${date}`, date, rowQuantitiesSnap: qty, rowEtfSnap: { AAA: "ETF-A", BBB: "ETF-B" },
});
const sync = (effective: string, quantities: Record<string, number>) => ({
  id: `bsync:${effective}`, kind: "broker_sync", version: 1, accountType: "pension",
  holdingsEffectiveFrom: effective, quantities,
  rowEtfSnap: { AAA: "ETF-A", BBB: "ETF-B" }, rowLabelSnap: {}, rowAssetSnap: {}, rowHoldingsSnap: {},
});

function timeline(history: ReturnType<typeof rebalance>[], brokerSyncs: unknown[] = []) {
  const merged = holdingsAnchorsOf({ history, brokerSyncs });
  const coverage: AccountCoverage = {
    ...accountCoverage({
      accountId: "pension" as AccountId, ledgerDates: LEDGER.map((t) => t.eventDate), cashflowDates: ["2026-10-01"], history: merged,
    }),
    performanceStart: "2026-10-01",
  };
  const days = buildAccountTimeline(
    { accountId: "pension", coverage, ledgerDays: replayDailyHoldings(LEDGER).pension, history: merged },
    LIB, DATES,
  );
  return { days, coverage, merged };
}
const closeOf = (days: ReturnType<typeof timeline>["days"], d: string) => days.find((x) => x.date === d)!.closeHoldings;

describe("holdings-timeline — 전량 0주 broker_sync 는 보유수량 경계다", () => {
  const history = [rebalance("2026-10-01", { AAA: 5, BBB: 3 })];

  it("★ 양수 history → 전 종목 0주 동기화 → cutoff 이후: 오래된 history 수량(5/3)으로 되돌아가지 않는다", () => {
    const { days } = timeline(history, [sync("2026-10-06", { AAA: 0, BBB: 0 })]);
    expect(closeOf(days, "2026-10-02")).toEqual({ AAA: 5, BBB: 3 }); // cutoff 뒤, 경계 전: 기존 anchor
    expect(closeOf(days, "2026-10-05")).toEqual({ AAA: 5, BBB: 3 });
    expect(closeOf(days, "2026-10-06")).toEqual({}); // 경계 날짜부터 0주
    expect(closeOf(days, "2026-10-07")).toEqual({});
    expect(closeOf(days, "2026-10-08")).toEqual({});
    // 경계 날짜의 전환은 보유 변화로 잡힌다 (open 은 전날 종료 상태)
    const d = days.find((x) => x.date === "2026-10-06")!;
    expect(d.openHoldings).toEqual({ AAA: 5, BBB: 3 });
    expect(d.traded).toBe(true);
  });

  it("대조: 0주 경계가 없으면(동기화 없음) 마지막 history 수량이 유지된다 — 기존 동작 불변", () => {
    const { days } = timeline(history, []);
    expect(closeOf(days, "2026-10-08")).toEqual({ AAA: 5, BBB: 3 });
  });

  it("일부 종목만 0주인 동기화는 그 종목만 빠진다 (기존 동작)", () => {
    const { days } = timeline(history, [sync("2026-10-06", { AAA: 0, BBB: 3 })]);
    expect(closeOf(days, "2026-10-07")).toEqual({ BBB: 3 });
  });

  it("0주 동기화 뒤에 양수 동기화가 오면 그 수량이 이긴다 (230/64 같은 현재 연금저축 형태)", () => {
    const { days } = timeline(history, [
      sync("2026-10-06", { AAA: 0, BBB: 0 }),
      sync("2026-10-07", { AAA: 230, BBB: 64 }),
    ]);
    expect(closeOf(days, "2026-10-06")).toEqual({});
    expect(closeOf(days, "2026-10-07")).toEqual({ AAA: 230, BBB: 64 });
    expect(closeOf(days, "2026-10-08")).toEqual({ AAA: 230, BBB: 64 });
  });

  it("양수 동기화만 있는 현재 연금저축 형태는 그대로다 (cutoff 와 같은 날 동기화 → 230/64)", () => {
    const { days } = timeline(history, [sync("2026-10-01", { AAA: 230, BBB: 64 })]);
    expect(closeOf(days, "2026-10-05")).toEqual({ AAA: 230, BBB: 64 });
  });

  it("일반 리밸런싱 history 의 0주 기록은 기존대로 무시된다 (정책 불변)", () => {
    const zeroRebalance = rebalance("2026-10-06", { AAA: 0, BBB: 0 });
    const { days } = timeline([...history, zeroRebalance]);
    expect(closeOf(days, "2026-10-08")).toEqual({ AAA: 5, BBB: 3 });
  });

  it("원장 구간(cutoff 이하)은 0주 동기화가 있어도 원장 재생 그대로다", () => {
    const { days } = timeline(history, [sync("2026-10-01", { AAA: 0, BBB: 0 })]);
    expect(days.find((d) => d.date === "2026-10-01")!.source).toBe("ledger");
    expect(closeOf(days, "2026-10-01")).toEqual({ AAA: 5, BBB: 3 });
  });

  it("커버리지: 0주 경계도 최신 anchor 날짜에 들어가고(미관측 수입 상한 R 판정용), seam 은 양수 anchor 기준 그대로다", () => {
    const { coverage } = timeline(history, [sync("2026-10-06", { AAA: 0, BBB: 0 })]);
    expect(coverage.anchorDates).toEqual(["2026-10-01", "2026-10-06"]);
    expect(coverage.seam).toBe("2026-10-01");
    const without = timeline(history, []).coverage;
    expect(without.anchorDates).toEqual(["2026-10-01"]);
    expect(without.seam).toBe("2026-10-01");
  });

  it("현금 경로: 경계 날짜의 0주 전환은 종가 체결 가정의 현금 증가(anchor-implied)이고, 이후 현금은 유지된다 — 예수금을 지어내지 않는다", () => {
    const { days, coverage } = timeline(history, [sync("2026-10-06", { AAA: 0, BBB: 0 })]);
    const flows = [{ date: "2026-10-01", amount: 1_000 }];
    const derived = buildDerivedCash({
      flows,
      trades: LEDGER.map((t) => ({ date: t.eventDate, side: t.side, amount: t.amount, fee: t.fee, tax: t.tax })),
      tradingDates: DATES,
    });
    const cash = buildCashSeries({ accountId: "pension", coverage, derived, flows, tradingDates: DATES }, days, bars);
    const base = cash.close.get("2026-10-01")!; // 1000 − 500 − 150 = 350
    expect(base).toBe(350);
    expect(cash.close.get("2026-10-05")).toBe(base);
    expect(cash.close.get("2026-10-06")).toBe(base + 5 * 100 + 3 * 50); // 종가 체결 가정으로 매도 대금이 현금으로
    expect(cash.close.get("2026-10-08")).toBe(base + 650); // 이후 유지
    expect(cash.quality.get("2026-10-06")).toBe("anchor-implied");
  });
});
