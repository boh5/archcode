import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import {
  ArtifactPathError,
  isMultiFileWorkflowArtifactKind,
  isSingleFileWorkflowArtifactKind,
  VALID_ARTIFACT_KIND_LIST,
  type SingleFileWorkflowArtifactKind,
} from "../../../agents/workflow/artifacts";
import { WorkflowArtifactKindSchema, WorkflowUuidSchema } from "../../../agents/workflow/state";

const ArtifactReadInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  kind: WorkflowArtifactKindSchema.optional(),
  path: z.string().min(1).optional(),
}).superRefine((input, ctx) => {
  if (input.kind || input.path) return;

  ctx.addIssue({
    code: "custom",
    message: `Either kind or path is required. Single-file artifacts can be read by kind. Multi-file artifact kinds list real paths by kind; read a specific entry by a returned path. All artifact kinds: ${VALID_ARTIFACT_KIND_LIST}`,
  });
});

type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;

export function createArtifactReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_read",
    description: "Read a same-project workflow artifact.\n\nSingle-file artifacts (RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT): pass workflowId and kind.\n\nMulti-file artifacts (CRITIC_REPORT, EVIDENCE): pass workflowId and kind to list real paths (returns {workflowId, kind, paths:[...]}), then pass workflowId and a returned path to read a specific entry. Do not invent paths.",
    inputSchema: ArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: ArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const kind = input.kind;
        if (input.path) {
          const artifact = await artifactManager.read(input.workflowId, input.path);
          return JSON.stringify(formatArtifactReadOutput(artifact), null, 2);
        }

        if (kind && isSingleFileWorkflowArtifactKind(kind)) {
          const artifact = await artifactManager.readByKind(input.workflowId, kind as SingleFileWorkflowArtifactKind);
          return JSON.stringify(formatArtifactReadOutput(artifact), null, 2);
        }

        if (kind && isMultiFileWorkflowArtifactKind(kind)) {
          const state = await ctx.projectContext.workflowState.read(input.workflowId);
          return JSON.stringify({
            workflowId: input.workflowId,
            kind,
            paths: artifactManager.listPathsByKind(state, kind),
          }, null, 2);
        }

        return createToolErrorResult({
          kind: "workspace",
          code: "TOOL_SCHEMA_INVALID_INPUT",
          message: `Unknown artifact kind. Valid kinds: ${VALID_ARTIFACT_KIND_LIST}`,
        });
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

function formatArtifactReadOutput(artifact: Awaited<ReturnType<ToolExecutionContext["projectContext"]["artifacts"]["read"]>>) {
  return {
    path: artifact.path,
    content: artifact.content,
    frontmatter: artifact.frontmatter,
    body: artifact.body,
  };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { ArtifactReadInputSchema };
