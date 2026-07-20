import type {
  ChildResult,
  ChildResultReceipt,
  DelegationContract,
  SessionGoal,
  SessionGoalReviewReceipt,
} from "@archcode/protocol";
import { hashDelegationContract, validateChildResultAgainstContract } from "../delegation/contract";
import type { SessionStoreState } from "../store/types";
import { computeSourceFingerprint } from "./source-fingerprint";

export const RUNTIME_OBJECTIVE_CRITERION_ID = "runtime-objective-complete";

export interface GoalReviewBasis {
  readonly contract: DelegationContract;
  readonly contractHash: string;
  readonly sourceFingerprint: string;
}

export interface GoalReviewDecision {
  readonly verdict: "accepted" | "rejected";
  readonly summary: string;
  readonly result: ChildResult;
}

export class GoalReviewGate {
  async createBasis(cwd: string, goal: Pick<SessionGoal, "objective">): Promise<GoalReviewBasis> {
    const contract = buildGoalReviewContract(goal.objective);
    return {
      contract,
      contractHash: hashDelegationContract(contract),
      sourceFingerprint: await computeSourceFingerprint(cwd),
    };
  }

  async decide(input: {
    readonly cwd: string;
    readonly goal: SessionGoal;
    readonly reviewerSessionId: string;
    readonly reviewerExecutionId: string;
    readonly resultReceipt: ChildResultReceipt | undefined;
    /** Runtime-derived successful Reviewer tool receipts, keyed by canonical evidence ref. */
    readonly reviewerToolEvidence: ReadonlyMap<string, string>;
  }): Promise<GoalReviewDecision> {
    const review = input.goal.review;
    if (review?.phase !== "review_running") {
      return rejected(emptyFailedResult(), "The active review claim no longer exists");
    }
    const claim = review.claim;
    if (
      claim.instanceId !== input.goal.instanceId
      || claim.generation !== input.goal.generation
      || claim.userInputCursor !== input.goal.userInputCursor
      || claim.sourceMutationEpoch !== input.goal.sourceMutationEpoch
      || claim.reviewContractHash !== hashDelegationContract(claim.reviewContract)
      || review.reviewerSessionId !== input.reviewerSessionId
      || review.reviewerExecutionId !== input.reviewerExecutionId
    ) {
      return rejected(input.resultReceipt?.result ?? emptyFailedResult(), "The review basis was invalidated before completion");
    }

    const fingerprint = await computeSourceFingerprint(input.cwd);
    if (fingerprint !== claim.sourceFingerprint) {
      return rejected(input.resultReceipt?.result ?? emptyFailedResult(), "Reviewed source changed while the Reviewer was running");
    }
    if (
      input.resultReceipt === undefined
      || input.resultReceipt.executionId !== input.reviewerExecutionId
      || input.resultReceipt.delegationContractHash !== claim.reviewContractHash
    ) {
      return rejected(input.resultReceipt?.result ?? emptyFailedResult(), "Reviewer did not submit the canonical receipt for this attempt");
    }

    const result = input.resultReceipt.result;
    try {
      validateChildResultAgainstContract(result, claim.reviewContract);
    } catch (error) {
      return rejected(result, error instanceof Error ? error.message : "Reviewer result is invalid");
    }
    const evidenceFailure = goalReviewEvidenceFailure(result, input.reviewerToolEvidence);
    if (evidenceFailure !== undefined) return rejected(result, evidenceFailure);
    return { verdict: "accepted", summary: result.summary, result };
  }
}

/**
 * Checks the Runtime-only proof contract independently of the Reviewer's prose
 * verdict. A positive result must cite actual successful tool-call ids from
 * this Reviewer Session; tool names and human-readable aliases are not proof.
 */
