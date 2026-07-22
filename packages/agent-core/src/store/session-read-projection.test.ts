import { describe, expect, test } from "bun:test";
import type { SessionExecutionRecord } from "@archcode/protocol";
import { createEmptyCompressionState, type CompressionBlock, type CompressionState } from "../compression";
import type { SessionToolBatch } from "./types";
import {
  projectSessionCompression,
  projectSessionExecutionInputCheckpoints,
} from "./session-read-projection";

const TEST_BINDING: SessionExecutionRecord["binding"] = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default",
  modelRuntimeRevision: "revision",
};

function execution(id: string, status: SessionExecutionRecord["status"], origin: SessionExecutionRecord["origin"]): SessionExecutionRecord {
  return { id, status, origin, startedAt: id === "source" ? 100 : 300, endedAt: status === "running" ? undefined : 400, binding: TEST_BINDING };
}

function checkpointBatch(input: {
  callState: "blocked" | "queued" | "failed";
  response?: "answer" | "cancel";
  continuationStartedAt?: string;
  continuationCompletedAt?: string;
  archivedAt?: string;
}): SessionToolBatch {
  const responseAppliedAt = input.response === undefined ? undefined : "2026-07-22T11:42:32.830Z";
  return {
    batchId: "batch",
    executionId: "source",
    step: 0,
    agentName: "lead",
    allowedTools: ["ask_user"],
    agentSkills: [],
    partitions: [{ type: "serial", callIds: ["call"] }],
    calls: [{
      ordinal: 0,
      partitionIndex: 0,
      toolCallId: "call",
      toolName: "ask_user",
      input: {},
      traits: { readOnly: true, destructive: false, concurrencySafe: false },
      state: input.callState,
      attempt: 1,
      blocker: {
        requestKey: "request",
        hitlId: "hitl",
        source: { type: "ask_user", toolCallId: "call" },
        displayPayload: { title: "Question", redacted: true },
        ...(responseAppliedAt === undefined ? {} : {
          responseAppliedAt,
          response: input.response === "cancel"
            ? { type: "cancel", reason: "Cancelled" }
            : { type: "question_answer", answers: ["Answer"] },
        }),
      },
      ...(input.callState !== "failed" ? {} : {
        result: {
          isError: true,
          output: {
            preview: "Cancelled",
            completeness: "complete",
            observed: { bytes: 9, lines: 1 },
            canonical: { bytes: 9, lines: 1 },
            stored: { bytes: 9, lines: 1 },
            omitted: { bytes: 0, lines: 0 },
            recovery: { kind: "none" },
          },
        },
      }),
    }],
    createdAt: "2026-07-22T11:42:08.649Z",
    updatedAt: "2026-07-22T11:42:43.420Z",
    ...(input.continuationStartedAt === undefined ? {} : { continuationStartedAt: input.continuationStartedAt }),
    ...(input.continuationCompletedAt === undefined ? {} : { continuationCompletedAt: input.continuationCompletedAt }),
    ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
  } as SessionToolBatch;
}

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
      childBlockRefs: [],
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

    expect(projection.blocksByRef.b1?.summary).toContain("## Current Objective\nEarlier intent");
    expect(projection.blocksByRef.b2?.summary).toContain("## Current Objective\nLater intent");
    expect(projection.activeBlockRefs).toEqual(["b2", "b1"]);
  });
});

describe("projectSessionExecutionInputCheckpoints", () => {
  test("keeps a blocked checkpoint actionable without rewriting its Execution", () => {
    const executions = [
      execution("source", "waiting_for_human", "user_message"),
      execution("unrelated", "completed", "tool_batch"),
    ];
    expect(projectSessionExecutionInputCheckpoints(executions, [checkpointBatch({ callState: "blocked" })])).toEqual([{
      executionId: "source",
      state: "pending_response",
    }]);
    expect(executions[0]?.status).toBe("waiting_for_human");
  });

  test("links an answered checkpoint to its completed continuation Execution", () => {
    const checkpoints = projectSessionExecutionInputCheckpoints([
      execution("source", "waiting_for_human", "user_message"),
      execution("continuation", "completed", "tool_batch"),
    ], [checkpointBatch({
      callState: "queued",
      response: "answer",
      continuationStartedAt: "2026-07-22T11:42:32.892Z",
      continuationCompletedAt: "2026-07-22T11:42:43.420Z",
      archivedAt: "2026-07-22T11:42:43.420Z",
    })]);

    expect(checkpoints).toEqual([{
      executionId: "source",
      state: "continued",
      continuationExecutionId: "continuation",
    }]);
  });

  test("distinguishes an accepted response from a running continuation", () => {
    const source = execution("source", "waiting_for_human", "user_message");
    expect(projectSessionExecutionInputCheckpoints(
      [source],
      [checkpointBatch({ callState: "queued", response: "answer" })],
    )).toEqual([{ executionId: "source", state: "response_received" }]);

    expect(projectSessionExecutionInputCheckpoints(
      [source, execution("continuation", "running", "tool_batch")],
      [checkpointBatch({
        callState: "queued",
        response: "answer",
        continuationStartedAt: "2026-07-22T11:42:32.892Z",
      })],
    )).toEqual([{
      executionId: "source",
      state: "continuing",
      continuationExecutionId: "continuation",
    }]);
  });

  test("projects an archived cancelled response without fabricating a continuation", () => {
    expect(projectSessionExecutionInputCheckpoints(
      [execution("source", "waiting_for_human", "user_message")],
      [checkpointBatch({ callState: "failed", response: "cancel", archivedAt: "2026-07-22T11:42:43.420Z" })],
    )).toEqual([{ executionId: "source", state: "cancelled" }]);
  });
});
