import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { z } from "zod/v4";
import {
  MAX_DELEGATED_SESSION_TITLE_LENGTH,
} from "@archcode/protocol";
import { DelegationRequestSchema } from "../delegation/schema";
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
  test("projects portable schemas through the actual ResolvedToolSet boundary", async () => {
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
    const delegateProviderSchema = await asSchema(aiTools.delegate!.inputSchema).jsonSchema;
    const schemas = Object.fromEntries(Object.entries(aiTools).map(([name, tool]) => [
      name,
      jsonSchema(tool.inputSchema),
    ]));
    const serialized = JSON.stringify(schemas);

    expect(serialized).not.toContain("lookahead");
    expect(serialized).not.toContain("lookaround");
    expect(schemas.delegate).toMatchObject({
      properties: {
        agent_type: { enum: ["analyst", "build", "explore"] },
        profile: { enum: ["deep", "fast"] },
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DELEGATED_SESSION_TITLE_LENGTH,
        },
        skills: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    });
    expect(delegateProviderSchema).toMatchObject({
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DELEGATED_SESSION_TITLE_LENGTH,
        },
      },
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

  test("keeps the AI-facing delegated title boundary identical to runtime admission", () => {
    const [projected] = projectModelToolDescriptors(
      [delegateTool],
      capabilities([Object.freeze({
        agentName: "explore",
        profiles: Object.freeze(["fast"] as const),
        builtinSkillNames: Object.freeze([]),
      })]),
    );
    const aiSchema = projected!.aiInputSchema as z.ZodType;
    const request = (title: string) => ({
      agent_type: "explore",
      profile: "fast",
      title,
      objective: "Inspect the delegated scope.",
      skills: [],
      background: false,
    });

    for (const [title, accepted] of [
      ["", false],
      [" ", false],
      ["t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH), true],
      ["t".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH + 1), false],
      ["😀".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH), true],
      ["😀".repeat(MAX_DELEGATED_SESSION_TITLE_LENGTH + 1), false],
    ] as const) {
      expect(aiSchema.safeParse(request(title)).success).toBe(accepted);
      expect(DelegationRequestSchema.safeParse(request(title)).success).toBe(accepted);
    }
  });

  test("fails closed if delegate is visible without an allowed target", () => {
    expect(() => projectModelToolDescriptors([delegateTool], capabilities([]))).toThrow(
      "delegate is model-visible",
    );
  });
});
