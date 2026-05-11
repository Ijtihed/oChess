/**
 * Centralized monitoring for production errors and product analytics.
 *
 * Both providers (Sentry for crashes, PostHog for events) are
 * STRICTLY OPT-IN: they only initialize when the corresponding
 * env var is set. Local dev, OSS forks, and self-hosters that
 * don't want either of them simply leave the env vars unset and
 * pay zero bundle cost beyond the import.
 *
 * Why dynamic imports?
 *   - Sentry alone is ~70 KB minified. Pulling it into the main
 *     bundle for every user, including those who haven't even set
 *     a DSN, is wasteful. Dynamic import lets Vite tree-shake the
 *     SDK out of the main chunk; it only loads when init succeeds.
 *
 * Public surface:
 *   - initMonitoring()       - call once on app boot.
 *   - captureError(err, ctx) - log a caught exception (or no-op).
 *   - track(event, props)    - product analytics (or no-op).
 *   - identify(userId, props) - associate the current session with
 *     a user when they sign in (or no-op).
 *
 * All four are safe to call regardless of init status, so callers
 * don't need to guard.
 */

let sentry = null;
let posthog = null;
let initPromise = null;

/**
 * Boot the monitoring stack. Idempotent: subsequent calls return
 * the same promise so React StrictMode's double-mount in dev
 * doesn't double-init either provider.
 */
export function initMonitoring() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const sentryDsn = import.meta.env?.VITE_SENTRY_DSN;
    const posthogKey = import.meta.env?.VITE_POSTHOG_KEY;
    const posthogHost = import.meta.env?.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

    if (sentryDsn) {
      try {
        const mod = await import("@sentry/react");
        mod.init({
          dsn: sentryDsn,
          // Browser performance / replay are off by default - they
          // ship a lot of bytes and have material privacy
          // implications. Operators can opt back in by editing this
          // file once they understand what they're collecting.
          integrations: [mod.browserTracingIntegration()],
          tracesSampleRate: 0.05,
          environment: import.meta.env.MODE || "production",
          beforeSend(event) {
            // Drop unhandled rejections from third-party scripts
            // (browser extensions, ad blockers) that pollute the
            // signal without being actionable for us.
            if (event?.exception?.values?.[0]?.stacktrace?.frames?.some((f) =>
              (f.filename || "").startsWith("chrome-extension://") ||
              (f.filename || "").startsWith("moz-extension://")
            )) {
              return null;
            }
            // Strip query strings from URLs - room ids, share
            // codes, OAuth fragments, etc. shouldn't end up in
            // the crash report. We keep the path so we can still
            // tell which screen broke.
            try {
              if (event.request?.url) {
                event.request.url = event.request.url.split("?")[0].split("#")[0];
              }
              if (Array.isArray(event.breadcrumbs)) {
                for (const b of event.breadcrumbs) {
                  if (typeof b?.data?.url === "string") {
                    b.data.url = b.data.url.split("?")[0].split("#")[0];
                  }
                  if (typeof b?.data?.from === "string") {
                    b.data.from = b.data.from.split("?")[0].split("#")[0];
                  }
                  if (typeof b?.data?.to === "string") {
                    b.data.to = b.data.to.split("?")[0].split("#")[0];
                  }
                }
              }
            } catch { /* never fail inside the reporter */ }
            return event;
          },
        });
        sentry = mod;
      } catch (e) {
        if (typeof console !== "undefined") console.warn("[monitoring] Sentry init failed:", e);
      }
    }

    if (posthogKey) {
      try {
        const mod = await import("posthog-js");
        const ph = mod.default || mod;
        ph.init(posthogKey, {
          api_host: posthogHost,
          // Privacy defaults: don't capture full pageview URLs that
          // include game ids / share imports / sensitive query
          // params. We track explicit events instead.
          capture_pageview: false,
          autocapture: false,
          disable_session_recording: true,
          // Honor the user's Do Not Track preference.
          respect_dnt: true,
          persistence: "localStorage",
        });
        posthog = ph;
      } catch (e) {
        if (typeof console !== "undefined") console.warn("[monitoring] PostHog init failed:", e);
      }
    }
  })();
  return initPromise;
}

/**
 * Report an exception. Safe to call even if monitoring isn't
 * initialized - silently no-ops in that case so callers don't
 * have to guard.
 */
export function captureError(err, ctx) {
  try {
    if (sentry?.captureException) {
      sentry.captureException(err, ctx ? { extra: ctx } : undefined);
    }
  } catch { /* don't let monitoring throw inside an error handler */ }
}

/** Track a named product event with optional properties. */
export function track(event, props) {
  try {
    if (posthog?.capture) posthog.capture(event, props || {});
  } catch { /* ignore */ }
}

/**
 * Associate the current session with a user. Pass `null` on logout
 * to reset the identity to anonymous so subsequent events aren't
 * mis-attributed.
 */
export function identify(userId, props) {
  try {
    if (!posthog) return;
    if (userId == null) {
      posthog.reset?.();
      return;
    }
    posthog.identify?.(userId, props || {});
  } catch { /* ignore */ }
  try {
    if (sentry?.setUser) {
      sentry.setUser(userId == null ? null : { id: userId });
    }
  } catch { /* ignore */ }
}
