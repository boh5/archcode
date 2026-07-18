/** Canonical workspace-relative ownership reference carried by a delegation contract. */
export interface ScopeRef {
  kind: "file" | "tree";
  path: string;
}

/** One independently checkable condition for accepting delegated work. */
export interface AcceptanceCriterion {
  id: string;
  condition: string;
  requiredEvidence: string;
}

export interface DelegationEvidence {
  claim: string;
  ref: string;
}

export interface DelegationVerification {
  command: string;
  expected: string;
}

export type DelegatedAgentType = "plan" | "build" | "reviewer" | "explore" | "librarian";

/**
 * Durable V2 parent-to-child handoff. Field names intentionally match the
 * model-visible delegate tool contract so no compatibility translation exists.
 */
export interface DelegationContract {
  agent_type: DelegatedAgentType;
  title: string;
  objective: string;
  owned_scope: ScopeRef[];
  non_goals: string[];
  acceptance_criteria: AcceptanceCriterion[];
  evidence: DelegationEvidence[];
  verification: DelegationVerification[];
  depends_on: string[];
  skills: string[];
  background: boolean;
}

export type ChildResultStatus = "completed" | "partial" | "blocked" | "failed";

export interface ChildResultDeliverable {
  type: string;
  ref: string;
  description: string;
}

export interface ChildResultEvidence {
  claim: string;
  ref: string;
}

export interface ChildResultCriterion {
  id: string;
  status: "passed" | "failed" | "unverified";
  evidenceRefs: string[];
}

export type ChildResultVerificationStatus = "passed" | "failed" | "not_run";

export interface ChildResultVerification {
  check: string;
  status: ChildResultVerificationStatus;
  outputRef?: string;
}

export interface ChildResultUnresolved {
  issue: string;
  blocking: boolean;
  nextOwner: "parent" | "user" | "external";
}

/** Canonical child-to-parent task result. This is distinct from execution status. */
export interface ChildResult {
  status: ChildResultStatus;
  summary: string;
  deliverables: ChildResultDeliverable[];
  evidence: ChildResultEvidence[];
  criteria: ChildResultCriterion[];
  verification: ChildResultVerification[];
  unresolved: ChildResultUnresolved[];
}

/** Runtime-minted receipt binding one result to one child execution and contract. */
export interface ChildResultReceipt {
  executionId: string;
  delegationContractHash: string;
  submittedAt: number;
  result: ChildResult;
}
