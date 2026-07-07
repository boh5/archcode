import { z } from "zod/v4";
import type { ModelCallOptions } from "../config";
import type { Logger } from "../logger";
import type { ModelInfo } from "../provider/model";
import { runLlmObject } from "../llm";
import type { SessionStoreState, StoredMessage, ToolPart } from "../store/types";
import { persistToolOutput } from "../tools/persist-output";
import { HARD_COMPACT_RATIO } from "./constants";
import { rangeContains, rangesOverlap } from "./coverage";
import { buildMessageRefMap } from "./refs";
import { commitCompressionBlock, createEmptyCompressionState, recordCompressionFailure, CompressionStateError } from "./state";
import { collectProtectedRefsForRange } from "./protection";
import { compressionBlockSnapshot, compressionStateSnapshot } from "./dynamic-range";
import { renderCompressionSummary, validateCompressionSummary } from "./summary";
import type {
  BlockRef,
  CompressionBlock,
  CompressionBlockDraft,
  CompressionFailure,
  CompressionRange,
  CompressionState,
  CompressionStrategy,
  CompressionSummary,
  CompressionSummarySectionName,
  CompressionTrigger,
  MessageRef,
} from "./types";

const SUMMARY_SECTIONS = [
  "Current Objective",
  "User Constraints",
  "Decisions Made",
  "Open Tasks",
  "Important Files",
  "Tool Results",
  "Errors/Unknown Results",
  "Protected Refs",
  "Child Block Refs",
  "Resume Instructions",
] as const satisfies readonly CompressionSummarySectionName[];

const CompressionSummaryObjectSchema = z.object({
  version: z.literal(1),
  childBlockRefs: z.array(z.string().regex(/^b\d+$/)),
  sections: z.object(Object.fromEntries(SUMMARY_SECTIONS.map((section) => [section, z.string().min(1)])) as Record<CompressionSummarySectionName, z.ZodString>).strict(),
}).strict();

export interface SystemCompressionInput {
  readonly storeState: SessionStoreState;
  readonly model: ModelInfo["model"];
  readonly modelOptions?: ModelCallOptions;
  readonly abort?: AbortSignal;
  readonly logger: Logger;
  readonly strategy?: CompressionStrategy;
  readonly trigger?: CompressionTrigger;
  readonly summaryBudget?: "normal" | "tight";
  readonly now?: number;
}

export type SystemCompressionResult =
  | {
    readonly ok: true;
    readonly block: CompressionBlock;
    readonly state: CompressionState;
    readonly event: ReturnType<typeof committedEvent>;
  }
  | {
    readonly ok: false;
    readonly code: "no_safe_range" | "summary_failed" | "commit_failed";
    readonly reason: string;
    readonly state: CompressionState;
    readonly event: ReturnType<typeof failedEvent>;
  };

export async function prepareHardLimitCompression(input: SystemCompressionInput): Promise<SystemCompressionResult> {
  return prepareSystemCompression({
    ...input,
    strategy: input.strategy ?? "hard-limit",
    trigger: input.trigger ?? "hard_threshold",
    summaryBudget: input.summaryBudget ?? "normal",
  });
}

