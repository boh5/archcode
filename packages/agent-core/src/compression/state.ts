import { COMPRESSION_STATE_VERSION } from "./constants";
import { rangeContains, rangesPartiallyOverlap } from "./coverage";
import { createEmptyCompressionRefMap, ensureBlockRef } from "./refs";
import { assertValidCompressionSummary } from "./summary";
import type { BlockRef, CompressionBlock, CompressionBlockDraft, CompressionState } from "./types";

export class CompressionStateError extends Error {
  constructor(
    public readonly code: "partial_active_overlap" | "nested_child_missing" | "unknown_child_block" | "child_not_active",
    message: string,
  ) {
    super(message);
    this.name = "CompressionStateError";
  }
}

export function createEmptyCompressionState(): CompressionState {
  return {
    version: COMPRESSION_STATE_VERSION,
    refMap: createEmptyCompressionRefMap(),
    blocksByRef: {},
    activeBlockRefs: [],
    inactiveBlockRefs: [],
    supersededBlockRefs: [],
    protectedRefs: [],
    failures: [],
  };
}

export function commitCompressionBlock(state: CompressionState, draft: CompressionBlockDraft): CompressionState {
  validateCompressionBlockDraft(state, draft);

  const blockRefResult = ensureBlockRef(state.refMap, draft.canonicalBlockId);
  const ref = blockRefResult.ref;
  const childBlockRefs = draft.childBlockRefs ?? [];
  assertValidCompressionSummary(draft.summary, childBlockRefs);

  const timestamp = draft.createdAt;
  const childRefsToSupersede = new Set(childBlockRefs);
  const nextBlocksByRef: CompressionState["blocksByRef"] = {};

  for (const [existingRef, block] of Object.entries(state.blocksByRef) as Array<[BlockRef, CompressionBlock]>) {
    if (childRefsToSupersede.has(existingRef)) {
      nextBlocksByRef[existingRef] = {
        ...block,
        status: "superseded",
        supersededBy: ref,
        deactivatedAt: timestamp,
        updatedAt: timestamp,
      };
    } else {
      nextBlocksByRef[existingRef] = block;
    }
  }

  const block: CompressionBlock = {
    id: draft.id,
    ref,
    status: "active",
    strategy: draft.strategy,
    trigger: draft.trigger,
    range: draft.range,
    summary: draft.summary,
    protectedRefs: draft.protectedRefs ?? [],
    childBlockRefs,
    ...(draft.tokenEstimate ? { tokenEstimate: draft.tokenEstimate } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  nextBlocksByRef[ref] = block;

  return normalizeCompressionState({
    ...state,
    refMap: blockRefResult.refMap,
    blocksByRef: nextBlocksByRef,
    protectedRefs: mergeProtectedRefs(state.protectedRefs, block.protectedRefs),
    updatedAt: timestamp,
  });
}

export function recordCompressionFailure(
  state: CompressionState,
  failure: CompressionState["failures"][number],
): CompressionState {
  return { ...state, failures: [...state.failures, failure], updatedAt: failure.failedAt };
}

export function validateCompressionBlockDraft(state: CompressionState, draft: CompressionBlockDraft): void {
  const childRefs = new Set(draft.childBlockRefs ?? []);
  for (const childRef of childRefs) {
    const child = state.blocksByRef[childRef];
    if (!child) {
      throw new CompressionStateError("unknown_child_block", `Unknown child block ${childRef}`);
    }
    if (child.status !== "active") {
      throw new CompressionStateError("child_not_active", `Child block ${childRef} is not active`);
    }
    if (!rangeContains(draft.range, child.range)) {
      throw new CompressionStateError("partial_active_overlap", `Child block ${childRef} is not fully covered`);
    }
  }

  for (const activeRef of state.activeBlockRefs) {
    const activeBlock = state.blocksByRef[activeRef];
    if (!activeBlock) continue;
    if (!rangesOverlapOrContain(draft, activeBlock)) continue;

    if (rangesPartiallyOverlap(draft.range, activeBlock.range)) {
      throw new CompressionStateError(
        "partial_active_overlap",
        `Draft range ${draft.range.startRef}-${draft.range.endRef} partially overlaps active block ${activeRef}`,
      );
    }

    if (rangeContains(draft.range, activeBlock.range)) {
      if (!childRefs.has(activeRef)) {
        throw new CompressionStateError(
          "nested_child_missing",
          `Nested compression must list active child block ${activeRef}`,
        );
      }
      continue;
    }

    throw new CompressionStateError(
      "partial_active_overlap",
      `Draft range is inside active block ${activeRef}; V1 only allows consuming whole child blocks`,
    );
  }
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

function mergeProtectedRefs(
  existing: readonly CompressionState["protectedRefs"][number][],
  next: readonly CompressionState["protectedRefs"][number][],
): CompressionState["protectedRefs"] {
  const merged = new Map<string, CompressionState["protectedRefs"][number]>();
  for (const item of [...existing, ...next]) {
    merged.set(`${item.ref}:${item.kind}:${item.messageId ?? ""}:${item.partId ?? ""}`, item);
  }
  return [...merged.values()];
}

function rangesOverlapOrContain(draft: CompressionBlockDraft, block: CompressionBlock): boolean {
  return draft.range.startIndex <= block.range.endIndex && block.range.startIndex <= draft.range.endIndex;
}
