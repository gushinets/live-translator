import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../src/cli/arguments.js";

describe("CLI argument parsing", () => {
  it("rejects duplicate normalized flags and a flag token used as a value", () => {
    expect(() => parseCliArguments(["--target", "first.sqlite", "--target", "second.sqlite"]))
      .toThrowError("invalid_arguments");
    expect(() => parseCliArguments(["--db", "--unexpected"]))
      .toThrowError("invalid_arguments");
  });

  it("rejects impossible calendar dates instead of normalizing them", async () => {
    const module = await import("../src/cli/arguments.js") as unknown as { parseCliInstant: (value: string) => number };
    expect(module.parseCliInstant("2024-02-29T00:00:00Z")).toBe(Date.parse("2024-02-29T00:00:00Z"));
    expect(() => module.parseCliInstant("2026-02-31T00:00:00Z")).toThrowError("invalid_arguments");
  });
  it("keeps prototype-like flag names as ordinary own keys", () => {
    const values = parseCliArguments(["--__proto__", "value"]);
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
  });
});
