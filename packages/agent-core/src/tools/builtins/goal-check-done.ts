import { z } from "zod/v4";
import { TOOL_GOAL_CHECK_DONE } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  evaluateCondition,
  GoalInvalidIdError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
  GoalStateManager,
  GoalUuidSchema,
} from "../../goals";

const GoalCheckDoneInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID whose Done Condition should be checked."),
  conditionId: z.string().trim().min(1).describe("Done Condition id within the Goal."),
});

type GoalCheckDoneInput = z.infer<typeof GoalCheckDoneInputSchema>;

export function createGoalCheckDoneTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_CHECK_DONE,
    description: "Evaluate one Goal Done Condition and persist canonical Reviewer evidence.",
    inputSchema: GoalCheckDoneInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalCheckDoneInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const manager = new GoalStateManager(ctx.workspaceRoot);
        const goal = await manager.read(input.goalId);
        const condition = goal.doneConditions.find((candidate) => candidate.id === input.conditionId);
        if (!condition) {
          return createToolErrorResult({
            kind: "workspace",
            code: "GOAL_CONDITION_NOT_FOUND",
            message: `Done condition not found: ${input.conditionId}`,
          });
        }

        const result = await evaluateCondition(condition, ctx.workspaceRoot);
        await manager.recordDoneResult(input.goalId, input.conditionId, result);
        return JSON.stringify(result, null, 2);
      } catch (error) {
        return goalToolErrorResult(error);
      }
    },
  });
}

function goalToolErrorResult(error: unknown): ToolExecutionResult {
  if (error instanceof GoalNotFoundError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_NOT_FOUND", message: error.message });
  }
  if (error instanceof GoalStateError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_TRANSITION", message: error.message });
  }
  if (error instanceof GoalPathError || error instanceof GoalInvalidIdError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_ID", message: error.message });
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

export { GoalCheckDoneInputSchema };
