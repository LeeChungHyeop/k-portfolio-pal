// 수익 분석 엔진 — 실제 463건 데이터셋 + production 에서 실측한 checkpoint 로 고정한다.
//
// production 의 legacy anchor(`rowQuantitiesSnap`)는 저장소에 없으므로, **2026-10-08 에
// 실측한 값**을 fixture 로 박아둔다. 그래서 seam 테스트는
// "실제 원장 재생 == 실제 production anchor" 를 검증한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNT_IDS, type AccountId } from "./constants";
import { parseVerifiedDataset } from "./verified-transactions";
import { replayDailyHoldings, type DailyHoldingsDelta, type LedgerTransaction } from "./ledger";
import {
  STRATEGY_START_DATES,
  buildCoverageMap,
  resolvePerformanceStart,
  holdingsSourceFor,
  hasStarted,
  worstCashQuality,
  isExactSegment,
  type AccountCoverage,
} from "./ledger-coverage";
import {
  buildAccountTimeline,
  reconcileSeam,
  ledgerHoldingsThrough,
  anchorHoldings,
  type AccountTimelineInput,
} from "./holdings-timeline";
import { buildDerivedCash, cashAtOpen, cashAtClose } from "./derived-cash";
import {
  tradingDatesOf,
  valuate,
  buildCashSeries,
  valuateAccountDays,
  aggregateScope,
  buildSegments,
  segmentProfit,
  gapProfit,
  spanOfSegment,
  computeProfitAnalysis,
  accountJoinFlows,
  type AccountDayValuation,
} from "./profit-analysis";
import { verifiedCashflowsFor } from "./verified-cashflows";
import type { PriceBarsByTicker } from "./useHistoricalPrices";
import type { SnapshotHistoryLike } from "./snapshot";
import type { AssetLibraryEntry } from "./benchmark-series";

const DATASET_PATH = resolve(import.meta.dirname, "../../../data/verified-transactions.v1.json");
const dataset = parseVerifiedDataset(JSON.parse(readFileSync(DATASET_PATH, "utf-8")));
const transactions = dataset.transactions as LedgerTransaction[];
const dailyByAccount = replayDailyHoldings(transactions);

// ── production 실측 fixture (2026-10-08) ───────────────────────────────────

/** 계좌별 첫 유효 `rowQuantitiesSnap` 날짜 = seam */
const SEAM_DATES: Record<AccountId, string> = {
  retirement: "2026-06-26",
  isa: "2026-06-18",
  pension: "2026-06-26",
  irp: "2026-06-26",
};

/** 그 seam anchor 의 보유수량 (ticker 기준). production 실측값. */
const SEAM_HOLDINGS: Record<AccountId, Record<string, number>> = {
  retirement: {
    "0072R0": 633,
    "0085P0": 408,
    "0162Z0": 1211,
    "0167A0": 691,
    "0181B0": 1279,
    "360750": 651,
    "484790": 526,
  },
  // isa 의 seam 은 2026-06-18 이다 — 0167A0 991 (803 은 그 뒤 06-26 값이다)
  isa: { "0167A0": 991, "0181B0": 978, "360750": 1021 },
  pension: { "0167A0": 114, "0181B0": 245, "360750": 148 },
  irp: { "0162Z0": 98, "0167A0": 45, "0181B0": 86, "360750": 36 },
};

/** 원장 마지막 실효 거래일 (데이터에서 계산되지만 지금 값을 고정해 회귀를 잡는다) */
const CUTOFFS: Record<AccountId, string> = {
  retirement: "2026-10-01",
  isa: "2026-06-26",
  pension: "2026-08-28",
  irp: "2026-08-28",
};

const ASSET_LIBRARY = [
  { ticker: "360750", defaultEtf: "TIGER 미국S&P500" },
  { ticker: "0072R0", defaultEtf: "TIGER KRX 금현물" },
  { ticker: "0085P0", defaultEtf: "ACE 미국10년국채액티브" },
  { ticker: "484790", defaultEtf: "KODEX 미국30년국채액티브(H)" },
  { ticker: "0162Z0", defaultEtf: "RISE 삼성전자SK하이닉스채권혼합" },
  { ticker: "0167A0", defaultEtf: "SOL AI반도체TOP2플러스" },
  { ticker: "0181B0", defaultEtf: "HANARO 미국AI메모리반도체 TOP4+" },
] satisfies AssetLibraryEntry[];

/** seam fixture → legacy history 모양(rowId → 수량 / rowId → ETF명) */
function historyFor(accountId: AccountId): SnapshotHistoryLike[] {
  const qty: Record<string, number> = {};
  const etf: Record<string, string> = {};
  for (const [ticker, q] of Object.entries(SEAM_HOLDINGS[accountId])) {
    const lib = ASSET_LIBRARY.find((a) => a.ticker === ticker)!;
    qty[`row_${ticker}`] = q;
    etf[`row_${ticker}`] = lib.defaultEtf;
  }
  return [{ date: SEAM_DATES[accountId], rowQuantitiesSnap: qty, rowEtfSnap: etf }];
}

// ── 가짜 거래일·가격 (순수 로직 검증용) ────────────────────────────────────

function makeBars(
  dates: string[],
  tickers: string[],
  f: (t: string, i: number) => { open: number; close: number },
): PriceBarsByTicker {
  const out: PriceBarsByTicker = {};
  for (const t of tickers) {
    out[t] = {};
    dates.forEach((d, i) => {
      out[t][d] = f(t, i);
    });
  }
  return out;
}

// ── coverage ────────────────────────────────────────────────────────────────

