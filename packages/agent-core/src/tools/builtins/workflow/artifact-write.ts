import { existsSync } from "node:fs";

import { defineTool } from "../../define-tool";
import { computeToolDiff, isProbablyBinaryText, MAX_DIFF_INPUT_CHARS } from "../../diff";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import { formatFrontmatter } from "../../../utils/frontmatter";
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
        const before = await readArtifactBeforeWrite(artifactManager, input);
        const result = await artifactManager.write(input);
        return {
          output: JSON.stringify(result, null, 2),
          isError: false,
          meta: {
            diffs: computeArtifactDiff({
              path: input.path,
              before,
              after: input.frontmatter ? formatFrontmatter(input.frontmatter, input.content) : input.content,
            }),
          },
        };
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

type ArtifactBeforeWrite =
  | { existed: false }
  | { existed: true; content: string };

async function readArtifactBeforeWrite(
  artifactManager: ToolExecutionContext["projectContext"]["artifacts"],
  input: WorkflowArtifactWriteInput,
): Promise<ArtifactBeforeWrite> {
  try {
    const existing = await artifactManager.read(input.workflowId, input.path);
    if (!existsSync(existing.absolutePath)) return { existed: false };
    return { existed: true, content: existing.content };
  } catch (error) {
    if (isNotFoundError(error)) return { existed: false };
    throw error;
  }
}

function computeArtifactDiff({
  path,
  before,
  after,
}: {
  path: string;
  before: ArtifactBeforeWrite;
  after: string;
}) {
  const previousContent = before.existed ? before.content : "";
  if (isProbablyBinaryText(previousContent) || isProbablyBinaryText(after)) {
    return { version: 1 as const, files: [], unsupportedReason: "binary" as const };
  }
  if (previousContent.length + after.length > MAX_DIFF_INPUT_CHARS) {
    return { version: 1 as const, files: [], unsupportedReason: "too_large" as const };
  }

  return computeToolDiff({
    path,
    before: previousContent,
    after,
    status: before.existed ? "modified" : "created",
  });
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export { WorkflowArtifactWriteInputSchema };
