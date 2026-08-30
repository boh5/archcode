import { z } from "zod/v4";
import type {
  SendMessageToChild,
} from "../../delegation/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";

export const SendMessageInputSchema = z.strictObject({
  session_id: z.string().trim().min(1)
    .describe("Currently running direct child Session ID."),
  expected_execution_id: z.string().trim().min(1)
    .describe("The child's exact active Execution ID observed before this call."),
  message: z.string().trim().min(1)
    .describe("Self-contained parent Agent message. It is context, not user authorization."),
  delivery: z.enum(["steer", "queue"])
    .describe("steer targets the next model attempt in the current Execution; queue starts the next Execution after normal completion."),
});

export type SendMessageInput = z.output<typeof SendMessageInputSchema>;

export async function executeSendMessage(
  input: SendMessageInput,
  context: ToolExecutionContext,
): Promise<RawToolResult> {
  const ctx = context;
  if (ctx.sendMessageToChild === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SEND_MESSAGE_UNAVAILABLE",
      name: "SubAgentError",
      message: "send_message is not available in this execution context",
    });
  }
  const parentState = ctx.store.getState();
  if (input.session_id === parentState.sessionId) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SEND_MESSAGE_SELF",
      name: "SubAgentError",
      message: "Cannot send_message to the current Session",
    });
  }
  try {
    const result = await ctx.sendMessageToChild(
      ctx.projectContext.project.workspaceRoot,
      {
        parentStore: ctx.store,
        parentSessionId: parentState.sessionId,
        parentAgentName: parentState.agentName,
        parentExecutionId: ctx.executionId,
        parentRunOrdinal: ctx.runOrdinal,
        parentToolBatchId: ctx.toolBatchId,
        parentToolCallId: ctx.toolCallId,
        sessionId: input.session_id,
        expectedExecutionId: input.expected_execution_id,
        message: input.message,
        delivery: input.delivery,
        clientRequestId: [
          "send_message",
          parentState.sessionId,
          ctx.executionId,
          String(ctx.runOrdinal),
          ctx.toolBatchId,
          ctx.toolCallId,
        ].join(":"),
      },
    );
    return createTextToolResult(JSON.stringify({
      session_id: result.sessionId,
      execution_id: result.executionId,
      message_id: result.messageId,
      delivery: result.delivery,
    }));
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SEND_MESSAGE_FAILED",
      name: safeError.name,
      message: safeError.message,
      error: safeError,
    });
  }
}

export const sendMessageTool = defineTool({
  name: "send_message",
  description: [
    "Communicate with a delegated child task by sending one message to a currently running direct child Agent Session.",
    "Use delivery=steer for its current Execution's next model attempt, or delivery=queue for a following Execution after normal completion.",
    "The exact expected_execution_id prevents delivery to a later generation. A stopped child is rejected; use resume_session instead.",
  ].join("\n"),
  inputSchema: SendMessageInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: executeSendMessage,
});
