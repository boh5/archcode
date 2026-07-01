import { z } from "zod/v4";
import { TOOL_GOAL_CREATE } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  ApprovalPointSchema,
  DoneConditionSchema,
  GoalPathError,
  GoalStateError,
  GoalStateManager,
  RetryPolicySchema,
} from "../../goals";

const GoalCreateInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).describe("Human-readable Goal title."),
  doneConditions: z.array(DoneConditionSchema).describe("Done Conditions that define Goal completion."),
  retryPolicy: RetryPolicySchema.describe("Retry limits and escalation policy for this Goal."),
  approvalPoints: z.array(ApprovalPointSchema).describe("Human approval checkpoints required by this Goal."),
  author: z.string().trim().min(1).describe("Author or source of the Goal contract."),
});

type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;

export function createGoalCreateTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_CREATE,
    description: "Create a draft Goal state for the current project.",
    inputSchema: GoalCreateInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalCreateInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const manager = new GoalStateManager(ctx.workspaceRoot);
        const goal = await manager.create(
          ctx.projectContext.project.slug,
          input.title,
          input.author,
          input.doneConditions,
          input.retryPolicy,
          input.approvalPoints,
        );
        return JSON.stringify(goal, null, 2);
      } catch (error) {
        return goalToolErrorResult(error);
      }
    },
  });
}

function goalToolErrorResult(error: unknown): ToolExecutionResult {
  if (error instanceof GoalPathError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_ID", message: error.message });
  }
  if (error instanceof GoalStateError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_TRANSITION", message: error.message });
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

export { GoalCreateInputSchema };
