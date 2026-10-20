// 서버(Cloudflare Worker) 전용 모듈. 절대 클라이언트 번들에 import되면 안 됨.
// Supabase는 여기(service_role 키)에서만 접근하고, 브라우저는 이 모듈이 노출하는
// 인증된 API를 통해서만 데이터를 읽고 쓴다.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS, BUILTIN_TICKERS } from "./constants";
import {
  isInvalidParameter, isSerializationFailure, isUndefinedFunction,
  parseExpectedRevisions, readGuardedSaveResult, splitGuardRows,
  type ExpectedRevisions,
} from "./revision-guard";
import {
  buildDailySnapshotRows, kstDateString, SNAPSHOT_UPSERT_CONFLICT,
  type SnapshotAccountInput, type SnapshotPrice,
} from "./snapshot";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DataEnv {
  /**
   * 무가드 저장 차단 스위치. 정확히 "on" 이면 `/api/data` 의 **expectedRevisions 없는 계좌 쓰기**를
   * 428 로 거부한다(아무 행도 쓰지 않는다). **기본 OFF** — 켜기 전에 가드 ON 클라이언트가 배포돼
   * 있어야 한다(아니면 모든 저장이 막힌다).
   */
  KAW_REQUIRE_REVISION?: string;
  /**
   * 비밀 질문 새 정답의 해시(JSON 배열 5개). 없으면 비밀 질문 인증은 비활성이다.
   * 정답 자체를 소스·저장소에 두지 않는다.
   */
  SECRET_QUESTION_ANSWER_HASHES?: string;
  /**
   * 초기 설정 코드의 해시(sha256("setup:<가족 코드>:<설정 코드>"), secret). **아직 아무도 PIN 을 설정하지 않은**
   * 가족의 첫 PIN 등록에만 쓴다. 없으면 그 등록은 불가능하다(fail closed).
   */
  FAMILY_SETUP_CODE_HASH?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SESSION_SECRET?: string;
  ACCESS_CODE?: string;
  RATE_LIMIT?: KVLike;
}

export const isRevisionRequired = (env: Pick<DataEnv, "KAW_REQUIRE_REVISION">): boolean =>
  env.KAW_REQUIRE_REVISION === "on";

/** 공용 JSON 응답 (no-store). 원장 API 등 다른 핸들러 모듈도 같은 모양을 쓰도록 export 한다. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// PIN/마스터코드/비밀질문처럼 "맞는 값 하나를 추측"하는 검증마다 공통으로 거치는 무차별 대입 방지.
// 실패할 때마다 카운트가 올라가고, 성공하면 리셋. KV가 없으면(설정 오류) 막지 않고 그냥 통과시킴 —
// 세션 토큰/PIN 해시라는 1차 방어선은 그대로 있으므로 가용성을 우선함.
async function checkRateLimit(env: DataEnv, key: string, limit: number, windowSec: number): Promise<boolean> {
  const kv = env.RATE_LIMIT;
  if (!kv) return true;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}
async function resetRateLimit(env: DataEnv, key: string): Promise<void> {
  if (env.RATE_LIMIT) await env.RATE_LIMIT.delete(key).catch(() => {});
}

let cachedClient: { url: string; client: SupabaseClient } | null = null;
/** service_role Supabase 클라이언트 (isolate 캐시). 원장 API 가 같은 클라이언트를 쓰도록 export 한다. */
export function serviceClient(env: DataEnv): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (cachedClient?.url === env.SUPABASE_URL) return cachedClient.client;
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  cachedClient = { url: env.SUPABASE_URL, client };
  return client;
}

// ── 해시/서명 유틸 (Web Crypto — Workers 런타임 내장) ────────────────────────
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const str = atob(padded);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export interface SessionPayload { code: string; profile: string; exp: number; v: number }

async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig) as BufferSource, new TextEncoder().encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// ── 가족 코드 기반 PIN 해시 (기존 auth.ts와 동일한 스킴 — 기존 저장값 호환) ──
async function hashPin(code: string, profileId: string, pin: string): Promise<string> {
  return sha256Hex(`pin:${code}:${profileId}:${pin}`);
}
async function hashMaster(entered: string): Promise<string> {
  return sha256Hex(`master:${entered}`);
}

// ── 비밀 질문 ──────────────────────────────────────────────────────────────
// **정답은 소스에 두지 않는다.** 예전 정답이 공개 저장소(소스·git 이력)에 있었으므로 그 값은
// 더 이상 인증 근거가 아니다(= 이미 노출된 값). 서버는 운영자가 Cloudflare secret
// `SECRET_QUESTION_ANSWER_HASHES`(길이 5 JSON 배열, 각 원소 = sha256("sq:<번호>:<정답 trim>"))에
// 넣은 **새 정답의 해시**로만 검증한다. 이 secret 이 없거나 모양이 틀리면 비밀 질문 인증은
// **비활성(fail closed)** 이며 마스터 코드·현재 PIN 인증은 그대로 동작한다.
const SQ_COUNT = 5;

function secretQuestionHashes(env: DataEnv): string[] | null {
  const raw = env.SECRET_QUESTION_ANSWER_HASHES;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || v.length !== SQ_COUNT) return null;
    if (!v.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))) return null;
    return v as string[];
  } catch {
    return null;
  }
}

/** 비밀 질문 인증이 켜져 있는가(운영자가 새 정답 해시를 등록했는가). */
export const isSecretQuestionEnabled = (env: DataEnv): boolean => secretQuestionHashes(env) !== null;

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// pin_version: PIN이 바뀔 때마다 증가 — 세션 토큰에 발급 당시 버전을 같이 담아둬서,
// PIN이 바뀐 뒤에는 그 전에 발급된 토큰이 자동으로 무효화되게 한다.
interface ProfileConfig { id: string; label: string; pin_hash: string | null; is_admin: boolean; pin_version?: number }
interface FamilyData { profiles: ProfileConfig[]; master_code_hash?: string | null; deleted_profiles?: ProfileConfig[] }

