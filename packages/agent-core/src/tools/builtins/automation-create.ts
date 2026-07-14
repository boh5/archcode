import {
  TOOL_AUTOMATION_CREATE,
} from "@archcode/protocol";
import type { z } from "zod/v4";

import { AutomationCreateSchema } from "../../automations/schema";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";

type AutomationCreateInput = z.infer<typeof AutomationCreateSchema>;

export const automationCreateTool: AnyToolDescriptor = defineTool({
  name: TOOL_AUTOMATION_CREATE,
  description: "Create a confirmed Automation from an ordinary root Engineer Session.",
  inputSchema: AutomationCreateSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input: AutomationCreateInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
    const state = ctx.store.getState();
    const agentName = ctx.agentName ?? state.agentName;
    const isStandaloneRole = state.sessionRole === undefined || state.sessionRole === "standalone";
    const isOrdinaryRoot = state.sessionId === state.rootSessionId
      && state.parentSessionId === undefined
      && state.goalId === undefined
      && isStandaloneRole;
    if (agentName !== "engineer" || !isOrdinaryRoot) {
      return createToolErrorResult({
        kind: "permission-denied",
        code: "AUTOMATION_CREATE_DENIED",
        message: `automation_create requires an unbound engineer root session, got ${agentName ?? "unknown"}/${state.sessionRole ?? "none"}`,
      });
    }

    try {
      const automation = await ctx.projectContext.createAutomation({
        name: input.name,
        trigger: input.trigger,
        action: input.action,
        createdFromSessionId: state.sessionId,
      });
      return JSON.stringify(automation, null, 2);
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
