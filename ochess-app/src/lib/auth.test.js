import { describe, it, expect, vi } from "vitest";

// Force the supabase module to report "not configured" so updateProfile
// hits the offline branch.
vi.mock("./supabase", () => ({
  supabase: null,
  isOnline: () => false,
}));

import { updateProfile } from "./auth";

describe("updateProfile", () => {
  it("throws when Supabase is not configured (no silent success)", async () => {
    await expect(updateProfile("u-1", { display_name: "Alice" })).rejects.toThrow(
      /not configured/i
    );
  });
});
