/**
 * 승인형 주문 서비스를 **모의 증권사**로 검증한다. 실제 네트워크·주문·DB 를 쓰지 않는다.
 *
 * 모의 증권사(`FakeBroker`)는 "거래소 장부"를 가진다: place() 가 접수되면 장부에 남는다 —
 * **응답이 유실돼도 장부에는 남는다.** 그래서 타임아웃 시나리오가 현실과 같게 재현된다.
 *
 * 지키는 것:
 *   정상 · 거부 · 중복(순차·동시) · 타임아웃/불명 · 부분체결 · 재시작 복구 ·
 *   접수≠체결 · 응답 불명 시 자동 재주문 금지 · 체결 증거 전 원장 금지
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ORDER_POLICY,
  ledgerEligibility,
  type ExecutionRow,
  type PlaceResponse,
} from "./order-intent";
import { InMemoryOrderStore } from "./order-store";
import { publicIntent } from "./order-handlers";
import {
  prepareOrder,
  reconcileOrder,
  resolveOrder,
  submitOrder,
  type BrokerPort,
  type ResolveInput,
  type ConfirmEcho,
  type OrderContext,
  type OrderServiceDeps,
} from "./order-service";
import type { BuyingPowerResult } from "./kis-buying-power";

let clockMsRef: () => number = () => 0;
const kstHms = () => new Date(clockMsRef() + 9 * 3_600_000).toISOString().slice(11, 19).replace(/:/g, "");

// ── 모의 증권사 ─────────────────────────────────────────────────────────────

interface BookedOrder {
  orderNo: string; ticker: string; qty: number; price: number; filled: number; cancelled: boolean; time: string;
  /** 주문일 YYYYMMDD. 없으면 2026-10-14 */
  date?: string;
}

class FakeBroker implements BrokerPort {
  price: number | null = 25_985;
  bpAmount = 2_307_289;
  bpQty = 88;
  bpOk = true;
  /** 다음 place() 의 동작. 기본은 정상 접수 */
  placeMode: "accept" | "reject" | "timeout" | "http500" | "no_orderno" | "throw" | "accept_but_store_fails" = "accept";
  /** place() 안에서 호출되는 훅(저장 실패 주입 등) */
  onPlace: (() => void) | null = null;
  inquiryOk = true;
  /** 조회 응답에서 수량 필드를 지운다 */
  hideQty = false;
  /** 조회 결과에 다음 페이지가 있다고 답한다 */
  more = false;
  /** 응답에 목록(output1)이 없었던 것처럼 답한다 */
  noList = false;

  book: BookedOrder[] = [];
  calls = { quote: 0, buyingPower: 0, place: 0, inquire: 0 };
  placed: Array<{ ticker: string; quantity: number; limitPrice: number }> = [];
  private seq = 0;

  async quote() {
    this.calls.quote += 1;
    return { price: this.price, asOf: "2026-10-14T05:00:00.000Z" };
  }

  async buyingPower(ticker: string, unitPrice: number): Promise<BuyingPowerResult> {
    this.calls.buyingPower += 1;
    return {
      ok: this.bpOk, httpStatus: 200, rtCd: this.bpOk ? "0" : "1", ticker, unitPrice, ordDvsn: "00",
      ordPsblCash: this.bpAmount, nrcvbBuyAmt: this.bpOk ? this.bpAmount : null,
      nrcvbBuyQty: this.bpOk ? this.bpQty : null, maxBuyAmt: this.bpAmount, maxBuyQty: this.bpQty,
      psblQtyCalcUnpr: unitPrice, ruseAmt: 0,
    };
  }

  async place(req: { ticker: string; quantity: number; limitPrice: number }): Promise<PlaceResponse & { sent: boolean }> {
    this.calls.place += 1;
    this.placed.push({ ...req });
    this.onPlace?.();
    const orderNo = `000${++this.seq}`.padStart(10, "0");
    const book = () => this.book.push({
      orderNo, ticker: req.ticker, qty: req.quantity, price: req.limitPrice, filled: 0, cancelled: false, time: kstHms(),
    });
    switch (this.placeMode) {
      case "reject":
        return { sent: true, httpStatus: 200, rtCd: "1", msgCd: "APBK0013", msg1: "주문가능금액을 초과합니다" };
      case "timeout":
        book(); // 거래소는 받았다 — 응답만 유실됐다
        return { sent: true, httpStatus: 0, transportError: "aborted", timedOut: true };
      case "http500":
        book();
        return { sent: true, httpStatus: 500, rtCd: undefined };
      case "no_orderno":
        book();
        return { sent: true, httpStatus: 200, rtCd: "0", msgCd: "APBK0013", msg1: "정상", orderNo: null };
      case "throw":
        book();
        throw new Error("socket hang up");
      default:
        book();
        return {
          sent: true, httpStatus: 200, rtCd: "0", msgCd: "APBK0013", msg1: "주문 전송 완료",
          orderNo, orderOrgNo: "91252", orderTime: "090501",
        };
    }
  }

  async inquire(q: { ticker: string; date: string; orderNo: string | null }) {
    this.calls.inquire += 1;
    if (!this.inquiryOk) return { ok: false, rows: [] as ExecutionRow[], hasMore: false, error: "조회 실패" };
    const rows: ExecutionRow[] = this.book
      .filter((o) => o.ticker === q.ticker && (!q.orderNo || o.orderNo === q.orderNo))
      .map((o) => ({
        orderNo: o.orderNo, ticker: o.ticker,
        orderQty: this.hideQty ? null : o.qty, orderPrice: o.price, orderTime: o.time,
        filledQty: this.hideQty ? null : o.filled, avgPrice: o.filled > 0 ? o.price : null,
        remainingQty: o.qty - o.filled, cancelled: o.cancelled, sideCode: "02", orderDate: o.date ?? "20261014",
      }));
    return { ok: true, rows, hasMore: this.more, complete: !this.more && !this.noList };
  }

