/**
 * 한국투자 잔고 → 결제 관측 변환 (Phase 4-C-1)
 *
 * 지키는 것:
 *   1. 관측 기준시각(observedAt) · 증권사 기준일(stateAsOf) · 출처(broker/source/instance)를 반드시 보존한다
 *   2. 조회하지 못한 축은 기록하지 않는다 (0 으로 채우지 않는다)
 *   3. 0행 보유를 '전부 0주'로 단정하지 않는다 (source registry 가 확정하기 전)
 *   4. 같은 내용의 관측은 조회 시각이 달라도 같은 capture 다 (폴링 로그가 되지 않는다)
 *   5. 계좌번호 · 키 · 토큰이 기록에 없다
 */
import { describe, it, expect } from "vitest";
import { buildKisObservation, KIS_PRODUCTS, resolveKisInstance } from "./kis-account-observe";
import type { KisBalanceSnapshot } from "./kis-account-server";
import type { BrokerAccountInstance } from "./broker-account";
import {
  KIS_BALANCE_SOURCE_TYPE,
  dbRowToPart,
  observationToPart,
  partToDbRow,
  summarizeObservation,
} from "./kis-balance-observation";

const KIS: BrokerAccountInstance = { id: "bai:kis", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };

function snap(over: Partial<KisBalanceSnapshot> = {}): KisBalanceSnapshot {
  return {
    ok: true, httpStatus: 200, rtCd: "0", msgCd: "KIOK0510", msg1: "조회가 완료되었습니다",
    holdings: [{ ticker: "360750", name: "TIGER 미국S&P500", quantity: 230 }, { ticker: "367380", name: "ACE 미국나스닥100", quantity: 64 }],
    holdingsCount: 2, cash: 2_318_828, summary: { dnca_tot_amt: 2_318_828, pchs_amt_smtl_amt: 7_974_630 }, ...over,
  };
}
function obs(over: { balance?: KisBalanceSnapshot; registry?: BrokerAccountInstance[]; observedAt?: string } = {}) {
  const registry = over.registry ?? [KIS];
  return buildKisObservation({
    productCode: "22",
    resolution: resolveKisInstance("22", registry, "2026-10-19"),
    stateAsOf: "2026-10-19",
    observedAt: over.observedAt ?? "2026-10-19T06:00:00.000Z",
    balance: over.balance ?? snap(),
  });
}

describe("관측 part 생성 — 실제 잔고 (230주 · 64주 · 2,318,828원)", () => {
  const r = observationToPart(obs(), "hyeobi", "사용자 승인");
  if (!r.ok) throw new Error(r.reason);
  const p = r.part;

  it("출처 · 계좌 instance · 상품코드가 보존된다", () => {
    expect(p.broker).toBe("kis");
    expect(p.brokerProductCode).toBe("22");
    expect(p.accountInstanceId).toBe("bai:kis");
    expect(p.accountType).toBe("pension");
    expect(p.sourceType).toBe(KIS_BALANCE_SOURCE_TYPE);
    expect(p.actor).toBe("hyeobi");
    expect(p.note).toBe("사용자 승인");
  });

  it("관측 기준시각과 증권사 기준일(현재 잔고 = 조회일)을 따로 보존한다", () => {
    expect(p.observedAt).toBe("2026-10-19T06:00:00.000Z");
    expect(p.stateAsOf).toBe("2026-10-19");
    expect(p.stateAsOfBasis).toBe("observation_date");
  });

  it("보유와 예수금이 그대로 담긴다", () => {
    expect(p.holdings).toEqual({ "360750": 230, "367380": 64 });
    expect(p.cash).toBe(2_318_828);
  });

  it("id 는 obs:<capture>:<source> 이고 해시 버전이 있다", () => {
    expect(p.id).toBe(`obs:${p.captureId}:${KIS_BALANCE_SOURCE_TYPE}`);
    expect(p.captureId.startsWith("cap:bai:kis:2026-10-19:")).toBe(true);
    expect(p.capturePayloadHash.startsWith("c1|")).toBe(true);
    expect(p.hashVersion).toBe(1);
  });

  it("계좌번호 · 키 · 토큰 같은 값이 어디에도 없다", () => {
    const s = JSON.stringify([p, partToDbRow(p, "fam", "prof"), summarizeObservation(p)]);
    expect(s).not.toMatch(/(appkey|appsecret|access_token|cano)/i);
  });
});

