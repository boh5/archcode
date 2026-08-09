import { describe, expect, test } from "bun:test";
import type {
  AssistantSessionPart,
  ExecutionModelBindingSummary,
  NormalizedUsage,
  SessionExecutionRecord,
  SessionMessage,
  SessionStep,
  ToolPart,
  UserSessionPart,
} from "@archcode/protocol";
import {
  buildExecutionWorkstream,
  stabilizeExecutionWorkstreamProjection,
  type ExecutionWorkstreamInput,
} from "./execution-workstream";

const binding: ExecutionModelBindingSummary = {
  selection: { model: "local:test" },
  providerId: "local",
  modelId: "test",
  providerDisplayName: "Local",
  modelDisplayName: "Test",
  resolution: "profile_default",
  modelRuntimeRevision: "r1",
};

const zeroUsage: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

function execution(
  id = "execution",
  overrides: Partial<SessionExecutionRecord> = {},
): SessionExecutionRecord {
  return {
    id,
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    executionSkills: [],
    durationMs: 100,
    status: "completed",
    endedAt: 100,
    runs: [{
      ordinal: 0,
      startedAt: 0,
      endedAt: 100,
      durationMs: 100,
      binding,
      usageDelta: zeroUsage,
      settlement: { key: "run", goalInstanceId: null },
    }],
    terminalSettlement: { key: "terminal", goalInstanceId: null },
    ...overrides,
  } as SessionExecutionRecord;
}

function userText(
  id: string,
  value: string,
  createdAt: number,
): UserSessionPart {
  return { type: "text", id, text: value, createdAt, completedAt: createdAt };
}

function output(
  id: string,
  value: string,
  createdAt: number,
): AssistantSessionPart {
  return {
    type: "assistant-output",
    id,
    blockId: id,
    text: value,
    createdAt,
    completedAt: createdAt,
  };
}

function reasoning(
  id: string,
  value: string,
  createdAt: number,
): AssistantSessionPart {
  return {
    type: "reasoning",
    id,
    blockId: id,
    text: value,
    createdAt,
    completedAt: createdAt,
  };
}

function tool(id: string, createdAt: number): ToolPart {
  return {
    type: "tool",
    id,
    state: "running",
    toolCallId: `call:${id}`,
    toolName: "file_read",
    input: { path: `${id}.ts` },
    createdAt,
    startedAt: createdAt,
  };
}

function user(id: string, value: string, createdAt: number): SessionMessage {
  return {
    id,
    role: "user",
    executionId: "execution",
    parts: [userText(`${id}:text`, value, createdAt)],
    createdAt,
    completedAt: createdAt,
  };
}

function assistant(
  id: string,
  stepId: string,
  outputPhase: "commentary" | "final_answer",
  parts: AssistantSessionPart[],
  createdAt: number,
): SessionMessage {
  return {
    id,
    role: "assistant",
    stepId,
    outputPhase,
    runOrdinal: 0,
    executionId: "execution",
    parts,
    createdAt,
    completedAt: createdAt,
  };
}

function step(
  id: string,
  startedAt: number,
  reasoningTokens = 0,
): SessionStep {
  return {
    id,
    executionId: "execution",
    runOrdinal: 0,
    step: startedAt,
    startedAt,
    completedAt: startedAt + 1,
    finishReason: "stop",
    usage: { ...zeroUsage, reasoningTokens },
  };
}

function input(
  overrides: Partial<ExecutionWorkstreamInput> = {},
): ExecutionWorkstreamInput {
  return {
    messages: [],
    executions: [],
    steps: [],
    childSessionLinks: [],
    session: { agentName: "lead", profile: "principal" },
    agentDescriptors: [],
    ...overrides,
  };
}