  /** 거래소에서 체결이 일어난다(테스트가 직접 일으킨다). */
  fill(orderNo: string, qty: number) {
    const o = this.book.find((x) => x.orderNo === orderNo)!;
    o.filled = qty;
  }
}

// ── 하네스 ──────────────────────────────────────────────────────────────────

const SCOPE = { familyCode: "soye", profile: "hyeobi" };
const CTX: OrderContext = { scope: SCOPE, accountInstanceId: "bai:kis-pension" };

let clockMs: number;
let tokenSeq: number;
let idSeq: number;

function makeDeps(store: InMemoryOrderStore, broker: FakeBroker, over: Partial<OrderServiceDeps> = {}): OrderServiceDeps {
  return {
    store, broker, enabled: true,
    now: () => new Date(clockMs),
    newId: () => `intent-${++idSeq}`,
    newToken: () => `token-${++tokenSeq}`,
    ...over,
  };
}

const echoOf = (i: { ticker: string; quantity: number; limitPrice: number; amount: number; accountInstanceId: string }): ConfirmEcho => ({
  ticker: i.ticker, quantity: i.quantity, limitPrice: i.limitPrice, amount: i.amount, accountInstanceId: i.accountInstanceId,
});

async function propose(deps: OrderServiceDeps, over: { ticker?: string; quantity?: number } = {}) {
  const r = await prepareOrder(CTX, { ticker: over.ticker ?? "360750", quantity: over.quantity ?? 1 }, deps);
  if (r.kind !== "proposed") throw new Error(`proposed 여야 한다: ${r.kind}`);
  return r;
}

let store: InMemoryOrderStore;
let broker: FakeBroker;
let deps: OrderServiceDeps;

beforeEach(() => {
  clockMs = Date.parse("2026-10-14T05:00:00.000Z"); // KST 14:00
  clockMsRef = () => clockMs;
  tokenSeq = 0;
  idSeq = 0;
  store = new InMemoryOrderStore();
  broker = new FakeBroker();
  deps = makeDeps(store, broker);
});

// ── 기능 flag ───────────────────────────────────────────────────────────────

describe("기능 flag OFF — 아무것도 호출하지 않는다", () => {
  it("prepare / submit / reconcile 모두 disabled 이고 증권사·저장소를 건드리지 않는다", async () => {
    const off = makeDeps(store, broker, { enabled: false });
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, off)).kind).toBe("disabled");
    expect((await submitOrder(CTX, {
      intentId: "x", approvalToken: "t", confirm: echoOf({ ticker: "360750", quantity: 1, limitPrice: 1, amount: 1, accountInstanceId: "a" }),
    }, off)).kind).toBe("disabled");
    expect((await reconcileOrder(CTX, "x", off)).kind).toBe("disabled");
    expect(broker.calls).toEqual({ quote: 0, buyingPower: 0, place: 0, inquire: 0 });
    expect(await store.listOpen(SCOPE)).toEqual([]);
  });
});

// ── 의도 생성 ───────────────────────────────────────────────────────────────

describe("prepare — 의도 생성 (주문하지 않는다)", () => {
  it("현재가를 지정가로 하는 의도를 만들고 승인 토큰을 발급한다", async () => {
    const r = await propose(deps);
    expect(r.intent).toMatchObject({
      state: "proposed", ticker: "360750", quantity: 1, limitPrice: 25_985, amount: 25_985,
      ordDvsn: "00", side: "buy", productCode: "22", accountInstanceId: "bai:kis-pension",
    });
    expect(r.approvalToken).toBe("token-1");
    expect(broker.calls.place).toBe(0);
  });

  it("**토큰 원문은 저장하지 않는다** (해시만)", async () => {
    const r = await propose(deps);
    const row = store.peek(SCOPE, r.intent.id)!;
    expect(JSON.stringify(row)).not.toContain(r.approvalToken);
    expect(row.approvalTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["허용되지 않은 종목", { ticker: "367380" }],
    ["수량 2주", { quantity: 2 }],
    ["수량 0", { quantity: 0 }],
    ["소수 수량", { quantity: 1.5 }],
  ])("정책 위반(%s)은 의도를 만들지 않는다", async (_n, over: { ticker?: string; quantity?: number }) => {
    const r = await prepareOrder(CTX, { ticker: over.ticker ?? "360750", quantity: over.quantity ?? 1 }, deps);
    expect(r.kind).toBe("policy_violation");
    expect(await store.listOpen(SCOPE)).toEqual([]);
  });

  it("건당 금액 상한을 넘으면 만들지 않는다", async () => {
    broker.price = ORDER_POLICY.maxOrderAmount + 1;
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("policy_violation");
  });

  it("현재가를 모르면 만들지 않는다", async () => {
    broker.price = null;
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("no_price");
  });

  it("매수가능금액이 확인되지 않으면 만들지 않는다", async () => {
    broker.bpOk = false;
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("buying_power_unverified");
  });

  it("매수가능금액이 모자라면 만들지 않는다", async () => {
    broker.bpAmount = 1_000;
    broker.bpQty = 0;
    const r = await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps);
    expect(r.kind).toBe("buying_power_insufficient");
  });

  it("**같은 의도를 다시 prepare 하면 새 토큰을 주고 이전 토큰은 무효가 된다**", async () => {
    const a = await propose(deps);
    const b = await propose(deps);
    expect(b.intent.id).toBe(a.intent.id);
    expect(b.approvalToken).not.toBe(a.approvalToken);
    const r = await submitOrder(CTX, {
      intentId: a.intent.id, approvalToken: a.approvalToken, confirm: echoOf(a.intent),
    }, deps);
    expect(r.kind).toBe("bad_token");
    expect(broker.calls.place).toBe(0);
  });
});

// ── 정상 ────────────────────────────────────────────────────────────────────

