import { describe, expect, test } from "bun:test";
import { projectAvailableSkills, SKILL_PROMPT_DESCRIPTION_MAX_BYTES } from "./projection";
import type { SkillIndexEntry } from "./types";

describe("available Skill prompt projection", () => {
  test("normalizes whitespace and truncates CJK and emoji at a code-point-safe 160-byte cap", () => {
    const projection = projectAvailableSkills([{
      name: "unicode",
      description: `  中文\n\t${"🙂".repeat(80)}  tail  `,
      source: "builtin",
    }], 1_000);
    const description = projection.includedEntries[0]!.description;
    expect(description.startsWith("中文 🙂")).toBeTrue();
    expect(description.endsWith("…")).toBeTrue();
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(SKILL_PROMPT_DESCRIPTION_MAX_BYTES);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(description))).not.toThrow();

    const ascii = projectAvailableSkills([{
      name: "ascii",
      description: "x".repeat(200),
      source: "builtin",
    }], 1_000).includedEntries[0]!.description;
    expect(Buffer.byteLength(ascii, "utf8")).toBe(160);
    expect(ascii.endsWith("…")).toBeTrue();
  });

  test("renders deterministic 7,999, 8,000, and 8,001-byte boundaries with an exact omitted footer", () => {
    const at7999 = entriesForExactBytes(7_999);
    const at8000 = entriesForExactBytes(8_000);
    const at8001 = entriesForExactBytes(8_001);
    expect(projectAvailableSkills(at7999).byteLength).toBe(7_999);
    expect(projectAvailableSkills(at7999).omittedCount).toBe(0);
    expect(projectAvailableSkills(at8000).byteLength).toBe(8_000);
    expect(projectAvailableSkills(at8000).omittedCount).toBe(0);

    const unconstrained = projectAvailableSkills(at8001, 9_000);
    expect(unconstrained.byteLength).toBe(8_001);
    const bounded = projectAvailableSkills(at8001);
    expect(bounded.byteLength).toBeLessThanOrEqual(8_000);
    expect(bounded.omittedCount).toBe(1);
    expect(bounded.renderedText.endsWith("- 1 additional Skill omitted; use skill_list to continue discovery."))
      .toBeTrue();
    expect(projectAvailableSkills(at8001)).toEqual(bounded);
  });

  test("projects a large directory with a bounded prefix and plural footer", () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      name: `skill-${index}`,
      description: "bounded guidance",
      source: "builtin" as const,
    }));
    const projection = projectAvailableSkills(entries, 512);

    expect(projection.byteLength).toBeLessThanOrEqual(512);
    expect(projection.includedEntries.length).toBeGreaterThan(0);
    expect(projection.omittedCount).toBeGreaterThan(1);
    expect(projection.renderedText).toContain("additional Skills omitted");
  });
});

function entriesForExactBytes(target: number): SkillIndexEntry[] {
  const count = 42;
  const finalNameLength = 64;
  // 41 fixed lines plus the final line's fixed syntax occupy 7,875 bytes.
  const finalDescriptionLength = target - 7_875;
  if (finalDescriptionLength < 1 || finalDescriptionLength > 160) {
    throw new Error(`Unable to construct ${target}-byte projection fixture`);
  }
  return Array.from({ length: count }, (_, index) => ({
    name: index === count - 1
      ? "n".repeat(finalNameLength)
      : `skill-${String(index).padStart(2, "0")}`,
    description: "x".repeat(index === count - 1 ? finalDescriptionLength : 160),
    source: "builtin" as const,
  }));
}
