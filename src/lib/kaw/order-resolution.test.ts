/**
 * 수동 해소의 저장소·migration 009·핸들러·클라이언트·mock 격리를 고정한다.
 * (서비스 흐름은 order-service.test.ts 의 "수동 해소" 블록)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { InMemoryOrderStore } from "./order-store";
import { normalizeOrderNo, type OrderIntent, type OrderResolutionRecord } from "./order-intent";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");
const stripSql = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SCOPE = { familyCode: "fam", profile: "me" };
const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  id: "i1", scope: SCOPE, idempotencyKey: "k#1", attempt: 1, accountInstanceId: "bai:x", broker: "kis",
  productCode: "22", side: "buy", ticker: "360750", quantity: 1, limitPrice: 20_000, ordDvsn: "00",
  amount: 20_000, buyingPowerAtProposal: null, state: "unknown", version: 3,
  approvalTokenHash: "h", approvalExpiresAt: "2026-10-14T05:02:00.000Z", approvalConsumedAt: "2026-10-14T05:00:00.000Z",
  submitStartedAt: "2026-10-14T05:00:00.000Z", orderNo: null, orderOrgNo: null, orderTime: null, evidence: null,
  lastInquiryAt: null, ambiguous: true, lastError: null,
  createdAt: "2026-10-14T05:00:00.000Z", updatedAt: "2026-10-14T05:00:00.000Z", policyVersion: 1, ...o,
});
const record = (o: Partial<OrderResolutionRecord> = {}): OrderResolutionRecord => ({
  id: "r1", scope: SCOPE, intentId: "i1", action: "dismiss_not_found", actor: "me", note: "확인했습니다",
  decidedAt: "2026-10-15T01:00:00.000Z", prevState: "unknown", newState: "dismissed", prevVersion: 3,
  evidence: { source: "inquire_daily_ccld" }, ...o,
});

// ── 저장소 ──────────────────────────────────────────────────────────────────

describe("InMemoryOrderStore.resolve — 의도 갱신과 감사 행이 함께", () => {
  it("성공하면 version 이 오르고 감사 행이 1건 남는다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(intent());
    const r = await s.resolve(SCOPE, "i1", 3, { state: "dismissed" }, record(), "t");
    expect(r.ok).toBe(true);
    expect((await s.getById(SCOPE, "i1"))!.version).toBe(4);
    expect(s.resolutions).toHaveLength(1);
  });
  it("낡은 version 이면 아무 것도 쓰지 않는다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(intent());
    expect((await s.resolve(SCOPE, "i1", 2, { state: "dismissed" }, record(), "t")).ok).toBe(false);
    expect(s.resolutions).toHaveLength(0);
  });
  it("해소 대상 상태가 아니면(accepted) 쓰지 않는다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(intent({ state: "accepted", orderNo: "0000000001" }));
    expect((await s.resolve(SCOPE, "i1", 3, { state: "open" }, record(), "t"))).toMatchObject({ ok: false, reason: "stale" });
    expect(s.resolutions).toHaveLength(0);
  });
  it("다른 의도의 주문번호를 붙이려 하면 쓰지 않는다", async () => {
    const s = new InMemoryOrderStore();
    await s.insert(intent({ id: "other", idempotencyKey: "k2#1", state: "accepted", orderNo: "0000000009" }));
    await s.insert(intent());
    const r = await s.resolve(SCOPE, "i1", 3, { state: "open", orderNo: "0000000009" }, record({ action: "link_order_no", newState: "open" }), "t");
    expect(r.ok).toBe(false);
    expect(s.resolutions).toHaveLength(0);
  });
});

describe("normalizeOrderNo", () => {
  it("숫자 1~10자리를 10자리로 맞추고 나머지는 null", () => {
    expect(normalizeOrderNo("777")).toBe("0000000777");
    expect(normalizeOrderNo(" 0000000777 ")).toBe("0000000777");
    for (const v of ["", "0", "0000", "12a", "12345678901", null, 777]) expect(normalizeOrderNo(v)).toBeNull();
  });
});

// ── migration 009 ───────────────────────────────────────────────────────────

describe("009_order_resolution.sql", () => {
  const sql = read("../../../migrations/009_order_resolution.sql");
  const live = stripSql(sql);

  it("dismissed 상태와 '주문번호·증거 없음' 제약을 추가한다", () => {
    expect(live).toMatch(/'expired','dismissed'/);
    expect(live).toMatch(/state <> 'dismissed' or \(order_no is null and evidence is null\)/);
  });

  it("감사 테이블은 추가만: revoke 후 select/insert 만, update/delete 없음", () => {
    expect(live).toMatch(/create table if not exists public\.kaw_order_resolution/);
    const revoke = live.indexOf("revoke all on public.kaw_order_resolution");
    const grant = live.indexOf("grant select, insert on public.kaw_order_resolution");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(live).not.toMatch(/grant[^;]*\b(update|delete|truncate)\b[^;]*kaw_order_resolution/i);
    expect(live).toMatch(/on delete restrict/);
  });

  it("행동과 결과의 짝·이전 상태·근거·메모를 CHECK 로 강제한다", () => {
    expect(live).toMatch(/action = 'dismiss_not_found' and new_state = 'dismissed'/);
    expect(live).toMatch(/prev_state in \('unknown','submitting'\)/);
    expect(live).toMatch(/evidence \? 'source'/);
    expect(live).toMatch(/char_length\(btrim\(note\)\) between 5 and 500/);
  });

  it("해소 함수는 한 트랜잭션: CAS(state_version)·해소 가능 상태·번호 없음 조건 후 감사 삽입", () => {
    const fn = live.slice(live.indexOf("create or replace function public.kaw_order_resolve"));
    expect(fn).toMatch(/security invoker/);
    expect(fn).toMatch(/set search_path = pg_catalog, public/);
    const upd = fn.indexOf("update public.kaw_order_intent");
    const ins = fn.indexOf("insert into public.kaw_order_resolution");
    expect(upd).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(upd);
    expect(fn).toMatch(/and state_version = p_expected_version/);
    expect(fn).toMatch(/and state in \('unknown','submitting'\)/);
    expect(fn).toMatch(/and order_no is null/);
    // 주문 내용 컬럼은 바꾸지 않는다
    const setBlock = fn.slice(upd, fn.indexOf("where", upd));
    for (const c of ["ticker", "quantity", "limit_price", "amount", "account_instance_id", "side"]) {
      expect(setBlock).not.toMatch(new RegExp(`\\b${c}\\s*=`));
    }
  });

  it("주문번호 출처 컬럼: 번호 없이 출처만 있을 수 없고, 수동 해소는 user_linked 로만 붙인다", () => {
    expect(live).toMatch(/add column if not exists order_no_source text/);
    expect(live).toMatch(/order_no_source in \('broker_response','user_linked'\) and order_no is not null/);
    expect(live).toMatch(/grant update \(order_no_source\) on public\.kaw_order_intent to service_role/);
    expect(live).toMatch(/is distinct from 'user_linked' then\s+raise exception/);
    expect(live).toMatch(/dismissed must not carry an order number/);
  });

  it("실행 권한은 service_role 만", () => {
    expect(live).toMatch(/revoke all on function public\.kaw_order_resolve[\s\S]*from public, anon, authenticated/);
    expect(live).toMatch(/grant execute on function public\.kaw_order_resolve[\s\S]*to service_role/);
  });

  it("거래 원장을 건드리지 않는다", () => {
    expect(live).not.toMatch(/kaw_transaction_ledger/);
  });

  it("롤백의 파괴적 문장은 전부 주석이다", () => {
    expect(stripSql(read("../../../migrations/009_order_resolution_rollback.sql")).trim()).toBe("");
  });
});

// ── 소스 불변식 · mock 격리 ─────────────────────────────────────────────────

describe("수동 해소·mock 소스 불변식", () => {
  it("해소 경로는 원장 모듈을 가져오지 않고 주문을 보내지 않는다", () => {
    const svc = stripTs(read("./order-service.ts"));
    const fn = svc.slice(svc.indexOf("export async function resolveOrder"));
    expect(fn).not.toMatch(/broker\.place\(/);
    for (const f of ["./order-service.ts", "./order-handlers.ts", "./order-store.ts"]) {
      expect(read(f)).not.toMatch(/from "\.\/ledger/);
    }
  });

  it("Supabase 해소는 RPC 한 번이다(두 번의 쓰기로 나누지 않는다)", () => {
    const st = stripTs(read("./order-store.ts"));
    const sup = st.slice(st.indexOf("class SupabaseOrderStore"));
    const res = sup.slice(sup.indexOf("async resolve("));
    expect(res).toContain('rpc("kaw_order_resolve"');
    expect(res.slice(0, res.indexOf("\n  }\n"))).not.toMatch(/\.from\(/);
  });

  it("운영 코드는 mock API 를 import 하지 않는다", () => {
    const srcRoot = here("../../");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const offenders = walk(srcRoot)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith("order-mock-api.ts"))
      .filter((f) => readFileSync(f, "utf8").includes("order-mock-api"));
    expect(offenders).toEqual([]);
  });

  it("mock 화면은 운영 store·Supabase·서버 모듈·fetch 를 쓰지 않는다", () => {
    const main = read("../../../mock/order-ui/main.tsx");
    const api = read("./order-mock-api.ts");
    const panel = read("../../components/kaw/OrderApprovalPanel.tsx");
    for (const src of [main, api, panel]) {
      expect(src).not.toMatch(/@\/lib\/kaw\/store|\.\/store"|supabase|data-server|kis-server|kis-order"/);
    }
    expect(stripTs(main) + stripTs(api)).not.toMatch(/\bfetch\(/);
    expect(stripTs(main)).not.toMatch(/localStorage/);
  });

  it("mock Vite 설정은 저장소 .env(VITE_*)를 읽지 않는다", () => {
    const cfg = read("../../../vite.mock.config.ts");
    expect(cfg).toMatch(/envPrefix:\s*"KAW_MOCK_ONLY_"/);
    expect(cfg).toMatch(/envDir:\s*path\.resolve\(import\.meta\.dirname, "mock\/order-ui"\)/);
    expect(stripTs(cfg)).not.toMatch(/tanstack|cloudflare|lovable/i);
  });

  it("mock 데이터는 가상값이다(계좌번호 형식의 8자리 숫자가 없다)", () => {
    const api = read("./order-mock-api.ts") + read("../../../mock/order-ui/main.tsx");
    expect(api).not.toMatch(/\b\d{8}\b(?!\d)/);
    expect(api).toContain("가상");
  });
});

// ── 핸들러 ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({ session: null as null | { code: string; profile: string } }));
vi.mock("./data-server", async (orig) => {
  const actual = await orig<typeof import("./data-server")>();
  return { ...actual, requireSession: async () => mocks.session, serviceClient: () => null };
});
const { handleOrderResolve } = await import("./order-handlers");

describe("POST /api/kis/order/resolve", () => {
  const PENSION = {
    id: "bai:kis-pension", label: "연금", broker: "kis", productCode: "22",
    logicalAccountType: "pension", activeFrom: "2026-01-01", connectionMode: "api_readonly",
  };
  const ENV = {
    SESSION_SECRET: "s", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
    KIS_ACCOUNT_OWNER_FAMILY_CODE: "fam", KIS_ACCOUNT_OWNER_PROFILE: "me",
    KIS_APP_KEY: "test-app-key-0123456789", KIS_APP_SECRET: "test-app-secret-abcdefghij",
    KIS_ACCOUNT_CANO: "12345678", KIS_ORDER_ENABLED: "on",
  };
  let store: InMemoryOrderStore;
  let calls: { place: number; inquire: number };
  const broker = () => ({
    quote: async () => ({ price: 20_000, asOf: "t" }),
    buyingPower: async () => { throw new Error("호출되면 안 된다"); },
    place: async () => { calls.place += 1; throw new Error("주문이 나가면 안 된다"); },
    inquire: async () => { calls.inquire += 1; return { ok: true, rows: [], hasMore: false, complete: true }; },
  });
  const req = (body: unknown) => new Request("https://x/api/kis/order/resolve", { method: "POST", body: JSON.stringify(body) });
  const ov = () => ({ store, broker: broker() as never, now: () => new Date("2026-10-15T01:00:00.000Z"), newId: () => "r1" });

  beforeEach(async () => {
    mocks.session = { code: "fam", profile: "me" };
    store = new InMemoryOrderStore();
    calls = { place: 0, inquire: 0 };
    await store.insert(intent({ scope: { familyCode: "fam", profile: "me" }, accountInstanceId: PENSION.id }));
  });

  it("flag OFF 면 403 이고 조회하지 않는다", async () => {
    const r = await handleOrderResolve(req({}), { ...ENV, KIS_ORDER_ENABLED: undefined }, ov(), [PENSION]);
    expect(r.status).toBe(403);
    expect(calls.inquire).toBe(0);
  });

  it("소유자가 아니면 403", async () => {
    mocks.session = { code: "fam", profile: "other" };
    const r = await handleOrderResolve(req({ intentId: "i1", action: "dismiss_not_found", note: "확인했습니다", confirmIntentId: "i1" }), ENV, ov(), [PENSION]);
    expect(r.status).toBe(403);
  });

  it("다음 날 조회가 비어 있으면 dismissed 로 200, 응답에 비밀값이 없다, 주문은 0건", async () => {
    const r = await handleOrderResolve(req({ intentId: "i1", action: "dismiss_not_found", note: "증권사 앱에 주문 없음", confirmIntentId: "i1" }), ENV, ov(), [PENSION]);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ intent: { state: "dismissed" }, resolution: { action: "dismiss_not_found", actor: "me" } });
    for (const secret of [ENV.KIS_ACCOUNT_CANO, ENV.KIS_APP_KEY, ENV.KIS_APP_SECRET, "approvalTokenHash"]) {
      expect(text).not.toContain(secret);
    }
    expect(calls.place).toBe(0);
    expect(store.resolutions[0]).toMatchObject({ actor: "me", note: "증권사 앱에 주문 없음" });
  });

  it("근거 부족(번호 미조회)은 422 이고 상태 그대로", async () => {
    const r = await handleOrderResolve(req({ intentId: "i1", action: "link_order_no", orderNo: "777", note: "증권사 앱에서 봄", confirmIntentId: "i1" }), ENV, ov(), [PENSION]);
    expect(r.status).toBe(422);
    expect((await store.getById({ familyCode: "fam", profile: "me" }, "i1"))!.state).toBe("unknown");
  });

  it("형식 오류는 400", async () => {
    const r = await handleOrderResolve(req({ intentId: "i1" }), ENV, ov(), [PENSION]);
    expect(r.status).toBe(400);
  });
});
