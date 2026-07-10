import {
  BusyError,
  InvalidTodoStateError,
  type SessionStoreState,
  type SessionTodo,
  type StreamEvent,
} from "./types";
import {
  reduceStreamEvent as protocolReduceStreamEvent,
  type CompressionBlockSnapshot,
  type CompressionFailureSnapshot,
  type CompressionRefMapSnapshot,
  type CompressionStateSnapshot,
  type SessionProjection,
} from "@archcode/protocol";
import { COMPRESSION_SUMMARY_SECTION_NAMES, createEmptyCompressionState } from "../compression";
import type { BlockRef, CompressionBlock, CompressionFailure, CompressionRefMap, CompressionState, CompressionSummary, MessageRef, ProtectedRef } from "../compression";

const TODO_STATUSES = new Set<SessionTodo["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * Runtime-specific wrapper around the protocol reducer.
 *
 * Adds two runtime-only behaviours:
 * 1. `execution-start` — throws BusyError if already running (protocol doesn't enforce this)
 * 2. `todo-write` — throws InvalidTodoStateError on invalid todos (protocol silently
 *    returns {}), and tracks `lastTodoWriteStepIndex`
 */
export function reduceStreamEvent(
  state: SessionStoreState,
  event: StreamEvent,
): Partial<SessionStoreState> {
  // Runtime-specific guards
  if (event.type === "execution-start" && state.isRunning) {
    throw new BusyError(state.sessionId);
  }

  if (event.type === "todo-write") {
    validateTodos(event.todos);
  }

  if (event.type === "compression.block_committed") {
    return {
      compression: event.state === undefined
        ? commitCompressionBlockSnapshot(state.compression, event.block)
        : compressionStateFromSnapshot(event.state),
    };
  }

  if (event.type === "compression.block_failed") {
    return {
      compression: event.state === undefined
        ? appendCompressionFailure(state.compression, event.failure)
        : compressionStateFromSnapshot(event.state),
    };
  }

  if (event.type === "compression.ref_map_updated") {
    const base = state.compression ?? createEmptyCompressionState();
    return {
      compression: {
        ...base,
        refMap: compressionRefMapFromSnapshot(event.refMap),
        ...(event.updatedAt === undefined ? {} : { updatedAt: event.updatedAt }),
      },
    };
  }

  if (event.type === "session.cwd_changed") {
    return { cwd: event.cwd, readSnapshots: new Map() };
  }

  // Delegate to protocol reducer (SessionStoreState structurally satisfies
  // SessionProjection on all shared fields)
  const protocolState: SessionProjection = { ...state, compression: undefined };
  const partial = protocolReduceStreamEvent(protocolState, event, {
    timestamp: Date.now(),
    generateId: () => crypto.randomUUID(),
  }) as Partial<SessionStoreState> & { compressionBlocks?: unknown };

  if (event.type === "compact") {
    const { compressionBlocks: _compressionBlocks, ...runtimePartial } = partial;
    void _compressionBlocks;
    return { ...runtimePartial, compression: createEmptyCompressionState() };
  }

  // Augment with runtime-only fields
  if (event.type === "todo-write") {
    const currentStepIndex = state.steps.length - 1;
    partial.lastTodoWriteStepIndex = currentStepIndex >= 0 ? currentStepIndex : null;
  }

  return partial;
}

function commitCompressionBlockSnapshot(
  state: CompressionState | undefined,
  block: CompressionBlockSnapshot,
): CompressionState {
  const base = state ?? createEmptyCompressionState();
  const nextBlock = compressionBlockFromSnapshot(block);
  return normalizeCompressionState({
    ...base,
    refMap: mergeCompressionRefMap(base.refMap, block),
    blocksByRef: { ...base.blocksByRef, [nextBlock.ref]: nextBlock },
    protectedRefs: mergeProtectedRefs(base.protectedRefs, nextBlock.protectedRefs),
    updatedAt: block.updatedAt,
  });
}

function appendCompressionFailure(
  state: CompressionState | undefined,
  failure: CompressionFailureSnapshot,
): CompressionState {
  const base = state ?? createEmptyCompressionState();
  return {
    ...base,
    failures: [...base.failures, compressionFailureFromSnapshot(failure)],
    updatedAt: failure.failedAt,
  };
}

function compressionStateFromSnapshot(snapshot: CompressionStateSnapshot): CompressionState {
  const blocksByRef: CompressionState["blocksByRef"] = {};
  for (const [ref, block] of Object.entries(snapshot.blocksByRef) as Array<[BlockRef, CompressionBlockSnapshot]>) {
    blocksByRef[ref] = compressionBlockFromSnapshot(block);
  }

  return normalizeCompressionState({
    version: 1,
    refMap: compressionRefMapFromSnapshot(snapshot.refMap),
    blocksByRef,
    activeBlockRefs: snapshot.activeBlockRefs as BlockRef[],
    inactiveBlockRefs: snapshot.inactiveBlockRefs as BlockRef[],
    supersededBlockRefs: snapshot.supersededBlockRefs as BlockRef[],
    protectedRefs: Object.values(blocksByRef).flatMap((block) => block.protectedRefs),
    failures: snapshot.failures.map(compressionFailureFromSnapshot),
    ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
  });
}

function compressionBlockFromSnapshot(block: CompressionBlockSnapshot): CompressionBlock {
  const protectedRefs = block.protectedRefs.map((ref): ProtectedRef => ({
    ref: ref as MessageRef | BlockRef,
    kind: "user_constraint",
    reason: "Protected by compression snapshot",
  }));

  return {
    id: block.id,
    ref: block.ref as BlockRef,
    status: block.status,
    strategy: block.strategy,
    trigger: block.trigger,
    range: {
      startMessageId: block.range.startMessageId,
      endMessageId: block.range.endMessageId,
      startRef: block.range.startRef as MessageRef,
      endRef: block.range.endRef as MessageRef,
      startIndex: block.range.startIndex,
      endIndex: block.range.endIndex,
    },
    summary: summaryFromSnapshot(block.summary, block.childBlockRefs as BlockRef[]),
    protectedRefs,
    childBlockRefs: block.childBlockRefs as BlockRef[],
    ...(block.tokenEstimate === undefined ? {} : { tokenEstimate: block.tokenEstimate }),
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    ...(block.deactivatedAt === undefined ? {} : { deactivatedAt: block.deactivatedAt }),
    ...(block.supersededBy === undefined ? {} : { supersededBy: block.supersededBy as BlockRef }),
  };
}

function summaryFromSnapshot(summary: string, childBlockRefs: BlockRef[]): CompressionSummary {
  const parsed = parseRenderedSummarySnapshot(summary);
  if (parsed !== undefined) return { version: 1, sections: parsed, childBlockRefs };

  const sections = Object.fromEntries(
    COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => {
      if (section === "Current Objective") return [section, summary.length === 0 ? "Not provided" : summary];
      if (section === "Child Block Refs") return [section, childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" ")];
      return [section, "Not provided by compression snapshot"];
    }),
  ) as CompressionSummary["sections"];

  return { version: 1, sections, childBlockRefs };
}

