import { describe, expect, test } from "bun:test";
import { commitCompressionBlock, createEmptyCompressionState, CompressionStateError } from "./state";
import { materializeCompressionSummaryTemplate } from "./summary";
import type { BlockRef, CompressionBlockDraft, CompressionRange, CompressionState, CompressionSummary } from "./types";

function range(startIndex: number, endIndex: number): CompressionRange {
  return {
    startMessageId: `msg-${startIndex}`,
    endMessageId: `msg-${endIndex}`,
    startRef: `m${String(startIndex + 1).padStart(4, "0")}`,
    endRef: `m${String(endIndex + 1).padStart(4, "0")}`,
    startIndex,
    endIndex,
  };
}

function summary(childBlockRefs: BlockRef[] = []): CompressionSummary {
  return {
    sections: {
      "Current Objective": childBlockRefs.length > 0 ? `Continue after materialized ${childBlockRefs[0]}` : "Continue task",
      "User Constraints": "Preserve constraints",
      "Decisions Made": "Use contracts first",
      "Open Tasks": "Implement later runtime tasks",
      "Important Files": "compression/state.ts",
      "Tool Results": "No runtime tool results",
      "Errors/Unknown Results": "None",
      "Protected Refs": "No protected refs",
      "Child Block Refs": childBlockRefs.join(", ") || "None",
      "Resume Instructions": "Resume safely",
    },
  };
}

function draft(canonicalBlockId: string, blockRange: CompressionRange, childBlockRefs: BlockRef[] = []): CompressionBlockDraft {
  return {
    id: canonicalBlockId,
    canonicalBlockId,
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: blockRange,
    summary: summary(childBlockRefs),
    childBlockRefs,
    createdAt: 100,
  };
}

function nestedDraft(
  state: CompressionState,
  canonicalBlockId: string,
  blockRange: CompressionRange,
  childBlockRefs: BlockRef[],
): CompressionBlockDraft {
  const template = {
    sections: {
      ...summary().sections,
      "Child Block Refs": childBlockRefs.map((ref) => `(${ref})`).join(" "),
    },
  };
  return {
    ...draft(canonicalBlockId, blockRange, childBlockRefs),
    summary: materializeCompressionSummaryTemplate(template, childBlockRefs, state.blocksByRef),
  };
}

describe("compression nested block DAG", () => {
  test("nested parent allows whole-child nesting and preserves superseded child resolvability", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));
    const parentState = commitCompressionBlock(childState, nestedDraft(childState, "parent", range(0, 4), ["b1"]));

    expect(parentState.blocksByRef.b1).toBeDefined();
    expect(parentState.blocksByRef.b1?.status).toBe("superseded");
    expect(parentState.blocksByRef.b1?.supersededBy).toBe("b2");
    expect(parentState.blocksByRef.b2?.status).toBe("active");
    expect(parentState.activeBlockRefs).toEqual(["b2"]);
    expect(parentState.supersededBlockRefs).toEqual(["b1"]);
  });

  test("nested parent rejects partial active overlap", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 3)));

    expect(() => commitCompressionBlock(childState, draft("partial", range(2, 5)))).toThrow(CompressionStateError);
  });

  test("nested parent must list fully covered active child refs exactly through childBlockRefs", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));

    expect(() => commitCompressionBlock(childState, draft("parent", range(0, 4)))).toThrow(CompressionStateError);
  });

  test("rejects duplicate child lineage before committing state", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));

    expect(() => commitCompressionBlock(childState, draft("parent", range(0, 4), ["b1", "b1"])))
      .toThrow(new CompressionStateError("duplicate_child_block", "Compression child block refs must be unique"));
  });

  test("committed lineage is isolated from the caller-owned draft array", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));
    const childBlockRefs: BlockRef[] = ["b1"];
    const parentDraft = nestedDraft(childState, "parent", range(0, 4), childBlockRefs);

    const parentState = commitCompressionBlock(childState, parentDraft);
    childBlockRefs.push("b1");

    expect(parentState.blocksByRef.b2?.childBlockRefs).toEqual(["b1"]);
    expect(Object.isFrozen(parentState.blocksByRef.b2?.childBlockRefs)).toBe(true);
  });

  test("nested parent rejects lineage without the materialized child payload", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));

    expect(() => commitCompressionBlock(childState, draft("parent", range(0, 4), ["b1"])))
      .toThrow("Materialized child block b1 must appear exactly once; found 0");
  });
});
