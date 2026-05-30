import { describe, expect, test } from "bun:test";
import { buildSkillsSection } from "./skills";
import type { PromptContext } from "../types";
import type { ResolvedSkill, SkillIndexEntry } from "../../skills/types";

function makeCtx(
  overrides?: Partial<Pick<PromptContext, "availableSkills" | "activeSkills">>,
): PromptContext {
  return { allowedTools: [],
  workspaceRoot: "/workspace",
  promptProfileId: "test",
  env: {
    platform: "darwin",
    timezone: "America/Los_Angeles",
    locale: "en-US",
    cwd: "/workspace",
    date: "2026-05-25",
  }, ...overrides,  };
}

const builtinSkills: SkillIndexEntry[] = [
  { name: "git-master", description: "Git operations expertise", when_to_use: "Use for git operations.", source: "builtin" },
  { name: "safe-refactor", description: "Safe code refactoring", when_to_use: "Use when refactoring.", source: "builtin" },
  { name: "codemap", description: "Codebase navigation", when_to_use: "Use before implementation.", source: "builtin" },
  { name: "review-work", description: "Post-implementation review", when_to_use: "Use after implementation.", source: "builtin" },
  { name: "research-docs", description: "Documentation research", when_to_use: "Use when uncertain about libraries.", source: "builtin" },
];

const exploreSkills: SkillIndexEntry[] = [
  { name: "codemap", description: "Codebase navigation", when_to_use: "Use before implementation.", source: "builtin" },
  { name: "research-docs", description: "Documentation research", when_to_use: "Use when uncertain about libraries.", source: "builtin" },
];

const activeGitMaster: ResolvedSkill[] = [
  {
    metadata: { name: "git-master", description: "Git operations expertise", when_to_use: "Use for git operations." },
    body: "# Git Master\n\nExpert git operations skill.",
    source: "builtin",
  },
];

describe("buildSkillsSection", () => {
  test("orchestrator prompt includes all 5 skills in available-skills with when_to_use", async () => {
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
      expect(result).toContain(skill.when_to_use);
    }
  });

  test("available-skills includes When to use: label", async () => {
    const ctx = makeCtx({ availableSkills: [builtinSkills[0]] });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("When to use: Use for git operations.");
  });

  test("normal agent prompt includes available skill summaries without full skill bodies", async () => {
    const fullSkillBody = "FULL SKILL BODY MUST NOT APPEAR";
    const ctx = makeCtx({
      availableSkills: [
        { name: "git-master", description: "Git operations expertise", when_to_use: "Use for git ops.", source: "builtin" },
        { name: "codemap", description: "Codebase navigation", when_to_use: "Use before impl.", source: "project" },
      ],
      activeSkills: [],
    });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("<available-skills>");
    expect(result).toContain("**git-master** — Git operations expertise (source: builtin). When to use: Use for git ops.");
    expect(result).toContain("**codemap** — Codebase navigation (source: project). When to use: Use before impl.");
    expect(result).not.toContain("<active-skills>");
    expect(result).not.toContain(fullSkillBody);
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
      { name: "git-master", description: "Git ops", when_to_use: "Use for git.", source: "builtin", allowed_tools: ["bash", "file_read"] },
      { name: "codemap", description: "Navigation", when_to_use: "Use before impl.", source: "user" },
    ];
    const ctx = makeCtx({ availableSkills: skillsWithTools });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("[allowed_tools: bash, file_read]");
    expect(result).not.toContain("allowed_tools: Navigation");
  });

  test("multiple active skills are separated by ---", async () => {
    const active: ResolvedSkill[] = [
      { metadata: { name: "git-master", description: "Git", when_to_use: "Use for git." }, body: "Body A", source: "builtin" },
      { metadata: { name: "codemap", description: "Map", when_to_use: "Use before impl." }, body: "Body B", source: "project" },
    ];
    const ctx = makeCtx({ activeSkills: active });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("---");
    expect(result).toContain("Body A");
    expect(result).toContain("Body B");
  });

  test("truncates long when_to_use with ellipsis suffix", async () => {
    const longWhenToUse = "A".repeat(400);
    const ctx = makeCtx({
      availableSkills: [
        { name: "verbose-skill", description: "Verbose", when_to_use: longWhenToUse, source: "user" },
      ],
    });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("When to use:");
    const whenToUseMatch = result?.match(/When to use: (.+?)(?:\n|\[allowed_tools|$)/s);
    expect(whenToUseMatch).not.toBeNull();
    const displayed = whenToUseMatch![1].trim();
    expect(displayed.length).toBeLessThan(longWhenToUse.length);
    expect(displayed.endsWith("…")).toBe(true);
  });

  test("truncates long when_to_use with whitespace at word boundary", async () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const ctx = makeCtx({
      availableSkills: [
        { name: "long-skill", description: "Long", when_to_use: words, source: "user" },
      ],
    });
    const result = await buildSkillsSection(ctx);

    const whenToUseMatch = result?.match(/When to use: (.+?)(?:\n|\[allowed_tools|$)/s);
    expect(whenToUseMatch).not.toBeNull();
    const displayed = whenToUseMatch![1].trim();
    expect(displayed.endsWith("…")).toBe(true);
    expect(displayed.length).toBeLessThan(words.length);
  });

  test("normalizes whitespace in when_to_use", async () => {
    const ctx = makeCtx({
      availableSkills: [
        { name: "multiline", description: "Test", when_to_use: "Use  when\n  multiple   spaces", source: "user" },
      ],
    });
    const result = await buildSkillsSection(ctx);

    expect(result).toContain("When to use: Use when multiple spaces");
  });
});