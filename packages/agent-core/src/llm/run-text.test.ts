import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setLlmAdapterForTest } from "./adapter";
import { runLlmText } from "./run-text";
import { LlmMaxRetriesError } from "./errors";
import type { LlmTextInput } from "./types";

const mockGenerateText = mock(async (input: Record<string, unknown>) => {
  void input;
  return { text: "ok", toolCalls: [] };
});
const dummyModel = {} as LlmTextInput["model"];

function generateTextCalls(): Array<[Record<string, unknown>]> {
  return mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>;
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockGenerateText.mockImplementation(async (input: Record<string, unknown>) => {
    void input;
    return { text: "ok", toolCalls: [] };
  });
  setLlmAdapterForTest({ generateText: mockGenerateText as never });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

describe("runLlmText", () => {
  test("calls generateText with maxRetries 0 and returns exact text contract", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "hello", toolCalls: [] });
    const result = await runLlmText({ model: dummyModel, prompt: "Say hi" });

    expect(result).toEqual({ text: "hello" });
    expect(generateTextCalls()[0]![0]).toMatchObject({ prompt: "Say hi", maxRetries: 0 });
  });

  test("retries retryable failures for 3 total attempts", async () => {
    mockGenerateText
      .mockImplementationOnce(async () => { throw Object.assign(new Error("rate limit"), { status: 429 }); })
      .mockImplementationOnce(async () => { throw Object.assign(new Error("rate limit"), { status: 429 }); })
      .mockImplementationOnce(async () => ({ text: "recovered", toolCalls: [] }));

    const result = await runLlmText({ model: dummyModel, prompt: "x" });
    expect(result).toEqual({ text: "recovered" });
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });

  test("throws LlmMaxRetriesError on retry exhaustion", async () => {
    mockGenerateText.mockImplementation(async () => { throw Object.assign(new Error("server down"), { status: 500 }); });

    try {
      await runLlmText({ model: dummyModel, prompt: "x" });
      expect.unreachable("expected retry exhaustion");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmMaxRetriesError);
      expect((err as LlmMaxRetriesError).attempts).toBe(3);
      expect(mockGenerateText).toHaveBeenCalledTimes(3);
    }
  });

  test("retries unknown provider failures by default", async () => {
    mockGenerateText
      .mockImplementationOnce(async () => { throw new Error("undocumented provider failure"); })
      .mockImplementationOnce(async () => ({ text: "recovered", toolCalls: [] }));

    const result = await runLlmText({ model: dummyModel, prompt: "x" });

    expect(result).toEqual({ text: "recovered" });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  test("does not retry explicit non-retryable provider failures", async () => {
    mockGenerateText.mockImplementation(async () => { throw Object.assign(new Error("Unauthorized"), { status: 401 }); });

    try {
      await runLlmText({ model: dummyModel, prompt: "x" });
      expect.unreachable("expected auth failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmMaxRetriesError);
      expect((err as LlmMaxRetriesError).attempts).toBe(1);
      expect((err as LlmMaxRetriesError).retryable).toBe(false);
    }

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
