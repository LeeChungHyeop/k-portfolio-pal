import { createClient } from "@supabase/supabase-js";

const url  = import.meta.env.VITE_SUPABASE_URL  as string | undefined;
const akey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const isValid = Boolean(url && akey && (url.startsWith("https://") || url.startsWith("http://")));

export const supabase    = isValid ? createClient(url!, akey!) : null;
export const hasSupabase = isValid;

export type UserProfile = "hyeobi" | "dayoung";

export const USER_PROFILES: { id: UserProfile; label: string }[] = [
  { id: "hyeobi",  label: "혀비" },
  { id: "dayoung", label: "다영" },
];
