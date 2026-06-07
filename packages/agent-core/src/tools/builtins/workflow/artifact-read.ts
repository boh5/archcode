import { z } from "zod/v4";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import {
  ArtifactPathError,
  SINGLE_FILE_ARTIFACT_KINDS,
  SingleFileWorkflowArtifactKind,
  SingleFileWorkflowArtifactKindSchema,
  VALID_ARTIFACT_KIND_LIST,
} from "../../../agents/workflow/artifacts";
import { WorkflowArtifactKindSchema, WorkflowUuidSchema } from "../../../agents/workflow/state";

const SINGLE_FILE_KIND_SET: ReadonlySet<string> = new Set(SINGLE_FILE_ARTIFACT_KINDS);

const ArtifactReadInputSchema = z.strictObject({
  workflowId: WorkflowUuidSchema,
  kind: WorkflowArtifactKindSchema.optional(),
  path: z.string().min(1).optional(),
}).superRefine((input, ctx) => {
  if (input.kind && !SINGLE_FILE_KIND_SET.has(input.kind)) {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: `${input.kind} is a multi-file artifact kind and cannot be read by kind. Use the path parameter instead (e.g., path: "critic-reports/report.md" for CRITIC_REPORT, path: "evidence/builder-output.md" for EVIDENCE). Single-file kinds: ${SingleFileWorkflowArtifactKindSchema.options.join(", ")}`,
    });
    return;
  }

  if (input.kind || input.path) return;

  ctx.addIssue({
    code: "custom",
    message: `Either kind or path is required. Single-file kinds (for kind param): ${SingleFileWorkflowArtifactKindSchema.options.join(", ")}. For CRITIC_REPORT and EVIDENCE (multi-file), use the path parameter instead (e.g., path: "critic-reports/report.md"). All artifact kinds: ${VALID_ARTIFACT_KIND_LIST}`,
  });
});

type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;

export function createArtifactReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_read",
    description: "Read a same-project workflow artifact by workflow id plus either a single-file kind or a contained artifact path. CRITIC_REPORT and EVIDENCE are multi-file artifacts — use the path parameter (e.g., path: 'critic-reports/report.md') instead of kind.",
    inputSchema: ArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: ArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      try {
        const kind = input.kind;
        if (kind && !SINGLE_FILE_KIND_SET.has(kind)) {
          return createToolErrorResult({
            kind: "workspace",
            code: "TOOL_SCHEMA_INVALID_INPUT",
            message: `${kind} cannot be read by kind. Use the path parameter instead.`,
          });
        }
        const artifact = kind
            ? await artifactManager.readByKind(input.workflowId, kind as SingleFileWorkflowArtifactKind)
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
