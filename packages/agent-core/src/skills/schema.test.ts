import { describe, expect, test } from "bun:test";
import { parseSkillMarkdown, SkillMetadataSchema } from "./schema";

describe("SkillMetadataSchema", () => {
  test("parses required skill frontmatter", () => {
    const parsed = parseSkillMarkdown(`---
name: safe-refactor
description: Refactor safely
allowed_tools: grep, file_read, lsp_diagnostics
---

Follow the plan.
`);

    expect(parsed.metadata).toEqual({
      name: "safe-refactor",
      description: "Refactor safely",
      allowed_tools: ["grep", "file_read", "lsp_diagnostics"],
    });
    expect(parsed.body).toBe("Follow the plan.\n");
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
      expect(SkillMetadataSchema.parse({ name, description: "ok" }).name).toBe(name);
    }

    for (const name of ["Git", "-bad", "bad_name", ""] as const) {
      expect(() => SkillMetadataSchema.parse({ name, description: "bad" })).toThrow();
    }
  });
});
