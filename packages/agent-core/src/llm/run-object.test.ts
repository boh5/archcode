import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { setLlmAdapterForTest } from "./adapter";
import { runLlmObject } from "./run-object";
import { LlmObjectError, LlmSchemaValidationError } from "./errors";
import type { LlmObjectInput } from "./types";

const mockGenerateText = mock(async (input: Record<string, unknown>) => {
  void input;
  return { text: "", toolCalls: [{ toolName: "result", input: { name: "Alice" } as unknown }] };
});
const dummyModel = {} as LlmObjectInput<unknown>["model"];

function generateTextCalls(): Array<[Record<string, unknown>]> {
  return mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>;
}

beforeEach(() => {
  mockGenerateText.mockClear();
  setLlmAdapterForTest({ generateText: mockGenerateText as never });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

function makeInput<T>(overrides: Partial<LlmObjectInput<T>> & { schema: LlmObjectInput<T>["schema"] }): LlmObjectInput<T> {
  return { model: dummyModel, prompt: "test prompt", ...overrides };
}

describe("runLlmObject", () => {
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

  test("return type matches schema inference", async () => {
    const schema = z.strictObject({ memories: z.array(z.string()) });
    mockGenerateText.mockImplementationOnce(async () => ({ text: "", toolCalls: [{ toolName: "result", input: { memories: ["hello"] } as unknown }] }) as never);

    const result: z.infer<typeof schema> = await runLlmObject(makeInput({ schema }));
    expect(result.memories).toEqual(["hello"]);
  });
});