export async function prepareSystemCompression(input: SystemCompressionInput): Promise<SystemCompressionResult> {
  const now = input.now ?? Date.now();
  const currentState = input.storeState.compression ?? createEmptyCompressionState();
  const selected = selectSafeCompressionRange(input.storeState, currentState);
  const strategy = input.strategy ?? "hard-limit";
  const trigger = input.trigger ?? "hard_threshold";

  if (!selected.ok) {
    return reject(currentState, "no_safe_range", selected.reason, strategy, now);
  }

  try {
    await persistGiantOutputs(input.storeState, selected.range, input.logger);
    const summary = await generateSystemSummary(input, selected.range, selected.requiredChildRefs);
    const summaryValidation = validateCompressionSummary(summary, selected.requiredChildRefs);
    if (!summaryValidation.ok) throw new Error(summaryValidation.errors.join("; "));
    const stateWithRefs: CompressionState = { ...currentState, refMap: selected.refMap };
    const draft: CompressionBlockDraft = {
      id: crypto.randomUUID(),
      canonicalBlockId: crypto.randomUUID(),
      strategy,
      trigger,
      range: selected.range,
      summary,
      childBlockRefs: summary.childBlockRefs,
      protectedRefs: [],
      tokenEstimate: estimateCompressionTokens(input.storeState, selected.range, summary, now),
      createdAt: now,
    };
    const nextState = commitCompressionBlock(stateWithRefs, draft);
    const block = nextState.blocksByRef[nextState.activeBlockRefs.at(-1)!];
    if (block === undefined) return reject(stateWithRefs, "commit_failed", "Compression block was not committed", strategy, now);
    return { ok: true, block, state: nextState, event: committedEvent(block, nextState) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const reason = error instanceof CompressionStateError || error instanceof Error ? error.message : String(error);
    return reject(currentState, error instanceof CompressionStateError ? "commit_failed" : "summary_failed", reason, strategy, now);
  }
}

export function selectSafeCompressionRange(
  storeState: SessionStoreState,
  state: CompressionState = storeState.compression ?? createEmptyCompressionState(),
): { ok: true; range: CompressionRange; refMap: CompressionState["refMap"]; requiredChildRefs: BlockRef[] } | { ok: false; reason: string } {
  const messages = storeState.messages;
  if (messages.length < 4) return { ok: false, reason: "no_safe_range: latest two complete rounds and current incomplete round leave no safe prefix" };

  const tailStartIndex = findRoundTailStartIndex(messages);
  if (tailStartIndex === null) return { ok: false, reason: "no_safe_range: latest two complete rounds and current incomplete round leave no safe prefix" };

  const endIndex = tailStartIndex - 1;
  if (endIndex <= 0) return { ok: false, reason: "no_safe_range: selected prefix would be too small" };

  const refMap = buildMessageRefMap(messages.map((message) => message.id), state.refMap);
  const start = messages[0]!;
  const end = messages[endIndex]!;
  const range: CompressionRange = {
    startMessageId: start.id,
    endMessageId: end.id,
    startRef: refMap.messageRefsById[start.id] ?? ("m0001" as MessageRef),
    endRef: refMap.messageRefsById[end.id] ?? (`m${String(endIndex + 1).padStart(4, "0")}` as MessageRef),
    startIndex: 0,
    endIndex,
  };

  const protection = collectProtectedRefsForRange(storeState, range);
  if (!protection.ok) {
    return { ok: false, reason: `no_safe_range: ${protection.protectedRefs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ")}` };
  }

  const activeBlockSafety = activeBlockSafetyForRange(state, range);
  if (!activeBlockSafety.ok) return activeBlockSafety;

  return { ok: true, range, refMap, requiredChildRefs: activeBlockSafety.requiredChildRefs };
}

function findRoundTailStartIndex(messages: readonly StoredMessage[]): number | null {
  const rounds: Array<{ userIndex: number; assistantCount: number }> = [];
  let current: { userIndex: number; assistantCount: number } | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      if (current !== null) rounds.push(current);
      current = { userIndex: index, assistantCount: 0 };
      continue;
    }
    if (message.role === "assistant" && current !== null) current.assistantCount += 1;
  }

  if (current === null) return null;
  const completeRounds = current.assistantCount === 0 ? rounds : [...rounds, current];
  const preservedComplete = completeRounds.slice(-2);
  const preserved = current.assistantCount === 0 ? [...preservedComplete, current] : preservedComplete;
  const tailStart = preserved[0]?.userIndex;
  if (tailStart === undefined || tailStart === 0) return null;
  if (tailStart < 2) return null;
  return tailStart;
}

function activeBlockSafetyForRange(
  state: CompressionState,
  range: CompressionRange,
): { ok: true; requiredChildRefs: BlockRef[] } | { ok: false; reason: string } {
  const requiredChildRefs: BlockRef[] = [];
  for (const ref of state.activeBlockRefs) {
    const block = state.blocksByRef[ref];
    if (block === undefined || !rangesOverlap(range, block.range)) continue;
    if (rangeContains(range, block.range)) {
      requiredChildRefs.push(ref);
      continue;
    }
    return { ok: false, reason: `no_safe_range: selected prefix partially overlaps active block ${ref}` };
  }
  return { ok: true, requiredChildRefs };
}

function committedEvent(block: CompressionBlock, state: CompressionState) {
  return { type: "compression.block_committed" as const, block: compressionBlockSnapshot(block), state: compressionStateSnapshot(state) };
}

