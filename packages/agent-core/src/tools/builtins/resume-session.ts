import { z } from "zod/v4";
import type { ChildExecutionHandle } from "../../delegation/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import {
  formatAsyncChildOutput,
  formatSyncChildOutput,
  waitForChildOutcome,
} from "./delegate";

export const ResumeSessionInputSchema = z.strictObject({
  session_id: z.string().trim().min(1).describe("Persisted id of an existing direct child Session"),
  task: z.string().trim().min(1).describe("Follow-up task for the existing child Session"),
  context: z.string().optional().describe("Optional context and verification requirements for the follow-up"),
  background: z.boolean().default(false).describe("true resumes asynchronously; false waits for the child result"),
});

export type ResumeSessionInput = z.infer<typeof ResumeSessionInputSchema>;

export async function executeResumeSession(input: ResumeSessionInput, ctx: ToolExecutionContext) {
  if (ctx.resumeChildSession === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_RESUME_SESSION_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child session resume is not available in this execution context",
      details: { ok: false, session_id: input.session_id },
    });
  }

  let handle: ChildExecutionHandle;
  try {
    handle = await ctx.resumeChildSession(ctx.projectContext.project.workspaceRoot, {
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentToolCallId: ctx.toolCallId,
      toolName: "resume_session",
      sessionId: input.session_id,
      prompt: buildResumePrompt(input),
      background: input.background ?? false,
      parentAbort: ctx.abort,
    });
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_RESUME_SESSION_FAILED",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
      details: {
        ok: false,
        session_id: input.session_id,
        error: { name: safeError.name, message: safeError.message },
      },
    });
  }

  if (input.background ?? false) return formatAsyncChildOutput(handle);
  return formatSyncChildOutput(handle, await waitForChildOutcome(handle));
}

function buildResumePrompt(input: ResumeSessionInput): string {
  const sections = [`Task:\n${input.task}`];
  if (input.context !== undefined && input.context.trim().length > 0) {
    sections.push(`Context:\n${input.context}`);
  }
  return sections.join("\n\n");
}

export const resumeSessionTool = defineTool({
  name: "resume_session",
  description:
    "Resume an existing persisted direct child Session with a follow-up task. The child's agent type, title, active Skills, depth, cwd, Goal identity, and permissions are derived from durable Session state and cannot be overridden.",
  inputSchema: ResumeSessionInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: executeResumeSession,
});
