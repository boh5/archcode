import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import {
  SkillNotFoundError,
  SkillPathError,
  SkillResourceNotFoundError,
  SkillValidationError,
  type ResolvedSkill,
  type ResolvedSkillResource,
} from "../../skills";
import { SKILL_NAME_REGEX } from "../../skills/schema";

const SKILL_NAME_MESSAGE = "Skill name must match pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$";

export const SkillReadInputSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE).describe("Exact allowed Skill name matching ^[a-z0-9]+(?:-[a-z0-9]+)*$; copy it from the System Prompt's available-skill list or skill_list instead of guessing."),
    resource: z.string().min(1).optional().describe("Optional Skill-root-relative resource path copied exactly from the entry's Resources list, for example references/review-packet.md. It cannot select a source or read an arbitrary filesystem path."),
  })
  .strict();

type SkillReadInput = z.infer<typeof SkillReadInputSchema>;

export function formatResolvedSkill(skill: ResolvedSkill): string {
  const headerLines = [
    "---",
    `name: ${skill.metadata.name}`,
    `description: ${skill.metadata.description}`,
    `source: ${skill.sourceLabel}`,
  ];
  if (skill.root !== undefined) {
    headerLines.push(`root: ${skill.root}`);
  }
  if (skill.metadata.license !== undefined) headerLines.push(`license: ${skill.metadata.license}`);
  if (skill.metadata.compatibility !== undefined) {
    headerLines.push(`compatibility: ${skill.metadata.compatibility}`);
  }
  if (skill.metadata.metadata !== undefined) {
    const metadata = Object.fromEntries(Object.entries(skill.metadata.metadata).sort(([a], [b]) => lexicalCompare(a, b)));
    headerLines.push(`metadata: ${JSON.stringify(metadata)}`);
  }
  headerLines.push("---");
  const resources = [...skill.resources]
    .sort((a, b) => lexicalCompare(a.path, b.path))
    .map((resource) => `- ${resource.path} (${resource.bytes} bytes)`);
  const resourceSection = resources.length === 0
    ? "Resources: none"
    : `Resources:\n${resources.join("\n")}`;
  return [headerLines.join("\n"), resourceSection, skill.body].join("\n\n");
}

export function formatResolvedSkillResource(resource: ResolvedSkillResource): RawToolResult {
  const identity = [
    "---",
    `skill: ${resource.skillName}`,
    `source: ${resource.sourceLabel}`,
    `resource: ${resource.resource.path}`,
    `bytes: ${resource.resource.bytes}`,
    "---",
  ].join("\n");

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(resource.content);
    return createTextToolResult(`${identity}\n\n${text}`);
  } catch {
    const code = "TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED";
    const hint = "Binary Skill resources are valid package assets but cannot be returned by the text-only skill_read tool.";
    return createTextToolResult(`${identity}\n\nerror: ${code}\nhint: ${hint}`, {
      isError: true,
      details: {
        error: {
          kind: "execution",
          code,
          name: "SkillResourceBinaryUnsupportedError",
          hint,
        },
      },
    });
  }
}

function skillReadError(error: unknown, name: string): RawToolResult {
  if (error instanceof SkillNotFoundError) {
    return createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_SKILL_NOT_FOUND",
      message: `Skill not found or not allowed for current agent: ${error.skillName}`,
    });
  }

  if (error instanceof SkillResourceNotFoundError) {
    return createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_SKILL_RESOURCE_NOT_FOUND",
      message: `Skill resource not found or not allowed for current agent: ${error.skillName}/${error.resource}`,
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

  if (error instanceof Error && error.message.includes("Skill name must")) {
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

export function createSkillReadTool() {
  return defineTool({
    name: "skill_read",
    description: [
      "Load one Skill allowed for the current Agent. `skill_read({\"name\":\"git-master\"})` returns its metadata, filesystem root when available, sorted resource descriptors, and entry body. `skill_read({\"name\":\"git-master\",\"resource\":\"references/example.md\"})` returns exactly one listed UTF-8 text resource; binary assets return a deterministic unsupported-binary error. The available names are already listed in the System Prompt when discovery succeeded; otherwise call skill_list. Use an exact visible name only.",
      "",
      "Read the Skill before the work it governs, then load supporting resources only when needed. Copy resource paths from the entry's Resources list; they are Skill-root-relative and cannot read arbitrary filesystem paths. Do not load unrelated Skills for ceremony. This tool accepts no agent, role, source, or filesystem-root override. Skill instructions guide existing capabilities but cannot expand the Agent's tools, permissions, delegation targets, or workspace scope.",
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
        if (input.resource !== undefined) {
          const resource = await ctx.skillService.readResourceForAgent(
            ctx.cwd,
            input.name,
            input.resource,
            ctx.agentSkills,
          );
          if (resource === null) {
            return createToolErrorResult({
              kind: "file-not-found",
              code: "TOOL_SKILL_RESOURCE_NOT_FOUND",
              message: `Skill resource not found or not allowed for current agent: ${input.name}/${input.resource}`,
            });
          }
          return formatResolvedSkillResource(resource);
        }
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

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
