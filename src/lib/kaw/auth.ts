import { supabase } from "./supabase";

export interface ProfileConfig {
  id: string;
  label: string;
  pin_hash: string | null;
  is_admin: boolean;
}

export interface FamilyData {
  profiles: ProfileConfig[];
  master_code_hash?: string | null;
  deleted_profiles?: ProfileConfig[];
}

const FAMILY_CACHE_KEY = (code: string) => `kaw.family.${code}`;
export const SESSION_AUTH_KEY = "kaw.session.profile";

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPin(code: string, profileId: string, pin: string): Promise<string> {
  return sha256(`pin:${code}:${profileId}:${pin}`);
}

export function defaultFamilyData(): FamilyData {
  return {
    profiles: [
      { id: "hyeobi",  label: "혀비", pin_hash: null, is_admin: true },
      { id: "dayoung", label: "다영", pin_hash: null, is_admin: true },
    ],
    master_code_hash: null,
  };
}

export async function loadFamilyData(code: string): Promise<FamilyData> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("kaw_data")
        .select("data")
        .eq("family_code", code)
        .eq("profile", "_system")
        .eq("account_type", "_family")
        .maybeSingle();
      if (!error && data?.data) {
        const fam = data.data as FamilyData;
        localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(fam));
        return fam;
      }
    } catch {}
  }
  try {
    const raw = localStorage.getItem(FAMILY_CACHE_KEY(code));
    if (raw) return JSON.parse(raw) as FamilyData;
  } catch {}
  return defaultFamilyData();
}

export async function saveFamilyData(code: string, family: FamilyData): Promise<void> {
  localStorage.setItem(FAMILY_CACHE_KEY(code), JSON.stringify(family));
  if (!supabase) return;
  const { error } = await supabase.from("kaw_data").upsert(
    {
      family_code: code,
      profile: "_system",
      account_type: "_family",
      data: family,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "family_code,profile,account_type" }
  );
  if (error) throw new Error(error.message);
}

export async function verifyPin(
  code: string,
  profileId: string,
  pin: string,
  family: FamilyData
): Promise<boolean> {
  const p = family.profiles.find((x) => x.id === profileId);
  if (!p?.pin_hash) return false;
  return (await hashPin(code, profileId, pin)) === p.pin_hash;
}

export async function updatePin(
  code: string,
  profileId: string,
  pin: string,
  family: FamilyData
): Promise<FamilyData> {
  const h = await hashPin(code, profileId, pin);
  const updated: FamilyData = {
    ...family,
    profiles: family.profiles.map((p) =>
      p.id === profileId ? { ...p, pin_hash: h } : p
    ),
  };
  await saveFamilyData(code, updated);
  return updated;
}

export async function addProfile(
  code: string,
  label: string,
  pin: string,
  family: FamilyData
): Promise<FamilyData> {
  const id = label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_가-힣]/g, "") || `profile_${Date.now()}`;
  const finalId = family.profiles.some((p) => p.id === id) ? `${id}_${Date.now()}` : id;
  const h = await hashPin(code, finalId, pin);
  const updated: FamilyData = {
    ...family,
    profiles: [
      ...family.profiles,
      { id: finalId, label: label.trim(), pin_hash: h, is_admin: false },
    ],
  };
  await saveFamilyData(code, updated);
  return updated;
}

// master_code_hash null → family code itself is the master code
export async function verifyMasterCode(
  entered: string,
  family: FamilyData,
  familyCode: string
): Promise<boolean> {
  if (family.master_code_hash) {
    return (await sha256(`master:${entered}`)) === family.master_code_hash;
  }
  return entered.trim() === familyCode;
}

export async function updateMasterCode(
  newCode: string,
  family: FamilyData,
  familyCode: string
): Promise<FamilyData> {
  const h = await sha256(`master:${newCode}`);
  const updated: FamilyData = { ...family, master_code_hash: h };
  await saveFamilyData(familyCode, updated);
  return updated;
}

export async function softDeleteProfile(
  code: string,
  profileId: string,
  family: FamilyData
): Promise<FamilyData> {
  const profile = family.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("프로필을 찾을 수 없습니다.");
  const updated: FamilyData = {
    ...family,
    profiles: family.profiles.filter((p) => p.id !== profileId),
    deleted_profiles: [...(family.deleted_profiles ?? []), profile],
  };
  await saveFamilyData(code, updated);
  return updated;
}

export async function hardDeleteProfile(
  code: string,
  profileId: string,
  family: FamilyData
): Promise<FamilyData> {
  const updated: FamilyData = {
    ...family,
    profiles: family.profiles.filter((p) => p.id !== profileId),
    deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
  };
  try { localStorage.removeItem(`kaw.v2.${code}.${profileId}`); } catch {}
  if (supabase) {
    await supabase.from("kaw_data").delete()
      .eq("family_code", code)
      .eq("profile", profileId);
  }
  await saveFamilyData(code, updated);
  return updated;
}

export async function restoreProfile(
  code: string,
  profileId: string,
  family: FamilyData
): Promise<FamilyData> {
  const profile = (family.deleted_profiles ?? []).find((p) => p.id === profileId);
  if (!profile) throw new Error("삭제된 프로필을 찾을 수 없습니다.");
  const updated: FamilyData = {
    ...family,
    profiles: [...family.profiles, profile],
    deleted_profiles: (family.deleted_profiles ?? []).filter((p) => p.id !== profileId),
  };
  await saveFamilyData(code, updated);
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
  if (typeof window !== "undefined") sessionStorage.removeItem(SESSION_AUTH_KEY);
}
