import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase credentials not configured. Online features disabled. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
}

export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // PKCE is the recommended SPA auth flow today. It exchanges
        // an authorization code (NOT a token) at the redirect URL,
        // which means tokens never appear in the browser history,
        // server logs, or referrer headers - a real upgrade over
        // the previous "implicit" flow which embedded tokens
        // directly in the URL fragment.
        //
        // PKCE requires `detectSessionInUrl: true` so supabase-js
        // can run the code -> token exchange when the user lands
        // back on /. Both Google OAuth and the email-link / magic-
        // link flows use the same redirect handler.
        flowType: "pkce",
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

