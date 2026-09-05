import { describe, expect, it } from "bun:test";
import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";
import { testExecutionRecord } from "../testing/test-execution-fixtures";
import {
  CHILD_FINAL_CLASSIFIER_CORPUS,
  CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS,
  CHILD_FINAL_MISSING_MESSAGE,
  CHILD_FINAL_PROTOCOL_ONLY_MESSAGE,
  classifyChildFinalOutput,
  finalOutputForExecution,
} from "./final-output";

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

function classificationState(
  outputs: readonly {
    readonly stepId: string;
    readonly text: string;
    readonly runOrdinal?: number;
    readonly outputPhase?: "commentary" | "final_answer";
  }[],
): Pick<SessionStoreState, "messages"> {
  return {
    messages: outputs.map((output, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      executionId: "child-execution",
      runOrdinal: output.runOrdinal ?? 0,
      stepId: output.stepId,
      outputPhase: output.outputPhase ?? "commentary",
      createdAt: index,
      completedAt: index + 1,
      parts: [{
        type: "assistant-output" as const,
        id: `output-${index}`,
        blockId: `block-${index}`,
        text: output.text,
        createdAt: index,
        completedAt: index + 1,
      }],
    })),
  };
}

describe("classifyChildFinalOutput", () => {
  it("rejects a missing final answer with one stable error", () => {
    expect(classifyChildFinalOutput(classificationState([]), "child-execution", undefined)).toEqual({
      accepted: false,
      error: CHILD_FINAL_MISSING_MESSAGE,
    });
  });

  for (const fixture of CHILD_FINAL_CLASSIFIER_CORPUS) {
    it(`${fixture.expected === "accepted" ? "accepts" : "rejects"} ${fixture.label}`, () => {
      const classification = classifyChildFinalOutput(classificationState([{
        stepId: "final",
        text: fixture.final,
        outputPhase: "final_answer",
      }]), "child-execution", "final");
      if (fixture.expected === "protocol-only") {
        expect(classification).toEqual({ accepted: false, error: CHILD_FINAL_PROTOCOL_ONLY_MESSAGE });
      } else if (fixture.expected === "missing") {
        expect(classification).toEqual({ accepted: false, error: CHILD_FINAL_MISSING_MESSAGE });
      } else {
        expect(classification).toEqual({ accepted: true, output: fixture.final });
      }
    });
  }

  it("rejects the locked adjacent parameter fragment and closing-tail incident", () => {
    const classification = classifyChildFinalOutput(classificationState([
      { stepId: "previous", text: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.previous },
      { stepId: "final", text: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final, outputPhase: "final_answer" },
    ]), "child-execution", "final");
    expect(classification).toEqual({ accepted: false, error: CHILD_FINAL_PROTOCOL_ONLY_MESSAGE });
  });

  it("accepts the same closing tail without adjacent same-run control evidence", () => {
    expect(classifyChildFinalOutput(classificationState([{
      stepId: "final",
      text: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final,
      outputPhase: "final_answer",
    }]), "child-execution", "final")).toEqual({
      accepted: true,
      output: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final,
    });
    expect(classifyChildFinalOutput(classificationState([
      { stepId: "previous", text: "<invoke></invoke>", runOrdinal: 0 },
      { stepId: "final", text: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final, runOrdinal: 1, outputPhase: "final_answer" },
    ]), "child-execution", "final")).toEqual({
      accepted: true,
      output: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final,
    });
  });

  it("uses all same-execution assistant outputs for adjacent control evidence", () => {
    expect(classifyChildFinalOutput(classificationState([
      { stepId: "control", text: "<invoke><parameter name=\"q\">x</parameter></invoke>" },
      { stepId: "final", text: CHILD_FINAL_CONTEXTUAL_TAIL_CORPUS.final, outputPhase: "final_answer" },
    ]), "child-execution", "final")).toEqual({
      accepted: false,
      error: CHILD_FINAL_PROTOCOL_ONLY_MESSAGE,
    });
  });
});
