import type {
  ExecutionModelBindingSummary,
  ExecutionEndEvent,
  ExecutionStartEvent,
  ExecutionSuspendedEvent,
  NormalizedUsage,
  RequestedModelSelection,
  SessionExecutionOrigin,
  SessionExecutionRecord,
  SessionExecutionSuspension,
  SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import { ModelInfo } from "../provider/model";

export function createTestModelInfo(overrides: {
  providerId?: string;
  providerDisplayName?: string;
  modelId?: string;
  displayName?: string;
  model?: ModelInfo["model"];
  providerSecretValues?: readonly string[];
  limit?: ModelInfo["limit"];
} = {}): ModelInfo {
  return new ModelInfo({
    model: overrides.model ?? ({ provider: "test" } as never),
    config: {
      name: overrides.displayName ?? "Test Model",
      limit: overrides.limit ?? { context: 4096, output: 1024 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: overrides.providerId ?? "test",
    providerDisplayName: overrides.providerDisplayName ?? "Test Provider",
    modelId: overrides.modelId ?? "test-model",
    providerSecretValues: overrides.providerSecretValues,
  });
}

export const testRequestedModelSelection: RequestedModelSelection = {
  mode: "profile_default",
  selection: { model: "test-provider:test-model" },
};

export const testExecutionBinding: ExecutionModelBindingSummary = {
  selection: { model: "test-provider:test-model" },
  providerId: "test-provider",
  modelId: "test-model",
  providerDisplayName: "Test Provider",
  modelDisplayName: "Test Model",
  resolution: "profile_default",
  modelRuntimeRevision: "test-model-runtime-revision",
};

export const testExecutionUsage: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

export const testExecutionMemoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
} as const;

export function testExecutionStart(
  executionId: string,
  origin: SessionExecutionOrigin = "tool_call",
): ExecutionStartEvent {
  return {
    type: "execution-start",
    executionId,
    binding: testExecutionBinding,
    memoryPolicy: testExecutionMemoryPolicy,
    origin,
    maxSteps: 50,
    executionSkills: [],
  };
}

export function testExecutionEnd(
  executionId: string,
  terminalStatus: SessionExecutionTerminalStatus = "completed",
  overrides: Partial<Omit<ExecutionEndEvent, "type" | "executionId" | "terminalStatus">> = {},
): ExecutionEndEvent {
  const endedAt = overrides.endedAt ?? 1;
  return {
    type: "execution-end",
    executionId,
    terminalStatus,
    endedAt,
    runEndedAt: overrides.runEndedAt ?? endedAt,
    runUsageDelta: overrides.runUsageDelta ?? testExecutionUsage,
    runSettlement: overrides.runSettlement ?? { key: `run:test-session:${executionId}:0`, goalInstanceId: null },
    terminalSettlement: overrides.terminalSettlement ?? { key: `terminal:test-session:${executionId}`, goalInstanceId: null },
    ...(overrides.finalOutputStepId === undefined ? {} : { finalOutputStepId: overrides.finalOutputStepId }),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  };
}

export function testExecutionSuspended(
  executionId: string,
  suspension: SessionExecutionSuspension,
  overrides: Partial<Omit<ExecutionSuspendedEvent, "type" | "executionId" | "suspension">> = {},
): ExecutionSuspendedEvent {
  const runEndedAt = overrides.runEndedAt ?? 1;
  return {
    type: "execution-suspended",
    executionId,
    suspension,
    runEndedAt,
    runUsageDelta: overrides.runUsageDelta ?? testExecutionUsage,
    runSettlement: overrides.runSettlement ?? { key: `run:test-session:${executionId}:0`, goalInstanceId: null },
  };
}

export function testExecutionRecord(
  id: string,
  status: SessionExecutionRecord["status"] = "completed",
): SessionExecutionRecord {
  const run = {
    ordinal: 0,
    startedAt: 1,
    binding: testExecutionBinding,
  };
  const settlement = { key: `run:test-session:${id}:0`, goalInstanceId: null };

  if (status === "running") {
    return {
      id,
      memoryPolicy: testExecutionMemoryPolicy,
      startedAt: 1,
      status,
      origin: "tool_call",
      maxSteps: 50,
      executionSkills: [],
      durationMs: 0,
      runs: [run],
    };
  }
  if (status === "suspended") {
    return {
      id,
      memoryPolicy: testExecutionMemoryPolicy,
      startedAt: 1,
      status,
      origin: "tool_call",
      maxSteps: 50,
      executionSkills: [],
      durationMs: 0,
      runs: [{ ...run, endedAt: 1, durationMs: 0, usageDelta: testExecutionUsage, settlement }],
      suspension: { kind: "hitl", toolBatchId: `batch:${id}`, blockerIds: [`blocker:${id}`] },
    };
  }
  return {
    id,
    memoryPolicy: testExecutionMemoryPolicy,
    startedAt: 1,
    status,
    origin: "tool_call",
    maxSteps: 50,
    executionSkills: [],
    durationMs: 0,
    endedAt: 1,
    runs: [{ ...run, endedAt: 1, durationMs: 0, usageDelta: testExecutionUsage, settlement }],
    terminalSettlement: { key: `terminal:test-session:${id}`, goalInstanceId: null },
  };
}
