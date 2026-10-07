// 거래 원장 → 리밸런싱 이벤트 규칙을 테스트로 고정한다.
//
// 합성 데이터만 쓴다 — production 식별자나 실제 계좌값을 하드코딩하지 않는다.
// (실제 데이터셋 자체의 정합성은 verified-transactions.test.ts 가 본다.)
import { describe, it, expect } from "vitest";
import { ACCOUNT_IDS } from "./constants";
import {
  defaultEventId,
  effectiveTransaction,
  eventFacets,
  filterEvents,
  holdingsAsOf,
  replayFinalHoldings,
  resolveEvents,
  splitEventId,
  valuateHoldings,
  INTRA_DAY_ROW_ORDER,
  compareIntraDayOrder,
  type LedgerTransaction,
  type TradeSide,
} from "./ledger";

const ACC = ACCOUNT_IDS[0];
const ACC2 = ACCOUNT_IDS[1];
const T_A = "100000";
const T_B = "200000";

let seq = 0;
function tx(
  date: string,
  ticker: string,
  side: TradeSide,
  quantity: number,
  price: number,
  extra: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  seq += 1;
  return {
    id: extra.id ?? `vtx:${String(seq).padStart(4, "0")}`,
    accountId: (extra.accountId ?? ACC) as LedgerTransaction["accountId"],
    ticker,
    etfName: ticker === T_A ? "테스트 ETF A" : "테스트 ETF B",
    side,
    quantity,
    price,
    amount: quantity * price,
    tradeDate: date,
    settlementDate: null,
    inferredTradeDate: date,
    eventDate: date,
    tradeDateEvidence: "broker-order-date",
    fee: null,
    tax: null,
    postQuantity: null,
    source: "test",
    ...extra,
  };
}

// ── 기본 grouping ───────────────────────────────────────────────────────────
describe("기본 grouping — 동일 계좌 + 동일 거래일", () => {
  const list = [
    tx("2026-08-25", T_A, "buy", 3, 10_000),
    tx("2026-08-25", T_B, "sell", 5, 2_000),
    tx("2026-08-26", T_A, "buy", 1, 10_500),
    tx("2026-08-25", T_A, "buy", 2, 10_000, { accountId: ACC2 }),
  ];

  it("같은 계좌·같은 날의 거래가 하나의 이벤트로 묶인다", () => {
    const events = resolveEvents({ transactions: list });
    expect(events).toHaveLength(3);
    const e = events.find((x) => x.id === defaultEventId(ACC, "2026-08-25"))!;
    expect(e.tradeCount).toBe(2);
    expect(e.buyCount).toBe(1);
    expect(e.sellCount).toBe(1);
    expect(e.buyAmount).toBe(30_000);
    expect(e.sellAmount).toBe(10_000);
    expect(e.netAmount).toBe(20_000);
  });

  it("계좌가 다르면 같은 날이어도 별개 이벤트다", () => {
    const events = resolveEvents({ transactions: list });
    expect(events.filter((e) => e.date === "2026-08-25").map((e) => e.accountId).sort())
      .toEqual([ACC, ACC2].sort());
  });

  it("최신 날짜가 먼저 온다", () => {
    const events = resolveEvents({ transactions: list });
    expect(events[0].date).toBe("2026-08-26");
  });

  it("거래가 없으면 이벤트도 없다", () => {
    expect(resolveEvents({ transactions: [] })).toEqual([]);
  });
});