describe("buildExecutionWorkstream", () => {
  test("preserves commentary and tools in Work and keeps attempt Reasoning usage separate", () => {
    const messages = [
      user("input", "Inspect the session", 5),
      assistant("attempt-1", "step-1", "commentary", [
        output("commentary-1", "I will inspect status.", 10),
        tool("git-status", 11),
      ], 10),
      assistant("attempt-2", "step-2", "commentary", [
        output("commentary-2", "Now I will read the file.", 20),
        tool("read-1", 21),
      ], 20),
      assistant("attempt-3", "step-3", "commentary", [
        output("commentary-3", "I will inspect the second file.", 30),
        tool("read-2", 31),
      ], 30),
      assistant("attempt-4", "step-4", "final_answer", [
        output("final-output", "Done", 90),
      ], 90),
    ];

    const projection = buildExecutionWorkstream(input({
      executions: [execution()],
      messages,
      steps: [
        step("step-1", 10, 137),
        step("step-2", 20, 56),
        step("step-3", 30),
        step("step-4", 90),
      ],
    }));
    const segment = projection.executions[0]!.segments[0]!;

    expect(segment.inputMessage).toBe(messages[0]);
    expect(segment.workItems.map((item) =>
      item.kind === "reasoning-usage" ? `reasoning:${item.tokens}` : item.message.id
    )).toEqual([
      "reasoning:137",
      "attempt-1",
      "reasoning:56",
      "attempt-2",
      "attempt-3",
    ]);
    expect(segment.finalResponse?.message).toBe(messages[4]);
    expect(segment.finalResponse?.outputParts.map((part) => part.text)).toEqual([
      "Done",
    ]);
  });

  test("keeps multiple actual Reasoning blocks ordered without a token placeholder", () => {
    const modelMessage = assistant("attempt", "step-1", "commentary", [
      reasoning("reason-a", "A", 10),
      output("commentary", "Between", 11),
      reasoning("reason-b", "B", 12),
      tool("read", 13),
    ], 10);
    const segment = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [modelMessage],
      steps: [step("step-1", 10, 193)],
    })).executions[0]!.segments[0]!;

    expect(segment.workItems).toHaveLength(1);
    expect(segment.workItems[0]?.kind).toBe("message");
    expect(
      segment.workItems[0]?.kind === "message"
        ? segment.workItems[0].parts.map((part) => part.id)
        : [],
    ).toEqual(["reason-a", "commentary", "reason-b", "read"]);
  });

  test("retains an empty attempt anchor for token-only Reasoning", () => {
    const emptyAttempt = assistant(
      "attempt",
      "step-1",
      "commentary",
      [],
      10,
    );
    const segment = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [emptyAttempt],
      steps: [step("step-1", 10, 42)],
    })).executions[0]!.segments[0]!;

    expect(segment.workItems).toEqual([{
      kind: "reasoning-usage",
      id: "reasoning-usage:step-1",
      stepId: "step-1",
      tokens: 42,
    }]);
  });

  test("does not project an open empty provider block as a blank Work item", () => {
    const emptyOutput = output("empty-output", "", 10);
    const openEmptyOutput = { ...emptyOutput, completedAt: undefined };
    const emptyAttempt = assistant(
      "attempt",
      "step-1",
      "commentary",
      [openEmptyOutput],
      10,
    );
    const segment = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [emptyAttempt],
      steps: [step("step-1", 10, 0)],
    })).executions[0]!.segments[0]!;

    expect(segment.workItems).toEqual([]);
  });

  test("creates one Segment for every adjacent canonical UserMessage", () => {
    const one = user("one", "One", 10);
    const two = user("two", "Two", 11);
    const three = user("three", "Three", 12);
    const segments = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [one, two, three],
    })).executions[0]!.segments;

    expect(segments.map((segment) => segment.inputMessage?.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(segments.map((segment) => segment.workItems)).toEqual([[], [], []]);
  });

  test("splits steered work at the exact UserMessage boundary", () => {
    const initial = user("input", "Initial", 10);
    const early = assistant("early", "step-1", "commentary", [
      output("early-output", "Inspect", 20),
    ], 20);
    const steer = user("steer", "Use the narrow fix", 40);
    const after = assistant("after", "step-2", "commentary", [
      output("after-output", "Read focused file", 50),
    ], 50);
    const final = assistant("final", "step-3", "final_answer", [
      output("final-output", "Done", 90),
    ], 90);
    const segments = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [initial, early, steer, after, final],
      steps: [step("step-1", 20), step("step-2", 50), step("step-3", 90)],
    })).executions[0]!.segments;

    expect(segments.map((segment) => segment.id)).toEqual([
      "work:execution:after:input",
      "work:execution:after:steer",
    ]);
    expect(segments[0]!.workItems[0]?.kind === "message"
      ? segments[0]!.workItems[0].message
      : undefined).toBe(early);
    expect(segments[1]!.workItems[0]?.kind === "message"
      ? segments[1]!.workItems[0].message
      : undefined).toBe(after);
    expect(segments[1]!.finalResponse?.message).toBe(final);
    expect(segments.map((segment) => segment.activeDurationMs)).toEqual([
      40,
      60,
    ]);
  });

  test("uses outputPhase rather than terminal-step inference for final response", () => {
    const commentary = assistant("commentary", "step-1", "commentary", [
      output("commentary-output", "Not final", 10),
    ], 10);
    const final = assistant("final", "step-2", "final_answer", [
      output("final-output", "Authoritative final", 20),
    ], 20);
    const segment = buildExecutionWorkstream(input({
      executions: [execution()],
      messages: [commentary, final],
      steps: [
        { ...step("step-1", 10), finishReason: "stop" },
        { ...step("step-2", 20), finishReason: "tool-calls" },
      ],
    })).executions[0]!.segments[0]!;

    expect(segment.workItems[0]?.kind === "message"
      ? segment.workItems[0].message
      : undefined).toBe(commentary);
    expect(segment.finalResponse?.message).toBe(final);
  });

  test("stabilizes unchanged projections but replaces changed Work items", () => {
    const record = execution();
    const firstMessage = assistant("assistant", "step-1", "commentary", [
      output("assistant-output", "First output", 10),
    ], 10);
    const nextMessage = assistant("assistant", "step-1", "commentary", [
      output("assistant-output", "Updated output", 10),
    ], 10);
    const first = buildExecutionWorkstream(input({
      executions: [record],
      messages: [firstMessage],
    }));
    const unchanged = buildExecutionWorkstream(input({
      executions: [record],
      messages: [firstMessage],
    }));
    const next = buildExecutionWorkstream(input({
      executions: [record],
      messages: [nextMessage],
    }));

    expect(stabilizeExecutionWorkstreamProjection(first, unchanged).executions[0])
      .toBe(first.executions[0]);
    expect(stabilizeExecutionWorkstreamProjection(first, next).executions[0])
      .toBe(next.executions[0]);
  });

  test("partitions active time across resumed runs", () => {
    const record = execution("execution", {
      durationMs: 30,
      endedAt: 100,
      runs: [
        {
          ordinal: 0,
          startedAt: 0,
          endedAt: 20,
          durationMs: 20,
          binding,
          usageDelta: zeroUsage,
          settlement: { key: "one", goalInstanceId: null },
        },
        {
          ordinal: 1,
          startedAt: 90,
          endedAt: 100,
          durationMs: 10,
          binding,
          usageDelta: zeroUsage,
          settlement: { key: "two", goalInstanceId: null },
        },
      ],
    });
    const segments = buildExecutionWorkstream(input({
      executions: [record],
      messages: [
        user("first", "First", 0),
        assistant("work", "step-1", "commentary", [
          output("work-output", "Work", 30),
        ], 30),
        user("steer", "Steer", 90),
      ],
    })).executions[0]!.segments;

    expect(segments.map((segment) => segment.activeDurationMs)).toEqual([
      20,
      10,
    ]);
  });
});
