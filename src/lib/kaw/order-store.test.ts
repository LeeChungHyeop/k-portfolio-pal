import { describe, it, expect } from "vitest";
import { InMemoryOrderStore } from "./order-store";
import type { OrderIntent } from "./order-intent";

const SCOPE = { familyCode: "soye", profile: "hyeobi" };
const base = (id: string, key: string, over: Partial<OrderIntent> = {}): OrderIntent => ({
  id, scope: SCOPE, idempotencyKey: key, attempt: 1, accountInstanceId: "bai:x", broker: "kis",
  productCode: "22", side: "buy", ticker: "360750", quantity: 1, limitPrice: 25_985, ordDvsn: "00",
  amount: 25_985, buyingPowerAtProposal: null, state: "proposed", version: 0,
  approvalTokenHash: "h", approvalExpiresAt: "2026-10-14T05:02:00.000Z", approvalConsumedAt: null,
  submitStartedAt: null, orderNo: null, orderOrgNo: null, orderTime: null, evidence: null,
  lastInquiryAt: null, ambiguous: false, lastError: null,
  createdAt: "2026-10-14T05:00:00.000Z", updatedAt: "2026-10-14T05:00:00.000Z", policyVersion: 1, ...over,
});

describe("InMemoryOrderStore", () => {
  it("멱등 키 중복 삽입은 거부된다", async () => {
    const s = new InMemoryOrderStore();
    expect((await s.insert(base("a", "k1"))).ok).toBe(true);
    expect((await s.insert(base("b", "k1"))).ok).toBe(false);
  });
  it("낙관적 잠금: 낡은 버전의 갱신은 실패하고 한쪽만 성공한다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(base("a", "k1"));
    const r1 = await s.update(SCOPE, "a", 0, { state: "submitting" }, "2026-10-14T05:00:01.000Z");
    const r2 = await s.update(SCOPE, "a", 0, { state: "submitting" }, "2026-10-14T05:00:01.000Z");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect((await s.getById(SCOPE, "a"))!.version).toBe(1);
  });
  it("다른 범위에서는 보이지 않는다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(base("a", "k1"));
    expect(await s.getById({ familyCode: "soye", profile: "other" }, "a")).toBeNull();
    expect(await s.listOpen({ familyCode: "x", profile: "hyeobi" })).toEqual([]);
  });
  it("listOpen 은 종결 상태를 제외한다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(base("a", "k1", { state: "accepted", orderNo: "1" }));
    await s.insert(base("b", "k2", { state: "rejected" }));
    expect((await s.listOpen(SCOPE)).map((i) => i.id)).toEqual(["a"]);
  });
  it("재시작: 같은 저장소를 다시 읽어도 submitting 이 남아 있다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(base("a", "k1"));
    await s.update(SCOPE, "a", 0, { state: "submitting" }, "2026-10-14T05:00:01.000Z");
    expect((await s.getById(SCOPE, "a"))!.state).toBe("submitting");
  });
});
