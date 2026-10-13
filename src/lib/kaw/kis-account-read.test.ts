/**
 * 실잔고 조회 오케스트레이션과 **조회 권한**을 가짜 어댑터로 고정한다. 실제 네트워크·실제
 * credential 을 쓰지 않는다.
 *
 * 지키는 것:
 *   1. 권한 → 계좌 등록·운용방식 → credential → 토큰 → 조회, 앞이 막히면 뒤를 실행하지 않는다
 *   2. **sentinel(미등록)·계산만 제공은 조회하지 않는다**
 *   3. 서버의 계좌는 **소유 프로필의 세션에만** 열린다(설정이 없으면 전원 거부)
 *   4. 22 는 한 번, 29 는 독립된 두 번 호출한다 (한쪽 실패가 다른 쪽을 지우지 않는다)
 *   5. 응답에 계좌번호·키가 없다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANO_RE,
  authorizeKisAccess,
  parseBrokerAccounts,
  readKisAccount,
  type KisReadDeps,
} from "./kis-account-read";
import type { KisBalanceSnapshot, KisDepositResult } from "./kis-account-server";
import type { BrokerAccountInstance } from "./broker-account";

const CRED = { appKey: "test-app-key-0123456789", appSecret: "test-app-secret-abcdefghij", cano: "12345678" };
const NOW = new Date("2026-10-12T03:00:00.000Z"); // KST 2026-10-12

const bal = (over: Partial<KisBalanceSnapshot> = {}): KisBalanceSnapshot => ({
  ok: true, httpStatus: 200, rtCd: "0", holdings: [], holdingsCount: 0, cash: 0, summary: {}, ...over,
});
const dep = (cash: number | null, ok = true): KisDepositResult => ({
  ok, httpStatus: ok ? 200 : 500, rtCd: ok ? "0" : "1", cash,
});

function fakeDeps(over: Partial<{
  savings: KisBalanceSnapshot; present: KisBalanceSnapshot; deposit: KisDepositResult;
}> = {}) {
  const calls: string[] = [];
  const deps: KisReadDeps = {
    fetchPensionSavings: vi.fn(async () => { calls.push("22:balance"); return over.savings ?? bal(); }),
    fetchIrpPresent: vi.fn(async () => { calls.push("29:present"); return over.present ?? bal(); }),
    fetchIrpDeposit: vi.fn(async () => { calls.push("29:deposit"); return over.deposit ?? dep(0); }),
    now: () => NOW,
  };
  return { deps, calls };
}

const KIS_PENSION_PENDING: BrokerAccountInstance = {
  id: "bai:kis-pension", label: "한국투자 연금저축", broker: "kis", productCode: "22",
  logicalAccountType: "pension", activeFrom: "2026-11-01", connectionMode: "api_readonly",
};
const KIS_PENSION: BrokerAccountInstance = { ...KIS_PENSION_PENDING, activeFrom: "2026-01-01" };
const KIS_IRP: BrokerAccountInstance = {
  id: "bai:kis-irp", label: "한국투자 IRP", broker: "kis", productCode: "29",
  logicalAccountType: "irp", activeFrom: "2026-10-09", connectionMode: "api_readonly",
};
const KIS_IRP_CALC_ONLY: BrokerAccountInstance = { ...KIS_IRP, connectionMode: "calc_only" };

describe("조회 전 판단 — 막히면 호출하지 않는다", () => {
  it("이전 중인 연금저축은 네트워크를 타지 않고 not_queried 다", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "22", registry: [KIS_PENSION_PENDING], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.observation.holdings).toEqual({ kind: "not_queried", reason: "not_yet_active" });
    expect(r.plan.holdings).toBeNull();
    expect(r.plan.cash).toBeNull();
    expect(r.plan.blockers[0].code).toBe("instance_not_active");
  });

  it("**등록되지 않은 계좌(sentinel)는 credential 이 있어도 조회하지 않는다**", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "22", registry: [], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.observation.holdings).toEqual({ kind: "not_queried", reason: "instance_unregistered" });
    expect(r.plan.ready).toBe(false);
  });

  it("**계산만 제공으로 설정된 계좌는 조회하지 않는다**", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "29", registry: [KIS_IRP_CALC_ONLY], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.observation.holdings).toEqual({ kind: "not_queried", reason: "mode_calc_only" });
  });

  it("connectionMode 가 없는(기존 사용자) 계좌도 조회하지 않는다", async () => {
    const f = fakeDeps();
    const { connectionMode: _drop, ...legacy } = KIS_IRP;
    void _drop;
    await readKisAccount(
      { productCode: "29", registry: [legacy], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual([]);
  });

  it("**상품코드·논리계좌가 섞인 instance 는 후보가 아니다** (22 요청이 IRP instance 를 못 쓴다)", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "22", registry: [KIS_IRP], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.observation.holdings.kind).toBe("not_queried");
  });

  it("미래에셋 instance 로는 한국투자 조회가 되지 않는다", async () => {
    const f = fakeDeps();
    const mirae: BrokerAccountInstance = {
      ...KIS_IRP, id: "bai:mirae", broker: "miraeasset", productCode: undefined,
    };
    await readKisAccount({ productCode: "29", registry: [mirae], credentials: CRED, token: "t" }, f.deps);
    expect(f.calls).toEqual([]);
  });

  it("같은 날 active 이고 api 모드인 IRP 는 조회한다", async () => {
    const f = fakeDeps({ deposit: dep(250_000) });
    const r = await readKisAccount(
      { productCode: "29", registry: [KIS_IRP], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls.sort()).toEqual(["29:deposit", "29:present"]);
    expect(r.observation.accountInstanceId).toBe("bai:kis-irp");
    expect(r.plan.ready).toBe(true);
    expect(r.plan.buyBudget).toEqual({ kind: "cash_upper_bound", amount: 250_000 });
  });

  it("credential·토큰이 없으면 호출하지 않는다", async () => {
    const f = fakeDeps();
    await readKisAccount({ productCode: "29", registry: [KIS_IRP], credentials: null }, f.deps);
    await readKisAccount({ productCode: "22", registry: [KIS_PENSION], credentials: CRED }, f.deps);
    expect(f.calls).toEqual([]);
  });

  it("CANO 가 8자리가 아니면 호출하지 않고 값을 되돌려 내지 않는다", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "22", registry: [KIS_PENSION], credentials: { ...CRED, cano: "1234567822" }, token: "t" },
      f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.observation.holdings).toEqual({ kind: "not_queried", reason: "invalid_account_config" });
    expect(CANO_RE.test("12345678")).toBe(true);
    expect(CANO_RE.test("123456-78")).toBe(false);
    expect(JSON.stringify(r)).not.toContain("1234567822");
  });
});

describe("호출 구성", () => {
  it("연금저축(22)은 한 번만 호출한다", async () => {
    const f = fakeDeps({ savings: bal({ holdings: [{ ticker: "069500", name: "K", quantity: 4 }], holdingsCount: 1, cash: 77 }) });
    const r = await readKisAccount(
      { productCode: "22", registry: [KIS_PENSION], credentials: CRED, token: "t" }, f.deps,
    );
    expect(f.calls).toEqual(["22:balance"]);
    expect(r.plan.holdings).toEqual({ "069500": 4 });
    expect(r.plan.cash).toBe(77);
    expect(r.observation.instanceBasis).toBe("registry");
  });

  it("IRP 는 한쪽이 실패해도 다른 쪽을 남긴다", async () => {
    const f = fakeDeps({
      present: bal({ holdings: [{ ticker: "069500", name: "K", quantity: 1 }], holdingsCount: 1 }),
      deposit: dep(null, false),
    });
    const r = await readKisAccount(
      { productCode: "29", registry: [KIS_IRP], credentials: CRED, token: "t" }, f.deps,
    );
    expect(r.observation.holdings.kind).toBe("observed");
    expect(r.observation.cash.kind).toBe("failed");
    expect(r.plan.ready).toBe(false);
  });

  it("stateAsOf 는 조회일(KST)이다 — 결제일로 소급하지 않는다", async () => {
    const f = fakeDeps();
    const r = await readKisAccount(
      { productCode: "29", registry: [KIS_IRP], credentials: CRED, token: "t" }, f.deps,
    );
    expect(r.observation.stateAsOf).toBe("2026-10-12");
    expect(r.observation.observedAt).toBe(NOW.toISOString());
  });
});

describe("parseBrokerAccounts", () => {
  it("모양이 맞는 항목만 읽고 어긋난 항목은 버린다", () => {
    const out = parseBrokerAccounts([
      { id: "bai:a", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-11-01", connectionMode: "api_readonly" },
      { id: "bai:b", broker: "kis", logicalAccountType: "nope", activeFrom: "2026-11-01" },
      { id: "bai:c", broker: "kis", logicalAccountType: "irp", activeFrom: "내일" },
      { id: "bai:d", broker: "kis", logicalAccountType: "irp", activeFrom: "2026-01-01", activeTo: "x" },
      "문자열", null,
    ]);
    expect(out.map((i) => i.id)).toEqual(["bai:a"]);
    expect(out[0]).toMatchObject({ productCode: "22", connectionMode: "api_readonly" });
  });

  it("알 수 없는 connectionMode 는 읽지 않는다 (기본 계산만 제공)", () => {
    const out = parseBrokerAccounts([
      { id: "bai:a", broker: "kis", logicalAccountType: "irp", activeFrom: "2026-01-01", connectionMode: "auto_trade" },
    ]);
    expect(out[0].connectionMode).toBeUndefined();
  });

  it("모르는 필드·계좌번호처럼 보이는 값은 복사하지 않는다", () => {
    const out = parseBrokerAccounts([
      {
        id: "bai:a", broker: "kis", logicalAccountType: "irp", activeFrom: "2026-01-01",
        cano: "12345678", label: "내 계좌 50012345678", productCode: "290",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("12345678");
    expect(out[0].label).toBe("bai:a");
    expect(out[0].productCode).toBeUndefined();
    expect((out[0] as unknown as Record<string, unknown>).cano).toBeUndefined();
  });

  it("중복 id 는 첫 항목만 읽는다", () => {
    const row = { id: "bai:a", broker: "kis", logicalAccountType: "irp", activeFrom: "2026-01-01" };
    expect(parseBrokerAccounts([row, { ...row, broker: "other" }])).toHaveLength(1);
  });

  it("배열이 아니면 빈 레지스트리다", () => {
    expect(parseBrokerAccounts(undefined)).toEqual([]);
    expect(parseBrokerAccounts({})).toEqual([]);
  });
});

describe("authorizeKisAccess — 서버 계좌는 소유 가족의 소유 프로필에만", () => {
  const session = { code: "soye", profile: "hyeobi" };
  const owner = { KIS_ACCOUNT_OWNER_FAMILY_CODE: "soye", KIS_ACCOUNT_OWNER_PROFILE: "hyeobi" };

  it("가족 코드와 프로필이 **둘 다** 일치할 때만 허용한다", () => {
    expect(authorizeKisAccess(session, owner)).toEqual({ ok: true });
  });

  it("**다른 가족의 같은 프로필명은 거부된다**", () => {
    expect(authorizeKisAccess({ code: "otherfam", profile: "hyeobi" }, owner))
      .toEqual({ ok: false, reason: "family_mismatch" });
  });

  it("같은 가족의 다른 프로필은 거부된다", () => {
    expect(authorizeKisAccess({ code: "soye", profile: "dayoung" }, owner))
      .toEqual({ ok: false, reason: "profile_not_owner" });
  });

  it("**둘 중 하나라도 설정되지 않으면 소유자 본인도 거부된다** (fail closed)", () => {
    const none = { ok: false, reason: "owner_not_configured" };
    expect(authorizeKisAccess(session, {})).toEqual(none);
    expect(authorizeKisAccess(session, { KIS_ACCOUNT_OWNER_PROFILE: "hyeobi" })).toEqual(none);
    expect(authorizeKisAccess(session, { KIS_ACCOUNT_OWNER_FAMILY_CODE: "soye" })).toEqual(none);
    expect(authorizeKisAccess(session, { ...owner, KIS_ACCOUNT_OWNER_FAMILY_CODE: "  " })).toEqual(none);
    expect(authorizeKisAccess(session, { ...owner, KIS_ACCOUNT_OWNER_PROFILE: "" })).toEqual(none);
  });

  it("세션 값이 비어 있으면 거부된다 (빈 값끼리 일치하지 않는다)", () => {
    expect(authorizeKisAccess({ code: "", profile: "hyeobi" }, owner).ok).toBe(false);
    expect(authorizeKisAccess({ code: "soye", profile: "" }, owner).ok).toBe(false);
  });

  it("대소문자·부분·접두 일치로 통과하지 않는다", () => {
    for (const s of [
      { code: "Soye", profile: "hyeobi" },
      { code: "soye2", profile: "hyeobi" },
      { code: "soy", profile: "hyeobi" },
      { code: "soye", profile: "Hyeobi" },
      { code: "soye", profile: "hyeobi2" },
      { code: "soye", profile: "_shared" },
    ]) {
      expect(authorizeKisAccess(s, owner).ok).toBe(false);
    }
  });

  it("클라이언트가 쓸 수 있는 레지스트리·모드 값은 판단 입력이 아니다", () => {
    // 시그니처가 세션과 소유 설정 둘뿐이다 — brokerAccounts/connectionMode 를 받을 자리가 없다.
    expect(authorizeKisAccess.length).toBe(2);
  });
});

// ── 핸들러 ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  session: null as null | { code: string; profile: string },
  registry: [] as unknown[],
  dbReads: 0,
}));

vi.mock("./data-server", async (orig) => {
  const actual = await orig<typeof import("./data-server")>();
  return {
    ...actual,
    requireSession: async () => mocks.session,
    serviceClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({
            maybeSingle: async () => {
              mocks.dbReads += 1;
              return { data: { data: { brokerAccounts: mocks.registry } } };
            },
          }) }) }),
        }),
      }),
    }),
  };
});

const { handleKisAccountGet } = await import("./kis-account-read");

const env = {
  SESSION_SECRET: "s", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
  KIS_ACCOUNT_OWNER_FAMILY_CODE: "soye", KIS_ACCOUNT_OWNER_PROFILE: "hyeobi",
  KIS_APP_KEY: CRED.appKey, KIS_APP_SECRET: CRED.appSecret, KIS_ACCOUNT_CANO: "12345678",
};
const req = (qs: string) => new Request(`https://x/api/kis/account${qs}`);
const OWNER = { code: "soye", profile: "hyeobi" };

beforeEach(() => {
  mocks.session = OWNER;
  mocks.registry = [];
  mocks.dbReads = 0;
});

describe("GET /api/kis/account", () => {
  it("세션이 없으면 401 이다", async () => {
    mocks.session = null;
    expect((await handleKisAccountGet(req("?product=22"), env)).status).toBe(401);
  });

  it.each(["", "?product=55", "?product=2", "?product=22,29"])("product 가 틀리면 400 (%s)", async (qs) => {
    expect((await handleKisAccountGet(req(qs), env)).status).toBe(400);
  });

  it("**소유자가 아닌 프로필은 403 이고 DB·토큰·조회를 모두 건너뛴다**", async () => {
    mocks.session = { code: "soye", profile: "dayoung" };
    mocks.registry = [{ ...KIS_PENSION }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(req("?product=22"), env);
    vi.unstubAllGlobals();
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.dbReads).toBe(0);
    // 설정 상태를 알려주지 않는다
    expect(await res.text()).not.toMatch(/OWNER|owner_not_configured|profile_not_owner/);
  });

  it("**다른 가족의 동일 프로필명은 403 이고 DB·토큰·조회를 모두 건너뛴다**", async () => {
    mocks.session = { code: "otherfam", profile: "hyeobi" };
    // 상대 가족이 자기 레지스트리에 "KIS + API 모드"를 써 두어도 권한이 생기지 않는다.
    mocks.registry = [{ ...KIS_PENSION }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(req("?product=22"), env);
    vi.unstubAllGlobals();
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.dbReads).toBe(0);
    const text = await res.text();
    expect(text).not.toMatch(/OWNER|soye|owner_not_configured|family_mismatch/);
  });

  it("소유 가족 코드만 설정되고 프로필이 없으면 403 이다", async () => {
    mocks.registry = [{ ...KIS_PENSION }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(
      req("?product=22"), { ...env, KIS_ACCOUNT_OWNER_PROFILE: undefined },
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("**소유 설정이 없으면 소유자 본인도 403 이다** (fail closed)", async () => {
    mocks.registry = [{ ...KIS_PENSION }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(
      req("?product=22"),
      { ...env, KIS_ACCOUNT_OWNER_FAMILY_CODE: undefined, KIS_ACCOUNT_OWNER_PROFILE: undefined },
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("credential 이 없으면 503 이다", async () => {
    const res = await handleKisAccountGet(req("?product=22"), { ...env, KIS_APP_KEY: undefined });
    expect(res.status).toBe(503);
  });

  it("**미등록 계좌는 200 + not_queried 이고 토큰도 발급하지 않는다**", async () => {
    mocks.registry = [];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(req("?product=29"), env);
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { observation: { holdings: { kind: string; reason: string } } };
    expect(body.observation.holdings).toEqual({ kind: "not_queried", reason: "instance_unregistered" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("계산만 제공 계좌는 토큰도 발급하지 않는다", async () => {
    mocks.registry = [{ ...KIS_IRP_CALC_ONLY }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(req("?product=29"), env);
    vi.unstubAllGlobals();
    const body = (await res.json()) as { observation: { holdings: { reason: string } }; plan: { ready: boolean } };
    expect(body.observation.holdings.reason).toBe("mode_calc_only");
    expect(body.plan.ready).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("이전 중인 계좌는 토큰도 발급하지 않는다", async () => {
    mocks.registry = [{ ...KIS_PENSION_PENDING }];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKisAccountGet(req("?product=22"), env);
    vi.unstubAllGlobals();
    const body = (await res.json()) as { observation: { holdings: { reason: string } } };
    expect(body.observation.holdings.reason).toBe("not_yet_active");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("응답이 22/29 동일 계좌번호 가정을 **미검증**으로 명시한다", async () => {
    mocks.registry = [{ ...KIS_IRP }];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await handleKisAccountGet(req("?product=29"), env);
    vi.unstubAllGlobals();
    const body = (await res.json()) as {
      accountIdentity: { sharedCanoAcrossProducts: string; usableAsOrderAccountIdentity: boolean };
    };
    expect(body.accountIdentity.sharedCanoAcrossProducts).toBe("unverified");
    expect(body.accountIdentity.usableAsOrderAccountIdentity).toBe(false);
  });

  it("응답 본문에 계좌번호·키가 없다 (조회 실패 경로 포함)", async () => {
    mocks.registry = [{ ...KIS_IRP }];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`boom ${CRED.appSecret} 12345678`); }));
    const res = await handleKisAccountGet(req("?product=29"), env);
    vi.unstubAllGlobals();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("12345678");
    expect(text).not.toContain(CRED.appSecret);
    expect(text).not.toContain(CRED.appKey);
  });
});

describe("소스 불변식", () => {
  const code = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("읽기 전용이다 — 쓰기·주문·원장 호출이 없다", () => {
    const src = code("./kis-account-read.ts");
    expect(src).not.toMatch(/\.(insert|upsert|update|delete)\(/);
    expect(src).not.toMatch(/method:\s*["']POST["']/);
    expect(src).not.toMatch(/order-cash|inquire-psbl-order|ledger|cashflow/);
    expect(src).not.toMatch(/console\./);
  });

  it("조회 어댑터는 기존 PoC 모듈 하나뿐이다 (중복 구현 없음)", () => {
    const src = code("./kis-account-read.ts");
    expect(src).toContain('from "./kis-account-server"');
    expect(src).toContain("getKisAccessToken");
    expect(src).not.toMatch(/openapi\.koreainvestment\.com/);
  });

  it("핸들러의 순서: 권한 → 레지스트리 → 게이트 → 토큰", () => {
    const src = code("./kis-account-read.ts");
    const h = src.slice(src.indexOf("export async function handleKisAccountGet"));
    const order = [
      "authorizeKisAccess(session, env)",
      "serviceClient(env)",
      "kisApiQueryGate(",
      "getKisAccessToken(",
    ].map((t) => h.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("권한 판단이 가족 코드와 프로필을 모두 비교한다", () => {
    const src = code("./kis-account-read.ts");
    const fn = src.slice(src.indexOf("export function authorizeKisAccess"), src.indexOf("export async function handleKisAccountGet"));
    expect(fn).toContain("session.code !== ownerFamily");
    expect(fn).toContain("session.profile !== ownerProfile");
    expect(fn).toContain("KIS_ACCOUNT_OWNER_FAMILY_CODE");
    // 프로필 하나만 보는 옛 방식(ACCESS_CODE 대조)으로 되돌아가지 않는다
    expect(fn).not.toContain("ACCESS_CODE");
  });

  it("서버의 권한 판단이 클라이언트 저장값(connectionMode)에 의존하지 않는다", () => {
    const src = code("./kis-account-read.ts");
    const fn = src.slice(src.indexOf("export function authorizeKisAccess"), src.indexOf("export async function handleKisAccountGet"));
    expect(fn).not.toMatch(/connectionMode|brokerAccounts|registry/);
  });
});
