import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import {
  ArtifactPathError,
  WorkflowArtifactWriteInputSchema,
  type WorkflowArtifactWriteInput,
} from "../../../agents/workflow/artifacts";
import { WorkflowPathError } from "../../../agents/workflow/state";

export function createArtifactWriteTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_write",
    description: "Write a workflow artifact and update artifact metadata without changing workflow stage or status.",
    inputSchema: WorkflowArtifactWriteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowArtifactWriteInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const result = await artifactManager.write(input);
        return JSON.stringify(result, null, 2);
      } catch (error) {
        if (error instanceof ArtifactPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_ARTIFACT_INVALID_PATH",
            message: error.message,
          });
        }
        if (error instanceof WorkflowPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_WORKFLOW_INVALID_ID",
            message: error.message,
          });
        }
        if (isNotFoundError(error)) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `Workflow not found: ${input.workflowId}`,
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

export { WorkflowArtifactWriteInputSchema };
