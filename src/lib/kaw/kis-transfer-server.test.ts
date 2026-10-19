/**
 * 계좌 이전 확정 · 잔고 관측 기록 핸들러 (Phase 4-C-1)
 *
 * 지키는 것:
 *   1. 승인(approved: true)이 없으면 DB 쓰기도 KIS 호출도 없다
 *   2. 권한이 없으면 DB 에 접근하지 않는다
 *   3. 쓰기는 정확히 두 곳 — kaw_settlement_observation 1행 / kaw_ledger_audit 1행. 원장 · cashflow · kaw_data 는 쓰지 않는다
 *   4. 증거가 부족하면 거부하고 아무것도 쓰지 않는다 (관측 없음 · 이탈 미완료 · 이미 확정)
 *   5. 계좌번호 · 키 · 토큰이 응답에 없다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase — 읽기/쓰기를 모두 기록한다 ───────────────────────────────
const calls: string[] = [];
const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
let ledgerRows: Record<string, unknown>[] = [];
let registryData: unknown = [];
let cashflows: unknown[] = [];
let auditRows: Array<{ new_value: unknown }> = [];
let obsRows: Record<string, unknown>[] = [];
let obsInsertError: { code: string } | null = null;
// 실제 DB 왕복처럼 응답을 한 턴 늦춘다 — 동시 요청이 겹치는 상황을 재현한다 (0 이면 즉시)
let dbLatencyMs = 0;
const lag = () => (dbLatencyMs > 0 ? new Promise<void>((r) => setTimeout(r, dbLatencyMs)) : Promise.resolve());

const fakeClient = {
  rpc: () => { calls.push("rpc"); return Promise.resolve({ data: null, error: null }); },
  from: (table: string) => {
    const ret = (): unknown => {
      if (table === "kaw_transaction_ledger") return { data: ledgerRows, error: null };
      if (table === "kaw_transaction_correction") return { data: [], error: null };
      if (table === "kaw_ledger_audit") return { data: auditRows, error: null };
      if (table === "kaw_settlement_observation") return { data: obsRows, error: null };
      if (table === "kaw_settlement_observation_void") return { data: [], error: null };
      return { data: [], error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => {
      calls.push(`read:${table}`);
      const filters = (chain as { _f?: Record<string, string> })._f;
      void filters;
      if (table === "kaw_data") return { data: null, error: null };
      return ret();
    };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { calls.push(`read:${table}`); return lag().then(() => ret()).then(res, rej); };
    chain.insert = (row: Record<string, unknown>) => {
      calls.push(`WRITE:insert:${table}`);
      writes.push({ table, row });
      return lag().then(() => ({ error: table === "kaw_settlement_observation" ? obsInsertError : null }));
    };
    for (const m of ["upsert", "update", "delete"]) chain[m] = () => { calls.push(`WRITE:${m}:${table}`); return Promise.resolve({ error: null }); };
    if (table === "kaw_data") {
      // _meta(레지스트리) / pension(장부) / 세션 검증용 _family
      return {
        select: () => {
          const filters: Record<string, string> = {};
          const c: Record<string, unknown> = {
            eq: (k: string, v: string) => { filters[k] = v; return c; },
            maybeSingle: async () => {
              calls.push(`read:kaw_data:${filters.account_type}`);
              if (filters.account_type === "_meta") return { data: { data: { brokerAccounts: registryData } }, error: null };
              if (filters.account_type === "pension") return { data: { data: { cashflows } }, error: null };
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
    return chain;
  },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleTransferState, handleBalanceObserve, handleTransferConfirm } = await import("./kis-transfer-server");
const { buildKisObservation, resolveKisInstance } = await import("./kis-account-observe");

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

const fullEnv = {
  SESSION_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
  KIS_ACCOUNT_APP_KEY: APPKEY, KIS_ACCOUNT_APP_SECRET: APPSECRET, KIS_ACCOUNT_CANO: CANO,
  KIS_ACCOUNT_OWNER_FAMILY_CODE: F, KIS_ACCOUNT_OWNER_PROFILE: P,
};

const kisInstance = { id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const miraeInstance = { id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const ledgerTx = (over: Record<string, unknown>) => ({
  id: "t1", account_type: "pension", ticker: "360750", etf_name: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  trade_date: null, settlement_date: "2026-10-07", inferred_trade_date: "2026-10-02", event_date: "2026-10-02",
  trade_date_evidence: "tplus2-weekday-inference", fee: 0, tax: 0, post_quantity: null, source: "miraeasset_transaction_history", ...over,
});
const proxy = { source: "user_attested_liquidation_price_proxy", import_batch_id: "imp:user_approved_pension_liquidation_20261018", event_date: "2026-10-13", inferred_trade_date: null, settlement_date: null, fee: null, tax: null, post_quantity: 0, trade_date_evidence: "user-attested-full-liquidation; exact-sale-date-unknown" };
const fullLedger = () => [
  ledgerTx({ id: "b1" }),
  ledgerTx({ id: "b2", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
  ledgerTx({ id: "s1", side: "sell", ...proxy }),
  ledgerTx({ id: "s2", side: "sell", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...proxy }),
];

const obsRow = {
  id: "obs:cap:bai:kis-pension:2026-10-19:abc:kis_inquire_balance", capture_id: "cap:bai:kis-pension:2026-10-19:abc",
  account_type: "pension", broker: "kis", broker_product_code: "22", account_instance_id: "bai:kis-pension", account_ref_fingerprint: null,
  observed_at: "2026-10-19T06:00:00+00:00", state_as_of: "2026-10-19", state_as_of_basis: "observation_date", settlement_basis: "settlement",
  source_type: "kis_inquire_balance", holdings: { "360750": 230, "367380": 64 }, holdings_completeness: "unknown", cash: "2318828",
  acquisition_cost: null, account_total: null, capture_payload_hash: "c1|x", hash_version: 1, note: null, actor: P,
};

function snapshotRead() {
  return vi.fn(async (req: { registry: never[]; productCode: "22" }) => ({
    observation: buildKisObservation({
      productCode: "22", resolution: resolveKisInstance("22", req.registry, "2026-10-19"), stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z",
      balance: { ok: true, httpStatus: 200, rtCd: "0", holdings: [{ ticker: "360750", name: "TIGER", quantity: 230 }, { ticker: "367380", name: "ACE", quantity: 64 }], holdingsCount: 2, cash: 2_318_828, summary: {} },
    }),
    plan: {} as never,
  }));
}
let readAccount: ReturnType<typeof snapshotRead>;
const getToken = vi.fn(async () => TOKEN);
const deps = () => ({ readAccount: readAccount as never, getToken: getToken as never, today: () => "2026-10-19", now: () => new Date("2026-10-19T06:10:00.000Z") });

async function req(path: string, method: "GET" | "POST", body?: unknown, token?: string | null) {
  const t = token === undefined ? await sessionToken() : token;
  return new Request(`https://x${path}`, {
    method, headers: t ? { authorization: `Bearer ${t}` } : {},
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const run = async (h: (r: Request, e: never, d: never) => Promise<Response>, r: Request, env: Record<string, unknown> = fullEnv) => {
  const res = await h(r, env as never, deps() as never);
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
};
const featureCalls = () => calls.filter((c) => !c.endsWith(":_family"));
const dbWrites = () => calls.filter((c) => c.startsWith("WRITE:"));

beforeEach(() => {
  calls.length = 0; writes.length = 0;
  ledgerRows = fullLedger(); registryData = [miraeInstance, kisInstance]; cashflows = [{ date: "2025-11-10", amount: 10_500_000 }];
  auditRows = []; obsRows = []; obsInsertError = null; dbLatencyMs = 0;
  readAccount = snapshotRead(); getToken.mockClear();
});

const confirmBody = (over: Record<string, unknown> = {}) => ({
  toInstanceId: "bai:kis-pension", fromInstanceId: "bai:mirae-pension", anchorDate: "2026-10-13",
  cashReceived: { amount: 10_293_793, date: null }, exitTxIds: ["s1", "s2"], note: "확인", approved: true, ...over,
});

describe("권한", () => {
  it("세션이 없으면 401 이고 DB 에 접근하지 않는다", async () => {
    for (const [h, m] of [[handleTransferState, "GET"], [handleBalanceObserve, "POST"], [handleTransferConfirm, "POST"]] as const) {
      const r = await run(h as never, await req("/x", m, m === "POST" ? { approved: true } : undefined, null));
      expect(r.status).toBe(401);
    }
    expect(featureCalls()).toEqual([]);
  });

  it("소유자가 아니면 403 이고 DB · KIS 에 접근하지 않는다", async () => {
    const t = await sessionToken(F, "other-profile");
    for (const [h, m] of [[handleTransferState, "GET"], [handleBalanceObserve, "POST"], [handleTransferConfirm, "POST"]] as const) {
      const r = await run(h as never, await req("/x", m, m === "POST" ? confirmBody() : undefined, t));
      expect(r.status).toBe(403);
    }
    expect(featureCalls()).toEqual([]);
    expect(readAccount).not.toHaveBeenCalled();
  });
});

describe("다른 가족·다른 프로필·다른 계좌 — 조회도 기록도 할 수 없다", () => {
  it("소유 가족이 아닌 세션(같은 프로필 이름이어도)은 403 이고 DB 에 접근하지 않는다", async () => {
    const t = await sessionToken("other-family", P);
    for (const [h, m] of [[handleTransferState, "GET"], [handleBalanceObserve, "POST"], [handleTransferConfirm, "POST"]] as const) {
      const r = await run(h as never, await req("/x", m, m === "POST" ? confirmBody() : undefined, t));
      expect(r.status).toBe(403);
    }
    expect(featureCalls()).toEqual([]);
    expect(readAccount).not.toHaveBeenCalled();
  });

  it("body 의 가족 코드 · 프로필 · 계좌 지정은 읽기 쿼리에도 쓰이지 않는다 (세션 값만)", async () => {
    obsRows = [obsRow];
    await run(handleTransferConfirm as never, await req("/x", "POST", { ...confirmBody(), family_code: "evil", profile: "evil" }));
    expect(writes.every((w) => w.row.family_code === F && w.row.profile === P)).toBe(true);
  });
});

describe("상태 조회 — DB 만 읽는다", () => {
  it("체크리스트 · 이탈 후보(추정 기본 선택) · 원장 수치를 돌려주고 KIS 를 호출하지 않는다", async () => {
    obsRows = [obsRow];
    const r = await run(handleTransferState as never, await req("/api/kis/transfer/state", "GET"));
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("ok");
    expect(r.json.target.instanceId).toBe("bai:kis-pension");
    expect(r.json.ledger.principal).toBe(10_500_000);
    expect(r.json.ledger.priorBrokerResidual).toEqual({});
    expect(r.json.observation).toMatchObject({ stateAsOf: "2026-10-19", cash: 2_318_828, broker: "kis" });
    const sel = r.json.exitCandidates.filter((e: { defaultSelected: boolean }) => e.defaultSelected).map((e: { txId: string }) => e.txId).sort();
    expect(sel).toEqual(["s1", "s2"]);
    expect(r.json.canConfirm).toBe(true);
    expect(readAccount).not.toHaveBeenCalled();
    expect(dbWrites()).toEqual([]);
  });

  it("관측이 없으면 확정할 수 없다 (canConfirm=false)", async () => {
    const r = await run(handleTransferState as never, await req("/api/kis/transfer/state", "GET"));
    expect(r.json.canConfirm).toBe(false);
    expect(r.json.checklist.find((c: { id: string }) => c.id === "observation_recorded").ok).toBe(false);
  });

  it("한국투자 계좌가 등록돼 있지 않으면 no_target", async () => {
    registryData = [miraeInstance];
    const r = await run(handleTransferState as never, await req("/api/kis/transfer/state", "GET"));
    expect(r.json).toEqual({ state: "no_target" });
  });
});

describe("잔고 관측 기록", () => {
  it("승인이 없으면 400 — DB 도 KIS 도 건드리지 않는다", async () => {
    for (const body of [{}, { approved: false }, { approved: "true" }, "not json"]) {
      const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", body));
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("approval_required");
    }
    expect(featureCalls()).toEqual([]);
    expect(readAccount).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("승인하면 KIS 잔고를 1회 읽고 관측 1행만 쓴다 (원장 · cashflow · kaw_data 는 쓰지 않는다)", async () => {
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("recorded");
    expect(r.json.observation).toMatchObject({ broker: "kis", sourceType: "kis_inquire_balance", stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z", cash: 2_318_828, holdings: { "360750": 230, "367380": 64 } });
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(dbWrites()).toEqual(["WRITE:insert:kaw_settlement_observation"]);
    expect(writes).toHaveLength(1);
    expect(writes[0].row).toMatchObject({ family_code: F, profile: P, actor: P, state_as_of_basis: "observation_date", source_type: "kis_inquire_balance", broker: "kis", cash: 2_318_828 });
  });

  it("같은 내용이 이미 있으면(23505) 새로 쌓지 않고 알린다", async () => {
    obsInsertError = { code: "23505" };
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    expect(r.json.state).toBe("already_recorded");
  });

  it("보유/예수금을 읽지 못했으면 기록하지 않는다", async () => {
    readAccount = vi.fn(async (rq: { registry: never[] }) => ({
      observation: buildKisObservation({ productCode: "22", resolution: resolveKisInstance("22", rq.registry, "2026-10-19"), stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z",
        balance: { ok: false, httpStatus: 500, rtCd: "1", holdings: [], holdingsCount: 0, cash: null, summary: {} } }),
      plan: {} as never,
    })) as never;
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    expect(r.json).toEqual({ state: "not_recordable", reason: "holdings_not_observed" });
    expect(dbWrites()).toEqual([]);
  });

  it("계좌용 credential 이 없으면 503 이고 어떤 호출도 없다 (시세용 키로 대체하지 않는다)", async () => {
    const { KIS_ACCOUNT_APP_KEY: _k, KIS_ACCOUNT_APP_SECRET: _s, ...rest } = fullEnv;
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }), { ...rest, KIS_APP_KEY: "market-key", KIS_APP_SECRET: "market-secret" });
    expect(r.status).toBe(503);
    expect(readAccount).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(dbWrites()).toEqual([]);
  });

  it("계산만 제공으로 설정된 계좌는 조회하지 않는다 (gate_blocked)", async () => {
    registryData = [miraeInstance, { ...kisInstance, connectionMode: "calc_only" }];
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    expect(r.json.state).toBe("gate_blocked");
    expect(readAccount).not.toHaveBeenCalled();
    expect(dbWrites()).toEqual([]);
  });

  it("응답에 계좌번호 · 키 · 토큰이 없다", async () => {
    const r = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    for (const secret of [CANO, APPKEY, APPSECRET, TOKEN]) expect(r.text).not.toContain(secret);
  });
});

describe("이전 확정 기록", () => {
  beforeEach(() => { obsRows = [obsRow]; });

  it("승인이 없으면 400 — 읽지도 쓰지도 않는다", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ approved: false })));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("approval_required");
    expect(featureCalls()).toEqual([]);
  });

  it("승인하면 audit 이력 1행만 쓴다 (원장 · cashflow · kaw_data · 관측은 쓰지 않는다)", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("confirmed");
    expect(dbWrites()).toEqual(["WRITE:insert:kaw_ledger_audit"]);
    const w = writes[0];
    expect(w.table).toBe("kaw_ledger_audit");
    expect(w.row).toMatchObject({ family_code: F, profile: P, actor: P, action: "transfer_confirm", target_type: "import", target_id: "transfer:bai:kis-pension", previous_value: null, note: "확인" });
    const rec = w.row.new_value as Record<string, any>;
    expect(rec).toMatchObject({ kind: "sold_then_cash_transfer", anchorDate: "2026-10-13", principalEffect: "none", createsCashflow: false, containsEstimates: true });
    expect(rec.cashReceived).toEqual({ amount: 10_293_793, date: null, basis: "user_confirmed" });
    expect(rec.exitEvidence.map((e: { basis: string }) => e.basis)).toEqual(["user_attested_estimate", "user_attested_estimate"]);
    expect(rec.observation.stateAsOf).toBe("2026-10-19");
    expect(rec.approval.actor).toBe(P);
    expect(readAccount).not.toHaveBeenCalled(); // 확정은 KIS 를 호출하지 않는다
  });

  it("관측이 없으면 409 evidence_missing — 아무것도 쓰지 않는다", async () => {
    obsRows = [];
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("evidence_missing");
    expect(dbWrites()).toEqual([]);
  });

  it("이전 증권사 보유가 남아 있으면 409 residual_remains", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ exitTxIds: ["s1"] })));
    // s2 는 원장에 있으므로 보유는 정리돼 있다 — 선택하지 않은 행이 있어도 원장 기준 보유가 0 이면 통과한다
    expect(r.status).toBe(200);
    ledgerRows = fullLedger().filter((t) => t.id !== "s2");
    calls.length = 0; writes.length = 0;
    const r2 = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ exitTxIds: ["s1"] })));
    expect(r2.status).toBe(409);
    expect(r2.json.code).toBe("residual_remains");
    expect(r2.json.detail).toEqual({ "367380": 81 });
    expect(dbWrites()).toEqual([]);
  });

  it("이미 확정돼 있으면 409 already_confirmed — 기록을 고치지 않는다", async () => {
    const first = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
    auditRows = [{ new_value: writes[0].row.new_value }];
    calls.length = 0; writes.length = 0;
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
    expect(first.status).toBe(200);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("already_confirmed");
    expect(dbWrites()).toEqual([]);
  });

  it("body 로 가족 · 프로필 · 계좌번호를 지정해도 무시된다 (세션만 쓴다)", async () => {
    await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", { ...confirmBody(), family_code: "evil", profile: "evil", cano: "99999999", actor: "evil" }));
    expect(writes[0].row).toMatchObject({ family_code: F, profile: P, actor: P });
    expect(JSON.stringify(writes[0].row)).not.toContain("99999999");
  });
});

describe("소스 수준 보증", () => {
  const code = readFileSync(fileURLToPath(new URL("./kis-transfer-server.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  it("insert 는 정확히 두 곳 — 관측 테이블과 audit 테이블뿐이다", () => {
    const inserts = [...code.matchAll(/\.from\("([a-z_]+)"\)\.insert\(/g)].map((m) => m[1]);
    expect(inserts.sort()).toEqual(["kaw_ledger_audit", "kaw_settlement_observation"]);
    // DB 테이블에 대한 update/upsert/delete 는 없다 (KV·메모리 잠금 해제의 delete 는 DB 쓰기가 아니다)
    expect(code).not.toMatch(/from\("[a-z_]+"\)\s*\.(update|upsert|delete)\(/);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("원장 · cashflow · kaw_data 에 쓰지 않고 주문 경로가 없다", () => {
    expect(code).not.toMatch(/from\("(kaw_transaction_ledger|kaw_data|kaw_order_intent)"\)/);
    expect(code).not.toMatch(/order-cash|placeCashBuyOrder|submit|cancel/i);
    expect(code).not.toMatch(/console\./);
  });
});

// ── 최종 안전성 점검 (배포 전) ───────────────────────────────────────────────
describe("동시 요청 · 중복 클릭 · 재시도 — 같은 기록이 중복 생성되지 않는다", () => {
  beforeEach(() => { obsRows = [obsRow]; });

  it("같은 확정 요청을 동시에 두 번 보내도 audit 이력은 1행만 쓰인다", async () => {
    dbLatencyMs = 5;
    const [a, b] = await Promise.all([
      run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody())),
      run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody())),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(dbWrites()).toEqual(["WRITE:insert:kaw_ledger_audit"]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.code).toBe("busy");
  });

  it("같은 관측 요청을 동시에 두 번 보내도 KIS 조회는 1회, 기록은 1행이다", async () => {
    dbLatencyMs = 5;
    const [a, b] = await Promise.all([
      run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true })),
      run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(dbWrites()).toEqual(["WRITE:insert:kaw_settlement_observation"]);
  });

  it("끝난 뒤에는 잠금이 풀려 다시 요청할 수 있다 (재시도 자체는 막지 않는다)", async () => {
    await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    obsInsertError = { code: "23505" };
    const again = await run(handleBalanceObserve as never, await req("/api/kis/transfer/observe", "POST", { approved: true }));
    expect(again.json.state).toBe("already_recorded");
  });

  it("확정 직후 DB 에 같은 계좌의 이력이 둘 이상 보이면(다른 인스턴스 경합) 응답이 알려준다", async () => {
    const dupRecord = { version: 1, kind: "sold_then_cash_transfer", toInstanceId: "bai:kis-pension", anchorDate: "2026-10-13", cashReceived: { amount: 1 }, exitEvidence: [], approval: { actor: P, at: "2026-10-19T06:10:01.000Z" } };
    // 첫 읽기(검증 시점)에는 없고, 쓰기 뒤 재확인에서 경쟁 요청의 이력이 보이는 상황
    let reads = 0;
    const orig = fakeClient.from;
    (fakeClient as { from: unknown }).from = (table: string) => {
      const c = orig(table) as Record<string, unknown>;
      if (table === "kaw_ledger_audit") {
        const origThen = c.then as (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => Promise<unknown>;
        c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { reads++; return origThen.call(c, (v: unknown) => res(reads >= 2 ? { data: [{ new_value: dupRecord }, { new_value: dupRecord }], error: null } : v), rej); };
      }
      return c;
    };
    try {
      const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
      expect(r.json.state).toBe("confirmed");
      expect(r.json.duplicateRecords).toBeGreaterThan(1);
    } finally { (fakeClient as { from: unknown }).from = orig; }
  });
});

describe("이전 증권사 instance 가 없는 운영 데이터 — instanceId=null 과 수기 증권사명", () => {
  beforeEach(() => { obsRows = [obsRow]; registryData = [kisInstance]; });

  it("미래에셋 instance 가 레지스트리에 없어도 수기 증권사명으로 확정되고 instance id 는 null 이다 (임의 id 를 만들지 않는다)", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ fromInstanceId: null, fromBroker: "miraeasset", fromLabel: "미래에셋 연금저축" })));
    expect(r.status).toBe(200);
    const rec = writes[0].row.new_value as Record<string, unknown>;
    expect(rec.fromInstanceId).toBeNull();
    expect(rec.fromBroker).toBe("miraeasset");
    expect(rec.fromLabel).toBe("미래에셋 연금저축");
    expect(JSON.stringify(rec)).not.toMatch(/bai:[0-9a-f]{8}"[^}]*"fromBroker/);
  });

  it("클라이언트가 만들어 보낸 존재하지 않는 instance id 는 거부하고 저장하지 않는다", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ fromInstanceId: "bai:made-up" })));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("source_instance_invalid");
    expect(dbWrites()).toEqual([]);
  });

  it("계좌번호가 섞인 수기 이름은 거부한다", async () => {
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ fromInstanceId: null, fromBroker: "미래에셋", fromLabel: "계좌 12345678901" })));
    expect(r.json.code).toBe("source_instance_invalid");
    expect(dbWrites()).toEqual([]);
  });
});

describe("서버가 독립적으로 검증한다 — approved: true 만으로는 부족하다", () => {
  beforeEach(() => { obsRows = [obsRow]; });

  it("다른 계좌(IRP) instance 를 새 계좌로 지정하면 거부한다", async () => {
    registryData = [miraeInstance, kisInstance, { ...kisInstance, id: "bai:irp", productCode: "29", logicalAccountType: "irp" }];
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ toInstanceId: "bai:irp" })));
    expect(r.json.code).toBe("target_instance_invalid");
    expect(dbWrites()).toEqual([]);
  });

  it("다른 계좌의 원장 행은 이탈 근거가 될 수 없다 (연금저축 원장만 본다)", async () => {
    ledgerRows = [...fullLedger(), ledgerTx({ id: "isa1", account_type: "isa", side: "sell" })];
    // 서버는 연금저축 원장만 읽는다 — isa 행은 원장 조회 결과에 없는 것으로 취급된다
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody({ exitTxIds: ["s1", "s2", "isa1"] })));
    expect(r.json.code).toBe("exit_rows_invalid");
    expect(dbWrites()).toEqual([]);
  });

  it("이전 기준일보다 오래된 관측으로는 확정할 수 없다 (이전 후 관측이 아니다)", async () => {
    obsRows = [{ ...obsRow, state_as_of: "2026-10-10", observed_at: "2026-10-10T06:00:00+00:00" }];
    const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
    expect(r.json.code).toBe("evidence_missing");
    expect(dbWrites()).toEqual([]);
  });

  it("무효(void) 처리된 관측은 증거로 쓰지 않는다", async () => {
    const orig = fakeClient.from;
    (fakeClient as { from: unknown }).from = (table: string) => {
      const c = orig(table) as Record<string, unknown>;
      if (table === "kaw_settlement_observation_void") {
        c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ observation_id: obsRow.id }], error: null }).then(res);
      }
      return c;
    };
    try {
      const r = await run(handleTransferConfirm as never, await req("/api/kis/transfer/confirm", "POST", confirmBody()));
      expect(r.json.code).toBe("evidence_missing");
      expect(dbWrites()).toEqual([]);
    } finally { (fakeClient as { from: unknown }).from = orig; }
  });
});
