import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { setLlmAdapterForTest } from "./adapter";
import { runLlmObject } from "./run-object";
import { LlmMaxRetriesError, LlmObjectError, LlmSchemaValidationError } from "./errors";
import type { LlmObjectInput } from "./types";
import { createFakeRetryScheduler } from "../testing/fake-retry-scheduler";

const mockGenerateText = mock(async (input: Record<string, unknown>) => {
  void input;
  return { text: "", toolCalls: [{ toolName: "result", input: { name: "Alice" } as unknown }] };
});
const dummyModel = {} as LlmObjectInput<unknown>["model"];

function generateTextCalls(): Array<[Record<string, unknown>]> {
  return mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>;
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockGenerateText.mockImplementation(async (input: Record<string, unknown>) => {
    void input;
    return { text: "", toolCalls: [{ toolName: "result", input: { name: "Alice" } as unknown }] };
  });
  setLlmAdapterForTest({ generateText: mockGenerateText as never });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

function makeInput<T>(overrides: Partial<LlmObjectInput<T>> & { schema: LlmObjectInput<T>["schema"] }): LlmObjectInput<T> {
  return {
    model: dummyModel,
    prompt: "test prompt",
    retryScheduler: createFakeRetryScheduler(),
    redactSensitiveText: (text) => text,
    ...overrides,
  };
}

describe("runLlmObject", () => {
  test("redacts configured Provider values from structured keys and values", async () => {
    const schema = z.record(z.string(), z.string());
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolName: "result", input: { "configured-secret": "configured-secret" } }],
    } as never);

    const result = await runLlmObject(makeInput({
      schema,
      redactSensitiveText: (text) => text.replaceAll("configured-secret", "[redacted]"),
    }));

    expect(result).toEqual({ "[redacted]": "[redacted]" });
  });

  test("returns parsed object and uses forced tool call", async () => {
    const schema = z.strictObject({ name: z.string() });
    const result = await runLlmObject(makeInput({ schema, system: "You are a helper" }));

    expect(result).toEqual({ name: "Alice" });
    expect(generateTextCalls()[0]![0]).toMatchObject({
      system: "You are a helper",
      toolChoice: { type: "tool", toolName: "result" },
      maxRetries: 0,
    });
  });

  test("reports normalized usage to internal maintenance callers", async () => {
    const schema = z.strictObject({ name: z.string() });
    const seen: unknown[] = [];
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolName: "result", input: { name: "Alice" } }],
      usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 2 },
    } as never);

    await runLlmObject(makeInput({ schema, onUsage: (usage) => seen.push(usage) }));

    expect(seen).toEqual([{
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 3,
      cachedInputTokens: 2,
    }]);
  });

  test("repairs schema failures for 2 total object attempts", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText
      .mockImplementationOnce(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { name: 123 } as unknown }] }) as never)
      .mockImplementationOnce(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { name: "Fixed" } as unknown }] }) as never);

    const result = await runLlmObject(makeInput({ schema }));
    expect(result).toEqual({ name: "Fixed" });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect((generateTextCalls()[1]![0] as { prompt: string }).prompt).toContain("previous result did not match");
  });

  test("throws schema validation error after repair attempts are exhausted", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockImplementation(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { name: 123 } as unknown }] }) as never);

    try {
      await runLlmObject(makeInput({ schema }));
      expect.unreachable("expected schema validation failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmSchemaValidationError);
    }
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  test("throws object error when model does not call result tool", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockImplementationOnce(async () => ({ text: "", toolCalls: [] }) as never);

    try {
      await runLlmObject(makeInput({ schema }));
      expect.unreachable("expected missing tool call failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmObjectError);
    }
  });

  test("retries unknown provider failures before schema repair handling", async () => {
    const schema = z.strictObject({ name: z.string() });
    const retryScheduler = createFakeRetryScheduler();
    mockGenerateText
      .mockImplementationOnce(async () => { throw new Error("undocumented provider failure"); })
      .mockImplementationOnce(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { name: "Recovered" } as unknown }] }) as never);

    const result = await runLlmObject(makeInput({ schema, retryScheduler }));

    expect(result).toEqual({ name: "Recovered" });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(retryScheduler.sleeps).toHaveLength(1);
  });

  test("does not retry explicit non-retryable provider failures", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockImplementation(async () => { throw Object.assign(new Error("Unauthorized"), { status: 401 }); });

    try {
      await runLlmObject(makeInput({ schema }));
      expect.unreachable("expected auth failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmMaxRetriesError);
      expect((err as LlmMaxRetriesError).attempts).toBe(1);
      expect((err as LlmMaxRetriesError).retryable).toBe(false);
    }

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("return type matches schema inference", async () => {
    const schema = z.strictObject({ memories: z.array(z.string()) });
    mockGenerateText.mockImplementationOnce(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { memories: ["hello"] } as unknown }] }) as never);

    const result: z.infer<typeof schema> = await runLlmObject(makeInput({ schema }));
    expect(result.memories).toEqual(["hello"]);
  });
});
