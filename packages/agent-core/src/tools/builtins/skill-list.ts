import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { ToolExecutionContext } from "../types";
import { DigestBoundCursorError } from "../../skills";

export const SkillListInputSchema = z.object({
  cursor: z.string().min(1).optional(),
  agent_type: z.enum(["analyst", "build", "explore", "librarian"]).optional(),
}).strict();

type SkillListInput = z.infer<typeof SkillListInputSchema>;

export function createSkillListTool() {
  return defineTool({
    name: "skill_list",
    description: [
      "Discover Skills for the current Agent or for an allowed direct delegation target. The System Prompt normally already lists current-Agent metadata; call skill_list only when you need a fresh machine-readable copy, and call skill_read directly when an exact current-Agent Skill is already visible.",
      "",
      "Call `skill_list({})` for current-Agent Skills. Those exact returned names may be passed to current-Agent skill_read. Call `skill_list({\"agent_type\":\"<allowed-target>\"})` only to choose exact names for that same target's delegate.skills; target results do not grant the parent Agent permission to read or activate them. Never guess or invent a Skill name. The result is metadata-only JSON containing exactly name, description, and source; Skill bodies and resource contents are omitted. An empty list means no Skill is available in the requested scope.",
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
      let agentSkills = ctx.agentSkills;
      if (input.agent_type !== undefined) {
        if (ctx.resolveSkillListTargetSkills === undefined) {
          return createToolErrorResult({
            kind: "execution",
            code: "TOOL_SKILL_CONTEXT_MISSING",
            message: "Target Skill discovery requires an explicit delegation capability resolver",
          });
        }
        const targetSkills = ctx.resolveSkillListTargetSkills(input.agent_type);
        if (targetSkills === undefined) {
          return createToolErrorResult({
            kind: "not-allowed",
            code: "TOOL_SKILL_TARGET_NOT_ALLOWED",
            message: `Agent target "${input.agent_type}" is not allowed at the current delegation depth`,
          });
        }
        agentSkills = targetSkills;
      }
      try {
        const page = await ctx.skillService.listPageForAgent(
          ctx.cwd,
          agentSkills,
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