describe("조회하지 못한 것은 기록하지 않는다", () => {
  it("보유종목을 읽지 못했으면 기록하지 않는다", () => {
    const r = observationToPart(obs({ balance: snap({ ok: false, httpStatus: 500, rtCd: "1", holdings: [], holdingsCount: 0, cash: null }) }), "hyeobi");
    expect(r).toEqual({ ok: false, reason: "holdings_not_observed" });
  });

  it("예수금 필드가 없으면 기록하지 않는다 (0 으로 채우지 않는다)", () => {
    expect(observationToPart(obs({ balance: snap({ cash: null }) }), "hyeobi")).toEqual({ ok: false, reason: "cash_not_observed" });
  });

  it("등록되지 않은 계좌(sentinel)의 관측은 기록하지 않는다", () => {
    expect(observationToPart(obs({ registry: [] }), "hyeobi")).toEqual({ ok: false, reason: "not_registered_instance" });
  });

  it("IRP(29)는 이 경로로 기록하지 않는다", () => {
    const o = { ...obs(), productCode: "29" as const };
    expect(observationToPart(o, "hyeobi")).toEqual({ ok: false, reason: "wrong_product" });
    expect(KIS_PRODUCTS["22"].logicalAccountType).toBe("pension");
  });

  it("0행 보유는 '전부 0주'로 단정하지 않고 미관측(null)으로 둔다", () => {
    const r = observationToPart(obs({ balance: snap({ holdings: [], holdingsCount: 0 }) }), "hyeobi");
    expect(r.ok && r.part.holdings).toBeNull();
    expect(r.ok && r.part.holdingsCompleteness).toBe("unknown");
    expect(r.ok && r.part.cash).toBe(2_318_828);
  });

  it("읽지 못한 보유 행이 있으면 완전성을 올리지 않는다", () => {
    const r = observationToPart(obs({ balance: snap({ holdings: [{ ticker: "360750", name: "T", quantity: 230 }, { ticker: null, name: null, quantity: null }], holdingsCount: 2 }) }), "hyeobi");
    expect(r.ok && r.part.holdingsCompleteness).toBe("partial");
  });
});

describe("capture 동일성 · DB 행 왕복", () => {
  it("같은 내용이면 조회 시각이 달라도 같은 capture id 다 (폴링 로그가 되지 않는다)", () => {
    const a = observationToPart(obs({ observedAt: "2026-10-19T06:00:00.000Z" }), "hyeobi");
    const b = observationToPart(obs({ observedAt: "2026-10-19T09:30:00.000Z" }), "hyeobi");
    expect(a.ok && b.ok && a.part.captureId === b.part.captureId).toBe(true);
    expect(a.ok && b.ok && a.part.id === b.part.id).toBe(true);
  });

  it("예수금이 다르면 다른 capture 다", () => {
    const a = observationToPart(obs(), "hyeobi");
    const b = observationToPart(obs({ balance: snap({ cash: 2_318_000 }) }), "hyeobi");
    expect(a.ok && b.ok && a.part.captureId !== b.part.captureId).toBe(true);
  });

  it("DB 행으로 바꿨다 되돌려도 같다 (조회 시각 · 기준일 · 보유 · 예수금)", () => {
    const r = observationToPart(obs(), "hyeobi");
    if (!r.ok) throw new Error(r.reason);
    const row = partToDbRow(r.part, "fam", "prof");
    expect(row.family_code).toBe("fam");
    expect(row.profile).toBe("prof");
    expect(row.source_type).toBe(KIS_BALANCE_SOURCE_TYPE);
    expect(row.state_as_of_basis).toBe("observation_date");
    const back = dbRowToPart({ ...row, cash: String(row.cash), observed_at: "2026-10-19T06:00:00+00:00", state_as_of: "2026-10-19" });
    expect(back).toMatchObject({ id: r.part.id, captureId: r.part.captureId, stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z", cash: 2_318_828, holdings: { "360750": 230, "367380": 64 } });
  });

  it("요약에는 조회 시각 · 기준일 · 출처가 있다", () => {
    const r = observationToPart(obs(), "hyeobi");
    if (!r.ok) throw new Error(r.reason);
    expect(summarizeObservation(r.part)).toMatchObject({ broker: "kis", sourceType: KIS_BALANCE_SOURCE_TYPE, observedAt: "2026-10-19T06:00:00.000Z", stateAsOf: "2026-10-19", cash: 2_318_828 });
  });
});
