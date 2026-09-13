import { describe, expect, it } from "vitest";
import { nextExpectedSpeaker, resolveSide } from "./SideResolver";

describe("resolveSide", () => {
  it("returns the expected side when there is no manual override", () => {
    expect(resolveSide("A")).toBe("A");
    expect(resolveSide("B")).toBe("B");
  });

  it("returns the manual override when one is provided, regardless of expectation", () => {
    expect(resolveSide("A", "B")).toBe("B");
    expect(resolveSide("B", "A")).toBe("A");
  });

  it("does not use language as an identity signal (no language parameter exists)", () => {
    // Type-level guarantee: resolveSide only accepts Side values.
    expect(resolveSide("A", undefined)).toBe("A");
  });
});

describe("nextExpectedSpeaker", () => {
  it("alternates from A to B", () => {
    expect(nextExpectedSpeaker("A")).toBe("B");
  });

  it("alternates from B to A", () => {
    expect(nextExpectedSpeaker("B")).toBe("A");
  });
});
