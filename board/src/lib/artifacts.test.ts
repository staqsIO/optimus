import { describe, it, expect } from "vitest";
import {
  computePrecision,
  formatPrecision,
  formatConfidence,
  type LinkStatsCounts,
} from "./artifacts";

function counts(p: Partial<LinkStatsCounts>): LinkStatsCounts {
  return { auto: 0, pending: 0, confirmed: 0, rejected: 0, ...p };
}

describe("computePrecision", () => {
  it("returns null when there are no reviews", () => {
    expect(computePrecision(counts({ auto: 10, pending: 5 }))).toBeNull();
  });

  it("returns 1 when all reviews are confirmed", () => {
    expect(computePrecision(counts({ confirmed: 4 }))).toBe(1);
  });

  it("returns 0 when all reviews are rejected", () => {
    expect(computePrecision(counts({ rejected: 3 }))).toBe(0);
  });

  it("computes confirmed / (confirmed + rejected)", () => {
    expect(computePrecision(counts({ confirmed: 3, rejected: 1 }))).toBe(0.75);
  });

  it("ignores auto and pending counts", () => {
    expect(
      computePrecision(counts({ auto: 100, pending: 50, confirmed: 1, rejected: 1 })),
    ).toBe(0.5);
  });
});

describe("formatPrecision", () => {
  it("renders the no-reviews placeholder for null", () => {
    expect(formatPrecision(null)).toBe("no reviews yet");
  });

  it("renders a whole-number percentage", () => {
    expect(formatPrecision(0.75)).toBe("75%");
    expect(formatPrecision(1)).toBe("100%");
    expect(formatPrecision(0)).toBe("0%");
  });
});

describe("formatConfidence", () => {
  it("renders a placeholder for null/undefined", () => {
    expect(formatConfidence(null)).toBe("--");
    expect(formatConfidence(undefined)).toBe("--");
  });

  it("renders a percentage", () => {
    expect(formatConfidence(0.92)).toBe("92%");
  });
});
