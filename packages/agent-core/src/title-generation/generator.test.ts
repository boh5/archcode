import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setLlmAdapterForTest } from "../llm";
import type { ModelInfo } from "../provider/model";
import type { ExecutionModelBinding } from "../models";
import { createFakeRetryScheduler } from "../testing/fake-retry-scheduler";
import { createTestModelInfo } from "../testing/test-execution-fixtures";
import { generateTitle } from "./generator";

const generateText = mock(async () => ({ text: "  Retry propagation  ", toolCalls: [] }));

const modelInfo: ModelInfo = createTestModelInfo();
const binding: ExecutionModelBinding = {
  modelInfo,
  options: undefined,
  summary: {
    selection: { model: modelInfo.qualifiedId },
    providerId: modelInfo.providerId,
    modelId: modelInfo.modelId,
    providerDisplayName: modelInfo.providerDisplayName,
    modelDisplayName: modelInfo.displayName,
    resolution: "profile_default",
    modelRuntimeRevision: "test-revision",
  },
};

beforeEach(() => {
  generateText.mockReset();
  generateText.mockImplementation(async () => ({ text: "  Retry propagation  ", toolCalls: [] }));
  setLlmAdapterForTest({ generateText: generateText as never });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

describe("generateTitle", () => {
  test("normalizes the generated title", async () => {
    const title = await generateTitle({
      kind: "session",
      text: "propagate a retry scheduler",
      binding,
      retryScheduler: createFakeRetryScheduler(),
    });

    expect(title).toBe("Retry propagation");
  });

  test("passes the caller retry scheduler to managed text generation", async () => {
    generateText
      .mockImplementationOnce(async () => { throw new Error("temporary provider failure"); })
      .mockImplementationOnce(async () => ({ text: "Recovered title", toolCalls: [] }));
    const retryScheduler = createFakeRetryScheduler();

    const title = await generateTitle({
      kind: "goal",
      text: "finish deterministic retries",
      binding,
      retryScheduler,
    });

    expect(title).toBe("Recovered title");
    expect(retryScheduler.sleeps).toHaveLength(1);
  });
});
