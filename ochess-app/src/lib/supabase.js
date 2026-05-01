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

// Lightweight client for Realtime (broadcast/presence only - no
// auth needed). Uses a UNIQUE storageKey + a stub in-memory
// storage so its internal GoTrueClient doesn't compete with
// the main client's auth-token entry. Without this isolation
// you get "Multiple GoTrueClient instances detected in the
// same browser context" warnings AND the two clients race on
// token-refresh writes - intermittent "logged out" symptoms
// after a refresh.
const noopStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
let _realtimeClient = null;
export function getRealtimeClient() {
  if (_realtimeClient) return _realtimeClient;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  _realtimeClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // Force a separate storage key + a noop storage so the
      // two GoTrueClient instances don't share state.
      storageKey: "sb-realtime-only",
      storage: noopStorage,
    },
  });
  return _realtimeClient;
}

export function isOnline() {
  return !!(supabaseUrl && supabaseAnonKey);
}

