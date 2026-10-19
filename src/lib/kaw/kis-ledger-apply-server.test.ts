/**
 * POST /api/kis/executions/apply — 한국투자 체결 → 거래원장 반영 핸들러 (Phase 4-C-2)
 *
 * 지키는 것:
 *   1. 인증·소유권 → 명시적 승인 → 서버 플래그 순서. 앞 단계가 막히면 DB 도 KIS 도 건드리지 않는다
 *   2. 승인 직전에 KIS 체결을 다시 조회하고 최신 원장으로 다시 판정한다
 *   3. 사용자가 승인한 계획 해시와 다르면 반영하지 않고 새 계획을 돌려준다
 *   4. 쓰기는 RPC 한 번뿐이다 (insert/update/upsert/delete 없음). 페이로드는 서버가 만든다 — 클라이언트 값을 쓰지 않는다
 *   5. RPC 결과가 applied 가 아니면 성공으로 안내하지 않는다 (already_applied · 불일치 · 함수 없음 · 23505)
 *   6. 동시 요청·재시도에서도 RPC 는 한 번만 나간다
 *   7. 응답에 계좌번호 · 키 · 토큰 · 전체 주문번호가 없다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase — 읽기/쓰기/RPC 를 모두 기록한다 ──────────────────────────
const calls: string[] = [];
const rpcCalls: Array<{ name: string; args: Record<string, any> }> = [];
let ledgerRows: Record<string, unknown>[] = [];
let registryData: unknown = [];
let cashflows: unknown[] = [];
let auditRows: Array<{ new_value: unknown }> = [];
let obsRows: Record<string, unknown>[] = [];
let corrRows: Record<string, unknown>[] = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: { status: "applied", inserted: 2, batch_id: "B", holdings_after: { "360750": 230, "367380": 64 } }, error: null };
let latencyMs = 0;
const lag = () => (latencyMs > 0 ? new Promise<void>((r) => setTimeout(r, latencyMs)) : Promise.resolve());

const fakeClient = {
  rpc: (name: string, args: Record<string, any>) => {
    calls.push(`RPC:${name}`);
    rpcCalls.push({ name, args });
    return lag().then(() => rpcResult);
  },
  from: (table: string) => {
    const ret = (): unknown => {
      if (table === "kaw_transaction_ledger") return { data: ledgerRows, error: null };
      if (table === "kaw_transaction_correction") return { data: corrRows, error: null };
      if (table === "kaw_ledger_audit") return { data: auditRows, error: null };
      if (table === "kaw_settlement_observation") return { data: obsRows, error: null };
      return { data: [], error: null };
    };
    if (table === "kaw_data") {
      return {
        select: () => {
          const f: Record<string, string> = {};
          const c: Record<string, unknown> = {
            eq: (k: string, v: string) => { f[k] = v; return c; },
            maybeSingle: async () => {
              calls.push(`read:kaw_data:${f.account_type}`);
              if (f.account_type === "_meta") return { data: { data: { brokerAccounts: registryData } }, error: null };
              if (f.account_type === "pension") return { data: { data: { cashflows } }, error: null };
              return { data: null, error: null };
            },
          };
          return c;
        },
        insert: () => { calls.push("WRITE:insert:kaw_data"); return Promise.resolve({ error: null }); },
        upsert: () => { calls.push("WRITE:upsert:kaw_data"); return Promise.resolve({ error: null }); },
        update: () => { calls.push("WRITE:update:kaw_data"); return Promise.resolve({ error: null }); },
        delete: () => { calls.push("WRITE:delete:kaw_data"); return Promise.resolve({ error: null }); },
      };
    }
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => { calls.push(`read:${table}`); return ret(); };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { calls.push(`read:${table}`); return lag().then(() => ret()).then(res, rej); };
    for (const m of ["insert", "upsert", "update", "delete"]) chain[m] = () => { calls.push(`WRITE:${m}:${table}`); return chain; };
    return chain;
  },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleKisLedgerApply } = await import("./kis-ledger-apply-server");
const { ledgerRowToTransaction } = await import("./kis-execution-server");
const { validateTransferConfirm } = await import("./account-transfer-record");
const { kisExecutionFingerprint } = await import("./kis-execution-preview");

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

const baseEnv = { SESSION_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
const fullEnv = {
  ...baseEnv, KIS_ACCOUNT_APP_KEY: APPKEY, KIS_ACCOUNT_APP_SECRET: APPSECRET, KIS_ACCOUNT_CANO: CANO,
  KIS_ACCOUNT_OWNER_FAMILY_CODE: F, KIS_ACCOUNT_OWNER_PROFILE: P, KIS_LEDGER_APPLY_ENABLED: "on",
};
const kisInstance = { id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const miraeInstance = { id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const dbTx = (over: Record<string, unknown>) => ({
  id: "t1", account_type: "pension", ticker: "360750", etf_name: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  trade_date: null, settlement_date: "2026-10-07", inferred_trade_date: "2026-10-02", event_date: "2026-10-02",
  trade_date_evidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, post_quantity: null, source: "miraeasset_capture_qty_price_reconstructed", import_batch_id: "imp:v2", ...over,
});
const proxy = { source: "user_attested_liquidation_price_proxy", import_batch_id: "imp:proxy", event_date: "2026-10-13", inferred_trade_date: null, settlement_date: null, fee: null, tax: null, post_quantity: 0, trade_date_evidence: "user-attested-full-liquidation; exact-sale-date-unknown" };
const LEDGER = () => [
  dbTx({ id: "b1" }),
  dbTx({ id: "b2", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
  dbTx({ id: "s1", side: "sell", ...proxy }),
  dbTx({ id: "s2", side: "sell", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...proxy }),
];
const OBS_ROW = {
  id: "obs:cap:bai:kis-pension:2026-10-19:abc:kis_inquire_balance", capture_id: "cap:bai:kis-pension:2026-10-19:abc",
  account_type: "pension", broker: "kis", broker_product_code: "22", account_instance_id: "bai:kis-pension", account_ref_fingerprint: null,
  observed_at: "2026-10-19T06:00:00+00:00", state_as_of: "2026-10-19", state_as_of_basis: "observation_date", settlement_basis: "settlement",
  source_type: "kis_inquire_balance", holdings: { "360750": 230, "367380": 64 }, holdings_completeness: "unknown", cash: "2318828",
  acquisition_cost: null, account_total: null, capture_payload_hash: "c1|x", hash_version: 1, note: null, actor: P,
};

function transferAuditRow() {
  const v = validateTransferConfirm(
    { toInstanceId: kisInstance.id, fromInstanceId: miraeInstance.id, anchorDate: "2026-10-13", cashReceived: { amount: 10_293_793 }, exitTxIds: ["s1", "s2"], approved: true },
    { registry: [miraeInstance as never, kisInstance as never], ledger: LEDGER().map(ledgerRowToTransaction), existing: [],
      observation: { captureId: OBS_ROW.capture_id, stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" }, today: "2026-10-19", actor: P, nowIso: "2026-10-19T08:57:45.000Z" },
  );
  if (!v.ok) throw new Error(v.message);
  return { new_value: v.record };
}

const rowRaw = (over: Record<string, unknown>) => ({
  ord_dt: "20261014", odno: "0000000001", orgn_odno: "", sll_buy_dvsn_cd: "02", pdno: "360750", prdt_name: "TIGER 미국S&P500",
  ord_qty: "230", ord_unpr: "25985", ord_tmd: "133636", tot_ccld_qty: "230", avg_prvs: "25985", cncl_yn: "",
  tot_ccld_amt: "5976550", rmn_qty: "0", rjct_qty: "0", ...over,
});
const OUT1 = [
  rowRaw({ odno: "0000000700", tot_ccld_qty: "0", avg_prvs: "0", tot_ccld_amt: "0" }),
  rowRaw({ odno: "0000001700", pdno: "367380", prdt_name: "ACE 미국나스닥100", ord_qty: "64", tot_ccld_qty: "64", avg_prvs: "31220", tot_ccld_amt: "1998080" }),
  rowRaw({ odno: "0000006700", orgn_odno: "0000000700" }),
];
const okKis = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    rt_cd: "0", msg_cd: "KIOK0510", msg1: "조회가 완료되었습니다", ctx_area_fk100: "", ctx_area_nk100: "", output1: OUT1,
    output2: { tot_ord_qty: "294", tot_ccld_qty: "294", tot_ccld_amt: "7974630", pchs_avg_pric: "27124.59", prsm_tlex_smtl: "0" }, ...over,
  }), { status: 200, headers: { "content-type": "application/json", tr_cont: "E" } });

let kisFetch: ReturnType<typeof vi.fn>;
const getToken = vi.fn(async () => TOKEN);
const RANGE = { start: "2026-10-14", end: "2026-10-19" };

async function call(body: unknown, env: Record<string, unknown> = fullEnv, opts: { token?: string | null } = {}) {
  const token = opts.token === undefined ? await sessionToken() : opts.token;
  const req = new Request("https://x/api/kis/executions/apply", {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleKisLedgerApply(req, env as never, { fetchImpl: kisFetch as never, getToken: getToken as never, today: () => "2026-10-19" });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const featureCalls = () => calls.filter((c) => !c.endsWith(":_family"));
const dbWrites = () => calls.filter((c) => c.startsWith("WRITE:"));

/** 사용자가 본 계획 해시를 얻는다: 형식만 맞는 가짜 해시로 호출하면 서버가 새 계획을 돌려준다 */
async function currentHash(): Promise<string> {
  const r = await call({ ...RANGE, planHash: "k1|0000", approved: true });
  expect(r.json.code).toBe("plan_changed");
  const h = r.json.plan.planHash as string;
  calls.length = 0; rpcCalls.length = 0; kisFetch.mockClear(); getToken.mockClear();
  return h;
}