function defaultFamilyData(): FamilyData {
  return {
    profiles: [
      { id: "hyeobi", label: "혀비", pin_hash: null, is_admin: true },
      { id: "dayoung", label: "다영", pin_hash: null, is_admin: true },
    ],
    master_code_hash: null,
  };
}

async function loadFamilyRaw(client: SupabaseClient, code: string): Promise<FamilyData> {
  const { data } = await client
    .from("kaw_data").select("data")
    .eq("family_code", code).eq("profile", "_system").eq("account_type", "_family")
    .maybeSingle();
  return (data?.data as FamilyData) ?? defaultFamilyData();
}

async function saveFamilyRaw(client: SupabaseClient, code: string, family: FamilyData): Promise<void> {
  const { error } = await client.from("kaw_data").upsert(
    { family_code: code, profile: "_system", account_type: "_family", data: family, updated_at: new Date().toISOString() },
    { onConflict: "family_code,profile,account_type" },
  );
  if (error) throw new Error(error.message);
}

// ── 가족 설정 행의 낙관적 잠금 ───────────────────────────────────────────────
// 가족 설정(`_system/_family`)은 통째로 교체되는 문서라서, 읽은 뒤 쓰기 전에 다른 변경이 끼면
// 그 변경을 지운다(PIN 설정·프로필 추가·삭제 사이의 경합). 쓰는 방식은 읽은 상태로 정해진다:
//   cas     행이 있고 revision 을 읽었다 → 읽은 revision 과 같을 때만 쓰고 +1(migration 006)
//   insert  행이 없다(새 가족) → INSERT. 동시 생성은 유일 제약이 하나만 통과시킨다
//   legacy  revision 컬럼을 읽을 수 없다(구 스키마·테스트 더블) → 기존 upsert
interface FamilyLoad { family: FamilyData; mode: "cas" | "insert" | "legacy"; revision: number | null }

async function loadFamilyVersioned(client: SupabaseClient, code: string): Promise<FamilyLoad> {
  const { data, error } = await client
    .from("kaw_data").select("data, revision")
    .eq("family_code", code).eq("profile", "_system").eq("account_type", "_family")
    .maybeSingle();
  if (error) return { family: await loadFamilyRaw(client, code), mode: "legacy", revision: null };
  const row = data as { data?: FamilyData; revision?: unknown } | null;
  if (!row) return { family: defaultFamilyData(), mode: "insert", revision: null };
  if (typeof row.revision !== "number") return { family: row.data ?? defaultFamilyData(), mode: "legacy", revision: null };
  return { family: row.data ?? defaultFamilyData(), mode: "cas", revision: row.revision };
}

const CONFLICT_BODY = { error: "동시에 다른 변경이 있어 저장하지 않았습니다. 다시 시도해 주세요." };

/** 충돌이면 409 응답을, 성공하면 null 을 돌려준다. */
async function commitFamily(
  client: SupabaseClient, code: string, family: FamilyData, load: FamilyLoad,
): Promise<Response | null> {
  const now = new Date().toISOString();
  if (load.mode === "legacy") {
    await saveFamilyRaw(client, code, family);
    return null;
  }
  if (load.mode === "insert") {
    const { error } = await client.from("kaw_data").insert({
      family_code: code, profile: "_system", account_type: "_family", data: family, updated_at: now,
    });
    if (!error) return null;
    if ((error as { code?: string }).code === "23505") return json(CONFLICT_BODY, 409);
    throw new Error(error.message);
  }
  const { data, error } = await client.from("kaw_data")
    .update({ data: family, updated_at: now, revision: (load.revision ?? 0) + 1 })
    .eq("family_code", code).eq("profile", "_system").eq("account_type", "_family")
    .eq("revision", load.revision ?? 0)
    .select("revision");
  if (error) throw new Error(error.message);
  if (!data?.length) return json(CONFLICT_BODY, 409);
  return null;
}

/** 초기 설정 코드 검증. 해시가 없으면 비활성(fail closed). */
async function verifySetupCode(env: DataEnv, entered: string, code: string): Promise<boolean> {
  const expected = env.FAMILY_SETUP_CODE_HASH;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return false;
  // 추측 횟수를 제한할 수 없으면(KV 미설정) 이 경로를 쓰지 않는다 — 마스터·PIN 과 달리 새 경로라
  // 가용성보다 닫힌 쪽을 택한다.
  if (!env.RATE_LIMIT) return false;
  const rlKey = `rl:setup:${code}`;
  if (!(await checkRateLimit(env, rlKey, 10, 10 * 60))) return false;
  // 가족 코드에 묶는다: 다른 가족·환경에서 만든 같은 문자열의 해시가 재사용되지 않는다.
  const ok = constantTimeEqualHex(await sha256Hex(`setup:${code}:${entered.trim()}`), expected);
  if (ok) await resetRateLimit(env, rlKey);
  return ok;
}

/**
 * 어느 프로필이든(삭제된 프로필 포함) PIN 이 한 번이라도 설정됐는가. 삭제된 프로필을 빼면, PIN 을
 * 가진 프로필을 모두 삭제한 가족이 "초기화 전"으로 보여 설정 코드 경로가 다시 열린다.
 */
function familyHasAnyPin(f: FamilyData): boolean {
  return [...f.profiles, ...(f.deleted_profiles ?? [])].some((p) => Boolean(p.pin_hash));
}

function sanitizeProfile(p: ProfileConfig) {
  return { id: p.id, label: p.label, is_admin: p.is_admin, pin_hash: p.pin_hash ? "•" : null };
}
function sanitizeFamily(f: FamilyData) {
  return {
    profiles: f.profiles.map(sanitizeProfile),
    deleted_profiles: (f.deleted_profiles ?? []).map(sanitizeProfile),
    // 실제로 설정돼 있는가. (예전에는 항상 true 였다 — 미설정이어도 액세스 코드가 마스터로 통했기 때문.
    // 지금은 미설정이면 마스터 인증이 **거부**되므로, 화면이 "초기 설정"을 안내할 수 있어야 한다.)
    hasMasterCode: Boolean(f.master_code_hash),
    // 어느 프로필이든 PIN 이 한 번이라도 설정됐는가. false 면 "초기 등록" 가족이다 —
    // 첫 PIN 은 운영자가 발급한 설정 코드(또는 마스터)로만 등록할 수 있다.
    initialized: familyHasAnyPin(f),
  };
}

