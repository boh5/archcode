import { z } from "zod/v4";
import { TOOL_GOAL_EVIDENCE } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { evaluateCondition } from "../../goals/done-checker";
import { assertGoalReviewerDoneAuthorized } from "../../goals/runner";
import { GoalUuidSchema } from "../../goals/state";
import {
  createGoalRunnerFromContext,
  extractGoalToolAuthorization,
  formatDoneResult,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalEvidenceCheckDoneInputSchema = z.strictObject({
  action: z.literal("check_done"),
  goalId: GoalUuidSchema.describe("Goal UUID whose Done Condition should be checked."),
  conditionId: z.string().trim().min(1).describe("Done Condition id within the Goal."),
});

const GoalEvidenceInputSchema = z.discriminatedUnion("action", [GoalEvidenceCheckDoneInputSchema]);

type GoalEvidenceInput = z.infer<typeof GoalEvidenceInputSchema>;

export const goalEvidenceTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_EVIDENCE,
  description: "Evaluate one Goal Done Condition and persist canonical Reviewer evidence.",
  inputSchema: GoalEvidenceInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input: GoalEvidenceInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
    try {
      const manager = ctx.projectContext.goalState;
      const runner = createGoalRunnerFromContext(ctx);
      const goal = await manager.read(input.goalId);
      const authorization = extractGoalToolAuthorization(ctx);

      assertGoalReviewerDoneAuthorized(goal, authorization);

      const condition = goal.doneConditions.find((candidate) => candidate.id === input.conditionId);
      if (!condition) {
        return createToolErrorResult({
          kind: "workspace",
          code: "GOAL_CONDITION_NOT_FOUND",
          message: `Done condition not found: ${input.conditionId}`,
        });
      }

      const result = await evaluateCondition(condition, ctx.workspaceRoot, {
        ...(ctx.confirmPermission ? { confirmPermission: ctx.confirmPermission } : {}),
        abort: ctx.abort,
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
      });
      await runner.recordAuthorizedReviewerDoneResult(input.goalId, input.conditionId, result, authorization);
      return formatDoneResult(result);
    } catch (error) {
      return goalToolErrorResult(error, { runnerErrorCode: "GOAL_REVIEW_PHASE_REQUIRED" });
    }
  },
});

export { GoalEvidenceInputSchema };
