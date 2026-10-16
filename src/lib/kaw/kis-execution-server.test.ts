/**
 * POST /api/kis/executions/preview — 인증 · 소유권 · 설정 없음 · 게이트 · 조회 · 조립 · 쓰기 없음.
 *
 * 실계좌 API 는 호출하지 않는다. KIS 응답은 실증된 구조(2026-10-16)의 모의 응답이다.
 *
 * 지키는 것:
 *   1. 세션 없음 401 · 요청 모양 400 · 소유자 아님 403 · credential 없음 503 — 각 단계에서 뒤 단계를 실행하지 않는다
 *   2. 운영 현재 상태(credential 없음)에서 어떤 DB 읽기 · KIS 호출도 하지 않는다
 *   3. 계산만 제공 설정이면 토큰도 조회도 하지 않는다
 *   4. 실패는 분류해서 돌려주고 재시도하지 않는다 · 응답 원문을 만들지 않는다
 *   5. 응답에 계좌번호 · 키 · 토큰 · 주문번호 전체가 없다
 *   6. 쓰기가 없다 (insert / upsert / update / delete / rpc 호출 0 · 소스에도 없음)
 *   7. 10-14 사례: 신규 2건 · 체결 없는 주문 1건 · 합계 7,974,630 · 승인 불가 · 자금/이탈 경고
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase (읽기만 기록) ─────────────────────────────────────────────
const dbCalls: string[] = [];
let ledgerRows: Record<string, unknown>[] = [];
let ledgerError = false;
let registryData: unknown = [];
let cashflows: unknown[] = [];

const fakeClient = {
  rpc: () => { dbCalls.push("rpc"); return Promise.resolve({ data: null, error: null }); },
  from: (table: string) => {
    const mk = (ret: () => unknown) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => { dbCalls.push(`read:${table}`); return ret(); };
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { dbCalls.push(`read:${table}`); return Promise.resolve(ret()).then(res, rej); };
      for (const m of ["insert", "upsert", "update", "delete"]) chain[m] = () => { dbCalls.push(`WRITE:${m}:${table}`); return chain; };
      return chain;
    };
    if (table === "kaw_transaction_ledger") return mk(() => (ledgerError ? { data: null, error: { message: "x" } } : { data: ledgerRows, error: null }));
    if (table === "kaw_transaction_correction") return mk(() => ({ data: [], error: null }));
    // kaw_data: _meta(레지스트리) / pension(장부) / 세션 검증용 _family 가 한 테이블이다. 요청 순서에 의존하지 않도록 단일 응답을 쓴다.
    return {
      select: () => {
        const filters: Record<string, string> = {};
        const chain: Record<string, unknown> = {
          eq: (k: string, v: string) => { filters[k] = v; return chain; },
          maybeSingle: async () => {
            dbCalls.push(`read:kaw_data:${filters.account_type}`);
            if (filters.account_type === "_meta") return { data: { data: { brokerAccounts: registryData } }, error: null };
            if (filters.account_type === "pension") return { data: { data: { cashflows } }, error: null };
            return { data: null, error: null };
          },
        };
        return chain;
      },
      insert: () => { dbCalls.push(`WRITE:insert:${table}`); return Promise.resolve({ error: null }); },
      upsert: () => { dbCalls.push(`WRITE:upsert:${table}`); return Promise.resolve({ error: null }); },
      update: () => { dbCalls.push(`WRITE:update:${table}`); return Promise.resolve({ error: null }); },
      delete: () => { dbCalls.push(`WRITE:delete:${table}`); return Promise.resolve({ error: null }); },
    };
  },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleKisExecutionsPreview, ledgerRowToTransaction } = await import("./kis-execution-server");

const SECRET = "test-secret";
const F = "family-x", P = "profile-x";
const CANO = "12345678";
const APPKEY = "APPKEY-1234567890-SECRET-VALUE-XYZ";
const APPSECRET = "APPSECRET-1234567890-SECRET-VALUE-XYZ";
const TOKEN = "TOKEN-1234567890-SECRET-VALUE-XYZ-ABCDEFGHIJKLMNOP";

function b64url(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sessionToken(code = F, profile = P): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ code, profile, exp: Math.floor(Date.now() / 1000) + 3600, v: 0 })));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const baseEnv = {
  SESSION_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
};
const fullEnv = {
  ...baseEnv, KIS_APP_KEY: APPKEY, KIS_APP_SECRET: APPSECRET, KIS_ACCOUNT_CANO: CANO,
  KIS_ACCOUNT_OWNER_FAMILY_CODE: F, KIS_ACCOUNT_OWNER_PROFILE: P,
};

const kisInstance = { id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const calcOnly = { ...kisInstance, connectionMode: "calc_only" };

// 실증된 응답 구조의 모의 응답 (주문번호는 가짜)
const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", ord_dvsn_name: "지정가", sll_buy_dvsn_cd: "02", pdno: "360750",
  prdt_name: "TIGER 미국S&P500", ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985",
  cncl_yn: "N", tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", ord_tmd: "133510", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080", ord_tmd: "133615" }),
  rowRaw({ odno: "0000006700" }),
];
const okKis = (over: Record<string, unknown> = {}, trCont = "E") =>
  new Response(JSON.stringify({
    rt_cd: "0", msg_cd: "KIOK0510", msg1: "조회가 완료되었습니다", ctx_area_fk100: "", ctx_area_nk100: "", output1: OUT1,
    output2: { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.5918", prsm_tlex_smtl: "0" }, ...over,
  }), { status: 200, headers: { "content-type": "application/json", tr_cont: trCont } });

// 합성 원장: 이전 증권사 출처 보유 + 장부 (실제 사례와 같은 모양)
const ledgerTx = (over: Record<string, unknown>) => ({
  id: "t1", account_type: "pension", ticker: "360750", etf_name: "TIGER", side: "buy", quantity: 297, price: 25000, amount: 7_425_000,
  trade_date: null, settlement_date: "2026-10-07", inferred_trade_date: "2026-10-02", event_date: "2026-10-02",
  trade_date_evidence: "tplus2-weekday-inference", fee: 10, tax: 0, post_quantity: null, source: "miraeasset_transaction_history", ...over,
});

let kisFetch: ReturnType<typeof vi.fn>;
const getToken = vi.fn(async () => TOKEN);

async function call(body: unknown, env: Record<string, unknown> = fullEnv, opts: { token?: string | null } = {}) {
  const token = opts.token === undefined ? await sessionToken() : opts.token;
  const req = new Request("https://x/api/kis/executions/preview", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleKisExecutionsPreview(req, env as never, { fetchImpl: kisFetch as never, getToken: getToken as never, today: () => "2026-10-16" });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, any>, text };
}
const RANGE = { start: "2026-10-13", end: "2026-10-16" };
/** 세션 유효성 확인(_family 읽기)은 기능의 DB 접근이 아니다 — 그것을 뺀 접근만 본다 */
const featureDb = () => dbCalls.filter((c) => !c.endsWith(":_family"));
const dbWrites = () => dbCalls.filter((c) => c.startsWith("WRITE") || c === "rpc");

