import { describe, expect, it } from "bun:test";
import type { SessionStoreState } from "../store/types";
import { testExecutionBinding } from "../testing/test-execution-fixtures";
import { finalOutputForExecution } from "./final-output";

function state(status: "completed" | "failed", latestText?: string): Pick<SessionStoreState, "executions" | "messages"> {
  return {
    executions: [
      { id: "old", startedAt: 1, endedAt: 2, status: "completed", binding: testExecutionBinding, origin: "tool_call" },
      { id: "latest", startedAt: 3, endedAt: 4, status, binding: testExecutionBinding, origin: "tool_call" },
    ],
    messages: [
      {
        id: "old-message",
        role: "assistant",
        executionId: "old",
        createdAt: 1,
        completedAt: 2,
        parts: [{ type: "text", id: "old-text", text: "VERDICT: APPROVED", createdAt: 1, completedAt: 2 }],
      },
      ...(latestText === undefined ? [] : [{
        id: "latest-message",
        role: "assistant" as const,
        executionId: "latest",
        createdAt: 3,
        completedAt: 4,
        parts: [
          { type: "text" as const, id: "latest-a", text: latestText, createdAt: 3, completedAt: 4 },
          { type: "reasoning" as const, id: "reasoning", text: "hidden", createdAt: 3, completedAt: 4 },
          { type: "text" as const, id: "latest-b", text: " tail", createdAt: 3, completedAt: 4 },
        ],
      }]),
    ],
  };
}

describe("finalOutputForExecution", () => {
  it("reads only text parts from the matching completed execution", () => {
    expect(finalOutputForExecution(state("completed", "latest"), "latest")).toBe("latest tail");
  });

  it("returns an empty string for a completed execution without assistant text", () => {
    expect(finalOutputForExecution(state("completed"), "latest")).toBe("");
  });

  it("never falls back to an older completed execution", () => {
    expect(finalOutputForExecution(state("failed"), "latest")).toBeUndefined();
    expect(finalOutputForExecution(state("completed"), "latest")).toBe("");
  });
});