// ── 이전 → 매매 → 이후 ─────────────────────────────────────────────────────
describe("보유수량 변화 (이전 → 매매 → 이후)", () => {
  const list = [
    tx("2026-01-05", T_A, "buy", 100, 1_000),
    tx("2026-02-10", T_A, "sell", 20, 1_100),
    tx("2026-02-10", T_B, "buy", 50, 500),
    tx("2026-03-10", T_B, "buy", 10, 520),
  ];
  const events = resolveEvents({ transactions: list });
  const feb = events.find((e) => e.date === "2026-02-10")!;

  it("각 거래가 이전수량 → 거래수량 → 이후수량을 갖는다", () => {
    const sell = feb.lines.find((l) => l.effective.ticker === T_A)!;
    expect(sell.beforeQuantity).toBe(100);
    expect(sell.deltaQuantity).toBe(-20);
    expect(sell.afterQuantity).toBe(80);

    const buy = feb.lines.find((l) => l.effective.ticker === T_B)!;
    expect(buy.beforeQuantity).toBe(0);
    expect(buy.deltaQuantity).toBe(50);
    expect(buy.afterQuantity).toBe(50);
  });

  it("이벤트의 전후 보유수량은 그 이벤트가 건드린 종목만 담는다", () => {
    expect(feb.preHoldings).toEqual({ [T_A]: 100 });
    expect(feb.postHoldings).toEqual({ [T_A]: 80, [T_B]: 50 });
  });

  it("한 이벤트에서 같은 종목을 여러 번 거래하면 처음 before / 마지막 after 를 쓴다", () => {
    const multi = resolveEvents({
      transactions: [
        tx("2026-05-01", T_A, "buy", 10, 100),
        tx("2026-05-02", T_A, "buy", 5, 100),
        tx("2026-05-02", T_A, "sell", 3, 100),
      ],
    });
    const e = multi.find((x) => x.date === "2026-05-02")!;
    expect(e.preHoldings).toEqual({ [T_A]: 10 });
    expect(e.postHoldings).toEqual({ [T_A]: 12 });
  });

  it("계좌별로 독립적으로 재생된다", () => {
    const h = replayFinalHoldings([
      ...list,
      tx("2026-01-05", T_A, "buy", 7, 1_000, { accountId: ACC2 }),
    ]);
    expect(h[ACC]).toEqual({ [T_A]: 80, [T_B]: 60 });
    expect(h[ACC2]).toEqual({ [T_A]: 7 });
  });

  it("전량매도한 종목은 보유수량에서 사라진다 (0 을 남기지 않는다)", () => {
    const h = replayFinalHoldings([
      tx("2026-01-05", T_A, "buy", 10, 100),
      tx("2026-02-05", T_A, "sell", 10, 110),
    ]);
    expect(h[ACC]).toEqual({});
  });

  it("holdingsAsOf 는 그 날짜까지만 재생한다", () => {
    expect(holdingsAsOf(list, ACC, "2026-01-31")).toEqual({ [T_A]: 100 });
    expect(holdingsAsOf(list, ACC, "2026-02-10")).toEqual({ [T_A]: 80, [T_B]: 50 });
    expect(holdingsAsOf(list, ACC, "2026-12-31")).toEqual({ [T_A]: 80, [T_B]: 60 });
  });
});

describe("증권사 보고 거래후수량 대조", () => {
  it("보고값과 재생값이 같으면 mismatch 가 false 다", () => {
    const events = resolveEvents({
      transactions: [tx("2026-01-05", T_A, "buy", 10, 100, { postQuantity: 10 })],
    });
    expect(events[0].lines[0].postQuantityMismatch).toBe(false);
  });

  it("다르면 true 로 드러낸다 (조용히 맞추지 않는다)", () => {
    const events = resolveEvents({
      transactions: [tx("2026-01-05", T_A, "buy", 10, 100, { postQuantity: 99 })],
    });
    expect(events[0].lines[0].postQuantityMismatch).toBe(true);
    expect(events[0].lines[0].afterQuantity).toBe(10);
  });

  it("증권사가 보고하지 않았으면 null 이다 (불일치 아님)", () => {
    const events = resolveEvents({
      transactions: [tx("2026-01-05", T_A, "buy", 10, 100, { postQuantity: null })],
    });
    expect(events[0].lines[0].postQuantityMismatch).toBeNull();
  });
});

