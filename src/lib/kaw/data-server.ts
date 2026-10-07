// 서버(Cloudflare Worker) 전용 모듈. 절대 클라이언트 번들에 import되면 안 됨.
// Supabase는 여기(service_role 키)에서만 접근하고, 브라우저는 이 모듈이 노출하는
// 인증된 API를 통해서만 데이터를 읽고 쓴다.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS, BUILTIN_TICKERS } from "./constants";
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
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SESSION_SECRET?: string;
  ACCESS_CODE?: string;
  RATE_LIMIT?: KVLike;
}

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

// 서버 전용 — 정답은 클라이언트 번들에 절대 포함하지 않는다 (질문 텍스트만 클라이언트에 공개)
const SECRET_QUESTIONS_ANSWERS = ["대전", "러닝", "진현", "12시", "맥북"];

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

function sanitizeProfile(p: ProfileConfig) {
  return { id: p.id, label: p.label, is_admin: p.is_admin, pin_hash: p.pin_hash ? "•" : null };
}
function sanitizeFamily(f: FamilyData) {
  return {
    profiles: f.profiles.map(sanitizeProfile),
    deleted_profiles: (f.deleted_profiles ?? []).map(sanitizeProfile),
    hasMasterCode: true, // master_code_hash가 없어도 family_code 자체가 항상 유효한 마스터코드로 동작함
  };
}

async function verifyMaster(env: DataEnv, family: FamilyData, entered: string, code: string): Promise<boolean> {
  const rlKey = `rl:master:${code}`;
  if (!(await checkRateLimit(env, rlKey, 10, 10 * 60))) return false;
  const ok = family.master_code_hash
    ? (await hashMaster(entered)) === family.master_code_hash
    : entered.trim() === code;
  if (ok) await resetRateLimit(env, rlKey);
  return ok;
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
  const rlKey = `rl:sq:${sqIdx}`;
  if (!(await checkRateLimit(env, rlKey, 10, 10 * 60))) return false;
  const ok = sqIdx >= 0 && sqIdx < SECRET_QUESTIONS_ANSWERS.length && answer.trim() === SECRET_QUESTIONS_ANSWERS[sqIdx];
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

  // 이 family_code로 저장된 행이 하나도 없으면 신규 — 기본 프로필 메타데이터를 만들어둔다
  // (계좌 데이터 자체는 클라이언트가 /api/data 조회 실패 시 알아서 emptyState/seedState로 폴백함)
  const { data: existing } = await client.from("kaw_data").select("id").eq("family_code", code).limit(1);
  const isNew = !existing?.length;
  const family = isNew ? defaultFamilyData() : await loadFamilyRaw(client, code);
  if (isNew) await saveFamilyRaw(client, code, family);
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
  const ok = await verifySecretQuestion(env, idx, answer);
  return json({ ok });
}

