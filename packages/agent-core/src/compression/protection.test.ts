import { describe, expect, test } from "bun:test";
import type {
  AssistantSessionPart,
  SessionMessage,
} from "@archcode/protocol";
import { collectProtectedRefsForRange } from "./protection";
import type { CompressionRange } from "./types";

function assistantMessage(
  id: string,
  stepId: string,
  parts: AssistantSessionPart[],
): SessionMessage {
  return {
    id,
    role: "assistant",
    executionId: "execution",
    runOrdinal: 0,
    stepId,
    outputPhase: "commentary",
    parts,
    createdAt: 1,
    completedAt: 2,
  };
}

function userMessage(id: string, text: string): SessionMessage {
  return {
    id,
    role: "user",
    parts: [{
      type: "text",
      id: `${id}:text`,
      text,
      createdAt: 1,
      completedAt: 2,
    }],
    createdAt: 1,
    completedAt: 2,
  };
}

const range: CompressionRange = {
  startMessageId: "output",
  endMessageId: "user",
  startRef: "m0001",
  endRef: "m0003",
  startIndex: 0,
  endIndex: 2,
};

describe("collectProtectedRefsForRange", () => {
  test("protects tagged Assistant output and Reasoning without treating user text as model protection", () => {
    const result = collectProtectedRefsForRange({
      messages: [
        assistantMessage("output", "step-output", [{
          type: "assistant-output",
          id: "output-part",
          blockId: "output-block",
          text: "<protect>Keep this output</protect>",
          createdAt: 1,
          completedAt: 2,
        }]),
        assistantMessage("reasoning", "step-reasoning", [{
          type: "reasoning",
          id: "reasoning-part",
          blockId: "reasoning-block",
          text: "<protect>Keep this reasoning</protect>",
          createdAt: 1,
          completedAt: 2,
        }]),
        userMessage("user", "<protect>User-authored text is not a protect tag</protect>"),
        userMessage("tail-a", "Tail A"),
        userMessage("tail-b", "Tail B"),
      ],
    }, range);

    expect(result.ok).toBe(false);
    expect(result.protectedRefs).toEqual([
      expect.objectContaining({
        ref: "m0001",
        kind: "protect_tag",
        messageId: "output",
        partId: "output-part",
      }),
      expect.objectContaining({
        ref: "m0002",
        kind: "protect_tag",
        messageId: "reasoning",
        partId: "reasoning-part",
      }),
    ]);
  });
});
