// 이 모듈은 더 이상 Supabase에 직접 접속하지 않는다.
// 모든 인증/가족 데이터 조작은 Cloudflare Worker의 /api/auth/* 를 통해서만 이뤄지고,
// 실제 Supabase 접속(service_role 키)은 서버(data-server.ts)에만 존재한다.

export interface ProfileConfig {
  id: string;
  label: string;
  pin_hash: string | null; // 서버에서 실제 해시 대신 "•"(있음) 또는 null(없음)로 내려줌
  is_admin: boolean;
}

export interface FamilyData {
  profiles: ProfileConfig[];
  master_code_hash?: string | null;
  /** 서버가 알려주는 실제 설정 여부. false 면 마스터 인증이 거부되므로 초기 설정이 필요하다 */
  hasMasterCode?: boolean;
  /** 서버가 알려주는 값: 어느 프로필이든 PIN 이 설정돼 있는가. false 면 초기 등록 가족 */
  initialized?: boolean;
  deleted_profiles?: ProfileConfig[];
  isNew?: boolean; // /api/auth/family 응답에서만 내려옴 — 이 family_code가 방금 처음 생성됐는지
}

const FAMILY_CACHE_KEY = (code: string) => `kaw.family.${code}`;
export const SESSION_AUTH_KEY = "kaw.session.profile";
export const SESSION_TOKEN_KEY = "kaw.session.token";

// 마스터코드/PIN 확인 직후 "그 사실"을 짧게 기억해뒀다가, 바로 이어지는 쓰기 요청(프로필 추가/삭제,
// 마스터코드 변경 등)에 자동으로 실어 보낸다. 서버가 매번 다시 검증하므로 클라이언트 상태는 신뢰 근거가 아니라
// 단지 "다시 입력 안 받고 재전송"하기 위한 편의용 캐시일 뿐이다.
let pendingProof: { masterCode?: string; pin?: { profileId: string; pin: string }; expiresAt: number } | null = null;
const PROOF_TTL_MS = 5 * 60 * 1000;

function stashMasterProof(masterCode: string) {
  pendingProof = { masterCode, expiresAt: Date.now() + PROOF_TTL_MS };
}
function stashPinProof(profileId: string, pin: string) {
  pendingProof = { pin: { profileId, pin }, expiresAt: Date.now() + PROOF_TTL_MS };
}
function consumeMasterProof(): string | undefined {
  if (!pendingProof || pendingProof.expiresAt < Date.now()) return undefined;
  const v = pendingProof.masterCode;
  pendingProof = null;
  return v;
}
function consumePinProof(profileId: string): string | undefined {
  if (!pendingProof || pendingProof.expiresAt < Date.now()) return undefined;
  if (pendingProof.pin?.profileId !== profileId) return undefined;
  const v = pendingProof.pin.pin;
  pendingProof = null;
  return v;
}

async function api<T>(path: string, body: unknown): Promise<T> {
  // 세션이 있으면 함께 보낸다(서버가 다른 관리자의 PIN 설정 같은 요청의 근거로 검증한다).
  const token = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SESSION_TOKEN_KEY) : null;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

export function defaultFamilyData(): FamilyData {
  return {
    profiles: [
      { id: "hyeobi", label: "혀비", pin_hash: null, is_admin: true },
      { id: "dayoung", label: "다영", pin_hash: null, is_admin: true },
    ],
    master_code_hash: null,
  };
}

export async function loadFamilyData(code: string): Promise<FamilyData> {
  try {
    const data = await api<FamilyData & { error?: string }>("/api/auth/family", { code });
    if (!data.error) {
      localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(data));
      return data;
    }
  } catch { /* 네트워크 실패 시 아래에서 캐시로 폴백 */ }
  try {
    const raw = localStorage.getItem(FAMILY_CACHE_KEY(code));
    if (raw) return JSON.parse(raw) as FamilyData;
  } catch { /* 캐시도 없으면 기본값 */ }
  return defaultFamilyData();
}

// 프로필의 PIN을 검증하고, 성공하면 세션 토큰을 발급받아 sessionStorage에 저장한다.
export async function verifyPin(
  code: string,
  profileId: string,
  pin: string,
  _family: FamilyData,
): Promise<boolean> {
  const res = await api<{ ok: boolean; token?: string }>("/api/auth/verify-pin", { code, profileId, pin });
  if (res.ok && res.token) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, res.token);
    stashPinProof(profileId, pin);
  }
  return res.ok;
}

export async function updatePin(
  code: string,
  profileId: string,
  pin: string,
  _family: FamilyData,
): Promise<FamilyData> {
  const masterCode = consumeMasterProof();
  const currentPin = consumePinProof(profileId);
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-pin", {
    code, profileId, newPin: pin, currentPin, masterCode,
  });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