describe("submit — 정상: 접수와 체결을 구분한다", () => {
  it("접수되면 accepted 이고 **체결이 아니다**", async () => {
    const p = await propose(deps);
    const r = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    expect(r.kind).toBe("accepted");
    if (r.kind !== "accepted") return;
    expect(r.intent.state).toBe("accepted");
    expect(r.intent.orderNo).toBeTruthy();
    expect(r.intent.evidence).toBeNull();
    expect(ledgerEligibility(r.intent).eligible).toBe(false); // 접수만으로 원장 근거가 아니다
    expect(broker.placed).toEqual([{ ticker: "360750", quantity: 1, limitPrice: 25_985 }]);
  });

  it("체결조회가 체결을 확인해야만 filled 가 되고 그때 원장 자격이 생긴다", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);

    // 미체결
    clockMs += 5_000;
    const open = await reconcileOrder(CTX, p.intent.id, deps);
    expect(open.kind === "reconciled" && open.intent.state).toBe("open");
    expect(open.kind === "reconciled" && ledgerEligibility(open.intent).eligible).toBe(false);

    // 체결
    broker.fill(broker.book[0].orderNo, 1);
    clockMs += 5_000;
    const filled = await reconcileOrder(CTX, p.intent.id, deps);
    expect(filled.kind).toBe("reconciled");
    if (filled.kind !== "reconciled") return;
    expect(filled.intent.state).toBe("filled");
    expect(filled.intent.evidence).toMatchObject({ filledQty: 1, source: "inquire_daily_ccld", matchedBy: "order_no" });
    expect(ledgerEligibility(filled.intent)).toMatchObject({ eligible: true, filledQty: 1 });
    expect(broker.calls.place).toBe(1); // 조회는 주문을 보내지 않는다
  });
});

// ── 사전 검증 ───────────────────────────────────────────────────────────────

describe("submit — 주문 직전 검증이 막으면 **전송하지 않는다**", () => {
  const send = (p: Awaited<ReturnType<typeof propose>>, over: Partial<{ token: string; confirm: ConfirmEcho; ctx: OrderContext }> = {}) =>
    submitOrder(over.ctx ?? CTX, {
      intentId: p.intent.id, approvalToken: over.token ?? p.approvalToken, confirm: over.confirm ?? echoOf(p.intent),
    }, deps);

  it("틀린 토큰", async () => {
    const p = await propose(deps);
    expect((await send(p, { token: "wrong" })).kind).toBe("bad_token");
    expect(broker.calls.place).toBe(0);
    expect((await store.getById(SCOPE, p.intent.id))!.state).toBe("proposed");
  });

  it.each([
    ["ticker", { ticker: "367380" }],
    ["quantity", { quantity: 2 }],
    ["limitPrice", { limitPrice: 26_000 }],
    ["amount", { amount: 1 }],
    ["accountInstanceId", { accountInstanceId: "bai:other" }],
  ] as Array<[keyof ConfirmEcho, Partial<ConfirmEcho>]>)("확인 echo 불일치(%s)", async (field, patch) => {
    const p = await propose(deps);
    const r = await send(p, { confirm: { ...echoOf(p.intent), ...patch } });
    expect(r).toEqual({ kind: "confirm_mismatch", field });
    expect(broker.calls.place).toBe(0);
  });

  it("승인 기한이 지나면 만료되고 전송하지 않는다", async () => {
    const p = await propose(deps);
    clockMs += (ORDER_POLICY.approvalTtlSeconds + 1) * 1000;
    const r = await send(p);
    expect(r.kind).toBe("expired");
    expect(broker.calls.place).toBe(0);
    expect((await store.getById(SCOPE, p.intent.id))!.state).toBe("expired");
  });

  it("계좌 instance 가 바뀌었으면 전송하지 않는다", async () => {
    const p = await propose(deps);
    const r = await send(p, { ctx: { ...CTX, accountInstanceId: "bai:kis-pension-2" } });
    expect(r.kind).toBe("account_changed");
    expect(broker.calls.place).toBe(0);
  });

  it("시세가 의도 단가에서 크게 벗어나면 전송하지 않는다", async () => {
    const p = await propose(deps);
    broker.price = Math.round(25_985 * 1.05);
    const r = await send(p);
    expect(r.kind).toBe("price_drift");
    expect(broker.calls.place).toBe(0);
    // 의도는 그대로 승인 대기다(토큰이 소비되지 않았다)
    expect((await store.getById(SCOPE, p.intent.id))!.approvalConsumedAt).toBeNull();
  });

  it("허용 오차 안의 시세 변동은 통과한다", async () => {
    const p = await propose(deps);
    broker.price = 25_985 + 100;
    expect((await send(p)).kind).toBe("accepted");
  });

  it("시세를 알 수 없으면 전송하지 않는다", async () => {
    const p = await propose(deps);
    broker.price = null;
    expect((await send(p)).kind).toBe("price_unavailable");
    expect(broker.calls.place).toBe(0);
  });

  it("주문 직전 매수가능금액이 모자라면 전송하지 않는다", async () => {
    const p = await propose(deps);
    broker.bpAmount = 100;
    broker.bpQty = 0;
    expect((await send(p)).kind).toBe("buying_power_insufficient");
    expect(broker.calls.place).toBe(0);
  });

  it("주문 직전 매수가능금액을 **의도의 지정가로** 다시 조회한다", async () => {
    const p = await propose(deps);
    const before = broker.calls.buyingPower;
    await send(p);
    expect(broker.calls.buyingPower).toBe(before + 1);
  });

  it("저장소 쓰기가 실패하면 **전송하지 않는다**", async () => {
    const p = await propose(deps);
    store.failNextUpdate = true;
    const r = await send(p);
    expect(r.kind).toBe("store_error");
    expect(broker.calls.place).toBe(0);
  });

  it("다른 정책 위반(저장된 의도 변조)도 전송하지 않는다", async () => {
    const p = await propose(deps);
    // 저장소의 의도를 정책 밖으로 바꿔 놓은 상황을 모사한다.
    const row = store.peek(SCOPE, p.intent.id)!;
    const tampered = { ...row, quantity: 5, amount: 5 * row.limitPrice };
    (store as unknown as { rows: Map<string, unknown> }).rows.set(`${SCOPE.familyCode}|${SCOPE.profile}|${row.id}`, tampered);
    const r = await submitOrder(CTX, {
      intentId: row.id, approvalToken: p.approvalToken, confirm: echoOf(tampered),
    }, deps);
    expect(r.kind).toBe("policy_violation");
    expect(broker.calls.place).toBe(0);
  });
});