describe("ledger-coverage", () => {
  const tradingDates = ["2025-09-09", "2025-09-10", "2025-09-11", "2025-09-12"];
  const coverage0 = buildCoverageMap(
    ACCOUNT_IDS.map((id) => ({
      accountId: id,
      ledgerDates: transactions.filter((t) => t.accountId === id).map((t) => t.eventDate),
      cashflowDates: verifiedCashflowsFor(id).map((f) => f.date),
      history: historyFor(id),
    })),
  );

  it("cutoff 와 seam 은 데이터에서 계산된다", () => {
    for (const id of ACCOUNT_IDS) {
      expect(coverage0[id].ledgerCutoff).toBe(CUTOFFS[id]);
      expect(coverage0[id].seam).toBe(SEAM_DATES[id]);
    }
  });

  it("계좌 개시일은 min(첫 입금, 첫 거래) — retirement 는 첫 거래보다 이른 입금이다", () => {
    expect(coverage0.retirement.inception).toBe("2025-03-25");
    expect(coverage0.pension.inception).toBe("2025-11-10");
    expect(coverage0.irp.inception).toBe("2025-12-29");
    expect(coverage0.isa.inception).toBe("2026-01-06");
  });

  it("★ retirement 성과 시작은 2025-09-11 — 전략 시작일(09-10)은 전환일이라 제외한다", () => {
    const before = ledgerHoldingsThrough(dailyByAccount.retirement, "2025-09-09");
    // 전략 시작 직전에 pre-strategy 보유가 있다 (실측: 133690 / 232080 / 360750)
    expect(before).toEqual({ "133690": 73, "232080": 10, "360750": 565 });
    const cv = resolvePerformanceStart(coverage0.retirement, before, tradingDates);
    expect(cv.strategyStartIsTransition).toBe(true);
    expect(cv.performanceStart).toBe("2025-09-11");
  });

  it("전략 시작 전 보유가 없는 계좌는 전략 시작일 당일부터다", () => {
    for (const id of ["pension", "irp", "isa"] as AccountId[]) {
      const start = STRATEGY_START_DATES[id];
      const before = ledgerHoldingsThrough(dailyByAccount[id] ?? [], "2000-01-01");
      expect(before).toEqual({});
      const cv = resolvePerformanceStart(coverage0[id], before, [start, "2099-01-01"]);
      expect(cv.strategyStartIsTransition).toBe(false);
      expect(cv.performanceStart).toBe(start);
    }
  });

  it("★ cutoff 전에는 ledger, 후에는 anchor 를 쓴다", () => {
    const cv = coverage0.pension; // cutoff 2026-08-28
    expect(holdingsSourceFor(cv, "2026-06-18")).toBe("ledger"); // seam 이전
    expect(holdingsSourceFor(cv, "2026-06-26")).toBe("ledger"); // seam 당일 — switch 지점이 아니다
    expect(holdingsSourceFor(cv, "2026-07-31")).toBe("ledger"); // seam 이후, cutoff 이전
    expect(holdingsSourceFor(cv, "2026-08-28")).toBe("ledger"); // cutoff 당일
    expect(holdingsSourceFor(cv, "2026-08-31")).toBe("anchor"); // cutoff 이후
  });

  it("미개설 계좌와 결측을 구분한다", () => {
    expect(hasStarted(coverage0.isa, "2025-12-31")).toBe(false);
    expect(hasStarted(coverage0.isa, "2026-01-06")).toBe(true);
  });

  it("★ cash-unknown 이 섞인 구간은 exact 가 아니다", () => {
    expect(isExactSegment(["ledger", "ledger"], "derived")).toBe(true);
    expect(isExactSegment(["ledger", "ledger"], "unknown")).toBe(false);
    expect(isExactSegment(["ledger", "ledger"], "anchor-implied")).toBe(false);
    expect(isExactSegment(["ledger", "ledger"], "cashflow-pending")).toBe(false);
    expect(isExactSegment(["ledger", "anchor"], "derived")).toBe(false);
    // 가장 약한 고리를 따른다
    expect(worstCashQuality(["derived", "derived", "unknown"])).toBe("unknown");
    expect(worstCashQuality(["derived", "anchor-implied"])).toBe("anchor-implied");
    expect(worstCashQuality(["derived"])).toBe("derived");
  });
});

// ── seam reconciliation (게이트) ────────────────────────────────────────────

describe("seam reconciliation", () => {
  const coverage0 = buildCoverageMap(
    ACCOUNT_IDS.map((id) => ({
      accountId: id,
      ledgerDates: transactions.filter((t) => t.accountId === id).map((t) => t.eventDate),
      cashflowDates: verifiedCashflowsFor(id).map((f) => f.date),
      history: historyFor(id),
    })),
  );

  it("★ 전 계좌 seam 에서 ledger replay == production anchor, 불일치 0", () => {
    let compared = 0;
    for (const id of ACCOUNT_IDS) {
      const r = reconcileSeam(
        {
          accountId: id,
          coverage: coverage0[id],
          ledgerDays: dailyByAccount[id] ?? [],
          history: historyFor(id),
        },
        ASSET_LIBRARY,
      );
      expect(r.seam).toBe(SEAM_DATES[id]);
      expect(r.mismatches).toEqual([]);
      expect(r.unresolved).toEqual([]);
      expect(r.ok).toBe(true);
      compared += r.compared;
    }
    // 실측: 7 + 3 + 3 + 4 = 17 ticker-position
    expect(compared).toBe(17);
  });

  it("원장 재생값 자체가 실측 fixture 와 같다 (ticker 단위)", () => {
    for (const id of ACCOUNT_IDS) {
      const replayed = ledgerHoldingsThrough(dailyByAccount[id] ?? [], SEAM_DATES[id]);
      expect(replayed).toEqual(SEAM_HOLDINGS[id]);
    }
  });

  it("ticker 로 해석 못한 anchor 행은 조용히 버리지 않고 unresolved 로 올린다", () => {
    const res = anchorHoldings(
      { date: "2026-06-26", rowQuantitiesSnap: { a: 10 }, rowEtfSnap: { a: "없는 ETF 이름" } },
      ASSET_LIBRARY,
    );
    expect(res.holdings).toEqual({});
    expect(res.unresolved).toEqual(["a=없는 ETF 이름"]);
  });
});

// ── derived cash ────────────────────────────────────────────────────────────

