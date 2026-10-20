// @vitest-environment jsdom
/**
 * 읽기 경로 일관성 (Phase 4-D) — 같은 계좌 문서에서 모든 소비자가 같은 '현재 보유수량'을 쓴다.
 *   cron 일별 스냅샷 · 지수비교 live 포인트 · 보유 기준 함수 · 수익분석 anchor 가 모두 동기화(230/64)를 가리키고,
 *   동기화 기록은 이력(history)을 한 건도 바꾸지 않으며 리밸런싱 수익률/손익 anchor 를 만들지 않는다.
 *   (SQL view 쪽 같은 규칙은 migration 014 의 PGlite 검증에서 같은 시나리오로 확인했다.)
 */
import { describe, it, expect } from "vitest";


const { holdingsBasisOf, holdingsAnchorsOf } = await import("./broker-sync-basis");
const { buildDailySnapshotRows } = await import("./snapshot");
const { buildLivePoint } = await import("@/components/kaw/PortfolioBenchmarkChart");
const { BACKTEST_SCHEMA_VERSION } = await import("./backtest");
const { BUILTIN_TICKERS } = await import("./store");
const DashboardMod = await import("@/components/kaw/Dashboard");

const P_KR = 26_000, P_US = 31_000;
const HIST = [{
  id: "h1", date: "2026-10-01", rowQuantitiesSnap: { kr: 297, us: 81 },
  rowEtfSnap: { kr: "TIGER 미국S&P500", us: "ACE 미국나스닥100" }, rowLabelSnap: {}, rowHoldingsSnap: {},
  baseAmount: 10_000_000, deposit: 0, totalValue: 10_000_000, returnPct: 3.2, holdings: [],
  backtestGrowth: { schemaVersion: BACKTEST_SCHEMA_VERSION, cashflowKey: "k", units: { kr: 1 } },
}];
const SYNC = {
  id: "bsync:x", kind: "broker_sync", holdingsEffectiveFrom: "2026-10-14", quantities: { kr: 230, us: 64 },
  rowEtfSnap: { kr: "TIGER 미국S&P500", us: "ACE 미국나스닥100" }, rowLabelSnap: {}, rowHoldingsSnap: { kr: 5_976_550, us: 1_998_080 },
};
const CASH = 2_318_828;
const LIB = [{ defaultEtf: "TIGER 미국S&P500", ticker: "360750" }, { defaultEtf: "ACE 미국나스닥100", ticker: "367380" }] as never;
const prices = { "360750": P_KR, "367380": P_US, [BUILTIN_TICKERS.kr ?? "x"]: 1000 };
const expectedEtf = 230 * P_KR + 64 * P_US;
const oldEtf = 297 * P_KR + 81 * P_US;

describe("모든 읽기 소비자가 같은 현재 수량(230/64)을 쓴다", () => {
  it("보유 기준 · cron 스냅샷 · 지수비교 live '실제' 평가액이 일치한다", () => {
    expect(holdingsBasisOf({ history: HIST, brokerSyncs: [SYNC] })?.rowQuantitiesSnap).toEqual({ kr: 230, us: 64 });

    const snapPrices = new Map([["360750", { price: P_KR, fetchedAt: "t" }], ["367380", { price: P_US, fetchedAt: "t" }]]);
    const tickers = new Map([["TIGER 미국S&P500", "360750"], ["ACE 미국나스닥100", "367380"]]);
    const snap = buildDailySnapshotRows([{ familyCode: "f", profile: "p", accountType: "pension", history: HIST as never, brokerSyncs: [SYNC], cashBalance: CASH }], tickers, snapPrices, "2026-10-20").rows[0];
    expect(snap.market_value).toBe(expectedEtf);
    expect(snap.total_asset_value).toBe(expectedEtf + CASH);

    const live = buildLivePoint(HIST as never, LIB, prices, false, CASH, undefined, "k", [SYNC]);
    expect(live?.actualValue).toBe(expectedEtf + CASH);
  });

  it("동기화가 없으면 세 소비자 모두 이전과 똑같이 옛 수량으로 계산한다", () => {
    const snapPrices = new Map([["360750", { price: P_KR, fetchedAt: "t" }], ["367380", { price: P_US, fetchedAt: "t" }]]);
    const tickers = new Map([["TIGER 미국S&P500", "360750"], ["ACE 미국나스닥100", "367380"]]);
    const snap = buildDailySnapshotRows([{ familyCode: "f", profile: "p", accountType: "pension", history: HIST as never, cashBalance: 29_296 }], tickers, snapPrices, "2026-10-20").rows[0];
    expect(snap.market_value).toBe(oldEtf);
    expect(buildLivePoint(HIST as never, LIB, prices, false, 29_296, undefined, "k")?.actualValue).toBe(oldEtf + 29_296);
    expect(holdingsBasisOf({ history: HIST })?.source).toBe("history");
  });
});