function parseRenderedSummarySnapshot(summary: string): CompressionSummary["sections"] | undefined {
  const headingMatches = [...summary.matchAll(/^## (.+)$/gm)];
  if (headingMatches.length === 0) return undefined;

  const sectionNames = new Set<string>(COMPRESSION_SUMMARY_SECTION_NAMES);
  const sectionRanges = new Map<string, { contentStart: number; contentEnd: number }>();

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index]!;
    const name = match[1];
    if (name === undefined || !sectionNames.has(name)) return undefined;
    if (sectionRanges.has(name)) return undefined;

    const contentStart = match.index + match[0].length;
    const nextMatch = headingMatches[index + 1];
    const contentEnd = nextMatch?.index ?? summary.length;
    sectionRanges.set(name, { contentStart, contentEnd });
  }

  if (sectionRanges.size !== COMPRESSION_SUMMARY_SECTION_NAMES.length) return undefined;

  const sections = Object.fromEntries(
    COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => {
      const range = sectionRanges.get(section);
      if (range === undefined) return [section, ""];
      return [section, summary.slice(range.contentStart, range.contentEnd).trim()];
    }),
  ) as CompressionSummary["sections"];

  return sections;
}

function compressionFailureFromSnapshot(failure: CompressionFailureSnapshot): CompressionFailure {
  return {
    id: failure.id,
    reason: failure.reason,
    ...(failure.startRef === undefined ? {} : { startRef: failure.startRef as MessageRef }),
    ...(failure.endRef === undefined ? {} : { endRef: failure.endRef as MessageRef }),
    ...(failure.strategy === undefined ? {} : { strategy: failure.strategy }),
    failedAt: failure.failedAt,
  };
}