describe("derived-cash", () => {
  const tradingDates = ["2025-09-24", "2025-09-25", "2025-09-26"];

  it("유도 예수금은 음수가 되지 않고, 결손 없는 구간에서는 derived 와 같다", () => {
    const s = buildDerivedCash({
      flows: [{ date: "2025-09-25", amount: 1_000_000 }],
      trades: [{ date: "2025-09-26", side: "buy", amount: 400_000, fee: null, tax: null }],
      tradingDates,
    });
    expect(s.byDate.get("2025-09-25")!.cash).toBe(1_000_000);
    expect(s.byDate.get("2025-09-25")!.incomeLB).toBe(0);
    expect(s.byDate.get("2025-09-26")!.cash).toBe(600_000);
    expect(s.maxDeficit).toBe(0);
  });

  it("결손이 생기면 incomeLB 가 정확히 그만큼 올라가 cash 가 0 이 된다", () => {
    const s = buildDerivedCash({
      flows: [],
      trades: [{ date: "2025-09-25", side: "buy", amount: 500_000, fee: null, tax: null }],
      tradingDates,
    });
    expect(s.byDate.get("2025-09-25")!.derived).toBe(-500_000);
    expect(s.byDate.get("2025-09-25")!.incomeLB).toBe(500_000);
    expect(s.byDate.get("2025-09-25")!.cash).toBe(0);
    expect(s.maxDeficitDate).toBe("2025-09-25");
  });

  it("fee/tax 가 null 이면 0 으로 채우지 않는다", () => {
    const withNull = buildDerivedCash({
      flows: [],
      trades: [{ date: "2025-09-25", side: "buy", amount: 100, fee: null, tax: null }],
      tradingDates,
    });
    const withZero = buildDerivedCash({
      flows: [],
      trades: [{ date: "2025-09-25", side: "buy", amount: 100, fee: 0, tax: 0 }],
      tradingDates,
    });
    expect(withNull.finalDerived).toBe(withZero.finalDerived);
    const withFee = buildDerivedCash({
      flows: [],
      trades: [{ date: "2025-09-25", side: "buy", amount: 100, fee: 7, tax: 3 }],
      tradingDates,
    });
    expect(withFee.finalDerived).toBe(-110);
  });

  it("after_close 입금은 다음 거래일부터 현금이다", () => {
    const s = buildDerivedCash({
      flows: [{ date: "2025-09-25", amount: 500_000, timing: "after_close" }],
      trades: [],
      tradingDates,
    });
    expect(s.byDate.has("2025-09-25")).toBe(false);
    expect(s.byDate.get("2025-09-26")!.cash).toBe(500_000);
  });

  it("cashAtOpen 은 그 날 이벤트를 하나도 반영하지 않는다 (당일 입금 제외)", () => {
    const s = buildDerivedCash({
      flows: [{ date: "2025-09-25", amount: 500_000 }],
      trades: [],
      tradingDates,
    });
    expect(cashAtOpen(s, "2025-09-25")).toBe(0);
    expect(cashAtClose(s, "2025-09-25")).toBe(500_000);
    // 이벤트가 없는 날은 직전 값을 유지한다 (현금은 가만히 있으면 그대로다)
    expect(cashAtClose(s, "2025-09-26")).toBe(500_000);
  });

  it("실측 — retirement 전략시작 시점 보수모델 예수금은 0 원이다", () => {
    const s = buildDerivedCash({
      flows: verifiedCashflowsFor("retirement").map((f) => ({
        date: f.date,
        amount: f.amount,
        timing: f.timing,
      })),
      trades: transactions
        .filter((t) => t.accountId === "retirement")
        .map((t) => ({
          date: t.eventDate,
          side: t.side,
          amount: t.amount,
          fee: t.fee,
          tax: t.tax,
        })),
      // 실제 거래일 대신 장부·원장 날짜를 모두 거래일로 본다(유효일 매핑만 쓰므로 충분)
      tradingDates: [
        ...new Set([
          ...verifiedCashflowsFor("retirement").map((f) => f.date),
          ...transactions.filter((t) => t.accountId === "retirement").map((t) => t.eventDate),
        ]),
      ].sort(),
    });
    // 전략 시작일(= 전액 투입일)에 예수금이 0 원이다 — 60.9M 유휴현금 구간이 그 앞이다
    expect(cashAtClose(s, "2025-09-10")).toBe(0);
    // 퇴직연금 부담금은 `after_close` 라 **다음 거래일**부터 현금이다. 09-25 저녁 입금은
    // 09-25 종료 시점 자산에 들어가지 않고(그 날 F 에도 안 들어간다) 09-26 로 넘어간다.
    expect(cashAtClose(s, "2025-09-25")).toBe(0);
    // 최대 결손과 최종값 — production 실측 고정값
    expect(Math.round(s.maxDeficit)).toBe(-1_658_004);
    expect(s.maxDeficitDate).toBe("2026-08-28");
    expect(Math.round(s.finalDerived)).toBe(-1_655_470);
    // 보수 모델은 결손만큼 올라가므로 cutoff 시점 예수금은 두 값의 차이다
    expect(Math.round(cashAtClose(s, "2026-10-01"))).toBe(-1_655_470 + 1_658_004);
  });

  it("실측 — same_day 입금 계좌는 입금액이 다음 리밸런싱까지 현금으로 남는다 (톱니)", () => {
    // 연금저축은 `same_day` 다 — 입금 당일부터 현금이다.
    const flows = verifiedCashflowsFor("pension");
    const trades = transactions.filter((t) => t.accountId === "pension");
    const s = buildDerivedCash({
      flows: flows.map((f) => ({ date: f.date, amount: f.amount, timing: f.timing })),
      trades: trades.map((t) => ({
        date: t.eventDate,
        side: t.side,
        amount: t.amount,
        fee: t.fee,
        tax: t.tax,
      })),
      tradingDates: [
        ...new Set([...flows.map((f) => f.date), ...trades.map((t) => t.eventDate)]),
      ].sort(),
    });
    // ★ 톱니 — 2026-02-25 입금 500,000 이 현금으로 남고, 다음 거래일 리밸런싱에서 쓰인다.
    // `cashBalance: 0` 으로 두면 이 두 날에 가짜 손실/가짜 이익이 생긴다.
    expect(Math.round(cashAtClose(s, "2026-02-25"))).toBe(500_000);
    expect(Math.round(cashAtClose(s, "2026-02-26"))).toBe(3_999);
    // 6월·7월·8월도 같은 모양이다
    expect(Math.round(cashAtClose(s, "2026-06-25"))).toBe(500_847);
    expect(Math.round(cashAtClose(s, "2026-06-26"))).toBe(11_585);
    // 최초 6,000,000 입금 전에는 0 이고, 입금 당일(same_day)부터 잔액이 생긴다
    expect(cashAtClose(s, "2025-11-09")).toBe(0);
    expect(Math.round(cashAtClose(s, "2025-11-10"))).toBe(2_299);
    // 최대 결손 실측값
    expect(Math.round(s.maxDeficit)).toBe(-58_116);
    expect(s.maxDeficitDate).toBe("2026-05-26");
  });
});

// ── 손익 분해 / 항등식 ──────────────────────────────────────────────────────

