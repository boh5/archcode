import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { ToolExecutionContext } from "../types";
import { DigestBoundCursorError } from "../../skills";

export const SkillListInputSchema = z.object({
  cursor: z.string().min(1).optional(),
}).strict();

type SkillListInput = z.infer<typeof SkillListInputSchema>;

export function createSkillListTool() {
  return defineTool({
    name: "skill_list",
    description: [
      "Discover the Skills currently allowed for this Agent. The System Prompt normally already lists the same allowed metadata; call skill_list only when you need a fresh machine-readable copy, and call skill_read directly when an exact matching Skill is already visible.",
      "",
      "Call `skill_list({})`, inspect each returned name, description, and source, choose only an exact returned name, then call `skill_read({\"name\":\"<exact-returned-name>\"})` before doing the governed work. Never guess or invent a Skill name. The result is metadata-only JSON containing exactly name, description, and source; Skill bodies and resource contents are omitted. An empty list means no Skill is available to this Agent.",
    ].join("\n"),
    inputSchema: SkillListInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async (
      input: SkillListInput,
      ctx: ToolExecutionContext,
    ) => {
      if (ctx.skillService === undefined || ctx.agentSkills === undefined) {
        return createToolErrorResult({
          kind: "execution",
          code: "TOOL_SKILL_CONTEXT_MISSING",
          message: "Skill tools require an explicit SkillService and agent Skill allow-list",
        });
      }
      try {
        const page = await ctx.skillService.listPageForAgent(
          ctx.cwd,
          ctx.agentSkills,
          input.cursor,
        );
        return createTextToolResult(JSON.stringify(page));
      } catch (error) {
        if (error instanceof DigestBoundCursorError) {
          return createToolErrorResult({
            kind: "execution",
            code: error.code,
            message: error.message,
          });
        }
        return createToolErrorResult({
          kind: "execution",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  });
}

export const skillListTool = createSkillListTool();