/**
 * 마스터 코드 검증. **설정된 마스터만 인정한다(fail closed).**
 *
 * 예전에는 master_code_hash 가 없으면 액세스 코드(`code`)를 마스터로 받아들였다. 그 값은 브라우저
 * 번들과 공개 저장소에 있어서, 미설정 가족은 누구나 마스터 권한(프로필 추가·삭제, PIN 재설정,
 * 마스터 변경)을 얻을 수 있었다. 이제 미설정이면 어떤 입력도 거부한다 — 속도 제한 카운트도 올리지
 * 않는다(미설정 가족의 마스터 시도가 정상 사용자를 잠그지 못하게).
 * 미설정 가족의 최초 설정은 `handleSetMaster` 의 "로그인한 관리자 세션" 경로로만 한다.
 */
async function verifyMaster(env: DataEnv, family: FamilyData, entered: string, code: string): Promise<boolean> {
  if (!family.master_code_hash) return false;
  const rlKey = `rl:master:${code}`;
  if (!(await checkRateLimit(env, rlKey, 10, 10 * 60))) return false;
  const ok = (await hashMaster(entered)) === family.master_code_hash;
  if (ok) await resetRateLimit(env, rlKey);
  return ok;
}

/** 새 마스터 코드의 최소 요건. 액세스 코드(공개값)와 같거나 너무 짧으면 거부한다. */
export const MASTER_MIN_LENGTH = 8;
function masterCodeProblem(newCode: string, code: string): string | null {
  const t = newCode.trim();
  if (t.length < MASTER_MIN_LENGTH) return `마스터 코드는 ${MASTER_MIN_LENGTH}자 이상이어야 합니다.`;
  if (t === code || t.toLowerCase() === code.toLowerCase()) return "마스터 코드는 액세스 코드와 달라야 합니다.";
  return null;
}

async function verifyPinHash(env: DataEnv, code: string, profileId: string, pin: string, expectedHash: string | null): Promise<boolean> {
  if (!expectedHash) return false;
  const rlKey = `rl:pin:${code}:${profileId}`;
  if (!(await checkRateLimit(env, rlKey, 8, 10 * 60))) return false;
  const ok = (await hashPin(code, profileId, pin)) === expectedHash;
  if (ok) await resetRateLimit(env, rlKey);
  return ok;
}

// 토큰 서명·만료뿐 아니라, 발급 이후 PIN이 바뀌지 않았는지(pin_version 일치)까지 확인
async function sessionStillValid(client: SupabaseClient, session: SessionPayload): Promise<boolean> {
  const family = await loadFamilyRaw(client, session.code);
  const profile = family.profiles.find((p) => p.id === session.profile);
  return (profile?.pin_version ?? 0) === session.v;
}

/**
 * 세션 토큰 검증만 하는 공용 helper (`handleDataGet` / `handleSnapshotsGet` 와 같은 경로).
 *
 * DB 를 읽지 않는 endpoint 가 기존 인증 패턴을 그대로 쓰기 위해 export 한다 — 예: 과거 종가
 * 구간 조회. 가격 자체는 public data 지만, 구간 × 종목 수만큼 외부 API 를 부르는 경로를
 * 무인증으로 열어두지 않는다.
 */
export async function requireSession(
  request: Request,
  env: DataEnv,
): Promise<SessionPayload | null> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return null;
  const token = bearerToken(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session || !(await sessionStillValid(client, session))) return null;
  return session;
}

async function verifySecretQuestion(env: DataEnv, sqIdx: number, answer: string): Promise<boolean> {
  const hashes = secretQuestionHashes(env);
  if (!hashes) return false; // 비활성: 어떤 답도 통과하지 않는다(속도 제한 카운트도 올리지 않는다)
  if (!Number.isInteger(sqIdx) || sqIdx < 0 || sqIdx >= SQ_COUNT) return false;
  const rlKey = `rl:sq:${sqIdx}`;
  if (!(await checkRateLimit(env, rlKey, 10, 10 * 60))) return false;
  const given = await sha256Hex(`sq:${sqIdx}:${answer.trim()}`);
  const ok = constantTimeEqualHex(given, hashes[sqIdx]);
  if (ok) await resetRateLimit(env, rlKey);
  return ok;
}

// ── 요청 핸들러 ───────────────────────────────────────────────────────────
export async function handleAuthFamily(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code || code !== env.ACCESS_CODE) return json({ error: "액세스 코드가 올바르지 않습니다." }, 401);
  if (!client) return json({ ...sanitizeFamily(defaultFamilyData()), isNew: true });

  // 이 family_code 로 저장된 행이 하나도 없으면 신규 — **쓰지 않는다.** 액세스 코드는 공개값이라
  // 인증 없는 요청이 DB 행을 만들게 두지 않는다. 기본 프로필 목록만 돌려주고, 설정 행은
  // 인증된 첫 PIN 등록(handleSetPin)이 만든다.
  const { data: existing } = await client.from("kaw_data").select("id").eq("family_code", code).limit(1);
  const isNew = !existing?.length;
  const family = isNew ? defaultFamilyData() : await loadFamilyRaw(client, code);
  return json({ ...sanitizeFamily(family), isNew });
}

