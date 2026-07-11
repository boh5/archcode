import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";

export const SkillListInputSchema = z.object({}).strict();

type SkillListInput = z.infer<typeof SkillListInputSchema>;

export function createSkillListTool(): AnyToolDescriptor {
  return defineTool({
    name: "skill_list",
    description:
      "List Skills available to the current agent. Returns JSON entries with name, description, when_to_use, source, and optional allowed_tools only; full Skill bodies are omitted.",
    inputSchema: SkillListInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (
      _input: SkillListInput,
      ctx: ToolExecutionContext,
    ): Promise<string | ToolExecutionResult> => {
      if (ctx.skillService === undefined || ctx.agentSkills === undefined) {
        return createToolErrorResult({
          kind: "execution",
          code: "TOOL_SKILL_CONTEXT_MISSING",
          message: "Skill tools require an explicit SkillService and agent Skill allow-list",
        });
      }
      try {
        const entries = await ctx.skillService.listForAgent(ctx.cwd, ctx.agentSkills);
        return JSON.stringify(entries);
      } catch (error) {
        return createToolErrorResult({
          kind: "execution",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  });
}

export const skillListTool = createSkillListTool();
