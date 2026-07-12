import { describe, expect, test } from "bun:test";
import { buildGuidelinesSection } from "./guidelines";

describe("buildGuidelinesSection", () => {
  test("defines the shared intent contract without granting role capabilities", () => {
    const result = buildGuidelinesSection();

    expect(result).toContain("## Execution Contract");
    expect(result).toContain("answer, report, or review");
    expect(result).toContain("diagnose");
    expect(result).toContain("change, build, or fix");
    expect(result).toContain("monitor or wait");
    expect(result).toContain("within this role's hardcoded capabilities");
    expect(result).not.toContain("change requests grant write access");
  });

  test("defines the evidence loop, scope boundary, verification ladder, and stop conditions", () => {
    const result = buildGuidelinesSection();

    expect(result).toContain("inspect evidence");
    expect(result).toContain("smallest valid next action");
    expect(result).toContain("verify the result");
    expect(result).toContain("unrelated failures");
    expect(result).toContain("narrowest meaningful verification");
    expect(result).toContain("genuine blocker");
    expect(result).toContain("background work that can affect the conclusion");
  });

  test("is deterministic", () => {
    expect(buildGuidelinesSection()).toBe(buildGuidelinesSection());
  });
});
