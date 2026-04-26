import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import ErrorBoundary from "./ErrorBoundary";

function Boom({ message = "boom" }) {
  throw new Error(message);
}

beforeEach(() => {
  // The component logs render errors to console.error; silence the
  // expected noise so the test output stays clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="happy">all good</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId("happy")).toBeDefined();
  });

  it("catches a render error and shows the fallback UI with the error message", () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom!" />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Something went wrong/i)).toBeDefined();
    expect(screen.getByText(/kaboom!/)).toBeDefined();
    expect(screen.getByText(/Try again/i)).toBeDefined();
    expect(screen.getByText(/Reload home/i)).toBeDefined();
  });

  it("uses role=alert with aria-live=assertive so screen readers pick up the failure", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    const alert = document.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it("the Try again button clears the error so subsequent renders work", () => {
    let shouldThrow = true;
    function Child() {
      if (shouldThrow) throw new Error("first time");
      return <div data-testid="recovered">recovered</div>;
    }
    const { rerender } = render(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Something went wrong/i)).toBeDefined();
    shouldThrow = false;
    fireEvent.click(screen.getByText(/Try again/i));
    rerender(
      <ErrorBoundary>
        <Child />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("recovered")).toBeDefined();
  });
});