describe("손익 분해와 항등식", () => {
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06"];
  const coverage: AccountCoverage = {
    accountId: "isa" as AccountId,
    inception: "2026-01-02",
    strategyStart: "2026-01-02",
    performanceStart: "2026-01-02",
    strategyStartIsTransition: false,
    seam: "2026-01-05",
    ledgerCutoff: "2026-01-06",
    anchorDates: ["2026-01-05"],
  };

  // A: 10,000 → 11,000 (장중 +1,000), B: 5,000 → 4,500
  const bars: PriceBarsByTicker = {
    A: {
      "2026-01-02": { open: 10_000, close: 11_000 },
      "2026-01-05": { open: 11_500, close: 12_000 },
      "2026-01-06": { open: 12_000, close: 12_500 },
    },
    B: {
      "2026-01-02": { open: 5_000, close: 4_500 },
      "2026-01-05": { open: 4_600, close: 4_700 },
      "2026-01-06": { open: 4_700, close: 4_800 },
    },
  };

  const ledgerDays: DailyHoldingsDelta[] = [
    // 1/2: A 10주 매수 (체결 10,500 → 종가 11,000 이라 ②가 +5,000)
    {
      date: "2026-01-02",
      deltas: { A: 10 },
      execPrice: { A: 10_500 },
      netCashDelta: -105_000,
      reportedCosts: 0,
    },
    // 1/5: B 5주 매수
    {
      date: "2026-01-05",
      deltas: { B: 5 },
      execPrice: { B: 4_650 },
      netCashDelta: -23_250,
      reportedCosts: 50,
    },
  ];

  const timeline: AccountTimelineInput = { accountId: "isa", coverage, ledgerDays, history: [] };

  function build() {
    const days = buildAccountTimeline(timeline, ASSET_LIBRARY, dates);
    const derived = buildDerivedCash({
      flows: [{ date: "2026-01-02", amount: 200_000 }],
      trades: [
        { date: "2026-01-02", side: "buy", amount: 105_000, fee: null, tax: null },
        { date: "2026-01-05", side: "buy", amount: 23_250, fee: 50, tax: null },
      ],
      tradingDates: dates,
    });
    const cash = buildCashSeries(
      {
        accountId: "isa",
        coverage,
        derived,
        flows: [{ date: "2026-01-02", amount: 200_000 }],
        tradingDates: dates,
      },
      days,
      bars,
    );
    return { days, derived, vals: valuateAccountDays(days, cash, bars) };
  }

  it("★ profit = ① + ② − ③ 가 V_close − V_open − F 와 정확히 같다 (daily)", () => {
    const { vals } = build();
    const flows = [{ date: "2026-01-02", amount: 200_000 }];
    for (const v of vals) {
      expect(v.usable).toBe(true);
      const f = flows.filter((x) => x.date === v.date).reduce((s, x) => s + x.amount, 0);
      expect(v.vClose - v.vOpen - f).toBeCloseTo(v.term1 + v.term2 - v.costs, 6);
    }
  });

  it("①②③ 의 의미 — 1/2 는 보유 0 에서 시작하므로 ①=0, ②는 체결가→종가 차익", () => {
    const { vals } = build();
    const d0 = vals.find((v) => v.date === "2026-01-02")!;
    expect(d0.term1).toBe(0); // 장 시작 보유가 없다
    expect(d0.term2).toBe(10 * 11_000 - 105_000); // = 5,000
    const d1 = vals.find((v) => v.date === "2026-01-05")!;
    expect(d1.term1).toBe(10 * (12_000 - 11_500)); // A 10주 × 장중 +500
    expect(d1.term2).toBe(5 * 4_700 - 23_250); // = 250
    expect(d1.costs).toBe(50);
  });

  it("★ 손익은 예수금 수준의 상수 오차에 불변이다 (분모만 바뀐다)", () => {
    const { days } = build();
    const base = buildDerivedCash({
      flows: [{ date: "2026-01-02", amount: 200_000 }],
      trades: [{ date: "2026-01-02", side: "buy", amount: 105_000, fee: null, tax: null }],
      tradingDates: dates,
    });
    const shifted = buildDerivedCash({
      // 과거에 쓰고 남은 현금이 999,999 더 있었다고 하자
      flows: [{ date: "2026-01-02", amount: 200_000 + 999_999 }],
      trades: [{ date: "2026-01-02", side: "buy", amount: 105_000, fee: null, tax: null }],
      tradingDates: dates,
    });
    const mk = (d: typeof base) =>
      valuateAccountDays(
        days,
        buildCashSeries(
          { accountId: "isa", coverage, derived: d, flows: [], tradingDates: dates },
          days,
          bars,
        ),
        bars,
      );
    const a = mk(base),
      b = mk(shifted);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].term1 + b[i].term2 - b[i].costs).toBeCloseTo(
        a[i].term1 + a[i].term2 - a[i].costs,
        6,
      );
      expect(b[i].vOpen - a[i].vOpen).toBeCloseTo(i === 0 ? 0 : 999_999, 6); // 분모만 움직인다
    }
  });

  it("★ 내부 매매는 외부흐름이 아니다 — 거래만 있는 날의 netCashflow 는 0", () => {
    const { vals } = build();
    const scope = aggregateScope(vals, [coverage], ["isa"]);
    const segs = buildSegments(
      scope.map((d) => d.date),
      "daily",
    );
    const seg = segs.find((s) => s.openDate === "2026-01-05")!;
    const r = segmentProfit(seg, scope, [], { recognized: 0, headroom: 0 }, "full");
    expect(r.netCashflow).toBe(0); // 그 날 외부 입출금이 없다
    expect(r.knownProfit).toBeCloseTo(
      vals.find((v) => v.date === "2026-01-05")!.vClose -
        vals.find((v) => v.date === "2026-01-05")!.vOpen,
      6,
    );
  });

  it("★ monthly 는 daily 의 합이 아니다 — bridge 항등식으로 정확히 설명된다", () => {
    const { vals } = build();
    const scope = aggregateScope(vals, [coverage], ["isa"]);
    const flows = [{ date: "2026-01-02", amount: 200_000 }];
    const [month] = buildSegments(
      scope.map((d) => d.date),
      "monthly",
    );
    const m = segmentProfit(month, scope, flows, { recognized: 0, headroom: 0 }, "full");

    const byDate = new Map(scope.map((d) => [d.date, d]));
    let dailySum = 0,
      gapSum = 0;
    const ds = buildSegments(
      scope.map((d) => d.date),
      "daily",
    );
    ds.forEach((s, i) => {
      const r = segmentProfit(s, scope, flows, { recognized: 0, headroom: 0 }, "full");
      dailySum += r.knownProfit;
      if (i > 0) gapSum += gapProfit(byDate.get(ds[i - 1].openDate)!, byDate.get(s.openDate)!);
    });

    expect(gapSum).not.toBe(0); // 오버나이트 갭이 실제로 있다
    expect(m.knownProfit).not.toBeCloseTo(dailySum, 2); // 합성값이 아니다
    expect(m.knownProfit).toBeCloseTo(dailySum + gapSum, 6); // bridge 항등식
  });

  it("★ source 가 바뀌는 경계에서 인위적 valuation jump 가 없다", () => {
    // 1/6 은 cutoff 당일(ledger), 1/7 은 anchor 구간. anchor 수량이 cutoff 종료 수량과
    // 같으면 자산이 연속이어야 한다.
    const anchorHistory: SnapshotHistoryLike[] = [
      {
        date: "2026-01-06",
        rowQuantitiesSnap: { rA: 10, rB: 5 },
        rowEtfSnap: { rA: "TIGER 미국S&P500", rB: "TIGER KRX 금현물" },
      },
    ];
    const bars2: PriceBarsByTicker = {
      "360750": { ...bars.A, "2026-01-07": { open: 12_500, close: 12_600 } },
      "0072R0": { ...bars.B, "2026-01-07": { open: 4_800, close: 4_850 } },
    };
    const dates2 = [...dates, "2026-01-07"];
    const cov2: AccountCoverage = {
      ...coverage,
      ledgerCutoff: "2026-01-06",
      seam: "2026-01-06",
      anchorDates: ["2026-01-06"],
    };
    const ledger2: DailyHoldingsDelta[] = [
      {
        date: "2026-01-02",
        deltas: { "360750": 10 },
        execPrice: {},
        netCashDelta: -105_000,
        reportedCosts: 0,
      },
      {
        date: "2026-01-05",
        deltas: { "0072R0": 5 },
        execPrice: {},
        netCashDelta: -23_250,
        reportedCosts: 0,
      },
    ];
    const days = buildAccountTimeline(
      { accountId: "isa", coverage: cov2, ledgerDays: ledger2, history: anchorHistory },
      ASSET_LIBRARY,
      dates2,
    );
    const d16 = days.find((d) => d.date === "2026-01-06")!;
    const d17 = days.find((d) => d.date === "2026-01-07")!;
    expect(d16.source).toBe("ledger");
    expect(d17.source).toBe("anchor");
    // 경계를 가로질러 보유수량이 같다 → 평가액 점프가 없다
    expect(d17.openHoldings).toEqual(d16.closeHoldings);
    expect(d17.traded).toBe(false);
    const vOpen17 = valuate(d17.openHoldings, bars2, "2026-01-07", "open")!.value;
    const vClose16 = valuate(d16.closeHoldings, bars2, "2026-01-06", "close")!.value;
    // 차이는 **오버나이트 가격 변동뿐**이어야 한다 (수량 변화로 인한 점프가 아니다)
    const expectedGap = 10 * (12_500 - 12_500) + 5 * (4_800 - 4_800);
    expect(vOpen17 - vClose16).toBeCloseTo(expectedGap, 6);
  });

  it("anchor 구간의 리밸런싱일은 ②=0 이다 (체결가를 모르므로 종가 체결 가정)", () => {
    const anchorHistory: SnapshotHistoryLike[] = [
      { date: "2026-01-05", rowQuantitiesSnap: { rA: 10 }, rowEtfSnap: { rA: "TIGER 미국S&P500" } },
      { date: "2026-01-06", rowQuantitiesSnap: { rA: 4 }, rowEtfSnap: { rA: "TIGER 미국S&P500" } },
    ];
    const bars2: PriceBarsByTicker = { "360750": bars.A };
    const cov2: AccountCoverage = {
      ...coverage,
      ledgerCutoff: "2026-01-02",
      anchorDates: ["2026-01-05", "2026-01-06"],
    };
    const days = buildAccountTimeline(
      { accountId: "isa", coverage: cov2, ledgerDays: [], history: anchorHistory },
      ASSET_LIBRARY,
      dates,
    );
    const d = days.find((x) => x.date === "2026-01-06")!;
    expect(d.source).toBe("anchor");
    expect(d.traded).toBe(true);
    expect(d.netCashDelta).toBeNull();
    // anchor 가 10주를 만들어내므로(1/5) 그 값을 살 현금이 먼저 있어야 한다.
    // 현금이 모자라면 가정이 깨진 것이고 모델은 그것을 `unknown` 으로 드러낸다.
    const flows = [{ date: "2026-01-02", amount: 200_000 }];
    const derived = buildDerivedCash({ flows, trades: [], tradingDates: dates });
    const cash = buildCashSeries(
      { accountId: "isa", coverage: cov2, derived, flows, tradingDates: dates },
      days,
      bars2,
    );
    const vals = valuateAccountDays(days, cash, bars2);
    const v = vals.find((x) => x.date === "2026-01-06")!;
    expect(v.term2).toBe(0); // 없는 매매 손익을 만들지 않는다
    expect(v.cashQuality).toBe("anchor-implied");
    // 1/5 에 10주 매수(종가 12,000) → 현금 200,000 − 120,000 = 80,000
    // 1/6 에 6주 매도(종가 12,500)   → 현금 80,000 + 75,000 = 155,000
    expect(cash.close.get("2026-01-05")).toBeCloseTo(80_000, 6);
    expect(cash.close.get("2026-01-06")).toBeCloseTo(155_000, 6);
  });

  it("anchor 구간에서 현금이 음수가 되면 가정이 깨진 것이므로 unknown 으로 드러낸다", () => {
    const anchorHistory: SnapshotHistoryLike[] = [
      { date: "2026-01-05", rowQuantitiesSnap: { rA: 10 }, rowEtfSnap: { rA: "TIGER 미국S&P500" } },
    ];
    const bars2: PriceBarsByTicker = { "360750": bars.A };
    const cov2: AccountCoverage = {
      ...coverage,
      ledgerCutoff: "2026-01-02",
      anchorDates: ["2026-01-05"],
    };
    const days = buildAccountTimeline(
      { accountId: "isa", coverage: cov2, ledgerDays: [], history: anchorHistory },
      ASSET_LIBRARY,
      dates,
    );
    const derived = buildDerivedCash({ flows: [], trades: [], tradingDates: dates });
    const cash = buildCashSeries(
      { accountId: "isa", coverage: cov2, derived, flows: [], tradingDates: dates },
      days,
      bars2,
    );
    // 현금 0 인데 anchor 가 120,000 어치를 사들였다 → 설명되지 않는다
    expect(cash.quality.get("2026-01-05")).toBe("unknown");
  });
});

