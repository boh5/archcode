import { afterEach, describe, expect, test } from "bun:test";
import type { PendingSessionMessage, SessionMessage } from "@archcode/protocol";
import { createSessionStore, storeManager } from "./store";
import { testExecutionMemoryPolicy } from "../testing/test-execution-fixtures";

const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};

afterEach(() => {
  storeManager.clearAll();
});

function acceptedMessage(id: string): PendingSessionMessage {
  return {
    id,
    clientRequestId: `${id}:request`,
    content: "Remember concise conclusions.",
    attachments: [],
    source: "user",
    state: "queued",
    revision: 0,
    acceptedAt: 100,
    updatedAt: 100,
    requestedModelSelection: {
      mode: "profile_default",
      selection: { model: "test:model" },
    },
  };
}

function appendSuccessfulRootExecution(
  agentName: "lead" | "discussion",
  beforeEnd?: (store: ReturnType<typeof createSessionStore>) => void,
): ReturnType<typeof createSessionStore> {
  const sessionId = `memory-learning-${agentName}-${crypto.randomUUID()}`;
  const store = storeManager.create(sessionId, "/tmp/archcode-memory-learning-tests", {
    agentName,
    source: agentName === "discussion"
      ? { kind: "todo", todoId: "todo-1", entry: "discussion" }
      : { kind: "direct" },
  });
  const pending = acceptedMessage(`${sessionId}:user`);
  store.getState().append({ type: "session.message_accepted", message: pending });
  store.getState().append({
    type: "execution-start",
    executionId: `${sessionId}:execution`,
    binding,
    memoryPolicy: testExecutionMemoryPolicy,
    origin: "user_message",
    maxSteps: 50,
  });
  const executionId = `${sessionId}:execution`;
  const user: SessionMessage = {
    id: pending.id,
    role: "user",
    executionId,
    clientRequestId: pending.clientRequestId,
    parts: [{ type: "text", id: `${pending.id}:text`, text: pending.content, createdAt: 101, completedAt: 101 }],
    createdAt: 101,
    completedAt: 101,
  };
  store.getState().append({ type: "session.messages_committed", executionId, messages: [user] });
  store.getState().append({ type: "step-start", stepId: `${sessionId}:step`, step: 0 });
  store.getState().append({ type: "text-start", stepId: `${sessionId}:step`, blockId: "output" });
  store.getState().append({ type: "text-delta", stepId: `${sessionId}:step`, blockId: "output", text: "Done." });
  store.getState().append({ type: "text-end", stepId: `${sessionId}:step`, blockId: "output" });
  store.getState().append({ type: "step-end", stepId: `${sessionId}:step`, step: 0, finishReason: "stop" });

  const execution = store.getState().executions.find((candidate) => candidate.id === executionId);
  if (execution === undefined || execution.status !== "running") throw new Error("Expected a running execution");
  const run = execution.runs.at(-1);
  if (run === undefined) throw new Error("Expected an open run");
  const endedAt = run.startedAt + 10;
  beforeEnd?.(store);
  store.getState().append({
    type: "execution-end",
    executionId,
    terminalStatus: "completed",
    finalOutputStepId: `${sessionId}:step`,
    endedAt,
    runEndedAt: endedAt,
    runUsageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    runSettlement: { key: `run:${sessionId}:${executionId}:0`, goalInstanceId: null },
    terminalSettlement: { key: `terminal:${sessionId}:${executionId}`, goalInstanceId: null },
  });
  return store;
}

describe("Memory learning cursor lifecycle", () => {
  test.each(["lead", "discussion"] as const)("marks a successful root %s execution eligible", (agentName) => {
    const store = appendSuccessfulRootExecution(agentName);
    const state = store.getState();
    expect(state.memoryLearning?.processedThroughMessageId).toBeNull();
    expect(state.memoryLearning?.eligibleThroughMessageId).toBe(
      state.messages.find((message) => message.role === "assistant" && message.outputPhase === "final_answer")?.id,
    );
    expect(state.memoryLearning?.idleSince).toBeTypeOf("number");
  });

  test("does not mark failed root executions eligible", () => {
    const sessionId = `memory-learning-failed-${crypto.randomUUID()}`;
    const store = storeManager.create(sessionId, "/tmp/archcode-memory-learning-tests", {
      agentName: "lead",
      source: { kind: "direct" },
    });
    const pending = acceptedMessage(`${sessionId}:user`);
    store.getState().append({ type: "session.message_accepted", message: pending });
    const executionId = `${sessionId}:execution`;
    store.getState().append({
      type: "execution-start",
      executionId,
      binding,
      memoryPolicy: testExecutionMemoryPolicy,
      origin: "user_message",
      maxSteps: 50,
    });
    const execution = store.getState().executions.find((candidate) => candidate.id === executionId);
    if (execution === undefined || execution.status !== "running") throw new Error("Expected a running execution");
    const run = execution.runs.at(-1)!;
    const endedAt = run.startedAt + 10;
    store.getState().append({
      type: "execution-end",
      executionId,
      terminalStatus: "failed",
      endedAt,
      runEndedAt: endedAt,
      runUsageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      runSettlement: { key: `run:${sessionId}:${executionId}:0`, goalInstanceId: null },
      terminalSettlement: { key: `terminal:${sessionId}:${executionId}`, goalInstanceId: null },
      error: "failed",
    });
    expect(store.getState().memoryLearning?.eligibleThroughMessageId).toBeUndefined();
    expect(store.getState().memoryLearning?.idleSince).toBeUndefined();
  });

  test("does not start the idle clock when newer user input is already queued", () => {
    let queuedId = "";
    const store = appendSuccessfulRootExecution("lead", (current) => {
      queuedId = `${current.getState().sessionId}:queued-user`;
      current.getState().append({
        type: "session.message_accepted",
        message: acceptedMessage(queuedId),
      });
    });

    expect(store.getState().pendingMessages.some((message) => message.id === queuedId)).toBe(true);
    expect(store.getState().memoryLearning?.eligibleThroughMessageId).toBeDefined();
    expect(store.getState().memoryLearning?.idleSince).toBeUndefined();
  });

  test("automation roots do not create a learning cursor", () => {
    const sessionId = `memory-learning-automation-${crypto.randomUUID()}`;
    const store = storeManager.create(sessionId, "/tmp/archcode-memory-learning-tests", {
      agentName: "lead",
      source: {
        kind: "automation",
        automationId: "automation-1",
        invocationId: "invocation-1",
        todoId: null,
      },
    });
    store.getState().append({ type: "session.message_accepted", message: acceptedMessage(`${sessionId}:user`) });
    expect(store.getState().memoryLearning).toBeUndefined();
  });
});
