import { describe, expect, test } from "bun:test";
import {
  createEmptyCompressionState,
  type CompressionBlock,
  type CompressionState,
} from "../compression";
import { projectSessionCompression } from "./session-read-projection";

function block(input: {
  id: string;
  ref: `b${number}`;
  createdAt: number;
  summary: string;
}): CompressionBlock {
  return {
    id: input.id,
    ref: input.ref,
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: {
      startMessageId: `${input.id}-start`,
      endMessageId: `${input.id}-end`,
      startRef: "m0001",
      endRef: "m0002",
      startIndex: 0,
      endIndex: 1,
    },
    summary: {
      sections: {
        "Current Objective": input.summary,
        "User Constraints": "Constraints",
        "Decisions Made": "Decisions",
        "Open Tasks": "Open tasks",
        "Important Files": "Important files",
        "Tool Results": "Tool results",
        "Errors/Unknown Results": "No errors",
        "Protected Refs": "None",
        "Child Block Refs": "None",
        "Resume Instructions": "Continue",
      },
    },
    protectedRefs: [],
    childBlockRefs: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

describe("projectSessionCompression", () => {
  test("projects persisted blocks into one rendered authoritative Protocol snapshot", () => {
    const later = block({ id: "later", ref: "b2", createdAt: 20, summary: "Later intent" });
    const earlier = block({ id: "earlier", ref: "b1", createdAt: 10, summary: "Earlier intent" });
    const empty = createEmptyCompressionState();
    const state: CompressionState = {
      ...empty,
      blocksByRef: { b2: later, b1: earlier },
      activeBlockRefs: ["b2", "b1"],
      updatedAt: 20,
    };

    const projection = projectSessionCompression(state);

    expect(projection.blocksByRef.b1?.summary.sections["Current Objective"]).toBe("Earlier intent");
    expect(projection.blocksByRef.b2?.summary.sections["Current Objective"]).toBe("Later intent");
    expect(projection.activeBlockRefs).toEqual(["b2", "b1"]);
  });
});
