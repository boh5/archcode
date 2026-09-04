import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { delegateTool } from "../tools/builtins/delegate";
import { skillListTool } from "../tools/builtins/skill-list";
import { skillReadTool } from "../tools/builtins/skill-read";
import { ResolvedToolSet } from "../tools/registry";
import type { DelegationCapabilitySnapshot } from "./factory-types";
import { projectModelToolDescriptors } from "./model-tool-projection";

function capabilities(
  targets: DelegationCapabilitySnapshot["targets"],
): DelegationCapabilitySnapshot {
  return Object.freeze({
    parentAgentName: "lead",
    depth: 0,
    targets: Object.freeze(targets),
  });
}

function jsonSchema(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && "jsonSchema" in value) {
    return (value as { readonly jsonSchema: Record<string, unknown> }).jsonSchema;
  }
  return z.toJSONSchema(value as z.ZodType) as Record<string, unknown>;
}

describe("projectModelToolDescriptors", () => {
  test("projects portable schemas through the actual ResolvedToolSet boundary", () => {
    const snapshot = capabilities([
      Object.freeze({
        agentName: "analyst",
        profiles: Object.freeze(["deep"] as const),
        builtinSkillNames: Object.freeze(["analyze-work"]),
      }),
      Object.freeze({
        agentName: "build",
        profiles: Object.freeze(["deep", "fast"] as const),
        builtinSkillNames: Object.freeze(["safe-refactor"]),
      }),
      Object.freeze({
        agentName: "explore",
        profiles: Object.freeze(["fast"] as const),
        builtinSkillNames: Object.freeze(["codemap"]),
      }),
    ]);
    const originals = [delegateTool, skillListTool, skillReadTool] as const;
    const originalState = originals.map((descriptor) => ({
      inputSchema: descriptor.inputSchema,
      aiInputSchema: descriptor.aiInputSchema,
      execute: descriptor.execute,
      description: descriptor.description,
    }));

    const projected = projectModelToolDescriptors(originals, snapshot);
    const aiTools = new ResolvedToolSet(projected).toAITools();
    const schemas = Object.fromEntries(Object.entries(aiTools).map(([name, tool]) => [
      name,
      jsonSchema(tool.inputSchema),
    ]));
    const serialized = JSON.stringify(schemas);

    expect(serialized).not.toContain("pattern");
    expect(serialized).not.toContain("lookahead");
    expect(serialized).not.toContain("lookaround");
    expect(schemas.delegate).toMatchObject({
      properties: {
        agent_type: { enum: ["analyst", "build", "explore"] },
        profile: { enum: ["deep", "fast"] },
        skills: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    });
    expect(schemas.skill_list).toMatchObject({
      properties: {
        agent_type: { enum: ["analyst", "build", "explore"] },
      },
      additionalProperties: false,
    });
    expect((aiTools.delegate?.description ?? "")).toContain(
      "analyst=deep, build=deep|fast, explore=fast",
    );
    expect(aiTools.skill_list?.description).toContain("skill_list({})");
    expect(aiTools.skill_list?.description).toContain('skill_list({"agent_type":"build"})');
    expect(aiTools.skill_list?.description).toContain("nextCursor");
    expect(aiTools.skill_list?.description).toContain("preserving agent_type");
    expect(aiTools.skill_list?.description).toContain("PLACEHOLDER");
    expect(jsonSchema(aiTools.skill_list!.inputSchema).properties).toMatchObject({
      cursor: { description: expect.stringContaining("nextCursor") },
      agent_type: { description: expect.stringContaining('skill_list({"agent_type":"build"})') },
    });
    const repeatedAiTools = new ResolvedToolSet(
      projectModelToolDescriptors(originals, snapshot),
    ).toAITools();
    for (const name of Object.keys(aiTools)) {
      expect(JSON.stringify(jsonSchema(repeatedAiTools[name]!.inputSchema))).toBe(
        JSON.stringify(jsonSchema(aiTools[name]!.inputSchema)),
      );
      expect(repeatedAiTools[name]!.description).toBe(aiTools[name]!.description);
    }
    expect(JSON.stringify(aiTools)).not.toContain("analyze-work");
    expect(JSON.stringify(aiTools)).not.toContain("safe-refactor");
    expect(JSON.stringify(aiTools)).not.toContain("codemap");

    projected.forEach((descriptor, index) => {
      expect(descriptor.inputSchema).toBe(originalState[index]!.inputSchema);
      expect(descriptor.execute).toBe(originalState[index]!.execute);
    });
    originals.forEach((descriptor, index) => {
      expect(descriptor.aiInputSchema).toBe(originalState[index]!.aiInputSchema);
      expect(descriptor.description).toBe(originalState[index]!.description);
    });
  });

  test("omits skill_list.agent_type when the current depth has no targets", () => {
    const projected = projectModelToolDescriptors(
      [skillListTool, skillReadTool],
      capabilities([]),
    );
    const aiTools = new ResolvedToolSet(projected).toAITools();
    const listSchema = jsonSchema(aiTools.skill_list!.inputSchema);
    const properties = listSchema.properties as Record<string, unknown>;

    expect(properties.agent_type).toBeUndefined();
    expect(properties.cursor).toBeDefined();
    expect(JSON.stringify(jsonSchema(aiTools.skill_read!.inputSchema))).not.toContain("pattern");
  });

  test("fails closed if delegate is visible without an allowed target", () => {
    expect(() => projectModelToolDescriptors([delegateTool], capabilities([]))).toThrow(
      "delegate is model-visible",
    );
  });
});
