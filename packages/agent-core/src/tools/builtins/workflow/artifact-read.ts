import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { ArtifactPathError } from "../../../agents/workflow/artifacts";

const ArtifactReadInputSchema = z.strictObject({
  workflowId: z.string().min(1),
  path: z.string().min(1),
});

type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;

export function createArtifactReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_read",
    description: "Read a workflow artifact by workflow id and artifact path.",
    inputSchema: ArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: ArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const artifact = await artifactManager.read(input.workflowId, input.path);
        return JSON.stringify(artifact, null, 2);
      } catch (error) {
        if (error instanceof ArtifactPathError) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_ARTIFACT_INVALID_PATH",
            message: error.message,
          });
        }
        if (isNotFoundError(error)) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `Artifact not found: ${input.path}`,
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

export { ArtifactReadInputSchema };
