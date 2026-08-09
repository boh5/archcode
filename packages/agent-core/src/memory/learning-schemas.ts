import { z } from "zod/v4";
import {
  MAX_MEMORY_EXTRACTION_CANDIDATES,
  MAX_MEMORY_PENDING_APPLY_BYTES,
  MAX_MEMORY_TOUCHED_FILES,
  type MemoryExtractionCandidate,
  type MemoryLearningState,
  type MemoryReconciliationOperation,
} from "./learning-state";
import { MemoryTopicTypeSchema } from "./schemas";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const topicNameSchema = z.string()
  .regex(/^[a-zA-Z0-9_]+$/)
  .max(200)
  .refine((name) => name !== "index" && name !== "preferences", "Reserved Memory topic name");
const targetSchema = z.strictObject({
  scope: z.enum(["user", "project"]),
  name: z.string().min(1).max(200),
});

const policyEpochSchema = z.strictObject({
  bootId: z.string().min(1).max(128),
  generation: z.number().int().nonnegative().safe(),
});

const pendingTargetSchema = z.strictObject({
  scope: z.enum(["user", "project"]),
  name: z.string().min(1).max(200),
  expectedRevision: sha256Schema.nullable(),
  finalRevision: sha256Schema,
  finalDocument: z.string(),
});

const pendingIndexSchema = z.strictObject({
  expectedRevision: sha256Schema.nullable(),
  finalRevision: sha256Schema,
  finalDocument: z.string(),
});

export const MemoryPendingApplyReceiptSchema = z.strictObject({
  id: z.string().min(1).max(128),
  captured: z.strictObject({
    processedThroughMessageId: z.string().min(1).nullable(),
    eligibleThroughMessageId: z.string().min(1),
    policyEpoch: policyEpochSchema,
  }),
  targets: z.array(pendingTargetSchema).min(1).max(MAX_MEMORY_TOUCHED_FILES),
  index: pendingIndexSchema.optional(),
  createdAt: z.number().int().nonnegative().safe(),
}).superRefine((receipt, ctx) => {
  const keys = receipt.targets.map((target) => `${target.scope}\0${target.name}`);
  const sorted = [...keys].sort();
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index])) {
    ctx.addIssue({ code: "custom", path: ["targets"], message: "Receipt targets must be unique and sorted" });
  }
  if (utf8Bytes(JSON.stringify(receipt)) > MAX_MEMORY_PENDING_APPLY_BYTES) {
    ctx.addIssue({ code: "custom", message: "Memory pending apply receipt exceeds its durable size limit" });
  }
});

export const MemoryLearningStateSchema: z.ZodType<MemoryLearningState> = z.strictObject({
  processedThroughMessageId: z.string().min(1).nullable(),
  eligibleThroughMessageId: z.string().min(1).optional(),
  idleSince: z.number().int().nonnegative().safe().optional(),
  blocked: z.strictObject({
    code: z.enum([
      "input_budget",
      "reconciliation_budget",
      "read_failed",
      "llm_failed",
      "schema_failed",
      "capacity",
      "revision_conflict",
      "apply_failed",
    ]),
    blockedAt: z.number().int().nonnegative().safe(),
    target: targetSchema.optional(),
  }).optional(),
  pendingApply: MemoryPendingApplyReceiptSchema.optional(),
});

const candidateBasis = z.enum(["explicit", "inferred"]);
const candidateIntent = z.enum(["add", "correct"]);
const candidateContent = z.string().trim().min(1).max(4_000);

const userCandidateSchema = z.strictObject({
  scope: z.literal("user"),
  target: z.literal("preferences"),
  content: candidateContent,
  basis: candidateBasis,
  intent: candidateIntent,
});

const projectCandidateSchema = z.strictObject({
  scope: z.literal("project"),
  target: topicNameSchema,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(300),
  type: MemoryTopicTypeSchema.exclude(["user"]),
  content: candidateContent,
  basis: candidateBasis,
  intent: candidateIntent,
});

export const MemoryExtractionResultSchema: z.ZodType<{
  candidates: MemoryExtractionCandidate[];
}> = z.strictObject({
  candidates: z.array(z.discriminatedUnion("scope", [
    userCandidateSchema,
    projectCandidateSchema,
  ])).max(MAX_MEMORY_EXTRACTION_CANDIDATES),
}).superRefine((result, ctx) => {
  const touched = new Set(result.candidates.map((candidate) => `${candidate.scope}\0${candidate.target}`));
  if (touched.size > MAX_MEMORY_TOUCHED_FILES) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "Extraction touches too many Memory files" });
  }
});

const operationTargetShape = {
  scope: z.enum(["user", "project"]),
  target: z.string().min(1).max(200),
};

const noopOperationSchema = z.strictObject({
  ...operationTargetShape,
  action: z.literal("NOOP"),
});

const addOperationSchema = z.strictObject({
  ...operationTargetShape,
  action: z.literal("ADD"),
  content: candidateContent,
});

const updateOperationSchema = z.strictObject({
  ...operationTargetShape,
  action: z.literal("UPDATE"),
  blockIds: z.array(z.number().int().positive().safe()).min(1).max(64)
    .refine((ids) => new Set(ids).size === ids.length, "UPDATE blockIds must be unique"),
  content: candidateContent,
});

export const MemoryReconciliationResultSchema: z.ZodType<{
  operations: MemoryReconciliationOperation[];
}> = z.strictObject({
  operations: z.array(z.discriminatedUnion("action", [
    noopOperationSchema,
    addOperationSchema,
    updateOperationSchema,
  ])).max(MAX_MEMORY_TOUCHED_FILES),
}).superRefine((result, ctx) => {
  const keys = result.operations.map((operation) => `${operation.scope}\0${operation.target}`);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", path: ["operations"], message: "Reconciliation targets must be unique" });
  }
});

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
