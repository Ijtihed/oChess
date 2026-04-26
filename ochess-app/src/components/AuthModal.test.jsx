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

import AuthModal, { validateUsername } from "./AuthModal";

describe("validateUsername", () => {
  it("accepts simple lowercase usernames", () => {
    expect(validateUsername("alice")).toBeNull();
    expect(validateUsername("alice_42")).toBeNull();
    expect(validateUsername("a1b2c3")).toBeNull();
  });
  it("requires a non-empty value", () => {
    expect(validateUsername("")).toMatch(/required/i);
    expect(validateUsername("   ")).toMatch(/required/i);
  });
  it("rejects names that are too short", () => {
    expect(validateUsername("ab")).toMatch(/at least 3/i);
  });
  it("rejects names that are too long", () => {
    expect(validateUsername("a".repeat(25))).toMatch(/24/);
  });
  it("requires the first character to be a lowercase letter", () => {
    expect(validateUsername("9abc")).toMatch(/start with/i);
    expect(validateUsername("_alice")).toMatch(/start with/i);
    expect(validateUsername("Alice")).toMatch(/start with|lowercase/i);
  });
  it("rejects forbidden characters", () => {
    expect(validateUsername("alice-bob")).toMatch(/lowercase|numbers/i);
    expect(validateUsername("alice bob")).toMatch(/lowercase|numbers/i);
    expect(validateUsername("alice!")).toMatch(/lowercase|numbers/i);
  });
});

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

  it("declares dialog semantics for screen readers", () => {
    const { container } = render(<AuthModal open={true} onClose={() => {}} />);
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("moves focus into the modal after opening", async () => {
    render(<AuthModal open={true} onClose={() => {}} />);
    // Focus is moved on the next paint; wait a tick.
    await new Promise((r) => setTimeout(r, 5));
    const active = document.activeElement;
    // The first focusable inside the sheet should now hold focus —
    // either the close button or the email input depending on tab.
    expect(active).not.toBe(document.body);
  });

  it("traps Tab inside the modal (loops to the first element)", async () => {
    render(<AuthModal open={true} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 5));
    const dialog = document.querySelector("[role='dialog'] > div:nth-child(2)");
    const focusables = dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), a[href]'
    );
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    // Tab from last should wrap to first (preventDefault + .focus()).
    const evt = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    window.dispatchEvent(evt);
    expect(document.activeElement).toBe(focusables[0]);
  });
});
