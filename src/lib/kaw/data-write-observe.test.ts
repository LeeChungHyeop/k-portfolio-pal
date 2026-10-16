/**
 * `/api/data` 쓰기 관측 로그 — KAW_REQUIRE_REVISION 을 켜기 전에 무가드 요청이 남아 있는지 보는 용도.
 *
 * 지키는 것:
 *   1. 가드 / 무가드 / 428 차단 경로가 각각 구분되어 한 줄로 남는다
 *   2. 로그에는 가족코드·프로필·토큰·데이터 원문이 들어가지 않는다 (경로와 행 수뿐)
 *   3. 공용 종목 라이브러리만 보내는 요청은 가드 대상이 아니라 남기지 않는다
 *   4. 로그를 남겨도 저장 동작(응답·저장 여부)은 바뀌지 않는다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const upserts: unknown[] = [];
const fakeClient = {
  rpc: async () => ({
    data: { outcome: "saved", revisions: { _meta: 2, isa: 2 }, accepted: 2 },
    error: null,
  }),
  from: () => ({
    select: () => {
      const chain: Record<string, unknown> = {
        eq: () => chain,
        in: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        limit: async () => ({ data: [], error: null }),
      };
      return chain;
    },
    upsert: async (rows: unknown) => { upserts.push(rows); return { error: null }; },
  }),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const { handleDataPost, dataWriteLogLine } = await import("./data-server");

const SECRET = "test-secret";
const F = "soye-family-code", P = "hyeobi-profile";
const MARKER = "SENSITIVE_DATA_MARKER_12345";

function b64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function token(): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ code: F, profile: P, exp: Math.floor(Date.now() / 1000) + 3600, v: 0 })));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}
const baseEnv = { SESSION_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
let authToken = "";

async function post(body: unknown, env: Record<string, unknown> = baseEnv) {
  authToken = await token();
  const res = await handleDataPost(
    new Request("https://x/api/data", { method: "POST", headers: { Authorization: `Bearer ${authToken}` }, body: JSON.stringify(body) }),
    env as never,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const acct = (t: string) => ({ family_code: F, profile: P, account_type: t, data: { note: MARKER } });
const shared = { family_code: F, profile: "_shared", account_type: "_assetLib", data: { assetLibrary: [] } };
const rev = { _meta: 1, isa: 1, irp: 1, pension: 1, retirement: 1 };
const logs: string[] = [];

beforeEach(() => {
  logs.length = 0; upserts.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});

const events = () => logs.filter((l) => l.includes("kaw_data_write")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("쓰기 경로 관측 로그", () => {
  it("무가드 요청(구버전 클라이언트)은 unguarded 로 남고 저장은 그대로 된다", async () => {
    const r = await post({ rows: [acct("_meta"), acct("isa"), shared] });
    expect(r.status).toBe(200);
    expect(r.json.guarded).toBe(false);
    expect(upserts).toHaveLength(1);
    expect(events()).toEqual([{ evt: "kaw_data_write", path: "unguarded", accountRows: 2, sharedRows: 1 }]);
  });

  it("가드 요청은 guarded 로 남는다", async () => {
    const r = await post({ rows: [acct("_meta"), acct("isa")], expectedRevisions: rev });
    expect(r.status).toBe(200);
    expect(r.json.guarded).toBe(true);
    expect(events()).toEqual([{ evt: "kaw_data_write", path: "guarded", accountRows: 2, sharedRows: 0 }]);
  });

  it("차단 스위치가 켜져 있으면 blocked_428 로 남고 저장하지 않는다", async () => {
    const r = await post({ rows: [acct("_meta"), acct("isa")] }, { ...baseEnv, KAW_REQUIRE_REVISION: "on" });
    expect(r.status).toBe(428);
    expect(upserts).toHaveLength(0);
    expect(events()).toEqual([{ evt: "kaw_data_write", path: "blocked_428", accountRows: 2, sharedRows: 0 }]);
  });

  it("공용 종목 라이브러리만 보내는 요청은 로그를 남기지 않는다", async () => {
    const r = await post({ rows: [shared] });
    expect(r.status).toBe(200);
    expect(events()).toEqual([]);
  });

  it("로그에 가족코드·프로필·토큰·데이터 원문이 없다", async () => {
    await post({ rows: [acct("_meta"), acct("isa")] });
    await post({ rows: [acct("_meta")], expectedRevisions: rev });
    await post({ rows: [acct("_meta")] }, { ...baseEnv, KAW_REQUIRE_REVISION: "on" });
    const all = logs.join("\n");
    expect(all).toContain("kaw_data_write");
    for (const secret of [F, P, authToken, authToken.split(".")[0], MARKER, SECRET]) {
      expect(all).not.toContain(secret);
    }
  });

  it("로그 한 줄은 고정된 4개 필드뿐이다", () => {
    const line = dataWriteLogLine("unguarded", 3, 1)!;
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(["accountRows", "evt", "path", "sharedRows"]);
    expect(dataWriteLogLine("guarded", 0, 1)).toBeNull();
  });
});