// ── 중복 ────────────────────────────────────────────────────────────────────

describe("중복 주문 차단", () => {
  it("**같은 승인으로 두 번 제출해도 한 번만 전송된다** (순차)", async () => {
    const p = await propose(deps);
    const body = { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) };
    const first = await submitOrder(CTX, body, deps);
    const second = await submitOrder(CTX, body, deps);
    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("already_processed");
    expect(broker.calls.place).toBe(1);
  });

  it("**동시에 두 요청이 와도 한 번만 전송된다** (낙관적 잠금)", async () => {
    const p = await propose(deps);
    const body = { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) };
    const [a, b] = await Promise.all([submitOrder(CTX, body, deps), submitOrder(CTX, body, deps)]);
    expect(broker.calls.place).toBe(1);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["accepted", "already_processed"]);
  });

  it("접수된 주문과 같은 주문을 다시 prepare 하면 duplicate 다", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    const again = await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps);
    expect(again.kind).toBe("duplicate");
  });

  it("다른 의도가 진행 중이면 새 의도를 만들지 않는다 (단가가 달라도)", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.price = 26_100; // 키가 달라진다
    const r = await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps);
    expect(r.kind).toBe("open_intent_exists");
  });

  it("체결까지 끝난 같은 주문도 같은 날 같은 키로는 다시 만들지 않는다", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.fill(broker.book[0].orderNo, 1);
    await reconcileOrder(CTX, p.intent.id, deps);
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("duplicate");
  });
});

// ── 거부 ────────────────────────────────────────────────────────────────────

describe("거부", () => {
  it("증권사가 명시적으로 거부하면 rejected 이고 **자동 재전송하지 않는다**", async () => {
    broker.placeMode = "reject";
    const p = await propose(deps);
    const r = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(r.intent.lastError).toContain("주문가능금액");
    expect(broker.calls.place).toBe(1);
    expect(broker.book).toHaveLength(0); // 거부는 장부에 남지 않았다
  });

  it("거부된 의도는 다시 prepare 하면 **새 시도(attempt 2)** 가 만들어진다", async () => {
    broker.placeMode = "reject";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.placeMode = "accept";
    const p2 = await propose(deps);
    expect(p2.intent.id).not.toBe(p.intent.id);
    expect(p2.intent.attempt).toBe(2);
    expect(p2.intent.idempotencyKey).not.toBe(p.intent.idempotencyKey);
  });

  it("거부된 의도의 옛 토큰으로는 아무것도 보내지 못한다", async () => {
    broker.placeMode = "reject";
    const p = await propose(deps);
    const body = { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) };
    await submitOrder(CTX, body, deps);
    const again = await submitOrder(CTX, body, deps);
    expect(again.kind).toBe("already_processed");
    expect(broker.calls.place).toBe(1);
  });
});

// ── 응답 불명 ───────────────────────────────────────────────────────────────

describe("응답 불명 — 재주문하지 않고 조회로 해소한다", () => {
  it.each(["timeout", "http500", "no_orderno", "throw"] as const)(
    "%s → unknown 이고 재전송하지 않는다", async (mode) => {
      broker.placeMode = mode;
      const p = await propose(deps);
      const r = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
      expect(r.kind).toBe("unknown");
      expect(broker.calls.place).toBe(1);
      // 같은 승인·같은 의도로 다시 보내려 해도 막힌다
      const again = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
      expect(again.kind).toBe("already_processed");
      // 새 의도도 만들 수 없다
      expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("duplicate");
      expect(broker.calls.place).toBe(1);
    },
  );

  it("**타임아웃 뒤 조건이 같은 행을 찾아도 후보일 뿐이다** (번호 채택·승격 없음)", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    clockMs += 5_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    expect(r.kind).toBe("reconciled");
    if (r.kind !== "reconciled") return;
    expect(r.verdict).toEqual({ kind: "candidate", count: 1 });
    expect(r.intent.state).toBe("unknown");
    expect(r.intent.orderNo).toBeNull();
    expect(r.intent.evidence).toBeNull();
    expect(r.intent.ambiguous).toBe(true);
    expect(r.intent.lastError).toContain("확인이 필요합니다");
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
    expect(broker.calls.place).toBe(1); // 자동 재주문 없음
  });

  it("**후보가 체결돼 보여도 체결로 승격하지 않는다** (executionConfirmed=false)", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.fill(broker.book[0].orderNo, 1);
    clockMs += 5_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.intent.state).toBe("unknown");
    expect(r.intent.evidence).toBeNull();
    expect(publicIntent(r.intent)).toMatchObject({
      executionConfirmed: false, ledgerEligible: false, needsUserConfirmation: true,
    });
  });

  it("**같은 종목·수량·가격의 수동매매가 겹쳐도 우리 주문의 체결로 오인하지 않는다**", async () => {
    broker.placeMode = "timeout";
    broker.book = []; // 우리 주문은 아직 조회에 반영되지 않았다
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.book = [];
    // 사용자가 증권사 앱에서 같은 종목·1주·같은 가격으로 직접 매수해 체결됐다.
    broker.book.push({
      orderNo: "0000007777", ticker: "360750", qty: 1, price: p.intent.limitPrice,
      filled: 1, cancelled: false, time: "140030",
    });
    clockMs += 10_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.intent.state).toBe("unknown");
    expect(r.intent.orderNo).toBeNull(); // 수동매매의 주문번호를 채택하지 않는다
    expect(r.intent.evidence).toBeNull();
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
    expect(publicIntent(r.intent).executionConfirmed).toBe(false);
    // 새 주문도, 자동 재주문도 없다
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("duplicate");
    expect(broker.calls.place).toBe(1);
  });

  it("전송 이전 시각의 같은 조건 행은 후보에서도 제외된다", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.book = [{
      orderNo: "0000001111", ticker: "360750", qty: 1, price: p.intent.limitPrice,
      filled: 1, cancelled: false, time: "091500",
    }];
    clockMs += 5_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.verdict.kind).toBe("not_found");
    expect(r.intent.ambiguous).toBe(false);
  });

  it("**조회에서 못 찾아도 거부로 단정하지 않는다** (unknown 유지)", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.book = []; // 반영 지연을 모사: 아직 조회에 안 보인다
    clockMs += 5_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.verdict.kind).toBe("not_found");
    expect(r.intent.state).toBe("unknown");
    expect(r.intent.lastError).toContain("주문이 없다는 뜻이 아닙니다");
    // 여전히 새 주문을 막는다
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("duplicate");
  });

  it("조회 자체가 실패하면 상태를 바꾸지 않는다", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.inquiryOk = false;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    expect(r.kind).toBe("inquiry_failed");
    expect((await store.getById(SCOPE, p.intent.id))!.state).toBe("unknown");
  });

  it("조건이 같은 후보가 여러 건이어도 확정하지 않고 확인 필요로 둔다", async () => {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.book.push({ ...broker.book[0], orderNo: "0000009999" });
    clockMs += 5_000;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.verdict).toEqual({ kind: "candidate", count: 2 });
    expect(r.intent.ambiguous).toBe(true);
    expect(r.intent.state).toBe("unknown");
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
  });

  it("수량 필드를 읽지 못하면 체결로 올리지 않는다", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.fill(broker.book[0].orderNo, 1);
    broker.hideQty = true;
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.verdict.kind).toBe("unreadable");
    expect(r.intent.state).toBe("accepted");
    expect(r.intent.evidence).toBeNull();
  });
});

