import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService, type SkillIndexEntry } from "../../skills";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors } from "./index";
import { SkillListInputSchema, skillListTool } from "./skill-list";

const tmpRoot = join(tmpdir(), "archcode-skill-list-tool", crypto.randomUUID());
const projectRoot = join(tmpRoot, "project");
const executionCwd = join(tmpRoot, "project.worktrees", "session-skill");
const userSkillsRoot = join(tmpRoot, "user", ".archcode", "skills");
const userAgentsSkillsRoot = join(tmpRoot, "user", ".agents", "skills");

const leadSkills = ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"] as const;
const exploreSkills = ["codemap", "research-docs"] as const;

type SkillListPage = {
  readonly items: readonly SkillIndexEntry[];
  readonly nextCursor?: string;
};

function makeContext(agentSkills: readonly string[], cwd = projectRoot): ToolExecutionContext {
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "skill_list",
  toolCallId: "skill-list-call",
  input: {},
  step: 0,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["skill_list"]),
  agentSkills,
  skillService: new SkillService({ userSkillsRoot, userAgentsSkillsRoot }),
  projectContext: createTestProjectContext(projectRoot),
  cwd, });
}

describe("skill_list tool", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(userSkillsRoot, { recursive: true });
    await mkdir(userAgentsSkillsRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("Lead allow-list returns all five builtin skill entries without bodies", async () => {
    const result = await skillListTool.execute({}, makeContext(leadSkills));
    const page = JSON.parse(expectTextDraft(result)) as SkillListPage;
    const entries = page.items;

    expect(entries.map((entry) => entry.name)).toEqual([
      "codemap",
      "git-master",
      "research-docs",
      "review-work",
      "safe-refactor",
    ]);
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.source).toBe("builtin");
      expect(Object.keys(entry).sort()).toEqual(["description", "name", "source"]);
    }
  });

  test("explore allow-list returns codemap and research-docs only", async () => {
    const result = await skillListTool.execute({}, makeContext(exploreSkills));
    const page = JSON.parse(expectTextDraft(result)) as SkillListPage;
    const entries = page.items;

    expect(entries.map((entry) => entry.name)).toEqual(["codemap", "research-docs"]);
  });

  test("agent with no skills receives an empty list", async () => {
    const result = await skillListTool.execute({}, makeContext([]));

    expect(JSON.parse(expectTextDraft(result))).toEqual({ items: [] });
  });

  test("resolves same-name project Skills from the Session cwd", async () => {
    const name = "worktree-catalog-skill";
    for (const [root, description] of [
      [projectRoot, "Canonical checkout metadata."],
      [executionCwd, "Session worktree metadata."],
    ] as const) {
      const skillRoot = join(root, ".archcode", "skills", name);
      await mkdir(skillRoot, { recursive: true });
      await Bun.write(join(skillRoot, "SKILL.md"), [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "---",
        "",
        description,
      ].join("\n"));
    }

    const result = await skillListTool.execute({}, makeContext([], executionCwd));
    const page = JSON.parse(expectTextDraft(result)) as SkillListPage;

    expect(page.items).toContainEqual({
      name,
      description: "Session worktree metadata.",
      source: "project-archcode",
    });
    expect(page.items).not.toContainEqual(expect.objectContaining({
      name,
      description: "Canonical checkout metadata.",
    }));
  });

  test("input schema rejects unknown keys including agentName", () => {
    expect(SkillListInputSchema.safeParse({}).success).toBe(true);
    expect(SkillListInputSchema.safeParse({ agentName: "lead" }).success).toBe(false);
    expect(SkillListInputSchema.safeParse({ source: "builtin" }).success).toBe(false);
  });

  test("has correct read-only concurrency-safe traits and is registered", () => {
    expect(skillListTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(createBuiltinToolDescriptors().some((tool) => tool.name === "skill_list")).toBe(true);
  });
});
