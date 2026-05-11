import { describe, it, expect, vi, beforeEach } from "vitest";

// Each test resets the mock to whatever shape it needs. Defaults
// to "no client" so the offline-guard test below still passes,
// but the validation tests substitute a stub client so the code
// path reaches the validation branches.
const supabaseStub = vi.hoisted(() => ({ current: null }));
vi.mock("./supabase", () => ({
  get supabase() { return supabaseStub.current; },
  isOnline: () => !!supabaseStub.current,
}));

import { updateProfile } from "./auth";

function makeFakeClient() {
  // Only stubs the small surface updateProfile touches. The chained
  // `from().update().eq().select().single()` resolves with an error
  // so we can assert the function reached the network call without
  // having to wire up real network mocks.
  return {
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { message: "stubbed" } }),
          }),
        }),
      }),
    }),
  };
}

describe("updateProfile", () => {
  beforeEach(() => { supabaseStub.current = null; });

  it("throws when Supabase is not configured (no silent success)", async () => {
    await expect(updateProfile("u-1", { display_name: "Alice" })).rejects.toThrow(
      /not configured/i
    );
  });

  // Once a backend is wired up, blanking the username field on the
  // Profile form (`username: formData.username || null`) used to land
  // a cryptic "violates not-null constraint" Postgres error in front
  // of the user. The handler should refuse the write client-side
  // with a clear message instead.
  describe("rejects bad payloads with friendly messages (with backend)", () => {
    beforeEach(() => { supabaseStub.current = makeFakeClient(); });

    it("rejects an explicitly null username", async () => {
      await expect(updateProfile("u-1", { username: null })).rejects.toThrow(
        /username cannot be empty/i
      );
    });

    it("rejects a whitespace-only username", async () => {
      await expect(updateProfile("u-1", { username: "   " })).rejects.toThrow(
        /username cannot be empty/i
      );
    });

    it("rejects a username that fails the format check", async () => {
      await expect(updateProfile("u-1", { username: "ab" })).rejects.toThrow(
        /3-24 characters/i
      );
      await expect(updateProfile("u-1", { username: "with space" })).rejects.toThrow(
        /3-24 characters/i
      );
    });

    it("accepts the strict shape (lowercase, 3-24 chars)", async () => {
      // Falls through to the stubbed Supabase error - that's fine,
      // we just need to confirm the validation didn't reject it.
      await expect(updateProfile("u-1", { username: "alice_42" })).rejects.toThrow(
        /stubbed/
      );
    });

    it("accepts the legacy OAuth-trigger shape", async () => {
      // `<base>_<6 hex>` from handle_new_user. Base can include
      // uppercase / period because it comes from email split.
      await expect(updateProfile("u-1", { username: "Alice.Smith_a1b2c3" })).rejects.toThrow(
        /stubbed/
      );
    });

    it("rejects an over-long bio", async () => {
      await expect(updateProfile("u-1", { bio: "x".repeat(601) })).rejects.toThrow(
        /600 characters/i
      );
    });

    it("rejects an over-long display name", async () => {
      await expect(updateProfile("u-1", { display_name: "x".repeat(61) })).rejects.toThrow(
        /60 characters/i
      );
    });

    it("rejects an over-long lichess / chesscom handle", async () => {
      await expect(updateProfile("u-1", { lichess_username: "x".repeat(41) })).rejects.toThrow(
        /40 characters/i
      );
      await expect(updateProfile("u-1", { chesscom_username: "x".repeat(41) })).rejects.toThrow(
        /40 characters/i
      );
    });

    it("rejects an over-long country", async () => {
      await expect(updateProfile("u-1", { country: "x".repeat(65) })).rejects.toThrow(
        /64 characters/i
      );
    });

    it("drops fields not on the allowlist before validating", async () => {
      // crazy_arena_lab is owner-readable but client-immutable. The
      // handler must silently strip it instead of forwarding to the
      // DB and tripping the guard trigger.
      await expect(updateProfile("u-1", { crazy_arena_lab: true, display_name: "Alice" })).rejects.toThrow(
        /stubbed/
      );
    });
  });

  // ── DB error translation ─────────────────────────────────────
  // The raw Postgres error from a unique-constraint hit reads as
  // "duplicate key value violates unique constraint ..." which
  // looks alarming in the UI. We translate the common shape into
  // a one-liner the user can act on.
  describe("translates common DB errors to friendly messages", () => {
    function clientWithError(err) {
      return {
        from: () => ({
          update: () => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: null, error: err }),
              }),
            }),
          }),
        }),
      };
    }

    it("translates 23505 unique-constraint hits", async () => {
      supabaseStub.current = clientWithError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "profiles_username_key"',
      });
      await expect(updateProfile("u-1", { username: "alice_42" })).rejects.toThrow(
        /username is taken/i
      );
    });

    it("translates 23502 not-null-constraint hits", async () => {
      // Belt-and-suspenders: client-side validation should normally
      // catch this, but if it ever leaks through (e.g. a future
      // bypass), the surfaced error stays clear.
      supabaseStub.current = clientWithError({
        code: "23502",
        message: 'null value in column "username" violates not-null constraint',
      });
      await expect(updateProfile("u-1", { display_name: "Alice" })).rejects.toThrow(
        /username cannot be empty/i
      );
    });

    it("falls back to the raw error message for unknown codes", async () => {
      supabaseStub.current = clientWithError({
        code: "P0001",
        message: "permission denied",
      });
      await expect(updateProfile("u-1", { display_name: "Alice" })).rejects.toThrow(
        /permission denied/i
      );
    });
  });
});
