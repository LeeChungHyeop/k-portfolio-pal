/**
 * 주문 HTTP 핸들러: 문(flag → 세션 → 소유권 → 계좌 registry) 순서와 응답 매핑.
 * 증권사·저장소는 전부 가짜다. 실제 네트워크·DB 를 쓰지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryOrderStore } from "./order-store";
import type { BrokerPort } from "./order-service";
import type { BuyingPowerResult } from "./kis-buying-power";
import type { BrokerAccountInstance } from "./broker-account";

const mocks = vi.hoisted(() => ({
  session: null as null | { code: string; profile: string },
  dbReads: 0,
}));

vi.mock("./data-server", async (orig) => {
  const actual = await orig<typeof import("./data-server")>();
  return {
    ...actual,
    requireSession: async () => mocks.session,
    serviceClient: () => {
      mocks.dbReads += 1;
      return null;
    },
  };
});

const { handleOrderPrepare, handleOrderSubmit, handleOrderStatus, publicIntent } = await import("./order-handlers");

const PENSION: BrokerAccountInstance = {
  id: "bai:kis-pension", label: "한국투자 연금저축", broker: "kis", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-01-01", connectionMode: "api_readonly",
};
const CALC_ONLY = { ...PENSION, connectionMode: "calc_only" };

const ENV_ON = {
  SESSION_SECRET: "s", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
  KIS_ACCOUNT_OWNER_FAMILY_CODE: "soye", KIS_ACCOUNT_OWNER_PROFILE: "hyeobi",
  KIS_APP_KEY: "test-app-key-0123456789", KIS_APP_SECRET: "test-app-secret-abcdefghij",
  KIS_ACCOUNT_CANO: "12345678", KIS_ORDER_ENABLED: "on",
};
const OWNER = { code: "soye", profile: "hyeobi" };

function fakeBroker() {
  const calls = { quote: 0, bp: 0, place: 0, inquire: 0 };
  const broker: BrokerPort = {
    quote: async () => { calls.quote += 1; return { price: 25_985, asOf: "t" }; },
    buyingPower: async (ticker, unitPrice): Promise<BuyingPowerResult> => {
      calls.bp += 1;
      return {
        ok: true, httpStatus: 200, rtCd: "0", ticker, unitPrice, ordDvsn: "00", ordPsblCash: 2_000_000,
        nrcvbBuyAmt: 2_000_000, nrcvbBuyQty: 70, maxBuyAmt: 2_000_000, maxBuyQty: 70,
        psblQtyCalcUnpr: unitPrice, ruseAmt: 0,
      };
    },
    place: async () => { calls.place += 1; return { sent: true, httpStatus: 200, rtCd: "0", orderNo: "0000000001" }; },
    inquire: async () => { calls.inquire += 1; return { ok: true, rows: [], hasMore: false }; },
  };
  return { broker, calls };
}

const post = (path: string, body: unknown) =>
  new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body) });

let store: InMemoryOrderStore;
let fb: ReturnType<typeof fakeBroker>;
let n = 0;
const ov = () => ({
  store, broker: fb.broker, now: () => new Date("2026-10-14T05:00:00.000Z"),
  newId: () => `id-${++n}`, newToken: () => `tok-${n}-${Math.random()}`,
});

beforeEach(() => {
  mocks.session = OWNER;
  mocks.dbReads = 0;
  store = new InMemoryOrderStore();
  fb = fakeBroker();
  n = 0;
});

describe("문 순서", () => {
  it("flag 가 꺼져 있으면(기본) 403 이고 아무 것도 건드리지 않는다", async () => {
    const env = { ...ENV_ON, KIS_ORDER_ENABLED: undefined };
    for (const v of [undefined, "", "off", "true", "1", "ON"]) {
      const e = { ...env, KIS_ORDER_ENABLED: v };
      const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), e, ov(), [PENSION]);
      expect(r.status).toBe(403);
    }
    expect(fb.calls).toEqual({ quote: 0, bp: 0, place: 0, inquire: 0 });
    expect(mocks.dbReads).toBe(0);
  });

  it("세션이 없으면 401", async () => {
    mocks.session = null;
    const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), ENV_ON, ov(), [PENSION]);
    expect(r.status).toBe(401);
    expect(fb.calls.quote).toBe(0);
  });

  it.each([
    ["다른 가족", { code: "other", profile: "hyeobi" }],
    ["같은 가족의 다른 프로필", { code: "soye", profile: "dayoung" }],
  ])("%s 는 403 이고 시세·증권사를 호출하지 않는다", async (_n, session) => {
    mocks.session = session;
    const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), ENV_ON, ov(), [PENSION]);
    expect(r.status).toBe(403);
    expect(fb.calls).toEqual({ quote: 0, bp: 0, place: 0, inquire: 0 });
  });

  it("소유자 설정이 없으면 전원 403", async () => {
    const env = { ...ENV_ON, KIS_ACCOUNT_OWNER_FAMILY_CODE: undefined, KIS_ACCOUNT_OWNER_PROFILE: undefined };
    const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), env, ov(), [PENSION]);
    expect(r.status).toBe(403);
  });

  it.each([
    ["계좌 미등록", []],
    ["계산만 제공", [CALC_ONLY]],
  ])("%s 이면 409 account_not_ready", async (_n, registry) => {
    const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), ENV_ON, ov(), registry);
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toBe("account_not_ready");
    expect(fb.calls.quote).toBe(0);
  });
});

describe("흐름과 응답", () => {
  async function prepared() {
    const r = await handleOrderPrepare(post("/p", { ticker: "360750", quantity: 1 }), ENV_ON, ov(), [PENSION]);
    expect(r.status).toBe(200);
    return (await r.json()) as {
      intent: { id: string }; approvalToken: string; confirm: Record<string, unknown>;
    };
  }

  it("prepare → submit(접수) → status(체결 미확인) 에서 접수는 체결이 아니다", async () => {
    const p = await prepared();
    expect(fb.calls.place).toBe(0);
    const s = await handleOrderSubmit(
      post("/s", { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: p.confirm }),
      ENV_ON, ov(), [PENSION],
    );
    expect(s.status).toBe(200);
    const sb = await s.json() as { outcome: string; executionConfirmed: boolean; intent: { ledgerEligible: boolean } };
    expect(sb).toMatchObject({ outcome: "accepted", executionConfirmed: false });
    expect(sb.intent.ledgerEligible).toBe(false);
    expect(fb.calls.place).toBe(1);

    const st = await handleOrderStatus(new Request(`https://x/st?intentId=${p.intent.id}`), ENV_ON, ov(), [PENSION]);
    expect(st.status).toBe(200);
    expect(fb.calls.place).toBe(1);
  });

  it("응답에 승인 토큰 해시·계좌번호·키가 없다", async () => {
    const p = await prepared();
    const text = JSON.stringify(p);
    expect(text).not.toContain("approvalTokenHash");
    expect(text).not.toContain(ENV_ON.KIS_ACCOUNT_CANO);
    expect(text).not.toContain(ENV_ON.KIS_APP_KEY);
    expect(text).not.toContain(ENV_ON.KIS_APP_SECRET);
    const row = store.peek({ familyCode: "soye", profile: "hyeobi" }, p.intent.id)!;
    expect(JSON.stringify(publicIntent(row))).not.toContain(row.approvalTokenHash);
  });

  it("같은 제출을 두 번 보내면 두 번째는 409 이고 증권사는 한 번만 호출된다", async () => {
    const p = await prepared();
    const body = { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: p.confirm };
    const a = await handleOrderSubmit(post("/s", body), ENV_ON, ov(), [PENSION]);
    const b = await handleOrderSubmit(post("/s", body), ENV_ON, ov(), [PENSION]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(fb.calls.place).toBe(1);
  });

  it("응답 불명은 202 이고 재주문을 하지 말라고 알린다", async () => {
    fb.broker.place = async () => {
      fb.calls.place += 1;
      return { sent: true, httpStatus: 0, transportError: "aborted", timedOut: true };
    };
    const p = await prepared();
    const s = await handleOrderSubmit(
      post("/s", { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: p.confirm }),
      ENV_ON, ov(), [PENSION],
    );
    expect(s.status).toBe(202);
    const b = await s.json() as { outcome: string; message: string };
    expect(b.outcome).toBe("unknown");
    expect(b.message).toContain("다시 주문하지 말고");
  });

  it("거부는 422", async () => {
    fb.broker.place = async () => ({ sent: true, httpStatus: 200, rtCd: "1", msgCd: "E", msg1: "거부" });
    const p = await prepared();
    const s = await handleOrderSubmit(
      post("/s", { intentId: p.intent.id, approvalToken: p.approvalToken, confirm: p.confirm }),
      ENV_ON, ov(), [PENSION],
    );
    expect(s.status).toBe(422);
  });

  it("정책 밖 요청은 422, 형식 오류는 400", async () => {
    const a = await handleOrderPrepare(post("/p", { ticker: "367380", quantity: 1 }), ENV_ON, ov(), [PENSION]);
    expect(a.status).toBe(422);
    const b = await handleOrderPrepare(post("/p", { ticker: "360750" }), ENV_ON, ov(), [PENSION]);
    expect(b.status).toBe(400);
  });
});

describe("소스 불변식", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("주문 POST 는 kis-order.ts 한 곳에만 있다", () => {
    for (const f of ["./order-service.ts", "./order-handlers.ts", "./order-intent.ts", "./order-store.ts"]) {
      expect(strip(read(f))).not.toMatch(/method:\s*"POST"/);
    }
    expect(strip(read("./kis-order.ts"))).toMatch(/method:\s*"POST"/);
  });

  it("주문 모듈은 console 을 쓰지 않는다 (민감정보 로그 금지)", () => {
    for (const f of ["./order-service.ts", "./order-handlers.ts", "./order-intent.ts", "./order-store.ts", "./kis-order.ts"]) {
      expect(strip(read(f))).not.toMatch(/console\./);
    }
  });

  it("flag 는 정확히 on 일 때만 켜진다 (기본 OFF)", () => {
    expect(read("./order-handlers.ts")).toMatch(/KIS_ORDER_ENABLED === "on"/);
  });

  it("22 주문 지원은 여전히 unverified 다", async () => {
    const { KIS_ORDER_SUPPORT } = await import("./kis-account-observe");
    expect(JSON.stringify(KIS_ORDER_SUPPORT)).toContain("unverified");
  });

  it("order-service 는 원장 모듈을 가져오지 않는다 (체결 증거 전 원장 금지)", () => {
    for (const f of ["./order-service.ts", "./order-handlers.ts", "./order-intent.ts"]) {
      expect(read(f)).not.toMatch(/from "\.\/ledger/);
    }
  });
});
