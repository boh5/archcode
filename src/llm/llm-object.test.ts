import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { generateText as aiGenerateText } from "ai";
import { z } from "zod/v4";
import { llmObject, __setGenerateTextForTest } from "./llm-object";
import { LlmObjectError, LlmSchemaValidationError } from "./errors";
import type { LlmObjectInput } from "./types";

// ─── Mock setup ───

const mockGenerateText = mock(async () => ({
  text: "",
  toolCalls: [
    {
      type: "tool-call" as const,
      toolCallId: "call_1",
      toolName: "result",
      input: { name: "Alice" },
    },
  ],
}));

beforeEach(() => {
  mockGenerateText.mockClear();
  __setGenerateTextForTest(
    mockGenerateText as unknown as typeof aiGenerateText,
  );
});

afterEach(() => {
  __setGenerateTextForTest(aiGenerateText);
});

// ─── Helpers ───

const dummyModel = {} as LlmObjectInput<unknown>["model"];

function makeInput<T>(
  overrides: Partial<LlmObjectInput<T>> & { schema: LlmObjectInput<T>["schema"] },
): LlmObjectInput<T> {
  return {
    model: dummyModel,
    prompt: "test prompt",
    ...overrides,
  };
}

function getCallArg(index: number): Record<string, unknown> {
  const calls = mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[index]![0];
}

// ─── Tests ───

describe("llmObject", () => {
  // 1. Happy path
  test("returns parsed object when model calls result with valid input", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: { name: "Alice" },
        },
      ],
    });

    const result = await llmObject(makeInput({ schema }));
    expect(result).toEqual({ name: "Alice" });
  });

  // 2. With system prompt
  test("passes system prompt through to generateText", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: { name: "Bob" },
        },
      ],
    });

    await llmObject(makeInput({ schema, system: "You are a helper" }));

    expect(getCallArg(0).system).toBe("You are a helper");
  });

  // 3. Schema validation failure
  test("throws LlmSchemaValidationError when tool input fails Zod parse", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: { name: 123 } as unknown as { name: string },
        },
      ],
    });

    await expect(llmObject(makeInput({ schema }))).rejects.toThrow(
      LlmSchemaValidationError,
    );
  });

  // 4. Tool not called
  test("throws LlmObjectError when model does not call result", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [] as unknown as Array<{ type: "tool-call"; toolCallId: string; toolName: string; input: { name: string } }>,
    });

    await expect(llmObject(makeInput({ schema }))).rejects.toThrow(
      LlmObjectError,
    );
  });

  // 5. Tool call input not object
  test("throws LlmObjectError when tool call input is not an object", async () => {
    const schema = z.strictObject({ name: z.string() });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: "not an object" as unknown as { name: string },
        },
      ],
    });

    await expect(llmObject(makeInput({ schema }))).rejects.toThrow(
      LlmObjectError,
    );
  });

  // 6. AI_TypeValidationError mapping
  test("catches AI_TypeValidationError from generateText and re-throws as LlmSchemaValidationError", async () => {
    const schema = z.strictObject({ name: z.string() });
    const aiError = new Error("Type validation failed");
    aiError.name = "AI_TypeValidationError";
    mockGenerateText.mockRejectedValueOnce(aiError);

    try {
      await llmObject(makeInput({ schema }));
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmSchemaValidationError);
      expect((err as LlmSchemaValidationError).cause).toBe(aiError);
    }
  });

  // 7. AbortSignal
  test("passes abortSignal through to generateText", async () => {
    const schema = z.strictObject({ name: z.string() });
    const controller = new AbortController();
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: { name: "Eve" },
        },
      ],
    });

    await llmObject(makeInput({ schema, abortSignal: controller.signal }));

    expect(getCallArg(0).abortSignal).toBe(controller.signal);
  });

  // 8. Type inference (compile-time check)
  test("return type matches schema inference", async () => {
    const schema = z.strictObject({ memories: z.array(z.string()) });
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call_1",
          toolName: "result",
          input: { memories: ["hello"] } as unknown as { name: string },
        },
      ],
    });

    // This assertion verifies the type at compile time:
    // llmObject<T> must return Promise<T> where T = z.infer<typeof schema>
    const result: z.infer<typeof schema> = await llmObject(
      makeInput({ schema }),
    );
    expect(result.memories).toEqual(["hello"]);
  });
});