// ── fail closed / scope ─────────────────────────────────────────────────────

describe("fail closed 와 scope 합산", () => {
  it("가격이 하나라도 없으면 그 계좌·날짜를 평가하지 않는다", () => {
    expect(
      valuate({ A: 1 }, { A: { "2026-01-02": { open: 1, close: 2 } } }, "2026-01-02", "open"),
    ).not.toBeNull();
    expect(
      valuate({ A: 1, B: 1 }, { A: { "2026-01-02": { open: 1, close: 2 } } }, "2026-01-02", "open"),
    ).toBeNull();
    // 0 이하 가격은 없는 것으로 본다
    expect(
      valuate({ A: 1 }, { A: { "2026-01-02": { open: 0, close: 2 } } }, "2026-01-02", "open"),
    ).toBeNull();
  });

  it("거래일은 가격이 실제로 있는 날짜뿐이다 — 휴장일을 만들지 않는다", () => {
    expect(
      tradingDatesOf({
        A: { "2026-01-02": { open: 1, close: 1 }, "2026-01-05": { open: 1, close: 1 } },
        B: { "2026-01-05": { open: 1, close: 1 }, "2026-01-06": { open: 1, close: 1 } },
      }),
    ).toEqual(["2026-01-02", "2026-01-05", "2026-01-06"]);
  });

  it("성과 구간에 들어온 계좌가 하나라도 평가 불가면 그 날짜는 point 가 되지 않는다", () => {
    const cov = (id: string, start: string): AccountCoverage => ({
      accountId: id as AccountId,
      inception: start,
      strategyStart: start,
      performanceStart: start,
      strategyStartIsTransition: false,
      seam: null,
      ledgerCutoff: null,
      anchorDates: [],
    });
    const covs = [cov("retirement", "2026-01-02"), cov("isa", "2026-01-05")];
    const mk = (date: string, accountId: string, usable: boolean) => ({
      date,
      accountId,
      vOpen: 100,
      vClose: 110,
      term1: 10,
      term2: 0,
      costs: 0,
      holdingsSource: "ledger" as const,
      cashQuality: "derived" as const,
      usable,
      missing: [],
    });
    const vals = [
      mk("2026-01-02", "retirement", true), // isa 는 아직 미개설 → 0 으로 본다
      mk("2026-01-05", "retirement", true),
      mk("2026-01-05", "isa", false), // isa 평가 불가 → 날짜 버림
      mk("2026-01-06", "retirement", true),
      mk("2026-01-06", "isa", true),
    ];
    const scope = aggregateScope(vals, covs, ["retirement", "isa"]);
    expect(scope.map((s) => s.date)).toEqual(["2026-01-02", "2026-01-06"]);
    expect(scope[0].vOpen).toBe(100); // 미개설 계좌는 0 으로 더한다 (결측이 아니다)
    expect(scope[1].vOpen).toBe(200);
  });
});

// ── 구간 만들기 / span ──────────────────────────────────────────────────────

