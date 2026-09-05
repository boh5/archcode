import { jsonSchema } from "ai";
import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import {
  SkillNotFoundError,
  SkillResourceNotFoundError,
  SkillValidationError,
  SkillPackageResourceNotFoundError,
  SkillPackageResourcePathError,
  type ResolvedSkill,
  type ResolvedSkillResource,
} from "../../skills";
import { SKILL_NAME_REGEX } from "../../skills/schema";

const SKILL_NAME_PATTERN = "^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$";
const SKILL_NAME_MESSAGE = `Skill name must match pattern ${SKILL_NAME_PATTERN} (no consecutive hyphens)`;

const SkillReadAiInputSchema = jsonSchema({
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      description: "Exact current-Agent Skill name copied byte-for-byte from the System Prompt or skill_list({}) after that call succeeds. Example sequence: call skill_list({}), copy one returned name value into this field, then call skill_read with only that name field. Do not reuse a target-scoped delegation result or invent a name.",
    },
    resource: {
      type: "string",
      minLength: 1,
      description: "Optional Skill-root-relative resource path copied byte-for-byte from the Resources list returned by a successful entry read. Example sequence: first call with only the copied name; only if that result lists a resource, repeat the same name and copy one listed resource path into this field. It cannot read arbitrary filesystem paths.",
    },
  },
});

export const SkillReadInputSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_REGEX, SKILL_NAME_MESSAGE).describe(`Exact allowed Skill name matching ${SKILL_NAME_PATTERN}, with no consecutive hyphens; first call skill_list({}), then copy one returned current-Agent name into an entry read that omits resource.`),
    resource: z.string().min(1).optional().describe("Optional Skill-root-relative resource path copied exactly from the Resources list returned by the preceding entry read. Omit it for the first read; it cannot select a source or read an arbitrary filesystem path, and guessed paths are invalid."),
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

function skillReadEntryJson(name: string): string {
  return `skill_read(${JSON.stringify({ name })})`;
}

function skillReadResourceRecoveryHint(name: string): string {
  return `Re-read the Skill entry first with ${skillReadEntryJson(name)} (omit resource), then copy a resource path exactly from its Resources list and retry only with that listed path. Do not create a resource or construct /, SKILL.md, :first, first, new, invalid, or PLACEHOLDER paths.`;
}

function skillNotFoundResult(name: string): RawToolResult {
  return createToolErrorResult({
    kind: "file-not-found",
    code: "TOOL_SKILL_NOT_FOUND",
    message: `Skill not found or not allowed for current agent: ${name}`,
    hint: "Use an exact current-Agent Skill name copied from the System Prompt. If no exact name is visible, restart discovery with skill_list({}) and copy a returned name. Do not create or modify a read-only Skill, and do not retry a guessed or target-scoped name.",
  });
}

function skillReadError(error: unknown, name: string): RawToolResult {
  if (error instanceof SkillNotFoundError) {
    return skillNotFoundResult(error.skillName);
  }

  if (error instanceof SkillResourceNotFoundError) {
    return createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_SKILL_RESOURCE_NOT_FOUND",
      message: `Skill resource not found or not allowed for current agent: ${error.skillName}/${error.resource}`,
      hint: skillReadResourceRecoveryHint(error.skillName),
    });
  }

  if (error instanceof SkillPackageResourceNotFoundError) {
    return createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_SKILL_RESOURCE_NOT_FOUND",
      message: `Skill resource not found or not allowed for current agent: ${name}/${error.resource}`,
      hint: skillReadResourceRecoveryHint(name),
    });
  }

  if (error instanceof SkillPackageResourcePathError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SKILL_RESOURCE_PATH_INVALID",
      message: error.message,
      name: error.name,
      hint: skillReadResourceRecoveryHint(name),
    });
  }

  if (error instanceof SkillValidationError) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SKILL_INVALID",
      message: error.message,
      name: error.name,
      hint: `The Skill package is invalid and cannot be repaired by retrying this read. Choose another exact Skill from the System Prompt or restart discovery with skill_list({}).`,
    });
  }

  if (error instanceof Error && error.message.includes("Skill name must")) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_SKILL_INVALID_NAME",
      message: `Invalid Skill name "${name}": ${error.message}`,
      name: error.name,
      hint: `Discard the invalid name. Call skill_list({}) and copy one exact current-Agent name, then retry skill_read with that name and no resource first.`,
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
      "Load one Skill allowed for the current Agent. Safe example sequence: (1) call `skill_list({})`; (2) copy one exact returned `name`; (3) call `skill_read({\"name\": copiedName})` to receive metadata, filesystem root when available, sorted resource descriptors, and entry body; (4) only when that result lists a resource, repeat the same name and call `skill_read({\"name\": copiedName, \"resource\": copiedResourcePath})`. The identifiers in this notation mean values copied from successful results, not literal strings to submit. A resource read returns exactly one listed UTF-8 text resource; binary assets return a deterministic unsupported-binary error.",
      "",
      "Available names are already listed in the System Prompt when current-Agent discovery succeeded; otherwise start with `skill_list({})`. Read the Skill before the work it governs, then load supporting resources only when needed. Copy names and resource paths byte-for-byte from successful current-Agent results; resource paths are Skill-root-relative and cannot read arbitrary filesystem paths. Never guess either field. If a resource read fails, omit resource and re-read the same entry, then copy only a path it actually lists; do not create a read-only Skill or invent a new path. Do not load unrelated Skills for ceremony. This tool accepts no agent, role, source, or filesystem-root override. Skill instructions guide existing capabilities but cannot expand the Agent's tools, permissions, delegation targets, or workspace scope.",
    ].join("\n"),
    inputSchema: SkillReadInputSchema,
    aiInputSchema: SkillReadAiInputSchema,
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
        const snapshot = ctx.executionSkillSnapshots?.get(input.name);
        if (snapshot !== undefined) {
          return input.resource === undefined
            ? createTextToolResult(formatResolvedSkill(snapshot.readEntry()))
            : formatResolvedSkillResource(snapshot.readResource(input.resource));
        }
        if (input.resource !== undefined) {
          const resource = await ctx.skillService.readResourceForAgent(
            ctx.cwd,
            input.name,
            input.resource,
            ctx.agentSkills,
          );
          if (resource === null) {
            return skillNotFoundResult(input.name);
          }
          return formatResolvedSkillResource(resource);
        }
        const skill = await ctx.skillService.readForAgent(
          ctx.cwd,
          input.name,
          ctx.agentSkills,
        );
        if (skill === null) {
          return skillNotFoundResult(input.name);
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