export async function handleVerifyPin(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; profileId?: unknown; pin?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!code || code !== env.ACCESS_CODE || !profileId || !pin) return json({ ok: false });

  const family = await loadFamilyRaw(client, code);
  const all = [...family.profiles, ...(family.deleted_profiles ?? [])];
  const profile = all.find((p) => p.id === profileId);
  if (!(await verifyPinHash(env, code, profileId, pin, profile?.pin_hash ?? null))) return json({ ok: false });

  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const token = await signSession({ code, profile: profileId, exp, v: profile?.pin_version ?? 0 }, env.SESSION_SECRET);
  return json({ ok: true, token });
}

export async function handleVerifyMaster(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; entered?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const entered = typeof body.entered === "string" ? body.entered : "";
  if (!client || !code || code !== env.ACCESS_CODE) return json({ ok: false });
  const family = await loadFamilyRaw(client, code);
  return json({ ok: await verifyMaster(env, family, entered, code) });
}

export async function handleVerifySecretQuestion(request: Request, env: DataEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { sqIdx?: unknown; answer?: unknown };
  const idx = typeof body.sqIdx === "number" ? body.sqIdx : -1;
  const answer = typeof body.answer === "string" ? body.answer : "";
  if (!isSecretQuestionEnabled(env)) return json({ ok: false, disabled: true });
  const ok = await verifySecretQuestion(env, idx, answer);
  return json({ ok });
}

// PIN 설정/변경 승인 방식.
//   · PIN 이 이미 있는 프로필: (1) 현재 PIN (2) 마스터 코드 (3) 비밀 질문(운영자가 새 정답을 등록한 경우)
//   · PIN 이 아직 없는 프로필(최초 설정) — **공개된 액세스 코드만으로는 되지 않는다**:
//       (1) 같은 가족의 **다른 관리자**가 PIN 으로 로그인한 세션(서명·만료·pin_version 검증)
//       (2) 마스터 코드 (3) 운영자가 발급한 초기 설정 코드 — 아무도 PIN 을 설정하지 않은 가족만
//       (4) 비밀 질문(운영자가 새 정답을 등록한 경우)
export async function handleSetPin(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown; profileId?: unknown; newPin?: unknown;
    currentPin?: unknown; masterCode?: unknown; setupCode?: unknown; sqIdx?: unknown; sqAnswer?: unknown;
  };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  const newPin = typeof body.newPin === "string" ? body.newPin : "";
  if (!code || code !== env.ACCESS_CODE || !profileId || !/^\d{4}$/.test(newPin)) {
    return json({ error: "잘못된 요청입니다." }, 400);
  }

  const load = await loadFamilyVersioned(client, code);
  const family = load.family;
  const profile = family.profiles.find((p) => p.id === profileId);
  if (!profile) return json({ error: "프로필을 찾을 수 없습니다." }, 404);

  let authorized = false;
  if (profile.pin_hash) {
    if (typeof body.currentPin === "string") {
      authorized = await verifyPinHash(env, code, profileId, body.currentPin, profile.pin_hash);
    }
  } else {
    // (1) 다른 관리자의 PIN 로그인 세션. requireSession 이 서명·만료·pin_version 을 확인한다.
    const session = await requireSession(request, env);
    if (session && session.code === code && session.profile !== profileId) {
      const actor = family.profiles.find((p) => p.id === session.profile);
      authorized = actor?.is_admin === true && Boolean(actor.pin_hash);
    }
    // (3) 초기 설정 코드 — 아무 프로필도 PIN 이 없는 가족에서만
    if (!authorized && typeof body.setupCode === "string" && !familyHasAnyPin(family)) {
      authorized = await verifySetupCode(env, body.setupCode, code);
    }
  }
  if (!authorized && typeof body.masterCode === "string") {
    authorized = await verifyMaster(env, family, body.masterCode, code);
  }
  if (!authorized && typeof body.sqIdx === "number" && typeof body.sqAnswer === "string") {
    authorized = await verifySecretQuestion(env, body.sqIdx, body.sqAnswer);
  }
  if (!authorized) return json({ error: "인증에 실패했습니다." }, 403);

  const hash = await hashPin(code, profileId, newPin);
  const updated: FamilyData = {
    ...family,
    profiles: family.profiles.map((p) =>
      p.id === profileId ? { ...p, pin_hash: hash, pin_version: (p.pin_version ?? 0) + 1 } : p,
    ),
  };
  const conflict = await commitFamily(client, code, updated, load);
  if (conflict) return conflict;
  return json(sanitizeFamily(updated));
}

export async function handleSetMaster(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown; newCode?: unknown; currentMaster?: unknown; sqIdx?: unknown; sqAnswer?: unknown;
  };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const newCode = typeof body.newCode === "string" ? body.newCode : "";
  if (!code || code !== env.ACCESS_CODE || !newCode.trim()) return json({ error: "잘못된 요청입니다." }, 400);

  const load = await loadFamilyVersioned(client, code);
  const family = load.family;
  let authorized = false;
  if (family.master_code_hash) {
    // 설정돼 있다: 현재 마스터 코드로만 바꾼다(기존 방식 그대로).
    if (typeof body.currentMaster === "string") authorized = await verifyMaster(env, family, body.currentMaster, code);
  } else {
    // **미설정: 최초 설정.** 액세스 코드 같은 공개값으로는 되지 않는다 — PIN 으로 로그인한
    // 관리자 프로필의 세션이 있어야 한다.
    const session = await requireSession(request, env);
    if (session && session.code === code) {
      authorized = family.profiles.find((p) => p.id === session.profile)?.is_admin === true;
    }
  }
  // 운영자가 새 정답 해시를 등록했을 때만 비밀 질문이 통한다(기본 비활성).
  if (!authorized && typeof body.sqIdx === "number" && typeof body.sqAnswer === "string") {
    authorized = await verifySecretQuestion(env, body.sqIdx, body.sqAnswer);
  }
  if (!authorized) return json({ error: "인증에 실패했습니다." }, 403);

  const problem = masterCodeProblem(newCode, code);
  if (problem) return json({ error: problem }, 400);

  const updated: FamilyData = { ...family, master_code_hash: await hashMaster(newCode) };
  const conflict = await commitFamily(client, code, updated, load);
  if (conflict) return conflict;
  return json(sanitizeFamily(updated));
}