// ── 부분체결 ────────────────────────────────────────────────────────────────

describe("부분체결", () => {
  /** 정책은 첫 주문을 1주로 막으므로, 부분체결은 저장소에 직접 시드한 의도로 재현한다. */
  async function seedAccepted(qty: number) {
    const now = new Date(clockMs).toISOString();
    await store.insert({
      id: "seed-1", scope: SCOPE, idempotencyKey: "ord:seed#1", attempt: 1,
      accountInstanceId: "bai:kis-pension", broker: "kis", productCode: "22", side: "buy",
      ticker: "360750", quantity: qty, limitPrice: 25_985, ordDvsn: "00", amount: qty * 25_985,
      buyingPowerAtProposal: null, state: "accepted", version: 0,
      approvalTokenHash: "x", approvalExpiresAt: now, approvalConsumedAt: now,
      submitStartedAt: now, orderNo: "0000000777", orderOrgNo: "91252", orderTime: "090501",
      evidence: null, lastInquiryAt: null, ambiguous: false, lastError: null,
      createdAt: now, updatedAt: now, policyVersion: 1,
    });
    broker.book.push({ orderNo: "0000000777", ticker: "360750", qty, price: 25_985, filled: 0, cancelled: false, time: "090501" });
  }

  it("일부 체결은 partially_filled 이고 체결 수량이 증거다", async () => {
    await seedAccepted(10);
    broker.fill("0000000777", 4);
    const r = await reconcileOrder(CTX, "seed-1", deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.intent.state).toBe("partially_filled");
    expect(r.intent.evidence).toMatchObject({ filledQty: 4, matchedBy: "order_no" });
    // 체결된 만큼만 원장 후보다
    expect(ledgerEligibility(r.intent)).toMatchObject({ eligible: true, filledQty: 4 });
  });

  it("부분체결 뒤 더 체결되면 전량 체결로 간다", async () => {
    await seedAccepted(10);
    broker.fill("0000000777", 4);
    await reconcileOrder(CTX, "seed-1", deps);
    broker.fill("0000000777", 10);
    const r = await reconcileOrder(CTX, "seed-1", deps);
    if (r.kind !== "reconciled") throw new Error("reconciled");
    expect(r.intent.state).toBe("filled");
    expect(r.intent.evidence!.filledQty).toBe(10);
  });

  it("체결 수량이 줄어드는 응답으로 상태가 뒤로 가지 않는다", async () => {
    await seedAccepted(10);
    broker.fill("0000000777", 10);
    await reconcileOrder(CTX, "seed-1", deps);
    broker.fill("0000000777", 3);
    const r = await reconcileOrder(CTX, "seed-1", deps);
    // filled 는 종결 상태라 더 이상 조회로 바뀌지 않는다
    expect(r.kind).toBe("nothing_to_reconcile");
    expect((await store.getById(SCOPE, "seed-1"))!.state).toBe("filled");
  });
});

// ── 재시작 복구 ─────────────────────────────────────────────────────────────

