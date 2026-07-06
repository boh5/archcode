import type { CompressionBlockRef } from "@archcode/protocol";
import type { SessionFile } from "../store/helpers";
import type { StoredMessage, StoredPart, ToolPart } from "../store/types";
import { createEmptyCompressionState } from "./state";
import type { BlockRef, CompressionBlock, CompressionRange, CompressionStrategy, CompressionTrigger, MessageRef } from "./types";

const LARGE_TOOL_OUTPUT_THRESHOLD = 8_000;
const PREVIEW_MAX_CHARS = 2_000;
const TRUNCATED_OUTPUT_MARKER = "[Output truncated; full output saved to:";

export interface PersistedOutputReference {
  readonly kind: "tool-output";
  readonly ref: string;
  readonly truncated: true;
  readonly preview: string;
}

export type OriginalRangePart = StoredPart | (Omit<ToolPart, "output" | "errorMessage"> & {
  readonly output?: string;
  readonly errorMessage?: string;
  readonly persistedOutput: PersistedOutputReference;
});

export type OriginalRangeMessage = Omit<StoredMessage, "parts"> & {
  readonly parts: OriginalRangePart[];
};

export interface CompressionOriginalRangeEntry {
  readonly ref: MessageRef;
  readonly message: OriginalRangeMessage;
}

export interface CompressionOriginalRangeSuccess {
  readonly ok: true;
  readonly blockRef: BlockRef;
  readonly blockId: string;
  readonly status: CompressionBlock["status"];
  readonly strategy: CompressionStrategy;
  readonly trigger: CompressionTrigger;
  readonly childBlockRefs: BlockRef[];
  readonly range: CompressionRange;
  readonly coveredRefs: MessageRef[];
  readonly coveredMessageIds: string[];
  readonly messages: CompressionOriginalRangeEntry[];
}

export interface CompressionOriginalRangeNotFound {
  readonly ok: false;
  readonly code: "not_found";
  readonly reason: "compression_block_not_found";
  readonly blockRef: string;
}

export interface CompressionOriginalRangeUnsupported {
  readonly ok: false;
  readonly code: "unsupported";
  readonly reason: "legacy_compact_without_hybrid_coverage" | "missing_hybrid_coverage";
  readonly blockRef: string;
}

export type CompressionOriginalRangeResult =
  | CompressionOriginalRangeSuccess
  | CompressionOriginalRangeNotFound
  | CompressionOriginalRangeUnsupported;

export function resolveCompressionOriginalRange(
  session: SessionFile,
  blockRef: string,
): CompressionOriginalRangeResult {
  const compression = session.compression ?? createEmptyCompressionState();
  const block = isBlockRef(blockRef) ? compression.blocksByRef[blockRef] : undefined;

  if (block === undefined) {
    if (hasLegacyCompaction(session.messages)) {
      return { ok: false, code: "unsupported", reason: "legacy_compact_without_hybrid_coverage", blockRef };
    }
    return { ok: false, code: "not_found", reason: "compression_block_not_found", blockRef };
  }

  const coveredEntries = resolveCoveredEntries(session, block);
  if (coveredEntries === undefined) {
    return { ok: false, code: "unsupported", reason: "missing_hybrid_coverage", blockRef };
  }

  return {
    ok: true,
    blockRef: block.ref,
    blockId: block.id,
    status: block.status,
    strategy: block.strategy,
    trigger: block.trigger,
    childBlockRefs: block.childBlockRefs,
    range: block.range,
    coveredRefs: coveredEntries.map((entry) => entry.ref),
    coveredMessageIds: coveredEntries.map((entry) => entry.message.id),
    messages: coveredEntries,
  };
}

function resolveCoveredEntries(
  session: SessionFile,
  block: CompressionBlock,
): CompressionOriginalRangeEntry[] | undefined {
  const { startIndex, endIndex } = block.range;
  if (startIndex < 0 || endIndex < startIndex || endIndex >= session.messages.length) return undefined;

  const messages = session.messages.slice(startIndex, endIndex + 1);
  if (messages[0]?.id !== block.range.startMessageId) return undefined;
  if (messages.at(-1)?.id !== block.range.endMessageId) return undefined;

  return messages.map((message, offset) => {
    const rawRef = session.compression?.refMap.messageRefsById[message.id];
    const ref = rawRef ?? formatMessageRef(startIndex + offset + 1);
    return {
      ref,
      message: sanitizeMessageForOriginalRange(session.sessionId, message),
    };
  });
}

function sanitizeMessageForOriginalRange(sessionId: string, message: StoredMessage): OriginalRangeMessage {
  return {
    ...message,
    parts: message.parts.map((part) => sanitizePartForOriginalRange(sessionId, part)),
  };
}

function sanitizePartForOriginalRange(sessionId: string, part: StoredPart): OriginalRangePart {
  if (part.type !== "tool" || (part.state !== "completed" && part.state !== "error")) return part;

  const output = part.state === "completed" ? part.output : part.errorMessage;
  const hasPersistedOutput = typeof part.meta?.fullOutputPath === "string" || output.includes(TRUNCATED_OUTPUT_MARKER);
  if (!hasPersistedOutput && output.length < LARGE_TOOL_OUTPUT_THRESHOLD) return part;

  const preview = previewOutput(output);
  const persistedOutput: PersistedOutputReference = {
    kind: "tool-output",
    ref: persistedOutputRef(sessionId, part.toolName, part.toolCallId),
    truncated: true,
    preview,
  };
  const sanitizedMeta = sanitizePersistedOutputMeta(part.meta);

  if (part.state === "completed") {
    return { ...part, output: preview, ...(sanitizedMeta === undefined ? { meta: undefined } : { meta: sanitizedMeta }), persistedOutput };
  }
  return { ...part, errorMessage: preview, ...(sanitizedMeta === undefined ? { meta: undefined } : { meta: sanitizedMeta }), persistedOutput };
}

function sanitizePersistedOutputMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  const { fullOutputPath: _fullOutputPath, ...rest } = meta;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function previewOutput(output: string): string {
  const markerIndex = output.indexOf(TRUNCATED_OUTPUT_MARKER);
  const preview = markerIndex >= 0 ? output.slice(0, markerIndex).trimEnd() : output;
  return preview.length <= PREVIEW_MAX_CHARS ? preview : `${preview.slice(0, PREVIEW_MAX_CHARS)}…`;
}

function persistedOutputRef(sessionId: string, toolName: string, toolCallId: string): string {
  return `${sanitizeRefSegment(sessionId)}:${sanitizeRefSegment(toolName)}:${sanitizeRefSegment(toolCallId)}`;
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasLegacyCompaction(messages: readonly StoredMessage[]): boolean {
  return messages.some((message) => message.parts.some((part) => part.type === "compaction"));
}

function isBlockRef(value: string): value is CompressionBlockRef & BlockRef {
  return /^b\d+$/.test(value);
}

function formatMessageRef(index: number): MessageRef {
  return `m${index.toString().padStart(4, "0")}`;
}
