import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService } from "../../skills";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors } from "./index";
import { SkillReadInputSchema, skillReadTool } from "./skill-read";
import { ONE_SHOT_FILE_READ_MAX_BYTES } from "../../utils/safe-file";

const tmpRoot = join(tmpdir(), "archcode-skill-read-tool", crypto.randomUUID());
const projectRoot = join(tmpRoot, "project");
const projectSkillsRoot = join(projectRoot, ".archcode", "skills");
const executionCwd = join(tmpRoot, "project.worktrees", "session-skill");
const executionSkillsRoot = join(executionCwd, ".archcode", "skills");
const userSkillsRoot = join(tmpRoot, "user", ".archcode", "skills");

function makeContext(agentSkills: readonly string[], cwd = projectRoot): ToolExecutionContext {
  return createToolExecutionContext({ store: createMockStore(), storeManager, toolName: "skill_read",
  toolCallId: "skill-read-call",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: 0,
  allowedTools: new Set(["skill_read"]),
  agentSkills,
  skillService: new SkillService({ userSkillsRoot }),
  projectContext: createTestProjectContext(projectRoot),
  cwd, });
}

async function writeProjectSkill(name: string, content: string): Promise<void> {
  const skillDir = join(projectSkillsRoot, name);
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), content);
}

async function writeExecutionSkill(name: string, content: string): Promise<void> {
  const skillDir = join(executionSkillsRoot, name);
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

    const output = expectTextDraft(result);
    expect(output).toContain("---\nname: codemap");
    expect(output).toContain("description:");
    expect(output).toContain("when_to_use:");
    expect(output).toContain("source: builtin");
    expect(output).toContain("Trace entry points");
  });

  test("resolves project-local Skills from execution cwd, not canonical project root", async () => {
    await writeProjectSkill("codemap", `---
name: codemap
description: canonical marker
when_to_use: Test canonical Skill resolution.
---

CANONICAL_SKILL_BODY
`);
    await writeExecutionSkill("codemap", `---
name: codemap
description: worktree marker
when_to_use: Test worktree Skill resolution.
---

WORKTREE_SKILL_BODY
`);

    const result = await skillReadTool.execute(
      { name: "codemap" },
      makeContext(["codemap"], executionCwd),
    );

    const output = expectTextDraft(result);
    expect(output).toContain("WORKTREE_SKILL_BODY");
    expect(output).not.toContain("CANONICAL_SKILL_BODY");
  });

  test("not-allowed skill returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "git-master" },
      makeContext(["codemap"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Skill not found or not allowed for current agent: git-master");
    expect(result.details?.error).toBeDefined();
  });

  test("unknown skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "missing-skill" },
      makeContext(["missing-skill"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Skill not found or not allowed for current agent: missing-skill");
    expect(result.details?.error).toBeDefined();
  });

  test("invalid skill name returns structured error", async () => {
    const result = await skillReadTool.execute(
      { name: "../bad" },
      makeContext(["../bad"]),
    );

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Invalid Skill name");
    expect(result.details?.error).toBeDefined();
  });

  test("invalid skill file returns structured error", async () => {
    await writeProjectSkill("codemap", `---
name: wrong-name
description: invalid override
---

Broken body.
`);

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));

    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("Invalid project skill");
    expect(result.details?.error).toBeDefined();
  });

  test("rejects a Skill one byte over the one-shot file cap without partial fallback", async () => {
    const header = `---\nname: codemap\ndescription: oversized\nwhen_to_use: boundary test\n---\n\n`;
    await writeProjectSkill(
      "codemap",
      header + "x".repeat(ONE_SHOT_FILE_READ_MAX_BYTES - new TextEncoder().encode(header).byteLength + 1),
    );

    const result = await skillReadTool.execute({ name: "codemap" }, makeContext(["codemap"]));
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_OUTPUT_POLICY_VIOLATION");
    expect(expectTextDraft(result)).not.toContain("x".repeat(1_024));
  });

  test("input schema rejects unknown keys including agent, role, source, and path", () => {
    expect(SkillReadInputSchema.safeParse({ name: "codemap" }).success).toBe(true);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", agentName: "engineer" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", role: "builder" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", source: "builtin" }).success).toBe(false);
    expect(SkillReadInputSchema.safeParse({ name: "codemap", path: "/tmp/SKILL.md" }).success).toBe(false);
  });

  test("input schema rejects invalid skill names", () => {
    for (const invalidName of ["../x", "Git-Master", ""]) {
      expect(SkillReadInputSchema.safeParse({ name: invalidName }).success).toBe(false);
    }
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
