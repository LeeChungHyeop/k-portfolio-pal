// 서버(Cloudflare Worker) 전용 모듈. 절대 클라이언트 번들에 import되면 안 됨.
// Supabase는 여기(service_role 키)에서만 접근하고, 브라우저는 이 모듈이 노출하는
// 인증된 API를 통해서만 데이터를 읽고 쓴다.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_IDS } from "./constants";

export interface DataEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SESSION_SECRET?: string;
  ACCESS_CODE?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

let cachedClient: { url: string; client: SupabaseClient } | null = null;
function serviceClient(env: DataEnv): SupabaseClient | null {
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

export interface SessionPayload { code: string; profile: string; exp: number }

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

interface ProfileConfig { id: string; label: string; pin_hash: string | null; is_admin: boolean }
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

async function verifyMaster(family: FamilyData, entered: string, code: string): Promise<boolean> {
  if (family.master_code_hash) return (await hashMaster(entered)) === family.master_code_hash;
  return entered.trim() === code;
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
  if (!profile?.pin_hash) return json({ ok: false });
  if ((await hashPin(code, profileId, pin)) !== profile.pin_hash) return json({ ok: false });

  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const token = await signSession({ code, profile: profileId, exp }, env.SESSION_SECRET);
  return json({ ok: true, token });
}

export async function handleVerifyMaster(request: Request, env: DataEnv): Promise<Response> {
  const client = serviceClient(env);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; entered?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const entered = typeof body.entered === "string" ? body.entered : "";
  if (!client || !code || code !== env.ACCESS_CODE) return json({ ok: false });
  const family = await loadFamilyRaw(client, code);
  return json({ ok: await verifyMaster(family, entered, code) });
}

export async function handleVerifySecretQuestion(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { sqIdx?: unknown; answer?: unknown };
  const idx = typeof body.sqIdx === "number" ? body.sqIdx : -1;
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const ok = idx >= 0 && idx < SECRET_QUESTIONS_ANSWERS.length && answer === SECRET_QUESTIONS_ANSWERS[idx];
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
    authorized = (await hashPin(code, profileId, body.currentPin)) === profile.pin_hash;
  }
  if (!authorized && typeof body.masterCode === "string") {
    authorized = await verifyMaster(family, body.masterCode, code);
  }
  if (!authorized && typeof body.sqIdx === "number" && typeof body.sqAnswer === "string") {
    authorized = body.sqIdx >= 0 && body.sqIdx < SECRET_QUESTIONS_ANSWERS.length
      && body.sqAnswer.trim() === SECRET_QUESTIONS_ANSWERS[body.sqIdx];
  }
  if (!authorized) return json({ error: "인증에 실패했습니다." }, 403);

  const updated: FamilyData = {
    ...family,
    profiles: family.profiles.map((p) => p.id === profileId ? { ...p, pin_hash: null } : p),
  };
  const hash = await hashPin(code, profileId, newPin);
  updated.profiles = updated.profiles.map((p) => p.id === profileId ? { ...p, pin_hash: hash } : p);
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
  if (typeof body.currentMaster === "string") authorized = await verifyMaster(family, body.currentMaster, code);
  if (!authorized && typeof body.sqIdx === "number" && typeof body.sqAnswer === "string") {
    authorized = body.sqIdx >= 0 && body.sqIdx < SECRET_QUESTIONS_ANSWERS.length
      && body.sqAnswer.trim() === SECRET_QUESTIONS_ANSWERS[body.sqIdx];
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
  if (!(await verifyMaster(family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

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
  if (!deleted?.pin_hash || (await hashPin(code, profileId, pin)) !== deleted.pin_hash) {
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
  if (!(await verifyMaster(family, masterCode, code))) return json({ error: "인증에 실패했습니다." }, 403);

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
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);

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
  if (!session) return json({ error: "인증이 만료됐어요. 다시 로그인해주세요." }, 401);

  const body = (await request.json().catch(() => ({}))) as { rows?: unknown };
  if (!Array.isArray(body.rows)) return json({ error: "잘못된 요청입니다." }, 400);

  const rows = body.rows as Array<{ family_code?: unknown; profile?: unknown; account_type?: unknown; data?: unknown; updated_at?: unknown }>;
  const sanitized = rows.filter((r) => {
    if (r.family_code !== session.code) return false;
    if (r.profile === "_shared") return true;
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
