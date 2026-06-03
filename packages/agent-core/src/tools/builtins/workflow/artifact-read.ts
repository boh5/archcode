import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import {
  ArtifactPathError,
  SingleFileWorkflowArtifactKindSchema,
  VALID_ARTIFACT_KIND_LIST,
} from "../../../agents/workflow/artifacts";

const ArtifactReadInputSchema = z.strictObject({
  workflowId: z.string().min(1),
  kind: SingleFileWorkflowArtifactKindSchema.optional(),
  path: z.string().min(1).optional(),
}).superRefine((input, ctx) => {
  if (input.kind || input.path) return;

  ctx.addIssue({
    code: "custom",
    message: `Either kind or path is required. Core kind must be one of: ${SingleFileWorkflowArtifactKindSchema.options.join(", ")}. All artifact kinds: ${VALID_ARTIFACT_KIND_LIST}`,
  });
});

type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;

export function createArtifactReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_read",
    description: "Read a same-project workflow artifact by workflow id plus either a core single-file kind or contained artifact path.",
    inputSchema: ArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: ArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const artifact = input.kind
          ? await artifactManager.readByKind(input.workflowId, input.kind)
          : await artifactManager.read(input.workflowId, input.path as string);
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
            message: `Artifact not found: ${input.path ?? input.kind}`,
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
