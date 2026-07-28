import { describe, expect, test } from "bun:test";
import type {
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
  SessionMessage,
  SessionPart,
  SessionStep,
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

function execution(
  id = "execution",
  overrides: Partial<SessionExecutionRecord> = {},
): SessionExecutionRecord {
  return {
    id,
    startedAt: 0,
    origin: "user_message",
    maxSteps: 10,
    durationMs: 100,
    status: "completed",
    endedAt: 100,
    runs: [
      {
        ordinal: 0,
        startedAt: 0,
        endedAt: 100,
        durationMs: 100,
        binding,
        usageDelta: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
        settlement: { key: "run", goalInstanceId: null },
      },
    ],
    terminalSettlement: { key: "terminal", goalInstanceId: null },
    ...overrides,
  } as SessionExecutionRecord;
}

function text(id: string, value: string, createdAt: number): SessionPart {
  return { type: "text", id, text: value, createdAt, completedAt: createdAt };
}

function message(
  id: string,
  role: SessionMessage["role"],
  parts: SessionPart[],
): SessionMessage {
  const createdAt = "createdAt" in parts[0]! ? parts[0]!.createdAt : 0;
  return {
    id,
    role,
    parts,
    createdAt,
    completedAt: createdAt,
    executionId: "execution",
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
  test("keeps initial work before a Steer and following work after it in array order", () => {
    const initial = message("input", "user", [
      text("input-text", "Initial", 10),
    ]);
    const early = message("early", "assistant", [
      {
        type: "reasoning",
        id: "early-work",
        text: "Inspect",
        createdAt: 20,
        completedAt: 35,
      },
    ]);
    const steer = {
      ...message("steer", "user", [
        text("steer-text", "Use the narrow fix", 25),
      ]),
      completedAt: 40,
      parts: [{
        type: "text" as const,
        id: "steer-text",
        text: "Use the narrow fix",
        createdAt: 25,
        completedAt: 40,
      }],
    };
    const after = message("after", "assistant", [
      {
        type: "reasoning",
        id: "tool",
        text: "Read the focused file",
        createdAt: 50,
        completedAt: 50,
      },
    ]);
    const final = message("final", "assistant", [
      text("final-text", "Done", 90),
    ]);
    const result = buildExecutionWorkstream(
      input({
        executions: [execution()],
        messages: [initial, early, steer, after, final],
        steps: [
          {
            id: "step",
            executionId: "execution",
            runOrdinal: 0,
            step: 1,
            startedAt: 80,
            completedAt: 90,
            finishReason: "stop",
          },
        ],
      }),
    );
    const segments = result.executions[0]!.segments;
    expect(segments.map((segment) => segment.id)).toEqual([
      "work:execution:after:input",
      "work:execution:after:steer",
    ]);
    expect(segments[0]!.inputMessages).toEqual([initial]);
    expect(segments[0]!.workMessages.map(({ message }) => message)).toEqual([
      early,
    ]);
    expect(segments[1]!.inputMessages).toEqual([steer]);
    expect(segments[1]!.workMessages.map(({ message }) => message)).toEqual([
      after,
    ]);
    expect(segments[1]!.finalResponse?.message).toBe(final);
    expect(segments.map((segment) => segment.activeDurationMs)).toEqual([
      40, 60,
    ]);
  });

  test("joins only a maximum adjacent canonical user batch and never treats tool answers as input", () => {
    const one = message("one", "user", [text("one-text", "One", 10)]);
    const two = message("two", "user", [text("two-text", "Two", 11)]);
    const answer = message("answer", "assistant", [
      text("answer-text", "Answer", 12),
    ]);
    const three = message("three", "user", [text("three-text", "Three", 13)]);
    const segments = buildExecutionWorkstream(
      input({ executions: [execution()], messages: [one, two, answer, three] }),
    ).executions[0]!.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.inputMessageIds).toEqual(["one", "two"]);
    expect(segments[1]!.inputMessageIds).toEqual(["three"]);
  });

  test("creates one stable implicit segment for leading work", () => {
    const work = message("work", "assistant", [text("work-text", "Work", 10)]);
    const segment = buildExecutionWorkstream(
      input({ executions: [execution()], messages: [work] }),
    ).executions[0]!.segments[0]!;
    expect(segment.id).toBe("work:execution:implicit");
    expect(segment.inputMessages).toEqual([]);
    expect(segment.workMessages).toEqual([]);
    expect(segment.outputMessages[0]!.message).toBe(work);
  });

  test("partitions active time across resumed runs and excludes suspension wall time", () => {
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
          usageDelta: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
          },
          settlement: { key: "one", goalInstanceId: null },
        },
        {
          ordinal: 1,
          startedAt: 90,
          endedAt: 100,
          durationMs: 10,
          binding,
          usageDelta: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
          },
          settlement: { key: "two", goalInstanceId: null },
        },
      ],
    });
    const first = message("first", "user", [text("first-text", "First", 0)]);
    const work = message("work", "assistant", [text("work-text", "Work", 30)]);
    const steer = message("steer", "user", [text("steer-text", "Steer", 90)]);
    const segments = buildExecutionWorkstream(
      input({ executions: [record], messages: [first, work, steer] }),
    ).executions[0]!.segments;
    expect(segments.map((segment) => segment.activeDurationMs)).toEqual([
      20, 10,
    ]);
  });

  test("stabilizes unchanged historical Segment projections", () => {
    const record = execution();
    const first = buildExecutionWorkstream(input({ executions: [record] }));
    const next = buildExecutionWorkstream(input({ executions: [record] }));
    expect(
      stabilizeExecutionWorkstreamProjection(first, next).executions[0],
    ).toBe(first.executions[0]);
  });

  test("does not reuse a Segment when same-window assistant text changes", () => {
    const record = execution();
    const firstMessage = message("assistant", "assistant", [
      text("assistant-text", "First output", 10),
    ]);
    const nextMessage = message("assistant", "assistant", [
      text("assistant-text", "Updated output", 10),
    ]);
    const first = buildExecutionWorkstream(
      input({ executions: [record], messages: [firstMessage] }),
    );
    const next = buildExecutionWorkstream(
      input({ executions: [record], messages: [nextMessage] }),
    );
    const stabilized = stabilizeExecutionWorkstreamProjection(first, next);

    expect(stabilized.executions[0]).toBe(next.executions[0]);
    expect(stabilized.executions[0]!.segments[0]!.outputMessages[0]!.message)
      .toBe(nextMessage);
  });

  test("preserves persisted Execution order when start timestamps tie", () => {
    const first = execution("z-first", { startedAt: 10, endedAt: 20 });
    const second = execution("a-second", { startedAt: 10, endedAt: 30 });

    const workstream = buildExecutionWorkstream(
      input({ executions: [first, second] }),
    );

    expect(workstream.executions.map(({ record }) => record.id)).toEqual([
      "z-first",
      "a-second",
    ]);
  });
});
