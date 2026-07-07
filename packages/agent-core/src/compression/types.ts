import type {
  COMPRESSION_BLOCK_STATUSES,
  COMPRESSION_STRATEGIES,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  COMPRESSION_TRIGGERS,
  DCP_PARITY_ITEMS,
  PROTECTED_CONTENT_KINDS,
} from "./constants";

export type MessageRef = `m${string}`;
export type BlockRef = `b${number}`;

export type CompressionStrategy = (typeof COMPRESSION_STRATEGIES)[number];
export type CompressionTrigger = (typeof COMPRESSION_TRIGGERS)[number];
export type CompressionBlockStatus = (typeof COMPRESSION_BLOCK_STATUSES)[number];
export type CompressionSummarySectionName = (typeof COMPRESSION_SUMMARY_SECTION_NAMES)[number];
export type ProtectedContentKind = (typeof PROTECTED_CONTENT_KINDS)[number];
export type DcpParityItem = (typeof DCP_PARITY_ITEMS)[number];

export interface CompressionRefMap {
  readonly messageRefsById: Record<string, MessageRef>;
  readonly messageIdsByRef: Record<MessageRef, string>;
  readonly blockRefsById: Record<string, BlockRef>;
  readonly blockIdsByRef: Record<BlockRef, string>;
  readonly nextMessageIndex: number;
  readonly nextBlockIndex: number;
}

export interface CompressionRange {
  readonly startMessageId: string;
  readonly endMessageId: string;
  readonly startRef: MessageRef;
  readonly endRef: MessageRef;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface CompressionTokenEstimate {
  readonly originalTokens: number;
  readonly summaryTokens: number;
  readonly savedTokens: number;
  readonly estimatedAt: number;
}

export interface ProtectedRef {
  readonly ref: MessageRef | BlockRef;
  readonly kind: ProtectedContentKind;
  readonly reason: string;
  readonly messageId?: string;
  readonly partId?: string;
}

export type CompressionSummarySections = Record<CompressionSummarySectionName, string>;

export interface CompressionSummary {
  readonly version: 1;
  readonly sections: CompressionSummarySections;
  readonly childBlockRefs: BlockRef[];
}

export interface CompressionBlock {
  readonly id: string;
  readonly ref: BlockRef;
  readonly status: CompressionBlockStatus;
  readonly strategy: CompressionStrategy;
  readonly trigger: CompressionTrigger;
  readonly range: CompressionRange;
  readonly summary: CompressionSummary;
  readonly protectedRefs: ProtectedRef[];
  readonly childBlockRefs: BlockRef[];
  readonly tokenEstimate?: CompressionTokenEstimate;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deactivatedAt?: number;
  readonly supersededBy?: BlockRef;
}

export interface CompressionFailure {
  readonly id: string;
  readonly reason: string;
  readonly startRef?: MessageRef;
  readonly endRef?: MessageRef;
  readonly strategy?: CompressionStrategy;
  readonly failedAt: number;
}

export interface CompressionCoverage {
  readonly activeBlockRefs: BlockRef[];
  readonly coveredMessageRefs: MessageRef[];
  readonly protectedRefs: ProtectedRef[];
}

export interface CompressionState {
  readonly version: 1;
  readonly refMap: CompressionRefMap;
  readonly blocksByRef: Record<BlockRef, CompressionBlock>;
  readonly activeBlockRefs: BlockRef[];
  readonly inactiveBlockRefs: BlockRef[];
  readonly supersededBlockRefs: BlockRef[];
  readonly protectedRefs: ProtectedRef[];
  readonly failures: CompressionFailure[];
  readonly updatedAt?: number;
}

export interface CompressionBlockDraft {
  readonly id: string;
  readonly canonicalBlockId: string;
  readonly strategy: CompressionStrategy;
  readonly trigger: CompressionTrigger;
  readonly range: CompressionRange;
  readonly summary: CompressionSummary;
  readonly protectedRefs?: ProtectedRef[];
  readonly childBlockRefs?: BlockRef[];
  readonly tokenEstimate?: CompressionTokenEstimate;
  readonly createdAt: number;
}

export interface CompressionDcpParityEntry {
  readonly item: DcpParityItem;
  readonly coveredBy: string;
  readonly status: "contract_defined";
}
