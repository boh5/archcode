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
  description: "Commit and activate a durable project Automation only after the user explicitly requests or accepts a one-time or recurring time-triggered action and the automation-create Skill has separately confirmed the complete name, trigger, and action. Use for scheduled, recurring, reminder, or periodic-monitoring intent; do not use for work that should run immediately. A material change after confirmation requires confirmation again. This tool is available only to an unbound ordinary Engineer root Session; provenance is derived from that Session. User confirmation is a model-visible Skill protocol, while runtime authorization separately enforces the Session boundary.",
  inputSchema: AutomationCreateSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: AutomationCreateInput, ctx: ToolExecutionContext) => {
    const state = ctx.store.getState();
    const agentName = ctx.agentName ?? state.agentName;
    const isOrdinaryRoot = state.sessionId === state.rootSessionId
      && state.parentSessionId === undefined;
    if (agentName !== "engineer" || !isOrdinaryRoot) {
      return createToolErrorResult({
        kind: "permission-denied",
        code: "AUTOMATION_CREATE_DENIED",
        message: `automation_create requires an Engineer root Session, got ${agentName ?? "unknown"}`,
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
