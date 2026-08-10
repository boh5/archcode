import type { MemoryTopicType } from "./types";
import type { MemoryPolicyEpoch } from "./policy-runtime";

export type { MemoryPolicyEpoch } from "./policy-runtime";

export const MEMORY_IDLE_DELAY_MS = 10 * 60 * 1_000;
export const MAX_MEMORY_EXTRACTION_CANDIDATES = 8;
export const MAX_MEMORY_TOUCHED_FILES = 4;
export const MAX_MEMORY_EXTRACTION_INPUT_BYTES = 64 * 1_024;
export const MAX_MEMORY_RECONCILIATION_INPUT_BYTES = 64 * 1_024;
export const MAX_MEMORY_PENDING_APPLY_BYTES = 192 * 1_024;

export type MemoryLearningScope = "user" | "project";

export interface MemoryLearningTarget {
  readonly scope: MemoryLearningScope;
  readonly name: string;
}

export type MemoryLearningBlockedCode =
  | "input_budget"
  | "reconciliation_budget"
  | "read_failed"
  | "llm_failed"
  | "schema_failed"
  | "capacity"
  | "revision_conflict"
  | "apply_failed";

export interface MemoryLearningBlocked {
  readonly code: MemoryLearningBlockedCode;
  readonly blockedAt: number;
  readonly target?: MemoryLearningTarget;
}

export interface MemoryPendingApplyTarget extends MemoryLearningTarget {
  readonly expectedRevision: string | null;
  readonly finalRevision: string;
  /** Exact complete UTF-8 document to apply; topic documents include frontmatter. */
  readonly finalDocument: string;
}

export interface MemoryPendingApplyIndex {
  readonly expectedRevision: string | null;
  readonly finalRevision: string;
  readonly finalDocument: string;
}

export interface MemoryPendingApplyReceipt {
  readonly id: string;
  readonly captured: {
    readonly processedThroughMessageId: string | null;
    readonly eligibleThroughMessageId: string;
    readonly policyEpoch: MemoryPolicyEpoch;
  };
  readonly targets: readonly MemoryPendingApplyTarget[];
  readonly index?: MemoryPendingApplyIndex;
  readonly createdAt: number;
}

/** Durable, root-Session-owned learning checkpoint. */
export interface MemoryLearningState {
  readonly processedThroughMessageId: string | null;
  readonly eligibleThroughMessageId?: string;
  readonly idleSince?: number;
  readonly blocked?: MemoryLearningBlocked;
  readonly pendingApply?: MemoryPendingApplyReceipt;
}

export type MemoryExtractionCandidate =
  | {
      readonly scope: "user";
      readonly target: "preferences";
      readonly content: string;
      readonly basis: "explicit" | "inferred";
      readonly intent: "add" | "correct";
    }
  | {
      readonly scope: "project";
      readonly target: string;
      readonly title: string;
      readonly description: string;
      readonly type: Exclude<MemoryTopicType, "user">;
      readonly content: string;
      readonly basis: "explicit" | "inferred";
      readonly intent: "add" | "correct";
    };

export type MemoryReconciliationOperation =
  | {
      readonly scope: MemoryLearningScope;
      readonly target: string;
      readonly action: "NOOP";
    }
  | {
      readonly scope: MemoryLearningScope;
      readonly target: string;
      readonly action: "ADD";
      readonly content: string;
    }
  | {
      readonly scope: MemoryLearningScope;
      readonly target: string;
      readonly action: "UPDATE";
      readonly blockIds: readonly number[];
      readonly content: string;
    };
