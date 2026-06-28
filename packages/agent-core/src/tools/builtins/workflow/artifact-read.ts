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
  workflowId: WorkflowUuidSchema.describe("The workflow id (uuid) owning the artifact"),
  kind: WorkflowArtifactKindSchema.optional().describe("Artifact kind. Single-file: RESEARCH, PRD, SPEC, TASKS, HANDOFF_SUMMARY, INTERACTIONS, FINAL_REPORT. Multi-file: CRITIC_REPORT, EVIDENCE."),
  path: z.string().min(1).optional().describe("For multi-file artifacts: a real path returned by a prior artifact_read call. Do not invent paths."),
  maxChars: z.number().int().positive().optional().default(4000).describe("Maximum artifact body characters to return unless includeFullContent is true."),
  includeFullContent: z.boolean().optional().default(false).describe("Set true to return the complete artifact body/content without truncation metadata."),
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
    description: "Read a same-project workflow artifact. For multi-file artifacts (CRITIC_REPORT, EVIDENCE), first call with workflowId+kind to list paths, then call again with workflowId+path to read an entry.",
    inputSchema: ArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: ArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const kind = input.kind;
        if (input.path) {
          const artifact = await artifactManager.read(input.workflowId, input.path);
          return JSON.stringify(formatArtifactReadOutput(artifact, input), null, 2);
        }

        if (kind && isSingleFileWorkflowArtifactKind(kind)) {
          const artifact = await artifactManager.readByKind(input.workflowId, kind as SingleFileWorkflowArtifactKind);
          return JSON.stringify(formatArtifactReadOutput(artifact, input), null, 2);
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

function formatArtifactReadOutput(
  artifact: Awaited<ReturnType<ToolExecutionContext["projectContext"]["artifacts"]["read"]>>,
  input: ArtifactReadInput,
) {
  if (input.includeFullContent) {
    return {
      path: artifact.path,
      content: artifact.content,
      frontmatter: artifact.frontmatter,
      body: artifact.body,
    };
  }

  const bodyChars = artifact.body.length;
  const body = artifact.body.slice(0, input.maxChars);
  const truncated = bodyChars > body.length;

  return {
    path: artifact.path,
    content: truncated ? body : artifact.content,
    frontmatter: artifact.frontmatter,
    body,
    truncated,
    bodyChars,
    returnedBodyChars: body.length,
    ...(truncated
      ? { fullContentRequestHint: "Call artifact_read again with includeFullContent: true to read the full content." }
      : {}),
  };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { ArtifactReadInputSchema };