export async function handleAddProfile(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown; label?: unknown; pin?: unknown; masterCode?: unknown;
  };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  const masterCode = typeof body.masterCode === "string" ? body.masterCode : "";
  if (!code || code !== env.ACCESS_CODE || !label || !/^\d{4}$/.test(pin)) {
    return json({ error: "잘못된 요청입니다." }, 400);
  }
  const load = await loadFamilyVersioned(client, code);
  const family = load.family;
  if (!(await verifyMaster(env, family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

  const id = label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_가-힣]/g, "") || `profile_${Date.now()}`;
  const finalId = family.profiles.some((p) => p.id === id) ? `${id}_${Date.now()}` : id;
  const updated: FamilyData = {
    ...family,
    profiles: [...family.profiles, { id: finalId, label, pin_hash: await hashPin(code, finalId, pin), is_admin: false }],
  };
  const conflict = await commitFamily(client, code, updated, load);
  if (conflict) return conflict;
  return json(sanitizeFamily(updated));
}

export async function handleRestoreProfile(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; profileId?: unknown; pin?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!code || code !== env.ACCESS_CODE || !profileId) return json({ error: "잘못된 요청입니다." }, 400);

  const load = await loadFamilyVersioned(client, code);
  const family = load.family;
  const deleted = (family.deleted_profiles ?? []).find((p) => p.id === profileId);
  if (!deleted || !(await verifyPinHash(env, code, profileId, pin, deleted.pin_hash))) {
    return json({ error: "인증에 실패했습니다." }, 403);
  }
  const updated: FamilyData = {
    ...family,
    profiles: [...family.profiles, deleted],
    deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
  };
  const conflict = await commitFamily(client, code, updated, load);
  if (conflict) return conflict;
  return json(sanitizeFamily(updated));
}

