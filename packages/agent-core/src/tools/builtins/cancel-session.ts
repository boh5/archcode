import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { ChildSessionNotDescendantError } from "../../agents/errors";
import { createWorkspacePermission } from "../permission/workspace";

export const CancelSessionInputSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the descendant sub-agent session to cancel"),
  })
  .strict();

export type CancelSessionInput = z.infer<typeof CancelSessionInputSchema>;

export async function executeCancelSession(
  input: CancelSessionInput,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  if (ctx.cancelChildSession === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CANCEL_SESSION_UNAVAILABLE",
      name: "SubAgentError",
      message: "cancel_session is not available in this execution context",
    });
  }

  const callingSessionId = ctx.store.getState().sessionId;
  const workspaceRoot = ctx.workspaceRoot;

  if (input.session_id === callingSessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CANCEL_SESSION_SELF",
      name: "SubAgentError",
      message: "Cannot cancel own session",
    });
  }

  let cancelled: boolean;
  try {
    cancelled = ctx.cancelChildSession(workspaceRoot, callingSessionId, input.session_id);
  } catch (error) {
    if (error instanceof ChildSessionNotDescendantError) {
      return createToolErrorResult({
        kind: "execution",
        code: "TOOL_CANCEL_SESSION_NOT_DESCENDANT",
        name: error.name,
        message: error.message,
        error,
      });
    }
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CANCEL_SESSION_FAILED",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
    });
  }

  if (!cancelled) {
    return `Session ${input.session_id} is not running. No action taken.`;
  }

  return `Session ${input.session_id} cancelled successfully. All descendant sessions were aborted.`;
}

export const cancelSessionTool = defineTool({
  name: "cancel_session",
  description:
    "Cancel a running sub-agent session. Only descendant sessions of the calling session can be cancelled. Cascades to all child sessions of the target. Use this to interrupt a sub-agent that is going in the wrong direction or taking too long.",
  inputSchema: CancelSessionInputSchema,
  traits: { readOnly: false, destructive: true, concurrencySafe: false },
  permissions: [createWorkspacePermission()],
  execute: async (input, ctx) => executeCancelSession(input, ctx),
});