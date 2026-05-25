import { describe, expect, test } from "bun:test";
import { buildSkillsSection } from "./skills";
import type { PromptContext } from "../types";
import type { ResolvedSkill, SkillIndexEntry } from "../../skills/types";

function makeCtx(
  overrides?: Partial<Pick<PromptContext, "availableSkills" | "activeSkills">>,
): PromptContext {
  return {
    allowedTools: [],
    workspaceRoot: "/workspace",
    agentId: "test",
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: "/workspace",
      date: "2026-05-25",
    },
    ...overrides,
  };
}

const builtinSkills: SkillIndexEntry[] = [
  { name: "git-master", description: "Git operations expertise", source: "builtin" },
  { name: "safe-refactor", description: "Safe code refactoring", source: "builtin" },
  { name: "codemap", description: "Codebase navigation", source: "builtin" },
  { name: "review-work", description: "Post-implementation review", source: "builtin" },
  { name: "research-docs", description: "Documentation research", source: "builtin" },
];

const exploreSkills: SkillIndexEntry[] = [
  { name: "codemap", description: "Codebase navigation", source: "builtin" },
  { name: "research-docs", description: "Documentation research", source: "builtin" },
];

const activeGitMaster: ResolvedSkill[] = [
  {
    metadata: { name: "git-master", description: "Git operations expertise" },
    body: "# Git Master\n\nExpert git operations skill.",
    source: "builtin",
  },
];

describe("buildSkillsSection", () => {
  test("orchestrator prompt includes all 5 skills in available-skills", async () => {
    const ctx = makeCtx({ availableSkills: builtinSkills });
    const result = await buildSkillsSection(ctx);

    expect(result).toBeString();
    expect(result).toContain("## Skills");
    expect(result).toContain("<available-skills>");
    expect(result).toContain("</available-skills>");
    expect(result).not.toContain("<active-skills>");

    for (const skill of builtinSkills) {
      expect(result).toContain(`**${skill.name}**`);
      expect(result).toContain(skill.description);
      expect(result).toContain(`source: ${skill.source}`);
    }
  });

  test("explore prompt includes only codemap and research-docs", async () => {
    const ctx = makeCtx({ availableSkills: exploreSkills });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("codemap");
    expect(result).toContain("research-docs");
    expect(result).not.toContain("git-master");
    expect(result).not.toContain("safe-refactor");
    expect(result).not.toContain("review-work");
  });

  test("delegated builder with active git-master includes full content under active-skills", async () => {
    const ctx = makeCtx({
      availableSkills: builtinSkills,
      activeSkills: activeGitMaster,
    });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("<available-skills>");
    expect(result).toContain("<active-skills>");
    expect(result).toContain("git-master (builtin)");
    expect(result).toContain("# Git Master");
    expect(result).toContain("Expert git operations skill.");
  });

  test("empty activeSkills produces no active-skills section", async () => {
    const ctx = makeCtx({
      availableSkills: builtinSkills,
      activeSkills: [],
    });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("<available-skills>");
    expect(result).not.toContain("<active-skills>");
  });

  test("no skills at all produces null section", async () => {
    const ctx = makeCtx({ availableSkills: [], activeSkills: [] });
    const result = await buildSkillsSection(ctx);

    expect(result).toBeNull();
  });

  test("undefined availableSkills and activeSkills produces null section", async () => {
    const ctx = makeCtx({});
    const result = await buildSkillsSection(ctx);

    expect(result).toBeNull();
  });

  test("available-skills includes allowed_tools when present", async () => {
    const skillsWithTools: SkillIndexEntry[] = [
      { name: "git-master", description: "Git ops", source: "builtin", allowed_tools: ["bash", "file_read"] },
      { name: "codemap", description: "Navigation", source: "user" },
    ];
    const ctx = makeCtx({ availableSkills: skillsWithTools });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("[allowed_tools: bash, file_read]");
    expect(result).not.toContain("allowed_tools: Navigation");
  });

  test("multiple active skills are separated by ---", async () => {
    const active: ResolvedSkill[] = [
      { metadata: { name: "git-master", description: "Git" }, body: "Body A", source: "builtin" },
      { metadata: { name: "codemap", description: "Map" }, body: "Body B", source: "project" },
    ];
    const ctx = makeCtx({ activeSkills: active });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("---");
    expect(result).toContain("Body A");
    expect(result).toContain("Body B");
  });
});