// 인증 방식 셋 중 하나로 PIN 변경을 승인: (1) 프로필에 PIN이 아직 없음(최초 설정) (2) 현재 PIN 일치
// (3) 마스터 코드 일치 (4) 비밀질문 정답
export async function handleSetPin(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client) return json({ ok: false }, 503);
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown; profileId?: unknown; newPin?: unknown;
    currentPin?: unknown; masterCode?: unknown; sqIdx?: unknown; sqAnswer?: unknown;
  };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  const newPin = typeof body.newPin === "string" ? body.newPin : "";
  if (!code || code !== env.ACCESS_CODE || !profileId || !/^\d{4}$/.test(newPin)) {
    return json({ error: "잘못된 요청입니다." }, 400);
  }

  const family = await loadFamilyRaw(client, code);
  const profile = family.profiles.find((p) => p.id === profileId);
  if (!profile) return json({ error: "프로필을 찾을 수 없습니다." }, 404);

  let authorized = !profile.pin_hash; // 최초 설정
  if (!authorized && typeof body.currentPin === "string") {
    authorized = await verifyPinHash(env, code, profileId, body.currentPin, profile.pin_hash);
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
  await saveFamilyRaw(client, code, updated);
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

  const family = await loadFamilyRaw(client, code);
  let authorized = false;
  if (typeof body.currentMaster === "string") authorized = await verifyMaster(env, family, body.currentMaster, code);
  if (!authorized && typeof body.sqIdx === "number" && typeof body.sqAnswer === "string") {
    authorized = await verifySecretQuestion(env, body.sqIdx, body.sqAnswer);
  }
  if (!authorized) return json({ error: "인증에 실패했습니다." }, 403);

  const updated: FamilyData = { ...family, master_code_hash: await hashMaster(newCode) };
  await saveFamilyRaw(client, code, updated);
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
  const family = await loadFamilyRaw(client, code);
  if (!(await verifyMaster(env, family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

  const id = label.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_가-힣]/g, "") || `profile_${Date.now()}`;
  const finalId = family.profiles.some((p) => p.id === id) ? `${id}_${Date.now()}` : id;
  const updated: FamilyData = {
    ...family,
    profiles: [...family.profiles, { id: finalId, label, pin_hash: await hashPin(code, finalId, pin), is_admin: false }],
  };
  await saveFamilyRaw(client, code, updated);
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

  const family = await loadFamilyRaw(client, code);
  const deleted = (family.deleted_profiles ?? []).find((p) => p.id === profileId);
  if (!deleted || !(await verifyPinHash(env, code, profileId, pin, deleted.pin_hash))) {
    return json({ error: "인증에 실패했습니다." }, 403);
  }
  const updated: FamilyData = {
    ...family,
    profiles: [...family.profiles, deleted],
    deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
  };
  await saveFamilyRaw(client, code, updated);
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

  const family = await loadFamilyRaw(client, code);
  if (!(await verifyMaster(env, family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

  const profile = family.profiles.find((p) => p.id === profileId);
  let updated: FamilyData;
  if (hard) {
    updated = {
      ...family,
      profiles: family.profiles.filter((p) => p.id !== profileId),
      deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
    };
    await client.from("kaw_data").delete().eq("family_code", code).eq("profile", profileId);
  } else {
    if (!profile) return json({ error: "프로필을 찾을 수 없습니다." }, 404);
    updated = {
      ...family,
      profiles: family.profiles.filter((p) => p.id !== profileId),
      deleted_profiles: [...(family.deleted_profiles ?? []), profile],
    };
  }
  await saveFamilyRaw(client, code, updated);
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

  const { data, error } = await client
    .from("kaw_data").select("account_type, data, profile")
    .eq("family_code", session.code)
    .in("profile", [session.profile, "_shared"]);
  if (error) return json({ error: error.message }, 500);
  return json({ rows: data ?? [] });
}

export async function handleDataPost(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  if (!client || !env.SESSION_SECRET) return json({ error: "서버 설정 오류" }, 503);
  const token = bearerToken(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session || !(await sessionStillValid(client, session))) {
    return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);
  }

  const body = (await request.json().catch(() => ({}))) as { rows?: unknown };
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
  if (!sanitized.length) return json({ ok: true });

  const { error } = await client.from("kaw_data").upsert(sanitized, { onConflict: "family_code,profile,account_type" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
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
    const data = row.data as { history?: unknown; cashBalance?: unknown } | null;
    return {
      familyCode: String(row.family_code),
      profile: String(row.profile ?? ""),
      accountType: String(row.account_type),
      history: Array.isArray(data?.history) ? (data!.history as SnapshotAccountInput["history"]) : [],
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
    .select("snapshot_date, account_type, market_value, cash_balance, total_asset_value")
    .eq("family_code", session.code)
    .eq("profile", session.profile)
    .order("snapshot_date", { ascending: true })
    .limit(SNAPSHOT_ROW_LIMIT);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("snapshot_date", from);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ rows: data ?? [] });
}