// ── 정정 overlay ────────────────────────────────────────────────────────────
describe("거래 정정 — 원본을 덮지 않는다", () => {
  const original = tx("2026-01-05", T_A, "buy", 10, 1_000);

  it("정정이 없으면 원본 그대로이고 corrected 가 false 다", () => {
    const e = effectiveTransaction(original);
    expect(e.quantity).toBe(10);
    expect(e.corrected).toBe(false);
    expect(e.correctedFields).toEqual([]);
  });

  it("정정값이 우선하고 어떤 필드가 바뀌었는지 남는다", () => {
    const e = effectiveTransaction(original, {
      transactionId: original.id, correctedQuantity: 12, reason: "증권사 정정",
    });
    expect(e.quantity).toBe(12);
    expect(e.corrected).toBe(true);
    expect(e.correctedFields).toEqual(["quantity"]);
    // 원본 객체는 변하지 않는다
    expect(original.quantity).toBe(10);
  });

  it("수량·단가만 고치면 금액을 다시 계산한다", () => {
    const e = effectiveTransaction(original, {
      transactionId: original.id, correctedQuantity: 12,
    });
    expect(e.amount).toBe(12 * 1_000);
  });

  it("금액을 직접 정정하면 그 값을 존중한다", () => {
    const e = effectiveTransaction(original, {
      transactionId: original.id, correctedQuantity: 12, correctedAmount: 11_900,
    });
    expect(e.amount).toBe(11_900);
  });

  it("같은 값으로 정정하면 corrected 로 치지 않는다", () => {
    const e = effectiveTransaction(original, {
      transactionId: original.id, correctedQuantity: 10,
    });
    expect(e.corrected).toBe(false);
  });

  it("정정된 수량이 보유수량 재생에 반영된다", () => {
    const h = replayFinalHoldings(
      [original],
      new Map([[original.id, { transactionId: original.id, correctedQuantity: 12 }]]),
    );
    expect(h[ACC]).toEqual({ [T_A]: 12 });
  });

  it("excluded 거래는 계산에서 빠지지만 원본은 남아 있다", () => {
    const list = [original, tx("2026-02-05", T_A, "buy", 5, 1_000)];
    const events = resolveEvents({
      transactions: list,
      corrections: [{ transactionId: original.id, excluded: true, reason: "중복 적재" }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].lines[0].beforeQuantity).toBe(0);
    expect(replayFinalHoldings(list, new Map([[original.id, {
      transactionId: original.id, excluded: true,
    }]]))[ACC]).toEqual({ [T_A]: 5 });
  });

  it("거래일을 정정하면 소속 이벤트가 따라 바뀐다", () => {
    const events = resolveEvents({
      transactions: [original],
      corrections: [{ transactionId: original.id, correctedTradeDate: "2026-01-07" }],
    });
    expect(events[0].id).toBe(defaultEventId(ACC, "2026-01-07"));
  });
});

// ── 병합 / 분리 / 이동 ──────────────────────────────────────────────────────
describe("병합 / 분리 / 이동 (override overlay)", () => {
  const a = tx("2026-08-25", T_A, "buy", 3, 10_000);
  const b = tx("2026-08-25", T_B, "sell", 5, 2_000);
  const c = tx("2026-08-27", T_A, "buy", 1, 10_500);
  const list = [a, b, c];

  it("병합 — 다른 날짜의 이벤트를 하나로 합친다", () => {
    const target = defaultEventId(ACC, "2026-08-25");
    const events = resolveEvents({
      transactions: list,
      overrides: [{ transactionId: c.id, eventId: target }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].tradeCount).toBe(3);
    // 병합하면 날짜 범위가 생긴다
    expect(events[0].date).toBe("2026-08-25");
    expect(events[0].dateEnd).toBe("2026-08-27");
    expect(events[0].regrouped).toBe(true);
  });

  it("분리 — 같은 날 거래 일부를 새 이벤트로 뗀다", () => {
    const split = splitEventId(ACC, "2026-08-25", 1);
    const events = resolveEvents({
      transactions: list,
      overrides: [{ transactionId: b.id, eventId: split }],
      events: [{
        id: split, accountId: ACC, eventDate: "2026-08-25",
        type: "rebalance", strategyIncluded: true, isUserCreated: true,
        memo: "반도체 비중 축소",
      }],
    });
    expect(events).toHaveLength(3);
    const made = events.find((e) => e.id === split)!;
    expect(made.tradeCount).toBe(1);
    expect(made.isUserCreated).toBe(true);
    expect(made.memo).toBe("반도체 비중 축소");
    expect(events.find((e) => e.id === defaultEventId(ACC, "2026-08-25"))!.tradeCount).toBe(1);
  });

  it("이동 — 거래 하나를 다른 이벤트로 옮긴다", () => {
    const events = resolveEvents({
      transactions: list,
      overrides: [{ transactionId: a.id, eventId: defaultEventId(ACC, "2026-08-27") }],
    });
    const to = events.find((e) => e.id === defaultEventId(ACC, "2026-08-27"))!;
    expect(to.tradeCount).toBe(2);
    expect(to.regrouped).toBe(true);
  });

  it("override 를 지우면 기본 grouping 으로 되돌아간다", () => {
    const back = resolveEvents({ transactions: list, overrides: [] });
    expect(back).toHaveLength(2);
    expect(back.every((e) => e.regrouped === false)).toBe(true);
  });

  it("병합해도 보유수량 재생은 시간순 그대로다 (이벤트 묶음이 수량을 바꾸지 않는다)", () => {
    const merged = resolveEvents({
      transactions: list,
      overrides: [{ transactionId: c.id, eventId: defaultEventId(ACC, "2026-08-25") }],
    });
    // b 는 보유하지 않은 T_B 를 파는 합성 데이터라 -5 가 된다 — 묶는 방식과 무관하게
    // 재생 결과가 같다는 것이 여기서 확인하려는 것이다.
    expect(merged[0].postHoldings).toEqual({ [T_A]: 4, [T_B]: -5 });
    expect(replayFinalHoldings(list)[ACC]).toEqual({ [T_A]: 4, [T_B]: -5 });
  });
});

// ── 메모 / 태그 / 숨김 ──────────────────────────────────────────────────────
describe("메모 / 태그 / 숨김", () => {
  const list = [tx("2026-08-25", T_A, "buy", 3, 10_000)];
  const id = defaultEventId(ACC, "2026-08-25");

  it("저장된 이벤트 행의 메모·태그·타입이 반영된다", () => {
    const events = resolveEvents({
      transactions: list,
      events: [{
        id, accountId: ACC, eventDate: "2026-08-25", type: "contribution_buy",
        strategyIncluded: true, memo: "월 정기납입", tags: ["정기매수", "수동"],
      }],
    });
    expect(events[0].memo).toBe("월 정기납입");
    expect(events[0].tags).toEqual(["정기매수", "수동"]);
    expect(events[0].type).toBe("contribution_buy");
  });

  it("행이 없으면 기본값 (메모 없음 / 태그 없음 / rebalance / 표시)", () => {
    const events = resolveEvents({ transactions: list });
    expect(events[0]).toMatchObject({
      memo: "", tags: [], type: "rebalance", hidden: false, isUserCreated: false,
    });
  });

  it("숨긴 이벤트는 기본 필터에서 빠지지만 데이터는 남아 있다 (복원 가능)", () => {
    const events = resolveEvents({
      transactions: list,
      events: [{
        id, accountId: ACC, eventDate: "2026-08-25", type: "rebalance",
        strategyIncluded: true, hidden: true,
      }],
    });
    expect(events).toHaveLength(1);
    expect(filterEvents(events)).toHaveLength(0);
    expect(filterEvents(events, { includeHidden: true })).toHaveLength(1);
  });
});

// ── 필터 / 검색 ─────────────────────────────────────────────────────────────
describe("목록 필터 / 검색", () => {
  const list = [
    tx("2026-01-05", T_A, "buy", 10, 1_000),
    tx("2026-05-10", T_B, "sell", 5, 2_000, { accountId: ACC2 }),
    tx("2026-09-20", T_A, "buy", 2, 1_100),
  ];
  const events = resolveEvents({
    transactions: list,
    events: [{
      id: defaultEventId(ACC, "2026-09-20"), accountId: ACC, eventDate: "2026-09-20",
      type: "contribution_buy", strategyIncluded: true,
      memo: "S&P500 추가매수", tags: ["정기매수"],
    }],
  });

  it("기간", () => {
    expect(filterEvents(events, { from: "2026-05-01" }).map((e) => e.date))
      .toEqual(["2026-09-20", "2026-05-10"]);
    expect(filterEvents(events, { to: "2026-05-31" }).map((e) => e.date))
      .toEqual(["2026-05-10", "2026-01-05"]);
  });

  it("계좌", () => {
    expect(filterEvents(events, { accountIds: [ACC2] })).toHaveLength(1);
  });

  it("매수 / 매도", () => {
    expect(filterEvents(events, { side: "sell" }).map((e) => e.accountId)).toEqual([ACC2]);
    expect(filterEvents(events, { side: "buy" })).toHaveLength(2);
  });

  it("종목 (코드 또는 ETF명)", () => {
    expect(filterEvents(events, { tickers: [T_B] })).toHaveLength(1);
    expect(filterEvents(events, { tickers: ["테스트 ETF B"] })).toHaveLength(1);
  });

  it("이벤트 유형 / 태그", () => {
    expect(filterEvents(events, { types: ["contribution_buy"] })).toHaveLength(1);
    expect(filterEvents(events, { tags: ["정기매수"] })).toHaveLength(1);
    expect(filterEvents(events, { tags: ["없는태그"] })).toHaveLength(0);
  });

  it("검색 — ETF명 / 종목코드 / 메모", () => {
    expect(filterEvents(events, { query: "추가매수" })).toHaveLength(1);
    expect(filterEvents(events, { query: "ETF B" })).toHaveLength(1);
    expect(filterEvents(events, { query: T_A })).toHaveLength(2);
    expect(filterEvents(events, { query: "없는말" })).toHaveLength(0);
  });

  it("필터를 겹쳐 쓸 수 있다", () => {
    expect(filterEvents(events, { accountIds: [ACC], side: "buy", from: "2026-06-01" }))
      .toHaveLength(1);
  });

  it("facets 는 실제 존재하는 값만 준다", () => {
    const f = eventFacets(events);
    expect(f.accountIds).toEqual([ACC, ACC2].sort());
    expect(f.types.sort()).toEqual(["contribution_buy", "rebalance"]);
    expect(f.tags).toEqual(["정기매수"]);
  });

  it("병합으로 날짜 범위가 생긴 이벤트는 범위가 걸치면 포함된다", () => {
    const merged = resolveEvents({
      transactions: [
        tx("2026-01-05", T_A, "buy", 1, 100),
        tx("2026-03-05", T_A, "buy", 1, 100),
      ],
      overrides: [],
    });
    const m = resolveEvents({
      transactions: [
        tx("2026-01-06", T_A, "buy", 1, 100, { id: "m1" }),
        tx("2026-03-06", T_A, "buy", 1, 100, { id: "m2" }),
      ],
      overrides: [{ transactionId: "m2", eventId: defaultEventId(ACC, "2026-01-06") }],
    });
    expect(merged).toHaveLength(2);
    expect(filterEvents(m, { from: "2026-02-01", to: "2026-02-28" })).toHaveLength(1);
  });
});

// ── 과거 시점 평가 ──────────────────────────────────────────────────────────
describe("과거 시점 평가 — 현재가를 쓰지 않고, 가격이 없으면 만들지 않는다", () => {
  it("보유수량 × 그 날 종가", () => {
    expect(valuateHoldings({ [T_A]: 10, [T_B]: 5 }, { [T_A]: 1_000, [T_B]: 2_000 }))
      .toEqual({ value: 20_000, missing: [] });
  });

  it("종목 하나라도 가격이 없으면 null (partial valuation 금지)", () => {
    expect(valuateHoldings({ [T_A]: 10, [T_B]: 5 }, { [T_A]: 1_000 })).toBeNull();
  });

  it("0 이하 가격도 '없음'으로 본다", () => {
    expect(valuateHoldings({ [T_A]: 10 }, { [T_A]: 0 })).toBeNull();
    expect(valuateHoldings({ [T_A]: 10 }, { [T_A]: -5 })).toBeNull();
  });

  it("보유수량이 0 인 종목은 가격이 없어도 막지 않는다", () => {
    expect(valuateHoldings({ [T_A]: 10, [T_B]: 0 }, { [T_A]: 1_000 }))
      .toEqual({ value: 10_000, missing: [] });
  });

  it("보유 종목이 없으면 0 이다", () => {
    expect(valuateHoldings({}, {})).toEqual({ value: 0, missing: [] });
  });
});

// ── 날짜 근거 ───────────────────────────────────────────────────────────────
describe("날짜 근거 (신뢰도)", () => {
  it("이벤트가 소속 거래의 근거를 모아 들고 있다", () => {
    const events = resolveEvents({
      transactions: [
        tx("2026-08-25", T_A, "buy", 1, 100, { tradeDateEvidence: "broker-order-date" }),
        tx("2026-08-25", T_B, "buy", 1, 100, {
          tradeDate: null, tradeDateEvidence: "tplus2-weekday-inference",
        }),
      ],
    });
    expect(events[0].dateEvidence)
      .toEqual(["broker-order-date", "tplus2-weekday-inference"]);
  });

  it("직접 보고된 날짜만 있으면 근거가 하나다", () => {
    const events = resolveEvents({
      transactions: [tx("2026-08-25", T_A, "buy", 1, 100)],
    });
    expect(events[0].dateEvidence).toEqual(["broker-order-date"]);
  });
});

describe("목표비중을 쓰지 않는다", () => {
  it("이벤트에 목표비중 개념의 필드가 없다", () => {
    const events = resolveEvents({ transactions: [tx("2026-01-05", T_A, "buy", 1, 100)] });
    const keys = Object.keys(events[0]);
    for (const banned of ["targetWeight", "allocation", "targetPct", "profile"]) {
      expect(keys).not.toContain(banned);
    }
  });
});

// ── 일중 거래 순서 ──────────────────────────────────────────────────────────
describe("일중 거래 순서 — source 별로 방향이 다르다", () => {
  const row = (source: string, sourceRow: number | null, id: string) =>
    tx("2026-05-26", T_A, "buy", 1, 100, { source, sourceRow, id });

  it("retirement_web 은 행 번호 오름차순이 시간순이다", () => {
    expect(INTRA_DAY_ROW_ORDER.miraeasset_retirement_web).toBe("asc");
    const a = row("miraeasset_retirement_web", 124, "a");
    const b = row("miraeasset_retirement_web", 156, "b");
    expect([b, a].sort(compareIntraDayOrder).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("transaction_history 는 행 번호 내림차순이 시간순이다", () => {
    expect(INTRA_DAY_ROW_ORDER.miraeasset_transaction_history).toBe("desc");
    const a = row("miraeasset_transaction_history", 255, "a");
    const b = row("miraeasset_transaction_history", 257, "b");
    expect([a, b].sort(compareIntraDayOrder).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("행 번호가 없는 거래는 그 날의 마지막에 오고 id 로 순서가 고정된다", () => {
    const withRow = row("miraeasset_retirement_web", 10, "z");
    const noRow1 = row("user_supplied", null, "b");
    const noRow2 = row("user_supplied", null, "a");
    expect([noRow1, noRow2, withRow].sort(compareIntraDayOrder).map((t) => t.id))
      .toEqual(["z", "a", "b"]);
  });

  it("source 가 다르면 행 번호를 비교하지 않고 id 로 고정한다", () => {
    const a = row("miraeasset_retirement_web", 500, "a");
    const b = row("miraeasset_transaction_history", 10, "b");
    expect([b, a].sort(compareIntraDayOrder).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("모르는 source 는 오름차순으로 보되, 그 가정이 검증 대상임을 남긴다", () => {
    const a = row("unknown_broker", 1, "a");
    const b = row("unknown_broker", 2, "b");
    expect([b, a].sort(compareIntraDayOrder).map((t) => t.id)).toEqual(["a", "b"]);
    expect(INTRA_DAY_ROW_ORDER.unknown_broker).toBeUndefined();
  });

  it("순서가 뒤집히면 보유수량 재생이 달라진다 (순서가 실제로 중요하다)", () => {
    // 658주 보유 상태에서 같은 날 매수 723 → 매도 1381 이면 0 으로 끝난다.
    // 반대로 매도가 먼저 오면 음수가 된다.
    const list = [
      tx("2026-01-05", T_A, "buy", 658, 100, { source: "miraeasset_retirement_web", sourceRow: 900, id: "t0" }),
      tx("2026-05-26", T_A, "buy", 723, 100, { source: "miraeasset_retirement_web", sourceRow: 124, id: "t1" }),
      tx("2026-05-26", T_A, "sell", 1381, 100, { source: "miraeasset_retirement_web", sourceRow: 156, id: "t2" }),
    ];
    const events = resolveEvents({ transactions: list });
    const may = events.find((e) => e.date === "2026-05-26")!;
    expect(may.lines.map((l) => l.effective.id)).toEqual(["t1", "t2"]);
    expect(may.lines.every((l) => l.afterQuantity >= 0)).toBe(true);
    expect(replayFinalHoldings(list)[ACC]).toEqual({});
  });
});
