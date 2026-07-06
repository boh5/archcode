import { describe, expect, test } from "bun:test";
import { COMPRESSION_SUMMARY_FORMAT_VERSION } from "./constants";
import { commitCompressionBlock, createEmptyCompressionState, CompressionStateError } from "./state";
import type { BlockRef, CompressionBlockDraft, CompressionRange, CompressionSummary } from "./types";

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
    version: COMPRESSION_SUMMARY_FORMAT_VERSION,
    childBlockRefs,
    sections: {
      "Current Objective": childBlockRefs.length > 0 ? `Continue after (${childBlockRefs[0]})` : "Continue task",
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

describe("compression nested block DAG", () => {
  test("nested parent allows whole-child nesting and preserves superseded child resolvability", () => {
    const childState = commitCompressionBlock(createEmptyCompressionState(), draft("child", range(1, 2)));
    const parentState = commitCompressionBlock(childState, draft("parent", range(0, 4), ["b1"]));

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
});
