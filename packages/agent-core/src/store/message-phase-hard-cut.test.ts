import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@archcode/protocol";
import { silentLogger } from "../logger";
import { InvalidExecutionTransitionError } from "./types";
import { SessionStoreManager } from "./session-store-manager";

const ROOT = join("/tmp", "archcode-message-phase-hard-cut", crypto.randomUUID());
const manager = new SessionStoreManager({ logger: silentLogger });
const BINDING = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};

beforeEach(async () => {
  manager.clearAll();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  manager.clearAll();
  await rm(ROOT, { recursive: true, force: true });
});

function terminalEvent(sessionId: string, finalOutputStepId: string) {
  const state = manager.get(sessionId, ROOT)!.getState();
  const execution = state.executions[0]!;
  const run = execution.runs[0]!;
  const endedAt = Math.max(Date.now(), run.startedAt);
  return {
    type: "execution-end" as const,
    executionId: execution.id,
    terminalStatus: "completed" as const,
    finalOutputStepId,
    endedAt,
    runEndedAt: endedAt,
    runUsageDelta: createEmptySessionStats().usage,
    runSettlement: {
      key: `run:${sessionId}:${execution.id}:0`,
      goalInstanceId: null,
    },
    terminalSettlement: {
      key: `terminal:${sessionId}:${execution.id}`,
      goalInstanceId: null,
    },
  };
}

function createAttempt(
  sessionId: string,
  stepId: string,
  cursor: number,
  finishReason: string,
  text: string,
) {
  const store = manager.get(sessionId, ROOT)!;
  store.getState().append({ type: "step-start", stepId, step: cursor });
  store.getState().append({ type: "text-start", stepId, blockId: "output" });
  if (text.length > 0) {
    store.getState().append({ type: "text-delta", stepId, blockId: "output", text });
  }
  store.getState().append({ type: "text-end", stepId, blockId: "output" });
  store.getState().append({ type: "step-end", stepId, step: cursor, finishReason });
}

describe("runtime final Assistant selection", () => {
  test("invalid cross-aggregate selections throw before any state mutation", () => {
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, ROOT, { agentName: "lead" });
    store.getState().append({
      type: "execution-start",
      executionId: "execution",
      origin: "user_message",
      maxSteps: 10,
      binding: BINDING,
    });
    createAttempt(sessionId, "earlier-stop", 0, "stop", "earlier");
    createAttempt(sessionId, "latest-tool", 1, "tool-calls", "tool preamble");

    const before = {
      executions: store.getState().executions,
      messages: store.getState().messages,
      currentExecutionId: store.getState().currentExecutionId,
      isRunning: store.getState().isRunning,
    };
    for (const invalidStepId of ["other-execution-step", "earlier-stop", "latest-tool"]) {
      expect(() => store.getState().append(terminalEvent(sessionId, invalidStepId)))
        .toThrow(InvalidExecutionTransitionError);
      expect({
        executions: store.getState().executions,
        messages: store.getState().messages,
        currentExecutionId: store.getState().currentExecutionId,
        isRunning: store.getState().isRunning,
      }).toEqual(before);
    }
  });

  test("empty and interrupted output cannot be selected", () => {
    for (const candidate of [
      { stepId: "empty", finishReason: "stop", text: "" },
      { stepId: "interrupted", finishReason: "interrupted", text: "partial" },
    ]) {
      const sessionId = crypto.randomUUID();
      const store = manager.create(sessionId, ROOT, { agentName: "lead" });
      store.getState().append({
        type: "execution-start",
        executionId: `execution-${candidate.stepId}`,
        origin: "user_message",
        maxSteps: 10,
        binding: BINDING,
      });
      createAttempt(sessionId, candidate.stepId, 0, candidate.finishReason, candidate.text);
      expect(() => store.getState().append(terminalEvent(sessionId, candidate.stepId)))
        .toThrow(InvalidExecutionTransitionError);
      expect(store.getState().isRunning).toBe(true);
      expect(store.getState().messages[0]?.outputPhase).toBe("commentary");
    }
  });
});
