import { COMPRESSION_SUMMARY_SECTION_NAMES } from "./constants";
import { buildMessageRefMap } from "./refs";
import { validateCompressionSummary } from "./summary";
import type {
  BlockRef,
  CompressionRange,
  CompressionState,
  CompressionSummary,
  MessageRef,
} from "./types";
import type { StoredMessage } from "../store/types";

export type CompressionValidationCode =
  | "invalid_ref"
  | "unknown_ref"
  | "invalid_range"
  | "invalid_summary";

export interface CompressionValidationIssue {
  readonly code: CompressionValidationCode;
  readonly message: string;
}

export interface ResolvedCompressionRange {
  readonly range: CompressionRange;
  readonly refMap: CompressionState["refMap"];
  readonly requiredChildRefs: BlockRef[];
}

export function resolveCompressionRange(
  messages: readonly StoredMessage[],
  state: CompressionState,
  startId: string,
  endId: string,
): { ok: true; value: ResolvedCompressionRange } | { ok: false; issues: CompressionValidationIssue[] } {
  const refMap = buildMessageRefMap(messages.map((message) => message.id), state.refMap);
  const start = resolveBoundaryRef(messages, state, refMap, startId);
  const end = resolveBoundaryRef(messages, state, refMap, endId);
  if (!start.ok || !end.ok) {
    return {
      ok: false,
      issues: [
        ...(!start.ok ? start.issues : []),
        ...(!end.ok ? end.issues : []),
      ],
    };
  }

  const startBoundary = start.value;
  const endBoundary = end.value;
  if (startBoundary.startIndex > endBoundary.endIndex) {
    return {
      ok: false,
      issues: [{ code: "invalid_range", message: `startId ${startId} must resolve before or at endId ${endId}` }],
    };
  }

  if (startBoundary.startIndex === endBoundary.endIndex) {
    return {
      ok: false,
      issues: [{ code: "invalid_range", message: "Compression range is too small; single-message ranges are protected" }],
    };
  }

  const startMessage = messages[startBoundary.startIndex];
  const endMessage = messages[endBoundary.endIndex];
  if (startMessage === undefined || endMessage === undefined) {
    return { ok: false, issues: [{ code: "unknown_ref", message: "Range resolved outside the current transcript" }] };
  }

  const range: CompressionRange = {
    startMessageId: startMessage.id,
    endMessageId: endMessage.id,
    startRef: refMap.messageRefsById[startMessage.id] ?? (`m${String(startBoundary.startIndex + 1).padStart(4, "0")}` as MessageRef),
    endRef: refMap.messageRefsById[endMessage.id] ?? (`m${String(endBoundary.endIndex + 1).padStart(4, "0")}` as MessageRef),
    startIndex: startBoundary.startIndex,
    endIndex: endBoundary.endIndex,
  };

  return {
    ok: true,
    value: {
      range,
      refMap,
      requiredChildRefs: activeChildRefsContainedByRange(state, range),
    },
  };
}

export function validateDynamicCompressionSummary(
  summary: unknown,
  requiredChildRefs: readonly BlockRef[],
): { ok: true; summary: CompressionSummary } | { ok: false; issues: CompressionValidationIssue[] } {
  const result = validateCompressionSummary(summary, requiredChildRefs);
  if (!result.ok) {
    return { ok: false, issues: result.errors.map((message) => ({ code: "invalid_summary", message })) };
  }

  return { ok: true, summary: summary as CompressionSummary };
}

export function compressionSummaryZodShape(): Record<string, unknown> {
  return Object.fromEntries(COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [section, section]));
}

interface BoundaryResolution {
  readonly startIndex: number;
  readonly endIndex: number;
}

function resolveBoundaryRef(
  messages: readonly StoredMessage[],
  state: CompressionState,
  refMap: CompressionState["refMap"],
  ref: string,
): { ok: true; value: BoundaryResolution } | { ok: false; issues: CompressionValidationIssue[] } {
  if (isMessageRef(ref)) {
    const messageId = refMap.messageIdsByRef[ref];
    if (messageId === undefined) {
      return { ok: false, issues: [{ code: "unknown_ref", message: `Unknown message ref ${ref}` }] };
    }
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) {
      return { ok: false, issues: [{ code: "unknown_ref", message: `Message ref ${ref} is not in the current transcript` }] };
    }
    return { ok: true, value: { startIndex: index, endIndex: index } };
  }

  if (isBlockRef(ref)) {
    const block = state.blocksByRef[ref];
    if (block === undefined) {
      return { ok: false, issues: [{ code: "unknown_ref", message: `Unknown block ref ${ref}` }] };
    }
    return { ok: true, value: { startIndex: block.range.startIndex, endIndex: block.range.endIndex } };
  }

  return {
    ok: false,
    issues: [{ code: "invalid_ref", message: `Refs must be projection refs like m0001 or known block refs like b1; received ${ref}` }],
  };
}

function activeChildRefsContainedByRange(state: CompressionState, range: CompressionRange): BlockRef[] {
  return state.activeBlockRefs.filter((ref) => {
    const block = state.blocksByRef[ref];
    return block !== undefined && range.startIndex <= block.range.startIndex && range.endIndex >= block.range.endIndex;
  });
}

function isMessageRef(value: string): value is MessageRef {
  return /^m\d{4,}$/.test(value);
}

function isBlockRef(value: string): value is BlockRef {
  return /^b\d+$/.test(value);
}