/**
 * PIN 이 아직 없는 프로필의 **최초 PIN 등록**. 근거는 마스터 코드 또는(아무도 PIN 이 없는 가족이면)
 * 운영자가 발급한 초기 설정 코드다. 액세스 코드는 근거가 아니다.
 */
export async function setFirstPin(
  code: string,
  profileId: string,
  pin: string,
  proof: { masterCode?: string; setupCode?: string },
): Promise<FamilyData> {
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-pin", {
    code, profileId, newPin: pin,
    ...(proof.masterCode ? { masterCode: proof.masterCode } : {}),
    ...(proof.setupCode ? { setupCode: proof.setupCode } : {}),
  });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

/**
 * 로그인한 **다른 관리자**가 PIN 이 없는 프로필의 첫 PIN 을 설정한다. 근거는 세션(Authorization)
 * 이며 서버가 서명·만료·pin_version·관리자 권한을 확인한다.
 */
export async function setFirstPinAsAdmin(code: string, profileId: string, pin: string): Promise<FamilyData> {
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-pin", { code, profileId, newPin: pin });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

// 비밀질문 통과 후 PIN 재설정 시 사용 (서버에서 정답을 재검증함)
export async function updatePinViaSecretQuestion(
  code: string,
  profileId: string,
  pin: string,
  sqIdx: number,
  sqAnswer: string,
): Promise<FamilyData> {
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-pin", {
    code, profileId, newPin: pin, sqIdx, sqAnswer,
  });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

export async function addProfile(
  code: string,
  label: string,
  pin: string,
  _family: FamilyData,
): Promise<FamilyData> {
  const masterCode = consumeMasterProof();
  const updated = await api<FamilyData & { error?: string }>("/api/auth/add-profile", { code, label, pin, masterCode });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

export async function verifyMasterCode(
  entered: string,
  _family: FamilyData,
  familyCode: string,
): Promise<boolean> {
  const res = await api<{ ok: boolean }>("/api/auth/verify-master", { code: familyCode, entered });
  if (res.ok) stashMasterProof(entered);
  return res.ok;
}

export async function updateMasterCode(
  newCode: string,
  _family: FamilyData,
  familyCode: string,
): Promise<FamilyData> {
  const currentMaster = consumeMasterProof();
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-master", {
    code: familyCode, newCode, currentMaster,
  });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(familyCode), JSON.stringify(updated));
  return updated;
}

/**
 * 마스터 코드가 **미설정**인 가족의 최초 설정. 로그인한 관리자 세션(Authorization)이 근거다 —
 * 액세스 코드는 공개값이라 인증 근거로 쓰지 않는다.
 */
export async function setInitialMasterCode(newCode: string, familyCode: string): Promise<FamilyData> {
  const token = getSessionToken();
  const res = await fetch("/api/auth/set-master", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ code: familyCode, newCode }),
  });
  const updated = (await res.json()) as FamilyData & { error?: string };
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(familyCode), JSON.stringify(updated));
  return updated;
}

// 비밀질문 통과 후 마스터코드 재설정 시 사용
export async function updateMasterCodeViaSecretQuestion(
  newCode: string,
  familyCode: string,
  sqIdx: number,
  sqAnswer: string,
): Promise<FamilyData> {
  const updated = await api<FamilyData & { error?: string }>("/api/auth/set-master", {
    code: familyCode, newCode, sqIdx, sqAnswer,
  });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(familyCode), JSON.stringify(updated));
  return updated;
}

export async function softDeleteProfile(
  code: string,
  profileId: string,
  _family: FamilyData,
): Promise<FamilyData> {
  const masterCode = consumeMasterProof();
  const updated = await api<FamilyData & { error?: string }>("/api/auth/soft-delete-profile", { code, profileId, masterCode });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

export async function hardDeleteProfile(
  code: string,
  profileId: string,
  _family: FamilyData,
): Promise<FamilyData> {
  const masterCode = consumeMasterProof();
  const updated = await api<FamilyData & { error?: string }>("/api/auth/hard-delete-profile", { code, profileId, masterCode });
  if (updated.error) throw new Error(updated.error);
  try { localStorage.removeItem(`kaw.v2.${code}.${profileId}`); } catch { /* 무시 */ }
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

export async function restoreProfile(
  code: string,
  profileId: string,
  _family: FamilyData,
): Promise<FamilyData> {
  const pin = consumePinProof(profileId);
  const updated = await api<FamilyData & { error?: string }>("/api/auth/restore-profile", { code, profileId, pin });
  if (updated.error) throw new Error(updated.error);
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(updated));
  return updated;
}

export function getSessionProfile(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(SESSION_AUTH_KEY);
}
export function setSessionProfile(profileId: string): void {
  if (typeof window !== "undefined") sessionStorage.setItem(SESSION_AUTH_KEY, profileId);
}
export function clearSessionProfile(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SESSION_AUTH_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  }
}
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(SESSION_TOKEN_KEY);
}
