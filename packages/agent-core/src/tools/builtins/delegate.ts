import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";

export const DelegateInputSchema = z
  .object({
    agent_type: z.string().min(1),
    prompt: z.string(),
    description: z.string().optional(),
    title: z.string().optional(),
    background: z.boolean().default(false),
  })
  .strict();

export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export interface DelegateErrorOutput {
  ok: false;
  sessionId: string;
  error: {
    name: string;
    message: string;
  };
}

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext): Promise<string> {
  if (ctx.agentFactory === undefined) {
    return JSON.stringify({
      ok: false,
      sessionId: "",
      error: { name: "SubAgentError", message: "AgentFactory is not available in this execution context" },
    } satisfies DelegateErrorOutput);
  }

  let sessionId = "";
  try {
    const handle = ctx.agentFactory.delegate({
      parentStore: ctx.store,
      parentAgentName: ctx.agentName ?? "orchestrator",
      targetAgentName: input.agent_type,
      prompt: input.prompt,
      title: input.title ?? input.description,
      description: input.description,
      background: input.background ?? false,
      currentDepth: ctx.currentDepth ?? 0,
      parentAbort: ctx.abort,
    });
    sessionId = handle.sessionId;

    if (input.background ?? false) {
      return JSON.stringify({ ok: true, session_id: sessionId });
    }

    await handle.result;
    return getLastAssistantText(handle.store.getState().messages);
  } catch (error) {
    return JSON.stringify({
      ok: false,
      sessionId,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies DelegateErrorOutput);
  }
}

export function getLastAssistantText(messages: readonly StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  return "";
}

export const delegateTool = defineTool({
  name: "delegate",
  description:
    "Delegate a prompt to another allowed agent. Use background=true to start it asynchronously and retrieve output later with background_output.",
  inputSchema: DelegateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input, ctx) => executeDelegate(input, ctx),
});

export function missingChildSessionResult(sessionId: string) {
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_UNKNOWN_CHILD_SESSION",
    message: `Unknown child session_id: ${sessionId}`,
  });
}
