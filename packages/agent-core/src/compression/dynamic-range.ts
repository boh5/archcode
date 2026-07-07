import type {
  CompressionBlock,
  CompressionBlockDraft,
  CompressionFailure,
  CompressionState,
  CompressionSummary,
  ProtectedRef,
} from "./types";
import { commitCompressionBlock, createEmptyCompressionState, recordCompressionFailure, CompressionStateError } from "./state";
import { renderCompressionSummary } from "./summary";
import { collectProtectedRefsForRange } from "./protection";
import { deduplicateCompletedToolOutputs, type DeduplicatedToolOutputGroup } from "./deduplication";
import { purgeRepeatedOldErrors, type PurgedRepeatedErrorGroup } from "./purge-errors";
import { resolveCompressionRange, validateDynamicCompressionSummary, type CompressionValidationIssue } from "./validation";
import type { SessionStoreState } from "../store/types";
import type { CompressionBlockSnapshot, CompressionFailureSnapshot, CompressionStateSnapshot } from "@archcode/protocol";

export interface DynamicRangeCompressionInput {
  readonly startId: string;
  readonly endId: string;
  readonly summary: unknown;
}

export interface DynamicRangeCompressionSuccess {
  readonly ok: true;
  readonly block: CompressionBlock;
  readonly state: CompressionState;
  readonly event: { type: "compression.block_committed"; block: CompressionBlockSnapshot; state: CompressionStateSnapshot };
  readonly deduplicatedToolOutputs: DeduplicatedToolOutputGroup[];
  readonly purgedErrors: PurgedRepeatedErrorGroup[];
}

export interface DynamicRangeCompressionRejection {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
  readonly issues: CompressionValidationIssue[];
  readonly protectedRefs: ProtectedRef[];
  readonly state: CompressionState;
  readonly event: { type: "compression.block_failed"; failure: CompressionFailureSnapshot; state: CompressionStateSnapshot };
}

export type DynamicRangeCompressionResult = DynamicRangeCompressionSuccess | DynamicRangeCompressionRejection;

export function prepareDynamicRangeCompression(
  storeState: SessionStoreState,
  input: DynamicRangeCompressionInput,
  now: number = Date.now(),
): DynamicRangeCompressionResult {
  const currentState = storeState.compression ?? createEmptyCompressionState();
  const resolved = resolveCompressionRange(storeState.messages, currentState, input.startId, input.endId);
  if (!resolved.ok) {
    return reject(currentState, "range_rejected", "Compression range is invalid", resolved.issues, [], input, now);
  }

  const summary = validateDynamicCompressionSummary(input.summary, resolved.value.requiredChildRefs);
  if (!summary.ok) {
    return reject(currentState, "summary_rejected", "Compression summary is invalid", summary.issues, [], input, now);
  }

  const stateWithRefs: CompressionState = {
    ...currentState,
    refMap: resolved.value.refMap,
  };
  const protection = collectProtectedRefsForRange(storeState, resolved.value.range);
  if (!protection.ok) {
    return reject(
      stateWithRefs,
      "protected_content",
      "Compression range includes protected content",
      protection.protectedRefs.map((ref) => ({ code: "invalid_range", message: `${ref.kind}: ${ref.reason}` })),
      protection.protectedRefs,
      input,
      now,
    );
  }

  const draft: CompressionBlockDraft = {
    id: crypto.randomUUID(),
    canonicalBlockId: crypto.randomUUID(),
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: resolved.value.range,
    summary: summary.summary,
    protectedRefs: [],
    childBlockRefs: summary.summary.childBlockRefs,
    tokenEstimate: estimateCompressionTokens(storeState, resolved.value.range, summary.summary, now),
    createdAt: now,
  };

  let nextState: CompressionState;
  try {
    nextState = commitCompressionBlock(stateWithRefs, draft);
  } catch (error) {
    const issue = stateIssue(error);
    return reject(stateWithRefs, issue.code, issue.message, [issue], [], input, now);
  }

  const block = nextState.blocksByRef[nextState.activeBlockRefs.at(-1)!];
  if (block === undefined) {
    return reject(stateWithRefs, "commit_failed", "Compression block was not committed", [], [], input, now);
  }

  const stateSnapshot = compressionStateSnapshot(nextState);
  return {
    ok: true,
    block,
    state: nextState,
    event: { type: "compression.block_committed", block: compressionBlockSnapshot(block), state: stateSnapshot },
    deduplicatedToolOutputs: deduplicateCompletedToolOutputs(storeState.messages, resolved.value.range),
    purgedErrors: purgeRepeatedOldErrors(storeState.messages, resolved.value.range),
  };
}

