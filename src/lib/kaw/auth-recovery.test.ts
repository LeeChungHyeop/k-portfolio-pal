/**
 * 복구 인증(비밀 질문) 보안 회귀 테스트.
 *
 * 지키는 것:
 *   1. 정답이 소스에 없다 — 운영자가 넣은 **새 정답의 해시**(secret)로만 검증한다
 *   2. secret 이 없거나 모양이 틀리면 비밀 질문 인증은 **비활성(fail closed)** 이다
 *   3. 비활성이어도 **현재 PIN · 마스터 코드 인증은 그대로** 동작한다(정상 사용자를 잠그지 않는다)
 *   4. 비활성일 때 비밀 질문으로는 PIN·마스터 코드를 바꿀 수 없다
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 가짜 Supabase (가족 설정 행 하나만) ─────────────────────────────────────

interface Family {
  profiles: Array<{ id: string; label: string; pin_hash: string | null; is_admin: boolean; pin_version?: number }>;
  master_code_hash?: string | null;
}
let family: Family;
let saves = 0;

const fakeClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        // handleAuthFamily 의 "이 가족 행이 있는가" 조회
        limit: async () => ({ data: [{ id: "1" }] }),
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: family } }) }) }),
      }),
    }),
    upsert: async (row: { data: Family }) => { family = row.data; saves += 1; return { error: null }; },
  }),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));

const {
  handleVerifySecretQuestion, handleSetPin, handleSetMaster, handleVerifyPin, handleVerifyMaster,
  handleAddProfile, handleDeleteProfile, handleAuthFamily, isSecretQuestionEnabled,
} = await import("./data-server");

// ── 입력 ────────────────────────────────────────────────────────────────────

const CODE = "test-family";
const sha = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/** 테스트 전용 새 정답(실제 운영 값이 아니다) */
const NEW_ANSWERS = ["alpha-one", "bravo-two", "charlie-three", "delta-four", "echo-five"];
const hashesJson = async () => JSON.stringify(await Promise.all(NEW_ANSWERS.map((a, i) => sha(`sq:${i}:${a}`))));

const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string) => { kvStore.set(k, v); },
  delete: async (k: string) => { kvStore.delete(k); },
};
const baseEnv = {
  ACCESS_CODE: CODE, SESSION_SECRET: "s", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k",
  RATE_LIMIT: kv,
};
const call = (h: (r: Request, e: typeof baseEnv) => Promise<Response>, body: unknown, env: Record<string, unknown> = baseEnv) =>
  h(new Request("https://x/api/auth", { method: "POST", body: JSON.stringify(body) }), env as typeof baseEnv)
    .then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

beforeEach(async () => {
  kvStore.clear();
  saves = 0;
  family = {
    profiles: [{ id: "me", label: "나", pin_hash: await sha(`pin:${CODE}:me:1234`), is_admin: true, pin_version: 0 }],
    master_code_hash: await sha("master:my-master"),
  };
});

// ── 비밀 질문 ───────────────────────────────────────────────────────────────

describe("비밀 질문 — 소스에 정답이 없다", () => {
  const src = readFileSync(fileURLToPath(new URL("./data-server.ts", import.meta.url)), "utf8");
  it("하드코딩 정답 배열·평문 비교가 없다", () => {
    expect(src).not.toContain("SECRET_QUESTIONS_ANSWERS");
    expect(src).not.toMatch(/answer\.trim\(\)\s*===/);
    // 공개 저장소에 정답을 다시 넣지 못하게: 문자열 리터럴 배열을 정답 비교에 쓰지 않는다
    expect(src).toContain("SECRET_QUESTION_ANSWER_HASHES");
  });
});

