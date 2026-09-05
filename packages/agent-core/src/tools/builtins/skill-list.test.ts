import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestBoundCursorError, SkillService, type SkillIndexEntry } from "../../skills";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors } from "./index";
import { SkillListInputSchema, skillListTool } from "./skill-list";
import { skillReadTool } from "./skill-read";

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

function makeContext(
  agentSkills: readonly string[],
  cwd = projectRoot,
  resolveSkillListTargetSkills?: ToolExecutionContext["resolveSkillListTargetSkills"],
  skillService = new SkillService({ userSkillsRoot, userAgentsSkillsRoot }),
): ToolExecutionContext {
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
  skillService,
  ...(resolveSkillListTargetSkills === undefined ? {} : { resolveSkillListTargetSkills }),
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

  test("allowed target uses its resolved builtin allow-list", async () => {
    const resolveTarget = mock((agentType: string) => agentType === "explore" ? exploreSkills : undefined);

    const result = await skillListTool.execute(
      { agent_type: "explore" },
      makeContext(leadSkills, projectRoot, resolveTarget),
    );
    const page = JSON.parse(expectTextDraft(result)) as SkillListPage;

    expect(resolveTarget).toHaveBeenCalledWith("explore");
    expect(page.items.map((entry) => entry.name)).toEqual(["codemap", "research-docs"]);
  });

  test("target-only reserved Skill discovery does not grant the parent read access", async () => {
    const ctx = makeContext(
      leadSkills,
      projectRoot,
      (agentType) => agentType === "analyst" ? ["goal-review"] : undefined,
    );
    const targetPage = JSON.parse(expectTextDraft(await skillListTool.execute(
      { agent_type: "analyst" },
      ctx,
    ))) as SkillListPage;
    const parentRead = await skillReadTool.execute(
      { name: "goal-review" },
      { ...ctx, toolName: "skill_read", allowedTools: new Set(["skill_read"]) },
    );

    expect(targetPage.items.map((entry) => entry.name)).toContain("goal-review");
    expect(parentRead.isError).toBe(true);
    expect(parentRead.details?.error?.code).toBe("TOOL_SKILL_NOT_FOUND");
  });

  test("target discovery fails closed when delegation context is missing", async () => {
    const result = await skillListTool.execute({ agent_type: "explore" }, makeContext(leadSkills));

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_CONTEXT_MISSING");
  });

  test("disallowed target returns a typed error without querying SkillService", async () => {
    const ctx = makeContext(leadSkills, projectRoot, () => undefined);
    const listPageForAgent = mock(async () => ({ items: [] }));
    Object.defineProperty(ctx.skillService!, "listPageForAgent", { value: listPageForAgent });

    const result = await skillListTool.execute({ agent_type: "build" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_TARGET_NOT_ALLOWED");
    expect(listPageForAgent).not.toHaveBeenCalled();
  });

  test("stale cursor hint retries the first page without losing current-Agent scope", async () => {
    const ctx = makeContext(leadSkills);
    const listPageForAgent = mock(async () => {
      throw new DigestBoundCursorError(
        "TOOL_SKILL_CATALOG_CHANGED",
        "Catalog changed or cursor is invalid; restart from the first page",
      );
    });
    Object.defineProperty(ctx.skillService!, "listPageForAgent", { value: listPageForAgent });

    const result = await skillListTool.execute(
      { cursor: "stale-cursor" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_SKILL_CATALOG_CHANGED");
    expect(result.details?.error?.hint).toContain("skill_list({})");
    expect(result.details?.error?.hint).not.toContain("skill_list({\"agent_type\":");
  });

  test("stale target cursor hint preserves agent_type in its first-page retry", async () => {
    const resolveTarget = mock((agentType: string) => agentType === "build" ? ["safe-refactor"] : undefined);
    const ctx = makeContext(leadSkills, projectRoot, resolveTarget);
    const listPageForAgent = mock(async () => {
      throw new DigestBoundCursorError(
        "TOOL_SKILL_CATALOG_CHANGED",
        "Catalog changed or cursor is invalid; restart from the first page",
      );
    });
    Object.defineProperty(ctx.skillService!, "listPageForAgent", { value: listPageForAgent });

    const result = await skillListTool.execute(
      { agent_type: "build", cursor: "stale-cursor" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error?.hint).toContain('skill_list({"agent_type":"build"})');
    expect(result.details?.error?.hint).not.toContain("skill_list({})");
  });

  test("replays exact guessed cursor tokens through the public schema and real SkillService", async () => {
    for (const cursor of [":first", "PLACEHOLDER"]) {
      const parsed = SkillListInputSchema.safeParse({ cursor });
      expect(parsed.success, cursor).toBe(true);
      if (!parsed.success) throw new Error(`Expected ${cursor} to pass the public cursor schema`);

      const result = await skillListTool.execute(parsed.data, makeContext(leadSkills));

      expect(result.isError, cursor).toBe(true);
      expect(result.details?.error, cursor).toMatchObject({ code: "TOOL_SKILL_CATALOG_CHANGED" });
      expect(result.details?.error?.hint, cursor).toContain("skill_list({})");
      expect(result.details?.error?.hint, cursor).toContain("Copy only nextCursor");
    }
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

  test("isolates concurrent Prompt catalogs and pages on one shared SkillService", async () => {
    const secondProjectRoot = join(tmpRoot, "second-project");
    const fixtures = [
      [projectRoot, "first-project-skill", "First project only."],
      [secondProjectRoot, "second-project-skill", "Second project only."],
    ] as const;
    for (const [root, name, description] of fixtures) {
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

    const sharedSkillService = new SkillService({ userSkillsRoot, userAgentsSkillsRoot });
    const [firstPrompt, secondPrompt, firstResult, secondResult] = await Promise.all([
      sharedSkillService.projectPromptCatalog(projectRoot, []),
      sharedSkillService.projectPromptCatalog(secondProjectRoot, []),
      skillListTool.execute({}, makeContext([], projectRoot, undefined, sharedSkillService)),
      skillListTool.execute({}, makeContext([], secondProjectRoot, undefined, sharedSkillService)),
    ]);
    const firstPromptNames = firstPrompt.includedEntries.map((entry) => entry.name);
    const secondPromptNames = secondPrompt.includedEntries.map((entry) => entry.name);
    const firstNames = (JSON.parse(expectTextDraft(firstResult)) as SkillListPage).items.map((entry) => entry.name);
    const secondNames = (JSON.parse(expectTextDraft(secondResult)) as SkillListPage).items.map((entry) => entry.name);

    expect(firstPromptNames).toEqual(["first-project-skill"]);
    expect(firstPrompt.renderedText).toContain("first-project-skill");
    expect(firstPrompt.renderedText).not.toContain("second-project-skill");
    expect(secondPromptNames).toEqual(["second-project-skill"]);
    expect(secondPrompt.renderedText).toContain("second-project-skill");
    expect(secondPrompt.renderedText).not.toContain("first-project-skill");
    expect(firstNames).toEqual(["first-project-skill"]);
    expect(firstNames).not.toContain("second-project-skill");
    expect(secondNames).toEqual(["second-project-skill"]);
    expect(secondNames).not.toContain("first-project-skill");
  });

  test("input schema accepts delegated targets and rejects unknown keys or roles", () => {
    expect(SkillListInputSchema.safeParse({}).success).toBe(true);
    expect(SkillListInputSchema.safeParse({ agent_type: "analyst" }).success).toBe(true);
    expect(SkillListInputSchema.safeParse({ agent_type: "build", cursor: "next" }).success).toBe(true);
    expect(SkillListInputSchema.safeParse({ agent_type: "lead" }).success).toBe(false);
    expect(SkillListInputSchema.safeParse({ agent_type: "discussion" }).success).toBe(false);
    expect(SkillListInputSchema.safeParse({ agentName: "lead" }).success).toBe(false);
    expect(SkillListInputSchema.safeParse({ source: "builtin" }).success).toBe(false);
  });

  test("description documents exact first-page and cursor recovery JSON", () => {
    expect(skillListTool.description).toContain("skill_list({})");
    expect(skillListTool.description).toContain('skill_list({"agent_type":"build"})');
    expect(skillListTool.description).toContain("nextCursor");
    for (const forbidden of ["/", ":first", "first", "new", "invalid", "PLACEHOLDER"]) {
      expect(skillListTool.description).toContain(forbidden);
    }
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
