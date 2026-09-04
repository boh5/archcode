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
      "First-page calls omit cursor: use `skill_list({})` for current-Agent Skills, or `skill_list({\"agent_type\":\"build\"})` only when build is an allowed direct target. Those exact returned names may be passed to current-Agent skill_read or copied into the same target's delegate.skills as appropriate; target results do not grant the parent Agent permission to read or activate them.",
      "For a later page, copy only the exact nextCursor from the immediately preceding successful page into cursor. If a cursor is malformed or stale, discard it and retry the first page with the same scope (`skill_list({})` or `skill_list({\"agent_type\":\"build\"})`); never invent or repair a cursor. Never guess or invent a Skill name. Do not use /, :first, first, new, invalid, or PLACEHOLDER as a cursor, agent_type, or Skill name.",
      "The result is metadata-only JSON containing exactly name, description, and source; Skill bodies and resource contents are omitted. An empty list means no Skill is available in the requested scope.",
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
            hint: `Discard the malformed or stale cursor and retry the first page for the same scope with ${skillListFirstPageJson(input.agent_type)}. Copy only nextCursor from that successful page for a later request; do not construct a cursor.`,
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

function skillListFirstPageJson(agentType: SkillListInput["agent_type"]): string {
  return agentType === undefined
    ? "skill_list({})"
    : `skill_list(${JSON.stringify({ agent_type: agentType })})`;
}
