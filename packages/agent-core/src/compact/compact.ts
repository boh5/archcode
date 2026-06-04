import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { StoreApi } from "zustand";
import type { ModelCallOptions } from "../config/provider";
import type { Logger } from "../logger";
import type { SessionStoreState, StoredMessage } from "../store/types";
import { runLlmStream } from "../llm";
import { withLlmRetry } from "../llm/retry";
import { toModelMessagesFromStoredMessages } from "../store/projection";
import { persistToolOutput } from "../tools/persist-output";
import { COMPACT_MIN_NEW_MESSAGES } from "./token-estimation";

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

export class CompactError extends Error {
  constructor(
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(`Compact failed: ${reason}`);
    this.name = "CompactError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactInput {
  messages: StoredMessage[];
  contextLimit: number;
  model: LanguageModelV3;
  modelOptions?: ModelCallOptions;
  sessionId: string;
  logger: Logger;
}

export interface CompactResult {
  summary: string;
  tailStartId: string;
  prunedToolOutputs: string[];
}

// ---------------------------------------------------------------------------
// Compact-specific minimal system prompt
// ---------------------------------------------------------------------------

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to produce a concise but comprehensive summary of the conversation prefix that will be compacted.

Your summary MUST include these structured sections:

## Current Objective
What the user is trying to accomplish right now.

## User Constraints
Any explicit constraints, preferences, or requirements the user has stated.

## Decisions Made
Key decisions that have been made during the conversation.

## Open Tasks
Tasks that are still pending or in progress.

## Important Files
Files that have been read, modified, or created during the conversation.

## Tool Output References
References to tool outputs that have been persisted to disk (shown as "[Output truncated; full output saved to: PATH]"). Mention the path and a brief description of what the output contained.

## Recent Failures
Any errors, failed attempts, or issues encountered.

Be thorough but concise. Preserve all important context that would be needed to continue the conversation effectively. Do NOT include any content from the current incomplete user message — it will be preserved verbatim in the tail.`;

// ---------------------------------------------------------------------------
// Phase 1: Select compactable prefix
// ---------------------------------------------------------------------------

interface TailBoundary {
  tailStartId: string;
  prefixMessages: StoredMessage[];
  tailMessages: StoredMessage[];
}

/**
 * Walk messages backward, preserving:
 * - Current incomplete round (latest user message with no assistant response)
 * - Last 2 complete rounds (user→assistant pairs)
 *
 * A "round" = user message + subsequent assistant response (which may span
 * multiple assistant messages with tool calls + results).
 */
function selectCompactablePrefix(messages: StoredMessage[]): TailBoundary | null {
  if (messages.length === 0) return null;

  const rounds: Array<{ userMsg: StoredMessage; assistantMsgs: StoredMessage[] }> = [];
  let currentRound: { userMsg: StoredMessage; assistantMsgs: StoredMessage[] } | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentRound) {
        rounds.push(currentRound);
      }
      currentRound = { userMsg: msg, assistantMsgs: [] };
    } else if (msg.role === "assistant" && currentRound) {
      currentRound.assistantMsgs.push(msg);
    }
  }

  const lastRound = currentRound;
  if (!lastRound) return null;

  const isIncomplete = lastRound.assistantMsgs.length === 0;
  const tailCompleteRoundCount = 2;

  if (isIncomplete) {
    const tailCompleteRounds = rounds.slice(-tailCompleteRoundCount);
    const preservedRounds = [...tailCompleteRounds, lastRound];
    const tailStartId = preservedRounds[0]?.userMsg.id;
    if (!tailStartId) return null;

    const prefixRoundCount = rounds.length - tailCompleteRoundCount;
    if (prefixRoundCount <= 0) return null;

    return splitAtTailStartId(messages, tailStartId);
  }

  const completeRounds = [...rounds, lastRound];
  const tailRounds = completeRounds.slice(-tailCompleteRoundCount);
  const tailStartId = tailRounds[0]?.userMsg.id;
  if (!tailStartId) return null;

  const prefixRoundCount = completeRounds.length - tailCompleteRoundCount;
  if (prefixRoundCount <= 0) return null;

  return splitAtTailStartId(messages, tailStartId);
}

/**
 * Split messages at tailStartId, ensuring tool call/result pairs are atomic.
 * If tailStartId falls between an assistant tool call and its corresponding
 * tool result, move boundary backward to include the complete transaction.
 */
function splitAtTailStartId(messages: StoredMessage[], tailStartId: string): TailBoundary | null {
  let splitIndex = messages.findIndex((m) => m.id === tailStartId);
  if (splitIndex === -1) return null;

  splitIndex = adjustBoundaryForToolAtomicity(messages, splitIndex);

  if (splitIndex === 0) return null;

  const prefixMessages = messages.slice(0, splitIndex);
  const tailMessages = messages.slice(splitIndex);

  return {
    tailStartId: messages[splitIndex]!.id,
    prefixMessages,
    tailMessages,
  };
}

/**
 * If the boundary splits a tool call/result pair, move boundary backward.
 *
 * In the store architecture, tool calls and their results are always in the
 * same StoredMessage (the tool-result event updates the existing ToolPart
 * in-place). The atomicity concern is about pending/running tools: if an
 * assistant message at the boundary has a tool part that's still
 * pending/running, we should not compact it. We move the boundary backward
 * so the entire message is in the tail.
 */
function adjustBoundaryForToolAtomicity(messages: StoredMessage[], splitIndex: number): number {
  if (splitIndex > 0) {
    const lastPrefixMsg = messages[splitIndex - 1]!;
    if (lastPrefixMsg.role === "assistant") {
      const hasUnsettledTools = lastPrefixMsg.parts.some(
        (p) => p.type === "tool" && (p.state === "pending" || p.state === "running"),
      );
      if (hasUnsettledTools) {
        let newSplitIndex = splitIndex - 1;
        while (newSplitIndex > 0 && messages[newSplitIndex - 1]!.role !== "user") {
          newSplitIndex--;
        }
        if (newSplitIndex > 0) {
          return newSplitIndex;
        }
      }
    }
  }

  return splitIndex;
}

// ---------------------------------------------------------------------------
// Phase 2: Prune tool outputs in prefix (on deep-cloned messages)
// ---------------------------------------------------------------------------

async function pruneToolOutputs(
  clonedPrefix: StoredMessage[],
  sessionId: string,
  logger: Logger,
  abort?: AbortSignal,
): Promise<string[]> {
  const prunedPaths: string[] = [];

  for (const message of clonedPrefix) {
    if (abort?.aborted) break;

    for (const part of message.parts) {
      if (part.type === "tool") {
        if (part.state === "pending" || part.state === "running") {
          continue;
        }

        const fullPath = await persistToolOutput(part, sessionId, { logger, previewLines: 5 });
        if (fullPath) {
          prunedPaths.push(fullPath);
        }
      }
    }
  }

  return prunedPaths;
}

// ---------------------------------------------------------------------------
// Phase 3: Summarize prefix
// ---------------------------------------------------------------------------

async function summarizePrefix(
  clonedPrefix: StoredMessage[],
  model: LanguageModelV3,
  modelOptions: ModelCallOptions | undefined,
  contextLimit: number,
  abort?: AbortSignal,
): Promise<string> {
  const projected = toModelMessagesFromStoredMessages(clonedPrefix);

  let messagesToSummarize = projected;
  const maxTokensForSummary = Math.floor(contextLimit * 0.5);

  let estimatedTokens = estimateTokensFromModelMessages(messagesToSummarize);
  while (estimatedTokens > maxTokensForSummary && messagesToSummarize.length > 1) {
    messagesToSummarize = messagesToSummarize.slice(1);
    estimatedTokens = estimateTokensFromModelMessages(messagesToSummarize);
  }

  if (messagesToSummarize.length === 0) {
    throw new CompactError("No messages to summarize after trimming");
  }

  const result = await withLlmRetry(
    async () => runLlmStream({
      model,
      messages: messagesToSummarize,
      system: COMPACT_SYSTEM_PROMPT,
      abortSignal: abort,
      modelOptions,
    }),
    "compact.summarize",
  );

  const summary = await result.text;

  if (!summary || summary.trim().length === 0) {
    throw new CompactError("Summarizer returned empty summary");
  }

  return summary.trim();
}

function estimateTokensFromModelMessages(messages: import("ai").ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          chars += part.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Hysteresis check
// ---------------------------------------------------------------------------

function hasEnoughNewMessages(messages: StoredMessage[]): boolean {
  let lastCompactionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.parts.some((p) => p.type === "compaction")) {
      lastCompactionIndex = i;
      break;
    }
  }

  if (lastCompactionIndex === -1) {
    return messages.length >= COMPACT_MIN_NEW_MESSAGES;
  }

  const newMessageCount = messages.length - lastCompactionIndex - 1;
  return newMessageCount >= COMPACT_MIN_NEW_MESSAGES;
}

// ---------------------------------------------------------------------------
// Deep clone helper
// ---------------------------------------------------------------------------

function deepCloneMessages(messages: StoredMessage[]): StoredMessage[] {
  return structuredClone(messages);
}

// ---------------------------------------------------------------------------
// Main compact function
// ---------------------------------------------------------------------------

/**
 * Three-phase compact pipeline: select compactable prefix → prune tool outputs → summarize prefix.
 *
 * Works on deep-cloned messages. Only commits to store on success via `commitCompact()`.
 * Returns null if compaction should be skipped (hysteresis, no prefix, etc.).
 */
export async function compact(
  input: CompactInput,
  abort?: AbortSignal,
): Promise<CompactResult | null> {
  const { messages, contextLimit, model, modelOptions, sessionId, logger } = input;

  if (abort?.aborted) {
    throw new DOMException("Compaction aborted", "AbortError");
  }

  if (!hasEnoughNewMessages(messages)) {
    return null;
  }

  const boundary = selectCompactablePrefix(messages);
  if (!boundary) {
    return null;
  }

  const { tailStartId, prefixMessages } = boundary;
  const clonedPrefix = deepCloneMessages(prefixMessages);

  const prunedToolOutputs = await pruneToolOutputs(clonedPrefix, sessionId, logger, abort);

  if (abort?.aborted) {
    throw new DOMException("Compaction aborted", "AbortError");
  }

  let summary: string;
  try {
    summary = await summarizePrefix(clonedPrefix, model, modelOptions, contextLimit, abort);
  } catch (err) {
    if (abort?.aborted) {
      throw new DOMException("Compaction aborted", "AbortError");
    }
    if (err instanceof CompactError) {
      throw err;
    }
    logger.warn("compact.summary.failed", {
      error: err instanceof Error ? err.message : String(err),
      context: { phase: "summarize" },
    });
    throw new CompactError(
      `Summary generation failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return {
    summary,
    tailStartId,
    prunedToolOutputs,
  };
}

// ---------------------------------------------------------------------------
// Commit function
// ---------------------------------------------------------------------------

/**
 * Dispatch a `compact` event to the store.
 * This is the ONLY function that modifies the live store.
 * Must be called AFTER compact() succeeds — transactional guarantee.
 */
export function commitCompact(
  store: StoreApi<SessionStoreState>,
  result: CompactResult,
): void {
  store.getState().append({
    type: "compact",
    summary: result.summary,
    tailStartId: result.tailStartId,
  });
}
