import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setLlmAdapterForTest } from "../llm";
import type { ModelInfo } from "../provider/model";
import { createFakeRetryScheduler } from "../testing/fake-retry-scheduler";
import { generateTitle } from "./generator";

const generateText = mock(async () => ({ text: "  Retry propagation  ", toolCalls: [] }));

const modelInfo: ModelInfo = {
  model: { provider: "test" } as never,
  displayName: "Test Model",
  limit: { context: 4096, output: 1024 },
  modalities: { input: ["text"], output: ["text"] },
          capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
  providerId: "test",
  modelId: "test-model",
  qualifiedId: "test:test-model",
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
      modelInfo,
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
      modelInfo,
      retryScheduler,
    });

    expect(title).toBe("Recovered title");
    expect(retryScheduler.sleeps).toHaveLength(1);
  });
});
