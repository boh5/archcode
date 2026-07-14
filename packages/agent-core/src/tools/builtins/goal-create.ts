import { z } from "zod/v4";
import { TOOL_GOAL_CREATE } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  assertGoalCreateAuthorized,
  formatGoalToolResult,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalTextSchema = z.string().trim().min(1);

export const GoalCreateInputSchema = z.strictObject({
  objective: GoalTextSchema.max(8_000).describe("Confirmed natural-language objective for the committed Goal."),
  acceptanceCriteria: GoalTextSchema.max(8_000).describe("Natural-language acceptance criteria for Reviewer judgment."),
  useWorktree: z.boolean().optional()
    .describe("Whether this Goal should execute in a dedicated managed Git worktree. Defaults to false."),
});

type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;

export const goalCreateTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_CREATE,
  description: "Commit and activate a confirmed Goal from an ordinary Engineer root Session.",
  inputSchema: GoalCreateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input: GoalCreateInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
    try {
      const source = assertGoalCreateAuthorized(ctx);
      const goal = await ctx.projectContext.goalLifecycle.create({
        projectSlug: ctx.projectContext.project.slug,
        createdFromSessionId: source.sessionId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        ...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
      });
      return formatGoalToolResult(goal);
    } catch (error) {
      return goalToolErrorResult(error);
    }
  },
});
