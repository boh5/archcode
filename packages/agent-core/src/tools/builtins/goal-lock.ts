import { z } from "zod/v4";
import { TOOL_GOAL_LOCK } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  GoalLockedError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
  GoalStateManager,
  GoalUuidSchema,
} from "../../goals";

const GoalLockInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID to lock."),
});

type GoalLockInput = z.infer<typeof GoalLockInputSchema>;

export function createGoalLockTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_LOCK,
    description: "Lock a draft Goal and record the current session as the locker.",
    inputSchema: GoalLockInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalLockInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const manager = new GoalStateManager(ctx.workspaceRoot);
        const lockedBy = ctx.store.getState().sessionId;
        const goal = await manager.lock(input.goalId, lockedBy);
        return JSON.stringify(goal, null, 2);
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
  if (error instanceof GoalStateError || error instanceof GoalLockedError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_TRANSITION", message: error.message });
  }
  if (error instanceof GoalPathError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_ID", message: error.message });
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

export { GoalLockInputSchema };
