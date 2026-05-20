import type { ModelMessage } from "ai";

export const TOKEN_CHARS_RATIO = 4;
export const COMPACT_THRESHOLD = 0.75;
export const COMPACT_MIN_NEW_MESSAGES = 5;

function contentLength(content: ModelMessage["content"]): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      total += part.text.length;
    }
  }
  return total;
}

export function estimateContextTokens(
  messages: ModelMessage[],
  systemPrompt?: string,
): number {
  let chars = 0;
  for (const msg of messages) {
    chars += contentLength(msg.content);
  }
  if (systemPrompt) {
    chars += systemPrompt.length;
  }
  return Math.ceil(chars / TOKEN_CHARS_RATIO);
}

interface ParsedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export function parseStepUsage(usage: unknown): ParsedUsage | null {
  if (usage == null || typeof usage !== "object") return null;

  const u = usage as Record<string, unknown>;

  // AI SDK standard: promptTokens, completionTokens, totalTokens
  if ("promptTokens" in u && typeof u.promptTokens === "number") {
    const promptTokens = u.promptTokens as number;
    const completionTokens =
      "completionTokens" in u && typeof u.completionTokens === "number"
        ? (u.completionTokens as number)
        : undefined;
    const totalTokens =
      "totalTokens" in u && typeof u.totalTokens === "number"
        ? (u.totalTokens as number)
        : promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  // OpenAI: prompt_tokens, completion_tokens, total_tokens
  if ("prompt_tokens" in u && typeof u.prompt_tokens === "number") {
    const promptTokens = u.prompt_tokens as number;
    const completionTokens =
      "completion_tokens" in u && typeof u.completion_tokens === "number"
        ? (u.completion_tokens as number)
        : undefined;
    const totalTokens =
      "total_tokens" in u && typeof u.total_tokens === "number"
        ? (u.total_tokens as number)
        : promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  // Anthropic: input_tokens, output_tokens
  if ("input_tokens" in u && typeof u.input_tokens === "number") {
    const promptTokens = u.input_tokens as number;
    const completionTokens =
      "output_tokens" in u && typeof u.output_tokens === "number"
        ? (u.output_tokens as number)
        : undefined;
    const totalTokens =
      promptTokens !== undefined && completionTokens !== undefined
        ? promptTokens + completionTokens
        : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  // Google: prompt_token_count, candidates_token_count, total_token_count
  if ("prompt_token_count" in u && typeof u.prompt_token_count === "number") {
    const promptTokens = u.prompt_token_count as number;
    const completionTokens =
      "candidates_token_count" in u && typeof u.candidates_token_count === "number"
        ? (u.candidates_token_count as number)
        : undefined;
    const totalTokens =
      "total_token_count" in u && typeof u.total_token_count === "number"
        ? (u.total_token_count as number)
        : promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  return null;
}

export function shouldAutoCompact(currentTokens: number, contextLimit: number): boolean {
  return currentTokens >= contextLimit * COMPACT_THRESHOLD;
}