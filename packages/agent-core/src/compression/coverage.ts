import type { BlockRef, CompressionBlock, CompressionCoverage, CompressionRange, MessageRef, ProtectedRef } from "./types";

export function rangeContains(outer: CompressionRange, inner: CompressionRange): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

export function rangesOverlap(first: CompressionRange, second: CompressionRange): boolean {
  return first.startIndex <= second.endIndex && second.startIndex <= first.endIndex;
}

export function rangesPartiallyOverlap(first: CompressionRange, second: CompressionRange): boolean {
  return rangesOverlap(first, second) && !rangeContains(first, second) && !rangeContains(second, first);
}

export function refsInRange(messageRefsInOrder: readonly MessageRef[], range: CompressionRange): MessageRef[] {
  return messageRefsInOrder.slice(range.startIndex, range.endIndex + 1);
}

export function computeCompressionCoverage(
  blocks: readonly CompressionBlock[],
  messageRefsInOrder: readonly MessageRef[],
  protectedRefs: readonly ProtectedRef[] = [],
): CompressionCoverage {
  const activeBlocks = blocks.filter((block) => block.status === "active");
  const covered = new Set<MessageRef>();

  for (const block of activeBlocks) {
    for (const ref of refsInRange(messageRefsInOrder, block.range)) {
      covered.add(ref);
    }
  }

  return {
    activeBlockRefs: activeBlocks.map((block) => block.ref),
    coveredMessageRefs: [...covered],
    protectedRefs: [...protectedRefs],
  };
}

export function activeBlocksByRef(blocksByRef: Record<BlockRef, CompressionBlock>): CompressionBlock[] {
  return Object.values(blocksByRef).filter((block) => block.status === "active");
}