describe("비밀 질문 — secret 이 없으면 비활성(fail closed)", () => {
  it("env 미설정: 어떤 답도 ok:false, disabled:true 이고 속도 제한 카운트도 올리지 않는다", async () => {
    expect(isSecretQuestionEnabled(baseEnv)).toBe(false);
    for (const [i, a] of [[0, "x"], [1, ""], [2, "alpha-one"], [3, "아무거나"], [4, "서울"]] as const) {
      const r = await call(handleVerifySecretQuestion, { sqIdx: i, answer: a });
      expect(r.json).toEqual({ ok: false, disabled: true });
    }
    expect([...kvStore.keys()].filter((k) => k.startsWith("rl:sq"))).toEqual([]);
  });

  it.each([
    ["JSON 아님", "not-json"],
    ["길이 4", JSON.stringify(["a".repeat(64), "a".repeat(64), "a".repeat(64), "a".repeat(64)])],
    ["해시 형식 아님", JSON.stringify(["x", "x", "x", "x", "x"])],
    ["객체", JSON.stringify({ 0: "a" })],
  ])("모양이 틀린 secret(%s)도 비활성", async (_n, raw) => {
    const env = { ...baseEnv, SECRET_QUESTION_ANSWER_HASHES: raw };
    expect(isSecretQuestionEnabled(env)).toBe(false);
    expect((await call(handleVerifySecretQuestion, { sqIdx: 0, answer: "alpha-one" }, env)).json).toEqual({ ok: false, disabled: true });
  });
});

describe("비밀 질문 — 새 정답 해시를 등록하면 동작한다", () => {
  let env: typeof baseEnv & { SECRET_QUESTION_ANSWER_HASHES: string };
  beforeEach(async () => { env = { ...baseEnv, SECRET_QUESTION_ANSWER_HASHES: await hashesJson() }; });

  it("새 정답은 통과하고 오답·다른 번호의 정답·범위 밖 번호는 거부한다", async () => {
    expect((await call(handleVerifySecretQuestion, { sqIdx: 0, answer: "alpha-one" }, env)).json.ok).toBe(true);
    expect((await call(handleVerifySecretQuestion, { sqIdx: 0, answer: " alpha-one " }, env)).json.ok).toBe(true); // trim
    expect((await call(handleVerifySecretQuestion, { sqIdx: 0, answer: "bravo-two" }, env)).json.ok).toBe(false);
    expect((await call(handleVerifySecretQuestion, { sqIdx: 9, answer: "alpha-one" }, env)).json.ok).toBe(false);
    expect((await call(handleVerifySecretQuestion, { sqIdx: -1, answer: "alpha-one" }, env)).json.ok).toBe(false);
  });

  it("속도 제한: 틀린 답이 10번 쌓이면 맞는 답도 잠시 거부한다", async () => {
    for (let n = 0; n < 10; n++) await call(handleVerifySecretQuestion, { sqIdx: 1, answer: "wrong" }, env);
    expect((await call(handleVerifySecretQuestion, { sqIdx: 1, answer: "bravo-two" }, env)).json.ok).toBe(false);
  });

  it("PIN 재설정: 새 정답으로 가능하고 오답은 403", async () => {
    const bad = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "4321", sqIdx: 2, sqAnswer: "nope" }, env);
    expect(bad.status).toBe(403);
    expect(saves).toBe(0);
    const ok = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "4321", sqIdx: 2, sqAnswer: "charlie-three" }, env);
    expect(ok.status).toBe(200);
    expect(saves).toBe(1);
  });
});

// ── 정상 사용자는 잠기지 않는다 ─────────────────────────────────────────────

describe("비밀 질문이 꺼져 있어도 정상 인증 경로는 그대로", () => {
  it("현재 PIN 으로 로그인한다", async () => {
    const r = await call(handleVerifyPin, { code: CODE, profileId: "me", pin: "1234" });
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.token).toBe("string");
    expect((await call(handleVerifyPin, { code: CODE, profileId: "me", pin: "0000" })).json.ok).toBe(false);
  });

  it("마스터 코드로 확인한다(설정된 마스터)", async () => {
    expect((await call(handleVerifyMaster, { code: CODE, entered: "my-master" })).json.ok).toBe(true);
    expect((await call(handleVerifyMaster, { code: CODE, entered: "wrong" })).json.ok).toBe(false);
  });

  it("현재 PIN 으로 PIN 을 바꾼다 / 마스터 코드로 PIN 을 재설정한다", async () => {
    const a = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "9999", currentPin: "1234" });
    expect(a.status).toBe(200);
    const b = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "5555", masterCode: "my-master" });
    expect(b.status).toBe(200);
    expect(saves).toBe(2);
  });

  it("마스터 코드는 현재 마스터로 바꾼다", async () => {
    const r = await call(handleSetMaster, { code: CODE, newCode: "new-master", currentMaster: "my-master" });
    expect(r.status).toBe(200);
    expect((await call(handleVerifyMaster, { code: CODE, entered: "new-master" })).json.ok).toBe(true);
  });
});

