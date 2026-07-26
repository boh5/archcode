import {
  SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH,
  SESSION_GOAL_NOTICE_ACTIONS,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  SESSION_GOAL_STATUSES,
} from "@archcode/protocol";
import { z } from "zod/v4";

const NON_NEGATIVE_SAFE_INT = z.number().int().nonnegative().safe();

export const SessionGoalObjectiveSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_GOAL_OBJECTIVE_MAX_LENGTH);

export const SessionGoalBlockedReasonSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH);

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
  blockedReason: SessionGoalBlockedReasonSchema.optional(),
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

export const SessionGoalNoticeSnapshotSchema = z.strictObject({
  objective: SessionGoalObjectiveSchema,
  status: z.enum(SESSION_GOAL_STATUSES),
  tokenBudget: z.number().int().positive().safe().optional(),
  blockedReason: SessionGoalBlockedReasonSchema.optional(),
}).superRefine((goal, ctx) => {
  if (goal.status === "blocked" && goal.blockedReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason must exist while blocked" });
  }
  if (goal.blockedReason !== undefined && goal.status !== "blocked" && goal.status !== "budget_limited") {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason is valid only while blocked or budget limited" });
  }
});

export const GoalNoticePartSchema = z.strictObject({
  type: z.literal("goal-notice"),
  id: z.string().uuid(),
  action: z.enum(SESSION_GOAL_NOTICE_ACTIONS),
  authority: z.enum(["user_control", "agent", "runtime"]),
  instanceId: z.string().uuid(),
  previousGeneration: z.number().int().positive().safe().optional(),
  generation: z.number().int().positive().safe(),
  goal: SessionGoalNoticeSnapshotSchema.nullable(),
  createdAt: NON_NEGATIVE_SAFE_INT,
}).superRefine((notice, ctx) => {
  if ((notice.action === "edited") !== (notice.previousGeneration !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["previousGeneration"],
      message: "previousGeneration must exist exactly for edited notices",
    });
  }
  if (notice.action === "edited"
    && notice.previousGeneration !== undefined
    && notice.generation !== notice.previousGeneration + 1) {
    ctx.addIssue({
      code: "custom",
      path: ["generation"],
      message: "edited notice generation must increment previousGeneration by one",
    });
  }
  if (notice.action === "created" && notice.generation !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["generation"],
      message: "created notice generation must be one",
    });
  }
  if ((notice.action === "cleared") !== (notice.goal === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["goal"],
      message: "goal must be null exactly for cleared notices",
    });
  }
  if (notice.goal !== null) {
    const allowedStatuses = notice.action === "created" || notice.action === "resumed"
      ? ["active"]
      : notice.action === "paused"
        ? ["paused", "budget_limited"]
        : notice.action === "budget_limited"
          ? ["budget_limited"]
          : notice.action === "blocked"
            ? ["blocked"]
            : notice.action === "completed"
              ? ["complete"]
              : SESSION_GOAL_STATUSES;
    if (!allowedStatuses.includes(notice.goal.status)) {
      ctx.addIssue({
        code: "custom",
        path: ["goal", "status"],
        message: `${notice.action} notice cannot carry ${notice.goal.status} status`,
      });
    }
  }
  const expectedAuthority = notice.action === "budget_limited"
    ? "runtime"
    : notice.action === "blocked" || notice.action === "completed"
      ? "agent"
      : "user_control";
  if (notice.authority !== expectedAuthority) {
    ctx.addIssue({
      code: "custom",
      path: ["authority"],
      message: `${notice.action} notices require ${expectedAuthority} authority`,
    });
  }
});

export type ParsedSessionGoal = z.output<typeof SessionGoalSchema>;
