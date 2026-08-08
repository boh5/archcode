import { describe, expect, test } from "bun:test";
import {
  parseSkillFrontmatter,
  parseSkillHeaderBytes,
  parseSkillMarkdown,
  SKILL_COMPATIBILITY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_ENTRY_MAX_BYTES,
  SKILL_FRONTMATTER_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SkillMetadataSchema,
} from "./schema";

const encoder = new TextEncoder();

describe("Skill schema", () => {
  test("parses the adopted Agent Skills metadata and preserves the exact body", () => {
    const parsed = parseSkillMarkdown(`---
name: safe-refactor
description: Refactors code without behavior changes when a repository needs structural cleanup.
license: MIT
compatibility: Requires repository source access.
metadata:
  archcode/source: superpowers
  archcode/adaptation: idea-only
---

Follow the plan.
`);

    expect(parsed).toEqual({
      metadata: {
        name: "safe-refactor",
        description: "Refactors code without behavior changes when a repository needs structural cleanup.",
        license: "MIT",
        compatibility: "Requires repository source access.",
        metadata: {
          "archcode/source": "superpowers",
          "archcode/adaptation": "idea-only",
        },
      },
      body: "\nFollow the plan.\n",
    });
  });

  test("requires name and description", () => {
    expect(() => SkillMetadataSchema.parse({ description: "Use this when needed." })).toThrow();
    expect(() => SkillMetadataSchema.parse({ name: "git-master" })).toThrow();
  });

  test("rejects a generic unknown top-level field", () => {
    expect(() => SkillMetadataSchema.parse({
      name: "git-master",
      description: "Guides Git operations when repository history must change safely.",
      custom: "unsupported",
    })).toThrow();
  });

  test("requires metadata to be a string-to-string map", () => {
    expect(SkillMetadataSchema.parse({
      name: "git-master",
      description: "Guides Git operations when repository history must change safely.",
      metadata: { source: "archcode", revision: "abc123" },
    }).metadata).toEqual({ source: "archcode", revision: "abc123" });

    for (const metadata of [{ nested: { value: "no" } }, { count: 1 }, ["no"]]) {
      expect(() => SkillMetadataSchema.parse({
        name: "git-master",
        description: "Guides Git operations when repository history must change safely.",
        metadata,
      })).toThrow();
    }
  });

  test("enforces the exact lowercase kebab name grammar and length", () => {
    for (const name of ["a", "git-master", "skill-1", "a".repeat(SKILL_NAME_MAX_LENGTH)]) {
      expect(SkillMetadataSchema.parse({ name, description: "Use this Skill when needed." }).name).toBe(name);
    }

    for (const name of [
      "Git",
      "-bad",
      "bad-",
      "bad_name",
      "double--hyphen",
      "a".repeat(SKILL_NAME_MAX_LENGTH + 1),
      "",
    ]) {
      expect(() => SkillMetadataSchema.parse({ name, description: "Use this Skill when needed." })).toThrow();
    }
  });

  test("enforces description below, equal, and above its byte-independent character limit", () => {
    for (const length of [SKILL_DESCRIPTION_MAX_LENGTH - 1, SKILL_DESCRIPTION_MAX_LENGTH]) {
      expect(SkillMetadataSchema.parse({ name: "a", description: "d".repeat(length) }).description).toHaveLength(length);
    }
    expect(() => SkillMetadataSchema.parse({
      name: "a",
      description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1),
    })).toThrow();
  });

  test("counts astral Unicode description characters as code points", () => {
    const equal = "😀".repeat(SKILL_DESCRIPTION_MAX_LENGTH);
    expect([...equal]).toHaveLength(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(SkillMetadataSchema.parse({ name: "a", description: equal }).description).toBe(equal);

    const above = "😀".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    expect(() => SkillMetadataSchema.parse({ name: "a", description: above })).toThrow();
  });

  test("enforces compatibility below, equal, and above its character limit", () => {
    for (const length of [SKILL_COMPATIBILITY_MAX_LENGTH - 1, SKILL_COMPATIBILITY_MAX_LENGTH]) {
      expect(SkillMetadataSchema.parse({
        name: "a",
        description: "Use this Skill when needed.",
        compatibility: "c".repeat(length),
      }).compatibility).toHaveLength(length);
    }
    expect(() => SkillMetadataSchema.parse({
      name: "a",
      description: "Use this Skill when needed.",
      compatibility: "c".repeat(SKILL_COMPATIBILITY_MAX_LENGTH + 1),
    })).toThrow();
  });

  test("counts astral Unicode compatibility characters as code points", () => {
    const equal = "😀".repeat(SKILL_COMPATIBILITY_MAX_LENGTH);
    expect([...equal]).toHaveLength(SKILL_COMPATIBILITY_MAX_LENGTH);
    expect(SkillMetadataSchema.parse({
      name: "a",
      description: "Use this Skill when needed.",
      compatibility: equal,
    }).compatibility).toBe(equal);

    const above = "😀".repeat(SKILL_COMPATIBILITY_MAX_LENGTH + 1);
    expect(() => SkillMetadataSchema.parse({
      name: "a",
      description: "Use this Skill when needed.",
      compatibility: above,
    })).toThrow();
  });

  test("counts outer whitespace before trimming bounded metadata strings", () => {
    expect(SkillMetadataSchema.parse({
      name: "a",
      description: ` ${"d".repeat(SKILL_DESCRIPTION_MAX_LENGTH - 2)} `,
      compatibility: ` ${"c".repeat(SKILL_COMPATIBILITY_MAX_LENGTH - 2)} `,
    })).toMatchObject({
      description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH - 2),
      compatibility: "c".repeat(SKILL_COMPATIBILITY_MAX_LENGTH - 2),
    });

    expect(() => SkillMetadataSchema.parse({
      name: "a",
      description: ` ${"d".repeat(SKILL_DESCRIPTION_MAX_LENGTH)} `,
    })).toThrow(`at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters`);
    expect(() => SkillMetadataSchema.parse({
      name: "a",
      description: "Use this Skill when needed.",
      compatibility: ` ${"c".repeat(SKILL_COMPATIBILITY_MAX_LENGTH)} `,
    })).toThrow(`at most ${SKILL_COMPATIBILITY_MAX_LENGTH} characters`);
  });

  test("enforces frontmatter bytes below, equal, and above 16 KiB", () => {
    for (const size of [SKILL_FRONTMATTER_MAX_BYTES - 1, SKILL_FRONTMATTER_MAX_BYTES]) {
      const frontmatter = frontmatterWithExactBytes(size);
      expect(encoder.encode(frontmatter)).toHaveLength(size);
      expect(parseSkillFrontmatter(frontmatter).name).toBe("a");
    }
    const above = frontmatterWithExactBytes(SKILL_FRONTMATTER_MAX_BYTES + 1);
    expect(() => parseSkillFrontmatter(above)).toThrow(`exceeds ${SKILL_FRONTMATTER_MAX_BYTES} bytes`);
  });

  test("enforces SKILL.md bytes below, equal, and above 128 KiB", () => {
    for (const size of [SKILL_ENTRY_MAX_BYTES - 1, SKILL_ENTRY_MAX_BYTES]) {
      const markdown = markdownWithExactBytes(size);
      expect(encoder.encode(markdown)).toHaveLength(size);
      expect(parseSkillMarkdown(markdown).metadata.name).toBe("a");
    }
    expect(() => parseSkillMarkdown(markdownWithExactBytes(SKILL_ENTRY_MAX_BYTES + 1)))
      .toThrow(`exceeds ${SKILL_ENTRY_MAX_BYTES} bytes`);
  });

  test("parses CRLF delimiters and returns the correct byte body offset", () => {
    const content = encoder.encode("---\r\nname: a\r\ndescription: Use this Skill when needed.\r\n---\r\nbody\r\n");
    const parsed = parseSkillHeaderBytes(content);
    expect(parsed.metadata.name).toBe("a");
    expect(new TextDecoder().decode(content.subarray(parsed.bodyOffset))).toBe("body\r\n");
  });

  test("rejects invalid UTF-8 in frontmatter and a missing closing delimiter", () => {
    const prefix = encoder.encode("---\nname: a\ndescription: ");
    const suffix = encoder.encode("\n---\nbody");
    const invalid = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    invalid.set(prefix);
    invalid[prefix.byteLength] = 0xff;
    invalid.set(suffix, prefix.byteLength + 1);
    expect(() => parseSkillHeaderBytes(invalid)).toThrow("valid UTF-8");
    expect(() => parseSkillHeaderBytes(encoder.encode("---\nname: a\n"))).toThrow("closing delimiter");
  });

  test("rejects duplicate YAML keys and alias expansion beyond the fixed limit", () => {
    expect(() => parseSkillFrontmatter([
      "name: a",
      "description: Use this Skill when needed.",
      "description: Duplicate key.",
    ].join("\n"))).toThrow("Invalid Skill YAML frontmatter");

    const aliasExpansion = [
      "name: a",
      "description: Use this Skill when needed.",
      "metadata:",
      "  a: &a [x, x]",
      "  b: &b [*a, *a]",
      "  c: &c [*b, *b]",
      "  d: &d [*c, *c]",
      "  e: *d",
    ].join("\n");
    expect(() => parseSkillFrontmatter(aliasExpansion))
      .toThrow("Excessive alias count");
  });
});

function frontmatterWithExactBytes(target: number): string {
  const prefix = "name: a\ndescription: Use this Skill when needed.\nmetadata:\n  pad: ";
  const suffix = "\n";
  const padding = target - encoder.encode(prefix + suffix).byteLength;
  if (padding < 1) throw new Error(`Target ${target} is too small for valid frontmatter`);
  return `${prefix}${"x".repeat(padding)}${suffix}`;
}

function markdownWithExactBytes(target: number): string {
  const prefix = "---\nname: a\ndescription: Use this Skill when needed.\n---\n";
  const padding = target - encoder.encode(prefix).byteLength;
  if (padding < 0) throw new Error(`Target ${target} is too small for valid Skill Markdown`);
  return `${prefix}${"b".repeat(padding)}`;
}
