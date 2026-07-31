import { describe, expect, test } from "bun:test";
import {
  materializeCompressionSummaryTemplate,
  renderCompressionSummary,
  CompressionSummaryValidationError,
  validateCompressionSummary,
  validateCompressionSummaryTemplate,
} from "./summary";
import type {
  BlockRef,
  CompressionBlock,
  CompressionSummary,
  CompressionSummaryTemplate,
} from "./types";

function sections(objective = "Ship contract layer") {
  return {
    "Current Objective": objective,
    "User Constraints": "No runtime wiring",
    "Decisions Made": "Use strict schemas",
    "Open Tasks": "Later tasks wire projection",
    "Important Files": "packages/agent-core/src/compression/summary.ts",
    "Tool Results": "Tests only",
    "Errors/Unknown Results": "None",
    "Protected Refs": "None",
    "Child Block Refs": "None",
    "Resume Instructions": "Continue with Task 2",
  };
}

function template(overrides: Partial<CompressionSummaryTemplate> = {}): CompressionSummaryTemplate {
  return { sections: sections(), ...overrides };
}

function storedSummary(objective: string): CompressionSummary {
  return { sections: sections(objective) };
}

function block(ref: BlockRef, summary: CompressionSummary): CompressionBlock {
  const index = Number(ref.slice(1));
  return {
    id: `block-${ref}`,
    ref,
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: {
      startMessageId: `msg-${index}`,
      endMessageId: `msg-${index + 1}`,
      startRef: `m${String(index).padStart(4, "0")}`,
      endRef: `m${String(index + 1).padStart(4, "0")}`,
      startIndex: index - 1,
      endIndex: index,
    },
    summary,
    protectedRefs: [],
    childBlockRefs: [],
    createdAt: index,
    updatedAt: index,
  };
}

describe("compression summary schema", () => {
  test("rejects missing sections and fields outside summary content", () => {
    const { "Current Objective": _removed, ...incomplete } = sections();

    expect(validateCompressionSummaryTemplate({ sections: incomplete }).ok).toBe(false);
    expect(validateCompressionSummaryTemplate({ ...template(), unexpectedField: true }).errors)
      .toContain("Unknown summary field unexpectedField");
  });

  test("requires every runtime-derived child placeholder exactly once", () => {
    const missing = template();
    const duplicate = template({
      sections: {
        ...sections(),
        "Current Objective": "First (b1)",
        "Resume Instructions": "Second (b1)",
      },
    });
    const unknown = template({ sections: { ...sections(), "Current Objective": "Unknown (b9)" } });

    expect(validateCompressionSummaryTemplate(missing, ["b1"]).errors)
      .toContain("Required child placeholder (b1) must appear exactly once; found 0");
    expect(validateCompressionSummaryTemplate(duplicate, ["b1"]).errors)
      .toContain("Required child placeholder (b1) must appear exactly once; found 2");
    expect(validateCompressionSummaryTemplate(unknown, ["b1"]).errors)
      .toContain("Placeholder (b9) is not a required child block ref");
  });

  test("stored summaries reject unresolved block placeholders", () => {
    expect(validateCompressionSummary(storedSummary("Expanded child text")).ok).toBe(true);
    expect(validateCompressionSummary(storedSummary("Still points at (b1)")).ok).toBe(false);
    expect(validateCompressionSummary(storedSummary('<compression-child ref="b1" >')).ok).toBe(false);
  });
});

describe("compression summary materialization", () => {
  test("replaces a child placeholder with the complete stored summary", () => {
    const child = block("b1", storedSummary("CHILD_SENTINEL"));
    const parentTemplate = template({
      sections: { ...sections("Before (b1) after"), "Child Block Refs": "b1 contributes prior work" },
    });

    const materialized = materializeCompressionSummaryTemplate(parentTemplate, ["b1"], { b1: child });
    const rendered = renderCompressionSummary(materialized);

    expect(rendered).toContain('Before <compression-child ref="b1">\n## Current Objective\nCHILD_SENTINEL');
    expect(rendered).toContain("</compression-child> after");
    expect(rendered).toContain("after");
    expect(rendered).not.toContain("(b1)");
    expect(Object.keys(materialized)).toEqual(["sections"]);
  });

  test("rejects invalid templates and missing required child blocks", () => {
    const unexpectedPlaceholder = template({
      sections: { ...sections(), "Current Objective": "Unexpected (b9)" },
    });
    const missingChild = template({
      sections: { ...sections(), "Current Objective": "Missing (b1)" },
    });

    expect(() => materializeCompressionSummaryTemplate(unexpectedPlaceholder, [], {}))
      .toThrow(CompressionSummaryValidationError);
    expect(() => materializeCompressionSummaryTemplate(missingChild, ["b1"], {}))
      .toThrow("Required child block b1 does not exist");
  });
});