describe("비밀 질문이 꺼져 있으면 그것으로는 아무 것도 바꿀 수 없다", () => {
  it("옛 정답 형식(짧은 문자열)으로 PIN 재설정 → 403, 저장 없음", async () => {
    for (const a of ["서울", "축구", "가나", "12", "x"]) {
      for (let i = 0; i < 5; i++) {
        const r = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "0000", sqIdx: i, sqAnswer: a });
        expect(r.status).toBe(403);
      }
    }
    expect(saves).toBe(0);
  });

  it("마스터 코드 초기화도 403, 저장 없음", async () => {
    const r = await call(handleSetMaster, { code: CODE, newCode: "hijack", sqIdx: 0, sqAnswer: "x" });
    expect(r.status).toBe(403);
    expect(saves).toBe(0);
    expect(family.master_code_hash).toBe(await sha("master:my-master"));
  });
});

// ── 마스터 코드: 미설정 fail-closed ─────────────────────────────────────────

async function sessionToken(profile: string, pinVersion = 0): Promise<string> {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = b64(new TextEncoder().encode(JSON.stringify({ code: CODE, profile, exp: Math.floor(Date.now() / 1000) + 3600, v: pinVersion })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64(sig)}`;
}
const callAuthed = async (h: (r: Request, e: typeof baseEnv) => Promise<Response>, body: unknown, token: string | null, env: Record<string, unknown> = baseEnv) =>
  h(new Request("https://x/api/auth", {
    method: "POST", body: JSON.stringify(body),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), env as typeof baseEnv).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));
const callDelete = (body: unknown) =>
  handleDeleteProfile(new Request("https://x/api/auth", { method: "POST", body: JSON.stringify(body) }), baseEnv as never, false)
    .then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

describe("마스터 코드 미설정 — 액세스 코드로 우회할 수 없다", () => {
  beforeEach(() => { family.master_code_hash = null; });

  it("**액세스 코드를 마스터로 넣어도 거부한다**", async () => {
    expect((await call(handleVerifyMaster, { code: CODE, entered: CODE })).json.ok).toBe(false);
    expect((await call(handleVerifyMaster, { code: CODE, entered: ` ${CODE} ` })).json.ok).toBe(false);
    expect((await call(handleVerifyMaster, { code: CODE, entered: "" })).json.ok).toBe(false);
  });

  it("미설정이면 마스터로 PIN 재설정·프로필 추가·삭제·마스터 변경이 모두 403 이고 저장하지 않는다", async () => {
    const a = await call(handleSetPin, { code: CODE, profileId: "me", newPin: "0000", masterCode: CODE });
    const b = await call(handleAddProfile, { code: CODE, label: "침입", pin: "1111", masterCode: CODE });
    const c = await callDelete({ code: CODE, profileId: "me", masterCode: CODE });
    const d = await call(handleSetMaster, { code: CODE, newCode: "attacker-master", currentMaster: CODE });
    expect([a.status, b.status, c.status, d.status]).toEqual([403, 403, 403, 403]);
    expect(saves).toBe(0);
  });

  it("미설정 가족의 마스터 시도는 속도 제한을 소모하지 않는다(정상 사용자 잠금 방지)", async () => {
    for (let i = 0; i < 20; i++) await call(handleVerifyMaster, { code: CODE, entered: "guess" + i });
    expect([...kvStore.keys()].filter((k) => k.startsWith("rl:master"))).toEqual([]);
  });

  it("PIN 으로 로그인·현재 PIN 으로 PIN 변경은 미설정이어도 그대로 된다", async () => {
    expect((await call(handleVerifyPin, { code: CODE, profileId: "me", pin: "1234" })).json.ok).toBe(true);
    expect((await call(handleSetPin, { code: CODE, profileId: "me", newPin: "2222", currentPin: "1234" })).status).toBe(200);
  });

  it("hasMasterCode 는 실제 설정 여부를 정확히 알린다", async () => {
    const unset = await call(handleAuthFamily, { code: CODE });
    expect(unset.json.hasMasterCode).toBe(false);
    family.master_code_hash = await sha("master:long-enough-master");
    const set = await call(handleAuthFamily, { code: CODE });
    expect(set.json.hasMasterCode).toBe(true);
    expect(JSON.stringify(set.json)).not.toContain(family.master_code_hash);
  });
});

describe("마스터 코드 최초 설정(미설정 가족) — 로그인한 관리자 세션만", () => {
  beforeEach(() => { family.master_code_hash = null; });

  it("관리자 세션이면 설정되고, 이후 그 코드로만 인증된다", async () => {
    const t = await sessionToken("me");
    const r = await callAuthed(handleSetMaster, { code: CODE, newCode: "brand-new-master" }, t);
    expect(r.status).toBe(200);
    expect(r.json.hasMasterCode).toBe(true);
    expect((await call(handleVerifyMaster, { code: CODE, entered: "brand-new-master" })).json.ok).toBe(true);
    expect((await call(handleVerifyMaster, { code: CODE, entered: CODE })).json.ok).toBe(false);
  });

  it("세션이 없거나 위조·만료·없는 프로필·PIN 변경 전 옛 세션이면 거부한다", async () => {
    const body = { code: CODE, newCode: "brand-new-master" };
    expect((await callAuthed(handleSetMaster, body, null)).status).toBe(403);
    expect((await callAuthed(handleSetMaster, body, "forged.token")).status).toBe(403);
    expect((await callAuthed(handleSetMaster, body, await sessionToken("ghost"))).status).toBe(403);
    family.profiles[0].pin_version = 3;
    expect((await callAuthed(handleSetMaster, body, await sessionToken("me", 0))).status).toBe(403);
    expect(saves).toBe(0);
  });

  it("관리자가 아닌 프로필의 세션은 거부한다", async () => {
    family.profiles.push({ id: "guest", label: "손님", pin_hash: await sha(`pin:${CODE}:guest:5678`), is_admin: false, pin_version: 0 });
    expect((await callAuthed(handleSetMaster, { code: CODE, newCode: "brand-new-master" }, await sessionToken("guest"))).status).toBe(403);
  });

  it("공개값(액세스 코드)·짧은 코드는 마스터로 설정할 수 없다", async () => {
    const t = await sessionToken("me");
    for (const bad of [CODE, ` ${CODE} `, CODE.toUpperCase(), "short", "1234567"]) {
      expect((await callAuthed(handleSetMaster, { code: CODE, newCode: bad }, t)).status).toBe(400);
    }
    expect(saves).toBe(0);
  });

  it("비밀 질문이 꺼져 있으면 그것으로 최초 설정할 수 없고, 운영자가 켠 경우에만 된다", async () => {
    expect((await call(handleSetMaster, { code: CODE, newCode: "brand-new-master", sqIdx: 0, sqAnswer: "x" })).status).toBe(403);
    const env = { ...baseEnv, SECRET_QUESTION_ANSWER_HASHES: await hashesJson() };
    expect((await call(handleSetMaster, { code: CODE, newCode: "brand-new-master", sqIdx: 0, sqAnswer: NEW_ANSWERS[0] }, env)).status).toBe(200);
  });
});

describe("마스터 코드 설정된 가족 — 기존 방식 그대로", () => {
  beforeEach(async () => { family.master_code_hash = await sha("master:existing-master"); });

  it("현재 마스터로 인증·변경된다", async () => {
    expect((await call(handleVerifyMaster, { code: CODE, entered: "existing-master" })).json.ok).toBe(true);
    expect((await call(handleSetMaster, { code: CODE, newCode: "changed-master-1", currentMaster: "existing-master" })).status).toBe(200);
  });

  it("틀린 마스터·액세스 코드·로그인 세션만으로는 변경할 수 없다", async () => {
    expect((await call(handleSetMaster, { code: CODE, newCode: "changed-master-1", currentMaster: "wrong" })).status).toBe(403);
    expect((await call(handleSetMaster, { code: CODE, newCode: "changed-master-1", currentMaster: CODE })).status).toBe(403);
    const t = await sessionToken("me");
    expect((await callAuthed(handleSetMaster, { code: CODE, newCode: "changed-master-1" }, t)).status).toBe(403);
    expect(saves).toBe(0);
  });

  it("프로필 추가는 마스터로 되고 액세스 코드로는 거부된다", async () => {
    expect((await call(handleAddProfile, { code: CODE, label: "새", pin: "1111", masterCode: CODE })).status).toBe(403);
    expect((await call(handleAddProfile, { code: CODE, label: "새", pin: "1111", masterCode: "existing-master" })).status).toBe(200);
  });
});
