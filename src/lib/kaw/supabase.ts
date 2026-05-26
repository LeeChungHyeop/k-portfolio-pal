import { createClient } from "@supabase/supabase-js";

const url  = import.meta.env.VITE_SUPABASE_URL  as string | undefined;
const akey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const isBrowser = typeof window !== "undefined";
const isValid   = isBrowser && Boolean(url && akey && (url.startsWith("https://") || url.startsWith("http://")));

export const supabase    = isValid ? createClient(url!, akey!) : null;
export const hasSupabase = isValid;

export type UserProfile = string;
