import { describe, expect, test } from "bun:test";
import { validateCompressionSummary } from "./summary";
import type { CompressionSummary } from "./types";

function validSummary(overrides: Partial<CompressionSummary> = {}): CompressionSummary {
  return {
    childBlockRefs: [],
    sections: {
      "Current Objective": "Ship contract layer",
      "User Constraints": "No runtime wiring",
      "Decisions Made": "Use strict schemas",
      "Open Tasks": "Later tasks wire projection",
      "Important Files": "packages/agent-core/src/compression/summary.ts",
      "Tool Results": "Tests only",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": "None",
      "Resume Instructions": "Continue with Task 2",
    },
    ...overrides,
  };
}

describe("compression summary schema", () => {
  test("summary rejects missing required sections", () => {
    const summary = validSummary();
    const { "Current Objective": _removed, ...sections } = summary.sections;

    const result = validateCompressionSummary({ ...summary, sections });

    expect(result.ok).toBe(false);
  });

  test("summary rejects the removed version field", () => {
    expect(validateCompressionSummary({ ...validSummary(), version: 1 }).ok).toBe(false);
  });

  test("summary requires child placeholders exactly once", () => {
    const summary = validSummary({
      childBlockRefs: ["b1"],
      sections: {
        ...validSummary().sections,
        "Current Objective": "Continue after (b1)",
        "Child Block Refs": "b1",
      },
    });

    expect(validateCompressionSummary(summary, ["b1"]).ok).toBe(true);
    expect(validateCompressionSummary(validSummary({ childBlockRefs: ["b1"] }), ["b1"]).ok).toBe(false);
    expect(validateCompressionSummary({
      ...summary,
      sections: { ...summary.sections, "Resume Instructions": "Use (b1) too" },
    }, ["b1"]).ok).toBe(false);
  });

  test("summary with no required children accepts no declared child refs", () => {
    expect(validateCompressionSummary(validSummary()).ok).toBe(true);
  });

  test("summary rejects declared child refs when no children are required", () => {
    const result = validateCompressionSummary(validSummary({ childBlockRefs: ["b1"] }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Child Block Refs must not include unknown ref b1");
  });

  test("summary rejects extra declared child refs outside required children", () => {
    const summary = validSummary({
      childBlockRefs: ["b1", "b2"],
      sections: {
        ...validSummary().sections,
        "Current Objective": "Continue after (b1)",
        "Child Block Refs": "b1, b2",
      },
    });

    const result = validateCompressionSummary(summary, ["b1"]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Child Block Refs must not include unknown ref b2");
  });

  test("summary rejects undeclared or non-required block placeholders in rendered text", () => {
    const summary = validSummary({
      childBlockRefs: ["b1"],
      sections: {
        ...validSummary().sections,
        "Current Objective": "Continue after (b1)",
        "Resume Instructions": "Do not follow unknown placeholder (b2)",
        "Child Block Refs": "b1",
      },
    });

    const result = validateCompressionSummary(summary, ["b1"]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Placeholder (b2) is not a required declared child block ref");
  });
});
