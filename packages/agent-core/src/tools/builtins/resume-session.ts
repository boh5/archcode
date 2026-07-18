import { z } from "zod/v4";
import type { ChildExecutionHandle } from "../../delegation/types";
import { DelegationEvidenceSchema } from "../../delegation/schema";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import {
  formatAsyncChildOutput,
  formatSyncChildOutput,
  waitForChildOutcome,
} from "./delegate";

export const ResumeSessionInputSchema = z.strictObject({
  session_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  new_evidence: z.array(DelegationEvidenceSchema),
  background: z.boolean().default(false),
});

export type ResumeSessionInput = z.output<typeof ResumeSessionInputSchema>;

export async function executeResumeSession(input: ResumeSessionInput, ctx: ToolExecutionContext): Promise<RawToolResult> {
  if (ctx.resumeChildSession === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_RESUME_SESSION_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child session resume is not available in this execution context",
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
      instruction: input.instruction,
      newEvidence: input.new_evidence,
      background: input.background,
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
    });
  }

  if (input.background ?? false) return createTextToolResult(formatAsyncChildOutput(handle));
  return createTextToolResult(formatSyncChildOutput(handle, await waitForChildOutcome(handle)));
}

export const resumeSessionTool = defineTool({
  name: "resume_session",
  description: [
    "Resume one stopped direct child Session for the same delegated responsibility.",
    "instruction and new_evidence may refine the next execution, but cannot change the durable Agent type, title, Skills, owned scope, dependencies, or acceptance criteria.",
    "Each resumed Execution must submit a new canonical child result receipt.",
  ].join("\n"),
  inputSchema: ResumeSessionInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: executeResumeSession,
});