describe("재시작 복구 — 의도는 저장소에 남는다", () => {
  it("**서비스 객체를 새로 만들어도(재시작) 접수된 주문을 다시 보내지 않는다**", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);

    // 프로세스 재시작: 같은 저장소, 새 의존성 객체
    const broker2 = new FakeBroker();
    broker2.book = broker.book;
    const restarted = makeDeps(store, broker2);

    const again = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, restarted);
    expect(again.kind).toBe("already_processed");
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, restarted)).kind).toBe("duplicate");
    expect(broker2.calls.place).toBe(0);
  });

  it("**결과 저장이 실패해 submitting 으로 남아도 재시작 후 조회로 해소한다**", async () => {
    const p = await propose(deps);
    // 전송은 성공하지만, 그 결과를 저장하는 쓰기가 실패한다(전송 직후 프로세스 종료를 모사).
    broker.onPlace = () => { store.failNextUpdate = true; };
    const r = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.recorded).toBe(false);
    expect((await store.getById(SCOPE, p.intent.id))!.state).toBe("submitting");
    expect(broker.calls.place).toBe(1);

    // 재시작 직후(아직 stale 이 아니다): 전송 중일 수 있으니 판정하지 않는다
    const broker2 = new FakeBroker();
    broker2.book = broker.book;
    const restarted = makeDeps(store, broker2);
    const early = await reconcileOrder(CTX, p.intent.id, restarted);
    expect(early.kind).toBe("in_flight");
    expect(broker2.calls.inquire).toBe(0);

    // 시간이 지나 stale 이 되면 조회로 해소한다
    clockMs += (ORDER_POLICY.submittingStaleSeconds + 1) * 1000;
    const late = await reconcileOrder(CTX, p.intent.id, restarted);
    if (late.kind !== "reconciled") throw new Error("reconciled");
    // 주문번호가 없으므로 조건이 같은 행이 있어도 후보일 뿐이다 — unknown 유지, 확인 필요.
    expect(late.intent.state).toBe("unknown");
    expect(late.intent.orderNo).toBeNull();
    expect(late.intent.ambiguous).toBe(true);
    expect(broker2.calls.place).toBe(0); // 해소 과정에서 주문을 보내지 않았다
  });

  it("submitting 상태에서 새 주문을 만들거나 다시 제출할 수 없다", async () => {
    const p = await propose(deps);
    broker.onPlace = () => { store.failNextUpdate = true; };
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    const restarted = makeDeps(store, new FakeBroker());
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, restarted)).kind).toBe("duplicate");
    const again = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, restarted);
    expect(again.kind).toBe("already_processed");
  });

  it("승인 전 의도(proposed)도 재시작 후 남아 있고 기한이 지나면 만료된다", async () => {
    const p = await propose(deps);
    const restarted = makeDeps(store, new FakeBroker());
    clockMs += (ORDER_POLICY.approvalTtlSeconds + 5) * 1000;
    const r = await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, restarted);
    expect(r.kind).toBe("expired");
  });
});

// ── 소유 범위 ───────────────────────────────────────────────────────────────

describe("의도는 가족·프로필 범위에 갇힌다", () => {
  it("다른 프로필은 남의 의도를 조회·제출할 수 없다", async () => {
    const p = await propose(deps);
    const other: OrderContext = { scope: { familyCode: "soye", profile: "dayoung" }, accountInstanceId: "bai:kis-pension" };
    expect((await submitOrder(other, {
      intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent),
    }, deps)).kind).toBe("not_found");
    expect((await reconcileOrder(other, p.intent.id, deps)).kind).toBe("not_found");
    expect(broker.calls.place).toBe(0);
  });

  it("다른 가족의 같은 프로필명도 접근할 수 없다", async () => {
    const p = await propose(deps);
    const other: OrderContext = { scope: { familyCode: "otherfam", profile: "hyeobi" }, accountInstanceId: "bai:kis-pension" };
    expect((await submitOrder(other, {
      intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent),
    }, deps)).kind).toBe("not_found");
  });
});

// ── 수동 해소 ───────────────────────────────────────────────────────────────

