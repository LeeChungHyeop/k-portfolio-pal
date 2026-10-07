// 실제 데이터셋(`data/verified-transactions.v1.json`) 자체의 정합성을 고정한다.
//
// 이 테스트가 깨지면 데이터 파일이 바뀐 것이다. 적재 전에 반드시 통과해야 한다.
// 파일은 fs 로 읽는다 — 앱 번들에 340KB JSON 이 딸려 들어가지 않게 하기 위해서다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNT_IDS } from "./constants";
import { parseVerifiedDataset, verifyDataset } from "./verified-transactions";
import { defaultEventId, replayFinalHoldings, resolveEvents } from "./ledger";
import { verifiedPrincipalOf, verifiedPrincipalTotal } from "./verified-cashflows";

const DATASET_PATH = resolve(import.meta.dirname, "../../../data/verified-transactions.v1.json");
const raw = JSON.parse(readFileSync(DATASET_PATH, "utf-8"));
const dataset = parseVerifiedDataset(raw);

describe("데이터셋 파싱", () => {
  it("schemaVersion 1 / 거래 463건 / 이벤트 65건", () => {
    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.transactions).toHaveLength(463);
    expect(dataset.events).toHaveLength(65);
  });

  it("모든 거래가 앱의 계좌 id 네 개 중 하나다", () => {
    for (const t of dataset.transactions) {
      expect(ACCOUNT_IDS).toContain(t.accountId);
    }
  });

  it("모든 거래에 양수 수량·단가와 YYYY-MM-DD eventDate 가 있다", () => {
    for (const t of dataset.transactions) {
      expect(t.quantity).toBeGreaterThan(0);
      expect(t.price).toBeGreaterThan(0);
      expect(t.eventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["buy", "sell"]).toContain(t.side);
    }
  });

  it("메모·태그·숨김은 데이터셋에 없다 (사용자가 앱에서 붙이는 값이다)", () => {
    for (const e of dataset.events) {
      expect(e.memo).toBeNull();
      expect(e.tags).toEqual([]);
      expect(e.hidden).toBe(false);
      expect(e.isUserCreated).toBe(false);
    }
  });
});

