import type { CompressionBlockRef } from "@archcode/protocol";
import type { SessionFile } from "../store/helpers";
import type { StoredMessage, StoredPart } from "../store/types";
import type { BlockRef, CompressionBlock, CompressionRange, CompressionStrategy, CompressionTrigger, MessageRef } from "./types";

export type OriginalRangePart = StoredPart;

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
  readonly reason: "missing_hybrid_coverage";
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
  const compression = session.compression;
  const block = isBlockRef(blockRef) ? compression.blocksByRef[blockRef] : undefined;

  if (block === undefined) {
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
      message: copyMessageForOriginalRange(message),
    };
  });
}

function copyMessageForOriginalRange(message: StoredMessage): OriginalRangeMessage {
  return {
    ...message,
    parts: message.parts.map(copyPartForOriginalRange),
  };
}

function copyPartForOriginalRange(part: StoredPart): OriginalRangePart {
  return structuredClone(part);
}

function isBlockRef(value: string): value is CompressionBlockRef & BlockRef {
  return /^b\d+$/.test(value);
}

function formatMessageRef(index: number): MessageRef {
  return `m${index.toString().padStart(4, "0")}`;
}
