import { z } from "zod/v4";
import { TOOL_GOAL_RETRY } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  GoalRunner,
  GoalRunnerError,
  GoalLockedError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
  GoalUuidSchema,
} from "../../goals";

const GoalRetryInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID to retry from a fresh plan phase."),
});

type GoalRetryInput = z.infer<typeof GoalRetryInputSchema>;

export function createGoalRetryTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_RETRY,
    description: "Increment retry count, reset phase to plan, and transition the Goal back to running.",
    inputSchema: GoalRetryInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalRetryInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const runner = new GoalRunner({
          goalStateManager: ctx.projectContext.goalState,
          goalArtifacts: ctx.projectContext.goalArtifacts,
          hitlService: ctx.projectContext.hitl,
          workspaceRoot: ctx.workspaceRoot,
          createSession: async () => ctx.store.getState().sessionId,
        });
        const goal = await runner.handleFailedVerification(input.goalId, "Retry requested by goal_retry", {
          abort: ctx.abort,
        });
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
  if (error instanceof GoalRunnerError || error instanceof GoalStateError || error instanceof GoalLockedError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_TRANSITION", message: error.message });
  }
  if (error instanceof GoalPathError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_ID", message: error.message });
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

export { GoalRetryInputSchema };
