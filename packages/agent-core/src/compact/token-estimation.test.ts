import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  COMPACT_MIN_NEW_MESSAGES,
  COMPACT_THRESHOLD,
  TOKEN_CHARS_RATIO,
  estimateContextTokens,
  parseStepUsage,
  shouldAutoCompact,
} from "./token-estimation";

// ---------------------------------------------------------------------------
// estimateContextTokens
// ---------------------------------------------------------------------------

describe("estimateContextTokens", () => {
  test("returns 0 for empty message array with no system prompt", () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  test("estimates tokens for a single user message using chars/4", () => {
    // "Hello world" = 11 chars → Math.ceil(11 / 4) = 3 tokens
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello world" },
    ];
    expect(estimateContextTokens(messages)).toBe(Math.ceil(11 / TOKEN_CHARS_RATIO));
  });

  test("estimates tokens for multiple messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },       // 5 chars
      { role: "assistant", content: "Hi there" }, // 8 chars
    ];
    // total chars = 13, tokens = Math.ceil(13 / 4) = 4
    const totalChars = 5 + 8;
    expect(estimateContextTokens(messages)).toBe(Math.ceil(totalChars / TOKEN_CHARS_RATIO));
  });

  test("handles content as array of parts (extracts text from text parts)", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },       // 5 chars
          { type: "text", text: " world" },      // 6 chars
        ],
      } as ModelMessage,
    ];
    // total chars = 11, tokens = Math.ceil(11 / 4) = 3
    expect(estimateContextTokens(messages)).toBe(Math.ceil(11 / TOKEN_CHARS_RATIO));
  });

  test("skips non-text content parts in array", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },       // 5 chars
          { type: "image", image: "base64data" }, // not counted
        ],
      } as ModelMessage,
    ];
    expect(estimateContextTokens(messages)).toBe(Math.ceil(5 / TOKEN_CHARS_RATIO));
  });

  test("includes systemPrompt text in estimation", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hi" }, // 2 chars
    ];
    const systemPrompt = "You are a helpful assistant."; // 28 chars
    // total = 30 chars, tokens = Math.ceil(30 / 4) = 8
    const totalChars = 2 + 28;
    expect(estimateContextTokens(messages, systemPrompt)).toBe(
      Math.ceil(totalChars / TOKEN_CHARS_RATIO),
    );
  });

  test("systemPrompt with Memory section is counted", () => {
    const messages: ModelMessage[] = [];
    const memorySection = "## Memory\n- User prefers dark mode\n- Project uses Bun runtime";
    // Just verify it's non-zero and includes the memory text length
    const result = estimateContextTokens(messages, memorySection);
    expect(result).toBe(Math.ceil(memorySection.length / TOKEN_CHARS_RATIO));
  });

  test("systemPrompt alone with no messages", () => {
    const systemPrompt = "System instructions here"; // 24 chars
    expect(estimateContextTokens([], systemPrompt)).toBe(
      Math.ceil(24 / TOKEN_CHARS_RATIO),
    );
  });

  test("handles empty string content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "" },
    ];
    expect(estimateContextTokens(messages)).toBe(0);
  });

  test("handles tool-result messages with content array (no text parts)", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Run the tool" }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{ type: "tool-result", output: { type: "text", value: "result" } }],
      } as unknown as ModelMessage,
    ];
    expect(estimateContextTokens(messages)).toBe(Math.ceil(12 / TOKEN_CHARS_RATIO));
  });
});

// ---------------------------------------------------------------------------
// parseStepUsage
// ---------------------------------------------------------------------------