describe("구간 경계", () => {
  const dates = [
    "2025-12-29",
    "2025-12-30",
    "2026-01-02",
    "2026-01-05",
    "2026-01-30",
    "2026-02-02",
    "2026-02-27",
  ];

  it("월·연 경계는 **실제 거래일**이다 (1월 1일 같은 가짜 날짜를 쓰지 않는다)", () => {
    const months = buildSegments(dates, "monthly");
    expect(months.map((m) => [m.key, m.openDate, m.closeDate])).toEqual([
      ["2025-12", "2025-12-29", "2025-12-30"],
      ["2026-01", "2026-01-02", "2026-01-30"],
      ["2026-02", "2026-02-02", "2026-02-27"],
    ]);
    const years = buildSegments(dates, "yearly");
    expect(years.map((y) => [y.key, y.openDate, y.closeDate])).toEqual([
      ["2025", "2025-12-29", "2025-12-30"],
      ["2026", "2026-01-02", "2026-02-27"],
    ]);
    // 연간 라벨에 실제 거래일 범위가 들어간다
    expect(years[1].label).toBe("2026년 (01/02~02/27)");
  });

  it("거래일이 1일뿐인 월·연 구간은 만들지 않는다 (daily 는 만든다)", () => {
    expect(buildSegments(["2025-12-30"], "monthly")).toEqual([]);
    expect(buildSegments(["2025-12-30"], "yearly")).toEqual([]);
    expect(buildSegments(["2025-12-30"], "daily")).toHaveLength(1);
  });

  it("span — 첫 구간은 account-inception, 마지막 구간은 in-progress", () => {
    const years = buildSegments(dates, "yearly");
    expect(spanOfSegment(years[0], "yearly", "2025-12-29", "2026-02-27")).toBe("account-inception");
    expect(spanOfSegment(years[1], "yearly", "2025-12-29", "2026-02-27")).toBe("in-progress");
    expect(
      spanOfSegment(buildSegments(dates, "daily")[0], "daily", "2025-12-29", "2026-02-27"),
    ).toBe("full");
  });

  it("유효일 가중 — 구간 첫날 입금은 가중치 1, 마지막날 입금은 0", () => {
    const scope = [
      {
        date: "2026-01-02",
        vOpen: 1_000_000,
        vClose: 1_000_000,
        term1: 0,
        term2: 0,
        costs: 0,
        holdingsSources: ["ledger" as const],
        cashQuality: "derived" as const,
      },
      {
        date: "2026-01-30",
        vOpen: 1_000_000,
        vClose: 1_000_000,
        term1: 0,
        term2: 0,
        costs: 0,
        holdingsSources: ["ledger" as const],
        cashQuality: "derived" as const,
      },
    ];
    const [seg] = buildSegments(["2026-01-02", "2026-01-30"], "monthly");
    const atOpen = segmentProfit(
      seg,
      scope,
      [{ date: "2026-01-02", amount: 100_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    const atClose = segmentProfit(
      seg,
      scope,
      [{ date: "2026-01-30", amount: 100_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    expect(atOpen.averageCapital).toBe(1_100_000);
    expect(atClose.averageCapital).toBe(1_000_000);
  });

  it("daily 분모는 V_open 이다 (당일 흐름 가중치 0)", () => {
    const scope = [
      {
        date: "2026-01-02",
        vOpen: 500_000,
        vClose: 505_000,
        term1: 5_000,
        term2: 0,
        costs: 0,
        holdingsSources: ["ledger" as const],
        cashQuality: "derived" as const,
      },
    ];
    const [seg] = buildSegments(["2026-01-02"], "daily");
    const r = segmentProfit(
      seg,
      scope,
      [{ date: "2026-01-02", amount: 300_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    expect(r.averageCapital).toBe(500_000);
  });
});

// ── L3 범위 ─────────────────────────────────────────────────────────────────

describe("미관측 현금수입(L3) 범위", () => {
  it("상한이 없는 계좌가 섞이면 구간 상한도 null 이고 exact 가 아니다", () => {
    const cov: AccountCoverage = {
      accountId: "isa" as AccountId,
      inception: "2026-01-02",
      strategyStart: "2026-01-02",
      performanceStart: "2026-01-02",
      strategyStartIsTransition: false,
      seam: null,
      ledgerCutoff: "2026-01-05",
      anchorDates: [],
    };
    const vals = [
      {
        date: "2026-01-02",
        accountId: "isa",
        vOpen: 100,
        vClose: 110,
        term1: 10,
        term2: 0,
        costs: 0,
        holdingsSource: "ledger" as const,
        cashQuality: "derived" as const,
        usable: true,
        missing: [],
      },
      {
        date: "2026-01-05",
        accountId: "isa",
        vOpen: 110,
        vClose: 115,
        term1: 5,
        term2: 0,
        costs: 0,
        holdingsSource: "ledger" as const,
        cashQuality: "unknown" as const,
        usable: true,
        missing: [],
      },
    ];
    const derived = buildDerivedCash({
      flows: [],
      trades: [],
      tradingDates: ["2026-01-02", "2026-01-05"],
    });
    const res = computeProfitAnalysis({
      valuations: vals,
      coverages: [cov],
      scopeAccountIds: ["isa"],
      period: "monthly",
      flows: [],
      incomeSources: [{ accountId: "isa", derived, cap: null }],
    });
    expect(res).toHaveLength(1);
    expect(res[0].incomeUpperBound).toBeNull();
    expect(res[0].returnPctHigh).toBeNull();
    expect(res[0].cashQuality).toBe("unknown");
    expect(res[0].exact).toBe(false); // ★ cash-unknown 이 섞이면 exact 아님
  });

  it("상한이 있으면 수익률이 범위로 나온다", () => {
    const cov: AccountCoverage = {
      accountId: "isa" as AccountId,
      inception: "2026-01-02",
      strategyStart: "2026-01-02",
      performanceStart: "2026-01-02",
      strategyStartIsTransition: false,
      seam: null,
      ledgerCutoff: "2026-01-05",
      anchorDates: [],
    };
    const vals = [
      {
        date: "2026-01-02",
        accountId: "isa",
        vOpen: 1_000_000,
        vClose: 1_010_000,
        term1: 10_000,
        term2: 0,
        costs: 0,
        holdingsSource: "ledger" as const,
        cashQuality: "derived" as const,
        usable: true,
        missing: [],
      },
      {
        date: "2026-01-05",
        accountId: "isa",
        vOpen: 1_010_000,
        vClose: 1_020_000,
        term1: 10_000,
        term2: 0,
        costs: 0,
        holdingsSource: "ledger" as const,
        cashQuality: "derived" as const,
        usable: true,
        missing: [],
      },
    ];
    const derived = buildDerivedCash({
      flows: [],
      trades: [],
      tradingDates: ["2026-01-02", "2026-01-05"],
    });
    const res = computeProfitAnalysis({
      valuations: vals,
      coverages: [cov],
      scopeAccountIds: ["isa"],
      period: "monthly",
      flows: [],
      incomeSources: [{ accountId: "isa", derived, cap: 5_000 }],
    });
    expect(res[0].incomeLowerBound).toBe(0);
    expect(res[0].incomeUpperBound).toBe(5_000);
    expect(res[0].returnPctLow).toBeCloseTo(2.0, 6); // 20,000 / 1,000,000
    expect(res[0].returnPctHigh).toBeCloseTo(2.5, 6); // 25,000 / 1,000,000
    expect(res[0].exact).toBe(true);
  });
});

// ── 수익률 분모/분자 회귀 ───────────────────────────────────────────────────
//
// 2026 전체가 −0.82% 대신 **−0.02%** 로 나왔던 버그의 재발 방지.
// 원인은 분모가 아니라 분자였다 — 예수금이 `derivedCash + incomeLB` 라서
// `V_close − V_open − F` 안에 이미 ΔincomeLB 가 들어 있는데, 수익률을 낼 때
// 그 값을 **한 번 더** 더하고 있었다.

describe("수익률 분모·분자 회귀", () => {
  const dates = ["2026-01-02", "2026-02-02", "2026-03-02"];
  const mk = (date: string, vOpen: number, vClose: number) => ({
    date,
    vOpen,
    vClose,
    term1: vClose - vOpen,
    term2: 0,
    costs: 0,
    holdingsSources: ["ledger" as const],
    cashQuality: "derived" as const,
  });

  it("★ 분모 = 기초자산 + Σ(가중 외부흐름) — 일간 자본을 누적하지 않는다", () => {
    const scope = [
      mk("2026-01-02", 100_000_000, 100_000_000),
      mk("2026-02-02", 100_000_000, 100_000_000),
      mk("2026-03-02", 100_000_000, 100_000_000),
    ];
    const [seg] = buildSegments(dates, "yearly");
    const flows = [{ date: "2026-02-02", amount: 10_000_000 }];
    const r = segmentProfit(seg, scope, flows, { recognized: 0, headroom: 0 }, "full");
    // T = 1/2 ~ 3/2 = 59일, ti = 31일 → w = (59-31)/59
    const w = (59 - 31) / 59;
    expect(r.averageCapital).toBeCloseTo(100_000_000 + 10_000_000 * w, 6);
    // 일간 vOpen 합(3억)과는 분명히 다르다 — 그게 버그의 모양이었다
    const sumDaily = scope.reduce((s, d) => s + d.vOpen, 0);
    expect(r.averageCapital).toBeLessThan(sumDaily);
  });

  it("★ 분모는 현실적인 자본 규모를 벗어나지 않는다 (기초자산 + 총유입 상한)", () => {
    const scope = [
      mk("2026-01-02", 81_575_665, 81_575_665),
      mk("2026-02-02", 90_000_000, 90_000_000),
      mk("2026-03-02", 148_174_504, 148_174_504),
    ];
    const [seg] = buildSegments(dates, "yearly");
    const flows = [
      { date: "2026-01-02", amount: 30_000_000 },
      { date: "2026-02-02", amount: 37_595_443 },
    ];
    const r = segmentProfit(seg, scope, flows, { recognized: 0, headroom: 0 }, "full");
    const grossIn = flows.reduce((s, f) => s + Math.max(0, f.amount), 0);
    // 가중치가 [0,1] 이므로 분모는 반드시 이 사이다
    expect(r.averageCapital).toBeGreaterThanOrEqual(scope[0].vOpen);
    expect(r.averageCapital).toBeLessThanOrEqual(scope[0].vOpen + grossIn);
    // 260 거래일을 더한 규모(수백억)가 절대 나오면 안 된다
    expect(r.averageCapital).toBeLessThan(1_000_000_000);
  });

  it("★ 외부흐름 가중치는 **일수** 기준이고 [0,1] 안에 있다 (ms 단위 아님)", () => {
    const scope = [
      mk("2026-01-02", 1_000_000, 1_000_000),
      mk("2026-02-02", 1_000_000, 1_000_000),
      mk("2026-03-02", 1_000_000, 1_000_000),
    ];
    const [seg] = buildSegments(dates, "yearly");
    // 구간 첫날 입금 → w=1, 마지막날 입금 → w=0, 중간 → 0<w<1
    const atOpen = segmentProfit(
      seg,
      scope,
      [{ date: "2026-01-02", amount: 500_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    const atClose = segmentProfit(
      seg,
      scope,
      [{ date: "2026-03-02", amount: 500_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    const mid = segmentProfit(
      seg,
      scope,
      [{ date: "2026-02-02", amount: 500_000 }],
      { recognized: 0, headroom: 0 },
      "full",
    );
    expect(atOpen.averageCapital).toBe(1_500_000); // w = 1
    expect(atClose.averageCapital).toBe(1_000_000); // w = 0
    expect(mid.averageCapital).toBeGreaterThan(1_000_000);
    expect(mid.averageCapital).toBeLessThan(1_500_000);
    // ms 단위였다면 가중금액이 천문학적이 된다
    expect(mid.averageCapital).toBeLessThan(2_000_000);
  });

  it("★ 분자에 미관측 수입 하한을 **다시 더하지 않는다** (이중계산 금지)", () => {
    const scope = [
      mk("2026-01-02", 100_000_000, 100_000_000),
      mk("2026-02-02", 100_000_000, 100_000_000),
      mk("2026-03-02", 99_000_000, 99_000_000),
    ];
    const [seg] = buildSegments(dates, "yearly");
    // 손익 −1,000,000 인데 recognized(이미 손익에 포함된 수입) 가 971,226 이라고 하자
    const r = segmentProfit(seg, scope, [], { recognized: 971_226, headroom: 0 }, "full");
    expect(r.knownProfit).toBe(-1_000_000);
    // 하한 수익률은 손익 그대로를 분모로 나눈 값이어야 한다
    expect(r.returnPctLow).toBeCloseTo((-1_000_000 / 100_000_000) * 100, 9);
    // 버그 당시 값(= (profit + recognized)/denom ≈ −0.03%)이 아니다
    expect(r.returnPctLow).not.toBeCloseTo(((-1_000_000 + 971_226) / 100_000_000) * 100, 4);
    // headroom 은 **상한에만** 더해진다
    const withHead = segmentProfit(
      seg,
      scope,
      [],
      { recognized: 971_226, headroom: 500_000 },
      "full",
    );
    expect(withHead.returnPctHigh).toBeCloseTo(((-1_000_000 + 500_000) / 100_000_000) * 100, 9);
    expect(withHead.incomeUpperBound).toBe(971_226 + 500_000);
  });

  it("★ 수익률은 비율이 아니라 **퍼센트**다 (/100 을 두 번 하지 않는다)", () => {
    const scope = [
      mk("2026-01-02", 1_000_000, 1_000_000),
      mk("2026-02-02", 1_000_000, 1_000_000),
      mk("2026-03-02", 1_100_000, 1_100_000),
    ];
    const [seg] = buildSegments(dates, "yearly");
    const r = segmentProfit(seg, scope, [], { recognized: 0, headroom: 0 }, "full");
    expect(r.knownProfit).toBe(100_000);
    expect(r.returnPctLow).toBeCloseTo(10, 9); // 0.1 이 아니라 10(%)
  });

  it("★ 월간 분모는 그 달 자체의 분모다 — 일간 분모의 합이 아니다", () => {
    const d = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-30"];
    const scope = d.map((x, i) => mk(x, 100_000_000 + i, 100_000_000 + i));
    const [month] = buildSegments(d, "monthly");
    const m = segmentProfit(month, scope, [], { recognized: 0, headroom: 0 }, "full");
    const dailies = buildSegments(d, "daily").map((s) =>
      segmentProfit(s, scope, [], { recognized: 0, headroom: 0 }, "full"),
    );
    const sumDailyCapital = dailies.reduce((s, x) => s + x.averageCapital, 0);
    expect(m.averageCapital).toBeCloseTo(100_000_000, 0);
    expect(sumDailyCapital).toBeGreaterThan(m.averageCapital * 3); // 합산하면 4배 규모
    expect(m.averageCapital).not.toBeCloseTo(sumDailyCapital, 0);
  });

  it("실데이터 — 2026 전체 분모가 자본 규모 안이고 수익률이 손익/분모와 일치한다", () => {
    // 분모가 50억대로 튀면(일간 누적 버그) 여기서 걸린다.
    const scope = [
      mk("2026-01-02", 81_575_665, 81_575_665),
      mk("2026-06-01", 120_000_000, 120_000_000),
      mk("2026-10-08", 148_174_504, 148_174_504),
    ];
    const [seg] = buildSegments(["2026-01-02", "2026-06-01", "2026-10-08"], "yearly");
    const flows = [{ date: "2026-06-01", amount: 67_595_443 }];
    const r = segmentProfit(seg, scope, flows, { recognized: 971_226, headroom: null }, "full");
    expect(r.averageCapital).toBeGreaterThan(80_000_000);
    expect(r.averageCapital).toBeLessThan(200_000_000);
    expect(r.returnPctLow).toBeCloseTo((r.knownProfit / r.averageCapital) * 100, 9);
    expect(r.returnPctHigh).toBeNull(); // headroom 미정 → 상한 없음
  });
});

// ── 합산 가산성 회귀 ────────────────────────────────────────────────────────
//
// 2026 전체 손익이 계좌별 합보다 **정확히 9,112,312원**(ISA 2026-01-06 입금액) 많았다.
// ISA 는 01-06 에 입금되고 **다음 거래일** 01-07 부터 성과 구간이 시작하는데, 그 입금이
// `e(01-06) < performanceStart(01-07)` 라 외부흐름에서 빠졌다. 그런데 01-07 의 V_open 에는
// 그 현금이 들어 있어서, 전체 scope 에서는 "없던 자산이 생긴" 것이 그대로 수익이 됐다.

describe("합산 가산성 (aggregate == Σ account)", () => {
  const dates = ["2026-01-02", "2026-01-07", "2026-03-02"];
  const covOf = (id: string, performanceStart: string): AccountCoverage => ({
    accountId: id as AccountId,
    inception: performanceStart,
    strategyStart: performanceStart,
    performanceStart,
    strategyStartIsTransition: false,
    seam: null,
    ledgerCutoff: "2026-12-31",
    anchorDates: [],
  });
  const val = (
    date: string,
    accountId: string,
    vOpen: number,
    vClose: number,
  ): AccountDayValuation => ({
    date,
    accountId,
    vOpen,
    vClose,
    term1: vClose - vOpen,
    term2: 0,
    costs: 0,
    holdingsSource: "ledger",
    cashQuality: "derived",
    usable: true,
    missing: [],
  });

  // A: 처음부터 있다. B: 01-07 에 9,112,312원을 들고 합류한다(그 전에는 자산 0).
  const coverages = [covOf("A", "2026-01-02"), covOf("B", "2026-01-07")];
  const valuations = [
    val("2026-01-02", "A", 100_000_000, 100_500_000),
    val("2026-01-07", "A", 100_500_000, 101_000_000),
    val("2026-03-02", "A", 101_000_000, 102_000_000),
    // B 는 01-02 에 아직 없다 (valuation 자체가 없다)
    val("2026-01-07", "B", 9_112_312, 9_100_000),
    val("2026-03-02", "B", 9_100_000, 9_050_000),
  ];
  const derived = buildDerivedCash({ flows: [], trades: [], tradingDates: dates });
  const incomeSources = [
    { accountId: "A", derived, cap: 0 },
    { accountId: "B", derived, cap: 0 },
  ];

  it("★ 합류 자본이 외부흐름으로 잡힌다 (없던 자산이 수익으로 둔갑하지 않는다)", () => {
    const joins = accountJoinFlows(valuations, coverages, ["A", "B"]);
    // A 는 구간 시작과 동시에 있었으므로 합류 흐름이 아니다(시작값에 이미 들어 있다)
    expect(joins).toEqual([
      { date: "2026-01-02", amount: 100_000_000 },
      { date: "2026-01-07", amount: 9_112_312 },
    ]);
  });

  it("★ aggregate profit == Σ account profit (동일 global window)", () => {
    const [agg] = computeProfitAnalysis({
      valuations,
      coverages,
      scopeAccountIds: ["A", "B"],
      period: "yearly",
      flows: [],
      incomeSources,
    });
    // 같은 window 에서 계좌별로 직접 계산 (미개설 구간은 0)
    const openDate = "2026-01-02",
      closeDate = "2026-03-02";
    const perAccount = ["A", "B"].map((id) => {
      const o = valuations.find((v) => v.accountId === id && v.date === openDate);
      const c2 = valuations.find((v) => v.accountId === id && v.date === closeDate)!;
      const cv = coverages.find((x) => x.accountId === id)!;
      const join =
        cv.performanceStart! > openDate
          ? valuations.find((v) => v.accountId === id && v.date === cv.performanceStart)!.vOpen
          : 0;
      const start = o?.vOpen ?? 0;
      return { start, end: c2.vClose, flow: join, profit: c2.vClose - start - join };
    });
    const sumStart = perAccount.reduce((s, x) => s + x.start, 0);
    const sumEnd = perAccount.reduce((s, x) => s + x.end, 0);
    const sumFlow = perAccount.reduce((s, x) => s + x.flow, 0);
    const sumProfit = perAccount.reduce((s, x) => s + x.profit, 0);

    expect(agg.beginningTotal).toBe(sumStart);
    expect(agg.endingTotal).toBe(sumEnd);
    expect(agg.netCashflow).toBe(sumFlow);
    expect(agg.knownProfit).toBe(sumProfit);
    // 버그 당시에는 합류 자본 9,112,312 만큼 손익이 부풀려졌다
    expect(agg.knownProfit).not.toBe(sumProfit + 9_112_312);
  });

  it("합류일이 구간 시작일과 같으면 흐름으로 세지 않는다 (이중계산 금지)", () => {
    // A 만 보는 scope — 구간이 A 의 performanceStart 에서 시작하므로 합류 흐름이 없다
    const [onlyA] = computeProfitAnalysis({
      valuations,
      coverages,
      scopeAccountIds: ["A"],
      period: "yearly",
      flows: [],
      incomeSources,
    });
    expect(onlyA.beginningTotal).toBe(100_000_000);
    expect(onlyA.netCashflow).toBe(0);
    expect(onlyA.knownProfit).toBe(102_000_000 - 100_000_000);
  });

  it("미개설 계좌는 0 으로 더해지고 그 날짜를 버리지 않는다", () => {
    const scope = aggregateScope(valuations, coverages, ["A", "B"]);
    // 01-02 에는 B 가 아직 없다 — 그래도 point 가 만들어지고 A 만 합산된다
    expect(scope.map((s) => s.date)).toEqual(dates);
    expect(scope[0].vOpen).toBe(100_000_000);
    expect(scope[1].vOpen).toBe(100_500_000 + 9_112_312);
  });
});
