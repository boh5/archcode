import { describe, expect, it } from "bun:test";
import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";
import { testExecutionRecord } from "../testing/test-execution-fixtures";
import { finalOutputForExecution } from "./final-output";

function completedWithFinal(
  id: string,
  stepId: string,
): SessionExecutionRecord {
  const record = testExecutionRecord(id, "completed");
  if (record.status !== "completed") {
    throw new Error("Expected completed execution fixture");
  }
  return { ...record, finalOutputStepId: stepId };
}

function state(
  status: "completed" | "failed",
  latestText?: string,
  outputPhase: "commentary" | "final_answer" = "final_answer",
): Pick<SessionStoreState, "executions" | "messages"> {
  const oldExecution = completedWithFinal("old", "old-step");
  const latestExecution = testExecutionRecord("latest", status);
  return {
    executions: [
      oldExecution,
      ...(status === "completed" && latestText !== undefined
        ? [completedWithFinal("latest", "latest-step")]
        : [latestExecution]),
    ],
    messages: [
      {
        id: "old-message",
        role: "assistant",
        executionId: "old",
        runOrdinal: 0,
        stepId: "old-step",
        outputPhase: "final_answer",
        createdAt: 1,
        completedAt: 2,
        parts: [{
          type: "assistant-output",
          id: "old-output",
          blockId: "old-block",
          text: "Earlier completed response",
          createdAt: 1,
          completedAt: 2,
        }],
      },
      ...(latestText === undefined
        ? []
        : [{
            id: "latest-message",
            role: "assistant" as const,
            executionId: "latest",
            runOrdinal: 0,
            stepId: "latest-step",
            outputPhase,
            createdAt: 3,
            completedAt: 4,
            parts: [
              {
                type: "assistant-output" as const,
                id: "latest-a",
                blockId: "latest-block-a",
                text: latestText,
                createdAt: 3,
                completedAt: 4,
              },
              {
                type: "reasoning" as const,
                id: "reasoning",
                blockId: "reasoning-block",
                text: "hidden",
                createdAt: 3,
                completedAt: 4,
              },
              {
                type: "assistant-output" as const,
                id: "latest-b",
                blockId: "latest-block-b",
                text: " tail",
                createdAt: 3,
                completedAt: 4,
              },
            ],
          }]),
    ],
  };
}

describe("finalOutputForExecution", () => {
  it("reads only Assistant output from the matching committed final phase", () => {
    expect(finalOutputForExecution(state("completed", "latest"), "latest"))
      .toBe("latest tail");
  });

  it("does not treat commentary output as a final result", () => {
    expect(
      finalOutputForExecution(
        state("completed", "still working", "commentary"),
        "latest",
      ),
    ).toBe("");
  });

  it("returns an empty string when a completed execution has no final output step", () => {
    expect(finalOutputForExecution(state("completed"), "latest")).toBe("");
  });

  it("never reads an older execution when the requested execution failed", () => {
    expect(finalOutputForExecution(state("failed", "latest"), "latest"))
      .toBeUndefined();
  });
});
