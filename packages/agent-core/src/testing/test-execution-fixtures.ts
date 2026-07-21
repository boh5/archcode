import type {
  ExecutionModelBindingSummary,
  ExecutionStartEvent,
  RequestedModelSelection,
  SessionExecutionOrigin,
  SessionExecutionRecord,
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

export function testExecutionStart(
  executionId: string,
  origin: SessionExecutionOrigin = "tool_call",
): ExecutionStartEvent {
  return { type: "execution-start", executionId, binding: testExecutionBinding, origin };
}

export function testExecutionRecord(
  id: string,
  status: SessionExecutionRecord["status"] = "completed",
): SessionExecutionRecord {
  return {
    id,
    startedAt: 1,
    status,
    ...(status === "running" ? {} : { endedAt: 1 }),
    binding: testExecutionBinding,
    origin: "tool_call",
  };
}