beforeEach(() => {
  dbCalls.length = 0; ledgerRows = []; ledgerError = false; registryData = [kisInstance]; cashflows = [];
  kisFetch = vi.fn(async () => okKis());
  getToken.mockClear();
});

describe("단계별 차단 — 앞 단계가 막히면 뒤 단계를 실행하지 않는다", () => {
  it("세션 없음 → 401, 아무것도 하지 않는다", async () => {
    const r = await call(RANGE, fullEnv, { token: null });
    expect(r.status).toBe(401);
    expect(featureDb()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("요청 모양 오류 → 400 (날짜 형식 · 역순 · 미래 · 93일 초과)", async () => {
    for (const b of ["{", {}, { start: "2026-10-1", end: "2026-10-16" }, { start: "2026-10-16", end: "2026-10-13" }, { start: "2026-10-13", end: "2026-10-17" }, { start: "2026-01-01", end: "2026-10-16" }]) {
      const r = await call(b);
      expect(r.status).toBe(400);
    }
    expect(kisFetch).not.toHaveBeenCalled();
    expect(featureDb()).toEqual([]);
  });

  it("소유자가 아닌 프로필 → 403, DB 도 KIS 도 건드리지 않는다", async () => {
    const r = await call(RANGE, { ...fullEnv, KIS_ACCOUNT_OWNER_PROFILE: "someone-else" });
    expect(r.status).toBe(403);
    expect(r.json.error).not.toContain("someone-else");
    expect(featureDb()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("소유자 설정이 없으면 전원 거부(fail closed)", async () => {
    const { KIS_ACCOUNT_OWNER_FAMILY_CODE: _a, KIS_ACCOUNT_OWNER_PROFILE: _b, ...noOwner } = fullEnv;
    expect((await call(RANGE, noOwner)).status).toBe(403);
  });

  it("【현재 운영 상태】credential 이 없으면 503 not_configured — DB 읽기 · 토큰 · KIS 호출이 전혀 없다", async () => {
    const { KIS_APP_KEY: _k, KIS_APP_SECRET: _s, KIS_ACCOUNT_CANO: _c, ...noCred } = fullEnv;
    const r = await call(RANGE, noCred);
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ unavailable: true, state: "not_configured" });
    expect(featureDb()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("CANO 만 없어도 503 이다", async () => {
    const { KIS_ACCOUNT_CANO: _c, ...noCano } = fullEnv;
    expect((await call(RANGE, noCano)).status).toBe(503);
    expect(kisFetch).not.toHaveBeenCalled();
  });

  it("계산만 제공 설정이면 gate_blocked — 토큰도 조회도 하지 않는다", async () => {
    registryData = [calcOnly];
    const r = await call(RANGE);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ state: "gate_blocked", reason: "mode_calc_only" });
    expect(getToken).not.toHaveBeenCalled();
    expect(kisFetch).not.toHaveBeenCalled();
  });

  it("레지스트리가 비어 있으면 gate_blocked(instance_unregistered)", async () => {
    registryData = [];
    const r = await call(RANGE);
    expect(r.json).toEqual({ state: "gate_blocked", reason: "instance_unregistered" });
    expect(kisFetch).not.toHaveBeenCalled();
  });
});

describe("조회 · 조립 — 10-14 실제 사례(모의 응답)", () => {
  beforeEach(() => {
    ledgerRows = [
      ledgerTx({ id: "m1", ticker: "360750", quantity: 297, amount: 7_425_000 }),
      ledgerTx({ id: "m2", ticker: "367380", etf_name: "ACE", quantity: 81, price: 31660, amount: 2_564_460 }),
    ];
    cashflows = [{ date: "2025-11-10", amount: 6_000_000, type: "deposit" }, { date: "2026-01-26", amount: 4_500_000, type: "deposit" }];
  });

  it("GET 1회(기본 1페이지) · 응답 조립 · 신규 2건 · 체결 없는 주문 1건", async () => {
    const r = await call(RANGE);
    expect(r.status).toBe(200);
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(r.json.state).toBe("ok");
    expect(r.json.query).toMatchObject({ start: "2026-10-13", end: "2026-10-16", complete: true, unreadPages: false, listState: "rows", windows: 1, pagesRead: 1 });
    expect(r.json.totals.byStatus).toMatchObject({ new: 2, no_execution: 1, matches: 0, possible_duplicate: 0, attribution_conflict: 0, unverifiable: 0 });
    expect(r.json.totals.executed).toMatchObject({ rows: 2, buyQty: 294, buyAmount: 7_974_630, sellAmount: 0 });
    expect(r.json.totals.zeroFillRows).toBe(1);
    expect(r.json.apiCrossCheck).toEqual({ matches: true, apiTotalFilledAmount: 7_974_630, ourTotalFilledAmount: 7_974_630 });
  });

  it("체결 0주 주문은 합계에 들어가지 않고 승인 후보도 아니다", async () => {
    const r = await call(RANGE);
    const zero = r.json.entries.find((e: any) => e.row.hasExecution === false);
    expect(zero.status).toBe("no_execution");
    expect(zero.futureCandidate).toBe(false);
    expect(r.json.entries.every((e: any) => e.approvable === false)).toBe(true);
  });

  it("승인은 열리지 않는다 — enabled=false 이고 차단 사유가 모두 나열된다", async () => {
    const r = await call(RANGE);
    expect(r.json.approval.enabled).toBe(false);
    const codes = r.json.approval.blockers.map((b: any) => b.code);
    expect(codes).toContain("phase_not_enabled");
    expect(codes).toContain("funding_evidence_missing");
    expect(codes).toContain("prior_broker_residual");
    expect(codes).toContain("transfer_mode_unconfirmed");
  });

  it("영향 미리보기: 원금 불변 · 이전 증권사 보유(297/81) 이탈 누락 · 가짜 수입 위험", async () => {
    const r = await call(RANGE);
    expect(r.json.impact.principal).toBe(10_500_000);
    expect(r.json.impact.priorBrokerResidual).toEqual({ "360750": 297, "367380": 81 });
    expect(r.json.impact.funding.principalAfter).toBe(10_500_000);
    expect(r.json.impact.funding.createsCashflow).toBe(false);
    expect(r.json.impact.funding.verdict).toBe("funding_evidence_missing");
    expect(r.json.impact.funding.phantomIncomeLB).toBeGreaterThan(0);
  });

  it("이미 같은 출처로 원장에 있으면 '일치'로 표시한다", async () => {
    ledgerRows.push(ledgerTx({
      id: "k1", ticker: "367380", quantity: 64, price: 31220, amount: 1_998_080, event_date: "2026-10-14", source: "kis_api_daily_ccld",
      source_fingerprint: "v2|kis_api_daily_ccld|bai:kis-pension|20261014|0000001700",
    }));
    const r = await call(RANGE);
    expect(r.json.totals.byStatus).toMatchObject({ new: 1, matches: 1, no_execution: 1 });
  });

  it("다음 페이지가 있으면 추가 호출 없이 불완전으로 알린다", async () => {
    kisFetch = vi.fn(async () => okKis({ ctx_area_fk100: "FK", ctx_area_nk100: "NK" }, "M"));
    const r = await call(RANGE);
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(r.json.query).toMatchObject({ complete: false, unreadPages: true });
    expect(r.json.approval.blockers.map((b: any) => b.code)).toContain("query_incomplete");
    expect(r.json.apiCrossCheck).toBeNull();
  });

  it("3개월 경계를 가로지르면 구간별로 GET 하고 TR_ID 가 다르다", async () => {
    const r = await call({ start: "2026-07-10", end: "2026-09-30" });
    expect(r.status).toBe(200);
    const trIds = kisFetch.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>).map((h) => h.tr_id);
    expect(new Set(trIds)).toEqual(new Set(["TTTC0081R", "CTSC9215R"]));
    expect(r.json.query.windows).toBe(2);
  });

  it("실제 0건(빈 배열)은 empty 로 표시하고 응답 부재와 구분한다", async () => {
    kisFetch = vi.fn(async () => okKis({ output1: [], output2: undefined }));
    const r = await call(RANGE);
    expect(r.json.query.listState).toBe("empty");
    expect(r.json.entries).toEqual([]);
    kisFetch = vi.fn(async () => okKis({ output1: undefined }));
    const r2 = await call(RANGE);
    expect(r2.json.query.listState).toBe("list_absent");
  });

  it("원장 저장소를 읽을 수 없으면 ledger_unavailable — 대조 없이 신규로 표시하지 않는다", async () => {
    ledgerError = true;
    const r = await call(RANGE);
    expect(r.json).toEqual({ state: "ledger_unavailable" });
    expect(kisFetch).not.toHaveBeenCalled();
  });
});

describe("실패 처리 — 재시도 · 기록 없음", () => {
  it("KIS 오류는 분류해 돌려주고 한 번만 호출한다", async () => {
    kisFetch = vi.fn(async () => new Response(JSON.stringify({ rt_cd: "2", msg_cd: "OPSQ2000", msg1: "ERROR : INPUT INVALID_CHECK_ACNO" }), { status: 200 }));
    const r = await call(RANGE);
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(r.json.state).toBe("query_failed");
    expect(r.json.failure.kind).toBe("account");
    expect(dbWrites()).toEqual([]);
  });

  it("네트워크 오류도 재시도하지 않는다", async () => {
    kisFetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const r = await call(RANGE);
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(r.json.failure.kind).toBe("network");
  });

  it("토큰 발급 실패는 auth 로 분류하고 조회하지 않는다 (메시지에 비밀값이 섞여도 응답에 없다)", async () => {
    getToken.mockRejectedValueOnce(new Error(`token fail ${APPKEY} ${APPSECRET} ${CANO}`));
    const r = await call(RANGE);
    expect(r.json.failure.kind).toBe("auth");
    expect(kisFetch).not.toHaveBeenCalled();
    for (const s of [APPKEY, APPSECRET, CANO]) expect(r.text).not.toContain(s);
  });

  it("실패 응답에 섞인 계좌번호 · 키 · 토큰이 응답에 남지 않는다", async () => {
    kisFetch = vi.fn(async () => new Response(JSON.stringify({ rt_cd: "2", msg_cd: "OPSQ2000", msg1: `ERR ${CANO} ${APPKEY} ${TOKEN}` }), { status: 200 }));
    const r = await call(RANGE);
    for (const s of [CANO, APPKEY, APPSECRET, TOKEN]) expect(r.text).not.toContain(s);
  });
});

describe("민감정보 · 쓰기 없음", () => {
  it("성공 응답 어디에도 계좌번호 · 키 · 토큰 · 주문번호 전체가 없다 (끝 4자리만)", async () => {
    ledgerRows = [ledgerTx({})];
    const r = await call(RANGE);
    for (const s of [CANO, APPKEY, APPSECRET, TOKEN, "0000006700", "0000001700", "0000000700", F, P]) {
      expect(r.text).not.toContain(s);
    }
    expect(r.text).toContain("6700");
  });

  it("DB 쓰기 · RPC 호출이 한 번도 없다 (성공 · 실패 · 차단 모두)", async () => {
    ledgerRows = [ledgerTx({})];
    await call(RANGE);
    kisFetch = vi.fn(async () => { throw new TypeError("x"); });
    await call(RANGE);
    registryData = [calcOnly];
    await call(RANGE);
    expect(dbWrites()).toEqual([]);
  });

  it("콘솔에 아무것도 남기지 않는다", async () => {
    const spy = vi.spyOn(console, "log"); const spyE = vi.spyOn(console, "error"); const spyW = vi.spyOn(console, "warn");
    ledgerRows = [ledgerTx({})];
    await call(RANGE);
    kisFetch = vi.fn(async () => new Response(JSON.stringify({ rt_cd: "2", msg1: `x ${CANO}` }), { status: 200 }));
    await call(RANGE);
    const out = [...spy.mock.calls, ...spyE.mock.calls, ...spyW.mock.calls].flat().map(String).join("\n");
    for (const s of [CANO, APPKEY, TOKEN]) expect(out).not.toContain(s);
    spy.mockRestore(); spyE.mockRestore(); spyW.mockRestore();
  });
});

describe("소스 불변식", () => {
  const src = readFileSync(fileURLToPath(new URL("./kis-execution-server.ts", import.meta.url)), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("쓰기 · 주문 · 로그 코드가 없다", () => {
    expect(code).not.toMatch(/\.(insert|upsert|update|delete)\(|\.rpc\(|order-cash|console\./);
  });
  it("원장 행 매핑이 도메인 모양으로 바뀐다", () => {
    const t = ledgerRowToTransaction(ledgerTx({ quantity: "12", amount: "1,0" }));
    expect(t).toMatchObject({ accountId: "pension", side: "buy", quantity: 12, source: "miraeasset_transaction_history" });
  });
  it("server.ts 는 POST 경로만 연결한다", () => {
    const server = readFileSync(fileURLToPath(new URL("../../server.ts", import.meta.url)), "utf8");
    expect(server).toMatch(/\/api\/kis\/executions\/preview" && request\.method === "POST"/);
  });
});
