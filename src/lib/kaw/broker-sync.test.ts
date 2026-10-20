/**
 * 계좌 상태 동기화(broker_sync) — 순수 판정 모델과 읽기 경로 (Phase 4-D)
 *
 * 지키는 것:
 *   1. 판정: 원장 재생 == 증권사 보유(양방향) · 이전 확정 · 정정 없음 · 행 매핑(fail closed) · 오래된 관측은 별도 승인
 *   2. 새 문서는 허용된 5개 키만 바뀐다. history · cashflows · baseAmount · deposit · 그 밖의 키는 그대로
 *   3. 동기화 기록은 리밸런싱이 아니다 — 거래·현금흐름·기준금액을 만들지 않고, 수익률 anchor 가 가짜 손익을 만들지 않는다
 *   4. 날짜 분리: 보유수량 효력일(10-14) ≠ 예수금 관측일 ≠ 승인 시각. 예수금은 효력일이 없다(null)
 *   5. 읽기 경로(일별 스냅샷 · 보유 기준)가 동기화를 보유 근거로 쓰되, 더 늦은 리밸런싱이 있으면 이력이 이긴다
 *   6. 계획 해시는 승인 행위(오래된 관측 허용)와 revision 에 흔들리지 않고, 바뀔 값의 현재값에는 반응한다
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));

const {
  BROKER_SYNC_AUDIT_ACTION, BROKER_SYNC_MUTABLE_KEYS, evaluateBrokerSync, finalizeSyncWrite, disallowedChanges, rowNamesOf,
} = await import("./broker-sync");
const { holdingsBasisOf, holdingsAnchorsOf, asBrokerSyncs } = await import("./broker-sync-basis");
const { buildDailySnapshotRows } = await import("./snapshot");
const { ledgerRowToTransaction } = await import("./kis-execution-server");
const { validateTransferConfirm } = await import("./account-transfer-record");

const kisInstance = { id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const miraeInstance = { id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const dbTx = (over: Record<string, unknown>) => ({
  id: "t1", account_type: "pension", ticker: "360750", etf_name: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  trade_date: null, settlement_date: "2026-10-07", inferred_trade_date: "2026-10-02", event_date: "2026-10-02",
  trade_date_evidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, post_quantity: null, source: "miraeasset_capture_qty_price_reconstructed", import_batch_id: "imp:v2", ...over,
});
const proxy = { source: "user_attested_liquidation_price_proxy", import_batch_id: "imp:proxy", event_date: "2026-10-13", inferred_trade_date: null, settlement_date: null, fee: null, tax: null, post_quantity: 0, trade_date_evidence: "user-attested-full-liquidation; exact-sale-date-unknown" };
const MIRAE_ROWS = [
  dbTx({ id: "b1" }),
  dbTx({ id: "b2", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
  dbTx({ id: "s1", side: "sell", ...proxy }),
  dbTx({ id: "s2", side: "sell", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...proxy }),
];
const kis = (id: string, ticker: string, name: string, q: number, price: number, amount: number) => dbTx({
  id, ticker, etf_name: name, side: "buy", quantity: q, price, amount, trade_date: "2026-10-14", settlement_date: null, inferred_trade_date: null,
  event_date: "2026-10-14", trade_date_evidence: "broker-order-date", fee: null, tax: null, post_quantity: null, source: "kis_api_daily_ccld", import_batch_id: "imp:kis",
});
const KIS_ROWS = [kis("k1", "360750", "TIGER 미국S&P500", 230, 25985, 5_976_550), kis("k2", "367380", "ACE 미국나스닥100", 64, 31220, 1_998_080)];
const ledger = (rows: Record<string, unknown>[] = [...MIRAE_ROWS, ...KIS_ROWS]) => rows.map(ledgerRowToTransaction);

const transfer = (() => {
  const v = validateTransferConfirm(
    { toInstanceId: kisInstance.id, fromInstanceId: miraeInstance.id, anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], approved: true },
    { registry: [miraeInstance as never, kisInstance as never], ledger: ledger(MIRAE_ROWS), existing: [],
      observation: { captureId: "cap:x", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" }, today: "2026-10-19", actor: "p", nowIso: "2026-10-19T08:57:45.000Z" },
  );
  if (!v.ok) throw new Error(v.message);
  return v.record;
})();

const LIB = [{ defaultEtf: "TIGER 미국S&P500", ticker: "360750" }, { defaultEtf: "ACE 미국나스닥100", ticker: "367380" }];
const HISTORY = [{
  id: "h1", date: "2026-10-01", confirmed: true, deposit: 0, totalValue: 10_000_000, returnPct: 1.5,
  rowQuantitiesSnap: { kr: 297, us: 81 }, rowEtfSnap: { kr: "TIGER 미국S&P500", us: "ACE 미국나스닥100" }, rowLabelSnap: { kr: "S&P", us: "나스닥" }, rowHoldingsSnap: { kr: 7_695_270, us: 2_564_460 },
}];
const doc = (over: Record<string, unknown> = {}) => ({
  profile: "growth", active: true, history: HISTORY, cashflows: [{ id: "c1", date: "2025-11-10", amount: 10_500_000 }], baseAmount: 10_500_000, deposit: 0,
  assetRows: [{ id: "kr", etfName: "TIGER 미국S&P500", assetId: "kr" }, { id: "us", etfName: "ACE 미국나스닥100", assetId: "us" }],
  liveQuantities: { kr: 297, us: 81 }, rowHoldings: { kr: 7_695_270, us: 2_564_460 }, cashBalance: 29_296, extraKey: { keep: true }, ...over,
});
const balance = (over: Record<string, unknown> = {}) => ({
  holdings: { "360750": 230, "367380": 64 }, cash: 2_318_828, stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z",
  source: "stored_observation" as const, captureId: "cap:x", ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  flagEnabled: true, doc: doc(), revision: 5, library: LIB, ledger: ledger(), correctionsPresent: false,
  transfers: [transfer], balance: balance(), flows: [{ date: "2025-11-10", amount: 10_500_000 }],
  snapshotDates: ["2026-10-13", "2026-10-14", "2026-10-15"], today: "2026-10-19", staleObservationApproved: false, ...over,
}) as never;
const codes = (e: { blockers: Array<{ code: string }> }) => e.blockers.map((b) => b.code);

describe("판정 — 근거가 모두 맞을 때만 계획을 만든다", () => {
  it("정상: 230/64, 효력일 10-14, 예수금은 관측값. 기록은 리밸런싱·거래·현금흐름이 아니다", () => {
    const e = evaluateBrokerSync(input());
    expect(e.eligible).toBe(true);
    expect(e.enabled).toBe(true);
    const p = e.plan!;
    expect(p.holdingsEffectiveFrom).toBe("2026-10-14");
    expect(p.rows.map((r) => [r.rowId, r.ticker, r.quantityBefore, r.quantityAfter])).toEqual([["kr", "360750", 297, 230], ["us", "367380", 81, 64]]);
    expect(p.cash).toMatchObject({ before: 29_296, after: 2_318_828, stateAsOf: "2026-10-19", fresh: true });
    expect(p.principal).toEqual({ amount: 10_500_000, unchanged: true });
    const r = e.write!.record;
    expect(r).toMatchObject({ kind: "broker_sync", notRebalance: true, createsCashflow: false, createsTrade: false, changesBaseAmount: false });
    expect(r.quantities).toEqual({ kr: 230, us: 64 });
    expect(r.holdingsByTicker).toEqual({ "360750": 230, "367380": 64 });
    expect(r.rowHoldingsBasis).toBe("ledger_acquisition_amount");
    expect(r.rowHoldingsSnap).toEqual({ kr: 5_976_550, us: 1_998_080 });
  });

  it("날짜가 서로 섞이지 않는다 — 효력일(10-14) · 예수금 관측일(10-19) · 승인 시각 · 이전 기준일(10-13)", () => {
    const r = evaluateBrokerSync(input()).write!.record;
    expect(r.holdingsEffectiveFrom).toBe("2026-10-14");
    expect(r.cash.effectiveFrom).toBeNull();           // 예수금은 효력일이 없다: 10-14 잔고로 보이게 하지 않는다
    expect(r.cash.stateAsOf).toBe("2026-10-19");
    expect(r.cash.observedAt).toBe("2026-10-19T06:00:00.000Z");
    expect(r.transfer.anchorDate).toBe("2026-10-13");  // 추정 매도 회계 기준일일 뿐
    expect(r.transfer.approvedAt).not.toBe(r.cash.observedAt);
    expect(r.approvedAt).toBe(""); // 승인 시각은 반영 시점에 채운다
    const f = finalizeSyncWrite(evaluateBrokerSync(input()).write!, "2026-10-20T01:10:00.000Z", "hyeobi");
    expect(f.record).toMatchObject({ approvedAt: "2026-10-20T01:10:00.000Z", approvedBy: "hyeobi" });
    const list = f.newData.brokerSyncs as Array<{ approvedAt: string }>;
    expect(list.at(-1)!.approvedAt).toBe("2026-10-20T01:10:00.000Z");
  });

  it("새 문서는 허용된 5개 키만 바뀐다 — history · cashflows · baseAmount · deposit · 그 밖의 키는 그대로", () => {
    const e = evaluateBrokerSync(input());
    const next = e.write!.newData;
    expect(disallowedChanges(doc(), next)).toEqual([]);
    expect(next.history).toEqual(HISTORY);
    expect(next.baseAmount).toBe(10_500_000);
    expect(next.extraKey).toEqual({ keep: true });
    expect(BROKER_SYNC_MUTABLE_KEYS).toEqual(["liveQuantities", "rowHoldings", "cashBalance", "cashBalanceObservation", "brokerSyncs"]);
    expect(disallowedChanges(doc(), { ...next, baseAmount: 1 })).toEqual(["baseAmount"]);
    expect(disallowedChanges(doc(), { ...next, history: [] })).toEqual(["history"]);
    expect(disallowedChanges(doc(), { ...next, cashflows: [] })).toEqual(["cashflows"]);
    expect(BROKER_SYNC_AUDIT_ACTION).toBe("broker_sync_apply");
  });

  it("미확인 차이와 소득 상한은 '모델상 가능한 범위'일 뿐 확정이 아니다 — 거래·입금을 만들지 않는다", () => {
    const r = evaluateBrokerSync(input()).write!.record;
    expect(r.incomeRangeUpper.meaning).toBe("model_possible_range_not_confirmed_income");
    expect(r.incomeRangeUpper.amount === null || r.incomeRangeUpper.amount >= 0).toBe(true);
    expect(Array.isArray(r.unconfirmedDifferences)).toBe(true);
    expect(r.createsCashflow).toBe(false);
    expect(r.createsTrade).toBe(false);
  });

  it("영향받는 기존 스냅샷 날짜를 알린다(효력일 이후). 지우거나 바꾸지 않는다고 기록한다", () => {
    const e = evaluateBrokerSync(input());
    expect(e.plan!.affectedSnapshotDates).toEqual(["2026-10-14", "2026-10-15"]); // 10-13(유효한 이전 데이터)은 포함되지 않는다
    expect(e.write!.record.affectedSnapshots).toEqual({ dates: ["2026-10-14", "2026-10-15"], reason: "computed_from_pre_transfer_holdings_and_cash", preserved: true });
    const none = evaluateBrokerSync(input({ snapshotDates: ["2026-10-13"] }));
    expect(none.write!.record.affectedSnapshots).toBeNull();
  });
});

describe("차단 — 근거가 어긋나면 계획을 만들지 않거나 승인을 막는다", () => {
  it("증권사 보유가 원장 재생과 다르면(수량·종목 빠짐·종목 추가) holdings_mismatch, 계획 없음", () => {
    for (const holdings of [{ "360750": 230, "367380": 65 }, { "360750": 230 }, { "360750": 230, "367380": 64, "999999": 1 }]) {
      const e = evaluateBrokerSync(input({ balance: balance({ holdings }) }));
      expect(codes(e)).toContain("holdings_mismatch");
      expect(e.eligible).toBe(false);
      expect(e.plan).toBeNull();
      expect(e.write).toBeNull();
    }
  });

  it("이전 확정이 없으면 transfer_unconfirmed, 원장에 한국투자 체결이 없으면 ledger_not_covering", () => {
    expect(codes(evaluateBrokerSync(input({ transfers: [] })))).toContain("transfer_unconfirmed");
    const e = evaluateBrokerSync(input({ ledger: ledger(MIRAE_ROWS) }));
    expect(codes(e)).toContain("ledger_not_covering");
    expect(e.write).toBeNull();
  });

  it("거래 정정(overlay)이 있으면 자동 동기화하지 않는다", () => {
    expect(codes(evaluateBrokerSync(input({ correctionsPresent: true })))).toContain("corrections_present");
  });

  it("관측이 없으면 balance_unavailable, 예수금이 비정상이면 invalid_cash", () => {
    const none = evaluateBrokerSync(input({ balance: null, balanceFailure: "auth_or_transport" }));
    expect(codes(none)).toContain("balance_unavailable");
    expect(none.plan).toBeNull();
    for (const cash of [-1, 10.5, Number.NaN]) {
      const e = evaluateBrokerSync(input({ balance: balance({ cash }) }));
      expect(codes(e)).toContain("invalid_cash");
      expect(e.plan).toBeNull();
    }
  });

  it("오늘이 아닌 관측은 별도 승인 없이는 막힌다 — 승인해도 fresh=false 로 기록된다", () => {
    const stale = evaluateBrokerSync(input({ today: "2026-10-20" }));
    expect(stale.needsStaleApproval).toBe(true);
    expect(codes(stale)).toContain("balance_stale");
    expect(stale.eligible).toBe(false);
    expect(stale.plan!.cash).toMatchObject({ stateAsOf: "2026-10-19", fresh: false });
    const approved = evaluateBrokerSync(input({ today: "2026-10-20", staleObservationApproved: true }));
    expect(approved.eligible).toBe(true);
    expect(approved.write!.record.cash.fresh).toBe(false);
    expect(approved.write!.record.staleObservationApproved).toBe(true);
    // 신선한 관측에는 승인 플래그가 기록되지 않는다
    expect(evaluateBrokerSync(input({ staleObservationApproved: true })).write!.record.staleObservationApproved).toBe(false);
  });

  it("행 매핑이 불확실하면 조용히 버리지 않고 막는다 (종목 없음 · 코드 없음 · 여러 행)", () => {
    const missingRow = evaluateBrokerSync(input({ doc: doc({ assetRows: [{ id: "kr", etfName: "TIGER 미국S&P500", assetId: "kr" }] , liveQuantities: { kr: 297 }, rowHoldings: { kr: 1 }, history: [{ ...HISTORY[0], rowQuantitiesSnap: { kr: 297 }, rowEtfSnap: { kr: "TIGER 미국S&P500" } }] }) }));
    expect(codes(missingRow)).toContain("unmapped_ticker");
    const noTicker = evaluateBrokerSync(input({ library: [{ defaultEtf: "TIGER 미국S&P500" }, { defaultEtf: "ACE 미국나스닥100", ticker: "367380" }] }));
    expect(codes(noTicker)).toContain("unresolved_row");
    const twoRows = evaluateBrokerSync(input({
      doc: doc({ assetRows: [{ id: "kr", etfName: "TIGER 미국S&P500" }, { id: "kr2", etfName: "TIGER 미국S&P500" }, { id: "us", etfName: "ACE 미국나스닥100" }], liveQuantities: { kr: 0, kr2: 0, us: 81 } }),
    }));
    expect(codes(twoRows)).toContain("ambiguous_row");
  });

  it("동기화 효력일(원장 마지막 날)보다 늦은 리밸런싱 이력이 있으면 history_newer", () => {
    const later = [...HISTORY, { ...HISTORY[0], id: "h2", date: "2026-10-16" }];
    expect(codes(evaluateBrokerSync(input({ doc: doc({ history: later }) })))).toContain("history_newer");
  });

  it("같은 상태가 이미 기록돼 있으면 already_synced", () => {
    const first = evaluateBrokerSync(input());
    const again = evaluateBrokerSync(input({ doc: doc({ brokerSyncs: [first.write!.record] }) }));
    expect(again.alreadySynced).toBe(true);
    expect(codes(again)).toContain("already_synced");
    expect(again.eligible).toBe(false);
  });

  it("플래그가 꺼져 있으면 flag_off 만 추가되고 enabled=false (계획은 보여 준다)", () => {
    const e = evaluateBrokerSync(input({ flagEnabled: false }));
    expect(codes(e)).toEqual(["flag_off"]);
    expect(e.eligible).toBe(true);
    expect(e.enabled).toBe(false);
    expect(e.plan).toBeTruthy();
  });
});

describe("계획 해시", () => {
  const hash = (over: Record<string, unknown> = {}) => evaluateBrokerSync(input(over)).plan!.planHash;
  it("같은 입력이면 같다 / 형식 s1|hex", () => {
    expect(hash()).toBe(hash());
    expect(hash()).toMatch(/^s1\|[0-9a-f]+$/);
  });
  it("revision 이나 '오래된 관측 승인' 플래그에는 흔들리지 않는다", () => {
    expect(hash({ revision: 99 })).toBe(hash());
    expect(hash({ today: "2026-10-20", staleObservationApproved: true })).toBe(hash({ today: "2026-10-20", staleObservationApproved: false }));
  });
  it("바뀔 값의 현재값(수량 · 예수금)이나 관측 예수금이 달라지면 달라진다", () => {
    expect(hash({ doc: doc({ liveQuantities: { kr: 298, us: 81 } }) })).not.toBe(hash());
    expect(hash({ doc: doc({ cashBalance: 30_000 }) })).not.toBe(hash());
    expect(hash({ balance: balance({ cash: 2_318_829 }) })).not.toBe(hash());
    expect(hash({ balance: balance({ stateAsOf: "2026-10-18" }) })).not.toBe(hash());
    expect(hash({ balance: balance({ source: "kis_live_read" }) })).not.toBe(hash());
  });
});

describe("읽기 경로 — 보유 기준(holdingsBasisOf)", () => {
  const rec = (date: string, id = `bsync:${date}`) => evaluateBrokerSync(input()).write!.record && ({
    ...evaluateBrokerSync(input()).write!.record, id, holdingsEffectiveFrom: date,
  });
  const hist = (date: string, id = `h-${date}`) => ({ id, date, rowQuantitiesSnap: { kr: 1 } });

  it("동기화 기록이 없으면 마지막 이력 (기존과 같다)", () => {
    const b = holdingsBasisOf({ history: [hist("2026-09-01"), hist("2026-10-01")] });
    expect(b).toMatchObject({ id: "h-2026-10-01", source: "history" });
    expect(holdingsBasisOf({ history: [] })).toBeNull();
  });
  it("동기화 효력일이 더 늦으면 동기화, 이력이 더 늦으면 이력, 같으면 동기화", () => {
    expect(holdingsBasisOf({ history: [hist("2026-10-01")], brokerSyncs: [rec("2026-10-14")] })?.source).toBe("broker_sync");
    expect(holdingsBasisOf({ history: [hist("2026-10-20")], brokerSyncs: [rec("2026-10-14")] })?.source).toBe("history");
    expect(holdingsBasisOf({ history: [hist("2026-10-14")], brokerSyncs: [rec("2026-10-14")] })?.source).toBe("broker_sync");
  });
  it("동기화만 있어도 기준이 된다. 모양이 틀린 항목은 무시한다", () => {
    expect(holdingsBasisOf({ history: [], brokerSyncs: [rec("2026-10-14")] })?.source).toBe("broker_sync");
    expect(asBrokerSyncs([{ kind: "other" }, null, 5, { kind: "broker_sync" }, { kind: "broker_sync", holdingsEffectiveFrom: "2026-10-14" }])).toEqual([]);
    expect(holdingsBasisOf({ history: [hist("2026-10-01")], brokerSyncs: "garbage" })?.source).toBe("history");
  });
  it("동기화 anchor 는 가짜 손익을 만들 수 없다 — 입금 0 · 평가액 0 · 수익률 null", () => {
    const anchors = holdingsAnchorsOf({ history: [hist("2026-10-01")], brokerSyncs: [rec("2026-10-14")] });
    expect(anchors).toHaveLength(2);
    const a = anchors.find((x) => x.id === "bsync:2026-10-14") as unknown as { deposit: number; totalValue: number; baseAmount: number; returnPct: null; holdings: unknown[] };
    expect(a).toMatchObject({ deposit: 0, totalValue: 0, baseAmount: 0, returnPct: null, holdings: [] });
  });
});

describe("읽기 경로 — 일별 스냅샷(cron)이 동기화를 보유 근거로 쓴다", () => {
  const prices = new Map([["360750", { price: 26_000, fetchedAt: "2026-10-20T06:30:00Z" }], ["367380", { price: 31_000, fetchedAt: "2026-10-20T06:30:00Z" }]]);
  const tickers = new Map([["TIGER 미국S&P500", "360750"], ["ACE 미국나스닥100", "367380"]]);
  const sync = (cash: number) => {
    const e = evaluateBrokerSync(input({ balance: balance({ cash }) }));
    return finalizeSyncWrite(e.write!, "2026-10-20T01:10:00.000Z", "hyeobi").newData;
  };
  const acc = (data: Record<string, unknown>) => ({ familyCode: "f", profile: "p", accountType: "pension", history: data.history as never, brokerSyncs: data.brokerSyncs, cashBalance: data.cashBalance as number });

  it("동기화 전: 옛 수량(297/81) × 시세 + 옛 예수금", () => {
    const { rows } = buildDailySnapshotRows([acc(doc())], tickers, prices, "2026-10-20");
    expect(rows[0].market_value).toBe(297 * 26_000 + 81 * 31_000);
    expect(rows[0].total_asset_value).toBe(297 * 26_000 + 81 * 31_000 + 29_296);
  });
  it("동기화 후: 230/64 × 시세 + 새 예수금 — 예수금만 바꿨을 때의 과대평가(옛 수량 + 새 예수금)가 아니다", () => {
    const { rows } = buildDailySnapshotRows([acc(sync(2_318_828))], tickers, prices, "2026-10-20");
    expect(rows[0].market_value).toBe(230 * 26_000 + 64 * 31_000);
    expect(rows[0].cash_balance).toBe(2_318_828);
    expect(rows[0].total_asset_value).toBe(230 * 26_000 + 64 * 31_000 + 2_318_828);
    expect(rows[0].total_asset_value).toBeLessThan(297 * 26_000 + 81 * 31_000 + 2_318_828);
  });
  it("동기화 뒤에 더 늦은 리밸런싱이 저장되면 이력이 이긴다", () => {
    const data = sync(2_318_828);
    const later = { ...data, history: [...(data.history as unknown[]), { ...HISTORY[0], id: "h2", date: "2026-10-25", rowQuantitiesSnap: { kr: 100, us: 10 } }] };
    const { rows } = buildDailySnapshotRows([acc(later)], tickers, prices, "2026-10-26");
    expect(rows[0].market_value).toBe(100 * 26_000 + 10 * 31_000);
  });
  it("동기화 기록이 없는 계좌는 이전과 똑같이 계산된다 (brokerSyncs 키 자체가 없어도)", () => {
    const a = buildDailySnapshotRows([acc(doc())], tickers, prices, "2026-10-20");
    const b = buildDailySnapshotRows([{ ...acc(doc()), brokerSyncs: undefined }], tickers, prices, "2026-10-20");
    expect(a).toEqual(b);
  });
});

describe("rowNamesOf", () => {
  it("이력의 이름 위에 현재 행 정의가 덮어쓴다", () => {
    const n = rowNamesOf(doc({ assetRows: [{ id: "kr", etfName: "새 이름", assetId: "krX" }] }));
    expect(n.names.kr).toBe("새 이름");
    expect(n.names.us).toBe("ACE 미국나스닥100");
    expect(n.assets.kr).toBe("krX");
    expect(n.labels.us).toBe("나스닥");
  });
});
