import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setLlmAdapterForTest } from "./adapter";
import { runLlmStream } from "./run-stream";
import type { LlmStreamInput } from "./types";

const streamResult = { marker: "stream-result" };
const mockStreamText = mock((input: Record<string, unknown>) => {
  void input;
  return streamResult;
});
const dummyModel = {} as LlmStreamInput["model"];

function streamTextCalls(): Array<[Record<string, unknown>]> {
  return mockStreamText.mock.calls as unknown as Array<[Record<string, unknown>]>;
}

beforeEach(() => {
  mockStreamText.mockClear();
  setLlmAdapterForTest({ streamText: mockStreamText as never });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

describe("runLlmStream", () => {
  test("returns AI SDK stream result without consuming fullStream", () => {
    const result = runLlmStream({
      model: dummyModel,
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      modelOptions: { temperature: 0.2 },
    });

    expect(result).toBe(streamResult as never);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(streamTextCalls()[0]![0]).toMatchObject({
      model: dummyModel,
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      temperature: 0.2,
      maxRetries: 0,
    });
  });
});
