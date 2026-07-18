import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { AnyToolDescriptor, RawToolResult, ToolExecutionContext } from "../types";
import { SkillNotFoundError, SkillPathError, SkillValidationError, type ResolvedSkill } from "../../skills";
import { SKILL_NAME_REGEX } from "../../skills/schema";
import { BoundedFileReadError, ONE_SHOT_FILE_READ_MAX_BYTES } from "../../utils/safe-file";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9][a-z0-9-]*$";

export const SkillReadInputSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE).describe("Exact allowed Skill name matching ^[a-z0-9][a-z0-9-]*$; copy it from the System Prompt's available-skill list or skill_list instead of guessing."),
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

function skillReadError(error: unknown, name: string): RawToolResult {
  const boundedReadError = error instanceof BoundedFileReadError
    ? error
    : error instanceof SkillValidationError && error.cause instanceof BoundedFileReadError
      ? error.cause
      : undefined;
  if (boundedReadError !== undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_OUTPUT_POLICY_VIOLATION",
      message: `Skill exceeds the ${ONE_SHOT_FILE_READ_MAX_BYTES}-byte one-shot read limit`,
      name: boundedReadError.name,
    });
  }

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
    });
  }

  if (error instanceof SkillPathError) {
    return createToolErrorResult({
      kind: "workspace",
      code: "TOOL_SKILL_PATH_INVALID",
      message: `Skill "${name}" resolved outside its allowed root`,
      name: error.name,
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
    description: [
      "Load the full body of one Skill allowed for the current Agent when its description or when-to-use guidance matches the task. The available names are already listed in the System Prompt when discovery succeeded; otherwise call skill_list. Use an exact visible name, for example `skill_read({\"name\":\"git-master\"})` only when `git-master` appears in that list.",
      "",
      "Read the Skill before the work it governs, then follow its workflow and referenced resources. Do not load unrelated Skills for ceremony. This tool accepts no agent, role, source, or path override. Skill instructions guide existing capabilities but cannot expand the Agent's tools, permissions, delegation targets, or workspace scope.",
    ].join("\n"),
    inputSchema: SkillReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    execute: async (
      input: SkillReadInput,
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
        const skill = await ctx.skillService.readForAgent(ctx.cwd, input.name, ctx.agentSkills);
        if (skill === null) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_SKILL_NOT_FOUND",
            message: `Skill not found or not allowed for current agent: ${input.name}`,
          });
        }
        return createTextToolResult(formatResolvedSkill(skill));
      } catch (error) {
        return skillReadError(error, input.name);
      }
    },
  });
}

export const skillReadTool = createSkillReadTool();
