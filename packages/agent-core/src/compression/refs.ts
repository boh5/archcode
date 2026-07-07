import type { BlockRef, CompressionRefMap, MessageRef } from "./types";

export function createEmptyCompressionRefMap(): CompressionRefMap {
  return {
    messageRefsById: {},
    messageIdsByRef: {},
    blockRefsById: {},
    blockIdsByRef: {},
    nextMessageIndex: 1,
    nextBlockIndex: 1,
  };
}

export function ensureMessageRef(
  refMap: CompressionRefMap,
  canonicalMessageId: string,
): { refMap: CompressionRefMap; ref: MessageRef } {
  const existing = refMap.messageRefsById[canonicalMessageId];
  if (existing) return { refMap, ref: existing };

  const ref = formatMessageRef(refMap.nextMessageIndex);
  return {
    ref,
    refMap: {
      ...refMap,
      messageRefsById: { ...refMap.messageRefsById, [canonicalMessageId]: ref },
      messageIdsByRef: { ...refMap.messageIdsByRef, [ref]: canonicalMessageId },
      nextMessageIndex: refMap.nextMessageIndex + 1,
    },
  };
}

export function ensureBlockRef(
  refMap: CompressionRefMap,
  canonicalBlockId: string,
): { refMap: CompressionRefMap; ref: BlockRef } {
  const existing = refMap.blockRefsById[canonicalBlockId];
  if (existing) return { refMap, ref: existing };

  const ref = formatBlockRef(refMap.nextBlockIndex);
  return {
    ref,
    refMap: {
      ...refMap,
      blockRefsById: { ...refMap.blockRefsById, [canonicalBlockId]: ref },
      blockIdsByRef: { ...refMap.blockIdsByRef, [ref]: canonicalBlockId },
      nextBlockIndex: refMap.nextBlockIndex + 1,
    },
  };
}

export function buildMessageRefMap(
  canonicalMessageIds: readonly string[],
  initialRefMap: CompressionRefMap = createEmptyCompressionRefMap(),
): CompressionRefMap {
  let refMap = initialRefMap;
  for (const id of canonicalMessageIds) {
    refMap = ensureMessageRef(refMap, id).refMap;
  }
  return refMap;
}

export function resolveMessageId(refMap: CompressionRefMap, ref: MessageRef): string | undefined {
  return refMap.messageIdsByRef[ref];
}

export function resolveBlockId(refMap: CompressionRefMap, ref: BlockRef): string | undefined {
  return refMap.blockIdsByRef[ref];
}

function formatMessageRef(index: number): MessageRef {
  return `m${index.toString().padStart(4, "0")}`;
}

function formatBlockRef(index: number): BlockRef {
  return `b${index}`;
}