export function goalReviewEvidenceFailure(
  result: ChildResult,
  reviewerToolEvidence: ReadonlyMap<string, string>,
): string | undefined {
  if (result.status !== "completed") return result.summary || "Reviewer did not complete the review";
  const runtimeCriterion = result.criteria.find((item) => item.id === RUNTIME_OBJECTIVE_CRITERION_ID);
  if (runtimeCriterion?.status !== "passed") return "Reviewer did not pass the complete Runtime objective criterion";
  if (runtimeCriterion.evidenceRefs.length === 0) return "Reviewer did not cite evidence for the complete Runtime objective criterion";

  const evidenceRefs = new Set(result.evidence.map((item) => item.ref.trim()).filter(Boolean));
  if (evidenceRefs.size === 0) return "Reviewer did not submit any evidence";
  for (const criterion of result.criteria) {
    for (const rawRef of criterion.evidenceRefs) {
      const ref = rawRef.trim();
      if (!evidenceRefs.has(ref)) return `Reviewer criterion cites undeclared evidence ref: ${ref}`;
      const toolName = reviewerToolEvidence.get(ref);
      if (toolName === undefined) return `Reviewer evidence ref is not a successful tool call from this review: ${ref}`;
      if (!CRITERION_EVIDENCE_TOOL_NAMES.has(toolName)) {
        return `Reviewer evidence ref uses a non-evidence tool: ${ref} (${toolName})`;
      }
    }
  }
  if (result.verification.length === 0) return "Reviewer did not run repeatable verification";
  for (const verification of result.verification) {
    const outputRef = verification.outputRef?.trim();
    if (verification.status !== "passed" || outputRef === undefined) {
      return `Reviewer verification did not pass with a tool output ref: ${verification.check}`;
    }
    const toolName = reviewerToolEvidence.get(outputRef);
    if (toolName === undefined) return `Reviewer verification ref is not a successful tool call from this review: ${outputRef}`;
    if (!VERIFICATION_TOOL_NAMES.has(toolName)) {
      return `Reviewer verification ref uses a non-verification tool: ${outputRef} (${toolName})`;
    }
  }
  if (result.unresolved.some((item) => item.blocking)) return "Reviewer reported a blocking unresolved issue";
  return undefined;
}

/** Canonical evidence namespace for one dedicated Runtime Reviewer Session. */
export function collectGoalReviewerToolEvidence(state: Readonly<SessionStoreState>): ReadonlyMap<string, string> {
  const evidence = new Map<string, string>();
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state !== "completed" || part.result.isError) continue;
      evidence.set(`tool:${part.toolCallId}`, part.toolName);
    }
  }
  return evidence;
}

export function buildGoalReviewContract(objective: string): DelegationContract {
  return {
    agent_type: "reviewer",
    title: "Verify Session Goal completion",
    objective: [
      "Independently inspect the actual workspace state and verify the complete Goal below.",
      "Do not modify source files. Use repeatable checks and submit one canonical child result.",
      "Evidence refs and verification outputRefs must use tool:<toolCallId> from successful tools in this dedicated Reviewer Session; invented or prose-only refs are rejected.",
      "Every outcome, constraint, and verification requirement in the single verbatim objective must be covered; omissions are failures.",
      "",
      "Authoritative objective (verbatim):",
      objective,
    ].join("\n"),
    owned_scope: [{ kind: "tree", path: "." }],
    non_goals: ["Changing source or weakening the authoritative objective"],
    acceptance_criteria: [{
      id: RUNTIME_OBJECTIVE_CRITERION_ID,
      condition: `Every objective requirement is satisfied without omission: ${objective}`,
      requiredEvidence: "Locatable source/diff evidence plus repeatable verification output covering the complete objective",
    }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
  };
}

export function isRuntimeGoalReviewContract(contract: DelegationContract): boolean {
  return contract.agent_type === "reviewer"
    && contract.acceptance_criteria.length === 1
    && contract.acceptance_criteria[0]?.id === RUNTIME_OBJECTIVE_CRITERION_ID;
}

const VERIFICATION_TOOL_NAMES = new Set(["bash", "lsp_diagnostics", "git_diff"]);
const CRITERION_EVIDENCE_TOOL_NAMES = new Set([
  "file_read",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "bash",
  "ast_grep_search",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "output_read",
  "output_search",
]);

export function toSessionGoalReviewReceipt(input: {
  readonly claimId: string;
  readonly attempt: number;
  readonly reviewerSessionId: string;
  readonly reviewerExecutionId: string;
  readonly decision: GoalReviewDecision;
  readonly decidedAt?: number;
}): SessionGoalReviewReceipt {
  return {
    claimId: input.claimId,
    attempt: input.attempt,
    reviewerSessionId: input.reviewerSessionId,
    reviewerExecutionId: input.reviewerExecutionId,
    verdict: input.decision.verdict,
    summary: input.decision.summary,
    result: input.decision.result,
    decidedAt: input.decidedAt ?? Date.now(),
  };
}

function rejected(result: ChildResult, summary: string): GoalReviewDecision {
  return { verdict: "rejected", summary, result };
}

function emptyFailedResult(): ChildResult {
  return {
    status: "failed",
    summary: "Review did not produce a valid result",
    deliverables: [],
    evidence: [],
    criteria: [{ id: RUNTIME_OBJECTIVE_CRITERION_ID, status: "unverified", evidenceRefs: [] }],
    verification: [],
    unresolved: [{ issue: "A fresh review attempt is required", blocking: true, nextOwner: "parent" }],
  };
}
