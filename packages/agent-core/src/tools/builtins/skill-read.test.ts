import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_ERROR_META_KEY } from "../errors";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";
import { createBuiltinToolDescriptors } from "./index";
import { SkillReadInputSchema, skillReadTool } from "./skill-read";

const tmpRoot = join(import.meta.dir, "__test_tmp__", "skill-read-tool");
const projectRoot = join(tmpRoot, "project");
const projectSkillsRoot = join(projectRoot, ".specra", "skills");
const userSkillsRoot = join(tmpRoot, "user", ".specra", "skills");

function makeContext(agentSkills: readonly string[]): ToolExecutionContext {
  return createToolExecutionContext({
    store: createMockStore(),
    toolName: "skill_read",
    toolCallId: "skill-read-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["skill_read"]),
    agentSkills,
    skillService: new SkillService({ userSkillsRoot }),
    projectContext: createTestProjectContext(projectRoot),
  });
}

async function writeProjectSkill(name: string, content: string): Promise<void> {
  const skillDir = join(projectSkillsRoot, name);
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), content);
}

describe("skill_read tool", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(userSkillsRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("allowed skill returns full metadata and body content", async () => {
    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));

    expect(typeof result).toBe("string");
    expect(result as string).toContain("---\nname: codemap");
    expect(result as string).toContain("description:");
    expect(result as string).toContain("source: builtin");
    expect(result as string).toContain("Trace entry points");
  });

  test("not-allowed skill returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "git-master" },
      makeContext(["codemap"]),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Skill not found or not allowed for current agent: git-master");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  test("unknown skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "missing-skill" },
      makeContext(["missing-skill"]),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Skill not found or not allowed for current agent: missing-skill");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  test("invalid skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "../bad" },
      makeContext(["../bad"]),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid Skill name");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  test("invalid skill file returns structured error", async () => {
    await writeProjectSkill("codemap", `---
name: wrong-name
description: invalid override
---

Broken body.
`);

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"])) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid project skill");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  test("input schema rejects unknown keys including agent, role, source, and path", () => {
    expect(SkillReadInputSchema.safeParse({ name: "codemap" }).success).toBe(true);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", agentName: "orchestrator" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", role: "builder" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", source: "builtin" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", path: "/tmp/SKILL.md" }).success).toBe(false);
  });

  test("has correct read-only concurrency-safe traits and is registered", () => {
    expect(skillReadTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(createBuiltinToolDescriptors().some((tool) => tool.name === "skill_read")).toBe(true);
  });
});
