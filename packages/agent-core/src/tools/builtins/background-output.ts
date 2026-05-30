import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { getLastAssistantText } from "./delegate";

export const BackgroundOutputInputSchema = z
  .object({
    session_id: z.string(),
  })
  .strict();

export type BackgroundOutputInput = z.infer<typeof BackgroundOutputInputSchema>;

export function executeBackgroundOutput(
  input: BackgroundOutputInput,
  ctx: ToolExecutionContext,
): string | ToolExecutionResult {
  if (!ctx.store.getState().childSessionIds.has(input.session_id)) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_UNKNOWN_CHILD_SESSION",
      message: `Unknown child session_id: ${input.session_id}`,
    });
  }

  const childStore = ctx.storeManager.get(input.session_id, ctx.workspaceRoot);
  if (childStore === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CHILD_SESSION_NOT_FOUND",
      message: `Child session store not found: ${input.session_id}`,
    });
  }

  const text = getLastAssistantText(childStore.getState().messages);
  if (text.length === 0) {
    return "Sub-agent is still running. Use wait_for_reminder to wait for completion.";
  }

  return text;
}

export const backgroundOutputTool = defineTool({
  name: "background_output",
  description: "Read the latest assistant output from a delegated background sub-agent session.",
  inputSchema: BackgroundOutputInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: executeBackgroundOutput,
});