function failedEvent(failure: CompressionFailure, state: CompressionState) {
  return { type: "compression.block_failed" as const, failure: {
    id: failure.id,
    reason: failure.reason,
    ...(failure.startRef === undefined ? {} : { startRef: failure.startRef }),
    ...(failure.endRef === undefined ? {} : { endRef: failure.endRef }),
    ...(failure.strategy === undefined ? {} : { strategy: failure.strategy }),
    failedAt: failure.failedAt,
  }, state: compressionStateSnapshot(state) };
}

function reject(
  state: CompressionState,
  code: SystemCompressionResult extends infer R ? R extends { ok: false; code: infer C } ? C : never : never,
  reason: string,
  strategy: CompressionStrategy,
  now: number,
): Extract<SystemCompressionResult, { ok: false }> {
  const failure: CompressionFailure = { id: crypto.randomUUID(), reason: `${code}: ${reason}`, strategy, failedAt: now };
  const nextState = recordCompressionFailure(state, failure);
  return { ok: false, code, reason: failure.reason, state: nextState, event: failedEvent(failure, nextState) };
}

async function generateSystemSummary(
  input: SystemCompressionInput,
  range: CompressionRange,
  requiredChildRefs: readonly BlockRef[],
): Promise<CompressionSummary> {
  const summary = await runLlmObject({
    model: input.model,
    modelOptions: withSummaryBudget(input.modelOptions, input.summaryBudget ?? "normal"),
    abortSignal: input.abort,
    logger: input.logger,
    schema: CompressionSummaryObjectSchema,
    schemaName: "compression_summary",
    schemaDescription: "Return a strict structured compression summary for the selected transcript range.",
    system: "You produce faithful ArchCode compression summaries. Preserve constraints, decisions, errors, files, tool results, child block placeholders, and resume instructions. Do not invent completed work.",
    prompt: buildSummaryPrompt(input.storeState.messages, range, requiredChildRefs, input.summaryBudget ?? "normal"),
  });
  return summary as CompressionSummary;
}

function withSummaryBudget(modelOptions: ModelCallOptions | undefined, budget: "normal" | "tight"): ModelCallOptions | undefined {
  const maxOutputTokens = budget === "tight" ? 1200 : 2400;
  return { ...(modelOptions ?? {}), maxOutputTokens: Math.min(modelOptions?.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) };
}

function buildSummaryPrompt(
  messages: readonly StoredMessage[],
  range: CompressionRange,
  requiredChildRefs: readonly BlockRef[],
  budget: "normal" | "tight",
): string {
  const selected = messages.slice(range.startIndex, range.endIndex + 1).map((message, offset) => ({
    ref: `m${String(range.startIndex + offset + 1).padStart(4, "0")}`,
    role: message.role,
    parts: message.parts,
  }));
  return JSON.stringify({
    instructions: [
      "Summarize only the selected range.",
      "Fill every required section with non-empty text.",
      "If childBlockRefs are required, list each and include each placeholder exactly once in the rendered section text.",
      budget === "tight" ? "Use terse emergency wording and prioritize resumability." : "Use concise but complete wording.",
    ],
    requiredSections: SUMMARY_SECTIONS,
    requiredChildRefs,
    selectedRange: { startRef: range.startRef, endRef: range.endRef },
    messages: selected,
  });
}

async function persistGiantOutputs(state: SessionStoreState, range: CompressionRange, logger: Logger): Promise<void> {
  const threshold = 8_000;
  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    const message = state.messages[index];
    if (message === undefined) continue;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const tool = part as ToolPart;
      const output = tool.state === "completed" ? tool.output : tool.state === "error" ? tool.errorMessage : "";
      if (output.length >= threshold && (tool.state === "completed" || tool.state === "error")) {
        await persistToolOutput(tool, state.sessionId, { logger, previewLines: 8 });
      }
    }
  }
}

function estimateCompressionTokens(
  state: SessionStoreState,
  range: CompressionRange,
  summary: CompressionSummary,
  now: number,
): CompressionBlockDraft["tokenEstimate"] {
  const originalChars = state.messages.slice(range.startIndex, range.endIndex + 1).map((message) => JSON.stringify(message.parts)).join("\n").length;
  const summaryChars = renderCompressionSummary(summary).length;
  const originalTokens = Math.ceil(originalChars / 4);
  const summaryTokens = Math.ceil(summaryChars / 4);
  return { originalTokens, summaryTokens, savedTokens: Math.max(0, originalTokens - summaryTokens), estimatedAt: now };
}

export { HARD_COMPACT_RATIO };
