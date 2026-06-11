import { existsSync } from "node:fs";

import { defineTool } from "../../define-tool";
import { computeToolDiff, isProbablyBinaryText, MAX_DIFF_INPUT_CHARS } from "../../diff";
import { createToolErrorResult } from "../../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../../types";
import {
  ArtifactPathError,
  WorkflowArtifactWriteInputSchema,
  type WorkflowArtifactWriteInput,
} from "../../../agents/workflow/artifacts";
import { emitWorkflowStateChange } from "../../../agents/workflow/events";
import { WorkflowPathError } from "../../../agents/workflow/state";
import { validateTasksMarkdown, type TasksValidationError } from "../../../agents/workflow/tasks-format";
import { guardCurrentWorkflow } from "./guard-current-workflow";

export function createArtifactWriteTool(): AnyToolDescriptor {
  return defineTool({
    name: "artifact_write",
    description: "Write a workflow artifact and update artifact metadata without changing workflow stage or status.",
    inputSchema: WorkflowArtifactWriteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: WorkflowArtifactWriteInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      const artifactManager = ctx.projectContext.artifacts;
      const guardResult = guardCurrentWorkflow(input.workflowId, ctx, "artifact_write");
      if (guardResult) return guardResult;

      try {
        const validationError = validateArtifactContentBeforeWrite(input);
        if (validationError) return validationError;

        const before = await readArtifactBeforeWrite(artifactManager, input);
        const result = await artifactManager.write(input, buildArtifactProvenance(ctx));
        const after = await artifactManager.readRaw(input.workflowId, input.path);
        emitWorkflowStateChange(ctx.store, input.workflowId, ["artifacts"]);
        return {
          output: JSON.stringify(result, null, 2),
          isError: false,
          meta: {
            diffs: computeArtifactDiff({
              path: input.path,
              before,
              after: after.content,
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

function validateArtifactContentBeforeWrite(input: WorkflowArtifactWriteInput): ToolExecutionResult | undefined {
  if (input.kind !== "TASKS") return undefined;

  const validation = validateTasksMarkdown(input.content);
  if (validation.valid && validation.tasks.length > 0) return undefined;

  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_ARTIFACT_VALIDATION_FAILED",
    name: "WorkflowArtifactValidationError",
    message: `TASKS.md is invalid and was not written. ${formatTasksValidationSummary(validation.errors, validation.tasks.length)}`,
    details: {
      artifactKind: input.kind,
      path: input.path,
      taskCount: validation.tasks.length,
      errors: validation.errors,
    },
  });
}

function formatTasksValidationSummary(errors: readonly TasksValidationError[], taskCount: number): string {
  if (taskCount === 0 && errors.length === 0) return "TASKS.md must contain at least one top-level task.";
  if (errors.length === 0) return "TASKS.md must contain at least one top-level task.";
  return errors.slice(0, 5).map(formatTasksValidationError).join("; ");
}

function formatTasksValidationError(error: TasksValidationError): string {
  const location = error.line ? `line ${error.line}: ` : "";
  return `${location}${error.message}`;
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
    if (error instanceof Error && error.message.includes("frontmatter")) {
      const existing = await artifactManager.readRaw(input.workflowId, input.path);
      if (!existsSync(existing.absolutePath)) return { existed: false };
      return { existed: true, content: existing.content };
    }
    if (isNotFoundError(error)) return { existed: false };
    throw error;
  }
}

function buildArtifactProvenance(ctx: ToolExecutionContext) {
  return {
    writerAgent: ctx.agentName,
    writerSessionId: ctx.store.getState().sessionId,
    toolCallId: ctx.toolCallId,
    writtenAt: new Date(ctx.startedAt).toISOString(),
  };
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
