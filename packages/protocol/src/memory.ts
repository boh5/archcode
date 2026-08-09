export type MemoryTopicType = "user" | "feedback" | "project" | "reference";

export type MemoryCapacityState = "within-limit" | "at-limit" | "over-limit";

export type MemoryMutationPolicy = "normal" | "shrink-only";

export interface MemoryPolicy {
  readonly useMemory: boolean;
  readonly autoLearning: boolean;
}

export interface MemoryPolicyEpoch {
  readonly bootId: string;
  readonly generation: number;
}

/** Immutable policy claimed when a logical Execution first starts. */
export interface MemoryPolicySnapshot {
  readonly policy: MemoryPolicy;
  readonly epoch: MemoryPolicyEpoch;
}

export interface MemoryCapacity {
  readonly bytes: number;
  readonly maxBytes: number;
  readonly state: MemoryCapacityState;
  readonly mutationPolicy: MemoryMutationPolicy;
}

export interface MemoryPreferencesItem {
  readonly content: string;
  readonly revision: string;
  readonly capacity: MemoryCapacity;
  readonly availableForPrompt: boolean;
}

export interface MemoryTopicSummary {
  /** Stable file identifier used by memory_read and the topic HTTP route. */
  readonly name: string;
  /** Human-readable title stored in the topic frontmatter. */
  readonly title: string;
  readonly description: string;
  readonly type: MemoryTopicType;
  readonly revision: string;
  readonly capacity: MemoryCapacity;
}

export interface MemoryTopicItem extends MemoryTopicSummary {
  readonly content: string;
}

export interface MemoryTopicCount {
  readonly count: number;
  readonly max: number;
  readonly state: MemoryCapacityState;
  readonly canCreate: boolean;
}

export interface MemoryIndexStatus {
  readonly revision: string | null;
  readonly bytes: number;
  readonly topicCount: MemoryTopicCount;
  readonly availableForPrompt: boolean;
}

export type MemoryWarningCode =
  | "preferences_over_capacity"
  | "topic_over_capacity"
  | "topic_count_over_capacity"
  | "input_budget"
  | "reconciliation_budget"
  | "capacity"
  | "revision_conflict"
  | "read_failed"
  | "llm_failed"
  | "schema_failed"
  | "apply_failed";

export interface MemoryBlockedWarning {
  readonly code: MemoryWarningCode;
  readonly sessionId?: string;
  readonly blockedAt?: number;
  /** Safe logical target only; never an absolute path or Memory body. */
  readonly target?: string;
  readonly message: string;
}

export interface MemorySnapshot {
  readonly preferences: MemoryPreferencesItem | null;
  readonly topics: readonly MemoryTopicSummary[];
  readonly index: MemoryIndexStatus;
  readonly warnings: readonly MemoryBlockedWarning[];
}