function compressionRefMapFromSnapshot(refMap: CompressionRefMapSnapshot): CompressionRefMap {
  return {
    messageRefsById: refMap.messageRefsById as Record<string, MessageRef>,
    messageIdsByRef: refMap.messageIdsByRef as Record<MessageRef, string>,
    blockRefsById: refMap.blockRefsById as Record<string, BlockRef>,
    blockIdsByRef: refMap.blockIdsByRef as Record<BlockRef, string>,
    nextMessageIndex: refMap.nextMessageIndex,
    nextBlockIndex: refMap.nextBlockIndex,
  };
}

function mergeCompressionRefMap(refMap: CompressionRefMap, block: CompressionBlockSnapshot): CompressionRefMap {
  return {
    ...refMap,
    messageRefsById: {
      ...refMap.messageRefsById,
      [block.range.startMessageId]: block.range.startRef as MessageRef,
      [block.range.endMessageId]: block.range.endRef as MessageRef,
    },
    messageIdsByRef: {
      ...refMap.messageIdsByRef,
      [block.range.startRef as MessageRef]: block.range.startMessageId,
      [block.range.endRef as MessageRef]: block.range.endMessageId,
    },
    blockRefsById: { ...refMap.blockRefsById, [block.id]: block.ref as BlockRef },
    blockIdsByRef: { ...refMap.blockIdsByRef, [block.ref as BlockRef]: block.id },
  };
}

function normalizeCompressionState(state: CompressionState): CompressionState {
  const blocks = Object.values(state.blocksByRef);
  return {
    ...state,
    activeBlockRefs: blocks.filter((block) => block.status === "active").map((block) => block.ref),
    inactiveBlockRefs: blocks.filter((block) => block.status === "inactive").map((block) => block.ref),
    supersededBlockRefs: blocks.filter((block) => block.status === "superseded").map((block) => block.ref),
  };
}

function mergeProtectedRefs(existing: readonly ProtectedRef[], next: readonly ProtectedRef[]): ProtectedRef[] {
  const merged = new Map<string, ProtectedRef>();
  for (const item of [...existing, ...next]) {
    merged.set(`${item.ref}:${item.kind}:${item.messageId ?? ""}:${item.partId ?? ""}`, item);
  }
  return [...merged.values()];
}

function validateTodos(todos: readonly SessionTodo[]): void {
  let inProgressCount = 0;

  for (const todo of todos) {
    if (!TODO_STATUSES.has(todo.status)) {
      throw new InvalidTodoStateError(
        `todo "${todo.id}" has invalid status "${String(todo.status)}"`,
      );
    }

    if (todo.status === "in_progress") {
      inProgressCount += 1;
    }
  }

  if (inProgressCount > 1) {
    throw new InvalidTodoStateError("only one todo can be in_progress");
  }
}
