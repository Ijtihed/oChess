import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("../lib/auth", () => ({
  signUp: vi.fn(),
  signIn: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  isOnline: () => true,
}));

import AuthModal from "./AuthModal";

describe("AuthModal", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("renders nothing when open is false", () => {
    const { container } = render(<AuthModal open={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("locks body scroll while open and restores it on close", () => {
    const { rerender, unmount } = render(<AuthModal open={true} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<AuthModal open={false} onClose={() => {}} />);
    expect(document.body.style.overflow).not.toBe("hidden");
    // Re-open then unmount mid-flight — should still restore.
    rerender(<AuthModal open={true} onClose={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<AuthModal open={true} onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not respond to Escape when closed", () => {
    const onClose = vi.fn();
    render(<AuthModal open={false} onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders sign-in / create-account tabs", () => {
    render(<AuthModal open={true} onClose={() => {}} />);
    // "Sign In" appears both as a tab and as a submit button; we just
    // need at least one match for each tab label to confirm render.
    expect(screen.getAllByText("Sign In").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Create Account").length).toBeGreaterThan(0);
  });
});
