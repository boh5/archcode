import { z } from "zod/v4";
import { SKILL_NAME_REGEX } from "../skills/schema";

const NON_EMPTY = z.string().trim().min(1);
const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const ScopeRefSchema = z.strictObject({
  kind: z.enum(["file", "tree"]),
  path: NON_EMPTY,
});

export const AcceptanceCriterionSchema = z.strictObject({
  id: NON_EMPTY,
  condition: NON_EMPTY,
  requiredEvidence: NON_EMPTY,
});

export const DelegationEvidenceSchema = z.strictObject({
  claim: NON_EMPTY,
  ref: NON_EMPTY,
});

export const DelegationVerificationSchema = z.strictObject({
  command: NON_EMPTY,
  expected: NON_EMPTY,
});

export const DelegationContractSchema = z.strictObject({
  agent_type: z.enum(["plan", "build", "reviewer", "explore", "librarian"]),
  title: NON_EMPTY,
  objective: NON_EMPTY,
  owned_scope: z.array(ScopeRefSchema),
  non_goals: z.array(NON_EMPTY),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).superRefine((criteria, ctx) => {
    const ids = criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "acceptance_criteria ids must be unique" });
    }
  }),
  evidence: z.array(DelegationEvidenceSchema),
  verification: z.array(DelegationVerificationSchema),
  depends_on: z.array(NON_EMPTY),
  skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)),
  background: z.boolean().default(false),
});

export const ChildResultDeliverableSchema = z.strictObject({
  type: NON_EMPTY,
  ref: NON_EMPTY,
  description: NON_EMPTY,
});

export const ChildResultEvidenceSchema = z.strictObject({
  claim: NON_EMPTY,
  ref: NON_EMPTY,
});

export const ChildResultCriterionSchema = z.strictObject({
  id: NON_EMPTY,
  status: z.enum(["passed", "failed", "unverified"]),
  evidenceRefs: z.array(NON_EMPTY),
});

export const ChildResultVerificationSchema = z.strictObject({
  check: NON_EMPTY,
  status: z.enum(["passed", "failed", "not_run"]),
  outputRef: NON_EMPTY.optional(),
});

export const ChildResultUnresolvedSchema = z.strictObject({
  issue: NON_EMPTY,
  blocking: z.boolean(),
  nextOwner: z.enum(["parent", "user", "external"]),
});

export const ChildResultSchema = z.strictObject({
  status: z.enum(["completed", "partial", "blocked", "failed"]),
  summary: NON_EMPTY,
  deliverables: z.array(ChildResultDeliverableSchema),
  evidence: z.array(ChildResultEvidenceSchema),
  criteria: z.array(ChildResultCriterionSchema).superRefine((criteria, ctx) => {
    const ids = criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "criteria ids must be unique" });
    }
  }),
  verification: z.array(ChildResultVerificationSchema),
  unresolved: z.array(ChildResultUnresolvedSchema),
});

export const ChildResultReceiptSchema = z.strictObject({
  executionId: NON_EMPTY,
  delegationContractHash: NON_EMPTY,
  submittedAt: z.number().finite(),
  result: ChildResultSchema,
});

export type DelegationContractInput = z.input<typeof DelegationContractSchema>;
export type ParsedDelegationContract = z.output<typeof DelegationContractSchema>;
export type ParsedChildResult = z.output<typeof ChildResultSchema>;