beforeEach(() => {
  calls.length = 0; rpcCalls.length = 0; latencyMs = 0;
  ledgerRows = LEDGER(); registryData = [miraeInstance, kisInstance]; cashflows = [{ date: "2025-11-10", amount: 10_500_000 }];
  auditRows = [transferAuditRow()]; obsRows = [OBS_ROW]; corrRows = [];
  rpcResult = { data: { status: "applied", inserted: 2, batch_id: "B", holdings_after: { "360750": 230, "367380": 64 } }, error: null };
  kisFetch = vi.fn(async () => okKis());
  getToken.mockClear();
});

describe("인증 · 승인 · 플래그 — 앞 단계가 막히면 아무것도 건드리지 않는다", () => {
  it("세션이 없으면 401, 소유자가 아니면 403 — DB · KIS 접근 없음", async () => {
    expect((await call({ ...RANGE, planHash: "k1|0", approved: true }, fullEnv, { token: null })).status).toBe(401);
    const other = await sessionToken("other-family", P);
    expect((await call({ ...RANGE, planHash: "k1|0", approved: true }, fullEnv, { token: other })).status).toBe(403);
    const otherProfile = await sessionToken(F, "other-profile");
    expect((await call({ ...RANGE, planHash: "k1|0", approved: true }, fullEnv, { token: otherProfile })).status).toBe(403);
    expect(featureCalls()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
  });

  it("승인(approved: true)이 없으면 400 — 읽지도 KIS 를 부르지도 쓰지도 않는다", async () => {
    for (const approved of [undefined, false, "true", 1, null]) {
      const r = await call({ ...RANGE, planHash: "k1|0", approved });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("approval_required");
    }
    expect(featureCalls()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("요청 모양이 틀리면 400 (기간 · 계획 해시 형식)", async () => {
    for (const bad of [{ ...RANGE, planHash: "nope", approved: true }, { start: "x", end: RANGE.end, planHash: "k1|0", approved: true }, { start: "2026-10-20", end: "2026-10-19", planHash: "k1|0", approved: true }, { start: "2026-01-01", end: "2026-10-19", planHash: "k1|0", approved: true }, "not json"]) {
      expect((await call(bad)).status).toBe(400);
    }
    expect(featureCalls()).toEqual([]);
  });

  it("서버 플래그가 꺼져 있으면 403 apply_disabled — KIS · DB 를 건드리지 않는다 (기본 꺼짐)", async () => {
    const { KIS_LEDGER_APPLY_ENABLED: _f, ...off } = fullEnv;
    const r = await call({ ...RANGE, planHash: "k1|0", approved: true }, off);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("apply_disabled");
    for (const v of ["ON", "true", "1", "yes", ""]) {
      expect((await call({ ...RANGE, planHash: "k1|0", approved: true }, { ...fullEnv, KIS_LEDGER_APPLY_ENABLED: v })).json.code).toBe("apply_disabled");
    }
    expect(featureCalls()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("계좌용 credential 이 없으면 503 — 시세용 키로 대체하지 않는다", async () => {
    const { KIS_ACCOUNT_APP_KEY: _k, KIS_ACCOUNT_APP_SECRET: _s, ...rest } = fullEnv;
    const r = await call({ ...RANGE, planHash: "k1|0", approved: true }, { ...rest, KIS_APP_KEY: "market", KIS_APP_SECRET: "market" });
    expect(r.status).toBe(503);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });
});

describe("재검증 → 반영 — 정상 경로", () => {
  it("승인한 계획과 지금 계산한 계획이 같으면 RPC 를 한 번 호출하고 applied 로 응답한다", async () => {
    const hash = await currentHash();
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("applied");
    expect(r.json.inserted).toBe(2);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("kaw_kis_execution_apply");
  });

  it("승인 직전에 KIS 체결을 다시 조회한다 (미리보기 결과를 믿지 않는다)", async () => {
    const hash = await currentHash();
    await call({ ...RANGE, planHash: hash, approved: true });
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("RPC 페이로드는 서버가 세션 값으로 만든다 — 가족 · 프로필 · 행 · 기대 보유 · 승인 감사", async () => {
    const hash = await currentHash();
    await call({ ...RANGE, planHash: hash, approved: true, family_code: "evil", profile: "evil", rows: [{ evil: 1 }], p_rows: [{ evil: 1 }] });
    const a = rpcCalls[0].args;
    expect(a.p_family_code).toBe(F);
    expect(a.p_profile).toBe(P);
    expect(a.p_rows).toHaveLength(2);
    expect(JSON.stringify(a)).not.toContain("evil");
    for (const row of a.p_rows) {
      expect(row).toMatchObject({ source: "kis_api_daily_ccld", side: "buy", account_type: "pension", fee: null, tax: null, post_quantity: null, fingerprint_version: 2, import_batch_id: a.p_batch.id });
      expect(row.family_code).toBeUndefined();
    }
    expect(a.p_rows.map((r: any) => r.quantity).sort((x: number, y: number) => x - y)).toEqual([64, 230]);
    expect(a.p_expect).toMatchObject({ instance_id: "bai:kis-pension", holdings_after: { "360750": 230, "367380": 64 } });
    expect(a.p_audit.actor).toBe(P);
    expect(a.p_audit.note).toContain(hash);
    expect(a.p_audit.new_value).toMatchObject({ planHash: hash, createsCashflow: false, principal: { before: 10_500_000, after: 10_500_000, unchanged: true } });
    expect(a.p_batch).toMatchObject({ source_kind: "kis_api", source_checksum: hash, inserted_count: 2 });
  });

  it("체결 0주 주문은 페이로드에 없다 (3건 조회 → 2건 반영)", async () => {
    const hash = await currentHash();
    await call({ ...RANGE, planHash: hash, approved: true });
    expect(rpcCalls[0].args.p_rows).toHaveLength(2);
    expect(JSON.stringify(rpcCalls[0].args.p_rows)).not.toContain("0000000700");
  });

  it("이 핸들러는 RPC 외에 어떤 DB 쓰기도 하지 않는다 (원장 · kaw_data · cashflow)", async () => {
    const hash = await currentHash();
    await call({ ...RANGE, planHash: hash, approved: true });
    expect(dbWrites()).toEqual([]);
    expect(calls.filter((c) => c.startsWith("RPC:"))).toEqual(["RPC:kaw_kis_execution_apply"]);
  });
});

describe("승인한 계획과 다르면 반영하지 않는다", () => {
  it("그 사이 관측이 바뀌었으면 plan_changed — RPC 호출 없음, 새 계획을 돌려준다", async () => {
    const hash = await currentHash();
    obsRows = [{ ...OBS_ROW, capture_id: "cap:changed", id: "obs:cap:changed:kis_inquire_balance" }];
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("plan_changed");
    expect(r.json.plan.planHash).not.toBe(hash);
    expect(rpcCalls).toEqual([]);
  });

  it("그 사이 KIS 체결이 바뀌었으면(금액) plan_changed", async () => {
    const hash = await currentHash();
    kisFetch = vi.fn(async () => okKis({ output1: [OUT1[0], OUT1[1], rowRaw({ odno: "0000006700", orgn_odno: "0000000700", tot_ccld_qty: "229", ord_qty: "229", tot_ccld_amt: String(229 * 25985) })], output2: { tot_ord_qty: "293", tot_ccld_qty: "293", tot_ccld_amt: String(229 * 25985 + 1998080), prsm_tlex_smtl: "0" } }));
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    // 관측 보유(230)와 달라져 조건 자체가 어긋난다 — 어느 쪽이든 반영하지 않는다
    expect([r.json.code]).toContain("not_eligible");
    expect(rpcCalls).toEqual([]);
  });

  it("조건을 만족하지 않으면 not_eligible + 차단 사유 목록 — RPC 호출 없음", async () => {
    const hash = await currentHash();
    ledgerRows = LEDGER().filter((t) => t.id !== "s1" && t.id !== "s2"); // 이탈 근거 없음
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("not_eligible");
    expect(r.json.blockers.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(["prior_residual"]));
    expect(rpcCalls).toEqual([]);
  });

  it("이전 확정 기록이 없으면 not_eligible (transfer_unconfirmed)", async () => {
    const hash = await currentHash();
    auditRows = [];
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.json.code).toBe("not_eligible");
    expect(r.json.blockers.map((b: { code: string }) => b.code)).toContain("transfer_unconfirmed");
    expect(rpcCalls).toEqual([]);
  });

  it("KIS 재조회가 실패하면 query_failed — 반영하지 않고 재시도하지 않는다", async () => {
    const hash = await currentHash();
    kisFetch = vi.fn(async () => new Response(JSON.stringify({ rt_cd: "1", msg_cd: "OPSQ2000", msg1: "ERROR : INPUT INVALID_CHECK_ACNO" }), { status: 200, headers: { "content-type": "application/json" } }));
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.json.state).toBe("query_failed");
    expect(kisFetch).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([]);
  });
});

describe("RPC 결과 — applied 가 아니면 성공으로 안내하지 않는다", () => {
  const body = async () => ({ ...RANGE, planHash: await currentHash(), approved: true });

  it("already_applied (멱등) → 409 already_applied, state 는 applied 가 아니다", async () => {
    const b = await body();
    rpcResult = { data: { status: "already_applied", inserted: 0, batch_id: "B" }, error: null };
    const r = await call(b);
    expect(r.status).toBe(409);
    expect(r.json.state).toBe("rejected");
    expect(r.json.code).toBe("already_applied");
    expect(r.json.inserted).toBeUndefined();
  });

  it("DB 가 반영 후 보유 불일치로 롤백하면 409 holdings_mismatch", async () => {
    const b = await body();
    rpcResult = { data: null, error: { code: "P0001", message: "KAW_KIS_APPLY:holdings_mismatch" } };
    const r = await call(b);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("holdings_mismatch");
    expect(r.json.message).toContain("아무것도 기록하지 않았습니다");
    expect(r.json.state).toBe("rejected");
  });

  it.each(["transfer_unconfirmed", "prior_residual", "corrections_present", "partial_conflict", "invalid_row", "invalid_input"])("DB 사전 조건 %s → 409 로 그대로 알린다", async (code) => {
    const b = await body();
    rpcResult = { data: null, error: { code: "P0001", message: `KAW_KIS_APPLY:${code}` } };
    const r = await call(b);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe(code);
  });

  it("함수가 없으면(migration 012 미적용) 503 apply_unavailable — 다른 경로로 우회하지 않는다", async () => {
    const b = await body();
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.kaw_kis_execution_apply in the schema cache" } };
    const r = await call(b);
    expect(r.status).toBe(503);
    expect(r.json.state).toBe("apply_unavailable");
    expect(dbWrites()).toEqual([]);
  });

  it("DB 유니크 충돌(23505)은 already_applied 로 처리한다", async () => {
    const b = await body();
    rpcResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const r = await call(b);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("already_applied");
  });

  it("알 수 없는 오류는 500 write_failed — 성공이 아니다", async () => {
    const b = await body();
    rpcResult = { data: null, error: { code: "XX000", message: "boom" } };
    const r = await call(b);
    expect(r.status).toBe(500);
    expect(r.json.state).toBe("write_failed");
    expect(r.json.inserted).toBeUndefined();
  });
});

describe("동시 요청 · 재시도", () => {
  it("같은 반영 요청을 동시에 두 번 보내도 RPC 는 한 번만 나간다", async () => {
    const hash = await currentHash();
    latencyMs = 5;
    const [a, b] = await Promise.all([
      call({ ...RANGE, planHash: hash, approved: true }),
      call({ ...RANGE, planHash: hash, approved: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.code).toBe("busy");
    expect(rpcCalls).toHaveLength(1);
    expect(kisFetch).toHaveBeenCalledTimes(1);
  });

  it("서로 다른 서버 인스턴스에서 동시에 보내도 DB 함수가 한 번만 반영한다 (RPC 는 둘 다 나가지만 두 번째는 already_applied)", async () => {
    const hash = await currentHash();
    latencyMs = 5;
    let first = true;
    const orig = fakeClient.rpc;
    fakeClient.rpc = (name: string, args: Record<string, any>) => {
      const res = orig(name, args);
      if (first) { first = false; return res; }
      return res.then(() => ({ data: { status: "already_applied", inserted: 0, batch_id: "B" }, error: null }));
    };
    vi.resetModules();
    const second = await import("./kis-ledger-apply-server");
    try {
      const [a, b] = await Promise.all([
        call({ ...RANGE, planHash: hash, approved: true }),
        (async () => {
          const token = await sessionToken();
          const res = await second.handleKisLedgerApply(new Request("https://x/api/kis/executions/apply", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...RANGE, planHash: hash, approved: true }) }), fullEnv as never, { fetchImpl: kisFetch as never, getToken: getToken as never, today: () => "2026-10-19" });
          return { status: res.status, json: (await res.json()) as Record<string, any> };
        })(),
      ]);
      const states = [a.json.state, b.json.state].sort();
      expect(states).toEqual(["applied", "rejected"]);
      expect([a, b].find((x) => x.json.state === "rejected")!.json.code).toBe("already_applied");
    } finally { fakeClient.rpc = orig; }
  });

  it("끝난 뒤에는 잠금이 풀려 다음 요청을 받을 수 있다", async () => {
    const hash = await currentHash();
    expect((await call({ ...RANGE, planHash: hash, approved: true })).status).toBe(200);
    rpcResult = { data: { status: "already_applied", inserted: 0, batch_id: "B" }, error: null };
    expect((await call({ ...RANGE, planHash: hash, approved: true })).json.code).toBe("already_applied");
  });
});

describe("응답 안전성 · 소스 보증", () => {
  it("응답에 계좌번호 · 키 · 토큰 · 전체 주문번호가 없다", async () => {
    const hash = await currentHash();
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    for (const secret of [CANO, APPKEY, APPSECRET, TOKEN, "0000006700", "0000001700"]) expect(r.text).not.toContain(secret);
    const changed = await call({ ...RANGE, planHash: "k1|0000", approved: true });
    for (const secret of [CANO, APPKEY, APPSECRET, TOKEN, "0000006700", "0000001700"]) expect(changed.text).not.toContain(secret);
  });

  const src = readFileSync(fileURLToPath(new URL("./kis-ledger-apply-server.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("쓰기는 RPC 한 곳뿐이다 — insert/update/upsert/delete 가 없다", () => {
    expect([...src.matchAll(/\.rpc\(/g)]).toHaveLength(1);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/order-cash|placeCashBuyOrder|cancel/i);
  });

  it("순서: 승인 · 플래그 확인이 읽기 · KIS 호출보다 앞선다", () => {
    const ix = (t: string) => src.indexOf(t);
    expect(ix("body.approved !== true")).toBeGreaterThan(-1);
    expect(ix("body.approved !== true")).toBeLessThan(ix("isLedgerApplyEnabled(env)"));
    expect(ix("isLedgerApplyEnabled(env)")).toBeLessThan(ix("readBundle("));
    expect(ix("readBundle(")).toBeLessThan(ix("queryKisExecutions("));
    expect(ix("queryKisExecutions(")).toBeLessThan(ix("apply.plan.planHash !== planHash"));
    expect(ix("apply.plan.planHash !== planHash")).toBeLessThan(ix(".rpc("));
  });
});

// ── 최종 보안 점검 보강 ─────────────────────────────────────────────────────────
describe("승인 직전 재검증은 실제 KIS 주문번호와 계좌 instance 를 쓴다", () => {
  it("RPC 로 가는 fingerprint 는 방금 재조회한 주문번호 · 주문일 · 등록된 한국투자 instance 로 만들어진다 (클라이언트 값 아님)", async () => {
    const hash = await currentHash();
    await call({ ...RANGE, planHash: hash, approved: true, instance: "bai:evil", orderNo: "9999999999", fingerprint: "v2|evil" });
    const fps = rpcCalls[0].args.p_rows.map((r: { source_fingerprint: string }) => r.source_fingerprint).sort();
    expect(fps).toEqual([
      kisExecutionFingerprint("bai:kis-pension", "20261014", "0000001700"),
      kisExecutionFingerprint("bai:kis-pension", "20261014", "0000006700"),
    ].sort());
    expect(JSON.stringify(rpcCalls[0].args)).not.toMatch(/evil|9999999999/);
    expect(rpcCalls[0].args.p_expect.instance_id).toBe("bai:kis-pension");
  });

  it("승인한 뒤 증권사 주문번호가 달라졌으면(정정 재주문 등) 계획 해시가 달라져 반영하지 않는다", async () => {
    const hash = await currentHash();
    kisFetch = vi.fn(async () => okKis({ output1: [OUT1[0], OUT1[1], rowRaw({ odno: "0000007777", orgn_odno: "0000000700" })] }));
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("plan_changed");
    expect(rpcCalls).toEqual([]);
  });

  it("등록되지 않은 계좌 instance(한국투자 계좌 없음)면 반영하지 않는다", async () => {
    const hash = await currentHash();
    registryData = [miraeInstance];
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.json.state).toBe("gate_blocked");
    expect(rpcCalls).toEqual([]);
  });
});

describe("관측 증거 — 불완전하거나 거래일보다 이전이면 쓰지 않는다", () => {
  it("보유 목록이 일부만 읽힌 관측(partial)이면 not_eligible", async () => {
    const hash = await currentHash();
    obsRows = [{ ...OBS_ROW, holdings_completeness: "partial" }];
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.json.code).toBe("not_eligible");
    expect(r.json.blockers.map((b: { code: string }) => b.code)).toContain("observation_incomplete");
    expect(rpcCalls).toEqual([]);
  });

  it("체결일(10-14)보다 이전 기준일의 관측은 증거로 쓰지 않는다 (observation_stale)", async () => {
    const hash = await currentHash();
    obsRows = [{ ...OBS_ROW, state_as_of: "2026-10-13", observed_at: "2026-10-13T06:00:00+00:00" }];
    const r = await call({ ...RANGE, planHash: hash, approved: true });
    expect(r.json.code).toBe("not_eligible");
    expect(r.json.blockers.map((b: { code: string }) => b.code)).toContain("observation_stale");
    expect(rpcCalls).toEqual([]);
  });

  it("보유가 비어 있는(null) 관측이나 관측이 없으면 쓰지 않는다", async () => {
    const hash = await currentHash();
    obsRows = [{ ...OBS_ROW, holdings: null }];
    expect((await call({ ...RANGE, planHash: hash, approved: true })).json.blockers.map((b: { code: string }) => b.code)).toContain("observation_missing");
    obsRows = [];
    expect((await call({ ...RANGE, planHash: hash, approved: true })).json.blockers.map((b: { code: string }) => b.code)).toContain("observation_missing");
    expect(rpcCalls).toEqual([]);
  });
});

describe("기능 플래그 OFF — 유효한 계획 해시가 있어도 RPC · 원장 · batch · audit 쓰기가 전혀 없다", () => {
  it.each([undefined, "", "off", "ON", "true", "1", "yes", " on", "on "])("KIS_LEDGER_APPLY_ENABLED=%j", async (v) => {
    const hash = await currentHash(); // 플래그를 켠 상태에서 얻은 유효한 해시
    const env = { ...fullEnv } as Record<string, unknown>;
    if (v === undefined) delete env.KIS_LEDGER_APPLY_ENABLED; else env.KIS_LEDGER_APPLY_ENABLED = v;
    const r = await call({ ...RANGE, planHash: hash, approved: true }, env);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("apply_disabled");
    expect(rpcCalls).toEqual([]);
    expect(featureCalls()).toEqual([]);          // 읽기도 쓰기도 RPC 도 없다
    expect(dbWrites()).toEqual([]);
    expect(kisFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("실주문 관련 플래그는 이 핸들러가 읽지도 쓰지도 않는다", () => {
    const src = readFileSync(fileURLToPath(new URL("./kis-ledger-apply-server.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/KIS_ORDER_ENABLED|KIS_ORDER_DISMISS_ENABLED|KAW_REQUIRE_REVISION/);
    const env = readFileSync(fileURLToPath(new URL("../../server.ts", import.meta.url)), "utf8");
    // 반영 플래그는 주문 플래그와 별개 이름이다
    expect(env).toContain("KIS_LEDGER_APPLY_ENABLED");
    expect(env).not.toMatch(/KIS_LEDGER_APPLY_ENABLED\s*[:=]\s*"on"/);
  });
});
