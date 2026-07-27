import {
  TOOL_AUTOMATION_CREATE,
} from "@archcode/protocol";
import type { z } from "zod/v4";

import { AutomationCreateSchema } from "../../automations/schema";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { AnyToolDescriptor, ToolExecutionContext } from "../types";

type AutomationCreateInput = z.infer<typeof AutomationCreateSchema>;

export const automationCreateTool: AnyToolDescriptor = defineTool({
  name: TOOL_AUTOMATION_CREATE,
  description: "Commit and activate a durable project Automation for a user-requested one-time or recurring time-triggered action. Before calling this tool, use the automation-create Skill to clarify missing information, present a complete proposal, and receive the user's response; interpret that response in the conversation and call this tool only when it accepts the proposed typed values. Use for scheduled, recurring, reminder, or periodic-monitoring intent; do not use for work that should run immediately. This tool is available only to an unbound ordinary Lead root Session, and its creation source is derived from that Session. Runtime authorization enforces the typed schema and Session boundary.",
  inputSchema: AutomationCreateSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: AutomationCreateInput, ctx: ToolExecutionContext) => {
    const state = ctx.store.getState();
    const agentName = ctx.agentName ?? state.agentName;
    const isOrdinaryRoot = state.sessionId === state.rootSessionId
      && state.parentSessionId === undefined;
    const discussion = isOrdinaryRoot
      ? await ctx.projectContext.todos.state.findByDiscussionSessionId(state.sessionId)
      : undefined;
    if (agentName !== "lead" || !isOrdinaryRoot || discussion !== undefined) {
      return createToolErrorResult({
        kind: "permission-denied",
        code: "AUTOMATION_CREATE_DENIED",
        message: `automation_create requires an ordinary Lead root Session, got ${agentName ?? "unknown"}`,
      });
    }

    try {
      const automation = await ctx.projectContext.createAutomation({
        name: input.name,
        trigger: input.trigger,
        action: input.action,
        createdFromSessionId: state.sessionId,
      });
      return createTextToolResult(JSON.stringify(automation, null, 2));
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
