import type { ModelMessage } from "ai";
import { normalizeUsage, type NormalizedUsage } from "@archcode/protocol";

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
  const normalized = normalizeUsage(usage);
  if (isEmptyUsage(normalized)) return null;

  return {
    promptTokens: normalized.inputTokens,
    completionTokens: normalized.outputTokens,
    totalTokens: normalized.totalTokens,
  };
}

function isEmptyUsage(usage: NormalizedUsage): boolean {
  return usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.totalTokens === 0 &&
    usage.reasoningTokens === 0 &&
    usage.cachedInputTokens === 0;
}

export function shouldAutoCompact(currentTokens: number, contextLimit: number): boolean {
  return currentTokens >= contextLimit * COMPACT_THRESHOLD;
}
