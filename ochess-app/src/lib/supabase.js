import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase credentials not configured. Online features disabled. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
}

export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        flowType: "implicit",
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;

// Lightweight client for Realtime (broadcast/presence only - no auth needed)
let _realtimeClient = null;
export function getRealtimeClient() {
  if (_realtimeClient) return _realtimeClient;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  _realtimeClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return _realtimeClient;
}

export function isOnline() {
  return !!(supabaseUrl && supabaseAnonKey);
}

