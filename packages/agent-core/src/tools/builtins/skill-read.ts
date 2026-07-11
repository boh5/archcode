import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { SkillNotFoundError, SkillPathError, SkillValidationError, type ResolvedSkill } from "../../skills";
import { SKILL_NAME_REGEX } from "../../skills/schema";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const SkillReadInputSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE).describe("Skill name (lowercase kebab-case, e.g. \"git-master\")"),
  })
  .strict();

type SkillReadInput = z.infer<typeof SkillReadInputSchema>;

export function formatResolvedSkill(skill: ResolvedSkill): string {
  const headerLines = [
    "---",
    `name: ${skill.metadata.name}`,
    `description: ${skill.metadata.description}`,
    `when_to_use: ${skill.metadata.when_to_use}`,
    `source: ${skill.source}`,
  ];
  if (skill.metadata.allowed_tools !== undefined) {
    headerLines.push(`allowed_tools: ${JSON.stringify(skill.metadata.allowed_tools)}`);
  }
  headerLines.push("---");
  return [headerLines.join("\n"), skill.body].join("\n\n");
}

function skillReadError(error: unknown, name: string): ToolExecutionResult {
  if (error instanceof SkillNotFoundError) {
    return createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_SKILL_NOT_FOUND",
      message: `Skill not found or not allowed for current agent: ${error.skillName}`,
    });
  }

  if (error instanceof SkillValidationError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SKILL_INVALID",
      message: error.message,
      name: error.name,
      details: {
        skillName: error.skillName,
        source: error.source,
        path: error.path,
      },
    });
  }

  if (error instanceof SkillPathError) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_SKILL_PATH_INVALID",
      message: error.message,
      name: error.name,
      details: { path: error.path, reason: error.reason },
    });
  }

  if (error instanceof Error && error.message.includes("Skill name must match")) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SKILL_INVALID_NAME",
      message: `Invalid Skill name "${name}": ${error.message}`,
      name: error.name,
    });
  }

  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_SKILL_READ_FAILED",
    message: `Failed to read Skill "${name}"`,
    error: error instanceof Error ? error : new Error(String(error)),
  });
}

export function createSkillReadTool(): AnyToolDescriptor {
  return defineTool({
    name: "skill_read",
    description:
      "Read the full content of a Skill allowed for the current agent by name. Does not accept agent, source, role, or path overrides.",
    inputSchema: SkillReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (
      input: SkillReadInput,
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
        const skill = await ctx.skillService.readForAgent(ctx.cwd, input.name, ctx.agentSkills);
        if (skill === null) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_SKILL_NOT_FOUND",
            message: `Skill not found or not allowed for current agent: ${input.name}`,
          });
        }
        return formatResolvedSkill(skill);
      } catch (error) {
        return skillReadError(error, input.name);
      }
    },
  });
}

export const skillReadTool = createSkillReadTool();