describe("동기화는 이력도 수익률도 만들지 않는다", () => {
  it("anchor 목록에서 이력 항목은 원본 그대로이고, 동기화 anchor 는 입금 0 · 평가액 0 · 수익률 null", () => {
    const anchors = holdingsAnchorsOf({ history: HIST, brokerSyncs: [SYNC] });
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toBe(HIST[0]); // 기존 history 객체는 복사/수정되지 않는다
    expect(anchors[0].returnPct).toBe(3.2);
    expect(anchors[1]).toMatchObject({ deposit: 0, totalValue: 0, baseAmount: 0, returnPct: null });
    expect(HIST).toHaveLength(1);
  });

  it("history 를 직접 읽는 소비자(예: buildLivePoint 의 비교선)는 동기화로 값이 바뀌지 않는다", () => {
    const a = buildLivePoint(HIST as never, LIB, prices, false, CASH, undefined, "k");
    const b = buildLivePoint(HIST as never, LIB, prices, false, CASH, undefined, "k", [SYNC]);
    expect(b?.growthValue).toBe(a?.growthValue); // 성장형 비교선은 리밸런싱 유닛만 본다
    expect(b?.kospiValue).toBe(a?.kospiValue);
  });
});

describe("시세 미확보 — 동기화의 저장 금액은 취득금액이라 평가액으로 쓰지 않는다 (앱 쪽)", () => {
  const { getEtfPositions, hasUnpricedSyncRows } = DashboardMod;
  const libraryOf = LIB as never;
  const acct = (extra: Record<string, unknown>) => ({ history: HIST, ...extra }) as never;

  it("동기화 기준 + 시세 없음: 취득금액(5,976,550원 등)이 평가액으로 나오지 않고 '미평가'로 표시된다", () => {
    const a = acct({ brokerSyncs: [SYNC] });
    expect(getEtfPositions(a, libraryOf, {})).toEqual([]);
    expect(hasUnpricedSyncRows(a, libraryOf, {})).toBe(true);
    // 한 종목만 시세가 있으면 그 종목만 평가되고 계좌는 여전히 '미평가'다(부분 합산을 전체로 내지 않도록 호출부가 합계를 보류한다)
    const partial = getEtfPositions(a, libraryOf, { "360750": P_KR });
    expect(partial.map((p) => [p.etfName, p.value])).toEqual([["TIGER 미국S&P500", 230 * P_KR]]);
    expect(hasUnpricedSyncRows(a, libraryOf, { "360750": P_KR })).toBe(true);
  });
  it("동기화 기준 + 시세 모두 있음: 정상 평가, 미평가 아님", () => {
    const a = acct({ brokerSyncs: [SYNC] });
    expect(hasUnpricedSyncRows(a, libraryOf, { "360750": P_KR, "367380": P_US })).toBe(false);
    expect(getEtfPositions(a, libraryOf, { "360750": P_KR, "367380": P_US }).reduce((s, p) => s + p.value, 0)).toBe(expectedEtf);
  });
  it("일반 리밸런싱 기준 계좌의 폴백은 그대로 — 저장된 평가금액을 쓰고 미평가가 아니다", () => {
    const h = [{ ...HIST[0], rowHoldingsSnap: { kr: 7_000_000, us: 2_500_000 } }];
    const a = { history: h } as never;
    expect(hasUnpricedSyncRows(a, libraryOf, {})).toBe(false);
    expect(getEtfPositions(a, libraryOf, {}).reduce((s, p) => s + p.value, 0)).toBe(9_500_000);
  });
});
