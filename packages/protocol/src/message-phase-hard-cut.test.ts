import { describe, expect, test } from "bun:test";
import { reduceStreamEvent, type ReduceContext } from "./reduce";
import { createEmptySessionStats } from "./usage";
import type { LoadedToolRef, SessionProjection, StreamEvent } from "./types";

const BINDING = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const MEMORY_POLICY = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
};
const TOOL_AUTHORIZATION_SNAPSHOT = { extraTools: [], toolProjection: null };
const LOADED_TOOL_REFS: LoadedToolRef[] = [];

function projection(): SessionProjection {
  return {
    sessionId: "session",
    cwd: "/workspace",
    rootSessionId: "session",
    title: null,
    messages: [],
    pendingMessages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    stats: createEmptySessionStats(),
    executions: [],
    executionCount: 0,
    isRunning: false,
    isStreamingModel: false,
    modelSelection: { revision: 0 },
  };
}

function apply(state: SessionProjection, events: StreamEvent[]): SessionProjection {
  let nextId = 0;
  const ctx: ReduceContext = {
    timestamp: 100,
    generateId: () => `generated-${nextId++}`,
  };
  return events.reduce(
    (current, event) => ({ ...current, ...reduceStreamEvent(current, event, ctx) }),
    state,
  );
}

function start(executionId = "execution"): StreamEvent {
  return {
    type: "execution-start",
    executionId,
    origin: "user_message",
    maxSteps: 10,
    binding: BINDING,
    executionSkills: [],
    memoryPolicy: MEMORY_POLICY,
    toolAuthorizationSnapshot: TOOL_AUTHORIZATION_SNAPSHOT,
    loadedToolRefs: LOADED_TOOL_REFS,
  };
}

function end(finalOutputStepId?: string): StreamEvent {
  return {
    type: "execution-end",
    executionId: "execution",
    terminalStatus: "completed",
    ...(finalOutputStepId === undefined ? {} : { finalOutputStepId }),
    endedAt: 100,
    runEndedAt: 100,
    runUsageDelta: createEmptySessionStats().usage,
    runSettlement: { key: "run:session:execution:0", goalInstanceId: null },
    terminalSettlement: { key: "terminal:session:execution", goalInstanceId: null },
  };
}

