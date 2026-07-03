import { z } from "zod/v4";
import { TOOL_GOAL_RUN } from "@archcode/protocol";

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

const GoalRunInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID to start running."),
});

type GoalRunInput = z.infer<typeof GoalRunInputSchema>;

export function createGoalRunTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_RUN,
    description: "Transition a locked Goal to running and record the main session id.",
    inputSchema: GoalRunInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalRunInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const currentSessionId = ctx.store.getState().sessionId;
        const runner = new GoalRunner({
          goalStateManager: ctx.projectContext.goalState,
          goalArtifacts: ctx.projectContext.goalArtifacts,
          hitlService: ctx.projectContext.hitl,
          workspaceRoot: ctx.workspaceRoot,
          createSession: async () => currentSessionId,
        });
        const goal = await runner.claimStart(input.goalId, currentSessionId);
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

export { GoalRunInputSchema };
