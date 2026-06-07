import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { ArtifactPathError } from "../../../agents/workflow/artifacts";
import { toggleTaskCheckbox } from "../../../agents/workflow/tasks-format";
import { WorkflowPathError, WorkflowUuidSchema } from "../../../agents/workflow/state";
import { guardCurrentWorkflow } from "./guard-current-workflow";

const TASKS_ARTIFACT_PATH = "TASKS.md";

const WorkflowTaskCheckInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  taskId: z.string().min(1),
  checked: z.boolean(),
});

type WorkflowTaskCheckInput = z.infer<typeof WorkflowTaskCheckInputSchema>;

export function createWorkflowTaskCheckTool(): AnyToolDescriptor {
  return defineTool({
    name: "workflow_task_check",
    description: "Toggle a top-level TASKS.md task checkbox by id, e.g. T1.",
    inputSchema: WorkflowTaskCheckInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowTaskCheckInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const stateManager = ctx.projectContext.workflowState;
      const artifactManager = ctx.projectContext.artifacts;
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, "workflow_task_check");
      if (guardResult) return guardResult;

      try {
        const state = await stateManager.read(input.workflowId);
        if (state.artifacts.TASKS !== undefined && state.artifacts.TASKS !== TASKS_ARTIFACT_PATH) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_WORKFLOW_TASKS_TARGET_INVALID",
            message: `workflow_task_check only supports ${TASKS_ARTIFACT_PATH}`,
          });
        }

        const artifact = await artifactManager.read(input.workflowId, TASKS_ARTIFACT_PATH);
        const updated = toggleTaskCheckbox(artifact.content, input.taskId, input.checked);
        await artifactManager.write({
          workflowId: input.workflowId,
          kind: "TASKS",
          path: TASKS_ARTIFACT_PATH,
          content: updated,
        });
        return `Updated ${input.taskId} in ${TASKS_ARTIFACT_PATH}`;
      } catch (error) {
        if (error instanceof WorkflowPathError || error instanceof ArtifactPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: error instanceof WorkflowPathError ? "TOOL_WORKFLOW_INVALID_ID" : "TOOL_ARTIFACT_INVALID_PATH",
            message: error.message,
          });
        }
        if (isNotFoundError(error)) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `TASKS.md not found for workflow: ${input.workflowId}`,
          });
        }
        return createToolErrorResult({
          kind: "execution",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  });
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { WorkflowTaskCheckInputSchema };
