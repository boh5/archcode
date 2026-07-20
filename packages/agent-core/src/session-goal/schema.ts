import {
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  SESSION_GOAL_STATUSES,
} from "@archcode/protocol";
import { z } from "zod/v4";

const NON_EMPTY = z.string().trim().min(1);
const NON_NEGATIVE_SAFE_INT = z.number().int().nonnegative().safe();

export const SessionGoalObjectiveSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_GOAL_OBJECTIVE_MAX_LENGTH);

export const SessionGoalUsageSchema = z.strictObject({
  tokens: z.strictObject({
    inputTokens: NON_NEGATIVE_SAFE_INT,
    outputTokens: NON_NEGATIVE_SAFE_INT,
    totalTokens: NON_NEGATIVE_SAFE_INT,
    reasoningTokens: NON_NEGATIVE_SAFE_INT,
    cachedInputTokens: NON_NEGATIVE_SAFE_INT,
  }),
  executionTimeMs: NON_NEGATIVE_SAFE_INT,
  executionCount: NON_NEGATIVE_SAFE_INT,
});

export const SessionGoalSchema = z.strictObject({
  instanceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  objective: SessionGoalObjectiveSchema,
  status: z.enum(SESSION_GOAL_STATUSES),
  tokenBudget: z.number().int().positive().safe().optional(),
  usage: SessionGoalUsageSchema,
  blockedReason: NON_EMPTY.optional(),
  createdAt: NON_NEGATIVE_SAFE_INT,
  activatedAt: NON_NEGATIVE_SAFE_INT,
  updatedAt: NON_NEGATIVE_SAFE_INT,
  pausedAt: NON_NEGATIVE_SAFE_INT.optional(),
  completedAt: NON_NEGATIVE_SAFE_INT.optional(),
}).superRefine((goal, ctx) => {
  if (goal.usage.tokens.totalTokens !== goal.usage.tokens.inputTokens + goal.usage.tokens.outputTokens) {
    ctx.addIssue({ code: "custom", path: ["usage", "tokens", "totalTokens"], message: "totalTokens must equal inputTokens + outputTokens" });
  }
  if (goal.status === "paused" && goal.pausedAt === undefined) {
    ctx.addIssue({ code: "custom", path: ["pausedAt"], message: "pausedAt must exist while paused" });
  }
  if (goal.pausedAt !== undefined && goal.status !== "paused" && goal.status !== "budget_limited") {
    ctx.addIssue({ code: "custom", path: ["pausedAt"], message: "pausedAt is valid only while paused or budget limited" });
  }
  if ((goal.status === "complete") !== (goal.completedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must exist exactly while complete" });
  }
  if (goal.status === "blocked" && goal.blockedReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason must exist while blocked" });
  }
  if (goal.blockedReason !== undefined && goal.status !== "blocked" && goal.status !== "budget_limited") {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason is valid only while blocked or budget limited" });
  }
});

export type ParsedSessionGoal = z.output<typeof SessionGoalSchema>;