describe("verifyDataset — 적재 전 게이트", () => {
  const checks = verifyDataset(dataset);

  it("모든 검사를 통과한다", () => {
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
  });

  it("검사 항목이 빠지지 않았다", () => {
    const names = checks.map((c) => c.name);
    for (const required of [
      "거래 건수", "이벤트 건수", "거래 id 유일", "이벤트 id 유일",
      "기본 grouping = 데이터셋 이벤트", "음수 보유수량 없음",
      "최종 보유수량 재생 일치", "증권사 보고 거래후수량 일치",
      "모든 거래가 이벤트에 1회씩",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("데이터가 망가지면 검사가 실패로 돌아선다 (게이트가 실제로 동작한다)", () => {
    const broken = {
      ...dataset,
      transactions: dataset.transactions.slice(0, -1), // 1건 누락
    };
    const failed = verifyDataset(broken).filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((c) => c.name === "거래 건수")).toBe(true);
  });
});

describe("계좌별 건수", () => {
  it("거래 — retirement 227 / irp 65 / isa 85 / pension 86", () => {
    const counts = Object.fromEntries(
      ACCOUNT_IDS.map((id) => [id, dataset.transactions.filter((t) => t.accountId === id).length]),
    );
    expect(counts).toEqual({ retirement: 227, irp: 65, isa: 85, pension: 86 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(463);
  });

  it("이벤트 — retirement 27 / irp 9 / isa 16 / pension 13", () => {
    const counts = Object.fromEntries(
      ACCOUNT_IDS.map((id) => [id, dataset.events.filter((e) => e.accountId === id).length]),
    );
    expect(counts).toEqual({ retirement: 27, irp: 9, isa: 16, pension: 13 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(65);
  });
});

describe("최종 보유수량 — 재생값이 데이터셋 주장과 일치한다", () => {
  const replayed = replayFinalHoldings(dataset.transactions);

  it("계좌별 ticker 수량이 1주도 다르지 않다", () => {
    for (const id of ACCOUNT_IDS) {
      expect(replayed[id] ?? {}).toEqual(dataset.validation.finalHoldings[id] ?? {});
    }
  });

  it("음수 보유수량이 없다", () => {
    for (const byTicker of Object.values(replayed)) {
      for (const qty of Object.values(byTicker)) expect(qty).toBeGreaterThan(0);
    }
  });
});

describe("기본 grouping 이 데이터셋 이벤트와 같다", () => {
  const events = resolveEvents({ transactions: dataset.transactions });

  it("앱이 묶은 이벤트 수가 65다", () => {
    expect(events).toHaveLength(65);
  });

  it("이벤트 id 가 rev:<계좌>:<날짜> 규칙과 데이터셋 양쪽에서 일치한다", () => {
    const appIds = new Set(events.map((e) => e.id));
    const datasetIds = new Set(dataset.events.map((e) => e.id));
    expect([...appIds].sort()).toEqual([...datasetIds].sort());
    for (const e of events) {
      expect(e.id).toBe(defaultEventId(e.accountId, e.date));
    }
  });

  it("이벤트 집계(건수·종목 수·매수/매도 금액)가 소속 거래와 맞는다", () => {
    for (const e of events) {
      const buys = e.lines.filter((l) => l.effective.side === "buy");
      const sells = e.lines.filter((l) => l.effective.side === "sell");
      // tradeCount 는 **체결 건수**, buyCount/sellCount 는 **종목 수**다.
      expect(e.tradeCount).toBe(e.lines.length);
      expect(e.buyCount).toBe(new Set(buys.map((l) => l.effective.ticker)).size);
      expect(e.sellCount).toBe(new Set(sells.map((l) => l.effective.ticker)).size);
      expect(e.buyAmount).toBe(buys.reduce((s, l) => s + l.effective.amount, 0));
      expect(e.sellAmount).toBe(sells.reduce((s, l) => s + l.effective.amount, 0));
      // 종목 수가 체결 건수를 넘을 수는 없다.
      expect(e.buyCount).toBeLessThanOrEqual(buys.length);
      expect(e.sellCount).toBeLessThanOrEqual(sells.length);
    }
  });

  it("같은 종목을 하루에 여러 번 거래하면 종목 수는 1로 센다 (실측값 고정)", () => {
    // Phase 4 요구사항은 "매수/매도 종목 수"인데 예전 구현은 체결 건수를 셌다.
    // 화면 라벨이 "매수 N종목"이라 14건을 14종목으로 보여주고 있었다.
    const expected: [string, number, number, number][] = [
      // [eventId, tradeCount, buyCount(종목), sellCount(종목)]
      ["rev:retirement:2026-08-28", 17, 5, 2],
      ["rev:irp:2026-08-28", 8, 2, 3],
      ["rev:isa:2026-06-26", 7, 2, 2],
    ];
    for (const [id, trades, buyTickers, sellTickers] of expected) {
      const e = events.find((x) => x.id === id);
      expect(e, `${id} 를 찾을 수 없다`).toBeDefined();
      expect(e!.tradeCount, `${id} tradeCount`).toBe(trades);
      expect(e!.buyCount, `${id} buyCount(종목)`).toBe(buyTickers);
      expect(e!.sellCount, `${id} sellCount(종목)`).toBe(sellTickers);
    }
  });

  it("모든 거래가 정확히 하나의 이벤트에 속한다", () => {
    const seen = events.flatMap((e) => e.lines.map((l) => l.effective.id));
    expect(seen).toHaveLength(463);
    expect(new Set(seen).size).toBe(463);
  });

  it("아직 아무도 병합/분리하지 않았으므로 regrouped 가 전부 false 다", () => {
    expect(events.every((e) => e.regrouped === false)).toBe(true);
  });
});

describe("날짜 근거 — 추정이 섞인 거래를 숨기지 않는다", () => {
  it("근거 분포: 직접 보고 292 / 결제일 교차대조 110 / T+2 추정 61", () => {
    const dist: Record<string, number> = {};
    for (const t of dataset.transactions) {
      dist[t.tradeDateEvidence] = (dist[t.tradeDateEvidence] ?? 0) + 1;
    }
    expect(dist).toEqual({
      "broker-order-date": 292,
      "cross-account-settlement-match": 110,
      "tplus2-weekday-inference": 61,
    });
  });

  it("증권사가 주문일을 직접 준 거래만 tradeDate 가 있다", () => {
    for (const t of dataset.transactions) {
      if (t.tradeDateEvidence === "broker-order-date") expect(t.tradeDate).toBeTruthy();
      expect(t.eventDate).toBe(t.tradeDate ?? t.inferredTradeDate);
    }
  });

  it("추정 날짜가 들어간 이벤트는 dateEvidence 로 드러난다", () => {
    const events = resolveEvents({ transactions: dataset.transactions });
    const inferred = events.filter((e) =>
      e.dateEvidence.some((x) => x !== "broker-order-date"));
    expect(inferred.length).toBeGreaterThan(0);
  });
});

describe("거래후수량 — 증권사가 보고한 것만 대조한다", () => {
  const events = resolveEvents({ transactions: dataset.transactions });
  const lines = events.flatMap((e) => e.lines);

  it("보고된 171건은 재생값과 전부 일치한다", () => {
    const comparable = lines.filter((l) => l.postQuantityMismatch !== null);
    expect(comparable).toHaveLength(171);
    expect(comparable.filter((l) => l.postQuantityMismatch === true)).toEqual([]);
  });

  it("보고하지 않은 292건은 null 이며 0 으로 메우지 않았다", () => {
    const unreported = lines.filter((l) => l.postQuantityMismatch === null);
    expect(unreported).toHaveLength(292);
    for (const l of unreported) expect(l.transaction.postQuantity).toBeNull();
  });
});

describe("직전 커밋의 검증 cashflow 와 체크섬이 일치한다", () => {
  it("계좌별 납입원금", () => {
    for (const id of ACCOUNT_IDS) {
      expect(dataset.validation.cashflowPrincipalChecksums[id]).toBe(verifiedPrincipalOf(id));
    }
  });

  it("전체 151,855,018", () => {
    expect(dataset.validation.cashflowPrincipalChecksums.total).toBe(151_855_018);
    expect(verifiedPrincipalTotal()).toBe(151_855_018);
  });
});

describe("전략 시작일 — 계좌 원금 시작일과 다른 개념이다", () => {
  it("네 계좌의 전략 시작일이 들어 있다", () => {
    expect(dataset.strategyStartDates).toEqual({
      retirement: "2025-09-10",
      isa: "2026-01-07",
      pension: "2025-11-10",
      irp: "2025-12-29",
    });
  });

  it("퇴직연금은 전략 시작(2025-09-10) 이전 매매가 보존돼 있고 전략 집계에서 빠진다", () => {
    const pre = dataset.events.filter(
      (e) => e.accountId === "retirement" && e.eventDate < "2025-09-10",
    );
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((e) => e.strategyIncluded === false)).toBe(true);
    // 그래도 거래 자체는 삭제하지 않는다
    const preTx = dataset.transactions.filter(
      (t) => t.accountId === "retirement" && t.eventDate < "2025-09-10",
    );
    expect(preTx.length).toBeGreaterThan(0);
  });
});
