# Security Policy

## Supported Versions

Security fixes land on the latest code on `main`. Tagged releases prior to `v1.0` are not patched.

## Scope

The security policy below covers:

- The web app under `ochess-app/`.
- The Supabase schema and RLS policies in `supabase/schema.sql`.
- The Supabase Edge Functions under `supabase/functions/`.

Out of scope:

- Third-party services we depend on (Supabase platform, Google Auth, Lichess / chess.com APIs, Stockfish source). Report those upstream.
- Self-hosted forks where the operator has materially changed the schema, RLS, or Edge Function logic.

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead:

- **Preferred:** open a private GitHub Security Advisory at <https://github.com/Ijtihed/oChess/security/advisories/new>.
- **Alternative:** contact the maintainer privately through GitHub.

When reporting, include:

- a clear description of the issue and the threat model it violates
- reproduction steps or a proof of concept
- affected files / components / endpoints
- potential impact (data leak, privilege escalation, denial of service, account takeover, etc.)
- any logs / screenshots that help us confirm the issue

## Response Timeline

You can expect:

- **Initial response:** within 7 days of the report (we aim for under 48 hours for clearly-described, high-impact issues).
- **Triage decision:** within 14 days, including whether we accept the report and the rough severity tier.
- **Fix and disclosure:** coordinated with the reporter; we typically aim for a fix within 30 days for high-impact issues, longer for issues that require schema migrations or edge-function redeploys.

## Hardening Notes for Operators

If you self-host this codebase, please verify:

- `supabase/schema.sql` is applied in full and the trigger functions referenced by it (`profiles_guard_writes`, `arena_rooms_guard_writes`, `ai_settings_audit_touch`) are active.
- The `record_ai_spend_or_block`, `record_coach_call`, and `record_arena_rules_call` RPCs are not granted to `anon` (the canonical schema does this; check after manual edits).
- Sentry (`VITE_SENTRY_DSN`) and PostHog (`VITE_POSTHOG_KEY`) are only enabled if your privacy policy describes them. The shipped privacy policy includes the disclosure.
- The `coach` and `arena_rules` Edge Functions are deployed with the JWT verification flag enabled (Supabase platform default).

## Public Acknowledgments

We are happy to credit reporters of accepted vulnerabilities in the release notes for the fix, or to leave it anonymous on request.
