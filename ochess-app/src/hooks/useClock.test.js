import { describe, it, expect } from "vitest";
import { formatTime } from "./useClock";

describe("formatTime", () => {
  it("returns 0:00 for null/undefined", () => {
    expect(formatTime(null)).toBe("0:00");
    expect(formatTime(undefined)).toBe("0:00");
  });

  it("returns 0:00 for zero or negative", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(-100)).toBe("0:00");
  });

  it("formats seconds correctly", () => {
    expect(formatTime(5000)).toBe("0:05");
    expect(formatTime(59000)).toBe("0:59");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(60000)).toBe("1:00");
    expect(formatTime(90000)).toBe("1:30");
    expect(formatTime(600000)).toBe("10:00");
  });

  it("rounds up partial seconds", () => {
    expect(formatTime(1500)).toBe("0:02");
    expect(formatTime(100)).toBe("0:01");
  });
});
