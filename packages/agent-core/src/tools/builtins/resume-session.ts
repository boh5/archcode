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
  session_id: z.string().trim().min(1).describe("Persisted id of an existing stopped direct child Session, copied from delegate, resume_session, or the child result"),
  task: z.string().trim().min(1).describe("Concrete follow-up task for the existing child, such as addressing one finding or answering one new question, based on its preserved context"),
  context: z.string().optional().describe("New evidence, changed constraints, and verification requirements for this follow-up; do not repeat the child's already-preserved history"),
  background: z.boolean().default(false).describe("true resumes asynchronously and later emits a terminal reminder; false waits for the child result and is the default"),
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
  description: [
    "Continue a stopped persisted direct child Session with one concrete follow-up while preserving its existing conversation and tool history. Use this instead of a new delegate when the follow-up depends on what that child already inspected, changed, or concluded.",
    "",
    "Example: `resume_session({\"session_id\":\"<session-id>\",\"task\":\"Address the review finding about timeout recovery and re-run the focused tests.\",\"context\":\"Keep the public schema unchanged and report the final test command and result.\",\"background\":false})`. Pass only new evidence or changed constraints in context; the existing history is already retained.",
    "",
    "The child's agent type, title, active Skills, depth, cwd, Goal identity, root family, and permissions come from durable Session state and cannot be overridden or widened. background=false waits for the next result. background=true returns immediately and uses the same reminder -> blocking background_output collection chain as delegate. A running child cannot be resumed.",
  ].join("\n"),
  inputSchema: ResumeSessionInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: executeResumeSession,
});
