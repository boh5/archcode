import type { NormalizedUsage, SessionStats } from "./types";

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

export function createEmptySessionStats(): SessionStats {
  return {
    messages: { user: 0, assistant: 0, total: 0 },
    tools: { calls: 0, completed: 0, failed: 0 },
    steps: { started: 0, completed: 0 },
    usage: { ...EMPTY_USAGE },
  };
}

export function normalizeUsage(usage: unknown): NormalizedUsage {
  if (usage == null || typeof usage !== "object") return { ...EMPTY_USAGE };

  const record = usage as Record<string, unknown>;
  const inputTokens = firstNumber(record, [
    "inputTokens",
    "promptTokens",
    "prompt_tokens",
    "input_tokens",
    "prompt_token_count",
  ]) ?? 0;
  const outputTokens = firstNumber(record, [
    "outputTokens",
    "completionTokens",
    "completion_tokens",
    "output_tokens",
    "candidates_token_count",
  ]) ?? 0;
  const totalTokens =
    firstNumber(record, ["totalTokens", "total_tokens", "total_token_count"]) ?? inputTokens + outputTokens;
  const reasoningTokens =
    firstNumber(record, ["reasoningTokens", "reasoning_tokens"]) ??
    nestedNumber(record, "completion_tokens_details", "reasoning_tokens") ??
    nestedNumber(record, "output_token_details", "reasoning") ??
    0;
  const cachedInputTokens =
    firstNumber(record, ["cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens"]) ??
    nestedNumber(record, "prompt_tokens_details", "cached_tokens") ??
    0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
  };
}

export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  return undefined;
}

function nestedNumber(
  record: Record<string, unknown>,
  objectKey: string,
  valueKey: string,
): number | undefined {
  const nested = record[objectKey];
  if (nested == null || typeof nested !== "object") return undefined;

  const value = (nested as Record<string, unknown>)[valueKey];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
