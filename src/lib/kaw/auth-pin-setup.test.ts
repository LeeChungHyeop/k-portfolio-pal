/**
 * 최초 PIN 설정·가족 초기 등록 보안 회귀 테스트.
 *
 *   1. PIN 이 없는 프로필의 첫 PIN 은 **공개 액세스 코드만으로는 설정되지 않는다**
 *   2. 다른 관리자의 PIN 로그인 세션 / 마스터 코드 / 운영자 설정 코드만 근거다
 *   3. 세션은 서명·만료·가족·pin_version·관리자 권한을 서버가 검증한다
 *   4. 신규 가족은 인증 없이 DB 행을 만들지 않고, 첫 PIN 은 설정 코드로만 등록된다
 *   5. 가족 설정 문서의 동시 변경은 하나만 반영된다(낙관적 잠금) — 변경이 사라지지 않는다
 *   6. 기존 정상 PIN·마스터·비밀질문 경로는 그대로다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase: revision 을 가진 가족 설정 행 + CAS update ────────────────

interface Profile { id: string; label: string; pin_hash: string | null; is_admin: boolean; pin_version?: number }
interface Family { profiles: Profile[]; master_code_hash?: string | null; deleted_profiles?: Profile[] }
interface Row { data: Family; revision: number }

let row: Row | null;
let dataRows: Set<string>;          // 프로필 데이터 행(삭제 테스트용): "<profile>"
let writes = 0;                     // 가족 설정 행에 대한 쓰기(upsert/update 성공) 횟수
let upserts = 0;
let inserts = 0;
let afterRead: (() => void) | null; // loadFamilyVersioned 의 읽기 직후, 한 번만 실행(경합 주입)
let readsWithRevision = 0;

const KEY = (f: string, p: string, a: string) => `${f}|${p}|${a}`;
const FAM_KEY = (code: string) => KEY(code, "_system", "_family");
let CODE_FOR_FAKE = "";

function builder() {
  const f: Record<string, unknown> = {};
  let op: "select" | "update" | "delete" | null = null;
  let payload: Record<string, unknown> | null = null;
  let cols = "";
  const isFam = () => f.profile === "_system" && f.account_type === "_family";

  const run = async (): Promise<{ data: unknown; error: null | { message: string } }> => {
    if (op === "update" && isFam()) {
      if (!row || (f.revision !== undefined && row.revision !== f.revision)) return { data: [], error: null };
      row = { data: payload!.data as Family, revision: payload!.revision as number };
      writes += 1;
      return { data: [{ revision: row.revision }], error: null };
    }
    if (op === "delete") {
      dataRows.delete(String(f.profile));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  const api: Record<string, unknown> = {
    select(c?: string) { if (op === null) op = "select"; cols = c ?? ""; return api; },
    update(p: Record<string, unknown>) { op = "update"; payload = p; return api; },
    delete() { op = "delete"; return api; },
    insert(p: { data: Family }) {
      if (row) return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
      writes += 1; inserts += 1;
      row = { data: p.data, revision: 0 };
      return Promise.resolve({ error: null });
    },
    upsert(p: { data: Family }) {
      upserts += 1; writes += 1;
      row = { data: p.data, revision: row ? row.revision : 0 };
      return Promise.resolve({ error: null });
    },
    eq(k: string, v: unknown) { f[k] = v; return api; },
    limit() { return Promise.resolve({ data: row ? [{ id: "1" }] : [] }); },
    async maybeSingle() {
      if (!isFam()) return { data: null, error: null };
      const snap = row ? { data: structuredClone(row.data), revision: row.revision } : null;
      if (cols.includes("revision")) {
        readsWithRevision += 1;
        const hook = afterRead; afterRead = null;
        if (hook) hook();
      }
      return { data: snap, error: null };
    },
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return run().then(res, rej); },
  };
  return api;
}
const fakeClient = { from: () => builder() };
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const {
  handleSetPin, handleVerifyPin, handleAuthFamily, handleAddProfile, handleDeleteProfile, handleSetMaster,
} = await import("./data-server");

// ── 입력 ────────────────────────────────────────────────────────────────────

const CODE = "test-family";
const SECRET = "s";
const sha = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

async function token(profile: string, over: Partial<{ code: string; exp: number; v: number; secret: string }> = {}) {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = b64(new TextEncoder().encode(JSON.stringify({
    code: over.code ?? CODE, profile, exp: over.exp ?? Math.floor(Date.now() / 1000) + 3600, v: over.v ?? 0,
  })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(over.secret ?? SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string) => { kvStore.set(k, v); },
  delete: async (k: string) => { kvStore.delete(k); },
};
const baseEnv = {
  ACCESS_CODE: CODE, SESSION_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k", RATE_LIMIT: kv,
};
type Env = typeof baseEnv & Record<string, unknown>;

async function post(
  h: (r: Request, e: Env) => Promise<Response>, body: unknown, tok: string | null = null, env: Record<string, unknown> = baseEnv,
) {
  const res = await h(new Request("https://x/api/auth", {
    method: "POST", body: JSON.stringify(body),
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  }), env as Env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const remove = (hard: boolean, body: unknown) =>
  handleDeleteProfile(new Request("https://x/api/auth", { method: "POST", body: JSON.stringify(body) }), baseEnv as never, hard)
    .then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

const profileOf = (id: string) => row!.data.profiles.find((p) => p.id === id)!;

async function seedFamily(over: Partial<Family> = {}, rev = 4) {
  row = {
    revision: rev,
    data: {
      profiles: [
        { id: "alice", label: "앨리스", pin_hash: await sha(`pin:${CODE}:alice:1111`), is_admin: true, pin_version: 0 },
        { id: "bob", label: "밥", pin_hash: null, is_admin: true, pin_version: 0 },
        { id: "carol", label: "캐럴", pin_hash: await sha(`pin:${CODE}:carol:3333`), is_admin: false, pin_version: 0 },
      ],
      master_code_hash: null,
      ...over,
    },
  };
}

beforeEach(async () => {
  CODE_FOR_FAKE = CODE;
  kvStore.clear(); writes = 0; upserts = 0; inserts = 0; afterRead = null; readsWithRevision = 0;
  dataRows = new Set(["alice", "bob", "carol"]);
  await seedFamily();
});

// ── 1~3. 최초 PIN 설정 ──────────────────────────────────────────────────────

describe("PIN 이 없는 프로필의 첫 PIN — 공개 액세스 코드만으로는 안 된다", () => {
  it("**액세스 코드만(인증 없음)**: 403, 쓰기 없음", async () => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "9999" });
    expect(r.status).toBe(403);
    expect(writes).toBe(0);
    expect(profileOf("bob").pin_hash).toBeNull();
  });

  it("액세스 코드를 마스터·설정 코드로 넣어도 거부(마스터 미설정 · 설정 코드 비활성)", async () => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "9999", masterCode: CODE, setupCode: CODE });
    expect(r.status).toBe(403);
    expect(writes).toBe(0);
  });

  it("다른 관리자의 PIN 로그인 세션이면 설정되고 새 PIN 으로 로그인된다", async () => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("alice"));
    expect(r.status).toBe(200);
    expect(profileOf("bob").pin_hash).toBe(await sha(`pin:${CODE}:bob:2222`));
    expect(profileOf("bob").pin_version).toBe(1);
    expect(JSON.stringify(r.json)).not.toContain(profileOf("bob").pin_hash!);
    const login = await post(handleVerifyPin, { code: CODE, profileId: "bob", pin: "2222" });
    expect(login.json.ok).toBe(true);
  });

  it("관리자가 아닌 프로필의 세션은 거부", async () => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("carol"));
    expect(r.status).toBe(403);
    expect(writes).toBe(0);
  });

  it("**자기 자신의 세션**(토큰 프로필 = 대상)은 근거가 아니다", async () => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("bob"));
    expect(r.status).toBe(403);
  });

  it("PIN 이 없는 관리자의 세션 · 존재하지 않는 프로필의 세션은 거부", async () => {
    // bob 은 PIN 이 없다 → bob 의 세션은 있을 수 없지만 위조 방어를 확인한다
    await seedFamily({ profiles: [
      { id: "alice", label: "a", pin_hash: null, is_admin: true, pin_version: 0 },
      { id: "bob", label: "b", pin_hash: null, is_admin: true, pin_version: 0 },
    ] });
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("alice"))).status).toBe(403);
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("ghost"))).status).toBe(403);
  });

  it.each([
    ["위조 토큰", async () => "forged.token"],
    ["다른 비밀로 서명", async () => token("alice", { secret: "other" })],
    ["만료된 세션", async () => token("alice", { exp: Math.floor(Date.now() / 1000) - 10 })],
    ["다른 가족 코드", async () => token("alice", { code: "other-family" })],
    ["pin_version 불일치(PIN 변경 전 옛 세션)", async () => token("alice", { v: 7 })],
  ])("%s 는 거부", async (_n, make) => {
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await make());
    expect(r.status).toBe(403);
    expect(writes).toBe(0);
  });

  it("존재하지 않는 대상·삭제된 프로필은 404, 잘못된 PIN 형식은 400", async () => {
    const t = await token("alice");
    expect((await post(handleSetPin, { code: CODE, profileId: "nobody", newPin: "2222" }, t)).status).toBe(404);
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "22" }, t)).status).toBe(400);
    expect((await post(handleSetPin, { code: "wrong", profileId: "bob", newPin: "2222" }, t)).status).toBe(400);
  });

  it("마스터가 설정된 가족: 올바른 마스터로 첫 PIN 설정, 틀린 마스터·액세스 코드는 거부", async () => {
    await seedFamily({ master_code_hash: await sha("master:long-master-code") });
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222", masterCode: "wrong" })).status).toBe(403);
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222", masterCode: CODE })).status).toBe(403);
    expect((await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222", masterCode: "long-master-code" })).status).toBe(200);
  });

  it("설정 코드는 이미 PIN 이 있는 가족(초기화된 가족)에서는 쓰이지 않는다", async () => {
    const env = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha(`setup:${CODE}:operator-code-1`) };
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222", setupCode: "operator-code-1" }, null, env);
    expect(r.status).toBe(403);
  });
});

// ── 4. 신규 가족 ────────────────────────────────────────────────────────────

describe("신규 가족 — 인증 없이 행을 만들지 않고, 첫 PIN 은 설정 코드로만", () => {
  beforeEach(() => { row = null; });

  it("**액세스 코드만으로 /family 를 호출해도 DB 에 쓰지 않는다**", async () => {
    const r = await post(handleAuthFamily, { code: CODE });
    expect(r.status).toBe(200);
    expect(r.json.isNew).toBe(true);
    expect(r.json.initialized).toBe(false);
    expect(upserts).toBe(0);
    expect(writes).toBe(0);
    expect(row).toBeNull();
  });

  it("액세스 코드만으로는 첫 PIN 을 등록할 수 없다(설정 코드 secret 이 없으면 아무도 못 한다)", async () => {
    for (const body of [
      { code: CODE, profileId: "hyeobi", newPin: "1234" },
      { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: CODE },
      { code: CODE, profileId: "hyeobi", newPin: "1234", masterCode: CODE },
    ]) {
      expect((await post(handleSetPin, body)).status).toBe(403);
    }
    expect(writes).toBe(0);
    expect(row).toBeNull();
  });

  it("운영자가 발급한 설정 코드로 첫 관리자 PIN 이 등록된다", async () => {
    const env = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha(`setup:${CODE}:operator-code-1`) };
    expect((await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "wrong" }, null, env)).status).toBe(403);
    const ok = await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: " operator-code-1 " }, null, env);
    expect(ok.status).toBe(200);
    expect(ok.json.initialized).toBe(true);
    expect(row!.data.profiles.find((p) => p.id === "hyeobi")!.pin_hash).toBe(await sha(`pin:${CODE}:hyeobi:1234`));
    // 이제 가족은 초기화됐다 — 같은 설정 코드로 다른 프로필의 PIN 을 등록할 수 없다
    const again = await post(handleSetPin, { code: CODE, profileId: "dayoung", newPin: "5678", setupCode: "operator-code-1" }, null, env);
    expect(again.status).toBe(403);
  });

  it("설정 코드 해시 형식이 틀리면 비활성이고, 틀린 시도는 속도 제한에 걸린다", async () => {
    const bad = { ...baseEnv, FAMILY_SETUP_CODE_HASH: "not-a-hash" };
    expect((await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "x" }, null, bad)).status).toBe(403);
    const env = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha(`setup:${CODE}:operator-code-1`) };
    for (let i = 0; i < 10; i++) await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "guess" + i }, null, env);
    const locked = await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, env);
    expect(locked.status).toBe(403);
  });
});

// ── 5. 동시 요청 ────────────────────────────────────────────────────────────

describe("가족 설정 문서의 동시 변경은 하나만 반영된다", () => {
  beforeEach(async () => {
    await seedFamily({ profiles: [
      { id: "alice", label: "a", pin_hash: await sha(`pin:${CODE}:alice:1111`), is_admin: true, pin_version: 0 },
      { id: "bob", label: "b", pin_hash: null, is_admin: true, pin_version: 0 },
      { id: "dave", label: "d", pin_hash: null, is_admin: false, pin_version: 0 },
    ] });
  });

  it("**두 요청이 동시에 와도 하나만 저장되고 다른 하나는 409, 변경이 사라지지 않는다**", async () => {
    const t = await token("alice");
    const [a, b] = await Promise.all([
      post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, t),
      post(handleSetPin, { code: CODE, profileId: "dave", newPin: "4444" }, t),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const set = ["bob", "dave"].filter((id) => profileOf(id).pin_hash !== null);
    expect(set).toHaveLength(1);                 // 둘 다 쓰였다면 마지막이 처음 것을 지운 것이다
    expect(row!.revision).toBe(5);               // 정확히 한 번 +1
  });

  it("읽은 뒤 다른 변경(프로필 추가)이 끼면 PIN 설정은 409 이고 추가된 프로필이 보존된다", async () => {
    afterRead = () => {
      row = { revision: row!.revision + 1, data: { ...row!.data, profiles: [...row!.data.profiles,
        { id: "newbie", label: "신규", pin_hash: "h", is_admin: false }] } };
    };
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222" }, await token("alice"));
    expect(r.status).toBe(409);
    expect(row!.data.profiles.some((p) => p.id === "newbie")).toBe(true);
    expect(profileOf("bob").pin_hash).toBeNull();
  });

  it("프로필 하드 삭제도 충돌이면 설정을 쓰지 않고 데이터 행을 지우지 않는다", async () => {
    await seedFamily({ master_code_hash: await sha("master:long-master-code") });
    afterRead = () => { row = { ...row!, revision: row!.revision + 1 }; };
    const r = await remove(true, { code: CODE, profileId: "carol", masterCode: "long-master-code" });
    expect(r.status).toBe(409);
    expect(dataRows.has("carol")).toBe(true);
    expect(profileOf("carol")).toBeTruthy();
  });

  it("충돌이 없으면 하드 삭제는 설정 저장 뒤에 데이터 행을 지운다", async () => {
    await seedFamily({ master_code_hash: await sha("master:long-master-code") });
    const r = await remove(true, { code: CODE, profileId: "carol", masterCode: "long-master-code" });
    expect(r.status).toBe(200);
    expect(dataRows.has("carol")).toBe(false);
    expect(row!.data.profiles.some((p) => p.id === "carol")).toBe(false);
  });

  it("마스터 변경·프로필 추가도 같은 낙관적 잠금을 쓴다", async () => {
    await seedFamily({ master_code_hash: await sha("master:long-master-code") });
    const add = await post(handleAddProfile, { code: CODE, label: "새", pin: "1111", masterCode: "long-master-code" });
    expect(add.status).toBe(200);
    expect(readsWithRevision).toBeGreaterThan(0);
    afterRead = () => { row = { ...row!, revision: row!.revision + 1 }; };
    const sm = await post(handleSetMaster, { code: CODE, newCode: "another-master-1", currentMaster: "long-master-code" });
    expect(sm.status).toBe(409);
  });
});

// ── 6. 기존 경로 유지 ───────────────────────────────────────────────────────

describe("기존 정상 경로는 그대로", () => {
  it("PIN 이 있는 프로필: 현재 PIN 으로 변경 / 틀린 PIN 은 거부", async () => {
    expect((await post(handleSetPin, { code: CODE, profileId: "alice", newPin: "7777", currentPin: "0000" })).status).toBe(403);
    expect((await post(handleSetPin, { code: CODE, profileId: "alice", newPin: "7777", currentPin: "1111" })).status).toBe(200);
    expect(profileOf("alice").pin_version).toBe(1);
  });

  it("PIN 이 있는 프로필의 PIN 은 다른 관리자의 세션만으로는 바꿀 수 없다", async () => {
    // alice 의 세션으로 carol(PIN 있음)을 바꾸려는 시도 — 첫 설정 경로가 아니다
    const r = await post(handleSetPin, { code: CODE, profileId: "carol", newPin: "7777" }, await token("alice"));
    expect(r.status).toBe(403);
    expect(profileOf("carol").pin_version).toBe(0);
  });

  it("PIN 로그인은 그대로 세션을 발급한다", async () => {
    const r = await post(handleVerifyPin, { code: CODE, profileId: "alice", pin: "1111" });
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.token).toBe("string");
  });
});

describe("소스 불변식", () => {
  const src = readFileSync(fileURLToPath(new URL("./data-server.ts", import.meta.url)), "utf8");
  it("handleSetPin 은 '프로필에 PIN 이 없으면 승인'하지 않는다", () => {
    const body = src.slice(src.indexOf("export async function handleSetPin("), src.indexOf("export async function handleSetMaster("));
    expect(body).not.toMatch(/authorized\s*=\s*!profile\.pin_hash/);
    expect(body).toContain("requireSession(");
    expect(body).toContain("commitFamily(");
  });
  it("handleAuthFamily 는 DB 에 쓰지 않는다", () => {
    const body = src.slice(src.indexOf("export async function handleAuthFamily("), src.indexOf("export async function handleVerifyPin("));
    expect(body).not.toMatch(/saveFamilyRaw|upsert\(|\.insert\(/);
  });
});

// ── 최종 점검 보강 ──────────────────────────────────────────────────────────

describe("초기 설정 코드가 전역 우회 수단이 되지 않는다", () => {
  const setupEnv = async (extra: Record<string, unknown> = {}) =>
    ({ ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha(`setup:${CODE}:operator-code-1`), ...extra });

  it("다른 가족 코드에 묶인 해시(옛 형식 포함)로는 통하지 않는다", async () => {
    row = null;
    const wrong = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha("setup:operator-code-1") };
    const r = await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, wrong);
    expect(r.status).toBe(403);
    const other = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha("setup:other-family:operator-code-1") };
    expect((await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, other)).status).toBe(403);
  });

  it("속도 제한 저장소(KV)가 없으면 사용하지 않는다", async () => {
    row = null;
    const env = { ...(await setupEnv()), RATE_LIMIT: undefined };
    expect((await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, env)).status).toBe(403);
    expect(writes).toBe(0);
  });

  it("한 번 쓰이면 이후에는 같은 코드·같은 secret 이 남아 있어도 무력하다", async () => {
    row = null;
    const env = await setupEnv();
    expect((await post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, env)).status).toBe(200);
    for (const id of ["dayoung", "hyeobi"]) {
      expect((await post(handleSetPin, { code: CODE, profileId: id, newPin: "5555", setupCode: "operator-code-1" }, null, env)).status).toBe(403);
    }
    expect(row!.data.profiles.find((p) => p.id === "dayoung")!.pin_hash).toBeNull();
  });

  it("PIN 을 가진 프로필을 전부 삭제(보관)해도 초기화 전 상태로 돌아가지 않는다", async () => {
    await seedFamily({
      profiles: [{ id: "bob", label: "b", pin_hash: null, is_admin: true, pin_version: 0 }],
      deleted_profiles: [{ id: "alice", label: "a", pin_hash: await sha(`pin:${CODE}:alice:1111`), is_admin: true }],
    });
    const env = await setupEnv();
    const r = await post(handleSetPin, { code: CODE, profileId: "bob", newPin: "2222", setupCode: "operator-code-1" }, null, env);
    expect(r.status).toBe(403);
    const fam = await post(handleAuthFamily, { code: CODE });
    expect(fam.json.initialized).toBe(true);
  });

  it("마스터가 없고 설정 코드 secret 도 없는 초기화 가족은 누구도 첫 PIN 을 못 만든다", async () => {
    row = null;
    for (const body of [
      { code: CODE, profileId: "hyeobi", newPin: "1234" },
      { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "" },
    ]) expect((await post(handleSetPin, body)).status).toBe(403);
    expect(row).toBeNull();
  });
});

describe("새 가족 설정 행 생성의 동시성", () => {
  it("**두 설정 코드 요청이 동시에 와도 행은 한 번만 만들어지고 다른 하나는 409**", async () => {
    row = null;
    const env = { ...baseEnv, FAMILY_SETUP_CODE_HASH: await sha(`setup:${CODE}:operator-code-1`) };
    const [a, b] = await Promise.all([
      post(handleSetPin, { code: CODE, profileId: "hyeobi", newPin: "1234", setupCode: "operator-code-1" }, null, env),
      post(handleSetPin, { code: CODE, profileId: "dayoung", newPin: "5678", setupCode: "operator-code-1" }, null, env),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(inserts).toBe(1);
    expect(upserts).toBe(0);
    const withPin = row!.data.profiles.filter((p) => p.pin_hash).length;
    expect(withPin).toBe(1);
  });
});
