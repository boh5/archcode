import { describe, expect, test } from "bun:test";
import { buildGuidelinesSection } from "./guidelines";

describe("buildGuidelinesSection", () => {
  test("contains 'Guidelines' header", () => {
    const result = buildGuidelinesSection();
    expect(result).toContain("## Guidelines");
  });

  test("is a non-empty string", () => {
    const result = buildGuidelinesSection();
    expect(result.length).toBeGreaterThan(0);
  });

  test("is deterministic (same call same result)", () => {
    const a = buildGuidelinesSection();
    const b = buildGuidelinesSection();
    expect(a).toBe(b);
  });

  test("does not instruct read-only roles to call an unavailable interaction tool", () => {
    const result = buildGuidelinesSection();

    expect(result).toContain("use ask_user if that tool is available");
    expect(result).toContain("report the ambiguity");
  });
});