describe("model attempt and Assistant phase hard cut", () => {
  test("same numeric cursor retries remain distinct attempts and only the selected stop is final", () => {
    const state = apply(projection(), [
      start(),
      { type: "step-start", stepId: "attempt-a", step: 0 },
      { type: "text-start", stepId: "attempt-a", blockId: "output" },
      { type: "text-delta", stepId: "attempt-a", blockId: "output", text: "partial" },
      { type: "step-end", stepId: "attempt-a", step: 0, finishReason: "interrupted" },
      { type: "step-start", stepId: "attempt-b", step: 0 },
      { type: "text-start", stepId: "attempt-b", blockId: "output" },
      { type: "text-delta", stepId: "attempt-b", blockId: "output", text: "done" },
      { type: "text-end", stepId: "attempt-b", blockId: "output" },
      {
        type: "step-end",
        stepId: "attempt-b",
        step: 0,
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 },
      },
      end("attempt-b"),
    ]);

    expect(state.steps.map((step) => step.id)).toEqual(["attempt-a", "attempt-b"]);
    expect(state.steps[1]?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      reasoningTokens: 1,
      cachedInputTokens: 0,
    });
    expect(state.messages).toHaveLength(2);
    const interrupted = state.messages[0];
    expect(interrupted?.role).toBe("assistant");
    if (interrupted?.role !== "assistant") throw new Error("Expected Assistant attempt");
    expect(interrupted.outputPhase).toBe("commentary");
    const partial = interrupted.parts[0];
    if (partial?.type !== "assistant-output") throw new Error("Expected Assistant output");
    expect(partial.meta).toMatchObject({
      interrupted: true,
      discardedFromContext: true,
    });
    expect(state.messages[1]?.outputPhase).toBe("final_answer");
    expect(state.executions[0]?.finalOutputStepId).toBe("attempt-b");
  });

  test("provider blocks preserve exact interleaving and reject unknown composite addresses", () => {
    const beforeInvalid = apply(projection(), [
      start(),
      { type: "step-start", stepId: "attempt", step: 0 },
      { type: "reasoning-start", stepId: "attempt", blockId: "reasoning-a" },
      { type: "reasoning-delta", stepId: "attempt", blockId: "reasoning-a", text: "A" },
      { type: "reasoning-end", stepId: "attempt", blockId: "reasoning-a" },
      { type: "text-start", stepId: "attempt", blockId: "output-a" },
      { type: "text-delta", stepId: "attempt", blockId: "output-a", text: "C" },
      { type: "text-end", stepId: "attempt", blockId: "output-a" },
      { type: "reasoning-start", stepId: "attempt", blockId: "reasoning-b" },
      { type: "reasoning-delta", stepId: "attempt", blockId: "reasoning-b", text: "B" },
      { type: "reasoning-end", stepId: "attempt", blockId: "reasoning-b" },
    ]);
    const afterInvalid = apply(beforeInvalid, [
      { type: "text-delta", stepId: "attempt", blockId: "missing", text: "must-not-append" },
    ]);

    expect(beforeInvalid.messages[0]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "assistant-output",
      "reasoning",
    ]);
    expect(afterInvalid.messages).toEqual(beforeInvalid.messages);
  });

  test("invalid final selection rejects the whole terminal event", () => {
    const running = apply(projection(), [
      start(),
      { type: "step-start", stepId: "tool-attempt", step: 0 },
      { type: "text-start", stepId: "tool-attempt", blockId: "output" },
      { type: "text-delta", stepId: "tool-attempt", blockId: "output", text: "not final" },
      { type: "text-end", stepId: "tool-attempt", blockId: "output" },
      { type: "step-end", stepId: "tool-attempt", step: 0, finishReason: "tool-calls" },
    ]);
    const rejected = apply(running, [end("tool-attempt")]);

    expect(rejected.executions[0]?.status).toBe("running");
    expect(rejected.isRunning).toBe(true);
    expect(rejected.messages[0]?.outputPhase).toBe("commentary");
  });

  test("final selection rejects a completed stop when a later attempt is still open", () => {
    const running = apply(projection(), [
      start(),
      { type: "step-start", stepId: "attempt-a", step: 0 },
      { type: "text-start", stepId: "attempt-a", blockId: "output" },
      { type: "text-delta", stepId: "attempt-a", blockId: "output", text: "not final yet" },
      { type: "text-end", stepId: "attempt-a", blockId: "output" },
      { type: "step-end", stepId: "attempt-a", step: 0, finishReason: "stop" },
      { type: "step-start", stepId: "attempt-b", step: 1 },
      { type: "text-start", stepId: "attempt-b", blockId: "output" },
      { type: "text-delta", stepId: "attempt-b", blockId: "output", text: "still streaming" },
    ]);
    const rejected = apply(running, [end("attempt-a")]);

    expect(rejected.executions[0]?.status).toBe("running");
    expect(rejected.steps[1]?.completedAt).toBeUndefined();
    expect(rejected.messages[0]?.outputPhase).toBe("commentary");
    expect(rejected.messages[1]?.parts[0]).toMatchObject({
      type: "assistant-output",
      text: "still streaming",
    });
    expect(rejected.messages[1]?.parts[0]).not.toHaveProperty("completedAt");
  });

  test("late stream events cannot mutate an ended attempt or terminal Execution", () => {
    const endedStep = apply(projection(), [
      start(),
      { type: "step-start", stepId: "attempt", step: 0 },
      { type: "reasoning-start", stepId: "attempt", blockId: "reasoning" },
      { type: "reasoning-delta", stepId: "attempt", blockId: "reasoning", text: "before end" },
      { type: "step-end", stepId: "attempt", step: 0, finishReason: "interrupted" },
    ]);
    const afterLateBlockEvents = apply(endedStep, [
      { type: "reasoning-delta", stepId: "attempt", blockId: "reasoning", text: "late" },
      { type: "reasoning-end", stepId: "attempt", blockId: "reasoning" },
      { type: "text-start", stepId: "attempt", blockId: "late-output" },
    ]);
    expect(afterLateBlockEvents.messages).toEqual(endedStep.messages);

    const terminal = apply(projection(), [
      start(),
      { type: "step-start", stepId: "final", step: 0 },
      { type: "text-start", stepId: "final", blockId: "output" },
      { type: "text-delta", stepId: "final", blockId: "output", text: "done" },
      { type: "text-end", stepId: "final", blockId: "output" },
      { type: "step-end", stepId: "final", step: 0, finishReason: "stop" },
      end("final"),
    ]);
    const afterTerminalLateStart = apply(terminal, [
      { type: "text-start", stepId: "final", blockId: "late" },
    ]);
    expect(afterTerminalLateStart.messages).toEqual(terminal.messages);
  });

  test("a selected stop attempt cannot own any interrupted or discarded output block", () => {
    const running = apply(projection(), [
      start(),
      { type: "step-start", stepId: "attempt", step: 0 },
      { type: "text-start", stepId: "attempt", blockId: "trusted" },
      { type: "text-delta", stepId: "attempt", blockId: "trusted", text: "trusted" },
      { type: "text-end", stepId: "attempt", blockId: "trusted" },
      { type: "text-start", stepId: "attempt", blockId: "discarded" },
      { type: "text-delta", stepId: "attempt", blockId: "discarded", text: "discarded" },
      { type: "text-end", stepId: "attempt", blockId: "discarded" },
      { type: "step-end", stepId: "attempt", step: 0, finishReason: "stop" },
    ]);
    const tainted: SessionProjection = {
      ...running,
      messages: running.messages.map((message) => message.role !== "assistant"
        ? message
        : {
            ...message,
            parts: message.parts.map((part) => (
              part.type === "assistant-output" && part.blockId === "discarded"
                ? {
                    ...part,
                    meta: { interrupted: true, discardedFromContext: true },
                  }
                : part
            )),
          }),
    };

    const rejected = apply(tainted, [end("attempt")]);

    expect(rejected.executions[0]?.status).toBe("running");
    expect(rejected.messages[0]?.outputPhase).toBe("commentary");
  });

  test("zero-visible-output attempt persists an anchor without counting an Assistant message", () => {
    const state = apply(projection(), [
      start(),
      { type: "step-start", stepId: "empty", step: 0 },
      { type: "step-end", stepId: "empty", step: 0, finishReason: "stop" },
      end(),
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts).toEqual([]);
    expect(state.stats.messages.assistant).toBe(0);
    expect(state.executions[0]?.status).toBe("completed");
  });
});