export async function handleDeleteProfile(request: Request, env: DataEnv, hard: boolean): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; profileId?: unknown; masterCode?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  const masterCode = typeof body.masterCode === "string" ? body.masterCode : "";
  if (!code || code !== env.ACCESS_CODE || !profileId) return json({ error: "잘못된 요청입니다." }, 400);

  const load = await loadFamilyVersioned(client, code);
  const family = load.family;
  if (!(await verifyMaster(env, family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

  const profile = family.profiles.find((p) => p.id === profileId);
  let updated: FamilyData;
  if (hard) {
    updated = {
      ...family,
      profiles: family.profiles.filter((p) => p.id !== profileId),
      deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
    };
  } else {
    if (!profile) return json({ error: "프로필을 찾을 수 없습니다." }, 404);
    updated = {
      ...family,
      profiles: family.profiles.filter((p) => p.id !== profileId),
      deleted_profiles: [...(family.deleted_profiles ?? []), profile],
    };
  }
  const conflict = await commitFamily(client, code, updated, load);
  if (conflict) return conflict;
  // 설정 변경이 확정된 뒤에만 데이터 행을 지운다(충돌이면 아무 것도 지우지 않는다).
  if (hard) await client.from("kaw_data").delete().eq("family_code", code).eq("profile", profileId);
  return json(sanitizeFamily(updated));
}

// ── 계좌 데이터 읽기/쓰기 (세션 토큰 필요) ────────────────────────────────
export async function handleDataGet(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const token = bearerToken(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session || !(await sessionStillValid(client, session))) {
    return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  }

  // `revision` 은 **쓰기 가드의 입력**이다(migration 006/007). 클라이언트는 여기서 읽은
  // 값을 저장 요청에 담아 보내고, 서버는 지금 값과 다르면 거부한다. 구버전 클라이언트는
  // 이 필드를 무시하므로 읽기 동작은 바뀌지 않는다.
  const { data, error } = await client
    .from("kaw_data").select("account_type, data, profile, revision")
    .eq("family_code", session.code)
    .in("profile", [session.profile, "_shared"]);
  if (error) {
    // 006 미적용 DB(revision 컬럼 없음)에서도 읽기는 계속돼야 한다 — 가드만 꺼진다
    // (revision 이 없으면 클라이언트 `canGuard()` 가 false 가 된다).
    if (isUndefinedColumn((error as { code?: string }).code)) {
      const fallback = await client
        .from("kaw_data").select("account_type, data, profile")
        .eq("family_code", session.code)
        .in("profile", [session.profile, "_shared"]);
      if (fallback.error) return json({ error: fallback.error.message }, 500);
      return json({ rows: fallback.data ?? [] });
    }
    return json({ error: error.message }, 500);
  }
  return json({ rows: data ?? [] });
}

/** Postgres: 컬럼이 없음(42703). migration 006 미적용 DB 판정에만 쓴다. */
const isUndefinedColumn = (code: string | undefined): boolean => code === "42703";

/**
 * 쓰기 경로 **관측 로그**(Workers Logs). 식별자·토큰·가족코드·프로필·데이터 원문을 싣지 않는다 —
 * 어느 경로로(가드 / 무가드 / 428 차단) 계좌 행이 몇 개 왔는지만 남긴다. KAW_REQUIRE_REVISION 을
 * 켜기 전에 "무가드 요청이 더 이상 오지 않는다"를 로그로 확인하기 위한 것이다.
 * 계좌 행이 없는 요청(공용 종목 라이브러리만)은 가드 대상이 아니라 남기지 않는다.
 */
export type DataWritePath = "guarded" | "unguarded" | "blocked_428";
export function dataWriteLogLine(path: DataWritePath, accountRows: number, sharedRows: number): string | null {
  if (accountRows <= 0) return null;
  return JSON.stringify({ evt: "kaw_data_write", path, accountRows, sharedRows });
}
function logDataWrite(path: DataWritePath, rows: Array<{ profile?: unknown }>): void {
  const account = rows.filter((r) => r.profile !== "_shared").length;
  const line = dataWriteLogLine(path, account, rows.length - account);
  if (line) console.log(line);
}

export async function handleDataPost(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const token = bearerToken(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session || !(await sessionStillValid(client, session))) {
    return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  }

  const body = (await request.json().catch(() => ({}))) as {
    rows?: unknown;
    /** 있으면 **revision 가드 경로**로 저장한다(없으면 기존 무가드 upsert) */
    expectedRevisions?: unknown;
    /** 사용자가 확인한 파괴적 저장만 true. 기본값은 거부다 */
    allowHistoryShrink?: unknown;
    allowKeyLoss?: unknown;
  };
  if (!Array.isArray(body.rows)) return json({ error: "잘못된 요청입니다." }, 400);

  const rows = body.rows as Array<{ family_code?: unknown; profile?: unknown; account_type?: unknown; data?: unknown; updated_at?: unknown }>;
  const sanitized = rows.filter((r) => {
    if (r.family_code !== session.code) return false;
    if (r.profile === "_shared") return r.account_type === "_assetLib";
    return r.profile === session.profile
      && (r.account_type === "_meta" || ACCOUNT_IDS.includes(r.account_type as (typeof ACCOUNT_IDS)[number]));
  }).map((r) => ({
    family_code: session.code, profile: r.profile, account_type: r.account_type,
    data: r.data, updated_at: new Date().toISOString(),
  }));
  // `accepted` = 실제로 upsert 에 들어간 행 수. 클라이언트가 **영속을 확인**하는 유일한
  // 근거다(store.ts saveAccountRowWithAck) — 세션과 안 맞아 전부 걸러진 요청도
  // 아래에서 ok:true 를 받으므로, ok 만으로는 "저장했다"를 구분할 수 없다.
  // 기존 호출부(dbSave)는 이 필드를 읽지 않으므로 동작이 바뀌지 않는다.
  if (!sanitized.length) return json({ ok: true, accepted: 0 });

  // ── 기존(무가드) 경로 ─────────────────────────────────────────────────────
  // `expectedRevisions` 가 없는 요청은 **구버전 클라이언트**다. 그대로 last-writer-wins
  // upsert 를 한다 — 서버를 먼저 배포하고 클라이언트 가드를 나중에 켜는 단계적 배포가
  // 성립해야 하기 때문이다(migration 007 대원칙 4). 이 경로가 남아 있는 동안은
  // "가드 완료"가 아니다(revision-guard.ts UNGUARDED_WRITE_PATHS).
  if (body.expectedRevisions === undefined || body.expectedRevisions === null) {
    // 차단 스위치가 켜져 있으면 계좌 행(프로필 5행)이 하나라도 섞인 무가드 요청은 **통째로 거부**한다
    // (같이 온 공용 행도 쓰지 않는다 — 한 번의 저장이 일부만 반영되지 않게). 공용 종목 라이브러리만
    // 보내는 요청은 설계상 가드 밖이라 그대로 둔다(007 대원칙 2).
    if (isRevisionRequired(env) && sanitized.some((r) => r.profile !== "_shared")) {
      logDataWrite("blocked_428", sanitized);
      return json({
        error: "revision_required",
        message: "앱이 최신 버전이 아니라 저장하지 않았습니다. 새로고침한 뒤 다시 시도하세요.",
        saved: false,
      }, 428);
    }
    logDataWrite("unguarded", sanitized);
    const { error } = await client.from("kaw_data").upsert(sanitized, { onConflict: "family_code,profile,account_type" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, accepted: sanitized.length, guarded: false });
  }

  // ── revision 가드 경로 ───────────────────────────────────────────────────
  const expected = parseExpectedRevisions(body.expectedRevisions);
  if ("error" in expected && typeof expected.error === "string") {
    return json({ error: expected.error }, 400);
  }
  const split = splitGuardRows(sanitized, expected as ExpectedRevisions);
  if (!split.ok) return json({ error: split.error }, 400);
  logDataWrite("guarded", sanitized);

  let revisions: Record<string, number> = {};
  let accepted = 0;

  if (split.guarded.length) {
    const { data, error } = await client.rpc("kaw_data_save_guarded", {
      p_family_code: session.code,
      p_profile: session.profile,
      p_rows: split.guarded,
      // **기본값은 거부다.** 파괴적 저장은 사용자가 확인한 요청에서만 통과한다.
      p_allow_history_shrink: body.allowHistoryShrink === true,
      p_allow_key_loss: body.allowKeyLoss === true,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      if (isUndefinedFunction(code)) {
        // 007 미적용. **무가드로 되돌아가지 않는다** — 가드를 켠 클라이언트가 보호받는다고
        // 믿는 채로 last-writer-wins 로 저장되는 것이 가장 나쁘다.
        console.error("[kaw] kaw_data_save_guarded 가 없습니다 (migration 007 미적용)");
        return json({ unavailable: true, error: "저장 가드가 아직 없습니다" }, 503);
      }
      if (isSerializationFailure(code)) {
        // 검사 후 경합. 충돌과 같은 뜻이므로 409 로 돌려준다(자동 재시도하지 않는다).
        return json({ error: "revision_conflict", conflicts: [], revisions: {} }, 409);
      }
      if (isInvalidParameter(code)) return json({ error: error.message }, 400);
      console.error("[kaw] 가드 저장 실패:", error.message);
      return json({ error: error.message }, 500);
    }

    const result = readGuardedSaveResult(data);
    if (result.kind === "conflict") {
      // **공용 행도 쓰지 않는다** — 한 번의 저장이 일부만 반영되는 상태를 만들지 않는다.
      return json(
        { error: "revision_conflict", conflicts: result.conflicts, revisions: result.revisions },
        409,
      );
    }
    if (result.kind === "unexpected") {
      console.error("[kaw] 가드 저장: 알 수 없는 반환값", JSON.stringify(result.raw));
      return json({ error: "저장 결과를 해석할 수 없습니다." }, 500);
    }
    revisions = result.revisions;
    accepted += result.accepted;
  }

  // 공용 종목 라이브러리(`_shared/_assetLib`)는 **가드 밖**이다 — 가족 공용 행이라
  // 프로필마다 revision 을 밀어내서 CAS 를 걸면 상시 충돌이 된다(007 대원칙 2).
  // 기존 upsert 동작을 그대로 유지한다.
  if (split.shared.length) {
    const sharedRows = split.shared.map((r) => ({
      family_code: session.code, profile: "_shared", account_type: "_assetLib",
      data: r.data, updated_at: new Date().toISOString(),
    }));
    const { error } = await client.from("kaw_data").upsert(sharedRows, { onConflict: "family_code,profile,account_type" });
    if (error) return json({ error: error.message }, 500);
    accepted += sharedRows.length;
  }

  return json({ ok: true, accepted, guarded: true, revisions });
}

// ── 시세 캐시용 ticker 화이트리스트 ────────────────────────────────────────
// /api/kis/price 는 무인증 공개 endpoint다. 거기서 받은 임의 종목코드를 그대로 DB에 적재하면
// 외부에서 캐시 테이블에 쓰레기 행을 늘릴 수 있으므로, **적재 대상만** 화이트리스트로 좁힌다.
// (가격조회 응답 자체는 종전과 똑같이 돌려준다 — 막지 않는다.)
//
//   library  = kaw_data의 assetLibrary(_assetLib/_meta)에 등록된 ticker. 예정된 갱신(cron)이 조회할 대상.
//   allowed  = library + 내장 자산 기본 ticker(BUILTIN_TICKERS). 적재 허용 집합.
//              앱의 getOrDefaultLibrary()가 ticker 없는 내장 종목을 BUILTIN_TICKERS로 보완하므로,
//              DB에 ticker가 비어 있는 내장 종목도 정상 조회 대상이 될 수 있다.
const TICKER_RE = /^[A-Z0-9]{6}$/;
const TICKER_SETS_TTL_MS = 5 * 60_000;

interface TickerSets {
  library: Set<string>;
  allowed: Set<string>;
}
let tickerSetsCache: { at: number; sets: TickerSets } | null = null;

async function loadTickerSets(client: SupabaseClient): Promise<TickerSets | null> {
  const now = Date.now();
  if (tickerSetsCache && now - tickerSetsCache.at < TICKER_SETS_TTL_MS) return tickerSetsCache.sets;

  const { data, error } = await client
    .from("kaw_data")
    .select("data")
    .in("account_type", ["_assetLib", "_meta"]);
  // 조회 실패 시에는 캐시하지 않고 null — 호출자가 "이번엔 적재 생략"으로 안전하게 처리한다.
  if (error) {
    console.error("[kaw] 시세 화이트리스트 조회 실패:", error.message);
    return null;
  }

  const library = new Set<string>();
  for (const row of data ?? []) {
    const lib = (row.data as { assetLibrary?: unknown } | null)?.assetLibrary;
    if (!Array.isArray(lib)) continue;
    for (const d of lib) {
      const raw = (d as { ticker?: unknown })?.ticker;
      const t = typeof raw === "string" ? raw.toUpperCase() : "";
      if (TICKER_RE.test(t)) library.add(t);
    }
  }
  const allowed = new Set(library);
  for (const t of Object.values(BUILTIN_TICKERS)) if (t) allowed.add(t.toUpperCase());

  const sets = { library, allowed };
  tickerSetsCache = { at: now, sets };
  return sets;
}

// 예정된 갱신(cron)이 조회할 종목 목록 — assetLibrary에 등록된 unique ticker만, 중복 없이.
// 한 번의 실행이 과하게 길어지지 않도록 상한을 둔다(종목 간 100ms 간격으로 순차 조회하므로).
const SCHEDULED_TICKER_LIMIT = 50;

export async function listLivePriceTickers(env: DataEnv): Promise<string[]> {
  const client = serviceClient(env);
  if (!client) return [];
  const sets = await loadTickerSets(client);
  if (!sets) return [];
  return [...sets.library].sort().slice(0, SCHEDULED_TICKER_LIMIT);
}

// ── 실시간 시세 캐시 적재 (read-only 분석 경로용) ──────────────────────────
// /api/kis/price 의 응답 내용·형식은 전혀 건드리지 않는다. 이미 만들어진 결과를 받아
// 성공한 시세만 public.kaw_live_prices 에 ticker당 1행으로 덮어쓰는 부가 작업이다.
// 실패(source: "failed")는 쓰지 않는다 — 마지막 성공값을 남겨두는 편이 분석에 유용하고,
// 일시적 실패가 캐시를 지워버리는 일도 막는다.
export async function upsertLivePrices(
  env: DataEnv,
  results: Record<string, { price: number; source: string }>,
  fetchedAt: string,
): Promise<void> {
  const client = serviceClient(env);
  if (!client) return;
  const candidates = Object.entries(results).filter(
    ([, r]) => r.price > 0 && (r.source === "kis" || r.source === "naver"),
  );
  if (!candidates.length) return;

  const sets = await loadTickerSets(client);
  if (!sets) return; // 화이트리스트를 확인할 수 없으면 적재하지 않는다
  const rows = candidates
    .filter(([ticker]) => sets.allowed.has(ticker.toUpperCase()))
    .map(([ticker, r]) => ({
      ticker: ticker.toUpperCase(),
      price: r.price,
      source: r.source,
      fetched_at: fetchedAt,
    }));
  if (!rows.length) return;

  const { error } = await client.from("kaw_live_prices").upsert(rows, { onConflict: "ticker" });
  if (error) console.error("[kaw] 시세 캐시 적재 실패:", error.message);
}

// ── 일별 자산 스냅샷 (kaw_daily_portfolio_snapshots) ────────────────────────
// 기간 성과(일간/월간/연간) 계산의 유일한 입력이다. 리밸런싱 history 는 "저장한 날"의
// 기록일 뿐이라 일별 평가가 아니므로 성과 계산에 쓰지 않는다.
//
// 행을 만드는 규칙(금액 정의, 시세 미확보 시 건너뛰기, 공휴일 처리)은 전부 순수 모듈
// `snapshot.ts` 에 있고 테스트로 고정돼 있다. 여기서는 DB 읽기/쓰기만 한다.

export { kstDateString, kstTimeString } from "./snapshot";

// kaw_price_stale_seconds() 와 같은 900초. 이보다 오래된 시세는 "신선하지 않다"고 본다.
const SNAPSHOT_PRICE_MAX_AGE_MS = 900_000;

interface LibEntry { defaultEtf?: unknown; ticker?: unknown }

function tickerMapFromLibraries(rows: Array<{ data: unknown }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const row of rows) {
    const lib = (row.data as { assetLibrary?: unknown } | null)?.assetLibrary;
    if (!Array.isArray(lib)) continue;
    for (const d of lib as LibEntry[]) {
      const etf = typeof d?.defaultEtf === "string" ? d.defaultEtf : "";
      const tk = typeof d?.ticker === "string" ? d.ticker.toUpperCase() : "";
      if (etf && TICKER_RE.test(tk) && !m.has(etf)) m.set(etf, tk);
    }
  }
  return m;
}

export async function writeDailySnapshots(
  env: DataEnv,
  now: Date = new Date(),
): Promise<{ written: number; skipped: string[] }> {
  const client = serviceClient(env);
  if (!client) return { written: 0, skipped: ["supabase 미설정"] };

  const snapshotDate = kstDateString(now);

  const [accountsRes, libRes, pricesRes] = await Promise.all([
    client.from("kaw_data").select("family_code, profile, account_type, data").in("account_type", [...ACCOUNT_IDS]),
    client.from("kaw_data").select("data").in("account_type", ["_assetLib", "_meta"]),
    client.from("kaw_live_prices").select("ticker, price, fetched_at"),
  ]);
  if (accountsRes.error) { console.error("[kaw] 스냅샷: 계좌 조회 실패:", accountsRes.error.message); return { written: 0, skipped: ["계좌 조회 실패"] }; }
  if (libRes.error)      { console.error("[kaw] 스냅샷: 라이브러리 조회 실패:", libRes.error.message); return { written: 0, skipped: ["라이브러리 조회 실패"] }; }
  if (pricesRes.error)   { console.error("[kaw] 스냅샷: 시세 조회 실패:", pricesRes.error.message); return { written: 0, skipped: ["시세 조회 실패"] }; }

  const tickerByEtf = tickerMapFromLibraries(libRes.data ?? []);

  // 신선한 시세만 넘긴다 — 오래된 시세는 애초에 후보에 넣지 않아 그 계좌가 건너뛰어진다.
  const freshPrice = new Map<string, SnapshotPrice>();
  for (const p of pricesRes.data ?? []) {
    const ticker = String(p.ticker ?? "").toUpperCase();
    const price = Number(p.price ?? 0);
    const fetchedAt = String(p.fetched_at ?? "");
    const parsed = Date.parse(fetchedAt);
    const age = Number.isFinite(parsed) ? now.getTime() - parsed : Infinity;
    if (price > 0 && age <= SNAPSHOT_PRICE_MAX_AGE_MS) freshPrice.set(ticker, { price, fetchedAt });
  }

  // 스냅샷에는 평가액만 담는다. cashflow 는 읽지도 쓰지도 않는다 —
  // source of truth 는 앱의 장부이고, 기간 성과는 계산 시점에 그 장부와 결합된다.
  const accounts: SnapshotAccountInput[] = (accountsRes.data ?? []).map((row) => {
    const data = row.data as { history?: unknown; cashBalance?: unknown; brokerSyncs?: unknown } | null;
    return {
      familyCode: String(row.family_code),
      profile: String(row.profile ?? ""),
      accountType: String(row.account_type),
      history: Array.isArray(data?.history) ? (data!.history as SnapshotAccountInput["history"]) : [],
      brokerSyncs: data?.brokerSyncs,
      cashBalance: typeof data?.cashBalance === "number" ? data.cashBalance : undefined,
    };
  });

  const { rows, skipped } = buildDailySnapshotRows(accounts, tickerByEtf, freshPrice, snapshotDate);
  const skipMsgs = skipped.map((s) => `${s.label}: ${s.reason}`);
  if (!rows.length) return { written: 0, skipped: skipMsgs };

  // 같은 날 여러 번 실행돼도 PK 충돌 → upsert 로 1행만 유지된다.
  const { error } = await client
    .from("kaw_daily_portfolio_snapshots")
    .upsert(rows, { onConflict: SNAPSHOT_UPSERT_CONFLICT });
  if (error) {
    console.error("[kaw] 스냅샷 적재 실패:", error.message);
    return { written: 0, skipped: [...skipMsgs, `적재 실패: ${error.message}`] };
  }
  return { written: rows.length, skipped: skipMsgs };
}

// ── 스냅샷 읽기 API (세션 토큰 필요) ────────────────────────────────────────
// 브라우저는 Supabase 에 직접 붙지 않는다. 기존 /api/data 와 같은 인증 경로만 쓴다.
// 평가액만 돌려준다 — 외부 입출금은 브라우저가 이미 가진 account.cashflows(장부)를 쓴다.
const SNAPSHOT_ROW_LIMIT = 2000;

export async function handleSnapshotsGet(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const token = bearerToken(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session || !(await sessionStillValid(client, session))) {
    return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  }

  const from = new URL(request.url).searchParams.get("from");
  let q = client
    .from("kaw_daily_portfolio_snapshots")
    .select("snapshot_date, account_type, market_value, cash_balance, total_asset_value, updated_at")
    .eq("family_code", session.code)
    .eq("profile", session.profile)
    .order("snapshot_date", { ascending: true })
    .limit(SNAPSHOT_ROW_LIMIT);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("snapshot_date", from);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ rows: data ?? [] });
}