describe("수동 해소 — 증권사 조회 근거로만, 식별이 불충분하면 확정하지 않는다", () => {
  const NOTE = "증권사 앱 주문내역에서 확인함";
  async function lostOrder() {
    broker.placeMode = "timeout";
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    clockMs += 5_000;
    return p.intent.id;
  }
  const link = (id: string, orderNo: string, over: Partial<ResolveInput> = {}) =>
    resolveOrder(CTX, { intentId: id, action: "link_order_no", orderNo, note: NOTE, confirmIntentId: id, actor: "hyeobi", ...over }, deps);
  // 미접수 정리는 서버 flag 가 켜진 경우만 동작한다 — 아래 정리 규칙 테스트는 flag ON 으로 돈다.
  const dismiss = (id: string, over: Partial<ResolveInput> = {}) =>
    resolveOrder(CTX, { intentId: id, action: "dismiss_not_found", note: NOTE, confirmIntentId: id, actor: "hyeobi", ...over }, { ...deps, dismissEnabled: true });
  const nextDay = () => { clockMs += 24 * 3_600_000; };
  const limitOf = async (id: string) => (await store.getById(SCOPE, id))!.limitPrice;

  it("flag OFF 면 disabled 이고 아무 것도 호출하지 않는다", async () => {
    const id = await lostOrder();
    const inq = broker.calls.inquire;
    const r = await resolveOrder(CTX, { intentId: id, action: "dismiss_not_found", note: NOTE, confirmIntentId: id, actor: "x" },
      makeDeps(store, broker, { enabled: false }));
    expect(r.kind).toBe("disabled");
    expect(broker.calls.inquire).toBe(inq);
  });

  // ── 1. 주문번호 연결 ──────────────────────────────────────────────────────

  it("**주문 당일에는 연결하지 않는다** (늦게 조회되는 앱 주문이 있을 수 있다)", async () => {
    const id = await lostOrder();
    const r = await link(id, broker.book[0].orderNo);
    expect(r.kind).toBe("insufficient_evidence");
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
    expect(store.resolutions).toHaveLength(0);
  });

  it("다음 날, 조건이 같은 주문이 기간 전체에서 1건이고 그 번호면 연결한다 — **단 체결 확정·원장 근거는 아니다**", async () => {
    const id = await lostOrder();
    const orderNo = broker.book[0].orderNo;
    broker.fill(orderNo, 1);
    nextDay();
    const r = await link(id, orderNo.replace(/^0+/, ""));
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.intent).toMatchObject({ state: "filled", orderNo, orderNoSource: "user_linked", ambiguous: true });
    expect(r.intent.evidence).toMatchObject({ filledQty: 1, matchedBy: "user_linked" });
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
    expect(publicIntent(r.intent)).toMatchObject({
      executionConfirmed: false, ledgerEligible: false, needsUserConfirmation: true, orderNoSource: "user_linked",
    });
    expect(store.resolutions[0]).toMatchObject({
      action: "link_order_no", actor: "hyeobi", note: NOTE, prevState: "unknown", newState: "filled",
      evidence: { identification: "user_linked_not_confirmed", sameConditionRows: 1, complete: true },
    });
    expect(broker.calls.place).toBe(1);
  });

  it("연결 뒤 상태 조회를 해도 **응답 번호로 승격되지 않는다**(user_linked 유지)", async () => {
    const id = await lostOrder();
    const orderNo = broker.book[0].orderNo;
    nextDay();
    await link(id, orderNo);
    broker.fill(orderNo, 1);
    const r = await reconcileOrder(CTX, id, deps);
    if (r.kind !== "reconciled") throw new Error(r.kind);
    expect(r.intent.state).toBe("filled");
    expect(r.intent.evidence!.matchedBy).toBe("user_linked");
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
    expect(publicIntent(r.intent).executionConfirmed).toBe(false);
  });

  it("**같은 조건의 수동매매가 겹쳐 2건이면 어느 번호도 연결하지 않는다**", async () => {
    const id = await lostOrder();
    broker.book.push({ orderNo: "0000005555", ticker: "360750", qty: 1, price: await limitOf(id), filled: 1, cancelled: false, time: "140100" });
    nextDay();
    for (const n of [broker.book[0].orderNo, "5555"]) {
      const r = await link(id, n);
      expect(r.kind).toBe("insufficient_evidence");
    }
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
  });

  it("**전송 이전 시각의 같은 조건 주문은 연결하지 않는다** (앱 주문이 아예 없던 경우)", async () => {
    const id = await lostOrder();
    broker.book = [{ orderNo: "0000004444", ticker: "360750", qty: 1, price: await limitOf(id), filled: 1, cancelled: false, time: "091500" }];
    nextDay();
    expect((await link(id, "4444")).kind).toBe("insufficient_evidence");
  });

  it("입력 번호가 조건이 같은 유일한 주문과 다르면 연결하지 않는다", async () => {
    const id = await lostOrder();
    broker.book.push({ orderNo: "0000006666", ticker: "360750", qty: 1, price: 25_000, filled: 1, cancelled: false, time: "140100" });
    nextDay();
    expect((await link(id, "6666")).kind).toBe("insufficient_evidence"); // 가격이 다른 수동매매
  });

  it("다음 날로 넘어간 주문(주문일 이후 날짜)은 기간 조회로 찾아 연결할 수 있다", async () => {
    const id = await lostOrder();
    broker.book[0].date = "20261015";
    broker.book[0].time = "090000";
    nextDay();
    const r = await link(id, broker.book[0].orderNo);
    expect(r.kind).toBe("resolved");
  });

  it("주문일을 알 수 없는 행은 연결 근거가 아니다", async () => {
    const id = await lostOrder();
    broker.book[0].date = "";
    nextDay();
    expect((await link(id, broker.book[0].orderNo)).kind).toBe("insufficient_evidence");
  });

  it("다른 의도에 이미 붙은 번호는 연결하지 않는다", async () => {
    const p1 = await propose(deps);
    await submitOrder(CTX, { intentId: p1.intent.id, approvalToken: p1.approvalToken, confirm: echoOf(p1.intent) }, deps);
    const used = (await store.getById(SCOPE, p1.intent.id))!;
    await store.insert({ ...used, id: "lost-2", idempotencyKey: "ord:other#1", state: "unknown", orderNo: null, orderNoSource: null, version: 0 });
    expect((await link("lost-2", used.orderNo!)).kind).toBe("order_no_in_use");
  });

  // ── 2. 미접수 정리 ────────────────────────────────────────────────────────

  it("미접수 정리는 **주문 당일에는 불가**", async () => {
    const id = await lostOrder();
    broker.book = [];
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
  });

  it("**다음 날이라도 조건이 같은 주문이 조회되면 정리하지 않는다**", async () => {
    const id = await lostOrder();
    nextDay();
    const r = await dismiss(id);
    expect(r.kind).toBe("insufficient_evidence");
  });

  it("**취소된 같은 조건 주문도 '있음'으로 본다**(정리하지 않는다)", async () => {
    const id = await lostOrder();
    broker.book[0].cancelled = true;
    nextDay();
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
  });

  it("**다음 날로 넘어가 접수된 주문도 기간 조회로 잡아 정리하지 않는다**", async () => {
    const id = await lostOrder();
    broker.book[0].date = "20261015";
    nextDay();
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
  });

  it("조회 기간은 주문일~오늘이다", async () => {
    const id = await lostOrder();
    broker.book = [];
    nextDay();
    const seen: Array<{ date: string; endDate?: string; orderNo: string | null }> = [];
    const orig = broker.inquire.bind(broker);
    broker.inquire = async (q) => { seen.push(q); return orig(q); };
    await dismiss(id);
    expect(seen.at(-1)).toMatchObject({ date: "20261014", endDate: "20261015", orderNo: null });
  });

  it.each([
    ["다음 페이지 신호", (b: FakeBroker) => { b.more = true; }],
    ["목록(output1) 없음", (b: FakeBroker) => { b.noList = true; }],
  ])("**%s 이면 0건이어도 정리하지 않는다** (모름 ≠ 없음)", async (_n, setup) => {
    const id = await lostOrder();
    broker.book = [];
    setup(broker);
    nextDay();
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
  });

  it("수량을 읽지 못하는 같은 종목 행이 있으면 정리하지 않는다", async () => {
    const id = await lostOrder();
    broker.book = [{ orderNo: "0000003333", ticker: "360750", qty: 2, price: 1, filled: 0, cancelled: false, time: "100000" }];
    broker.hideQty = true;
    nextDay();
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
  });

  it("체결조회 기간(90일)을 넘은 주문은 정리하지 않는다", async () => {
    const id = await lostOrder();
    broker.book = [];
    clockMs += 100 * 24 * 3_600_000;
    expect((await dismiss(id)).kind).toBe("insufficient_evidence");
  });

  it("완전한 조회에서 같은 조건 0건일 때만 dismissed + 감사 기록, 그 뒤에야 사용자가 다시 준비할 수 있다", async () => {
    const id = await lostOrder();
    broker.book = [];
    nextDay();
    const r = await dismiss(id);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.intent).toMatchObject({ state: "dismissed", orderNo: null, evidence: null });
    expect(ledgerEligibility(r.intent).eligible).toBe(false);
    expect(store.resolutions[0]).toMatchObject({
      action: "dismiss_not_found", prevState: "unknown", newState: "dismissed",
      evidence: { complete: true, inquiryFrom: "2026-10-14", inquiryTo: "2026-10-15", sameConditionRows: 0 },
    });
    expect(broker.calls.place).toBe(1);
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).toBe("proposed");
    expect(broker.calls.place).toBe(1);
  });

  it("조회 실패면 inquiry_failed 이고 아무 것도 쓰지 않는다", async () => {
    const id = await lostOrder();
    broker.inquiryOk = false;
    nextDay();
    expect((await dismiss(id)).kind).toBe("inquiry_failed");
    expect(store.resolutions).toHaveLength(0);
  });

  // ── 미접수 정리 flag ─────────────────────────────────────────────────────

  it("**flag 기본 OFF: 미접수 정리 직접 요청은 거부되고 조회·저장·감사 모두 없다**", async () => {
    const id = await lostOrder();
    broker.book = [];
    nextDay();
    const inq = broker.calls.inquire;
    const r = await resolveOrder(CTX, { intentId: id, action: "dismiss_not_found", note: NOTE, confirmIntentId: id, actor: "hyeobi" }, deps);
    expect(r.kind).toBe("dismiss_disabled");
    expect(broker.calls.inquire).toBe(inq);
    expect(store.resolutions).toHaveLength(0);
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
    // 잠금도 그대로: 새 주문을 만들 수 없다
    expect((await prepareOrder(CTX, { ticker: "360750", quantity: 1 }, deps)).kind).not.toBe("proposed");
  });

  it("flag OFF 여도 주문번호 연결은 그대로 동작한다", async () => {
    const id = await lostOrder();
    nextDay();
    const r = await link(id, broker.book[0].orderNo);
    expect(r.kind).toBe("resolved");
  });

  it("flag OFF 여도 상태 조회(reconcile)는 그대로 동작한다", async () => {
    const id = await lostOrder();
    clockMs += 5_000;
    expect((await reconcileOrder(CTX, id, deps)).kind).toBe("reconciled");
  });

  // ── 공통 ──────────────────────────────────────────────────────────────────

  it("해소 대상이 아닌 상태(접수됨)는 거절한다", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    expect((await dismiss(p.intent.id)).kind).toBe("not_resolvable");
  });

  it("아직 전송 중일 수 있는 submitting 은 거절하고, 오래되면(다음 날) 허용한다", async () => {
    const p = await propose(deps);
    broker.onPlace = () => { store.failNextUpdate = true; };
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    expect((await link(p.intent.id, broker.book[0].orderNo)).kind).toBe("not_resolvable");
    nextDay();
    const r = await link(p.intent.id, broker.book[0].orderNo);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(store.resolutions[0].prevState).toBe("submitting");
  });

  it.each([
    ["근거가 짧다", { note: "확인" }],
    ["확인한 의도 id 가 다르다", { confirmIntentId: "other" }],
    ["번호 형식 오류", { orderNo: "12a4" }],
  ])("입력 오류(%s)는 조회하지 않고 거절한다", async (_n, over) => {
    const id = await lostOrder();
    const inq = broker.calls.inquire;
    const r = await link(id, (over as { orderNo?: string }).orderNo ?? broker.book[0].orderNo, over as Partial<ResolveInput>);
    expect(r.kind).toBe("bad_input");
    expect(broker.calls.inquire).toBe(inq);
  });

  it("저장 실패면 store_error 이고 감사 행도 남지 않는다(원자성)", async () => {
    const id = await lostOrder();
    nextDay();
    store.failNextUpdate = true;
    expect((await link(id, broker.book[0].orderNo)).kind).toBe("store_error");
    expect(store.resolutions).toHaveLength(0);
    expect((await store.getById(SCOPE, id))!.state).toBe("unknown");
  });

  it("**동시 해소 요청은 하나만 반영된다**", async () => {
    const id = await lostOrder();
    nextDay();
    const no = broker.book[0].orderNo;
    const [a, b] = await Promise.all([link(id, no), link(id, no)]);
    expect([a.kind, b.kind].sort()).toEqual(["resolved", "stale"]);
    expect(store.resolutions).toHaveLength(1);
  });

  it("다른 프로필은 남의 의도를 해소할 수 없다", async () => {
    const id = await lostOrder();
    const other: OrderContext = { scope: { familyCode: "soye", profile: "dayoung" }, accountInstanceId: CTX.accountInstanceId };
    const r = await resolveOrder(other, { intentId: id, action: "dismiss_not_found", note: NOTE, confirmIntentId: id, actor: "dayoung" }, { ...deps, dismissEnabled: true });
    expect(r.kind).toBe("not_found");
  });

  it("정상 접수 주문은 응답 번호 출처로 기록되고 체결 시 확정된다(비교 기준)", async () => {
    const p = await propose(deps);
    await submitOrder(CTX, { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: echoOf(p.intent) }, deps);
    broker.fill(broker.book[0].orderNo, 1);
    const r = await reconcileOrder(CTX, p.intent.id, deps);
    if (r.kind !== "reconciled") throw new Error(r.kind);
    expect(r.intent.orderNoSource).toBe("broker_response");
    expect(publicIntent(r.intent).executionConfirmed).toBe(true);
    expect(ledgerEligibility(r.intent).eligible).toBe(true);
  });
});
