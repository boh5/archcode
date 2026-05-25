import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionContext } from "../types";
import type { StoredMessage } from "../../store/types";
import { SKILL_NAME_REGEX } from "../../skills/schema";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const DelegateInputSchema = z
  .object({
    agent_type: z.string().min(1),
    prompt: z.string(),
    skills: z.array(z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE)),
    description: z.string().optional(),
    title: z.string().optional(),
    background: z.boolean().default(false),
  })
  .strict();

export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export interface DelegateErrorOutput {
  ok: false;
  session_id: string;
  error: {
    name: string;
    message: string;
  };
}

export async function executeDelegate(input: DelegateInput, ctx: ToolExecutionContext) {
  if (ctx.agentFactory === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_FACTORY_UNAVAILABLE",
      name: "SubAgentError",
      message: "AgentFactory is not available in this execution context",
      details: { ok: false, session_id: "" } satisfies Pick<DelegateErrorOutput, "ok" | "session_id">,
    });
  }

  let sessionId = "";
  try {
    const handle = await ctx.agentFactory.delegate({
      parentStore: ctx.store,
      parentAgentName: ctx.agentName ?? "orchestrator",
      targetAgentName: input.agent_type,
      prompt: input.prompt,
      skills: input.skills,
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
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_FAILED",
      message: safeError.message,
      name: safeError.name,
      error: safeError,
      details: {
        ok: false,
        session_id: sessionId,
        error: { name: safeError.name, message: safeError.message },
      } satisfies DelegateErrorOutput,
    });
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
    "Delegate a prompt to another allowed agent. The skills field is required; pass [] when no Skill should be active. Use background=true to start it asynchronously and retrieve output later with background_output.",
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
