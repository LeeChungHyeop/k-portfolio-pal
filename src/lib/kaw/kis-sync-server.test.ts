/**
 * POST /api/kis/sync/preview · /api/kis/sync/apply — 계좌 상태 동기화 핸들러 (Phase 4-D)
 *
 * 지키는 것:
 *   1. 인증·소유권 → 명시적 승인 → 서버 플래그 순서. 앞 단계가 막히면 DB 도 KIS 도 건드리지 않는다
 *   2. 승인 직전에 증권사 잔고를 **한 번만**(재시도 없이) 다시 읽고 최신 상태로 다시 판정한다
 *   3. 읽기에 실패하면 저장된 관측으로 내려가되 '현재'로 둔갑시키지 않는다 — 기준일을 보이고 별도 승인을 요구한다
 *   4. 사용자가 승인한 계획 해시와 다르면 반영하지 않고 새 계획을 돌려준다
 *   5. 쓰기는 RPC 한 번뿐이다. 문서는 허용된 5개 키만 바뀌고 history · cashflows · baseAmount 는 한 글자도 안 바뀐다
 *   6. RPC 결과가 applied 가 아니면 성공으로 안내하지 않는다
 *   7. 동시 요청에서도 RPC 는 한 번만 나간다
 *   8. 응답에 계좌번호 · 키 · 토큰이 없다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase — 읽기/쓰기/RPC 를 모두 기록한다 ──────────────────────────
const calls: string[] = [];
const rpcCalls: Array<{ name: string; args: Record<string, any> }> = [];
let ledgerRows: Record<string, unknown>[] = [];
let registryData: unknown = [];
let pensionDoc: Record<string, unknown> = {};
let pensionRevision = 5;
let auditRows: Array<{ new_value: unknown }> = [];
let obsRows: Record<string, unknown>[] = [];
let corrRows: Record<string, unknown>[] = [];
let snapshotRows: Array<{ snapshot_date: string }> = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: { status: "applied", record_id: "R", revision: 6 }, error: null };
let latencyMs = 0;
const lag = () => (latencyMs > 0 ? new Promise<void>((r) => setTimeout(r, latencyMs)) : Promise.resolve());

const LIB = [
  { defaultEtf: "TIGER 미국S&P500", ticker: "360750" },
  { defaultEtf: "ACE 미국나스닥100", ticker: "367380" },
];

const fakeClient = {
  rpc: (name: string, args: Record<string, any>) => {
    calls.push(`RPC:${name}`);
    rpcCalls.push({ name, args });
    return lag().then(() => rpcResult);
  },
  from: (table: string) => {
    const f: Record<string, string> = {};
    let inCols: string[] | null = null;
    const resolve = (): { data: unknown; error: null } => {
      if (table === "kaw_transaction_ledger") return { data: ledgerRows, error: null };
      if (table === "kaw_transaction_correction") return { data: corrRows, error: null };
      if (table === "kaw_ledger_audit") return { data: auditRows, error: null };
      if (table === "kaw_settlement_observation") return { data: obsRows, error: null };
      if (table === "kaw_daily_portfolio_snapshots") return { data: snapshotRows, error: null };
      if (table === "kaw_data") {
        if (inCols) return { data: [{ data: { assetLibrary: LIB } }], error: null };
        if (f.account_type === "_meta") return { data: { data: { brokerAccounts: registryData } }, error: null };
        if (f.account_type === "pension") return { data: { data: pensionDoc, revision: pensionRevision }, error: null };
        return { data: null, error: null };
      }
      return { data: [], error: null };
    };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (k: string, v: string) => { f[k] = v; return chain; };
    chain.in = (k: string, v: string[]) => { if (k === "account_type") inCols = v; return chain; };
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = async () => { calls.push(`read:${table}:${f.account_type ?? ""}`); return resolve(); };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      calls.push(`read:${table}${inCols ? ":in" : ""}`);
      return lag().then(() => resolve()).then(res, rej);
    };
    for (const m of ["insert", "upsert", "update", "delete"]) chain[m] = () => { calls.push(`WRITE:${m}:${table}`); return chain; };
    return chain;
  },
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleSyncApply, handleSyncPreview, isBrokerSyncEnabled } = await import("./kis-sync-server");
const { ledgerRowToTransaction } = await import("./kis-execution-server");
const { validateTransferConfirm } = await import("./account-transfer-record");
const { buildKisObservation, resolveKisInstance } = await import("./kis-account-observe");
const { disallowedChanges } = await import("./broker-sync");

const SECRET = "test-secret";
const F = "family-x", P = "profile-x";
const CANO = "12345678";
const APPKEY = "APPKEY-1234567890-SECRET-VALUE-XYZ";
const APPSECRET = "APPSECRET-1234567890-SECRET-VALUE-XYZ";
const TOKEN = "TOKEN-1234567890-SECRET-VALUE-XYZ-ABCDEFGHIJKLMNOP";
const TODAY = "2026-10-20";

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
  KIS_ACCOUNT_OWNER_FAMILY_CODE: F, KIS_ACCOUNT_OWNER_PROFILE: P, KIS_ACCOUNT_SYNC_ENABLED: "on",
};
const kisInstance = { id: "bai:kis-pension", label: "한국투자증권 연금저축", broker: "kis", productCode: "22", logicalAccountType: "pension", activeFrom: "2026-10-14", connectionMode: "api_readonly" };
const miraeInstance = { id: "bai:mirae-pension", label: "미래에셋 연금저축", broker: "miraeasset", logicalAccountType: "pension", activeFrom: "2025-01-01", activeTo: "2026-10-14" };

const dbTx = (over: Record<string, unknown>) => ({
  id: "t1", account_type: "pension", ticker: "360750", etf_name: "TIGER 미국S&P500", side: "buy", quantity: 297, price: 25910, amount: 7_695_270,
  trade_date: null, settlement_date: "2026-10-07", inferred_trade_date: "2026-10-02", event_date: "2026-10-02",
  trade_date_evidence: "tplus2-krx-trading-calendar-holiday-adjusted", fee: 0, tax: 0, post_quantity: null, source: "miraeasset_capture_qty_price_reconstructed", import_batch_id: "imp:v2", ...over,
});
const proxy = { source: "user_attested_liquidation_price_proxy", import_batch_id: "imp:proxy", event_date: "2026-10-13", inferred_trade_date: null, settlement_date: null, fee: null, tax: null, post_quantity: 0, trade_date_evidence: "user-attested-full-liquidation; exact-sale-date-unknown" };
const MIRAE = () => [
  dbTx({ id: "b1" }),
  dbTx({ id: "b2", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460 }),
  dbTx({ id: "s1", side: "sell", ...proxy }),
  dbTx({ id: "s2", side: "sell", ticker: "367380", etf_name: "ACE 미국나스닥100", quantity: 81, price: 31660, amount: 2_564_460, ...proxy }),
];
const kisBuy = (id: string, ticker: string, name: string, q: number, price: number, amount: number) => dbTx({
  id, ticker, etf_name: name, side: "buy", quantity: q, price, amount, trade_date: "2026-10-14", settlement_date: null, inferred_trade_date: null,
  event_date: "2026-10-14", trade_date_evidence: "broker-order-date", fee: null, tax: null, post_quantity: null, source: "kis_api_daily_ccld", import_batch_id: "imp:kis",
});
const LEDGER = () => [
  ...MIRAE(),
  kisBuy("k1", "360750", "TIGER 미국S&P500", 230, 25985, 5_976_550),
  kisBuy("k2", "367380", "ACE 미국나스닥100", 64, 31220, 1_998_080),
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
    { registry: [miraeInstance as never, kisInstance as never], ledger: MIRAE().map(ledgerRowToTransaction), existing: [],
      observation: { captureId: OBS_ROW.capture_id, stateAsOf: "2026-10-19", observedAt: "2026-10-19T06:00:00.000Z" }, today: "2026-10-19", actor: P, nowIso: "2026-10-19T08:57:45.000Z" },
  );
  if (!v.ok) throw new Error(v.message);
  return { new_value: v.record };
}

const HISTORY = [
  { id: "h-2026-10-01", date: "2026-10-01", confirmed: true, deposit: 0, totalValue: 10_000_000,
    rowQuantitiesSnap: { kr: 297, us: 81 }, rowEtfSnap: { kr: "TIGER 미국S&P500", us: "ACE 미국나스닥100" }, rowLabelSnap: { kr: "S&P", us: "나스닥" }, rowHoldingsSnap: { kr: 7_695_270, us: 2_564_460 } },
];
const CASHFLOWS = [{ id: "c1", date: "2025-11-10", amount: 10_500_000 }];
const docOf = (over: Record<string, unknown> = {}) => ({
  profile: "growth", active: true, history: HISTORY, cashflows: CASHFLOWS, baseAmount: 10_500_000, deposit: 0,
  assetRows: [{ id: "kr", etfName: "TIGER 미국S&P500", assetId: "kr" }, { id: "us", etfName: "ACE 미국나스닥100", assetId: "us" }],
  liveQuantities: { kr: 297, us: 81 }, rowHoldings: { kr: 7_695_270, us: 2_564_460 }, cashBalance: 29_296, extraKey: { keep: true }, ...over,
});

function liveRead(over: { holdings?: Array<{ ticker: string; name: string; quantity: number }>; cash?: number; stateAsOf?: string } = {}) {
  return vi.fn(async (req: { registry: never[]; productCode: "22" }) => ({
    observation: buildKisObservation({
      productCode: "22", resolution: resolveKisInstance("22", req.registry, over.stateAsOf ?? TODAY), stateAsOf: over.stateAsOf ?? TODAY, observedAt: `${over.stateAsOf ?? TODAY}T00:30:00.000Z`,
      balance: { ok: true, httpStatus: 200, rtCd: "0", holdings: over.holdings ?? [{ ticker: "360750", name: "TIGER", quantity: 230 }, { ticker: "367380", name: "ACE", quantity: 64 }], holdingsCount: 2, cash: over.cash ?? 2_330_000, summary: {} },
    }),
    plan: {} as never,
  }));
}
let readAccount: ReturnType<typeof liveRead>;
const getToken = vi.fn(async () => TOKEN);
const deps = () => ({ readAccount: readAccount as never, getToken: getToken as never, today: () => TODAY, now: () => new Date(`${TODAY}T01:10:00.000Z`) });

async function post(handler: typeof handleSyncPreview, path: string, body: unknown, env: Record<string, unknown> = fullEnv, opts: { token?: string | null } = {}) {
  const token = opts.token === undefined ? await sessionToken() : opts.token;
  const req = new Request(`https://x${path}`, {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handler(req, env as never, deps() as never);
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const preview = (body: unknown = { live: true }, env?: Record<string, unknown>, opts?: { token?: string | null }) => post(handleSyncPreview, "/api/kis/sync/preview", body, env, opts);
const apply = (body: unknown, env?: Record<string, unknown>, opts?: { token?: string | null }) => post(handleSyncApply, "/api/kis/sync/apply", body, env, opts);
const dbWrites = () => calls.filter((c) => c.startsWith("WRITE:"));

async function currentHash(live = true, staleApproved = false): Promise<{ hash: string; recordId: string; plan: any }> {
  const r = await preview({ live, staleObservationApproved: staleApproved });
  expect(r.status).toBe(200);
  expect(r.json.plan, JSON.stringify(r.json.blockers)).toBeTruthy();
  const out = { hash: r.json.plan.planHash as string, recordId: r.json.plan.recordId as string, plan: r.json.plan };
  calls.length = 0; rpcCalls.length = 0; readAccount.mockClear(); getToken.mockClear();
  return out;
}

beforeEach(() => {
  calls.length = 0; rpcCalls.length = 0; latencyMs = 0;
  ledgerRows = LEDGER(); registryData = [miraeInstance, kisInstance];
  pensionDoc = docOf(); pensionRevision = 5;
  auditRows = [transferAuditRow()]; obsRows = [OBS_ROW]; corrRows = [];
  snapshotRows = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-19"].map((d) => ({ snapshot_date: d }));
  rpcResult = { data: { status: "applied", record_id: "R", revision: 6 }, error: null };
  readAccount = liveRead();
  getToken.mockClear();
});

describe("인증 · 승인 · 플래그 — 앞 단계가 막히면 아무것도 건드리지 않는다", () => {
  it("세션이 없으면 401, 소유자가 아니면 403 — DB · KIS 접근 없음", async () => {
    for (const h of [preview, apply] as const) {
      const a = await h({ approved: true, planHash: "s1|0" }, fullEnv, { token: null });
      expect(a.status).toBe(401);
      const b = await h({ approved: true, planHash: "s1|0" }, fullEnv, { token: await sessionToken("other-family", P) });
      expect(b.status).toBe(403);
    }
    expect(readAccount).not.toHaveBeenCalled();
    expect(calls.filter((c) => !c.endsWith(":_family"))).toEqual([]);
    expect(dbWrites()).toEqual([]);
  });

  it("승인이 없으면 400 — 읽지도 KIS 를 부르지도 쓰지도 않는다", async () => {
    for (const body of [{}, { approved: false, planHash: "s1|ab" }, { approved: "true", planHash: "s1|ab" }, "not json"]) {
      const r = await apply(body);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("approval_required");
    }
    expect(readAccount).not.toHaveBeenCalled();
    expect(calls.filter((c) => !c.endsWith(":_family"))).toEqual([]);
  });

  it("planHash 형식이 틀리면 400", async () => {
    for (const planHash of [undefined, 5, "k1|ab", "s1|", "s1|XYZ"]) {
      const r = await apply({ approved: true, planHash });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("bad_request");
    }
    expect(readAccount).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("서버 플래그가 꺼져 있으면 403 — KIS · RPC 없음 (정확히 'on' 만 켜진다)", async () => {
    for (const v of [undefined, "", "ON", "true", "1", "off"]) {
      const r = await apply({ approved: true, planHash: "s1|ab" }, { ...fullEnv, KIS_ACCOUNT_SYNC_ENABLED: v });
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("sync_disabled");
    }
    expect(readAccount).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(isBrokerSyncEnabled({ KIS_ACCOUNT_SYNC_ENABLED: "on" })).toBe(true);
    expect(isBrokerSyncEnabled({})).toBe(false);
  });

  it("credential 이 없으면 503 not_configured — 시세용 키로 대체하지 않고 쓰지 않는다", async () => {
    const { KIS_ACCOUNT_APP_KEY: _a, ...noKey } = fullEnv;
    const r = await apply({ approved: true, planHash: "s1|ab" }, noKey);
    expect(r.status).toBe(503);
    expect(r.json.state).toBe("not_configured");
    expect(rpcCalls).toEqual([]);
  });
});

describe("미리보기 — 읽기 전용, 날짜를 분리해 보여 준다", () => {
  it("라이브 잔고로 계획을 만든다: 230/64, 예수금 변경 전/후, 원금 불변, 쓰기 없음", async () => {
    const r = await preview({ live: true });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("preview");
    expect(r.json.eligible).toBe(true);
    expect(r.json.enabled).toBe(true);
    expect(r.json.balance).toMatchObject({ liveAttempted: true, failure: null, source: "kis_live_read", stateAsOf: TODAY });
    const p = r.json.plan;
    expect(p.holdingsEffectiveFrom).toBe("2026-10-14");
    expect(p.rows.map((x: any) => [x.rowId, x.quantityBefore, x.quantityAfter])).toEqual([["kr", 297, 230], ["us", 81, 64]]);
    expect(p.cash).toMatchObject({ before: 29_296, after: 2_330_000, stateAsOf: TODAY, source: "kis_live_read", fresh: true });
    expect(p.principal).toEqual({ amount: 10_500_000, unchanged: true });
    expect(p.untouched).toMatchObject({ historyCount: 1, cashflowCount: 1, baseAmount: 10_500_000 });
    // 기존 스냅샷은 지우지 않고 영향 범위만 알린다 (효력일 10-14 이후)
    expect(p.affectedSnapshotDates).toEqual(["2026-10-14", "2026-10-15", "2026-10-19"]);
    expect(dbWrites()).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(readAccount).toHaveBeenCalledTimes(1);
  });

  it("live=false 면 KIS 를 부르지 않고 저장된 관측(10-19)을 쓴다 — 오늘(10-20)이 아니라서 오래된 관측으로 표시된다", async () => {
    const r = await preview({ live: false });
    expect(readAccount).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(r.json.balance).toMatchObject({ liveAttempted: false, source: "stored_observation", stateAsOf: "2026-10-19" });
    expect(r.json.needsStaleApproval).toBe(true);
    expect(r.json.eligible).toBe(false);
    expect(r.json.blockers.map((b: any) => b.code)).toContain("balance_stale");
    // 계획은 보여 준다 — 단, 기준일이 노출되고 fresh=false
    expect(r.json.plan.cash).toMatchObject({ after: 2_318_828, stateAsOf: "2026-10-19", fresh: false, source: "stored_observation" });
  });

  it("라이브 읽기에 실패하면 저장된 관측으로 내려가되 실패 사유와 기준일을 그대로 보인다 (재시도 없음)", async () => {
    readAccount = vi.fn(async () => { throw new Error("EGW00215 " + TOKEN); }) as never;
    const r = await preview({ live: true });
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(r.json.balance).toMatchObject({ liveAttempted: true, failure: "auth_or_transport", source: "stored_observation", stateAsOf: "2026-10-19" });
    expect(r.json.needsStaleApproval).toBe(true);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain(APPKEY);
    expect(r.text).not.toContain(APPSECRET);
    expect(r.text).not.toContain(CANO);
  });

  it("플래그가 꺼져 있어도 미리보기는 되고 flag_off 만 표시한다", async () => {
    const r = await preview({ live: true }, { ...fullEnv, KIS_ACCOUNT_SYNC_ENABLED: undefined });
    expect(r.status).toBe(200);
    expect(r.json.flagEnabled).toBe(false);
    expect(r.json.enabled).toBe(false);
    expect(r.json.blockers.map((b: any) => b.code)).toContain("flag_off");
    expect(r.json.plan).toBeTruthy();
  });

  it("원장 재생 보유와 증권사 보유가 다르면 계획을 만들지 않는다", async () => {
    readAccount = liveRead({ holdings: [{ ticker: "360750", name: "TIGER", quantity: 230 }, { ticker: "367380", name: "ACE", quantity: 65 }] });
    const r = await preview({ live: true });
    expect(r.json.eligible).toBe(false);
    expect(r.json.plan).toBeNull();
    expect(r.json.blockers.map((b: any) => b.code)).toContain("holdings_mismatch");
  });
});

describe("반영 — 지금 다시 읽고, 승인한 계획과 같을 때만 RPC 한 번", () => {
  it("정상: KIS 잔고를 한 번 읽고 RPC 를 한 번 호출한다. 허용된 5개 키만 바뀐다", async () => {
    const { hash } = await currentHash();
    const r = await apply({ approved: true, planHash: hash });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("applied");
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toHaveLength(1);
    expect(dbWrites()).toEqual([]);

    const { name, args } = rpcCalls[0];
    expect(name).toBe("kaw_broker_sync_apply");
    expect(args.p_family_code).toBe(F);
    expect(args.p_profile).toBe(P);
    expect(args.p_expect).toMatchObject({
      account_type: "pension", expected_revision: 5, instance_id: "bai:kis-pension",
      holdings_by_ticker: { "360750": 230, "367380": 64 }, live_quantities: { kr: 230, us: 64 }, cash_amount: 2_330_000,
    });
    // 새 문서: history · cashflows · baseAmount · deposit · 그 밖의 키는 그대로
    const next = args.p_new_data as Record<string, any>;
    expect(disallowedChanges(docOf(), next)).toEqual([]);
    expect(next.history).toEqual(HISTORY);
    expect(next.cashflows).toEqual(CASHFLOWS);
    expect(next.baseAmount).toBe(10_500_000);
    expect(next.extraKey).toEqual({ keep: true });
    expect(next.liveQuantities).toEqual({ kr: 230, us: 64 });
    expect(next.cashBalance).toBe(2_330_000);
    expect(next.cashBalanceObservation).toMatchObject({ stateAsOf: TODAY, basis: "broker_observation", effectiveFrom: null });
    // 동기화 기록: 리밸런싱이 아니고 거래·현금흐름·기준금액을 만들지 않는다
    expect(next.brokerSyncs).toHaveLength(1);
    const rec = next.brokerSyncs[0];
    expect(rec).toMatchObject({
      kind: "broker_sync", notRebalance: true, createsCashflow: false, createsTrade: false, changesBaseAmount: false,
      holdingsEffectiveFrom: "2026-10-14", approvedBy: P, staleObservationApproved: false,
    });
    expect(rec.cash).toMatchObject({ amount: 2_330_000, stateAsOf: TODAY, fresh: true, effectiveFrom: null });
    expect(rec.principal.amount).toBe(10_500_000);
    expect(rec.incomeRangeUpper.meaning).toBe("model_possible_range_not_confirmed_income");
    expect(typeof rec.approvedAt).toBe("string");
    expect(rec.approvedAt).toBe(`${TODAY}T01:10:00.000Z`);
    // 감사: 이전 값이 남는다
    expect(args.p_audit.actor).toBe(P);
    expect(args.p_audit.previous_value).toMatchObject({ cashBalance: 29_296, expectedRevision: 5 });
    expect(args.p_audit.new_value.id).toBe(rec.id);
    // 응답에 비밀값이 없다
    for (const s of [TOKEN, APPKEY, APPSECRET, CANO]) expect(r.text).not.toContain(s);
  });

  it("승인한 계획과 다르면(그 사이 예수금이 바뀜) plan_changed — 쓰지 않고 새 계획을 돌려준다", async () => {
    const { hash } = await currentHash();
    readAccount = liveRead({ cash: 2_331_111 });
    const r = await apply({ approved: true, planHash: hash });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("plan_changed");
    expect(r.json.plan.cash.after).toBe(2_331_111);
    expect(rpcCalls).toEqual([]);
  });

  it("그 사이 사용자가 현재 수량을 고쳐도 plan_changed", async () => {
    const { hash } = await currentHash();
    pensionDoc = docOf({ liveQuantities: { kr: 298, us: 81 } });
    const r = await apply({ approved: true, planHash: hash });
    expect(r.json.code).toBe("plan_changed");
    expect(rpcCalls).toEqual([]);
  });

  it("라이브 읽기에 실패하면 오래된 관측은 별도 승인 없이는 쓰지 않는다 (balance_stale)", async () => {
    const { hash } = await currentHash(false, true); // 사용자가 본 계획 = 저장된 관측 기반
    readAccount = vi.fn(async () => { throw new Error("EGW00215"); }) as never;
    const denied = await apply({ approved: true, planHash: hash });
    expect(denied.status).toBe(409);
    expect(denied.json.code).toBe("not_eligible");
    expect(denied.json.blockers.map((b: any) => b.code)).toContain("balance_stale");
    expect(denied.json.balance).toMatchObject({ failure: "auth_or_transport", source: "stored_observation", stateAsOf: "2026-10-19" });
    expect(readAccount).toHaveBeenCalledTimes(1); // 연속 재시도 없음
    expect(rpcCalls).toEqual([]);
  });

  it("별도 승인(staleObservationApproved)이 있으면 저장된 관측으로 반영하되 기록에 fresh=false · 승인 여부가 남는다", async () => {
    const { hash } = await currentHash(false, true);
    readAccount = vi.fn(async () => { throw new Error("EGW00215"); }) as never;
    const r = await apply({ approved: true, planHash: hash, staleObservationApproved: true });
    expect(r.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    const rec = rpcCalls[0].args.p_new_data.brokerSyncs[0];
    expect(rec.cash).toMatchObject({ amount: 2_318_828, stateAsOf: "2026-10-19", source: "stored_observation", fresh: false });
    expect(rec.staleObservationApproved).toBe(true);
    expect(rpcCalls[0].args.p_new_data.cashBalance).toBe(2_318_828);
  });

  it("같은 상태의 동기화가 이미 문서에 있으면 already_synced — RPC 없음", async () => {
    const { hash, recordId } = await currentHash();
    pensionDoc = docOf({ brokerSyncs: [{ id: recordId, kind: "broker_sync", holdingsEffectiveFrom: "2026-10-14", quantities: { kr: 230, us: 64 } }] });
    const r = await apply({ approved: true, planHash: hash });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("already_synced");
    expect(rpcCalls).toEqual([]);
  });

  it("조건이 안 맞으면(거래 정정이 있음) not_eligible — RPC 없음", async () => {
    const { hash } = await currentHash();
    corrRows = [{ transaction_id: "b1", corrected_quantity: 296 }];
    const r = await apply({ approved: true, planHash: hash });
    expect(r.json.code).toBe("not_eligible");
    expect(r.json.blockers.map((b: any) => b.code)).toContain("corrections_present");
    expect(rpcCalls).toEqual([]);
  });

  it("동시 요청 두 개 — RPC 는 한 번만 나간다", async () => {
    const { hash } = await currentHash();
    latencyMs = 15;
    const [a, b] = await Promise.all([apply({ approved: true, planHash: hash }), apply({ approved: true, planHash: hash })]);
    expect(rpcCalls).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.json.code, b.json.code]).toContain("busy");
  });
});

describe("RPC 결과 해석 — applied 가 아니면 성공으로 안내하지 않는다", () => {
  const cases: Array<[string, { data: unknown; error: { code?: string; message?: string } | null }, number, string]> = [
    ["함수가 없음(013 미적용)", { data: null, error: { code: "PGRST202", message: "Could not find the function public.kaw_broker_sync_apply" } }, 503, "apply_unavailable"],
    ["revision 충돌", { data: null, error: { code: "P0001", message: "KAW_SYNC:revision_conflict" } }, 409, "revision_conflict"],
    ["보유 불일치", { data: null, error: { code: "P0001", message: "KAW_SYNC:holdings_mismatch" } }, 409, "holdings_mismatch"],
    ["허용 밖 키 변경", { data: null, error: { code: "P0001", message: "KAW_SYNC:doc_changed_outside_allowed" } }, 409, "doc_changed_outside_allowed"],
    ["중복 감사(23505)", { data: null, error: { code: "23505", message: "duplicate key" } }, 409, "already_synced"],
    ["이미 반영됨", { data: { status: "already_synced", record_id: "R", revision: 6 }, error: null }, 409, "already_synced"],
  ];
  for (const [name, result, status, code] of cases) {
    it(`${name} → ${status} ${code}`, async () => {
      const { hash } = await currentHash();
      rpcResult = result;
      const r = await apply({ approved: true, planHash: hash });
      expect(r.status).toBe(status);
      expect(r.json.state === "applied").toBe(false);
      expect(r.json.code ?? r.json.state).toBe(code);
    });
  }
  it("알 수 없는 오류 · 알 수 없는 상태 → 500 write_failed", async () => {
    const { hash } = await currentHash();
    rpcResult = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await apply({ approved: true, planHash: hash })).json.state).toBe("write_failed");
    rpcResult = { data: { status: "weird" }, error: null };
    const r = await apply({ approved: true, planHash: hash });
    expect(r.status).toBe(500);
    expect(r.json.state).toBe("write_failed");
  });
});

describe("소스 계약 — 쓰기 경로가 RPC 하나뿐이다", () => {
  const src = readFileSync(fileURLToPath(new URL("./kis-sync-server.ts", import.meta.url)), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  it("insert / update / upsert / delete 가 없고 rpc 는 정확히 한 번", () => {
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src.match(/\.rpc\(/g)).toHaveLength(1);
    expect(src).toContain('client.rpc("kaw_broker_sync_apply"');
  });
  it("RPC 인자 이름이 migration 013 과 같다", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../migrations/013_broker_sync_apply.sql", import.meta.url)), "utf8");
    for (const p of ["p_family_code", "p_profile", "p_expect", "p_new_data", "p_audit"]) {
      expect(src).toContain(`${p}:`);
      expect(sql).toContain(p);
    }
    for (const c of ["revision_conflict", "holdings_mismatch", "doc_changed_outside_allowed", "doc_mismatch", "transfer_unconfirmed", "corrections_present", "invalid_input", "doc_missing", "save_conflict", "forbidden"]) {
      expect(sql, c).toContain(`KAW_SYNC:${c}`);
      expect(src, c).toContain(c);
    }
  });
  it("KIS 호출은 잔고 조회뿐 — 주문 · 취소 · 이체 코드를 부르지 않는다", () => {
    expect(src).toContain("readKisAccount");
    expect(src).not.toMatch(/fetchOrder|placeOrder|submitOrder|cancelOrder/);
  });
});
