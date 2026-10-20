/**
 * 계좌 동기화 기록이 클라이언트 읽기·마이그레이션을 거쳐도 사라지지 않는다 (Phase 4-D)
 *   · 서버가 쓴 brokerSyncs / cashBalanceObservation 을 migrateState 가 지우면, 다음 자동저장이 키를 잃은 문서를 보내게 된다
 *   · 동기화 기록이 있어도 원금(cashflow 장부)은 그대로 계산된다 — 기록은 원금과 무관하다
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));

const { migrateState, seedState } = await import("./store");
const { cumulativePrincipal } = await import("./cashflow");
const { asBrokerSyncs } = await import("./broker-sync-basis");

const REC = {
  id: "bsync:x", kind: "broker_sync", version: 1, accountType: "pension", holdingsEffectiveFrom: "2026-10-14",
  quantities: { kr: 230, us: 64 }, notRebalance: true, createsCashflow: false, createsTrade: false, changesBaseAmount: false,
};

describe("hydration", () => {
  it("migrateState 는 brokerSyncs · cashBalanceObservation 을 지우지 않는다", () => {
    const s = structuredClone(seedState());
    s.accounts.pension.brokerSyncs = [REC as never];
    s.accounts.pension.cashBalanceObservation = { stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z", source: "stored_observation", basis: "broker_observation", effectiveFrom: null, syncId: "bsync:x" };
    const out = migrateState(s, false);
    expect(asBrokerSyncs(out.accounts.pension.brokerSyncs)).toHaveLength(1);
    expect(out.accounts.pension.cashBalanceObservation).toMatchObject({ stateAsOf: "2026-10-19" });
  });

  it("동기화 기록은 누적 납입원금(cashflow 장부)을 바꾸지 않는다", () => {
    const s = structuredClone(seedState());
    const before = cumulativePrincipal(s.accounts.pension.cashflows);
    s.accounts.pension.brokerSyncs = [REC as never];
    const out = migrateState(s, false);
    expect(cumulativePrincipal(out.accounts.pension.cashflows)).toBe(before);
  });

  it("brokerSyncs 가 없는 계좌는 키를 새로 만들지 않는다 (기존 문서가 그대로)", () => {
    const out = migrateState(structuredClone(seedState()), false);
    expect("brokerSyncs" in out.accounts.pension).toBe(false);
    expect("cashBalanceObservation" in out.accounts.pension).toBe(false);
  });
});
