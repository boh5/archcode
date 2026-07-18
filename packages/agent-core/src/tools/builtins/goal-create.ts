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
  objective: GoalTextSchema.max(8_000).describe("Exact confirmed Goal objective. Non-empty; max 8000 characters."),
  acceptanceCriteria: GoalTextSchema.max(8_000).describe("Exact confirmed, unambiguous completion criteria used by the Reviewer; include the observable evidence or outcomes that prove completion. Non-empty; max 8000 characters."),
  useWorktree: z.boolean().optional()
    .describe("true executes the Goal in a dedicated managed Git worktree; false or omitted uses the project workspace."),
});

type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;

export const goalCreateTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_CREATE,
  description: "Commit and activate a durable Goal immediately, only after the user explicitly requests or accepts Goal creation and the goal-create Skill has obtained a separate confirmation of the complete objective, acceptance criteria, and worktree choice. Do not infer Goal creation from an ordinary long or complex task. A material change after confirmation requires confirmation again. This tool is available only to an unbound ordinary Engineer root Session; provenance is derived from that Session. User confirmation is a model-visible Skill protocol, while runtime authorization separately enforces the Session boundary.",
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
