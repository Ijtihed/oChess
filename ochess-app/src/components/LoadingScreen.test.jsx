import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import LoadingScreen from "./LoadingScreen";

describe("LoadingScreen", () => {
  it("renders the default 'Loading...' message into the body via portal", () => {
    render(<LoadingScreen />);
    expect(document.body.textContent).toMatch(/Loading\.\.\./);
  });

  it("respects a custom message prop", () => {
    render(<LoadingScreen message="Syncing your games..." />);
    expect(document.body.textContent).toMatch(/Syncing your games/);
  });
});
