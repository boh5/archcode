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
const userSkillsRoot = join(tmpRoot, "user", ".archcode", "skills");

const leadSkills = ["git-master", "safe-refactor", "codemap", "review-work", "research-docs"] as const;
const exploreSkills = ["codemap", "research-docs"] as const;

function makeContext(agentSkills: readonly string[]): ToolExecutionContext {
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "skill_list",
  toolCallId: "skill-list-call",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["skill_list"]),
  agentSkills,
  skillService: new SkillService({ userSkillsRoot }),
  projectContext: createTestProjectContext(projectRoot),
  cwd: projectRoot, });
}

describe("skill_list tool", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(userSkillsRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("Lead allow-list returns all five builtin skill entries without bodies", async () => {
    const result = await skillListTool.execute({}, makeContext(leadSkills));
    const entries = JSON.parse(expectTextDraft(result)) as SkillIndexEntry[];

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
      expect("body" in entry).toBe(false);
    }
  });

  test("explore allow-list returns codemap and research-docs only", async () => {
    const result = await skillListTool.execute({}, makeContext(exploreSkills));
    const entries = JSON.parse(expectTextDraft(result)) as SkillIndexEntry[];

    expect(entries.map((entry) => entry.name)).toEqual(["codemap", "research-docs"]);
  });

  test("agent with no skills receives an empty list", async () => {
    const result = await skillListTool.execute({}, makeContext([]));

    expect(JSON.parse(expectTextDraft(result))).toEqual([]);
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