export function compressionStateSnapshot(state: CompressionState): CompressionStateSnapshot {
  return {
    version: 1,
    refMap: state.refMap,
    blocksByRef: Object.fromEntries(
      Object.entries(state.blocksByRef).map(([ref, block]) => [ref, compressionBlockSnapshot(block)]),
    ) as CompressionStateSnapshot["blocksByRef"],
    activeBlockRefs: state.activeBlockRefs,
    inactiveBlockRefs: state.inactiveBlockRefs,
    supersededBlockRefs: state.supersededBlockRefs,
    failures: state.failures.map(compressionFailureSnapshot),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
  };
}

export function compressionBlockSnapshot(block: CompressionBlock): CompressionBlockSnapshot {
  return {
    id: block.id,
    ref: block.ref,
    status: block.status,
    strategy: block.strategy,
    trigger: block.trigger,
    range: block.range,
    summary: renderCompressionSummary(block.summary),
    childBlockRefs: block.childBlockRefs,
    protectedRefs: block.protectedRefs.map((ref) => ref.ref),
    ...(block.tokenEstimate === undefined ? {} : { tokenEstimate: block.tokenEstimate }),
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    ...(block.deactivatedAt === undefined ? {} : { deactivatedAt: block.deactivatedAt }),
    ...(block.supersededBy === undefined ? {} : { supersededBy: block.supersededBy }),
  };
}

function reject(
  state: CompressionState,
  code: string,
  reason: string,
  issues: CompressionValidationIssue[],
  protectedRefs: ProtectedRef[],
  input: DynamicRangeCompressionInput,
  now: number,
): DynamicRangeCompressionRejection {
  const failure: CompressionFailure = {
    id: crypto.randomUUID(),
    reason,
    ...(input.startId.startsWith("m") ? { startRef: input.startId as CompressionFailure["startRef"] } : {}),
    ...(input.endId.startsWith("m") ? { endRef: input.endId as CompressionFailure["endRef"] } : {}),
    strategy: "dynamic-range",
    failedAt: now,
  };
  const nextState = recordCompressionFailure(state, failure);
  return {
    ok: false,
    code,
    reason,
    issues,
    protectedRefs,
    state: nextState,
    event: {
      type: "compression.block_failed",
      failure: compressionFailureSnapshot(failure),
      state: compressionStateSnapshot(nextState),
    },
  };
}

function compressionFailureSnapshot(failure: CompressionFailure): CompressionFailureSnapshot {
  return {
    id: failure.id,
    reason: failure.reason,
    ...(failure.startRef === undefined ? {} : { startRef: failure.startRef }),
    ...(failure.endRef === undefined ? {} : { endRef: failure.endRef }),
    ...(failure.strategy === undefined ? {} : { strategy: failure.strategy }),
    failedAt: failure.failedAt,
  };
}

function estimateCompressionTokens(
  storeState: SessionStoreState,
  range: CompressionBlockDraft["range"],
  summary: CompressionSummary,
  now: number,
): CompressionBlockDraft["tokenEstimate"] {
  const originalChars = storeState.messages
    .slice(range.startIndex, range.endIndex + 1)
    .map((message) => JSON.stringify(message.parts))
    .join("\n").length;
  const summaryChars = renderCompressionSummary(summary).length;
  const originalTokens = Math.ceil(originalChars / 4);
  const summaryTokens = Math.ceil(summaryChars / 4);
  return {
    originalTokens,
    summaryTokens,
    savedTokens: Math.max(0, originalTokens - summaryTokens),
    estimatedAt: now,
  };
}

function stateIssue(error: unknown): CompressionValidationIssue {
  if (error instanceof CompressionStateError) return { code: "invalid_range", message: error.message };
  if (error instanceof Error) return { code: "invalid_summary", message: error.message };
  return { code: "invalid_range", message: String(error) };
}