describe("parseStepUsage", () => {
  test("returns null for null", () => {
    expect(parseStepUsage(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(parseStepUsage(undefined)).toBeNull();
  });

  test("returns null when shared normalization yields zero usage", () => {
    expect(parseStepUsage({})).toBeNull();
  });

  test("parses OpenAI format: prompt_tokens, completion_tokens, total_tokens", () => {
    const result = parseStepUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
    });
    expect(result).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
    });
  });

  test("parses Anthropic format: input_tokens, output_tokens", () => {
    const result = parseStepUsage({
      input_tokens: 500,
      output_tokens: 100,
    });
    expect(result).toEqual({
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
    });
  });

  test("parses Google format: total_token_count, prompt_token_count, candidates_token_count", () => {
    const result = parseStepUsage({
      total_token_count: 3000,
      prompt_token_count: 2500,
      candidates_token_count: 500,
    });
    expect(result).toEqual({
      promptTokens: 2500,
      completionTokens: 500,
      totalTokens: 3000,
    });
  });

  test("parses AI SDK standard format through shared normalization", () => {
    const result = parseStepUsage({
      promptTokens: 800,
      completionTokens: 150,
      totalTokens: 950,
    });
    expect(result).toEqual({
      promptTokens: 800,
      completionTokens: 150,
      totalTokens: 950,
    });
  });

  test("parses AI SDK format without totalTokens (computes sum)", () => {
    const result = parseStepUsage({
      promptTokens: 800,
      completionTokens: 150,
    });
    expect(result).toEqual({
      promptTokens: 800,
      completionTokens: 150,
      totalTokens: 950,
    });
  });

  test("returns null for object with unrecognized keys", () => {
    expect(parseStepUsage({ foo: 1, bar: 2 })).toBeNull();
  });

  test("handles partial OpenAI format with shared zero defaults", () => {
    const result = parseStepUsage({
      prompt_tokens: 1000,
    });
    expect(result).toEqual({
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
    });
  });

  test("handles partial Anthropic format with shared zero defaults", () => {
    const result = parseStepUsage({
      input_tokens: 500,
    });
    expect(result).toEqual({
      promptTokens: 500,
      completionTokens: 0,
      totalTokens: 500,
    });
  });

  test("maps shared normalized usage names back to compact token names", () => {
    expect(parseStepUsage({
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    })).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
  });
});

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

describe("shouldAutoCompact", () => {
  test("returns true when currentTokens is exactly 75% of contextLimit", () => {
    expect(shouldAutoCompact(750, 1000)).toBe(true);
  });

  test("returns true when currentTokens exceeds 75% of contextLimit", () => {
    expect(shouldAutoCompact(800, 1000)).toBe(true);
  });

  test("returns false when currentTokens is below 75% of contextLimit", () => {
    expect(shouldAutoCompact(749, 1000)).toBe(false);
  });

  test("returns false when currentTokens is 0", () => {
    expect(shouldAutoCompact(0, 1000)).toBe(false);
  });

  test("returns true when currentTokens equals contextLimit (100%)", () => {
    expect(shouldAutoCompact(1000, 1000)).toBe(true);
  });

  test("returns true when currentTokens exceeds contextLimit", () => {
    expect(shouldAutoCompact(1200, 1000)).toBe(true);
  });

  test("uses COMPACT_THRESHOLD constant", () => {
    // Verify the threshold is 0.75
    expect(COMPACT_THRESHOLD).toBe(0.75);
    // Verify boundary: 750 = 1000 * 0.75 → should compact
    expect(shouldAutoCompact(Math.floor(1000 * COMPACT_THRESHOLD), 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-cumulative token counting
// ---------------------------------------------------------------------------

describe("non-cumulative token counting", () => {
  test("adding two step usages should NOT double-count context", () => {
    // Simulate two consecutive steps. The second step's promptTokens already
    // includes the full context (previous messages + new assistant message).
    // So we should NOT add promptTokens from step 1 + promptTokens from step 2.
    const step1Usage = parseStepUsage({ promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });
    const step2Usage = parseStepUsage({ promptTokens: 1100, completionTokens: 50, totalTokens: 1150 });

    // The correct current context estimate is the LATEST promptTokens: 1100
    // NOT the sum: 1000 + 1100 = 2100
    const latestPromptTokens = step2Usage!.promptTokens!;
    expect(latestPromptTokens).toBe(1100);

    // Verify that naive summation would give wrong answer
    const wrongSum = step1Usage!.promptTokens! + step2Usage!.promptTokens!;
    expect(wrongSum).toBe(2100); // This is WRONG, just proving the point

    // The correct approach: use latest promptTokens only
    expect(latestPromptTokens).not.toBe(wrongSum);
  });

  test("fallback estimation counts messages + systemPrompt once", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "First message" },    // 13 chars
      { role: "assistant", content: "Reply" },        // 5 chars
    ];
    const systemPrompt = "You are helpful.";          // 16 chars
    // Total chars = 13 + 5 + 16 = 34, tokens = ceil(34/4) = 9
    const tokens = estimateContextTokens(messages, systemPrompt);
    expect(tokens).toBe(Math.ceil(34 / TOKEN_CHARS_RATIO));

    // Calling again should give same result (no accumulation)
    const tokens2 = estimateContextTokens(messages, systemPrompt);
    expect(tokens2).toBe(tokens);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  test("TOKEN_CHARS_RATIO is 4", () => {
    expect(TOKEN_CHARS_RATIO).toBe(4);
  });

  test("COMPACT_THRESHOLD is 0.75", () => {
    expect(COMPACT_THRESHOLD).toBe(0.75);
  });

  test("COMPACT_MIN_NEW_MESSAGES is 5", () => {
    expect(COMPACT_MIN_NEW_MESSAGES).toBe(5);
  });
});
