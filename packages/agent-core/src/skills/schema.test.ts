import { describe, expect, test } from "bun:test";
import { parseSkillMarkdown, SkillMetadataSchema } from "./schema";
import { BUILTIN_SKILL_BODIES } from "./builtin/manifest";
import type { BuiltinSkillName } from "./builtin/manifest";

describe("SkillMetadataSchema", () => {
  test("parses required skill frontmatter", () => {
    const parsed = parseSkillMarkdown(`---
name: safe-refactor
description: Refactor safely
when_to_use: Use when restructuring code without behavior changes.
allowed_tools: grep, file_read, lsp_diagnostics
---

Follow the plan.
`);

    expect(parsed.metadata).toEqual({
      name: "safe-refactor",
      description: "Refactor safely",
      when_to_use: "Use when restructuring code without behavior changes.",
      allowed_tools: ["grep", "file_read", "lsp_diagnostics"],
    });
    expect(parsed.body).toBe("Follow the plan.\n");
  });

  test("rejects missing when_to_use", () => {
    expect(() => SkillMetadataSchema.parse({
      name: "git-master",
      description: "Git guidance",
    })).toThrow();
  });

  test("rejects empty when_to_use after trim", () => {
    expect(() => SkillMetadataSchema.parse({
      name: "git-master",
      description: "Git guidance",
      when_to_use: "   ",
    })).toThrow();
  });

  test("trims whitespace from when_to_use", () => {
    const parsed = SkillMetadataSchema.parse({
      name: "codemap",
      description: "Map code",
      when_to_use: "  Use before implementation.  ",
    });
    expect(parsed.when_to_use).toBe("Use before implementation.");
  });

  test("rejects unknown legacy invocation fields", () => {
    expect(() => SkillMetadataSchema.parse({
      name: "git-master",
      description: "Git guidance",
      user_invocable: "true",
    })).toThrow();

    expect(() => SkillMetadataSchema.parse({
      name: "git-master",
      description: "Git guidance",
      disable_model_invocation: "true",
    })).toThrow();
  });

  test("validates skill names with the exact lowercase kebab pattern", () => {
    for (const name of ["a", "git-master", "skill-1"] as const) {
      expect(SkillMetadataSchema.parse({ name, description: "ok", when_to_use: "Use when needed." }).name).toBe(name);
    }

    for (const name of ["Git", "-bad", "bad_name", ""] as const) {
      expect(() => SkillMetadataSchema.parse({ name, description: "bad" })).toThrow();
    }
  });

  test("builtin skill when_to_use values contain no quotes", () => {
    for (const [skillName, body] of Object.entries(BUILTIN_SKILL_BODIES)) {
      const parsed = parseSkillMarkdown(body);
      expect(parsed.metadata.when_to_use).not.toStartWith('"');
      expect(parsed.metadata.when_to_use).not.toEndWith('"');
      expect(parsed.metadata.when_to_use).not.toStartWith("'");
      expect(parsed.metadata.when_to_use).not.toEndWith("'");
      expect(parsed.metadata.name).toBe(skillName as BuiltinSkillName);
    }
  });
});
